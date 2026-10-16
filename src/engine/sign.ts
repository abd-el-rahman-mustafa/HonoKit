import { BRAND } from '@shared/brand'
import { createHash, webcrypto } from 'node:crypto'
import forge from 'node-forge'
import { PDFDocument, rgb } from 'pdf-lib'
import { detectDirection } from './bidi'
import { PdfError } from './errors'
import { free, openPdf, type PdfDoc } from './mupdf'
import { contentOf, drawLine, FontSet, measureLine } from './stamp'
import { isIdentity, shownTurn, turnMatrix } from './upright'

/**
 * Certificate (digital ID) signatures, offline (docs/decisions.md §53, docs/research-signing.md).
 *
 * MuPDF's object API adds a /Sig field and widget whose look is drawn by pdf-lib (Arabic
 * shaped) and grafted in as /AP; MuPDF saves incrementally, so the original bytes — and any
 * earlier signature — stay untouched; then /ByteRange is patched and a detached CMS
 * (PKCS#7, SHA-256/RSA) from node-forge fills /Contents. pdf-lib never parses the person's
 * file (§22). Signed files verify with OpenSSL and pkijs; Acrobat shows a self-signed ID as
 * "validity unknown" until the person trusts it.
 */

const asn1 = forge.asn1
const pki = forge.pki

type Box = [number, number, number, number]

export interface SignMeta {
  name: string
  reason?: string
  location?: string
  contact?: string
  date: Date
}

export interface DigitalId {
  privateKey: forge.pki.rsa.PrivateKey
  cert: forge.pki.Certificate
  chain: forge.pki.Certificate[]
}

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1'
}

const U = asn1.Class.UNIVERSAL
const T = asn1.Type
const seq = (v: forge.asn1.Asn1[]): forge.asn1.Asn1 => asn1.create(U, T.SEQUENCE, true, v)
const set = (v: forge.asn1.Asn1[]): forge.asn1.Asn1 => asn1.create(U, T.SET, true, v)
const oid = (o: string): forge.asn1.Asn1 => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes())
const octets = (bin: string): forge.asn1.Asn1 => asn1.create(U, T.OCTETSTRING, false, bin)
const int = (bin: string): forge.asn1.Asn1 => asn1.create(U, T.INTEGER, false, bin)
const nul = (): forge.asn1.Asn1 => asn1.create(U, T.NULL, false, '')
const algSha256 = (): forge.asn1.Asn1 => seq([oid(OID.sha256), nul()])
const attr = (o: string, value: forge.asn1.Asn1): forge.asn1.Asn1 => seq([oid(o), set([value])])

/** A detached CMS SignedData over a SHA-256 digest computed outside (forge would copy the whole file). Exported for the tests. */
export function buildCms(digest: Buffer, id: DigitalId, signingTime: Date): Buffer {
  const signedAttrs = [attr(OID.contentType, oid(OID.data)), attr(OID.signingTime, asn1.create(U, T.UTCTIME, false, asn1.dateToUtcTime(signingTime))), attr(OID.messageDigest, octets(digest.toString('binary')))]
  const md = forge.md.sha256.create()
  md.update(asn1.toDer(set(signedAttrs)).getBytes())
  const signature = id.privateKey.sign(md)
  // Issuer and serial exactly as in the certificate: forge re-encodes UTF-8 names wrongly (an
  // Arabic name would no longer match, and every reader would call the signature invalid).
  const tbs = (id.cert as unknown as { tbsCertificate?: forge.asn1.Asn1 }).tbsCertificate ?? (pki as unknown as { getTBSCertificate(c: forge.pki.Certificate): forge.asn1.Asn1 }).getTBSCertificate(id.cert)
  const parts = tbs.value as forge.asn1.Asn1[]
  const serialIdx = parts.findIndex((v) => v.tagClass === U && v.type === T.INTEGER)
  const signerInfo = seq([int('\x01'), seq([parts[serialIdx + 2]!, parts[serialIdx]!]), algSha256(), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, signedAttrs), seq([oid(OID.rsaEncryption), nul()]), octets(signature)])
  const signedData = seq([int('\x01'), set([algSha256()]), seq([oid(OID.data)]), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [id.cert, ...id.chain].map((c) => pki.certificateToAsn1(c))), set([signerInfo])])
  return Buffer.from(asn1.toDer(seq([oid(OID.signedData), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData])])).getBytes(), 'binary')
}

/**
 * Rounds of key derivation a new digital ID is written with, for its key, its certificates and
 * its MAC alike (the MAC alone tells whether a guessed password is right). The library's 2048
 * is far below today's advice; 100,000 opens in about half a second here (decisions §94).
 */
export const ID_ROUNDS = 100_000

/** The shortest password a new digital ID may have (NIST SP 800-63B); an existing ID opens with any. */
export const MIN_ID_PASSWORD = 8

/**
 * Rounds of key derivation an ID may ask for in all, charged before any hashing. The file sets
 * its own counts, unchecked by the library: a crafted one could stall the password check for
 * hours, or wrap a huge count to a single round.
 */
const MAX_ID_ROUNDS = 10_000_000

type Derive = (...args: unknown[]) => unknown

/**
 * Runs `work` with the library's three key-derivation entry points charged against one budget
 * of rounds: PKCS#12's own (keys, certificates and the MAC) and PBKDF2 (PBES2 keys). They are
 * called by name through their modules, so the budget sees every count the file carries.
 */
function withRoundsBudget<T>(work: () => T): T {
  let left = MAX_ID_ROUNDS
  const charge = (count: unknown): void => {
    const n = typeof count === 'number' && Number.isInteger(count) && count >= 1 ? count : Infinity
    left -= n
    if (left < 0) throw new PdfError('unsupported', 'This digital ID asks for too many rounds of key derivation to open: it is damaged, or made to stall the password check.')
  }
  const pkcs5 = forge.pkcs5 as unknown as { pbkdf2: Derive }
  // The PBE module is not in the typings; it is the one pkcs12 derives its keys through.
  const pbe = (forge as unknown as { pbe: { generatePkcs12Key: Derive } }).pbe
  const p12 = forge.pkcs12 as unknown as { generateKey: Derive }
  const was = { pbkdf2: pkcs5.pbkdf2, pkcs12: pbe.generatePkcs12Key, mac: p12.generateKey }
  // pbkdf2(password, salt, iterations, …); generatePkcs12Key(password, salt, id, iterations, …).
  pkcs5.pbkdf2 = (...args) => {
    charge(args[2])
    return was.pbkdf2(...args)
  }
  pbe.generatePkcs12Key = (...args) => {
    charge(args[3])
    return was.pkcs12(...args)
  }
  p12.generateKey = pbe.generatePkcs12Key
  try {
    return work()
  } finally {
    pkcs5.pbkdf2 = was.pbkdf2
    pbe.generatePkcs12Key = was.pkcs12
    p12.generateKey = was.mac
  }
}

/** The key and certificate in a .pfx / .p12 file. */
export function loadDigitalId(p12: Uint8Array, password: string): DigitalId {
  let parsed: forge.pkcs12.Pkcs12Pfx
  try {
    parsed = withRoundsBudget(() => forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(forge.util.createBuffer(Buffer.from(p12).toString('binary'))), false, password))
  } catch (error) {
    if (error instanceof PdfError) throw error
    throw new PdfError('wrong-password', 'The digital ID could not be opened: the password is wrong, or the file is not a .pfx / .p12 digital ID.')
  }
  const certs = (parsed.getBags({ bagType: pki.oids.certBag! })[pki.oids.certBag!] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c)
  const keyBags = [...(parsed.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag! })[pki.oids.pkcs8ShroudedKeyBag!] ?? []), ...(parsed.getBags({ bagType: pki.oids.keyBag! })[pki.oids.keyBag!] ?? [])]
  const privateKey = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined
  if (!privateKey || !('n' in privateKey)) throw new PdfError('unsupported', `This digital ID has no RSA private key. ${BRAND.name} signs with RSA keys only.`)
  const cert = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey
    return pub.n.compareTo(privateKey.n) === 0 && pub.e.compareTo(privateKey.e) === 0
  })
  if (!cert) throw new PdfError('unsupported', 'This digital ID has no certificate for its key.')
  return { privateKey, cert, chain: certs.filter((c) => c !== cert) }
}

/** A new self-signed digital ID as a .pfx (Acrobat's "Create a new digital ID"). */
export function createDigitalId(name: string, email: string, organisation: string, password: string, years = 5): Uint8Array {
  if ([...password].length < MIN_ID_PASSWORD) throw new PdfError('bad-arguments', `The password of a digital ID needs at least ${MIN_ID_PASSWORD} characters.`)
  const keys = pki.rsa.generateKeyPair(2048)
  const cert = pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 86_400_000)
  // UTF8String values, so an Arabic name is stored as it is written.
  const subject = [
    // forge encodes UTF8String values itself (and double-encodes pre-encoded ones).
    { shortName: 'CN', value: name, valueTagClass: T.UTF8 as unknown as forge.asn1.Class },
    ...(organisation ? [{ shortName: 'O', value: organisation, valueTagClass: T.UTF8 as unknown as forge.asn1.Class }] : []),
    ...(email ? [{ name: 'emailAddress', value: email }] : [])
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  // 3DES with SHA-1 is what every reader of .pfx files (Windows, Acrobat) opens; the rounds are ours.
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', count: ID_ROUNDS, friendlyName: name })
  return new Uint8Array(Buffer.from(asn1.toDer(p12).getBytes(), 'binary'))
}

/** The certificate's common name, decoded (forge keeps UTF-8 bytes). */
export function commonName(cert: forge.pki.Certificate): string {
  const cn = cert.subject.getField('CN')?.value as string | undefined
  if (!cn) return ''
  try {
    return forge.util.decodeUtf8(cn)
  } catch {
    return cn
  }
}

const pdfDate = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

/** The visible signature: an optional drawn signature on the left, the name and details beside it. */
async function drawAppearance(width: number, height: number, meta: SignMeta, labels: { signedBy: string; date: string }, picture?: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([width, height])
  const fonts = new FontSet(pdf)
  let textLeft = 4
  if (picture) {
    const image = await pdf.embedPng(picture)
    const box = { w: width * 0.42, h: height - 8 }
    const s = Math.min(box.w / image.width, box.h / image.height)
    page.drawImage(image, { x: 4 + (box.w - image.width * s) / 2, y: 4 + (box.h - image.height * s) / 2, width: image.width * s, height: image.height * s })
    textLeft = width * 0.46
  }
  const lines: Array<{ text: string; size: number; bold: boolean }> = [
    { text: meta.name, size: 11, bold: true },
    { text: `${labels.signedBy}`, size: 7, bold: false },
    { text: labels.date, size: 7, bold: false },
    ...(meta.reason ? [{ text: meta.reason, size: 7, bold: false }] : []),
    ...(meta.location ? [{ text: meta.location, size: 7, bold: false }] : [])
  ]
  const room = width - textLeft - 4
  let y = height - 6
  for (const line of lines) {
    let size = line.size
    const w = (await measureLine(fonts, line.text, size, line.bold)).width
    if (w > room) size = Math.max(4, size * (room / w))
    y -= size * 1.15
    const rtl = detectDirection(line.text) === 'rtl'
    await drawLine(fonts, page, line.text, { x: rtl ? width - 4 : textLeft, y, alignX: rtl ? 1 : 0, centreY: false }, { size, bold: line.bold, colour: '#1f2937', opacity: 1, rotation: 0 })
  }
  page.drawRectangle({ x: 0.5, y: 0.5, width: width - 1, height: height - 1, borderColor: rgb(0.55, 0.6, 0.7), borderWidth: 0.6, opacity: 0 })
  return new Uint8Array(await pdf.save())
}

/**
 * A name for a new signature field that no field in the form has (S2): SignatureN after the
 * signature fields already there, skipping any name taken (by a text field called Signature1,
 * say). Two fields of the same name are one field to a reader, sharing one value.
 */
function freeSignatureName(doc: PdfDoc): string {
  const acro = doc.getTrailer().get('Root').get('AcroForm')
  const fields = acro.isDictionary() ? acro.get('Fields') : null
  if (!fields?.isArray()) return 'Signature1'
  const names = new Set<string>()
  let signatures = 0
  for (let i = 0; i < fields.length; i++) {
    const f = fields.get(i)
    const t = f.get('T')
    if (t.isString()) names.add(t.asString())
    if (f.get('FT').isName() && f.get('FT').asName() === 'Sig') signatures++
  }
  let n = signatures + 1
  while (names.has(`Signature${n}`)) n++
  return `Signature${n}`
}

const SIG_BYTES = 8192

/** The field, its widget with the drawn look, and a /Sig with room for the signature (zeros). */
function addSignatureField(doc: PdfDoc, pageIndex: number, rect: Box, appearance: Uint8Array, size: { width: number; height: number }, meta: SignMeta, turn: number): void {
  const pageRef = doc.findPage(pageIndex)
  const overlay = openPdf(appearance)
  let apStream
  try {
    const source = overlay.findPage(0)
    const form = doc.newDictionary()
    form.put('Type', doc.newName('XObject'))
    form.put('Subtype', doc.newName('Form'))
    form.put('FormType', 1)
    const bbox = doc.newArray()
    for (const v of [0, 0, size.width, size.height]) bbox.push(v)
    form.put('BBox', bbox)
    // Upright as the page is shown, also on a turned page (/Rotate).
    const matrix = turnMatrix(turn)
    if (!isIdentity(matrix)) {
      const m = doc.newArray()
      for (const v of matrix) m.push(v)
      form.put('Matrix', m)
    }
    form.put('Resources', doc.newGraftMap().graftObject(source.get('Resources')))
    apStream = doc.addStream(contentOf(source), form)
  } finally {
    free(overlay)
  }
  const sig = doc.newDictionary()
  sig.put('Type', doc.newName('Sig'))
  sig.put('Filter', doc.newName('Adobe.PPKLite'))
  sig.put('SubFilter', doc.newName('adbe.pkcs7.detached'))
  const br = doc.newArray()
  for (const v of [0, 1e9, 1e9, 1e9]) br.push(v)
  sig.put('ByteRange', br)
  sig.put('Contents', doc.newByteString(new Uint8Array(SIG_BYTES)))
  sig.put('Name', doc.newString(meta.name))
  if (meta.reason) sig.put('Reason', doc.newString(meta.reason))
  if (meta.location) sig.put('Location', doc.newString(meta.location))
  if (meta.contact) sig.put('ContactInfo', doc.newString(meta.contact))
  sig.put('M', doc.newString(pdfDate(meta.date)))
  const build = doc.newDictionary()
  const filter = doc.newDictionary()
  const app = doc.newDictionary()
  filter.put('Name', doc.newName('Adobe.PPKLite'))
  app.put('Name', doc.newName(BRAND.name))
  build.put('Filter', filter)
  build.put('App', app)
  sig.put('Prop_Build', build)
  const sigRef = doc.addObject(sig)

  const w = doc.newDictionary()
  w.put('Type', doc.newName('Annot'))
  w.put('Subtype', doc.newName('Widget'))
  w.put('FT', doc.newName('Sig'))
  w.put('T', doc.newString(freeSignatureName(doc)))
  w.put('F', 132)
  const r = doc.newArray()
  for (const v of rect) r.push(+v.toFixed(3))
  w.put('Rect', r)
  w.put('P', pageRef)
  w.put('V', sigRef)
  if (turn) {
    const mk = doc.newDictionary()
    mk.put('R', turn)
    w.put('MK', mk)
  }
  const ap = doc.newDictionary()
  ap.put('N', apStream)
  w.put('AP', ap)
  const wRef = doc.addObject(w)
  let annots = pageRef.get('Annots')
  if (!annots.isArray()) {
    annots = doc.newArray()
    pageRef.put('Annots', annots)
  }
  annots.push(wRef)
  const root = doc.getTrailer().get('Root')
  let acro = root.get('AcroForm')
  if (!acro.isDictionary()) {
    acro = doc.addObject(doc.newDictionary())
    root.put('AcroForm', acro)
  }
  let fields = acro.get('Fields')
  if (!fields.isArray()) {
    fields = doc.newArray()
    acro.put('Fields', fields)
  }
  fields.push(wRef)
  acro.put('SigFlags', 3)
}

/** The last uncompressed, unsigned /Sig: where /ByteRange and /Contents sit in the bytes. */
function locatePlaceholder(buf: Buffer): { byteRange: [number, number]; contents: [number, number] } {
  let at = buf.length
  while ((at = buf.lastIndexOf('/ByteRange', at - 1)) >= 0) {
    const objStart = buf.lastIndexOf(' 0 obj', at)
    const end = buf.indexOf('endobj', at)
    if (objStart < 0 || end < 0) continue
    const found = buf.lastIndexOf('\n', objStart) + 1
    const obj = buf.subarray(found, end).toString('latin1')
    if (!/\/Type\s*\/Sig\b/.test(obj)) continue
    const brOpen = obj.indexOf('[', obj.indexOf('/ByteRange'))
    const brClose = obj.indexOf(']', brOpen)
    const cOpen = obj.indexOf('<', obj.indexOf('/Contents'))
    const cClose = obj.indexOf('>', cOpen)
    if (!/^0+$/.test(obj.slice(cOpen + 1, cClose))) continue
    return { byteRange: [found + brOpen, found + brClose + 1], contents: [found + cOpen, found + cClose + 1] }
  }
  throw new PdfError('corrupt', 'The signature could not be placed in the file.')
}

export interface CertSignRequest {
  p12: Uint8Array
  password: string
  page: number
  /** Where the signature box goes, in page coordinates (top-left, y down). */
  box: Box
  reason?: string
  location?: string
  /** A drawn signature (PNG) shown beside the name. */
  picture?: Uint8Array
  labels: { signedBy: string; date: string }
}

export async function signWithCertificate(bytes: Uint8Array, request: CertSignRequest, password?: string): Promise<Uint8Array> {
  const id = loadDigitalId(request.p12, request.password)
  const now = new Date()
  const meta: SignMeta = { name: commonName(id.cert) || 'Signer', reason: request.reason, location: request.location, date: now }
  const width = request.box[2] - request.box[0]
  const height = request.box[3] - request.box[1]
  if (width < 40 || height < 20) throw new PdfError('bad-arguments', 'Make the signature box a little larger.')
  const appearance = await drawAppearance(width, height, meta, request.labels, request.picture)
  const doc = openPdf(bytes, password)
  let saved: Buffer
  try {
    if (request.page < 0 || request.page >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    if (!doc.canBeSavedIncrementally()) throw new PdfError('corrupt', 'This file was repaired when it opened, so it cannot be signed as it is. Save it first, open the saved copy, and sign that.')
    // Page coordinates → PDF space for /Rect.
    const page = doc.loadPage(request.page) as import('mupdf').PDFPage
    const [a, b, c, d, e, f] = page.getTransform()
    const turn = shownTurn(page)
    free(page)
    const det = a * d - b * c
    const toPdf = (x: number, y: number): [number, number] => [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det]
    const p0 = toPdf(request.box[0], request.box[3])
    const p1 = toPdf(request.box[2], request.box[1])
    const rect: Box = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])]
    addSignatureField(doc, request.page, rect, appearance, { width, height }, meta, turn)
    const buffer = doc.saveToBuffer('incremental')
    saved = Buffer.from(buffer.asUint8Array())
    free(buffer)
  } finally {
    free(doc)
  }
  const { byteRange, contents } = locatePlaceholder(saved)
  const [cStart, cEnd] = contents
  const text = `[${[0, cStart, cEnd, saved.length - cEnd].join(' ')}]`
  saved.write(text.padEnd(byteRange[1] - byteRange[0], ' '), byteRange[0], 'latin1')
  const hash = createHash('sha256')
  hash.update(saved.subarray(0, cStart))
  hash.update(saved.subarray(cEnd))
  const cms = buildCms(hash.digest(), id, now)
  const room = (cEnd - cStart - 2) / 2
  if (cms.length > room) throw new PdfError('unsupported', 'This digital ID’s certificates are too large to fit.')
  saved.write(cms.toString('hex').padEnd(room * 2, '0'), cStart + 1, 'latin1')
  return new Uint8Array(saved)
}

export interface SignatureInfo {
  /** Who signed, from the certificate. */
  signer: string
  name: string
  reason: string
  date: string
  /** The signed bytes are unchanged and the signature checks with its certificate. */
  valid: boolean
  /** Content was added after this signature (as with comments or a later signature). */
  modifiedAfter: boolean
  /** The certificate signed itself (not issued by an authority this PC trusts). */
  selfSigned: boolean
  problem?: string
}

/** Every signature in the file, checked: bytes, digest and signature. Trust in the certificate is not judged here. */
export async function verifySignatures(bytes: Uint8Array): Promise<SignatureInfo[]> {
  const buf = Buffer.from(bytes)
  const out: SignatureInfo[] = []
  const pkijs = await import('pkijs')
  const asn1js = await import('asn1js')
  pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as never }))
  // A trailer's /Encrypt, by reference or written in place.
  const encrypted = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(buf.toString('latin1'))
  let at = 0
  while ((at = buf.indexOf('/ByteRange', at + 1)) >= 0) {
    const objStart = buf.lastIndexOf(' 0 obj', at)
    const end = buf.indexOf('endobj', at)
    if (objStart < 0 || end < 0) continue
    const objOffset = buf.lastIndexOf('\n', objStart) + 1
    const obj = buf.subarray(objOffset, end).toString('latin1')
    if (!/\/Type\s*\/Sig\b/.test(obj) && !/\/Filter\s*\/Adobe/.test(obj)) continue
    const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(obj)
    const hex = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(obj)
    const field = (key: string): string => {
      const hexString = new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]*)>`).exec(obj)
      const m = hexString ? null : new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(obj)
      if (!hexString && !m) return ''
      const raw = hexString ? Buffer.from(hexString[1]!.replace(/\s/g, ''), 'hex').toString('latin1') : m![1]!.replace(/\\([()\\])/g, '$1')
      // UTF-16BE with BOM, or PDFDocEncoding.
      if (raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) return Buffer.from(raw.slice(2), 'latin1').swap16().toString('utf16le')
      return raw
    }
    // In an encrypted file these strings are encrypted (only /Contents is not): read as bytes
    // they would be noise, so the certificate's name stands in.
    const plain = !encrypted
    const info: SignatureInfo = { signer: '', name: plain ? field('Name') : '', reason: plain ? field('Reason') : '', date: plain ? field('M') : '', valid: false, modifiedAfter: false, selfSigned: false }
    if (!range || !hex || /^0+$/.test(hex[1]!.replace(/\s/g, ''))) continue
    const [a, b, c, d] = range.slice(1).map(Number) as [number, number, number, number]
    info.modifiedAfter = c + d < buf.length
    // The range must cover the file from its first byte up to this signature's own /Contents
    // string, and from just after it, within the file.
    // Otherwise a signature that checks could cover other bytes than the ones shown.
    const hexStart = objOffset + hex.index + hex[0].indexOf('<')
    const hexEnd = objOffset + hex.index + hex[0].length
    if (a !== 0 || b !== hexStart || c !== hexEnd || c + d > buf.length) {
      info.problem = 'The signed byte range does not cover the whole file.'
      out.push(info)
      continue
    }
    try {
      const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)])
      const der = Buffer.from(hex[1]!.replace(/\s/g, ''), 'hex')
      const parsed = asn1js.fromBER(der)
      const content = new pkijs.ContentInfo({ schema: parsed.result })
      const sd = new pkijs.SignedData({ schema: content.content })
      const cert = sd.certificates?.[0] as import('pkijs').Certificate | undefined
      if (cert) {
        const cn = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3')
        info.signer = cn ? String((cn.value.valueBlock as { value?: string }).value ?? '') : ''
        info.selfSigned = cert.subject.isEqual(cert.issuer)
      }
      const result = await sd.verify({ signer: 0, data: signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength), checkChain: false, extendedMode: true })
      info.valid = !!(result as { signatureVerified?: boolean }).signatureVerified
    } catch (error) {
      info.problem = (error as Error).message
    }
    out.push(info)
  }
  return out
}

/** A document that carries a signature must be saved by appending, or the signature breaks. */
export function hasSignatures(doc: PdfDoc): boolean {
  try {
    const flags = doc.getTrailer().get('Root').get('AcroForm').get('SigFlags')
    return flags.isNumber() && (flags.asNumber() & 1) === 1
  } catch {
    return false
  }
}

/** Checked quickly in the bytes, without opening. */
export function mayBeSigned(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('/ByteRange')
}

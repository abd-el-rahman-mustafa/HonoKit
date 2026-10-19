import { free, mupdf, type PdfDoc } from './mupdf'

/**
 * What a document declares about its print standard, carried into documents made from its pages
 * (decisions §82): the catalogue's /OutputIntents (with their ICC profiles), the
 * document information's GTS_PDFXVersion, GTS_PDFXConformance and Trapped, and the XMP
 * identification (pdfxid). A RIP or a preflight reads these; without them a PDF/X file stops
 * being one and the intended printing condition is lost.
 *
 * Extract and split keep the whole catalogue already (pages.ts `restoreCatalog`): the XMP there is
 * kept too, except a claim the result can no longer honestly make (`withdrawClaims`). Combine
 * starts a new document: it gets the first file's print standard only when every file declares
 * the same one, and a fresh XMP packet that claims PDF/X only — never PDF/A or PDF/UA, whose
 * structure and other conditions a combination of other files' pages does not keep.
 */

export interface PrintStandard {
  /** The catalogue's /OutputIntents, or null. */
  intents: mupdf.PDFObject | null
  /** Compared across files: each intent's /S, condition identifier and decoded profile. */
  signature: string
  version: string
  conformance: string
  trapped: string
  /** The source had an XMP packet (a PDF/X-1a:2001 file has none; it does not gain one). */
  xmp: boolean
  title: string
}

const XMP_PDFX = 'http://www.npes.org/pdfx/ns/id/'
const XMP_PDFA = 'http://www.aiim.org/pdfa/ns/id/'
const XMP_PDFUA = 'http://www.aiim.org/pdfua/ns/id/'

/**
 * The prefixes the packet binds to the namespace `uri`, with the usual one first (packets that
 * leave it undeclared still use it). The identification is the namespace, not the prefix: a file
 * may write `ida:part` for PDF/A.
 */
function prefixesFor(xmp: string, uri: string, usual: string): string[] {
  const out = new Set([usual])
  for (const m of xmp.slice(0, 1_000_000).matchAll(/xmlns:([A-Za-z_][A-Za-z0-9_-]{0,40})\s*=\s*["']([^"']{0,200})["']/g)) if (m[2]!.trim() === uri) out.add(m[1]!)
  return [...out]
}

/** A property of the namespace `uri` under any prefix the packet gives it. */
function xmpValueIn(xmp: string, uri: string, usual: string, local: string): string {
  for (const p of prefixesFor(xmp, uri, usual)) {
    const v = xmpValue(xmp, `${p}:${local}`)
    if (v) return v
  }
  return ''
}

function text(v: mupdf.PDFObject): string {
  return v.isString() ? v.asString() : v.isName() ? v.asName() : ''
}

/** A property of the XMP packet, written as an attribute or as an element. */
export function xmpValue(xmp: string, name: string): string {
  const attr = new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*"([^"]{0,200})"`).exec(xmp) ?? new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*'([^']{0,200})'`).exec(xmp)
  if (attr) return attr[1]!.trim()
  const elem = new RegExp(`<${name}>([^<]{0,200})</${name}>`).exec(xmp)
  return elem ? elem[1]!.trim() : ''
}

function metadataOf(doc: PdfDoc): string {
  try {
    const meta = doc.getTrailer().get('Root').get('Metadata')
    if (!meta.isStream()) return ''
    const buffer = meta.readStream()
    try {
      return buffer.asString()
    } finally {
      free(buffer)
    }
  } catch {
    return ''
  }
}

function profileHash(profile: mupdf.PDFObject): string {
  if (!profile.isStream()) return ''
  try {
    const buffer = profile.readStream()
    try {
      const bytes = buffer.asUint8Array()
      // FNV-1a over the decoded profile, with its length: equal profiles, equal signatures.
      let h = 0x811c9dc5
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
      return `${bytes.length}:${h.toString(16)}`
    } finally {
      free(buffer)
    }
  } catch {
    return '?'
  }
}

/** What a document declares; null when it declares no print standard at all. */
export function readPrintStandard(doc: PdfDoc): PrintStandard | null {
  const trailer = doc.getTrailer()
  const root = trailer.get('Root')
  const info = trailer.get('Info')
  const xmp = metadataOf(doc)
  const fromInfo = (key: string): string => (info.isDictionary() ? text(info.get(key)).replace(/[\0<>&]/g, '').trim() : '')
  const version = fromInfo('GTS_PDFXVersion') || (xmp.includes(XMP_PDFX) ? xmpValueIn(xmp, XMP_PDFX, 'pdfxid', 'GTS_PDFXVersion').replace(/[\0<>&]/g, '') : '')
  const conformance = fromInfo('GTS_PDFXConformance') || (xmp.includes(XMP_PDFX) ? xmpValueIn(xmp, XMP_PDFX, 'pdfxid', 'GTS_PDFXConformance').replace(/[\0<>&]/g, '') : '')
  const trapped = info.isDictionary() && info.get('Trapped').isName() ? info.get('Trapped').asName() : ''
  const list = root.get('OutputIntents')
  const intents = list.isArray() && list.length > 0 ? list : null
  const parts: string[] = []
  if (intents)
    for (let i = 0; i < intents.length; i++) {
      const it = intents.get(i)
      if (!it.isDictionary()) {
        parts.push('?')
        continue
      }
      const profile = it.get('DestOutputProfile')
      parts.push([text(it.get('S')), text(it.get('OutputConditionIdentifier')), text(it.get('RegistryName')), profile.isIndirect() && intents.get(i).isIndirect() && profile.asIndirect() === intents.get(i).asIndirect() ? '?' : profileHash(profile)].join('|'))
    }
  if (!intents && !version) return null
  return { intents, signature: parts.join('\n'), version, conformance, trapped, xmp: xmp.length > 0, title: fromInfo('Title') }
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A new XMP packet that claims PDF/X (and nothing else) for a combined document. */
export function pdfxPacket(p: PrintStandard): string {
  const bom = String.fromCharCode(0xfeff)
  const props = [`<pdfxid:GTS_PDFXVersion>${escapeXml(p.version)}</pdfxid:GTS_PDFXVersion>`]
  if (p.conformance) props.push(`<pdfxid:GTS_PDFXConformance>${escapeXml(p.conformance)}</pdfxid:GTS_PDFXConformance>`)
  if (p.trapped) props.push(`<pdf:Trapped>${escapeXml(p.trapped)}</pdf:Trapped>`)
  if (p.title) props.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(p.title)}</rdf:li></rdf:Alt></dc:title>`)
  return [
    `<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:pdfxid="${XMP_PDFX}" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    ...props,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>'
  ].join('\n')
}

function infoOf(doc: PdfDoc): mupdf.PDFObject {
  const trailer = doc.getTrailer()
  let info = trailer.get('Info')
  if (!info.isDictionary()) {
    info = doc.addObject(doc.newDictionary())
    trailer.put('Info', info)
  }
  return info
}

/**
 * Combine: the print standard of the files, when they all declare the same one (version, trapping
 * and output intents). When they differ, the result claims nothing (as before): one press
 * condition must not silently apply to another file's pages.
 */
export function carryPrintStandard(out: PdfDoc, sources: Array<PrintStandard | null>): void {
  const first = sources[0]
  if (!first) return
  const same = sources.every((s) => s && s.signature === first.signature && s.version === first.version && s.conformance === first.conformance && s.trapped === first.trapped)
  if (!same) return
  const root = out.getTrailer().get('Root')
  if (first.intents) root.put('OutputIntents', out.graftObject(first.intents))
  if (!first.version) return
  const info = infoOf(out)
  info.put('GTS_PDFXVersion', out.newString(first.version))
  if (first.conformance) info.put('GTS_PDFXConformance', out.newString(first.conformance))
  if (first.trapped) info.put('Trapped', out.newName(first.trapped))
  if (first.xmp) {
    const stream = out.addStream(pdfxPacket(first), {})
    stream.put('Type', out.newName('Metadata'))
    stream.put('Subtype', out.newName('XML'))
    root.put('Metadata', stream)
  }
}

/**
 * Extract, split, delete: a claim the result can no longer make honestly is taken out of the kept
 * XMP. PDF/UA, and PDF/A level A ("accessible"), need the structure tree; when no tagged content is
 * left, the claims go (PDF/X and the rest stay).
 */
export function withdrawClaims(doc: PdfDoc, reasons: { untagged: boolean }): void {
  if (!reasons.untagged) return
  const root = doc.getTrailer().get('Root')
  const meta = root.get('Metadata')
  if (!meta.isStream()) return
  const xmp = metadataOf(doc)
  if (!/pdfuaid|pdfaid/.test(xmp) && !xmp.includes(XMP_PDFA) && !xmp.includes(XMP_PDFUA)) return
  let next = xmp
  for (const ua of prefixesFor(xmp, XMP_PDFUA, 'pdfuaid')) for (const p of ['part', 'rev']) next = dropProperty(next, `${ua}:${p}`)
  for (const a of prefixesFor(xmp, XMP_PDFA, 'pdfaid')) if (/^a$/i.test(xmpValue(next, `${a}:conformance`))) for (const p of ['part', 'conformance', 'amd', 'rev']) next = dropProperty(next, `${a}:${p}`)
  if (next === xmp) return
  const stream = doc.addStream(next, {})
  meta.forEach((v, key) => {
    const k = String(key)
    if (k !== 'Length' && k !== 'Filter' && k !== 'DecodeParms') stream.put(k, v)
  })
  root.put('Metadata', stream)
}

/** The XMP without one property, in attribute or element form. */
function dropProperty(xmp: string, name: string): string {
  const n = name.replace(':', '\\:')
  return xmp
    .replace(new RegExp(`\\s${n}\\s*=\\s*("[^"]*"|'[^']*')`, 'g'), '')
    .replace(new RegExp(`\\s*<${n}>[^<]*</${n}>`, 'g'), '')
    .replace(new RegExp(`\\s*<${n}\\s*/>`, 'g'), '')
}

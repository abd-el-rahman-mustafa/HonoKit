import { PdfError } from './errors'
import { mupdf, type PdfDoc } from './mupdf'

/**
 * Redaction gives a rewritten page its own pruned /Resources, but the dictionary the page drew
 * through before can still name the picture or form that was removed: one inherited from a
 * /Pages node, or one resource dictionary shared by several pages. A full rewrite keeps whatever
 * is still referenced, so the removed picture's samples would stay in the saved file.
 *
 * `drawnResources` is called on the redacted pages before the redaction, `unlinkRemoved` after it:
 * every page-tree XObject or Font dictionary that still names an object a redacted page no longer
 * draws loses that entry, unless a page drawing through that dictionary still uses the name (the
 * same picture on another page). When a page's use of a name cannot be told, it fails closed.
 *
 * A font matters as much as a picture. A font's own drawing keeps the shape of the characters it
 * drew: a Type 3 font's glyph programs are content streams, and each may draw a picture of its
 * own, so a scanned or bitmap-font page whose text was redacted left the ink of every redacted
 * character in the saved file; an embedded subset's glyph outlines say which characters the text
 * had. A font the redacted pages no longer name goes with them.
 */

/** The resource kinds a redaction can leave behind. */
const KINDS = ['XObject', 'Font'] as const
type Kind = (typeof KINDS)[number]

/** Object numbers of the pictures and fonts each page draws through, as resolved before the redaction. */
export function drawnResources(doc: PdfDoc, pages: number[]): Map<Kind, Map<number, Set<number>>> {
  const out = new Map<Kind, Map<number, Set<number>>>()
  for (const kind of KINDS) {
    const perPage = new Map<number, Set<number>>()
    for (const p of pages) perPage.set(p, refsIn(doc.findPage(p).getInheritable('Resources'), kind))
    out.set(kind, perPage)
  }
  return out
}

function refsIn(resources: mupdf.PDFObject, kind: Kind): Set<number> {
  const refs = new Set<number>()
  if (!resources.isDictionary()) return refs
  const named = resources.get(kind)
  if (!named.isDictionary()) return refs
  named.forEach((val) => {
    if (val.isIndirect()) refs.add(val.asIndirect())
  })
  return refs
}

interface Group {
  xobj: mupdf.PDFObject
  pages: mupdf.PDFObject[]
}

/** Removes what the redaction took off the redacted pages from the dictionaries they shared. */
export function unlinkRemoved(doc: PdfDoc, before: Map<Kind, Map<number, Set<number>>>): number {
  let unlinked = 0
  for (const kind of KINDS) unlinked += unlinkKind(doc, kind, before.get(kind) ?? new Map())
  return unlinked
}

function unlinkKind(doc: PdfDoc, kind: Kind, before: Map<number, Set<number>>): number {
  const kept = new Set<number>()
  for (const p of before.keys()) for (const n of refsIn(doc.findPage(p).getInheritable('Resources'), kind)) kept.add(n)
  const removed = new Set<number>()
  for (const refs of before.values()) for (const n of refs) if (!kept.has(n)) removed.add(n)
  if (removed.size === 0) return 0
  let unlinked = 0
  for (const group of groups(doc, kind).values()) {
    const names: string[] = []
    group.xobj.forEach((val, key) => {
      if (val.isIndirect() && removed.has(val.asIndirect())) names.push(String(key))
    })
    for (const name of names) {
      if (group.pages.some((page) => drawsName(page, group.xobj, name))) continue
      group.xobj.delete(name)
      unlinked++
    }
  }
  return unlinked
}

/**
 * Every XObject dictionary in the page tree, with the pages that draw through it. A dictionary
 * held directly in a node's /Resources is told apart by that node; one that is an object of its
 * own (or inside a /Resources that is) by its object number, so a dictionary shared by several
 * nodes is one group.
 */
function groups(doc: PdfDoc, kind: Kind | 'Properties'): Map<string, Group> {
  const out = new Map<string, Group>()
  const seen = new Set<number>()
  const groupOf = (node: mupdf.PDFObject): string | null => {
    const res = node.get('Resources')
    if (!res.isDictionary()) return null
    const xobj = res.get(kind)
    if (!xobj.isDictionary()) return null
    const key = xobj.isIndirect() ? `x${xobj.asIndirect()}` : res.isIndirect() ? `r${res.asIndirect()}` : `n${node.asIndirect()}`
    if (!out.has(key)) out.set(key, { xobj, pages: [] })
    return key
  }
  const visit = (node: mupdf.PDFObject, inherited: string | null, depth: number): void => {
    if (!node.isIndirect() || depth > 64) throw new PdfError('corrupt', 'The page tree could not be followed.')
    const num = node.asIndirect()
    if (seen.has(num)) throw new PdfError('corrupt', 'The page tree could not be followed.')
    seen.add(num)
    // A /Resources key that is not a dictionary does not stop inheritance in readers either.
    const own = groupOf(node) ?? (node.get('Resources').isDictionary() ? null : inherited)
    const kids = node.get('Kids')
    if (node.get('Type').toString() === '/Pages' || kids.isArray()) {
      for (let i = 0; i < kids.length; i++) visit(kids.get(i), own, depth + 1)
      return
    }
    if (own) out.get(own)!.pages.push(node)
  }
  visit(doc.getTrailer().get('Root').get('Pages'), null, 0)
  return out
}

/**
 * Removes marked-content property lists named `names` (their /ActualText or /Alt described text a
 * redaction removed) from every page-tree /Properties dictionary that no page drawing through it
 * still names them in. Returns how many entries went.
 */
export function unlinkProperties(doc: PdfDoc, names: Set<string>): number {
  if (names.size === 0) return 0
  let unlinked = 0
  for (const group of groups(doc, 'Properties').values()) {
    for (const name of names) {
      if (group.xobj.get(name).isNull()) continue
      if (group.pages.some((page) => drawsName(page, group.xobj, name))) continue
      group.xobj.delete(name)
      unlinked++
    }
  }
  return unlinked
}

/**
 * Whether `page` still uses `name` from `xobj`: as a name in its content, or in a form of that
 * dictionary that draws through it. A form draws through it when it has no /Resources of its own,
 * when its /Resources is the very dictionary the page uses, or when its /Resources names this
 * same dictionary of names — all three are ordinary ways to write a shared one, and reading only
 * the first took a name a form still drew with, so a picture vanished from a page that had
 * nothing redacted on it (§102). A content stream that cannot be read fails the redaction rather
 * than guessing.
 */
function drawsName(page: mupdf.PDFObject, xobj: mupdf.PDFObject, name: string): boolean {
  const streams: mupdf.PDFObject[] = []
  const contents = page.get('Contents')
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) streams.push(contents.get(i))
  else if (contents.isStream()) streams.push(contents)
  const numOf = (o: mupdf.PDFObject): number => (o.isIndirect() ? o.asIndirect() : -1)
  const pageRes = numOf(page.getInheritable('Resources'))
  const dict = numOf(xobj)
  /** Whether a form's /Resources leads back to this very dictionary of names. */
  const through = (res: mupdf.PDFObject): boolean => {
    if (!res.isDictionary()) return true
    if (pageRes > 0 && numOf(res) === pageRes) return true
    return dict > 0 && ['XObject', 'Font', 'Properties'].some((k) => numOf(res.get(k)) === dict)
  }
  xobj.forEach((val, key) => {
    if (val.isStream() && val.get('Subtype').toString() === '/Form' && through(val.get('Resources'))) streams.push(val)
    // A Type 3 glyph program may itself draw with a name from the page's resources (PDF 32000
    // §9.6.5), so the glyph programs of the other fonts here are read too. The font being tested
    // skips its own: a font whose glyphs name it would never be let go.
    if (String(key) !== name && val.get('Subtype').toString() === '/Type3') {
      const procs = val.get('CharProcs')
      if (procs.isDictionary())
        procs.forEach((proc) => {
          if (proc.isStream()) streams.push(proc)
        })
    }
  })
  for (const s of streams) {
    let text: string
    try {
      text = latin1(s.readStream().asUint8Array())
    } catch {
      throw new PdfError('corrupt', 'A page could not be read, so the redaction could not be checked.')
    }
    if (namesIn(text).has(name)) return true
  }
  return false
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}

/** The names in a content stream, #xx escapes decoded. */
export function namesIn(text: string): Set<string> {
  const names = new Set<string>()
  for (const m of text.matchAll(/\/([^\s/[\]()<>{}%]*)/g)) names.add((m[1] ?? '').replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))))
  return names
}

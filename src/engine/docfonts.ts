import fontkit from '@pdf-lib/fontkit'
import type { mupdf, PdfDoc } from './mupdf'
import { familyOf } from './paragraphs'
import { systemFonts } from './systemFonts'

/**
 * The fonts a document uses, and how an edit can keep each one (docs/decisions.md §56):
 *  1. the same font installed on this PC (by name) — the edit looks exactly the same;
 *  2. otherwise the font embedded in the PDF itself, when it is a TrueType or OpenType file and
 *     holds every letter of the new text (a subset holds only the letters the page used);
 *  3. otherwise a similar font, and the person is told the font's name, so they can install it.
 */

export interface DocFont {
  /** As named in the file, without the subset tag ("Georgia-Bold"). */
  name: string
  /** The family ("Georgia"), for matching and for searching. */
  family: string
  embedded: boolean
  /** Only the letters the document used are in the file. */
  subset: boolean
  /** The embedded file is one HonoPDF can draw new text with (TrueType or OpenType). */
  reusable: boolean
  /** The same family installed on this PC, by its Windows name; null if not installed. */
  installed: string | null
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The PDF standard fonts (Helvetica, Times, Courier): every reader has them, and the editor
 * writes new text with the very same fonts, so an edit keeps their look without anything installed.
 */
export function isStandardFamily(family: string): boolean {
  return ['helvetica', 'times', 'timesroman', 'courier'].includes(compact(family))
}

/** The installed family that is the same font as a PDF family name ("TimesNewRomanPSMT" → "Times New Roman"). */
export function installedFamily(family: string): string | null {
  const want = compact(family)
  if (!want) return null
  for (const name of systemFonts().keys()) if (compact(name) === want) return name
  return null
}

interface FontEntry {
  dict: mupdf.PDFObject
  baseFont: string
}

/** A dictionary entry, or null when anything on the way is missing (files are often incomplete). */
function dictAt(obj: mupdf.PDFObject | null, key: string): mupdf.PDFObject | null {
  if (!obj) return null
  const base = obj.isIndirect() ? obj.resolve() : obj
  if (!base || !base.isDictionary()) return null
  const v = base.get(key)
  if (!v || v.isNull()) return null
  const r = v.isIndirect() ? v.resolve() : v
  return r && !r.isNull() ? r : null
}

function fontsOf(fonts: mupdf.PDFObject | null, out: FontEntry[]): void {
  if (!fonts || !fonts.isDictionary()) return
  fonts.forEach((value) => {
    const dict = value?.isIndirect() ? value.resolve() : value
    if (!dict || !dict.isDictionary()) return
    const base = dict.get('BaseFont')
    const baseFont = base && base.isName() ? base.asName() : ''
    const descendants = dictAt(dict, 'DescendantFonts')
    const first = descendants && descendants.isArray() && descendants.length ? descendants.get(0) : null
    const inner = first ? (first.isIndirect() ? first.resolve() : first) : dict
    out.push({ dict: inner && inner.isDictionary() ? inner : dict, baseFont })
  })
}

/** The font dictionaries a page names in its resources, and those of its form XObjects (a Type0 font's descendant carries the descriptor). */
function pageFonts(doc: PdfDoc, pageIndex: number): FontEntry[] {
  const out: FontEntry[] = []
  const resources = doc.findPage(pageIndex).getInheritable('Resources')
  const res = resources && resources.isDictionary() ? resources : null
  fontsOf(dictAt(res, 'Font'), out)
  const xobjects = dictAt(res, 'XObject')
  if (xobjects && xobjects.isDictionary()) xobjects.forEach((x) => fontsOf(dictAt(dictAt(x, 'Resources'), 'Font'), out))
  return out
}

function fontFile(dict: mupdf.PDFObject): { bytes: Uint8Array; kind: 'truetype' | 'opentype' | 'cff' | 'type1' } | null {
  const descriptor = dictAt(dict, 'FontDescriptor')
  if (!descriptor || !descriptor.isDictionary()) return null
  const tt = descriptor.get('FontFile2')
  if (tt.isStream()) return { bytes: new Uint8Array(tt.readStream().asUint8Array()), kind: 'truetype' }
  const f3 = descriptor.get('FontFile3')
  if (f3.isStream()) {
    const sub = f3.get('Subtype')
    return { bytes: new Uint8Array(f3.readStream().asUint8Array()), kind: sub.isName() && sub.asName() === 'OpenType' ? 'opentype' : 'cff' }
  }
  const t1 = descriptor.get('FontFile')
  if (t1.isStream()) return { bytes: new Uint8Array(t1.readStream().asUint8Array()), kind: 'type1' }
  return null
}

/**
 * Whether new text can be drawn with the file through pdf-lib: fontkit reads it and its letter map
 * is Unicode. Subsets often map private codes instead (a Mac 1,0 or symbol 3,0 table where "M" is
 * code 1): drawing with those gives empty or wrong letters, so they are not reused.
 */
function readable(bytes: Uint8Array): boolean {
  try {
    // fontkit reads tables lazily: `cmap` is read when asked for.
    const font = fontkit.create(Buffer.from(bytes)) as unknown as { characterSet?: number[]; cmap?: { tables?: Array<{ platformID: number; encodingID: number }> }; hasGlyphForCodePoint(cp: number): boolean }
    const tables = font.cmap?.tables ?? []
    const unicode = tables.some((t) => t.platformID === 0 || (t.platformID === 3 && (t.encodingID === 1 || t.encodingID === 10)))
    if (!unicode || !Array.isArray(font.characterSet)) return false
    return font.characterSet.some((cp) => cp > 32 && font.hasGlyphForCodePoint(cp))
  } catch {
    return false
  }
}

export function documentFonts(doc: PdfDoc, pages?: number[]): DocFont[] {
  const seen = new Map<string, DocFont>()
  const targets = pages ?? Array.from({ length: doc.countPages() }, (_, i) => i)
  for (const p of targets) {
    for (const entry of pageFonts(doc, p)) {
      if (!entry.baseFont) continue
      const subset = /^[A-Z]{6}\+/.test(entry.baseFont)
      const name = entry.baseFont.replace(/^[A-Z]{6}\+/, '')
      if (seen.has(name)) continue
      const file = fontFile(entry.dict)
      const family = familyOf(entry.baseFont)
      seen.set(name, {
        name,
        family,
        embedded: !!file,
        subset,
        reusable: !!file && (file.kind === 'truetype' || file.kind === 'opentype') && readable(file.bytes),
        installed: installedFamily(family) ?? (isStandardFamily(family) && !file ? family : null)
      })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every face of a family the page carries as a usable TrueType/OpenType file, with its weight and
 * style read from its name — for the editor to show typing in the document's own font (§66).
 */
export function embeddedFaces(doc: PdfDoc, pageIndex: number, family: string): Array<{ bold: boolean; italic: boolean; bytes: Uint8Array; kind: 'truetype' | 'opentype' }> {
  const want = compact(family)
  const out: Array<{ bold: boolean; italic: boolean; bytes: Uint8Array; kind: 'truetype' | 'opentype' }> = []
  const seen = new Set<string>()
  for (const e of pageFonts(doc, pageIndex)) {
    if (compact(familyOf(e.baseFont)) !== want) continue
    const n = e.baseFont.toLowerCase()
    const bold = /bold|black|heavy|semibold/.test(n)
    const italic = /italic|oblique/.test(n)
    const key = `${bold}|${italic}`
    if (seen.has(key)) continue
    const file = fontFile(e.dict)
    if (!file || (file.kind !== 'truetype' && file.kind !== 'opentype') || !readable(file.bytes)) continue
    seen.add(key)
    out.push({ bold, italic, bytes: file.bytes, kind: file.kind })
  }
  return out
}

/**
 * The embedded file of the font a paragraph was set in, if new text can be drawn with it: the
 * page's font whose family matches, preferring the same weight and slant.
 */
export function embeddedFont(doc: PdfDoc, pageIndex: number, family: string, bold: boolean, italic: boolean): Uint8Array | null {
  const want = compact(family)
  const candidates = pageFonts(doc, pageIndex).filter((e) => compact(familyOf(e.baseFont)) === want)
  const score = (e: FontEntry): number => {
    const n = e.baseFont.toLowerCase()
    return (/bold|black|heavy|semibold/.test(n) === bold ? 2 : 0) + (/italic|oblique/.test(n) === italic ? 1 : 0)
  }
  for (const e of candidates.sort((a, b) => score(b) - score(a))) {
    const file = fontFile(e.dict)
    if (file && (file.kind === 'truetype' || file.kind === 'opentype') && readable(file.bytes)) return file.bytes
  }
  return null
}


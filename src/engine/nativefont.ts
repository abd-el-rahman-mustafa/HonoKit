import { readToUnicode } from './ligatures'
import { type mupdf, type PdfDoc } from './mupdf'

/**
 * New text in the paragraph's own font, as the file has it (docs/decisions.md §59).
 *
 * Most newspaper fonts are embedded as bare CFF or Type1 subsets that pdf-lib cannot draw with,
 * and are not installed on the reader's PC: an edit came out in a stand-in face — another weight
 * (HED-Medium as regular), other digit shapes (a page drawing ١٩٧١ shown as 1971). Instead, the new
 * words are written with the font object already on the page, by the codes the page itself uses:
 * the letters look exactly as the rest of the paragraph.
 *
 * Only letters the page shows in that very font are used (a font's map may list codes whose glyphs
 * were never embedded, which would print nothing). Arabic letters are left to the stand-in: a
 * subset's map gives the letter but not which joined form a glyph is. Digits and punctuation —
 * Arabic ones included — come from the font.
 */
export interface NativeFont {
  /** The font dictionary's object number, the same in every copy opened from the same bytes. */
  num: number
  /** Two-byte codes (Type0, Identity-H); otherwise one byte. */
  twoByte: boolean
  /** Letter → its code and width (thousandths of the size). */
  glyphs: Map<number, { code: number; width: number }>
  /** The width of a space, when the font has no space glyph of its own (thousandths). */
  space: number
}

/** Letters whose shape depends on their neighbours (Arabic, Hebrew presentation): not taken from a subset. */
function joining(cp: number): boolean {
  return (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0x0610 && cp <= 0x061a) || (cp >= 0x0620 && cp <= 0x065f) || (cp >= 0x066e && cp <= 0x06d3) || (cp >= 0x06d5 && cp <= 0x06ef) || (cp >= 0x06fa && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff) || cp === 0x200c || cp === 0x200d
}

const plain = (name: string): string => name.replace(/^[A-Z]{6}\+/, '').replace(/-Identity-[HV]$/, '').toLowerCase()

/**
 * The page's font named `fontName` (as MuPDF reads it), with the letters `seen` on the page in it.
 * Null when it cannot be used: not found, Type3, another CMap than Identity-H, no ToUnicode map.
 */
export function nativeFont(doc: PdfDoc, pageIndex: number, fontName: string, seen: Set<number>): NativeFont | null {
  if (!fontName || seen.size === 0) return null
  const taken: Array<{ destroy(): void }> = []
  const take = <T extends mupdf.PDFObject | null | undefined>(o: T): T => {
    if (o) taken.push(o)
    return o
  }
  const deref = (o: mupdf.PDFObject | null): mupdf.PDFObject | null => (o && o.isIndirect() ? take(o.resolve()) : o)
  try {
    const candidates: Array<{ num: number; dict: mupdf.PDFObject }> = []
    const visit = (fonts: mupdf.PDFObject | null): void => {
      const dict = deref(fonts)
      if (!dict || !dict.isDictionary()) return
      dict.forEach((value) => {
        take(value)
        if (!value || !value.isIndirect()) return
        const font = deref(value)
        if (!font || !font.isDictionary()) return
        const base = take(font.get('BaseFont'))
        const names = [base && base.isName() ? base.asName() : '']
        const descendants = deref(take(font.get('DescendantFonts')))
        const first = descendants && descendants.isArray() && descendants.length ? deref(take(descendants.get(0))) : null
        const inner = first ? take(first.get('BaseFont')) : null
        if (inner && inner.isName()) names.push(inner.asName())
        if (names.some((n) => n && (n === fontName || plain(n) === plain(fontName)))) candidates.push({ num: value.asIndirect(), dict: font })
      })
    }
    const resources = deref(take(take(doc.findPage(pageIndex)).getInheritable('Resources')))
    if (!resources || !resources.isDictionary()) return null
    visit(take(resources.get('Font')))
    const xobjects = deref(take(resources.get('XObject')))
    if (xobjects && xobjects.isDictionary()) {
      xobjects.forEach((x) => {
        take(x)
        const form = deref(x)
        const r = form && form.isDictionary() ? deref(take(form.get('Resources'))) : null
        if (r && r.isDictionary()) visit(take(r.get('Font')))
      })
    }
    // The same subset can be named by several resources; prefer an exact name, then the most letters.
    let best: NativeFont | null = null
    for (const c of candidates) {
      const font = read(c.num, c.dict, seen, take, deref)
      if (font && (!best || font.glyphs.size > best.glyphs.size)) best = font
    }
    return best
  } catch {
    return null
  } finally {
    for (const o of taken) {
      try {
        o.destroy()
      } catch {
        // already released
      }
    }
  }
}

function read(num: number, font: mupdf.PDFObject, seen: Set<number>, take: <T extends mupdf.PDFObject | null | undefined>(o: T) => T, deref: (o: mupdf.PDFObject | null) => mupdf.PDFObject | null): NativeFont | null {
  const subtype = take(font.get('Subtype'))
  const kind = subtype && subtype.isName() ? subtype.asName() : ''
  const tu = take(font.get('ToUnicode'))
  let map: Map<number, string> | null = null
  if (tu && tu.isStream()) {
    const buffer = tu.readStream()
    map = readToUnicode(buffer.asString())
    buffer.destroy()
  } else if (kind === 'Type1' || kind === 'MMType1' || kind === 'TrueType') {
    // No map: a simple font's letters come from its /Encoding (a code page, and glyph names).
    map = encodingMap(font, take, deref)
  }
  if (!map) return null
  const widthOf = new Map<number, number>()
  let missing = 0
  let twoByte = false
  if (kind === 'Type0') {
    const enc = take(font.get('Encoding'))
    if (!enc || !enc.isName() || enc.asName() !== 'Identity-H') return null
    twoByte = true
    const descendants = deref(take(font.get('DescendantFonts')))
    const cid = descendants && descendants.isArray() && descendants.length ? deref(take(descendants.get(0))) : null
    if (!cid || !cid.isDictionary()) return null
    const dw = take(cid.get('DW'))
    missing = dw && dw.isNumber() ? dw.asNumber() : 1000
    const w = deref(take(cid.get('W')))
    if (w && w.isArray()) {
      for (let i = 0; i < w.length; ) {
        const a = take(w.get(i))
        const b = deref(take(w.get(i + 1)))
        if (!a || !a.isNumber() || !b) break
        if (b.isArray()) {
          for (let k = 0; k < b.length; k++) {
            const v = take(b.get(k))
            if (v && v.isNumber()) widthOf.set(a.asNumber() + k, v.asNumber())
          }
          i += 2
        } else {
          const c = take(w.get(i + 2))
          if (!b.isNumber() || !c || !c.isNumber()) break
          for (let code = a.asNumber(); code <= b.asNumber() && code - a.asNumber() < 65536; code++) widthOf.set(code, c.asNumber())
          i += 3
        }
      }
    }
  } else if (kind === 'Type1' || kind === 'MMType1' || kind === 'TrueType') {
    const first = take(font.get('FirstChar'))
    const widths = deref(take(font.get('Widths')))
    if (!first || !first.isNumber() || !widths || !widths.isArray()) return null
    for (let k = 0; k < widths.length; k++) {
      const v = take(widths.get(k))
      if (v && v.isNumber()) widthOf.set(first.asNumber() + k, v.asNumber())
    }
    const descriptor = deref(take(font.get('FontDescriptor')))
    const mw = descriptor && descriptor.isDictionary() ? take(descriptor.get('MissingWidth')) : null
    missing = mw && mw.isNumber() ? mw.asNumber() : 0
  } else {
    return null
  }
  const glyphs = new Map<number, { code: number; width: number }>()
  for (const [code, text] of map) {
    const chars = [...text]
    if (chars.length !== 1) continue
    const cp = chars[0]!.codePointAt(0)!
    if (cp === 0xfffd || cp < 0x20 || joining(cp) || !seen.has(cp) || glyphs.has(cp)) continue
    const width = widthOf.get(code) ?? missing
    if (!(width > 0) && cp !== 0x20) continue
    glyphs.set(cp, { code, width })
  }
  if (glyphs.size === 0) return null
  return { num, twoByte, glyphs, space: glyphs.get(0x20)?.width ?? 250 }
}

/** Whether every letter of `text` (spaces aside) is in the font. */
export function covers(font: NativeFont, text: string): boolean {
  for (const c of text) if (c !== ' ' && !font.glyphs.has(c.codePointAt(0)!)) return false
  return true
}

/** The width of `text` at `size`, in points. */
export function nativeWidth(font: NativeFont, text: string, size: number): number {
  let w = 0
  for (const c of text) w += c === ' ' ? (font.glyphs.get(0x20)?.width ?? font.space) : (font.glyphs.get(c.codePointAt(0)!)?.width ?? 0)
  return (w * size) / 1000
}

/**
 * `text` as a TJ array: hex strings of codes, and for a space the font has no glyph for, a move
 * left of a quarter em (in thousandths of the size, negative moves right).
 */
export function nativeTJ(font: NativeFont, text: string): Array<string | number> {
  const parts: Array<string | number> = []
  let codes = ''
  for (const c of text) {
    const g = font.glyphs.get(c.codePointAt(0)!)
    if (g) codes += g.code.toString(16).padStart(font.twoByte ? 4 : 2, '0')
    else if (c === ' ') {
      if (codes) parts.push(codes)
      codes = ''
      parts.push(-font.space)
    }
  }
  if (codes) parts.push(codes)
  return parts
}

/** The placeholder font name an overlay uses for the page's font object `num`; swapped back when placed. */
export const NATIVE_PREFIX = 'HonoNative-'

/** Common glyph names (Adobe Glyph List) for letters a code page does not give by itself. */
const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '\u2019', quoteleft: '\u2018',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{',
  bar: '|', braceright: '}', asciitilde: '~', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  endash: '\u2013', emdash: '\u2014', quotedblleft: '\u201C', quotedblright: '\u201D', quotesinglbase: '\u201A', quotedblbase: '\u201E', bullet: '\u2022',
  ellipsis: '\u2026', dagger: '\u2020', daggerdbl: '\u2021', guilsinglleft: '\u2039', guilsinglright: '\u203A', guillemotleft: '\u00AB', guillemotright: '\u00BB',
  trademark: '\u2122', registered: '\u00AE', copyright: '\u00A9', degree: '\u00B0', section: '\u00A7', paragraph: '\u00B6', periodcentered: '\u00B7',
  minus: '\u2212', multiply: '\u00D7', divide: '\u00F7', Euro: '\u20AC', sterling: '\u00A3', yen: '\u00A5', cent: '\u00A2', currency: '\u00A4',
  nbspace: '\u00A0', exclamdown: '\u00A1', questiondown: '\u00BF', dieresis: '\u00A8', acute: '\u00B4', cedilla: '\u00B8', fi: 'fi', fl: 'fl',
  Agrave: 'À', Aacute: 'Á', Acircumflex: 'Â', Atilde: 'Ã', Adieresis: 'Ä', Aring: 'Å', AE: 'Æ', Ccedilla: 'Ç', Egrave: 'È', Eacute: 'É', Ecircumflex: 'Ê',
  Edieresis: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icircumflex: 'Î', Idieresis: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocircumflex: 'Ô', Otilde: 'Õ',
  Odieresis: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucircumflex: 'Û', Udieresis: 'Ü', Yacute: 'Ý', germandbls: 'ß', agrave: 'à', aacute: 'á',
  acircumflex: 'â', atilde: 'ã', adieresis: 'ä', aring: 'å', ae: 'æ', ccedilla: 'ç', egrave: 'è', eacute: 'é', ecircumflex: 'ê', edieresis: 'ë',
  igrave: 'ì', iacute: 'í', icircumflex: 'î', idieresis: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocircumflex: 'ô', otilde: 'õ', odieresis: 'ö',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucircumflex: 'û', udieresis: 'ü', yacute: 'ý', ydieresis: 'ÿ', dotlessi: '\u0131'
}

/** The letters a glyph name stands for: a single letter, uniXXXX, uXXXX[XX], or a common name. */
function glyphText(name: string): string | null {
  const n = name.replace(/\..*$/, '')
  if (/^[A-Za-z]$/.test(n)) return n
  const uni = /^uni([0-9A-F]{4})$/.exec(n)
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16))
  const u = /^u([0-9A-F]{4,6})$/.exec(n)
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16))
  return GLYPHS[n] ?? null
}

/**
 * Code → letter for a simple font without a ToUnicode map, as a reader works it out: the base
 * encoding (WinAnsi, MacRoman, or Standard for plain ASCII), then the /Differences names.
 * A font with no /Encoding uses its own built-in one, which is not read here: null.
 */
function encodingMap(font: mupdf.PDFObject, take: <T extends mupdf.PDFObject | null | undefined>(o: T) => T, deref: (o: mupdf.PDFObject | null) => mupdf.PDFObject | null): Map<number, string> | null {
  const enc = deref(take(font.get('Encoding')))
  if (!enc || enc.isNull()) return null
  let base = enc.isName() ? enc.asName() : ''
  let differences: mupdf.PDFObject | null = null
  if (enc.isDictionary()) {
    const b = take(enc.get('BaseEncoding'))
    base = b && b.isName() ? b.asName() : 'StandardEncoding'
    differences = deref(take(enc.get('Differences')))
  }
  const map = new Map<number, string>()
  const page = base === 'WinAnsiEncoding' ? 'windows-1252' : base === 'MacRomanEncoding' ? 'macintosh' : null
  if (page) {
    const decoder = new TextDecoder(page)
    for (let code = 32; code < 256; code++) {
      if (code === 127) continue
      const c = decoder.decode(new Uint8Array([code]))
      if (c && c !== '\uFFFD') map.set(code, c)
    }
  } else if (base === 'StandardEncoding') {
    for (let code = 32; code < 127; code++) map.set(code, code === 0x27 ? '\u2019' : code === 0x60 ? '\u2018' : String.fromCharCode(code))
  } else {
    return null
  }
  if (differences && differences.isArray()) {
    let code = 0
    for (let i = 0; i < differences.length; i++) {
      const x = take(differences.get(i))
      if (x.isNumber()) code = x.asNumber()
      else if (x.isName()) {
        const text = glyphText(x.asName())
        if (text) map.set(code, text)
        else map.delete(code)
        code++
      }
    }
  }
  return map
}

import { free, mupdf, type PdfDoc } from './mupdf'
import { nativeFont } from './nativefont'

/**
 * A PDF's own font made into one the editor's window can show (docs/decisions.md §66), so typing
 * shows in the document's typeface, as in Acrobat. Fonts in PDFs are rarely usable as they are:
 * newspapers embed bare CFF ("Type1C"), TrueType subsets often map letters by private codes (a Mac
 * 1,0 table, symbol 3,0, or none at all) and lack tables browsers require. Here the font's own
 * glyphs get a Unicode letter map — built from the letters the page shows in that font (their
 * codes from its ToUnicode/Encoding, §59, and each code's glyph through MuPDF) — and the missing
 * tables; bare CFF is wrapped as OpenType. Only letters the page shows are mapped: others fall back
 * to the next family in the editor's list, as the engine falls back when it draws.
 */

/** Big-endian writer. */
class W {
  private bytes: number[] = []
  u8(v: number): this {
    this.bytes.push(v & 255)
    return this
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v)
  }
  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff)
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.bytes.push(x)
    return this
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.bytes.push(0)
    return this
  }
  get length(): number {
    return this.bytes.length
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/** A Unicode letter map (cmap format 4 in a 3,1 subtable; format 12 too when letters lie beyond the BMP). */
function cmapTable(map: Map<number, number>): Uint8Array {
  const entries = [...map].filter(([u, g]) => g > 0 && u <= 0x10ffff).sort((a, b) => a[0] - b[0])
  const bmp = entries.filter(([u]) => u < 0xffff)
  // Format 4: one segment per letter (simple, valid), then the 0xFFFF end segment.
  const segs = [...bmp.map(([u, g]) => ({ start: u, end: u, delta: (g - u + 0x10000) % 0x10000 })), { start: 0xffff, end: 0xffff, delta: 1 }]
  const n = segs.length
  const f4 = new W()
  const length = 16 + n * 8
  const searchRange = 2 ** Math.floor(Math.log2(n)) * 2
  f4.u16(4).u16(length).u16(0).u16(n * 2).u16(searchRange).u16(Math.log2(searchRange / 2)).u16(n * 2 - searchRange)
  for (const s of segs) f4.u16(s.end)
  f4.u16(0)
  for (const s of segs) f4.u16(s.start)
  for (const s of segs) f4.u16(s.delta)
  for (let i = 0; i < n; i++) f4.u16(0)
  const beyond = entries.filter(([u]) => u > 0xffff)
  const sub4 = f4.done()
  const out = new W()
  if (!beyond.length) {
    out.u16(0).u16(1).u16(3).u16(1).u32(12).raw(sub4)
    return out.done()
  }
  const f12 = new W()
  f12.u16(12).u16(0).u32(16 + entries.length * 12).u32(0).u32(entries.length)
  for (const [u, g] of entries) f12.u32(u).u32(u).u32(g)
  out.u16(0).u16(2).u16(3).u16(1).u32(20).u16(3).u16(10).u32(20 + sub4.length).raw(sub4).raw(f12.done())
  return out.done()
}

/** A name table with the family's names (Windows platform, UTF-16BE). */
function nameTable(family: string, sub: string): Uint8Array {
  const records: Array<[number, string]> = [
    [1, family],
    [2, sub],
    [3, `${family} ${sub}`],
    [4, `${family} ${sub}`],
    [6, `${family}-${sub}`.replace(/[^A-Za-z0-9-]/g, '')]
  ]
  const strings = records.map(([, s]) => {
    const w = new W()
    for (const c of s) w.u16(c.charCodeAt(0))
    return w.done()
  })
  const w = new W()
  w.u16(0).u16(records.length).u16(6 + records.length * 12)
  let offset = 0
  records.forEach(([id], i) => {
    w.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i]!.length).u16(offset)
    offset += strings[i]!.length
  })
  for (const s of strings) w.raw(s)
  return w.done()
}

function os2Table(o: { ascent: number; descent: number; avgWidth: number; bold: boolean; italic: boolean; firstChar: number; lastChar: number }): Uint8Array {
  const w = new W()
  const selection = (o.italic ? 1 : 0) | (o.bold ? 32 : 0) | (!o.bold && !o.italic ? 64 : 0)
  w.u16(3).i16(o.avgWidth).u16(o.bold ? 700 : 400).u16(5).u16(0)
  w.i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(250)
  w.i16(0).zeros(10).zeros(16).raw(Uint8Array.from([0x48, 0x4f, 0x4e, 0x4f]))
  w.u16(selection).u16(Math.min(o.firstChar, 0xffff)).u16(Math.min(o.lastChar, 0xffff))
  w.i16(o.ascent).i16(o.descent).i16(Math.round((o.ascent - o.descent) * 0.1)).u16(o.ascent).u16(-o.descent)
  w.u32(1).u32(0).i16(500).i16(700).u16(0).u16(32).u16(0)
  return w.done()
}

function postTable(italic: boolean): Uint8Array {
  return new W().u32(0x00030000).u32(italic ? (0x10000 - 12) * 0x10000 : 0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).done()
}

/** Tables written as an sfnt (TrueType or OpenType-CFF) file. */
function sfnt(tables: Map<string, Uint8Array>, version: number): Uint8Array {
  const tags = [...tables.keys()].sort()
  const n = tags.length
  const sel = Math.floor(Math.log2(n))
  const w = new W()
  w.u32(version).u16(n).u16(2 ** sel * 16).u16(sel).u16(n * 16 - 2 ** sel * 16)
  let offset = 12 + n * 16
  const sum = (d: Uint8Array): number => {
    let s = 0
    for (let i = 0; i < d.length; i += 4) s = (s + (((d[i] ?? 0) << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0))) >>> 0
    return s
  }
  for (const tag of tags) {
    const d = tables.get(tag)!
    for (const c of tag) w.u8(c.charCodeAt(0))
    w.u32(sum(d)).u32(offset).u32(d.length)
    offset += (d.length + 3) & ~3
  }
  for (const tag of tags) {
    const d = tables.get(tag)!
    w.raw(d).zeros(((d.length + 3) & ~3) - d.length)
  }
  return w.done()
}

function readTables(data: Uint8Array): Map<string, Uint8Array> | null {
  if (data.length < 12) return null
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const n = v.getUint16(4)
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16
    if (at + 16 > data.length) return null
    const tag = String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!)
    const off = v.getUint32(at + 8)
    const len = v.getUint32(at + 12)
    if (off + len > data.length) return null
    out.set(tag, data.subarray(off, off + len))
  }
  return out
}

/**
 * A TrueType font's own letter map, code → glyph, from its first subtable of a kind a simple PDF
 * font is drawn through (Windows symbol 3,0, Mac 1,0, else Unicode): formats 0, 4 and 6.
 */
function codeMap(cmap: Uint8Array | undefined): ((code: number) => number) | null {
  if (!cmap || cmap.length < 4) return null
  const v = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength)
  const n = v.getUint16(2)
  const subs: Array<{ platform: number; encoding: number; offset: number }> = []
  for (let i = 0; i < n && 4 + i * 8 + 8 <= cmap.length; i++) subs.push({ platform: v.getUint16(4 + i * 8), encoding: v.getUint16(6 + i * 8), offset: v.getUint32(8 + i * 8) })
  const rank = (s: { platform: number; encoding: number }): number => (s.platform === 3 && s.encoding === 0 ? 0 : s.platform === 1 && s.encoding === 0 ? 1 : 2)
  for (const s of subs.sort((a, b) => rank(a) - rank(b))) {
    const o = s.offset
    if (o + 6 > cmap.length) continue
    const format = v.getUint16(o)
    if (format === 0 && o + 262 <= cmap.length) return (c) => (c < 256 ? cmap[o + 6 + c]! : 0)
    if (format === 6) {
      const first = v.getUint16(o + 6)
      const count = v.getUint16(o + 8)
      return (c) => (c >= first && c < first + count && o + 10 + (c - first) * 2 + 2 <= cmap.length ? v.getUint16(o + 10 + (c - first) * 2) : 0)
    }
    if (format === 4) {
      const segX2 = v.getUint16(o + 6)
      const ends = o + 14
      const starts = ends + segX2 + 2
      const deltas = starts + segX2
      const ranges = deltas + segX2
      if (ranges + segX2 > cmap.length) continue
      return (c) => {
        for (let k = 0; k < segX2; k += 2) {
          if (c > v.getUint16(ends + k)) continue
          const start = v.getUint16(starts + k)
          if (c < start) return 0
          const delta = v.getUint16(deltas + k)
          const ro = v.getUint16(ranges + k)
          if (!ro) return (c + delta) & 0xffff
          const at = ranges + k + ro + (c - start) * 2
          if (at + 2 > cmap.length) return 0
          const g = v.getUint16(at)
          return g ? (g + delta) & 0xffff : 0
        }
        return 0
      }
    }
  }
  return null
}

/** A CFF's glyph count (its CharStrings INDEX) and FontBBox, read from its Top DICT. */
function cffInfo(cff: Uint8Array): { glyphs: number; bbox: [number, number, number, number] } | null {
  try {
    const at = (i: number): number => cff[i]!
    const index = (pos: number): { count: number; items: Array<[number, number]>; end: number } => {
      const count = (at(pos) << 8) | at(pos + 1)
      if (count === 0) return { count, items: [], end: pos + 2 }
      const offSize = at(pos + 2)
      const offAt = (k: number): number => {
        let v = 0
        for (let b = 0; b < offSize; b++) v = (v << 8) | at(pos + 3 + k * offSize + b)
        return v
      }
      const base = pos + 3 + (count + 1) * offSize - 1
      const items: Array<[number, number]> = []
      for (let k = 0; k < count; k++) items.push([base + offAt(k), base + offAt(k + 1)])
      return { count, items, end: base + offAt(count) }
    }
    const names = index(at(2))
    const top = index(names.end)
    const [s, e] = top.items[0]!
    // DICT: operands then operators.
    const operands: number[] = []
    let charStrings = -1
    let bbox: [number, number, number, number] = [0, -250, 1000, 900]
    for (let i = s; i < e; ) {
      const b0 = at(i)
      if (b0 <= 21) {
        let op = b0
        i++
        if (b0 === 12) op = 1200 + at(i++)
        if (op === 17) charStrings = operands[operands.length - 1] ?? -1
        if (op === 5 && operands.length >= 4) bbox = operands.slice(-4) as [number, number, number, number]
        operands.length = 0
      } else if (b0 === 28) {
        operands.push(((at(i + 1) << 24) | (at(i + 2) << 16)) >> 16)
        i += 3
      } else if (b0 === 29) {
        operands.push((at(i + 1) << 24) | (at(i + 2) << 16) | (at(i + 3) << 8) | at(i + 4))
        i += 5
      } else if (b0 === 30) {
        // A real number: kept as 0 (only integers matter here).
        i++
        while (i < e && (at(i) & 0x0f) !== 0x0f && (at(i) >> 4) !== 0x0f) i++
        i++
        operands.push(0)
      } else if (b0 >= 32 && b0 <= 246) {
        operands.push(b0 - 139)
        i++
      } else if (b0 >= 247 && b0 <= 250) {
        operands.push((b0 - 247) * 256 + at(i + 1) + 108)
        i += 2
      } else if (b0 >= 251 && b0 <= 254) {
        operands.push(-(b0 - 251) * 256 - at(i + 1) - 108)
        i += 2
      } else i++
    }
    if (charStrings <= 0) return null
    return { glyphs: index(charStrings).count, bbox }
  } catch {
    return null
  }
}

interface Source {
  kind: 'truetype' | 'cff'
  data: Uint8Array
  /** Type0 font: its CIDToGIDMap (null = identity). */
  cidToGid: Uint16Array | null
  type0: boolean
  ascent: number
  descent: number
  baseFont: string
}

/** An object itself, whether stored directly or by reference. */
const R = (o: mupdf.PDFObject): mupdf.PDFObject => (o.isIndirect() ? o.resolve() : o)

/** The font file and what goes with it, for the page's font object named `fontName`. */
function sourceOf(doc: PdfDoc, pageIndex: number, fontName: string): Source | null {
  const plain = (n: string): string => n.replace(/^[A-Z]{6}\+/, '').toLowerCase()
  const page = doc.findPage(pageIndex)
  let found: Source | null = null
  const visit = (fonts: mupdf.PDFObject | null): void => {
    if (found || !fonts || !fonts.isDictionary()) return
    fonts.forEach((value) => {
      if (found) return
      const font = R(value)
      if (!font.isDictionary()) return
      const base = font.get('BaseFont')
      const name = base.isName() ? base.asName() : ''
      if (name !== fontName && plain(name) !== plain(fontName)) return
      const type0 = font.get('Subtype').isName() && font.get('Subtype').asName() === 'Type0'
      const desc = type0 ? R(R(font.get('DescendantFonts')).get(0)) : font
      const fd = R(desc.get('FontDescriptor'))
      if (!fd.isDictionary()) return
      const num = (k: string, d: number): number => (fd.get(k).isNumber() ? fd.get(k).asNumber() : d)
      const ascent = num('Ascent', 800)
      const descent = num('Descent', -200)
      let cidToGid: Uint16Array | null = null
      const map = desc.get('CIDToGIDMap')
      if (map.isStream()) {
        const b = map.readStream().asUint8Array()
        cidToGid = new Uint16Array(b.length >> 1)
        for (let i = 0; i < cidToGid.length; i++) cidToGid[i] = (b[i * 2]! << 8) | b[i * 2 + 1]!
      }
      const tt = fd.get('FontFile2')
      const f3 = fd.get('FontFile3')
      if (tt.isStream()) found = { kind: 'truetype', data: new Uint8Array(tt.readStream().asUint8Array()), cidToGid, type0, ascent, descent, baseFont: name }
      else if (f3.isStream()) {
        const sub = f3.get('Subtype').isName() ? f3.get('Subtype').asName() : ''
        const data = new Uint8Array(f3.readStream().asUint8Array())
        // OpenType (FontFile3/OpenType) is an sfnt: its glyphs as TrueType or CFF inside.
        if (sub === 'OpenType') {
          const t = readTables(data)
          if (t?.has('glyf')) found = { kind: 'truetype', data, cidToGid, type0, ascent, descent, baseFont: name }
          else if (t?.get('CFF ')) found = { kind: 'cff', data: new Uint8Array(t.get('CFF ')!), cidToGid, type0, ascent, descent, baseFont: name }
        } else if (sub === 'Type1C') found = { kind: 'cff', data, cidToGid, type0, ascent, descent, baseFont: name }
      }
    })
  }
  const res = page.getInheritable('Resources')
  if (res && res.isDictionary()) {
    visit(R(res.get('Font')))
    const xo = R(res.get('XObject'))
    if (xo.isDictionary())
      xo.forEach((x) => {
        const r = R(R(x).get('Resources'))
        if (r.isDictionary()) visit(R(r.get('Font')))
      })
  }
  return found
}

/**
 * The page's font `fontName` as a font file a browser shows (TrueType or OpenType-CFF), with the
 * letters the page shows in it (`seen`) mapped; null when it cannot be made (no file, Type3, CID
 * CFF, nothing mapped).
 */
export function browserFont(doc: PdfDoc, pageIndex: number, fontName: string, seen: Set<number>, look: { bold: boolean; italic: boolean; family: string }): Uint8Array | null {
  let source: Source | null
  try {
    source = sourceOf(doc, pageIndex, fontName)
  } catch {
    return null
  }
  if (!source || (source.kind === 'cff' && source.type0)) return null
  const native = nativeFont(doc, pageIndex, fontName, seen)
  if (!native || !native.glyphs.size) return null
  let mf: mupdf.Font | null = null
  try {
    mf = new mupdf.Font(look.family, source.data)
    // Each letter's glyph: by its code (a Type0 font's code is its CID), through the font's own maps.
    const own = source.kind === 'truetype' ? codeMap(readTables(source.data)?.get('cmap')) : null
    const map = new Map<number, number>()
    for (const [uni, { code }] of native.glyphs) {
      let gid = 0
      if (source.type0) gid = source.cidToGid ? (source.cidToGid[code] ?? 0) : code
      else if (source.kind === 'cff') gid = mf.encodeCharacter(uni)
      else {
        // A simple TrueType font is drawn through its own map (symbol fonts at 0xF000 + code); without one, the code is the glyph.
        gid = own ? own(code) || own(0xf000 + code) : code
        if (gid <= 0) gid = mf.encodeCharacter(uni)
      }
      if (gid > 0) map.set(uni, gid)
    }
    if (!map.size) return null
    const codes = [...map.keys()]
    const sub = look.bold && look.italic ? 'Bold Italic' : look.bold ? 'Bold' : look.italic ? 'Italic' : 'Regular'
    const os2 = (avgWidth: number): Uint8Array => os2Table({ ascent: Math.round(source!.ascent), descent: Math.round(source!.descent), avgWidth, bold: look.bold, italic: look.italic, firstChar: Math.min(...codes), lastChar: Math.max(...codes) })
    if (source.kind === 'truetype') {
      const tables = readTables(source.data)
      if (!tables || !tables.has('glyf') || !tables.has('loca') || !tables.has('head') || !tables.has('hhea') || !tables.has('hmtx') || !tables.has('maxp')) return null
      const out = new Map(tables)
      out.set('cmap', cmapTable(map))
      out.set('name', nameTable(look.family, sub))
      if (!out.has('OS/2')) out.set('OS/2', os2(500))
      if (!out.has('post')) out.set('post', postTable(look.italic))
      for (const tag of ['DSIG', 'kern', 'vhea', 'vmtx', 'VDMX', 'hdmx', 'LTSH']) out.delete(tag)
      return sfnt(out, 0x00010000)
    }
    // Bare CFF: wrapped as OpenType, its widths from MuPDF, in thousandths of an em.
    const info = cffInfo(source.data)
    if (!info || info.glyphs < 2) return null
    const widths: number[] = []
    for (let g = 0; g < info.glyphs; g++) widths.push(Math.max(0, Math.round(mf.advanceGlyph(g) * 1000)))
    const [x0, y0, x1, y1] = info.bbox
    const head = new W()
      .u32(0x00010000)
      .u32(0x00010000)
      .u32(0)
      .u32(0x5f0f3cf5)
      .u16(0)
      .u16(1000)
      .zeros(16)
      .i16(x0)
      .i16(y0)
      .i16(x1)
      .i16(y1)
      .u16((look.bold ? 1 : 0) | (look.italic ? 2 : 0))
      .u16(8)
      .i16(2)
      .i16(0)
      .i16(0)
      .done()
    const hhea = new W()
      .u32(0x00010000)
      .i16(Math.round(source.ascent))
      .i16(Math.round(source.descent))
      .i16(0)
      .u16(Math.max(...widths))
      .i16(x0)
      .i16(0)
      .i16(x1)
      .i16(1)
      .i16(0)
      .i16(0)
      .zeros(8)
      .i16(0)
      .u16(info.glyphs)
      .done()
    const hmtx = new W()
    for (const w of widths) hmtx.u16(w).i16(0)
    const maxp = new W().u32(0x00005000).u16(info.glyphs).done()
    const avg = Math.round(widths.filter((w) => w > 0).reduce((a, b) => a + b, 0) / Math.max(1, widths.filter((w) => w > 0).length))
    const tables = new Map<string, Uint8Array>([
      ['CFF ', source.data],
      ['cmap', cmapTable(map)],
      ['head', head],
      ['hhea', hhea],
      ['hmtx', hmtx.done()],
      ['maxp', maxp],
      ['name', nameTable(look.family, sub)],
      ['OS/2', os2(avg)],
      ['post', postTable(look.italic)]
    ])
    return sfnt(tables, 0x4f54544f)
  } catch {
    return null
  } finally {
    if (mf) free(mf)
  }
}

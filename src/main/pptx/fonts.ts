/**
 * Fonts embedded in a PowerPoint file (§63). PowerPoint stores them as Embedded OpenType
 * (".fntdata"), usually compressed with MicroType Express (W3C MTX submission, 2008): the font's
 * tables in Compact Table Format, then LZCOMP. Here they become plain TrueType again so the
 * slides are drawn in their own typefaces.
 *
 * Hinting is left out: the glyph instructions (MTX blocks 2 and 3) and the tables that only
 * serve them or screen sizes (cvt, fpgm, prep, hdmx, VDMX, LTSH) — slides become a PDF of
 * outlines, where hinting plays no part.
 */

/* --- LZCOMP (MTX §3, Appendix C), ported from the sample code ---------------------------- */

class BitReader {
  private count = 0
  private buffer = 0
  private index = 0
  constructor(private data: Uint8Array) {}

  bit(): number {
    if (this.count-- === 0) {
      if (this.index >= this.data.length) throw new Error('MTX: data ended early')
      this.buffer = this.data[this.index++]!
      this.count = 7
    }
    this.buffer <<= 1
    return this.buffer & 0x100
  }

  value(bits: number): number {
    let v = 0
    for (let i = bits - 1; i >= 0; i--) v = (v << 1) | (this.bit() ? 1 : 0)
    return v >>> 0
  }
}

const bitsUsed = (x: number): number => (x <= 0 ? 1 : 32 - Math.clz32(x))

/** Adaptive Huffman coding of symbols 0 … range-1 (AHUFF.C). */
class AdaptiveHuffman {
  private up: Int32Array
  private left: Int32Array
  private right: Int32Array
  private code: Int32Array
  private weight: Float64Array
  private symbolIndex: Int32Array

  constructor(
    private bits: BitReader,
    range: number
  ) {
    const size = 2 * range
    this.up = new Int32Array(size)
    this.left = new Int32Array(size)
    this.right = new Int32Array(size)
    this.code = new Int32Array(size)
    this.weight = new Float64Array(size)
    this.symbolIndex = new Int32Array(range)
    for (let i = 2; i < size; i++) {
      this.up[i] = i >> 1
      this.weight[i] = 1
    }
    for (let i = 1; i < range; i++) {
      this.left[i] = 2 * i
      this.right[i] = 2 * i + 1
    }
    for (let i = 0; i < range; i++) {
      this.code[i] = -1
      this.code[range + i] = i
      this.left[range + i] = -1
      this.right[range + i] = -1
      this.symbolIndex[i] = range + i
    }
    this.initWeight(1)
    let bitCount2 = 0
    if (range > 256 && range < 512) bitCount2 = bitsUsed(range - 256 - 1) + 1
    if (bitCount2 !== 0) {
      this.updateWeight(this.symbolIndex[256]!)
      this.updateWeight(this.symbolIndex[257]!)
      for (let i = 0; i < 12; i++) this.updateWeight(this.symbolIndex[range - 3]!)
      for (let i = 0; i < 6; i++) this.updateWeight(this.symbolIndex[range - 2]!)
    } else {
      for (let j = 0; j < 2; j++) for (let i = 0; i < range; i++) this.updateWeight(this.symbolIndex[i]!)
    }
  }

  private initWeight(a: number): number {
    if (this.code[a]! < 0) this.weight[a] = this.initWeight(this.left[a]!) + this.initWeight(this.right[a]!)
    return this.weight[a]!
  }

  private swap(a: number, b: number): void {
    const upa = this.up[a]!
    const upb = this.up[b]!
    for (const arr of [this.left, this.right, this.code] as const) {
      const t = arr[a]!
      arr[a] = arr[b]!
      arr[b] = t
    }
    const tw = this.weight[a]!
    this.weight[a] = this.weight[b]!
    this.weight[b] = tw
    this.up[a] = upa
    this.up[b] = upb
    for (const n of [a, b]) {
      const c = this.code[n]!
      if (c < 0) {
        this.up[this.left[n]!] = n
        this.up[this.right[n]!] = n
      } else this.symbolIndex[c] = n
    }
  }

  private updateWeight(a: number): void {
    const ROOT = 1
    for (; a !== ROOT; a = this.up[a]!) {
      const w = this.weight[a]!
      let b = a - 1
      if (this.weight[b] === w) {
        do b--
        while (this.weight[b] === w)
        b++
        if (b > ROOT) {
          this.swap(a, b)
          a = b
        }
      }
      this.weight[a] = w + 1
    }
    this.weight[a] = this.weight[a]! + 1
  }

  read(): number {
    let a = 1
    let symbol: number
    do {
      a = this.bits.bit() ? this.right[a]! : this.left[a]!
      symbol = this.code[a]!
    } while (symbol < 0)
    this.updateWeight(a)
    return symbol
  }
}

/** One LZCOMP-compressed block, decompressed. */
export function lzcomp(data: Uint8Array): Uint8Array {
  const bits = new BitReader(data)
  const runLength = bits.bit() !== 0
  const dist = new AdaptiveHuffman(bits, 8)
  const len = new AdaptiveHuffman(bits, 8)
  const outLen = bits.value(24)
  let ranges = 1
  while (1 + (1 << (3 * ranges)) - 1 < outLen) ranges++
  const DUP2 = 256 + 8 * ranges
  const DUP4 = DUP2 + 1
  const DUP6 = DUP2 + 2
  const sym = new AdaptiveHuffman(bits, DUP6 + 1)
  // The window starts pre-loaded so early bytes can be copies too.
  const PRELOAD = 2 * 32 * 96 + 4 * 256
  const window = new Uint8Array(PRELOAD + outLen)
  let i = 0
  for (let k = 0; k < 32; k++)
    for (let j = 0; j < 96; j++) {
      window[i++] = k
      window[i++] = j
    }
  for (let j = 0; i < PRELOAD && j < 256; j++) for (let r = 0; r < 4; r++) window[i++] = j
  // The run-length layer (RUNLENGTHCOMP_SaveBytes): escape byte, then count + value.
  const out: number[] = []
  let state: 'initial' | 'normal' | 'escape' | 'count' = 'initial'
  let escape = 0
  let count = 0
  const save = (v: number): void => {
    if (!runLength) {
      out.push(v)
      return
    }
    if (state === 'initial') {
      escape = v
      state = 'normal'
    } else if (state === 'normal') {
      if (v === escape) state = 'escape'
      else out.push(v)
    } else if (state === 'escape') {
      count = v
      if (count === 0) {
        out.push(escape)
        state = 'normal'
      } else state = 'count'
    } else {
      for (let r = 0; r < count; r++) out.push(v)
      state = 'normal'
    }
  }
  let pos = PRELOAD
  const end = PRELOAD + outLen
  while (pos < end) {
    const s = sym.read()
    if (s < 256 || s === DUP2 || s === DUP4 || s === DUP6) {
      const v = s < 256 ? s : window[pos - (s === DUP2 ? 2 : s === DUP4 ? 4 : 6)]!
      window[pos++] = v
      save(v)
      continue
    }
    // A copy: its length in 2-bit pieces with a stop bit, then its distance in 3-bit pieces.
    let bitsVal = s - 256
    const distRanges = Math.floor(bitsVal / 8) + 1
    bitsVal %= 8
    let length = 0
    for (;;) {
      const done = (bitsVal & 4) === 0
      length = (length << 2) | (bitsVal & 3)
      if (done) break
      bitsVal = len.read()
    }
    length += 2
    let distance = 0
    for (let r = distRanges; r > 0; r--) distance = (distance << 3) | dist.read()
    distance += 1
    if (distance >= 512) length++
    const start = pos - distance - length + 1
    for (let j = 0; j < length && pos < window.length; j++) {
      const v = window[start + j]!
      window[pos++] = v
      save(v)
    }
  }
  return Uint8Array.from(out)
}

/* --- Compact Table Format → TrueType (MTX §5) --------------------------------------------- */

class Reader {
  pos = 0
  constructor(private d: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.d.length) throw new Error('MTX: glyph data ended early')
    return this.d[this.pos++]!
  }
  u16(): number {
    return (this.u8() << 8) | this.u8()
  }
  i16(): number {
    const v = this.u16()
    return v & 0x8000 ? v - 0x10000 : v
  }
  /** 255USHORT (§6.1.1). */
  u255(): number {
    const code = this.u8()
    if (code === 253) return this.u16()
    if (code === 255) return 253 + this.u8()
    if (code === 254) return 506 + this.u8()
    return code
  }
  bytes(n: number): Uint8Array {
    const b = this.d.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }
}

class Writer {
  private chunks: number[] = []
  u8(v: number): void {
    this.chunks.push(v & 0xff)
  }
  u16(v: number): void {
    this.u8(v >> 8)
    this.u8(v)
  }
  i16(v: number): void {
    this.u16(v < 0 ? v + 0x10000 : v)
  }
  u32(v: number): void {
    this.u16(Math.floor(v / 0x10000) & 0xffff)
    this.u16(v & 0xffff)
  }
  bytes(b: Uint8Array): void {
    for (const x of b) this.chunks.push(x)
  }
  pad(): void {
    while (this.chunks.length % 4) this.chunks.push(0)
  }
  get length(): number {
    return this.chunks.length
  }
  done(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }
}

/** A point's (dx, dy) from its triplet flag (§5.11 — the same table WOFF2 later took over). */
function triplet(flag: number, r: Reader): [number, number] {
  const sign = (f: number, v: number): number => (f & 1 ? v : -v)
  if (flag < 10) return [0, sign(flag, ((flag & 14) << 7) + r.u8())]
  if (flag < 20) return [sign(flag, (((flag - 10) & 14) << 7) + r.u8()), 0]
  if (flag < 84) {
    const b0 = flag - 20
    const b1 = r.u8()
    return [sign(flag, 1 + (b0 & 0x30) + (b1 >> 4)), sign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f))]
  }
  if (flag < 120) {
    const b0 = flag - 84
    const x = r.u8()
    const y = r.u8()
    return [sign(flag, 1 + (Math.floor(b0 / 12) << 8) + x), sign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + y)]
  }
  if (flag < 124) {
    const b1 = r.u8()
    const b2 = r.u8()
    const b3 = r.u8()
    return [sign(flag, (b1 << 4) + (b2 >> 4)), sign(flag >> 1, ((b2 & 0x0f) << 8) + b3)]
  }
  const a = r.u16()
  const b = r.u16()
  return [sign(flag, a), sign(flag >> 1, b)]
}

/** One CTF glyph as a TrueType glyph (empty when it has no contours); instructions left out. */
function glyph(r: Reader, out: Writer): void {
  let contours = r.i16()
  if (contours === -1) {
    // Composite: its box, then its components as in TrueType, then (with instructions) two counts.
    const box = [r.i16(), r.i16(), r.i16(), r.i16()]
    out.i16(-1)
    box.forEach((v) => out.i16(v))
    let flags: number
    let instructions = false
    do {
      flags = r.u16()
      const glyphIndex = r.u16()
      let size = flags & 0x0001 ? 4 : 2
      if (flags & 0x0008) size += 2
      else if (flags & 0x0040) size += 4
      else if (flags & 0x0080) size += 8
      if (flags & 0x0100) instructions = true
      out.u16(flags & ~0x0100)
      out.u16(glyphIndex)
      out.bytes(r.bytes(size))
    } while (flags & 0x0020)
    if (instructions) {
      r.u255()
      r.u255()
    }
    return
  }
  // An empty glyph (a space) is its contour count alone.
  if (contours === 0) return
  let box: number[] | null = null
  if (contours === 0x7fff) {
    contours = r.i16()
    box = [r.i16(), r.i16(), r.i16(), r.i16()]
  }
  const ends: number[] = []
  for (let c = 0; c < contours; c++) {
    const v = r.u255()
    ends.push(c === 0 ? v : ends[c - 1]! + v)
  }
  const points = contours ? ends[contours - 1]! + 1 : 0
  const flags = Array.from(r.bytes(points))
  const xs: number[] = []
  const ys: number[] = []
  let x = 0
  let y = 0
  for (const f of flags) {
    const [dx, dy] = triplet(f & 0x7f, r)
    x += dx
    y += dy
    xs.push(x)
    ys.push(y)
  }
  r.u255() // pushCount
  r.u255() // codeSize
  if (!contours) return
  box ??= [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  out.i16(contours)
  box.forEach((v) => out.i16(v))
  ends.forEach((e) => out.u16(e))
  out.u16(0)
  for (const f of flags) out.u8(f & 0x80 ? 0 : 1)
  let px = 0
  let py = 0
  for (let i = 0; i < points; i++) {
    out.i16(xs[i]! - px)
    px = xs[i]!
  }
  for (let i = 0; i < points; i++) {
    out.i16(ys[i]! - py)
    py = ys[i]!
  }
}

const DROP = new Set(['cvt ', 'fpgm', 'prep', 'hdmx', 'VDMX', 'LTSH', 'DSIG', 'loca', 'glyf'])

/** The font of a CTF block (block 1 of MTX) as a TrueType file. */
export function ctfToTtf(ctf: Uint8Array): Uint8Array {
  const view = new DataView(ctf.buffer, ctf.byteOffset, ctf.byteLength)
  const numTables = view.getUint16(4)
  const tables = new Map<string, Uint8Array>()
  for (let t = 0; t < numTables; t++) {
    const at = 12 + t * 16
    const tag = String.fromCharCode(ctf[at]!, ctf[at + 1]!, ctf[at + 2]!, ctf[at + 3]!)
    const offset = view.getUint32(at + 8)
    const length = view.getUint32(at + 12)
    tables.set(tag, ctf.subarray(offset, offset + length))
  }
  const maxp = tables.get('maxp')
  const ctfGlyf = tables.get('glyf')
  const head = tables.get('head')
  // An OpenType font with CFF outlines has nothing translated: it is used as it is.
  if (tables.has('CFF ') || tables.has('CFF2')) {
    const out = new Map([...tables].filter(([tag, data]) => tag !== 'loca' && data.length > 0))
    return sfnt(out, 0x4f54544f)
  }
  if (!maxp || !ctfGlyf || !head) throw new Error('MTX: the font has no glyphs')
  const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset).getUint16(4)
  // Glyphs one after another; loca is rebuilt from where each one ends.
  const r = new Reader(ctfGlyf)
  const glyf = new Writer()
  const loca: number[] = [0]
  for (let g = 0; g < numGlyphs; g++) {
    glyph(r, glyf)
    glyf.pad()
    loca.push(glyf.length)
  }
  const locaW = new Writer()
  loca.forEach((v) => locaW.u32(v))
  // head: long loca offsets; the checksum adjustment is not checked by browsers.
  const newHead = Uint8Array.from(head)
  newHead[50] = 0
  newHead[51] = 1
  const out = new Map<string, Uint8Array>()
  for (const [tag, data] of tables) if (!DROP.has(tag)) out.set(tag, tag === 'head' ? newHead : data)
  out.set('glyf', glyf.done())
  out.set('loca', locaW.done())
  return sfnt(out)
}

/** Tables written as a TrueType file. */
function sfnt(tables: Map<string, Uint8Array>, version = 0x00010000): Uint8Array {
  const tags = [...tables.keys()].sort()
  const n = tags.length
  const entrySelector = Math.floor(Math.log2(n))
  const searchRange = 2 ** entrySelector * 16
  const w = new Writer()
  w.u32(version)
  w.u16(n)
  w.u16(searchRange)
  w.u16(entrySelector)
  w.u16(n * 16 - searchRange)
  let offset = 12 + n * 16
  const checksum = (d: Uint8Array): number => {
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum = (sum + (((d[i] ?? 0) << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0))) >>> 0
    return sum
  }
  for (const tag of tags) {
    const d = tables.get(tag)!
    for (let i = 0; i < 4; i++) w.u8(tag.charCodeAt(i))
    w.u32(checksum(d))
    w.u32(offset)
    w.u32(d.length)
    offset += (d.length + 3) & ~3
  }
  for (const tag of tags) {
    w.bytes(tables.get(tag)!)
    w.pad()
  }
  return w.done()
}

/* --- Embedded OpenType ---------------------------------------------------------------------- */

/** An embedded font part (.fntdata: EOT, MTX-compressed or not) as TrueType, or null when it is not one. */
export function embeddedFont(eot: Uint8Array): Uint8Array | null {
  if (eot.length < 82) return null
  const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength)
  // A plain TrueType/OpenType file is used as it is.
  const tag = view.getUint32(0)
  if (tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565) return eot
  const eotSize = view.getUint32(0, true)
  const dataSize = view.getUint32(4, true)
  const flags = view.getUint32(12, true)
  const magic = view.getUint16(34, true)
  if (magic !== 0x504c || dataSize > eot.length || eotSize > eot.length + 4) return null
  // The font data is last in the file.
  let data = Uint8Array.from(eot.subarray(eotSize - dataSize, eotSize))
  if (flags & 0x10000000) data = data.map((b) => b ^ 0x50)
  if (!(flags & 0x4)) return data
  // MicroType Express: a 10-byte header, then three LZCOMP blocks; the first is the font.
  const offset2 = (data[4]! << 16) | (data[5]! << 8) | data[6]!
  if (data[0] !== 3 || offset2 <= 10 || offset2 > data.length) return null
  return ctfToTtf(lzcomp(data.subarray(10, offset2)))
}

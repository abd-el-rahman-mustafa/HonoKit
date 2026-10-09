import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'

/**
 * Reading a PowerPoint file (docs/decisions.md §63): the package's parts, XML helpers, the theme
 * and DrawingML colours. Everything a slide needs is read up front, so drawing it is synchronous.
 */

const NS: Record<string, string> = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'
}

export type El = Element

/** Whether an element has this qualified name ("a:solidFill"; a bare name matches any namespace). */
export function is(e: El, name: string): boolean {
  const colon = name.indexOf(':')
  if (colon < 0) return e.localName === name
  return e.localName === name.slice(colon + 1) && e.namespaceURI === NS[name.slice(0, colon)]
}

/** Direct child elements, all or with one qualified name ("a:solidFill"). */
export function kids(el: El | null | undefined, name?: string): El[] {
  if (!el) return []
  const out: El[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    const e = n as El
    if (!name || is(e, name)) out.push(e)
  }
  return out
}

/** The first direct child with this name, following a path of names ("p:txBody", "a:bodyPr"). */
export function kid(el: El | null | undefined, ...names: string[]): El | null {
  let at: El | null | undefined = el
  for (const name of names) {
    at = kids(at, name)[0]
    if (!at) return null
  }
  return at ?? null
}

/** The first descendant with this name, at any depth. */
export function find(el: El | null | undefined, name: string): El | null {
  for (const k of kids(el)) {
    if (is(k, name)) return k
    const f = find(k, name)
    if (f) return f
  }
  return null
}

export function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null
  if (name.includes(':')) {
    const [prefix, local] = name.split(':')
    const v = el.getAttributeNS(NS[prefix!] ?? null, local!)
    return v === '' && !el.hasAttributeNS(NS[prefix!] ?? null, local!) ? null : v
  }
  return el.hasAttribute(name) ? el.getAttribute(name) : null
}

export function num(el: El | null | undefined, name: string): number | undefined {
  const v = attr(el, name)
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function bool(el: El | null | undefined, name: string): boolean | undefined {
  const v = attr(el, name)
  if (v === null) return undefined
  return v === '1' || v === 'true' || v === 'on'
}

/**
 * Markup compatibility: an mc:AlternateContent is replaced by its Fallback (what older PowerPoint
 * draws, e.g. a picture for an equation), or its Choice when there is none.
 */
export function resolveAlternate(el: El): El[] {
  if (el.localName !== 'AlternateContent') return [el]
  const pick = kid(el, 'mc:Fallback') ?? kid(el, 'mc:Choice')
  return pick ? kids(pick).flatMap(resolveAlternate) : []
}

export function parseXml(text: string): El {
  const doc = new DOMParser({ onError: () => undefined } as never).parseFromString(text, 'application/xml')
  return doc.documentElement as unknown as El
}

export interface Rel {
  target: string
  type: string
  external: boolean
}

/** A part's folder-relative target made a path in the package ("ppt/slides/../media/x.png" → "ppt/media/x.png"). */
export function joinPart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const step of target.split('/')) {
    if (step === '..') parts.pop()
    else if (step !== '.' && step !== '') parts.push(step)
  }
  return parts.join('/')
}

/** The package: its XML parts parsed on demand (and kept), its other parts as bytes. */
export class Package {
  private xmlCache = new Map<string, El | null>()
  private relCache = new Map<string, Map<string, Rel>>()

  private constructor(
    private texts: Map<string, string>,
    readonly zip: JSZip
  ) {}

  static async open(bytes: Uint8Array): Promise<Package> {
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(bytes)
    } catch {
      throw new Error('This is not a PowerPoint (.pptx) file, or it is damaged.')
    }
    const texts = new Map<string, string>()
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir || !/\.(xml|rels)$/i.test(name)) continue
      texts.set(name, await file.async('string'))
    }
    if (!texts.has('ppt/presentation.xml')) throw new Error('This file has no presentation in it (is it a PowerPoint .pptx file?).')
    return new Package(texts, zip)
  }

  xml(path: string): El | null {
    if (!this.xmlCache.has(path)) {
      const text = this.texts.get(path)
      this.xmlCache.set(path, text === undefined ? null : parseXml(text))
    }
    return this.xmlCache.get(path)!
  }

  rels(part: string): Map<string, Rel> {
    let map = this.relCache.get(part)
    if (map) return map
    map = new Map()
    const slash = part.lastIndexOf('/')
    const relPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
    const root = this.xml(relPath)
    for (const r of kids(root)) {
      const id = attr(r, 'Id')
      const target = attr(r, 'Target')
      if (!id || target === null) continue
      const external = attr(r, 'TargetMode') === 'External'
      map.set(id, { target: external ? target : joinPart(part, target), type: attr(r, 'Type') ?? '', external })
    }
    this.relCache.set(part, map)
    return map
  }

  /** The part a relationship of `part` points to (by id), or the first one of a type ending. */
  target(part: string, id: string | null): string | null {
    if (!id) return null
    const r = this.rels(part).get(id)
    return r && !r.external ? r.target : null
  }

  relOfType(part: string, typeEnd: string): string | null {
    for (const r of this.rels(part).values()) if (!r.external && r.type.endsWith(typeEnd)) return r.target
    return null
  }

  has(path: string): boolean {
    return !!this.zip.file(path)
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const f = this.zip.file(path)
    return f ? new Uint8Array(await f.async('uint8array')) : null
  }
}

/* --- colours -------------------------------------------------------------------------------- */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080',
  darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', purple: '800080', navy: '000080', maroon: '800000', silver: 'C0C0C0', teal: '008080',
  cyan: '00FFFF', magenta: 'FF00FF', lime: '00FF00', olive: '808000', brown: 'A52A2A', pink: 'FFC0CB', gold: 'FFD700', darkBlue: '00008B', darkRed: '8B0000',
  darkGreen: '006400', lightBlue: 'ADD8E6', skyBlue: '87CEEB', indigo: '4B0082', violet: 'EE82EE', tan: 'D2B48C', beige: 'F5F5DC', ltGray: 'D3D3D3', dkGray: 'A9A9A9'
}

const SYSTEM: Record<string, string> = { window: 'FFFFFF', windowText: '000000', btnFace: 'F0F0F0', btnText: '000000', highlight: '0078D7', highlightText: 'FFFFFF', grayText: '6D6D6D', menu: 'F0F0F0', menuText: '000000' }

function hex(h: string): Rgba {
  const v = parseInt(h.padStart(6, '0').slice(-6), 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 }
}

function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return [h * 60, s, l]
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    const c = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - c * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return { r: f(0), g: f(8), b: f(4), a }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** The colour transforms DrawingML puts inside a colour element, applied in order. */
function transform(base: Rgba, el: El): Rgba {
  let c = { ...base }
  for (const t of kids(el)) {
    const v = (num(t, 'val') ?? 0) / 100000
    switch (t.localName) {
      case 'alpha':
        c.a = clamp01(v)
        break
      case 'alphaMod':
        c.a = clamp01(c.a * v)
        break
      case 'alphaOff':
        c.a = clamp01(c.a + v)
        break
      case 'lumMod':
      case 'lumOff':
      case 'satMod':
      case 'satOff':
      case 'hueMod':
      case 'hueOff':
      case 'lum':
      case 'sat':
      case 'hue': {
        let [h, s, l] = toHsl(c)
        const raw = num(t, 'val') ?? 0
        if (t.localName === 'lumMod') l *= v
        else if (t.localName === 'lumOff') l += v
        else if (t.localName === 'lum') l = v
        else if (t.localName === 'satMod') s *= v
        else if (t.localName === 'satOff') s += v
        else if (t.localName === 'sat') s = v
        else if (t.localName === 'hueMod') h *= v
        else if (t.localName === 'hueOff') h += raw / 60000
        else h = raw / 60000
        c = fromHsl(((h % 360) + 360) % 360, clamp01(s), clamp01(l), c.a)
        break
      }
      case 'tint':
        c = { r: c.r + (255 - c.r) * (1 - v), g: c.g + (255 - c.g) * (1 - v), b: c.b + (255 - c.b) * (1 - v), a: c.a }
        break
      case 'shade':
        c = { r: c.r * v, g: c.g * v, b: c.b * v, a: c.a }
        break
      case 'comp': {
        const [h, s, l] = toHsl(c)
        c = fromHsl((h + 180) % 360, s, l, c.a)
        break
      }
      case 'inv':
        c = { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b, a: c.a }
        break
      case 'gray': {
        const y = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
        c = { r: y, g: y, b: y, a: c.a }
        break
      }
    }
  }
  return { r: Math.round(Math.max(0, Math.min(255, c.r))), g: Math.round(Math.max(0, Math.min(255, c.g))), b: Math.round(Math.max(0, Math.min(255, c.b))), a: c.a }
}

export function css(c: Rgba | null | undefined): string {
  if (!c) return 'transparent'
  return c.a >= 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${+c.a.toFixed(3)})`
}

/* --- theme ------------------------------------------------------------------------------------ */

export interface Theme {
  colors: Record<string, Rgba>
  major: { latin: string; ea: string; cs: string; arab: string }
  minor: { latin: string; ea: string; cs: string; arab: string }
  fills: El[]
  lines: El[]
  effects: El[]
  bgFills: El[]
}

export function readTheme(root: El | null): Theme {
  const elements = kid(root, 'a:themeElements')
  const scheme = kid(elements, 'a:clrScheme')
  const colors: Record<string, Rgba> = {}
  for (const c of kids(scheme)) {
    const v = kids(c)[0]
    if (!v) continue
    colors[c.localName] = v.localName === 'sysClr' ? hex(attr(v, 'lastClr') ?? SYSTEM[attr(v, 'val') ?? ''] ?? '000000') : hex(attr(v, 'val') ?? '000000')
  }
  const fontsOf = (el: El | null): Theme['major'] => ({
    latin: attr(kid(el, 'a:latin'), 'typeface') ?? '',
    ea: attr(kid(el, 'a:ea'), 'typeface') ?? '',
    cs: attr(kid(el, 'a:cs'), 'typeface') ?? '',
    arab: attr(kids(el, 'a:font').find((f) => attr(f, 'script') === 'Arab') ?? null, 'typeface') ?? ''
  })
  const fontScheme = kid(elements, 'a:fontScheme')
  const fmt = kid(elements, 'a:fmtScheme')
  return {
    colors,
    major: fontsOf(kid(fontScheme, 'a:majorFont')),
    minor: fontsOf(kid(fontScheme, 'a:minorFont')),
    fills: kids(kid(fmt, 'a:fillStyleLst')),
    lines: kids(kid(fmt, 'a:lnStyleLst')),
    effects: kids(kid(fmt, 'a:effectStyleLst')),
    bgFills: kids(kid(fmt, 'a:bgFillStyleLst'))
  }
}

/** How a slide reads colours: the theme, the master's colour map (with any override), and the "placeholder colour" of a style reference. */
export interface ColorContext {
  theme: Theme
  map: Record<string, string>
  ph?: Rgba | null
}

export const DEFAULT_MAP: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' }

export function readColorMap(el: El | null): Record<string, string> | null {
  if (!el) return null
  const map: Record<string, string> = {}
  for (const k of Object.keys(DEFAULT_MAP)) map[k] = attr(el, k) ?? DEFAULT_MAP[k]!
  return map
}

/** A colour element's value: the first colour child of `el` (solidFill, a gradient stop, a style reference…). */
export function color(el: El | null | undefined, ctx: ColorContext): Rgba | null {
  if (!el) return null
  for (const c of kids(el)) {
    let base: Rgba | null = null
    switch (c.localName) {
      case 'srgbClr':
        base = hex(attr(c, 'val') ?? '000000')
        break
      case 'scrgbClr': {
        const lin = (v: number): number => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
        base = { r: lin((num(c, 'r') ?? 0) / 100000), g: lin((num(c, 'g') ?? 0) / 100000), b: lin((num(c, 'b') ?? 0) / 100000), a: 1 }
        break
      }
      case 'hslClr':
        base = fromHsl((num(c, 'hue') ?? 0) / 60000, (num(c, 'sat') ?? 0) / 100000, (num(c, 'lum') ?? 0) / 100000, 1)
        break
      case 'sysClr':
        base = hex(attr(c, 'lastClr') ?? SYSTEM[attr(c, 'val') ?? ''] ?? '000000')
        break
      case 'prstClr':
        base = hex(PRESET[attr(c, 'val') ?? ''] ?? '000000')
        break
      case 'schemeClr': {
        const v = attr(c, 'val') ?? ''
        if (v === 'phClr') base = ctx.ph ?? null
        else base = ctx.theme.colors[ctx.map[v] ?? v] ?? ctx.theme.colors[v] ?? null
        break
      }
      default:
        continue
    }
    return base ? transform(base, c) : null
  }
  return null
}

/** EMU (English Metric Units) to points. */
export const pt = (emu: number | undefined): number => (emu ?? 0) / 12700

export const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

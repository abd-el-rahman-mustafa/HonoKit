import { drawChart } from './chart'
import { geometryOf, type Geometry } from './geometry'
import { attr, bool, color, css, DEFAULT_MAP, fmt, kid, kids, num, Package, readColorMap, readTheme, resolveAlternate, type ColorContext, type El, type Rgba, type Theme } from './ooxml'
import { embeddedFont } from './fonts'
import { drawText, type TextLayers } from './text'

/**
 * PowerPoint (.pptx) to PDF without Office (docs/decisions.md §63). Each slide becomes a page of
 * one HTML document — shapes as SVG, text as HTML (so Chromium shapes Arabic), pictures as images,
 * tables as tables, charts drawn from their cached values — printed to PDF by Chromium at the
 * slide's size. Masters, layouts, placeholders and themes are followed as PowerPoint does. What is
 * not drawn yet is listed in `notes`.
 */

export interface ConvertedDeck {
  html: string
  /** Slide size, in points. */
  width: number
  height: number
  slides: number
  /** Pictures the HTML refers to, by file name ("m3.png"), to be written beside it (unless inlined). */
  media: Map<string, Uint8Array>
  /** What could not be drawn faithfully (shown to the person once, briefly). */
  notes: string[]
  /**
   * Windows metafiles (EMF/WMF), by the PNG file name the HTML expects beside it: Chromium cannot
   * draw them, so the caller has Windows draw each into that PNG (create.ts).
   */
  metafiles: Map<string, { bytes: Uint8Array; type: 'emf' | 'wmf' }>
}

export interface ConvertOptions {
  /** Pictures as data: URLs inside the HTML instead of files beside it. */
  inline?: boolean
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' }

interface Coord {
  /** Child offset and scale of the enclosing group (EMU), or identity. */
  ox: number
  oy: number
  sx: number
  sy: number
}

const IDENTITY: Coord = { ox: 0, oy: 0, sx: 1, sy: 1 }

interface Placeholder {
  type: string
  idx: string | null
}

/** Everything a slide is drawn with. */
interface SlideScope {
  slidePart: string
  layoutPart: string | null
  masterPart: string | null
  slide: El
  layout: El | null
  master: El | null
  colors: ColorContext
  number: number
}

class Converter {
  private themes = new Map<string, Theme>()
  private mediaNames = new Map<string, string>()
  readonly media = new Map<string, Uint8Array>()
  private pendingMedia = new Map<string, string>()
  private pendingMetafiles = new Map<string, string>()
  /** Windows metafiles (EMF/WMF) by the PNG name the HTML gives them. */
  readonly metafiles = new Map<string, { bytes: Uint8Array; type: 'emf' | 'wmf' }>()
  private notes = new Set<string>()
  private ids = 0
  private defaultText: El | null
  private tableStyles: El | null
  readonly fonts = new Set<string>()
  /** Families the file carries, lower case. */
  readonly embedded = new Set<string>()
  private tab: number

  constructor(
    readonly pkg: Package,
    private options: ConvertOptions
  ) {
    const pres = pkg.xml('ppt/presentation.xml')
    this.defaultText = kid(pres, 'p:defaultTextStyle')
    this.tableStyles = pkg.xml('ppt/tableStyles.xml')
    this.tab = (num(kid(pres, 'p:defaultTextStyle', 'a:defPPr'), 'defTabSz') ?? 914400) / 12700
  }

  note(text: string): void {
    this.notes.add(text)
  }

  allNotes(): string[] {
    return [...this.notes]
  }

  private theme(part: string | null): Theme {
    const path = part ?? ''
    let t = this.themes.get(path)
    if (!t) {
      t = readTheme(part ? this.pkg.xml(part) : null)
      this.themes.set(path, t)
    }
    return t
  }

  private uid(prefix: string): string {
    return `${prefix}${++this.ids}`
  }

  /** A picture part as a URL in the HTML: a file name beside it, or a data URL. */
  private mediaUrl(part: string): string | null {
    const ext = part.split('.').pop()!.toLowerCase()
    // Windows metafiles are drawn by Windows itself into a PNG of this name before printing (create.ts).
    const metafile = ext === 'emf' || ext === 'wmf'
    if (!IMAGE_TYPES[ext] && !metafile) {
      this.note(`Some pictures (.${ext}) cannot be drawn.`)
      return null
    }
    let name = this.mediaNames.get(part)
    if (!name) {
      name = `m${this.mediaNames.size + 1}.png`
      if (!metafile) name = name.replace(/png$/, ext)
      this.mediaNames.set(part, name)
      ;(metafile ? this.pendingMetafiles : this.pendingMedia).set(name, part)
    }
    return this.options.inline ? `{{media:${name}}}` : `media/${name}`
  }

  /**
   * The fonts the file carries (Embed fonts in PowerPoint), as @font-face rules: each face
   * decoded from its .fntdata part (§63, fonts.ts). A face that cannot be read is skipped and
   * its family falls back like any missing font.
   */
  async embeddedFonts(): Promise<string> {
    const pres = this.pkg.xml('ppt/presentation.xml')
    const rules: string[] = []
    let failed = false
    for (const font of kids(kid(pres, 'p:embeddedFontLst'), 'p:embeddedFont')) {
      const family = attr(kid(font, 'p:font'), 'typeface')
      if (!family) continue
      for (const [face, weight, style] of [
        ['p:regular', 400, 'normal'],
        ['p:bold', 700, 'normal'],
        ['p:italic', 400, 'italic'],
        ['p:boldItalic', 700, 'italic']
      ] as const) {
        const part = this.pkg.target('ppt/presentation.xml', attr(kid(font, face), 'r:id'))
        if (!part) continue
        const bytes = await this.pkg.bytes(part)
        let ttf: Uint8Array | null = null
        try {
          ttf = bytes ? embeddedFont(bytes) : null
        } catch {
          ttf = null
        }
        if (!ttf) {
          failed = true
          continue
        }
        const cff = ttf[0] === 0x4f
        const name = `f${this.media.size + this.pendingMedia.size + 1}.${cff ? 'otf' : 'ttf'}`
        this.media.set(name, ttf)
        const url = this.options.inline ? `data:font/${cff ? 'otf' : 'ttf'};base64,${Buffer.from(ttf).toString('base64')}` : `media/${name}`
        rules.push(`@font-face { font-family: '${family.replace(/'/g, '')}'; src: url("${url}"); font-weight: ${weight}; font-style: ${style} }`)
        this.embedded.add(family.toLowerCase())
      }
    }
    if (failed) this.note('Some fonts carried in the file could not be read; similar fonts are used.')
    return rules.join(' ')
  }

  /** Reads the pictures the HTML refers to; inlines them when asked. */
  async finish(html: string): Promise<string> {
    for (const [name, part] of this.pendingMedia) {
      const bytes = await this.pkg.bytes(part)
      if (bytes) this.media.set(name, bytes)
    }
    for (const [name, part] of this.pendingMetafiles) {
      const bytes = await this.pkg.bytes(part)
      if (bytes) this.metafiles.set(name, { bytes, type: part.toLowerCase().endsWith('.wmf') ? 'wmf' : 'emf' })
    }
    if (!this.options.inline) return html
    return html.replace(/\{\{media:([^}]+)\}\}/g, (_, name: string) => {
      const bytes = this.media.get(name)
      const type = IMAGE_TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'
      return bytes ? `data:${type};base64,${Buffer.from(bytes).toString('base64')}` : ''
    })
  }

  /* --- slides -------------------------------------------------------------------------------- */

  scope(slidePart: string, number: number): SlideScope | null {
    const slide = this.pkg.xml(slidePart)
    if (!slide) return null
    const layoutPart = this.pkg.relOfType(slidePart, '/slideLayout')
    const masterPart = layoutPart ? this.pkg.relOfType(layoutPart, '/slideMaster') : null
    const layout = layoutPart ? this.pkg.xml(layoutPart) : null
    const master = masterPart ? this.pkg.xml(masterPart) : null
    const theme = this.theme(masterPart ? this.pkg.relOfType(masterPart, '/theme') : null)
    let map = readColorMap(kid(master, 'p:clrMap')) ?? { ...DEFAULT_MAP }
    for (const el of [layout, slide]) {
      const over = kid(el, 'p:clrMapOvr', 'a:overrideClrMapping')
      if (over) map = readColorMap(over) ?? map
    }
    return { slidePart, layoutPart, masterPart, slide, layout, master, colors: { theme, map }, number }
  }

  slide(scope: SlideScope, width: number, height: number): string {
    const parts: string[] = []
    parts.push(this.background(scope, width, height))
    const showMaster = attr(scope.slide, 'showMasterSp') !== '0'
    const layoutShowsMaster = attr(scope.layout, 'showMasterSp') !== '0'
    if (showMaster && layoutShowsMaster && scope.master && scope.masterPart) parts.push(this.tree(kid(scope.master, 'p:cSld', 'p:spTree'), scope, scope.masterPart, IDENTITY, true))
    if (showMaster && scope.layout && scope.layoutPart) parts.push(this.tree(kid(scope.layout, 'p:cSld', 'p:spTree'), scope, scope.layoutPart, IDENTITY, true))
    parts.push(this.tree(kid(scope.slide, 'p:cSld', 'p:spTree'), scope, scope.slidePart, IDENTITY, false))
    return `<section class="slide">${parts.join('')}</section>`
  }

  private background(scope: SlideScope, width: number, height: number): string {
    for (const [el, part] of [
      [scope.slide, scope.slidePart],
      [scope.layout, scope.layoutPart],
      [scope.master, scope.masterPart]
    ] as const) {
      const bg = kid(el, 'p:cSld', 'p:bg')
      if (!bg || !part) continue
      const bgPr = kid(bg, 'p:bgPr')
      let fill: El | null = null
      let colors = scope.colors
      if (bgPr) fill = kids(bgPr).find((k) => /Fill$/.test(k.localName)) ?? null
      const ref = kid(bg, 'p:bgRef')
      if (!fill && ref) {
        const idx = num(ref, 'idx') ?? 0
        const list = idx >= 1001 ? scope.colors.theme.bgFills : scope.colors.theme.fills
        fill = list[(idx >= 1001 ? idx - 1001 : idx - 1)] ?? null
        colors = { ...scope.colors, ph: color(ref, scope.colors) }
      }
      if (!fill) continue
      const paint = this.paint(fill, colors, part, width, height)
      return `<svg class="bg" width="${fmt(width)}pt" height="${fmt(height)}pt" viewBox="0 0 ${fmt(width)} ${fmt(height)}" preserveAspectRatio="none"><defs>${paint.defs}</defs><rect width="${fmt(width)}" height="${fmt(height)}" fill="${paint.fill}"${paint.opacity}/></svg>`
    }
    return ''
  }

  /* --- placeholders -------------------------------------------------------------------------- */

  private placeholderOf(el: El): Placeholder | null {
    const nv = kids(el).find((k) => /^nv/.test(k.localName))
    const ph = kid(kid(nv, 'nvPr'), 'ph')
    if (!ph) return null
    return { type: attr(ph, 'type') ?? (attr(ph, 'idx') ? 'body' : 'body'), idx: attr(ph, 'idx') }
  }

  /** The layout's or master's placeholder a placeholder inherits from. */
  private findPlaceholder(tree: El | null, ph: Placeholder, byIndex: boolean): El | null {
    const all: El[] = []
    const walk = (t: El | null): void => {
      for (const k of kids(t)) {
        if (k.localName === 'grpSp') walk(k)
        else if (k.localName === 'sp' || k.localName === 'pic' || k.localName === 'graphicFrame') all.push(k)
      }
    }
    walk(tree)
    const same = (t: string): string => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t)
    if (byIndex && ph.idx !== null) {
      const hit = all.find((k) => this.placeholderOf(k)?.idx === ph.idx)
      if (hit) return hit
    }
    return all.find((k) => {
      const p = this.placeholderOf(k)
      return p && same(p.type) === same(ph.type)
    }) ?? null
  }

  /** A placeholder's layout and master shapes (for position, look and text styles). */
  private inherited(el: El, scope: SlideScope, fromLayout: boolean): { layout: El | null; master: El | null; ph: Placeholder | null } {
    const ph = this.placeholderOf(el)
    if (!ph) return { layout: null, master: null, ph: null }
    const layout = fromLayout ? null : this.findPlaceholder(kid(scope.layout, 'p:cSld', 'p:spTree'), ph, true)
    const masterPh = layout ? (this.placeholderOf(layout) ?? ph) : ph
    const master = this.findPlaceholder(kid(scope.master, 'p:cSld', 'p:spTree'), masterPh, false)
    return { layout, master, ph }
  }

  /* --- shapes -------------------------------------------------------------------------------- */

  private tree(tree: El | null, scope: SlideScope, part: string, coord: Coord, inheritedTree: boolean): string {
    const out: string[] = []
    for (const raw of kids(tree)) {
      for (const el of resolveAlternate(raw)) {
        // Placeholders on layouts and masters are prompts ("Click to add title"), not drawn.
        if (inheritedTree && this.placeholderOf(el)) continue
        const nv = kids(el).find((k) => /^nv/.test(k.localName))
        if (attr(kid(nv, 'cNvPr'), 'hidden') === '1') continue
        switch (el.localName) {
          case 'sp':
          case 'cxnSp':
            out.push(this.shape(el, scope, part, coord, inheritedTree))
            break
          case 'pic':
            out.push(this.picture(el, scope, part, coord, inheritedTree))
            break
          case 'grpSp':
            out.push(this.group(el, scope, part, coord, inheritedTree))
            break
          case 'graphicFrame':
            out.push(this.frame(el, scope, part, coord))
            break
          case 'contentPart':
            this.note('Ink drawings are not drawn yet.')
            break
        }
      }
    }
    return out.join('')
  }

  /** A shape's box in points, relative to its container, with its turn and flips. */
  private box(xfrm: El | null, coord: Coord): { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean } | null {
    const off = kid(xfrm, 'a:off')
    const ext = kid(xfrm, 'a:ext')
    if (!off || !ext) return null
    return {
      x: (((num(off, 'x') ?? 0) - coord.ox) * coord.sx) / 12700,
      y: (((num(off, 'y') ?? 0) - coord.oy) * coord.sy) / 12700,
      w: ((num(ext, 'cx') ?? 0) * coord.sx) / 12700,
      h: ((num(ext, 'cy') ?? 0) * coord.sy) / 12700,
      rot: (num(xfrm, 'rot') ?? 0) / 60000,
      flipH: bool(xfrm, 'flipH') === true,
      flipV: bool(xfrm, 'flipV') === true
    }
  }

  private place(b: { x: number; y: number; w: number; h: number; rot: number }, extra = ''): string {
    const t = b.rot ? `transform:rotate(${fmt(b.rot)}deg);` : ''
    return `left:${fmt(b.x)}pt;top:${fmt(b.y)}pt;width:${fmt(b.w)}pt;height:${fmt(b.h)}pt;${t}${extra}`
  }

  /** A fill as SVG paint: a colour, a gradient or a picture pattern (with its definitions). */
  private paint(fill: El | null, colors: ColorContext, part: string, w: number, h: number): { fill: string; defs: string; opacity: string } {
    if (!fill || fill.localName === 'noFill') return { fill: 'none', defs: '', opacity: '' }
    if (fill.localName === 'solidFill') {
      const c = color(fill, colors)
      return { fill: c ? `rgb(${c.r},${c.g},${c.b})` : 'none', defs: '', opacity: c && c.a < 1 ? ` fill-opacity="${fmt(c.a)}"` : '' }
    }
    if (fill.localName === 'gradFill') {
      const id = this.uid('g')
      const stops = kids(kid(fill, 'a:gsLst'), 'a:gs')
        .map((gs) => ({ pos: (num(gs, 'pos') ?? 0) / 100000, c: color(gs, colors) }))
        .sort((a, b) => a.pos - b.pos)
        .map((s) => `<stop offset="${fmt(s.pos)}" stop-color="${s.c ? `rgb(${s.c.r},${s.c.g},${s.c.b})` : '#000'}"${s.c && s.c.a < 1 ? ` stop-opacity="${fmt(s.c.a)}"` : ''}/>`)
        .join('')
      const path = kid(fill, 'a:path')
      if (path) {
        const r = kid(path, 'a:fillToRect')
        const cx = 0.5 + ((num(r, 'l') ?? 50000) - (num(r, 'r') ?? 50000)) / 200000
        const cy = 0.5 + ((num(r, 't') ?? 50000) - (num(r, 'b') ?? 50000)) / 200000
        return { fill: `url(#${id})`, defs: `<radialGradient id="${id}" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${attr(path, 'path') === 'circle' ? '0.71' : '0.75'}">${stops}</radialGradient>`, opacity: '' }
      }
      // A linear gradient at its angle, measured on the shape as drawn (not on a unit square).
      const ang = ((num(kid(fill, 'a:lin'), 'ang') ?? 0) / 60000) * (Math.PI / 180)
      const dx = Math.cos(ang) * w
      const dy = Math.sin(ang) * h
      const len = Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * h || 1
      const ux = (dx / Math.hypot(dx, dy || 1e-9)) * (len / 2)
      const uy = (dy / Math.hypot(dx || 1e-9, dy)) * (len / 2)
      return {
        fill: `url(#${id})`,
        defs: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(w / 2 - ux)}" y1="${fmt(h / 2 - uy)}" x2="${fmt(w / 2 + ux)}" y2="${fmt(h / 2 + uy)}">${stops}</linearGradient>`,
        opacity: ''
      }
    }
    if (fill.localName === 'blipFill') {
      const target = this.pkg.target(part, attr(kid(fill, 'a:blip'), 'r:embed'))
      const url = target ? this.mediaUrl(target) : null
      if (!url) return { fill: 'none', defs: '', opacity: '' }
      const id = this.uid('p')
      return { fill: `url(#${id})`, defs: `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmt(w)}" height="${fmt(h)}"><image href="${url}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none"/></pattern>`, opacity: '' }
    }
    if (fill.localName === 'pattFill') {
      // A pattern as the even mix of its two colours (its texture is not drawn).
      const fg = color(kid(fill, 'a:fgClr'), colors) ?? { r: 0, g: 0, b: 0, a: 1 }
      const bg = color(kid(fill, 'a:bgClr'), colors) ?? { r: 255, g: 255, b: 255, a: 1 }
      const pct = /pct(\d+)/.exec(attr(fill, 'prst') ?? '')
      const k = pct ? Number(pct[1]) / 100 : 0.5
      const mix = (a: number, b: number): number => Math.round(a * k + b * (1 - k))
      return { fill: `rgb(${mix(fg.r, bg.r)},${mix(fg.g, bg.g)},${mix(fg.b, bg.b)})`, defs: '', opacity: '' }
    }
    return { fill: 'none', defs: '', opacity: '' }
  }

  /** An outline: colour, width, dashes, ends — the style's line, then the inherited, then the shape's own. */
  private stroke(lines: Array<El | null>, colors: ColorContext): { attrs: string; width: number; head: El | null; tail: El | null; color: Rgba | null } | null {
    let width = 9525
    let fillEl: El | null = null
    let dash: string | null = null
    let cap: string | null = null
    let head: El | null = null
    let tail: El | null = null
    let any = false
    for (const ln of lines) {
      if (!ln) continue
      any = true
      if (num(ln, 'w') !== undefined) width = num(ln, 'w')!
      const f = kids(ln).find((k) => /Fill$/.test(k.localName))
      if (f) fillEl = f
      const d = kid(ln, 'a:prstDash')
      if (d) dash = attr(d, 'val')
      if (attr(ln, 'cap')) cap = attr(ln, 'cap')
      if (kid(ln, 'a:headEnd')) head = kid(ln, 'a:headEnd')
      if (kid(ln, 'a:tailEnd')) tail = kid(ln, 'a:tailEnd')
    }
    if (!any || !fillEl || fillEl.localName === 'noFill') return null
    const c = fillEl.localName === 'solidFill' ? color(fillEl, colors) : fillEl.localName === 'gradFill' ? color(kid(fillEl, 'a:gsLst', 'a:gs'), colors) : null
    if (!c) return null
    const w = Math.max(0.25, width / 12700)
    const DASHES: Record<string, number[]> = { dash: [4, 3], sysDash: [3, 1], dot: [1, 3], sysDot: [1, 1], dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3] }
    const pattern = dash ? DASHES[dash] : undefined
    let attrs = ` stroke="rgb(${c.r},${c.g},${c.b})" stroke-width="${fmt(w)}"`
    if (c.a < 1) attrs += ` stroke-opacity="${fmt(c.a)}"`
    if (pattern) attrs += ` stroke-dasharray="${pattern.map((p) => fmt(p * w)).join(' ')}"`
    if (cap === 'rnd') attrs += ' stroke-linecap="round"'
    else if (cap === 'sq') attrs += ' stroke-linecap="square"'
    return { attrs, width: w, head, tail, color: c }
  }

  /** An arrowhead as an SVG marker. */
  private marker(end: El | null, c: Rgba, start: boolean): { id: string; def: string } | null {
    const type = attr(end, 'type')
    if (!end || !type || type === 'none') return null
    const size = (v: string | null): number => (v === 'sm' ? 2 : v === 'lg' ? 5 : 3)
    const w = size(attr(end, 'w'))
    const l = size(attr(end, 'len'))
    const id = this.uid('a')
    const fillC = `rgb(${c.r},${c.g},${c.b})`
    const shape =
      type === 'oval'
        ? `<ellipse cx="${fmt(l / 2)}" cy="${fmt(w / 2)}" rx="${fmt(l / 2)}" ry="${fmt(w / 2)}" fill="${fillC}"/>`
        : type === 'diamond'
          ? `<path d="M0,${fmt(w / 2)} L${fmt(l / 2)},0 L${fmt(l)},${fmt(w / 2)} L${fmt(l / 2)},${fmt(w)} Z" fill="${fillC}"/>`
          : type === 'arrow'
            ? `<path d="M0,0 L${fmt(l)},${fmt(w / 2)} L0,${fmt(w)}" fill="none" stroke="${fillC}" stroke-width="0.5"/>`
            : type === 'stealth'
              ? `<path d="M0,0 L${fmt(l)},${fmt(w / 2)} L0,${fmt(w)} L${fmt(l * 0.3)},${fmt(w / 2)} Z" fill="${fillC}"/>`
              : `<path d="M0,0 L${fmt(l)},${fmt(w / 2)} L0,${fmt(w)} Z" fill="${fillC}"/>`
    return { id, def: `<marker id="${id}" markerUnits="strokeWidth" markerWidth="${fmt(l)}" markerHeight="${fmt(w)}" refX="${fmt(type === 'oval' || type === 'diamond' ? l / 2 : l * 0.8)}" refY="${fmt(w / 2)}" orient="${start ? 'auto-start-reverse' : 'auto'}" overflow="visible">${shape}</marker>` }
  }

  /** A shadow (outer shadow effect) as a CSS filter. */
  private shadow(effects: Array<El | null>, colors: ColorContext): string {
    let outer: El | null = null
    for (const e of effects) {
      if (!e) continue
      outer = kid(e, 'a:outerShdw')
    }
    if (!outer) return ''
    const c = color(outer, colors)
    if (!c) return ''
    const dist = (num(outer, 'dist') ?? 0) / 12700
    const dir = ((num(outer, 'dir') ?? 0) / 60000) * (Math.PI / 180)
    const blur = (num(outer, 'blurRad') ?? 0) / 12700
    return `filter:drop-shadow(${fmt(dist * Math.cos(dir))}pt ${fmt(dist * Math.sin(dir))}pt ${fmt(blur / 2)}pt ${css(c)});`
  }

  /** The style's references (fill, line, effect, font) of a shape. */
  private styleRefs(el: El, colors: ColorContext): { fill: El | null; fillColors: ColorContext; line: El | null; lineColors: ColorContext; effect: El | null; font: El | null } {
    const style = kid(el, 'style')
    const ref = (name: string): El | null => kid(style, name)
    const fillRef = ref('a:fillRef')
    const lnRef = ref('a:lnRef')
    const effectRef = ref('a:effectRef')
    const fi = num(fillRef, 'idx') ?? 0
    const li = num(lnRef, 'idx') ?? 0
    const ei = num(effectRef, 'idx') ?? 0
    const t = colors.theme
    return {
      fill: fi >= 1001 ? (t.bgFills[fi - 1001] ?? null) : fi > 0 ? (t.fills[fi - 1] ?? null) : null,
      fillColors: { ...colors, ph: color(fillRef, colors) },
      line: li > 0 ? (t.lines[li - 1] ?? null) : null,
      lineColors: { ...colors, ph: color(lnRef, colors) },
      effect: ei > 0 ? kid(t.effects[ei - 1] ?? null, 'a:effectLst') : null,
      font: ref('a:fontRef')
    }
  }

  private shape(el: El, scope: SlideScope, part: string, coord: Coord, fromInherited: boolean, groupFill: El | null = null): string {
    const spPr = kid(el, 'spPr')
    const inh = this.inherited(el, scope, fromInherited)
    const inhSpPr = [kid(inh.master, 'spPr'), kid(inh.layout, 'spPr')]
    const xfrm = kid(spPr, 'a:xfrm') ?? kid(inhSpPr[1] ?? null, 'a:xfrm') ?? kid(inhSpPr[0] ?? null, 'a:xfrm')
    const b = this.box(xfrm, coord)
    if (!b) return ''
    const refs = this.styleRefs(el, scope.colors)
    // The geometry: the shape's own, or its placeholder's.
    const geomFrom = kid(spPr, 'a:prstGeom') || kid(spPr, 'a:custGeom') ? spPr : (inhSpPr.reverse().find((s) => kid(s, 'a:prstGeom') || kid(s, 'a:custGeom')) ?? spPr)
    const geom: Geometry = geometryOf(geomFrom, b.w, b.h)
    if (geom.unknown) this.note(`Some shapes (${geom.unknown}) are drawn as simple outlines.`)
    // Fill: the shape's own, its placeholder's, or its style's.
    const ownFill = kids(spPr).find((k) => /Fill$/.test(k.localName)) ?? null
    const inhFill = [kid(inh.layout, 'spPr'), kid(inh.master, 'spPr')].map((s) => kids(s).find((k) => /Fill$/.test(k.localName)) ?? null).find(Boolean) ?? null
    let fillEl = ownFill ?? inhFill
    let fillColors = scope.colors
    if (fillEl?.localName === 'grpFill') fillEl = groupFill
    if (!fillEl && refs.fill) {
      fillEl = refs.fill
      fillColors = refs.fillColors
    }
    const paint = this.paint(fillEl, fillColors, part, b.w, b.h)
    const line = this.stroke([refs.line, kid(kid(inh.master, 'spPr'), 'a:ln'), kid(kid(inh.layout, 'spPr'), 'a:ln'), kid(spPr, 'a:ln')], refs.line && !kid(spPr, 'a:ln') ? refs.lineColors : scope.colors)
    const shadow = this.shadow([refs.effect, kid(spPr, 'a:effectLst')], scope.colors)
    const defs: string[] = [paint.defs]
    const paths: string[] = []
    for (const p of geom.paths) {
      const filled = p.fill ? `fill="${paint.fill}"${paint.opacity}` : 'fill="none"'
      let markers = ''
      if (line && !p.fill) {
        const head = this.marker(line.head, line.color!, true)
        const tail = this.marker(line.tail, line.color!, false)
        if (head) ((markers += ` marker-start="url(#${head.id})"`), defs.push(head.def))
        if (tail) ((markers += ` marker-end="url(#${tail.id})"`), defs.push(tail.def))
      }
      paths.push(`<path d="${p.d}" ${filled}${p.stroke && line ? line.attrs : ' stroke="none"'}${markers} fill-rule="evenodd"/>`)
    }
    const flip = b.flipH || b.flipV ? ` transform="translate(${b.flipH ? fmt(b.w) : 0},${b.flipV ? fmt(b.h) : 0}) scale(${b.flipH ? -1 : 1},${b.flipV ? -1 : 1})"` : ''
    // The drawing gets a margin around the shape's box: a line has no height (Chromium does not paint
    // an SVG that thin), and thick outlines and arrowheads reach past the box.
    const pad = 6 + (line ? line.width * 3 : 0)
    const svg =
      paths.length && (paint.fill !== 'none' || line)
        ? `<svg style="left:${fmt(-pad)}pt;top:${fmt(-pad)}pt" width="${fmt(b.w + 2 * pad)}pt" height="${fmt(b.h + 2 * pad)}pt" viewBox="${fmt(-pad)} ${fmt(-pad)} ${fmt(b.w + 2 * pad)} ${fmt(b.h + 2 * pad)}"><defs>${defs.join('')}</defs><g${flip}>${paths.join('')}</g></svg>`
        : ''

    // The text, with the styles it inherits.
    let text = ''
    const txBody = kid(el, 'txBody')
    if (txBody) {
      const ph = inh.ph
      const txStyles = kid(scope.master, 'p:txStyles')
      const master = ph ? (ph.type === 'title' || ph.type === 'ctrTitle' ? kid(txStyles, 'p:titleStyle') : ['dt', 'ftr', 'sldNum', 'hdr'].includes(ph.type) ? kid(txStyles, 'p:otherStyle') : kid(txStyles, 'p:bodyStyle')) : kid(txStyles, 'p:otherStyle')
      const lists = [this.defaultText, master, kid(kid(inh.master, 'txBody'), 'a:lstStyle'), kid(kid(inh.layout, 'txBody'), 'a:lstStyle')]
      const layers: TextLayers = {
        lists,
        bodies: [kid(kid(inh.master, 'txBody'), 'a:bodyPr'), kid(kid(inh.layout, 'txBody'), 'a:bodyPr')],
        fontRef: refs.font,
        inherited: lists.length
      }
      // Text in an ellipse sits in the ellipse's inner box, as in PowerPoint.
      const prst = attr(kid(geomFrom, 'a:prstGeom'), 'prst')
      const inset = prst === 'ellipse' ? 0.146 : 0
      const t = drawText(txBody, layers, { colors: scope.colors, slideNumber: scope.number, tab: this.tab, fonts: this.fonts, embedded: this.embedded }, b.w * (1 - 2 * inset), b.h * (1 - 2 * inset))
      if (t.hasText) text = inset ? `<div style="position:absolute;left:${fmt(b.w * inset)}pt;top:${fmt(b.h * inset)}pt;width:${fmt(b.w * (1 - 2 * inset))}pt;height:${fmt(b.h * (1 - 2 * inset))}pt">${t.html}</div>` : t.html
    }
    if (!svg && !text) return ''
    return `<div class="sp" style="${this.place(b, shadow)}">${svg}${text}</div>`
  }

  private picture(el: El, scope: SlideScope, part: string, coord: Coord, fromInherited: boolean, fallback?: { x: number; y: number; w: number; h: number; rot: number }): string {
    const spPr = kid(el, 'spPr')
    const inh = this.inherited(el, scope, fromInherited)
    const xfrm = kid(spPr, 'a:xfrm') ?? kid(kid(inh.layout, 'spPr'), 'a:xfrm') ?? kid(kid(inh.master, 'spPr'), 'a:xfrm')
    const b = this.box(xfrm, coord) ?? (fallback ? { ...fallback, flipH: false, flipV: false } : null)
    if (!b) return ''
    const blipFill = kid(el, 'blipFill')
    const blip = kid(blipFill, 'a:blip')
    // A vector original (SVG) is preferred over its picture copy.
    const svgBlip = blip ? Array.from(blip.getElementsByTagNameNS('http://schemas.microsoft.com/office/drawing/2016/SVG/main', 'svgBlip'))[0] : undefined
    const target = this.pkg.target(part, (svgBlip ? attr(svgBlip as unknown as El, 'r:embed') : null) ?? attr(blip, 'r:embed'))
    const media = kid(kid(kids(el).find((k) => /^nv/.test(k.localName)) ?? null, 'nvPr'), 'a:videoFile') ?? null
    if (media) this.note('Videos are shown as their poster picture.')
    const url = target ? this.mediaUrl(target) : null
    if (!url) return ''
    // Cropping: the picture is drawn larger and moved so only the kept part shows.
    const src = kid(blipFill, 'a:srcRect')
    const l = (num(src, 'l') ?? 0) / 100000
    const t = (num(src, 't') ?? 0) / 100000
    const r = (num(src, 'r') ?? 0) / 100000
    const bt = (num(src, 'b') ?? 0) / 100000
    const iw = b.w / Math.max(0.01, 1 - l - r)
    const ih = b.h / Math.max(0.01, 1 - t - bt)
    const geom = geometryOf(spPr, b.w, b.h)
    const clip = this.uid('c')
    const alpha = num(kid(blip, 'a:alphaModFix'), 'amt')
    const filters: string[] = []
    if (kid(blip, 'a:grayscl')) filters.push('grayscale(1)')
    const lum = kid(blip, 'a:lum')
    if (lum) {
      const bright = (num(lum, 'bright') ?? 0) / 100000
      const contrast = (num(lum, 'contrast') ?? 0) / 100000
      if (bright) filters.push(`brightness(${fmt(1 + bright)})`)
      if (contrast) filters.push(`contrast(${fmt(1 + contrast)})`)
    }
    const line = this.stroke([kid(spPr, 'a:ln')], scope.colors)
    const flip = b.flipH || b.flipV ? ` transform="translate(${b.flipH ? fmt(b.w) : 0},${b.flipV ? fmt(b.h) : 0}) scale(${b.flipH ? -1 : 1},${b.flipV ? -1 : 1})"` : ''
    const outline = line ? geom.paths.map((p) => `<path d="${p.d}" fill="none"${line.attrs}/>`).join('') : ''
    const svg = `<svg width="${fmt(b.w)}pt" height="${fmt(b.h)}pt" viewBox="0 0 ${fmt(b.w)} ${fmt(b.h)}"><defs><clipPath id="${clip}">${geom.paths.map((p) => `<path d="${p.d}"/>`).join('')}</clipPath></defs><g${flip}><g clip-path="url(#${clip})"${filters.length ? ` style="filter:${filters.join(' ')}"` : ''}><image href="${url}" x="${fmt(-l * iw)}" y="${fmt(-t * ih)}" width="${fmt(iw)}" height="${fmt(ih)}" preserveAspectRatio="none"${alpha !== undefined ? ` opacity="${fmt(alpha / 100000)}"` : ''}/></g>${outline}</g></svg>`
    const shadow = this.shadow([kid(spPr, 'a:effectLst')], scope.colors)
    return `<div class="sp" style="${this.place(b, shadow)}">${svg}</div>`
  }

  private group(el: El, scope: SlideScope, part: string, coord: Coord, fromInherited: boolean): string {
    const grpSpPr = kid(el, 'grpSpPr')
    const xfrm = kid(grpSpPr, 'a:xfrm')
    const b = this.box(xfrm, coord)
    if (!b) return this.tree(el, scope, part, coord, fromInherited)
    const ext = kid(xfrm, 'a:ext')
    const chOff = kid(xfrm, 'a:chOff')
    const chExt = kid(xfrm, 'a:chExt')
    const cx = num(chExt, 'cx') || num(ext, 'cx') || 1
    const cy = num(chExt, 'cy') || num(ext, 'cy') || 1
    const inner: Coord = { ox: num(chOff, 'x') ?? 0, oy: num(chOff, 'y') ?? 0, sx: (((num(ext, 'cx') ?? cx) * coord.sx) / cx) as number, sy: (((num(ext, 'cy') ?? cy) * coord.sy) / cy) as number }
    // Children drawn relative to the group's box; a group fill is passed to children that ask for it.
    const groupFill = kids(grpSpPr).find((k) => /Fill$/.test(k.localName) && k.localName !== 'grpFill') ?? null
    const children: string[] = []
    for (const raw of kids(el)) {
      for (const k of resolveAlternate(raw)) {
        const nv = kids(k).find((c) => /^nv/.test(c.localName))
        if (attr(kid(nv, 'cNvPr'), 'hidden') === '1') continue
        if (k.localName === 'sp' || k.localName === 'cxnSp') children.push(this.shape(k, scope, part, inner, fromInherited, groupFill))
        else if (k.localName === 'pic') children.push(this.picture(k, scope, part, inner, fromInherited))
        else if (k.localName === 'grpSp') children.push(this.group(k, scope, part, inner, fromInherited))
        else if (k.localName === 'graphicFrame') children.push(this.frame(k, scope, part, inner))
      }
    }
    const flip = b.flipH || b.flipV ? `transform:${b.rot ? `rotate(${fmt(b.rot)}deg) ` : ''}scale(${b.flipH ? -1 : 1},${b.flipV ? -1 : 1});` : ''
    return `<div class="sp grp" style="${this.place({ ...b, rot: flip ? 0 : b.rot }, flip)}">${children.join('')}</div>`
  }

  /* --- tables, charts, diagrams ------------------------------------------------------------- */

  private frame(el: El, scope: SlideScope, part: string, coord: Coord): string {
    const b = this.box(kid(el, 'xfrm'), coord)
    const data = kid(el, 'a:graphic', 'a:graphicData')
    if (!b || !data) return ''
    const uri = attr(data, 'uri') ?? ''
    if (uri.endsWith('/table')) return this.table(kid(data, 'a:tbl'), scope, part, b)
    if (uri.endsWith('/chart')) {
      const ref = kids(data).find((k) => k.localName === 'chart')
      const target = this.pkg.target(part, attr(ref ?? null, 'r:id'))
      if (!target) return ''
      const family = [scope.colors.theme.minor.latin, 'Segoe UI', 'Arial'].filter(Boolean).map((f) => `'${f}'`).join(', ')
      return `<div class="sp" style="${this.place(b)}">${drawChart(this.pkg.xml(target), scope.colors, b.w, b.h, family)}</div>`
    }
    if (uri.endsWith('/diagram')) return this.diagram(data, scope, part, b)
    // An embedded object (OLE): its picture, when it has one, in the frame's box.
    for (const k of kids(data).flatMap(resolveAlternate)) {
      const pic = kids(k).find((c) => c.localName === 'pic')
      if (pic) return this.picture(pic, scope, part, coord, false, b)
    }
    this.note('Some embedded objects are not drawn.')
    return ''
  }

  /** SmartArt: the drawing PowerPoint saved with it (shapes, as on a slide). */
  private diagram(data: El, scope: SlideScope, part: string, b: { x: number; y: number; w: number; h: number; rot: number }): string {
    const ids = kids(data).find((k) => k.localName === 'relIds')
    const dataPart = this.pkg.target(part, attr(ids ?? null, 'r:dm'))
    let drawing: string | null = null
    if (dataPart) {
      const ext = Array.from(this.pkg.xml(dataPart)?.getElementsByTagName('*') ?? []).find((e) => (e as unknown as El).localName === 'dataModelExt') as unknown as El | undefined
      const relId = ext ? attr(ext, 'relId') : null
      if (relId) drawing = this.pkg.target(part, relId)
    }
    const root = drawing ? this.pkg.xml(drawing) : null
    const tree = kids(root).find((k) => k.localName === 'spTree') ?? null
    if (!tree || !drawing) {
      this.note('Some SmartArt graphics are not drawn (they were saved without their drawing).')
      return ''
    }
    return `<div class="sp" style="${this.place(b)}">${this.tree(tree, scope, drawing, IDENTITY, false)}</div>`
  }

  private table(tbl: El | null, scope: SlideScope, part: string, b: { x: number; y: number; w: number; h: number; rot: number }): string {
    if (!tbl) return ''
    const tblPr = kid(tbl, 'a:tblPr')
    const cols = kids(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((c) => (num(c, 'w') ?? 0) / 12700)
    const rows = kids(tbl, 'a:tr')
    const styleId = kid(tblPr, 'a:tableStyleId')?.textContent?.trim() ?? attr(tblPr, 'tableStyleId')
    const style = styleId ? (kids(this.tableStyles).find((s) => attr(s, 'styleId') === styleId) ?? null) : null
    if (styleId && !style && styleId !== '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}') this.note('Some tables use a built-in table style that is drawn in a simpler way.')
    const on = (name: string): boolean => bool(tblPr, name) === true
    const flags = { firstRow: on('firstRow'), lastRow: on('lastRow'), firstCol: on('firstCol'), lastCol: on('lastCol'), bandRow: on('bandRow'), bandCol: on('bandCol') }
    const rtlTable = on('rtl')
    const accent = scope.colors.theme.colors.accent1 ?? { r: 68, g: 114, b: 196, a: 1 }
    // The table style's parts that apply to a cell, lowest first.
    const partsFor = (r: number, c: number): El[] => {
      if (!style) return []
      const names: string[] = ['wholeTbl']
      if (flags.bandRow) {
        const band = (r - (flags.firstRow ? 1 : 0)) % 2 === 0 ? 'band1H' : 'band2H'
        if (!(flags.firstRow && r === 0) && !(flags.lastRow && r === rows.length - 1)) names.push(band)
      }
      if (flags.bandCol) names.push((c - (flags.firstCol ? 1 : 0)) % 2 === 0 ? 'band1V' : 'band2V')
      if (flags.lastCol && c === cols.length - 1) names.push('lastCol')
      if (flags.firstCol && c === 0) names.push('firstCol')
      if (flags.lastRow && r === rows.length - 1) names.push('lastRow')
      if (flags.firstRow && r === 0) names.push('firstRow')
      return names.map((n) => kid(style, `a:${n}`)).filter((x): x is El => !!x)
    }
    // PowerPoint's default style (Medium Style 2 – Accent 1) when the file names it without its definition.
    const builtIn = !style && styleId === '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'
    const tint = (c: Rgba, k: number): Rgba => ({ r: Math.round(c.r + (255 - c.r) * k), g: Math.round(c.g + (255 - c.g) * k), b: Math.round(c.b + (255 - c.b) * k), a: 1 })

    const html: string[] = []
    const covered = new Set<string>()
    rows.forEach((tr, r) => {
      const cells: string[] = []
      kids(tr, 'a:tc').forEach((tc, c) => {
        if (bool(tc, 'hMerge') || bool(tc, 'vMerge') || covered.has(`${r},${c}`)) return
        const span = num(tc, 'gridSpan') ?? 1
        const rowSpan = num(tc, 'rowSpan') ?? 1
        const tcPr = kid(tc, 'a:tcPr')
        const styleParts = partsFor(r, c)
        // Fill: the cell's own, else the style's (last part that gives one).
        let fill: string | null = null
        const own = kids(tcPr).find((k) => /Fill$/.test(k.localName))
        if (own) {
          const p = this.paint(own, scope.colors, part, 1, 1)
          fill = own.localName === 'noFill' ? 'transparent' : own.localName === 'solidFill' ? css(color(own, scope.colors)) : p.fill.startsWith('url') ? null : p.fill
        } else {
          for (const sp of styleParts) {
            const tcStyle = kid(sp, 'a:tcStyle')
            const f = kid(tcStyle, 'a:fill')
            const solid = kid(f, 'a:solidFill')
            if (solid) fill = css(color(solid, scope.colors))
            else if (kid(f, 'a:noFill')) fill = 'transparent'
            const fillRef = kid(tcStyle, 'a:fillRef')
            if (fillRef) fill = css(color(fillRef, scope.colors))
          }
          if (builtIn) fill = css(flags.firstRow && r === 0 ? accent : flags.bandRow && (r - (flags.firstRow ? 1 : 0)) % 2 === 0 ? tint(accent, 0.6) : tint(accent, 0.8))
        }
        // Borders: the cell's own lines, else the style's (outer edges or inside lines).
        const border = (side: 'L' | 'R' | 'T' | 'B'): string => {
          const ownLn = kid(tcPr, `a:ln${side}`)
          let ln: El | null = ownLn
          if (!ln) {
            const name = side === 'L' ? (c === 0 ? 'left' : 'insideV') : side === 'R' ? (c + span >= cols.length ? 'right' : 'insideV') : side === 'T' ? (r === 0 ? 'top' : 'insideH') : r + rowSpan >= rows.length ? 'bottom' : 'insideH'
            for (const sp of styleParts) {
              const edge = kid(sp, 'a:tcStyle', 'a:tcBdr', `a:${name}`)
              if (edge) ln = kid(edge, 'a:ln') ?? ln
            }
            if (builtIn && !ln) return '1pt solid #fff'
          }
          const s = this.stroke([ln], scope.colors)
          return s ? `${fmt(s.width)}pt solid ${css(s.color)}` : 'none'
        }
        // Text: the style's text properties (bold, colour) under the cell's own.
        const txt = styleParts.map((sp) => kid(sp, 'a:tcTxStyle')).filter((x): x is El => !!x)
        const doc = tbl.ownerDocument!
        const lst = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:lstStyle') as unknown as El
        const lvl = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:lvl1pPr') as unknown as El
        const def = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:defRPr') as unknown as El
        for (const t of txt) {
          if (attr(t, 'b') === 'on') def.setAttribute('b', '1')
          if (attr(t, 'i') === 'on') def.setAttribute('i', '1')
          const clr = kids(t).find((k) => /Clr$/.test(k.localName)) ?? kid(t, 'a:fontRef')
          if (clr) {
            const solid = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:solidFill')
            solid.appendChild((clr.localName === 'fontRef' ? (kids(clr).find((k) => /Clr$/.test(k.localName)) ?? clr) : clr).cloneNode(true))
            def.appendChild(solid)
          }
        }
        if (builtIn && flags.firstRow && r === 0) {
          def.setAttribute('b', '1')
          const solid = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:solidFill')
          const s = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:schemeClr')
          s.setAttribute('val', 'lt1')
          solid.appendChild(s)
          def.appendChild(solid)
        }
        lvl.appendChild(def as unknown as Node)
        lst.appendChild(lvl as unknown as Node)
        const marL = (num(tcPr, 'marL') ?? 91440) / 12700
        const marR = (num(tcPr, 'marR') ?? 91440) / 12700
        const marT = (num(tcPr, 'marT') ?? 45720) / 12700
        const marB = (num(tcPr, 'marB') ?? 45720) / 12700
        const anchor = attr(tcPr, 'anchor') ?? 't'
        const width = cols.slice(c, c + span).reduce((a, x) => a + x, 0)
        const txBody = kid(tc, 'a:txBody')
        // The cell's text drawn in flow (rows grow to fit it, as PowerPoint's do).
        const t = drawText(txBody, { lists: [this.defaultText, kid(kid(scope.master, 'p:txStyles'), 'p:otherStyle'), lst], bodies: [] }, { colors: scope.colors, slideNumber: scope.number, tab: this.tab, fonts: this.fonts, embedded: this.embedded }, width, 0)
        const inner = t.html.replace(/^<div class="tx" style="[^"]*">/, '<div class="cell">').replace(/<\/div>$/, '</div>')
        for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < span; dc++) if (dr || dc) covered.add(`${r + dr},${c + dc}`)
        cells.push(
          `<td${span > 1 ? ` colspan="${span}"` : ''}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''} style="padding:${fmt(marT)}pt ${fmt(marR)}pt ${fmt(marB)}pt ${fmt(marL)}pt;vertical-align:${anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top'};background:${fill ?? 'transparent'};border-left:${border('L')};border-right:${border('R')};border-top:${border('T')};border-bottom:${border('B')}">${inner}</td>`
        )
      })
      html.push(`<tr style="height:${fmt((num(tr, 'h') ?? 0) / 12700)}pt">${cells.join('')}</tr>`)
    })
    const colgroup = `<colgroup>${cols.map((w) => `<col style="width:${fmt(w)}pt">`).join('')}</colgroup>`
    return `<div class="sp" style="${this.place({ ...b, w: Math.max(b.w, cols.reduce((a, x) => a + x, 0)) }).replace(/height:[^;]+;/, '')}"><table class="tbl"${rtlTable ? ' dir="rtl"' : ''} style="width:${fmt(cols.reduce((a, x) => a + x, 0))}pt">${colgroup}${html.join('')}</table></div>`
  }
}

const STYLE = (w: number, h: number): string => `
@page { size: ${fmt(w)}pt ${fmt(h)}pt; margin: 0 }
* { box-sizing: border-box }
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.slide { position: relative; width: ${fmt(w)}pt; height: ${fmt(h)}pt; overflow: hidden; break-after: page; background: #fff }
.slide:last-child { break-after: auto }
.bg { position: absolute; left: 0; top: 0 }
.sp { position: absolute; transform-origin: center }
.sp > svg { position: absolute; left: 0; top: 0; overflow: visible }
.tx { position: absolute; display: flex; flex-direction: column; overflow: visible }
.txi { min-width: 0 }
.tx p, .cell p { margin: 0; white-space: pre-wrap; overflow-wrap: break-word }
.tbl { border-collapse: collapse; table-layout: fixed }
.tbl td { overflow: hidden }
`

/** A PowerPoint file as one HTML document, a page per slide (hidden slides left out, as PowerPoint's own PDF export does). */
export async function pptxToHtml(bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConvertedDeck> {
  const pkg = await Package.open(bytes)
  const pres = pkg.xml('ppt/presentation.xml')
  const size = kid(pres, 'p:sldSz')
  const width = (num(size, 'cx') ?? 9144000) / 12700
  const height = (num(size, 'cy') ?? 6858000) / 12700
  const converter = new Converter(pkg, options)
  const fontFaces = await converter.embeddedFonts()
  const slides: string[] = []
  let number = 0
  for (const id of kids(kid(pres, 'p:sldIdLst'), 'p:sldId')) {
    const part = pkg.target('ppt/presentation.xml', attr(id, 'r:id'))
    if (!part) continue
    number++
    const scope = converter.scope(part, number)
    if (!scope) continue
    if (attr(scope.slide, 'show') === '0') continue
    slides.push(converter.slide(scope, width, height))
  }
  if (!slides.length) throw new Error('This presentation has no slides to show.')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Slides</title><style>${fontFaces}${STYLE(width, height)}</style></head><body>${slides.join('\n')}</body></html>`
  return { html: await converter.finish(html), width, height, slides: slides.length, media: converter.media, notes: converter.allNotes(), metafiles: converter.metafiles }
}

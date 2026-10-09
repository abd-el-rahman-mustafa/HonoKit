import { attr, bool, color, css, escapeHtml, fmt, is, kid, kids, num, type ColorContext, type El, type Rgba } from './ooxml'

/**
 * Text in shapes and table cells as HTML (§63). PowerPoint's text inherits in layers — the
 * presentation's defaults, the master's title/body/other styles, the master's and the layout's
 * placeholder, the shape's own list style, the paragraph, the run — and each layer may set only a
 * few properties. Layers are merged here, lowest first, then drawn as CSS. Chromium shapes Arabic
 * and orders mixed right-to-left text.
 */

/** Paragraph or run properties merged from several layers: attributes, and child elements by group. */
interface Props {
  attrs: Map<string, string>
  groups: Map<string, El>
  /** For paragraph properties: the merged default run properties. */
  run?: Props
}

const empty = (): Props => ({ attrs: new Map(), groups: new Map() })

const PARA_GROUPS: Record<string, string> = {
  lnSpc: 'lnSpc', spcBef: 'spcBef', spcAft: 'spcAft',
  buClrTx: 'buClr', buClr: 'buClr',
  buSzTx: 'buSz', buSzPct: 'buSz', buSzPts: 'buSz',
  buFontTx: 'buFont', buFont: 'buFont',
  buNone: 'bu', buAutoNum: 'bu', buChar: 'bu', buBlip: 'bu',
  tabLst: 'tabLst'
}
const RUN_GROUPS: Record<string, string> = {
  noFill: 'fill', solidFill: 'fill', gradFill: 'fill', blipFill: 'fill', pattFill: 'fill', grpFill: 'fill',
  latin: 'latin', ea: 'ea', cs: 'cs', sym: 'sym', highlight: 'highlight', ln: 'ln', effectLst: 'effect', effectDag: 'effect',
  uFillTx: 'uFill', uFill: 'uFill', uLnTx: 'uLn', uLn: 'uLn', hlinkClick: 'hlinkClick'
}

function mergeRun(into: Props, rPr: El | null): void {
  if (!rPr) return
  for (let i = 0; i < rPr.attributes.length; i++) {
    const a = rPr.attributes.item(i)!
    if (!a.name.includes(':')) into.attrs.set(a.name, a.value)
  }
  for (const k of kids(rPr)) {
    const g = RUN_GROUPS[k.localName]
    if (g) into.groups.set(g, k)
  }
}

function mergePara(into: Props, pPr: El | null): void {
  if (!pPr) return
  for (let i = 0; i < pPr.attributes.length; i++) {
    const a = pPr.attributes.item(i)!
    if (!a.name.includes(':')) into.attrs.set(a.name, a.value)
  }
  for (const k of kids(pPr)) {
    if (k.localName === 'defRPr') {
      into.run ??= empty()
      mergeRun(into.run, k)
      continue
    }
    const g = PARA_GROUPS[k.localName]
    if (g) into.groups.set(g, k)
  }
}

/** The style layers of a text body, lowest first. */
export interface TextLayers {
  /** List styles (lstStyle, txStyles' titleStyle…, defaultTextStyle): each holds lvl1pPr…lvl9pPr. */
  lists: Array<El | null>
  /** Body properties (bodyPr), lowest first. */
  bodies: Array<El | null>
  /** The shape style's font reference (its colour and theme font), applied above the inherited defaults. */
  fontRef?: El | null
  /** How many of `lists` are inherited defaults (the font reference goes above them). */
  inherited?: number
}

export interface TextContext {
  colors: ColorContext
  slideNumber: number
  /** Default tab width, in points. */
  tab: number
  /** Font families seen, for the page's font list (kept by the caller). */
  fonts?: Set<string>
  /** Families the file carries (lower case): their faces have their own weights. */
  embedded?: Set<string>
}

/* --- fonts ---------------------------------------------------------------------------------- */

/** Windows fonts that look and measure close to common presentation fonts that may be missing. */
const SUBSTITUTES: Array<[RegExp, string[]]> = [
  [/^helvetica( neue)?|^arial|^inter\b|^roboto(?! (serif|slab|mono))|^open sans|^lato|^source sans|^noto sans|^nunito|^montserrat|^poppins|^openai sans|^sf pro|^avenir|^gotham|^proxima/i, ['Arial', 'Segoe UI']],
  [/^aptos|^calibri|^carlito|^segoe/i, ['Calibri', 'Segoe UI', 'Arial']],
  [/^lora|^roboto (serif|slab)|^georgia|^merriweather|^playfair|^libre baskerville|^source serif|^noto serif|^pt serif|^crimson|^garamond|^eb garamond/i, ['Georgia', 'Cambria', 'Times New Roman']],
  [/^cambria|^times|^book antiqua|^palatino/i, ['Cambria', 'Times New Roman']],
  [/mono|^consolas|^courier/i, ['Consolas', 'Courier New']]
]

const WEIGHT: Array<[RegExp, number]> = [
  [/\b(thin|hairline)\b/i, 100],
  [/\b(extra ?light|ultra ?light)\b/i, 200],
  [/\blight\b/i, 300],
  [/\bmedium\b/i, 500],
  [/\b(semi ?bold|demi ?bold)\b/i, 600],
  [/\b(extra ?bold|ultra ?bold)\b/i, 800],
  [/\b(black|heavy)\b/i, 900]
]

/** A font's weight from its name ("Roboto Medium" → 500), for when a substitute draws it. */
function nameWeight(name: string): number | null {
  for (const [re, w] of WEIGHT) if (re.test(name)) return w
  return null
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/

/** A theme font reference ("+mn-lt") or a typeface, as a typeface. */
function typeface(name: string | null, ctx: TextContext, kind: 'latin' | 'ea' | 'cs'): string {
  if (!name) return ''
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(name)
  if (!m) return name
  const set = m[1] === 'mj' ? ctx.colors.theme.major : ctx.colors.theme.minor
  if (m[2] === 'lt') return set.latin
  if (m[2] === 'ea') return set.ea
  return set.cs || (kind === 'cs' ? set.arab : '')
}

function family(run: Props, ctx: TextContext, arabic: boolean): { css: string; weight: number | null } {
  const latin = typeface(attr(run.groups.get('latin') ?? null, 'typeface'), ctx, 'latin') || ctx.colors.theme.minor.latin
  const cs = typeface(attr(run.groups.get('cs') ?? null, 'typeface'), ctx, 'cs') || ctx.colors.theme.minor.cs || ctx.colors.theme.minor.arab
  const names: string[] = []
  const push = (n: string): void => {
    if (n && !names.includes(n)) names.push(n)
  }
  // Arabic runs use the complex-script font, as PowerPoint does.
  if (arabic) {
    push(cs)
    push(ctx.colors.theme.minor.arab)
  }
  push(latin)
  if (!arabic) push(cs)
  for (const n of [...names]) for (const [re, subs] of SUBSTITUTES) if (re.test(n)) subs.forEach(push)
  if (arabic) ['Segoe UI', 'Sakkal Majalla', 'Arial'].forEach(push)
  else ['Segoe UI', 'Arial'].forEach(push)
  for (const n of names) ctx.fonts?.add(n)
  const primary = arabic ? cs || latin : latin
  const weight = ctx.embedded?.has(primary.toLowerCase()) ? null : nameWeight(primary)
  return { css: names.map((n) => `'${n.replace(/'/g, '')}'`).join(', ') + ', sans-serif', weight }
}

/* --- bullets -------------------------------------------------------------------------------- */

/** Symbol-font bullet characters as the Unicode symbols they draw. */
const SYMBOL_BULLETS: Record<string, Record<string, string>> = {
  wingdings: { '§': '▪', l: '●', n: '■', q: '❑', u: '◆', v: '❖', Ø: '➢', ü: '✓', þ: '☑', Ÿ: '•', è: '➔', à: '➢', ð: '⇨', '': '▪', '': '●', '': '■', '': '✓', '': '➢', '': '❖', '': '❑', '': '➔' },
  symbol: { '·': '•', '': '•', o: '○', '¨': '♦', '': '♦' },
  'courier new': { o: '○' }
}

function bulletChar(char: string, font: string): string {
  const table = SYMBOL_BULLETS[font.toLowerCase()]
  return table?.[char] ?? (font.toLowerCase() === 'wingdings' ? '▪' : char)
}

const roman = (n: number): string => {
  const map: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [v, s] of map) while (n >= v) ((out += s), (n -= v))
  return out
}
const alpha = (n: number): string => {
  let out = ''
  while (n > 0) {
    n--
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}
const ARABIC_ABJAD = 'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ'
const HINDI_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** An automatic number in one of DrawingML's schemes ("arabicPeriod" → "3."). */
function autoNumber(scheme: string, n: number): string {
  const m = /^(arabic|roman(Uc|Lc)|alpha(Uc|Lc)|hindiNum|arabicAbjad|arabicAlpha|thaiNum|ea1|circleNum)(.*)$/.exec(scheme)
  let body = String(n)
  if (scheme.startsWith('romanUc')) body = roman(n).toUpperCase()
  else if (scheme.startsWith('romanLc')) body = roman(n)
  else if (scheme.startsWith('alphaUc')) body = alpha(n).toUpperCase()
  else if (scheme.startsWith('alphaLc')) body = alpha(n)
  else if (scheme.startsWith('hindiNum')) body = String(n).replace(/\d/g, (d) => HINDI_DIGITS[Number(d)]!)
  else if (scheme.startsWith('arabicAbjad') || scheme.startsWith('arabicAlpha')) body = ARABIC_ABJAD[(n - 1) % ARABIC_ABJAD.length]!
  else if (scheme.startsWith('circleNum')) body = n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n)
  const tail = m?.[4] ?? 'Period'
  if (/ParenBoth/.test(tail)) return `(${body})`
  if (/ParenR/.test(tail)) return `${body})`
  if (/Period/.test(tail)) return `${body}.`
  if (/Minus|Dash/.test(tail)) return `${body} -`
  return body
}

/* --- drawing -------------------------------------------------------------------------------- */

interface RunStyle {
  size: number
  css: string
  color: Rgba | null
}

function runStyle(run: Props, ctx: TextContext, scale: number, arabic: boolean, hyperlink: boolean, fontRef: El | null | undefined): RunStyle {
  const size = ((Number(run.attrs.get('sz') ?? 1800) || 1800) / 100) * scale
  const parts: string[] = [`font-size:${fmt(size)}pt`]
  const f = family(run, ctx, arabic)
  parts.push(`font-family:${f.css}`)
  const bold = run.attrs.get('b')
  if (bold === '1' || bold === 'true') parts.push('font-weight:700')
  else if (f.weight) parts.push(`font-weight:${f.weight}`)
  const italic = run.attrs.get('i')
  if (italic === '1' || italic === 'true') parts.push('font-style:italic')
  const fill = run.groups.get('fill')
  let c: Rgba | null = null
  if (fill && is(fill, 'a:solidFill')) c = color(fill, ctx.colors)
  else if (fill && is(fill, 'a:gradFill')) c = color(kid(fill, 'a:gsLst', 'a:gs'), ctx.colors)
  else if (fill && is(fill, 'a:noFill')) c = { r: 0, g: 0, b: 0, a: 0 }
  else if (fontRef) c = color(fontRef, ctx.colors)
  if (hyperlink && !(fill && is(fill, 'a:solidFill'))) c = ctx.colors.theme.colors[ctx.colors.map.hlink ?? 'hlink'] ?? c
  if (c) parts.push(`color:${css(c)}`)
  const decorations: string[] = []
  const u = run.attrs.get('u')
  if ((u && u !== 'none') || hyperlink) {
    decorations.push('underline')
    if (u === 'dbl') parts.push('text-decoration-style:double')
    else if (u && /dot/i.test(u)) parts.push('text-decoration-style:dotted')
    else if (u && /dash/i.test(u)) parts.push('text-decoration-style:dashed')
    else if (u && /wavy/i.test(u)) parts.push('text-decoration-style:wavy')
  }
  const strike = run.attrs.get('strike')
  if (strike && strike !== 'noStrike') decorations.push('line-through')
  if (decorations.length) parts.push(`text-decoration-line:${decorations.join(' ')}`)
  const spc = Number(run.attrs.get('spc') ?? 0)
  if (spc) parts.push(`letter-spacing:${fmt((spc / 100) * scale)}pt`)
  const cap = run.attrs.get('cap')
  if (cap === 'all') parts.push('text-transform:uppercase')
  else if (cap === 'small') parts.push('font-variant:small-caps')
  const baseline = Number(run.attrs.get('baseline') ?? 0)
  if (baseline) parts.push(`vertical-align:${fmt(baseline / 1000)}%`, `font-size:${fmt(size * 0.67)}pt`)
  const highlight = run.groups.get('highlight')
  if (highlight) parts.push(`background-color:${css(color(highlight, ctx.colors))}`)
  const outline = run.groups.get('ln')
  if (outline && kid(outline, 'a:solidFill')) parts.push(`-webkit-text-stroke:${fmt(Math.max(0.25, (num(outline, 'w') ?? 9525) / 12700))}pt ${css(color(kid(outline, 'a:solidFill'), ctx.colors))}`)
  return { size, css: parts.join(';'), color: c }
}

/** Space before or after a paragraph: points, or a share of its line. */
function spacing(el: El | null, size: number, scale: number): number {
  if (!el) return 0
  const pts = kid(el, 'a:spcPts')
  if (pts) return ((num(pts, 'val') ?? 0) / 100) * scale
  const pct = kid(el, 'a:spcPct')
  if (pct) return ((num(pct, 'val') ?? 0) / 100000) * size * 1.2
  return 0
}

export interface TextBox {
  /** The text, positioned inside the shape's box. */
  html: string
  /** Whether there is any text to draw. */
  hasText: boolean
}

/**
 * A text body in a box of w × h points. `layers` gives the inherited styles; the body's own
 * lstStyle and bodyPr are taken from it last.
 */
export function drawText(txBody: El | null, layers: TextLayers, ctx: TextContext, w: number, h: number): TextBox {
  if (!txBody) return { html: '', hasText: false }
  const paragraphs = kids(txBody, 'a:p')
  if (!paragraphs.length) return { html: '', hasText: false }
  // Body properties: inherited, then the body's own.
  const body = new Map<string, string>()
  let autofit: El | null = null
  for (const b of [...layers.bodies, kid(txBody, 'a:bodyPr')]) {
    if (!b) continue
    for (let i = 0; i < b.attributes.length; i++) {
      const a = b.attributes.item(i)!
      if (!a.name.includes(':')) body.set(a.name, a.value)
    }
    const fit = kid(b, 'a:normAutofit') ?? kid(b, 'a:spAutoFit') ?? kid(b, 'a:noAutofit')
    if (fit) autofit = fit
  }
  const n = (k: string, d: number): number => {
    const v = Number(body.get(k))
    return Number.isFinite(v) && body.has(k) ? v : d
  }
  const scale = autofit && is(autofit, 'a:normAutofit') ? (num(autofit, 'fontScale') ?? 100000) / 100000 : 1
  const lineCut = autofit && is(autofit, 'a:normAutofit') ? (num(autofit, 'lnSpcReduction') ?? 0) / 100000 : 0
  const lists = [...layers.lists, kid(txBody, 'a:lstStyle')]
  const inherited = layers.inherited ?? layers.lists.length
  const spaceFirstLast = body.get('spcFirstLastPara') === '1'

  const counters: number[] = []
  let anyText = false
  const html: string[] = []
  paragraphs.forEach((p, index) => {
    const pPr = kid(p, 'a:pPr')
    const level = Math.max(0, Math.min(8, num(pPr, 'lvl') ?? 0))
    // The paragraph's properties: each layer's level style, then its own.
    const props = empty()
    lists.forEach((list, i) => {
      if (i === inherited && layers.fontRef) {
        // The shape style's font colour and face sit above the inherited defaults.
        props.run ??= empty()
        const fill = kids(layers.fontRef).find((k) => /Clr$/.test(k.localName))
        if (fill) {
          const solid = layers.fontRef.ownerDocument!.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:solidFill')
          solid.appendChild(fill.cloneNode(true))
          props.run.groups.set('fill', solid as unknown as El)
        }
      }
      mergePara(props, kid(list, `a:lvl${level + 1}pPr`))
    })
    mergePara(props, pPr)
    const runs = kids(p).filter((k) => is(k, 'a:r') || is(k, 'a:br') || is(k, 'a:fld'))
    const text = runs.map((r) => (is(r, 'a:br') ? '\n' : (kid(r, 'a:t')?.textContent ?? ''))).join('')
    const arabicPara = ARABIC.test(text)
    // The paragraph's direction is the file's (bullet side, indents); Arabic inside a left-to-right
    // paragraph is still ordered right to left by the browser, as PowerPoint draws it.
    const rtl = props.attrs.get('rtl') === '1'
    // Run styles: the paragraph's default run properties, then each run's own.
    const styled = runs.map((r) => {
      const rp = empty()
      if (props.run) {
        for (const [k, v] of props.run.attrs) rp.attrs.set(k, v)
        for (const [k, v] of props.run.groups) rp.groups.set(k, v)
      }
      mergeRun(rp, kid(r, 'a:rPr'))
      return { el: r, props: rp }
    })
    const end = empty()
    if (props.run) {
      for (const [k, v] of props.run.attrs) end.attrs.set(k, v)
      for (const [k, v] of props.run.groups) end.groups.set(k, v)
    }
    mergeRun(end, kid(p, 'a:endParaRPr'))
    const sizeOf = (rp: Props): number => ((Number(rp.attrs.get('sz') ?? 1800) || 1800) / 100) * scale
    const size = styled.length ? Math.max(...styled.map((s) => sizeOf(s.props))) : sizeOf(end)

    // Line spacing.
    const lnSpc = props.groups.get('lnSpc')
    let lineHeight = `${fmt(1.2 * Math.max(0.1, 1 - lineCut))}`
    if (lnSpc) {
      const pct = kid(lnSpc, 'a:spcPct')
      const pts = kid(lnSpc, 'a:spcPts')
      if (pct) lineHeight = fmt(1.2 * Math.max(0.1, (num(pct, 'val') ?? 100000) / 100000 - lineCut))
      else if (pts) lineHeight = `${fmt(((num(pts, 'val') ?? 1200) / 100) * scale)}pt`
    }
    const before = index === 0 && !spaceFirstLast ? 0 : spacing(props.groups.get('spcBef') ?? null, size, scale)
    const after = index === paragraphs.length - 1 && !spaceFirstLast ? 0 : spacing(props.groups.get('spcAft') ?? null, size, scale)
    const marL = (Number(props.attrs.get('marL') ?? 0) || 0) / 12700
    const indent = (Number(props.attrs.get('indent') ?? 0) || 0) / 12700
    const algn = props.attrs.get('algn') ?? 'l'
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' || algn === 'justLow' || algn === 'dist' || algn === 'thaiDist' ? 'justify' : 'left'
    const style = [
      `text-align:${align}`,
      // The paragraph's own size (its largest run's): without it the line's strut is the page's
      // 12 pt, and text smaller than that (tiny print in a table, §68) gets 14 pt lines.
      `font-size:${fmt(size)}pt`,
      `line-height:${lineHeight}`,
      `padding-top:${fmt(before)}pt`,
      `padding-bottom:${fmt(after)}pt`,
      `padding-inline-start:${fmt(marL)}pt`,
      `text-indent:${fmt(indent)}pt`
    ]
    if (algn === 'dist') style.push('text-align-last:justify')

    // The bullet, when the paragraph has text.
    let bullet = ''
    const bu = props.groups.get('bu')
    const hasText = text.trim().length > 0
    if (bu && is(bu, 'a:buAutoNum')) {
      for (let i = level + 1; i < counters.length; i++) counters[i] = 0
      counters[level] = counters[level] ? counters[level]! + 1 : (num(bu, 'startAt') ?? 1)
    } else {
      counters[level] = 0
      for (let i = level + 1; i < counters.length; i++) counters[i] = 0
    }
    if (bu && hasText && !is(bu, 'a:buNone')) {
      const first = styled.find((s) => is(s.el, 'a:r') || is(s.el, 'a:fld'))?.props ?? end
      const firstStyle = runStyle(first, ctx, scale, arabicPara, false, layers.fontRef)
      const fontEl = props.groups.get('buFont')
      const buFont = fontEl && is(fontEl, 'a:buFont') ? (attr(fontEl, 'typeface') ?? '') : ''
      const sizeEl = props.groups.get('buSz')
      const buSize = sizeEl && is(sizeEl, 'a:buSzPct') ? firstStyle.size * ((num(sizeEl, 'val') ?? 100000) / 100000) : sizeEl && is(sizeEl, 'a:buSzPts') ? (num(sizeEl, 'val') ?? 1800) / 100 : firstStyle.size
      const clrEl = props.groups.get('buClr')
      const buColor = clrEl && is(clrEl, 'a:buClr') ? color(clrEl, ctx.colors) : firstStyle.color
      const glyph = is(bu, 'a:buChar') ? bulletChar(attr(bu, 'char') ?? '•', buFont) : is(bu, 'a:buAutoNum') ? autoNumber(attr(bu, 'type') ?? 'arabicPeriod', counters[level] ?? 1) : '•'
      const symbolFont = /^(wingdings|symbol|webdings)/i.test(buFont)
      const width = indent < 0 ? -indent : 0
      bullet = `<span class="bu" style="display:inline-block;text-indent:0;min-width:${fmt(width)}pt;font-size:${fmt(buSize)}pt;${symbolFont || !buFont ? `font-family:${family(first, ctx, arabicPara).css}` : `font-family:'${buFont}', 'Segoe UI Symbol', sans-serif`};color:${css(buColor)}">${escapeHtml(glyph)}</span>`
    }

    // The runs.
    const parts: string[] = []
    for (const s of styled) {
      if (is(s.el, 'a:br')) {
        parts.push('<br>')
        continue
      }
      let t = kid(s.el, 'a:t')?.textContent ?? ''
      if (is(s.el, 'a:fld') && attr(s.el, 'type') === 'slidenum') t = String(ctx.slideNumber)
      if (!t) continue
      anyText ||= t.trim().length > 0
      const link = !!s.props.groups.get('hlinkClick')
      const rs = runStyle(s.props, ctx, scale, ARABIC.test(t), link, layers.fontRef)
      parts.push(`<span style="${rs.css}">${escapeHtml(t)}</span>`)
    }
    // An empty paragraph keeps its line's height.
    if (!parts.length) {
      const rs = runStyle(end, ctx, scale, false, false, layers.fontRef)
      parts.push(`<span style="${rs.css}">​</span>`)
    }
    html.push(`<p dir="${rtl ? 'rtl' : 'ltr'}" style="${style.join(';')}">${bullet}${parts.join('')}</p>`)
  })

  const lIns = n('lIns', 91440) / 12700
  const tIns = n('tIns', 45720) / 12700
  const rIns = n('rIns', 91440) / 12700
  const bIns = n('bIns', 45720) / 12700
  const anchor = body.get('anchor') ?? 't'
  const wrap = body.get('wrap') !== 'none'
  const vert = body.get('vert') ?? 'horz'
  const columns = n('numCol', 1)
  const box = [
    `left:${fmt(lIns)}pt`,
    `top:${fmt(tIns)}pt`,
    `width:${fmt(Math.max(0, w - lIns - rIns))}pt`,
    `height:${fmt(Math.max(0, h - tIns - bIns))}pt`,
    `justify-content:${anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'}`,
    `tab-size:${fmt(ctx.tab)}pt`
  ]
  if (!wrap) box.push('white-space:pre')
  if (body.get('anchorCtr') === '1') box.push('align-items:center')
  let inner = `<div class="txi"${columns > 1 ? ` style="column-count:${columns};column-gap:${fmt(n('spcCol', 0) / 12700)}pt"` : ''}>${html.join('')}</div>`
  if (vert === 'vert' || vert === 'eaVert' || vert === 'vert270' || vert === 'wordArtVert') {
    // Vertical text: the box turned a quarter, its text laid out along the turned width.
    const turn = vert === 'vert270' ? -90 : 90
    box.splice(0, 4, `left:${fmt(lIns + (w - lIns - rIns - (h - tIns - bIns)) / 2)}pt`, `top:${fmt(tIns + (h - tIns - bIns - (w - lIns - rIns)) / 2)}pt`, `width:${fmt(Math.max(0, h - tIns - bIns))}pt`, `height:${fmt(Math.max(0, w - lIns - rIns))}pt`, `transform:rotate(${turn}deg)`)
  }
  const rotation = num(kid(txBody, 'a:bodyPr'), 'rot')
  if (rotation) box.push(`transform:rotate(${fmt(rotation / 60000)}deg)`)
  inner = `<div class="tx" style="${box.join(';')}">${inner}</div>`
  return { html: inner, hasText: anyText || paragraphs.some((p) => kids(p, 'a:r').length > 0) }
}

/** Whether a flag attribute is on (exported for the table and slide code). */
export const flag = bool

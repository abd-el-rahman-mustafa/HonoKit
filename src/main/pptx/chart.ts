import { attr, color, css, escapeHtml, find, fmt, kid, kids, num, type ColorContext, type El, type Rgba } from './ooxml'

/**
 * Charts as SVG (§63), from the values PowerPoint keeps with each chart (its cache of the
 * embedded workbook), so neither Excel nor the workbook is needed. Column, bar, line, area, pie,
 * doughnut and scatter charts, alone or combined, with their axes, gridlines, labels, legend and
 * title. 3-D charts are drawn flat.
 */

interface Series {
  name: string
  values: Array<number | null>
  categories: string[]
  xValues?: Array<number | null>
  fill: Rgba | null
  line: Rgba | null
  lineWidth: number | null
  noLine: boolean
  marker: string | null
  points: Map<number, Rgba>
  labels: Labels | null
  /** A point's own label settings (c:dLbl), over the series'. */
  pointLabels: Map<number, Labels | null>
  format: string
}

interface Labels {
  value: boolean
  percent: boolean
  category: boolean
  series: boolean
  position: string | null
  size: number
  color: Rgba | null
  bold: boolean
}

interface Group {
  kind: 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter'
  horizontal: boolean
  grouping: string
  series: Series[]
  gap: number
  overlap: number
  hole: number
  vary: boolean
  labels: Labels | null
  axes: string[]
}

interface ChartText {
  size: number
  color: Rgba | null
  bold: boolean
}

const PALETTE_KEYS = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
const ARABIC_TEXT = new RegExp('[\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF]')
/** First-strong isolate and its end (Unicode bidi). */
const FSI = String.fromCharCode(0x2068)
const PDI = String.fromCharCode(0x2069)

function strings(ref: El | null): string[] {
  const cache = kid(ref, 'c:strRef', 'c:strCache') ?? kid(ref, 'c:numRef', 'c:numCache') ?? kid(ref, 'c:multiLvlStrRef', 'c:multiLvlStrCache', 'c:lvl') ?? kid(ref, 'c:strLit') ?? kid(ref, 'c:numLit')
  if (!cache) return []
  const count = num(kid(cache, 'c:ptCount'), 'val') ?? 0
  const out = new Array<string>(count).fill('')
  for (const p of kids(cache, 'c:pt')) {
    const i = num(p, 'idx') ?? 0
    out[i] = kid(p, 'c:v')?.textContent ?? ''
  }
  return out
}

function numbers(ref: El | null): { values: Array<number | null>; format: string } {
  const cache = kid(ref, 'c:numRef', 'c:numCache') ?? kid(ref, 'c:numLit')
  if (!cache) return { values: [], format: 'General' }
  const count = num(kid(cache, 'c:ptCount'), 'val') ?? 0
  const out = new Array<number | null>(count).fill(null)
  for (const p of kids(cache, 'c:pt')) {
    const v = Number(kid(p, 'c:v')?.textContent)
    out[num(p, 'idx') ?? 0] = Number.isFinite(v) ? v : null
  }
  return { values: out, format: kid(cache, 'c:formatCode')?.textContent ?? 'General' }
}

/** A number in an Excel-style format, simply: percent, decimals, thousands, currency signs. */
function formatNumber(v: number, format: string): string {
  if (!format || format === 'General') {
    const r = Math.round(v * 1e6) / 1e6
    return Math.abs(r) >= 1e15 ? r.toExponential(2) : String(r)
  }
  const section = format.split(';')[v < 0 && format.includes(';') ? 1 : 0] ?? format
  const percent = section.includes('%')
  const decimals = (/\.(0+)/.exec(section)?.[1] ?? '').length
  const grouped = /#,##|0,0/.test(section)
  const value = Math.abs(percent ? v * 100 : v) * (v < 0 && format.includes(';') ? 1 : Math.sign(v) || 1)
  let body = value.toFixed(decimals)
  if (grouped) {
    const [int, frac] = body.split('.')
    body = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
  }
  const literal = (s: string): string => s.replace(/\[[^\]]*\]|"|\\|_.|\*./g, '').replace(/[#0,.%?]/g, '')
  const at = section.search(/[#0?]/)
  const prefix = at > 0 ? literal(section.slice(0, at)) : ''
  const lastDigit = Math.max(section.lastIndexOf('0'), section.lastIndexOf('#'))
  const suffix = lastDigit >= 0 ? literal(section.slice(lastDigit + 1)) : ''
  return `${prefix}${body}${percent ? '%' : ''}${suffix}`
}

function textOf(txPr: El | null, ctx: ColorContext, fallback: ChartText): ChartText {
  const def = find(txPr, 'a:defRPr')
  if (!def) return fallback
  const fill = kid(def, 'a:solidFill')
  return {
    size: (num(def, 'sz') ?? fallback.size * 100) / 100,
    color: fill ? color(fill, ctx) : fallback.color,
    bold: attr(def, 'b') === '1' ? true : attr(def, 'b') === '0' ? false : fallback.bold
  }
}

function labelsOf(el: El | null, ctx: ColorContext, base: ChartText): Labels | null {
  if (!el || attr(kid(el, 'c:delete'), 'val') === '1') return null
  const on = (name: string): boolean => attr(kid(el, name), 'val') === '1'
  const t = textOf(kid(el, 'c:txPr'), ctx, base)
  const l: Labels = { value: on('c:showVal'), percent: on('c:showPercent'), category: on('c:showCatName'), series: on('c:showSerName'), position: attr(kid(el, 'c:dLblPos'), 'val'), size: t.size, color: t.color, bold: t.bold }
  return l.value || l.percent || l.category || l.series ? l : null
}

function fillOf(spPr: El | null, ctx: ColorContext): { fill: Rgba | null; line: Rgba | null; width: number | null; noFill: boolean; noLine: boolean } {
  const solid = kid(spPr, 'a:solidFill')
  const grad = kid(spPr, 'a:gradFill')
  const ln = kid(spPr, 'a:ln')
  return {
    fill: solid ? color(solid, ctx) : grad ? color(kid(grad, 'a:gsLst', 'a:gs'), ctx) : null,
    noFill: !!kid(spPr, 'a:noFill'),
    line: kid(ln, 'a:solidFill') ? color(kid(ln, 'a:solidFill'), ctx) : null,
    width: num(ln, 'w') !== undefined ? num(ln, 'w')! / 12700 : null,
    noLine: !!kid(ln, 'a:noFill')
  }
}

/** The colour of series or point `i` when the chart does not give one: the theme's accents, then darker and lighter turns. */
function paletteColor(i: number, ctx: ColorContext): Rgba {
  const base = ctx.theme.colors[PALETTE_KEYS[i % 6]!] ?? { r: 68, g: 114, b: 196, a: 1 }
  const round = Math.floor(i / 6)
  if (!round) return base
  const k = round % 2 ? 0.6 : 1.4
  const c = (v: number): number => Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))
  return { r: c(base.r), g: c(base.g), b: c(base.b), a: 1 }
}

/** "Nice" axis bounds and step for values from lo to hi. */
function niceScale(lo: number, hi: number, fixedMin?: number, fixedMax?: number, fixedStep?: number): { min: number; max: number; step: number } {
  let min = fixedMin ?? Math.min(0, lo)
  let max = fixedMax ?? Math.max(0, hi)
  if (max === min) max = min + 1
  const raw = (max - min) / 5
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = fixedStep ?? ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag)
  if (fixedMin === undefined) min = Math.floor(min / step) * step
  if (fixedMax === undefined) max = Math.ceil(max / step) * step
  return { min, max, step }
}

function svgText(x: number, y: number, text: string, t: ChartText, family: string, anchor: 'start' | 'middle' | 'end' = 'middle', baseline = 'central', extra = ''): string {
  // Text with Arabic is an isolate with its own direction ("الهاتف 55%" reads right to left), while the chart's anchors stay left to right.
  if (ARABIC_TEXT.test(text)) text = `${FSI}${text}${PDI}`
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(t.size)}" font-family="${family}" fill="${css(t.color)}" text-anchor="${anchor}" dominant-baseline="${baseline}"${t.bold ? ' font-weight="700"' : ''}${extra}>${escapeHtml(text)}</text>`
}

/** A chart part drawn in a box of w × h points. */
export function drawChart(space: El | null, ctx: ColorContext, w: number, h: number, fontFamily: string): string {
  const chart = kid(space, 'c:chart')
  if (!chart) return ''
  const gray: Rgba = { r: 89, g: 89, b: 89, a: 1 }
  const base = textOf(kid(space, 'c:txPr'), ctx, { size: 10, color: gray, bold: false })
  const plot = kid(chart, 'c:plotArea')
  const out: string[] = []
  const family = escapeHtml(fontFamily)

  // The chart's own background and border.
  const spaceFill = fillOf(kid(space, 'c:spPr'), ctx)
  if (spaceFill.fill || (spaceFill.line && !spaceFill.noLine)) out.push(`<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" fill="${spaceFill.noFill ? 'none' : css(spaceFill.fill ?? { r: 255, g: 255, b: 255, a: 1 })}" stroke="${spaceFill.line && !spaceFill.noLine ? css(spaceFill.line) : 'none'}"/>`)

  // The chart groups (several in a combination chart).
  const groups: Group[] = []
  let seriesIndex = 0
  for (const g of kids(plot)) {
    const name = g.localName
    const kind = /^bar/.test(name) ? 'bar' : /^line/.test(name) || name === 'stockChart' ? 'line' : /^area/.test(name) ? 'area' : /^pie|ofPie/.test(name) ? 'pie' : name === 'doughnutChart' ? 'doughnut' : name === 'scatterChart' || name === 'bubbleChart' || name === 'radarChart' ? 'scatter' : null
    if (!kind) continue
    const groupLabels = labelsOf(kid(g, 'c:dLbls'), ctx, base)
    const vary = attr(kid(g, 'c:varyColors'), 'val') === '1'
    const series: Series[] = []
    for (const s of kids(g, 'c:ser')) {
      const sp = fillOf(kid(s, 'c:spPr'), ctx)
      const idx = num(kid(s, 'c:idx'), 'val') ?? seriesIndex
      const val = numbers(kid(s, 'c:val') ?? kid(s, 'c:yVal'))
      const points = new Map<number, Rgba>()
      for (const dp of kids(s, 'c:dPt')) {
        const f = fillOf(kid(dp, 'c:spPr'), ctx)
        if (f.fill) points.set(num(kid(dp, 'c:idx'), 'val') ?? 0, f.fill)
      }
      const marker = kid(s, 'c:marker')
      const symbol = attr(kid(marker, 'c:symbol'), 'val')
      series.push({
        name: strings(kid(s, 'c:tx'))[0] ?? kid(s, 'c:tx', 'c:v')?.textContent ?? `Series ${idx + 1}`,
        values: val.values,
        categories: strings(kid(s, 'c:cat') ?? kid(s, 'c:xVal')),
        xValues: kind === 'scatter' ? numbers(kid(s, 'c:xVal')).values : undefined,
        fill: sp.noFill ? null : (sp.fill ?? (kind === 'line' || kind === 'scatter' ? (sp.line ?? paletteColor(idx, ctx)) : paletteColor(idx, ctx))),
        line: sp.line ?? (kind === 'line' || kind === 'scatter' ? paletteColor(idx, ctx) : null),
        lineWidth: sp.width,
        noLine: sp.noLine,
        marker: symbol ?? (kind === 'line' && attr(kid(g, 'c:marker'), 'val') === '1' ? 'circle' : kind === 'scatter' ? 'circle' : null),
        points,
        labels: labelsOf(kid(s, 'c:dLbls'), ctx, base) ?? groupLabels,
        pointLabels: new Map(kids(kid(s, 'c:dLbls'), 'c:dLbl').map((d) => [num(kid(d, 'c:idx'), 'val') ?? 0, labelsOf(d, ctx, base)] as const)),
        format: val.format
      })
      seriesIndex++
    }
    if (!series.length) continue
    groups.push({
      kind,
      horizontal: attr(kid(g, 'c:barDir'), 'val') === 'bar',
      grouping: attr(kid(g, 'c:grouping'), 'val') ?? (kind === 'bar' ? 'clustered' : 'standard'),
      series,
      gap: (num(kid(g, 'c:gapWidth'), 'val') ?? 150) / 100,
      overlap: (num(kid(g, 'c:overlap'), 'val') ?? (attr(kid(g, 'c:grouping'), 'val')?.includes('tacked') ? 100 : 0)) / 100,
      hole: (num(kid(g, 'c:holeSize'), 'val') ?? 50) / 100,
      vary: vary && (kind === 'pie' || kind === 'doughnut' || series.length === 1),
      labels: groupLabels,
      axes: kids(g, 'c:axId').map((a) => attr(a, 'val') ?? '')
    })
  }
  if (!groups.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}pt" height="${fmt(h)}pt" viewBox="0 0 ${fmt(w)} ${fmt(h)}">${out.join('')}</svg>`

  // The title: its own text, or the only series' name.
  let top = 6
  const titleEl = kid(chart, 'c:title')
  const autoDeleted = attr(kid(chart, 'c:autoTitleDeleted'), 'val') === '1'
  const allSeries = groups.flatMap((g) => g.series)
  let title = ''
  const titleText = textOf(kid(titleEl, 'c:txPr') ?? kid(titleEl, 'c:tx', 'c:rich'), ctx, { size: base.size * 1.4, color: base.color, bold: false })
  if (titleEl) {
    const rich = kid(titleEl, 'c:tx', 'c:rich')
    title = rich ? kids(rich, 'a:p').map((p) => kids(p, 'a:r').map((r) => kid(r, 'a:t')?.textContent ?? '').join('')).join(' ') : allSeries.length === 1 ? allSeries[0]!.name : ''
    const richRun = find(rich, 'a:rPr')
    if (richRun && num(richRun, 'sz')) titleText.size = num(richRun, 'sz')! / 100
  } else if (!autoDeleted && allSeries.length === 1 && groups[0]!.kind !== 'pie') {
    title = ''
  }
  if (title) {
    out.push(svgText(w / 2, top + titleText.size * 0.7, title, titleText, family))
    top += titleText.size * 1.6
  }

  // The legend.
  const legend = kid(chart, 'c:legend')
  const legendPos = attr(kid(legend, 'c:legendPos'), 'val') ?? 'r'
  const legendText = textOf(kid(legend, 'c:txPr'), ctx, base)
  const pieLike = groups.every((g) => g.kind === 'pie' || g.kind === 'doughnut')
  const entries: Array<{ name: string; fill: Rgba | null; line: boolean }> = pieLike
    ? (groups[0]!.series[0]?.categories ?? []).map((c, i) => ({ name: c, fill: groups[0]!.series[0]!.points.get(i) ?? paletteColor(i, ctx), line: false }))
    : allSeries.map((s) => ({ name: s.name, fill: s.fill ?? s.line, line: !s.fill || groups.find((g) => g.series.includes(s))!.kind === 'line' }))
  let left = 6
  let right = w - 6
  let bottom = h - 6
  if (legend && entries.length) {
    const sw = legendText.size * 0.8
    const widthOf = (s: string): number => sw + 4 + s.length * legendText.size * 0.52
    if (legendPos === 'r' || legendPos === 'l' || legendPos === 'tr') {
      const lw = Math.min(w * 0.35, Math.max(...entries.map((e) => widthOf(e.name))) + 8)
      const lh = entries.length * legendText.size * 1.5
      const x = legendPos === 'l' ? left : right - lw
      let y = top + (bottom - top - lh) / 2
      for (const e of entries) {
        out.push(e.line ? `<line x1="${fmt(x)}" y1="${fmt(y + sw / 2)}" x2="${fmt(x + sw * 1.4)}" y2="${fmt(y + sw / 2)}" stroke="${css(e.fill)}" stroke-width="2"/>` : `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(sw)}" height="${fmt(sw)}" fill="${css(e.fill)}"/>`)
        out.push(svgText(x + (e.line ? sw * 1.4 : sw) + 4, y + sw / 2, e.name, legendText, family, 'start'))
        y += legendText.size * 1.5
      }
      if (legendPos === 'l') left += lw + 6
      else right -= lw + 6
    } else {
      const total = entries.reduce((a, e) => a + widthOf(e.name) + 12, 0)
      let x = Math.max(left, (w - total) / 2)
      const y = legendPos === 't' ? top : bottom - legendText.size
      for (const e of entries) {
        out.push(e.line ? `<line x1="${fmt(x)}" y1="${fmt(y + sw / 2)}" x2="${fmt(x + sw * 1.4)}" y2="${fmt(y + sw / 2)}" stroke="${css(e.fill)}" stroke-width="2"/>` : `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(sw)}" height="${fmt(sw)}" fill="${css(e.fill)}"/>`)
        out.push(svgText(x + (e.line ? sw * 1.4 : sw) + 4, y + sw / 2, e.name, legendText, family, 'start'))
        x += widthOf(e.name) + 12
      }
      if (legendPos === 't') top += legendText.size * 1.8
      else bottom -= legendText.size * 1.8
    }
  }

  // Pie and doughnut charts.
  if (pieLike) {
    const g = groups[0]!
    const s = g.series[0]!
    const values = s.values.map((v) => Math.max(0, v ?? 0))
    const total = values.reduce((a, b) => a + b, 0) || 1
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    const r = Math.max(4, Math.min(right - left, bottom - top) / 2 - 4)
    const first = (num(kid(plot, 'c:pieChart', 'c:firstSliceAng') ?? kid(plot, 'c:doughnutChart', 'c:firstSliceAng'), 'val') ?? 0) * (Math.PI / 180)
    let a = -Math.PI / 2 + first
    const inner = g.kind === 'doughnut' ? r * g.hole : 0
    values.forEach((v, i) => {
      const sweep = (v / total) * Math.PI * 2
      const fillC = s.points.get(i) ?? paletteColor(i, ctx)
      const a2 = a + sweep
      const large = sweep > Math.PI ? 1 : 0
      const p = (ang: number, rr: number): string => `${fmt(cx + rr * Math.cos(ang))},${fmt(cy + rr * Math.sin(ang))}`
      const d =
        sweep >= Math.PI * 2 - 1e-6
          ? `M${p(a, r)} A${fmt(r)},${fmt(r)} 0 1 1 ${p(a + Math.PI, r)} A${fmt(r)},${fmt(r)} 0 1 1 ${p(a, r)} Z${inner ? ` M${p(a, inner)} A${fmt(inner)},${fmt(inner)} 0 1 0 ${p(a + Math.PI, inner)} A${fmt(inner)},${fmt(inner)} 0 1 0 ${p(a, inner)} Z` : ''}`
          : inner
            ? `M${p(a, r)} A${fmt(r)},${fmt(r)} 0 ${large} 1 ${p(a2, r)} L${p(a2, inner)} A${fmt(inner)},${fmt(inner)} 0 ${large} 0 ${p(a, inner)} Z`
            : `M${fmt(cx)},${fmt(cy)} L${p(a, r)} A${fmt(r)},${fmt(r)} 0 ${large} 1 ${p(a2, r)} Z`
      out.push(`<path d="${d}" fill="${css(fillC)}" stroke="#fff" stroke-width="1" fill-rule="evenodd"/>`)
      const lb = s.pointLabels.has(i) ? s.pointLabels.get(i)! : s.labels
      if (lb && v > 0) {
        const mid = a + sweep / 2
        const rr = lb.position === 'outEnd' ? r + lb.size : inner ? (r + inner) / 2 : r * 0.65
        const parts = [lb.category ? s.categories[i] ?? '' : '', lb.value ? formatNumber(v, s.format) : '', lb.percent ? `${Math.round((v / total) * 100)}%` : ''].filter(Boolean)
        out.push(svgText(cx + rr * Math.cos(mid), cy + rr * Math.sin(mid), parts.join('; '), { size: lb.size, color: lb.color ?? (lb.position === 'outEnd' ? base.color : { r: 255, g: 255, b: 255, a: 1 }), bold: lb.bold }, family))
      }
      a = a2
    })
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}pt" height="${fmt(h)}pt" viewBox="0 0 ${fmt(w)} ${fmt(h)}">${out.join('')}</svg>`
  }

  // Axes: category (or x) and value axes.
  const axes = new Map<string, El>()
  for (const ax of kids(plot)) if (/Ax$/.test(ax.localName)) axes.set(attr(kid(ax, 'c:axId'), 'val') ?? '', ax)
  const main = groups[0]!
  const valAx = main.axes.map((id) => axes.get(id)).find((a) => a && a.localName === 'valAx') ?? null
  const catAx = main.axes.map((id) => axes.get(id)).find((a) => a && a.localName !== 'valAx') ?? (main.kind === 'scatter' ? (main.axes.map((id) => axes.get(id)).find((a) => a && a !== valAx) ?? null) : null)
  const horizontal = main.kind === 'bar' && main.horizontal
  const categories = main.series[0]!.categories.length ? main.series[0]!.categories : main.series[0]!.values.map((_, i) => String(i + 1))
  const count = Math.max(1, ...groups.flatMap((g) => g.series.map((s) => Math.max(s.values.length, s.categories.length))))

  // The value range, with stacking.
  let lo = Infinity
  let hi = -Infinity
  for (const g of groups) {
    if (g.kind === 'scatter') {
      for (const s of g.series) for (const v of s.values) if (v !== null) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)))
      continue
    }
    if (g.grouping === 'percentStacked') {
      lo = Math.min(lo, 0)
      hi = Math.max(hi, 1)
      continue
    }
    if (g.grouping === 'stacked') {
      for (let i = 0; i < count; i++) {
        let pos = 0
        let neg = 0
        for (const s of g.series) {
          const v = s.values[i] ?? 0
          if (v >= 0) pos += v
          else neg += v
        }
        lo = Math.min(lo, neg)
        hi = Math.max(hi, pos)
      }
      continue
    }
    for (const s of g.series) for (const v of s.values) if (v !== null) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)))
  }
  if (!Number.isFinite(lo)) ((lo = 0), (hi = 1))
  const scaling = kid(valAx, 'c:scaling')
  const scale = niceScale(lo, hi, num(kid(scaling, 'c:min'), 'val'), num(kid(scaling, 'c:max'), 'val'), num(kid(valAx, 'c:majorUnit'), 'val'))
  const percentAxis = groups.some((g) => g.grouping === 'percentStacked')
  const valFormat = attr(kid(valAx, 'c:numFmt'), 'formatCode') ?? (percentAxis ? '0%' : main.series[0]!.format)
  const valText = textOf(kid(valAx, 'c:txPr'), ctx, base)
  const catText = textOf(kid(catAx, 'c:txPr'), ctx, base)
  const valDeleted = attr(kid(valAx, 'c:delete'), 'val') === '1'
  const catDeleted = attr(kid(catAx, 'c:delete'), 'val') === '1'
  const ticks: number[] = []
  for (let v = scale.min; v <= scale.max + scale.step / 1e6; v += scale.step) ticks.push(Math.round(v / scale.step) * scale.step)

  // The plot area: the chart's own layout when it gives one, else room left for the labels.
  const valLabelWidth = valDeleted ? 0 : Math.max(...ticks.map((t) => formatNumber(t, valFormat).length)) * valText.size * 0.55 + 6
  const catLabelHeight = catDeleted ? 0 : catText.size * 1.6
  let px = left + (horizontal ? Math.max(...categories.map((c) => c.length)) * catText.size * 0.5 + 6 : valLabelWidth)
  let py = top + 4
  let pw = right - px - 4
  let ph = bottom - py - (horizontal ? valText.size * 1.6 : catLabelHeight)
  const manual = kid(plot, 'c:layout', 'c:manualLayout')
  if (manual && num(kid(manual, 'c:w'), 'val') !== undefined) {
    const inner = attr(kid(manual, 'c:layoutTarget'), 'val') === 'inner'
    const mx = (num(kid(manual, 'c:x'), 'val') ?? 0) * w
    const my = (num(kid(manual, 'c:y'), 'val') ?? 0) * h
    const mw = (num(kid(manual, 'c:w'), 'val') ?? 1) * w
    const mh = (num(kid(manual, 'c:h'), 'val') ?? 1) * h
    if (inner) [px, py, pw, ph] = [mx, my, mw, mh]
    else [px, py, pw, ph] = [mx + valLabelWidth, my, mw - valLabelWidth, mh - catLabelHeight]
  }
  pw = Math.max(10, pw)
  ph = Math.max(10, ph)
  const valueAt = (v: number): number => (horizontal ? px + ((v - scale.min) / (scale.max - scale.min)) * pw : py + ph - ((v - scale.min) / (scale.max - scale.min)) * ph)
  const band = (horizontal ? ph : pw) / count
  const catCenter = (i: number): number => (horizontal ? py + band * (i + 0.5) : px + band * (i + 0.5))

  // Gridlines and value labels.
  const grid = kid(valAx, 'c:majorGridlines')
  const gridColor = fillOf(kid(grid, 'c:spPr'), ctx).line ?? { r: 217, g: 217, b: 217, a: 1 }
  for (const t of ticks) {
    const at = valueAt(t)
    if (grid) out.push(horizontal ? `<line x1="${fmt(at)}" y1="${fmt(py)}" x2="${fmt(at)}" y2="${fmt(py + ph)}" stroke="${css(gridColor)}" stroke-width="0.75"/>` : `<line x1="${fmt(px)}" y1="${fmt(at)}" x2="${fmt(px + pw)}" y2="${fmt(at)}" stroke="${css(gridColor)}" stroke-width="0.75"/>`)
    if (!valDeleted) out.push(horizontal ? svgText(at, py + ph + valText.size, formatNumber(t, valFormat), valText, family) : svgText(px - 4, at, formatNumber(t, valFormat), valText, family, 'end'))
  }
  // The category axis line and labels.
  const catLine = fillOf(kid(catAx, 'c:spPr'), ctx)
  if (!catDeleted || catLine.line) {
    const zero = valueAt(Math.max(scale.min, Math.min(scale.max, 0)))
    if (!catLine.noLine) out.push(horizontal ? `<line x1="${fmt(zero)}" y1="${fmt(py)}" x2="${fmt(zero)}" y2="${fmt(py + ph)}" stroke="${css(catLine.line ?? { r: 191, g: 191, b: 191, a: 1 })}" stroke-width="0.75"/>` : `<line x1="${fmt(px)}" y1="${fmt(zero)}" x2="${fmt(px + pw)}" y2="${fmt(zero)}" stroke="${css(catLine.line ?? { r: 191, g: 191, b: 191, a: 1 })}" stroke-width="0.75"/>`)
  }
  if (!catDeleted && main.kind !== 'scatter') {
    const every = Math.max(1, Math.ceil((categories.length * catText.size * 3) / Math.max(1, horizontal ? ph * 3 : pw)))
    categories.forEach((c, i) => {
      if (i % every) return
      out.push(horizontal ? svgText(px - 4, catCenter(i), c, catText, family, 'end') : svgText(catCenter(i), py + ph + catText.size * 0.9, c, catText, family))
    })
  }

  // The series.
  const label = (x: number, y: number, v: number, s: Series, lb: Labels, cat: string, inside: boolean): void => {
    const parts = [lb.series ? s.name : '', lb.category ? cat : '', lb.value ? formatNumber(v, s.format) : ''].filter(Boolean)
    out.push(svgText(x, y, parts.join(', '), { size: lb.size, color: lb.color ?? (inside ? { r: 255, g: 255, b: 255, a: 1 } : base.color), bold: lb.bold }, family))
  }
  for (const g of groups) {
    if (g.kind === 'bar') {
      const n = g.series.length
      const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked'
      const slots = stacked ? 1 : n - (n - 1) * Math.max(0, g.overlap)
      const unit = band / (slots + g.gap)
      const pos = new Array<number>(count).fill(0)
      const neg = new Array<number>(count).fill(0)
      const totals = Array.from({ length: count }, (_, i) => g.series.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0) || 1)
      g.series.forEach((s, si) => {
        s.values.forEach((raw, i) => {
          if (raw === null) return
          const v = g.grouping === 'percentStacked' ? raw / totals[i]! : raw
          const from = stacked ? (v >= 0 ? pos[i]! : neg[i]!) : 0
          const to = from + v
          if (stacked) v >= 0 ? (pos[i] = to) : (neg[i] = to)
          const offset = stacked ? 0 : si * unit * (1 - Math.max(0, g.overlap))
          const start = catCenter(i) - band / 2 + (unit * g.gap) / 2 + offset
          const a = valueAt(Math.max(scale.min, Math.min(scale.max, from)))
          const b = valueAt(Math.max(scale.min, Math.min(scale.max, to)))
          const fillC = s.points.get(i) ?? (g.vary ? paletteColor(i, ctx) : s.fill)
          const stroke = s.line && !s.noLine ? ` stroke="${css(s.line)}" stroke-width="${fmt(s.lineWidth ?? 0.75)}"` : ''
          const rect = horizontal ? { x: Math.min(a, b), y: start, w: Math.abs(b - a), h: unit } : { x: start, y: Math.min(a, b), w: unit, h: Math.abs(b - a) }
          out.push(`<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.w)}" height="${fmt(rect.h)}" fill="${css(fillC)}"${stroke}/>`)
          const lb = s.pointLabels.has(i) ? s.pointLabels.get(i)! : s.labels
          if (lb) {
            const inside = lb.position === 'inEnd' || lb.position === 'ctr' || lb.position === 'inBase' || stacked
            const cx = rect.x + rect.w / 2
            const cy = rect.y + rect.h / 2
            if (horizontal) label(lb.position === 'outEnd' || !inside ? rect.x + rect.w + lb.size * 1.2 : lb.position === 'ctr' || stacked ? cx : rect.x + rect.w - lb.size * 1.2, cy, raw, s, lb, categories[i] ?? '', inside)
            else label(cx, lb.position === 'outEnd' || !inside ? rect.y - lb.size * 0.8 : lb.position === 'ctr' || stacked ? cy : rect.y + lb.size * 0.9, raw, s, lb, categories[i] ?? '', inside)
          }
        })
      })
      continue
    }
    if (g.kind === 'line' || g.kind === 'area' || g.kind === 'scatter') {
      const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked'
      const acc = new Array<number>(count).fill(0)
      const totals = Array.from({ length: count }, (_, i) => g.series.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0) || 1)
      // Scatter x values on their own scale.
      const xs = g.kind === 'scatter' ? g.series.flatMap((s) => (s.xValues ?? []).filter((v): v is number => v !== null)) : []
      const xScale = xs.length ? niceScale(Math.min(...xs), Math.max(...xs)) : null
      g.series.forEach((s) => {
        const pts: Array<[number, number, number, number]> = []
        s.values.forEach((raw, i) => {
          if (raw === null) return
          let v = g.grouping === 'percentStacked' ? raw / totals[i]! : raw
          if (stacked) v = acc[i] = acc[i]! + v
          const x = xScale && s.xValues?.[i] != null ? px + ((s.xValues[i]! - xScale.min) / (xScale.max - xScale.min)) * pw : catCenter(i)
          pts.push([x, valueAt(v), raw, i])
        })
        if (!pts.length) return
        const d = pts.map(([x, y], j) => `${j ? 'L' : 'M'}${fmt(x)},${fmt(y)}`).join(' ')
        if (g.kind === 'area') {
          const zero = valueAt(Math.max(scale.min, 0))
          out.push(`<path d="${d} L${fmt(pts[pts.length - 1]![0])},${fmt(zero)} L${fmt(pts[0]![0])},${fmt(zero)} Z" fill="${css(s.fill ?? paletteColor(0, ctx))}" fill-opacity="${s.fill && s.fill.a < 1 ? 1 : 0.85}"/>`)
        } else if (!s.noLine) {
          out.push(`<path d="${d}" fill="none" stroke="${css(s.line ?? s.fill)}" stroke-width="${fmt(s.lineWidth ?? 2.25)}" stroke-linejoin="round" stroke-linecap="round"/>`)
        }
        if (s.marker && s.marker !== 'none') {
          for (const [x, y] of pts) out.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="3" fill="${css(s.fill ?? s.line)}" stroke="${css(s.line ?? s.fill)}" stroke-width="0.75"/>`)
        }
        if (s.labels) for (const [x, y, raw, i] of pts) label(x, s.labels.position === 'b' ? y + s.labels.size : s.labels.position === 'ctr' ? y : y - s.labels.size, raw, s, s.labels, categories[i] ?? '', false)
      })
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}pt" height="${fmt(h)}pt" viewBox="0 0 ${fmt(w)} ${fmt(h)}" overflow="visible">${out.join('')}</svg>`
}

import { attr, fmt, kid, kids, type El } from './ooxml'

/**
 * Shapes' outlines as SVG paths (§63), in the shape's own box measured in points. PowerPoint's
 * preset shapes are drawn from their definitions (adjust values included) for the common ones;
 * custom geometry is evaluated from its guides and path list. A preset not drawn here becomes its
 * box, and is reported.
 */

export interface ShapePath {
  d: string
  fill: boolean
  stroke: boolean
}

export interface Geometry {
  paths: ShapePath[]
  /** The preset's name when it is not drawn here (its box is drawn instead). */
  unknown?: string
}

/* --- guide formulas (ECMA-376 §20.1.9) ---------------------------------------------------- */

const DEG = 60000
const rad = (a: number): number => (a / DEG) * (Math.PI / 180)

/** The built-in variables of a shape w × h (EMU). */
function builtins(w: number, h: number): Map<string, number> {
  const ss = Math.min(w, h)
  const ls = Math.max(w, h)
  const v = new Map<string, number>([
    ['w', w], ['h', h], ['l', 0], ['t', 0], ['r', w], ['b', h], ['hc', w / 2], ['vc', h / 2], ['ss', ss], ['ls', ls],
    ['cd2', 10800000], ['cd4', 5400000], ['cd8', 2700000], ['3cd4', 16200000], ['3cd8', 8100000], ['5cd8', 13500000], ['7cd8', 18900000]
  ])
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    v.set(`wd${d}`, w / d)
    v.set(`hd${d}`, h / d)
    v.set(`ssd${d}`, ss / d)
  }
  v.set('wd3', w / 3)
  v.set('hd3', h / 3)
  return v
}

function evaluate(fmla: string, vars: Map<string, number>): number {
  const [op, ...args] = fmla.trim().split(/\s+/)
  const a = args.map((x) => (vars.has(x) ? vars.get(x)! : Number(x) || 0))
  const [x = 0, y = 0, z = 0] = a
  switch (op) {
    case 'val':
      return x
    case '*/':
      return z === 0 ? 0 : (x * y) / z
    case '+-':
      return x + y - z
    case '+/':
      return z === 0 ? 0 : (x + y) / z
    case '?:':
      return x > 0 ? y : z
    case 'abs':
      return Math.abs(x)
    case 'at2':
      return (Math.atan2(y, x) * 180 * DEG) / Math.PI
    case 'cat2':
      return x * Math.cos(Math.atan2(z, y))
    case 'sat2':
      return x * Math.sin(Math.atan2(z, y))
    case 'cos':
      return x * Math.cos(rad(y))
    case 'sin':
      return x * Math.sin(rad(y))
    case 'tan':
      return x * Math.tan(rad(y))
    case 'max':
      return Math.max(x, y)
    case 'min':
      return Math.min(x, y)
    case 'mod':
      return Math.sqrt(x * x + y * y + z * z)
    case 'pin':
      return y < x ? x : y > z ? z : y
    case 'sqrt':
      return Math.sqrt(Math.max(0, x))
    default:
      return 0
  }
}

/** Guides (avLst then gdLst) evaluated over the built-ins, in order. */
function guides(vars: Map<string, number>, ...lists: Array<El | null>): void {
  for (const list of lists) for (const gd of kids(list, 'a:gd')) vars.set(attr(gd, 'name') ?? '', evaluate(attr(gd, 'fmla') ?? 'val 0', vars))
}

/**
 * An arc from the current point, as DrawingML defines it: on the ellipse wR × hR, from angle
 * `st` sweeping `sw` (60000ths of a degree). Angles are visual (as drawn), turned into the
 * ellipse's parameter.
 */
function arcTo(cur: [number, number], wR: number, hR: number, st: number, sw: number, k: [number, number]): { d: string; end: [number, number] } {
  const param = (a: number): number => Math.atan2(wR * Math.sin(rad(a)), hR * Math.cos(rad(a)))
  const t0 = param(st)
  const t1 = param(st + sw)
  const cx = cur[0] - wR * Math.cos(t0)
  const cy = cur[1] - hR * Math.sin(t0)
  const end: [number, number] = [cx + wR * Math.cos(t1), cy + hR * Math.sin(t1)]
  if (wR === 0 || hR === 0) return { d: `L${fmt(end[0] * k[0])},${fmt(end[1] * k[1])}`, end }
  const large = Math.abs(sw) > 180 * DEG ? 1 : 0
  const sweep = sw > 0 ? 1 : 0
  // A full turn is two half arcs (SVG cannot draw an arc back to its start).
  if (Math.abs(sw) >= 360 * DEG - 1) {
    const mid: [number, number] = [cx + wR * Math.cos(t0 + Math.PI), cy + hR * Math.sin(t0 + Math.PI)]
    return {
      d: `A${fmt(wR * k[0])},${fmt(hR * k[1])} 0 0 ${sweep} ${fmt(mid[0] * k[0])},${fmt(mid[1] * k[1])} A${fmt(wR * k[0])},${fmt(hR * k[1])} 0 0 ${sweep} ${fmt(end[0] * k[0])},${fmt(end[1] * k[1])}`,
      end
    }
  }
  return { d: `A${fmt(wR * k[0])},${fmt(hR * k[1])} 0 ${large} ${sweep} ${fmt(end[0] * k[0])},${fmt(end[1] * k[1])}`, end }
}

/** A custom geometry (a:custGeom) in a box of w × h points. */
export function customGeometry(geom: El, w: number, h: number): Geometry {
  const W = w * 12700
  const H = h * 12700
  const vars = builtins(W, H)
  guides(vars, kid(geom, 'a:avLst'), kid(geom, 'a:gdLst'))
  const value = (s: string | null): number => (s === null ? 0 : vars.has(s) ? vars.get(s)! : Number(s) || 0)
  const paths: ShapePath[] = []
  for (const path of kids(kid(geom, 'a:pathLst'), 'a:path')) {
    const pw = Number(attr(path, 'w') ?? 0) || W
    const ph = Number(attr(path, 'h') ?? 0) || H
    const k: [number, number] = [w / pw, h / ph]
    let cur: [number, number] = [0, 0]
    let start: [number, number] = [0, 0]
    const parts: string[] = []
    const p = (el: El | null): [number, number] => [value(attr(el, 'x')), value(attr(el, 'y'))]
    const at = (q: [number, number]): string => `${fmt(q[0] * k[0])},${fmt(q[1] * k[1])}`
    for (const c of kids(path)) {
      const pts = kids(c, 'a:pt').map(p)
      switch (c.localName) {
        case 'moveTo':
          cur = start = pts[0] ?? [0, 0]
          parts.push(`M${at(cur)}`)
          break
        case 'lnTo':
          cur = pts[0] ?? cur
          parts.push(`L${at(cur)}`)
          break
        case 'cubicBezTo':
          if (pts.length >= 3) {
            parts.push(`C${at(pts[0]!)} ${at(pts[1]!)} ${at(pts[2]!)}`)
            cur = pts[2]!
          }
          break
        case 'quadBezTo':
          if (pts.length >= 2) {
            parts.push(`Q${at(pts[0]!)} ${at(pts[1]!)}`)
            cur = pts[1]!
          }
          break
        case 'arcTo': {
          // The arc's radii and angles are in path units like everything else.
          const r = arcTo(cur, value(attr(c, 'wR')), value(attr(c, 'hR')), value(attr(c, 'stAng')), value(attr(c, 'swAng')), k)
          parts.push(r.d)
          cur = r.end
          break
        }
        case 'close':
          parts.push('Z')
          cur = start
          break
      }
    }
    paths.push({ d: parts.join(' '), fill: attr(path, 'fill') !== 'none', stroke: attr(path, 'stroke') !== '0' && attr(path, 'stroke') !== 'false' })
  }
  return { paths }
}

/* --- preset shapes ------------------------------------------------------------------------- */

type Pt = [number, number]
const poly = (points: Pt[], close = true): string => `M${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')}${close ? ' Z' : ''}`
const ellipse = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${fmt(cx - rx)},${fmt(cy)} A${fmt(rx)},${fmt(ry)} 0 1 0 ${fmt(cx + rx)},${fmt(cy)} A${fmt(rx)},${fmt(ry)} 0 1 0 ${fmt(cx - rx)},${fmt(cy)} Z`
const rounded = (w: number, h: number, r: [number, number, number, number]): string => {
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)))
  return `M${fmt(tl!)},0 L${fmt(w - tr!)},0 ${tr ? `A${fmt(tr)},${fmt(tr)} 0 0 1 ${fmt(w)},${fmt(tr)}` : ''} L${fmt(w)},${fmt(h - br!)} ${br ? `A${fmt(br)},${fmt(br)} 0 0 1 ${fmt(w - br)},${fmt(h)}` : ''} L${fmt(bl!)},${fmt(h)} ${bl ? `A${fmt(bl)},${fmt(bl)} 0 0 1 0,${fmt(h - bl)}` : ''} L0,${fmt(tl!)} ${tl ? `A${fmt(tl)},${fmt(tl)} 0 0 1 ${fmt(tl)},0` : ''} Z`
}
const star = (w: number, h: number, points: number, inner: number): string => {
  const out: Pt[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const r = i % 2 ? inner : 1
    out.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)])
  }
  return poly(out)
}
const regular = (w: number, h: number, n: number): string => {
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    out.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)])
  }
  return poly(out)
}

const fill = (d: string): ShapePath => ({ d, fill: true, stroke: true })
const line = (d: string): ShapePath => ({ d, fill: false, stroke: true })

/** A preset shape (a:prstGeom) in a box of w × h points. */
export function presetGeometry(geom: El, w: number, h: number): Geometry {
  const name = attr(geom, 'prst') ?? 'rect'
  const adj = new Map<string, number>()
  for (const gd of kids(kid(geom, 'a:avLst'), 'a:gd')) {
    const m = /^val\s+(-?[\d.]+)/.exec(attr(gd, 'fmla') ?? '')
    if (m) adj.set(attr(gd, 'name') ?? '', Number(m[1]))
  }
  const a = (key: string, fallback: number): number => (adj.get(key) ?? (key === 'adj1' ? adj.get('adj') : undefined) ?? fallback) / 100000
  const ss = Math.min(w, h)
  const hc = w / 2
  const vc = h / 2
  switch (name) {
    case 'rect':
    case 'flowChartProcess':
    case 'textBox':
      return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z`)] }
    case 'roundRect':
    case 'flowChartAlternateProcess': {
      const r = ss * a('adj', 16667)
      return { paths: [fill(rounded(w, h, [r, r, r, r]))] }
    }
    case 'round1Rect': {
      const r = ss * a('adj', 16667)
      return { paths: [fill(rounded(w, h, [0, r, 0, 0]))] }
    }
    case 'round2SameRect': {
      const r1 = ss * a('adj1', 16667)
      const r2 = ss * a('adj2', 0)
      return { paths: [fill(rounded(w, h, [r1, r1, r2, r2]))] }
    }
    case 'round2DiagRect': {
      const r1 = ss * a('adj1', 16667)
      const r2 = ss * a('adj2', 0)
      return { paths: [fill(rounded(w, h, [r1, r2, r1, r2]))] }
    }
    case 'snip1Rect': {
      const x = ss * a('adj', 16667)
      return { paths: [fill(poly([[0, 0], [w - x, 0], [w, x], [w, h], [0, h]]))] }
    }
    case 'snip2SameRect': {
      const x = ss * a('adj1', 16667)
      const y = ss * a('adj2', 0)
      return { paths: [fill(poly([[x, 0], [w - x, 0], [w, x], [w, h - y], [w - y, h], [y, h], [0, h - y], [0, x]]))] }
    }
    case 'ellipse':
    case 'flowChartConnector':
      return { paths: [fill(ellipse(hc, vc, w / 2, h / 2))] }
    case 'line':
    case 'straightConnector1':
      return { paths: [line(`M0,0 L${fmt(w)},${fmt(h)}`)] }
    case 'bentConnector2':
      return { paths: [line(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)}`)] }
    case 'bentConnector3': {
      const x = w * a('adj1', 50000)
      return { paths: [line(`M0,0 L${fmt(x)},0 L${fmt(x)},${fmt(h)} L${fmt(w)},${fmt(h)}`)] }
    }
    case 'bentConnector4': {
      const x = w * a('adj1', 50000)
      const y = h * a('adj2', 50000)
      return { paths: [line(`M0,0 L${fmt(x)},0 L${fmt(x)},${fmt(y)} L${fmt(w)},${fmt(y)} L${fmt(w)},${fmt(h)}`)] }
    }
    case 'curvedConnector2':
      return { paths: [line(`M0,0 C${fmt(w / 2)},0 ${fmt(w)},${fmt(h / 2)} ${fmt(w)},${fmt(h)}`)] }
    case 'curvedConnector3':
    case 'curvedConnector4':
    case 'curvedConnector5': {
      const x = w * a('adj1', 50000)
      return { paths: [line(`M0,0 C${fmt(x)},0 ${fmt(x)},${fmt(h)} ${fmt(w)},${fmt(h)}`)] }
    }
    case 'triangle':
    case 'flowChartExtract':
      return { paths: [fill(poly([[0, h], [w * a('adj', 50000), 0], [w, h]]))] }
    case 'flowChartMerge':
      return { paths: [fill(poly([[0, 0], [w, 0], [hc, h]]))] }
    case 'rtTriangle':
      return { paths: [fill(poly([[0, 0], [0, h], [w, h]]))] }
    case 'diamond':
    case 'flowChartDecision':
      return { paths: [fill(poly([[hc, 0], [w, vc], [hc, h], [0, vc]]))] }
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const x = name === 'parallelogram' ? ss * a('adj', 25000) : w / 5
      return { paths: [fill(poly([[x, 0], [w, 0], [w - x, h], [0, h]]))] }
    }
    case 'trapezoid': {
      const x = ss * a('adj', 25000)
      return { paths: [fill(poly([[0, h], [x, 0], [w - x, 0], [w, h]]))] }
    }
    case 'flowChartManualOperation':
      return { paths: [fill(poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]))] }
    case 'pentagon':
      return { paths: [fill(regular(w, h, 5))] }
    case 'hexagon': {
      const x = ss * a('adj', 25000)
      return { paths: [fill(poly([[0, vc], [x, 0], [w - x, 0], [w, vc], [w - x, h], [x, h]]))] }
    }
    case 'heptagon':
      return { paths: [fill(regular(w, h, 7))] }
    case 'octagon': {
      const x = ss * a('adj', 29289)
      return { paths: [fill(poly([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]))] }
    }
    case 'decagon':
      return { paths: [fill(regular(w, h, 10))] }
    case 'dodecagon':
      return { paths: [fill(regular(w, h, 12))] }
    case 'homePlate': {
      const x = w - ss * a('adj', 50000)
      return { paths: [fill(poly([[0, 0], [x, 0], [w, vc], [x, h], [0, h]]))] }
    }
    case 'chevron': {
      const x = ss * a('adj', 50000)
      return { paths: [fill(poly([[0, 0], [w - x, 0], [w, vc], [w - x, h], [0, h], [x, vc]]))] }
    }
    case 'rightArrow':
    case 'leftArrow': {
      const dy = (h * a('adj1', 50000)) / 2
      const head = ss * a('adj2', 50000)
      const pts: Pt[] = [[0, vc - dy], [w - head, vc - dy], [w - head, 0], [w, vc], [w - head, h], [w - head, vc + dy], [0, vc + dy]]
      return { paths: [fill(poly(name === 'leftArrow' ? pts.map(([x, y]) => [w - x, y]) : pts))] }
    }
    case 'upArrow':
    case 'downArrow': {
      const dx = (w * a('adj1', 50000)) / 2
      const head = ss * a('adj2', 50000)
      const pts: Pt[] = [[hc - dx, h], [hc - dx, head], [0, head], [hc, 0], [w, head], [hc + dx, head], [hc + dx, h]]
      return { paths: [fill(poly(name === 'downArrow' ? pts.map(([x, y]) => [x, h - y]) : pts))] }
    }
    case 'leftRightArrow': {
      const dy = (h * a('adj1', 50000)) / 2
      const head = ss * a('adj2', 50000)
      return { paths: [fill(poly([[0, vc], [head, 0], [head, vc - dy], [w - head, vc - dy], [w - head, 0], [w, vc], [w - head, h], [w - head, vc + dy], [head, vc + dy], [head, h]]))] }
    }
    case 'upDownArrow': {
      const dx = (w * a('adj1', 50000)) / 2
      const head = ss * a('adj2', 50000)
      return { paths: [fill(poly([[hc, 0], [w, head], [hc + dx, head], [hc + dx, h - head], [w, h - head], [hc, h], [0, h - head], [hc - dx, h - head], [hc - dx, head], [0, head]]))] }
    }
    case 'notchedRightArrow': {
      const dy = (h * a('adj1', 50000)) / 2
      const head = ss * a('adj2', 50000)
      const notch = (dy * head) / (h / 2)
      return { paths: [fill(poly([[0, vc - dy], [w - head, vc - dy], [w - head, 0], [w, vc], [w - head, h], [w - head, vc + dy], [0, vc + dy], [notch, vc]]))] }
    }
    case 'star4':
      return { paths: [fill(star(w, h, 4, a('adj', 12500) * 2))] }
    case 'star5':
      return { paths: [fill(star(w, h, 5, a('adj', 19098) * 2))] }
    case 'star6':
      return { paths: [fill(star(w, h, 6, a('adj', 28868) * 2))] }
    case 'star7':
    case 'star8':
    case 'star10':
    case 'star12':
    case 'star16':
    case 'star24':
    case 'star32': {
      const n = Number(name.slice(4))
      return { paths: [fill(star(w, h, n, a('adj', 37500) * 2))] }
    }
    case 'plus':
    case 'mathPlus': {
      const x = name === 'plus' ? ss * a('adj', 25000) : w * 0.38
      const y = name === 'plus' ? x : h * 0.38
      return { paths: [fill(poly([[x, 0], [w - x, 0], [w - x, y], [w, y], [w, h - y], [w - x, h - y], [w - x, h], [x, h], [x, h - y], [0, h - y], [0, y], [x, y]]))] }
    }
    case 'mathMinus':
      return { paths: [fill(poly([[w * 0.07, h * 0.38], [w * 0.93, h * 0.38], [w * 0.93, h * 0.62], [w * 0.07, h * 0.62]]))] }
    case 'mathEqual':
      return { paths: [fill(`${poly([[w * 0.07, h * 0.24], [w * 0.93, h * 0.24], [w * 0.93, h * 0.44], [w * 0.07, h * 0.44]])} ${poly([[w * 0.07, h * 0.56], [w * 0.93, h * 0.56], [w * 0.93, h * 0.76], [w * 0.07, h * 0.76]])}`)] }
    case 'mathMultiply': {
      const t = ss * 0.12
      return { paths: [fill(poly([[t, 0], [hc, vc - t], [w - t, 0], [w, t], [hc + t, vc], [w, h - t], [w - t, h], [hc, vc + t], [t, h], [0, h - t], [hc - t, vc], [0, t]]))] }
    }
    case 'donut': {
      const t = ss * a('adj', 25000)
      return { paths: [{ d: `${ellipse(hc, vc, w / 2, h / 2)} ${ellipse(hc, vc, w / 2 - t, h / 2 - t)}`, fill: true, stroke: true }] }
    }
    case 'frame': {
      const t = ss * a('adj1', 12500)
      return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z M${fmt(t)},${fmt(t)} L${fmt(t)},${fmt(h - t)} L${fmt(w - t)},${fmt(h - t)} L${fmt(w - t)},${fmt(t)} Z`)] }
    }
    case 'flowChartTerminator': {
      const r = Math.min(h / 2, w / 2)
      return { paths: [fill(rounded(w, h, [r, r, r, r]))] }
    }
    case 'flowChartPredefinedProcess':
      return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z`), line(`M${fmt(w / 8)},0 L${fmt(w / 8)},${fmt(h)} M${fmt((7 * w) / 8)},0 L${fmt((7 * w) / 8)},${fmt(h)}`)] }
    case 'flowChartDocument':
      return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h * 0.83)} C${fmt(w * 0.68)},${fmt(h * 0.68)} ${fmt(w * 0.5)},${fmt(h * 1.12)} 0,${fmt(h * 0.94)} Z`)] }
    case 'flowChartManualInput':
      return { paths: [fill(poly([[0, h * 0.2], [w, 0], [w, h], [0, h]]))] }
    case 'can': {
      const ry = ss * a('adj', 25000) * 0.5
      return {
        paths: [
          fill(`M0,${fmt(ry)} A${fmt(w / 2)},${fmt(ry)} 0 0 0 ${fmt(w)},${fmt(ry)} L${fmt(w)},${fmt(h - ry)} A${fmt(w / 2)},${fmt(ry)} 0 0 1 0,${fmt(h - ry)} Z`),
          { d: ellipse(hc, ry, w / 2, ry), fill: true, stroke: true }
        ]
      }
    }
    case 'pie':
    case 'arc':
    case 'chord':
    case 'blockArc': {
      const st = (adj.get('adj1') ?? (name === 'pie' ? 0 : 16200000)) / DEG
      const en = (adj.get('adj2') ?? (name === 'pie' ? 16200000 : 0)) / DEG
      const sweep = (((en - st) % 360) + 360) % 360 || 360
      const pt = (deg: number, rx: number, ry: number): Pt => {
        const t = Math.atan2(rx * Math.sin((deg * Math.PI) / 180), ry * Math.cos((deg * Math.PI) / 180))
        return [hc + rx * Math.cos(t), vc + ry * Math.sin(t)]
      }
      const p0 = pt(st, w / 2, h / 2)
      const p1 = pt(st + sweep, w / 2, h / 2)
      const large = sweep > 180 ? 1 : 0
      const arc = `M${fmt(p0[0])},${fmt(p0[1])} A${fmt(w / 2)},${fmt(h / 2)} 0 ${large} 1 ${fmt(p1[0])},${fmt(p1[1])}`
      if (name === 'arc') return { paths: [line(arc)] }
      if (name === 'chord') return { paths: [fill(`${arc} Z`)] }
      if (name === 'pie') return { paths: [fill(`M${fmt(hc)},${fmt(vc)} L${fmt(p0[0])},${fmt(p0[1])} ${arc.slice(arc.indexOf('A'))} Z`)] }
      const t = ss * a('adj3', 25000)
      const q0 = pt(st + sweep, w / 2 - t, h / 2 - t)
      const q1 = pt(st, w / 2 - t, h / 2 - t)
      return { paths: [fill(`${arc} L${fmt(q0[0])},${fmt(q0[1])} A${fmt(w / 2 - t)},${fmt(h / 2 - t)} 0 ${large} 0 ${fmt(q1[0])},${fmt(q1[1])} Z`)] }
    }
    case 'heart':
      return { paths: [fill(`M${fmt(hc)},${fmt(h * 0.25)} C${fmt(hc)},${fmt(-h * 0.08)} ${fmt(-w * 0.2)},${fmt(h * 0.1)} ${fmt(hc)},${fmt(h)} C${fmt(w * 1.2)},${fmt(h * 0.1)} ${fmt(hc)},${fmt(-h * 0.08)} ${fmt(hc)},${fmt(h * 0.25)} Z`)] }
    case 'leftBracket':
      return { paths: [line(`M${fmt(w)},0 Q0,0 0,${fmt(ss * 0.1)} L0,${fmt(h - ss * 0.1)} Q0,${fmt(h)} ${fmt(w)},${fmt(h)}`)] }
    case 'rightBracket':
      return { paths: [line(`M0,0 Q${fmt(w)},0 ${fmt(w)},${fmt(ss * 0.1)} L${fmt(w)},${fmt(h - ss * 0.1)} Q${fmt(w)},${fmt(h)} 0,${fmt(h)}`)] }
    case 'bracketPair': {
      const r = ss * a('adj', 16667)
      return { paths: [line(`M${fmt(r)},${fmt(h)} A${fmt(r)},${fmt(r)} 0 0 1 0,${fmt(h - r)} L0,${fmt(r)} A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(r)},0 M${fmt(w - r)},0 A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(w)},${fmt(r)} L${fmt(w)},${fmt(h - r)} A${fmt(r)},${fmt(r)} 0 0 1 ${fmt(w - r)},${fmt(h)}`)] }
    }
    case 'wedgeRectCallout':
    case 'wedgeRoundRectCallout':
    case 'wedgeEllipseCallout': {
      const tx = hc + w * a('adj1', -20833)
      const ty = vc + h * a('adj2', 62500)
      // The tail: from the middle of the side nearest the point.
      const below = ty > h
      const above = ty < 0
      const side = below ? h : above ? 0 : null
      const tail = side !== null ? poly([[hc - w * 0.08, side], [tx, ty], [hc + w * 0.08, side]], false) : poly([[tx < 0 ? 0 : w, vc - h * 0.1], [tx, ty], [tx < 0 ? 0 : w, vc + h * 0.1]], false)
      const body = name === 'wedgeEllipseCallout' ? ellipse(hc, vc, w / 2, h / 2) : name === 'wedgeRoundRectCallout' ? rounded(w, h, [ss / 6, ss / 6, ss / 6, ss / 6]) : `M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z`
      return { paths: [fill(`${body} ${tail} Z`)] }
    }
    case 'cloud':
    case 'cloudCallout':
    case 'flowChartOnlineStorage':
    case 'flowChartMagneticDisk':
    case 'smileyFace':
    case 'noSmoking':
    case 'sun':
    case 'moon':
    case 'teardrop':
      return { paths: [fill(ellipse(hc, vc, w / 2, h / 2))], unknown: name }
    default:
      return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z`)], unknown: name }
  }
}

/** The outline of a shape: its preset or custom geometry, or its box when it has neither. */
export function geometryOf(spPr: El | null, w: number, h: number): Geometry {
  const custom = kid(spPr, 'a:custGeom')
  if (custom) return customGeometry(custom, w, h)
  const preset = kid(spPr, 'a:prstGeom')
  if (preset) return presetGeometry(preset, w, h)
  return { paths: [fill(`M0,0 L${fmt(w)},0 L${fmt(w)},${fmt(h)} L0,${fmt(h)} Z`)] }
}

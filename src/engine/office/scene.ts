import type { Drawing, OtherPaint, PageDrawings, RGB } from './drawings'
import type { Box } from './model'

/**
 * What a page's drawings become in an Office file that keeps the look (decisions §118):
 *
 * - **Tables**: rules that cross into a grid with text in its cells — a real table, its rules as
 *   cell borders (width and colour), the fills of its cells as cell shading (pdf2docx's lattice
 *   tables, research §10).
 * - **Shapes**: every other plain drawing — rectangles, lines, simple outlines (a rounded box, a
 *   stamp's border) — as an Office shape with its fill and line.
 * - **Art**: drawings Office cannot redraw alike or that are many small parts of one thing (a logo,
 *   a chart, a cover's decoration, a gradient, anything masked) — grouped where they touch, each
 *   group one picture of just those drawings (SVG when it is plain vectors).
 * - **Images**: the page's pictures, each on its own.
 *
 * The solid / Polotno way: vectors stay vectors, only what Office cannot draw becomes a picture,
 * and never the whole page as one picture.
 */

export interface Rule {
  width: number
  colour: RGB
}

export interface StyledGrid {
  box: Box
  xs: number[]
  ys: number[]
  /** `h[i][c]`: the rule along ys[i] over column c. */
  h: Array<Array<Rule | null>>
  /** `v[r][i]`: the rule along xs[i] beside row r. */
  v: Array<Array<Rule | null>>
  /** `shading[r][c]`: the cell's fill. */
  shading: Array<Array<RGB | null>>
}

export interface ArtRegion {
  box: Box
  /** The drawing operations it shows (with the masks they need). */
  calls: number[]
  /** Paint order: its first operation. */
  order: number
  /** Plain vectors (no picture, gradient, pattern or mask): can be an SVG. */
  vector: boolean
}

export interface PlacedImage {
  box: Box
  calls: number[]
  order: number
  pixels: number
}

export interface Scene {
  grids: StyledGrid[]
  shapes: Drawing[]
  art: ArtRegion[]
  images: PlacedImage[]
}

const area = (b: Box): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const near = (a: Box, b: Box, d: number): boolean => a[0] - d <= b[2] && b[0] - d <= a[2] && a[1] - d <= b[3] && b[1] - d <= a[3]
const within = (inner: Box, outer: Box, slack = 1): boolean => inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack
const union = (bs: Box[]): Box => [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]

/** Over white: what a part-transparent fill looks like on paper. */
const onWhite = (c: RGB, alpha: number): RGB => [c[0] * alpha + 1 - alpha, c[1] * alpha + 1 - alpha, c[2] * alpha + 1 - alpha]

/** Values within `tolerance` of each other, as one (their mean), sorted. */
function cluster(values: number[], tolerance = 2): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[][] = []
  for (const v of sorted) {
    const last = out[out.length - 1]
    if (last && v - last[last.length - 1]! <= tolerance) last.push(v)
    else out.push([v])
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
}

class Groups {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  root(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!
      i = this.parent[i]!
    }
    return i
  }
  join(a: number, b: number): void {
    this.parent[this.root(a)] = this.root(b)
  }
  sets(): number[][] {
    const m = new Map<number, number[]>()
    this.parent.forEach((_, i) => {
      const r = this.root(i)
      m.set(r, [...(m.get(r) ?? []), i])
    })
    return [...m.values()]
  }
}

interface HSeg {
  y: number
  x0: number
  x1: number
  rule: Rule
  from: Drawing
}
interface VSeg {
  x: number
  y0: number
  y1: number
  rule: Rule
  from: Drawing
}

/** Rules a drawing makes: a thin bar, a straight line, or a box's four sides. */
function segmentsOf(d: Drawing): { h: HSeg[]; v: VSeg[] } {
  const out = { h: [] as HSeg[], v: [] as VSeg[] }
  if (d.complex) return out
  const [x0, y0, x1, y1] = d.box
  const w = x1 - x0
  const h = y1 - y0
  if (d.kind === 'rect' && d.fill && !d.stroke) {
    const colour = onWhite(d.fill.colour, d.fill.alpha)
    if (h <= 2.5 && w >= 4) out.h.push({ y: (y0 + y1) / 2, x0, x1, rule: { width: h, colour }, from: d })
    else if (w <= 2.5 && h >= 4) out.v.push({ x: (x0 + x1) / 2, y0, y1, rule: { width: w, colour }, from: d })
  } else if (d.kind === 'rect' && d.stroke && w >= 4 && h >= 4) {
    const rule = { width: d.stroke.width, colour: onWhite(d.stroke.paint.colour, d.stroke.paint.alpha) }
    // The outline itself, not the box widened by the line.
    const [a, b, c, e] = [x0 + d.stroke.width / 2, y0 + d.stroke.width / 2, x1 - d.stroke.width / 2, y1 - d.stroke.width / 2]
    out.h.push({ y: b, x0: a, x1: c, rule, from: d }, { y: e, x0: a, x1: c, rule, from: d })
    out.v.push({ x: a, y0: b, y1: e, rule, from: d }, { x: c, y0: b, y1: e, rule, from: d })
  } else if (d.kind === 'line' && d.stroke && !d.stroke.dashes) {
    const [p, q] = d.ops as Array<{ x: number; y: number }>
    if (!p || !q) return out
    const rule = { width: d.stroke.width, colour: onWhite(d.stroke.paint.colour, d.stroke.paint.alpha) }
    if (Math.abs(p.y - q.y) < 0.05 && Math.abs(p.x - q.x) >= 4) out.h.push({ y: p.y, x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), rule, from: d })
    else if (Math.abs(p.x - q.x) < 0.05 && Math.abs(p.y - q.y) >= 4) out.v.push({ x: p.x, y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y), rule, from: d })
  }
  return out
}

/** Ruled tables: rules that cross, with text in at least two cells. Their drawings in `used`. */
function grids(drawings: Drawing[], lines: Box[], used: Set<Drawing>): StyledGrid[] {
  const h: HSeg[] = []
  const v: VSeg[] = []
  for (const d of drawings) {
    const s = segmentsOf(d)
    h.push(...s.h)
    v.push(...s.v)
  }
  if (h.length === 0 || v.length === 0) return []
  const t = 2
  const g = new Groups(h.length + v.length)
  h.forEach((a, i) =>
    v.forEach((b, j) => {
      if (b.x >= a.x0 - t && b.x <= a.x1 + t && a.y >= b.y0 - t && a.y <= b.y1 + t) g.join(i, h.length + j)
    })
  )
  const fills = drawings.filter((d) => d.kind === 'rect' && d.fill && !d.complex && d.box[2] - d.box[0] > 2.5 && d.box[3] - d.box[1] > 2.5)
  const out: StyledGrid[] = []
  for (const set of g.sets()) {
    const hs = set.filter((i) => i < h.length).map((i) => h[i]!)
    const vs = set.filter((i) => i >= h.length).map((i) => v[i - h.length]!)
    if (hs.length === 0 || vs.length === 0) continue
    let ys = cluster(hs.map((s) => s.y))
    let xs = cluster(vs.map((s) => s.x))
    // Rules reaching past the outermost crossing rules: the table's edge has no rule there (pdf2docx adds
    // an invisible border).
    const left = Math.min(...hs.map((s) => s.x0))
    const right = Math.max(...hs.map((s) => s.x1))
    const top = Math.min(...vs.map((s) => s.y0))
    const bottom = Math.max(...vs.map((s) => s.y1))
    if (left < xs[0]! - 3) xs = [left, ...xs]
    if (right > xs[xs.length - 1]! + 3) xs = [...xs, right]
    if (top < ys[0]! - 3) ys = [top, ...ys]
    if (bottom > ys[ys.length - 1]! + 3) ys = [...ys, bottom]
    if (xs.length < 2 || ys.length < 2 || (xs.length < 3 && ys.length < 3)) continue
    const box: Box = [xs[0]!, ys[0]!, xs[xs.length - 1]!, ys[ys.length - 1]!]
    // Text in the cells: a table, not a frame or a chart's grid.
    const rows = ys.length - 1
    const cols = xs.length - 1
    const filled = new Set<string>()
    for (const l of lines) {
      const cx = (l[0] + l[2]) / 2
      const cy = (l[1] + l[3]) / 2
      if (cx < box[0] || cx > box[2] || cy < box[1] || cy > box[3]) continue
      const r = ys.findIndex((y, i) => i < rows && cy >= y && cy <= ys[i + 1]!)
      const c = xs.findIndex((x, i) => i < cols && cx >= x && cx <= xs[i + 1]!)
      filled.add(`${r},${c}`)
    }
    if (filled.size < 2 || (rows * cols >= 20 && filled.size < rows * cols * 0.15)) continue
    const ruleH = (y: number, a: number, b: number): Rule | null => {
      const s = hs.find((s) => Math.abs(s.y - y) <= 1.5 && s.x0 <= a + t && s.x1 >= b - t) ?? hs.find((s) => Math.abs(s.y - y) <= 1.5 && Math.min(s.x1, b) - Math.max(s.x0, a) >= (b - a) * 0.6)
      return s?.rule ?? null
    }
    const ruleV = (x: number, a: number, b: number): Rule | null => {
      const s = vs.find((s) => Math.abs(s.x - x) <= 1.5 && s.y0 <= a + t && s.y1 >= b - t) ?? vs.find((s) => Math.abs(s.x - x) <= 1.5 && Math.min(s.y1, b) - Math.max(s.y0, a) >= (b - a) * 0.6)
      return s?.rule ?? null
    }
    const grid: StyledGrid = {
      box,
      xs,
      ys,
      h: ys.map((y) => xs.slice(0, -1).map((x, c) => ruleH(y, x, xs[c + 1]!))),
      v: ys.slice(0, -1).map((y, r) => xs.map((x) => ruleV(x, y, ys[r + 1]!))),
      shading: ys.slice(0, -1).map(() => xs.slice(0, -1).map(() => null))
    }
    // Cell fills: a fill covering most of a cell shades it; one inside the table is taken by it.
    for (const f of fills) {
      if (!within(f.box, box, 1.5)) continue
      let shaded = 0
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const cell: Box = [xs[c]!, ys[r]!, xs[c + 1]!, ys[r + 1]!]
          const inter: Box = [Math.max(cell[0], f.box[0]), Math.max(cell[1], f.box[1]), Math.min(cell[2], f.box[2]), Math.min(cell[3], f.box[3])]
          if (area(inter) >= area(cell) * 0.8) {
            grid.shading[r]![c] = onWhite(f.fill!.colour, f.fill!.alpha)
            shaded++
          }
        }
      if (shaded > 0) used.add(f)
    }
    for (const s of [...hs, ...vs]) if (within(s.from.box, box, 2.5)) used.add(s.from)
    out.push(grid)
  }
  return out
}

/**
 * The page's drawings sorted into tables, shapes, art and images. `lines` are the boxes of the
 * page's text lines (a ruled grid is a table only with text in it).
 */
export function scene(d: PageDrawings, lines: Box[], width: number, height: number): Scene {
  const page = width * height
  const used = new Set<Drawing>()
  const tables = grids(d.drawings, lines, used)
  const rest = d.drawings.filter((x) => !used.has(x))

  // Heavy parts: anything complex, any outline that is not a rectangle or a line, gradients, patterns, stencils.
  type Item = { box: Box; calls: number[]; order: number; heavy: boolean; drawing?: Drawing; other?: OtherPaint; ops: number }
  const items: Item[] = [
    ...rest.map((x) => ({ box: x.box, calls: [x.call, ...x.needs], order: x.call, heavy: x.complex || x.kind === 'path', drawing: x, ops: x.ops.length })),
    ...d.others.filter((o) => o.kind !== 'image').map((o) => ({ box: o.box, calls: [o.call, ...o.needs], order: o.call, heavy: true, other: o, ops: 50 }))
  ]
  const big = (i: Item): boolean => area(i.box) > page * 0.25
  const heavy = items.filter((i) => i.heavy && !big(i))
  const g = new Groups(heavy.length)
  for (let i = 0; i < heavy.length; i++) for (let j = i + 1; j < heavy.length; j++) if (near(heavy[i]!.box, heavy[j]!.box, 2)) g.join(i, j)
  const regions: Array<{ box: Box; members: Item[] }> = []
  const shapes: Drawing[] = []
  for (const set of g.sets()) {
    const members = set.map((i) => heavy[i]!)
    const complex = members.some((m) => m.other || m.drawing!.complex)
    const ops = members.reduce((n, m) => n + m.ops, 0)
    // Many small parts of one thing (a logo's letters, a chart's marks) are one picture; a few boxes that
    // touch (rounded panels with their borders) stay shapes.
    const box = union(members.map((m) => m.box))
    const parts = members.filter((m) => area(m.box) < area(box) * 0.2).length
    if (complex || ops > 600 || parts >= 4) regions.push({ box, members })
    else shapes.push(...members.map((m) => m.drawing!))
  }
  // A big drawing (a page-wide band, a cover's ground): a shape when Office can draw it, else art of its own.
  for (const i of items.filter((i) => i.heavy && big(i))) {
    if (i.drawing && !i.drawing.complex && i.ops <= 400) shapes.push(i.drawing)
    else regions.push({ box: i.box, members: [i] })
  }
  // Plain rectangles and lines: inside a region they are part of it; very many close together (a chart's
  // bars, a QR code) are art too; the rest are shapes.
  const light = items.filter((i) => !i.heavy)
  const free: Item[] = []
  for (const i of light) {
    const host = regions.find((r) => within(i.box, r.box, 1) && area(i.box) < area(r.box) * 0.9)
    if (host) host.members.push(i)
    else free.push(i)
  }
  const lg = new Groups(free.length)
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) if (!big(free[i]!) && !big(free[j]!) && near(free[i]!.box, free[j]!.box, 1)) lg.join(i, j)
  for (const set of lg.sets()) {
    const members = set.map((i) => free[i]!)
    if (members.length >= 80) regions.push({ box: union(members.map((m) => m.box)), members })
    else shapes.push(...members.map((m) => m.drawing!))
  }
  // Overlapping regions are one picture.
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < regions.length && !merged; i++)
      for (let j = i + 1; j < regions.length && !merged; j++)
        if (near(regions[i]!.box, regions[j]!.box, 0)) {
          regions[i] = { box: union([regions[i]!.box, regions[j]!.box]), members: [...regions[i]!.members, ...regions[j]!.members] }
          regions.splice(j, 1)
          merged = true
        }
  }
  // Pictures: each on its own, unless it is part of a piece of art (a logo with a picture in it).
  const images: PlacedImage[] = []
  for (const o of d.others.filter((o) => o.kind === 'image')) {
    const host = regions.find((r) => within(o.box, r.box, 1) && area(o.box) < area(r.box) * 0.9)
    if (host) host.members.push({ box: o.box, calls: [o.call, ...o.needs], order: o.call, heavy: true, other: o, ops: 0 })
    else images.push({ box: o.box, calls: [o.call, ...o.needs], order: o.call, pixels: o.pixels ?? 0 })
  }
  const art: ArtRegion[] = regions.map((r) => ({
    box: [Math.max(0, r.box[0]), Math.max(0, r.box[1]), Math.min(width, r.box[2]), Math.min(height, r.box[3])],
    calls: [...new Set(r.members.flatMap((m) => m.calls))].sort((a, b) => a - b),
    order: Math.min(...r.members.map((m) => m.order)),
    vector: r.members.every((m) => m.drawing && m.drawing.needs.length === 0)
  }))
  shapes.sort((a, b) => a.call - b.call)
  return { grids: tables, shapes, art: art.filter((a) => area(a.box) > 0.5), images }
}

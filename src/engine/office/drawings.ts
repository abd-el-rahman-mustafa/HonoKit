import { free, mupdf, type PdfDoc } from '../mupdf'
import type { Box } from './model'

/**
 * A page's drawings one by one (decisions §118): every filled or stroked path with its colour,
 * line, clip and paint order, read through a MuPDF device as the page is drawn. The writers that
 * keep the look turn the plain ones (rectangles, rules, lines, simple outlines) into Office shapes
 * and the rest (logos, charts, gradients, anything masked) into pictures of just those drawings —
 * nothing is flattened into one picture of the page any more.
 *
 * Every drawing operation the page performs has a number (`call`) in the order the page paints
 * it; `replay` draws a chosen set of them again (into an SVG or a picture), with the clips,
 * groups and masks around them, and nothing else — no text, no other drawing.
 */

export type RGB = [number, number, number]

export interface Paint {
  colour: RGB
  alpha: number
}

export type PathOp =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' }

export interface Stroke {
  paint: Paint
  width: number
  dashes: number[] | null
  cap: 'flat' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
}

export interface Drawing {
  /** The page's drawing operation (paint order); split parts of one path share it. */
  call: number
  /** Operations that must be drawn with it: the soft masks it is drawn through. */
  needs: number[]
  /** An axis-aligned rectangle, a straight line (two points), or any other outline. */
  kind: 'rect' | 'line' | 'path'
  /** What shows, clip applied (a stroke's width included). */
  box: Box
  fill: Paint | null
  stroke: Stroke | null
  evenOdd: boolean
  /** The outline in page coordinates (a rect's four corners, a line's two ends). */
  ops: PathOp[]
  /** Office cannot draw it alike: cut by an irregular clip, under a soft mask or a blend mode. */
  complex: boolean
}

/** Painted things that are not paths: gradients, patterns, pictures and stencil masks. */
export interface OtherPaint {
  call: number
  needs: number[]
  kind: 'shade' | 'pattern' | 'image' | 'stencil'
  box: Box
  /** A picture's own pixels (how sharp to draw it again). */
  pixels?: number
}

export interface PageDrawings {
  drawings: Drawing[]
  others: OtherPaint[]
}

const HAIR = new mupdf.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 10 })

const intersect = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
const empty = (b: Box): boolean => b[2] - b[0] <= 0.01 || b[3] - b[1] <= 0.01
const within = (inner: Box, outer: Box, slack = 0.5): boolean => inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack

/** A colour in any colour space as the page shows it in RGB (MuPDF's own conversion, ICC included). */
const rgbCache = new Map<string, RGB>()
function rgbOf(cs: mupdf.ColorSpace, colour: number[]): RGB {
  if (cs.isRGB() && colour.length >= 3) return [colour[0]!, colour[1]!, colour[2]!]
  if (cs.isGray() && colour.length >= 1) return [colour[0]!, colour[0]!, colour[0]!]
  const key = `${cs.getName()}|${colour.join(',')}`
  const known = rgbCache.get(key)
  if (known) return known
  let out: RGB = [0, 0, 0]
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1, 1], false)
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
  const path = new mupdf.Path()
  try {
    pixmap.clear(255)
    path.rect(0, 0, 1, 1)
    device.fillPath(path, false, mupdf.Matrix.identity, cs, colour as mupdf.Color, 1)
    device.close()
    const px = pixmap.getPixels()
    out = [px[0]! / 255, px[1]! / 255, px[2]! / 255]
  } catch {
    /* an unusual colour space: black */
  } finally {
    free(path, device, pixmap)
  }
  rgbCache.set(key, out)
  return out
}

const apply = (m: mupdf.Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** The path in page coordinates, cut into subpaths. */
function outline(path: mupdf.Path, ctm: mupdf.Matrix): PathOp[][] {
  const subs: PathOp[][] = []
  let cur: PathOp[] = []
  path.walk({
    moveTo(x, y) {
      if (cur.length) subs.push(cur)
      const [px, py] = apply(ctm, x, y)
      cur = [{ op: 'M', x: px, y: py }]
    },
    lineTo(x, y) {
      const [px, py] = apply(ctm, x, y)
      cur.push({ op: 'L', x: px, y: py })
    },
    curveTo(x1, y1, x2, y2, x, y) {
      const [a, b] = apply(ctm, x1, y1)
      const [c, d] = apply(ctm, x2, y2)
      const [e, f] = apply(ctm, x, y)
      cur.push({ op: 'C', x1: a, y1: b, x2: c, y2: d, x: e, y: f })
    },
    closePath() {
      cur.push({ op: 'Z' })
    }
  })
  if (cur.length) subs.push(cur)
  return subs.filter((s) => s.length > 1 || s[0]?.op !== 'M')
}

const points = (sub: PathOp[]): Array<[number, number]> => sub.flatMap((o) => (o.op === 'Z' ? [] : [[o.x, o.y] as [number, number]]))

/** An axis-aligned rectangle drawn as four (or five, closing) straight points. */
function rectOf(sub: PathOp[]): Box | null {
  if (sub.some((o) => o.op === 'C')) return null
  let pts = points(sub)
  if (pts.length === 5 && Math.abs(pts[0]![0] - pts[4]![0]) < 0.01 && Math.abs(pts[0]![1] - pts[4]![1]) < 0.01) pts = pts.slice(0, 4)
  if (pts.length !== 4) return null
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % 4]!
    if (Math.abs(ax - bx) > 0.05 && Math.abs(ay - by) > 0.05) return null
  }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const boundsOf = (ops: PathOp[]): Box => {
  const xs: number[] = []
  const ys: number[] = []
  for (const o of ops) {
    if (o.op === 'Z') continue
    xs.push(o.x)
    ys.push(o.y)
    if (o.op === 'C') xs.push(o.x1, o.x2), ys.push(o.y1, o.y2)
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const CAP = ['flat', 'round', 'square', 'flat'] as const
const JOIN = ['miter', 'round', 'bevel', 'miter'] as const

interface Clip {
  box: Box
  /** Not a plain rectangle: a curve, text, a stroke or a picture's mask. */
  irregular: boolean
  /** A soft mask: what is drawn under it is drawn through it. */
  mask: number[]
  /** A rectangle with rounded corners (a box with `border-radius`): the corners' size and outline. */
  radius?: number
  ops?: PathOp[]
}

/**
 * A rectangle with rounded (or cut) corners: one closed outline whose straight sides lie on the
 * edges of its box, its curves only at the corners (a browser splits each corner in several). The
 * radius is how far the corners reach along the edges.
 */
function roundedOf(sub: PathOp[]): { box: Box; radius: number } | null {
  if (sub.filter((o) => o.op === 'C').length > 32) return null
  const box = boundsOf(sub)
  const onEdge = (x: number, y: number): boolean => Math.abs(x - box[0]) < 0.5 || Math.abs(x - box[2]) < 0.5 || Math.abs(y - box[1]) < 0.5 || Math.abs(y - box[3]) < 0.5
  // The ends of the straight sides, and where each side starts.
  const sides: Array<[number, number]> = []
  let prev: [number, number] | null = null
  for (const o of sub) {
    if (o.op === 'Z') continue
    if (o.op === 'L') {
      if (prev && !onEdge(prev[0], prev[1])) return null
      if (!onEdge(o.x, o.y)) return null
      if (prev) sides.push(prev)
      sides.push([o.x, o.y])
    }
    prev = [o.x, o.y]
  }
  if (sides.length < 4) return null
  let radius = 0
  for (const [cx, cy] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] as const) {
    radius = Math.max(radius, Math.min(...sides.map(([x, y]) => Math.hypot(x - cx, y - cy))))
  }
  return radius > 0.3 && radius < Math.min(box[2] - box[0], box[3] - box[1]) / 2 ? { box, radius } : null
}

/** Does `b` reach into a rounded clip's corner (where the curve cuts it)? */
function inCorner(b: Box, clip: Box, radius: number): boolean {
  const left = b[0] < clip[0] + radius
  const right = b[2] > clip[2] - radius
  const top = b[1] < clip[1] + radius
  const bottom = b[3] > clip[3] - radius
  return (left || right) && (top || bottom)
}

/**
 * Reads the page's drawings (text is left out: the converter reads it on its own). A white
 * rectangle under the whole page is the paper, not a drawing, and is left out.
 */
export function pageDrawings(doc: PdfDoc, pageIndex: number): PageDrawings {
  const page = doc.loadPage(pageIndex)
  const bounds = page.getBounds() as Box
  const out: PageDrawings = { drawings: [], others: [] }
  const clips: Clip[] = [{ box: bounds, irregular: false, mask: [] }]
  const groups: boolean[] = []
  /** Inside a soft mask's definition: its operations, collected for what it masks. */
  const masks: number[][] = []
  let tiles = 0
  let tileStart: { call: number; box: Box } | null = null
  let call = 0
  const clip = (): Clip & { rounded: Array<{ box: Box; radius: number; ops: PathOp[] }> } => {
    let box = bounds
    let irregular = false
    const mask: number[] = []
    const rounded: Array<{ box: Box; radius: number; ops: PathOp[] }> = []
    for (const c of clips) {
      box = intersect(box, c.box)
      irregular ||= c.irregular
      mask.push(...c.mask)
      if (c.radius && c.ops) rounded.push({ box: c.box, radius: c.radius, ops: c.ops })
    }
    return { box, irregular, mask, rounded }
  }
  const blended = (): boolean => groups.some(Boolean)

  const add = (path: mupdf.Path, ctm: mupdf.Matrix, fill: Paint | null, stroke: Stroke | null, evenOdd: boolean, strokeState: mupdf.StrokeState | null): void => {
    // A pattern's cell is counted as one operation with the pattern (replay counts alike).
    if (tiles > 0) return
    const n = call++
    if (masks.length) {
      masks[masks.length - 1]!.push(n)
      return
    }
    const c = clip()
    const subs = outline(path, ctm)
    if (subs.length === 0) return
    const raw = path.getBounds(strokeState ?? HAIR, ctm) as Box
    const visible = intersect(raw, c.box)
    if (empty(visible) && !(stroke && (visible[2] >= visible[0] || visible[3] >= visible[1]))) return
    // Cut by an irregular clip near the drawing (a rounded box's corner), masked, or blended.
    const cut = (c.irregular && !within(raw, shrink(c.box, 4))) || c.rounded.some((r) => inCorner(raw, r.box, r.radius))
    const complex = cut || c.mask.length > 0 || blended()
    const base = { call: n, needs: c.mask, fill, stroke, evenOdd, complex }
    // Rectangles and lines drawn in one path are drawn one by one, so rules become a table's borders.
    const rects = subs.map(rectOf)
    const nested = rects.length > 1 && rects.every(Boolean) && rects.some((a, i) => rects.some((b, j) => i !== j && within(b!, a!, 0.01)))
    // A fill under a rounded clip it covers (a badge, a box with rounded corners): the rounded box itself.
    const roundedClip = c.rounded.length === 1 && !c.irregular && fill && !stroke && rects.length === 1 && rects[0] ? c.rounded[0]! : null
    if (roundedClip && within(roundedClip.box, rects[0]!, 1) && c.mask.length === 0 && !blended()) {
      out.drawings.push({ ...base, complex: false, kind: 'path', box: roundedClip.box, ops: roundedClip.ops })
      return
    }
    if (rects.every(Boolean) && !nested) {
      for (const r of rects) {
        const box = intersect(r!, c.box)
        // A rule drawn as a stroked rectangle of no height is a line.
        if (stroke && !fill && (r![3] - r![1] < 0.05 || r![2] - r![0] < 0.05)) {
          out.drawings.push({ ...base, kind: 'line', box: widen(box, stroke.width), ops: [{ op: 'M', x: box[0], y: box[1] }, { op: 'L', x: box[2], y: box[3] }] })
          continue
        }
        if (empty(box) && !stroke) continue
        out.drawings.push({ ...base, kind: 'rect', box: stroke ? widen(box, stroke.width) : box, ops: corners(box) })
      }
      return
    }
    // A frame drawn as one rectangle inside another (even-odd or opposite winding): four bars.
    if (nested && rects.length === 2 && fill && !stroke) {
      const [outer, inner] = within(rects[1]!, rects[0]!, 0.01) ? [rects[0]!, rects[1]!] : [rects[1]!, rects[0]!]
      const bars: Box[] = [
        [outer[0], outer[1], outer[2], inner[1]],
        [outer[0], inner[3], outer[2], outer[3]],
        [outer[0], inner[1], inner[0], inner[3]],
        [inner[2], inner[1], outer[2], inner[3]]
      ]
      for (const bar of bars) {
        const box = intersect(bar, c.box)
        if (!empty(box)) out.drawings.push({ ...base, kind: 'rect', box, ops: corners(box) })
      }
      return
    }
    const lines = subs.every((s) => s.length === 2 && s[1]!.op === 'L')
    if (lines && stroke) {
      for (const s of subs) {
        const a = s[0] as { x: number; y: number }
        const b = s[1] as { x: number; y: number }
        const box: Box = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
        const straight = Math.abs(a.x - b.x) < 0.05 || Math.abs(a.y - b.y) < 0.05
        // A straight rule cut by a plain clip is cut here; anything else cut is drawn as a picture.
        if (straight && !c.irregular) {
          const shown = intersect(widen(box, 0.01), c.box)
          if (empty(shown) && Math.min(shown[2] - shown[0], shown[3] - shown[1]) < -0.01) continue
          const horizontal = Math.abs(a.y - b.y) < 0.05
          const ends = horizontal ? [Math.max(box[0], c.box[0]), Math.min(box[2], c.box[2])] : [Math.max(box[1], c.box[1]), Math.min(box[3], c.box[3])]
          if (ends[1]! - ends[0]! <= 0.01) continue
          const ops: PathOp[] = horizontal ? [{ op: 'M', x: ends[0]!, y: a.y }, { op: 'L', x: ends[1]!, y: a.y }] : [{ op: 'M', x: a.x, y: ends[0]! }, { op: 'L', x: a.x, y: ends[1]! }]
          out.drawings.push({ ...base, kind: 'line', box: widen(boundsOf(ops), stroke.width), ops })
        } else {
          const lineBox = widen(box, stroke.width)
          out.drawings.push({ ...base, complex: base.complex || !within(lineBox, c.box), kind: 'line', box: intersect(lineBox, c.box), ops: s })
        }
      }
      return
    }
    out.drawings.push({ ...base, complex: complex || !within(raw, c.box, 0.5), kind: 'path', box: visible, ops: subs.flat() })
  }

  const other = (kind: OtherPaint['kind'], box: Box, pixels?: number): void => {
    if (tiles > 0) return
    const n = call++
    if (masks.length) {
      masks[masks.length - 1]!.push(n)
      return
    }
    const c = clip()
    const shown = intersect(box, c.box)
    if (!empty(shown)) out.others.push({ call: n, needs: c.mask, kind, box: shown, ...(pixels ? { pixels } : {}) })
  }

  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, cs, colour, alpha) {
      add(path, ctm, { colour: rgbOf(cs, colour), alpha }, null, evenOdd, null)
    },
    strokePath(path, st, ctm, cs, colour, alpha) {
      // The line's width as drawn: the stroke state's width scaled by the matrix.
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
      const dashes = st.getDashes()
      const stroke: Stroke = {
        paint: { colour: rgbOf(cs, colour), alpha },
        width: Math.max(0.25, st.getLineWidth() * scale),
        dashes: dashes && dashes.length ? dashes.map((d) => d * scale) : null,
        cap: CAP[st.getLineCap()] ?? 'flat',
        join: JOIN[st.getLineJoin()] ?? 'miter'
      }
      add(path, ctm, null, stroke, false, st)
    },
    fillShade(shade, ctm) {
      other('shade', mupdf.Rect.transform(shade.getBounds(), ctm) as Box)
    },
    fillImage(image, ctm) {
      other('image', mupdf.Rect.transform([0, 0, 1, 1], ctm) as Box, image.getWidth() * image.getHeight())
    },
    fillImageMask(_image, ctm) {
      other('stencil', mupdf.Rect.transform([0, 0, 1, 1], ctm) as Box)
    },
    fillText() {
      if (tiles === 0) call++
    },
    strokeText() {
      if (tiles === 0) call++
    },
    clipPath(path, _evenOdd, ctm) {
      const subs = outline(path, ctm)
      const rect = subs.length === 1 ? rectOf(subs[0]!) : null
      const rounded = !rect && subs.length === 1 ? roundedOf(subs[0]!) : null
      if (rounded) clips.push({ box: rounded.box, irregular: false, mask: [], radius: rounded.radius, ops: subs[0]! })
      else clips.push({ box: rect ?? (path.getBounds(HAIR, ctm) as Box), irregular: !rect, mask: [] })
    },
    clipStrokePath(path, st, ctm) {
      clips.push({ box: path.getBounds(st, ctm) as Box, irregular: true, mask: [] })
    },
    clipText(text, ctm) {
      clips.push({ box: text.getBounds(HAIR, ctm) as Box, irregular: true, mask: [] })
    },
    clipStrokeText(text, st, ctm) {
      clips.push({ box: text.getBounds(st, ctm) as Box, irregular: true, mask: [] })
    },
    clipImageMask(_image, ctm) {
      clips.push({ box: mupdf.Rect.transform([0, 0, 1, 1], ctm) as Box, irregular: true, mask: [] })
    },
    popClip() {
      if (clips.length > 1) clips.pop()
    },
    beginMask() {
      masks.push([])
    },
    endMask() {
      const mask = masks.pop() ?? []
      // What follows, until its popClip, is drawn through the mask.
      clips.push({ box: bounds, irregular: true, mask })
    },
    beginGroup(_bbox, _cs, _isolated, _knockout, blendmode, alpha) {
      groups.push(blendmode !== 'Normal' || alpha < 0.999)
    },
    endGroup() {
      groups.pop()
    },
    beginTile(area, _view, _xstep, _ystep, ctm) {
      // A pattern: its cell is drawn over and over. The whole filled area is one painted thing,
      // one operation (its cell's are not counted).
      if (tiles++ === 0) {
        const n = call++
        if (masks.length) masks[masks.length - 1]!.push(n)
        else tileStart = { call: n, box: mupdf.Rect.transform(area, ctm) as Box }
      }
      return 0
    },
    endTile() {
      if (--tiles === 0 && tileStart) {
        const c = clip()
        const box = intersect(tileStart.box, c.box)
        if (!empty(box)) out.others.push({ call: tileStart.call, needs: c.mask, kind: 'pattern', box })
        tileStart = null
      }
    }
  })
  try {
    page.run(device, mupdf.Matrix.identity)
    device.close()
  } finally {
    free(device, page)
  }
  // The paper: a white rectangle under (nearly) the whole page.
  const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
  out.drawings = out.drawings.filter(
    (d) => !(d.kind === 'rect' && !d.stroke && d.fill && d.fill.colour.every((v) => v > 0.985) && (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]) > area * 0.9)
  )
  return out
}

function shrink(b: Box, by: number): Box {
  return [b[0] + by, b[1] + by, b[2] - by, b[3] - by]
}

function widen(b: Box, width: number): Box {
  const h = width / 2
  return [b[0] - h, b[1] - h, b[2] + h, b[3] + h]
}

function corners(b: Box): PathOp[] {
  return [
    { op: 'M', x: b[0], y: b[1] },
    { op: 'L', x: b[2], y: b[1] },
    { op: 'L', x: b[2], y: b[3] },
    { op: 'L', x: b[0], y: b[3] },
    { op: 'Z' }
  ]
}

/**
 * Draws the chosen operations of a page again into `target` (an SVG writer's page, a picture),
 * moved by `m`: only those, with the clips, groups and masks they are drawn under. No text.
 */
export function replay(doc: PdfDoc, pageIndex: number, calls: Set<number>, target: mupdf.Device, m: mupdf.Matrix): void {
  const page = doc.loadPage(pageIndex)
  let call = 0
  const at = (ctm: mupdf.Matrix): mupdf.Matrix => mupdf.Matrix.concat(ctm, m)
  const rect = (r: mupdf.Rect): mupdf.Rect => mupdf.Rect.transform(r, m)
  // Inside a pattern's cell: everything is drawn when the pattern is (one operation, as read).
  let tileDepth = 0
  let tileKept = false
  // A cell the target already holds (it draws it itself): nothing inside is passed on.
  let mute = 0
  const keep = (): boolean => (tileDepth > 0 ? tileKept && mute === 0 : calls.has(call++))
  const pass = (f: () => void): void => {
    if (mute === 0) f()
  }
  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, cs, colour, alpha) {
      if (keep()) target.fillPath(path, evenOdd, at(ctm), cs, colour as mupdf.Color, alpha)
    },
    strokePath(path, st, ctm, cs, colour, alpha) {
      if (keep()) target.strokePath(path, st, at(ctm), cs, colour as mupdf.Color, alpha)
    },
    fillShade(shade, ctm, alpha) {
      if (keep()) target.fillShade(shade, at(ctm), alpha)
    },
    fillImage(image, ctm, alpha) {
      if (keep()) target.fillImage(image, at(ctm), alpha)
    },
    fillImageMask(image, ctm, cs, colour, alpha) {
      if (keep()) target.fillImageMask(image, at(ctm), cs, colour as mupdf.Color, alpha)
    },
    fillText() {
      if (tileDepth === 0) call++
    },
    strokeText() {
      if (tileDepth === 0) call++
    },
    clipPath(path, evenOdd, ctm) {
      pass(() => target.clipPath(path, evenOdd, at(ctm)))
    },
    clipStrokePath(path, st, ctm) {
      pass(() => target.clipStrokePath(path, st, at(ctm)))
    },
    clipText(text, ctm) {
      pass(() => target.clipText(text, at(ctm)))
    },
    clipStrokeText(text, st, ctm) {
      pass(() => target.clipStrokeText(text, st, at(ctm)))
    },
    clipImageMask(image, ctm) {
      pass(() => target.clipImageMask(image, at(ctm)))
    },
    popClip() {
      pass(() => target.popClip())
    },
    beginMask(area, luminosity, cs, colour) {
      pass(() => target.beginMask(rect(area), luminosity, cs, colour as mupdf.Color))
    },
    endMask() {
      pass(() => target.endMask())
    },
    beginGroup(area, cs, isolated, knockout, blendmode, alpha) {
      pass(() => target.beginGroup(rect(area), cs, isolated, knockout, blendmode, alpha))
    },
    endGroup() {
      pass(() => target.endGroup())
    },
    beginTile(area, view, xstep, ystep, ctm, id, docId) {
      if (tileDepth++ === 0) tileKept = calls.has(call++)
      if (mute > 0) mute++
      else if (target.beginTile(area, view, xstep, ystep, at(ctm), id, docId) !== 0) mute = 1
      // The cell is always walked here, so operations are met as they were read.
      return 0
    },
    endTile() {
      tileDepth--
      if (mute > 1) mute--
      else {
        mute = 0
        target.endTile()
      }
    }
  })
  try {
    page.run(device, mupdf.Matrix.identity)
    device.close()
  } finally {
    free(device, page)
  }
}

/** The chosen operations as an SVG of `box` (points), or null when MuPDF cannot write it. */
export function replaySvg(doc: PdfDoc, pageIndex: number, calls: Set<number>, box: Box): string | null {
  const buffer = new mupdf.Buffer()
  let writer: mupdf.DocumentWriter | null = null
  try {
    writer = new mupdf.DocumentWriter(buffer, 'svg', '')
    const device = writer.beginPage([0, 0, box[2] - box[0], box[3] - box[1]])
    replay(doc, pageIndex, calls, device, mupdf.Matrix.translate(-box[0], -box[1]))
    writer.endPage()
    writer.close()
    return buffer.asString()
  } catch {
    return null
  } finally {
    free(writer, buffer)
  }
}

/** The chosen operations as a picture of `box` on a transparent ground, `scale` pixels a point. */
export function replayPixmap(doc: PdfDoc, pageIndex: number, calls: Set<number>, box: Box, scale: number): mupdf.Pixmap {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, Math.max(1, Math.ceil((box[2] - box[0]) * scale)), Math.max(1, Math.ceil((box[3] - box[1]) * scale))], true)
  pixmap.clear(0)
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
  try {
    replay(doc, pageIndex, calls, device, mupdf.Matrix.concat(mupdf.Matrix.translate(-box[0], -box[1]), mupdf.Matrix.scale(scale, scale)))
    device.close()
    return pixmap
  } catch (error) {
    free(pixmap)
    throw error
  } finally {
    free(device)
  }
}

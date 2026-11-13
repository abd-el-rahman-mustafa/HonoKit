import type { Paint, PathOp, Stroke } from './drawings'
import type { Box, ShapeBlock } from './model'

/**
 * DrawingML both positioned writers share (decisions §118): a page's drawing as an Office shape —
 * a rectangle or a line as a preset, any other outline as custom geometry — with its fill, line,
 * dashes, caps and joins. `len` turns page points into the file's EMU (a slide may be scaled).
 */

export const EMU = 12700

export const hex = (c: readonly number[]): string =>
  c
    .slice(0, 3)
    .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

export const solid = (p: Paint): string => `<a:solidFill><a:srgbClr val="${hex(p.colour)}">${p.alpha < 0.999 ? `<a:alpha val="${Math.round(p.alpha * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>`

/** Dash lengths as dash-gap pairs (an odd list repeats, as in PDF). */
function pairs(dashes: number[]): Array<[number, number]> {
  const list = dashes.length % 2 ? [...dashes, ...dashes] : dashes
  const out: Array<[number, number]> = []
  for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i]!, list[i + 1]!])
  return out
}

export function lineXml(st: Stroke | null, len: (pt: number) => number): string {
  if (!st) return '<a:ln><a:noFill/></a:ln>'
  // A zero width is the thinnest line the device draws.
  const width = Math.max(0.25, st.width)
  const cap = st.cap === 'round' ? 'rnd' : st.cap === 'square' ? 'sq' : 'flat'
  const dash =
    st.dashes && st.dashes.some((d) => d > 0)
      ? `<a:custDash>${pairs(st.dashes)
          .map(([d, gap]) => `<a:ds d="${Math.max(1, Math.round((d / width) * 100000))}" sp="${Math.max(1, Math.round((gap / width) * 100000))}"/>`)
          .join('')}</a:custDash>`
      : ''
  const join = st.join === 'round' ? '<a:round/>' : st.join === 'bevel' ? '<a:bevel/>' : '<a:miter lim="800000"/>'
  return `<a:ln w="${Math.max(1, len(width))}" cap="${cap}">${solid(st.paint)}${dash}${join}</a:ln>`
}

export function boundsOf(ops: PathOp[]): Box {
  const xs: number[] = []
  const ys: number[] = []
  for (const o of ops) {
    if (o.op === 'Z') continue
    xs.push(o.x)
    ys.push(o.y)
    if (o.op === 'C') {
      xs.push(o.x1, o.x2)
      ys.push(o.y1, o.y2)
    }
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0]
}

/** A shape's place (its outline's bounds, page points), its flip, and its geometry, fill and line XML. */
export function shapeParts(b: ShapeBlock, len: (pt: number) => number): { box: Box; flip: string; body: string } {
  const box = boundsOf(b.ops)
  const fill = b.fill && b.geometry !== 'line' ? solid(b.fill) : '<a:noFill/>'
  let geometry: string
  let flip = ''
  if (b.geometry === 'rect') geometry = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
  else if (b.geometry === 'line' && b.ops.length === 2 && b.ops[0]!.op !== 'Z' && b.ops[1]!.op !== 'Z') {
    const [p, q] = b.ops as Array<{ x: number; y: number }>
    // The preset line runs from the top-left corner to the bottom-right one.
    if ((q!.x - p!.x) * (q!.y - p!.y) < 0) flip = ' flipV="1"'
    geometry = '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
  } else {
    const w = Math.max(1, len(box[2] - box[0]))
    const h = Math.max(1, len(box[3] - box[1]))
    const pt = (x: number, y: number): string => `<a:pt x="${len(x - box[0])}" y="${len(y - box[1])}"/>`
    const path = b.ops
      .map((o) => (o.op === 'M' ? `<a:moveTo>${pt(o.x, o.y)}</a:moveTo>` : o.op === 'L' ? `<a:lnTo>${pt(o.x, o.y)}</a:lnTo>` : o.op === 'C' ? `<a:cubicBezTo>${pt(o.x1, o.y1)}${pt(o.x2, o.y2)}${pt(o.x, o.y)}</a:cubicBezTo>` : '<a:close/>'))
      .join('')
    const open = b.geometry === 'line' || !b.fill ? ' fill="none"' : ''
    geometry = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${open}${b.stroke ? '' : ' stroke="0"'}>${path}</a:path></a:pathLst></a:custGeom>`
  }
  return { box, flip, body: `${geometry}${fill}${lineXml(b.stroke, len)}` }
}

/** The SVG of a picture beside its PNG (Office 2016 and later draw the SVG; older ones the PNG). */
export const svgExtension = (rel: string): string =>
  `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${rel}"/></a:ext></a:extLst>`

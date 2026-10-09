/** Geometry shared by the Edit mode layers and the viewer (pure: unit tested in test/viewerfix.test.ts). Page points, top-left origin. */

export type Box = [number, number, number, number]

export interface Guide {
  axis: 'x' | 'y'
  at: number
}

/**
 * Snapping, as in Foxit's and Acrobat's alignment guides: while a block moves, its edges and
 * centre snap to other blocks' edges and centres and to the page's centre when within a few
 * pixels, and a green line shows what it lines up with.
 */
export function snap(box: Box, dx: number, dy: number, others: Box[], page: { width: number; height: number }, tolerance: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [page.width / 2, ...others.flatMap((b) => [b[0], b[2], (b[0] + b[2]) / 2])]
  const ys = [page.height / 2, ...others.flatMap((b) => [b[1], b[3], (b[1] + b[3]) / 2])]
  const mine = { x: [box[0] + dx, box[2] + dx, (box[0] + box[2]) / 2 + dx], y: [box[1] + dy, box[3] + dy, (box[1] + box[3]) / 2 + dy] }
  const guides: Guide[] = []
  let best = { d: tolerance + 1, shift: 0, at: 0 }
  for (const a of mine.x) for (const b of xs) if (Math.abs(a - b) < Math.abs(best.d)) best = { d: b - a, shift: b - a, at: b }
  if (Math.abs(best.d) <= tolerance) {
    dx += best.shift
    guides.push({ axis: 'x', at: best.at })
  }
  best = { d: tolerance + 1, shift: 0, at: 0 }
  for (const a of mine.y) for (const b of ys) if (Math.abs(a - b) < Math.abs(best.d)) best = { d: b - a, shift: b - a, at: b }
  if (Math.abs(best.d) <= tolerance) {
    dy += best.shift
    guides.push({ axis: 'y', at: best.at })
  }
  return { dx, dy, guides }
}

// --- the viewer's scrolling (Viewer.tsx) ------------------------------------------------------

/** Where a page sits in the viewer's scrolled content, in CSS pixels. */
export interface PageSpot {
  top: number
  left: number
  width: number
  height: number
}

/**
 * Where the viewer puts its pages at a scale: one under another from `padding`, `gap` apart,
 * each centred in content as wide as the widest page plus room at the sides, or the view.
 */
export function pageSpots(pages: Array<{ width: number; height: number }>, scale: number, layout: { padding: number; gap: number; side: number; viewWidth: number }): PageSpot[] {
  const widest = Math.max(1, ...pages.map((p) => p.width)) * scale
  const content = Math.max(widest + layout.side * 2, layout.viewWidth - 1)
  // The content is centred in the view when narrower (mx-auto).
  const offset = Math.max(0, (layout.viewWidth - content) / 2)
  const out: PageSpot[] = []
  let y = layout.padding
  for (const p of pages) {
    out.push({ top: y, left: offset + content / 2 - (p.width * scale) / 2, width: p.width * scale, height: p.height * scale })
    y += p.height * scale + layout.gap
  }
  return out
}

/**
 * The scroll position that shows `box` (page points, as the page is displayed, so rotated pages
 * too) of a page, as Acrobat's Find does: unchanged if it is already in view with a little room,
 * otherwise the match is brought to the middle of the view (to its start when it is bigger than the view).
 */
export function scrollToBox(spot: PageSpot, scale: number, box: Box, view: { left: number; top: number; width: number; height: number }, margin = 8): { left: number; top: number } {
  const x0 = spot.left + box[0] * scale
  const x1 = spot.left + box[2] * scale
  const y0 = spot.top + box[1] * scale
  const y1 = spot.top + box[3] * scale
  const along = (a0: number, a1: number, at: number, size: number): number => {
    const room = Math.min(margin, Math.max(0, (size - (a1 - a0)) / 2))
    if (a0 >= at + room && a1 <= at + size - room) return at
    return a1 - a0 > size - 2 * room ? a0 - room : (a0 + a1) / 2 - size / 2
  }
  return { left: Math.max(0, along(x0, x1, view.left, view.width)), top: Math.max(0, along(y0, y1, view.top, view.height)) }
}

/** The page point under a point of the view (pixels from its top-left), for zooming about it. */
export interface ZoomAnchor {
  page: number
  /** Page points. */
  x: number
  y: number
  /** Where it is in the view, CSS pixels. */
  vx: number
  vy: number
}

export function zoomAnchor(spots: PageSpot[], scale: number, scroll: { left: number; top: number }, at: { x: number; y: number }): ZoomAnchor | null {
  if (!spots.length) return null
  const cx = scroll.left + at.x
  const cy = scroll.top + at.y
  // The page under the point, or the nearest one above or below it (the gap between pages).
  let page = 0
  let best = Infinity
  spots.forEach((s, i) => {
    const d = cy < s.top ? s.top - cy : cy > s.top + s.height ? cy - s.top - s.height : 0
    if (d < best) {
      best = d
      page = i
    }
  })
  const s = spots[page]!
  return { page, x: (cx - s.left) / scale, y: (cy - s.top) / scale, vx: at.x, vy: at.y }
}

/** The scroll position after a zoom that keeps the anchor's page point under the same view point. */
export function anchoredScroll(spots: PageSpot[], scale: number, anchor: ZoomAnchor): { left: number; top: number } {
  const s = spots[anchor.page]
  if (!s) return { left: 0, top: 0 }
  return { left: Math.max(0, s.left + anchor.x * scale - anchor.vx), top: Math.max(0, s.top + anchor.y * scale - anchor.vy) }
}

/** Limits a move so the box stays on the page: dropped past an edge, it would vanish. */
export function keepOnPage(box: Box, dx: number, dy: number, page: { width: number; height: number }): { dx: number; dy: number } {
  const lo = (a: number, b: number): number => Math.min(a, b)
  const hi = (a: number, b: number): number => Math.max(a, b)
  return {
    dx: hi(-box[0], lo(dx, page.width - box[2])),
    dy: hi(-box[1], lo(dy, page.height - box[3]))
  }
}

/**
 * A dragged block's move as the Edit layers make it: snapped to the other blocks and the page
 * centre (unless Alt), kept straight along its longer axis with Shift, and never past the page.
 */
export function dragMove(
  box: Box,
  dx: number,
  dy: number,
  others: Box[],
  page: { width: number; height: number },
  tolerance: number,
  keys: { alt?: boolean; shift?: boolean } = {}
): { dx: number; dy: number; guides: Guide[] } {
  const s = keys.alt ? { dx, dy, guides: [] as Guide[] } : snap(box, dx, dy, others, page, tolerance)
  if (keys.shift) {
    if (Math.abs(dx) > Math.abs(dy)) s.dy = 0
    else s.dx = 0
  }
  const k = keepOnPage(box, s.dx, s.dy, page)
  // A guide only stays while the snapped edge is still where the block ended up.
  const guides = s.guides.filter((g) => (g.axis === 'x' ? k.dx === s.dx : k.dy === s.dy))
  return { dx: k.dx, dy: k.dy, guides }
}

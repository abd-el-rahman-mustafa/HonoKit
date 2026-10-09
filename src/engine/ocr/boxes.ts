/**
 * Text lines from a detector's probability map.
 *
 * PaddleOCR's detector (DB, "differentiable binarisation") answers with one
 * number per pixel: how likely that pixel is to be inside a line of text. This
 * turns the map into rectangles, the way PaddleOCR's own post-processing does in
 * its simplest form: threshold the map, take each connected blob, keep the blobs
 * the model was sure of, and grow each one back out — the model deliberately
 * predicts a *shrunken* text region, so the box is unclipped by
 * `area × ratio / perimeter` to cover the whole line again.
 *
 * Axis-aligned rectangles, not rotated polygons: newspaper lines are level, and
 * a rectangle is what the reader crops.
 */

export interface TextBox {
  x: number
  y: number
  w: number
  h: number
  /** The mean probability inside the blob before it was grown. */
  score: number
}

export interface BoxOptions {
  /** A pixel is text above this. */
  threshold: number
  /** A blob is kept when its mean probability is at least this. */
  minScore: number
  /** Blobs narrower or shorter than this, in pixels, are noise. */
  minSide: number
  /** How far to grow a blob back out: PaddleOCR's `unclip_ratio`. */
  unclip: number
}

export const DEFAULT_BOX_OPTIONS: BoxOptions = { threshold: 0.3, minScore: 0.6, minSide: 4, unclip: 1.5 }

/**
 * `width`×`height` is the map's size; `limit` is the image it was made from, which
 * the grown boxes are clipped to (the map is padded to a multiple of 32).
 * Returned top to bottom, and right to left within a row — reading order.
 */
export function boxesFromProbability(probability: ArrayLike<number>, width: number, height: number, limit: { width: number; height: number }, options: BoxOptions = DEFAULT_BOX_OPTIONS): TextBox[] {
  const seen = new Uint8Array(width * height)
  const boxes: TextBox[] = []
  const stack: number[] = []

  for (let start = 0; start < width * height; start++) {
    if (seen[start] || probability[start]! < options.threshold) continue
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0,
      count = 0,
      sum = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const at = stack.pop()!,
        x = at % width,
        y = (at - x) / width
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      count++
      sum += probability[at]!
      // Four neighbours; the column test stops a blob wrapping from one row's end to the next row's start.
      for (const next of [at - 1, at + 1, at - width, at + width]) {
        if (next < 0 || next >= width * height || seen[next]) continue
        if (Math.abs((next % width) - x) > 1 || probability[next]! < options.threshold) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1
    if (w < options.minSide || h < options.minSide || sum / count < options.minScore) continue
    const grow = (w * h * options.unclip) / (2 * (w + h))
    const left = Math.max(0, x0 - grow),
      top = Math.max(0, y0 - grow)
    const right = Math.min(limit.width, x1 + grow),
      bottom = Math.min(limit.height, y1 + grow)
    if (right <= left || bottom <= top) continue
    boxes.push({ x: left, y: top, w: right - left, h: bottom - top, score: sum / count })
  }
  return boxes.sort((a, b) => a.y - b.y || b.x - a.x)
}

/** Overlap of two boxes as a share of the smaller one — how tiled detections are de-duplicated. */
export function overlapOfSmaller(a: TextBox, b: TextBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  return (w * h) / Math.min(a.w * a.h, b.w * b.h)
}

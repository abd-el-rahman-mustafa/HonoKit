import type { FormatId } from './imageFormats'

/**
 * What a result screen says about one picture (decisions §77): the size and the dimensions before
 * and after, and how to compare the two — a slider when they have the same shape, a Before / After
 * switch when the shape changed (crop, rotate, meme bands, exact resize), nothing for tools whose
 * pixels do not change.
 */

export interface Sized {
  width: number
  height: number
  /** Bytes on disk. */
  size: number
  format: FormatId
}

export interface ResultFacts {
  /** Percent of the original's file size saved (positive) or added (negative), whole numbers. */
  sizeChange: number
  /** The dimensions changed. */
  resized: boolean
  /** Enlarged or reduced by the same factor both ways (2 for 2×, 0.5 for half), else null. */
  scale: number | null
  /** The format changed (JPG → WebP). */
  converted: boolean
}

export function resultFacts(before: Sized, after: Sized): ResultFacts {
  const sizeChange = before.size > 0 ? Math.round((100 * (before.size - after.size)) / before.size) : 0
  const resized = before.width !== after.width || before.height !== after.height
  const sx = after.width / before.width
  const sy = after.height / before.height
  // Rounding of odd sizes allowed (a 1001 px side halved is 500 or 501).
  const uniform = Math.abs(sx - sy) <= Math.max(2 / before.width, 2 / before.height)
  const scale = resized && uniform ? Math.round(sx * 100) / 100 : null
  return { sizeChange, resized, scale, converted: before.format !== after.format }
}

export type CompareMode = 'slider' | 'switch' | 'none'

/** The image tools whose result looks like its picture: nothing to compare. */
const SAME_LOOK = new Set(['imgInfo', 'imgFrames', 'imgGif', 'imgIcon'])

/**
 * Slider when before and after have the same shape (within 1 %), so the two line up; a switch
 * when the shape changed; none for tools whose output is not a changed version of one picture.
 */
export function compareMode(tool: string, before: { width: number; height: number }, after: { width: number; height: number }): CompareMode {
  if (SAME_LOOK.has(tool)) return 'none'
  const a = before.width / before.height
  const b = after.width / after.height
  return Math.abs(a - b) / a <= 0.01 ? 'slider' : 'switch'
}

import type { mupdf } from './mupdf'

export type Matrix = [number, number, number, number, number, number]

const tidy = (v: number): number => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : +v.toFixed(6))

/**
 * From a drawing's own space (y up, upright as the person sees the page) to PDF space: the
 * /Matrix an appearance needs to look upright on a page shown turned by /Rotate. Identity on
 * unturned pages. Only the linear part: a reader fits the turned /BBox into /Rect
 * (PDF 32000 §12.5.5), which places it. A stamp on a rotated page came out lying on its side
 * without this (owner's report, 2026-10-08).
 */
export function uprightMatrix(page: mupdf.PDFPage): Matrix {
  const [a, b, c, d] = page.getTransform()
  const det = a * d - b * c
  // Page space (y down) from the drawing's: (u, v) → (u, −v); then back to PDF space by the inverse.
  return [tidy(d / det), tidy(-b / det), tidy(c / det), tidy(-a / det), 0, 0]
}

/** How far the page is shown turned, as a widget's /MK /R wants it: 0, 90, 180 or 270 (anticlockwise in PDF space). */
export function shownTurn(page: mupdf.PDFPage): 0 | 90 | 180 | 270 {
  const [a, b] = uprightMatrix(page)
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90
  return (((deg % 360) + 360) % 360) as 0 | 90 | 180 | 270
}

/** The /Matrix for a widget appearance turned by /MK /R degrees. */
export function turnMatrix(degrees: number): Matrix {
  const r = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360
  const [cos, sin] = r === 90 ? [0, 1] : r === 180 ? [-1, 0] : r === 270 ? [0, -1] : [1, 0]
  return [cos, sin, -sin, cos, 0, 0]
}

export const isIdentity = (m: Matrix): boolean => m.join(' ') === '1 0 0 1 0 0'

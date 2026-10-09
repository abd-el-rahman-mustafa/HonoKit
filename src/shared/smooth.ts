type Point = [number, number]

/**
 * A pen stroke as a smooth curve through the points drawn (decisions §82): each
 * stretch between two points is the Catmull-Rom curve through them, written as a cubic Bézier
 * (control points a sixth of the neighbours' difference away) and sampled every `step` units.
 *
 * MuPDF draws an Ink annotation's /InkList as straight lines from point to point, and so do other
 * readers that make their own appearance from the list; a list that already follows the curve
 * shows the same smooth stroke everywhere. Every point drawn stays in the list, exactly.
 * Strokes of one or two points are returned as they are.
 */
export function smoothStroke(points: Point[], step = 1.5, limit = 4000): Point[] {
  const p = points.filter((q, i) => i === 0 || Math.hypot(q[0] - points[i - 1]![0], q[1] - points[i - 1]![1]) > 1e-6)
  if (p.length < 3) return points
  let length = 0
  for (let i = 1; i < p.length; i++) length += Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![1] - p[i - 1]![1])
  // A very long stroke is sampled more coarsely so the list stays a sensible size.
  const each = Math.max(step, length / limit)
  const round = (v: number): number => Math.round(v * 100) / 100
  const out: Point[] = [[round(p[0]![0]), round(p[0]![1])]]
  for (let i = 0; i + 1 < p.length; i++) {
    const p1 = p[i]!
    const p2 = p[i + 1]!
    const p0 = p[i - 1] ?? p1
    const p3 = p[i + 2] ?? p2
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    const n = Math.max(1, Math.min(64, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / each)))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      out.push(k === n ? [round(p2[0]), round(p2[1])] : [round(a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0]), round(a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1])])
    }
  }
  return out
}

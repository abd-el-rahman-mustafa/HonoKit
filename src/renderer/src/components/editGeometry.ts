/** Geometry shared by the Edit mode layers. Page points, top-left origin. The pure parts live in @shared/viewGeometry. */

import type { Box } from '@shared/viewGeometry'

export { anchoredScroll, dragMove, keepOnPage, pageSpots, scrollToBox, snap, zoomAnchor, type Box, type Guide, type PageSpot, type ZoomAnchor } from '@shared/viewGeometry'

/** CSS pixels for a box in points. */
export function px(b: Box, scale: number): React.CSSProperties {
  return { left: b[0] * scale, top: b[1] * scale, width: (b[2] - b[0]) * scale, height: (b[3] - b[1]) * scale }
}

export const closeBoxes = (a: Box, b: Box, tolerance = 1.5): boolean => a.every((v, i) => Math.abs(v - b[i]!) < tolerance)

export const inside = (b: Box, p: { x: number; y: number }, margin = 0): boolean => p.x >= b[0] - margin && p.x <= b[2] + margin && p.y >= b[1] - margin && p.y <= b[3] + margin

export const area = (b: Box): number => (b[2] - b[0]) * (b[3] - b[1])

/** True while typing in a field, when keys like Delete belong to the field. */
export function typing(): boolean {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)
}

/**
 * Follows a press on the page until release: `onMove` gets the distance in points once the
 * mouse has moved a few pixels; `onEnd` whether it was a drag at all.
 */
export function follow(e: React.MouseEvent, scale: number, onMove: (dx: number, dy: number, m: MouseEvent) => void, onEnd: (dragged: boolean, m: MouseEvent) => void): void {
  const x0 = e.clientX
  const y0 = e.clientY
  let dragged = false
  const move = (m: MouseEvent): void => {
    if (!dragged && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return
    dragged = true
    onMove((m.clientX - x0) / scale, (m.clientY - y0) / scale, m)
  }
  const up = (m: MouseEvent): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    onEnd(dragged, m)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

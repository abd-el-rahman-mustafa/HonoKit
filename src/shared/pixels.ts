/**
 * Page pictures and the screen's pixels (decisions §82–83). Pure, so the sizes can
 * be tested; the viewer passes the window's devicePixelRatio, which changes when the window moves
 * to a monitor with another scaling (or the Windows scaling changes), see `watchPixelRatio`.
 */

/** Scale steps, so small zoom changes reuse cached pictures; capped so a huge zoom never renders a gigapixel page. */
export const SCALE_STEPS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6]

/** The render scale (pixels per point) for a page shown at `displayScale` CSS pixels per point. */
export function stepScale(displayScale: number, dpr: number): number {
  const target = displayScale * (dpr || 1)
  return SCALE_STEPS.find((s) => s >= target * 0.98) ?? SCALE_STEPS[SCALE_STEPS.length - 1]!
}

/**
 * The page in the viewer pixel for pixel: rendered at exactly the device pixels it covers
 * (devicePixelRatio × its CSS size, rounded) and shown at that size, so the picture is never
 * scaled again. Null above the largest step (very large zooms keep the capped, stepped scale).
 */
export function exactPixels(width: number, height: number, pointsWide: number, dpr: number): { size: [number, number]; cssWidth: number; cssHeight: number } | null {
  const ratio = dpr || 1
  const size: [number, number] = [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))]
  if (size[0] / Math.max(1, pointsWide) > SCALE_STEPS[SCALE_STEPS.length - 1]!) return null
  return { size, cssWidth: size[0] / ratio, cssHeight: size[1] / ratio }
}

/** The parts of a window `watchPixelRatio` uses (a test passes its own). */
export interface PixelRatioWindow {
  readonly devicePixelRatio: number
  matchMedia(query: string): { addEventListener(type: 'change', listener: () => void, options?: { once?: boolean }): void; removeEventListener(type: 'change', listener: () => void): void }
}

/**
 * Calls `onChange` with the new devicePixelRatio whenever it changes: the window moved to a monitor
 * with another scaling, the Windows scaling changed, or the page zoom did. A media query matches
 * one exact resolution, so it is armed for the current ratio and armed again after each change.
 * Returns a function that stops watching.
 */
export function watchPixelRatio(win: PixelRatioWindow, onChange: (dpr: number) => void): () => void {
  let stop = (): void => {}
  const arm = (): void => {
    const query = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`)
    const changed = (): void => {
      arm()
      onChange(win.devicePixelRatio || 1)
    }
    query.addEventListener('change', changed, { once: true })
    stop = () => query.removeEventListener('change', changed)
  }
  arm()
  return () => stop()
}

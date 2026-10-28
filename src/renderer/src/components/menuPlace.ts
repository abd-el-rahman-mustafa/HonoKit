/** Where a popover goes next to the control that opened it. */

/** The sides of a box in window coordinates: all the placing needs of the control or the window. */
export type Sides = { top: number; bottom: number; left: number; right: number }

/**
 * Where a popover goes: under its control, flipped above when it would pass the window's foot,
 * and kept on screen sideways. The window's size and the writing direction are passed in rather
 * than read here, so the arithmetic stands on its own and can be tested.
 */
export function placeBox(
  anchor: Sides,
  width: number,
  height: number,
  view: { width: number; height: number },
  rtl: boolean
): { left: number; top: number; width: number } {
  const below = anchor.bottom + 4 + height < view.height - 8
  const left = Math.min(Math.max(8, rtl ? anchor.right - width : anchor.left), view.width - width - 8)
  return { left, top: below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - height), width }
}

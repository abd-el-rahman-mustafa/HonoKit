/**
 * Where the quick tools stand after the person dragged them (decisions §92). The place is kept
 * as a distance from the nearer side of the pages' area, left or right and top or bottom, so the
 * card stays by that side when the window is resized; and it is always drawn inside the area,
 * however small the area becomes. Up to 0.19.0 it was a distance from the top-left corner, and a
 * card dragged to the right side vanished when the window was made narrower.
 */
export interface QuickPlace {
  /** Distance from the left side, or from the right side when `right`. */
  x: number
  /** Distance from the top, or from the bottom when `bottom`. */
  y: number
  right: boolean
  bottom: boolean
}

export interface Size {
  width: number
  height: number
}

/** The gap kept between the card and the sides of the area. */
export const QUICK_MARGIN = 4

function clamp(value: number, room: number): number {
  return Math.max(QUICK_MARGIN, Math.min(value, room - QUICK_MARGIN))
}

/** The place for a card whose left and top are `left`, `top` in an area of `area`. */
export function quickPlaceAt(left: number, top: number, card: Size, area: Size): QuickPlace {
  const right = left + card.width / 2 > area.width / 2
  const bottom = top + card.height / 2 > area.height / 2
  return {
    x: right ? area.width - card.width - left : left,
    y: bottom ? area.height - card.height - top : top,
    right,
    bottom
  }
}

/** The card's left and top for `place` in an area of `area`, always inside it. */
export function quickPlaceOffset(place: QuickPlace, card: Size, area: Size): { left: number; top: number } {
  const left = place.right ? area.width - card.width - place.x : place.x
  const top = place.bottom ? area.height - card.height - place.y : place.y
  return { left: clamp(left, area.width - card.width), top: clamp(top, area.height - card.height) }
}

import { describe, expect, it } from 'vitest'
import { placeBox } from '../src/renderer/src/components/menuPlace'

// A popover goes under the control that opened it, flips above it near the foot of the window,
// and is held on screen sideways. The height it is placed by is the one the menu measures, not
// a count of its rows: a choice that carries a hint under its label takes two lines, and a long
// hint wraps to more, so a counted height left such a menu running off the bottom.

/** The Select button's box: 200 wide, its foot 560 down the window. */
const anchor = { top: 552, bottom: 560, left: 100, right: 300 }
const view = { width: 1200, height: 840 }
/** Six choices with a hint each, as the places to save in have: 44 px a row and 8 of padding. */
const TWO_LINE_MENU = 6 * 44 + 8
/** What counting one line for every row said instead. */
const COUNTED = 6 * 34 + 10

describe('a popover is placed by the height it is given', () => {
  it('flips above the control when the menu does not fit below it', () => {
    const at = placeBox(anchor, 200, TWO_LINE_MENU, view, false)
    expect(at.top).toBe(anchor.top - 4 - TWO_LINE_MENU)
    // Its foot is at or above the control's head, so it covers neither the control nor the
    // window's own foot.
    expect(at.top + TWO_LINE_MENU).toBeLessThanOrEqual(anchor.top)
    expect(at.top).toBeGreaterThanOrEqual(8)
  })

  it('a height smaller than the menu leaves it below the control and off the window', () => {
    expect(COUNTED).toBeLessThan(TWO_LINE_MENU)
    const at = placeBox(anchor, 200, COUNTED, view, false)
    expect(at.top).toBe(anchor.bottom + 4)
    expect(at.top + TWO_LINE_MENU).toBeGreaterThan(view.height - 8)
  })

  it('stays below the control when the menu does fit', () => {
    const at = placeBox(anchor, 200, TWO_LINE_MENU, { width: 1200, height: 1400 }, false)
    expect(at.top).toBe(anchor.bottom + 4)
    expect(at.top + TWO_LINE_MENU).toBeLessThan(1400 - 8)
  })

  it('is held at the margin in a window too short for it either way', () => {
    // Nothing fits below, and the menu is taller than everything above the control: its head
    // stays at the margin rather than going off the top, and the rows scroll.
    const short = { width: 1200, height: 300 }
    const at = placeBox({ top: 40, bottom: 68, left: 100, right: 300 }, 200, 280, short, false)
    expect(at.top).toBe(8)
  })

  it('stays on screen sideways, hanging from the start side in either direction', () => {
    // A control near the right edge: the menu is pulled back inside, not cut off.
    const edge = { top: 100, bottom: 128, left: 1100, right: 1180 }
    expect(placeBox(edge, 300, 100, view, false).left).toBe(view.width - 300 - 8)
    // Right to left a menu hangs from the control's right side; near the left edge it is held in.
    const start = { top: 100, bottom: 128, left: 20, right: 120 }
    expect(placeBox(start, 300, 100, view, true).left).toBe(8)
    expect(placeBox({ top: 100, bottom: 128, left: 600, right: 800 }, 300, 100, view, true).left).toBe(500)
  })
})

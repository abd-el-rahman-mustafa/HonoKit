import { describe, expect, it } from 'vitest'
import { quickPlaceAt, quickPlaceOffset } from '../src/renderer/src/components/quickPlace'

// The quick tools stay by the side they were dragged to and inside the pages' area (decisions §92).

const card = { width: 44, height: 340 }

describe('quick tools place', () => {
  it('a card dragged to the right side stays by it when the window is made narrower', () => {
    const wide = { width: 1400, height: 840 }
    const place = quickPlaceAt(1340, 200, card, wide)
    expect(place.right).toBe(true)
    // The window shrinks: the old left of 1340 would be past the area's right side.
    const narrow = { width: 700, height: 840 }
    const at = quickPlaceOffset(place, card, narrow)
    expect(at.left).toBe(700 - 44 - (1400 - 44 - 1340))
    expect(at.left + card.width).toBeLessThanOrEqual(narrow.width - 4)
    expect(at.top).toBe(200)
  })

  it('a card dragged to the left side keeps its distance from the left', () => {
    const place = quickPlaceAt(30, 60, card, { width: 1400, height: 840 })
    expect(place).toEqual({ x: 30, y: 60, right: false, bottom: false })
    expect(quickPlaceOffset(place, card, { width: 600, height: 840 })).toEqual({ left: 30, top: 60 })
  })

  it('a card in the lower half keeps its distance from the bottom', () => {
    const place = quickPlaceAt(30, 480, card, { width: 1400, height: 840 })
    expect(place.bottom).toBe(true)
    expect(quickPlaceOffset(place, card, { width: 1400, height: 600 }).top).toBe(600 - 340 - (840 - 340 - 480))
  })

  it('stays inside an area smaller than where it was left, down to the margin', () => {
    const place = { x: 900, y: 700, right: false, bottom: false }
    expect(quickPlaceOffset(place, card, { width: 500, height: 400 })).toEqual({ left: 500 - 44 - 4, top: 400 - 340 - 4 })
    // An area too small for the card: its top-left corner stays in view.
    expect(quickPlaceOffset(place, card, { width: 30, height: 200 })).toEqual({ left: 4, top: 4 })
  })
})

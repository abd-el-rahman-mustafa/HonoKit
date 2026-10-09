import { describe, expect, it } from 'vitest'
import { searchLines, type TextLine } from '@engine/text'
import { anchoredScroll, dragMove, keepOnPage, pageSpots, scrollToBox, snap, zoomAnchor, type Box } from '@shared/viewGeometry'

/** Viewer fixes V1–V5 of 2026-10-08, as pure logic. */

const PAGE = { width: 600, height: 800 }

/** A line of text set left to right from x at baseline row y (12 pt type, 6 pt per letter). */
function line(text: string, x: number, y: number, size = 12): TextLine {
  const glyphs = Array.from(text).map((c, i) => ({ c, width: size / 2, box: [x + (i * size) / 2, y - size, x + ((i + 1) * size) / 2, y] as [number, number, number, number] }))
  return { glyphs, text, box: [x, y - size, x + (text.length * size) / 2, y] }
}

describe('V2: Find across a line break', () => {
  const para = [line('The report covers the quarter in detail and', 40, 100), line('the quarter results are good for the team', 40, 116), line('and the board thanks every member of staff', 40, 132)]

  it('finds a phrase that runs onto the next line, one box per line', () => {
    const hits = searchLines(para, 'detail and the quarter', 0)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.boxes).toHaveLength(2)
    const [a, b] = hits[0]!.boxes
    // The end of the first line, then the start of the second.
    expect(a![1]).toBeLessThan(b![1])
    expect(b![0]).toBe(40)
  })

  it('still finds phrases inside one line with a single box', () => {
    const hits = searchLines(para, 'quarter', 0)
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => h.boxes.length === 1)).toBe(true)
  })

  it('does not join lines side by side, far apart, or of a different size', () => {
    const columns = [line('left column ends with the', 40, 100), line('word in the right column', 320, 100)]
    expect(searchLines(columns, 'the word', 0)).toHaveLength(0)
    const apart = [line('a heading that ends with the', 40, 100), line('word after a wide gap', 40, 180)]
    expect(searchLines(apart, 'the word', 0)).toHaveLength(0)
    const sizes = [line('A HEADLINE THE', 40, 100, 30), line('word in the body', 40, 116)]
    expect(searchLines(sizes, 'the word', 0)).toHaveLength(0)
  })

  it('can be asked to keep to single lines', () => {
    expect(searchLines(para, 'detail and the quarter', 0, 500, { acrossLines: false })).toHaveLength(0)
  })
})

describe('V1: a search match is scrolled into view, not the page top', () => {
  const spots = pageSpots([PAGE, PAGE, PAGE], 1, { padding: 24, gap: 16, side: 64, viewWidth: 1000 })

  it('lays pages out as the viewer draws them, centred in the content', () => {
    expect(spots.map((s) => s.top)).toEqual([24, 24 + 800 + 16, 24 + 2 * (800 + 16)])
    // Content 999 px wide (the view less one), centred in the 1000 px view.
    expect(spots[0]!.left).toBe(0.5 + (999 - 600) / 2)
  })

  it('centres a match that is out of view, and leaves one in view alone', () => {
    const view = { left: 0, top: 0, width: 1000, height: 600 }
    // Near the bottom of page 2.
    const box: Box = [100, 700, 200, 712]
    const to = scrollToBox(spots[1]!, 1, box, view)
    const middle = spots[1]!.top + 706
    expect(to.top).toBeCloseTo(middle - 300)
    // Already showing: no jump.
    const shown = scrollToBox(spots[0]!, 1, [100, 200, 200, 212], view)
    expect(shown).toEqual({ left: 0, top: 0 })
  })

  it('scrolls sideways when zoomed in and the match is off to the side', () => {
    const big = pageSpots([PAGE], 4, { padding: 24, gap: 16, side: 64, viewWidth: 1000 })
    const to = scrollToBox(big[0]!, 4, [500, 100, 560, 112], { left: 0, top: 0, width: 1000, height: 600 })
    const cx = big[0]!.left + 530 * 4
    expect(to.left).toBeCloseTo(cx - 500)
    // Its row is already showing: no vertical jump.
    expect(to.top).toBe(0)
  })

  it('never scrolls before the start', () => {
    expect(scrollToBox(spots[0]!, 1, [0, 0, 10, 10], { left: 0, top: 2000, width: 1000, height: 600 })).toEqual({ left: 0, top: 0 })
  })
})

describe('V4: Ctrl+wheel zoom keeps the point under the pointer', () => {
  const layout = { padding: 24, gap: 16, side: 64, viewWidth: 1000 }
  const pages = [PAGE, PAGE, PAGE]

  for (const [from, to] of [
    [1, 1.1],
    [1.5, 1 / 1.1],
    [0.5, 3]
  ] as const) {
    it(`from ${from} to ${to}`, () => {
      const scroll = { left: 40, top: 1200 }
      const pointer = { x: 420, y: 250 }
      const anchor = zoomAnchor(pageSpots(pages, from, layout), from, scroll, pointer)!
      const after = anchoredScroll(pageSpots(pages, to, layout), to, anchor)
      // The page point now under the pointer is the one that was there.
      const again = zoomAnchor(pageSpots(pages, to, layout), to, after, pointer)!
      expect(again.page).toBe(anchor.page)
      // Unless the scroll had to stop at the start, the point is the same.
      if (after.left > 0) expect(again.x).toBeCloseTo(anchor.x)
      if (after.top > 0) expect(again.y).toBeCloseTo(anchor.y)
    })
  }

  it('anchors a point in the gap between pages to the nearer page', () => {
    const spots = pageSpots(pages, 1, layout)
    const a = zoomAnchor(spots, 1, { left: 0, top: 0 }, { x: 500, y: spots[1]!.top - 4 })!
    expect(a.page).toBe(1)
    expect(a.y).toBeCloseTo(-4)
  })
})

describe('V3: markup stays on the page while dragged', () => {
  const stamp: Box = [400, 600, 560, 660]

  it('stops at the page edges', () => {
    expect(dragMove(stamp, 300, 300, [], PAGE, 5)).toMatchObject({ dx: 40, dy: 140 })
    expect(dragMove(stamp, -900, -900, [], PAGE, 5)).toMatchObject({ dx: -400, dy: -600 })
    expect(keepOnPage(stamp, 10, 10, PAGE)).toEqual({ dx: 10, dy: 10 })
  })

  it('moves straight with Shift and without snapping with Alt', () => {
    expect(dragMove(stamp, -50, 8, [], PAGE, 5, { shift: true })).toMatchObject({ dx: -50, dy: 0 })
    // Alt: the centre would snap to the page centre (x 300) — it does not.
    const free = dragMove(stamp, -178, 0, [], PAGE, 5, { alt: true })
    expect(free.dx).toBe(-178)
    expect(free.guides).toEqual([])
  })

  it('drops a guide the edge clamp moved away from', () => {
    // Snapping to a box past the edge would push it off: the clamp wins, and no false guide shows.
    const r = dragMove(stamp, 42, 0, [[602, 0, 640, 20]], PAGE, 5)
    expect(r.dx).toBe(40)
    expect(r.guides.filter((g) => g.axis === 'x')).toEqual([])
  })
})

describe('V5: snapping to centres on both axes', () => {
  const box: Box = [100, 100, 200, 140] // centre (150, 120)

  it("lines a block's vertical centre up with another block's centre", () => {
    const other: Box = [400, 300, 500, 360] // centre y 330
    const r = snap(box, 0, 208, [other], PAGE, 5)
    expect(r.dy).toBe(210)
    expect(r.guides).toContainEqual({ axis: 'y', at: 330 })
  })

  it("lines a block's centre up with the page centre, both ways", () => {
    const r = snap(box, 148, 278, [], PAGE, 5)
    expect(r.dx).toBe(150)
    expect(r.dy).toBe(280)
    expect(r.guides).toEqual([
      { axis: 'x', at: 300 },
      { axis: 'y', at: 400 }
    ])
  })
})

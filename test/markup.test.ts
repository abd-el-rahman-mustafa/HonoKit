import { describe, expect, it } from 'vitest'
import { BRAND, MARKUP_KEY, OLD_MARKUP_KEYS } from '@shared/brand'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { pageMarkups } from '@engine/markup'
import { applyOperation } from '@ops/index'
import { makeLatinPdf, makeRestrictedPdf } from './fixtures'

/** The colour of one pixel of page 1 rendered at 1:1, annotations included, as "r,g,b". */
function pixel(bytes: Uint8Array, x: number, y: number, page = 0): string {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const px = pm.getPixels()
    const o = (y * pm.getWidth() + x) * 3
    return `${px[o]},${px[o + 1]},${px[o + 2]}`
  } finally {
    free(doc)
  }
}

function markups(bytes: Uint8Array, page = 0) {
  const doc = openPdf(bytes)
  try {
    return pageMarkups(doc, page)
  } finally {
    free(doc)
  }
}

/** The first line of text on page 1, as the editor sees it. */
function firstLine(bytes: Uint8Array): [number, number, number, number] {
  const doc = openPdf(bytes)
  try {
    const stext = doc.loadPage(0).toStructuredText('preserve-whitespace')
    let box: [number, number, number, number] | null = null
    stext.walk({
      beginLine(bbox: mupdf.Rect) {
        box ??= [bbox[0], bbox[1], bbox[2], bbox[3]]
      }
    })
    return box!
  } finally {
    free(doc)
  }
}

const BIG = { width: 600, height: 800 }

describe('markup', () => {
  it('highlights the text between two points, and nothing where there is no text', async () => {
    const src = await makeLatinPdf(1)
    const line = firstLine(src)
    const mid = (line[1] + line[3]) / 2
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'highlight', from: [line[0], mid], to: [line[2], mid], colour: '#ffff00' } })
    const found = markups(bytes)
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('highlight')
    expect(found[0]!.box[0]).toBeLessThan(line[0] + 2)

    // A drag just under the line (between lines) still takes the nearest line.
    const below = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'highlight', from: [line[0], line[3] + 3], to: [line[2], line[3] + 3], colour: '#ffff00' } })
    expect(markups(below.bytes)).toHaveLength(1)

    const empty = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'highlight', from: [5, 5], to: [8, 6], colour: '#ffff00' } })
    expect(empty.note?.key).toBe('note.noTextThere')
    expect(markups(empty.bytes)).toHaveLength(0)
  })

  it('draws a rectangle where it is placed, and moves and deletes it', async () => {
    const src = await makeLatinPdf(1, BIG)
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'rect', rect: [100, 500, 200, 560], colour: '#ff0000', width: 4 } })
    expect(pixel(bytes, 150, 501)).toBe('255,0,0') // the top edge
    expect(pixel(bytes, 150, 530)).toBe('255,255,255') // not filled
    const [rect] = markups(bytes)
    expect(rect!.kind).toBe('rect')

    const moved = await applyOperation(bytes, { op: 'changeMarkup', page: 0, index: rect!.index, box: rect!.box, change: { kind: 'move', dx: 0, dy: 100 } })
    expect(pixel(moved.bytes, 150, 501)).toBe('255,255,255')
    expect(pixel(moved.bytes, 150, 601)).toBe('255,0,0')

    const [again] = markups(moved.bytes)
    const gone = await applyOperation(moved.bytes, { op: 'changeMarkup', page: 0, index: again!.index, box: again!.box, change: { kind: 'delete' } })
    expect(markups(gone.bytes)).toHaveLength(0)
    expect(pixel(gone.bytes, 150, 601)).toBe('255,255,255')
  })

  it('draws pen strokes, ellipses and arrows', async () => {
    const src = await makeLatinPdf(1, BIG)
    let { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'ink', strokes: [[[100, 650], [200, 650]]], colour: '#0000ff', width: 4 } })
    expect(pixel(bytes, 150, 650)).toBe('0,0,255')
    ;({ bytes } = await applyOperation(bytes, { op: 'markup', page: 0, markup: { kind: 'ellipse', rect: [300, 600, 400, 700], colour: '#00ff00', width: 3, fill: '#00ff00' } }))
    expect(pixel(bytes, 350, 650)).toBe('0,255,0')
    ;({ bytes } = await applyOperation(bytes, { op: 'markup', page: 0, markup: { kind: 'arrow', from: [100, 720], to: [250, 720], colour: '#000000', width: 2 } }))
    expect(markups(bytes).map((m) => m.kind)).toEqual(['ink', 'ellipse', 'arrow'])
  })

  it('places markup where it is seen on a rotated page', async () => {
    const rotated = await makeLatinPdf(1, { rotate: 90 })
    const { bytes } = await applyOperation(rotated, { op: 'markup', page: 0, markup: { kind: 'rect', rect: [50, 50, 150, 100], colour: '#ff0000', width: 4, fill: '#ff0000' } })
    expect(pixel(bytes, 100, 75)).toBe('255,0,0')
  })

  it('survives text edits and new pictures on the same page', async () => {
    const src = await makeLatinPdf(1, BIG)
    let { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'rect', rect: [100, 500, 200, 560], colour: '#ff0000', width: 4 } })
    const line = firstLine(bytes)
    ;({ bytes } = await applyOperation(bytes, { op: 'replaceText', page: 0, box: line, text: 'Changed' }))
    ;({ bytes } = await applyOperation(bytes, { op: 'erase', page: 0, box: [300, 300, 400, 400] }))
    expect(markups(bytes).map((m) => m.kind)).toEqual(['rect'])
  })

  it('adds a sticky note with its comment, then moves, recolours and rewrites it', async () => {
    const src = await makeLatinPdf(1, BIG)
    let { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'note', at: [300, 400], text: 'راجع هذا الرقم', colour: '#facc15' } })
    let [note] = markups(bytes)
    expect(note).toMatchObject({ kind: 'note', text: 'راجع هذا الرقم', author: BRAND.name, movable: true })
    expect(note!.box[0]).toBeCloseTo(300, 0)
    ;({ bytes } = await applyOperation(bytes, { op: 'changeMarkup', page: 0, index: note!.index, box: note!.box, change: { kind: 'move', dx: 50, dy: 0 } }))
    ;[note] = markups(bytes)
    expect(note!.box[0]).toBeCloseTo(350, 0)
    ;({ bytes } = await applyOperation(bytes, { op: 'changeMarkup', page: 0, index: note!.index, box: note!.box, change: { kind: 'revise', colour: '#16a34a', text: 'Checked' } }))
    ;[note] = markups(bytes)
    expect(note).toMatchObject({ text: 'Checked', colour: '#16a34a' })
  })

  it('needs only the "comment" right, not "edit"', async () => {
    // The restricted fixture allows nothing but printing: markup is refused.
    await expect(
      applyOperation(await makeRestrictedPdf(1), { op: 'markup', page: 0, markup: { kind: 'rect', rect: [10, 10, 50, 50], colour: '#ff0000' } })
    ).rejects.toMatchObject({ code: 'restricted' })
  })
})

/** Coloured (non-white, non-grey) pixels inside a region of page 1. */
function colouredIn(bytes: Uint8Array, r: [number, number, number, number]): number {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const px = pm.getPixels()
    const w = pm.getWidth()
    let n = 0
    for (let y = Math.max(0, Math.round(r[1])); y < Math.round(r[3]); y++)
      for (let x = Math.max(0, Math.round(r[0])); x < Math.round(r[2]); x++) {
        const o = (y * w + x) * 3
        if (Math.min(px[o]!, px[o + 1]!, px[o + 2]!) < 170) n++
      }
    return n
  } finally {
    free(doc)
  }
}

describe('stamps, text boxes and callouts (our own drawing)', () => {
  it('stamps an Arabic word with a line under it, as a Stamp annotation', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, author: 'Test', markup: { kind: 'stamp', at: [300, 300], label: 'معتمد', sub: 'Test — 30/09/2026', colour: '#1a7f37' } })
    const [m] = markups(bytes).filter((x) => x.kind === 'stamp')
    expect(m).toBeDefined()
    expect(m!.movable).toBe(true)
    expect(m!.text).toContain('معتمد')
    expect(colouredIn(bytes, m!.box)).toBeGreaterThan(200)
  })

  it('moves a stamp with its drawing, and redraws it when its text changes', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'stamp', at: [200, 200], label: 'APPROVED', colour: '#1a7f37' } })
    const [m] = markups(bytes)
    const moved = await applyOperation(bytes, { op: 'changeMarkup', page: 0, index: m!.index, box: m!.box, change: { kind: 'move', dx: 150, dy: 250 } })
    const [after] = markups(moved.bytes)
    expect(after!.box[0]).toBeCloseTo(m!.box[0] + 150, 0)
    expect(after!.box[1]).toBeCloseTo(m!.box[1] + 250, 0)
    expect(colouredIn(moved.bytes, after!.box)).toBeGreaterThan(200)
    expect(colouredIn(moved.bytes, m!.box)).toBeLessThan(20)
    const revised = await applyOperation(moved.bytes, { op: 'changeMarkup', page: 0, index: after!.index, box: after!.box, change: { kind: 'revise', text: 'REJECTED', colour: '#c62828' } })
    const [r] = markups(revised.bytes)
    expect(r!.text).toBe('REJECTED')
    expect(colouredIn(revised.bytes, r!.box)).toBeGreaterThan(200)
  })

  it('still redraws a stamp made before the rename, and moves it to the new key', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'stamp', at: [200, 200], label: 'APPROVED', colour: '#1a7f37' } })
    // As a PowerPDF build wrote it: the drawing's recipe under /PowerPDF.
    const doc = openPdf(bytes)
    let old: Uint8Array
    try {
      const annot = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0]!.getObject()
      annot.put(OLD_MARKUP_KEYS[0], annot.get(MARKUP_KEY))
      annot.delete(MARKUP_KEY)
      old = saveBytes(doc)
    } finally {
      free(doc)
    }
    const [m] = markups(old)
    const revised = await applyOperation(old, { op: 'changeMarkup', page: 0, index: m!.index, box: m!.box, change: { kind: 'revise', text: 'REJECTED', colour: '#c62828' } })
    const [r] = markups(revised.bytes)
    expect(r!.text).toBe('REJECTED')
    expect(colouredIn(revised.bytes, r!.box)).toBeGreaterThan(200)
    const after = openPdf(revised.bytes)
    try {
      const annot = (after.loadPage(0) as mupdf.PDFPage).getAnnotations()[0]!.getObject()
      expect(annot.get(MARKUP_KEY).isDictionary()).toBe(true)
      expect(annot.get(OLD_MARKUP_KEYS[0]).isNull()).toBe(true)
    } finally {
      free(after)
    }
  })

  it('wraps an Arabic text box inside its width', async () => {
    const src = await makeLatinPdf(1)
    const text = 'هذا نص تجريبي طويل داخل مربع نص يلتف عند حافته'
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'textbox', rect: [100, 500, 260, 520], text, colour: '#d32f2f', size: 12 } })
    const [m] = markups(bytes).filter((x) => x.kind === 'textbox')
    expect(m!.box[2] - m!.box[0]).toBeCloseTo(160, 0)
    // Wrapped onto several lines: the box grew downwards.
    expect(m!.box[3] - m!.box[1]).toBeGreaterThan(40)
    expect(colouredIn(bytes, [m!.box[0] + 4, m!.box[1] + 4, m!.box[2] - 4, m!.box[3] - 4])).toBeGreaterThan(150)
  })

  it('draws a callout with its line reaching the point', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'markup', page: 0, markup: { kind: 'callout', rect: [300, 100, 460, 140], to: [150, 300], text: 'Check this total', colour: '#d32f2f', size: 11 } })
    const [m] = markups(bytes).filter((x) => x.kind === 'callout')
    expect(m).toBeDefined()
    expect(m!.box[0]).toBeLessThan(150)
    expect(m!.box[3]).toBeGreaterThan(300)
    // Ink near the arrow tip.
    expect(colouredIn(bytes, [140, 285, 170, 305])).toBeGreaterThan(5)
  })
})

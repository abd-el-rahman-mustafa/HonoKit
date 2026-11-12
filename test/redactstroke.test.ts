import { describe, expect, it } from 'vitest'
import { PDFDocument, rgb } from 'pdf-lib'
import { applyRedactions, markForRedaction } from '@engine/redact'
import { contentOf } from '@engine/stamp'
import { free, openPdf } from '@engine/mupdf'
import type * as mupdf from 'mupdf'

/**
 * A stroked line is judged by the ink it paints, not by the points it is built from. A straight
 * horizontal or vertical stroke has a box of no area, and a wide stroke whose points lie beside a
 * mark still paints into it; either way its drawing instructions must not stay under the box.
 */

async function sample(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  // A thin horizontal rule crossing the mark: its path box has no height.
  page.drawLine({ start: { x: 20, y: 150 }, end: { x: 380, y: 150 }, thickness: 1, color: rgb(0, 0, 0) })
  // A wide vertical stroke whose centre is left of the mark (x 200) but whose ink reaches x 205.
  page.drawLine({ start: { x: 195, y: 120 }, end: { x: 195, y: 280 }, thickness: 20, color: rgb(0, 0, 0) })
  // A rule well away from the mark.
  page.drawLine({ start: { x: 20, y: 380 }, end: { x: 380, y: 380 }, thickness: 1, color: rgb(0, 0, 0) })
  return new Uint8Array(await pdf.save())
}

function content(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    const page = doc.loadPage(0) as mupdf.PDFPage
    try {
      return Buffer.from(contentOf(page.getObject())).toString('latin1')
    } finally {
      free(page)
    }
  } finally {
    free(doc)
  }
}

describe('redacting stroked lines', () => {
  it('sample has the strokes it describes', async () => {
    const stream = content(await sample())
    expect(stream).toContain('20 150 m')
    expect(stream).toContain('195 120 m')
    expect(stream).toContain('20 380 m')
  })

  it('removes a thin rule and a wide stroke that paint into the mark', async () => {
    const marked = markForRedaction(await sample(), [{ page: 0, box: [200, 100, 340, 300] }])
    const out = await applyRedactions(marked, { fill: [0, 0, 0], sanitize: false })
    const stream = content(out.bytes)
    // Page coordinates in the mark are top-down; y 150 from the bottom is 250 from the top, inside.
    expect(stream).not.toContain('20 150 m')
    expect(stream).not.toContain('195 120 m')
    expect(stream).toContain('20 380 m')
  })
})

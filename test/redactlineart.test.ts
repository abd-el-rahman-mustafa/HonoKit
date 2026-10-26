import { describe, expect, it } from 'vitest'
import { PDFDocument, rgb } from 'pdf-lib'
import { applyRedactions, markForRedaction } from '@engine/redact'
import { contentOf } from '@engine/stamp'
import { free, openPdf } from '@engine/mupdf'
import type * as mupdf from 'mupdf'

/**
 * A drawing under a redaction mark must leave nothing behind in the content stream. MuPDF removes
 * a drawing only when a mark covers it whole unless it is told otherwise, so a drawing that reaches
 * past the mark's edge — an outlined word, a signature, a line of a chart — kept every one of its
 * drawing instructions in the file, under the painted box, for anyone to read back.
 */

/** A page with three filled bars: one straddling the mark, one crossing it, one well away. */
async function sample(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  // Reaches from outside the mark (x 100) to inside it (x 300); the mark starts at x 200.
  page.drawRectangle({ x: 100, y: 200, width: 200, height: 40, color: rgb(0, 0, 0) })
  // Crosses the mark's column at a height the mark covers.
  page.drawRectangle({ x: 20, y: 150, width: 360, height: 2, color: rgb(0, 0, 0) })
  // Nowhere near the mark.
  page.drawRectangle({ x: 20, y: 380, width: 360, height: 2, color: rgb(0, 0, 0) })
  return new Uint8Array(await pdf.save())
}

/** The page's own drawing instructions (our painted box is an XObject of its own). */
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

describe('redacting drawings', () => {
  it('leaves no geometry behind when a drawing only partly lies under a mark', async () => {
    const marked = markForRedaction(await sample(), [{ page: 0, box: [200, 100, 340, 300] }])
    const out = await applyRedactions(marked, { fill: [0, 0, 0], sanitize: false })
    const stream = content(out.bytes)
    // The straddling bar and the crossing rule are gone, geometry and all.
    expect(stream).not.toContain('1 0 0 1 100 200 cm')
    expect(stream).not.toContain('200 40 l')
    expect(stream).not.toContain('1 0 0 1 20 150 cm')
    // A drawing the mark never touches stays.
    expect(stream).toContain('1 0 0 1 20 380 cm')
    expect(stream).toContain('360 2 l')
    expect(out.leftover).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { pageParagraphs, replaceText } from '@engine/edit'
import { PdfError } from '@engine/errors'
import { free, openPdf } from '@engine/mupdf'

/**
 * Text written at a size of thousands of points — a broken or hostile file — gives a line whose
 * box is far larger than its page. Judging whether the old words are still drawn asked MuPDF for
 * a pixmap of that whole box: "malloc (3735818064 bytes) failed", a plain error with no code of
 * ours, and the memory of the app and every other document open in it with it. The region is now
 * kept inside the page, and one still too large is left unjudged. Decisions §103.
 */

async function hugeTextPdf(size: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Wide heading', { x: 20, y: 400, size, font })
  return new Uint8Array(await pdf.save())
}

describe('text far larger than its page (§103)', () => {
  it('has a line box far outside the page', async () => {
    const src = await hugeTextPdf(20_000)
    const doc = openPdf(src)
    try {
      const [x0, y0, x1, y1] = pageParagraphs(doc, 0)[0]!.lines[0]!
      expect(x1 - x0 > 595 * 4 || y1 - y0 > 842 * 4).toBe(true)
    } finally {
      free(doc)
    }
  })

  it('is retyped, or refused with a message of ours, and never for want of memory', async () => {
    const src = await hugeTextPdf(20_000)
    const doc = openPdf(src)
    let line: [number, number, number, number]
    try {
      line = pageParagraphs(doc, 0)[0]!.lines[0]!
    } finally {
      free(doc)
    }
    for (const style of [{}, { width: 200 }]) {
      try {
        const r = await replaceText(src, 0, line, 'Wide heading reflowed', undefined, style)
        expect(r.bytes.length).toBeGreaterThan(0)
      } catch (e) {
        // A refusal of ours is fine; a bare memory failure is not.
        expect(String((e as Error).message)).not.toMatch(/malloc|failed/i)
        expect(e).toBeInstanceOf(PdfError)
      }
    }
  })
})

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { replaceText } from '@engine/edit'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { styledLines } from '@engine/paragraphs'
import { carryStyles, mark, paletteOf, plainText, segments, unmark, type RunStyle } from '@engine/richtext'
import { extractText } from '@engine/text'

/** Several styles in one paragraph (docs/decisions.md §65). */

describe('style markers', () => {
  it('ride along with words and come off cleanly', () => {
    const text = 'make this bold now'
    const { palette, styles } = paletteOf(text, [{ start: 5, end: 9, style: { bold: true } }])
    expect(palette).toHaveLength(2)
    const marked = mark(text, styles)
    expect(plainText(marked)).toBe(text)
    // Every word carries its style, so a line cut at any word knows it.
    expect(segments(marked).map((s) => [s.text, s.style])).toEqual([
      ['make ', 0],
      ['this ', 1],
      ['bold ', 0],
      ['now', 0]
    ])
    // A space belongs to the stretch before it; letters keep their own style.
    const back = unmark(marked)
    expect(back.text).toBe(text)
    expect(back.styles.filter((_, i) => text[i] !== ' ')).toEqual(styles.filter((_, i) => text[i] !== ' '))
    // Split into words as the layout does: each word still has its marker.
    expect(marked.split(/\s+/).every((w) => segments(w).length === 1)).toBe(true)
  })

  it('carry a paragraph’s styles to its new text', () => {
    const bold: RunStyle = { bold: true }
    const old = 'the big result'
    const styles = [...old].map((_, i) => (i >= 4 && i < 7 ? bold : null))
    // Another word changed: "big" stays bold.
    const a = carryStyles(old, styles, 'the big outcome')
    expect(a.slice(4, 7)).toEqual([bold, bold, bold])
    expect(a.slice(8).every((s) => s === null)).toBe(true)
    // The bold word itself replaced: the new word is bold.
    const b = carryStyles(old, styles, 'the huge result')
    expect(b.slice(4, 8)).toEqual([bold, bold, bold, bold])
    expect(b[9]).toBeNull()
  })
})

/** A paragraph in Helvetica with one bold word, as a PDF. */
async function mixedParagraph(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([420, 300])
  const parts: Array<[string, typeof regular]> = [
    ['The plan was ', regular],
    ['approved', bold],
    [' by the board on Monday', regular]
  ]
  let x = 40
  for (const [t, f] of parts) {
    page.drawText(t, { x, y: 220, size: 12, font: f })
    x += f.widthOfTextAtSize(t, 12)
  }
  page.drawText('and the work starts next week.', { x: 40, y: 205, size: 12, font: regular, color: rgb(0, 0, 0) })
  return new Uint8Array(await pdf.save())
}

/** Each word on the page with the font it is drawn in (and its colour). */
function wordFonts(bytes: Uint8Array): Map<string, { font: string; colour: number[] }> {
  const doc = openPdf(bytes)
  const out = new Map<string, { font: string; colour: number[] }>()
  try {
    let word = ''
    let font = ''
    let colour: number[] = []
    const flush = (): void => {
      if (word) out.set(word, { font, colour })
      word = ''
    }
    doc.loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(c: string, _o: unknown, f: mupdf.Font, _size: number, _quad: unknown, rgbColour: number[]) {
        if (!c.trim()) return flush()
        if (!word) {
          font = f.getName()
          colour = rgbColour.map((v) => Math.round(v * 255))
        }
        word += c
      },
      endLine: flush
    })
  } finally {
    free(doc)
  }
  return out
}

describe('several styles in a paragraph (§65)', () => {
  it('keeps a bold word bold when another word is changed', async () => {
    const src = await mixedParagraph()
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    free(doc)
    const r = await replaceText(src, 0, first.box, 'The plan was approved by the board on Tuesday and the work starts next week.')
    expect(r.unified).toBe(false)
    const words = wordFonts(r.bytes)
    expect(words.get('approved')?.font).toMatch(/Bold/)
    expect(words.get('Tuesday')?.font).not.toMatch(/Bold/)
    expect(words.get('plan')?.font).not.toMatch(/Bold/)
  })

  it('keeps the style when the bold word itself is replaced', async () => {
    const src = await mixedParagraph()
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    free(doc)
    const r = await replaceText(src, 0, first.box, 'The plan was rejected by the board on Monday and the work starts next week.')
    expect(wordFonts(r.bytes).get('rejected')?.font).toMatch(/Bold/)
  })

  it('sets stretches in the style the editor gives (bold and red)', async () => {
    const src = await mixedParagraph()
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    free(doc)
    const text = 'The plan was approved by the board on Monday and the work starts next week.'
    const at = text.indexOf('Monday')
    const r = await replaceText(src, 0, first.box, text, undefined, {
      spans: [
        { start: text.indexOf('approved'), end: text.indexOf('approved') + 8, style: { bold: true } },
        { start: at, end: at + 6, style: { bold: true, colour: [0.8, 0, 0] } }
      ]
    })
    const words = wordFonts(r.bytes)
    expect(words.get('Monday')?.font).toMatch(/Bold/)
    expect(words.get('Monday')?.colour[0]).toBeGreaterThan(180)
    expect(words.get('Monday')?.colour[1]).toBeLessThan(40)
    expect(words.get('board')?.font).not.toMatch(/Bold/)
    // Nothing lost, and in order.
    const after = openPdf(r.bytes)
    try {
      expect(extractText(after, 0).replace(/\s+/g, ' ').trim()).toBe(text)
    } finally {
      free(after)
    }
  })

  it('sets a word regular within a bold paragraph', async () => {
    const pdf = await PDFDocument.create()
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    pdf.addPage([400, 300]).drawText('The board approved the plan on Monday morning.', { x: 40, y: 220, size: 12, font: bold })
    const src = new Uint8Array(await pdf.save())
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    free(doc)
    const text = 'Edited in PowerPDF today'
    const at = text.indexOf('PowerPDF')
    // A stated "not bold" is a change from the bold body, not the body's style (found on a newspaper page).
    const r = await replaceText(src, 0, first.box, text, undefined, { spans: [{ start: at, end: at + 8, style: { bold: false } }] })
    const words = wordFonts(r.bytes)
    expect(words.get('PowerPDF')?.font).not.toMatch(/Bold/)
    expect(words.get('Edited')?.font).toMatch(/Bold/)
    expect(words.get('today')?.font).toMatch(/Bold/)
  })

  it('draws an Arabic word in bold within a right-to-left paragraph, in order', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 300]).drawText('placeholder line of text', { x: 60, y: 220, size: 14, font })
    const src = new Uint8Array(await pdf.save())
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    free(doc)
    const text = 'تقرير الصندوق السنوي لعام ٢٠٢٥'
    const at = text.indexOf('الصندوق')
    const r = await replaceText(src, 0, first.box, text, undefined, { style: { direction: 'rtl' }, spans: [{ start: at, end: at + 7, style: { bold: true } }] })
    const words = wordFonts(r.bytes)
    const fundFont = [...words].find(([w]) => w.includes('الصندوق') || w.includes('قودنصلا'))?.[1].font ?? ''
    expect(fundFont).toMatch(/Bold/)
    const after = openPdf(r.bytes)
    try {
      // Read back in reading order: every word there, the bold one in its place.
      const read = extractText(after, 0).replace(/\s+/g, ' ').trim()
      for (const w of ['تقرير', 'الصندوق', 'السنوي', 'لعام']) expect(read).toContain(w)
      expect(read.indexOf('تقرير')).toBeLessThan(read.indexOf('الصندوق'))
    } finally {
      free(after)
    }
  })
})

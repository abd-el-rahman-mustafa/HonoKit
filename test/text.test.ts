import { describe, expect, it } from 'vitest'
import { PdfError } from '@engine/errors'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { extractLines, extractText, foldString, repairLigatureOrder, searchLines } from '@engine/text'
import { visualRuns } from '@engine/bidi'
import { makeArabicPdf, makeLatinPdf, makeLigatureBugPdf, systemArabicFont } from './fixtures'

describe('opening documents', () => {
  it('rejects bytes that are not a PDF', () => {
    expect(() => openPdf(new TextEncoder().encode('hello, this is not a pdf'))).toThrow(PdfError)
    expect(() => openPdf(new Uint8Array(0))).toThrow(PdfError)
  })
})

describe('Arabic text extraction', () => {
  const hasSystemFont = systemArabicFont() !== null

  it.skipIf(!hasSystemFont)('MuPDF still reverses ligature letters on its own (if this fails, remove the repair in text.ts)', async () => {
    const pdf = (await makeLigatureBugPdf(['قطار الاتحاد']))!
    const raw = mupdf.Document.openDocument(pdf, 'application/pdf')
    try {
      const text = raw.loadPage(0).toStructuredText('preserve-whitespace').asText()
      expect(text).toContain('االتحاد') // lam-alef ligature glyph, letters swapped
      expect(text).not.toContain('الاتحاد')
    } finally {
      free(raw)
    }
  })

  it.skipIf(!hasSystemFont)('our extraction restores «على» and lam-alef words exactly as typed', async () => {
    const lines = ['على الطاولة كتاب', 'قطار الاتحاد من أبوظبي إلى دبي']
    const doc = openPdf((await makeLigatureBugPdf(lines))!)
    try {
      const text = extractText(doc, 0)
      for (const line of lines) expect(text).toContain(line)
    } finally {
      free(doc)
    }
  })

  it('reads text drawn with the bundled font (dot marks are not read as text)', async () => {
    const lines = ['على الطاولة كتاب', 'قطار الاتحاد']
    const doc = openPdf(await makeArabicPdf(lines))
    try {
      const text = extractText(doc, 0)
      expect(text).not.toContain('�')
      for (const line of lines) expect(foldString(text)).toContain(foldString(line))
    } finally {
      free(doc)
    }
  })

  it('repairs only a zero-width letter followed by a wide letter', () => {
    const glyphs = [
      { c: 'ع', width: 5 },
      { c: 'ى', width: 0 },
      { c: 'ل', width: 5 },
      { c: 'ا', width: 4 },
      { c: 'ً', width: 0 } // a vowel mark after its base is correct as it is
    ]
    repairLigatureOrder(glyphs)
    expect(glyphs.map((g) => g.c).join('')).toBe('علىاً')
  })
})

describe('search', () => {
  it('finds Arabic despite tatweel, vowel marks and alef variants', () => {
    expect(foldString('أَحْمَد')).toBe(foldString('احمد'))
    expect(foldString('مـحـمـد')).toBe('محمد')
    expect(foldString('على')).toBe(foldString('علي'))
  })

  it('finds a phrase and returns its position', async () => {
    const doc = openPdf(await makeArabicPdf())
    try {
      const lines = extractLines(doc, 0)
      const hits = searchLines(lines, 'الاتحاد', 0)
      expect(hits).toHaveLength(1)
      const [x0, y0, x1, y1] = hits[0]!.boxes[0]!
      expect(x1).toBeGreaterThan(x0)
      expect(y1).toBeGreaterThan(y0)
      expect(searchLines(lines, 'غير موجود', 0)).toHaveLength(0)
    } finally {
      free(doc)
    }
  })

  it('searches Latin text case-insensitively across pages', async () => {
    const doc = openPdf(await makeLatinPdf(3))
    try {
      const all = [0, 1, 2].flatMap((p) => searchLines(extractLines(doc, p), 'marker', p))
      expect(all.map((h) => h.page)).toEqual([0, 1, 2])
    } finally {
      free(doc)
    }
  })
})

describe('bidi runs', () => {
  it('keeps digits left-to-right inside an Arabic line, in visual order', () => {
    const runs = visualRuns('صفحة 3 من 28')
    // Visual order, left to right: 28, من, 3, صفحة (RTL text is right-to-left overall).
    expect(runs.map((r) => r.text.trim())).toEqual(['28', 'من', '3', 'صفحة'])
    expect(runs.filter((r) => !r.rtl).map((r) => r.text.trim())).toEqual(['28', '3'])
  })

  it('leaves a plain Latin line as one run', () => {
    expect(visualRuns('Page 3 of 28')).toEqual([{ text: 'Page 3 of 28', rtl: false, arabic: false, indices: [...Array(12).keys()] }])
  })
})

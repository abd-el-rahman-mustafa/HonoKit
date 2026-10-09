import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { free, mupdf, openPdf } from '@engine/mupdf'
import type { Box } from '@engine/edit'
import { replaceInText } from '@engine/replace'
import { extractLines, extractText, matchUnits, searchLines } from '@engine/text'

/** Find & Replace (docs/decisions.md §64). */

const units = (s: string): string[] => Array.from(s)

describe('matching as Find matches', () => {
  it('folds Arabic letter forms, vowel marks and tatweel, and letter case unless asked', () => {
    // Hamza forms, alef maksura/yeh and tatweel are the same word to a reader.
    expect(matchUnits(units('قال إن الإمارات على حق'), 'الامارات')).toHaveLength(1)
    expect(matchUnits(units('ذهب إلى المدرسة'), 'الي')).toHaveLength(1)
    expect(matchUnits(units('الإمـــارات'), 'الإمارات')).toHaveLength(1)
    expect(matchUnits(units('Dubai and DUBAI'), 'dubai')).toHaveLength(2)
    expect(matchUnits(units('Dubai and DUBAI'), 'Dubai', { matchCase: true })).toEqual([[0, 4]])
  })

  it('finds whole words only when asked, in Arabic too', () => {
    expect(matchUnits(units('cat category scat cat.'), 'cat')).toHaveLength(4)
    expect(matchUnits(units('cat category scat cat.'), 'cat', { wholeWords: true })).toHaveLength(2)
    // "كتاب" inside "الكتاب" is not the whole word.
    expect(matchUnits(units('كتاب الكتاب كتابة'), 'كتاب', { wholeWords: true })).toEqual([[0, 3]])
  })
})

/** Two paragraphs in Noto Sans embedded as a subset of their own letters. */
async function document(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf')), { subset: true })
  for (let p = 0; p < 2; p++) {
    const page = pdf.addPage([420, 320])
    const first = ['The report covers the quarter in detail and', 'the quarter results are good for the team', 'and the board thanks every member of staff']
    first.forEach((t, i) => page.drawText(t, { x: 40, y: 260 - i * 16, size: 12, font }))
    page.drawText('A separate note mentions the quarter once.', { x: 40, y: 160, size: 12, font })
  }
  return new Uint8Array(await pdf.save())
}

const lines = (bytes: Uint8Array, page: number): string[] => {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, page).split('\n').map((l) => l.trim()).filter(Boolean)
  } finally {
    free(doc)
  }
}

const fontsByLine = (bytes: Uint8Array, page: number): Map<string, string> => {
  const doc = openPdf(bytes)
  const out = new Map<string, string>()
  try {
    let text = ''
    let fonts = new Set<string>()
    doc.loadPage(page).toStructuredText('preserve-whitespace').walk({
      beginLine() {
        text = ''
        fonts = new Set()
      },
      onChar(c: string, _o: unknown, font: mupdf.Font) {
        text += c
        if (c.trim()) fonts.add(font.getName())
      },
      endLine() {
        out.set(text.trim(), [...fonts].join(','))
      }
    })
  } finally {
    free(doc)
  }
  return out
}

describe('Find & Replace in a document (§64)', () => {
  it('replaces every occurrence on every page, as one change', async () => {
    const src = await document()
    const r = await replaceInText(src, 'quarter', 'year', {})
    expect(r.replaced).toBe(6)
    expect(r.paragraphs).toBe(4)
    expect(r.skipped).toEqual([])
    for (const page of [0, 1]) {
      const text = lines(r.bytes, page).join(' ')
      expect(text).not.toMatch(/quarter/)
      expect(text).toContain('covers the year in detail')
      expect(text).toContain('mentions the year once')
      expect(text).toContain('thanks every member of staff')
    }
  })

  it('leaves the lines without a match in their own letters', async () => {
    const src = await document()
    const r = await replaceInText(src, 'board', 'committee', { wholeWords: true })
    expect(r.replaced).toBe(2)
    const fonts = fontsByLine(r.bytes, 0)
    // The first two lines had no match: still the embedded subset, untouched.
    expect(fonts.get('The report covers the quarter in detail and')).toMatch(/NotoSans/)
    expect(fonts.get('the quarter results are good for the team')).toMatch(/NotoSans/)
  })

  it('replaces only the occurrence Find shows when asked for one', async () => {
    const src = await document()
    // The second line ("the quarter results…", baseline 76 pt from the top): Find's box for its "quarter".
    expect(lines(src, 1)[1]).toMatch(/^the quarter results/)
    const r = await replaceInText(src, 'quarter', 'season', {}, { only: { page: 1, box: [60, 66, 105, 79] } })
    expect(r.replaced).toBe(1)
    const page2 = lines(r.bytes, 1).join(' ')
    expect(page2).toContain('the season results')
    expect(page2).toContain('covers the quarter in detail')
    // The first page is untouched.
    expect(lines(r.bytes, 0).join(' ')).not.toContain('season')
  })

  it('leaves a paragraph as it was when the new words would not fit in its lines', async () => {
    const src = await document()
    // "once" → a long phrase: the one-line note would need a second line (or run into the margin).
    const r = await replaceInText(src, 'once.', 'once more, as the board of directors asked in its long letter.', {})
    expect(r.replaced).toBe(0)
    expect(r.skipped).toHaveLength(2)
    expect(r.skipped.every((s) => s.reason === 'longer')).toBe(true)
    expect(r.bytes).toBe(src)
  })

  it('skips a match that runs onto the next line, and counts it as left (V2)', async () => {
    const src = await document()
    // Find shows "detail and / the quarter" across the line break; Replace leaves it.
    const doc = openPdf(src)
    try {
      expect(searchLines(extractLines(doc, 0), 'detail and the quarter', 0)[0]?.boxes).toHaveLength(2)
    } finally {
      free(doc)
    }
    const r = await replaceInText(src, 'detail and the quarter', 'detail', {})
    expect(r.replaced).toBe(0)
    expect(r.skipped).toHaveLength(2)
    expect(r.skipped.every((s) => s.reason === 'wraps')).toBe(true)
    expect(r.bytes).toBe(src)
  })

  it('replaces the matches inside a line and leaves the one across the break (V2)', async () => {
    const src = await document()
    // "…in detail and / the quarter…" wraps; "and the board" is inside the third line.
    const r = await replaceInText(src, 'and the', 'and a', {})
    expect(r.replaced).toBe(2)
    expect(r.skipped.map((s) => s.reason)).toEqual(['wraps', 'wraps'])
    for (const page of [0, 1]) {
      const text = lines(r.bytes, page)
      expect(text).toContain('The report covers the quarter in detail and')
      expect(text).toContain('the quarter results are good for the team')
      expect(text.join(' ')).toContain('and a board thanks')
    }
  })

  it('leaves the one occurrence Find shows when it runs onto the next line (V2)', async () => {
    const src = await document()
    const doc = openPdf(src)
    let hit: Box
    try {
      hit = searchLines(extractLines(doc, 0), 'and the', 0)[0]!.boxes[0]!
    } finally {
      free(doc)
    }
    const r = await replaceInText(src, 'and the', 'and a', {}, { only: { page: 0, box: hit } })
    expect(r.replaced).toBe(0)
    expect(r.skipped).toMatchObject([{ page: 0, reason: 'wraps' }])
    expect(r.bytes).toBe(src)
  })

  it('says when the words are not there', async () => {
    const src = await document()
    const r = await replaceInText(src, 'nowhere', 'x', {})
    expect(r.replaced).toBe(0)
    expect(r.bytes).toBe(src)
  })
})

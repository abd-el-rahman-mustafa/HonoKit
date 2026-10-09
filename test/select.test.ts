import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { extractLines, selectText, type TextLine } from '@engine/text'
import { makeArabicPdf, makeLatinPdf } from './fixtures'

async function linesOf(bytes: Uint8Array | Promise<Uint8Array>): Promise<TextLine[]> {
  const doc = openPdf(await bytes)
  try {
    return extractLines(doc, 0)
  } finally {
    free(doc)
  }
}

const mid = (l: TextLine): number => (l.box[1] + l.box[3]) / 2

describe('text selection', () => {
  it('selects from one character to another in a line', async () => {
    const [line] = await linesOf(makeLatinPdf(1)) // "Page 1"
    const g = line!.glyphs
    const s = selectText([line!], [(g[0]!.box[0] + g[0]!.box[2]) / 2, mid(line!)], [(g[3]!.box[0] + g[3]!.box[2]) / 2, mid(line!)])
    expect(s?.text).toBe('Page')
    expect(s?.boxes).toHaveLength(1)
  })

  it('takes whole lines in between, in reading order, whichever way the drag went', async () => {
    const lines = await linesOf(makeLatinPdf(1))
    const [a, b] = lines
    const down = selectText(lines, [a!.box[0] + 1, mid(a!)], [b!.box[2] - 1, mid(b!)])
    const up = selectText(lines, [b!.box[2] - 1, mid(b!)], [a!.box[0] + 1, mid(a!)])
    expect(down?.text).toBe('Page 1\nMarker1')
    expect(up?.text).toBe(down?.text)
    expect(down?.boxes).toHaveLength(2)
  })

  it('widens to the word and the line on double and triple click', async () => {
    const [line] = await linesOf(makeLatinPdf(1))
    const g = line!.glyphs
    const p: [number, number] = [(g[1]!.box[0] + g[1]!.box[2]) / 2, mid(line!)]
    expect(selectText([line!], p, p, 'word')?.text).toBe('Page')
    expect(selectText([line!], p, p, 'line')?.text).toBe('Page 1')
  })

  it('selects Arabic in reading order, with ligatures the right way round', async () => {
    const lines = await linesOf(makeArabicPdf(['على الطاولة كتاب']))
    const line = lines[0]!
    // A drag from the right end (where Arabic starts) to the left end.
    const s = selectText(lines, [line.box[2] - 1, mid(line)], [line.box[0] + 1, mid(line)])
    expect(s?.text).toBe('على الطاولة كتاب')
    const word = selectText(lines, [line.box[2] - 3, mid(line)], [line.box[2] - 3, mid(line)], 'word')
    expect(word?.text).toBe('على')
  })

  it('selects to the end of the line when the drag goes past it', async () => {
    const lines = await linesOf(makeLatinPdf(1))
    const [a] = lines
    expect(selectText(lines, [a!.box[0] - 10, mid(a!)], [a!.box[2] + 150, mid(a!)])?.text).toBe('Page 1')
  })

  it('finds nothing away from text', async () => {
    const lines = await linesOf(makeLatinPdf(1))
    expect(selectText(lines, [5, 590], [30, 595])).toBeNull()
  })
})

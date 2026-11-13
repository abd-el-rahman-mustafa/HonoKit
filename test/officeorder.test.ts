import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { modelOf } from '@engine/office'
import type { ParagraphBlock } from '@engine/office/model'

/**
 * Flowing Word's reading order on hand-built pages shaped like the real ones that came out jumbled:
 * an invoice's sender beside its label/value pairs, a CV's bullets under a job title, a magazine's
 * letters page (a centred title and standfirst between three columns on a shared grid).
 */

const BASE = { removeTatweel: true, digits: 'keep' as const, pageBreaks: false, pictureFolder: 'pictures' }
const HEIGHT = 842

/** Text placed from the page's top (as the eye reads it), at its baseline. */
const put = (page: PDFPage, text: string, x: number, top: number, size: number, font: PDFFont): void => page.drawText(text, { x, y: HEIGHT - top, size, font })

/** Words wrapped to `width` at `size`. */
function wrap(text: string, width: number, size: number, font: PDFFont): string[] {
  const out: string[] = []
  let line = ''
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w
    if (line && font.widthOfTextAtSize(next, size) > width) {
      out.push(line)
      line = w
    } else line = next
  }
  if (line) out.push(line)
  return out
}

/** The first page's paragraphs, in the order flowing Word writes them. */
async function order(pdf: PDFDocument): Promise<string[]> {
  const model = modelOf(new Uint8Array(await pdf.save()), BASE)
  return model.pages[0]!.blocks.filter((b): b is ParagraphBlock => b.kind === 'paragraph').map((b) => b.runs.map((r) => r.text).join('').trim())
}

const LETTER = 'I really enjoyed your feature on the singers who moved into acting this year, and the way it showed how much work goes into a first role on screen and on stage.'

describe('flowing Word reading order', () => {
  it('reads an invoice sender first, then each label with its value', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const page = pdf.addPage([595, HEIGHT])
    put(page, 'INVOICE', 50, 60, 22, bold)
    put(page, 'FROM', 50, 120, 9, bold)
    put(page, 'Example Trading LLC', 50, 134, 11, font)
    put(page, 'Sharjah, United Arab Emirates', 50, 148, 11, font)
    const pairs = [['Date of issue', '08 Oct 2026'], ['Order', 'EP-1234'], ['Due', '15 Oct 2026']]
    pairs.forEach(([label, value], i) => {
      put(page, label!, 340, 120 + i * 20, 10, font)
      put(page, value!, 440, 120 + i * 20, 10, font)
    })
    const got = await order(pdf)
    const at = (s: string): number => got.findIndex((t) => t.startsWith(s))
    // The sender in one piece, before the pairs; each value straight after its label.
    expect(at('FROM')).toBeLessThan(at('Date of issue'))
    expect(at('Example Trading')).toBeLessThan(at('Date of issue'))
    for (const [label, value] of pairs) expect(at(value!)).toBe(at(label!) + 1)
  })

  it('keeps a CV bullet out of the job title above it', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([595, HEIGHT])
    // A title as wide as the bullets under it, at their size, its first words bold.
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const lead = 'Head of Sales and Customer Service,'
    const title = `${lead} Northern Region, Example Trading Company`
    put(page, lead, 50, 100, 11, bold)
    put(page, title.slice(lead.length), 50 + bold.widthOfTextAtSize(lead, 11), 100, 11, font)
    // Items 14 pt below the title, their own lines 11.5 pt apart, as the CV sets them.
    const items = [
      ['• Key Accounts: grew the region\'s largest customers through two busy seasons', 'of new products, with a monthly review of every open order and invoice'],
      ['• Service Desk: wrote and introduced the procedures that every branch office', 'of the region follows, with the forms and the yearly internal check']
    ]
    let top = 114
    for (const [first, rest] of items) {
      put(page, first!, 62, top, 11, font)
      put(page, rest!, 70, top + 11.5, 11, font)
      top += 11.5 + 14
    }
    const got = await order(pdf)
    expect(got[0]).toBe(title)
    expect(got.slice(1, 3)).toEqual(items.map(([a, b]) => `${a} ${b}`.replace('• ', '')))
  })

  it('reads three columns of letters down, though their headings and signatures share rows', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.TimesRoman)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const page = pdf.addPage([595, HEIGHT])
    const lefts = [50, 220, 390]
    lefts.forEach((x, c) => {
      put(page, `HEADING ${c + 1}`, x, 100, 12, bold)
      wrap(LETTER, 150, 10, font).forEach((l, i) => put(page, l, x, 114 + i * 12, 10, font))
      put(page, `Writer ${c + 1}`, x + 100, 200, 10, font)
    })
    const got = await order(pdf)
    // Each heading, then its own letter and signature.
    for (const c of [1, 2, 3]) {
      const h = got.indexOf(`HEADING ${c}`)
      expect(got[h + 1]).toMatch(/^I really enjoyed .* on stage\.$/)
      expect(got[h + 2]).toBe(`Writer ${c}`)
    }
  })

  it('cuts a centred title and standfirst off the columns their letters only touch', async () => {
    const pdf = await PDFDocument.create()
    const font = await embedFace(pdf, 'latin')
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const display = await embedFace(pdf, 'latin')
    const page = pdf.addPage([595, HEIGHT])
    const title = 'HAVE YOUR SAY'
    put(page, title, (595 - bold.widthOfTextAtSize(title, 44)) / 2, 80, 44, bold)
    // Three columns 150 wide, 12 apart; the standfirst's widest line runs from 3 pt after the left
    // column's text to 3 pt before the right column's.
    const lefts = [70, 232, 394]
    const leftEnd = 70 + Math.max(...wrap(LETTER, 150, 10, font).map((l) => font.widthOfTextAtSize(l, 10)))
    const from = leftEnd + 3
    const to = lefts[2]! - 3
    const stand = ['LET US KNOW', 'WHAT YOU THINK OF IT', 'BY EMAIL OR POST']
    const size = (20 * (to - from)) / display.widthOfTextAtSize(stand[1]!, 20)
    stand.forEach((l, i) => put(page, l, (from + to - display.widthOfTextAtSize(l, size)) / 2, 80 + size * 1.25 + i * size * 1.05, size, display))
    const below = 80 + size * 1.25 + 2 * size * 1.05
    lefts.forEach((x, c) => {
      // The middle column starts under the standfirst; the outer ones beside its last line.
      const top = c === 1 ? below + 30 : below - 4
      put(page, `HEADING ${c + 1}`, x, top, 11, bold)
      wrap(LETTER, 150, 10, font).forEach((l, i) => put(page, l, x, top + 14 + i * 12, 10, font))
    })
    const got = await order(pdf)
    expect(got[0]).toBe(title)
    expect(got[1]).toMatch(/^LET US KNOW/)
    // Each column down, left to right; no heading read across another column's letter.
    const heads = [1, 2, 3].map((c) => got.indexOf(`HEADING ${c}`))
    expect(heads.every((h) => h > 0)).toBe(true)
    expect([...heads].sort((a, b) => a - b)).toEqual(heads)
    for (const h of heads) expect(got[h + 1]).toMatch(/^I really enjoyed .* on stage\.$/)
  })

  it("keeps a column's paragraph whole past many captions set on the rows between its lines", async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.TimesRoman)
    const small = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([595, HEIGHT])
    const lines = wrap(`${LETTER} ${LETTER}`, 150, 10, font)
    lines.forEach((l, i) => put(page, l, 50, 300 + i * 11.5, 10, font))
    // A cover's tiny captions, each on its own baseline, between the paragraph's lines.
    for (let i = 0; i < 14; i++) put(page, `Caption ${i + 1}`, 260 + (i % 2) * 70, 296 + i * 6.3, 5, small)
    const got = await order(pdf)
    expect(got.filter((t) => t.startsWith('I really enjoyed'))).toEqual([`${LETTER} ${LETTER}`])
  })
})

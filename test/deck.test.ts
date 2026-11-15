import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { exportOffice, modelOf } from '@engine/office'
import { storiesOf } from '@engine/office/stories'
import { makePng } from './fixtures'

/**
 * PDF → PowerPoint "Make a presentation" (decisions §123): stories found on the page (stories.ts)
 * and slides made from them (deck.ts) — a contents slide, a story's kicker, headline, text on the
 * reading side and picture on the other, its text over as many slides as it takes, the whole
 * story in the notes, tables as PowerPoint tables, Arabic right to left.
 */

const BASE = { removeTatweel: true, digits: 'keep' as const, pageBreaks: false, pictureFolder: 'pictures' }
const deckOf = (bytes: Uint8Array, slideText: 'all' | 'opening' = 'all'): ReturnType<typeof exportOffice> => exportOffice(bytes, { ...BASE, format: 'pptx', layout: 'deck', slideText })
const storiesIn = (bytes: Uint8Array): ReturnType<typeof storiesOf> => storiesOf(modelOf(bytes, { ...BASE, art: false, figures: true }))

/** Each slide's XML and notes, in order. */
async function slidesOf(bytes: Uint8Array): Promise<Array<{ xml: string; text: string; notes: string }>> {
  const zip = await JSZip.loadAsync(bytes)
  const out: Array<{ xml: string; text: string; notes: string }> = []
  for (let i = 1; zip.file(`ppt/slides/slide${i}.xml`); i++) {
    const xml = await zip.file(`ppt/slides/slide${i}.xml`)!.async('string')
    const notesXml = (await zip.file(`ppt/notesSlides/notesSlide${i}.xml`)?.async('string')) ?? ''
    out.push({ xml, text: textIn(xml), notes: textIn(notesXml) })
  }
  return out
}

/** The text of `<a:t>` elements, a space between paragraphs, the bidi marks the writer adds left out. */
const textIn = (xml: string): string =>
  xml
    .split('</a:p>')
    .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''))
    .filter(Boolean)
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[‎‪‬]/g, '')

/** Draws `text` wrapped to `width` from (x, y) down; right-aligned for Arabic. The y under it. */
function paragraph(page: PDFPage, font: PDFFont, text: string, x: number, y: number, width: number, size: number, rtl = false): number {
  const words = text.split(' ')
  let line = ''
  const lines: string[] = []
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line)
      line = w
    } else line = next
  }
  if (line) lines.push(line)
  for (const l of lines) {
    page.drawText(l, { x: rtl ? x + width - font.widthOfTextAtSize(l, size) : x, y, size, font })
    y -= size * 1.3
  }
  return y - size * 0.8
}

const LOREM_A = 'Heavy rains flooded the valley on Sunday and roads were closed for hours. Rescue teams reached the villages before dark and moved families to schools on higher ground. The weather office said more rain would fall during the week.'
const LOREM_B = 'Shares rose in every market on Monday as oil prices held steady. Banks led the gains while builders and shipping firms followed close behind. Traders said the mood had turned after a quiet week of small moves.'

/** A newspaper page: two stories side by side, each with a kicker over its headline; a picture with its caption under the first. */
async function newspaper(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([800, 600])
  // Left: kicker, headline, two paragraphs, a picture, its caption.
  page.drawText('WEATHER WATCH', { x: 40, y: 545, size: 11, font, color: rgb(0.75, 0.1, 0.1) })
  page.drawText('Floods close roads in the valley', { x: 40, y: 515, size: 24, font: bold })
  let y = paragraph(page, font, LOREM_A, 40, 490, 330, 10)
  y = paragraph(page, font, 'Schools will stay shut on Tuesday while the water goes down. Parents were told to keep children at home.', 40, y, 330, 10)
  const png = await pdf.embedPng(makePng(80, 50))
  page.drawImage(png, { x: 40, y: y - 150, width: 240, height: 150 })
  page.drawText('Water covers the main road near the old bridge', { x: 40, y: y - 164, size: 8, font })
  // Right: kicker, headline, two paragraphs.
  page.drawText('MARKETS', { x: 420, y: 545, size: 11, font, color: rgb(0.75, 0.1, 0.1) })
  page.drawText('Shares close higher on Monday', { x: 420, y: 515, size: 24, font: bold })
  y = paragraph(page, font, LOREM_B, 420, 490, 330, 10)
  paragraph(page, font, 'Gold slipped a little and the dollar was flat against most currencies by the close.', 420, y, 330, 10)
  return new Uint8Array(await pdf.save())
}

describe('Make a presentation: the stories', () => {
  it('finds stories side by side, each with its kicker, text, picture and caption', async () => {
    const stories = storiesIn(await newspaper())
    expect(stories.map((s) => s.title)).toEqual(['Floods close roads in the valley', 'Shares close higher on Monday'])
    const [floods, shares] = stories
    expect(floods!.kicker).toBe('WEATHER WATCH')
    expect(shares!.kicker).toBe('MARKETS')
    // Each story's text is its own: nothing from the column beside it.
    const floodText = floods!.paragraphs.map((p) => p.text).join(' ')
    const shareText = shares!.paragraphs.map((p) => p.text).join(' ')
    expect(floodText).toContain('Rescue teams reached the villages')
    expect(floodText).toContain('Schools will stay shut')
    expect(floodText).not.toContain('Shares')
    expect(shareText).toContain('Gold slipped')
    expect(shareText).not.toContain('valley')
    // The picture is the floods story's, its caption with it and not in the text.
    expect(floods!.pictures).toHaveLength(1)
    expect(floods!.pictures[0]!.caption).toBe('Water covers the main road near the old bridge')
    expect(floodText).not.toContain('Water covers')
    expect(shares!.pictures).toHaveLength(0)
  })

  it('reads a report whose sections stand one under another in order, a section going on over the next page', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const first = pdf.addPage([595, 842])
    first.drawText('Second section', { x: 60, y: 560, size: 16, font: bold })
    first.drawText('Annual review', { x: 60, y: 770, size: 22, font: bold })
    paragraph(first, font, LOREM_A, 60, 740, 470, 11)
    paragraph(first, font, LOREM_B, 60, 530, 470, 11)
    const second = pdf.addPage([595, 842])
    paragraph(second, font, 'The section goes on here with a closing paragraph about the plans for next year and the new offices.', 60, 770, 470, 11)
    const stories = storiesIn(new Uint8Array(await pdf.save()))
    // Top to bottom, not by headline size.
    expect(stories.map((s) => s.title)).toEqual(['Annual review', 'Second section'])
    expect(stories[1]!.paragraphs.map((p) => p.text).join(' ')).toContain('closing paragraph about the plans')
  })
})

describe('Make a presentation: the slides', () => {
  it('makes a contents slide, then a slide per story: kicker, headline, text and picture, the story in the notes', async () => {
    const r = await deckOf(await newspaper())
    const slides = await slidesOf(r.bytes)
    expect(slides).toHaveLength(3)
    // Contents: the first page as a picture, and the headlines.
    expect(slides[0]!.text).toContain('Contents')
    expect(slides[0]!.text).toContain('Floods close roads in the valley')
    expect(slides[0]!.text).toContain('Shares close higher on Monday')
    expect(slides[0]!.xml).toContain('<p:pic>')
    // The floods story: kicker in the accent colour, the headline, every word, the picture with its caption as its alt text.
    const floods = slides[1]!
    expect(floods.text).toContain('WEATHER WATCH')
    expect(floods.text).toContain('Floods close roads in the valley')
    expect(floods.text).toContain(LOREM_A)
    expect(floods.xml).toMatch(/<p:pic>.*descr="Water covers the main road near the old bridge"/)
    expect(floods.text).toContain('Water covers the main road near the old bridge')
    // The kicker's red, darkened to read on white, is the deck's accent: the kicker and the rule under the headline.
    const accent = /<a:t>WEATHER WATCH<\/a:t>/.test(floods.xml) ? /srgbClr val="([0-9A-F]{6})"\/><\/a:solidFill><a:latin[^>]*\/><a:cs[^>]*\/><\/a:rPr><a:t>WEATHER WATCH/.exec(floods.xml)?.[1] : null
    expect(accent).toBeTruthy()
    const [r8, g8, b8] = [0, 2, 4].map((i) => parseInt(accent!.slice(i, i + 2), 16) / 255)
    expect(r8!).toBeGreaterThan(g8! + 0.3)
    expect(b8!).toBeLessThan(0.3)
    expect(floods.xml).toContain(`<p:sp><p:nvSpPr><p:cNvPr id="4" name="Rule 4"/>`)
    // Notes: the whole story, kicker to caption.
    expect(floods.notes).toContain('WEATHER WATCH')
    expect(floods.notes).toContain(LOREM_A)
    expect(floods.notes).toContain('Water covers the main road')
    // Text set for a screen: Segoe UI (or the PDF's own family when installed), headline at 34 pt.
    expect(floods.xml).toMatch(/sz="3400"/)
    expect(slides[2]!.text).toContain(LOREM_B)
  })

  it('carries a long story over as many slides as it takes, breaking at the end of a sentence; "opening" keeps the rest in the notes', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i + 1} tells a little more of the long story about the harbour.`)
    const paragraphs = Array.from({ length: 6 }, (_, i) => sentences.slice(i * 10, i * 10 + 10).join(' '))
    let page = pdf.addPage([595, 842])
    page.drawText('The long story of the harbour', { x: 60, y: 780, size: 22, font: bold })
    let y = 750
    for (const p of paragraphs) {
      if (y < 200) {
        page = pdf.addPage([595, 842])
        y = 780
      }
      y = paragraph(page, font, p, 60, y, 470, 11)
    }
    const bytes = new Uint8Array(await pdf.save())
    const slides = await slidesOf((await deckOf(bytes)).bytes)
    // One story: no contents slide; its words over several slides, in order, none lost or repeated.
    expect(slides.length).toBeGreaterThan(2)
    const shown = slides.map((s) => s.text.replace('The long story of the harbour', '')).join(' ')
    for (const [i, s] of sentences.entries()) expect(shown.indexOf(s), s).toBeGreaterThan(i ? shown.indexOf(sentences[i - 1]!) : -1)
    expect(shown.split('Sentence number').length - 1).toBe(60)
    // Every slide but the last ends at the end of a sentence; slides after the first repeat the headline small.
    for (const s of slides.slice(0, -1)) expect(s.text.trim()).toMatch(/harbour\.$/)
    expect(slides[1]!.xml).toContain('sz="1800"')
    // Opening: the first paragraph on the slide, the rest only in the notes.
    const opening = await slidesOf((await deckOf(bytes, 'opening')).bytes)
    expect(opening).toHaveLength(1)
    expect(opening[0]!.text).toContain('Sentence number 1 ')
    expect(opening[0]!.text).not.toContain('Sentence number 11 ')
    expect(opening[0]!.notes).toContain('Sentence number 60 ')
  })

  it('sets a guide page\'s short labels round a screenshot as bullets beside it', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const page = pdf.addPage([842, 595])
    page.drawText('HOME PAGE', { x: 40, y: 540, size: 22, font: bold })
    const png = await pdf.embedPng(makePng(120, 70, [40, 60, 160]))
    page.drawImage(png, { x: 300, y: 200, width: 480, height: 280 })
    const labels = ['Contact support for help', 'Click the catalog to explore the services', 'Scroll down to view more', 'Choose Arabic or English']
    labels.forEach((l, i) => page.drawText(l, { x: 40, y: 460 - i * 60, size: 11, font }))
    const slides = await slidesOf((await deckOf(new Uint8Array(await pdf.save()))).bytes)
    expect(slides).toHaveLength(1)
    const [s] = slides
    for (const l of labels) expect(s!.text).toContain(l)
    expect(s!.xml.match(/<a:buChar char="•"\/>/g)?.length).toBe(labels.length)
    // The screenshot is wide and the text short: it takes most of the slide, on the right.
    const pic = /<p:pic>.*?<a:off x="(\d+)" y="\d+"\/><a:ext cx="(\d+)"/.exec(s!.xml)!
    expect(Number(pic[2]) / 12700).toBeGreaterThan(400)
    expect(Number(pic[1]) / 12700).toBeGreaterThan(300)
  })

  it('sets Arabic right to left, the picture on the left, and an Arabic table as a right-to-left PowerPoint table', async () => {
    const pdf = await PDFDocument.create()
    const arabic = await embedFace(pdf, 'arabic')
    const page = pdf.addPage([595, 842])
    const head = 'الإمارات تطلق برنامجا جديدا للعلوم'
    page.drawText(head, { x: 535 - arabic.widthOfTextAtSize(head, 24), y: 770, size: 24, font: arabic })
    const body = 'أعلنت الدولة اليوم عن برنامج وطني جديد يربط التعليم بالصناعة ويدعم الابتكار في القطاعات الحيوية. وقال المسؤولون إن البرنامج سيبدأ العام المقبل في كل الجامعات.'
    let y = paragraph(page, arabic, body, 60, 730, 475, 12, true)
    y = paragraph(page, arabic, 'ويشمل البرنامج منحا للطلاب ومختبرات حديثة في كل إمارة.', 60, y, 475, 12, true)
    const png = await pdf.embedPng(makePng(60, 80))
    page.drawImage(png, { x: 60, y: y - 200, width: 150, height: 200 })
    // A ruled table: two columns, the first (logical) on the right.
    const top = y - 240
    const xs = [60, 300, 535]
    const ys = [top, top - 24, top - 48, top - 72]
    for (const yy of ys) page.drawLine({ start: { x: 60, y: yy }, end: { x: 535, y: yy }, thickness: 0.8, color: rgb(0, 0, 0) })
    for (const x of xs) page.drawLine({ start: { x, y: top }, end: { x, y: top - 72 }, thickness: 0.8, color: rgb(0, 0, 0) })
    const rows = [['الإمارة', 'عدد الطلاب'], ['دبي', 'ألفان'], ['الشارقة', 'ألف']]
    rows.forEach((row, r) =>
      row.forEach((c, k) => {
        const right = k === 0 ? 535 : 300
        page.drawText(c, { x: right - 8 - arabic.widthOfTextAtSize(c, 11), y: ys[r]! - 17, size: 11, font: arabic })
      })
    )
    const slides = await slidesOf((await deckOf(new Uint8Array(await pdf.save()))).bytes)
    const story = slides.find((s) => s.text.includes(head))!
    expect(story).toBeTruthy()
    expect(story.xml).toContain('rtl="1"')
    expect(story.xml).toContain('algn="r"')
    expect(story.xml).toContain('lang="ar-AE"')
    expect(story.text).toContain('يربط التعليم بالصناعة')
    // The text reads from the right; the picture stands on the left.
    const pic = /<p:pic>.*?<a:off x="(\d+)"/.exec(story.xml)!
    expect(Number(pic[1]) / 12700).toBeLessThan(200)
    const table = slides.find((s) => s.xml.includes('<a:tbl>'))!
    expect(table.xml).toContain('<a:tblPr firstRow="0" bandRow="0" rtl="1"/>')
    expect(table.text).toContain('الشارقة')
    expect(table.xml.match(/<a:tr /g)).toHaveLength(3)
  })

  it('gives a page title with only a line under it a section slide of its own', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    const opener = pdf.addPage([595, 842])
    opener.drawText('Part two', { x: 60, y: 600, size: 40, font: bold })
    opener.drawText('What the year brought', { x: 60, y: 560, size: 16, font: bold })
    const page = pdf.addPage([595, 842])
    page.drawText('Sales by region', { x: 60, y: 770, size: 20, font: bold })
    paragraph(page, font, LOREM_B, 60, 740, 470, 11)
    paragraph(page, font, LOREM_A, 60, 660, 470, 11)
    const slides = await slidesOf((await deckOf(new Uint8Array(await pdf.save()))).bytes)
    const section = slides.find((s) => s.text.includes('Part two') && !s.text.includes('Contents'))!
    expect(section.xml).toContain('<p:bg>')
    expect(section.text).toContain('What the year brought')
    expect(slides.find((s) => s.text.includes('Sales by region') && !s.text.includes('Contents'))!.xml).not.toContain('<p:bg>')
  })
})

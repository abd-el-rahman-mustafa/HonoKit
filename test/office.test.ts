import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { exportOffice, modelOf } from '@engine/office'
import type { ParagraphBlock } from '@engine/office/model'
import { mupdf } from '@engine/mupdf'
import { withoutUnmapped } from '@engine/text'
import { makePng } from './fixtures'

const BASE = { removeTatweel: true, digits: 'keep' as const, pageBreaks: false, pictureFolder: 'pictures' }

/** A two-page report: title, paragraph, bullets, a ruled table, a picture, Arabic text, a running footer. */
async function makeReport(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const arabic = await embedFace(pdf, 'arabic')
  const png = await pdf.embedPng(makePng(60, 40))
  for (let p = 1; p <= 2; p++) {
    const page = pdf.addPage([595, 842])
    page.drawText(`Page ${p} of 2`, { x: 270, y: 30, size: 9, font })
    if (p === 1) {
      page.drawText('Annual Report', { x: 60, y: 770, size: 26, font: bold })
      const body = ['This report describes the year. Revenue grew in every quarter', 'and the new office opened in Dubai in the spring of the year.']
      body.forEach((l, i) => page.drawText(l, { x: 60, y: 730 - i * 15, size: 11, font }))
      page.drawText('• First point about sales', { x: 60, y: 680, size: 11, font })
      page.drawText('• Second point about costs', { x: 60, y: 665, size: 11, font })
      // A ruled 3 × 2 table.
      const xs = [60, 200, 340, 480]
      const ys = [620, 600, 580]
      for (const y of ys) page.drawLine({ start: { x: 60, y }, end: { x: 480, y }, thickness: 0.8, color: rgb(0, 0, 0) })
      for (const x of xs) page.drawLine({ start: { x, y: 620 }, end: { x, y: 580 }, thickness: 0.8, color: rgb(0, 0, 0) })
      const cells = [['Region', 'Sales', 'Costs'], ['Dubai', '1,200', '800']]
      cells.forEach((row, r) => row.forEach((c, k) => page.drawText(c, { x: xs[k]! + 6, y: ys[r]! - 14, size: 10, font })))
      page.drawImage(png, { x: 60, y: 480, width: 120, height: 80 })
      const line = 'تقرير سنوي عن أداء الشركة في دبي'
      page.drawText(line, { x: 535 - arabic.widthOfTextAtSize(line, 14), y: 440, size: 14, font: arabic })
    } else {
      page.drawText('Second page text continues here.', { x: 60, y: 770, size: 11, font })
    }
  }
  return new Uint8Array(await pdf.save())
}

const paragraphs = (model: ReturnType<typeof modelOf>): ParagraphBlock[] => model.pages.flatMap((p) => p.blocks.filter((b): b is ParagraphBlock => b.kind === 'paragraph'))
const words = (b: ParagraphBlock): string => b.runs.map((r) => r.text).join('')

describe('PDF to Office: the model', () => {
  it('finds the heading, paragraph, list, table, picture, Arabic text and the running footer', async () => {
    const model = modelOf(await makeReport(), BASE)
    const paras = paragraphs(model)
    const title = paras.find((p) => words(p) === 'Annual Report')!
    expect(title.heading).toBe(1)
    expect(paras.find((p) => words(p).startsWith('This report'))!.heading).toBe(0)
    // Two lines joined into one flowing paragraph.
    expect(paras.some((p) => words(p).includes('every quarter and the new office'))).toBe(true)
    const bullets = paras.filter((p) => p.list === 'bullet')
    expect(bullets.map(words)).toEqual(['First point about sales', 'Second point about costs'])
    const table = model.pages[0]!.blocks.find((b) => b.kind === 'table')
    expect(table && table.kind === 'table' && table.rows.map((r) => r.map((c) => c.paragraphs.map(words).join(' ')))).toEqual([
      ['Region', 'Sales', 'Costs'],
      ['Dubai', '1,200', '800']
    ])
    expect(model.pages[0]!.blocks.some((b) => b.kind === 'picture')).toBe(true)
    const ar = paras.find((p) => p.rtl)!
    expect(words(ar)).toBe('تقرير سنوي عن أداء الشركة في دبي')
    expect(model.footer).toBe('Page {page} of 2')
    // The footer is not repeated as body text.
    expect(paras.some((p) => words(p).startsWith('Page '))).toBe(false)
    // Reading order: title first, the Arabic line after the table.
    const order = model.pages[0]!.blocks.map((b) => (b.kind === 'paragraph' ? words(b).slice(0, 6) : b.kind))
    expect(order[0]).toBe('Annual')
    expect(order.indexOf('table')).toBeLessThan(order.findIndex((o) => o.startsWith('تقرير')))
  })
})

describe('PDF to Office: the files', () => {
  it('writes Word with right-to-left paragraphs, a table, a picture and a page-number footer', async () => {
    const r = await exportOffice(await makeReport(), { ...BASE, format: 'docx' })
    const zip = await JSZip.loadAsync(r.bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Annual Report')
    expect(xml).toContain('<w:bidi/>')
    expect(xml).toContain('<w:rtl/>')
    expect(xml).toContain('تقرير سنوي')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('Region')
    expect(xml).toMatch(/<w:drawing>/)
    const footers = Object.keys(zip.files).filter((n) => /footer\d*\.xml$/.test(n))
    const footer = await zip.file(footers[0]!)!.async('string')
    expect(footer).toContain('PAGE')
    expect(r.tables).toBe(1)
  })

  it('writes PowerPoint with a slide per page', async () => {
    const r = await exportOffice(await makeReport(), { ...BASE, format: 'pptx' })
    const zip = await JSZip.loadAsync(r.bytes)
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    expect(slides).toHaveLength(2)
    const one = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(one).toContain('Annual Report')
    expect(one).toContain('rtl="1"')
    expect(one).toContain('<a:tbl>')
  })

  it('writes Markdown with a heading, a list, a table and the picture beside it', async () => {
    const r = await exportOffice(await makeReport(), { ...BASE, format: 'md' })
    const md = new TextDecoder().decode(r.bytes)
    expect(md).toContain('# Annual Report')
    expect(md).toContain('- First point about sales')
    expect(md).toContain('| Region | Sales | Costs |')
    expect(md).toContain('![](pictures/page1-1.png)')
    expect(r.extra.map((e) => e.name)).toEqual(['page1-1.png'])
    expect(md).toContain('<div dir="rtl">')
  })

  it('refuses a PDF with nothing to convert', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([200, 200])
    await expect(exportOffice(new Uint8Array(await pdf.save()), { ...BASE, format: 'txt' })).rejects.toThrow(/OCR/)
  })
})

describe('PDF to Excel', () => {
  it('reads numbers the way Excel needs them', async () => {
    const { asNumber } = await import('@engine/office/xlsx')
    expect(asNumber('1,200')).toEqual({ value: 1200, percent: false })
    expect(asNumber('١٬٢٠٠')).toEqual({ value: 1200, percent: false })
    expect(asNumber('12.5%')).toEqual({ value: 0.125, percent: true })
    expect(asNumber('(300)')).toEqual({ value: -300, percent: false })
    expect(asNumber('Dubai')).toBeNull()
  })

  it('makes a sheet per page with columns, and a sheet per ruled table', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([595, 842])
    // A borderless table: three columns far apart.
    const rows = [['Item', 'Qty', 'Price'], ['Paper', '10', '1,250'], ['Ink', '3', '75.5']]
    rows.forEach((r, i) => r.forEach((c, k) => page.drawText(c, { x: 60 + k * 150, y: 780 - i * 18, size: 11, font })))
    const bytes = new Uint8Array(await pdf.save())
    const ExcelJS = (await import('exceljs')).default
    const r = await exportOffice(bytes, { ...BASE, format: 'xlsx' })
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Buffer.from(r.bytes) as never)
    const sheet = book.worksheets[0]!
    expect(sheet.getCell(1, 1).value).toBe('Item')
    expect(sheet.getCell(2, 3).value).toBe(1250)
    expect(sheet.getCell(3, 3).value).toBe(75.5)
    const report = await exportOffice(await makeReport(), { ...BASE, format: 'xlsx', sheets: 'tables' })
    const tables = new ExcelJS.Workbook()
    await tables.xlsx.load(Buffer.from(report.bytes) as never)
    expect(tables.worksheets).toHaveLength(1)
    expect(tables.worksheets[0]!.getCell(2, 2).value).toBe(1200)
  })
})

describe('PDF to Office: text the file maps to nothing (§68)', () => {
  const UNMAPPED = String.fromCharCode(0xfffd)

  /**
   * A masthead line drawn in a font without a ToUnicode map (as some newspapers' fonts are):
   * readers get U+FFFD for every letter. A readable heading and line stay beside it.
   */
  async function makeUnmapped(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create()
    const latin = await pdf.embedFont(StandardFonts.Helvetica)
    const arabic = await embedFace(pdf, 'arabic')
    const page = pdf.addPage([500, 400])
    page.drawText('Readable heading', { x: 40, y: 340, size: 20, font: latin })
    const line = 'يومية سياسية مستقلة أسسها سنة'
    page.drawText(line, { x: 460 - arabic.widthOfTextAtSize(line, 18), y: 280, size: 18, font: arabic })
    page.drawText('The body text stays text.', { x: 40, y: 200, size: 12, font: latin })
    // A readable line with one word in the unmapped font: kept whole, as a picture.
    page.drawText('Diesel price 2.85', { x: 40, y: 150, size: 12, font: latin })
    page.drawText('ديزل', { x: 40 + latin.widthOfTextAtSize('Diesel price 2.85 ', 12), y: 150, size: 12, font: arabic })
    const doc = mupdf.Document.openDocument(new Uint8Array(await pdf.save()), 'application/pdf').asPDF()!
    try {
      doc.findPage(0).getInheritable('Resources').get('Font').forEach((value) => {
        const dict = value.resolve()
        if (dict.get('Subtype').toString() === '/Type0') dict.delete('ToUnicode')
      })
      return new Uint8Array(doc.saveToBuffer('').asUint8Array())
    } finally {
      doc.destroy()
    }
  }

  it('leaves the unreadable line out of the text and keeps it as a picture of the page', async () => {
    const bytes = await makeUnmapped()
    const raw = mupdf.Document.openDocument(bytes, 'application/pdf')
    // The fixture really is unreadable: MuPDF reads the masthead as U+FFFD.
    expect(raw.loadPage(0).toStructuredText('preserve-whitespace').asText()).toContain(UNMAPPED.repeat(5))
    raw.destroy()
    const model = modelOf(bytes, BASE)
    const texts = paragraphs(model).map(words)
    expect(texts).toContain('Readable heading')
    expect(texts.join(' ')).not.toContain(UNMAPPED)
    // The line's place on the page (baseline 280 from the bottom: about 105–125 from the top).
    const pictures = model.pages[0]!.blocks.filter((b) => b.kind === 'picture')
    expect(pictures.some((p) => p.box[1] < 110 && p.box[3] > 120 && p.box[2] > 455)).toBe(true)
    // The price line lost a word: it is a picture too, not "Diesel price 2.85" without it.
    expect(texts.some((t) => t.includes('Diesel'))).toBe(false)
    expect(pictures.some((p) => p.box[1] < 245 && p.box[3] > 250 && p.box[0] < 45)).toBe(true)
  })

  it('writes no U+FFFD into PowerPoint, Word, Markdown, text or Excel', async () => {
    const bytes = await makeUnmapped()
    for (const format of ['pptx', 'docx', 'md', 'txt', 'xlsx'] as const) {
      const r = await exportOffice(bytes, { ...BASE, format })
      let all = ''
      if (format === 'md' || format === 'txt') all = new TextDecoder().decode(r.bytes)
      else {
        const zip = await JSZip.loadAsync(r.bytes)
        for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml'))) all += await zip.file(name)!.async('string')
      }
      expect(all, format).not.toContain(UNMAPPED)
      expect(all, format).toContain('The body text stays text.')
      if (format !== 'xlsx' && format !== 'txt') expect(r.pictures, format).toBe(2)
    }
  })

  it('keeps an unreadable word in a ruled table as a picture in its cell', async () => {
    const pdf = await PDFDocument.create()
    const latin = await pdf.embedFont(StandardFonts.Helvetica)
    const arabic = await embedFace(pdf, 'arabic')
    const page = pdf.addPage([400, 300])
    // A ruled 2 × 3 table: Grade | Price, with the grade names in the unmapped font.
    const xs = [60, 200, 340]
    const ys = [250, 225, 200, 175]
    for (const y of ys) page.drawLine({ start: { x: 60, y }, end: { x: 340, y }, thickness: 0.8, color: rgb(0, 0, 0) })
    for (const x of xs) page.drawLine({ start: { x, y: 250 }, end: { x, y: 175 }, thickness: 0.8, color: rgb(0, 0, 0) })
    page.drawText('Grade', { x: 66, y: 233, size: 11, font: latin })
    page.drawText('Price', { x: 206, y: 233, size: 11, font: latin })
    page.drawText('ديزل', { x: 66, y: 208, size: 11, font: arabic })
    page.drawText('2.85', { x: 206, y: 208, size: 11, font: latin })
    page.drawText('سوبر', { x: 66, y: 183, size: 11, font: arabic })
    page.drawText('2.70', { x: 206, y: 183, size: 11, font: latin })
    page.drawText('Fuel prices this week.', { x: 60, y: 120, size: 11, font: latin })
    const doc = mupdf.Document.openDocument(new Uint8Array(await pdf.save()), 'application/pdf').asPDF()!
    let bytes: Uint8Array
    try {
      doc.findPage(0).getInheritable('Resources').get('Font').forEach((value) => {
        const dict = value.resolve()
        if (dict.get('Subtype').toString() === '/Type0') dict.delete('ToUnicode')
      })
      bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array())
    } finally {
      doc.destroy()
    }

    const model = modelOf(bytes, BASE)
    const table = model.pages[0]!.blocks.find((b) => b.kind === 'table')
    if (!table || table.kind !== 'table') throw new Error('no table found')
    expect(table.rows.map((r) => r.map((c) => c.paragraphs.map(words).join(' ')))).toEqual([
      ['Grade', 'Price'],
      ['', '2.85'],
      ['', '2.70']
    ])
    // Each grade is a picture in its own cell, inside the rules (60–200 across; 75–100 and 100–125 down).
    const [diesel, superGrade] = [table.rows[1]![0]!, table.rows[2]![0]!]
    expect(diesel.pictures).toHaveLength(1)
    expect(superGrade.pictures).toHaveLength(1)
    const box = diesel.pictures[0]!.box
    expect(box[0] > 60 && box[2] < 200 && box[1] > 75 && box[3] < 100, String(box)).toBe(true)
    // Nothing of the table is left as a page picture.
    expect(model.pages[0]!.blocks.filter((b) => b.kind === 'picture')).toHaveLength(0)

    const files: Record<string, string> = {}
    for (const format of ['pptx', 'docx', 'md', 'txt', 'xlsx'] as const) {
      const r = await exportOffice(bytes, { ...BASE, format })
      let all = ''
      if (format === 'md' || format === 'txt') all = new TextDecoder().decode(r.bytes)
      else {
        const zip = await JSZip.loadAsync(r.bytes)
        for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml'))) all += await zip.file(name)!.async('string')
      }
      expect(all, format).not.toContain(UNMAPPED)
      expect(all, format).toContain('2.85')
      if (format !== 'xlsx' && format !== 'txt') expect(r.pictures, format).toBe(2)
      files[format] = all
    }
    // Word: the pictures are inside the table; PowerPoint: over it; Markdown: in the cells.
    const tbl = files.docx!.slice(files.docx!.indexOf('<w:tbl>'), files.docx!.indexOf('</w:tbl>'))
    expect(tbl.match(/<w:drawing>/g)).toHaveLength(2)
    expect(files.pptx!.match(/<p:pic>/g)).toHaveLength(2)
    // The slide's rows keep the PDF's 25 pt, so the pictures over the table stay in their cells.
    expect(files.pptx!.match(/<a:tr h="(\d+)"/g)!.map((m) => Math.round(Number(m.match(/\d+/)![0]) / 12700))).toEqual([25, 25, 25])
    expect(files.md).toContain('| ![](pictures/page1-1.png) | 2.85 |')
  })

  it('drops a stray U+FFFD from a readable line', () => {
    expect(withoutUnmapped(`Total ${UNMAPPED} 1,250 AED`)).toBe('Total 1,250 AED')
    expect(withoutUnmapped('سنة 1970')).toBe('سنة 1970')
  })

  // The owner's papers, read where they are (never copied into the repo):
  //   POWERPDF_TEST_PDFS="a.pdf;b.pdf" npx vitest run test/office.test.ts
  const files = (process.env.POWERPDF_TEST_PDFS ?? '').split(';').map((f) => f.trim()).filter(Boolean)
  it.skipIf(files.length === 0)('writes no U+FFFD for real files (first three pages)', async () => {
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file))
      const count = mupdf.Document.openDocument(bytes, 'application/pdf')
      const pages = [0, 1, 2].filter((p) => p < count.countPages())
      count.destroy()
      for (const format of ['pptx', 'docx', 'md', 'txt'] as const) {
        const r = await exportOffice(bytes, { ...BASE, format, pages, removeTatweel: false })
        let all = ''
        if (format === 'md' || format === 'txt') all = new TextDecoder().decode(r.bytes)
        else {
          const zip = await JSZip.loadAsync(r.bytes)
          for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml'))) all += await zip.file(name)!.async('string')
        }
        expect(all.split(UNMAPPED).length - 1, `${file} ${format}`).toBe(0)
      }
    }
  }, 900_000)
})

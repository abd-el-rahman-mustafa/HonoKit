import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { exportOffice, modelOf } from '@engine/office'
import type { ParagraphBlock } from '@engine/office/model'
import { fromDingbats } from '@engine/dingbats'
import { mupdf } from '@engine/mupdf'
import { seatClusters, type Glyph } from '@engine/paragraphs'
import { clustersOf, joinPieces, readingOrder } from '@engine/readorder'

/**
 * Word "keep the look" and PowerPoint against what real files showed (2026-11-13): pictures
 * hidden under the page's background in Word, lines drifting in PowerPoint, bold lost from
 * Chrome's Type 3 fonts, bullets and icons, logos on black in flowing Word.
 */

const BASE = { removeTatweel: true, digits: 'keep' as const, pageBreaks: false, pictureFolder: 'pictures' }
const words = (b: ParagraphBlock): string => b.runs.map((r) => r.text).join('')
const paragraphsOf = (model: ReturnType<typeof modelOf>): ParagraphBlock[] => model.pages.flatMap((p) => p.blocks.filter((b): b is ParagraphBlock => b.kind === 'paragraph'))
const slide = async (bytes: Uint8Array): Promise<string> => (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string')

/** A Type 3 font of three letters, each a filled bar `stem` thousandths wide: thin is regular, thick is bold. */
function type3(stem: number, proc: number): string {
  return `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a ${proc} 0 R /b ${proc} 0 R /c ${proc} 0 R >> /Encoding << /Type /Encoding /Differences [97 /a /b /c] >> /FirstChar 97 /LastChar 99 /Widths [600 600 600] /Resources << >> >>`
}

/** As Chrome prints a web page: a heading and body text in Type 3 fonts whose names say nothing. */
function chromeLikePdf(): Uint8Array {
  const body = 'abc'.repeat(14)
  const content = ['BT /F2 16 Tf 20 250 Td (abcabcabc) Tj ET', ...[0, 1, 2].map((i) => `BT /F1 10 Tf 20 ${210 - i * 14} Td (${body}) Tj ET`)].join('\n')
  const glyph = (stem: number): string => `600 0 0 0 600 700 d1 0 0 ${stem} 700 re f`
  return pdfOf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    type3(60, 7),
    type3(220, 8),
    stream(content),
    stream(glyph(60)),
    stream(glyph(220))
  ])
}

const stream = (s: string): string => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`

/**
 * A glyph as MuPDF reads Chrome's Arabic: its letter, where it starts and its width — 0 for a
 * cluster's letters and marks, which come at the cluster's start, the mark first.
 */
const glyph = (cp: number, x: number, width: number): Glyph => ({
  c: String.fromCodePoint(cp),
  width,
  box: [x, 91, x + width, 103],
  origin: [x, 100],
  family: 'Segoe UI',
  font: 'SegoeUI',
  size: 9,
  colour: [0, 0, 0],
  bold: false,
  italic: false,
  kind: 'sans'
})

/** The pieces' text in reading order, clusters seated first (as styledLines reads them). */
function readPieces(pieces: Glyph[][]): string {
  const ps = pieces.map((glyphs) => ({ glyphs }))
  seatClusters(ps)
  return joinPieces(ps.map((p) => p.glyphs))
    .map((line) => readingOrder(clustersOf(line)).glyphs.map((g) => g.c).join(''))
    .join('|')
}

/** A PDF of these objects (1 0 R the catalog). */
function pdfOf(objects: string[]): Uint8Array {
  let pdf = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

describe('PDF to Office: keeping the look', () => {
  it('reads Zapf Dingbats letters as the symbols they draw', () => {
    expect(fromDingbats('u')).toBe(String.fromCodePoint(0x25c6))
    expect(fromDingbats('l')).toBe(String.fromCodePoint(0x25cf))
    expect(fromDingbats('3')).toBe(String.fromCodePoint(0x2713))
    expect(fromDingbats(String.fromCharCode(0xac))).toBe(String.fromCodePoint(0x2460))
    expect(fromDingbats(' ')).toBe(' ')
    expect(fromDingbats(String.fromCodePoint(0x25c6))).toBe(String.fromCodePoint(0x25c6))
  })

  it("seats Chrome's Arabic clusters: each letter before its mark, in its place, no space inside a word", () => {
    // Positions as MuPDF read them from a Chrome-printed credit note (9 pt Segoe UI).
    const ar = (...cps: number[]): string => String.fromCodePoint(...cps)
    // "لم تُنقل": the cluster starts 1 pt past the nun before it — the gap read as a word space ("تُ نقل").
    const left = [glyph(0x644, 296.5, 6), glyph(0x642, 302.5, 4.5), glyph(0x646, 307, 3)]
    const right = [glyph(0x20, 313, 2.5), glyph(0x645, 315.5, 5.3), glyph(0x644, 320.8, 3)]
    expect(readPieces([left, [glyph(0x64f, 311, 0), glyph(0x62a, 311, 0)], right])).toBe(ar(0x644, 0x645, 0x20, 0x62a, 0x64f, 0x646, 0x642, 0x644))
    // "أُعيد إلى": the cluster is the line's right end, nothing after it ("ُعأيد").
    const end = [glyph(0x649, 258.6, 7.5), glyph(0x644, 266.1, 3), glyph(0x625, 269.1, 2.3), glyph(0x20, 271.4, 2.5), glyph(0x62f, 273.8, 4.5), glyph(0x64a, 278.3, 3), glyph(0x639, 281.3, 5.3)]
    expect(readPieces([end, [glyph(0x64f, 286.9, 0), glyph(0x623, 286.9, 0)]])).toBe(ar(0x623, 0x64f, 0x639, 0x64a, 0x62f, 0x20, 0x625, 0x644, 0x649))
    // "عادةً": the cluster's width is a false space at its start, which goes.
    const cluster = [glyph(0x64b, 387.9, 0), glyph(0x629, 387.9, 0)]
    expect(readPieces([cluster, [glyph(0x62f, 391.4, 4.1), glyph(0x20, 387.9, 3.5)], [glyph(0x627, 395.5, 2.1)], [glyph(0x639, 397.6, 4.8)]])).toBe(ar(0x639, 0x627, 0x62f, 0x629, 0x64b))
    // A ligature's last letter at zero width where a real space starts ("في" in a font with that
    // ligature) is no cluster: the space stays ("الشركةيف").
    const yeh = glyph(0x64a, 397.4, 0)
    const ligature = [{ glyphs: [glyph(0x629, 400.7, 6.7), glyph(0x20, 397.4, 3.3), yeh, glyph(0x641, 387.3, 10.2)] }]
    seatClusters(ligature)
    expect(ligature[0]!.glyphs.map((g) => g.c).join('')).toBe(ar(0x629, 0x20, 0x64a, 0x641))
    expect(yeh.width).toBe(0)
  })

  it('finds bold in Type 3 fonts from their ink', () => {
    const model = modelOf(chromeLikePdf(), BASE)
    const paras = paragraphsOf(model)
    const heading = paras.find((p) => words(p) === 'abcabcabc')
    const body = paras.find((p) => words(p).startsWith('abcabcabcabcabc'))
    expect(heading?.runs[0]?.bold).toBe(true)
    expect(body?.runs.every((r) => !r.bold)).toBe(true)
  })

  it('puts Word pictures over the page background, in Word z-order', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(0.93, 0.95, 1) })
    page.drawImage(await pdf.embedPng(makeRgbaPng(40, 30)), { x: 50, y: 150, width: 80, height: 60 })
    for (let i = 0; i < 5; i++) page.drawText(`Line ${i + 1} of the page text.`, { x: 200, y: 250 - i * 14, size: 10, font })
    const r = await exportOffice(new Uint8Array(await pdf.save()), { ...BASE, format: 'docx' })
    const xml = await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')
    const heights = [...xml.matchAll(/relativeHeight="(\d+)"/g)].map((m) => Number(m[1]))
    expect(heights).toHaveLength(2)
    // With small values (1, 2) Word drew the background over the picture.
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(251658240)
    expect(heights[0]!).toBeLessThan(heights[1]!)
  })

  it('writes a PowerPoint paragraph as one wrapping box at its pitch, with valid paragraphs', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    // A 11.5 pt pitch: spacing as a share of the size (spcPct), which PowerPoint keeps to the hundredth.
    const lines = ['The first line of a paragraph runs', 'on to a second line and then a', 'third one, a fourth one after it,', 'and a fifth one ends it here now.']
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 250 - i * 11.5, size: 10, font, color: rgb(0, 0, 0) }))
    const xml = await slide((await exportOffice(new Uint8Array(await pdf.save()), { ...BASE, format: 'pptx' })).bytes)
    // One text box that wraps (an edit re-flows it), its lines one paragraph, 11.5 / (1.2 × 10).
    expect(xml.match(/<p:sp>/g)).toHaveLength(1)
    expect(xml).toContain('wrap="square"')
    expect(xml.match(/<a:p>/g)).toHaveLength(1)
    expect(xml).toContain('<a:spcPct val="95833"/>')
    // Placed at the left edge where it was printed (40 pt).
    expect(xml).toContain('<a:off x="508000"')
    // One paragraph-properties element per paragraph, first (pptxgenjs wrote one per run).
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      expect((p.match(/<a:pPr\b/g) ?? []).length).toBeLessThanOrEqual(1)
      if (p.includes('<a:pPr')) expect(p.startsWith('<a:p><a:pPr')).toBe(true)
    }
  })

  it('draws a bullet apart from its text, which starts where it was printed', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawText('Points to keep in mind:', { x: 60, y: 260, size: 11, font })
    page.drawText('•', { x: 62, y: 240, size: 11, font })
    page.drawText('First point about the sales of the year', { x: 80, y: 240, size: 11, font })
    page.drawText('•', { x: 62, y: 222, size: 11, font })
    page.drawText('Second point about the costs', { x: 80, y: 222, size: 11, font })
    const bytes = new Uint8Array(await pdf.save())
    const xml = await slide((await exportOffice(bytes, { ...BASE, format: 'pptx' })).bytes)
    // 80 pt from the left edge, in EMU: the text box starts where the text did, not at the bullet.
    expect(xml).toContain('<a:off x="1016000"')
    expect(xml).toMatch(/<a:t>•<\/a:t>/)
    // Flowing Word still sees a list.
    const flow = await (await JSZip.loadAsync((await exportOffice(bytes, { ...BASE, format: 'docx', layout: 'flow' })).bytes)).file('word/document.xml')!.async('string')
    expect(flow).toContain('<w:numPr>')
  })

  it('keeps an icon the file maps to nothing as a picture before its text', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const latin = await pdf.embedFont(StandardFonts.Helvetica)
    const arabic = await embedFace(pdf, 'arabic')
    page.drawText('A heading line for the page', { x: 40, y: 260, size: 14, font: latin })
    // The "icon": one letter of a font without a ToUnicode map, then the address.
    page.drawText('ب', { x: 40, y: 230, size: 11, font: arabic })
    page.drawText('office@example.com', { x: 54, y: 230, size: 11, font: latin })
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
    const r = await exportOffice(bytes, { ...BASE, format: 'pptx' })
    expect(r.pictures).toBe(1)
    const xml = await slide(r.bytes)
    expect(xml).toContain('office@example.com')
    expect(xml).toContain('<p:pic>')
    // The address's box starts at the address (54 pt), not at the icon (40 pt).
    const at = xml.indexOf('office@example.com')
    const off = [...xml.slice(0, at).matchAll(/<a:off x="(\d+)"/g)].pop()!
    expect(Number(off[1]) / 12700).toBeGreaterThan(52)
  })

  it('puts a transparent logo on white in flowing Word', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 300])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawImage(await pdf.embedPng(makeRgbaPng(40, 30)), { x: 40, y: 200, width: 80, height: 60 })
    page.drawText('Text under the logo of the company.', { x: 40, y: 170, size: 11, font })
    const r = await exportOffice(new Uint8Array(await pdf.save()), { ...BASE, format: 'docx', layout: 'flow' })
    const zip = await JSZip.loadAsync(r.bytes)
    const media = Object.keys(zip.files).find((n) => n.startsWith('word/media/') && n.endsWith('.png'))!
    const image = new mupdf.Image(await zip.file(media)!.async('uint8array'))
    const pixmap = image.toPixmap()
    try {
      const px = pixmap.getPixels()
      // MuPDF's count of components already includes alpha.
      const n = pixmap.getNumberOfComponents()
      // The left half was transparent: white, not black.
      const left = (Math.floor(pixmap.getHeight() / 2) * pixmap.getWidth() + 2) * n
      expect(px[left]! + px[left + 1]! + px[left + 2]!).toBeGreaterThan(740)
      // The right half is the logo's red.
      const right = (Math.floor(pixmap.getHeight() / 2) * pixmap.getWidth() + pixmap.getWidth() - 3) * n
      expect(px[right]!).toBeGreaterThan(150)
      expect(px[right + 1]!).toBeLessThan(90)
    } finally {
      pixmap.destroy()
      image.destroy()
    }
  })
})

/** A PNG whose left half is transparent (black underneath) and right half red. */
function makeRgbaPng(width: number, height: number): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true)
  const px = pixmap.getPixels()
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const opaque = x >= width / 2
      px[i] = opaque ? 200 : 0
      px[i + 1] = opaque ? 30 : 0
      px[i + 2] = opaque ? 30 : 0
      px[i + 3] = opaque ? 255 : 0
    }
  const png = new Uint8Array(pixmap.asPNG())
  pixmap.destroy()
  return png
}

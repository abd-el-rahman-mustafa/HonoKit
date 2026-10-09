import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import sharp from 'sharp'
import { PDFDocument, PDFName, StandardFonts, type PDFRef } from 'pdf-lib'
import { findToRedact } from '@engine/redact'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { keepPages } from '@engine/pages'
import { addWatermark } from '@engine/stamp'
import { writeDocx } from '@engine/office/docx'
import type { ParagraphBlock, TableBlock } from '@engine/office/model'
import { WatermarkOp } from '@shared/ops'
import { applyOperation } from '@ops/index'
import { makeLatinPdf } from './fixtures'

/** The colour of one pixel of page 1 rendered at 1:1, as [r, g, b]. */
function pixel(bytes: Uint8Array, x: number, y: number): number[] {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const o = (Math.round(y) * pm.getWidth() + Math.round(x)) * 3
    return [...pm.getPixels().subarray(o, o + 3)]
  } finally {
    free(doc)
  }
}

const isRed = (c: number[]): boolean => c[0]! > 200 && c[1]! < 80 && c[2]! < 80
const isBlue = (c: number[]): boolean => c[2]! > 200 && c[0]! < 80 && c[1]! < 80

/**
 * A phone photo stored sideways: 200 × 100 pixels, red on the left and blue on the right, with
 * EXIF orientation 6 (turn 90° clockwise to show). Upright it is 100 × 200, red on top.
 */
async function sidewaysPhoto(): Promise<Uint8Array> {
  const raw = Buffer.alloc(200 * 100 * 3)
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 200; x++) {
      const o = (y * 200 + x) * 3
      if (x < 100) raw[o] = 255
      else raw[o + 2] = 255
    }
  return new Uint8Array(await sharp(raw, { raw: { width: 200, height: 100, channels: 3 } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer())
}

describe('phone numbers are redacted whole', () => {
  it('takes international numbers with dots, a 00 prefix or many groups whole', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([500, 300])
    const lines = ['Call +1 555.987.6543 today', 'Office 0044 20 7946 0018', 'Fax +49.2151.123456', 'Desk +33 1 23 45 67 89 01 ext', 'Home +971 50 123 4567']
    lines.forEach((l, i) => page.drawText(l, { x: 20, y: 260 - i * 30, size: 12, font }))
    const doc = openPdf(new Uint8Array(await pdf.save()))
    try {
      const found = findToRedact(doc, { words: [], patterns: ['phone'], wholeWords: true }).map((h) => h.text)
      expect(found).toEqual(['+1 555.987.6543', '0044 20 7946 0018', '+49.2151.123456', '+33 1 23 45 67 89 01', '+971 50 123 4567'])
    } finally {
      free(doc)
    }
  })

  it('still leaves dates, decimals and short numbers alone', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([500, 100]).drawText('On 01.10.2026 the ratio was 0.1234567 for item 12 345', { x: 20, y: 50, size: 12, font })
    const doc = openPdf(new Uint8Array(await pdf.save()))
    try {
      expect(findToRedact(doc, { words: [], patterns: ['phone'], wholeWords: true })).toEqual([])
    } finally {
      free(doc)
    }
  })
})

describe('phone photos are placed upright', () => {
  it('adds a picture stored sideways the way it was taken', async () => {
    const photo = await sidewaysPhoto()
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'addPicture', page: 0, rect: [100, 100, 200, 300], source: { data: Buffer.from(photo).toString('base64') } })
    expect(isRed(pixel(bytes, 150, 130))).toBe(true)
    expect(isBlue(pixel(bytes, 150, 270))).toBe(true)
  })

  it('uses a picture stored sideways as an upright watermark', async () => {
    const src = await makeLatinPdf(1)
    const doc = openPdf(src)
    const [, , w, h] = doc.loadPage(0).getBounds()
    free(doc)
    const op = WatermarkOp.parse({ op: 'watermark', imagePath: 'photo.jpg', rotation: 0, opacity: 1, imageScale: 0.3, position: 'center' })
    const { bytes } = await addWatermark(src, op, await sidewaysPhoto())
    // Upright the picture is twice as tall as it is wide: red above the middle, blue below.
    const width = w * 0.3
    expect(isRed(pixel(bytes, w / 2, h / 2 - width * 0.6))).toBe(true)
    expect(isBlue(pixel(bytes, w / 2, h / 2 + width * 0.6))).toBe(true)
  })
})

describe('hostile page label trees', () => {
  it('rearranges pages quickly when the label tree repeats the same branch', async () => {
    const pdf = await PDFDocument.load(await makeLatinPdf(3))
    const ctx = pdf.context
    // Each level lists the level below 40 times: walked naively, that is 40^8 leaves.
    let node: PDFRef = ctx.register(ctx.obj({ Nums: [0, { S: 'r' }] }))
    for (let level = 0; level < 8; level++) node = ctx.register(ctx.obj({ Kids: Array.from({ length: 40 }, () => node) }))
    pdf.catalog.set(PDFName.of('PageLabels'), node)
    const bytes = new Uint8Array(await pdf.save())
    const started = Date.now()
    const out = keepPages(bytes, [1, 0])
    expect(Date.now() - started).toBeLessThan(5000)
    const doc = openPdf(out)
    try {
      expect(doc.countPages()).toBe(2)
      expect(doc.getTrailer().get('Root').get('PageLabels').isNull()).toBe(false)
    } finally {
      free(doc)
    }
  }, 20000)
})

describe('Word export', () => {
  it('writes a table wider than Word allows (63 columns) as text', async () => {
    const run = (text: string): ParagraphBlock => ({
      kind: 'paragraph',
      box: [0, 0, 10, 10],
      runs: [{ text, size: 8, colour: [0, 0, 0], bold: false, italic: false, kind: 'sans', family: 'Helvetica', font: 'Helvetica' }],
      rtl: false,
      alignment: 'start',
      heading: 0,
      list: null,
      marker: '',
      lineHeight: 1.2,
      firstIndent: 0
    })
    const wide = (n: number): TableBlock => ({
      kind: 'table',
      box: [10, 10, 10 + n * 8, 40],
      columns: Array.from({ length: n }, () => 8),
      rowHeights: [15, 15],
      rows: [0, 1].map((r) => Array.from({ length: n }, (_, c) => ({ paragraphs: [run(`r${r}c${c}`)], pictures: [], span: 1 }))),
      rtl: false
    })
    const xml = async (n: number): Promise<string> => {
      const docx = await writeDocx({ pages: [{ width: 1200, height: 800, blocks: [wide(n)], rtl: false }], header: null, footer: null, bodySize: 8 }, { pageBreaks: false })
      return (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')
    }
    expect(await xml(63)).toContain('<w:tbl>')
    const tooWide = await xml(70)
    expect(tooWide).not.toContain('<w:tbl>')
    expect(tooWide).toContain('r0c0')
    expect(tooWide).toContain('r1c69')
  })
})

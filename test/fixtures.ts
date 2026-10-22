import { existsSync, readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { mupdf } from '@engine/mupdf'

/**
 * Test documents, generated here rather than checked in: nothing in the suite
 * depends on anyone's real files (docs/arabic.md — corpus policy).
 */

export interface LatinOptions {
  width?: number
  height?: number
  /** /Rotate value for every page. */
  rotate?: 0 | 90 | 180 | 270
}

/** Pages that say "Page N" and carry a word unique to that page ("Marker3"). */
export async function makeLatinPdf(pageCount: number, options: LatinOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pageCount; i++) {
    const page = pdf.addPage([options.width ?? 400, options.height ?? 600])
    page.drawText(`Page ${i}`, { x: 40, y: (options.height ?? 600) - 80, size: 28, font })
    page.drawText(`Marker${i}`, { x: 40, y: (options.height ?? 600) - 130, size: 16, font })
    if (options.rotate) page.setRotation(degrees(options.rotate))
  }
  pdf.setTitle('Fixture')
  return new Uint8Array(await pdf.save())
}

/** Arabic lines drawn with shaping, including ligature glyphs (lam-alef, lam-yeh) that expose the extraction bug. */
export async function makeArabicPdf(lines: string[] = ['على الطاولة كتاب', 'محمد بن زايد يستقل قطار الاتحاد من أبوظبي إلى دبي', 'مرحبا بالعالم']): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await embedFace(pdf, 'arabic')
  const page = pdf.addPage([500, 400])
  lines.forEach((line, i) => {
    const width = font.widthOfTextAtSize(line, 20)
    page.drawText(line, { x: 470 - width, y: 340 - i * 40, size: 20, font })
  })
  return new Uint8Array(await pdf.save())
}

/** A JPEG full of noise so it compresses badly at high quality and well after recompression. */
export function makeNoiseJpeg(width: number, height: number, quality = 98): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)
  const px = pixmap.getPixels()
  let seed = 12345
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const o = (y * width + x) * 3
      px[o] = (x * 255) / width + ((seed >> 8) & 31)
      px[o + 1] = (y * 255) / height + ((seed >> 16) & 31)
      px[o + 2] = 128 + ((seed >> 24) & 63)
    }
  }
  const jpeg = new Uint8Array(pixmap.asJPEG(quality))
  pixmap.destroy()
  return jpeg
}

export function makePng(width: number, height: number, colour: [number, number, number] = [200, 30, 30]): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)
  const px = pixmap.getPixels()
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = colour[0]
    px[i * 3 + 1] = colour[1]
    px[i * 3 + 2] = colour[2]
  }
  const png = new Uint8Array(pixmap.asPNG())
  pixmap.destroy()
  return png
}

/** One page carrying a large photograph-like image. */
export async function makeImagePdf(imagePx = 2400): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const jpeg = await pdf.embedJpg(makeNoiseJpeg(imagePx, imagePx))
  const page = pdf.addPage([600, 600])
  page.drawImage(jpeg, { x: 0, y: 0, width: 600, height: 600 })
  page.drawRectangle({ x: 20, y: 20, width: 50, height: 50, color: rgb(1, 1, 1) })
  return new Uint8Array(await pdf.save())
}

const SYSTEM_ARABIC_FONTS = [
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf'
]

/**
 * A system font whose Arabic ligature glyphs map to two letters in the wrong
 * order: what typesetting software's fonts do, and what triggers the MuPDF bug.
 * Not redistributable, so never bundled; tests that need it skip when it is absent.
 */
export function systemArabicFont(): Uint8Array | null {
  const path = SYSTEM_ARABIC_FONTS.find((p) => existsSync(p))
  return path ? new Uint8Array(readFileSync(path)) : null
}

export async function makeLigatureBugPdf(lines: string[]): Promise<Uint8Array | null> {
  const bytes = systemArabicFont()
  if (!bytes) return null
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(bytes, { subset: true })
  const page = pdf.addPage([500, 400])
  lines.forEach((line, i) => {
    const width = font.widthOfTextAtSize(line, 20)
    page.drawText(line, { x: 470 - width, y: 340 - i * 40, size: 20, font })
  })
  return new Uint8Array(await pdf.save())
}

/** Pages with a text field on page 1 and a bookmark to each page. */
export async function makeFormWithBookmarks(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await makeLatinPdf(pageCount))
  const form = pdf.getForm()
  const field = form.createTextField('customerName')
  field.setText('Aisha')
  field.addToPage(pdf.getPage(0), { x: 40, y: 300, width: 200, height: 24 })
  const bytes = new Uint8Array(await pdf.save())
  // Bookmarks through MuPDF, which pdf-lib has no API for.
  const doc = new mupdf.PDFDocument(bytes)
  const it = doc.outlineIterator()
  for (let i = 0; i < pageCount; i++) it.insert({ title: `Chapter ${i + 1}`, uri: doc.formatLinkURI({ chapter: 0, page: i, type: 'Fit', x: 0, y: 0, width: 0, height: 0, zoom: 0 }), open: false })
  const out = new Uint8Array(doc.saveToBuffer('compress').asUint8Array())
  doc.destroy()
  return out
}

/**
 * Encrypted with no open password and a permissions password: the "restricted" PDF
 * that opens for anyone but forbids changes. Two of the owner's real files are like this.
 */
export async function makeRestrictedPdf(pageCount: number, allow: { edit?: boolean; assemble?: boolean; copy?: boolean; printHq?: boolean } = {}, ownerPassword = 'owner-secret'): Promise<Uint8Array> {
  const doc = new mupdf.PDFDocument(await makeLatinPdf(pageCount))
  // Print, high-quality print (bit 12, unless printHq: false) and copy (bit 5, unless copy: false)
  // allowed; edit (bit 4) and assemble (bit 11) only when asked.
  let p = 0xfffff0c0 | 4
  if (allow.printHq !== false) p |= 2048
  if (allow.copy !== false) p |= 16
  if (allow.edit) p |= 8
  if (allow.assemble) p |= 1024
  const out = new Uint8Array(doc.saveToBuffer(`encrypt=aes-256,user-password=,owner-password=${ownerPassword},permissions=${p | 0}`).asUint8Array())
  doc.destroy()
  return out
}

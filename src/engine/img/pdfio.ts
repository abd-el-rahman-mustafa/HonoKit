import { PDFDocument } from 'pdf-lib'
import { BRAND } from '@shared/brand'
import { free, mupdf } from '../mupdf'
import type { RgbaFrame } from './magick'

/**
 * PDF as a picture format for the image tools: a page in (MuPDF, as everywhere in the app), a
 * picture out as a one-page PDF (pdf-lib only draws a new file here; it never parses a person's
 * PDF, decisions §22). Images to PDF with layout options remains its own tool (engine/images.ts).
 */

export function pdfPageCount(bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  try {
    return doc.countPages()
  } finally {
    free(doc)
  }
}

/** One page as RGBA pixels at `dpi`, transparent where the page has nothing. */
export function renderPdfPage(bytes: Uint8Array, page: number, dpi: number): RgbaFrame {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  try {
    const p = doc.loadPage(Math.min(Math.max(0, page), doc.countPages() - 1))
    const pix = p.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, true, true)
    const frame = { data: new Uint8Array(pix.getPixels()), width: pix.getWidth(), height: pix.getHeight(), delay: 0 }
    free(pix, p)
    return frame
  } finally {
    free(doc)
  }
}

/** A JPEG as a one-page PDF, the page the picture's size at `dpi`. */
export async function pdfOfJpeg(jpeg: Uint8Array, width: number, height: number, dpi = 96): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setProducer(BRAND.name)
  doc.setCreator(BRAND.name)
  const image = await doc.embedJpg(jpeg)
  const w = (width * 72) / dpi
  const h = (height * 72) / dpi
  doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h })
  return Buffer.from(await doc.save())
}

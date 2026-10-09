import { PdfError } from './errors'
import { free, mupdf, newPdf, openPdf, saveBytes, SAVE_FINAL } from './mupdf'
import { renderPage, type RenderedPage } from './render'
import { exifOrientation, orientationTurn } from '@shared/exif'

export type PaperSize = 'fit' | 'a4' | 'letter'

const PAPER: Record<Exclude<PaperSize, 'fit'>, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] }

export interface ImagesToPdfOptions {
  paper: PaperSize
  /** Points of white border around the picture. */
  margin: number
  /** With a fixed paper size: turn the page to match a landscape picture. */
  autoOrientation: boolean
  /** With a fixed paper size: always portrait or landscape (overrides autoOrientation). */
  orientation?: 'auto' | 'portrait' | 'landscape'
  /** Degrees clockwise for each picture, in order (0, 90, 180, 270). */
  rotations?: number[]
}

/**
 * The drawing matrix that puts a picture, turned `rotate` degrees clockwise, into the box
 * at (x, y) of w × h points (the box as seen, after turning).
 */
function placement(rotate: number, x: number, y: number, w: number, h: number): number[] {
  switch (rotate) {
    case 90:
      return [0, -h, w, 0, x, y + h]
    case 180:
      return [-w, 0, 0, -h, x + w, y + h]
    case 270:
      return [0, h, -w, 0, x + w, y]
    default:
      return [w, 0, 0, h, x, y]
  }
}

/** One picture per page. JPEG data is embedded as it is, not re-encoded. */
export function imagesToPdf(images: Uint8Array[], options: ImagesToPdfOptions): Uint8Array {
  if (images.length === 0) throw new PdfError('bad-arguments', 'No pictures were given.')
  const doc = newPdf()
  try {
    for (const [i, bytes] of images.entries()) {
      let image: mupdf.Image
      try {
        image = new mupdf.Image(bytes)
      } catch {
        throw new PdfError('unsupported', `Picture ${i + 1} could not be read. Use PNG, JPEG, GIF, BMP or TIFF.`)
      }
      const pxW = image.getWidth()
      const pxH = image.getHeight()
      const xRes = image.getXResolution() || 96
      const yRes = image.getYResolution() || 96
      // Natural size in points, treating unknown resolution as 96 dpi and capping absurd sizes.
      // A phone photo stored sideways (EXIF orientation) is placed as the photo was taken, as its preview shows it (§61).
      const rotate = (((options.rotations?.[i] ?? 0) + orientationTurn(exifOrientation(bytes))) % 360 + 360) % 360
      const turned = rotate === 90 || rotate === 270
      const rawW = Math.min(14000, (pxW * 72) / (xRes > 1 ? xRes : 96))
      const rawH = Math.min(14000, (pxH * 72) / (yRes > 1 ? yRes : 96))
      // The picture as it will be seen: a quarter turn swaps its sides.
      const natW = turned ? rawH : rawW
      const natH = turned ? rawW : rawH
      const wide = natW > natH

      let pageW: number
      let pageH: number
      if (options.paper === 'fit') {
        pageW = natW + options.margin * 2
        pageH = natH + options.margin * 2
      } else {
        ;[pageW, pageH] = PAPER[options.paper]
        const orientation = options.orientation ?? (options.autoOrientation ? 'auto' : 'portrait')
        if (orientation === 'landscape' || (orientation === 'auto' && wide)) [pageW, pageH] = [pageH, pageW]
      }
      const boxW = Math.max(10, pageW - options.margin * 2)
      const boxH = Math.max(10, pageH - options.margin * 2)
      const scale = options.paper === 'fit' ? 1 : Math.min(boxW / natW, boxH / natH)
      const drawW = natW * scale
      const drawH = natH * scale
      const x = (pageW - drawW) / 2
      const y = (pageH - drawH) / 2

      const imageObj = doc.addImage(image)
      const resources = doc.newDictionary()
      const xobjects = doc.newDictionary()
      xobjects.put('Im0', imageObj)
      resources.put('XObject', xobjects)
      const m = placement(rotate, x, y, drawW, drawH)
      const page = doc.addPage([0, 0, pageW, pageH], 0, resources, `q ${m.map((v) => v.toFixed(3)).join(' ')} cm /Im0 Do Q`)
      doc.insertPage(-1, page)
      free(image)
    }
    return saveBytes(doc, SAVE_FINAL)
  } finally {
    free(doc)
  }
}

export interface PageImage extends RenderedPage {
  page: number
}

/** Renders pages to pictures at a resolution in dpi. */
export function pdfToImages(bytes: Uint8Array, pages: number[] | undefined, format: 'png' | 'jpeg', dpi: number, password?: string, onPage?: (done: number, total: number) => void, annotations: boolean | 'print' | 'print-none' = true): PageImage[] {
  // Printing (P7): 'print' draws annotations as printed, 'print-none' leaves them out; both use print rules for layers.
  const shown = annotations === 'print-none' ? false : annotations
  const print = annotations === 'print' || annotations === 'print-none'
  const doc = openPdf(bytes, password)
  try {
    const count = doc.countPages()
    const list = pages ?? Array.from({ length: count }, (_, i) => i)
    const out: PageImage[] = []
    for (const [k, index] of list.entries()) {
      if (index < 0 || index >= count) throw new PdfError('bad-arguments', `Page ${index + 1} does not exist (the document has ${count}).`)
      out.push({ page: index, ...renderPage(doc, index, { scale: dpi / 72, format, quality: 92, annotations: shown, print }) })
      onPage?.(k + 1, list.length)
    }
    return out
  } finally {
    free(doc)
  }
}

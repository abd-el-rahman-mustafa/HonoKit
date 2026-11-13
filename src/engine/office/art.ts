import { free, mupdf, type PdfDoc } from '../mupdf'
import { safeRedact } from '../saferedact'
import type { Box, PictureBlock } from './model'

/**
 * The page's artwork without its text (research §6.2 "layout"): what PowerPoint and Word's
 * "keep the look" layout put behind the editable text — boxes, rules, shading, logos and charts
 * drawn as vectors, which a converter of text alone loses (an invoice without its lines and logo, a
 * chart reduced to its axis numbers). The text is removed with MuPDF's redaction on the
 * converter's own copy of the file, so nothing a person sees in the PDF but the letters goes missing.
 *
 * Pictures come from the same text-free drawing, cut at their place: they keep their clipping,
 * soft masks and what shows through them, and they stay movable. The background under them is
 * drawn again without pictures, so moving one does not show it twice.
 */

/** Background resolution: 150 dpi. */
const BACKGROUND = 150 / 72

function draw(doc: PdfDoc, pageIndex: number, box: Box, scale: number): mupdf.Pixmap {
  const page = doc.loadPage(pageIndex)
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.floor(box[0] * scale), Math.floor(box[1] * scale), Math.ceil(box[2] * scale), Math.ceil(box[3] * scale)], false)
  const device = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pixmap)
  try {
    pixmap.clear(255)
    page.run(device, mupdf.Matrix.identity)
    device.close()
    return pixmap
  } catch (error) {
    free(pixmap)
    throw error
  } finally {
    free(device, page)
  }
}

/**
 * Blank (no drawing left) and photographic (many distinct colours, sampled). Every pixel is looked
 * at for ink: a page whose only drawings are a table's thin rules is mostly white, and a sample
 * every few rows missed the rules and dropped them.
 */
function look(pixmap: mupdf.Pixmap): { blank: boolean; photo: boolean } {
  const px = pixmap.getPixels()
  const n = pixmap.getNumberOfComponents() + (pixmap.getAlpha() ? 1 : 0)
  const w = pixmap.getWidth()
  const h = pixmap.getHeight()
  let inked = 0
  // Drawn on pure white: pale shading (a table header, a tinted box) is ink too.
  for (let i = 0; i < w * h * n && inked < 24; i += n) if (px[i]! < 250 || px[i + 1]! < 250 || px[i + 2]! < 250) inked++
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)))
  const colours = new Set<number>()
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * n
      colours.add(((px[i]! >> 3) << 10) | ((px[i + 1]! >> 3) << 5) | (px[i + 2]! >> 3))
    }
  return { blank: inked < 24, photo: colours.size > 400 }
}

function asPicture(pixmap: mupdf.Pixmap, box: Box, photo: boolean): PictureBlock {
  return { kind: 'picture', box, data: photo ? pixmap.asJPEG(88) : pixmap.asPNG(), type: photo ? 'jpg' : 'png', width: pixmap.getWidth(), height: pixmap.getHeight() }
}

export interface PageArt {
  /** The page's drawings without text or pictures; null when there are none. */
  background: PictureBlock | null
  /** Each picture as drawn on the page, in the order of `pictures` given. */
  pictures: Array<PictureBlock | null>
}

/**
 * Text-free artwork of one page. CHANGES THE DOCUMENT (its text and then its pictures are
 * removed): call it last, on a document opened for the conversion only.
 * `pictures` are the boxes of the page's pictures with the pixels each has (to draw them as sharp).
 */
export function pageArt(doc: PdfDoc, pageIndex: number, width: number, height: number, pictures: Array<{ box: Box; pixels: number }>): PageArt {
  const whole: Box = [0, 0, width, height]
  safeRedact(doc, pageIndex, [[-2, -2, width + 2, height + 2]], { text: 'remove', images: 'keep', lineArt: 'keep' })
  const drawn = pictures.map(({ box, pixels }) => {
    const b: Box = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(width, box[2]), Math.min(height, box[3])]
    if (b[2] - b[0] < 2 || b[3] - b[1] < 2) return null
    // As sharp as the picture itself, within reason.
    const scale = Math.min(4, Math.max(BACKGROUND, Math.sqrt(pixels / ((b[2] - b[0]) * (b[3] - b[1])))))
    let pixmap: mupdf.Pixmap | null = null
    try {
      pixmap = draw(doc, pageIndex, b, scale)
      return asPicture(pixmap, b, look(pixmap).photo)
    } catch {
      return null
    } finally {
      free(pixmap)
    }
  })
  let background: PictureBlock | null = null
  let pixmap: mupdf.Pixmap | null = null
  try {
    // Only the pictures given come out (a background picture under them stays); boxes a point
    // inside theirs, so a neighbouring picture they touch is not taken too.
    const boxes = pictures.map(({ box }): Box => [box[0] + 1, box[1] + 1, box[2] - 1, box[3] - 1]).filter((b) => b[2] > b[0] && b[3] > b[1])
    if (boxes.length) safeRedact(doc, pageIndex, boxes, { text: 'keep', images: 'remove', lineArt: 'keep' })
    pixmap = draw(doc, pageIndex, whole, BACKGROUND)
    const seen = look(pixmap)
    if (!seen.blank) background = asPicture(pixmap, whole, seen.photo)
  } catch {
    background = null
  } finally {
    free(pixmap)
  }
  return { background, pictures: drawn }
}

/**
 * A region of the page as drawn, text included (a chart with its labels, for flowing Word).
 * Read-only: call before `pageArt` changes the page.
 */
export function regionPicture(doc: PdfDoc, pageIndex: number, box: Box): PictureBlock | null {
  let pixmap: mupdf.Pixmap | null = null
  try {
    pixmap = draw(doc, pageIndex, box, 200 / 72)
    const seen = look(pixmap)
    return seen.blank ? null : asPicture(pixmap, box, seen.photo)
  } catch {
    return null
  } finally {
    free(pixmap)
  }
}

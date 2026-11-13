import { free, mupdf, type PdfDoc } from '../mupdf'
import { replayPixmap, replaySvg } from './drawings'
import type { Box, PictureBlock } from './model'
import type { ArtRegion, PlacedImage } from './scene'

/**
 * Pictures of parts of a page (decisions §118): a piece of art the scene found (a logo, a chart, a
 * gradient, a cover's decoration) drawn alone — just its drawings, on a transparent ground, so
 * what lies behind it shows through as on the page — as SVG when it is plain vectors, with a PNG
 * for Office without SVG; a picture of the page drawn as the page shows it (clipped, masked,
 * turned); and, for flowing writers, a region drawn with its labels.
 *
 * The page is no longer one picture behind the text (research §10: the main reason the output
 * looked like a scan): drawings Office can draw are shapes, and only these are pictures.
 */

/** A picture is drawn no sharper than 216 dpi (3 pixels a point): Office's own "high fidelity" is 220. */
const SHARPEST_PICTURE = 3
/** Pixels a picture may have (a page-wide piece of art at 3× is about 8 million). */
const MOST_PIXELS = 12_000_000
/** Pixels above which an opaque picture may be a JPEG though it has few colours. */
const BIG_PICTURE = 1_000_000
/** An SVG larger than this is left out (Office is slow with it): the PNG alone. */
const MOST_SVG = 2_000_000

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
 * Blank (no ink, or nothing opaque) and photographic (many distinct colours, sampled). Every pixel
 * is looked at for ink: a region whose only drawings are thin rules is mostly empty.
 */
function look(pixmap: mupdf.Pixmap): { blank: boolean; photo: boolean; opaque: boolean } {
  const px = pixmap.getPixels()
  const alpha = pixmap.getAlpha() > 0
  // MuPDF's "number of components" already counts alpha (adding it again read a picture on a
  // transparent ground five bytes a pixel: a dashboard screenshot was neither opaque nor a photo).
  const n = pixmap.getNumberOfComponents()
  const stride = pixmap.getStride()
  const w = pixmap.getWidth()
  const h = pixmap.getHeight()
  let inked = 0
  let clear = 0
  for (let y = 0; y < h; y++)
    for (let i = y * stride, end = i + w * n; i < end; i += n) {
      const a = alpha ? px[i + n - 1]! : 255
      if (a < 250) clear++
      // Ink: anything visible that is not white (pale shading counts).
      if (inked < 24 && a > 8 && (px[i]! < 250 || px[i + 1]! < 250 || px[i + 2]! < 250 || alpha)) inked++
    }
  // Opaque but for its edge pixels, half covered where the box falls between pixels.
  const opaque = clear <= 2 * (w + h) + 4
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)))
  const colours = new Set<number>()
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const i = y * stride + x * n
      colours.add(((px[i]! >> 3) << 10) | ((px[i + 1]! >> 3) << 5) | (px[i + 2]! >> 3))
    }
  return { blank: inked < 24, photo: colours.size > 400, opaque }
}

/**
 * The picture on white, with no alpha (a JPEG has none). MuPDF will not just drop the alpha
 * ("cannot drop alpha when converting pixmap"), and a picture seen as a photo was left out.
 */
function onWhite(pixmap: mupdf.Pixmap): mupdf.Pixmap {
  const w = pixmap.getWidth()
  const h = pixmap.getHeight()
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const image = new mupdf.Image(pixmap)
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, out)
  try {
    out.clear(255)
    device.fillImage(image, [w, 0, 0, h, 0, 0], 1)
    device.close()
    return out
  } catch (error) {
    free(out)
    throw error
  } finally {
    free(device, image)
  }
}

function asPicture(pixmap: mupdf.Pixmap, box: Box, photo: boolean): PictureBlock {
  return { kind: 'picture', box, data: photo ? pixmap.asJPEG(88) : pixmap.asPNG(), type: photo ? 'jpg' : 'png', width: pixmap.getWidth(), height: pixmap.getHeight() }
}

/** A scale within reason: at least `least`, at most 4, and no more than MOST_PIXELS pixels. */
function scaleFor(box: Box, wanted: number, least: number): number {
  const area = Math.max(1, (box[2] - box[0]) * (box[3] - box[1]))
  return Math.max(0.5, Math.min(4, Math.max(least, wanted), Math.sqrt(MOST_PIXELS / area)))
}

/**
 * Drawn calls as a picture: on a transparent ground (PNG), or a JPEG when it is an opaque photo.
 * Null when nothing shows.
 */
function replayed(doc: PdfDoc, pageIndex: number, calls: number[], box: Box, scale: number): PictureBlock | null {
  let pixmap: mupdf.Pixmap | null = null
  let flat: mupdf.Pixmap | null = null
  try {
    pixmap = replayPixmap(doc, pageIndex, new Set(calls), box, scale)
    const seen = look(pixmap)
    if (seen.blank) return null
    if (seen.photo && seen.opaque) {
      flat = onWhite(pixmap)
      return asPicture(flat, box, true)
    }
    const png = asPicture(pixmap, box, false)
    // A big opaque picture with few colours (a page-high dashboard screenshot): a JPEG when it is far
    // smaller — 3.6 MB as PNG against the file's own 1.4 MB JPEG made a 9 MB document.
    if (seen.opaque && pixmap.getWidth() * pixmap.getHeight() > BIG_PICTURE) {
      flat = onWhite(pixmap)
      const jpeg = asPicture(flat, box, true)
      if (jpeg.data.length < png.data.length * 0.5) return jpeg
    }
    return png
  } catch {
    return null
  } finally {
    free(flat, pixmap)
  }
}

/** A piece of art: SVG (with its PNG) when it is plain vectors, else a picture at 3× (more when it holds a sharper picture). */
export function artPicture(doc: PdfDoc, pageIndex: number, art: ArtRegion): PictureBlock | null {
  const box = art.box
  if (box[2] - box[0] < 0.5 || box[3] - box[1] < 0.5) return null
  const picture = replayed(doc, pageIndex, art.calls, box, scaleFor(box, 3, 2))
  if (!picture) return null
  picture.order = art.order
  if (art.vector) {
    const svg = replaySvg(doc, pageIndex, new Set(art.calls), box)
    if (svg && svg.length <= MOST_SVG) picture.svg = new TextEncoder().encode(svg)
  }
  return picture
}

/** A picture of the page as the page shows it, as sharp as its own pixels (within reason). */
export function placedPicture(doc: PdfDoc, pageIndex: number, image: PlacedImage, width: number, height: number): PictureBlock | null {
  const b = image.box
  const box: Box = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(width, b[2]), Math.min(height, b[3])]
  if (box[2] - box[0] < 2 || box[3] - box[1] < 2) return null
  // Its pixels spread over its whole box (part of it may lie off the page).
  const density = Math.sqrt(image.pixels / Math.max(1, (b[2] - b[0]) * (b[3] - b[1])))
  const picture = replayed(doc, pageIndex, image.calls, box, scaleFor(box, Math.min(SHARPEST_PICTURE, density), 150 / 72))
  if (picture) picture.order = image.order
  return picture
}

/** A region of the page as drawn, text included (a chart with its labels, for flowing Word). */
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

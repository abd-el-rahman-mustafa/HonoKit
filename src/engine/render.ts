import { free, mupdf, type PdfDoc } from './mupdf'

export interface RenderedPage {
  /** PNG or JPEG bytes. */
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export interface RenderOptions {
  /** Pixels per point: 1 = 72 dpi. */
  scale: number
  /** Exactly this many pixels wide and high instead (the page's shape kept to the pixel); `scale` is then ignored. */
  size?: [number, number]
  format?: 'png' | 'jpeg' | 'auto'
  quality?: number
  /**
   * Draw annotations and form fields. Default true (as shown on screen). 'print' draws the page as
   * it prints: annotations without the Print flag, and layers set not to print, are left out, and
   * print-only ones are drawn (PDF 32000 §12.5.3, §8.11.4.4).
   */
  annotations?: boolean | 'print'
  /** Use print rules for layers even when annotations are left out (printing without comments). */
  print?: boolean
}

/** Pages larger than this many pixels are sent as JPEG in 'auto' mode: PNG of a big photo page is slow and huge. */
const AUTO_JPEG_ABOVE = 3_000_000

export function renderPage(doc: PdfDoc, index: number, options: RenderOptions): RenderedPage {
  const page = doc.loadPage(index)
  try {
    const s = Math.max(0.05, Math.min(options.scale, 16))
    const annotations = options.annotations ?? true
    const usage = annotations === 'print' || options.print ? 'Print' : 'View'
    let matrix = mupdf.Matrix.scale(s, s)
    if (options.size) {
      // Exactly the pixels asked for (§82): the page's bounds onto [0 0 w h]. MuPDF rounds
      // the pixmap out from the transformed bounds, so they are made to land on whole pixels.
      const [x0, y0, x1, y1] = page.getBounds()
      const [w, h] = options.size
      const sx = Math.max(1, Math.min(w, 20000)) / Math.max(1e-6, x1! - x0!)
      const sy = Math.max(1, Math.min(h, 20000)) / Math.max(1e-6, y1! - y0!)
      matrix = [sx, 0, 0, sy, -x0! * sx, -y0! * sy]
    }
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, annotations !== false, usage)
    try {
      const width = pixmap.getWidth()
      const height = pixmap.getHeight()
      const format = options.format ?? 'auto'
      const useJpeg = format === 'jpeg' || (format === 'auto' && width * height > AUTO_JPEG_ABOVE)
      const data = useJpeg ? pixmap.asJPEG(options.quality ?? 90) : pixmap.asPNG()
      return { data: new Uint8Array(data), mime: useJpeg ? 'image/jpeg' : 'image/png', width, height }
    } finally {
      free(pixmap)
    }
  } finally {
    free(page)
  }
}

export interface PageGeometry {
  /** Displayed width and height in points (rotation applied). */
  width: number
  height: number
  rotation: number
}

export function pageGeometry(doc: PdfDoc, index: number): PageGeometry {
  const page = doc.loadPage(index)
  try {
    const b = page.getBounds()
    const rotate = doc.findPage(index).getInheritable('Rotate')
    return { width: b[2] - b[0], height: b[3] - b[1], rotation: rotate.isNumber() ? rotate.asNumber() : 0 }
  } finally {
    free(page)
  }
}

/**
 * The page's white margins, in points as displayed (left, top, right, bottom): how far the
 * content (anything not near-white) sits from each edge — Acrobat's "Remove white margins".
 * Found on a small grey rendering, so it takes pictures and drawings into account, not only text.
 */
export function whiteMargins(doc: PdfDoc, index: number): { left: number; top: number; right: number; bottom: number } {
  const page = doc.loadPage(index)
  try {
    const b = page.getBounds()
    const w = b[2] - b[0]
    const h = b[3] - b[1]
    const s = Math.min(1, 600 / Math.max(w, h))
    const pixmap = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true)
    try {
      const pw = pixmap.getWidth()
      const ph = pixmap.getHeight()
      const stride = pixmap.getStride()
      const px = pixmap.getPixels()
      let x0 = pw
      let y0 = ph
      let x1 = -1
      let y1 = -1
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          if (px[y * stride + x]! < 240) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      if (x1 < 0) return { left: 0, top: 0, right: 0, bottom: 0 }
      // A little breathing room, so the content does not touch the new edge.
      const pad = 4
      return {
        left: Math.max(0, x0 / s - pad),
        top: Math.max(0, y0 / s - pad),
        right: Math.max(0, (pw - 1 - x1) / s - pad),
        bottom: Math.max(0, (ph - 1 - y1) / s - pad)
      }
    } finally {
      free(pixmap)
    }
  } finally {
    free(page)
  }
}

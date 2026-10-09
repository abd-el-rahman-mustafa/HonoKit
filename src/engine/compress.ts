import { free, mupdf, openPdf, saveBytes, SAVE_FINAL, type PdfDoc } from './mupdf'

/**
 * Making a PDF smaller: recompress large images, then let MuPDF drop unused and
 * duplicate objects and compress every stream.
 *
 * The levels cap an image's longest side and set its JPEG quality. That is
 * cruder than targeting an effective resolution (dpi at the size it is drawn
 * at), and is documented as such; it never enlarges anything and it only
 * replaces an image when the result is actually smaller.
 */

export type CompressLevel = 'low' | 'medium' | 'high'

const LEVELS: Record<CompressLevel, { maxSide: number; quality: number }> = {
  low: { maxSide: 3200, quality: 85 },
  medium: { maxSide: 1800, quality: 72 },
  high: { maxSide: 1200, quality: 55 }
}

/** Images with fewer pixels than this are left alone; recompressing them gains nothing worth the loss. */
const MIN_PIXELS = 40_000

export interface CompressResult {
  bytes: Uint8Array
  before: number
  after: number
  imagesRecompressed: number
}

function isImage(obj: mupdf.PDFObject): boolean {
  if (!obj.isDictionary()) return false
  const subtype = obj.get('Subtype')
  return subtype.isName() && subtype.asName() === 'Image'
}

function rawLength(obj: mupdf.PDFObject): number {
  const length = obj.get('Length')
  return length.isNumber() ? length.asNumber() : Number.POSITIVE_INFINITY
}

/** The filter names of a stream: /Filter may be one name or an array of them. */
function filterNames(obj: mupdf.PDFObject): string[] {
  const filter = obj.get('Filter')
  if (filter.isName()) return [filter.asName()]
  const names: string[] = []
  if (filter.isArray()) for (let i = 0; i < filter.length; i++) if (filter.get(i).isName()) names.push(filter.get(i).asName())
  return names
}

/** The family of an image's /ColorSpace: 'DeviceRGB', 'ICCBased', 'Indexed', … ('' when absent). */
function colourFamily(obj: mupdf.PDFObject): string {
  const cs = obj.get('ColorSpace')
  if (cs.isName()) return cs.asName()
  if (cs.isArray() && cs.length > 0 && cs.get(0).isName()) return cs.get(0).asName()
  return ''
}

/**
 * Objects that must not be re-encoded on their own: every soft mask (a JPEG'd alpha channel blurs
 * and rings at each edge), and both halves of a pair whose soft mask has /Matte (the image's colours
 * are pre-blended with the mask, so the two must keep the same size; resampling either gives fringes).
 */
function protectedObjects(doc: PdfDoc): Set<number> {
  const keep = new Set<number>()
  const total = doc.countObjects()
  for (let n = 1; n < total; n++) {
    try {
      const obj = doc.newIndirect(n).resolve()
      if (!isImage(obj)) continue
      const smask = obj.get('SMask')
      if (!smask.isIndirect()) continue
      keep.add(smask.asIndirect())
      if (!smask.resolve().get('Matte').isNull()) keep.add(n)
    } catch {
      continue
    }
  }
  return keep
}

/**
 * Drops what only the authoring application or an old viewer uses (Acrobat's "Discard objects"
 * defaults): embedded page thumbnails (every viewer draws its own) and /PieceInfo, the private
 * data Illustrator, Photoshop and others keep for re-editing — sometimes a full copy of the artwork.
 */
function discardUnused(doc: PdfDoc): void {
  const root = doc.getTrailer().get('Root')
  if (root.isDictionary()) root.delete('PieceInfo')
  const count = doc.countPages()
  for (let i = 0; i < count; i++) {
    try {
      const page = doc.findPage(i)
      page.delete('Thumb')
      page.delete('PieceInfo')
    } catch {
      continue
    }
  }
}

function recompressImages(doc: PdfDoc, level: CompressLevel): number {
  const { maxSide, quality } = LEVELS[level]
  const total = doc.countObjects()
  const keep = protectedObjects(doc)
  let replaced = 0
  for (let n = 1; n < total; n++) {
    if (keep.has(n)) continue
    let ref: mupdf.PDFObject
    let obj: mupdf.PDFObject
    try {
      ref = doc.newIndirect(n)
      obj = ref.resolve()
      if (!isImage(obj)) continue
    } catch {
      continue
    }
    try {
      if (obj.get('ImageMask').isBoolean() && obj.get('ImageMask').asBoolean()) continue
      if (obj.get('Mask').isArray() || obj.get('Mask').isIndirect()) continue // colour-key or explicit stencil masks
      // JPEG 2000 is already compact; JBIG2 and CCITT are 1-bit scans that JPEG would make bigger.
      // (A filter array, [/FlateDecode /JBIG2Decode] say, is checked name by name.)
      if (filterNames(obj).some((name) => ['JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode'].includes(name))) continue
      // A palette image is flat colour (charts, logos, screenshots): JPEG would smear every edge and
      // usually come out bigger than the palette data anyway.
      const family = colourFamily(obj)
      if (family === 'Indexed') continue
      // An ICC-based image keeps its profile: the decoded samples are still in that space.
      const keepColourSpace = family === 'ICCBased'
      const w0 = obj.get('Width').asNumber()
      const h0 = obj.get('Height').asNumber()
      if (w0 * h0 < MIN_PIXELS) continue

      const image = doc.loadImage(ref)
      let pixmap = image.toPixmap()
      const cs = pixmap.getColorSpace()
      // Only plain grey and RGB are re-encoded; CMYK/indexed/separation keep their fidelity.
      if (!cs || (!cs.isGray() && !cs.isRGB())) {
        free(pixmap, image)
        continue
      }
      if (pixmap.getAlpha()) {
        free(pixmap, image)
        continue
      }
      const scale = Math.min(1, maxSide / Math.max(w0, h0))
      if (scale < 1) {
        const w = Math.max(1, Math.round(w0 * scale))
        const h = Math.max(1, Math.round(h0 * scale))
        const target = new mupdf.Pixmap(cs, [0, 0, w, h], false)
        target.clear(255)
        const device = new mupdf.DrawDevice(mupdf.Matrix.identity, target)
        device.fillImage(image, mupdf.Matrix.scale(w, h), 1)
        device.close()
        free(device, pixmap)
        pixmap = target
      }
      const jpeg = pixmap.asJPEG(quality)
      const w = pixmap.getWidth()
      const h = pixmap.getHeight()
      const gray = pixmap.getColorSpace()!.isGray()
      const components = pixmap.getNumberOfComponents()
      free(pixmap, image)

      if (jpeg.length >= rawLength(obj) * 0.95) continue
      if (keepColourSpace) {
        const n = obj.get('ColorSpace').get(1).resolve().get('N')
        if (!n.isNumber() || n.asNumber() !== components) continue
      }
      obj.put('Width', w)
      obj.put('Height', h)
      if (!keepColourSpace) obj.put('ColorSpace', doc.newName(gray ? 'DeviceGray' : 'DeviceRGB'))
      obj.put('BitsPerComponent', 8)
      obj.put('Filter', doc.newName('DCTDecode'))
      obj.delete('DecodeParms')
      obj.delete('Decode')
      ref.writeRawStream(jpeg)
      replaced++
    } catch (error) {
      // An image that cannot be decoded is left exactly as it was.
      if (process.env.POWERPDF_DEBUG) console.warn(`compress: object ${n} skipped: ${(error as Error).message}`)
      continue
    }
  }
  return replaced
}

export function compressPdf(bytes: Uint8Array, level: CompressLevel, password?: string): CompressResult {
  const doc = openPdf(bytes, password)
  try {
    discardUnused(doc)
    const replaced = recompressImages(doc, level)
    const out = saveBytes(doc, `${SAVE_FINAL},compress-fonts`)
    // Never hand back something bigger than what went in.
    if (out.length >= bytes.length) return { bytes, before: bytes.length, after: bytes.length, imagesRecompressed: 0 }
    return { bytes: out, before: bytes.length, after: out.length, imagesRecompressed: replaced }
  } finally {
    free(doc)
  }
}

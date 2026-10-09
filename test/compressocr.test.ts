import { describe, expect, it } from 'vitest'
import { compressPdf } from '@engine/compress'
import { free, mupdf, openPdf } from '@engine/mupdf'

/**
 * Compress edge cases (thumbnails, private application data, soft masks with /Matte, indexed
 * and ICC images). The PDFs are built with MuPDF directly so the image dictionaries are exactly
 * what the test needs.
 */

const SIDE = 2000 // above the 'medium' cap (1800), so a recompressed image is also resized

function noise(components: number, side = SIDE): Uint8Array {
  const out = new Uint8Array(side * side * components)
  let seed = 987654
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      for (let c = 0; c < components; c++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        out[(y * side + x) * components + c] = ((x + y * (c + 1)) * 255) / (2 * side) + ((seed >> 8) & 63)
      }
    }
  }
  return out
}

type Build = (doc: mupdf.PDFDocument) => { image: mupdf.PDFObject; page?: (page: mupdf.PDFObject) => void }

function imageDict(doc: mupdf.PDFDocument, colorSpace: mupdf.PDFObject, side = SIDE): mupdf.PDFObject {
  const d = doc.newDictionary()
  d.put('Type', doc.newName('XObject'))
  d.put('Subtype', doc.newName('Image'))
  d.put('Width', side)
  d.put('Height', side)
  d.put('BitsPerComponent', 8)
  d.put('ColorSpace', colorSpace)
  return d
}

function buildPdf(build: Build): Uint8Array {
  const doc = new mupdf.PDFDocument()
  try {
    const { image, page: tweak } = build(doc)
    const xobjects = doc.newDictionary()
    xobjects.put('Im0', image)
    const resources = doc.newDictionary()
    resources.put('XObject', xobjects)
    const page = doc.addPage([0, 0, 600, 600], 0, resources, 'q 600 0 0 600 0 0 cm /Im0 Do Q')
    tweak?.(page)
    doc.insertPage(-1, page)
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array())
  } finally {
    doc.destroy()
  }
}

function rgbImage(doc: mupdf.PDFDocument): mupdf.PDFObject {
  return doc.addStream(noise(3), imageDict(doc, doc.newName('DeviceRGB')))
}

/** Reads the image /Im0 of page 1. */
function inspect<T>(bytes: Uint8Array, read: (image: mupdf.PDFObject, page: mupdf.PDFObject, doc: mupdf.PDFDocument) => T): T {
  const doc = openPdf(bytes)
  try {
    const page = doc.findPage(0)
    const image = page.get('Resources').get('XObject').get('Im0').resolve()
    return read(image, page, doc)
  } finally {
    free(doc)
  }
}

describe('compress: objects nobody needs', () => {
  it('drops page thumbnails and /PieceInfo at document and page level', () => {
    const src = buildPdf((doc) => {
      const image = rgbImage(doc)
      return {
        image,
        page: (page) => {
          const thumb = doc.addStream(noise(3, 120), imageDict(doc, doc.newName('DeviceRGB'), 120))
          page.put('Thumb', thumb)
          const piece = doc.newDictionary()
          const app = doc.newDictionary()
          app.put('Private', doc.addStream(noise(1, 200), doc.newDictionary()))
          app.put('LastModified', doc.newString('D:20200101000000Z'))
          piece.put('Illustrator', app)
          page.put('PieceInfo', piece)
          const docPiece = doc.newDictionary()
          docPiece.put('Illustrator', app)
          doc.getTrailer().get('Root').put('PieceInfo', docPiece)
        }
      }
    })
    inspect(src, (_image, page, doc) => {
      expect(page.get('Thumb').isNull()).toBe(false)
      expect(page.get('PieceInfo').isNull()).toBe(false)
      expect(doc.getTrailer().get('Root').get('PieceInfo').isNull()).toBe(false)
    })
    const r = compressPdf(src, 'medium')
    inspect(r.bytes, (_image, page, doc) => {
      expect(page.get('Thumb').isNull()).toBe(true)
      expect(page.get('PieceInfo').isNull()).toBe(true)
      expect(doc.getTrailer().get('Root').get('PieceInfo').isNull()).toBe(true)
    })
  })
})

describe('compress: images that would be harmed', () => {
  it('leaves an image whose soft mask has /Matte at its size (resizing one gives colour fringes)', () => {
    const src = buildPdf((doc) => {
      const smaskDict = imageDict(doc, doc.newName('DeviceGray'))
      const matte = doc.newArray()
      for (const v of [1, 1, 1]) matte.push(v)
      smaskDict.put('Matte', matte)
      const smask = doc.addStream(noise(1), smaskDict)
      const image = rgbImage(doc)
      image.put('SMask', smask)
      return { image }
    })
    const r = compressPdf(src, 'medium')
    inspect(r.bytes, (image) => {
      expect(image.get('Width').asNumber()).toBe(SIDE)
      expect(image.get('Filter').isName() && image.get('Filter').asName()).not.toBe('DCTDecode')
      const smask = image.get('SMask')
      expect(smask.get('Width').asNumber()).toBe(SIDE)
      expect(smask.get('Matte').isArray()).toBe(true)
      expect(smask.get('Filter').isName() && smask.get('Filter').asName()).not.toBe('DCTDecode')
    })
  })

  it('still recompresses an image with a plain soft mask (no /Matte), keeping the mask lossless', () => {
    const src = buildPdf((doc) => {
      const smask = doc.addStream(noise(1), imageDict(doc, doc.newName('DeviceGray')))
      const image = rgbImage(doc)
      image.put('SMask', smask)
      return { image }
    })
    const r = compressPdf(src, 'medium')
    inspect(r.bytes, (image) => {
      expect(image.get('Filter').asName()).toBe('DCTDecode')
      expect(image.get('Width').asNumber()).toBeLessThan(SIDE)
      // A JPEG'd alpha channel blurs and rings at every edge: the mask is never made lossy.
      const smask = image.get('SMask')
      expect(smask.get('Filter').isName() && smask.get('Filter').asName()).not.toBe('DCTDecode')
    })
  })

  it('does not turn an indexed (palette) image into a JPEG', () => {
    const src = buildPdf((doc) => {
      const palette = new Uint8Array(256 * 3)
      for (let i = 0; i < 256; i++) palette.set([i, 255 - i, (i * 7) & 255], i * 3)
      const cs = doc.newArray()
      cs.push(doc.newName('Indexed'))
      cs.push(doc.newName('DeviceRGB'))
      cs.push(255)
      cs.push(doc.newByteString(palette))
      return { image: doc.addStream(noise(1), imageDict(doc, cs)) }
    })
    const r = compressPdf(src, 'medium')
    inspect(r.bytes, (image) => {
      expect(image.get('Width').asNumber()).toBe(SIDE)
      const cs = image.get('ColorSpace')
      expect(cs.isArray() && cs.get(0).asName()).toBe('Indexed')
    })
  })

  it('keeps an ICC-based image in its ICC colour space when it recompresses it', () => {
    const src = buildPdf((doc) => {
      // Not a valid profile: MuPDF falls back to the /Alternate, which is all this test needs.
      const profileDict = doc.newDictionary()
      profileDict.put('N', 3)
      profileDict.put('Alternate', doc.newName('DeviceRGB'))
      const profile = doc.addStream(new Uint8Array(128), profileDict)
      const cs = doc.newArray()
      cs.push(doc.newName('ICCBased'))
      cs.push(profile)
      return { image: doc.addStream(noise(3), imageDict(doc, cs)) }
    })
    const r = compressPdf(src, 'medium')
    inspect(r.bytes, (image) => {
      expect(image.get('Filter').asName()).toBe('DCTDecode')
      const cs = image.get('ColorSpace')
      expect(cs.isArray() && cs.get(0).asName()).toBe('ICCBased')
    })
  })

  it('recompresses an image whose /Filter is an array ([/DCTDecode])', () => {
    const src = buildPdf((doc) => {
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, SIDE, SIDE], false)
      pix.getPixels().set(noise(3))
      const jpeg = new Uint8Array(pix.asJPEG(98))
      pix.destroy()
      const dict = imageDict(doc, doc.newName('DeviceRGB'))
      const filters = doc.newArray()
      filters.push(doc.newName('DCTDecode'))
      dict.put('Filter', filters)
      return { image: doc.addRawStream(jpeg, dict) }
    })
    const r = compressPdf(src, 'medium')
    expect(r.imagesRecompressed).toBe(1)
    inspect(r.bytes, (image) => {
      expect(image.get('Width').asNumber()).toBeLessThan(SIDE)
    })
  })
})

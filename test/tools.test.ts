import { describe, expect, it } from 'vitest'
import { compressPdf } from '@engine/compress'
import { PdfError } from '@engine/errors'
import { imagesToPdf, pdfToImages } from '@engine/images'
import { free, mupdf, openPdf, rightsOf } from '@engine/mupdf'
import { pageCount } from '@engine/pages'
import { isEncrypted, permissionsValue, protectPdf, unlockPdf } from '@engine/security'
import { extractText } from '@engine/text'
import { applyOperation, parseOp } from '@ops/index'
import { makeImagePdf, makeLatinPdf, makeNoiseJpeg, makePng } from './fixtures'

describe('compress', () => {
  it('shrinks a photo-heavy PDF and keeps it readable', async () => {
    const src = await makeImagePdf(2400)
    const r = compressPdf(src, 'medium')
    expect(r.after).toBeLessThan(r.before * 0.7)
    expect(r.imagesRecompressed).toBe(1)
    expect(pageCount(r.bytes)).toBe(1)
  })

  it('compresses harder at a higher level', async () => {
    const src = await makeImagePdf(2400)
    const low = compressPdf(src, 'low').after
    const high = compressPdf(src, 'high').after
    expect(high).toBeLessThan(low)
  })

  it('never returns something bigger than the input', async () => {
    const src = await makeLatinPdf(2)
    const r = compressPdf(src, 'high')
    expect(r.bytes.length).toBeLessThanOrEqual(src.length)
  })

  it('leaves text intact', async () => {
    const src = await makeLatinPdf(2)
    const doc = openPdf(compressPdf(src, 'medium').bytes)
    try {
      expect(extractText(doc, 1)).toContain('Marker2')
    } finally {
      free(doc)
    }
  })
})

describe('passwords', () => {
  it('protects with AES-256 and asks for the password', async () => {
    const locked = protectPdf(await makeLatinPdf(2), { userPassword: 'secret', allowPrint: true, allowCopy: false, allowModify: false, allowAnnotate: true })
    expect(isEncrypted(locked)).toBe(true)
    expect(() => openPdf(locked)).toThrowError(expect.objectContaining({ code: 'password-required' }))
    expect(() => openPdf(locked, 'wrong')).toThrowError(expect.objectContaining({ code: 'wrong-password' }))
    const doc = openPdf(locked, 'secret')
    try {
      expect(extractText(doc, 0)).toContain('Marker1')
    } finally {
      free(doc)
    }
  })

  it('accepts a password with non-ASCII characters', async () => {
    const locked = protectPdf(await makeLatinPdf(1), { userPassword: 'كلمة-سر', allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true })
    expect(() => openPdf(locked, 'كلمة-سر')).not.toThrow()
  })

  const all = { allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true }
  const decomposed = 'cafe' + String.fromCodePoint(0x301)
  const precomposed = 'caf' + String.fromCodePoint(0xe9)

  it('refuses an open password that would also lift the restrictions', async () => {
    const pdf = await makeLatinPdf(1)
    const restricted = { allowPrint: true, allowCopy: false, allowModify: false, allowAnnotate: false }
    expect(() => protectPdf(pdf, { userPassword: 'secret', ownerPassword: 'secret', ...restricted })).toThrowError(expect.objectContaining({ code: 'bad-arguments' }))
    // Readers count only the first 127 bytes: these two differ after them, so they are one password.
    const long = 'ب'.repeat(64)
    expect(() => protectPdf(pdf, { userPassword: long + 'X', ownerPassword: long + 'Y', ...restricted })).toThrowError(expect.objectContaining({ code: 'bad-arguments' }))
    expect(() => protectPdf(pdf, { userPassword: precomposed, ownerPassword: decomposed, ...restricted })).toThrowError(expect.objectContaining({ code: 'bad-arguments' }))
    expect(() => protectPdf(pdf, { userPassword: String.fromCodePoint(0xad), ...restricted })).toThrowError(expect.objectContaining({ code: 'bad-arguments' }))
    const doc = openPdf(protectPdf(pdf, { userPassword: 'ب'.repeat(63), ownerPassword: 'owner', ...restricted }), 'ب'.repeat(63))
    try {
      expect(rightsOf(doc).copy).toBe(false)
    } finally {
      free(doc)
    }
  })

  it('keys the file on the password as other readers prepare it, and opens either form', async () => {
    const locked = protectPdf(await makeLatinPdf(1), { userPassword: decomposed, ...all })
    const raw = mupdf.Document.openDocument(locked, 'application/pdf')
    try {
      expect(raw.authenticatePassword(precomposed)).toBeTruthy()
    } finally {
      raw.destroy()
    }
    expect(() => openPdf(locked, decomposed)).not.toThrow()
    const nbsp = protectPdf(await makeLatinPdf(1), { userPassword: 'open' + String.fromCodePoint(0xa0) + 'sesame', ...all })
    expect(() => openPdf(nbsp, 'open sesame')).not.toThrow()
    expect(() => openPdf(nbsp, 'open' + String.fromCodePoint(0xa0) + 'sesame')).not.toThrow()
  })

  it('unlocks into a file that needs no password', async () => {
    const locked = protectPdf(await makeLatinPdf(1), { userPassword: 'secret', allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true })
    const open = unlockPdf(locked, 'secret')
    expect(isEncrypted(open)).toBe(false)
    expect(pageCount(open)).toBe(1)
  })

  it('refuses to unlock with the wrong password', async () => {
    const locked = protectPdf(await makeLatinPdf(1), { userPassword: 'secret', allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true })
    expect(() => unlockPdf(locked, 'nope')).toThrow(PdfError)
  })

  it('encodes permissions with the reserved bits set', () => {
    const none = permissionsValue({ allowPrint: false, allowCopy: false, allowModify: false, allowAnnotate: false })
    const all = permissionsValue({ allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true })
    expect(none & 0xc0).toBe(0xc0)
    expect(all & 4).toBe(4) // print
    expect(none & 4).toBe(0)
    expect(all & 16).toBe(16) // copy
  })
})

describe('pictures', () => {
  it('turns pictures into pages, one each, fitted to A4', () => {
    const pdf = imagesToPdf([makePng(800, 400), makeNoiseJpeg(300, 600, 80), makePng(50, 50)], { paper: 'a4', margin: 20, autoOrientation: true })
    expect(pageCount(pdf)).toBe(3)
    const doc = openPdf(pdf)
    try {
      const first = doc.loadPage(0).getBounds()
      // A wide picture turns the page to landscape.
      expect(first[2] - first[0]).toBeGreaterThan(first[3] - first[1])
      const second = doc.loadPage(1).getBounds()
      expect(second[2] - second[0]).toBeLessThan(second[3] - second[1])
    } finally {
      free(doc)
    }
  })

  it('sizes pages to the picture when asked to fit', () => {
    const pdf = imagesToPdf([makePng(192, 96)], { paper: 'fit', margin: 0, autoOrientation: false })
    const doc = openPdf(pdf)
    try {
      const b = doc.loadPage(0).getBounds()
      // 192×96 px at 96 dpi = 144×72 pt.
      expect(Math.round(b[2] - b[0])).toBe(144)
      expect(Math.round(b[3] - b[1])).toBe(72)
    } finally {
      free(doc)
    }
  })

  it('turns a picture a quarter turn, and fits the page to it', () => {
    const pdf = imagesToPdf([makePng(192, 96, [255, 0, 0])], { paper: 'fit', margin: 0, autoOrientation: false, rotations: [90] })
    const doc = openPdf(pdf)
    try {
      const b = doc.loadPage(0).getBounds()
      expect(Math.round(b[2] - b[0])).toBe(72)
      expect(Math.round(b[3] - b[1])).toBe(144)
      // The picture fills the turned page: red at the corners, not white.
      const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
      const px = pm.getPixels()
      for (const [x, y] of [[3, 3], [68, 140]] as const) expect(px[(y * pm.getWidth() + x) * 3]).toBeGreaterThan(200)
    } finally {
      free(doc)
    }
  })

  it('makes landscape pages when asked, whatever the picture', () => {
    const pdf = imagesToPdf([makePng(50, 100)], { paper: 'a4', margin: 10, autoOrientation: true, orientation: 'landscape' })
    const doc = openPdf(pdf)
    try {
      const b = doc.loadPage(0).getBounds()
      expect(b[2] - b[0]).toBeGreaterThan(b[3] - b[1])
    } finally {
      free(doc)
    }
  })

  it('rejects something that is not a picture', () => {
    expect(() => imagesToPdf([new TextEncoder().encode('not an image')], { paper: 'a4', margin: 10, autoOrientation: true })).toThrow(/could not be read/)
  })

  it('renders pages to PNG or JPEG at a chosen resolution', async () => {
    const src = await makeLatinPdf(3, { width: 200, height: 100 })
    const png = pdfToImages(src, [0, 2], 'png', 144)
    expect(png.map((p) => p.page)).toEqual([0, 2])
    expect(png[0]!.width).toBe(400) // 200 pt at 144 dpi
    expect(Array.from(png[0]!.data.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    const jpg = pdfToImages(src, undefined, 'jpeg', 72)
    expect(jpg).toHaveLength(3)
    expect(jpg[0]!.data[0]).toBe(0xff)
  })
})

describe('operations', () => {
  it('rejects malformed operations with a readable message', () => {
    expect(() => parseOp({ op: 'rotate', pages: [], angle: 90 })).toThrow(/Invalid operation/)
    expect(() => parseOp({ op: 'rotate', pages: [0], angle: 45 })).toThrow(/Invalid operation/)
    expect(() => parseOp({ op: 'nonsense' })).toThrow(/Invalid operation/)
    expect(() => parseOp({ op: 'watermark', text: 'x', colour: 'red' })).toThrow(/Invalid operation/)
  })

  it('fills in defaults', () => {
    const op = parseOp({ op: 'watermark', text: 'x' })
    expect(op).toMatchObject({ opacity: 0.25, rotation: 45, position: 'center' })
  })

  it('edits metadata', async () => {
    const r = await applyOperation(await makeLatinPdf(1), { op: 'metadata', title: 'عنوان', author: 'A. Author' })
    const doc = openPdf(r.bytes)
    try {
      expect(doc.getMetaData('info:Title')).toBe('عنوان')
      expect(doc.getMetaData('info:Author')).toBe('A. Author')
    } finally {
      free(doc)
    }
  })

  it('repairs a file whose cross-reference table is broken', async () => {
    const src = await makeLatinPdf(3)
    // Point startxref at nonsense: the classic "damaged download".
    const text = Buffer.from(src).toString('latin1')
    const broken = Buffer.from(text.replace(/startxref\s+\d+/, 'startxref\n999999'), 'latin1')
    const r = await applyOperation(new Uint8Array(broken), { op: 'repair' })
    expect(pageCount(r.bytes)).toBe(3)
    expect(r.note?.key).toBe('note.repaired')
  })

  it('says so plainly when a file is beyond repair', async () => {
    const src = await makeLatinPdf(1)
    await expect(applyOperation(src.slice(0, 40), { op: 'repair' })).rejects.toThrow(PdfError)
  })
})

describe('white margins (Crop → Trim white margins)', () => {
  it('finds how far the content sits from each edge', async () => {
    const { whiteMargins } = await import('@engine/render')
    const doc = openPdf(await makeLatinPdf(1)) // 400 × 600, text from x=40 near the top
    try {
      const m = whiteMargins(doc, 0)
      expect(m.left).toBeGreaterThan(25)
      expect(m.left).toBeLessThan(45)
      expect(m.top).toBeGreaterThan(40)
      expect(m.bottom).toBeGreaterThan(400) // two short lines near the top: most of the page is empty
      expect(m.right).toBeGreaterThan(150)
    } finally {
      free(doc)
    }
  })
})

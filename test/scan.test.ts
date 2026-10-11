import { describe, expect, it } from 'vitest'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { detectFold, detectPicture, exifOrientation, idCardPage, loadUpright, scanBookPicture, scanPicture, type Corners } from '@engine/scan'

/**
 * Photos of a page lying on a table, made here: a white page (a tilted quadrilateral) on a dark
 * background, with a black mark near the page's top-left corner, so the result's orientation can
 * be checked.
 */
function photo(w: number, h: number, page: Corners): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const px = pix.getPixels()
  const stride = pix.getStride()
  const inside = (x: number, y: number, q: Corners): boolean => {
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = q[i]!
      const [bx, by] = q[(i + 1) % 4]!
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
      if (cross !== 0) {
        if (sign === 0) sign = Math.sign(cross)
        else if (Math.sign(cross) !== sign) return false
      }
    }
    return true
  }
  // The mark: a small quad a tenth of the way into the page from its top-left corner.
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const at = (u: number, v: number): [number, number] => lerp(lerp(page[0], page[1], u), lerp(page[3], page[2], u), v)
  const mark: Corners = [at(0.08, 0.08), at(0.22, 0.08), at(0.22, 0.2), at(0.08, 0.2)]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * 3
      const v = inside(x, y, mark) ? 20 : inside(x, y, page) ? 235 : 60
      px[o] = v
      px[o + 1] = v
      px[o + 2] = inside(x, y, page) || inside(x, y, mark) ? v : 70
    }
  }
  const jpeg = new Uint8Array(pix.asJPEG(92))
  pix.destroy()
  return jpeg
}

/** A JPEG with an EXIF orientation tag added (as phones store an upright photo sideways). */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // APP1: "Exif\0\0", a little-endian TIFF header, one IFD entry: 0x0112 SHORT 1 = orientation.
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
  const length = body.length + 2
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...body]
  return new Uint8Array([0xff, 0xd8, ...app1, ...jpeg.subarray(2)])
}

/** The share of dark pixels in a part of a picture (fractions of its size). */
function darkness(bytes: Uint8Array, x0: number, y0: number, x1: number, y1: number): number {
  const pix = loadUpright(bytes)
  try {
    const w = pix.getWidth()
    const h = pix.getHeight()
    const px = pix.getPixels()
    const stride = pix.getStride()
    const n = pix.getNumberOfComponents()
    let dark = 0
    let all = 0
    for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
      all++
      if (px[y * stride + x * n]! < 100) dark++
    }
    return dark / all
  } finally {
    free(pix)
  }
}

const PAGE: Corners = [
  [180, 90],
  [600, 130],
  [570, 560],
  [140, 520]
]

describe('scanning photos (§61)', () => {
  it('finds the page in a photo of it on a table', () => {
    const found = detectPicture(photo(800, 640, PAGE))
    expect(found.width).toBe(800)
    expect(found.corners).not.toBeNull()
    for (const [i, [x, y]] of found.corners!.entries()) {
      expect(Math.abs(x - PAGE[i]![0])).toBeLessThan(14)
      expect(Math.abs(y - PAGE[i]![1])).toBeLessThan(14)
    }
  })

  it('straightens the page: the mark ends up at its top-left', () => {
    const bytes = photo(800, 640, PAGE)
    const { corners } = detectPicture(bytes)
    const out = scanPicture(bytes, { corners, mode: 'color' })
    expect(out.width).toBeGreaterThan(380)
    expect(out.height).toBeGreaterThan(380)
    expect(darkness(out.bytes, 0.1, 0.1, 0.2, 0.18)).toBeGreaterThan(0.6)
    expect(darkness(out.bytes, 0.6, 0.6, 0.9, 0.9)).toBeLessThan(0.02)
  })

  it('reads the orientation past fill bytes before a marker', () => {
    const sideways = withOrientation(photo(64, 48, [[6, 5], [58, 5], [58, 43], [6, 43]]), 6)
    // JPEG allows any number of 0xFF fill bytes before a marker (ITU T.81 B.1.1.2).
    const padded = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, ...sideways.subarray(3)])
    expect(exifOrientation(padded)).toBe(6)
  })

  it('turns a phone photo stored sideways upright (EXIF orientation 6)', () => {
    const sideways = withOrientation(photo(640, 480, [[60, 50], [580, 50], [580, 430], [60, 430]]), 6)
    expect(exifOrientation(sideways)).toBe(6)
    const pix = loadUpright(sideways)
    expect([pix.getWidth(), pix.getHeight()]).toEqual([480, 640])
    free(pix)
    // Turned a quarter clockwise, the page's top-left mark is now at the top-right.
    expect(darkness(sideways, 0.76, 0.18, 0.82, 0.25)).toBeGreaterThan(0.6)
    expect(darkness(sideways, 0.2, 0.5, 0.5, 0.8)).toBeLessThan(0.02)
  })

  it('makes a clean black-and-white page', () => {
    const bytes = photo(800, 640, PAGE)
    const { corners } = detectPicture(bytes)
    const out = scanPicture(bytes, { corners, mode: 'bw' })
    expect(out.format).toBe('png')
    expect(darkness(out.bytes, 0.1, 0.1, 0.2, 0.18)).toBeGreaterThan(0.4)
    expect(darkness(out.bytes, 0.4, 0.4, 0.9, 0.9)).toBeLessThan(0.01)
  })

  it('turns the result by a quarter on request', () => {
    const bytes = photo(800, 640, PAGE)
    const { corners } = detectPicture(bytes)
    const plain = scanPicture(bytes, { corners, mode: 'gray' })
    const turned = scanPicture(bytes, { corners, mode: 'gray', rotate: 90 })
    expect([turned.width, turned.height]).toEqual([plain.height, plain.width])
    expect(darkness(turned.bytes, 0.8, 0.1, 0.9, 0.2)).toBeGreaterThan(0.4)
  })

  it('finds a card with a dark band across its top, not just its light part', () => {
    // A card: light body, dark blue header band, on a dark table — the band must stay inside the card.
    const w = 640
    const h = 480
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
    const px = pix.getPixels()
    const stride = pix.getStride()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * stride + x * 3
      const inCard = x >= 120 && x < 520 && y >= 110 && y < 360
      const band = inCard && y < 160
      const [r, g, b] = band ? [26, 90, 166] : inCard ? [235, 240, 250] : [56, 51, 48]
      px[o] = r
      px[o + 1] = g
      px[o + 2] = b
    }
    const bytes = new Uint8Array(pix.asJPEG(92))
    pix.destroy()
    const { corners } = detectPicture(bytes)
    expect(corners).not.toBeNull()
    expect(corners![0][1]).toBeLessThan(118)
    expect(corners![1][1]).toBeLessThan(118)
    expect(corners![2][1]).toBeGreaterThan(350)
  })

  it('keeps a blank or sparse page white in colour and gray (a flatbed scan of a letter)', () => {
    for (const ink of [0, 0.01]) {
      const w = 400
      const h = 560
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
      const px = pix.getPixels()
      const stride = pix.getStride()
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = y * stride + x * 3
        // Paper with a little grain; one line of "text" covering `ink` of the page.
        const v = y >= 100 && y < 100 + h * ink && x >= 40 && x < 360 ? 30 : 248 + ((x * 7 + y * 3) % 7)
        px[o] = v
        px[o + 1] = v
        px[o + 2] = v
      }
      const bytes = new Uint8Array(pix.asJPEG(92))
      pix.destroy()
      for (const mode of ['color', 'gray'] as const) {
        const out = scanPicture(bytes, { mode })
        expect(darkness(out.bytes, 0.1, 0.4, 0.9, 0.9), `${mode}, ${ink * 100}% ink`).toBeLessThan(0.01)
      }
    }
  })

  it('gives "As scanned" pages about A4 size, not MuPDF\'s 96 dpi', async () => {
    const { imagesToPdf } = await import('@engine/images')
    const bytes = photo(800, 640, PAGE)
    const { corners } = detectPicture(bytes)
    for (const mode of ['color', 'bw'] as const) {
      const out = scanPicture(bytes, { corners, mode })
      const doc = openPdf(imagesToPdf([out.bytes], { paper: 'fit', margin: 0, autoOrientation: true, orientation: 'auto' }))
      try {
        const b = doc.loadPage(0).getBounds()
        expect(Math.round(Math.max(b[2] - b[0], b[3] - b[1])), mode).toBeGreaterThan(820)
        expect(Math.round(Math.max(b[2] - b[0], b[3] - b[1])), mode).toBeLessThan(860)
      } finally {
        free(doc)
      }
    }
  })

  it('splits a photo of an open book at its fold and flattens the curved lines (§62)', () => {
    // A spread on a table: two pages, their top edges and text lines dipping toward the fold
    // (as a book's pages curve), and the fold's shadow.
    const W = 1200
    const H = 800
    const fold = 610
    const dip = (x: number): number => 46 * Math.max(0, 1 - Math.abs(x - fold) / 450) ** 2
    const top = (x: number): number => 150 + dip(x)
    const bottom = (x: number): number => 650 + dip(x) * 0.35
    const LINES = [0.2, 0.4, 0.6, 0.8]
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false)
    const px = pix.getPixels()
    const stride = pix.getStride()
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = y * stride + x * 3
        const inside = x >= 160 && x < 1060 && y >= top(x) && y < bottom(x)
        let rgb: [number, number, number] = [60, 55, 50]
        if (inside) {
          const v = (y - top(x)) / (bottom(x) - top(x))
          // Text lines across each page, away from the fold and the outer edges.
          const text = LINES.some((l) => Math.abs(v - l) < 0.008) && Math.abs(x - fold) > 30 && x > 200 && x < 1020
          const shade = 1 - 0.45 * Math.exp(-(((x - fold) / 28) ** 2))
          const g = (text ? 25 : 242) * shade
          rgb = [g, g, g * 0.98]
        }
        px[o] = rgb[0]
        px[o + 1] = rgb[1]
        px[o + 2] = rgb[2]
      }
    const bytes = new Uint8Array(pix.asJPEG(93))
    pix.destroy()

    const { corners } = detectPicture(bytes)
    expect(corners).not.toBeNull()
    const split = detectFold(bytes, corners)
    expect(split).not.toBeNull()
    // The fold is at 610 of a spread from 160 to 1060: 0.5 of its width.
    expect(Math.abs(split! - 0.5)).toBeLessThan(0.03)
    const pages = scanBookPicture(bytes, { corners, mode: 'gray', split })
    expect(pages).toHaveLength(2)
    for (const page of pages) {
      expect(page.height).toBeGreaterThan(page.width)
      // Each text line at the same height across the page: the curve is gone.
      const p = loadUpright(page.bytes)
      try {
        const w = p.getWidth()
        const h = p.getHeight()
        const data = p.getPixels()
        const n = p.getNumberOfComponents()
        const s = p.getStride()
        const rows = (x: number): number[] => {
          const found: number[] = []
          for (let y = 1; y < h; y++) if (data[y * s + x * n]! < 110 && data[(y - 1) * s + x * n]! >= 110) found.push(y / h)
          return found
        }
        const near = rows(Math.round(w * (page === pages[0] ? 0.85 : 0.15)))
        const far = rows(Math.round(w * (page === pages[0] ? 0.2 : 0.8)))
        expect(near.length, 'lines near the fold').toBe(4)
        expect(far.length, 'lines away from the fold').toBe(4)
        for (let i = 0; i < 4; i++) expect(Math.abs(near[i]! - far[i]!)).toBeLessThan(0.015)
        // The fold's shadow lightened: the paper beside the fold is near white.
        const edgeX = page === pages[0] ? w - 4 : 3
        expect(data[Math.round(h * 0.5) * s + edgeX * n]!).toBeGreaterThan(200)
      } finally {
        free(p)
      }
    }
  })

  it('puts an ID card front and back on one A4 page at real size', async () => {
    const card: Corners = [[100, 100], [528, 100], [528, 370], [100, 370]]
    const bytes = photo(640, 480, card)
    const { corners } = detectPicture(bytes)
    const front = scanPicture(bytes, { corners, mode: 'color' })
    const pdf = await idCardPage(front, front)
    const doc = openPdf(pdf)
    try {
      expect(doc.countPages()).toBe(1)
      const b = doc.loadPage(0).getBounds()
      expect(Math.round(b[2] - b[0])).toBe(595)
      expect(Math.round(b[3] - b[1])).toBe(842)
    } finally {
      free(doc)
    }
  })
})

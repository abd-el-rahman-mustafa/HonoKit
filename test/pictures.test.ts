import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, rgb, StandardFonts, type PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { pagePictures } from '@engine/pictures'
import { applyOperation } from '@ops/index'
import { makeLatinPdf, makePng, makeRestrictedPdf } from './fixtures'

/** The colour of one pixel of page 1 rendered at 1:1, as "r,g,b". */
function pixel(bytes: Uint8Array, x: number, y: number): string {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const px = pm.getPixels()
    const o = (y * pm.getWidth() + x) * 3
    return `${px[o]},${px[o + 1]},${px[o + 2]}`
  } finally {
    free(doc)
  }
}

function pictures(bytes: Uint8Array) {
  const doc = openPdf(bytes)
  try {
    return pagePictures(doc, 0)
  } finally {
    free(doc)
  }
}

/** A green background picture covering the page, a blue picture on it, and a red square drawn as vector art. */
async function makePicturePage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 300])
  page.drawImage(await pdf.embedPng(makePng(300, 300, [0, 160, 0])), { x: 0, y: 0, width: 300, height: 300 })
  page.drawImage(await pdf.embedPng(makePng(60, 40, [0, 0, 255])), { x: 40, y: 200, width: 60, height: 40 })
  page.drawRectangle({ x: 200, y: 20, width: 40, height: 40, color: rgb(1, 0, 0) })
  return new Uint8Array(await pdf.save())
}

/** A transparent PNG: a black diagonal stroke on nothing, like a drawn signature. */
function signaturePng(): Uint8Array {
  const w = 120
  const h = 40
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true)
  pm.clear() // transparent; clear(0) would be opaque black
  const px = pm.getPixels()
  for (let x = 0; x < w; x++) {
    const y = Math.round((x / w) * (h - 1))
    const o = (y * w + x) * 4
    px[o] = 0
    px[o + 1] = 0
    px[o + 2] = 0
    px[o + 3] = 255
  }
  const png = new Uint8Array(pm.asPNG())
  pm.destroy()
  return png
}

describe('pictures', () => {
  it('lists the pictures on a page with their boxes', async () => {
    const found = pictures(await makePicturePage())
    expect(found).toHaveLength(2)
    const blue = found.find((p) => p.pixels.width === 60)!
    expect(blue.box.map(Math.round)).toEqual([40, 60, 100, 100])
  })

  it('adds a picture where it is placed', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'addPicture', page: 0, rect: [100, 300, 200, 350], source: { data: Buffer.from(makePng(50, 25, [255, 0, 255])).toString('base64') } })
    expect(pixel(bytes, 150, 325)).toBe('255,0,255')
    expect(pictures(bytes).some((p) => Math.round(p.box[0]) === 100 && Math.round(p.box[1]) === 300)).toBe(true)
  })

  it('keeps a signature transparent: the page shows through around the stroke', async () => {
    const { bytes } = await applyOperation(await makePicturePage(), { op: 'addPicture', page: 0, rect: [150, 150, 270, 190], source: { data: Buffer.from(signaturePng()).toString('base64') } })
    expect(pixel(bytes, 265, 155)).toBe('0,160,0') // the green background, not white
  })

  it('keeps a signature transparent after it is moved', async () => {
    const signed = await applyOperation(await makePicturePage(), { op: 'addPicture', page: 0, rect: [150, 150, 270, 190], source: { data: Buffer.from(signaturePng()).toString('base64') } })
    const sig = pictures(signed.bytes).find((p) => p.pixels.width === 120)!
    const { bytes } = await applyOperation(signed.bytes, { op: 'changePicture', page: 0, box: sig.box, change: { kind: 'move', rect: [150, 240, 270, 280] } })
    expect(pixel(bytes, 265, 245)).toBe('0,160,0')
    expect(pixel(bytes, 265, 155)).toBe('0,160,0')
    // The stroke itself is where it was in the picture, not squeezed or repeated.
    const stroke = (x: number): number => Number(pixel(bytes, 150 + x, 240 + Math.round((x / 120) * 39)).split(',')[1])
    for (const x of [10, 60, 110]) expect(stroke(x)).toBeLessThan(80)
    expect(Number(pixel(bytes, 150 + 110, 240 + 5).split(',')[1])).toBe(160)
  })

  it('moves a picture off a background picture without harming the background', async () => {
    const src = await makePicturePage()
    const blue = pictures(src).find((p) => p.pixels.width === 60)!
    const r = await applyOperation(src, { op: 'changePicture', page: 0, box: blue.box, change: { kind: 'move', rect: [150, 150, 210, 190] } })
    expect(r.note).toBeUndefined()
    expect(pixel(r.bytes, 70, 80)).toBe('0,160,0') // where it was: background again, no hole
    expect(pixel(r.bytes, 180, 170)).toBe('0,0,255') // where it went
    expect(pixel(r.bytes, 220, 260)).toBe('255,0,0') // the drawing is untouched
    expect(pictures(r.bytes)).toHaveLength(2)
  })

  it('resizes by moving to a bigger rectangle', async () => {
    const src = await makePicturePage()
    const blue = pictures(src).find((p) => p.pixels.width === 60)!
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: blue.box, change: { kind: 'move', rect: [40, 60, 160, 140] } })
    expect(pixel(bytes, 150, 130)).toBe('0,0,255')
  })

  it('deletes a picture, leaving what was behind it', async () => {
    const src = await makePicturePage()
    const blue = pictures(src).find((p) => p.pixels.width === 60)!
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: blue.box, change: { kind: 'delete' } })
    expect(pixel(bytes, 70, 80)).toBe('0,160,0')
    expect(pictures(bytes)).toHaveLength(1)
  })

  it('replaces a picture inside the same box, keeping the new one\'s proportions', async () => {
    const src = await makePicturePage()
    const blue = pictures(src).find((p) => p.pixels.width === 60)!
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: blue.box, change: { kind: 'replace', source: { data: Buffer.from(makePng(40, 40, [255, 255, 0])).toString('base64') } } })
    expect(pixel(bytes, 70, 80)).toBe('255,255,0') // centre of the old box
    expect(pixel(bytes, 42, 80)).toBe('0,160,0') // a square in a wide box leaves the sides
  })

  it('respects the author\'s restrictions', async () => {
    await expect(
      applyOperation(await makeRestrictedPdf(1), { op: 'addPicture', page: 0, rect: [10, 10, 50, 50], source: { data: Buffer.from(makePng(10, 10)).toString('base64') } })
    ).rejects.toMatchObject({ code: 'restricted' })
  })
})

// --- E2: a moved or replaced picture stays the picture it was ---------------------------------

type B = [number, number, number, number]

/** 40 × 20 pixels that show which way up and which way round they are: a black top, a red left side, blue elsewhere. */
function orientedPixmap(): mupdf.Pixmap {
  const w = 40
  const h = 20
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const px = pm.getPixels()
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = y < 5 ? [0, 0, 0] : x < 8 ? [255, 0, 0] : [0, 0, 255]
      px.set(c, (y * w + x) * 3)
    }
  return pm
}
function encoded(kind: 'png' | 'jpeg'): Uint8Array {
  const pm = orientedPixmap()
  try {
    return new Uint8Array(kind === 'png' ? pm.asPNG() : pm.asJPEG(95))
  } finally {
    pm.destroy()
  }
}

/**
 * Pages 300 × 300 drawn by raw content (the picture is /Im1; /Fm1 a form drawing it when `form` is
 * given; /F1 Helvetica for captions; `rotate` turns the pages).
 */
async function rawPicturePdf(contents: string[], options: { jpeg?: boolean; form?: string; rotate?: number } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const image = options.jpeg ? await pdf.embedJpg(encoded('jpeg')) : await pdf.embedPng(encoded('png'))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const ctx = pdf.context
  const xobjects: Record<string, PDFRef> = { Im1: image.ref }
  if (options.form) xobjects['Fm1'] = ctx.register(ctx.stream(options.form, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 300], Resources: { XObject: { Im1: image.ref } } }))
  const resources = ctx.register(ctx.obj({ XObject: xobjects, Font: { F1: font.ref } }))
  for (const content of contents) {
    const page = pdf.addPage([300, 300])
    if (options.rotate) page.node.set(PDFName.of('Rotate'), PDFNumber.of(options.rotate))
    page.node.set(PDFName.of('Resources'), resources)
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)))
  }
  return new Uint8Array(await pdf.save())
}

/** The rendered pixels (1:1) inside a displayed box on a page (one pixel in from each edge), row by row. */
function region(bytes: Uint8Array, box: B, page = 0): string[] {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const px = pm.getPixels()
    const out: string[] = []
    for (let y = box[1] + 1; y < box[3] - 1; y++)
      for (let x = box[0] + 1; x < box[2] - 1; x++) {
        const o = (y * pm.getWidth() + x) * 3
        out.push(`${px[o]},${px[o + 1]},${px[o + 2]}`)
      }
    pm.destroy()
    return out
  } finally {
    free(doc)
  }
}
const blank = (pixels: string[]): boolean => pixels.every((p) => p === '255,255,255')
const shifted = (b: B, dx: number, dy: number): B => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]
const rounded = (b: number[]): B => b.map(Math.round) as B

/** The filters of the image objects in a file (soft masks left out). */
function imageFilters(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    const masks = new Set<number>()
    const images: Array<{ num: number; filter: string }> = []
    for (let i = 1; i < doc.countObjects(); i++) {
      const o = doc.newIndirect(i)
      if (!o.isDictionary() || o.get('Subtype').asName() !== 'Image') continue
      if (o.get('SMask').isIndirect()) masks.add(o.get('SMask').asIndirect())
      images.push({ num: i, filter: o.get('Filter').isName() ? o.get('Filter').asName() : 'none' })
    }
    return images.filter((x) => !masks.has(x.num)).map((x) => x.filter).sort()
  } finally {
    free(doc)
  }
}

describe('moving and replacing a picture keeps the picture as it was (E2)', () => {
  // Displayed boxes (top-left origin) of the placements below.
  const TURNED: B = [110, 120, 150, 200] // 0 80 -40 0 150 100 cm
  const MIRRORED: B = [120, 210, 200, 250] // -80 0 0 40 200 50 cm

  for (const [name, cm, box] of [
    ['turned a quarter', '0 80 -40 0 150 100 cm', TURNED],
    ['mirrored', '-80 0 0 40 200 50 cm', MIRRORED]
  ] as const) {
    it(`a ${name} picture moves as it is: same direction, same pixels`, async () => {
      const src = await rawPicturePdf([`q ${cm} /Im1 Do Q`])
      const found = pictures(src)
      expect(found).toHaveLength(1)
      expect(rounded(found[0]!.box)).toEqual(box)
      const target = shifted(box, 60, -60)
      const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: found[0]!.box, change: { kind: 'move', rect: target } })
      expect(rounded(pictures(bytes)[0]!.box)).toEqual(target)
      expect(region(bytes, target)).toEqual(region(src, box))
      expect(imageFilters(bytes)).toEqual(imageFilters(src))
      expect(blank(region(bytes, [box[0], target[3] + 2, box[2], box[3]]))).toBe(true)
    })
  }

  it('a turned picture resized stays turned (its black top still on the left)', async () => {
    const src = await rawPicturePdf(['q 0 80 -40 0 150 100 cm /Im1 Do Q'])
    // Turned a quarter anticlockwise: the picture's top edge is on the left, its left side at the bottom.
    expect(pixel(src, 112, 160)).toBe('0,0,0')
    expect(pixel(src, 140, 195)).toBe('255,0,0')
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: pictures(src)[0]!.box, change: { kind: 'move', rect: [20, 20, 100, 180] } })
    expect(rounded(pictures(bytes)[0]!.box)).toEqual([20, 20, 100, 180])
    expect(pixel(bytes, 25, 100)).toBe('0,0,0')
    expect(pixel(bytes, 60, 175)).toBe('255,0,0')
    expect(pixel(bytes, 60, 100)).toBe('0,0,255')
  })

  it('a JPEG stays the same JPEG: not decoded and stored again', async () => {
    const src = await rawPicturePdf(['q 80 0 0 40 40 200 cm /Im1 Do Q'], { jpeg: true })
    expect(imageFilters(src)).toEqual(['DCTDecode'])
    const box = rounded(pictures(src)[0]!.box)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 100, 100) } })
    expect(imageFilters(bytes)).toEqual(['DCTDecode'])
    expect(region(bytes, shifted(box, 100, 100))).toEqual(region(src, box))
  })

  it('keeps its place in the drawing order: what was drawn over it stays over it', async () => {
    // A green square drawn after the picture, over its right part.
    const src = await rawPicturePdf(['q 80 0 0 40 40 220 cm /Im1 Do Q 0 0.6 0 rg 100 230 40 20 re f'])
    const box = rounded(pictures(src)[0]!.box)
    expect(pixel(src, 110, 60)).toBe('0,153,0')
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 20, 0) } })
    expect(pixel(bytes, 130, 60)).toBe('0,153,0') // still on top of the moved picture
    expect(pixel(bytes, 80, 60)).toBe('0,0,255') // the picture is there
  })

  it('a replacement takes the old picture’s place in the drawing order', async () => {
    const src = await rawPicturePdf(['q 80 0 0 40 40 220 cm /Im1 Do Q 0 0.6 0 rg 100 230 40 20 re f'])
    const box = rounded(pictures(src)[0]!.box)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'replace', source: { data: Buffer.from(makePng(80, 40, [255, 255, 0])).toString('base64') } } })
    expect(pixel(bytes, 60, 60)).toBe('255,255,0')
    expect(pixel(bytes, 110, 60)).toBe('0,153,0')
    expect(pictures(bytes)).toHaveLength(1)
  })

  it('a picture object drawn twice: only the chosen one moves or goes', async () => {
    const src = await rawPicturePdf(['q 80 0 0 40 40 220 cm /Im1 Do Q q 80 0 0 40 160 220 cm /Im1 Do Q'])
    const [A, Bx] = pictures(src).map((p) => rounded(p.box)).sort((p, q) => p[0] - q[0])
    const moved = await applyOperation(src, { op: 'changePicture', page: 0, box: Bx!, change: { kind: 'move', rect: shifted(Bx!, 0, 150) } })
    expect(pictures(moved.bytes)).toHaveLength(2)
    expect(region(moved.bytes, A!)).toEqual(region(src, A!))
    expect(region(moved.bytes, shifted(Bx!, 0, 150))).toEqual(region(src, Bx!))
    expect(blank(region(moved.bytes, Bx!))).toBe(true)
    expect(imageFilters(moved.bytes)).toEqual(imageFilters(src))
    const gone = await applyOperation(src, { op: 'changePicture', page: 0, box: A!, change: { kind: 'delete' } })
    expect(pictures(gone.bytes)).toHaveLength(1)
    expect(blank(region(gone.bytes, A!))).toBe(true)
    expect(region(gone.bytes, Bx!)).toEqual(region(src, Bx!))
  })

  it('a picture inside a form shared by two pages moves on this page only', async () => {
    const draw = 'q 1 0 0 1 40 200 cm /Fm1 Do Q'
    const src = await rawPicturePdf([draw, draw], { form: 'q 80 0 0 40 0 0 cm /Im1 Do Q' })
    const box = rounded(pictures(src)[0]!.box)
    expect(box).toEqual([40, 60, 120, 100])
    // Within the form's box (it clips at displayed y 100): changed in place, the same picture object.
    const inside = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 100, -50) } })
    expect(region(inside.bytes, shifted(box, 100, -50))).toEqual(region(src, box))
    expect(blank(region(inside.bytes, [box[0], 52, box[2], box[3]]))).toBe(true)
    expect(region(inside.bytes, box, 1)).toEqual(region(src, box, 1))
    expect(imageFilters(inside.bytes)).toEqual(imageFilters(src))
    // Out of the form's box it would be clipped away: removed there and drawn again over the page.
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 100, 100) } })
    expect(region(bytes, shifted(box, 100, 100))).toEqual(region(src, box))
    expect(blank(region(bytes, box))).toBe(true)
    expect(region(bytes, box, 1)).toEqual(region(src, box, 1))
    // The page's resources list the picture too (the form shares them): deleting takes the one drawn.
    const gone = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'delete' } })
    expect(blank(region(gone.bytes, box))).toBe(true)
    expect(region(gone.bytes, box, 1)).toEqual(region(src, box, 1))
  })

  it('moving it twice keeps one picture, still in its own direction', async () => {
    const src = await rawPicturePdf(['q 0 80 -40 0 150 100 cm /Im1 Do Q'])
    const once = await applyOperation(src, { op: 'changePicture', page: 0, box: TURNED, change: { kind: 'move', rect: shifted(TURNED, 60, -60) } })
    const twice = await applyOperation(once.bytes, { op: 'changePicture', page: 0, box: shifted(TURNED, 60, -60), change: { kind: 'move', rect: shifted(TURNED, -80, 60) } })
    expect(pictures(twice.bytes)).toHaveLength(1)
    expect(region(twice.bytes, shifted(TURNED, -80, 60))).toEqual(region(src, TURNED))
  })

  it('a picture its frame crops (a newspaper photo) moves with its crop: nothing hidden comes out', async () => {
    // Clipped to its left half, as InDesign frames do; it moves together with its frame (§83).
    const src = await rawPicturePdf(['q 40 220 40 40 re W n 80 0 0 40 40 220 cm /Im1 Do Q'], { jpeg: true })
    const box = rounded(pictures(src)[0]!.box)
    expect(box).toEqual([40, 40, 80, 80])
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 100, 100) } })
    expect(rounded(pictures(bytes)[0]!.box)).toEqual(shifted(box, 100, 100))
    expect(region(bytes, shifted(box, 100, 100))).toEqual(region(src, box))
    expect(blank(region(bytes, [182, 142, 222, 178]))).toBe(true) // the cropped-off half stays hidden
    expect(blank(region(bytes, box))).toBe(true)
    expect(imageFilters(bytes).every((f) => f === 'DCTDecode')).toBe(true) // still the same JPEG data
  })

  it('a cropped picture in a colour space MuPDF cannot copy as it is (Indexed) moves as PNG', async () => {
    const pdf = await PDFDocument.create()
    const ctx = pdf.context
    const image = ctx.register(ctx.stream(new Uint8Array([0, 1]), { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, BitsPerComponent: 8, ColorSpace: ctx.obj(['Indexed', 'DeviceRGB', 1, PDFHexString.of('ff00000000ff')]) }))
    const page = pdf.addPage([300, 300])
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im1: image } }))
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q 40 220 60 40 re W n 80 0 0 40 40 220 cm /Im1 Do Q')))
    const src = new Uint8Array(await pdf.save())
    const box = rounded(pictures(src)[0]!.box)
    expect(box).toEqual([40, 40, 100, 80])
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 100, 100) } })
    expect(pixel(bytes, 160, 160)).toBe('255,0,0')
    expect(pixel(bytes, 190, 160)).toBe('0,0,255')
    expect(pixel(bytes, 210, 160)).toBe('255,255,255') // cropped off
    expect(blank(region(bytes, box))).toBe(true)
  })

  it('an inline picture is moved too, turned as it was', async () => {
    // 2 × 1 pixels, red then blue, turned a quarter anticlockwise: red at the bottom, blue at the top.
    const src = await rawPicturePdf(['q 0 80 -40 0 150 100 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff00000000ff> EI Q'])
    const found = pictures(src)
    expect(found).toHaveLength(1)
    const box = rounded(found[0]!.box)
    expect(box).toEqual(TURNED)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: shifted(box, 60, 0) } })
    expect(pictures(bytes)).toHaveLength(1)
    expect(pixel(bytes, box[0] + 80, box[3] - 10)).toBe('255,0,0')
    expect(pixel(bytes, box[0] + 80, box[1] + 10)).toBe('0,0,255')
    expect(blank(region(bytes, box))).toBe(true)
  })
})

// --- E2, the open part (§83): a cropped newspaper photo moves with its frame, under its caption ---

describe('a picture its frame crops moves with its frame, in its place in the drawing order (E2, §83)', () => {
  // As InDesign writes a photo: the frame's clip, then the picture in its own group. The picture is
  // 80 × 40 pt, cropped to its left half: shown at [40, 60, 80, 100] (displayed, top-left origin).
  const FRAMED = 'q 40 200 40 40 re W n q 80 0 0 40 40 200 cm /Im1 Do Q Q'
  const SHOWN: B = [40, 60, 80, 100]
  // A caption drawn after the photo, over its lower part: a green band with black words.
  const CAPTION = '0 0.6 0 rg 30 205 70 12 re f BT /F1 10 Tf 0 0 0 rg 34 208 Td (Caption) Tj ET'
  const rgbOf = (p: string): number[] => p.split(',').map(Number)
  const bluish = (p: string): boolean => {
    const [r, g, b] = rgbOf(p)
    return b! > 150 && r! < 100 && g! < 100
  }
  const reddish = (p: string): boolean => {
    const [r, g, b] = rgbOf(p)
    return r! > 150 && g! < 100 && b! < 100
  }

  it('moved, the caption drawn after it stays on top, the picture stays the same JPEG and stays cropped', async () => {
    const src = await rawPicturePdf([`${FRAMED} ${CAPTION}`], { jpeg: true })
    expect(rounded(pictures(src)[0]!.box)).toEqual(SHOWN)
    // Before: the caption covers the photo's lower part.
    expect(region(src, [41, 84, 79, 94]).some(bluish)).toBe(false)
    const target = shifted(SHOWN, 15, 0)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: SHOWN, change: { kind: 'move', rect: target } })
    expect(pictures(bytes)).toHaveLength(1)
    expect(rounded(pictures(bytes)[0]!.box)).toEqual(target)
    // The caption is still over the moved photo: none of the photo's blue or red shows through it.
    const under = region(bytes, [56, 84, 94, 94])
    expect(under.some(bluish) || under.some(reddish)).toBe(false)
    expect(under.filter((p) => p === '0,153,0').length).toBeGreaterThan(under.length / 3)
    // Above the caption the photo is there, the same pixels, just moved.
    expect(region(bytes, [55, 60, 95, 82])).toEqual(region(src, [40, 60, 80, 82]))
    // Cropped to its moved frame: the half its frame hid stays hidden; nothing left where it was.
    expect(blank(region(bytes, [96, 60, 136, 82]))).toBe(true)
    expect(blank(region(bytes, [40, 60, 55, 82]))).toBe(true)
    // Changed where it is drawn: the one JPEG object, not drawn again from a copy.
    expect(imageFilters(bytes)).toEqual(['DCTDecode'])
  })

  it('resized, its crop grows with it (its black top and red left side where they were)', async () => {
    const src = await rawPicturePdf([FRAMED])
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: SHOWN, change: { kind: 'move', rect: [100, 120, 180, 200] } })
    expect(rounded(pictures(bytes)[0]!.box)).toEqual([100, 120, 180, 200])
    expect(pixel(bytes, 110, 125)).toBe('0,0,0')
    expect(pixel(bytes, 110, 170)).toBe('255,0,0')
    expect(pixel(bytes, 160, 170)).toBe('0,0,255')
    expect(pixel(bytes, 190, 170)).toBe('255,255,255') // the cropped-off half, still hidden
    expect(imageFilters(bytes)).toEqual(imageFilters(src))
  })

  it('moving it twice keeps one picture in its frame', async () => {
    const src = await rawPicturePdf([`${FRAMED} ${CAPTION}`], { jpeg: true })
    const once = await applyOperation(src, { op: 'changePicture', page: 0, box: SHOWN, change: { kind: 'move', rect: shifted(SHOWN, 15, 0) } })
    const twice = await applyOperation(once.bytes, { op: 'changePicture', page: 0, box: shifted(SHOWN, 15, 0), change: { kind: 'move', rect: shifted(SHOWN, 100, 100) } })
    expect(pictures(twice.bytes)).toHaveLength(1)
    expect(rounded(pictures(twice.bytes)[0]!.box)).toEqual(shifted(SHOWN, 100, 100))
    expect(region(twice.bytes, [140, 160, 180, 182])).toEqual(region(src, [40, 60, 80, 82]))
    expect(blank(region(twice.bytes, [181, 160, 221, 200]))).toBe(true) // still cropped
    expect(imageFilters(twice.bytes)).toEqual(['DCTDecode'])
  })

  it('one picture object in two frames: only the chosen one moves', async () => {
    const src = await rawPicturePdf([`${FRAMED} q 160 200 40 40 re W n q 80 0 0 40 160 200 cm /Im1 Do Q Q`])
    const other: B = [160, 60, 200, 100]
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: other, change: { kind: 'move', rect: shifted(other, 0, 120) } })
    expect(pictures(bytes)).toHaveLength(2)
    expect(region(bytes, SHOWN)).toEqual(region(src, SHOWN))
    expect(region(bytes, shifted(other, 0, 120))).toEqual(region(src, other))
    expect(blank(region(bytes, other))).toBe(true)
    expect(imageFilters(bytes)).toEqual(imageFilters(src))
  })

  it('on a turned page it moves with its frame too', async () => {
    const src = await rawPicturePdf([FRAMED], { rotate: 90 })
    const box = rounded(pictures(src)[0]!.box)
    const target = shifted(box, 20, 30)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'move', rect: target } })
    expect(rounded(pictures(bytes)[0]!.box)).toEqual(target)
    expect(region(bytes, target)).toEqual(region(src, box))
    expect(blank(region(bytes, [box[0], box[1], box[0] + 20, box[3]]))).toBe(true)
    expect(imageFilters(bytes)).toEqual(imageFilters(src)) // in place: no second copy of the picture
  })

  it('a frame that also draws something else is not moved: the picture alone moves, drawn again', async () => {
    // A green square under the photo inside the frame's group: moving the group would carry it along.
    const src = await rawPicturePdf(['q 40 200 40 40 re W n 0 0.6 0 rg 40 200 10 10 re f q 80 0 0 40 40 200 cm /Im1 Do Q Q'])
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box: SHOWN, change: { kind: 'move', rect: shifted(SHOWN, 100, 0) } })
    expect(rounded(pictures(bytes)[0]!.box)).toEqual(shifted(SHOWN, 100, 0))
    expect(pixel(bytes, 45, 95)).toBe('0,153,0') // the square stayed, uncovered now
    expect(pixel(bytes, 145, 95)).not.toBe('0,153,0')
    expect(blank(region(bytes, [182, 60, 222, 100]))).toBe(true) // still cropped
  })
})

describe('reading a content stream’s operators', () => {
  it('keeps arrays, dictionaries, strings and inline pictures together', async () => {
    const { contentOps } = await import('@engine/pictures')
    const ops = contentOps('q [1 2] 0 d /P <</MCID 3>> BDC (a (b) \\) Q) Tj BI /W 1 /H 1 ID x EI EMC 1 0 0 1 5 6 cm % note Q\n Q')
    expect(ops.map((o) => o.op)).toEqual(['q', 'd', 'BDC', 'Tj', 'BI', 'EMC', 'cm', 'Q'])
    expect(ops[1]!.operands).toEqual(['[1 2]', '0'])
    expect(ops[2]!.operands).toEqual(['/P', '<</MCID 3>>'])
    expect(ops[6]!.operands).toEqual(['1', '0', '0', '1', '5', '6'])
  })
})

describe('removing a picture leaves the person’s annotations alone (E1)', () => {
  it('deleting an inline picture keeps a link and a pending redaction mark elsewhere unapplied', async () => {
    const raw = await rawPicturePdf(['q 80 0 0 40 40 220 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff00000000ff> EI Q 0 0.6 0 rg 150 20 40 20 re f'])
    const pdf = await PDFDocument.load(raw)
    const ctx = pdf.context
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 220, 120, 260], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com') } }))
    pdf.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([link]))
    const linked = new Uint8Array(await pdf.save())
    const src = (await applyOperation(linked, { op: 'redactMark', marks: [{ page: 0, box: [150, 260, 190, 280] }] })).bytes
    const kinds = (bytes: Uint8Array): string[] => {
      const doc = openPdf(bytes)
      try {
        const annots = doc.findPage(0).get('Annots')
        const out: string[] = []
        for (let i = 0; i < annots.length; i++) out.push(annots.get(i).get('Subtype').asName())
        return out
      } finally {
        free(doc)
      }
    }
    expect(kinds(src)).toEqual(['Link', 'Redact'])
    const box = rounded(pictures(src)[0]!.box)
    const { bytes } = await applyOperation(src, { op: 'changePicture', page: 0, box, change: { kind: 'delete' } })
    expect(pictures(bytes)).toHaveLength(0)
    expect(kinds(bytes)).toEqual(['Link', 'Redact'])
    expect(pixel(bytes, 170, 270)).toBe('0,153,0') // the mark was not applied: the green under it is still there
  })
})

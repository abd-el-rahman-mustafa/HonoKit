import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { formFields } from '@engine/forms'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { autoFieldSize, MAX_FIELD_HEIGHT } from '@shared/fieldText'
import { applyOperation } from '@ops/index'

/**
 * A text field whose /DA asks for size 0 is "auto": the reader picks the size. For one line,
 * Acrobat fills the box's height, so a tall field shows tall text. Ours stopped at 12 pt
 * however tall the box was, which left the value small and sitting low in the box.
 *
 * Multi-line fields keep their own limit: their size follows the number of lines, not the box.
 */

const BOXES: Array<[string, number]> = [
  ['short', 16],
  ['tall', 30],
  ['taller', 60]
]

/** Single-line auto-sized fields of several heights, plus one asking for a fixed 12 pt. */
async function autoForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  const form = pdf.getForm()
  // Laid out down the page with a gap, so no box overlaps another: the ink in one is its own.
  let top = 360
  for (const [name, height] of BOXES) {
    form.createTextField(name).addToPage(page, { x: 40, y: top - height, width: 300, height })
    top -= height + 20
  }
  form.createTextField('fixed').addToPage(page, { x: 40, y: top - 30, width: 300, height: 30 })
  const bytes = new Uint8Array(await pdf.save())
  const doc = openPdf(bytes)
  try {
    const p = doc.loadPage(0) as mupdf.PDFPage
    for (const w of p.getWidgets()) {
      const da = w.getName() === 'fixed' ? '/Helv 12 Tf 0 g' : '/Helv 0 Tf 0 g'
      w.getObject().put('DA', doc.newString(da))
    }
    free(p)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** The largest size any `Tf` in the field's drawn appearance asks for. */
function drawnSize(bytes: Uint8Array, name: string): number {
  const doc = openPdf(bytes)
  try {
    const page = doc.loadPage(0) as mupdf.PDFPage
    try {
      const w = page.getWidgets().find((x) => x.getName() === name)
      if (!w) throw new Error(`no field ${name}`)
      const stream = w.getObject().get('AP').get('N')
      const buffer = stream.readStream()
      const content = Buffer.from(buffer.asUint8Array()).toString('latin1')
      buffer.destroy()
      const sizes = [...content.matchAll(/([\d.]+)\s+Tf/g)].map((m) => Number(m[1]))
      return sizes.length === 0 ? 0 : Math.max(...sizes)
    } finally {
      free(page)
    }
  } finally {
    free(doc)
  }
}

/** The height in points of the dark pixels inside a box of page 1, rendered at 1:1. */
function inkHeight(bytes: Uint8Array, b: [number, number, number, number]): number {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    const px = pm.getPixels()
    let top = Infinity
    let bottom = -Infinity
    for (let y = Math.ceil(b[1]) + 2; y < b[3] - 2; y++) {
      for (let x = Math.ceil(b[0]) + 2; x < b[2] - 2; x++) {
        if (px[y * pm.getWidth() + x]! < 128) {
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          break
        }
      }
    }
    return bottom < top ? 0 : bottom - top + 1
  } finally {
    free(doc)
  }
}

async function filled(): Promise<Uint8Array> {
  const src = await autoForm()
  const list = formFields(openPdf(src), 0)
  const { bytes } = await applyOperation(src, {
    op: 'fillForm',
    values: list.map((f) => ({ page: 0, index: f.index, value: 'Hg' }))
  })
  return bytes
}

describe('an auto-sized single line fills the field', () => {
  it('draws taller text in a taller box, past 12 pt', async () => {
    const bytes = await filled()
    const short = drawnSize(bytes, 'short')
    const tall = drawnSize(bytes, 'tall')
    const taller = drawnSize(bytes, 'taller')
    // A short box is unchanged: it never reached the old limit.
    expect(short).toBeGreaterThan(8)
    expect(short).toBeLessThan(11)
    // A 30 pt box asked for 12 pt before; it now follows its height.
    expect(tall).toBeGreaterThan(12)
    expect(taller).toBeGreaterThan(tall)
    expect(taller).toBeLessThan(60)
  })

  it('keeps a field that asks for a size at that size', async () => {
    expect(drawnSize(await filled(), 'fixed')).toBeCloseTo(12, 5)
  })

  it('shows the taller text on the page, inside its box', async () => {
    const bytes = await filled()
    const boxes = new Map(formFields(openPdf(bytes), 0).map((f) => [f.name, f.box]))
    const short = inkHeight(bytes, boxes.get('short')!)
    const taller = inkHeight(bytes, boxes.get('taller')!)
    expect(short).toBeGreaterThan(0)
    // The 60 pt box drew the same 12 pt as the 16 pt one before; its text is now far taller.
    expect(taller).toBeGreaterThan(short * 2.5)
  })

  it('stops at a size a hostile rectangle cannot blow up', async () => {
    const src = await autoForm()
    const doc = openPdf(src)
    const huge = (() => {
      try {
        const page = doc.loadPage(0) as mupdf.PDFPage
        const w = page.getWidgets().find((x) => x.getName() === 'tall')!
        const rect = w.getObject().get('Rect')
        rect.put(1, -1e9)
        rect.put(3, 1e9)
        free(page)
        return saveBytes(doc)
      } finally {
        free(doc)
      }
    })()
    const list = formFields(openPdf(huge), 0)
    const index = list.find((f) => f.name === 'tall')!.index
    const { bytes } = await applyOperation(huge, { op: 'fillForm', values: [{ page: 0, index, value: 'Hg' }] })
    const size = drawnSize(bytes, 'tall')
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(14_400)
  })
})

describe('the size a field with no size of its own is drawn at', () => {
  it('follows the box for one line and the lines for many', () => {
    expect(autoFieldSize(30, false)).toBeCloseTo(18.6, 5)
    expect(autoFieldSize(60, false)).toBeCloseTo(37.2, 5)
    // Many lines keep the smaller limit, whatever the box.
    expect(autoFieldSize(60, true)).toBeCloseTo(11, 5)
    expect(autoFieldSize(20, true)).toBeCloseTo(20 / 2.6, 5)
  })

  it('never returns an unusable size, however strange the box', () => {
    expect(autoFieldSize(0, false)).toBe(6)
    expect(autoFieldSize(-50, false)).toBe(6)
    expect(autoFieldSize(Number.NaN, false)).toBe(6)
    expect(autoFieldSize(Number.POSITIVE_INFINITY, false)).toBeCloseTo(MAX_FIELD_HEIGHT * 0.62, 5)
    expect(autoFieldSize(1e300, false)).toBeCloseTo(MAX_FIELD_HEIGHT * 0.62, 5)
    expect(autoFieldSize(Number.NaN, true)).toBe(0)
  })
})

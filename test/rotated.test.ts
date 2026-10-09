import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, degrees } from 'pdf-lib'
import { createDigitalId } from '@engine/sign'
import { formFields } from '@engine/forms'
import { pageMarkups } from '@engine/markup'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { applyOperation } from '@ops/index'
import type { OpInput } from '@shared/ops'
import { makePng } from './fixtures'

/**
 * Everything the person puts on a page must look the same on a turned page as on a plain one:
 * upright as the page is shown, where it was placed. The owner found a stamp on a rotated page
 * printed lying on its side (2026-10-08); these check every tool that draws on a page.
 *
 * The pages are square, so a page turned by /Rotate is shown with the same size as an unturned
 * one: the whole rendering of the turned result must match the unturned one. Some pages also
 * have a MediaBox that does not start at 0,0, which moves PDF space away from what is shown.
 */

const SIZE = 500

interface PageShape {
  rotate: 0 | 90 | 180 | 270
  /** MediaBox origin. */
  origin: [number, number]
}

async function blank(shape: PageShape): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([SIZE, SIZE])
  page.setMediaBox(shape.origin[0], shape.origin[1], SIZE, SIZE)
  if (shape.rotate) page.setRotation(degrees(shape.rotate))
  return new Uint8Array(await pdf.save())
}

/** Page 1 as shown (rotation and crop applied), grey, 1 pixel per point. */
function render(bytes: Uint8Array): { px: Uint8Array; width: number; height: number } {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    return { px: new Uint8Array(pm.getPixels()), width: pm.getWidth(), height: pm.getHeight() }
  } finally {
    free(doc)
  }
}

/** How many pixels are clearly darker than paper. */
const inked = (r: ReturnType<typeof render>): number => r.px.reduce((n, v) => n + (v < 200 ? 1 : 0), 0)

/**
 * The share of inked pixels that differ between two renderings. Anti-aliasing of a turned
 * drawing differs a little at its edges, so a pixel counts as different only when no pixel
 * within one step of it in the other picture is close in grey.
 */
function difference(a: ReturnType<typeof render>, b: ReturnType<typeof render>): number {
  expect([b.width, b.height]).toEqual([a.width, a.height])
  const w = a.width
  const h = a.height
  let ink = 0
  let off = 0
  const near = (p: Uint8Array, x: number, y: number, v: number): boolean => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && Math.abs(p[yy * w + xx]! - v) < 90) return true
      }
    return false
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const va = a.px[y * w + x]!
      const vb = b.px[y * w + x]!
      if (va >= 200 && vb >= 200) continue
      ink++
      if (!near(b.px, x, y, va) || !near(a.px, x, y, vb)) off++
    }
  return ink === 0 ? 0 : off / ink
}

const SHAPES: PageShape[] = [
  { rotate: 90, origin: [0, 0] },
  { rotate: 180, origin: [0, 0] },
  { rotate: 270, origin: [0, 0] },
  { rotate: 0, origin: [-40, 70] },
  { rotate: 90, origin: [30, -60] },
  { rotate: 270, origin: [55, 25] }
]

const dir = mkdtempSync(join(tmpdir(), 'honokit-rotated-'))
const logo = join(dir, 'logo.png')
writeFileSync(logo, makePng(60, 30, [20, 90, 200]))
// A picture that shows which way up it is: a dark bar along its top edge.
function arrowPng(): string {
  const w = 80
  const h = 50
  const raw = Buffer.alloc(w * h * 3, 255)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dark = y < 10 || (x < 10 && y < 35)
      if (dark) raw.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3)
    }
  const p = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  p.getPixels().set(raw)
  return Buffer.from(p.asPNG()).toString('base64')
}
const arrow = arrowPng()
const p12 = join(dir, 'id.p12')
writeFileSync(p12, createDigitalId('Test Signer', '', '', 'secret'))

/** Each step is applied in turn to the blank page; the last result is compared. */
const CASES: Array<{ name: string; steps: OpInput[] }> = [
  { name: 'stamp', steps: [{ op: 'markup', page: 0, markup: { kind: 'stamp', at: [180, 140], label: 'APPROVED', sub: 'by Test, 2026-10-08', colour: '#c0392b' } }] },
  { name: 'stamp (Arabic, bigger)', steps: [{ op: 'markup', page: 0, markup: { kind: 'stamp', at: [250, 300], label: 'معتمد', colour: '#1d4ed8', scale: 1.6 } }] },
  { name: 'text box', steps: [{ op: 'markup', page: 0, markup: { kind: 'textbox', rect: [60, 300, 260, 360], text: 'A text box that wraps onto a second line', colour: '#16a34a', size: 12 } }] },
  { name: 'callout', steps: [{ op: 'markup', page: 0, markup: { kind: 'callout', rect: [220, 60, 420, 110], to: [120, 220], text: 'Look here', colour: '#9333ea', size: 14 } }] },
  { name: 'rectangle', steps: [{ op: 'markup', page: 0, markup: { kind: 'rect', rect: [50, 80, 220, 130], colour: '#ff0000', width: 4 } }] },
  { name: 'ellipse', steps: [{ op: 'markup', page: 0, markup: { kind: 'ellipse', rect: [260, 300, 460, 360], colour: '#0000ff', width: 3, fill: '#00ff00' } }] },
  { name: 'arrow', steps: [{ op: 'markup', page: 0, markup: { kind: 'arrow', from: [60, 420], to: [300, 380], colour: '#000000', width: 3 } }] },
  { name: 'pen', steps: [{ op: 'markup', page: 0, markup: { kind: 'ink', strokes: [[[50, 50], [120, 90], [200, 60], [260, 140]]], colour: '#000000', width: 3 } }] },
  { name: 'note', steps: [{ op: 'markup', page: 0, markup: { kind: 'note', at: [300, 120], text: 'A note', colour: '#facc15' } }] },
  {
    name: 'note moved and revised',
    steps: [
      { op: 'markup', page: 0, markup: { kind: 'note', at: [300, 120], text: 'A note', colour: '#facc15' } },
      { op: 'changeMarkup', page: 0, index: 0, box: [0, 0, 0, 0], change: { kind: 'move', dx: -150, dy: 200 } },
      { op: 'changeMarkup', page: 0, index: 0, box: [0, 0, 0, 0], change: { kind: 'revise', text: 'Changed', colour: '#2563eb' } }
    ]
  },
  {
    name: 'stamp moved',
    steps: [
      { op: 'markup', page: 0, markup: { kind: 'stamp', at: [180, 140], label: 'DRAFT', colour: '#c0392b' } },
      { op: 'changeMarkup', page: 0, index: 0, box: [0, 0, 0, 0], change: { kind: 'move', dx: 90, dy: 160 } }
    ]
  },
  {
    name: 'stamp revised',
    steps: [
      { op: 'markup', page: 0, markup: { kind: 'stamp', at: [180, 140], label: 'DRAFT', colour: '#c0392b' } },
      { op: 'changeMarkup', page: 0, index: 0, box: [0, 0, 0, 0], change: { kind: 'revise', text: 'FINAL VERSION', colour: '#16a34a' } }
    ]
  },
  { name: 'added text', steps: [{ op: 'addText', page: 0, x: 60, y: 120, text: 'Added words Hello', size: 22 }] },
  { name: 'added Arabic text in a box', steps: [{ op: 'addText', page: 0, x: 440, y: 200, text: 'نص عربي مضاف إلى الصفحة يلتف', size: 18, width: 200, direction: 'rtl' }] },
  { name: 'picture', steps: [{ op: 'addPicture', page: 0, rect: [100, 150, 260, 250], source: { data: arrow } }] },
  {
    name: 'picture moved',
    steps: [
      { op: 'addPicture', page: 0, rect: [100, 150, 260, 250], source: { data: arrow } },
      { op: 'changePicture', page: 0, box: [100, 150, 260, 250], change: { kind: 'move', rect: [220, 300, 460, 450] } }
    ]
  },
  { name: 'watermark text', steps: [{ op: 'watermark', text: 'CONFIDENTIAL', size: 48, rotation: 30, opacity: 0.6 }] },
  { name: 'watermark picture', steps: [{ op: 'watermark', imagePath: logo, opacity: 0.8, rotation: 0, position: 'top-left' }] },
  { name: 'page numbers', steps: [{ op: 'pageNumbers', template: 'Page {n} of {N}', position: 'bottom-right', size: 14 }] },
  { name: 'header and footer', steps: [{ op: 'headerFooter', slots: { topLeft: 'Top left', topCenter: 'Middle', bottomRight: 'Page {n}' }, size: 14, date: '', file: '' }] },
  {
    name: 'form fields',
    steps: [
      {
        op: 'addFields',
        fields: [
          { page: 0, box: [40, 40, 240, 64], kind: 'text', name: 'Name' },
          { page: 0, box: [260, 40, 280, 60], kind: 'checkbox', name: 'Agree' },
          { page: 0, box: [40, 90, 200, 114], kind: 'dropdown', name: 'City', options: ['Dubai', 'Sharjah'] },
          { page: 0, box: [40, 140, 300, 200], kind: 'multiline', name: 'Notes' }
        ]
      }
    ]
  },
  { name: 'redaction applied', steps: [{ op: 'addText', page: 0, x: 60, y: 120, text: 'Secret words here', size: 22 }, { op: 'redactMark', marks: [{ page: 0, box: [55, 95, 200, 130] }] }, { op: 'redactApply', fill: '#000000', label: 'X' }] },
  { name: 'redaction marked', steps: [{ op: 'redactMark', marks: [{ page: 0, box: [55, 95, 200, 130] }] }] },
  { name: 'digital signature', steps: [{ op: 'certSign', page: 0, box: [200, 380, 440, 450], p12Path: p12, password: 'secret', reason: 'Approved', labels: { signedBy: 'Digitally signed by', date: '2026-10-08' } }] }
]

/** Form values are filled after the fields exist; done separately because they need the indexes. */
async function fillAll(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = openPdf(bytes)
  let list
  try {
    list = formFields(doc)
  } finally {
    free(doc)
  }
  const values = list.map((f) => ({ page: f.page, index: f.index, value: f.kind === 'checkbox' ? true : f.kind === 'combo' ? 'Sharjah' : f.name === 'Notes' ? 'ملاحظات تلتف على سطرين داخل الحقل الطويل' : 'Ahmed أحمد' }))
  return (await applyOperation(bytes, { op: 'fillForm', values })).bytes
}

async function run(steps: OpInput[], shape: PageShape): Promise<Uint8Array> {
  let bytes = await blank(shape)
  for (const step of steps) {
    // Moving a markup names it by the box it is shown at; fill that in from the page.
    if (step.op === 'changeMarkup') {
      const doc = openPdf(bytes)
      try {
        const m = pageMarkups(doc, 0)[0]!
        step.box = m.box
        step.index = m.index
      } finally {
        free(doc)
      }
    }
    bytes = (await applyOperation(bytes, step)).bytes
  }
  return bytes
}

describe('tools on rotated pages and pages with a moved origin', () => {
  for (const c of CASES) {
    it(`${c.name} looks the same as on a plain page`, async () => {
      const plain = render(await run(c.steps, { rotate: 0, origin: [0, 0] }))
      expect(inked(plain)).toBeGreaterThan(c.name === 'redaction marked' ? 50 : 100)
      const bad: string[] = []
      for (const shape of SHAPES) {
        const d = difference(plain, render(await run(c.steps, shape)))
        if (d > 0.03) bad.push(`/Rotate ${shape.rotate}, origin ${shape.origin.join(',')}: ${(d * 100).toFixed(1)}% differs`)
      }
      expect(bad).toEqual([])
    })
  }

  it('filled form fields look the same as on a plain page', async () => {
    const steps = CASES.find((c) => c.name === 'form fields')!.steps
    const plain = render(await fillAll(await run(steps, { rotate: 0, origin: [0, 0] })))
    const bad: string[] = []
    for (const shape of SHAPES) {
      const d = difference(plain, render(await fillAll(await run(steps, shape))))
      if (d > 0.03) bad.push(`/Rotate ${shape.rotate}, origin ${shape.origin.join(',')}: ${(d * 100).toFixed(1)}% differs`)
    }
    expect(bad).toEqual([])
  })
})

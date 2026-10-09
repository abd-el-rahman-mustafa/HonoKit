import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, inflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { MARKUP_KEY } from '@shared/brand'
import { formFields } from '@engine/forms'
import { pageMarkups } from '@engine/markup'
import { free, mupdf, openPdf, saveBytes, SAVE_FINAL } from '@engine/mupdf'
import { buildCms, createDigitalId, loadDigitalId, signWithCertificate, verifySignatures } from '@engine/sign'
import { extractText } from '@engine/text'
import { uprightMatrix } from '@engine/upright'
import { applyOperation } from '@ops/index'
import { Sessions } from '../src/worker/sessions'
import { makeLatinPdf } from './fixtures'

/**
 * Fixes of 2026-10-08: what redaction leaves behind, drawn markup
 * after the page turns, foreign text boxes, password and multi-widget fields, signature checks.
 */

const LABELS = { signedBy: 'Digitally signed', date: '2026-10-08' }
const P12 = createDigitalId('Test Signer', '', '', 'secret')

// --- helpers ---------------------------------------------------------------------------------

/** Every readable form of the file: the raw bytes, every stream inflated, and every object as MuPDF reads it. */
function haystacks(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes)
  const out = [buf.toString('latin1')]
  let at = 0
  for (;;) {
    const s = buf.indexOf('stream', at)
    if (s < 0) break
    if (s >= 3 && buf.subarray(s - 3, s).toString('latin1') === 'end') {
      at = s + 6
      continue
    }
    let start = s + 6
    if (buf[start] === 13) start++
    if (buf[start] === 10) start++
    const e = buf.indexOf('endstream', start)
    if (e < 0) break
    const data = buf.subarray(start, e)
    try {
      out.push(inflateSync(data).toString('latin1'))
    } catch {
      try {
        out.push(inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1'))
      } catch {
        /* not deflated */
      }
    }
    at = e + 9
  }
  const doc = openPdf(bytes)
  try {
    for (let i = 1; i < doc.countObjects(); i++) {
      try {
        const o = doc.newIndirect(i)
        out.push(o.resolve().toString())
        if (o.isStream()) out.push(Buffer.from(o.readStream().asUint8Array()).toString('latin1'))
      } catch {
        /* a free object */
      }
    }
  } finally {
    free(doc)
  }
  return out
}

/** The words found anywhere in the file, in any encoding a PDF string or content stream may use. */
function leaked(bytes: Uint8Array, words: string[]): string[] {
  const hays = haystacks(bytes)
  const upper = hays.map((h) => h.toUpperCase())
  const hex = (w: string): string => Buffer.from(w, 'latin1').toString('hex').toUpperCase()
  const hex16 = (w: string): string => [...w].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
  const raw16 = (w: string): string => [...w].map((c) => `\0${c}`).join('')
  return words.filter((w) => hays.some((h, i) => h.includes(w) || h.includes(raw16(w)) || upper[i]!.includes(hex(w)) || upper[i]!.includes(hex16(w))))
}

function markups(bytes: Uint8Array, page = 0) {
  const doc = openPdf(bytes)
  try {
    return pageMarkups(doc, page)
  } finally {
    free(doc)
  }
}

function fields(bytes: Uint8Array) {
  const doc = openPdf(bytes)
  try {
    return formFields(doc)
  } finally {
    free(doc)
  }
}

function text(bytes: Uint8Array, page = 0): string {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, page)
  } finally {
    free(doc)
  }
}

/** Page 1's /Annots by subtype; a pop-up names the subtype of its parent, which must still be on the page. */
function annotSummary(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    const annots = doc.findPage(0).get('Annots')
    const items = Array.from({ length: annots.isArray() ? annots.length : 0 }, (_, i) => annots.get(i))
    const onPage = new Set(items.map((a) => a.asIndirect()))
    return items.map((a) => {
      const type = a.get('Subtype').asName()
      if (type !== 'Popup') return type
      const parent = a.get('Parent')
      return onPage.has(parent.asIndirect()) ? `Popup of ${parent.get('Subtype').asName()}` : 'Popup of a removed annotation'
    })
  } finally {
    free(doc)
  }
}

/** The text the form fields of page 1 show (their appearances). */
function widgetText(bytes: Uint8Array, page = 0): string {
  const doc = openPdf(bytes)
  try {
    return (doc.loadPage(page) as mupdf.PDFPage)
      .getWidgets()
      .map((w) => w.toDisplayList().toStructuredText('preserve-whitespace').asText())
      .join('\n')
  } finally {
    free(doc)
  }
}

/** Pixels in a box of page 1 (displayed points, 1:1) that are clearly not white. */
function ink(bytes: Uint8Array, b: [number, number, number, number], page = 0): number {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    const px = pm.getPixels()
    let n = 0
    for (let y = Math.max(0, Math.ceil(b[1])); y < Math.min(pm.getHeight(), b[3]); y++) for (let x = Math.max(0, Math.ceil(b[0])); x < Math.min(pm.getWidth(), b[2]); x++) if (px[y * pm.getWidth() + x]! < 160) n++
    return n
  } finally {
    free(doc)
  }
}

const centre = (b: number[]): [number, number] => [(b[0]! + b[2]!) / 2, (b[1]! + b[3]!) / 2]

/** Edits the file with MuPDF's object API, as another program would have. */
function edit(bytes: Uint8Array, fn: (doc: mupdf.PDFDocument, page: mupdf.PDFPage) => void, pageIndex = 0): Uint8Array {
  const doc = openPdf(bytes)
  try {
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    fn(doc, page)
    free(page)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

// --- redaction -------------------------------------------------------------------------------

const GONE = ['Zebrafish', 'Axolotl', 'Pangolin', 'Quokka', 'Wombat', 'Ibis', 'Tapir', 'Narwhal', 'Okapi']
const KEPT = ['Keepsake', 'Elsewhere']
/** Displayed points (top-left, y down) on a 500 × 500 page. */
const MARK: [number, number, number, number] = [20, 80, 480, 160]

/** A page whose marked band carries text, every kind of comment, our stamp and form fields. */
async function redactFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([500, 500])
  page.drawText('Keep this line visible', { x: 40, y: 460, size: 12, font })
  page.drawText('Secret Zebrafish here', { x: 40, y: 400, size: 14, font })
  page.drawText('A Keepsake far away', { x: 40, y: 200, size: 12, font })
  const form = pdf.getForm()
  const pet = form.createTextField('pet')
  pet.setText('Axolotl')
  pet.addToPage(page, { x: 300, y: 390, width: 150, height: 24, font })
  const shared = form.createTextField('shared')
  shared.setText('Pangolin')
  shared.addToPage(page, { x: 300, y: 350, width: 150, height: 24, font })
  // Its second widget lies outside the mark: the whole field must still go.
  shared.addToPage(page, { x: 40, y: 40, width: 150, height: 24, font })
  let bytes: Uint8Array = new Uint8Array(await pdf.save())
  bytes = edit(bytes, (doc, p) => {
    const note = p.createAnnotation('Text')
    note.setRect([60, 110, 80, 130])
    note.setContents('Quokka note')
    note.setPopup([100, 100, 250, 180])
    note.update()
    const reply = p.createAnnotation('Text')
    reply.setRect([400, 400, 420, 420])
    reply.setContents('Wombat reply')
    reply.getObject().put('IRT', note.getObject())
    reply.update()
    const hl = p.createAnnotation('Highlight')
    hl.setQuadPoints([[40, 88, 200, 88, 40, 104, 200, 104]])
    hl.setContents('Highlight Ibis')
    hl.update()
    const sq = p.createAnnotation('Square')
    sq.setRect([100, 120, 200, 150])
    sq.setContents('Square Tapir')
    sq.update()
    const inkA = p.createAnnotation('Ink')
    inkA.setInkList([[[30, 140], [60, 150], [90, 140]]])
    inkA.setContents('Ink Okapi')
    inkA.update()
    const line = p.createAnnotation('Line')
    line.setLine([200, 140], [260, 150])
    line.update()
    const far = p.createAnnotation('Text')
    far.setRect([400, 300, 420, 320])
    far.setContents('Elsewhere kept')
    far.update()
    void doc
  })
  const { bytes: stamped } = await applyOperation(bytes, { op: 'markup', page: 0, markup: { kind: 'stamp', at: [250, 125], label: 'Narwhal', colour: '#c0392b' } })
  return stamped
}

async function redact(bytes: Uint8Array) {
  const marked = await applyOperation(bytes, { op: 'redactMark', marks: [{ page: 0, box: MARK }] })
  return applyOperation(marked.bytes, { op: 'redactApply', label: 'REDACTED' })
}

describe('redaction leaves nothing behind', () => {
  it('fixture: every word is there before redacting', async () => {
    const src = await redactFixture()
    expect(leaked(src, GONE)).toEqual(GONE)
    expect(leaked(src, KEPT)).toEqual(KEPT)
  })

  it('removes the text, comments, replies, stamps and fields under the marks, from every object in the file', async () => {
    const src = await redactFixture()
    const r = await redact(src)
    expect(r.note?.key).toBe('note.redacted')
    expect(r.note?.values?.leftover).toBe(0)
    expect(leaked(r.bytes, GONE)).toEqual([])
    expect(leaked(r.bytes, KEPT)).toEqual(KEPT)
    expect(text(r.bytes)).toContain('Keepsake')
    expect(text(r.bytes)).toContain('REDACTED')
    // Only the comment outside the mark is left (with no popup or reply of a removed one).
    expect(markups(r.bytes).map((m) => m.text)).toEqual(['Elsewhere kept'])
    expect(fields(r.bytes)).toEqual([])
    // The kept note's own pop-up (MuPDF gives every note one) is all that is left with it.
    expect(annotSummary(r.bytes)).toEqual(['Text', 'Popup of Text'])
    const doc = openPdf(r.bytes)
    try {
      const acro = doc.getTrailer().get('Root').get('AcroForm')
      expect(acro.isDictionary() ? acro.get('Fields').length : 0).toBe(0)
    } finally {
      free(doc)
    }
  }, 60_000)

  it('rewrites a signed file in full, so the original revision is gone, and says the signatures broke', async () => {
    const signed = await signWithCertificate(await redactFixture(), { p12: P12, password: 'secret', page: 0, box: [300, 300, 480, 360], labels: LABELS })
    expect((await verifySignatures(signed))[0]!.valid).toBe(true)
    const r = await redact(signed)
    expect(r.note?.key).toBe('note.redactedSigned')
    expect(r.note?.values?.leftover).toBe(0)
    expect(leaked(r.bytes, GONE)).toEqual([])
    expect(text(r.bytes)).toContain('Keepsake')
    expect((await verifySignatures(r.bytes)).every((s) => !s.valid)).toBe(true)
    // The session's Save of that version (appended, as for any signed file) keeps it clean.
    const doc = openPdf(r.bytes)
    const saved = saveBytes(doc, SAVE_FINAL)
    free(doc)
    expect(leaked(saved, GONE)).toEqual([])
  }, 60_000)

  it('redact, then sign: the signature is appended to a file that no longer holds the words', async () => {
    const r = await redact(await redactFixture())
    const signed = await signWithCertificate(r.bytes, { p12: P12, password: 'secret', page: 0, box: [300, 300, 480, 360], labels: LABELS })
    expect((await verifySignatures(signed))[0]!.valid).toBe(true)
    expect(leaked(signed, GONE)).toEqual([])
    const doc = openPdf(signed)
    const saved = saveBytes(doc, SAVE_FINAL)
    free(doc)
    expect(leaked(saved, GONE)).toEqual([])
    expect((await verifySignatures(saved))[0]!.valid).toBe(true)
  }, 60_000)

  it('a label with the same letters as the redacted words still checks clean', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 200]).drawText('REDACTED DATA here', { x: 20, y: 150, size: 14, font })
    const src = new Uint8Array(await pdf.save())
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [15, 35, 200, 55] }] })
    const r = await applyOperation(marked.bytes, { op: 'redactApply', label: 'REDACTED' })
    expect(r.note?.values?.leftover).toBe(0)
    expect(text(r.bytes)).not.toContain('DATA')
  })
})

// --- drawn markup on a page turned or cropped later -------------------------------------------

async function square(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.addPage([500, 500])
  return new Uint8Array(await pdf.save())
}

function apMatrix(bytes: Uint8Array): number[] {
  const doc = openPdf(bytes)
  try {
    const m = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0]!.getObject().get('AP').get('N').get('Matrix')
    return m.isArray() ? Array.from({ length: 6 }, (_, i) => m.get(i).asNumber()) : [1, 0, 0, 1, 0, 0]
  } finally {
    free(doc)
  }
}

function pageUpright(bytes: Uint8Array): number[] {
  const doc = openPdf(bytes)
  try {
    return uprightMatrix(doc.loadPage(0) as mupdf.PDFPage)
  } finally {
    free(doc)
  }
}

describe('changing drawn markup after the page was turned', () => {
  const cases = [
    { name: 'stamp', markup: { kind: 'stamp' as const, at: [150, 120] as [number, number], label: 'APPROVED', colour: '#c0392b' } },
    { name: 'text box', markup: { kind: 'textbox' as const, rect: [60, 300, 260, 340] as [number, number, number, number], text: 'A text box', colour: '#16a34a', size: 12 } }
  ]
  for (const c of cases) {
    it(`keeps a ${c.name} where it is shown, upright, when its colour changes`, async () => {
      const { bytes } = await applyOperation(await square(), { op: 'markup', page: 0, markup: c.markup })
      const [m] = markups(bytes)
      const turned = await applyOperation(bytes, { op: 'rotate', pages: [0], angle: 90 })
      const [shown] = markups(turned.bytes)
      const revised = await applyOperation(turned.bytes, { op: 'changeMarkup', page: 0, index: shown!.index, box: shown!.box, change: { kind: 'revise', colour: '#1d4ed8' } })
      const [n] = markups(revised.bytes)
      const [cx, cy] = centre(shown!.box)
      expect(centre(n!.box)[0]).toBeCloseTo(cx, 0)
      expect(centre(n!.box)[1]).toBeCloseTo(cy, 0)
      // Upright as shown: the drawing's own width and height, not swapped.
      expect(n!.box[2] - n!.box[0]).toBeCloseTo(m!.box[2] - m!.box[0], 0)
      expect(n!.box[3] - n!.box[1]).toBeCloseTo(m!.box[3] - m!.box[1], 0)
      // (+ 0 turns −0 into 0: the file cannot tell them apart.)
      expect(apMatrix(revised.bytes).map((v) => v + 0)).toEqual(pageUpright(revised.bytes).map((v) => v + 0))
      expect(ink(revised.bytes, n!.box)).toBeGreaterThan(100)
      // And the text changes too, still in place.
      const again = await applyOperation(revised.bytes, { op: 'changeMarkup', page: 0, index: n!.index, box: n!.box, change: { kind: 'revise', text: 'REJECTED' } })
      const [k] = markups(again.bytes)
      expect(centre(k!.box)[0]).toBeCloseTo(cx, -1)
      expect(centre(k!.box)[1]).toBeCloseTo(cy, -1)
    })
  }

  it('keeps a callout pointing at the same spot after the page turned', async () => {
    const tip: [number, number] = [120, 220]
    const { bytes } = await applyOperation(await square(), { op: 'markup', page: 0, markup: { kind: 'callout', rect: [220, 60, 420, 110], to: tip, text: 'Look here', colour: '#111111', size: 14 } })
    const turned = await applyOperation(bytes, { op: 'rotate', pages: [0], angle: 90 })
    const [shown] = markups(turned.bytes)
    const revised = await applyOperation(turned.bytes, { op: 'changeMarkup', page: 0, index: shown!.index, box: shown!.box, change: { kind: 'revise', text: 'Look here now' } })
    const [n] = markups(revised.bytes)
    // Turned a quarter clockwise: (x, y) is shown at (500 − y, x).
    const at: [number, number] = [500 - tip[1], tip[0]]
    expect(ink(revised.bytes, [at[0] - 8, at[1] - 8, at[0] + 8, at[1] + 8])).toBeGreaterThan(3)
    expect(n!.box[0]).toBeLessThan(at[0])
    expect(n!.box[2]).toBeGreaterThan(at[0])
    expect(n!.box[1]).toBeLessThan(at[1])
    expect(n!.box[3]).toBeGreaterThan(at[1])
  })

  it('keeps a stamp in place after the page was cropped', async () => {
    const { bytes } = await applyOperation(await square(), { op: 'markup', page: 0, markup: { kind: 'stamp', at: [250, 250], label: 'DRAFT', colour: '#c0392b' } })
    const cropped = await applyOperation(bytes, { op: 'crop', pages: [0], margins: { top: 50, right: 0, bottom: 0, left: 80 } })
    const [shown] = markups(cropped.bytes)
    const revised = await applyOperation(cropped.bytes, { op: 'changeMarkup', page: 0, index: shown!.index, box: shown!.box, change: { kind: 'revise', colour: '#1d4ed8' } })
    const [n] = markups(revised.bytes)
    expect(centre(n!.box)[0]).toBeCloseTo(centre(shown!.box)[0], 0)
    expect(centre(n!.box)[1]).toBeCloseTo(centre(shown!.box)[1], 0)
  })
})

// --- text boxes made by other programs ---------------------------------------------------------

function foreignFreeText(bytes: Uint8Array, callout: boolean): Uint8Array {
  return edit(bytes, (_doc, p) => {
    const a = p.createAnnotation('FreeText')
    a.setRect(callout ? [40, 100, 300, 320] : [100, 100, 300, 160])
    a.setContents('Hello')
    a.setDefaultAppearance('Helv', 14, [1, 0, 0])
    if (callout) {
      a.setIntent('FreeTextCallout')
      a.setCalloutLine([
        [60, 300],
        [120, 200],
        [140, 160]
      ])
    }
    a.update()
  })
}

function spec(bytes: Uint8Array): { kind: string; size: number; colour: number[]; text: string } | null {
  const doc = openPdf(bytes)
  try {
    const ours = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0]!.getObject().get(MARKUP_KEY)
    // Not ours yet: no spec (MuPDF's null object has no entries to look up).
    if (!ours.isDictionary()) return null
    const s = ours.get('Spec')
    return s.isString() ? JSON.parse(s.asString()) : null
  } finally {
    free(doc)
  }
}

function calloutLine(bytes: Uint8Array): number[] {
  const doc = openPdf(bytes)
  try {
    const cl = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0]!.getObject().get('CL')
    return Array.from({ length: cl.length }, (_, i) => cl.get(i).asNumber())
  } finally {
    free(doc)
  }
}

describe('text boxes made in other programs', () => {
  it('draws Arabic itself when the text of an Acrobat-made text box changes', async () => {
    const src = foreignFreeText(await makeLatinPdf(1), false)
    const [m] = markups(src).filter((x) => x.kind === 'textbox')
    expect(spec(src)).toBeNull()
    const revised = await applyOperation(src, { op: 'changeMarkup', page: 0, index: m!.index, box: m!.box, change: { kind: 'revise', text: 'مرحبا بالعالم' } })
    const [n] = markups(revised.bytes).filter((x) => x.kind === 'textbox')
    expect(n!.text).toBe('مرحبا بالعالم')
    const s = spec(revised.bytes)
    expect(s?.kind).toBe('textbox')
    expect(s?.size).toBe(14)
    expect(s?.colour).toEqual([1, 0, 0])
    expect(ink(revised.bytes, [n!.box[0] + 3, n!.box[1] + 3, n!.box[2] - 3, n!.box[3] - 3])).toBeGreaterThan(40)
  })

  it('redraws a foreign callout as a callout, and moves its callout line with it', async () => {
    const src = foreignFreeText(await makeLatinPdf(1), true)
    const [m] = markups(src).filter((x) => x.kind === 'callout')
    const before = calloutLine(src)
    const moved = await applyOperation(src, { op: 'changeMarkup', page: 0, index: m!.index, box: m!.box, change: { kind: 'move', dx: 20, dy: 30 } })
    const after = calloutLine(moved.bytes)
    // PDF space: x the same way, y the other way.
    expect(after.length).toBe(before.length)
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]! + (i % 2 === 0 ? 20 : -30), 1))
    const [mm] = markups(moved.bytes).filter((x) => x.kind === 'callout')
    const revised = await applyOperation(moved.bytes, { op: 'changeMarkup', page: 0, index: mm!.index, box: mm!.box, change: { kind: 'revise', text: 'انظر هنا' } })
    expect(spec(revised.bytes)?.kind).toBe('callout')
    const [n] = markups(revised.bytes).filter((x) => x.kind === 'callout')
    expect(n!.text).toBe('انظر هنا')
    expect(ink(revised.bytes, n!.box)).toBeGreaterThan(40)
  })
})

// --- forms -----------------------------------------------------------------------------------

describe('form filling', () => {
  it('draws a password field as bullets', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 400])
    const f = pdf.getForm().createTextField('pin')
    f.enablePassword()
    f.addToPage(page, { x: 40, y: 300, width: 200, height: 24 })
    const src = new Uint8Array(await pdf.save())
    const [w] = fields(src)
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: w!.index, value: 'Secret123' }] })
    // Page text leaves widgets out: read what the field's own appearance shows.
    const shown = widgetText(bytes)
    expect(shown).not.toContain('Secret')
    expect(shown).toContain('•••••••••')
    expect(ink(bytes, [44, 78, 236, 96])).toBeGreaterThan(20)
  })

  it('draws every widget of a field that appears twice', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 400])
    const f = pdf.getForm().createTextField('shared')
    f.addToPage(page, { x: 40, y: 300, width: 200, height: 30 })
    f.addToPage(page, { x: 40, y: 100, width: 200, height: 30 })
    const src = new Uint8Array(await pdf.save())
    const list = fields(src)
    expect(list).toHaveLength(2)
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: list[0]!.index, value: 'محمد علي' }] })
    // Displayed boxes: y from the top.
    expect(ink(bytes, [44, 72, 236, 98])).toBeGreaterThan(30)
    expect(ink(bytes, [44, 272, 236, 298])).toBeGreaterThan(30)
  })

  it('removes a field whose widget is a kid: the parent goes when it has no widgets left', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 400])
    const f = pdf.getForm().createTextField('kid')
    f.addToPage(page, { x: 40, y: 300, width: 200, height: 30 })
    f.addToPage(page, { x: 40, y: 100, width: 200, height: 30 })
    const src = new Uint8Array(await pdf.save())
    const one = await applyOperation(src, { op: 'removeField', page: 0, index: 0 })
    expect(fields(one.bytes)).toHaveLength(1)
    const two = await applyOperation(one.bytes, { op: 'removeField', page: 0, index: 0 })
    expect(fields(two.bytes)).toHaveLength(0)
    const doc = openPdf(two.bytes)
    try {
      expect(doc.getTrailer().get('Root').get('AcroForm').get('Fields').length).toBe(0)
    } finally {
      free(doc)
    }
  })

  it('drops the rich-text value when a field is filled', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 400])
    pdf.getForm().createTextField('rich').addToPage(page, { x: 40, y: 300, width: 200, height: 30 })
    let src: Uint8Array = new Uint8Array(await pdf.save())
    src = edit(src, (doc, p) => p.getWidgets()[0]!.getObject().put('RV', doc.newString('<body>old</body>')))
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: 0, value: 'new' }] })
    const doc = openPdf(bytes)
    try {
      expect((doc.loadPage(0) as mupdf.PDFPage).getWidgets()[0]!.getObject().get('RV').isNull()).toBe(true)
    } finally {
      free(doc)
    }
  })
})

// --- comments ---------------------------------------------------------------------------------

describe('deleting a comment', () => {
  it('deletes its replies (and theirs) and its pop-up too', async () => {
    const src = edit(await makeLatinPdf(1), (_doc, p) => {
      const note = p.createAnnotation('Text')
      note.setRect([60, 60, 80, 80])
      note.setContents('Parent')
      note.setPopup([100, 60, 250, 140])
      note.update()
      const reply = p.createAnnotation('Text')
      reply.setRect([60, 60, 80, 80])
      reply.setContents('Reply')
      reply.getObject().put('IRT', note.getObject())
      reply.update()
      const replyToReply = p.createAnnotation('Text')
      replyToReply.setRect([60, 60, 80, 80])
      replyToReply.setContents('Reply to reply')
      replyToReply.getObject().put('IRT', reply.getObject())
      replyToReply.update()
      const other = p.createAnnotation('Text')
      other.setRect([300, 300, 320, 320])
      other.setContents('Other')
      other.update()
    })
    const parent = markups(src).find((m) => m.text === 'Parent')!
    const { bytes } = await applyOperation(src, { op: 'changeMarkup', page: 0, index: parent.index, box: parent.box, change: { kind: 'delete' } })
    expect(markups(bytes).map((m) => m.text)).toEqual(['Other'])
    // MuPDF gives every note a pop-up of its own: only Other's is left.
    expect(annotSummary(bytes)).toEqual(['Text', 'Popup of Text'])
    expect(markups(bytes).map((m) => m.text)).toEqual(['Other'])
  })
})

// --- signatures -------------------------------------------------------------------------------

/** Rewrites a signed file's /ByteRange and signs exactly the bytes it names: crypto that checks, over the wrong bytes. */
function resign(signed: Uint8Array, range: (cStart: number, cEnd: number, length: number) => [number, number, number, number], append = ''): Uint8Array {
  const buf = Buffer.concat([Buffer.from(signed), Buffer.from(append, 'latin1')])
  const s = buf.toString('latin1')
  const brAt = s.lastIndexOf('/ByteRange')
  const brOpen = s.indexOf('[', brAt)
  const brClose = s.indexOf(']', brOpen)
  const cOpen = s.indexOf('<', s.indexOf('/Contents', brAt))
  const cClose = s.indexOf('>', cOpen)
  const [a, b, c, d] = range(cOpen, cClose + 1, buf.length)
  buf.write(`[${a} ${b} ${c} ${d}]`.padEnd(brClose + 1 - brOpen, ' '), brOpen, 'latin1')
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hash = createHash('sha256')
  hash.update(buf.subarray(a, a + b))
  hash.update(buf.subarray(c, c + d))
  const cms = buildCms(hash.digest(), loadDigitalId(P12, 'secret'), new Date())
  buf.write(cms.toString('hex').padEnd(cClose - cOpen - 1, '0'), cOpen + 1, 'latin1')
  return new Uint8Array(buf)
}

describe('signature checks', () => {
  it('accepts the byte range only when it covers the whole file but the signature itself', async () => {
    const signed = await signWithCertificate(await makeLatinPdf(1), { p12: P12, password: 'secret', page: 0, box: [100, 100, 300, 160], labels: LABELS })
    // Re-signed with the right range: valid (the helper itself is sound).
    const fair = resign(signed, (cs, ce, n) => [0, cs, ce, n - ce])
    expect((await verifySignatures(fair))[0]!.valid).toBe(true)
    // Not from the start of the file.
    expect((await verifySignatures(resign(signed, (cs, ce, n) => [40, cs - 40, ce, n - ce])))[0]!.valid).toBe(false)
    // A gap wider than the signature: bytes before it are not signed.
    expect((await verifySignatures(resign(signed, (cs, ce, n) => [0, cs - 30, ce, n - ce])))[0]!.valid).toBe(false)
    // A range past the end of the file.
    expect((await verifySignatures(resign(signed, (cs, ce, n) => [0, cs, ce, n - ce + 500])))[0]!.valid).toBe(false)
    // Bytes added after the signed range: still valid, and reported as added later.
    const later = resign(signed, (cs, ce, n) => [0, cs, ce, n - ce - 20], '\n%' + 'x'.repeat(19))
    const [l] = await verifySignatures(later)
    expect(l!.valid).toBe(true)
    expect(l!.modifiedAfter).toBe(true)
  }, 60_000)

  // A1 did not reproduce: MuPDF leaves a signature's /Contents unencrypted, as PDF 32000 §7.6.1
  // asks, so signing an encrypted file works and checks — as Acrobat signs encrypted files.
  it('signs an encrypted file: the signature checks and the file keeps its password', async () => {
    const locked = await applyOperation(await makeLatinPdf(1), { op: 'protect', userPassword: 'open-me', ownerPassword: 'owner-x' } as never)
    const signed = await signWithCertificate(locked.bytes, { p12: P12, password: 'secret', page: 0, box: [100, 100, 300, 160], labels: LABELS }, 'owner-x')
    const [s] = await verifySignatures(signed)
    expect(s!.valid).toBe(true)
    expect(s!.modifiedAfter).toBe(false)
    // Its other strings are encrypted: the signer is named from the certificate, not from noise.
    expect(s!.signer).toBe('Test Signer')
    expect(s!.name).toBe('')
    expect(() => openPdf(signed)).toThrow()
    const doc = openPdf(signed, 'open-me')
    try {
      expect(formFields(doc).map((f) => f.kind)).toEqual(['signature'])
      expect(extractText(doc, 0).length).toBeGreaterThan(0)
    } finally {
      free(doc)
    }
  }, 60_000)

  it('names a new signature field so it clashes with no field', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 400])
    pdf.getForm().createTextField('Signature1').addToPage(page, { x: 40, y: 40, width: 100, height: 20 })
    const signed = await signWithCertificate(new Uint8Array(await pdf.save()), { p12: P12, password: 'secret', page: 0, box: [100, 100, 300, 160], labels: LABELS })
    const names = fields(signed).map((f) => f.name)
    expect(names).toContain('Signature1')
    expect(names).toContain('Signature2')
  }, 60_000)
})

// --- through a session, as the app does it -----------------------------------------------------

describe('saving from a session', () => {
  let dir = ''
  let sessions: Sessions
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'honokit-annotfix-'))
    sessions = new Sessions()
  })
  afterEach(() => {
    sessions.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const signedFirst of [false, true]) {
    it(`a redacted ${signedFirst ? 'signed ' : ''}file saved from the session holds none of the words`, async () => {
      let src = await redactFixture()
      if (signedFirst) src = await signWithCertificate(src, { p12: P12, password: 'secret', page: 0, box: [300, 300, 480, 360], labels: LABELS })
      const path = join(dir, 'in.pdf')
      writeFileSync(path, src)
      const doc = await sessions.openFile(path)
      await sessions.apply(doc.id, { op: 'redactMark', marks: [{ page: 0, box: MARK }] })
      const r = await sessions.apply(doc.id, { op: 'redactApply', fill: '#000000', label: 'REDACTED', sanitize: true })
      expect(r.note?.key).toBe(signedFirst ? 'note.redactedSigned' : 'note.redacted')
      // A later change is saved on top of the clean version (appended, for a signed file).
      await sessions.apply(doc.id, { op: 'markup', page: 0, markup: { kind: 'stamp', at: [250, 300], label: 'CHECKED', colour: '#c0392b' } })
      await sessions.save(doc.id)
      expect(leaked(new Uint8Array(readFileSync(path)), GONE)).toEqual([])
    }, 60_000)
  }

  it('a save that fails leaves no temporary file behind', async () => {
    const path = join(dir, 'a.pdf')
    writeFileSync(path, await makeLatinPdf(1))
    const doc = await sessions.openFile(path)
    // A folder where the file should go: the last step (the rename) fails.
    const target = join(dir, 'taken.pdf')
    mkdirSync(target)
    writeFileSync(join(target, 'inside.txt'), 'x')
    await expect(sessions.save(doc.id, target)).rejects.toBeTruthy()
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

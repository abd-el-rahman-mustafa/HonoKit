import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { formFields } from '@engine/forms'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { renderPage } from '@engine/render'
import { applyOperation } from '@ops/index'

async function makeForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  const form = pdf.getForm()
  form.createTextField('name').addToPage(page, { x: 40, y: 320, width: 300, height: 24 })
  const notes = form.createTextField('notes')
  notes.enableMultiline()
  notes.addToPage(page, { x: 40, y: 250, width: 200, height: 60 })
  form.createCheckBox('agree').addToPage(page, { x: 40, y: 220, width: 16, height: 16 })
  const colour = form.createRadioGroup('colour')
  colour.addOptionToPage('red', page, { x: 40, y: 190, width: 16, height: 16 })
  colour.addOptionToPage('blue', page, { x: 80, y: 190, width: 16, height: 16 })
  const city = form.createDropdown('city')
  city.addOptions(['Dubai', 'Sharjah', 'Abu Dhabi'])
  city.addToPage(page, { x: 40, y: 140, width: 150, height: 24 })
  const fixed = form.createTextField('fixed')
  fixed.setText('Do not change')
  fixed.enableReadOnly()
  fixed.addToPage(page, { x: 40, y: 100, width: 150, height: 24 })
  return new Uint8Array(await pdf.save())
}

const fields = (bytes: Uint8Array) => {
  const doc = openPdf(bytes)
  try {
    return formFields(doc)
  } finally {
    free(doc)
  }
}

/** Dark pixels inside a box of page 1 (displayed points), rendered at 1:1. */
function ink(bytes: Uint8Array, b: [number, number, number, number]): number {
  const doc = openPdf(bytes)
  try {
    const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    const px = pm.getPixels()
    let n = 0
    for (let y = Math.ceil(b[1]) + 2; y < b[3] - 2; y++) for (let x = Math.ceil(b[0]) + 2; x < b[2] - 2; x++) if (px[y * pm.getWidth() + x]! < 128) n++
    return n
  } finally {
    free(doc)
  }
}

describe('forms', () => {
  it('lists every kind of field', async () => {
    const list = fields(await makeForm())
    expect(list.map((f) => `${f.name}:${f.kind}`)).toEqual(['name:text', 'notes:text', 'agree:checkbox', 'colour:radio', 'colour:radio', 'city:combo', 'fixed:text'])
    expect(list.find((f) => f.name === 'notes')!.multiline).toBe(true)
    expect(list.find((f) => f.name === 'city')!.options).toEqual(['Dubai', 'Sharjah', 'Abu Dhabi'])
    expect(list.find((f) => f.name === 'fixed')!.readOnly).toBe(true)
  })

  it('fills text (Arabic drawn and readable), checkbox, radio and drop-down', async () => {
    const src = await makeForm()
    const list = fields(src)
    const at = (name: string, n = 0) => list.filter((f) => f.name === name)[n]!
    const { bytes } = await applyOperation(src, {
      op: 'fillForm',
      values: [
        { page: 0, index: at('name').index, value: 'أحمد علي Ahmed' },
        { page: 0, index: at('notes').index, value: 'ملاحظة طويلة تلتف على أكثر من سطر داخل الحقل' },
        { page: 0, index: at('agree').index, value: true },
        { page: 0, index: at('colour', 1).index, value: true },
        { page: 0, index: at('city').index, value: 'Sharjah' }
      ]
    })
    const after = fields(bytes)
    const now = (name: string, n = 0) => after.filter((f) => f.name === name)[n]!
    expect(now('name').value).toBe('أحمد علي Ahmed')
    expect(now('agree').checked).toBe(true)
    expect(now('colour', 0).checked).toBe(false)
    expect(now('colour', 1).checked).toBe(true)
    expect(now('city').value).toBe('Sharjah')
    // Our drawing is there and reads back as the value.
    expect(ink(bytes, now('name').box)).toBeGreaterThan(100)
    const doc = openPdf(bytes)
    try {
      mkdirSync('smoke-out', { recursive: true })
      writeFileSync('smoke-out/form-filled.png', renderPage(doc, 0, { scale: 2, format: 'png' }).data)
    } finally {
      free(doc)
    }
  })

  it('turns a radio group over to the other button, and refuses a read-only field', async () => {
    const src = await makeForm()
    const list = fields(src)
    const radios = list.filter((f) => f.name === 'colour')
    const one = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: radios[0]!.index, value: true }] })
    const two = await applyOperation(one.bytes, { op: 'fillForm', values: [{ page: 0, index: radios[1]!.index, value: true }] })
    expect(fields(two.bytes).filter((f) => f.name === 'colour').map((f) => f.checked)).toEqual([false, true])
    await expect(applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: list.find((f) => f.name === 'fixed')!.index, value: 'x' }] })).rejects.toThrow()
  })
})

describe('prepare a form', () => {
  it('creates each kind of field, fills them, removes one', async () => {
    const { bytes } = await applyOperation(await makeForm(), {
      op: 'addFields',
      fields: [
        { page: 0, box: [40, 40, 240, 62], kind: 'text', name: 'Full name' },
        { page: 0, box: [260, 40, 276, 56], kind: 'checkbox', name: 'Agree' },
        { page: 0, box: [40, 70, 200, 92], kind: 'dropdown', name: 'Emirate', options: ['Dubai', 'Sharjah'] },
        { page: 0, box: [40, 100, 300, 160], kind: 'multiline', name: 'Notes' },
        { page: 0, box: [40, 170, 240, 220], kind: 'signature', name: 'Signature' },
        { page: 0, box: [40, 230, 240, 252], kind: 'text', name: 'name' }
      ]
    })
    const list = fields(bytes)
    const made = (n: string) => list.find((f) => f.name === n)!
    expect(made('Full name').kind).toBe('text')
    expect(made('Agree').kind).toBe('checkbox')
    expect(made('Emirate').options).toEqual(['Dubai', 'Sharjah'])
    expect(made('Notes').multiline).toBe(true)
    expect(made('Signature').kind).toBe('signature')
    // "name" was taken by the fixture's own field: the new one got a new name.
    expect(list.filter((f) => f.name.startsWith('name')).length).toBe(2)
    const filled = await applyOperation(bytes, { op: 'fillForm', values: [{ page: 0, index: made('Full name').index, value: 'مريم' }, { page: 0, index: made('Agree').index, value: true }] })
    const after = fields(filled.bytes)
    expect(after.find((f) => f.name === 'Full name')!.value).toBe('مريم')
    expect(after.find((f) => f.name === 'Agree')!.checked).toBe(true)
    const removed = await applyOperation(filled.bytes, { op: 'removeField', page: 0, index: made('Notes').index })
    expect(fields(removed.bytes).some((f) => f.name === 'Notes')).toBe(false)
  })

  it('finds blanks and tick boxes on a flat form, named after their labels', async () => {
    const { detectFormFields } = await import('@engine/forms')
    const { StandardFonts, rgb } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([500, 400])
    page.drawText('Name: ______________________', { x: 40, y: 340, size: 12, font })
    page.drawText('I agree', { x: 64, y: 300, size: 12, font })
    page.drawRectangle({ x: 40, y: 298, width: 12, height: 12, borderColor: rgb(0, 0, 0), borderWidth: 1 })
    const doc = openPdf(new Uint8Array(await pdf.save()))
    try {
      const found = detectFormFields(doc, 0)
      expect(found.map((f) => `${f.kind}:${f.name}`)).toEqual(['text:Name', 'checkbox:I agree'])
    } finally {
      free(doc)
    }
  })
})

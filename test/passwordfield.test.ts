import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { formFields } from '@engine/forms'
import { free, openPdf, saveBytes } from '@engine/mupdf'
import { applyOperation } from '@ops/index'

/**
 * A text field with the Password flag must never have its value stored in the file
 * (PDF 32000-2 §12.7.5.3, Table 231; decisions §99). Acrobat writes the typed value nowhere: the
 * field is saved holding its default value (/DV) or empty, and the masking characters are drawn
 * from the saved value, so the file does not say how long the typed password was.
 */

const SECRET = 'Zq7-notInAnyFile-9xW'

async function formWithPassword(options: { defaultValue?: string; typed?: string } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 200])
  const form = pdf.getForm()
  const pin = form.createTextField('pin')
  pin.enablePassword()
  if (options.typed) pin.setText(options.typed)
  pin.addToPage(page, { x: 40, y: 140, width: 200, height: 24 })
  const plain = form.createTextField('name')
  plain.addToPage(page, { x: 40, y: 100, width: 200, height: 24 })
  // Plain objects, so a search of the bytes finds a value that is there.
  const bytes = new Uint8Array(await pdf.save({ useObjectStreams: false }))
  if (options.defaultValue === undefined) return bytes
  // /DV, which pdf-lib does not write.
  const doc = openPdf(bytes)
  try {
    const fields = doc.getTrailer().get('Root').get('AcroForm').get('Fields')
    for (let i = 0; i < fields.length; i++) {
      const f = fields.get(i)
      if (f.get('T').isString() && f.get('T').asString() === 'pin') f.put('DV', doc.newString(options.defaultValue))
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Where in the file, if anywhere, the text appears (the save writes dictionary strings as they are). */
function holdsText(bytes: Uint8Array, text: string): boolean {
  const hay = Buffer.from(bytes)
  const utf16be = Buffer.from(text, 'utf16le').swap16()
  const forms = [Buffer.from(text, 'latin1'), utf16be]
  // A hexadecimal string, as pdf-lib writes a field's value.
  for (const b of [Buffer.from(text, 'latin1'), utf16be]) {
    forms.push(Buffer.from(b.toString('hex'), 'latin1'), Buffer.from(b.toString('hex').toUpperCase(), 'latin1'))
  }
  return forms.some((f) => hay.includes(f))
}

const fieldsOf = (bytes: Uint8Array) => {
  const doc = openPdf(bytes)
  try {
    return formFields(doc)
  } finally {
    free(doc)
  }
}

const pinOf = (bytes: Uint8Array) => fieldsOf(bytes).find((f) => f.name === 'pin')!

describe('password form fields (§99)', () => {
  it('writes a typed password value to no file', async () => {
    const src = await formWithPassword()
    const pin = pinOf(src)
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: pin.index, value: SECRET }] })
    expect(holdsText(bytes, SECRET)).toBe(false)
    expect(pinOf(bytes).value).toBe('')
  })

  it('keeps an ordinary field beside it filled in', async () => {
    const src = await formWithPassword()
    const list = fieldsOf(src)
    const { bytes } = await applyOperation(src, {
      op: 'fillForm',
      values: [
        { page: 0, index: list.find((f) => f.name === 'pin')!.index, value: SECRET },
        { page: 0, index: list.find((f) => f.name === 'name')!.index, value: 'Maryam' },
      ],
    })
    expect(holdsText(bytes, SECRET)).toBe(false)
    expect(fieldsOf(bytes).find((f) => f.name === 'name')!.value).toBe('Maryam')
  })

  it('leaves a password field at its default value, not at what was typed', async () => {
    const src = await formWithPassword({ defaultValue: 'abcde' })
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: pinOf(src).index, value: SECRET }] })
    expect(holdsText(bytes, SECRET)).toBe(false)
    expect(pinOf(bytes).value).toBe('abcde')
  })

  it('takes a password value that came with the file out of every save', async () => {
    const src = await formWithPassword({ typed: SECRET })
    expect(holdsText(src, SECRET)).toBe(true)
    const { bytes } = await applyOperation(src, { op: 'rotate', pages: [0], angle: 90 })
    expect(holdsText(bytes, SECRET)).toBe(false)
    expect(pinOf(bytes).value).toBe('')
  })

  it('takes a password value held by an ancestor field out too', async () => {
    const src = await formWithPassword()
    const doc = openPdf(src)
    let withParent: Uint8Array
    try {
      // One password field written as a parent holding the value and a widget under it, as a
      // writer that shares a value between widgets makes it.
      const acro = doc.getTrailer().get('Root').get('AcroForm')
      const fields = acro.get('Fields')
      let widget: ReturnType<typeof acro.get> | null = null
      let at = -1
      for (let i = 0; i < fields.length; i++) {
        const f = fields.get(i)
        if (f.get('T').isString() && f.get('T').asString() === 'pin') {
          widget = f
          at = i
        }
      }
      const parent = doc.newDictionary()
      parent.put('T', doc.newString('pin'))
      parent.put('FT', doc.newName('Tx'))
      parent.put('Ff', doc.newInteger(1 << 13))
      parent.put('V', doc.newString(SECRET))
      const kids = doc.newArray()
      kids.push(widget!)
      parent.put('Kids', kids)
      const ref = doc.addObject(parent)
      widget!.delete('T')
      widget!.delete('FT')
      widget!.delete('Ff')
      widget!.delete('V')
      widget!.put('Parent', ref)
      fields.put(at, ref)
      withParent = doc.saveToBuffer('incremental').asUint8Array().slice()
    } finally {
      free(doc)
    }
    expect(holdsText(withParent, SECRET)).toBe(true)
    const { bytes } = await applyOperation(withParent, { op: 'rotate', pages: [0], angle: 90 })
    expect(holdsText(bytes, SECRET)).toBe(false)
  })
})

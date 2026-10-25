import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { formFields } from '@engine/forms'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { applyOperation } from '@ops/index'

/**
 * Filling in a hybrid XFA form takes the XFA packet out, or Acrobat would show the old values
 * from it instead of the ones typed (xfaKind). Deleting the reference only unlinks the packet:
 * a plain save keeps every object, whether anything points at it or not, so the data it holds —
 * the old field values — stayed in the saved file for anyone to read back. Decisions §100.
 */

const SECRET = 'Qx4-oldXfaValue-7Km'

/** A hybrid XFA form: ordinary AcroForm fields and an XFA packet holding `SECRET`. */
async function hybridXfaForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 200])
  const form = pdf.getForm()
  const name = form.createTextField('name')
  name.addToPage(page, { x: 40, y: 140, width: 200, height: 24 })
  const bytes = new Uint8Array(await pdf.save({ useObjectStreams: false }))
  const doc = openPdf(bytes)
  try {
    const acro = doc.getTrailer().get('Root').get('AcroForm')
    const datasets = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><name>${SECRET}</name></form1></xfa:data></xfa:datasets>`
    const stream = doc.addStream(datasets, doc.newDictionary())
    const xfa = doc.newArray()
    xfa.push(doc.newString('datasets'))
    xfa.push(stream)
    acro.put('XFA', xfa)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Whether any object of the file still holds the text, streams unpacked. */
function anyObjectHolds(bytes: Uint8Array, text: string): boolean {
  const doc = openPdf(bytes)
  try {
    for (let n = 1; n < doc.countObjects(); n++) {
      let obj: mupdf.PDFObject | undefined
      try {
        obj = doc.newIndirect(n)
        if (obj.isStream()) {
          const buffer = obj.readStream()
          try {
            if (Buffer.from(buffer.asUint8Array()).includes(Buffer.from(text, 'latin1'))) return true
          } finally {
            free(buffer)
          }
        } else if (obj.resolve().toString().includes(text)) return true
      } catch {
        // An object that cannot be read holds nothing readable.
      } finally {
        free(obj)
      }
    }
    return false
  } finally {
    free(doc)
  }
}

describe('a stripped XFA packet (§100)', () => {
  it('is in the file while the form still has it', async () => {
    const src = await hybridXfaForm()
    expect(anyObjectHolds(src, SECRET)).toBe(true)
  })

  it('leaves nothing behind when filling in the form takes it out', async () => {
    const src = await hybridXfaForm()
    const doc = openPdf(src)
    let index = -1
    try {
      index = formFields(doc).find((f) => f.name === 'name')!.index
    } finally {
      free(doc)
    }
    const { bytes } = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index, value: 'Maryam' }] })
    expect(anyObjectHolds(bytes, SECRET)).toBe(false)
    // The form itself still works.
    const after = openPdf(bytes)
    try {
      expect(formFields(after).find((f) => f.name === 'name')!.value).toBe('Maryam')
      expect(after.getTrailer().get('Root').get('AcroForm').get('XFA').isNull()).toBe(true)
    } finally {
      free(after)
    }
  })
})

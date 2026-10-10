import { describe, expect, it } from 'vitest'
import { free, openPdf, saveBytes, SAVE_FINAL } from '@engine/mupdf'
import { protectPdf } from '@engine/security'
import { makeLatinPdf } from './fixtures'

/**
 * Acrobat calls an encrypted file "damaged and could not be repaired", before it even asks for the
 * password, when the document catalog sits inside an object stream. Other readers accept it.
 */
function catalogStandsAlone(bytes: Uint8Array, password: string): boolean {
  const doc = openPdf(bytes, password)
  let num: number
  try {
    num = doc.getTrailer().get('Root').asIndirect()
  } finally {
    free(doc)
  }
  // An object written on its own starts "N G obj"; one packed in an object stream has no such header.
  return new RegExp(`(^|[\\r\\n\\s])${num} \\d+ obj\\b`).test(Buffer.from(bytes).toString('latin1'))
}

const options = { allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true }

describe('encrypted files keep their catalog out of object streams', () => {
  it('Protect writes the catalog as its own object', async () => {
    const bytes = protectPdf(await makeLatinPdf(3), { ...options, userPassword: 'open-me' })
    expect(catalogStandsAlone(bytes, 'open-me')).toBe(true)
  })
  it('a permissions-only password does too', async () => {
    const bytes = protectPdf(await makeLatinPdf(3), { ...options, userPassword: '', ownerPassword: 'owner-pw' })
    expect(catalogStandsAlone(bytes, '')).toBe(true)
  })
  it('saving an encrypted file again keeps it so', async () => {
    const locked = protectPdf(await makeLatinPdf(3), { ...options, userPassword: 'open-me' })
    const doc = openPdf(locked, 'open-me')
    try {
      const again = saveBytes(doc, SAVE_FINAL)
      expect(catalogStandsAlone(again, 'open-me')).toBe(true)
    } finally {
      free(doc)
    }
  })
  it('unencrypted saves still pack objects into streams', async () => {
    const doc = openPdf(await makeLatinPdf(3))
    try {
      const out = Buffer.from(saveBytes(doc, SAVE_FINAL)).toString('latin1')
      expect(out).toContain('/ObjStm')
    } finally {
      free(doc)
    }
  })
})

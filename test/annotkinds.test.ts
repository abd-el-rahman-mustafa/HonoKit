import { describe, expect, it } from 'vitest'
import { free, openPdf, saveBytes } from '@engine/mupdf'
import { pageMarkups } from '@engine/markup'
import { makeLatinPdf } from './fixtures'

/** Adds raw annotations of the given subtypes to page 1. */
async function withAnnotations(subtypes: string[]): Promise<Uint8Array> {
  const doc = openPdf(await makeLatinPdf(1))
  try {
    const page = doc.findPage(0)
    const annots = doc.newArray()
    subtypes.forEach((subtype, i) => {
      const a = doc.newDictionary()
      a.put('Type', doc.newName('Annot'))
      a.put('Subtype', doc.newName(subtype))
      a.put('Rect', [50 + i * 30, 50, 70 + i * 30, 70])
      a.put('Contents', doc.newString(subtype))
      annots.push(doc.addObject(a))
    })
    page.put('Annots', annots)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

describe('only comments are listed as comments', () => {
  it('leaves out media, 3D, printer marks and watermark annotations, as Acrobat does', async () => {
    const kinds = ['Text', 'Screen', 'Movie', 'RichMedia', '3D', 'PrinterMark', 'TrapNet', 'Watermark', 'Square']
    const doc = openPdf(await withAnnotations(kinds))
    try {
      const listed = pageMarkups(doc, 0).map((m) => m.text)
      expect(listed).toEqual(['Text', 'Square'])
    } finally {
      free(doc)
    }
  })
})

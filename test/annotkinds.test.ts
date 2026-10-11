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

describe('comment text', () => {
  it('shows line breaks saved as CR or CRLF (as Acrobat writes them) as line breaks', async () => {
    const src = openPdf(await withAnnotations(['Text', 'FreeText']))
    let bytes: Uint8Array
    try {
      const annots = src.findPage(0).get('Annots')
      annots.get(0).put('Contents', src.newString('first line\r\rsecond paragraph'))
      annots.get(1).put('Contents', src.newString('one\r\ntwo'))
      bytes = saveBytes(src)
    } finally {
      free(src)
    }
    const doc = openPdf(bytes)
    try {
      expect(pageMarkups(doc, 0).map((m) => m.text)).toEqual(['first line\n\nsecond paragraph', 'one\ntwo'])
    } finally {
      free(doc)
    }
  })
})

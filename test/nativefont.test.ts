import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { nativeFont, nativeTJ } from '@engine/nativefont'
import { makeLatinPdf } from './fixtures'

describe('the page font used for typed text', () => {
  it('never writes a character with CID 0, even when ToUnicode maps it', async () => {
    // Word's Type 0 subsets map CID 0 (.notdef) as well as the real space glyph to U+0020 and
    // list a width for CID 0. Typing with the lowest code wrote every space as <0000>: a box.
    const doc = openPdf(await makeLatinPdf(1))
    try {
      const cmap = [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '1 begincodespacerange <0000> <FFFF> endcodespacerange',
        '3 beginbfchar <0000> <0020> <0003> <0020> <0024> <0041> endbfchar',
        'endcmap CMapName currentdict /CMap defineresource pop end end'
      ].join('\n')
      const tu = doc.addStream(cmap, doc.newDictionary())
      const cid = doc.newDictionary()
      cid.put('Type', doc.newName('Font'))
      cid.put('Subtype', doc.newName('CIDFontType2'))
      cid.put('BaseFont', doc.newName('ABCDEF+TestSans'))
      cid.put('DW', 1000)
      const w = doc.newArray()
      for (const [code, width] of [[0, 600], [3, 250], [36, 650]]) {
        w.push(code)
        const one = doc.newArray()
        one.push(width)
        w.push(one)
      }
      cid.put('W', w)
      const descendants = doc.newArray()
      descendants.push(doc.addObject(cid))
      const font = doc.newDictionary()
      font.put('Type', doc.newName('Font'))
      font.put('Subtype', doc.newName('Type0'))
      font.put('BaseFont', doc.newName('ABCDEF+TestSans'))
      font.put('Encoding', doc.newName('Identity-H'))
      font.put('DescendantFonts', descendants)
      font.put('ToUnicode', tu)
      const resources = doc.findPage(0).getInheritable('Resources')
      let fonts = resources.get('Font')
      if (!fonts.isDictionary()) {
        fonts = doc.newDictionary()
        resources.put('Font', fonts)
      }
      fonts.put('FTest', doc.addObject(font))
      const native = nativeFont(doc, 0, 'TestSans', new Set([0x20, 0x41]))
      expect(native).not.toBeNull()
      expect(native!.glyphs.get(0x20)).toEqual({ code: 3, width: 250 })
      expect(nativeTJ(native!, 'A A')).toEqual(['002400030024'])
    } finally {
      free(doc)
    }
  })
})

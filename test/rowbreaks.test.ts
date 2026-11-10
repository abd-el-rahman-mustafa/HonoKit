import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { hardLines } from '@engine/rows'
import { extractLines } from '@engine/text'
import { applyOperation } from '@ops/index'
import { makeLatinPdf } from './fixtures'

// Built by code point so no editor or tool turns them into something else.
const ch = (cp: number): string => String.fromCharCode(cp)
const LS = ch(0x2028) // LINE SEPARATOR (browsers, some editors)
const PS = ch(0x2029) // PARAGRAPH SEPARATOR
const VT = ch(0x0b) // what Word puts on the clipboard for a manual line break (Shift+Enter)
const FF = ch(0x0c)
const NEL = ch(0x85)
const RS = ch(0x1e)

describe('hard line breaks', () => {
  it('ends a line on every Unicode mandatory break, not only on \\n', () => {
    expect(hardLines('a\nb')).toEqual(['a', 'b'])
    expect(hardLines('a\r\nb')).toEqual(['a', 'b'])
    expect(hardLines('a\rb')).toEqual(['a', 'b'])
    for (const brk of [LS, PS, VT, FF, NEL, RS]) expect(hardLines(`a${brk}b`)).toEqual(['a', 'b'])
  })

  it('keeps empty lines, and one CR LF is one break', () => {
    expect(hardLines('a\r\n\r\nb')).toEqual(['a', '', 'b'])
    expect(hardLines(`a${LS}${LS}b`)).toEqual(['a', '', 'b'])
    expect(hardLines('')).toEqual([''])
  })

  async function lines(bytes: Uint8Array): Promise<string[]> {
    const doc = openPdf(bytes)
    try {
      return extractLines(doc, 0).map((l) => l.text.trim()).filter((t) => /TOP|BOTTOM|ONE|TWO/.test(t))
    } finally {
      free(doc)
    }
  }

  it('a watermark pasted with a line separator is drawn on two lines', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: `TOP${LS}BOTTOM`, rotation: 0, size: 40 })
    const found = await lines(bytes)
    expect(found).toContain('TOP')
    expect(found).toContain('BOTTOM')
    expect(found.join('')).not.toContain(LS)
  })

  it("a watermark pasted from Word with a manual line break is drawn on two lines", async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: `ONE${VT}TWO`, rotation: 0, size: 40 })
    const found = await lines(bytes)
    expect(found).toContain('ONE')
    expect(found).toContain('TWO')
  })
})

import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFRef } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { explicitLeading, explicitStream, repairLeading, tokens } from '@engine/contentfix'
import { readToUnicode, writeToUnicode } from '@engine/ligatures'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from '@engine/mupdf'
import { safeRedact } from '@engine/saferedact'
import { extractLines, extractText, foldString } from '@engine/text'
import { applyOperation } from '@ops/index'

/**
 * Fixes of 2026-10-08: edits leaving the person's annotations
 * alone, content rewritten per page, inline images read to their real end, wide ToUnicode ranges.
 */

function withDoc<T>(bytes: Uint8Array, fn: (doc: PdfDoc) => T): T {
  const doc = openPdf(bytes)
  try {
    return fn(doc)
  } finally {
    free(doc)
  }
}

const boxOf = (bytes: Uint8Array, page: number, needle: string): [number, number, number, number] =>
  withDoc(bytes, (doc) => {
    const line = extractLines(doc, page).find((l) => foldString(l.text).includes(foldString(needle)))
    if (!line) throw new Error(`no line with ${needle}`)
    return line.box
  })

const textOf = (bytes: Uint8Array, page = 0): string => withDoc(bytes, (d) => extractText(d, page))

/** The page's annotations, in /Annots order: object number and type. */
function annotsIn(doc: PdfDoc, page = 0): string[] {
  const annots = doc.findPage(page).get('Annots')
  const out: string[] = []
  for (let i = 0; i < annots.length; i++) out.push(`${annots.get(i).asIndirect()}:${annots.get(i).get('Subtype').asName()}`)
  return out
}
const annotsOf = (bytes: Uint8Array, page = 0): string[] => withDoc(bytes, (d) => annotsIn(d, page))

// Displayed coordinates of the lines below (page 500 × 400, baselines at 340, 300, 250).
const PENDING: [number, number, number, number] = [48, 46, 260, 64]

/**
 * A letter-like page: a line the person has marked for redaction (not applied yet), a line with a
 * hyperlink, a note and a free-text comment on it, and a plain line.
 */
async function annotatedPage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([500, 400])
  page.drawText('Pending secret number 4471', { x: 50, y: 340, size: 14, font })
  page.drawText('Visit our website for the full report.', { x: 50, y: 300, size: 14, font })
  page.drawText('Costs stayed the same as last year.', { x: 50, y: 250, size: 14, font })
  const ctx = pdf.context
  const annot = (subtype: string, rect: number[], extra: Record<string, unknown> = {}) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: rect, ...extra }))
  const line2 = [48, 296, 320, 314]
  page.node.set(
    PDFName.of('Annots'),
    ctx.obj([
      annot('Link', line2, { Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://example.com/report') } }),
      annot('FreeText', [330, 296, 450, 314], { DA: PDFString.of('/Helv 10 Tf 0 g'), Contents: PDFString.of('see this') }),
      annot('Text', line2, { Contents: PDFString.of('a note') })
    ])
  )
  const bytes = new Uint8Array(await pdf.save())
  // The person's pending mark, made the app's own way.
  return (await applyOperation(bytes, { op: 'redactMark', marks: [{ page: 0, box: PENDING }] })).bytes
}

describe('MuPDF redaction alone takes the person’s annotations with it (why safeRedact exists)', () => {
  it('applies every pending mark and drops links and free text under the area', async () => {
    const src = await annotatedPage()
    withDoc(src, (doc) => {
      const page = doc.loadPage(0) as mupdf.PDFPage
      page.createAnnotation('Redact').setRect(boxOf(src, 0, 'Visit our website'))
      page.applyRedactions(false, 0, 0, 0)
      free(page)
      const left = annotsIn(doc).map((a) => a.split(':')[1])
      expect(left).not.toContain('Redact')
      expect(left).not.toContain('Link')
      expect(textOf(saveBytes(doc))).not.toContain('Pending secret')
    })
  })
})

describe('safeRedact', () => {
  it('removes only what is under its boxes; every annotation stays, same objects, same order', async () => {
    const src = await annotatedPage()
    const before = annotsOf(src)
    expect(before.map((a) => a.split(':')[1])).toEqual(['Link', 'FreeText', 'Text', 'Redact'])
    const out = withDoc(src, (doc) => {
      safeRedact(doc, 0, [boxOf(src, 0, 'Visit our website')])
      return saveBytes(doc)
    })
    const text = textOf(out)
    expect(text).not.toContain('Visit our website')
    expect(text).toContain('Pending secret number 4471')
    expect(text).toContain('Costs stayed the same')
    expect(annotsOf(out)).toEqual(before)
  })

  it('also when MuPDF holds the page open with its annotation list already loaded', async () => {
    const src = await annotatedPage()
    const before = annotsOf(src)
    const out = withDoc(src, (doc) => {
      const held = doc.loadPage(0) as mupdf.PDFPage
      expect(held.getAnnotations().length).toBeGreaterThan(0)
      try {
        safeRedact(doc, 0, [boxOf(src, 0, 'Visit our website')])
      } finally {
        free(held)
      }
      return saveBytes(doc)
    })
    expect(textOf(out)).toContain('Pending secret number 4471')
    expect(textOf(out)).not.toContain('Visit our website')
    expect(annotsOf(out)).toEqual(before)
  })

  it('leaves a page without annotations without an /Annots entry, and does nothing for no boxes', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([300, 200]).drawText('Plain words here', { x: 20, y: 150, size: 14, font })
    const src = new Uint8Array(await pdf.save())
    withDoc(src, (doc) => {
      safeRedact(doc, 0, [])
      expect(extractText(doc, 0)).toContain('Plain words here')
      doc.findPage(0).delete('Annots') // pdf-lib writes an empty one
      safeRedact(doc, 0, [boxOf(src, 0, 'Plain words')])
      expect(doc.findPage(0).get('Annots').isNull()).toBe(true)
      expect(extractText(doc, 0)).not.toContain('Plain words')
    })
  })
})

describe('edits keep pending redaction marks and links', () => {
  it('a text edit on a line with a link: done, the link and the pending mark stay, the marked text too', async () => {
    const src = await annotatedPage()
    const before = annotsOf(src)
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Visit our website'), text: 'Visit our new website for the report.' })
    const text = textOf(bytes)
    expect(text).toContain('Visit our new website')
    expect(text).toContain('Pending secret number 4471')
    expect(annotsOf(bytes)).toEqual(before)
    withDoc(bytes, (doc) => {
      const link = doc.findPage(0).get('Annots').get(0)
      expect(link.get('A').get('URI').asString()).toBe('https://example.com/report')
    })
  })

  it('Erase area does not apply the pending mark elsewhere on the page', async () => {
    const src = await annotatedPage()
    const before = annotsOf(src)
    const { bytes } = await applyOperation(src, { op: 'erase', page: 0, box: boxOf(src, 0, 'Costs stayed') })
    const text = textOf(bytes)
    expect(text).not.toContain('Costs stayed')
    expect(text).toContain('Pending secret number 4471')
    expect(annotsOf(bytes)).toEqual(before)
  })

  it('Format all keeps the marks and the marked words', async () => {
    const src = await annotatedPage()
    const before = annotsOf(src)
    const { bytes } = await applyOperation(src, { op: 'formatText', kind: 'serif' })
    expect(textOf(bytes)).toContain('Pending secret number 4471')
    expect(annotsOf(bytes)).toEqual(before)
  })
})

// --- content streams ---------------------------------------------------------------------------

/** Pages drawn by raw content streams (Helvetica as /F1), optionally sharing one stream or calling a form. */
async function rawPdf(options: { pages: number; content: string; shared: 'stream' | 'array' | 'none'; form?: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const ctx = pdf.context
  const fontRes = ctx.obj({ F1: font.ref })
  const xobjects: Record<string, PDFRef> = {}
  if (options.form) {
    const form = ctx.stream(options.form, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 800], Resources: { Font: fontRes } })
    xobjects['Fm0'] = ctx.register(form)
  }
  const one = ctx.register(ctx.stream(options.content))
  const tail = ctx.register(ctx.stream('% end'))
  const array = ctx.register(ctx.obj([one, tail]))
  for (let i = 0; i < options.pages; i++) {
    const page = pdf.addPage([400, 800])
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: fontRes, XObject: xobjects }))
    if (options.shared === 'stream') page.node.set(PDFName.of('Contents'), one)
    else if (options.shared === 'array') page.node.set(PDFName.of('Contents'), array)
    else page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(options.content)))
  }
  return new Uint8Array(await pdf.save({ useObjectStreams: false }))
}

/** Each line's text and baseline-ish place (top of its box, displayed). */
const places = (doc: PdfDoc, page: number): Array<[string, number, number]> => extractLines(doc, page).map((l) => [l.text, Math.round(l.box[0]), Math.round(l.box[1])])

const contentsOf = (doc: PdfDoc, page: number): { num: number; text: string } => {
  const c = doc.findPage(page).get('Contents')
  const stream = c.isArray() ? c.get(0) : c
  const buffer = stream.readStream()
  const text = buffer.asString()
  buffer.destroy()
  return { num: stream.asIndirect(), text }
}

const LEADING = 'BT /F1 12 Tf 14 TL 50 700 Td (Alpha line) Tj T* (Beta line) Tj ET'

describe('explicitLeading writes this page’s own stream', () => {
  for (const shared of ['stream', 'array'] as const) {
    it(`a ${shared === 'stream' ? 'content stream' : '/Contents array'} shared by two pages: the other page is not touched`, async () => {
      const src = await rawPdf({ pages: 2, content: LEADING, shared })
      withDoc(src, (doc) => {
        const placesBefore = [places(doc, 0), places(doc, 1)]
        const other = contentsOf(doc, 1)
        const otherContents = doc.findPage(1).get('Contents')
        const otherIsArray = otherContents.isArray()
        expect(explicitLeading(doc, 0)).toBeGreaterThan(0)
        // Page 2: the very same stream object, word for word, and its /Contents unchanged.
        expect(contentsOf(doc, 1)).toEqual(other)
        expect(doc.findPage(1).get('Contents').isArray()).toBe(otherIsArray)
        if (otherIsArray) expect(doc.findPage(1).get('Contents').asIndirect()).toBe(otherContents.asIndirect())
        // Page 1: a new stream with no T*, drawing the same.
        const mine = contentsOf(doc, 0)
        expect(mine.num).not.toBe(other.num)
        expect(mine.text).not.toContain('T*')
        expect(places(doc, 0)).toEqual(placesBefore[0])
        expect(places(doc, 1)).toEqual(placesBefore[1])
        // The rest of an array is kept as it was.
        if (shared === 'array') expect(doc.findPage(0).get('Contents').length).toBe(2)
      })
    })
  }

  it('repairLeading writes a new stream too', async () => {
    const src = await rawPdf({ pages: 2, content: 'BT /F1 12 Tf 50 700 Td (One) Tj 0 30 TD (Two) Tj 0 -14 TD (Three) Tj T* (Four) Tj ET', shared: 'stream' })
    withDoc(src, (doc) => {
      const other = contentsOf(doc, 1)
      expect(repairLeading(doc, 0)).toBe(1)
      expect(contentsOf(doc, 1)).toEqual(other)
      expect(contentsOf(doc, 0).num).not.toBe(other.num)
      expect(contentsOf(doc, 0).text).toContain('0 30 Td 14 TL')
    })
  })

  it('keeps the leading for a form drawn after the text (T* in the form inherits it)', async () => {
    const src = await rawPdf({ pages: 1, content: `${LEADING} /Fm0 Do`, shared: 'none', form: 'BT /F1 12 Tf 50 600 Td (Gamma line) Tj T* (Delta line) Tj ET' })
    withDoc(src, (doc) => {
      const before = places(doc, 0)
      const delta = before.find((p) => p[0].includes('Delta'))!
      const gamma = before.find((p) => p[0].includes('Gamma'))!
      expect(delta[2] - gamma[2]).toBe(14)
      explicitLeading(doc, 0)
      expect(contentsOf(doc, 0).text).toContain('14 TL')
      expect(places(doc, 0)).toEqual(before)
    })
  })

  it('an edit on such a page never moves the form’s lines (MuPDF’s rewrite loses the inherited leading: refused)', async () => {
    // MuPDF 1.28's redaction copies the form and drops the leading it inherited, so "Delta" would
    // land on "Gamma". The edit's check sees it and refuses; it must never go through with it.
    const src = await rawPdf({ pages: 1, content: `${LEADING} /Fm0 Do`, shared: 'none', form: 'BT /F1 12 Tf 50 600 Td (Gamma line) Tj T* (Delta line) Tj ET' })
    const where = (bytes: Uint8Array, needle: string) => withDoc(bytes, (d) => places(d, 0).find((p) => p[0].includes(needle)))
    let bytes: Uint8Array
    try {
      bytes = (await applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Alpha line'), text: 'Alpha changed' })).bytes
    } catch (e) {
      expect((e as { code?: string }).code).toBe('edit-unsafe')
      return
    }
    expect(textOf(bytes)).toContain('Alpha changed')
    expect(where(bytes, 'Beta line')).toEqual(where(src, 'Beta line'))
    expect(where(bytes, 'Delta line')).toEqual(where(src, 'Delta line'))
    expect(where(bytes, 'Gamma line')).toEqual(where(src, 'Gamma line'))
  })
})

describe('inline images are read to their real end', () => {
  // The picture's own bytes hold "EI" twice: once with no space before it, once followed by a letter.
  const IMAGE = 'q 8 0 0 1 0 0 cm BI /W 9 /H 1 /BPC 8 /CS /G ID aEI EIbT*\nEI Q'
  it('tokens skip the data and stop at the EI that ends it', () => {
    const ts = tokens(`${IMAGE} BT 14 TL T* ET`)
    const ops = ts.filter((t) => t.kind === 'op').map((t) => t.value)
    expect(ops).toEqual(['q', 'cm', 'BI', 'ID', 'EI', 'Q', 'BT', 'TL', 'T*', 'ET'])
  })

  it('explicitStream leaves the picture’s bytes alone', () => {
    const out = explicitStream(`${IMAGE} BT 14 TL T* ET`).text
    expect(out).toBe(`${IMAGE} BT 14 TL 0 -14 Td ET`)
  })

  it('an EI right after ID (empty data) and one at the very end are found', () => {
    expect(tokens('BI /W 0 /H 0 ID EI Q').filter((t) => t.kind === 'op').map((t) => t.value)).toEqual(['BI', 'ID', 'EI', 'Q'])
    expect(tokens('BI ID xx EI').filter((t) => t.kind === 'op').map((t) => t.value)).toEqual(['BI', 'ID', 'EI'])
    expect(tokens('BI ID xx EIx').filter((t) => t.kind === 'op').map((t) => t.value)).toEqual(['BI', 'ID'])
  })

  it('a producer that writes no space before EI: the rest of the stream is still read', () => {
    const ops = tokens('BI /W 1 /H 1 /CS /G /BPC 8 ID \x80EI Q BT 14 TL T* ET').filter((t) => t.kind === 'op').map((t) => t.value)
    expect(ops).toEqual(['BI', 'ID', 'EI', 'Q', 'BT', 'TL', 'T*', 'ET'])
  })

  it('a page with such a picture draws the same after explicitLeading', async () => {
    const src = await rawPdf({ pages: 1, content: `${IMAGE} ${LEADING}`, shared: 'none' })
    withDoc(src, (doc) => {
      const before = places(doc, 0)
      explicitLeading(doc, 0)
      expect(contentsOf(doc, 0).text.startsWith(IMAGE)).toBe(true)
      expect(places(doc, 0)).toEqual(before)
    })
  })
})

describe('ToUnicode maps', () => {
  it('reads ranges wider than 256 codes, as real producers write them', () => {
    const map = readToUnicode('1 beginbfrange\n<0003> <0241> <0020>\nendbfrange')
    expect(map.get(0x0003)).toBe(' ')
    expect(map.get(0x0024)).toBe('A')
    expect(map.get(0x0241)).toBe(String.fromCharCode(0x20 + 0x241 - 3))
    expect(map.size).toBe(0x241 - 3 + 1)
  })

  it('reads one-byte destinations', () => {
    const map = readToUnicode('1 beginbfchar\n<05> <41>\nendbfchar\n2 beginbfrange\n<10> <12> <61>\n<20> <21> [<62> <0063>]\nendbfrange')
    expect(map.get(5)).toBe('A')
    expect([map.get(0x10), map.get(0x11), map.get(0x12)]).toEqual(['a', 'b', 'c'])
    expect([map.get(0x20), map.get(0x21)]).toEqual(['b', 'c'])
  })

  it('a range past every two-byte code is not stepped through', () => {
    expect(readToUnicode('1 beginbfrange\n<00000000> <00FFFFFF> <0020>\nendbfrange').size).toBe(0)
  })

  it('writing a one-byte map leaves out codes it cannot hold', () => {
    const map = new Map([[0x41, 'A'], [0x241, 'x']])
    expect(readToUnicode(writeToUnicode(map))).toEqual(new Map([[0x41, 'A']]))
  })
})

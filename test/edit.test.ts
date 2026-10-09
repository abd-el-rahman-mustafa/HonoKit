import { mkdirSync, writeFileSync } from 'node:fs'
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { lineAt } from '@engine/edit'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { renderPage } from '@engine/render'
import { extractLines, extractText, foldString } from '@engine/text'
import { applyOperation } from '@ops/index'
import { makeArabicPdf, makeImagePdf, makeLatinPdf, makeRestrictedPdf } from './fixtures'

function snapshot(name: string, bytes: Uint8Array, page = 0): void {
  mkdirSync('smoke-out', { recursive: true })
  const doc = openPdf(bytes)
  try {
    writeFileSync(`smoke-out/${name}.png`, renderPage(doc, page, { scale: 1.5, format: 'png' }).data)
  } finally {
    free(doc)
  }
}

function withDoc<T>(bytes: Uint8Array, fn: (doc: ReturnType<typeof openPdf>) => T): T {
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

/** A page in Times, bold heading and regular body, like a typical document. */
async function makeDocument(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const page = pdf.addPage([500, 400])
  page.drawText('Quarterly Report', { x: 50, y: 340, size: 24, font: bold })
  page.drawText('Revenue rose by 12 percent this quarter.', { x: 50, y: 300, size: 14, font: regular })
  page.drawText('Costs stayed the same as last year.', { x: 50, y: 250, size: 14, font: regular })
  return new Uint8Array(await pdf.save())
}

describe('replace a line of text', () => {
  it('replaces a line, keeps its neighbours, and the old words are really gone', async () => {
    const src = await makeDocument()
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Revenue rose'), text: 'Revenue fell by 3 percent this quarter.' })
    const text = withDoc(bytes, (d) => extractText(d, 0))
    expect(text).toContain('Revenue fell by 3 percent')
    expect(text).not.toContain('rose by 12')
    expect(text).toContain('Costs stayed the same')
    expect(text).toContain('Quarterly Report')
    snapshot('edit-replace', bytes)
  })

  it('keeps the size, weight, family and baseline of the line it replaces', async () => {
    const src = await makeDocument()
    const before = withDoc(src, (d) => lineAt(d, 0, boxOf(src, 0, 'Quarterly'))!)
    expect(before).toMatchObject({ bold: true, kind: 'serif', rtl: false })
    expect(before.size).toBeCloseTo(24, 0)
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: before.box, text: 'Annual Report' })
    const after = withDoc(bytes, (d) => lineAt(d, 0, boxOf(bytes, 0, 'Annual'))!)
    expect(after).toMatchObject({ bold: true, kind: 'serif' })
    expect(after.size).toBeCloseTo(24, 0)
    expect(after.baseline.x).toBeCloseTo(before.baseline.x, 0)
    expect(after.baseline.y).toBeCloseTo(before.baseline.y, 0)
  })

  it('replaces an Arabic line, aligned to its right end', async () => {
    const src = await makeArabicPdf(['على الطاولة كتاب', 'مرحبا بالعالم'])
    const before = withDoc(src, (d) => lineAt(d, 0, boxOf(src, 0, 'مرحبا'))!)
    expect(before.rtl).toBe(true)
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: before.box, text: 'أهلا وسهلا 2026' })
    const text = foldString(withDoc(bytes, (d) => extractText(d, 0)))
    expect(text).toContain(foldString('أهلا وسهلا'))
    expect(text).not.toContain(foldString('مرحبا'))
    expect(text).toContain(foldString('على الطاولة كتاب'))
    const after = withDoc(bytes, (d) => lineAt(d, 0, boxOf(bytes, 0, 'أهلا'))!)
    expect(after.box[2]).toBeCloseTo(before.box[2], -1) // right ends line up
    snapshot('edit-replace-arabic', bytes)
  })

  it('keeps a centred heading centred', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.HelveticaBold)
    const page = pdf.addPage([500, 400])
    const w = font.widthOfTextAtSize('Short Title', 20)
    page.drawText('Short Title', { x: 250 - w / 2, y: 350, size: 20, font })
    const src = new Uint8Array(await pdf.save())
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Short Title'), text: 'A Much Longer Replacement Title' })
    const line = withDoc(bytes, (d) => extractLines(d, 0).find((l) => l.text.includes('Longer'))!)
    expect(Math.abs((line.box[0] + line.box[2]) / 2 - 250)).toBeLessThan(3)
  })

  it('removes a line when the new text is empty', async () => {
    const src = await makeDocument()
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Costs stayed'), text: '' })
    expect(withDoc(bytes, (d) => extractText(d, 0))).not.toContain('Costs')
  })

  it('refuses a line that runs up or down the page, rather than guessing', async () => {
    // Drawn flat and then shown turned by /Rotate: the reader sees it running vertically.
    const src = await makeLatinPdf(1, { rotate: 90 })
    await expect(applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Marker1'), text: 'x' })).rejects.toThrow(/horizontal/)
  })

  it('works on a turned page whose text reads upright (a scanned page stored sideways)', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 600])
    page.setRotation(degrees(90))
    // Written a quarter turn anticlockwise, so the clockwise /Rotate shows it upright.
    page.drawText('Marker1 upright', { x: 300, y: 100, size: 18, font, rotate: degrees(90) })
    const src = new Uint8Array(await pdf.save())
    const box = boxOf(src, 0, 'Marker1')
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box, text: 'Edited1' })
    const line = withDoc(bytes, (d) => extractLines(d, 0).find((l) => l.text.includes('Edited1'))!)
    expect(line).toBeDefined()
    // Upright for the reader, and near where the old line was.
    expect(line.box[2] - line.box[0]).toBeGreaterThan(line.box[3] - line.box[1])
    expect(Math.abs(line.box[1] - box[1])).toBeLessThan(6)
  })

  it('says so when there is no text at the place', async () => {
    const src = await makeDocument()
    await expect(applyOperation(src, { op: 'replaceText', page: 0, box: [400, 10, 450, 20], text: 'x' })).rejects.toThrow(/no text there/)
  })

  it('respects the author\'s restrictions', async () => {
    const src = await makeRestrictedPdf(1)
    await expect(applyOperation(src, { op: 'replaceText', page: 0, box: boxOf(src, 0, 'Marker1'), text: 'x' })).rejects.toMatchObject({ code: 'restricted' })
  })
})

describe('add text', () => {
  it('adds Latin and Arabic text that can be read back and is visible', async () => {
    const src = await makeDocument()
    let { bytes } = await applyOperation(src, { op: 'addText', page: 0, x: 50, y: 360, text: 'Approved by the board', size: 12, colour: '#1f6f3f', bold: true })
    ;({ bytes } = await applyOperation(bytes, { op: 'addText', page: 0, x: 450, y: 380, text: 'تمت الموافقة', size: 16 }))
    const text = foldString(withDoc(bytes, (d) => extractText(d, 0)))
    expect(text).toContain(foldString('Approved by the board'))
    expect(text).toContain(foldString('تمت الموافقة'))
    snapshot('edit-add', bytes)
  })

  it('writes several lines', async () => {
    const { bytes } = await applyOperation(await makeDocument(), { op: 'addText', page: 0, x: 50, y: 120, text: 'First line\nSecond line', size: 12 })
    const lines = withDoc(bytes, (d) => extractLines(d, 0)).map((l) => l.text)
    expect(lines.some((l) => l.includes('First line'))).toBe(true)
    expect(lines.some((l) => l.includes('Second line'))).toBe(true)
  })
})

describe('erase an area', () => {
  it('removes the text inside and keeps the text outside', async () => {
    const src = await makeDocument()
    const box = boxOf(src, 0, 'Revenue rose')
    const { bytes } = await applyOperation(src, { op: 'erase', page: 0, box: [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2] })
    const text = withDoc(bytes, (d) => extractText(d, 0))
    expect(text).not.toContain('Revenue')
    expect(text).toContain('Costs stayed')
  })

  it('removes the picture under the area, not only covers it', async () => {
    const src = await makeImagePdf(600)
    const { bytes } = await applyOperation(src, { op: 'erase', page: 0, box: [100, 100, 300, 300] })
    const pixels = withDoc(bytes, (d) => {
      const pm = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
      const px = pm.getPixels()
      const w = pm.getWidth()
      const at = (x: number, y: number): number => px[(y * w + x) * 3]! + px[(y * w + x) * 3 + 1]! + px[(y * w + x) * 3 + 2]!
      return { inside: at(200, 200), outside: at(450, 450) }
    })
    expect(pixels.inside).toBe(765) // white
    expect(pixels.outside).toBeLessThan(765)
  })
})

describe('editing under a watermark', () => {
  it('edits a line that a diagonal watermark crosses', async () => {
    const { bytes: marked } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: 'CONFIDENTIAL 2026', size: 60, rotation: 45 })
    const doc = openPdf(marked)
    const line = extractLines(doc, 0).find((l) => l.text.startsWith('Marker'))!
    free(doc)
    const { bytes } = await applyOperation(marked, { op: 'replaceText', page: 0, box: line.box, text: 'Edited under the mark' })
    const after = openPdf(bytes)
    try {
      expect(foldString(extractText(after, 0))).toContain(foldString('Edited under the mark'))
    } finally {
      free(after)
    }
  })
})

describe('fonts on this PC, underline, line spacing', () => {
  const hasArial = process.platform === 'win32'
  it.skipIf(!hasArial)('lists installed families and writes with one of them', async () => {
    const { systemFontFamilies } = await import('@engine/systemFonts')
    const families = systemFontFamilies()
    expect(families).toContain('Arial')
    const src = await makeLatinPdf(1)
    const doc = openPdf(src)
    const line = extractLines(doc, 0)[0]!
    free(doc)
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: line.box, text: 'Set in Arial', style: { family: 'Arial' } })
    const after = openPdf(bytes)
    try {
      const names = new Set<string>()
      after.loadPage(0).toStructuredText('preserve-whitespace').walk({ onChar(_c: string, _o: unknown, font: mupdf.Font) { names.add(font.getName()) } })
      expect([...names].some((n) => n.startsWith('Arial'))).toBe(true)
      expect(foldString(extractText(after, 0))).toContain(foldString('Set in Arial'))
    } finally {
      free(after)
    }
  })

  it.skipIf(!hasArial)('writes Arabic in an installed font that has it, joined and in order', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'addText', page: 0, x: 400, y: 400, text: 'تم التعديل', size: 20, family: 'Arial' })
    const after = openPdf(bytes)
    try {
      const names = new Set<string>()
      after.loadPage(0).toStructuredText('preserve-whitespace').walk({ onChar(_c: string, _o: unknown, font: mupdf.Font) { names.add(font.getName()) } })
      expect([...names].some((n) => n.startsWith('Arial'))).toBe(true)
      expect(foldString(extractText(after, 0))).toContain(foldString('تم التعديل'))
    } finally {
      free(after)
    }
  })

  it('underlines added text', async () => {
    const src = await makeLatinPdf(1)
    const plain = await applyOperation(src, { op: 'addText', page: 0, x: 60, y: 400, text: 'Underlined words', size: 20 })
    const under = await applyOperation(src, { op: 'addText', page: 0, x: 60, y: 400, text: 'Underlined words', size: 20, underline: true })
    const inkBelow = (bytes: Uint8Array): number => {
      const doc = openPdf(bytes)
      try {
        const pm = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
        const px = pm.getPixels()
        let n = 0
        // The darkest row just under the baseline (400).
        for (let y = 401; y <= 404; y++) {
          let row = 0
          for (let x = 60; x < 200; x++) if (px[y * pm.getWidth() + x]! < 128) row++
          n = Math.max(n, row)
        }
        return n
      } finally {
        free(doc)
      }
    }
    expect(inkBelow(under.bytes)).toBeGreaterThan(inkBelow(plain.bytes) + 60)
  })

  it('spaces lines as asked', async () => {
    const src = await makeLatinPdf(1, { width: 600, height: 800 })
    const baselines = async (lineHeight?: number): Promise<number> => {
      const { bytes } = await applyOperation(src, { op: 'addText', page: 0, x: 60, y: 300, text: 'first line\nsecond line', size: 20, ...(lineHeight ? { lineHeight } : {}) })
      const doc = openPdf(bytes)
      try {
        const lines = extractLines(doc, 0).filter((l) => /line/.test(l.text))
        return lines[1]!.box[1] - lines[0]!.box[1]
      } finally {
        free(doc)
      }
    }
    expect(await baselines(2)).toBeCloseTo(40, 0)
    expect(await baselines()).toBeCloseTo(25, 0)
  })
})

describe('format all text', () => {
  it('scales every paragraph and keeps the words and their order', async () => {
    const src = await makeLatinPdf(2)
    const before = (() => {
      const doc = openPdf(src)
      try {
        return extractLines(doc, 0).map((l) => ({ text: l.text, h: l.box[3] - l.box[1] }))
      } finally {
        free(doc)
      }
    })()
    const { bytes, note } = await applyOperation(src, { op: 'formatText', scale: 1.5 })
    expect(note?.key).toBe('note.formatted')
    const doc = openPdf(bytes)
    try {
      const after = extractLines(doc, 0)
      for (const b of before) {
        const a = after.find((l) => l.text === b.text)
        expect(a, b.text).toBeDefined()
        expect(a!.box[3] - a!.box[1]).toBeGreaterThan(b.h * 1.3)
      }
      // Page 2 changed too.
      expect(extractText(doc, 1)).toContain('Page 2')
    } finally {
      free(doc)
    }
  })

  it('sets one size and a typeface on chosen pages only', async () => {
    const src = await makeLatinPdf(2)
    const { bytes } = await applyOperation(src, { op: 'formatText', pages: [1], size: 9, kind: 'serif' })
    const doc = openPdf(bytes)
    try {
      const fontsOn = (p: number): Set<string> => {
        const names = new Set<string>()
        doc.loadPage(p).toStructuredText('preserve-whitespace').walk({ onChar(_c: string, _o: unknown, font: mupdf.Font) { names.add(font.getName()) } })
        return names
      }
      expect([...fontsOn(1)].some((n) => /Times/i.test(n))).toBe(true)
      expect([...fontsOn(0)].some((n) => /Times/i.test(n))).toBe(false)
    } finally {
      free(doc)
    }
  })

  it('keeps Arabic readable when its size changes', async () => {
    const { bytes: withArabic } = await applyOperation(await makeLatinPdf(1), { op: 'addText', page: 0, x: 350, y: 400, text: 'نص عربي للتجربة', size: 14 })
    const { bytes } = await applyOperation(withArabic, { op: 'formatText', scale: 1.25 })
    const doc = openPdf(bytes)
    try {
      expect(foldString(extractText(doc, 0))).toContain(foldString('نص عربي للتجربة'))
    } finally {
      free(doc)
    }
  })
})

describe('keeping the paragraph font', () => {
  const fontsOf = (bytes: Uint8Array): Set<string> => {
    const doc = openPdf(bytes)
    const names = new Set<string>()
    try {
      doc.loadPage(0).toStructuredText('preserve-whitespace').walk({ onChar(_c: string, _o: unknown, font: mupdf.Font) { names.add(font.getName()) } })
    } finally {
      free(doc)
    }
    return names
  }
  async function pdfWith(fontBytes: Uint8Array, subset: boolean): Promise<Uint8Array> {
    const { PDFDocument } = await import('pdf-lib')
    const fontkit = (await import('@pdf-lib/fontkit')).default
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(fontBytes, { subset })
    pdf.addPage([400, 300]).drawText('Hello from the original font', { x: 40, y: 200, size: 14, font })
    return new Uint8Array(await pdf.save())
  }
  const edit = async (src: Uint8Array, text: string) => {
    const doc = openPdf(src)
    const line = extractLines(doc, 0)[0]!
    free(doc)
    return applyOperation(src, { op: 'replaceText', page: 0, box: line.box, text })
  }

  it.skipIf(process.platform !== 'win32')('uses the same font when it is installed on this PC', async () => {
    const { readFileSync } = await import('node:fs')
    const src = await pdfWith(new Uint8Array(readFileSync('C:/Windows/Fonts/arial.ttf')), true)
    const r = await edit(src, 'Edited, still Arial')
    expect([...fontsOf(r.bytes)].some((n) => /Arial/i.test(n))).toBe(true)
    expect(r.note?.key).not.toBe('note.fontSimilar')
  })

  it('reuses the font embedded in the PDF when it is not installed', async () => {
    const { readFileSync } = await import('node:fs')
    const noto = new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf'))
    const r = await edit(await pdfWith(noto, false), 'Brand new words: quixotic jazz')
    expect([...fontsOf(r.bytes)].some((n) => /Noto/i.test(n))).toBe(true)
    expect(r.note?.key).not.toBe('note.fontSimilar')
  })

  it('keeps a standard PDF font without a warning', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Courier)
    pdf.addPage([400, 300]).drawText('Typewriter words', { x: 40, y: 200, size: 14, font })
    const r = await edit(new Uint8Array(await pdf.save()), 'Other words')
    expect(r.note?.key).not.toBe('note.fontSimilar')
  })

  it('names the font when a similar one had to be used', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const pdf = await PDFDocument.create()
    // A font neither installed nor usable from the file: Noto Sans embedded as a subset of its own letters.
    const { readFileSync } = await import('node:fs')
    const fontkit = (await import('@pdf-lib/fontkit')).default
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf')), { subset: true })
    pdf.addPage([400, 300]).drawText('abc', { x: 40, y: 200, size: 14, font })
    void StandardFonts
    const r = await edit(new Uint8Array(await pdf.save()), 'xyz quite different')
    expect(r.note?.key).toBe('note.fontSimilar')
    expect(r.note?.values?.font).toMatch(/NotoSans/)
  })
})

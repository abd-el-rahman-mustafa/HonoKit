import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { describe, expect, it } from 'vitest'
import { replaceText, unchangedLines, unreadable } from '@engine/edit'
import { ligatureLetters, readToUnicode, writeToUnicode } from '@engine/ligatures'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { kindOf, styledLines, withoutOverprints } from '@engine/paragraphs'
import { extractText } from '@engine/text'

/**
 * Text the person did not change stays as it was (docs/decisions.md §57, §58): ligatures read in
 * full, unchanged lines left untouched, copies drawn twice read once, neighbours kept.
 */

describe('ligatures whose text map gives only part of them', () => {
  it('reads glyph names as letters', () => {
    expect(ligatureLetters('f_t')).toBe('ft')
    expect(ligatureLetters('t_t')).toBe('tt')
    expect(ligatureLetters('f_f_i')).toBe('ffi')
    expect(ligatureLetters('fl')).toBe('fl')
    expect(ligatureLetters('f_t.alt')).toBe('ft')
    expect(ligatureLetters('uni00660074')).toBeNull() // one name, not a ligature with parts
    expect(ligatureLetters('f_uni0074')).toBe('ft')
    expect(ligatureLetters('t')).toBeNull()
    expect(ligatureLetters('uni2191')).toBeNull()
  })

  it('reads and writes a ToUnicode map', () => {
    const map = readToUnicode('2 beginbfrange\n<20><22><0020>\n<30><31>[<0041> <00660074>]\nendbfrange\n1 beginbfchar\n<7E> <0074>\nendbfchar')
    expect(map.get(0x21)).toBe('!')
    expect(map.get(0x31)).toBe('ft')
    expect(map.get(0x7e)).toBe('t')
    expect(readToUnicode(writeToUnicode(map))).toEqual(map)
  })

  /** "gi~shop" drawn with a font that names code 126 "f_t" but maps it to "t" only. */
  async function brokenLigaturePdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 200]).drawText('www.gi~shop.ae', { x: 40, y: 100, size: 20, font })
    const bytes = new Uint8Array(await pdf.save())
    const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!
    try {
      const fonts = doc.findPage(0).getInheritable('Resources').get('Font')
      fonts.forEach((value) => {
        const dict = value.resolve()
        const enc = doc.newDictionary()
        const diff = doc.newArray()
        diff.push(126)
        diff.push(doc.newName('f_t'))
        enc.put('Differences', diff)
        enc.put('BaseEncoding', doc.newName('WinAnsiEncoding'))
        dict.put('Encoding', enc)
        const cmap = writeToUnicode(new Map([...Array.from({ length: 0x7e - 0x20 }, (_, i) => [0x20 + i, String.fromCharCode(0x20 + i)] as [number, string]), [0x7e, 't']]))
        dict.put('ToUnicode', doc.addStream(cmap, doc.newDictionary()))
      })
      return new Uint8Array(doc.saveToBuffer('').asUint8Array())
    } finally {
      doc.destroy()
    }
  }

  it('reads "giftshop", not "gitshop"', async () => {
    const bytes = await brokenLigaturePdf()
    // Without the repair MuPDF reads what the map says.
    const raw = mupdf.Document.openDocument(bytes, 'application/pdf')
    expect(raw.loadPage(0).toStructuredText('preserve-whitespace').asText()).toContain('gitshop')
    raw.destroy()
    const doc = openPdf(bytes)
    try {
      expect(extractText(doc, 0)).toContain('www.giftshop.ae')
    } finally {
      free(doc)
    }
  })

  it('an edit of that line keeps the f', async () => {
    const bytes = await brokenLigaturePdf()
    const doc = openPdf(bytes)
    const line = styledLines(doc, 0)[0]!
    free(doc)
    const r = await replaceText(bytes, 0, line.box, 'visit www.giftshop.ae')
    const after = openPdf(r.bytes)
    try {
      expect(extractText(after, 0)).toContain('visit www.giftshop.ae')
    } finally {
      free(after)
    }
  })
})

describe('lines the person did not change', () => {
  it('finds the unchanged lines at both ends', () => {
    const lines = ['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota', 'kappa lambda']
    expect(unchangedLines(lines, 'alpha beta gamma delta EDIT zeta eta theta iota kappa lambda')).toEqual({ head: 1, tail: 2, from: 17, to: 32 })
    expect(unchangedLines(lines, 'CHANGED beta gamma delta epsilon zeta eta theta iota kappa lambda').head).toBe(0)
    expect(unchangedLines(lines, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda!').tail).toBe(0)
    // A whole line removed: the text between the kept lines is empty, not negative.
    const gone = unchangedLines(lines, 'alpha beta gamma eta theta iota kappa lambda')
    expect(gone.to).toBeGreaterThanOrEqual(gone.from)
    // One line: it is always the one set again.
    expect(unchangedLines(['only line'], 'only line changed')).toEqual({ head: 0, tail: 0, from: 0, to: 17 })
  })

  /** A three-line paragraph in Noto Sans embedded as a subset of its own letters only. */
  async function subsetParagraph(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf')), { subset: true })
    const page = pdf.addPage([400, 300])
    const lines = ['alpha beta gamma delta epsilon', 'zeta eta theta iota kappa mu', 'lambda nu xi omicron pi rho']
    lines.forEach((t, i) => page.drawText(t, { x: 40, y: 220 - i * 16, size: 12, font }))
    return new Uint8Array(await pdf.save())
  }
  const fontsByLine = (bytes: Uint8Array): Map<string, string> => {
    const doc = openPdf(bytes)
    const out = new Map<string, string>()
    try {
      let text = ''
      let fonts = new Set<string>()
      doc.loadPage(0).toStructuredText('preserve-whitespace').walk({
        beginLine() {
          text = ''
          fonts = new Set()
        },
        onChar(c: string, _o: unknown, font: mupdf.Font) {
          text += c
          if (c.trim()) fonts.add(font.getName())
        },
        endLine() {
          out.set(text.trim(), [...fonts].join(','))
        }
      })
    } finally {
      free(doc)
    }
    return out
  }

  it('retyping the same text changes nothing at all', async () => {
    const src = await subsetParagraph()
    const doc = openPdf(src)
    const line = styledLines(doc, 0)[0]!
    free(doc)
    const r = await replaceText(src, 0, line.box, 'alpha beta gamma delta epsilon zeta eta theta iota kappa mu lambda nu xi omicron pi rho')
    expect(r.bytes).toBe(src)
  })

  it('a word changed in the middle line leaves the first and last lines in their own font', async () => {
    const src = await subsetParagraph()
    const doc = openPdf(src)
    const line = styledLines(doc, 0)[0]!
    free(doc)
    // Q, U, I, Z are not in the subset: the middle line needs a stand-in font.
    const r = await replaceText(src, 0, line.box, 'alpha beta gamma delta epsilon zeta eta QUIZ iota kappa mu lambda nu xi omicron pi rho')
    const lines = fontsByLine(r.bytes)
    expect(lines.get('alpha beta gamma delta epsilon')).toMatch(/NotoSans/)
    expect(lines.get('lambda nu xi omicron pi rho')).toMatch(/NotoSans/)
    expect([...lines.keys()].some((t) => t.includes('QUIZ'))).toBe(true)
    // Nothing else on the page went missing.
    const after = openPdf(r.bytes)
    try {
      const text = extractText(after, 0).replace(/\s+/g, ' ')
      for (const w of ['alpha', 'epsilon', 'zeta', 'eta', 'QUIZ', 'iota', 'kappa', 'mu', 'lambda', 'rho']) expect(text).toContain(w)
      expect(text).not.toContain('theta')
    } finally {
      free(after)
    }
  })
})

describe("new words in the page's own font (§59)", () => {
  it('writes words whose letters the page shows with the very font object on the page', async () => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf')), { subset: true })
    const page = pdf.addPage([400, 300])
    const lines = ['alpha beta gamma delta epsilon', 'zeta eta theta iota kappa mu', 'lambda nu xi omicron pi rho']
    lines.forEach((t, i) => page.drawText(t, { x: 40, y: 220 - i * 16, size: 12, font }))
    const src = new Uint8Array(await pdf.save())
    const doc = openPdf(src)
    const first = styledLines(doc, 0)[0]!
    const original = first.runs[0]!.font
    free(doc)
    // "beta" and "gamma" use letters the page already shows in that font.
    const r = await replaceText(src, 0, first.box, 'alpha beta gamma delta epsilon zeta eta beta gamma kappa mu lambda nu xi omicron pi rho')
    const after = openPdf(r.bytes)
    try {
      const names = new Map<string, Set<string>>()
      let text = ''
      let fonts = new Set<string>()
      after.loadPage(0).toStructuredText('preserve-whitespace').walk({
        beginLine() {
          text = ''
          fonts = new Set()
        },
        onChar(c: string, _o: unknown, f: mupdf.Font) {
          text += c
          if (c.trim()) fonts.add(f.getName())
        },
        endLine() {
          names.set(text.trim(), fonts)
        }
      })
      const middle = [...names].find(([t]) => t.includes('beta gamma kappa'))
      expect(middle).toBeDefined()
      // The same subset, tag and all: not a new copy of the font.
      expect([...middle![1]]).toEqual([original])
      expect(r.font?.kept).toBe('embedded')
    } finally {
      free(after)
    }
  })
})

describe('reading', () => {
  it('reads a line drawn twice once (InDesign Arabic draws each line end again)', () => {
    const line = (text: string, box: [number, number, number, number]) => ({ text, box, baseline: box[3], size: 10 })
    const full = line('ومختلف جوانب التعاون بين البلدين،', [262.9, 423.7, 416.9, 431])
    const copy = line('،دين', [262.9, 423.7, 284.4, 431])
    const next = line('مؤكدين حرصهما على مواصلة التشاور', [262.9, 436.5, 417, 443.8])
    expect(withoutOverprints([full, copy, next])).toEqual([full, next])
    // A short line that is not inside another, or has its own letters, stays.
    const own = line('جديد', [262.9, 423.7, 284.4, 431])
    expect(withoutOverprints([full, own])).toHaveLength(2)
  })

  it('knows text whose letters the file does not map', () => {
    expect(unreadable('���www.adjd.gov.ae����������')).toBe(true)
    expect(unreadable('Total � 1,250 AED')).toBe(false)
    expect(unreadable('')).toBe(false)
  })

  it('knows sans faces by name, whatever their flags say', () => {
    const serifFlag = { isMono: () => false, isSerif: () => true }
    expect(kindOf('Futura-Book', serifFlag)).toBe('sans')
    expect(kindOf('EuclidFlexMedium', serifFlag)).toBe('sans')
    expect(kindOf('Futura-CondensedBold', serifFlag)).toBe('sans')
    expect(kindOf('MinionPro-Regular')).toBe('serif')
    expect(kindOf('BookmanOldStyle')).toBe('serif')
    expect(kindOf('Courier')).toBe('mono')
  })
})

describe('text moves made explicit before MuPDF rewrites a page', () => {
  it('turns T*, quote operators and TD into plain moves, and keeps the leading set (TL)', async () => {
    const { explicitStream } = await import('@engine/contentfix')
    const out = explicitStream('BT /F1 9 Tf 1 0 0 1 10 700 Tm 9.5 TL (a)Tj T* (b)Tj 195.59 266 Td (c)\' 1 2 (d)" 0 -12 TD T* (e)Tj ET').text
    // Nothing in the page depends on the leading any more; it is still set, for a form drawn later
    // (checked on a newspaper page and another PDF: 116 edits, no line moved, 2026-10-08).
    expect(out).toBe('BT /F1 9 Tf 1 0 0 1 10 700 Tm 9.5 TL (a)Tj 0 -9.5 Td (b)Tj 195.59 266 Td 0 -9.5 Td (c) Tj 1 Tw 2 Tc 0 -9.5 Td (d) Tj 0 -12 Td 12 TL 0 -12 Td (e)Tj ET')
  })

  it('keeps the leading per graphics state, and leaves strings alone', async () => {
    const { explicitStream } = await import('@engine/contentfix')
    const out = explicitStream('q 10 TL Q BT (T* inside \) a string)Tj T* ET').text
    // Q restored the leading to 0; the T* inside the string is text, not an operator.
    expect(out).toBe('q 10 TL Q BT (T* inside \) a string)Tj 0 0 Td ET')
  })
})

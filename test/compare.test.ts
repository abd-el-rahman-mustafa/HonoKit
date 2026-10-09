import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { diffWords, pdfWords, textWords, type CompareOptions } from '@engine/compare'
import { free, openPdf } from '@engine/mupdf'

const OPTIONS: CompareOptions = { ignoreMarks: true, ignorePunctuation: false, sameDigits: true }

describe('compare', () => {
  it('finds an added, a removed and a changed word in texts', () => {
    const a = textWords('The total is 1,000 AED for the first quarter')
    const b = textWords('The final total is 1,200 AED for the quarter')
    const changes = diffWords(a, b, OPTIONS)
    const described = changes.map((c) => `${c.kind}:${a.slice(...c.a).map((w) => w.text).join(' ')}>${b.slice(...c.b).map((w) => w.text).join(' ')}`)
    expect(described).toEqual(['insert:>final', 'replace:1,000>1,200', 'delete:first>'])
  })

  it('ignores vowel marks, tatweel and digit shapes when asked', () => {
    const a = textWords('بلغ المجموع ١٢٣ درهمًا')
    const b = textWords('بلغ المجمـوع 123 درهما')
    expect(diffWords(a, b, OPTIONS)).toEqual([])
    expect(diffWords(a, b, { ignoreMarks: false, ignorePunctuation: false, sameDigits: false }).length).toBeGreaterThan(0)
  })

  it('keeps a moved paragraph readable and handles long texts quickly', () => {
    const para = (n: number): string => Array.from({ length: 60 }, (_, i) => `word${n}_${i}`).join(' ')
    const a = Array.from({ length: 300 }, (_, n) => para(n)).join('\n')
    const bParas = Array.from({ length: 300 }, (_, n) => para(n))
    bParas[150] = bParas[150]!.replace('word150_7', 'changed')
    const started = Date.now()
    const changes = diffWords(textWords(a), textWords(bParas.join('\n')), OPTIONS)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.kind).toBe('replace')
  })

  it('gives each PDF word its page and box', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 300]).drawText('Hello brave world', { x: 40, y: 200, size: 20, font })
    pdf.addPage([400, 300]).drawText('Second page', { x: 40, y: 200, size: 20, font })
    const doc = openPdf(new Uint8Array(await pdf.save()))
    try {
      const words = pdfWords(doc)
      expect(words.map((w) => w.text)).toEqual(['Hello', 'brave', 'world', 'Second', 'page'])
      expect(words[3]!.page).toBe(1)
      expect(words[1]!.box![0]).toBeGreaterThan(words[0]!.box![2] - 1)
    } finally {
      free(doc)
    }
  })
})

describe('compare reading order', () => {
  it('reads a heading drawn last (an edit) where it is on the page', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 300])
    page.drawText('Body line one', { x: 40, y: 200, size: 12, font })
    page.drawText('Body line two', { x: 40, y: 180, size: 12, font })
    // Drawn after the body, but above it on the page.
    page.drawText('Title', { x: 40, y: 260, size: 20, font })
    const doc = openPdf(new Uint8Array(await pdf.save()))
    try {
      const a = pdfWords(doc)
      expect(a.map((w) => w.text).join(' ')).toBe('Title Body line one Body line two')
      expect(diffWords(a, textWords('Title\nBody line one\nBody line 2'), OPTIONS)).toHaveLength(1)
    } finally {
      free(doc)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { findToRedact, redactionMarks } from '@engine/redact'
import { free, openPdf } from '@engine/mupdf'
import { extractText } from '@engine/text'
import { applyOperation } from '@ops/index'

async function sample(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([500, 400])
  const lines = [
    'Contact: ahmed.ali@example.ae or +971 50 123 4567',
    'Emirates ID 784-1990-1234567-1 and IBAN AE07 0331 2345 6789 0123 456',
    'Card 4111 1111 1111 1111 but not 1234 5678 9012 3456',
    'Signed on 30/09/2026 by the Secret Committee'
  ]
  lines.forEach((l, i) => page.drawText(l, { x: 30, y: 350 - i * 30, size: 12, font }))
  pdf.setTitle('Secret title')
  pdf.setAuthor('Someone')
  return new Uint8Array(await pdf.save())
}

function text(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, 0)
  } finally {
    free(doc)
  }
}

describe('redaction', () => {
  it('finds words and every pattern, and skips numbers that are not card numbers', async () => {
    const doc = openPdf(await sample())
    try {
      const found = (patterns: Parameters<typeof findToRedact>[1]['patterns'], words: string[] = []) => findToRedact(doc, { words, patterns, wholeWords: true }).map((h) => h.text)
      expect(found(['email'])).toEqual(['ahmed.ali@example.ae'])
      expect(found(['phone'])).toEqual(['+971 50 123 4567'])
      expect(found(['emiratesId'])).toEqual(['784-1990-1234567-1'])
      expect(found(['iban'])[0]).toMatch(/^AE07 0331/)
      expect(found(['card'])).toEqual(['4111 1111 1111 1111'])
      expect(found(['date'])).toEqual(['30/09/2026'])
      expect(found([], ['secret'])).toEqual(['Secret'])
      // Whole words only: "Secret" is not found inside "Secretary"-like text unless asked.
      expect(findToRedact(doc, { words: ['ecre'], patterns: [], wholeWords: true })).toHaveLength(0)
      expect(findToRedact(doc, { words: ['ecre'], patterns: [], wholeWords: false })).toHaveLength(1)
    } finally {
      free(doc)
    }
  })

  it('reads Arabic-Indic digits in patterns', async () => {
    const { bytes } = await applyOperation(await sample(), { op: 'addText', page: 0, x: 400, y: 380, text: 'الهاتف ٠٥٠١٢٣٤٥٦٧', size: 14 })
    const doc = openPdf(bytes)
    try {
      expect(findToRedact(doc, { words: [], patterns: ['phone'], wholeWords: true }).some((h) => /[٠-٩]/.test(h.text))).toBe(true)
    } finally {
      free(doc)
    }
  })

  it('marks, then removes the text for good, draws the label, and checks nothing is left', async () => {
    const src = await sample()
    const doc = openPdf(src)
    const hits = findToRedact(doc, { words: ['Secret'], patterns: ['email', 'emiratesId'], wholeWords: true })
    free(doc)
    const marked = await applyOperation(src, { op: 'redactMark', marks: hits.flatMap((h) => h.boxes.map((box) => ({ page: h.page, box }))) })
    const check = openPdf(marked.bytes)
    expect(redactionMarks(check)).toHaveLength(3)
    free(check)
    // Marks alone remove nothing.
    expect(text(marked.bytes)).toContain('ahmed.ali@example.ae')
    const applied = await applyOperation(marked.bytes, { op: 'redactApply', label: 'REDACTED' })
    const after = text(applied.bytes)
    expect(after).not.toContain('ahmed.ali')
    expect(after).not.toContain('784-1990')
    expect(after).not.toContain('Secret')
    expect(after).toContain('Committee')
    expect(after).toContain('REDACTED')
    expect(applied.note?.key).toBe('note.redacted')
    expect(applied.note?.values?.leftover).toBe(0)
    const final = openPdf(applied.bytes)
    try {
      expect(redactionMarks(final)).toHaveLength(0)
      // Hidden information went too.
      expect(final.getMetaData('info:Title') ?? '').toBe('')
    } finally {
      free(final)
    }
  })

  it('refuses to apply with nothing marked, and clears marks', async () => {
    const src = await sample()
    await expect(applyOperation(src, { op: 'redactApply' })).rejects.toThrow()
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [20, 20, 200, 60] }] })
    const cleared = await applyOperation(marked.bytes, { op: 'redactClear' })
    const doc = openPdf(cleared.bytes)
    try {
      expect(redactionMarks(doc)).toHaveLength(0)
    } finally {
      free(doc)
    }
  })
})

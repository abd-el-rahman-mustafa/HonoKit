import { describe, expect, it } from 'vitest'
import { free, openPdf, type PdfDoc } from '@engine/mupdf'
import { extractText } from '@engine/text'
import { applyOperation } from '@ops/index'

/** A one-page PDF written by hand, so its content stream holds exactly `content`. */
function rawPdf(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let out = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** The page's content streams, decoded and joined, as MuPDF reads them. */
function contentOf(doc: PdfDoc): string {
  const contents = doc.findPage(0).get('Contents')
  const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents]
  return streams.map((s) => s.readStream().asString()).join(' ')
}

/** Every object of the file, streams decoded, as text. */
function wholeFile(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    const out = doc.saveToBuffer('decompress=yes')
    try {
      return out.asString()
    } finally {
      out.destroy()
    }
  } finally {
    free(doc)
  }
}

describe('redaction and replacement text', () => {
  it('the replacement text of removed text goes with it; other spans keep theirs', async () => {
    const src = rawPdf(
      [
        '/Span << /ActualText (Account HIDDEN-98765) >> BDC',
        'BT /F1 12 Tf 50 300 Td (Account 98765) Tj ET',
        'EMC',
        '/Span << /ActualText (Kept description) >> BDC',
        'BT /F1 12 Tf 50 150 Td (Public line) Tj ET',
        'EMC'
      ].join('\n')
    )
    // The first line sits at y 300 from the bottom: 100 from the top, about 12 points tall.
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [40, 84, 220, 106] }] })
    const applied = await applyOperation(marked.bytes, { op: 'redactApply' })
    const doc = openPdf(applied.bytes)
    try {
      const content = contentOf(doc)
      expect(content).not.toContain('98765')
      expect(content).toContain('Kept description')
      expect(wholeFile(applied.bytes)).not.toContain('98765')
    } finally {
      free(doc)
    }
  })

  it('a span that holds the removed text loses its description too, however deep', async () => {
    const src = rawPdf(
      [
        '/Sect << /Alt <4f75746572204e616d65> /Lang (en) >> BDC',
        '/Span << /E (Expanded 4242) /MCID 7 >> BDC BT /F1 12 Tf 50 300 Td (Code 4242) Tj ET EMC',
        'BT /F1 12 Tf 50 150 Td (Other line) Tj ET',
        'EMC'
      ].join('\n')
    )
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [40, 84, 220, 106] }] })
    const applied = await applyOperation(marked.bytes, { op: 'redactApply' })
    const doc = openPdf(applied.bytes)
    try {
      const content = contentOf(doc)
      expect(content).not.toContain('4242')
      expect(content).not.toMatch(/Outer Name|4f75746572/i)
      // Only the replacement text goes: the language, the MCID and the line that stays are kept.
      expect(content).toMatch(/MCID\s*7/)
      expect(content).toContain('/Lang')
      expect(content).toContain('Other line')
    } finally {
      free(doc)
    }
  })

  it('a span named in the page resources gets its own dictionary, and the named entry goes', async () => {
    const content = '/Span /MC0 BDC BT /F1 12 Tf 50 300 Td (Account 98765) Tj ET EMC'
    const text = new TextDecoder()
      .decode(rawPdf(content))
      .replace('/Resources << /Font << /F1 4 0 R >> >>', '/Resources << /Font << /F1 4 0 R >> /Properties << /MC0 << /ActualText (Account 98765) /MCID 3 >> >> >>')
    // The xref offsets are now off; MuPDF repairs the table when it opens the file.
    const src = new TextEncoder().encode(text)
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [40, 84, 220, 106] }] })
    const applied = await applyOperation(marked.bytes, { op: 'redactApply' })
    const doc = openPdf(applied.bytes)
    try {
      const out = contentOf(doc)
      expect(out).not.toContain('98765')
      expect(out).toMatch(/MCID\s*3/)
      expect(wholeFile(applied.bytes)).not.toContain('98765')
    } finally {
      free(doc)
    }
  })

  it('a comment left open at the end of the page does not hide a watermark or a redaction box', async () => {
    // Readers join content streams with a space, so an unended comment runs on into the next one.
    const src = rawPdf('BT /F1 12 Tf 50 300 Td (Account 98765) Tj ET\n% a note with no line end')
    const { bytes: marked } = await applyOperation(src, { op: 'watermark', text: 'DRAFTMARK', size: 40, rotation: 0 })
    const doc = openPdf(marked)
    try {
      expect(extractText(doc, 0)).toContain('DRAFTMARK')
    } finally {
      free(doc)
    }
    const boxed = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [40, 84, 220, 106] }] })
    const applied = await applyOperation(boxed.bytes, { op: 'redactApply', label: 'GONE' })
    const after = openPdf(applied.bytes)
    try {
      expect(extractText(after, 0)).toContain('GONE')
    } finally {
      free(after)
    }
  })

  it('Erase area clears the replacement text of what it erased', async () => {
    const src = rawPdf(
      [
        '/Span << /ActualText (Erased 5555) >> BDC BT /F1 12 Tf 50 300 Td (Erased 5555) Tj ET EMC',
        '/Span << /ActualText (Stays here) >> BDC BT /F1 12 Tf 50 150 Td (Stays here) Tj ET EMC'
      ].join('\n')
    )
    const { bytes } = await applyOperation(src, { op: 'erase', page: 0, box: [40, 84, 220, 106] })
    const doc = openPdf(bytes)
    try {
      const content = contentOf(doc)
      expect(content).not.toContain('5555')
      expect(content.match(/Stays here/g)).toHaveLength(2)
    } finally {
      free(doc)
    }
  })
})

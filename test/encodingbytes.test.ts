import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { findToRedact } from '@engine/redact'
import { extractLines, searchLines } from '@engine/text'

/**
 * Pins how the engine reads two bytes of WinAnsiEncoding that PDF 32000 Annex D.2 gives the
 * glyph names of ordinary characters: 0xAD is the hyphen and 0xA0 is the space, as they are
 * drawn, not the invisible soft hyphen and no-break space a Windows code page would say. Text
 * the reader can see must match a search and a redaction pattern typed with a plain hyphen.
 * (Checked here so that a MuPDF upgrade cannot change it unnoticed, see decisions §17.)
 */

/** A one-page PDF drawing `literal` (a PDF literal string, escapes allowed) in Helvetica with the given encoding. */
function pdfWith(literal: string, encoding: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${encoding} >>`
  ]
  const content = `BT /F1 18 Tf 20 50 Td (${literal}) Tj ET`
  objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}

const read = (bytes: Uint8Array): string => {
  const doc = openPdf(bytes)
  try {
    return extractLines(doc, 0)
      .map((l) => l.text)
      .join('\n')
  } finally {
    free(doc)
  }
}

describe('WinAnsi bytes 0xAD and 0xA0', () => {
  it('read as the hyphen and the space they draw, so search and redaction see them', () => {
    // "well-known" with the 0xAD byte (octal 255) and "a b" with 0xA0 (octal 240).
    const bytes = pdfWith('well\\255known a\\240b', '/WinAnsiEncoding')
    expect(read(bytes)).toBe('well-known a b')
    const doc = openPdf(bytes)
    try {
      expect(searchLines(extractLines(doc, 0), 'well-known', 0)).toHaveLength(1)
      expect(findToRedact(doc, { words: ['well-known'], patterns: [], wholeWords: true })).toHaveLength(1)
    } finally {
      free(doc)
    }
  })

  it('a /Differences entry that names the soft hyphen on purpose keeps it', () => {
    const bytes = pdfWith('well\\255known', '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [173 /sfthyphen] >>')
    expect(read(bytes)).toBe('well­known')
  })
})

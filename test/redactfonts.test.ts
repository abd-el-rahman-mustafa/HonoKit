import { describe, expect, it } from 'vitest'
import { applyRedactions, markForRedaction } from '@engine/redact'
import { free, openPdf } from '@engine/mupdf'
import type * as mupdf from 'mupdf'

/**
 * A font keeps the shape of the characters it drew. A Type 3 font's glyph programs are content
 * streams, each free to draw a picture of its own, so a scanned or bitmap-font page whose text was
 * redacted left the ink of the redacted characters in the saved file; a simple font's /ToUnicode
 * says which characters the text had. A font the redacted pages no longer name must go with them,
 * and a font another page still draws must stay.
 */

/** A raw PDF built from numbered objects, with a correct xref table. */
function rawPdf(objects: string[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')]
  const offsets: number[] = []
  let at = parts[0]!.length
  objects.forEach((body, i) => {
    offsets.push(at)
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
    parts.push(chunk)
    at += chunk.length
  })
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}

const stream = (dict: string, data: string): string => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`

/** A Type 3 glyph that draws the picture called `name`, and a one-line picture holding `payload`. */
const glyph = (name: string): string => stream('', `1000 0 0 0 1000 1000 d0\nq 1000 0 0 1000 0 0 cm /${name} Do Q`)
const picture = (payload: string): string => stream(`/Type /XObject /Subtype /Image /Width ${payload.length} /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8`, payload)
const type3 = (): string =>
  '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 65 /LastChar 66 /Widths [1000 1000] /Encoding << /Differences [65 /Ga /Gb] >> /CharProcs << /Ga 7 0 R /Gb 8 0 R >> /Resources << /XObject << /ImA 9 0 R /ImB 10 0 R >> >> >>'

/**
 * Two pages sharing one /Resources, which is where a redaction leaves a font behind: the rewritten
 * page gets its own pruned resources, while the dictionary it drew through keeps every name the
 * second page's presence justifies. The first page draws "AB" with a Type 3 font whose two glyphs
 * are pictures; what the second page draws is the argument.
 */
function shared(second: string): Uint8Array {
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 11 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources 5 0 R >>',
    stream('', 'BT /T3 24 Tf 20 200 Td (AB) Tj ET'),
    '<< /Font << /T3 6 0 R >> >>',
    type3(),
    glyph('ImA'),
    glyph('ImB'),
    picture('GLYPH-A-INK-PAYLOAD'),
    picture('GLYPH-B-INK-PAYLOAD'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 12 0 R /Resources 5 0 R >>',
    stream('', second)
  ])
}

/** The same two pages, the shared font a simple one carrying a /ToUnicode map. */
function sharedSimple(second: string): Uint8Array {
  const toUnicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 beginbfchar <41> <0041> endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end\n% TOUNICODE-PAYLOAD'
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources 5 0 R >>',
    stream('', 'BT /F1 24 Tf 20 200 Td (AB) Tj ET'),
    '<< /Font << /F1 6 0 R >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 65 /LastChar 66 /Widths [1000 1000] /ToUnicode 7 0 R >>',
    stream('', toUnicode),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 9 0 R /Resources 5 0 R >>',
    stream('', second)
  ])
}

/** A second page that draws no text at all. */
const NO_TEXT = '0 0 0 rg 10 10 40 40 re f'

/**
 * No page's own content names /T3 after the redaction, but another Type 3 font in the same
 * dictionary draws with it from inside a glyph program, which a reader resolves against the page's
 * resources (PDF 32000 §9.6.5). The font and its glyphs must stay.
 */
function nested(): Uint8Array {
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 11 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources 5 0 R >>',
    stream('', 'BT /T3 24 Tf 20 200 Td (AB) Tj ET'),
    '<< /Font << /T3 6 0 R /T4 13 0 R >> >>',
    type3(),
    glyph('ImA'),
    glyph('ImB'),
    picture('GLYPH-A-INK-PAYLOAD'),
    picture('GLYPH-B-INK-PAYLOAD'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 12 0 R /Resources 5 0 R >>',
    stream('', 'BT /T4 24 Tf 20 100 Td (A) Tj ET'),
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 65 /LastChar 65 /Widths [1000] /Encoding << /Differences [65 /Ha] >> /CharProcs << /Ha 14 0 R >> >>',
    stream('', '1000 0 0 0 1000 1000 d0\nBT /T3 10 Tf 0 0 Td (AB) Tj ET')
  ])
}

/** Every dictionary and decoded stream the saved file still reaches, as one latin-1 string. */
function reachable(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    let all = ''
    const count = doc.countObjects()
    for (let n = 1; n < count; n++) {
      let ref: mupdf.PDFObject
      try {
        ref = doc.newIndirect(n)
      } catch {
        continue
      }
      all += `\n${ref.resolve().toString()}`
      if (ref.isStream()) {
        try {
          all += `\n${Buffer.from(ref.readStream().asUint8Array()).toString('latin1')}`
        } catch {
          // An unreadable stream is nothing this test can judge.
        }
      }
    }
    return all
  } finally {
    free(doc)
  }
}

const redacted = async (bytes: Uint8Array, box: [number, number, number, number], page = 0): Promise<string> => {
  const out = await applyRedactions(markForRedaction(bytes, [{ page, box }]), { fill: [0, 0, 0], sanitize: false })
  expect(out.leftover).toBe(0)
  return reachable(out.bytes)
}

/** The mark covers both characters, so the redacted page draws no text afterwards. */
const WHOLE_TEXT: [number, number, number, number] = [16, 72, 72, 104]

describe('fonts left behind by a redaction', () => {
  it('takes a Type 3 font and its glyph pictures out of a shared dictionary', async () => {
    const before = reachable(shared(NO_TEXT))
    expect(before).toContain('GLYPH-A-INK-PAYLOAD')
    expect(before).toContain('GLYPH-B-INK-PAYLOAD')
    const after = await redacted(shared(NO_TEXT), WHOLE_TEXT)
    expect(after).not.toContain('GLYPH-A-INK-PAYLOAD')
    expect(after).not.toContain('GLYPH-B-INK-PAYLOAD')
    expect(after).not.toContain('/Type3')
  })

  it('keeps a shared font and its glyphs when another page still draws with it', async () => {
    const after = await redacted(shared('BT /T3 24 Tf 20 200 Td (B) Tj ET'), WHOLE_TEXT)
    expect(after).toContain('GLYPH-B-INK-PAYLOAD')
    expect(after).toContain('/Type3')
  })

  it("keeps a shared font another page's glyph program draws with", async () => {
    const after = await redacted(nested(), WHOLE_TEXT)
    expect(after).toContain('GLYPH-A-INK-PAYLOAD')
    expect(after).toContain('GLYPH-B-INK-PAYLOAD')
  })

  it("takes a simple font's character map out of a shared dictionary", async () => {
    expect(reachable(sharedSimple(NO_TEXT))).toContain('TOUNICODE-PAYLOAD')
    const after = await redacted(sharedSimple(NO_TEXT), WHOLE_TEXT)
    expect(after).not.toContain('TOUNICODE-PAYLOAD')
  })

  it('keeps a simple font another page still draws with', async () => {
    const after = await redacted(sharedSimple('BT /F1 24 Tf 20 200 Td (B) Tj ET'), WHOLE_TEXT)
    expect(after).toContain('TOUNICODE-PAYLOAD')
  })
})

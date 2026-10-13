import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { free, openPdf } from '@engine/mupdf'
import { applyOperation } from '@ops/index'

// A picture in uncompressed RGB whose samples no other object in the file has.
const W = 8
const SAMPLES = new Uint8Array(W * W * 3).map((_, i) => [17, 99, 201][i % 3]!)

/** A hand-built file, so the resource layout is exactly what the test needs. */
function build(objects: string[], streams: Record<number, Uint8Array> = {}): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = [enc.encode('%PDF-1.7\n')]
  const offsets: number[] = []
  let at = parts[0]!.length
  objects.forEach((body, i) => {
    offsets.push(at)
    const n = i + 1
    const s = streams[n]
    const chunk = s ? [enc.encode(`${n} 0 obj\n${body.replace('LEN', String(s.length))}\nstream\n`), s, enc.encode('\nendstream\nendobj\n')] : [enc.encode(`${n} 0 obj\n${body}\nendobj\n`)]
    for (const c of chunk) {
      parts.push(c)
      at += c.length
    }
  })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
  parts.push(enc.encode(xref))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const enc = new TextEncoder()
const IMAGE = `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${W} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length LEN >>`
const DRAW = enc.encode('q 200 0 0 200 100 100 cm /Im0 Do Q')
const NOTHING = enc.encode('BT ET')

/** Whether any image in the file still holds the original samples. */
function pictureSurvives(bytes: Uint8Array): boolean {
  const doc = openPdf(bytes) as mupdf.PDFDocument
  try {
    for (let n = 1; n < doc.countObjects(); n++) {
      const obj = doc.newIndirect(n)
      if (!obj.isStream() || obj.get('Subtype').toString() !== '/Image') continue
      const data = obj.readStream().asUint8Array()
      if (data.length === SAMPLES.length && data.every((b, i) => b === SAMPLES[i])) return true
    }
    return false
  } finally {
    free(doc)
  }
}

async function redactPicture(src: Uint8Array): Promise<Uint8Array> {
  const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [80, 80, 320, 320] }] })
  return (await applyOperation(marked.bytes, { op: 'redactApply' })).bytes
}

describe('redaction removes the picture from resources the page shares', () => {
  it('a picture in the page own resources does not survive', async () => {
    const src = build(
      ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 400] >>', '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>', IMAGE, '<< /Length LEN >>'],
      { 4: SAMPLES, 5: DRAW }
    )
    expect(pictureSurvives(src)).toBe(true)
    expect(pictureSurvives(await redactPicture(src))).toBe(false)
  })

  it('a picture the page draws through resources inherited from the page tree does not survive', async () => {
    // 1 Catalog, 2 Pages (holds the resources), 3 page one (draws), 4 page two (draws nothing), 5 picture, 6-7 contents.
    const src = build(
      ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /XObject << /Im0 5 0 R >> >> /MediaBox [0 0 400 400] >>', '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>', IMAGE, '<< /Length LEN >>', '<< /Length LEN >>'],
      { 5: SAMPLES, 6: DRAW, 7: NOTHING }
    )
    expect(pictureSurvives(src)).toBe(true)
    expect(pictureSurvives(await redactPicture(src))).toBe(false)
  })

  it('a picture the page draws through a resource dictionary shared with another page does not survive', async () => {
    // 5 is one resource dictionary both pages point to; page two does not draw the picture.
    const src = build(
      ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 400 400] >>', '<< /Type /Page /Parent 2 0 R /Resources 5 0 R /Contents 7 0 R >>', '<< /Type /Page /Parent 2 0 R /Resources 5 0 R /Contents 8 0 R >>', '<< /XObject << /Im0 6 0 R >> >>', IMAGE, '<< /Length LEN >>', '<< /Length LEN >>'],
      { 6: SAMPLES, 7: DRAW, 8: NOTHING }
    )
    expect(pictureSurvives(await redactPicture(src))).toBe(false)
  })

  it('keeps the picture when another page still draws it', async () => {
    const src = build(
      ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /XObject << /Im0 5 0 R >> >> /MediaBox [0 0 400 400] >>', '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>', IMAGE, '<< /Length LEN >>', '<< /Length LEN >>'],
      { 5: SAMPLES, 6: DRAW, 7: DRAW }
    )
    const out = await redactPicture(src)
    expect(pictureSurvives(out)).toBe(true)
    const doc = openPdf(out)
    try {
      expect(doc.countPages()).toBe(2)
    } finally {
      free(doc)
    }
  })
})

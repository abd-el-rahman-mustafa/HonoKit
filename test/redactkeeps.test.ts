import { describe, expect, it } from 'vitest'
import { free, mupdf, openPdf, saveBytes, SAVE_FINAL } from '@engine/mupdf'
import { pageMarkups } from '@engine/markup'
import { applyOperation } from '@ops/index'

/**
 * Three faults of redaction, each proved on a hand-built file whose resource and annotation
 * layout is exactly the one that breaks (decisions §102):
 *
 * - a picture a form on another page still draws was unlinked from the shared resources, so it
 *   vanished from a page that had nothing redacted on it;
 * - an annotation written as a dictionary of its own in /Annots (no object number) was skipped,
 *   so a comment under a mark stayed, and an inline reply kept the comment it answered — its
 *   text included — in the saved file while the page looked clean;
 * - clearing or un-marking a mark left a reply to it behind, answering a mark that is gone.
 */

const W = 8
const SAMPLES = new Uint8Array(W * W * 3).map((_, i) => [17, 99, 201][i % 3]!)
const SECRET = 'TopSecretCommentText'

/** A hand-built file, so the layout is exactly what the test needs. */
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
const DRAW_IMAGE = enc.encode('q 200 0 0 200 100 100 cm /Im0 Do Q')
const DRAW_FORM = enc.encode('q /Fx Do Q')

/** Whether any image in the file still holds the original samples. */
function pictureSurvives(bytes: Uint8Array): boolean {
  const doc = openPdf(bytes)
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

/** Whether any object of the file still holds the text, streams unpacked. */
function anyObjectHolds(bytes: Uint8Array, text: string): boolean {
  const doc = openPdf(bytes)
  try {
    for (let n = 1; n < doc.countObjects(); n++) {
      let obj: mupdf.PDFObject | undefined
      try {
        obj = doc.newIndirect(n)
        if (obj.isStream()) {
          const buffer = obj.readStream()
          try {
            if (Buffer.from(buffer.asUint8Array()).includes(Buffer.from(text, 'latin1'))) return true
          } finally {
            free(buffer)
          }
        } else if (obj.resolve().toString().includes(text)) return true
      } catch {
        // An object that cannot be read holds nothing readable.
      } finally {
        free(obj)
      }
    }
    return false
  } finally {
    free(doc)
  }
}

/** Dark pixels of a page, rendered at 1:1. */
function ink(bytes: Uint8Array, pageIndex: number): number {
  const doc = openPdf(bytes)
  try {
    const page = doc.loadPage(pageIndex)
    const pm = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    try {
      return [...pm.getPixels()].filter((v) => v < 200).length
    } finally {
      free(pm, page)
    }
  } finally {
    free(doc)
  }
}

const MARK = { op: 'redactMark' as const, marks: [{ page: 0, box: [80, 80, 320, 320] as [number, number, number, number] }] }
const REPLY = 'A reply to the mark'

/** A blank page with one mark and a reply to that mark, as another program may leave it. */
async function markedWithAReply(): Promise<Uint8Array> {
  const src = build(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 400] >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', '<< /Length LEN >>'], {
    4: enc.encode('BT ET'),
  })
  const marked = (await applyOperation(src, MARK)).bytes
  const doc = openPdf(marked)
  try {
    const page = doc.loadPage(0) as mupdf.PDFPage
    try {
      const mark = page.getAnnotations().find((a) => a.getType() === 'Redact')!
      const reply = page.createAnnotation('Text')
      reply.setRect([360, 360, 380, 380])
      reply.setContents(REPLY)
      reply.update()
      reply.getObject().put('IRT', mark.getObject())
      return saveBytes(doc)
    } finally {
      free(page)
    }
  } finally {
    free(doc)
  }
}

/** The bytes as the app writes them to the person's file (the session's final save). */
function asWritten(bytes: Uint8Array): Uint8Array {
  const doc = openPdf(bytes)
  try {
    return saveBytes(doc, SAVE_FINAL)
  } finally {
    free(doc)
  }
}

describe('what redaction must keep and what it must take (§102)', () => {
  it('keeps a picture a form on another page draws through the shared resources', async () => {
    // 9 is one resource dictionary both pages and the form point to. Page 1 (redacted) draws the
    // picture; page 2 draws the form; the form draws the picture.
    const src = build(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 400 400] >>',
        '<< /Type /Page /Parent 2 0 R /Resources 9 0 R /Contents 7 0 R >>',
        '<< /Type /Page /Parent 2 0 R /Resources 9 0 R /Contents 8 0 R >>',
        '<< /Type /XObject /Subtype /Form /BBox [0 0 400 400] /Resources 9 0 R /Length LEN >>',
        IMAGE,
        '<< /Length LEN >>',
        '<< /Length LEN >>',
        '<< /XObject << /Im0 6 0 R /Fx 5 0 R >> >>',
      ],
      { 5: DRAW_IMAGE, 6: SAMPLES, 7: DRAW_IMAGE, 8: DRAW_FORM }
    )
    expect(ink(src, 1)).toBeGreaterThan(100)
    const marked = await applyOperation(src, MARK)
    const out = (await applyOperation(marked.bytes, { op: 'redactApply' })).bytes
    expect(pictureSurvives(out)).toBe(true)
    expect(ink(out, 1)).toBeGreaterThan(100)
  })

  it('takes a comment written straight into the page list off a mark', async () => {
    const src = build(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 400] >>',
        `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [<< /Type /Annot /Subtype /Text /Rect [100 100 120 120] /Contents (${SECRET}) >>] >>`,
        '<< /Length LEN >>',
      ],
      { 4: enc.encode('BT ET') }
    )
    expect(anyObjectHolds(src, SECRET)).toBe(true)
    const marked = await applyOperation(src, MARK)
    const done = await applyOperation(marked.bytes, { op: 'redactApply' })
    expect(anyObjectHolds(done.bytes, SECRET)).toBe(false)
  })

  it('takes a reply written straight into the page list with the comment it answers', async () => {
    // The comment (5) lies under the mark; the reply is an inline entry away from it.
    const src = build(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 400 400] >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Annots [5 0 R << /Type /Annot /Subtype /Text /Rect [360 360 380 380] /Contents (Reply) /IRT 5 0 R >>] >>',
        '<< /Length LEN >>',
        `<< /Type /Annot /Subtype /Text /Rect [100 100 120 120] /Contents (${SECRET}) >>`,
      ],
      { 4: enc.encode('BT ET') }
    )
    expect(anyObjectHolds(src, SECRET)).toBe(true)
    const marked = await applyOperation(src, MARK)
    const out = (await applyOperation(marked.bytes, { op: 'redactApply' })).bytes
    expect(anyObjectHolds(out, SECRET)).toBe(false)
    expect(anyObjectHolds(out, 'Reply')).toBe(false)
  })

  it('takes a reply to a mark with the mark when the marks are cleared', async () => {
    const src = await markedWithAReply()
    const cleared = (await applyOperation(src, { op: 'redactClear' })).bytes
    const doc = openPdf(cleared)
    try {
      expect(pageMarkups(doc, 0).map((m) => m.text)).toEqual([])
    } finally {
      free(doc)
    }
    expect(anyObjectHolds(asWritten(cleared), REPLY)).toBe(false)
  })

  it('takes a reply to a mark with the mark when one mark is un-marked', async () => {
    const src = await markedWithAReply()
    const out = (await applyOperation(src, { op: 'redactUnmark', page: 0, box: [80, 80, 320, 320] })).bytes
    const doc = openPdf(out)
    try {
      expect(pageMarkups(doc, 0).map((m) => m.text)).toEqual([])
    } finally {
      free(doc)
    }
    expect(anyObjectHolds(asWritten(out), REPLY)).toBe(false)
  })
})

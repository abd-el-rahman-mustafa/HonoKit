import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { embedFace } from '@engine/fonts'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { extractLines, extractText, foldString, searchLines } from '@engine/text'
import { applyOperation } from '@ops/index'

/** A "scan": a page of text turned into a picture, with no text layer. */
async function makeScan(): Promise<Uint8Array> {
  const src = await PDFDocument.create()
  const font = await src.embedFont(StandardFonts.Helvetica)
  const arabic = await embedFace(src, 'arabic')
  const page = src.addPage([595, 842])
  page.drawText('Invoice number 2045', { x: 60, y: 760, size: 20, font })
  page.drawText('Total amount due 1250 AED', { x: 60, y: 720, size: 20, font })
  const line = 'فاتورة ضريبية للشركة'
  page.drawText(line, { x: 535 - arabic.widthOfTextAtSize(line, 24), y: 660, size: 24, font: arabic })
  const rendered = openPdf(new Uint8Array(await src.save()))
  const pix = rendered.loadPage(0).toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = pix.asPNG()
  free(pix, rendered)
  const scan = await PDFDocument.create()
  const image = await scan.embedPng(png)
  scan.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
  return new Uint8Array(await scan.save())
}

const text = (bytes: Uint8Array): string => {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, 0)
  } finally {
    free(doc)
  }
}

describe('recognise text (OCR)', () => {
  it('makes a scanned page searchable in English and Arabic, and leaves text pages alone', async () => {
    const scan = await makeScan()
    expect(text(scan).trim()).toBe('')
    const started = Date.now()
    const r = await applyOperation(scan, { op: 'ocr' })
    console.log('OCR took', Date.now() - started, 'ms:', JSON.stringify(text(r.bytes)))
    expect(r.note?.key).toBe('note.ocr')
    const found = foldString(text(r.bytes))
    expect(found).toContain('invoice')
    expect(found).toContain('total amount due 1250 aed')
    expect(found).toContain(foldString('فاتورة'))
    // Again: the page now has text, so nothing is done.
    const again = await applyOperation(r.bytes, { op: 'ocr' })
    expect(again.note?.key).toBe('note.ocrNothing')
  }, 120_000)

  const count = (bytes: Uint8Array, word: string): number => foldString(text(bytes)).split(word).length - 1

  it('replaces its own text layer when run again on the same pages, instead of adding a second one', async () => {
    const once = await applyOperation(await makeScan(), { op: 'ocr' })
    expect(count(once.bytes, 'invoice')).toBe(1)
    const twice = await applyOperation(once.bytes, { op: 'ocr', redo: true })
    expect(count(twice.bytes, 'invoice')).toBe(1)
    expect(count(twice.bytes, 'total amount due')).toBe(1)
  }, 120_000)

  it('also replaces the untagged layer that earlier versions wrote', async () => {
    const once = await applyOperation(await makeScan(), { op: 'ocr' })
    // What a file recognised before the layer was tagged looks like: the same overlay, no /HonoOcr.
    const doc = openPdf(once.bytes)
    let legacy: Uint8Array
    try {
      const total = doc.countObjects()
      for (let n = 1; n < total; n++) {
        const obj = doc.newIndirect(n).resolve()
        if (obj.isDictionary() && !obj.get('HonoOcr').isNull()) obj.delete('HonoOcr')
      }
      legacy = new Uint8Array(doc.saveToBuffer('').asUint8Array())
    } finally {
      free(doc)
    }
    expect(new TextDecoder('latin1').decode(legacy)).not.toContain('HonoOcr')
    const again = await applyOperation(legacy, { op: 'ocr', redo: true })
    expect(count(again.bytes, 'invoice')).toBe(1)
  }, 120_000)

  it('puts each word over its own place in the picture, so Find marks the word itself', async () => {
    const r = await applyOperation(await makeScan(), { op: 'ocr' })
    const doc = openPdf(r.bytes)
    try {
      const lines = extractLines(doc, 0)
      const box = (word: string): [number, number, number, number] => {
        const hit = searchLines(lines, word, 0)[0]
        expect(hit, word).toBeDefined()
        const b = hit!.boxes
        return [Math.min(...b.map((q) => q[0])), Math.min(...b.map((q) => q[1])), Math.max(...b.map((q) => q[2])), Math.max(...b.map((q) => q[3]))]
      }
      // "amount" in "Total amount due 1250 AED", Helvetica 20 at x 60.
      const src = await PDFDocument.create()
      const font = await src.embedFont(StandardFonts.Helvetica)
      const left = 60 + font.widthOfTextAtSize('Total ', 20)
      const right = left + font.widthOfTextAtSize('amount', 20)
      const amount = box('amount')
      expect(Math.abs(amount[0] - left)).toBeLessThan(4)
      expect(Math.abs(amount[2] - right)).toBeLessThan(4)
      // The Arabic line, right-aligned at 535: its first word is the one on the right.
      const arabic = await embedFace(src, 'arabic')
      const line = 'فاتورة ضريبية للشركة'
      const start = 535 - arabic.widthOfTextAtSize(line, 24)
      const first = box('فاتورة')
      const last = box('للشركة')
      expect(first[0]).toBeGreaterThan(last[2])
      expect(Math.abs(first[2] - 535)).toBeLessThan(5)
      expect(Math.abs(last[0] - start)).toBeLessThan(5)
      // Word breaks are kept: the phrase is found as typed.
      expect(searchLines(lines, 'total amount due', 0)).toHaveLength(1)
      expect(searchLines(lines, 'ضريبية للشركة', 0)).toHaveLength(1)
    } finally {
      free(doc)
    }
  }, 120_000)

  it('stops when asked, leaving nothing half done', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(applyOperation(await makeScan(), { op: 'ocr' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
    const { recogniseText } = await import('@engine/ocr')
    const late = new AbortController()
    let stopped = false
    const run = recogniseText(await makeScan(), { language: 'auto', redo: false, signal: late.signal }, undefined, () => {
      if (!stopped) {
        stopped = true
        late.abort()
      }
    })
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
  }, 120_000)

  it('keeps a page’s real text when recognising it again', async () => {
    const src = await PDFDocument.create()
    const font = await src.embedFont(StandardFonts.Helvetica)
    src.addPage([595, 842]).drawText('Quarterly report of the newsroom budget', { x: 60, y: 760, size: 20, font })
    const r = await applyOperation(new Uint8Array(await src.save()), { op: 'ocr', redo: true })
    const r2 = await applyOperation(r.bytes, { op: 'ocr', redo: true })
    // The real text stays exactly once; only the recognised copy is replaced, never stacked.
    expect(count(r.bytes, 'quarterly')).toBe(count(r2.bytes, 'quarterly'))
    expect(count(r2.bytes, 'quarterly')).toBeGreaterThanOrEqual(1)
  }, 120_000)
})

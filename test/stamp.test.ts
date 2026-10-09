import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { free, mupdf, openPdf } from '@engine/mupdf'
import { renderPage } from '@engine/render'
import { extractLines, extractText, foldString } from '@engine/text'
import { applyOperation } from '@ops/index'
import { makeLatinPdf, makePng } from './fixtures'

/** Writes a picture of a page so a person can look at the result: smoke-out/ is git-ignored. */
function snapshot(name: string, bytes: Uint8Array, page = 0, scale = 1.2): void {
  mkdirSync('smoke-out', { recursive: true })
  const doc = openPdf(bytes)
  try {
    writeFileSync(`smoke-out/${name}.png`, renderPage(doc, page, { scale, format: 'png' }).data)
  } finally {
    free(doc)
  }
}

/** Dark pixels on the page: proof that something was actually drawn, which text extraction alone cannot give. */
function ink(bytes: Uint8Array, page = 0, region?: { y0: number; y1: number }): number {
  const doc = openPdf(bytes)
  try {
    const p = doc.loadPage(page)
    const pixmap = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    const px = pixmap.getPixels()
    const w = pixmap.getWidth()
    const h = pixmap.getHeight()
    let dark = 0
    for (let y = region?.y0 ?? 0; y < Math.min(h, region?.y1 ?? h); y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 3]! < 160) dark++
    return dark
  } finally {
    free(doc)
  }
}

function text(bytes: Uint8Array, page = 0): string {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, page)
  } finally {
    free(doc)
  }
}

describe('watermark', () => {
  it('stamps Latin text on every page', async () => {
    const src = await makeLatinPdf(3)
    const { bytes } = await applyOperation(src, { op: 'watermark', text: 'CONFIDENTIAL' })
    for (const p of [0, 1, 2]) expect(text(bytes, p)).toContain('CONFIDENTIAL')
    snapshot('watermark-latin', bytes)
  })

  it('stamps only the chosen pages', async () => {
    const src = await makeLatinPdf(3)
    const { bytes } = await applyOperation(src, { op: 'watermark', text: 'DRAFT', pages: [1] })
    expect(text(bytes, 0)).not.toContain('DRAFT')
    expect(text(bytes, 1)).toContain('DRAFT')
    expect(text(bytes, 2)).not.toContain('DRAFT')
  })

  it('stamps Arabic text so it can be read and searched back', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: 'سري للغاية', rotation: 0, size: 48 })
    expect(foldString(text(bytes))).toContain(foldString('سري للغاية'))
    snapshot('watermark-arabic', bytes)
  })

  it('draws a mixed Arabic and Latin line without reversing the Latin and the digits', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), {
      op: 'watermark',
      text: 'رقم الطلب 2024 ABC',
      rotation: 0,
      size: 30,
      position: 'top-center',
      colour: '#000000',
      opacity: 1
    })
    const doc = openPdf(bytes)
    try {
      const lines = extractLines(doc, 0).filter((l) => /ABC|CBA/.test(l.text))
      const all = lines.flatMap((l) => l.glyphs)
      const xOf = (ch: string): number => all.find((g) => g.c === ch)!.box[0]
      // Left to right on the page: digits keep their order, and so do the Latin letters.
      expect(xOf('2')).toBeLessThan(xOf('4'))
      expect(xOf('A')).toBeLessThan(xOf('B'))
      expect(xOf('B')).toBeLessThan(xOf('C'))
    } finally {
      free(doc)
    }
    snapshot('watermark-mixed', bytes)
  })

  it('keeps the stamp upright on a rotated page', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1, { rotate: 90 }), { op: 'watermark', text: 'UPRIGHT', rotation: 0, size: 40, position: 'top-center', colour: '#000000', opacity: 1 })
    const doc = openPdf(bytes)
    try {
      const line = extractLines(doc, 0).find((l) => l.text.includes('UPRIGHT'))!
      const [x0, y0, x1, y1] = line.box
      // Upright text on the displayed page is wider than it is tall.
      expect(x1 - x0).toBeGreaterThan(y1 - y0)
    } finally {
      free(doc)
    }
    snapshot('watermark-rotated-page', bytes)
  })

  it('places an image watermark', async () => {
    const dir = 'smoke-out'
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/wm.png`, makePng(120, 60))
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', imagePath: `${dir}/wm.png`, opacity: 0.5, imageScale: 0.4, rotation: 0 })
    snapshot('watermark-image', bytes)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('shrinks a watermark that would run off the page', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: 'CONFIDENTIAL — DO NOT DISTRIBUTE — 2026', size: 120, rotation: 45, colour: '#000000', opacity: 1 })
    const doc = openPdf(bytes)
    try {
      const glyphs = extractLines(doc, 0).flatMap((l) => l.glyphs).filter((g) => /[A-Z]/.test(g.c))
      expect(glyphs.length).toBeGreaterThan(20)
      for (const g of glyphs) {
        expect(g.box[0]).toBeGreaterThanOrEqual(0)
        expect(g.box[1]).toBeGreaterThanOrEqual(0)
        expect(g.box[2]).toBeLessThanOrEqual(400)
        expect(g.box[3]).toBeLessThanOrEqual(600)
      }
    } finally {
      free(doc)
    }
    snapshot('watermark-fitted', bytes)
  })

  it('needs text or an image', async () => {
    await expect(applyOperation(await makeLatinPdf(1), { op: 'watermark' })).rejects.toThrow(/text or an image/)
  })

  it('reports characters the fonts cannot draw instead of failing', async () => {
    const r = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: 'OK 你好' })
    expect(r.note?.key).toBe('note.droppedCharacters')
    expect(text(r.bytes)).toContain('OK')
  })
})

describe('stamped text is actually visible', () => {
  it('an Arabic watermark draws ink, not just text', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'watermark', text: 'سري للغاية', rotation: 0, size: 60, colour: '#000000', opacity: 1, position: 'center' })
    expect(ink(bytes) - ink(src)).toBeGreaterThan(1500)
  })

  it('bold Arabic draws ink too', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'watermark', text: 'مسودة', rotation: 0, size: 60, colour: '#000000', opacity: 1, bold: true })
    expect(ink(bytes) - ink(src)).toBeGreaterThan(1000)
  })

  it('an Arabic page-number footer draws ink in the footer band', async () => {
    const src = await makeLatinPdf(1)
    const { bytes } = await applyOperation(src, { op: 'pageNumbers', template: 'صفحة {n} من {N}', size: 16, colour: '#000000' })
    // Footer band of a 600-point page: the bottom 60 points.
    expect(ink(bytes, 0, { y0: 540, y1: 600 })).toBeGreaterThan(150)
    expect(ink(src, 0, { y0: 540, y1: 600 })).toBe(0)
  })
})

describe('page numbers', () => {
  it('numbers pages from a template, with the total', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(3), { op: 'pageNumbers', template: 'Page {n} of {N}' })
    expect(text(bytes, 0)).toContain('Page 1 of 3')
    expect(text(bytes, 2)).toContain('Page 3 of 3')
    snapshot('pagenumbers-latin', bytes)
  })

  it('starts at a chosen number', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(2), { op: 'pageNumbers', template: '- {n} -', startAt: 10 })
    expect(text(bytes, 0)).toContain('- 10 -')
    expect(text(bytes, 1)).toContain('- 11 -')
  })

  // Owner's decision N1 (2026-10-08), "as Acrobat does": a page range is numbered within itself.
  it('numbers a page range within the chosen pages, {N} being the last number shown', async () => {
    const src = await makeLatinPdf(10)
    const { bytes } = await applyOperation(src, { op: 'pageNumbers', template: 'No {n} of {N}', pages: [9, 2, 3, 4, 5, 6, 7, 8] })
    expect(text(bytes, 0)).not.toContain('No ')
    expect(text(bytes, 1)).not.toContain('No ')
    expect(text(bytes, 2)).toContain('No 1 of 8')
    expect(text(bytes, 3)).toContain('No 2 of 8')
    expect(text(bytes, 9)).toContain('No 8 of 8')
    const started = (await applyOperation(src, { op: 'pageNumbers', template: 'No {n} of {N}', pages: [4, 5], startAt: 20 })).bytes
    expect(text(started, 4)).toContain('No 20 of 21')
    expect(text(started, 5)).toContain('No 21 of 21')
    const hf = (await applyOperation(src, { op: 'headerFooter', slots: { bottomCenter: 'HF {n}/{N}' }, pages: [2, 3, 4, 5, 6, 7, 8, 9], colour: '#000000' })).bytes
    expect(text(hf, 2)).toContain('HF 1/8')
    expect(text(hf, 3)).toContain('HF 2/8')
    expect(text(hf, 9)).toContain('HF 8/8')
  })

  it('writes Arabic-Indic digits when asked', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(2), { op: 'pageNumbers', template: '{n}', digits: 'arabic-indic' })
    expect(text(bytes, 1)).toContain('٢')
  })

  it('keeps the digits of an Arabic footer in order', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(28), { op: 'pageNumbers', template: 'صفحة {n} من {N}', pages: [27], startAt: 28, colour: '#000000' })
    const doc = openPdf(bytes)
    try {
      // Only the footer band: the fixture's own "Page 28" text also has these digits.
      const glyphs = extractLines(doc, 27).flatMap((l) => l.glyphs).filter((g) => g.box[1] > 540)
      const twos = glyphs.filter((g) => g.c === '2' || g.c === '8')
      // "28" appears twice (page 28 of 28); within each number 2 sits left of 8.
      const sorted = [...twos].sort((a, b) => a.box[0] - b.box[0]).map((g) => g.c).join('')
      expect(sorted).toBe('2828')
    } finally {
      free(doc)
    }
    snapshot('pagenumbers-arabic', bytes, 27)
  })

  it('works on rotated pages and other corners', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1, { rotate: 270 }), { op: 'pageNumbers', position: 'top-right', template: '{n}/{N}', colour: '#000000' })
    expect(text(bytes)).toContain('1/1')
    snapshot('pagenumbers-rotated', bytes)
  })
})

describe('header and footer', () => {
  it('writes six boxes with tokens, header at the top and footer at the bottom', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(2), {
      op: 'headerFooter',
      slots: { topLeft: 'Annual report', topRight: '{date}', bottomCenter: 'Page {n} of {N}', bottomRight: '{file}' },
      date: '30 September 2026',
      file: 'report',
      colour: '#000000'
    })
    expect(text(bytes, 1)).toContain('Page 2 of 2')
    expect(text(bytes, 0)).toContain('Annual report')
    expect(text(bytes, 0)).toContain('30 September 2026')
    const doc = openPdf(bytes)
    try {
      const lines = extractLines(doc, 0)
      const header = lines.find((l) => l.text.includes('Annual report'))!
      const footer = lines.find((l) => l.text.includes('Page 1 of 2'))!
      const height = doc.loadPage(0).getBounds()[3]
      expect(header.box[1]).toBeLessThan(height * 0.1)
      expect(footer.box[3]).toBeGreaterThan(height * 0.9)
    } finally {
      free(doc)
    }
    snapshot('header-footer', bytes)
  })

  it('writes an Arabic header with Arabic-Indic numbers', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(3), { op: 'headerFooter', slots: { topRight: 'التقرير السنوي', bottomCenter: 'صفحة {n}' }, digits: 'arabic-indic', colour: '#000000' })
    expect(foldString(text(bytes, 2))).toContain(foldString('التقرير السنوي'))
    expect(text(bytes, 2)).toContain('٣')
  })

  it('refuses when every box is empty', async () => {
    await expect(applyOperation(await makeLatinPdf(1), { op: 'headerFooter', slots: { topLeft: '  ' } })).rejects.toThrow()
  })
})

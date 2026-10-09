import { mkdirSync, writeFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { fontBytes } from '@engine/fonts'
import { free, openPdf } from '@engine/mupdf'
import { paragraphs, styledLines } from '@engine/paragraphs'
import { renderPage } from '@engine/render'
import { extractLines, extractText, foldString } from '@engine/text'
import { applyOperation } from '@ops/index'

function snapshot(name: string, bytes: Uint8Array): void {
  mkdirSync('smoke-out', { recursive: true })
  const doc = openPdf(bytes)
  try {
    writeFileSync(`smoke-out/${name}.png`, renderPage(doc, 0, { scale: 1.3, format: 'png' }).data)
  } finally {
    free(doc)
  }
}
const lines = (bytes: Uint8Array) => {
  const doc = openPdf(bytes)
  try {
    return extractLines(doc, 0)
  } finally {
    free(doc)
  }
}
const paras = (bytes: Uint8Array) => {
  const doc = openPdf(bytes)
  try {
    return paragraphs(styledLines(doc, 0))
  } finally {
    free(doc)
  }
}

const LOREM =
  'PowerPDF edits whole paragraphs. The words are wrapped again inside the same column, at the same size and spacing, so a changed sentence reads as if it had always been there. This paragraph is long enough to take several lines.'

/** A page with a heading, a justified paragraph, a bullet with a hanging indent, and a table of contents. */
async function makeRichPage(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const times = await pdf.embedFont(StandardFonts.TimesRoman)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.addPage([595, 842])
  page.drawText('Heading On The Left', { x: 72, y: 780, size: 18, font: bold })
  // A justified paragraph: every line but the last spans the full column, 72..523.
  const width = 451
  const words = LOREM.split(' ')
  let line: string[] = []
  let y = 740
  const flush = (last: boolean): void => {
    if (last) {
      page.drawText(line.join(' '), { x: 72, y, size: 12, font: times })
    } else {
      const natural = line.reduce((n, w) => n + times.widthOfTextAtSize(w, 12), 0)
      const gap = (width - natural) / (line.length - 1)
      let x = 72
      for (const w of line) {
        page.drawText(w, { x, y, size: 12, font: times })
        x += times.widthOfTextAtSize(w, 12) + gap
      }
    }
    y -= 14.4
    line = []
  }
  for (const w of words) {
    if (line.length && times.widthOfTextAtSize([...line, w].join(' '), 12) > width) flush(false)
    line.push(w)
  }
  flush(true)
  // A bullet whose continuation lines hang at 90.
  page.drawText('•', { x: 72, y: 640, size: 12, font: times })
  page.drawText('A bullet point that is long enough to wrap onto a second line, which hangs', { x: 90, y: 640, size: 12, font: times })
  page.drawText('under the words and not under the bullet.', { x: 90, y: 625.6, size: 12, font: times })
  // A table of contents: dot leaders, page numbers on the right, starting at the left margin.
  const toc = [
    ['Academic Writing Sample Task – 1A', '3'],
    ['Academic Writing Sample Task – 1B', '4'],
    ['Academic Writing Sample Task – 1C', '5']
  ]
  toc.forEach(([title, n], i) => {
    const ty = 560 - i * 22
    const dots = '.'.repeat(Math.floor((440 - times.widthOfTextAtSize(title!, 12)) / times.widthOfTextAtSize('.', 12)))
    page.drawText(`${title}${dots}`, { x: 72, y: ty, size: 12, font: times })
    page.drawText(n!, { x: 523 - times.widthOfTextAtSize(n!, 12), y: ty, size: 12, font: times })
  })
  return new Uint8Array(await pdf.save())
}

describe('paragraphs', () => {
  it('finds the heading, the paragraph, the bullet and each contents entry separately', async () => {
    const found = paras(await makeRichPage())
    const kinds = found.map((p) => `${p.lines.length}:${p.text.slice(0, 12)}`)
    expect(kinds[0]).toMatch(/^1:Heading/)
    const body = found.find((p) => p.text.startsWith('PowerPDF edits'))!
    expect(body.lines.length).toBeGreaterThan(2)
    expect(body.alignment).toBe('justify')
    const bullet = found.find((p) => p.text.startsWith('•'))!
    expect(bullet.lines).toHaveLength(2)
    expect(bullet.restStart - bullet.firstStart).toBeGreaterThan(10)
    // Contents entries never merge into one paragraph.
    expect(found.filter((p) => p.text.startsWith('Academic Writing')).map((p) => p.lines.length)).toEqual([1, 1, 1])
  })
})

describe('editing a paragraph', () => {
  it('owner\'s report: a contents entry with fewer dots stays at the left margin, not the middle', async () => {
    const src = await makeRichPage()
    const entry = lines(src).find((l) => l.text.startsWith('Academic Writing Sample Task – 1A'))!
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: entry.box, text: 'Academic Writing Sample Task – 1A ........ 3' })
    const edited = lines(bytes).find((l) => l.text.includes('1A'))!
    expect(Math.abs(edited.box[0] - entry.box[0])).toBeLessThan(1.5)
    // The other entries are untouched.
    expect(lines(bytes).filter((l) => /1B|1C/.test(l.text))).toHaveLength(2)
    snapshot('para-toc', bytes)
  })

  it('rewraps an edited paragraph inside the same column, keeping it justified', async () => {
    const src = await makeRichPage()
    const body = paras(src).find((p) => p.text.startsWith('PowerPDF edits'))!
    const text = body.text.replace('edits whole paragraphs', 'now edits complete paragraphs of any length')
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: body.lines[0]!.box, text })
    const after = paras(bytes).find((p) => p.text.includes('now edits complete'))!
    expect(foldString(after.text)).toBe(foldString(text))
    for (const l of after.lines) {
      expect(l.box[0]).toBeGreaterThan(71)
      expect(l.box[2]).toBeLessThan(524.5)
    }
    // Every line but the last reaches the far edge: justified, like the original.
    for (const l of after.lines.slice(0, -1)) expect(l.box[2]).toBeGreaterThan(520)
    expect(after.style.size).toBeCloseTo(12, 0)
    expect(after.pitch).toBeCloseTo(14.4, 0)
    // The heading and the bullet did not move.
    expect(extractTextOf(bytes)).toContain('Heading On The Left')
    snapshot('para-justified', bytes)
  })

  it('keeps a bullet\'s hanging indent', async () => {
    const src = await makeRichPage()
    const bullet = paras(src).find((p) => p.text.startsWith('•'))!
    const { bytes } = await applyOperation(src, {
      op: 'replaceText',
      page: 0,
      box: bullet.lines[0]!.box,
      text: '• A rewritten bullet point, again long enough that it has to wrap onto another line under the words.'
    })
    const after = paras(bytes).find((p) => p.text.includes('rewritten bullet'))!
    expect(after.lines.length).toBeGreaterThanOrEqual(2)
    expect(after.firstStart).toBeCloseTo(72, 0)
    expect(after.restStart).toBeCloseTo(90, 0)
  })

  it('reports when the new text needs more lines than the old', async () => {
    const src = await makeRichPage()
    const bullet = paras(src).find((p) => p.text.startsWith('•'))!
    const long = `• ${LOREM} ${LOREM}`
    const r = await applyOperation(src, { op: 'replaceText', page: 0, box: bullet.lines[0]!.box, text: long })
    expect(r.note?.key).toBe('note.paragraphLonger')
  })

  it('rewraps an Arabic paragraph from the right', async () => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(fontBytes('arabic'), { subset: true })
    const page = pdf.addPage([500, 400])
    const arabicLines = ['هذه فقرة عربية طويلة بما يكفي لتمتد على أكثر من سطر واحد في الصفحة', 'وهذا هو السطر الثاني منها الذي يبدأ من اليمين']
    arabicLines.forEach((l, i) => page.drawText(l, { x: 460 - font.widthOfTextAtSize(l, 16), y: 340 - i * 22, size: 16, font }))
    const src = new Uint8Array(await pdf.save())
    const p = paras(src)[0]!
    expect(p.style.rtl).toBe(true)
    expect(p.lines).toHaveLength(2)
    const text = 'هذه فقرة معدّلة أطول من الأصل بكثير، تُلَفّ كلماتها من جديد داخل العمود نفسه وتبقى محاذاتها إلى اليمين كما كانت في الأصل تمامًا'
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: p.lines[0]!.box, text })
    const after = paras(bytes)[0]!
    expect(foldString(after.text.replace(/\s+/g, ''))).toBe(foldString(text.replace(/\s+/g, '')))
    for (const l of after.lines) expect(Math.abs(l.box[2] - 460)).toBeLessThan(2) // right edges line up
    snapshot('para-arabic', bytes)
  })
})

function extractTextOf(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, 0)
  } finally {
    free(doc)
  }
}

describe('the text box of an editor', () => {
  it('restyles a paragraph: size, bold, colour, family', async () => {
    const src = await makeRichPage()
    const body = paras(src).find((p) => p.text.startsWith('PowerPDF edits'))!
    const { bytes } = await applyOperation(src, {
      op: 'replaceText',
      page: 0,
      box: body.lines[0]!.box,
      text: 'A short restyled paragraph.',
      style: { size: 16, bold: true, colour: '#1f6f3f', kind: 'sans' }
    })
    const after = paras(bytes).find((p) => p.text.includes('restyled'))!
    expect(after.style).toMatchObject({ bold: true, kind: 'sans' })
    expect(after.style.size).toBeCloseTo(16, 0)
    expect(after.style.colour[1]).toBeGreaterThan(after.style.colour[0])
  })

  it('moves a paragraph by dragging (dx, dy) and keeps its shape', async () => {
    const src = await makeRichPage()
    const bullet = paras(src).find((p) => p.text.startsWith('•'))!
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: bullet.lines[0]!.box, text: bullet.text, dx: 40, dy: 100 })
    const after = paras(bytes).find((p) => p.text.includes('bullet point'))!
    expect(after.firstStart).toBeCloseTo(bullet.firstStart + 40, 0)
    expect(after.restStart).toBeCloseTo(bullet.restStart + 40, 0)
    expect(after.lines[0]!.baseline).toBeCloseTo(bullet.lines[0]!.baseline + 100, 0)
  })

  it('narrows the column and the text re-wraps into more lines', async () => {
    const src = await makeRichPage()
    const body = paras(src).find((p) => p.text.startsWith('PowerPDF edits'))!
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: body.lines[0]!.box, text: body.text, width: 220 })
    // Still one paragraph: words stretched too far apart would read as separate words.
    const after = paras(bytes).find((p) => p.text.startsWith('PowerPDF edits'))!
    expect(after.lines.length).toBeGreaterThan(body.lines.length)
    for (const l of after.lines) expect(l.box[2]).toBeLessThan(72 + 222)
  })

  it('text added earlier can be edited again, like any other text (owner\'s report)', async () => {
    let { bytes } = await applyOperation(await makeRichPage(), { op: 'addText', page: 0, x: 300, y: 820, text: 'Male', size: 12 })
    const added = paras(bytes).find((p) => p.text === 'Male')!
    expect(added).toBeDefined()
    ;({ bytes } = await applyOperation(bytes, { op: 'replaceText', page: 0, box: added.lines[0]!.box, text: 'Female' }))
    const texts = paras(bytes).map((p) => p.text)
    expect(texts).toContain('Female')
    expect(texts).not.toContain('Male')
  })
})

describe('direction and drawn boxes', () => {
  it('switches a paragraph to right-to-left by hand: it is anchored at the right edge', async () => {
    const src = await makeRichPage()
    const bullet = paras(src).find((p) => p.text.startsWith('•'))!
    const { bytes } = await applyOperation(src, { op: 'replaceText', page: 0, box: bullet.lines[0]!.box, text: 'Order 123 — الطلب', style: { direction: 'rtl' } })
    const after = paras(bytes).find((p) => p.text.includes('Order'))!
    // Right-aligned to the old block's right edge.
    expect(Math.abs(after.box[2] - bullet.box[2])).toBeLessThan(2)
  })

  it('wraps a drawn text box inside its width', async () => {
    const src = await makeRichPage()
    const { bytes } = await applyOperation(src, { op: 'addText', page: 0, x: 72, y: 450, text: `${LOREM}`, size: 11, width: 200 })
    // The empty lower half of the page, below the contents entries.
    const lines = lines_(bytes).filter((l) => l.box[1] > 430)
    expect(lines.length).toBeGreaterThan(4)
    for (const l of lines) expect(l.box[2]).toBeLessThan(72 + 202)
  })

  it('a drawn right-to-left box ends at its right edge', async () => {
    const src = await makeRichPage()
    const { bytes } = await applyOperation(src, { op: 'addText', page: 0, x: 500, y: 450, text: 'نص عربي في مربع مرسوم يلتف داخل عرضه المحدد تمامًا كما في الفقرات', size: 12, width: 150, direction: 'rtl' })
    const lines = lines_(bytes).filter((l) => l.box[1] > 430)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) {
      expect(l.box[2]).toBeLessThanOrEqual(501)
      expect(l.box[0]).toBeGreaterThan(500 - 152)
    }
  })
})

const lines_ = lines

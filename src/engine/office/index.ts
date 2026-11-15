import { PdfError } from '../errors'
import { free, mupdf, openPdf } from '../mupdf'
import { buildModel, type BuildOptions } from './build'
import { writeDeck } from './deck'
import { writeDocx } from './docx'
import type { StyleRun } from '../paragraphs'
import { learnFallbacks } from './fonts'
import type { DocModel } from './model'
import { writeMarkdown, writePlainText } from './plain'
import { writePptx } from './pptx'
import { writeXlsx, type XlsxMode } from './xlsx'

/**
 * PDF → Word, PowerPoint, Markdown and text (docs/decisions.md §49,
 * docs/research-pdf-to-office.md). An editable approximation, said so in the interface:
 * a PDF records where letters are drawn, not paragraphs or tables, so these are rebuilt.
 */

export type OfficeFormat = 'docx' | 'pptx' | 'xlsx' | 'md' | 'txt'

export interface ExportOptions extends BuildOptions {
  format: OfficeFormat
  /** Word: start every PDF page on a new page (flowing text). */
  pageBreaks: boolean
  /**
   * Word: keep the look of each page (default) or flowing text (docx.ts). PowerPoint: keep the look
   * (a slide like each page, pptx.ts) or 'deck', a presentation made from the stories (deck.ts).
   */
  layout?: 'exact' | 'flow' | 'deck'
  /** PowerPoint 'deck': every word on the slides (default), or each story's opening paragraph with the rest in the notes. */
  slideText?: 'all' | 'opening'
  /** Markdown: the folder name (beside the file) for its pictures. */
  pictureFolder: string
  /** Excel: a sheet per page, or a sheet per ruled table. */
  sheets?: XlsxMode
}

export interface ExportResult {
  bytes: Uint8Array
  /** Files that go beside the main file (Markdown's pictures), by name inside `pictureFolder`. */
  extra: Array<{ name: string; bytes: Uint8Array }>
  pages: number
  paragraphs: number
  tables: number
  pictures: number
}

export function modelOf(bytes: Uint8Array, options: BuildOptions, password?: string): DocModel {
  const doc = openPdf(bytes, password)
  try {
    return buildModel(doc, options)
  } finally {
    free(doc)
  }
}

/** Lines as printed, for choosing stand-in fonts by width: a justified paragraph's last line only (the others are stretched). */
function fontSamples(model: DocModel): Array<{ runs: StyleRun[]; width: number }> {
  const paragraphs = model.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === 'paragraph' ? [b] : b.kind === 'table' ? b.rows.flat().flatMap((c) => c.paragraphs) : [])))
  return paragraphs.flatMap((b) => (b.alignment === 'justify' ? b.lines.slice(-1) : b.lines).map((l) => ({ runs: l.runs, width: l.box[2] - l.box[0] })))
}

/** A page as a picture (the deck's contents slide): JPEG, about 1400 pixels on its long side. */
function coverOf(bytes: Uint8Array, index: number, password?: string): { data: Uint8Array; width: number; height: number } | null {
  const doc = openPdf(bytes, password)
  let page: ReturnType<typeof doc.loadPage> | null = null
  let pixmap: mupdf.Pixmap | null = null
  try {
    if (index < 0 || index >= doc.countPages()) return null
    page = doc.loadPage(index)
    const b = page.getBounds()
    const width = b[2] - b[0]
    const height = b[3] - b[1]
    const k = Math.min(3, 1400 / Math.max(1, width, height))
    pixmap = page.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true)
    return { data: new Uint8Array(pixmap.asJPEG(85)), width, height }
  } catch {
    return null
  } finally {
    free(pixmap, page, doc)
  }
}

export async function exportOffice(bytes: Uint8Array, options: ExportOptions, password?: string): Promise<ExportResult> {
  const layout = options.layout ?? 'exact'
  const deck = options.format === 'pptx' && layout === 'deck'
  // Writers that place things where they were take the page's drawings (art); flowing ones its charts as pictures.
  const art = (options.format === 'pptx' && !deck) || (options.format === 'docx' && layout === 'exact')
  // Slides are not justified: the tatweel that stretched Arabic words to justify the PDF's lines goes.
  const removeTatweel = options.removeTatweel || deck
  const model = modelOf(bytes, { ...options, removeTatweel, art, figures: !art && (options.format === 'docx' || options.format === 'md' || deck) }, password)
  if (options.format === 'xlsx') {
    const doc = openPdf(bytes, password)
    try {
      const pages = options.pages ?? Array.from({ length: doc.countPages() }, (_, i) => i)
      const tables = model.pages.flatMap((p) => p.blocks).filter((b) => b.kind === 'table').length
      if ((options.sheets ?? 'page') === 'tables' && tables === 0) throw new PdfError('unsupported', 'No ruled tables were found. Choose "A sheet for each page" instead.')
      return { bytes: await writeXlsx(doc, model, pages, options.sheets ?? 'page'), extra: [], pages: model.pages.length, paragraphs: 0, tables, pictures: 0 }
    } finally {
      free(doc)
    }
  }
  const blocks = model.pages.flatMap((p) => p.blocks)
  const stats = {
    pages: model.pages.length,
    paragraphs: blocks.filter((b) => b.kind === 'paragraph').length,
    tables: blocks.filter((b) => b.kind === 'table').length,
    // Table cells hold pictures too: their lines the file maps to nothing (§68); and positioned writers' drawings.
    pictures:
      blocks.reduce((n, b) => n + (b.kind === 'picture' ? 1 : b.kind === 'table' ? b.rows.flat().reduce((m, c) => m + c.pictures.length, 0) : 0), 0) +
      model.pages.reduce((n, p) => n + p.drawn.filter((d) => d.kind === 'picture').length, 0)
  }
  const shapes = model.pages.reduce((n, p) => n + p.drawn.length, 0)
  if (stats.paragraphs + stats.tables + stats.pictures + shapes === 0) {
    throw new PdfError('unsupported', 'No text or pictures were found. A scanned PDF needs text recognition (OCR) first.')
  }
  if (options.format === 'docx' || (options.format === 'pptx' && !deck)) learnFallbacks(fontSamples(model))
  switch (options.format) {
    case 'docx':
      return { bytes: await writeDocx(model, { layout: layout === 'flow' ? 'flow' : 'exact', pageBreaks: options.pageBreaks }), extra: [], ...stats }
    case 'pptx': {
      if (!deck) return { bytes: await writePptx(model), extra: [], ...stats }
      const made = await writeDeck(model, { text: options.slideText ?? 'all', cover: coverOf(bytes, options.pages?.[0] ?? 0, password) })
      if (made.stories === 0) throw new PdfError('unsupported', 'No text or pictures to make slides from were found. Choose "Keep the look" instead.')
      return { bytes: made.bytes, extra: [], ...stats }
    }
    case 'md': {
      const rtl = model.pages.some((p) => p.blocks.some((b) => b.kind === 'paragraph' && b.rtl))
      const md = writeMarkdown(model, options.pictureFolder, rtl)
      return { bytes: new TextEncoder().encode(md.text), extra: md.pictures, ...stats }
    }
    case 'txt':
      return { bytes: new TextEncoder().encode(writePlainText(model)), extra: [], ...stats }
  }
}

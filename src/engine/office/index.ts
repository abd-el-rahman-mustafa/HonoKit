import { PdfError } from '../errors'
import { free, openPdf } from '../mupdf'
import { buildModel, type BuildOptions } from './build'
import { writeDocx } from './docx'
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
  /** Word: start every PDF page on a new page. */
  pageBreaks: boolean
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

export async function exportOffice(bytes: Uint8Array, options: ExportOptions, password?: string): Promise<ExportResult> {
  const model = modelOf(bytes, options, password)
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
    // Table cells hold pictures too: their lines the file maps to nothing (§68).
    pictures: blocks.reduce((n, b) => n + (b.kind === 'picture' ? 1 : b.kind === 'table' ? b.rows.flat().reduce((m, c) => m + c.pictures.length, 0) : 0), 0)
  }
  if (stats.paragraphs + stats.tables + stats.pictures === 0) {
    throw new PdfError('unsupported', 'No text or pictures were found. A scanned PDF needs text recognition (OCR) first.')
  }
  switch (options.format) {
    case 'docx':
      return { bytes: await writeDocx(model, { pageBreaks: options.pageBreaks }), extra: [], ...stats }
    case 'pptx':
      return { bytes: await writePptx(model), extra: [], ...stats }
    case 'md': {
      const rtl = model.pages.some((p) => p.blocks.some((b) => b.kind === 'paragraph' && b.rtl))
      const md = writeMarkdown(model, options.pictureFolder, rtl)
      return { bytes: new TextEncoder().encode(md.text), extra: md.pictures, ...stats }
    }
    case 'txt':
      return { bytes: new TextEncoder().encode(writePlainText(model)), extra: [], ...stats }
  }
}

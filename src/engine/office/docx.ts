import { AlignmentType, Document, Footer, Header, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type IRunOptions, type ParagraphChild } from 'docx'
import { BRAND } from '@shared/brand'
import type { StyleRun } from '../paragraphs'
import type { Block, DocModel, ParagraphBlock, PictureBlock, TableBlock } from './model'
import { fontsFor } from './fonts'

/**
 * The model as a Word document, "flowing text" (Acrobat's Retain Flowing Text): real
 * paragraphs that re-flow, with runs, headings, lists, tables and pictures in reading order,
 * the running header and footer as Word's own, and the first page's size and margins.
 * Arabic as Word needs it (research §4.1): w:bidi on the paragraph, w:rtl on its Arabic runs,
 * complex-script size and weight, an Arabic font in w:cs, and ar-AE as the bidi language.
 */

export interface DocxOptions {
  /** Start each PDF page on a new Word page (Acrobat and Word's reflow do not). */
  pageBreaks: boolean
}

const twips = (pt: number): number => Math.round(pt * 20)
const hex = (c: [number, number, number]): string => c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
const hasArabic = (s: string): boolean => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s)

function run(r: StyleRun, extra: Partial<IRunOptions> = {}): TextRun {
  const half = Math.round(r.size * 2)
  const fonts = fontsFor(r)
  return new TextRun({
    text: r.text,
    bold: r.bold,
    boldComplexScript: r.bold,
    italics: r.italic,
    italicsComplexScript: r.italic,
    size: half,
    sizeComplexScript: half,
    color: hex(r.colour),
    font: { ascii: fonts.latin, hAnsi: fonts.latin, cs: fonts.arabic, eastAsia: fonts.latin },
    rightToLeft: hasArabic(r.text),
    language: { value: 'en-US', bidirectional: 'ar-AE' },
    ...extra
  })
}

const ALIGN = { start: AlignmentType.START, end: AlignmentType.END, centre: AlignmentType.CENTER, justify: AlignmentType.BOTH } as const
const HEADINGS = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const

function paragraph(b: ParagraphBlock, pageBreakBefore = false): Paragraph {
  const runs = b.runs.map((r, i) => run(i === 0 && b.list === 'number' ? { ...r, text: `${b.marker} ${r.text}` } : r))
  const indent = b.list ? { start: twips(18), hanging: twips(18) } : b.firstIndent > 0 ? { firstLine: twips(b.firstIndent) } : b.firstIndent < 0 ? { hanging: twips(-b.firstIndent) } : undefined
  return new Paragraph({
    children: runs,
    bidirectional: b.rtl,
    alignment: ALIGN[b.alignment],
    ...(b.heading ? { heading: HEADINGS[b.heading] } : {}),
    ...(b.list === 'bullet' ? { bullet: { level: 0 } } : {}),
    ...(indent && b.list !== 'bullet' ? { indent } : {}),
    spacing: { after: twips(b.heading ? 6 : 4), ...(b.lineHeight > 1.35 ? { line: Math.round((b.lineHeight / 1.2) * 240) } : {}) },
    pageBreakBefore
  })
}

/** `pageWidth` 0: in a table cell, where it starts at the cell's reading edge (the right one when `rtl`). */
function picture(b: PictureBlock, contentWidth: number, pageWidth: number, pageBreakBefore = false, rtl = false): Paragraph {
  let w = b.box[2] - b.box[0]
  let h = b.box[3] - b.box[1]
  if (w > contentWidth) {
    h *= contentWidth / w
    w = contentWidth
  }
  const middle = (b.box[0] + b.box[2]) / 2
  const centred = pageWidth > 0 && Math.abs(middle - pageWidth / 2) < pageWidth * 0.08
  return new Paragraph({
    alignment: centred ? AlignmentType.CENTER : AlignmentType.START,
    bidirectional: rtl,
    children: [new ImageRun({ type: 'png', data: b.png, transformation: { width: Math.round((w * 96) / 72), height: Math.round((h * 96) / 72) } })],
    pageBreakBefore
  })
}

/** Word's default cell margins, left and right together (5.4 pt each). */
const CELL_MARGINS = 10.8

function table(b: TableBlock): Table {
  return new Table({
    columnWidths: b.columns.map(twips),
    width: { size: twips(b.columns.reduce((s, c) => s + c, 0)), type: WidthType.DXA },
    visuallyRightToLeft: b.rtl,
    rows: b.rows.map((row) => {
      let column = 0
      return new TableRow({
        children: row.map((cell) => {
          const width = b.columns.slice(column, column + cell.span).reduce((s, c) => s + c, 0)
          column += cell.span
          // Text and pictures of lines the file maps to nothing (§68), top to bottom.
          const items = [...cell.paragraphs, ...cell.pictures].sort((x, y) => x.box[1] - y.box[1])
          const children = items.map((i) => (i.kind === 'paragraph' ? paragraph({ ...i, heading: 0 }) : picture(i, Math.max(8, width - CELL_MARGINS), 0, false, b.rtl)))
          return new TableCell({
            children: children.length ? children : [new Paragraph({ bidirectional: b.rtl })],
            ...(cell.span > 1 ? { columnSpan: cell.span } : {})
          })
        })
      })
    })
  })
}

/** A running header or footer, with Word's page number where the page's number was. */
function running(text: string): Paragraph {
  const parts = text.split('{page}')
  const children: ParagraphChild[] = []
  parts.forEach((part, i) => {
    if (part) children.push(new TextRun({ text: part, size: 18, sizeComplexScript: 18, rightToLeft: hasArabic(part) }))
    if (i < parts.length - 1) children.push(new TextRun({ children: [PageNumber.CURRENT], size: 18, sizeComplexScript: 18 }))
  })
  return new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: hasArabic(text), children })
}

export async function writeDocx(model: DocModel, options: DocxOptions): Promise<Uint8Array> {
  const first = model.pages[0] ?? { width: 595, height: 842, blocks: [], rtl: false }
  // Margins from where the text actually is (within reason).
  const boxes = model.pages.flatMap((p) => p.blocks.map((b) => ({ b: b.box, w: p.width })))
  const left = Math.min(108, Math.max(36, Math.min(...boxes.map((x) => x.b[0]), 72)))
  const right = Math.min(108, Math.max(36, Math.min(...boxes.map((x) => x.w - x.b[2]), 72)))
  const contentWidth = first.width - left - right
  const children: Array<Paragraph | Table> = []
  model.pages.forEach((page, pi) => {
    page.blocks.forEach((b: Block, bi) => {
      const breakHere = options.pageBreaks && pi > 0 && bi === 0
      if (b.kind === 'paragraph') children.push(paragraph(b, breakHere))
      else if (b.kind === 'picture') children.push(picture(b, contentWidth, page.width, breakHere))
      else {
        if (breakHere) children.push(new Paragraph({ pageBreakBefore: true }))
        children.push(table(b))
        // Word joins two tables that touch; a paragraph keeps them apart.
        children.push(new Paragraph({ bidirectional: b.rtl }))
      }
    })
  })
  if (children.length === 0) children.push(new Paragraph({}))
  const doc = new Document({
    creator: BRAND.name,
    sections: [
      {
        properties: {
          page: {
            size: { width: twips(first.width), height: twips(first.height) },
            margin: { left: twips(left), right: twips(right), top: twips(54), bottom: twips(54) }
          },
          ...(first.rtl ? { bidi: true } : {})
        },
        ...(model.header ? { headers: { default: new Header({ children: [running(model.header)] }) } } : {}),
        ...(model.footer ? { footers: { default: new Footer({ children: [running(model.footer)] }) } } : {}),
        children
      }
    ]
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}

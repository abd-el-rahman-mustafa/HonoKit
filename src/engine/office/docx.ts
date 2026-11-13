import {
  AlignmentType,
  Document,
  Footer,
  FrameAnchorType,
  FrameWrap,
  Header,
  HeadingLevel,
  HeightRule,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  WidthType,
  type IRunOptions,
  type ISectionOptions,
  type ParagraphChild
} from 'docx'
import { BRAND } from '@shared/brand'
import type { StyleRun } from '../paragraphs'
import type { Block, DocModel, LineBlock, PageModel, ParagraphBlock, PictureBlock, TableBlock } from './model'
import { directedRuns, type DirectedRun } from './bidiruns'
import { fontsFor } from './fonts'
import { officeWidth, spacingToFit } from './measure'

/**
 * The model as a Word document, two ways (Acrobat's two):
 *
 * - **Keep the look** (`layout: 'exact'`, the default): every PDF page is a Word page of its size;
 *   its drawings without text lie behind (art.ts), pictures float where they were, and the text is
 *   in frames at its place that keep the PDF's lines, the letter spacing set so each line is as
 *   wide as printed (measure.ts). Edits stay inside their frame.
 * - **Flowing text** (`layout: 'flow'`, Retain Flowing Text): real paragraphs that re-flow, with
 *   runs, headings, lists, tables and pictures (charts and logos among them) in reading order, the
 *   running header and footer as Word's own, and the first page's size and margins.
 *
 * Arabic as Word needs it (research §4.1): w:bidi on the paragraph, w:rtl on its Arabic runs,
 * complex-script size and weight, an Arabic font in w:cs and a Latin one for digits and Latin
 * words, and ar-AE as the bidi language.
 */

export interface DocxOptions {
  layout: 'exact' | 'flow'
  /** Flowing text: start each PDF page on a new Word page (Acrobat and Word's reflow do not). */
  pageBreaks: boolean
}

const twips = (pt: number): number => Math.round(pt * 20)
const EMU = 12700
const pixels = (pt: number): number => Math.max(1, Math.round((pt * 96) / 72))
const hex = (c: [number, number, number]): string => c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
const hasArabic = (s: string): boolean => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s)

function run(r: StyleRun | DirectedRun, extra: Partial<IRunOptions> = {}): TextRun {
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
    rightToLeft: 'rtl' in r ? r.rtl : hasArabic(r.text),
    language: { value: 'en-US', bidirectional: 'ar-AE' },
    ...(r.tracking ? { characterSpacing: twips(r.tracking) } : {}),
    ...extra
  })
}

const ALIGN = { start: AlignmentType.START, end: AlignmentType.END, centre: AlignmentType.CENTER, justify: AlignmentType.BOTH } as const
const HEADINGS = [undefined, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const

function paragraph(b: ParagraphBlock, pageBreakBefore = false): Paragraph {
  const runs = directedRuns(b.runs.map((r, i) => (i === 0 && b.list === 'number' ? { ...r, text: `${b.marker} ${r.text}` } : r)), b.rtl).map((r) => run(r))
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
    children: [new ImageRun({ type: b.type, data: b.data, transformation: { width: pixels(w), height: pixels(h) } })],
    pageBreakBefore
  })
}

/** The most columns a Word table may have. */
const WORD_COLUMNS = 63

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

function flowing(model: DocModel, options: DocxOptions): ISectionOptions[] {
  const first = model.pages[0] ?? { width: 595, height: 842, blocks: [], rtl: false, background: null }
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
      else if (b.columns.length > WORD_COLUMNS) {
        // Word opens no table wider than this: the cells' text and pictures follow row by row.
        if (breakHere) children.push(new Paragraph({ pageBreakBefore: true }))
        for (const row of b.rows)
          for (const cell of row)
            for (const i of [...cell.paragraphs, ...cell.pictures].sort((x, y) => x.box[1] - y.box[1])) children.push(i.kind === 'paragraph' ? paragraph({ ...i, heading: 0 }) : picture(i, contentWidth, 0, false, b.rtl))
      } else {
        if (breakHere) children.push(new Paragraph({ pageBreakBefore: true }))
        children.push(table(b))
        // Word joins two tables that touch; a paragraph keeps them apart.
        children.push(new Paragraph({ bidirectional: b.rtl }))
      }
    })
  })
  if (children.length === 0) children.push(new Paragraph({}))
  return [
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
}

/** A picture floating at its place on the page; `layer` orders them (the background lowest). */
function floating(b: PictureBlock, layer: number): ImageRun {
  return new ImageRun({
    type: b.type,
    data: b.data,
    transformation: { width: pixels(b.box[2] - b.box[0]), height: pixels(b.box[3] - b.box[1]) },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(b.box[0] * EMU) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(b.box[1] * EMU) },
      behindDocument: true,
      allowOverlap: true,
      lockAnchor: true,
      layoutInCell: true,
      // Word's own range: with small values (1, 2) Word drew the page's background over a picture.
      zIndex: 251658240 + layer * 1024,
      wrap: { type: TextWrappingType.NONE }
    }
  })
}

/** Lines of one paragraph that share a start edge share a frame (as pptx.ts segments). */
function segments(b: ParagraphBlock): LineBlock[][] {
  const lines = b.lines.filter((l) => l.runs.length > 0)
  if (b.alignment === 'centre' || b.alignment === 'end') return lines.length ? [lines] : []
  const startOf = (l: LineBlock): number => (b.rtl ? l.box[2] : l.box[0])
  const out: LineBlock[][] = []
  for (const line of lines) {
    const last = out[out.length - 1]
    if (last && Math.abs(startOf(last[last.length - 1]!) - startOf(line)) < Math.max(2, line.runs[0]?.size ?? 10) * 0.3) last.push(line)
    else out.push([line])
  }
  return out
}

/** A part of a paragraph in a frame at its place, its lines as printed. */
function framed(b: ParagraphBlock, seg: LineBlock[]): Paragraph {
  const x0 = Math.min(...seg.map((l) => l.box[0]))
  const x1 = Math.max(...seg.map((l) => l.box[2]))
  const size = Math.max(...seg.flatMap((l) => l.runs.map((r) => r.size)))
  const pitch = seg.length > 1 ? (seg[seg.length - 1]!.baseline - seg[0]!.baseline) / (seg.length - 1) : size * 1.2
  const line = Math.max(pitch, size * 0.9)
  // Word puts a line's baseline above the bottom of its exact height by about the font's descent.
  const top = seg[0]!.baseline - line + size * 0.22
  const align = b.alignment === 'centre' ? 'centre' : (b.alignment === 'end') !== b.rtl ? 'right' : 'left'
  // A frame wraps what does not fit. Room a little wider than printed; much wider where Office's
  // width is not known (Arabic, fonts without metrics here), unless lines are justified to the frame.
  const unknown = seg.some((l) => officeWidth(l.runs) === null)
  const stretched = b.alignment === 'justify' && seg.length > 1
  const w = unknown && !stretched ? (x1 - x0) * 1.15 + size : (x1 - x0) * 1.02 + size * 0.3
  const left = align === 'right' ? x1 - w : align === 'centre' ? (x0 + x1) / 2 - w / 2 : x0
  const children: ParagraphChild[] = []
  seg.forEach((l, i) => {
    const spacing = spacingToFit(l.runs, l.box[2] - l.box[0])
    directedRuns(l.runs, b.rtl).forEach((r, k) => children.push(run({ ...r, tracking: 0 }, { ...(Math.abs(spacing) > 0.01 ? { characterSpacing: twips(spacing) } : {}), ...(i > 0 && k === 0 ? { break: 1 } : {}) })))
  })
  return new Paragraph({
    children,
    bidirectional: b.rtl,
    alignment: b.alignment === 'centre' ? AlignmentType.CENTER : b.alignment === 'end' ? AlignmentType.END : b.alignment === 'justify' && seg.length > 1 ? AlignmentType.BOTH : AlignmentType.START,
    spacing: { before: 0, after: 0, line: twips(line), lineRule: LineRuleType.EXACT },
    frame: {
      type: 'absolute',
      position: { x: twips(Math.max(0, left)), y: twips(Math.max(0, top)) },
      width: twips(w),
      height: twips(line * seg.length),
      anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      wrap: FrameWrap.NONE,
      rule: HeightRule.ATLEAST
    }
  })
}

function exactPage(page: PageModel): ISectionOptions {
  const pictures: PictureBlock[] = []
  const texts: ParagraphBlock[] = []
  for (const b of page.blocks) {
    if (b.kind === 'picture') pictures.push(b)
    else if (b.kind === 'paragraph') texts.push(b)
    else
      for (const cell of b.rows.flat()) {
        pictures.push(...cell.pictures)
        texts.push(...cell.paragraphs)
      }
  }
  const art = [...(page.background ? [floating(page.background, 1)] : []), ...pictures.map((p, i) => floating(p, 2 + i))]
  const children: Paragraph[] = [new Paragraph({ children: art, spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT } })]
  for (const b of texts) {
    // A bullet in its own frame at its place: its text then starts where it did, not a space after it.
    for (const l of b.lines)
      if (l.marker?.runs.length) {
        const line: LineBlock = { runs: l.marker.runs, box: l.marker.box, baseline: l.baseline }
        children.push(framed({ ...b, alignment: 'start', lines: [line] }, [line]))
      }
    for (const seg of segments(b)) children.push(framed(b, seg))
  }
  return {
    properties: {
      page: {
        size: { width: twips(page.width), height: twips(page.height) },
        margin: { left: 0, right: 0, top: 0, bottom: 0, header: 0, footer: 0, gutter: 0 }
      },
      ...(page.rtl ? { bidi: true } : {})
    },
    children
  }
}

export async function writeDocx(model: DocModel, options: DocxOptions): Promise<Uint8Array> {
  const sections = options.layout === 'exact' ? model.pages.map(exactPage) : flowing(model, options)
  const doc = new Document({ creator: BRAND.name, sections: sections.length ? sections : [{ children: [new Paragraph({})] }] })
  return new Uint8Array(await Packer.toBuffer(doc))
}

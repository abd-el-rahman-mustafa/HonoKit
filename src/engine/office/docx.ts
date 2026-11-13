import JSZip from 'jszip'
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  FrameAnchorType,
  FrameWrap,
  Header,
  HeadingLevel,
  HeightRule,
  ImageRun,
  LineRuleType,
  OverlapType,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableAnchorType,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
  type IParagraphOptions,
  type IRunOptions,
  type ISectionOptions,
  type ParagraphChild
} from 'docx'
import { BRAND } from '@shared/brand'
import type { StyleRun } from '../paragraphs'
import type { Block, Box, DocModel, PageModel, ParagraphBlock, PictureBlock, ShapeBlock, TableBlock, TableCell as CellBlock } from './model'
import type { Rule } from './scene'
import { directedRuns, type DirectedRun } from './bidiruns'
import { EMU, hex, shapeParts, svgExtension } from './drawingml'
import { joinedRuns, textBoxes, type TextBox } from './fit'
import { fontsFor } from './fonts'

/**
 * The model as a Word document, two ways (Acrobat's two):
 *
 * - **Keep the look** (`layout: 'exact'`, the default; decisions §118): every PDF page is a Word
 *   page of its size; its drawings are Word shapes and pictures behind the text in the PDF's paint
 *   order (a logo or chart that is plain vectors as SVG with a PNG beside it), its ruled tables are
 *   floating Word tables with their rules and fills, and each paragraph is in a frame at its place
 *   whose width makes Word break its lines where the PDF did (fit.ts) and re-flow when edited.
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
const pixels = (pt: number): number => Math.max(1, Math.round((pt * 96) / 72))
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
  const first = model.pages[0] ?? { width: 595, height: 842, blocks: [], rtl: false, drawn: [] }
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

/**
 * Drawings Word gets as raw DrawingML (decisions §118): the docx library has no shapes with custom
 * geometry and no SVG with a PNG beside it, so each is a marker run while the document is built and
 * its XML replaces the marker after packing, with its pictures in word/media.
 */
class Drawings {
  readonly xml = new Map<string, string>()
  readonly media: Array<{ name: string; bytes: Uint8Array; rel: string }> = []
  private markers = 0
  private ids = 0
  private layer = 0
  /** A run standing for `xml` until the package is written. */
  marker(xml: string): TextRun {
    const key = `HKDRAW${++this.markers}X`
    this.xml.set(key, xml)
    return new TextRun(key)
  }
  embed(bytes: Uint8Array, ext: 'png' | 'jpeg' | 'svg'): string {
    const n = this.media.length + 1
    const rel = `rIdHk${n}`
    this.media.push({ name: `hk${n}.${ext}`, bytes, rel })
    return rel
  }
  id(): number {
    return ++this.ids
  }
  /** Word's own range of z-orders (with small values Word drew a page's background over a picture). */
  z(): number {
    return 251658240 + ++this.layer * 1024
  }
}

const emu = (pt: number): number => Math.round(pt * EMU)

/** A drawing floating at its place on the page, behind the text, above those drawn before it. */
function anchorXml(d: Drawings, box: Box, name: string, graphic: string): string {
  const id = d.id()
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${d.z()}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(box[0])}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(box[1])}</wp:posOffset></wp:positionV><wp:extent cx="${Math.max(1, emu(box[2] - box[0]))}" cy="${Math.max(1, emu(box[3] - box[1]))}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="${name} ${id}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${graphic}</a:graphic></wp:anchor></w:drawing></w:r>`
}

function shapeRun(d: Drawings, b: ShapeBlock): TextRun {
  const { box, flip, body } = shapeParts(b, emu)
  const ext = `<a:ext cx="${Math.max(1, emu(box[2] - box[0]))}" cy="${Math.max(1, emu(box[3] - box[1]))}"/>`
  const graphic = `<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm${flip}><a:off x="0" y="0"/>${ext}</a:xfrm>${body}</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData>`
  return d.marker(anchorXml(d, box, 'Shape', graphic))
}

function pictureRun(d: Drawings, b: PictureBlock): TextRun {
  const png = d.embed(b.data, b.type === 'jpg' ? 'jpeg' : 'png')
  const svg = b.svg ? d.embed(b.svg, 'svg') : null
  const ext = `<a:ext cx="${Math.max(1, emu(b.box[2] - b.box[0]))}" cy="${Math.max(1, emu(b.box[3] - b.box[1]))}"/>`
  const graphic = `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Picture"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${png}">${svg ? svgExtension(svg) : ''}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>${ext}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData>`
  return d.marker(anchorXml(d, b.box, 'Picture', graphic))
}

/**
 * Where Word puts a line's baseline below the top of its line with exact line spacing `line`: at
 * four fifths of it, whatever the font and size (measured on Word's own PDF export: Arial, Calibri,
 * Times New Roman, Segoe UI, Book Antiqua and Georgia at 8–24 pt, lines 0.9–2 times the size).
 */
const wordBaselineIn = (line: number): number => line * 0.8

/**
 * A paragraph's text boxes measured at the sizes Word will print: Word keeps sizes in half points, so
 * 8.25 pt text is 8.5 pt there, 3 % wider — enough to wrap a line that just fitted (an Arabic invoice).
 */
function wordBoxes(b: ParagraphBlock): TextBox[] {
  const lines = b.lines.map((l) => ({ ...l, runs: l.runs.map((r) => ({ ...r, size: Math.round(r.size * 2) / 2 })) }))
  return textBoxes({ ...b, lines })
}

/** Word's exact line height for a box: its pitch, never less than most of its letters. */
const lineOf = (tb: TextBox): number => Math.max(tb.pitch, tb.size * 0.9)

const characterSpacing = (spacing: number | undefined): Partial<IRunOptions> => (spacing && Math.abs(spacing) > 0.01 ? { characterSpacing: twips(spacing) } : {})

/** A text box's runs: the paragraph's text when Word wraps it, else its lines with a break after each. */
function boxRuns(b: ParagraphBlock, tb: TextBox): ParagraphChild[] {
  const out: ParagraphChild[] = []
  if (tb.wrap) for (const r of directedRuns(joinedRuns(tb.lines), b.rtl)) out.push(run({ ...r, tracking: 0 }, characterSpacing(tb.spacing[0])))
  else
    tb.lines.forEach((l, i) =>
      directedRuns(l.runs, b.rtl).forEach((r, k) => out.push(run({ ...r, tracking: 0 }, { ...characterSpacing(tb.spacing[i]), ...(i > 0 && k === 0 ? { break: 1 } : {}) })))
    )
  return out
}

const alignOf = (b: ParagraphBlock, tb: TextBox): (typeof AlignmentType)[keyof typeof AlignmentType] =>
  tb.wrap && tb.align === 'justify' ? AlignmentType.BOTH : b.alignment === 'centre' ? AlignmentType.CENTER : b.alignment === 'end' ? AlignmentType.END : AlignmentType.START

/** Indents of a wrapping box: its first line's indent or hang, plus `start` / `end` room (inside a table cell). */
function indentOf(tb: TextBox, start = 0, end = 0): IParagraphOptions['indent'] {
  const hang = tb.firstIndent < 0 ? -tb.firstIndent : 0
  const first = tb.firstIndent > 0 ? tb.firstIndent : 0
  if (!hang && !first && !start && !end) return undefined
  return { start: twips(start + hang), end: twips(end), ...(hang ? { hanging: twips(hang) } : first ? { firstLine: twips(first) } : {}) }
}

/** One text box: a paragraph in a frame at its place, its lines breaking where the PDF's did (fit.ts). */
function framedBox(b: ParagraphBlock, tb: TextBox): Paragraph {
  const line = lineOf(tb)
  const top = tb.lines[0]!.baseline - wordBaselineIn(line)
  const indent = indentOf(tb)
  return new Paragraph({
    children: boxRuns(b, tb),
    bidirectional: b.rtl,
    alignment: alignOf(b, tb),
    ...(indent ? { indent } : {}),
    spacing: { before: 0, after: 0, line: twips(line), lineRule: LineRuleType.EXACT },
    frame: {
      type: 'absolute',
      position: { x: twips(Math.max(0, tb.left)), y: twips(Math.max(0, top)) },
      width: twips(tb.width),
      height: twips(line * tb.lines.length),
      anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      wrap: FrameWrap.NONE,
      rule: HeightRule.ATLEAST
    }
  })
}

/** A paragraph's frames, and its bullets printed apart from their text, each in a frame at its place. */
function framedParagraph(b: ParagraphBlock, withText = true): Paragraph[] {
  const out: Paragraph[] = []
  for (const l of b.lines)
    if (l.marker?.runs.length) {
      const bullet: ParagraphBlock = { ...b, alignment: 'start', lines: [{ runs: l.marker.runs, box: l.marker.box, baseline: l.baseline }] }
      for (const tb of wordBoxes(bullet)) out.push(framedBox(bullet, tb))
    }
  if (withText) for (const tb of wordBoxes(b)) out.push(framedBox(b, tb))
  return out
}

const TINY = { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT } as const

/**
 * Where Word puts a cell's text (measured on Word's own PDF export): below the row's top rule and
 * right of the cell's left rule, each taking its whole width inside the cell, and a row's height
 * does not count its top rule. `rules` gives those widths for this cell.
 */
interface CellRules {
  top: number
  left: number
  right: number
}

/** A cell's text: each paragraph inside the cell where it was (its indents and the space above it). */
function cellParagraphs(cell: CellBlock, rules: CellRules): Paragraph[] {
  const box = cell.box!
  const items = cell.paragraphs.flatMap((p) => wordBoxes(p).map((tb) => ({ p, tb })))
  items.sort((x, y) => x.tb.lines[0]!.baseline - y.tb.lines[0]!.baseline)
  const out: Paragraph[] = []
  // The table lies half a rule up and left of the PDF's (each rule centred where it was drawn).
  let bottom = box[1] + rules.top / 2
  for (const { p, tb } of items) {
    const line = lineOf(tb)
    const top = tb.lines[0]!.baseline - wordBaselineIn(line)
    const left = Math.max(0, tb.left - box[0] - rules.left / 2)
    const right = Math.max(0, box[2] - rules.left / 2 - rules.right - (tb.left + tb.width))
    const indent = indentOf(tb, p.rtl ? right : left, p.rtl ? left : right)
    out.push(
      new Paragraph({
        children: boxRuns(p, tb),
        bidirectional: p.rtl,
        alignment: alignOf(p, tb),
        ...(indent ? { indent } : {}),
        spacing: { before: twips(Math.max(0, top - bottom)), after: 0, line: twips(line), lineRule: LineRuleType.EXACT }
      })
    )
    const last = tb.lines[tb.lines.length - 1]!
    bottom = Math.max(bottom, top) + line * tb.lines.length
    bottom = Math.max(bottom, last.baseline + (line - wordBaselineIn(line)))
  }
  // An empty cell takes the least height.
  return out.length ? out : [new Paragraph({ spacing: TINY })]
}

const borderOf = (r: Rule | null | undefined): { style: (typeof BorderStyle)[keyof typeof BorderStyle]; size: number; color: string } =>
  r ? { style: BorderStyle.SINGLE, size: Math.max(2, Math.min(96, Math.round(r.width * 8))), color: hex(r.colour) } : { style: BorderStyle.NIL, size: 0, color: 'auto' }

/** A rule's width as Word draws it (in eighths of a point). */
const ruleWidth = (r: Rule | null | undefined): number => (r ? borderOf(r).size / 8 : 0)

/** A table as drawn: floating at its place, its columns and rows as ruled, each cell's rules and fill. */
function placedTable(t: TableBlock): Table {
  const none = borderOf(null)
  const n = t.rows.length
  // The widest rule across each row line (Word draws the heavier of two that meet), top to bottom.
  const across = (r: number): number =>
    Math.max(0, ...(r > 0 ? t.rows[r - 1]!.map((c) => ruleWidth(c.borders?.bottom)) : []), ...(r < n ? t.rows[r]!.map((c) => ruleWidth(c.borders?.top)) : []))
  const h = Array.from({ length: n + 1 }, (_, r) => across(r))
  const firstLeft = Math.max(0, ...t.rows.map((row) => ruleWidth(row[0]?.borders?.left)))
  return new Table({
    columnWidths: t.columns.map(twips),
    width: { size: twips(t.columns.reduce((s, c) => s + c, 0)), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA },
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    float: {
      horizontalAnchor: TableAnchorType.PAGE,
      verticalAnchor: TableAnchorType.PAGE,
      absoluteHorizontalPosition: twips(t.box[0] - firstLeft / 2),
      absoluteVerticalPosition: twips(t.box[1] - h[0]! / 2),
      overlap: OverlapType.OVERLAP,
      leftFromText: 0,
      rightFromText: 0,
      topFromText: 0,
      bottomFromText: 0
    },
    rows: t.rows.map((row, r) => {
      let column = 0
      return new TableRow({
        height: { value: twips(Math.max(1, (t.rowHeights[r] ?? 1) - (h[r]! + h[r + 1]!) / 2)), rule: HeightRule.ATLEAST },
        cantSplit: true,
        children: row.map((cell) => {
          const width = t.columns.slice(column, column + cell.span).reduce((s, c) => s + c, 0)
          column += cell.span
          const b = cell.borders
          return new TableCell({
            children: cellParagraphs(cell, { top: h[r]!, left: ruleWidth(b?.left), right: ruleWidth(b?.right) }),
            width: { size: twips(width), type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 0, marginUnitType: WidthType.DXA },
            borders: { top: borderOf(b?.top), bottom: borderOf(b?.bottom), left: borderOf(b?.left), right: borderOf(b?.right) },
            verticalAlign: VerticalAlignTable.TOP,
            ...(cell.shading ? { shading: { fill: hex(cell.shading), type: ShadingType.CLEAR, color: 'auto' } } : {}),
            ...(cell.span > 1 ? { columnSpan: cell.span } : {})
          })
        })
      })
    })
  })
}

/**
 * A PDF page as a Word page of its size (decisions §118): its drawings as Word shapes and pictures
 * behind the text in the PDF's paint order, its ruled tables as floating Word tables with their
 * rules and fills, and each paragraph in a frame at its place that wraps where the PDF's lines did.
 */
function exactPage(page: PageModel, d: Drawings): ISectionOptions {
  const art: TextRun[] = page.drawn.map((x) => (x.kind === 'shape' ? shapeRun(d, x) : pictureRun(d, x)))
  // Pictures of lines the file maps to nothing (§68), in tables too: above the drawings.
  for (const b of page.blocks) {
    if (b.kind === 'picture') art.push(pictureRun(d, b))
    else if (b.kind === 'table') for (const cell of b.rows.flat()) for (const p of cell.pictures) art.push(pictureRun(d, p))
  }
  const children: Array<Paragraph | Table> = [new Paragraph({ children: art, spacing: TINY })]
  for (const b of page.blocks) {
    if (b.kind === 'paragraph') children.push(...framedParagraph(b))
    else if (b.kind === 'table' && b.placed && b.columns.length <= WORD_COLUMNS) {
      children.push(placedTable(b))
      for (const p of b.rows.flat().flatMap((c) => c.paragraphs)) children.push(...framedParagraph(p, false))
    } else if (b.kind === 'table') for (const p of b.rows.flat().flatMap((c) => c.paragraphs)) children.push(...framedParagraph(p))
  }
  // A section ends with a paragraph (a table may not end it), as small as can be.
  children.push(new Paragraph({ spacing: TINY }))
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

/** The drawings' XML in place of their markers, their pictures in the package. */
async function withDrawings(bytes: Uint8Array, d: Drawings): Promise<Uint8Array> {
  if (d.xml.size === 0) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const name = 'word/document.xml'
  let xml = await zip.file(name)!.async('string')
  xml = xml.replace(/<w:r>(?:(?!<w:r>)[\s\S])*?<w:t[^>]*>(HKDRAW\d+X)<\/w:t><\/w:r>/g, (m, key: string) => d.xml.get(key) ?? m)
  zip.file(name, xml)
  if (d.media.length) {
    const relsName = 'word/_rels/document.xml.rels'
    const rels = await zip.file(relsName)!.async('string')
    const extra = d.media.map((m) => `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')
    zip.file(relsName, rels.replace('</Relationships>', `${extra}</Relationships>`))
    for (const m of d.media) zip.file(`word/media/${m.name}`, m.bytes)
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

export async function writeDocx(model: DocModel, options: DocxOptions): Promise<Uint8Array> {
  const drawings = new Drawings()
  const sections = options.layout === 'exact' ? model.pages.map((p) => exactPage(p, drawings)) : flowing(model, options)
  const doc = new Document({ creator: BRAND.name, sections: sections.length ? sections : [{ children: [new Paragraph({})] }] })
  return withDrawings(new Uint8Array(await Packer.toBuffer(doc)), drawings)
}

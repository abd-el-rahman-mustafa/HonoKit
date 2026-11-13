import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { BRAND } from '@shared/brand'
import { directedRuns, type DirectedRun } from './bidiruns'
import { EMU, hex, shapeParts, solid, svgExtension } from './drawingml'
import { joinedRuns, textBoxes, type TextBox } from './fit'
import { fontsFor } from './fonts'
import type { Box, DocModel, PageModel, ParagraphBlock, PictureBlock, ShapeBlock, TableBlock, TableCell } from './model'
import type { Rule } from './scene'

/**
 * The model as a PowerPoint deck (research §4.2, §7, §10; decisions §118): one slide per page that
 * looks like the page and is made of what PowerPoint itself edits —
 *
 * - the page's drawings as shapes (rectangles, lines, outlines with their fills, lines and dashes),
 *   art PowerPoint cannot draw alike as pictures of just that art (SVG when it is plain vectors, with
 *   a PNG stand-in), the page's pictures as pictures, all in the PDF's paint order;
 * - ruled tables as PowerPoint tables, the rules as cell borders and the fills as cell shading;
 * - each paragraph one text box that wraps where the PDF's lines broke (fit.ts), so editing it
 *   re-flows the paragraph; a paragraph that cannot keeps its lines with line breaks.
 *
 * pptxgenjs writes the empty deck (masters, notes); the slides' contents are written here, as
 * pptxgenjs has no custom geometry, SVG pictures, cell borders per side or exact text placement.
 *
 * Arabic: right-to-left paragraphs (rtl="1"), the Arabic font in the complex-script slot and the
 * Latin one in the Latin slot, so digits and Latin words keep a Latin font (fonts.ts).
 */

/** Characters XML 1.0 does not allow, and markup. */
const CONTROL = new RegExp(`[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F${String.fromCodePoint(0xfffe, 0xffff)}]`, 'g')
const esc = (s: string): string => s.replace(CONTROL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Line spacing as PowerPoint draws it (measured on its PDF export, Arial, Georgia, Calibri, Times New
 * Roman, Segoe UI, Courier New, Tahoma, Simplified Arabic and Dubai at 10 and 20 pt): a percentage
 * of 1.2 times the size, whatever the font, kept to a thousandth; spacing in points is rounded to
 * whole points (11.5 came out 12, a paragraph of 10 lines 5 points too long). The first baseline
 * lies 0.26 of the size above the line's bottom up to 100 %, and at 0.751 of the line above that.
 */
const percentOf = (pitch: number, size: number): number => pitch / (1.2 * size)
const baselineIn = (pitch: number, size: number): number => (percentOf(pitch, size) <= 1 ? pitch - size * 0.26 : pitch * 0.751)

interface Media {
  name: string
  bytes: Uint8Array
}

/** One slide being written: its shapes' XML, ids, pictures and their relationships. */
class SlideXml {
  private next = 2
  readonly parts: string[] = []
  readonly rels: Array<{ id: string; target: string }> = []
  constructor(
    private readonly media: Media[],
    /** Page points → slide EMU. */
    private readonly s: number,
    private readonly dx: number,
    private readonly dy: number
  ) {}
  id(): number {
    return this.next++
  }
  x(v: number): number {
    return Math.round((this.dx + v * this.s) * EMU)
  }
  y(v: number): number {
    return Math.round((this.dy + v * this.s) * EMU)
  }
  len(v: number): number {
    return Math.max(0, Math.round(v * this.s * EMU))
  }
  get scale(): number {
    return this.s
  }
  /** A picture file in the deck, related to this slide; its relationship id. */
  embed(bytes: Uint8Array, ext: 'png' | 'jpeg' | 'svg'): string {
    const n = this.media.length + 1
    const name = `hk${n}.${ext}`
    this.media.push({ name, bytes })
    const id = `rIdHk${n}`
    this.rels.push({ id, target: `../media/${name}` })
    return id
  }
}

function xfrm(sx: SlideXml, box: Box, flip = ''): string {
  return `<a:xfrm${flip}><a:off x="${sx.x(box[0])}" y="${sx.y(box[1])}"/><a:ext cx="${sx.len(box[2] - box[0])}" cy="${sx.len(box[3] - box[1])}"/></a:xfrm>`
}

function shapeXml(sx: SlideXml, b: ShapeBlock): string {
  const id = sx.id()
  const { box, flip, body } = shapeParts(b, (v) => sx.len(v))
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(sx, box, flip)}${body}</p:spPr></p:sp>`
}

function pictureXml(sx: SlideXml, b: PictureBlock): string {
  const id = sx.id()
  const png = sx.embed(b.data, b.type === 'jpg' ? 'jpeg' : 'png')
  const svg = b.svg ? sx.embed(b.svg, 'svg') : null
  const ext = svg ? svgExtension(svg) : ''
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${png}">${ext}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(sx, b.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

function runXml(sx: SlideXml, r: DirectedRun, spacing: number): string {
  const f = fontsFor(r)
  const sz = Math.max(100, Math.min(400000, Math.round(r.size * sx.scale * 100)))
  const spc = Math.round(spacing * sx.scale * 100)
  // No kerning: the widths were fitted without it (fit.ts).
  return `<a:r><a:rPr lang="${r.rtl ? 'ar-AE' : 'en-US'}" sz="${sz}" b="${r.bold ? 1 : 0}" i="${r.italic ? 1 : 0}" kern="0"${spc ? ` spc="${spc}"` : ''} dirty="0"><a:solidFill><a:srgbClr val="${hex(r.colour)}"/></a:solidFill><a:latin typeface="${esc(f.latin)}"/><a:cs typeface="${esc(f.arabic)}"/></a:rPr><a:t>${esc(r.text)}</a:t></a:r>`
}

const breakXml = (sx: SlideXml, r: DirectedRun | undefined): string => `<a:br><a:rPr lang="en-US" sz="${Math.max(100, Math.round((r?.size ?? 10) * sx.scale * 100))}" dirty="0"/></a:br>`

/** Where a text box lies inside a table cell: room left between it and the cell's left and right edges (points). */
interface Inset {
  left: number
  right: number
}

/**
 * Paragraph properties and runs of one text box; `inset` places it inside a table cell, `before` is
 * the space above it there. PowerPoint's marL is the margin on the paragraph's start side.
 */
function paragraphXml(sx: SlideXml, b: ParagraphBlock, tb: TextBox, inset: Inset | null = null, before = 0): string {
  const algn = tb.wrap && tb.align === 'justify' ? 'just' : b.alignment === 'centre' ? 'ctr' : (b.alignment === 'end') !== b.rtl ? 'r' : 'l'
  const hang = tb.firstIndent < 0 ? -tb.firstIndent : 0
  const first = tb.firstIndent > 0 ? tb.firstIndent : 0
  const start = inset ? (b.rtl ? inset.right : inset.left) : 0
  const end = inset ? (b.rtl ? inset.left : inset.right) : 0
  const marL = sx.len(start + hang)
  const marR = sx.len(end)
  const indent = sx.len(first) - sx.len(hang)
  const margin = `${marL ? ` marL="${marL}"` : ''}${marR ? ` marR="${marR}"` : ''}${indent ? ` indent="${indent}"` : ''}`
  const pPr = `<a:pPr algn="${algn}"${b.rtl ? ' rtl="1"' : ' rtl="0"'}${margin}><a:lnSpc><a:spcPct val="${Math.max(10000, Math.round(percentOf(tb.pitch, tb.size) * 100000))}"/></a:lnSpc><a:spcBef><a:spcPts val="${Math.max(0, Math.round(before * sx.scale * 100))}"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>`
  let runs: string
  if (tb.wrap) runs = directedRuns(joinedRuns(tb.lines), b.rtl).map((r) => runXml(sx, r, tb.spacing[0] ?? 0)).join('')
  else
    runs = tb.lines
      .map((l, i) => {
        const pieces = directedRuns(l.runs, b.rtl)
        return (i > 0 ? breakXml(sx, pieces[0]) : '') + pieces.map((r) => runXml(sx, r, tb.spacing[i] ?? 0)).join('')
      })
      .join('')
  return `<a:p>${pPr}${runs}</a:p>`
}

function textBoxXml(sx: SlideXml, b: ParagraphBlock, tb: TextBox): string {
  const id = sx.id()
  const first = tb.lines[0]!
  const top = first.baseline - baselineIn(tb.pitch, tb.size)
  const height = tb.pitch * tb.lines.length
  const box: Box = [tb.left, top, tb.left + tb.width, top + height]
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(sx, box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="${tb.wrap ? 'square' : 'none'}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphXml(sx, b, tb)}</p:txBody></p:sp>`
}

/** A paragraph's text boxes, and its bullets printed apart from their text, each at its place. */
function paragraphShapes(sx: SlideXml, b: ParagraphBlock): string {
  let out = bulletShapes(sx, b)
  for (const tb of textBoxes(b)) out += textBoxXml(sx, b, tb)
  return out
}

/** Bullets printed apart from their text (in a table cell too), each in a small box at its place. */
function bulletShapes(sx: SlideXml, b: ParagraphBlock): string {
  let out = ''
  for (const l of b.lines)
    if (l.marker?.runs.length) {
      const bullet: ParagraphBlock = { ...b, alignment: 'start', lines: [{ runs: l.marker.runs, box: l.marker.box, baseline: l.baseline }] }
      for (const tb of textBoxes(bullet)) out += textBoxXml(sx, bullet, tb)
    }
  return out
}

const borderXml = (sx: SlideXml, side: 'L' | 'R' | 'T' | 'B', rule: Rule | null | undefined): string =>
  rule ? `<a:ln${side} w="${Math.max(1, sx.len(Math.max(0.25, rule.width)))}" cap="flat" cmpd="sng" algn="ctr">${solid({ colour: rule.colour, alpha: 1 })}<a:prstDash val="solid"/></a:ln${side}>` : `<a:ln${side} w="0"><a:noFill/></a:ln${side}>`

/** A cell's text: each paragraph placed inside the cell where it was (its margins and the space above it). */
function cellXml(sx: SlideXml, cell: TableCell, extra: string): string {
  const box = cell.box!
  const items = cell.paragraphs.flatMap((p) => textBoxes(p).map((tb) => ({ p, tb })))
  items.sort((a, b) => a.tb.lines[0]!.baseline - b.tb.lines[0]!.baseline)
  let body = ''
  let top = 0
  let last: { baseline: number; pitch: number; size: number } | null = null
  for (const { p, tb } of items) {
    const inset = { left: Math.max(0, tb.left - box[0]), right: Math.max(0, box[2] - (tb.left + tb.width)) }
    const lineTop = tb.lines[0]!.baseline - baselineIn(tb.pitch, tb.size)
    let before = 0
    if (!last) top = Math.max(0, lineTop - box[1])
    else before = Math.max(0, lineTop - (last.baseline + (last.pitch - baselineIn(last.pitch, last.size))))
    body += paragraphXml(sx, p, tb, inset, before)
    const lastLine = tb.lines[tb.lines.length - 1]!
    last = { baseline: lastLine.baseline, pitch: tb.pitch, size: tb.size }
  }
  // An empty cell takes the least height: a tiny empty paragraph.
  if (!body) body = '<a:p><a:pPr><a:lnSpc><a:spcPts val="100"/></a:lnSpc></a:pPr><a:endParaRPr lang="en-US" sz="100" dirty="0"/></a:p>'
  const b = cell.borders
  const fill = cell.shading ? solid({ colour: cell.shading, alpha: 1 }) : '<a:noFill/>'
  return `<a:tc${extra}><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody><a:tcPr marL="0" marR="0" marT="${sx.len(top)}" marB="0" anchor="t">${borderXml(sx, 'L', b?.left)}${borderXml(sx, 'R', b?.right)}${borderXml(sx, 'T', b?.top)}${borderXml(sx, 'B', b?.bottom)}${fill}</a:tcPr></a:tc>`
}

const MERGED = '<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" sz="100" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>'

function tableXml(sx: SlideXml, t: TableBlock): string {
  const id = sx.id()
  const grid = t.columns.map((w) => `<a:gridCol w="${Math.max(1, sx.len(w))}"/>`).join('')
  const rows = t.rows
    .map((row, r) => {
      const cells = row.map((cell) => cellXml(sx, cell, cell.span > 1 ? ` gridSpan="${cell.span}"` : '') + MERGED.repeat(cell.span - 1)).join('')
      return `<a:tr h="${Math.max(1, sx.len(t.rowHeights[r] ?? 0))}">${cells}</a:tr>`
    })
    .join('')
  const box = t.box
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${sx.x(box[0])}" y="${sx.y(box[1])}"/><a:ext cx="${sx.len(box[2] - box[0])}" cy="${sx.len(box[3] - box[1])}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

/** The slide's shapes: drawings in paint order, then tables, then pictures of unreadable lines, then text. */
function slideShapes(sx: SlideXml, page: PageModel): string {
  const parts: string[] = []
  for (const d of page.drawn) parts.push(d.kind === 'shape' ? shapeXml(sx, d) : pictureXml(sx, d))
  for (const b of page.blocks) {
    if (b.kind === 'table' && b.placed) parts.push(tableXml(sx, b))
  }
  for (const b of page.blocks) {
    if (b.kind === 'picture') parts.push(pictureXml(sx, b))
    else if (b.kind === 'table') for (const cell of b.rows.flat()) for (const p of cell.pictures) parts.push(pictureXml(sx, p))
  }
  for (const b of page.blocks) {
    if (b.kind === 'paragraph') parts.push(paragraphShapes(sx, b))
    else if (b.kind === 'table' && b.placed) for (const cell of b.rows.flat()) for (const p of cell.paragraphs) parts.push(bulletShapes(sx, p))
    // A table without its drawn cells (not built for placing): its text where it was.
    else if (b.kind === 'table' && !b.placed) for (const cell of b.rows.flat()) for (const p of cell.paragraphs) parts.push(paragraphShapes(sx, p))
  }
  return parts.join('')
}

/** The page's text in reading order: the slide's notes (PowerPoint's search, screen readers). */
function notesOf(page: PageModel): string {
  return page.blocks
    .flatMap((b) => (b.kind === 'paragraph' ? [b] : b.kind === 'table' ? b.rows.flat().flatMap((c) => c.paragraphs) : []))
    .map((p) => p.runs.map((r) => r.text).join(''))
    .filter((t) => t.trim())
    .join('\n')
}

/** PowerPoint's largest slide side: 56 inches. */
const MOST = 56 * 72

export async function writePptx(model: DocModel): Promise<Uint8Array> {
  const pres = new PptxGenJS()
  const first = model.pages[0] ?? { width: 960, height: 540, blocks: [], rtl: false, drawn: [] }
  const k = Math.min(1, MOST / Math.max(first.width, first.height))
  const slideW = Math.max(72, first.width * k)
  const slideH = Math.max(72, first.height * k)
  pres.defineLayout({ name: 'PDF', width: slideW / 72, height: slideH / 72 })
  pres.layout = 'PDF'
  pres.author = BRAND.name
  if (first.rtl) pres.rtlMode = true
  for (const page of model.pages) {
    const slide = pres.addSlide()
    const notes = notesOf(page).replace(CONTROL, '')
    if (notes) slide.addNotes(notes)
  }
  const zip = await JSZip.loadAsync((await pres.write({ outputType: 'nodebuffer' })) as Buffer)
  const media: Media[] = []
  for (let i = 0; i < model.pages.length; i++) {
    const page = model.pages[i]!
    // A page of another size is scaled to fit the slide, centred.
    const s = Math.min(slideW / page.width, slideH / page.height)
    const sx = new SlideXml(media, s, (slideW - page.width * s) / 2, (slideH - page.height * s) / 2)
    const shapes = slideShapes(sx, page)
    const slideName = `ppt/slides/slide${i + 1}.xml`
    const xml = await zip.file(slideName)!.async('string')
    zip.file(slideName, xml.replace('</p:spTree>', `${shapes}</p:spTree>`))
    if (sx.rels.length) {
      const relsName = `ppt/slides/_rels/slide${i + 1}.xml.rels`
      const rels = await zip.file(relsName)!.async('string')
      const extra = sx.rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join('')
      zip.file(relsName, rels.replace('</Relationships>', `${extra}</Relationships>`))
    }
  }
  for (const m of media) zip.file(`ppt/media/${m.name}`, m.bytes)
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

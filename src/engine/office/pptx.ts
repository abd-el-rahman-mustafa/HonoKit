import PptxGenJS from 'pptxgenjs'
import { BRAND } from '@shared/brand'
import type { DocModel, ParagraphBlock, PictureBlock, TableCell } from './model'
import { fontsFor } from './fonts'

/**
 * The model as a PowerPoint deck (research §4.2, §7): one slide per page, the slide the size
 * of the page, each paragraph a text box where it was, pictures and ruled tables in place.
 * Arabic text boxes are right to left (rtlMode) and shrink if the substituted font is wider.
 */

const inch = (pt: number): number => pt / 72
const hex = (c: [number, number, number]): string => c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const hasArabic = (s: string): boolean => /[؀-ۿݐ-ݿࢠ-ࣿ]/.test(s)

function runs(b: ParagraphBlock): PptxGenJS.TextProps[] {
  // pptxgenjs writes rtl="1" for the paragraph only from the runs' own options.
  const prefix = b.list === 'bullet' ? '• ' : b.list === 'number' ? `${b.marker} ` : ''
  return b.runs.map((r, i) => {
    const fonts = fontsFor(r)
    return {
      text: (i === 0 ? prefix : '') + r.text,
      options: { bold: r.bold, italic: r.italic, fontSize: Math.max(4, r.size), color: hex(r.colour), fontFace: hasArabic(r.text) ? fonts.arabic : fonts.latin, ...(b.rtl ? { rtlMode: true, lang: 'ar-AE' } : {}) }
    }
  })
}

const ALIGN = { start: 'left', end: 'right', centre: 'center', justify: 'justify' } as const
/** Table cell margins at most (points), and how much wider than the PDF's a line may come out in the substituted font. */
const CELL_MARGIN = 2.88
const TEXT_ROOM = 1.06
/** The table's rules (0.75 pt). */
const BORDER = 0.75

/**
 * A table cell that keeps the PDF's row height: PowerPoint grows a row whose text wraps anew or
 * whose (even empty) paragraph is taller than the row. So margins are as tight as the PDF's own
 * padding, the text has room for a substituted font a little wider (shrunk if need be, down to
 * PowerPoint's 1 pt for tiny print), and an empty cell takes the table's text size or less.
 */
function tableCell(cell: TableCell, width: number, height: number, textSize: number, rtl: boolean): PptxGenJS.TableCell {
  const text = cell.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
  const first = cell.paragraphs[0]?.runs[0]
  const boxes = cell.paragraphs.map((p) => p.box)
  const widest = Math.max(1, ...boxes.map((x) => x[2] - x[0]))
  // Margins take at most a third of the room left over, so some is spare; the rule takes its own width.
  const side = Math.max(0.3, Math.min(CELL_MARGIN, (width - widest * TEXT_ROOM - BORDER) / 3))
  const fit = Math.min(1, (width - 2 * side - BORDER) / (widest * TEXT_ROOM))
  const size = first ? first.size * fit : Math.min(textSize, (height - 1) / 1.2)
  const tall = boxes.length ? Math.max(...boxes.map((x) => x[3])) - Math.min(...boxes.map((x) => x[1])) : size
  const top = Math.max(0.5, Math.min(CELL_MARGIN, (height - tall * 1.1) / 2))
  return {
    text,
    options: {
      ...(cell.span > 1 ? { colspan: cell.span } : {}),
      fontSize: Math.max(1, Math.floor(size * 4) / 4),
      bold: first?.bold ?? false,
      margin: [inch(top), inch(side), inch(top), inch(side)] as [number, number, number, number],
      rtlMode: rtl,
      align: rtl ? 'right' : 'left'
    } as PptxGenJS.TableCellProps
  }
}

function image(slide: PptxGenJS.Slide, b: PictureBlock): void {
  const [x0, y0, x1, y1] = b.box
  slide.addImage({ data: `image/png;base64,${Buffer.from(b.png).toString('base64')}`, x: inch(x0), y: inch(y0), w: inch(x1 - x0), h: inch(y1 - y0) })
}

export async function writePptx(model: DocModel): Promise<Uint8Array> {
  const pres = new PptxGenJS()
  const first = model.pages[0] ?? { width: 960, height: 540, blocks: [], rtl: false }
  pres.defineLayout({ name: 'PDF', width: inch(first.width), height: inch(first.height) })
  pres.layout = 'PDF'
  pres.author = BRAND.name
  if (first.rtl) pres.rtlMode = true
  for (const page of model.pages) {
    const slide = pres.addSlide()
    for (const b of page.blocks) {
      const [x0, y0, x1, y1] = b.box
      if (b.kind === 'paragraph') {
        if (b.runs.length === 0) continue
        const align = b.rtl ? ({ start: 'right', end: 'left', centre: 'center', justify: 'justify' } as const)[b.alignment] : ALIGN[b.alignment]
        slide.addText(runs(b), {
          x: inch(x0),
          y: inch(y0),
          // A little room: the substituted font may be a touch wider than the PDF's.
          w: inch(x1 - x0) * 1.04,
          h: inch(y1 - y0) * 1.1,
          margin: 0,
          valign: 'top',
          align,
          rtlMode: b.rtl,
          lang: b.rtl ? 'ar-AE' : 'en-US',
          fit: 'shrink',
          lineSpacingMultiple: b.lineHeight > 1.35 ? b.lineHeight / 1.2 : 1
        })
      } else if (b.kind === 'picture') {
        image(slide, b)
      } else {
        const textSize = b.rows.flat().find((c) => c.paragraphs[0]?.runs[0])?.paragraphs[0]?.runs[0]?.size ?? 10
        const rows: PptxGenJS.TableRow[] = b.rows.map((row, ri) => {
          let column = 0
          return row.map((cell) => {
            const width = b.columns.slice(column, column + cell.span).reduce((s, c) => s + c, 0)
            column += cell.span
            return tableCell(cell, width, b.rowHeights[ri]!, textSize, b.rtl)
          })
        })
        slide.addTable(rows, { x: inch(x0), y: inch(y0), w: inch(x1 - x0), colW: b.columns.map(inch), rowH: b.rowHeights.map(inch), border: { type: 'solid', pt: BORDER, color: '808080' }, margin: inch(CELL_MARGIN) })
        // A PowerPoint cell holds no picture: lines the file maps to nothing (§68) lie over the table where they were.
        for (const row of b.rows) for (const cell of row) for (const p of cell.pictures) image(slide, p)
      }
    }
  }
  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer
  return new Uint8Array(out)
}

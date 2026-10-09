import { BRAND } from '@shared/brand'
import ExcelJS from 'exceljs'
import { extractLines, unreadable, withoutUnmapped, type TextLine } from '../text'
import type { PdfDoc } from '../mupdf'
import type { DocModel, TableBlock } from './model'

/**
 * The document as an Excel workbook (research §4.3, §7), as Acrobat's Export to Excel:
 *  - 'page' (default): one worksheet per page. Ruled tables keep their grid; every other line
 *    is a row, split into cells where its words are far apart (a column gap), and the cells
 *    of the whole page are lined up into columns by where they start.
 *  - 'tables': one worksheet per ruled table only.
 * Numbers ("1,200", "١٢٬٥", "15%", "(300)") become numbers Excel can add up. An Arabic page is
 * a right-to-left sheet, its columns read from the right.
 */

export type XlsxMode = 'page' | 'tables'

type Box = [number, number, number, number]

interface Cell {
  text: string
  /** Where the cell starts on the page: left edge (right edge on an RTL page). */
  x: number
}

interface Row {
  y: number
  cells: Cell[]
  /** A row from a ruled table: its cells are already in their columns. */
  grid?: string[]
}

const ARABIC = /[؀-ۿ]/

/** A line's pieces separated by a gap much wider than a word space. */
function splitLine(line: TextLine, rtl: boolean): Cell[] {
  const glyphs = line.glyphs.filter((g) => g.c.trim() !== '').sort((a, b) => a.box[0] - b.box[0])
  if (glyphs.length === 0) return []
  const height = line.box[3] - line.box[1]
  const pieces: Array<{ x0: number; x1: number; glyphs: typeof glyphs }> = []
  for (const g of glyphs) {
    const last = pieces[pieces.length - 1]
    if (last && g.box[0] - last.x1 < Math.max(height * 1.1, 6)) {
      last.glyphs.push(g)
      last.x1 = Math.max(last.x1, g.box[2])
    } else pieces.push({ x0: g.box[0], x1: g.box[2], glyphs: [g] })
  }
  // Each piece's text in the line's own (logical) order: take it from the line's text by the glyphs it holds.
  const order = new Map(line.glyphs.map((g, i) => [g, i]))
  const cells = pieces.map((p) => {
    const idx = p.glyphs.map((g) => order.get(g)!).sort((a, b) => a - b)
    let text = ''
    for (let i = idx[0]!; i <= idx[idx.length - 1]!; i++) text += line.glyphs[i]!.c
    return { text: withoutUnmapped(text).replace(/\s+/g, ' ').trim(), x: rtl ? p.x1 : p.x0 }
  })
  // A piece that was only letters the file maps to nothing (§68) is no cell.
  return (rtl ? cells.reverse() : cells).filter((c) => c.text)
}

/** "1,200" / "١٬٢٠٠" / "12.5%" / "(300)" → a number; otherwise null. */
export function asNumber(text: string): { value: number; percent: boolean } | null {
  let t = text.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  t = t.replace(/٫/g, '.').replace(/[٬,\s]/g, '')
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t)
  t = t.replace(/^[(-]|\)$/g, '')
  const percent = /[%٪]$/.test(t)
  t = t.replace(/[%٪]$/, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const v = Number(t) * (negative ? -1 : 1)
  return { value: percent ? v / 100 : v, percent }
}

function inside(box: Box, line: TextLine): boolean {
  const cx = (line.box[0] + line.box[2]) / 2
  const cy = (line.box[1] + line.box[3]) / 2
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]
}

const tableText = (t: TableBlock): string[][] =>
  t.rows.map((row) => {
    const out: string[] = []
    for (const c of row) {
      out.push(c.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n'))
      for (let k = 1; k < c.span; k++) out.push('')
    }
    return out
  })

function fill(sheet: ExcelJS.Worksheet, rows: string[][], rtl: boolean): void {
  rows.forEach((cells, r) => {
    cells.forEach((text, c) => {
      if (!text) return
      const cell = sheet.getCell(r + 1, c + 1)
      const n = asNumber(text)
      if (n) {
        cell.value = n.value
        if (n.percent) cell.numFmt = '0.##%'
        else if (/[,٬]/.test(text)) cell.numFmt = '#,##0.##'
      } else {
        cell.value = text
        if (ARABIC.test(text)) cell.alignment = { readingOrder: 'rtl', horizontal: 'right', wrapText: true, vertical: 'top' }
        else cell.alignment = { wrapText: true, vertical: 'top' }
      }
    })
  })
  // Columns wide enough for their text, within reason.
  const widths: number[] = []
  for (const cells of rows) cells.forEach((t, c) => (widths[c] = Math.max(widths[c] ?? 6, Math.min(60, Math.max(...t.split('\n').map((l) => l.length)) + 2))))
  widths.forEach((w, c) => (sheet.getColumn(c + 1).width = w))
  if (rtl) sheet.views = [{ rightToLeft: true }]
}

export async function writeXlsx(doc: PdfDoc, model: DocModel, pages: number[], mode: XlsxMode): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook()
  book.creator = BRAND.name
  let tableCount = 0
  model.pages.forEach((page, pi) => {
    const pageIndex = pages[pi]!
    const tables = page.blocks.filter((b): b is TableBlock => b.kind === 'table')
    if (mode === 'tables') {
      for (const t of tables) fill(book.addWorksheet(`Table ${++tableCount}`), tableText(t), t.rtl)
      return
    }
    const rtl = page.rtl
    const lines = extractLines(doc, pageIndex).filter((l) => l.box[3] - l.box[1] < 72 && l.text.trim() && !unreadable(l.text) && !tables.some((t) => inside(t.box, l)))
    const rows: Row[] = []
    // Lines on the same baseline (MuPDF splits a row at a wide gap) are one row.
    for (const l of [...lines].sort((a, b) => a.box[1] - b.box[1])) {
      const cells = splitLine(l, rtl)
      if (cells.length === 0) continue
      const mid = (l.box[1] + l.box[3]) / 2
      const same = rows.find((r) => !r.grid && Math.abs(r.y - mid) < (l.box[3] - l.box[1]) * 0.45)
      if (same) same.cells.push(...cells)
      else rows.push({ y: mid, cells })
    }
    for (const t of tables) tableText(t).forEach((grid, i) => rows.push({ y: t.box[1] + i * 0.01, cells: [], grid }))
    rows.sort((a, b) => a.y - b.y)
    // Columns: where cells start, clustered across the whole page.
    const starts = rows.flatMap((r) => r.cells.map((c) => c.x)).sort((a, b) => (rtl ? b - a : a - b))
    const columns: number[] = []
    for (const x of starts) if (!columns.some((c) => Math.abs(c - x) < 12)) columns.push(x)
    columns.sort((a, b) => (rtl ? b - a : a - b))
    const grid: string[][] = rows.map((r) => {
      if (r.grid) return r.grid
      const out: string[] = []
      for (const c of r.cells.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x))) {
        let col = columns.findIndex((x) => Math.abs(x - c.x) < 12)
        if (col < 0) col = 0
        while (out[col]) col++
        out[col] = c.text
      }
      return Array.from(out, (t) => t ?? '')
    })
    fill(book.addWorksheet(`Page ${pageIndex + 1}`), grid, rtl)
  })
  if (book.worksheets.length === 0) book.addWorksheet('Sheet 1')
  return new Uint8Array(await book.xlsx.writeBuffer())
}

import type { Alignment, StyleRun } from '../paragraphs'

/**
 * The document as the Office writers see it (docs/research-pdf-to-office.md §6): pages of
 * blocks in reading order — paragraphs (with style runs, direction, alignment, heading
 * level, list marker), pictures and ruled tables — plus the running header and footer.
 * Geometry stays with every block, so a positioned writer (PowerPoint) can use it too.
 */

export type Box = [number, number, number, number]

export interface ParagraphBlock {
  kind: 'paragraph'
  box: Box
  runs: StyleRun[]
  rtl: boolean
  alignment: Alignment
  /** 1–3 for headings (by size across the document), 0 for body text. */
  heading: 0 | 1 | 2 | 3
  /** A list item: its marker is removed from the runs. */
  list: 'bullet' | 'number' | null
  /** The number text of a numbered item ("3.", "٣)"), kept as printed. */
  marker: string
  /** Distance between baselines as a multiple of the size (1.2 is single). */
  lineHeight: number
  /** First line indented past the others (points; negative for a hanging indent). */
  firstIndent: number
}

export interface PictureBlock {
  kind: 'picture'
  box: Box
  png: Uint8Array
  /** Pixels of the picture itself. */
  width: number
  height: number
}

export interface TableCell {
  paragraphs: ParagraphBlock[]
  /** Lines in the cell the file maps to nothing, as pictures of the page (§68). */
  pictures: PictureBlock[]
  /** Columns this cell spans. */
  span: number
}

export interface TableBlock {
  kind: 'table'
  box: Box
  /** Column widths in points. */
  columns: number[]
  /** Row heights in points, as ruled in the PDF. */
  rowHeights: number[]
  rows: TableCell[][]
  rtl: boolean
}

export type Block = ParagraphBlock | PictureBlock | TableBlock

export interface PageModel {
  width: number
  height: number
  blocks: Block[]
  /** Mostly Arabic: columns are read right to left, and the page is an RTL page. */
  rtl: boolean
}

export interface DocModel {
  pages: PageModel[]
  /** Text repeated at the top / bottom of most pages; `{page}` where the page number was. */
  header: string | null
  footer: string | null
  /** The most common text size: body text. */
  bodySize: number
}

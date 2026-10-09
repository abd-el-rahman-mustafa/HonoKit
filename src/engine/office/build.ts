import { pageGeometry } from '../render'
import { free, mupdf, type PdfDoc } from '../mupdf'
import { paragraphs, styledLines, type Paragraph, type StyledLine, type StyleRun } from '../paragraphs'
import { foldString, UNMAPPED, unreadable, withoutUnmapped } from '../text'
import type { Block, Box, DocModel, PageModel, ParagraphBlock, PictureBlock, TableBlock, TableCell } from './model'

/**
 * PDF pages → the Office model (docs/research-pdf-to-office.md §6.2, phase A): lines with
 * their style runs (paragraphs.ts), running headers and footers found across pages, ruled
 * tables from the page's lines, pictures, paragraphs with headings and list items, and the
 * reading order by cutting the page into bands and columns (X-Y cut; columns right to left
 * on Arabic pages).
 */

export interface BuildOptions {
  pages?: number[]
  /** Remove tatweel used to stretch words (a Word paragraph justifies itself). */
  removeTatweel: boolean
  digits: 'keep' | 'western' | 'arabic'
}

interface Extras {
  pictures: PictureBlock[]
  segments: { h: Array<{ y: number; x0: number; x1: number }>; v: Array<{ x: number; y0: number; y1: number }> }
}

/** Pictures and ruled lines of a page (MuPDF's walker, which gives both with their boxes). */
function extras(doc: PdfDoc, pageIndex: number): Extras {
  const page = doc.loadPage(pageIndex)
  const stext = page.toStructuredText('preserve-images,vectors')
  const out: Extras = { pictures: [], segments: { h: [], v: [] } }
  try {
    stext.walk({
      onImageBlock(bbox: mupdf.Rect, _m: mupdf.Matrix, image: mupdf.Image) {
        const w = bbox[2] - bbox[0]
        const h = bbox[3] - bbox[1]
        if (w < 6 || h < 6) return
        try {
          const pixmap = image.toPixmap()
          const png = pixmap.asPNG()
          out.pictures.push({ kind: 'picture', box: [bbox[0], bbox[1], bbox[2], bbox[3]], png, width: pixmap.getWidth(), height: pixmap.getHeight() })
          free(pixmap)
        } catch {
          /* a picture MuPDF cannot decode is left out */
        }
      },
      onVector(bbox: mupdf.Rect, flags: { isStroked: boolean; isRectangle: boolean }) {
        const [x0, y0, x1, y1] = bbox
        const w = x1 - x0
        const h = y1 - y0
        if (h <= 2.5 && w >= 8) out.segments.h.push({ y: (y0 + y1) / 2, x0, x1 })
        else if (w <= 2.5 && h >= 8) out.segments.v.push({ x: (x0 + x1) / 2, y0, y1 })
        else if (flags.isStroked && flags.isRectangle && w >= 8 && h >= 8) {
          out.segments.h.push({ y: y0, x0, x1 }, { y: y1, x0, x1 })
          out.segments.v.push({ x: x0, y0, y1 }, { x: x1, y0, y1 })
        }
      }
    })
  } finally {
    free(stext, page)
  }
  return out
}

/**
 * A line kept as a picture rather than text (§68): most of its letters map to nothing (a font
 * without a usable ToUnicode map), or a whole word does — dropping it would lose the word (a
 * fuel price whose grade name is unmapped, in a business newspaper). A lone U+FFFD is only left out of the text.
 */
const pictureLine = (text: string): boolean => unreadable(text) || text.includes(UNMAPPED + UNMAPPED)

/** Such lines grouped where they touch: a masthead of several lines is one area. */
function unreadableAreas(lines: StyledLine[]): Box[] {
  const areas: Array<{ box: Box; size: number }> = []
  for (const l of lines) {
    const box: Box = [...l.box]
    // Absorb every area this line reaches (and areas it joins together).
    for (let i = areas.length - 1; i >= 0; i--) {
      const a = areas[i]!
      const gap = Math.max(a.size, l.size) * 0.6
      if (box[0] <= a.box[2] + gap && a.box[0] <= box[2] + gap && box[1] <= a.box[3] + gap && a.box[1] <= box[3] + gap) {
        box[0] = Math.min(box[0], a.box[0])
        box[1] = Math.min(box[1], a.box[1])
        box[2] = Math.max(box[2], a.box[2])
        box[3] = Math.max(box[3], a.box[3])
        areas.splice(i, 1)
      }
    }
    areas.push({ box, size: l.size })
  }
  return areas.map((a) => a.box)
}

/**
 * The page as drawn inside a box (216 dpi, more for tiny print): what an unreadable line looks
 * like (§68). `clip` bounds it: the page, or a table cell inside its rules.
 */
type Crop = (box: Box, clip: Box) => PictureBlock | null

function cropPicture(doc: PdfDoc, pageIndex: number, box: Box, clip: Box): PictureBlock | null {
  const pad = 1.5
  const b: Box = [Math.max(clip[0], box[0] - pad), Math.max(clip[1], box[1] - pad), Math.min(clip[2], box[2] + pad), Math.min(clip[3], box[3] + pad)]
  if (b[2] - b[0] < 2 || b[3] - b[1] < 2) return null
  const s = Math.min(8, Math.max(3, 40 / (b[3] - b[1])))
  const page = doc.loadPage(pageIndex)
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [Math.floor(b[0] * s), Math.floor(b[1] * s), Math.ceil(b[2] * s), Math.ceil(b[3] * s)], false)
  const device = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pixmap)
  try {
    pixmap.clear(255)
    page.run(device, mupdf.Matrix.identity)
    device.close()
    return { kind: 'picture', box: b, png: pixmap.asPNG(), width: pixmap.getWidth(), height: pixmap.getHeight() }
  } catch {
    return null
  } finally {
    free(device, pixmap, page)
  }
}

/** Values within `tolerance` of each other, as one (their mean), sorted. */
function cluster(values: number[], tolerance = 2): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[][] = []
  for (const v of sorted) {
    const last = out[out.length - 1]
    if (last && v - last[last.length - 1]! <= tolerance) last.push(v)
    else out.push([v])
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
}

interface Grid {
  box: Box
  xs: number[]
  ys: number[]
  v: Array<{ x: number; y0: number; y1: number }>
}

/** Ruled tables: horizontal and vertical rules that cross each other and enclose at least 2 × 2 cells. */
function findGrids(segments: Extras['segments']): Grid[] {
  const { h, v } = segments
  const parent = [...h.map((_, i) => i), ...v.map((_, i) => h.length + i)]
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)))
  const t = 2
  h.forEach((a, i) =>
    v.forEach((b, j) => {
      if (b.x >= a.x0 - t && b.x <= a.x1 + t && a.y >= b.y0 - t && a.y <= b.y1 + t) parent[root(i)] = root(h.length + j)
    })
  )
  const groups = new Map<number, { h: typeof h; v: typeof v }>()
  h.forEach((a, i) => {
    const g = groups.get(root(i)) ?? { h: [], v: [] }
    g.h.push(a)
    groups.set(root(i), g)
  })
  v.forEach((b, j) => {
    const g = groups.get(root(h.length + j)) ?? { h: [], v: [] }
    g.v.push(b)
    groups.set(root(h.length + j), g)
  })
  const grids: Grid[] = []
  for (const g of groups.values()) {
    const ys = cluster(g.h.map((s) => s.y))
    const xs = cluster(g.v.map((s) => s.x))
    if (ys.length < 3 || xs.length < 3) continue
    grids.push({ box: [xs[0]!, ys[0]!, xs[xs.length - 1]!, ys[ys.length - 1]!], xs, ys, v: g.v })
  }
  return grids
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/g
const LATIN = /[A-Za-zÀ-ɏ]/g
const arabicCount = (s: string): number => s.match(ARABIC)?.length ?? 0
const latinCount = (s: string): number => s.match(LATIN)?.length ?? 0

function normalise(text: string, options: BuildOptions): string {
  // A stray letter the file maps to nothing (U+FFFD) is not text (§68).
  let t = withoutUnmapped(text).normalize('NFKC')
  if (options.removeTatweel) t = t.replace(/ـ+/g, '')
  if (options.digits === 'western') t = t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  else if (options.digits === 'arabic') t = t.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)))
  return t
}

const sameStyle = (a: StyleRun, b: StyleRun): boolean =>
  a.bold === b.bold && a.italic === b.italic && Math.abs(a.size - b.size) < 0.6 && a.family === b.family && a.kind === b.kind && a.colour.every((v, i) => Math.abs(v - b.colour[i]!) < 0.02)

const BULLET = /^([•▪◦‣●○■□·\-–*➢➤✓])\s*/u
const NUMBER = /^(\(?(?:\d{1,3}|[٠-٩]{1,3}|[a-zA-Z])[.)\-])\s+/u

/** Each line starting with a bullet or a number begins its own paragraph (a list item). */
function splitAtMarkers(p: Paragraph): Paragraph[] {
  const starts = p.lines.map((l, i) => i === 0 || BULLET.test(l.text) || NUMBER.test(l.text))
  if (starts.filter(Boolean).length <= 1) return [p]
  const out: Paragraph[] = []
  p.lines.forEach((line, i) => {
    if (starts[i]) out.push({ ...p, lines: [line], text: line.text, box: [...line.box], firstStart: line.start, restStart: line.start })
    else {
      const cur = out[out.length - 1]!
      cur.lines.push(line)
      cur.text += ` ${line.text}`
      cur.box = [Math.min(cur.box[0], line.box[0]), Math.min(cur.box[1], line.box[1]), Math.max(cur.box[2], line.box[2]), Math.max(cur.box[3], line.box[3])]
      cur.restStart = line.start
    }
  })
  return out
}

function paragraphBlock(p: Paragraph, options: BuildOptions): ParagraphBlock {
  const runs: StyleRun[] = []
  p.lines.forEach((line, i) => {
    const next = p.lines[i + 1]
    const lineRuns = line.runs.map((r) => ({ ...r }))
    const last = lineRuns[lineRuns.length - 1]
    // A Latin word broken with a hyphen at the line's end is joined again.
    const hyphen = !!next && !line.rtl && !!last && /[a-z]-$/.test(last.text) && /^[a-z]/.test(next.text)
    if (last) last.text = hyphen ? last.text.slice(0, -1) : last.text + (next ? ' ' : '')
    for (const r of lineRuns) {
      const prev = runs[runs.length - 1]
      if (prev && sameStyle(prev, r)) prev.text += r.text
      else runs.push(r)
    }
  })
  for (const r of runs) r.text = normalise(r.text, options)
  let list: ParagraphBlock['list'] = null
  let marker = ''
  const first = runs[0]
  if (first) {
    const b = BULLET.exec(first.text)
    const n = b ? null : NUMBER.exec(first.text)
    if (b) {
      list = 'bullet'
      first.text = first.text.slice(b[0].length)
    } else if (n && p.lines.length >= 1 && first.text.length > n[0].length) {
      list = 'number'
      marker = n[1]!
      first.text = first.text.slice(n[0].length)
    }
  }
  const size = p.style.size
  const indent = p.style.rtl ? p.restStart - p.firstStart : p.firstStart - p.restStart
  return {
    kind: 'paragraph',
    box: p.box,
    runs: runs.filter((r) => r.text.length > 0),
    rtl: p.style.rtl,
    alignment: p.alignment,
    heading: 0,
    list,
    marker,
    lineHeight: p.lines.length > 1 ? p.pitch / size : 1.2,
    firstIndent: Math.abs(indent) > 2 ? indent : 0
  }
}

/** `unmapped`: the table's lines kept as pictures (§68), cropped cell by cell inside the rules. */
function tableBlock(grid: Grid, lines: StyledLine[], unmapped: StyledLine[], crop: Crop, options: BuildOptions): TableBlock {
  const { xs, ys } = grid
  const rows: TableCell[][] = []
  const inCell = (l: StyledLine, r: number, c0: number, c1: number): boolean => {
    const cx = (l.box[0] + l.box[2]) / 2
    const cy = (l.box[1] + l.box[3]) / 2
    return cx >= xs[c0]! && cx <= xs[c1]! && cy >= ys[r]! && cy <= ys[r + 1]!
  }
  for (let r = 0; r + 1 < ys.length; r++) {
    const mid = (ys[r]! + ys[r + 1]!) / 2
    const row: TableCell[] = []
    for (let c = 0; c + 1 < xs.length; ) {
      // Where no rule separates two cells of this row, they are one cell spanning both.
      let end = c + 1
      while (end + 1 < xs.length && !grid.v.some((s) => Math.abs(s.x - xs[end]!) <= 2 && s.y0 - 2 <= mid && s.y1 + 2 >= mid)) end++
      const cellLines = lines.filter((l) => inCell(l, r, c, end))
      // Inside the cell's rules (a rule is about a point wide), so the crop shows none of them.
      const inside: Box = [xs[c]! + 1, ys[r]! + 1, xs[end]! - 1, ys[r + 1]! - 1]
      const pictures = unreadableAreas(unmapped.filter((l) => inCell(l, r, c, end)))
        .map((area) => crop(area, inside))
        .filter((p): p is PictureBlock => p !== null)
      row.push({ paragraphs: paragraphs(cellLines).map((p) => paragraphBlock(p, options)), pictures, span: end - c })
      c = end
    }
    rows.push(row)
  }
  const text = lines.map((l) => l.text).join(' ')
  const rtl = arabicCount(text) > latinCount(text)
  const columns = xs.slice(1).map((x, i) => x - xs[i]!)
  const rowHeights = ys.slice(1).map((y, i) => y - ys[i]!)
  // Word lays out an RTL table's first column on the right: give it the cells right to left.
  return rtl ? { kind: 'table', box: grid.box, columns: columns.reverse(), rowHeights, rows: rows.map((row) => [...row].reverse()), rtl } : { kind: 'table', box: grid.box, columns, rowHeights, rows, rtl }
}

/** Reading order: cut into columns where a gutter runs the whole height, else into bands; recurse. */
function readingOrder(blocks: Block[], rtl: boolean, pageWidth: number): Block[] {
  if (blocks.length <= 1) return blocks
  const byLeft = [...blocks].sort((a, b) => a.box[0] - b.box[0])
  const columns: Block[][] = []
  let right = -Infinity
  for (const b of byLeft) {
    if (columns.length && b.box[0] < right + 8) {
      columns[columns.length - 1]!.push(b)
      right = Math.max(right, b.box[2])
    } else {
      columns.push([b])
      right = b.box[2]
    }
  }
  // Real columns are wide; a narrow strip (labels beside values) is read across instead.
  if (columns.length > 1 && columns.every((c) => Math.max(...c.map((b) => b.box[2])) - Math.min(...c.map((b) => b.box[0])) > pageWidth * 0.18)) {
    return (rtl ? columns.reverse() : columns).flatMap((c) => readingOrder(c, rtl, pageWidth))
  }
  const byTop = [...blocks].sort((a, b) => a.box[1] - b.box[1])
  const bands: Block[][] = []
  let bottom = -Infinity
  for (const b of byTop) {
    if (bands.length && b.box[1] < bottom + 1) {
      bands[bands.length - 1]!.push(b)
      bottom = Math.max(bottom, b.box[3])
    } else {
      bands.push([b])
      bottom = b.box[3]
    }
  }
  if (bands.length > 1) return bands.flatMap((b) => readingOrder(b, rtl, pageWidth))
  // Neither cuts: side by side in reading direction, top to bottom.
  return byTop.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < 4 ? (rtl ? b.box[2] - a.box[2] : a.box[0] - b.box[0]) : 0))
}

/** "Page 3 of 10" → "page # of #": the same running line on every page, whatever its numbers. */
const runningKey = (text: string): string => foldString(text).replace(/[0-9٠-٩]+/g, '#').replace(/\s+/g, ' ').trim()

export function buildModel(doc: PdfDoc, options: BuildOptions): DocModel {
  const count = doc.countPages()
  const targets = options.pages ?? Array.from({ length: count }, (_, i) => i)
  const pageLines = targets.map((p) => {
    const all = styledLines(doc, p).filter((l) => l.horizontal)
    // Lines the file maps to nothing are left out of the text and come back as pictures (§68).
    return { index: p, geometry: pageGeometry(doc, p), lines: all.filter((l) => !pictureLine(l.text)), unreadable: all.filter((l) => pictureLine(l.text)) }
  })

  // Running headers and footers: the same text in the top or bottom tenth of most pages.
  const seen = new Map<string, number>()
  for (const pl of pageLines) {
    const keys = new Set(pl.lines.filter((l) => l.box[3] < pl.geometry.height * 0.1 || l.box[1] > pl.geometry.height * 0.9).map((l) => `${l.box[1] < pl.geometry.height / 2 ? 'top' : 'bottom'}|${runningKey(l.text)}`))
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const needed = Math.max(2, Math.ceil(targets.length * 0.6))
  const running = new Set([...seen].filter(([k, n]) => n >= needed && k.split('|')[1]).map(([k]) => k))
  let header: string | null = null
  let footer: string | null = null

  const pages: PageModel[] = pageLines.map((pl) => {
    const { width, height } = pl.geometry
    const kept: StyledLine[] = []
    for (const l of pl.lines) {
      const band = l.box[3] < height * 0.1 ? 'top' : l.box[1] > height * 0.9 ? 'bottom' : null
      if (band && running.has(`${band}|${runningKey(l.text)}`)) {
        // The page's own number in it becomes a page-number field.
        const n = String(pl.index + 1)
        const text = withoutUnmapped(l.text).replace(new RegExp(`(?<![0-9])${n}(?![0-9])`), '{page}')
        if (band === 'top') header ??= text
        else footer ??= text
        continue
      }
      kept.push(l)
    }
    const { pictures, segments } = extras(doc, pl.index)
    const crop: Crop = (box, clip) => cropPicture(doc, pl.index, box, clip)
    const grids = findGrids(segments)
    const tables: TableBlock[] = []
    let flowing = kept
    let unmapped = pl.unreadable
    for (const grid of grids) {
      const inside = (l: StyledLine): boolean => {
        const cx = (l.box[0] + l.box[2]) / 2
        const cy = (l.box[1] + l.box[3]) / 2
        return cx >= grid.box[0] && cx <= grid.box[2] && cy >= grid.box[1] && cy <= grid.box[3]
      }
      const cellLines = flowing.filter(inside)
      const cellUnmapped = unmapped.filter(inside)
      if (cellLines.length + cellUnmapped.length === 0) continue
      tables.push(tableBlock(grid, cellLines, cellUnmapped, crop, options))
      flowing = flowing.filter((l) => !inside(l))
      unmapped = unmapped.filter((l) => !inside(l))
    }
    const text = kept.map((l) => l.text).join(' ')
    const rtl = arabicCount(text) > latinCount(text)
    // A picture covering most of a page that has text is a background or a scan under its text: left out.
    const shownPictures = pictures.filter((p) => {
      const area = ((p.box[2] - p.box[0]) * (p.box[3] - p.box[1])) / (width * height)
      const inTable = tables.some((t) => p.box[0] >= t.box[0] - 1 && p.box[2] <= t.box[2] + 1 && p.box[1] >= t.box[1] - 1 && p.box[3] <= t.box[3] + 1)
      return !inTable && !(area > 0.6 && kept.length > 3)
    })
    // Unreadable lines outside tables (§68), after that filter: a page all in such a font is a large crop, not a background.
    for (const area of unreadableAreas(unmapped)) {
      const picture = crop(area, [0, 0, width, height])
      if (picture) shownPictures.push(picture)
    }
    const blocks: Block[] = [...paragraphs(flowing).flatMap(splitAtMarkers).map((p) => paragraphBlock(p, options)), ...tables, ...shownPictures]
    return { width, height, rtl, blocks: readingOrder(blocks, rtl, width) }
  })

  // Headings: bigger than body text; the biggest sizes are the higher levels.
  const sizes = new Map<number, number>()
  for (const page of pages)
    for (const b of page.blocks) if (b.kind === 'paragraph') for (const r of b.runs) sizes.set(Math.round(r.size * 2) / 2, (sizes.get(Math.round(r.size * 2) / 2) ?? 0) + r.text.length)
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11
  const headingSizes = [...new Set(pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === 'paragraph' ? [mainSize(b)] : []))))].filter((s) => s >= bodySize * 1.2).sort((a, b) => b - a)
  for (const page of pages)
    for (const b of page.blocks) {
      if (b.kind !== 'paragraph' || b.list) continue
      const s = mainSize(b)
      const length = b.runs.reduce((n, r) => n + r.text.length, 0)
      if (s >= bodySize * 1.2 && length < 200) b.heading = Math.min(3, headingSizes.indexOf(s) + 1) as 1 | 2 | 3
    }
  return { pages, header, footer, bodySize }
}

/** The size most of a paragraph's letters have. */
export function mainSize(b: ParagraphBlock): number {
  const by = new Map<number, number>()
  for (const r of b.runs) by.set(Math.round(r.size * 2) / 2, (by.get(Math.round(r.size * 2) / 2) ?? 0) + r.text.length)
  return [...by].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0
}

import { detectDirection } from './bidi'
import { free, type mupdf, type PdfDoc } from './mupdf'
import { repairLigatureOrder } from './text'

/**
 * Lines of text with their style, and the paragraphs they form.
 *
 * MuPDF groups lines into blocks, but on real files it over-merges (a whole column
 * with its blank lines; a 36 pt title with 12 pt body text — measured on the owner's
 * PDFs, docs/decisions.md §27). Editing a "paragraph" that mixes a heading and body
 * text would restyle both, so paragraphs are rebuilt here from MuPDF's lines: same
 * size, same weight and direction, regular spacing, overlapping columns. A blank line,
 * a jump in spacing or a change of style ends a paragraph.
 *
 * All geometry is the page as displayed: points from the top-left.
 */

export type Box = [number, number, number, number]

/** A stretch of a line in one style: what a Word run is. */
export interface StyleRun {
  text: string
  size: number
  colour: [number, number, number]
  bold: boolean
  italic: boolean
  kind: 'serif' | 'sans' | 'mono'
  /** The font's family as named in the file, without subset tag or style ("Arial", "IBMPlexSansArabic"). */
  family: string
  /** The font exactly as named in the file, subset tag included ("USSIZV+EuclidFlex"): one font object. */
  font: string
}

export interface StyledLine {
  text: string
  /** The same text split where the style changes (logical order, spaces collapsed as in `text`). */
  runs: StyleRun[]
  box: Box
  /** Baseline y, and the x where the line starts (left for LTR, right for RTL). */
  baseline: number
  start: number
  rtl: boolean
  size: number
  colour: [number, number, number]
  bold: boolean
  italic: boolean
  kind: 'serif' | 'sans' | 'mono'
  horizontal: boolean
  /** Some letters differ from the line's main style (a bold word in a sentence). */
  mixed: boolean
  /**
   * A table-of-contents entry or a table row: dot leaders, or a tab-like jump between
   * words. Such lines are never joined into a flowing paragraph.
   */
  tabular: boolean
}

export type Alignment = 'start' | 'end' | 'centre' | 'justify'

export interface Paragraph {
  lines: StyledLine[]
  text: string
  box: Box
  /** Style of the paragraph's body (the most common among its letters). */
  style: Pick<StyledLine, 'size' | 'colour' | 'bold' | 'italic' | 'kind' | 'rtl'>
  alignment: Alignment
  /** Distance between baselines; the size × 1.2 for a single line. */
  pitch: number
  /** Start edge of the first line, of the lines after it, and the far edge of the column. */
  firstStart: number
  restStart: number
  farEdge: number
  /** Letters in a different style from the body (a bold word) — lost when retyped. */
  mixedStyles: boolean
}

function toRgb(colour: number[] | undefined): [number, number, number] {
  if (!colour || colour.length === 0) return [0, 0, 0]
  if (colour.length === 1) return [colour[0]!, colour[0]!, colour[0]!]
  if (colour.length === 4) {
    const [c, m, y, k] = colour as [number, number, number, number]
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  return [colour[0]!, colour[1]!, colour[2]!]
}

interface Glyph {
  c: string
  width: number
  box: Box
  origin: [number, number]
  family: string
  font: string
  size: number
  colour: [number, number, number]
  bold: boolean
  italic: boolean
  kind: StyledLine['kind']
}

const invisible = (g: { c: string; width: number }): boolean => g.width < 0.01 && (g.c === '�' || g.c === '​')

function mostCommon<T>(values: T[], key: (v: T) => string): T {
  const counts = new Map<string, { n: number; v: T }>()
  for (const v of values) {
    const k = key(v)
    const e = counts.get(k)
    if (e) e.n++
    else counts.set(k, { n: 1, v })
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]!.v
}

/** Every line of text on a page, with its style. Lines that are only spaces are left out. */
export function styledLines(doc: PdfDoc, pageIndex: number): StyledLine[] {
  const page = doc.loadPage(pageIndex)
  const stext = page.toStructuredText('preserve-whitespace')
  const out: StyledLine[] = []
  let glyphs: Glyph[] = []
  let horizontal = true
  try {
    stext.walk({
      beginLine(_bbox: mupdf.Rect, _wmode: number, dir: mupdf.Point) {
        glyphs = []
        horizontal = Math.abs(dir[1]) < 0.01
      },
      onChar(c: string, origin: mupdf.Point, font: mupdf.Font, size: number, quad: mupdf.Quad, colour: mupdf.Color) {
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const name = font.getName()
        glyphs.push({
          c,
          width: Math.max(...xs) - Math.min(...xs),
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          origin: [origin[0], origin[1]],
          family: familyOf(name),
          font: name,
          size,
          colour: toRgb(Array.from(colour ?? [])),
          bold: font.isBold() || /bold|black|heavy|semibold/i.test(name),
          italic: font.isItalic() || /italic|oblique/i.test(name),
          // The name wins over the font's own flags, which files often get wrong (Work Sans flagged serif).
          kind: kindOf(name, font)
        })
      },
      endLine() {
        const kept = glyphs.filter((g) => !invisible(g))
        repairLigatureOrder(kept)
        const printed = kept.filter((g) => g.c.trim() !== '')
        if (printed.length === 0) return
        const text = kept.map((g) => g.c).join('').replace(/\s+/g, ' ').trim()
        // Symbol-font bullets and the like are part of the line but not its style.
        const letters = printed.filter((g) => /\p{L}|\p{N}/u.test(g.c))
        const body = letters.length ? letters : printed
        const style = mostCommon(body, (g) => `${Math.round(g.size * 2)}|${g.bold}|${g.italic}|${g.kind}|${g.colour.map((v) => v.toFixed(2)).join(',')}`)
        const rtl = detectDirection(text) === 'rtl'
        // A jump between neighbouring glyphs much wider than a space: a tab stop or a table column.
        // Justified text spreads *every* word gap alike, so only a gap far wider than the line's
        // other word gaps counts (a narrow justified column is not a table).
        const byX = [...kept].filter((g) => g.c.trim() !== '').sort((a, b) => a.box[0] - b.box[0])
        const gaps: number[] = []
        for (let i = 1; i < byX.length; i++) {
          const gap = byX[i]!.box[0] - byX[i - 1]!.box[2]
          if (gap > style.size * 0.15) gaps.push(gap)
        }
        gaps.sort((a, b) => a - b)
        const widestGap = gaps[gaps.length - 1] ?? 0
        const typicalGap = gaps.length > 1 ? gaps[Math.floor((gaps.length - 1) / 2)]! : 0
        const tabStop = widestGap > style.size * 1.6 && (gaps.length < 2 || widestGap > typicalGap * 2.5)
        const tabular = /(\.\s?){4,}|…{2,}|_{4,}|(·\s?){3,}/.test(text) || tabStop
        const box: Box = [Math.min(...printed.map((g) => g.box[0])), Math.min(...printed.map((g) => g.box[1])), Math.max(...printed.map((g) => g.box[2])), Math.max(...printed.map((g) => g.box[3]))]
        out.push({
          text,
          runs: runsOf(kept),
          box,
          baseline: style.origin[1],
          start: rtl ? box[2] : box[0],
          rtl,
          size: style.size,
          colour: style.colour,
          bold: style.bold,
          italic: style.italic,
          kind: style.kind,
          horizontal,
          mixed: body.some((g) => g.bold !== style.bold || g.italic !== style.italic || Math.abs(g.size - style.size) > 0.6),
          tabular
        })
      }
    })
  } finally {
    free(stext, page)
  }
  return joinBullets(withoutOverprints(out.map(realSymbols)))
}

/** "ABCDEF+Arial-BoldMT", "IBMPlexSansArabic-Regular-9538" → "Arial", "IBMPlexSansArabic". */
export function familyOf(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-\d+$/, '')
    .replace(/[-,](Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Black|Heavy|Book|MT|PS|BoldMT|ItalicMT|BoldItalicMT|BoldItalic|PSMT|Thin|ExtraLight|ExtraBold)+$/i, '')
    .replace(/(MT|PSMT)$/, '')
}

/** The line's glyphs as style runs, spaces collapsed and ends trimmed as the line's text is. */
function runsOf(glyphs: Glyph[]): StyleRun[] {
  const runs: StyleRun[] = []
  let pendingSpace = false
  for (const g of glyphs) {
    if (/\s/.test(g.c)) {
      pendingSpace = runs.length > 0
      continue
    }
    const last = runs[runs.length - 1]
    const same = last && last.bold === g.bold && last.italic === g.italic && Math.abs(last.size - g.size) < 0.6 && last.kind === g.kind && last.font === g.font && last.colour.every((v, i) => Math.abs(v - g.colour[i]!) < 0.02)
    if (same) last.text += (pendingSpace ? ' ' : '') + g.c
    else {
      if (pendingSpace && last) last.text += ' '
      runs.push({ text: g.c, size: g.size, colour: g.colour, bold: g.bold, italic: g.italic, kind: g.kind, family: g.family, font: g.font })
    }
    pendingSpace = false
  }
  return runs
}

const MARKER_ONLY = /^([•▪◦‣●○■□·\-–*]|\d{1,3}[.)])$/u

/**
 * A bullet drawn as its own piece of text comes back from MuPDF as a line of its own.
 * Joined to the text beside it (same baseline, a little to its right), so the bullet
 * and its words form one line and the paragraph keeps its hanging indent.
 */
function joinBullets(lines: StyledLine[]): StyledLine[] {
  const gone = new Set<StyledLine>()
  for (const marker of lines) {
    if (!MARKER_ONLY.test(marker.text)) continue
    const text = lines.find(
      (l) =>
        l !== marker &&
        !gone.has(l) &&
        Math.abs(l.baseline - marker.baseline) < marker.size * 0.3 &&
        (marker.rtl ? marker.box[0] - l.box[2] : l.box[0] - marker.box[2]) > 0 &&
        (marker.rtl ? marker.box[0] - l.box[2] : l.box[0] - marker.box[2]) < marker.size * 3
    )
    if (!text) continue
    gone.add(marker)
    text.text = `${marker.text} ${text.text}`
    text.runs = [...marker.runs.map((r) => ({ ...r, text: `${r.text} ` })), ...text.runs]
    text.box = [Math.min(marker.box[0], text.box[0]), Math.min(marker.box[1], text.box[1]), Math.max(marker.box[2], text.box[2]), Math.max(marker.box[3], text.box[3])]
    text.start = text.rtl ? text.box[2] : text.box[0]
  }
  return lines.filter((l) => !gone.has(l))
}

const sameStyle = (a: StyledLine, b: StyledLine): boolean => Math.abs(a.size - b.size) < 0.6 && a.bold === b.bold && a.rtl === b.rtl && a.kind === b.kind

/** Groups a page's lines into paragraphs, top to bottom. */
export function paragraphs(lines: StyledLine[]): Paragraph[] {
  const sorted = [...lines].filter((l) => l.horizontal).sort((a, b) => a.baseline - b.baseline || a.box[0] - b.box[0])
  const groups: StyledLine[][] = []
  for (const line of sorted) {
    let joined = false
    // The most recent group this line can continue: directly below its last line.
    for (let g = groups.length - 1; g >= Math.max(0, groups.length - 4); g--) {
      const group = groups[g]!
      const last = group[group.length - 1]!
      const gap = line.baseline - last.baseline
      const pitch = group.length > 1 ? group[group.length - 1]!.baseline - group[group.length - 2]!.baseline : null
      const overlap = Math.min(line.box[2], last.box[2]) - Math.max(line.box[0], last.box[0])
      const regular = pitch === null ? gap > last.size * 0.9 && gap < last.size * 1.75 : Math.abs(gap - pitch) < last.size * 0.25
      // A line well short of the column ended its paragraph (the usual last line).
      const column = Math.max(...group.map((l) => l.box[2] - l.box[0]), line.box[2] - line.box[0])
      const lastWasFull = last.box[2] - last.box[0] >= column * 0.6
      const joinable = !line.tabular && !last.tabular && lastWasFull
      if (joinable && sameStyle(line, last) && regular && overlap > Math.min(line.box[2] - line.box[0], last.box[2] - last.box[0]) * 0.3) {
        group.push(line)
        joined = true
        break
      }
    }
    if (!joined) groups.push([line])
  }
  return groups.map(describe)
}

function describe(lines: StyledLine[]): Paragraph {
  const first = lines[0]!
  const rtl = mostCommon(lines, (l) => String(l.rtl)).rtl
  const body = mostCommon(lines, (l) => `${Math.round(l.size * 2)}|${l.bold}|${l.italic}|${l.kind}`)
  const box: Box = [Math.min(...lines.map((l) => l.box[0])), Math.min(...lines.map((l) => l.box[1])), Math.max(...lines.map((l) => l.box[2])), Math.max(...lines.map((l) => l.box[3]))]
  const pitches = lines.slice(1).map((l, i) => l.baseline - lines[i]!.baseline)
  const pitch = pitches.length ? pitches.sort((a, b) => a - b)[Math.floor(pitches.length / 2)]! : first.size * 1.2
  // Which edges line up decides the alignment; the last line of a paragraph is usually short.
  const starts = lines.map((l) => (rtl ? l.box[2] : l.box[0]))
  const ends = lines.map((l) => (rtl ? l.box[0] : l.box[2]))
  const tol = Math.max(2, first.size * 0.35)
  const bodyStarts = starts.slice(1)
  const startsAlign = bodyStarts.length === 0 || bodyStarts.every((s) => Math.abs(s - bodyStarts[0]!) < tol)
  const fullLines = ends.slice(0, -1)
  const endsAlign = fullLines.length > 0 && fullLines.every((e) => Math.abs(e - fullLines[0]!) < tol)
  const centres = lines.map((l) => (l.box[0] + l.box[2]) / 2)
  const centred = lines.length > 1 && centres.every((c) => Math.abs(c - centres[0]!) < tol) && !startsAlign
  let alignment: Alignment = 'start'
  if (centred) alignment = 'centre'
  else if (lines.length > 1 && startsAlign && endsAlign && lines.length > 2) alignment = 'justify'
  else if (lines.length > 1 && !startsAlign && endsAlign) alignment = 'end'
  const farEdge = rtl ? Math.min(...lines.map((l) => l.box[0])) : Math.max(...lines.map((l) => l.box[2]))
  return {
    lines,
    text: lines.map((l) => l.text).join(' '),
    box,
    style: { size: body.size, colour: body.colour, bold: body.bold, italic: body.italic, kind: body.kind, rtl },
    alignment,
    pitch,
    firstStart: starts[0]!,
    restStart: lines.length > 1 ? starts[1]! : starts[0]!,
    farEdge,
    mixedStyles: lines.some((l) => l.mixed || !sameStyle(l, body))
  }
}

/** The paragraph at a point or box on the page, or null. */
export function paragraphAt(doc: PdfDoc, pageIndex: number, box: Box): Paragraph | null {
  const all = paragraphs(styledLines(doc, pageIndex))
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  // The interface sends the exact box of the paragraph's first line: that paragraph, even where
  // others overlap it (a caption on a photo, a date line on a banner). Taking the first paragraph
  // around the point edited a neighbour instead — retyping a caption unchanged rewrote another.
  const same = (a: Box): boolean => a.every((v, i) => Math.abs(v - box[i]!) < 0.6)
  const exact = all.find((p) => same(p.lines[0]!.box)) ?? all.find((p) => p.lines.some((l) => same(l.box)))
  if (exact) return exact
  const inside = all.filter((p) => p.lines.some((l) => cx >= l.box[0] - 1 && cx <= l.box[2] + 1 && cy >= l.box[1] - 1 && cy <= l.box[3] + 1))
  // Several around the point: the one whose line is closest in size to the box given.
  const fit = (p: Paragraph): number => Math.min(...p.lines.map((l) => l.box.reduce((n, v, i) => n + Math.abs(v - box[i]!), 0)))
  if (inside.length) return inside.sort((a, b) => fit(a) - fit(b))[0]!
  // Otherwise the paragraph with the most overlap.
  const area = (p: Paragraph): number =>
    Math.max(0, Math.min(p.box[2], box[2]) - Math.max(p.box[0], box[0])) * Math.max(0, Math.min(p.box[3], box[3]) - Math.max(p.box[1], box[1]))
  const best = all.map((p) => ({ p, a: area(p) })).sort((a, b) => b.a - a.a)[0]
  return best && best.a > 0 ? best.p : null
}

/**
 * Serif, sans or mono, by the font's name first: an embedded font's own serif flag is often
 * wrong (Futura and Euclid came out serif, and were retyped in a Times look).
 */
export function kindOf(name: string, font?: { isMono(): boolean; isSerif(): boolean }): 'serif' | 'sans' | 'mono' {
  if (/courier|mono|consol/i.test(name) || font?.isMono()) return 'mono'
  if (/sans|arial|helvetica|verdana|tahoma|calibri|segoe|futura|myriad|euclid|avenir|gill|frutiger|univers|optima|franklin|\bdin|gotham|montserrat|roboto|\blato|proxima|grotesk|grotesque|trebuchet|century ?gothic|candara|corbel|aptos|\binter\b|kufi/i.test(name)) return 'sans'
  if (/times|serif|roman|georgia|garamond|century|bookman|book ?antiqua|palatino|minion|cambria|baskerville|caslon|bodoni|didot|pensum|naskh/i.test(name)) return 'serif'
  return font?.isSerif() ? 'serif' : 'sans'
}

/**
 * Drops lines drawn a second time on top of another: Arabic newspapers exported from InDesign
 * draw the end of each justified line again ("خويـــة" over "...الأخويـــة"). Read as their own
 * lines, those copies were glued into paragraphs ("البلدين، شاور") and edits wrote them twice.
 * A copy lies inside the other line's box, on its baseline, with no letters the other lacks.
 */
export function withoutOverprints<L extends { text: string; box: Box; baseline: number; size: number }>(lines: L[]): L[] {
  const letters = (t: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (const c of t.replace(/[\sـ]/g, '')) m.set(c, (m.get(c) ?? 0) + 1)
    return m
  }
  const counts = lines.map((l) => letters(l.text))
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
  const dropped = new Set<number>()
  lines.forEach((a, i) => {
    const mine = counts[i]!
    const size = total(mine)
    if (size === 0) return
    for (let j = 0; j < lines.length; j++) {
      if (j === i || dropped.has(j)) continue
      const b = lines[j]!
      const theirs = counts[j]!
      const bigger = total(theirs) > size || (total(theirs) === size && j < i)
      if (!bigger) continue
      if (Math.abs(a.baseline - b.baseline) > Math.max(0.6, a.size * 0.08) || Math.abs(a.size - b.size) > 0.6) continue
      if (a.box[0] < b.box[0] - 1.5 || a.box[2] > b.box[2] + 1.5) continue
      if ([...mine].every(([c, n]) => (theirs.get(c) ?? 0) >= n)) {
        dropped.add(i)
        return
      }
    }
  })
  return dropped.size ? lines.filter((_, i) => !dropped.has(i)) : lines
}

/**
 * The Symbol font's private-use codes for ® © ™ (Adobe's U+F8E8–F8EA sans and U+F6D9–F6DB serif
 * forms), read as the real characters: retyped as private codes no font has, "Adobe® Reader" lost
 * its ® (decisions §58).
 */
const SYMBOLS: Record<string, string> = { '\uF8E8': '\u00AE', '\uF8E9': '\u00A9', '\uF8EA': '\u2122', '\uF6DA': '\u00AE', '\uF6D9': '\u00A9', '\uF6DB': '\u2122' }
const HAS_PRIVATE = /[\uF8E8-\uF8EA\uF6D9-\uF6DB]/
const PRIVATE = /[\uF8E8-\uF8EA\uF6D9-\uF6DB]/g
function realSymbols<L extends { text: string; runs: Array<{ text: string }> }>(line: L): L {
  if (!HAS_PRIVATE.test(line.text)) return line
  const fix = (t: string): string => t.replace(PRIVATE, (c) => SYMBOLS[c] ?? c)
  return { ...line, text: fix(line.text), runs: line.runs.map((r) => ({ ...r, text: fix(r.text) })) }
}

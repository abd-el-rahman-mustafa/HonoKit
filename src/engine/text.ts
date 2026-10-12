import { free, type PdfDoc } from './mupdf'
import type { mupdf as MupdfNs } from './mupdf'

/**
 * Reading text out of a page, and searching it.
 *
 * MuPDF hands back the two letters of an Arabic ligature glyph in the wrong
 * order («عىل» for «على», «االتحاد» for «الاتحاد»). It exposes each character with
 * its width, so we repair the order here; measured against pdftotext this took
 * agreement from ~77% to 99.8% (docs/spikes.md S2, decisions §17). Do not
 * upgrade `mupdf` without re-running the check in test/text.test.ts: if MuPDF
 * fixes this itself, this swap would break correct text.
 */

export interface Glyph {
  /** The character. */
  c: string
  /** Bounding box on the page as displayed, in points, top-left origin: [x0, y0, x1, y1]. */
  box: [number, number, number, number]
  width: number
}

export interface TextLine {
  glyphs: Glyph[]
  /** The line's text in reading order. */
  text: string
  box: [number, number, number, number]
}

const ARABIC_BASE_LETTER = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/

/** Repairs ligature order in one line of glyphs, in place. */
export function repairLigatureOrder(glyphs: Array<{ c: string; width: number }>): void {
  for (let i = 0; i + 1 < glyphs.length; i++) {
    const a = glyphs[i]!
    const b = glyphs[i + 1]!
    if (a.width < 0.01 && b.width >= 0.01 && ARABIC_BASE_LETTER.test(a.c) && ARABIC_BASE_LETTER.test(b.c)) {
      glyphs[i] = b
      glyphs[i + 1] = a
      i++
    }
  }
}

export function extractLines(doc: PdfDoc, pageIndex: number): TextLine[] {
  const page = doc.loadPage(pageIndex)
  const lines: TextLine[] = []
  let current: Glyph[] = []
  let lineBox: [number, number, number, number] = [0, 0, 0, 0]
  const stext = page.toStructuredText('preserve-whitespace')
  try {
    stext.walk({
      beginLine(bbox: MupdfNs.Rect) {
        current = []
        lineBox = [bbox[0], bbox[1], bbox[2], bbox[3]]
      },
      onChar(c: string, _origin: MupdfNs.Point, _font: MupdfNs.Font, _size: number, quad: MupdfNs.Quad) {
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const x0 = Math.min(...xs)
        const x1 = Math.max(...xs)
        current.push({ c, width: x1 - x0, box: [x0, Math.min(...ys), x1, Math.max(...ys)] })
      },
      endLine() {
        // Some fonts build dotted letters from a separate dot glyph with no Unicode value (Noto Naskh
        // does); readers report it as U+FFFD or U+200B at zero width. It is not text.
        current = current.filter((g) => !(g.width < 0.01 && (g.c === '\uFFFD' || g.c === '\u200B')))
        repairLigatureOrder(current)
        lines.push({ glyphs: current, text: current.map((g) => g.c).join(''), box: lineBox })
      }
    })
  } finally {
    free(stext, page)
  }
  return lines
}

export function extractText(doc: PdfDoc, pageIndex: number): string {
  return extractLines(doc, pageIndex)
    .map((l) => l.text)
    .join('\n')
}

/** U+FFFD: a letter whose font maps it to nothing (no usable ToUnicode map), §68. */
export const UNMAPPED = String.fromCharCode(0xfffd)

/** Most of the letters have no meaning in the file: its font maps them to nothing (U+FFFD). */
export function unreadable(text: string): boolean {
  const letters = [...text.replace(/\s/g, '')]
  if (letters.length === 0) return false
  return letters.filter((c) => c === UNMAPPED).length / letters.length > 0.3
}

/** The text without letters that map to nothing, its spaces tidied where they were (§68). */
export function withoutUnmapped(text: string): string {
  return text.includes(UNMAPPED) ? text.split(UNMAPPED).join('').replace(/ {2,}/g, ' ') : text
}

// --- search -----------------------------------------------------------------

/**
 * Folds a character for comparison. Deliberately mild: it removes what readers
 * do not type (tatweel, vowel marks) and unifies the alef and yeh families, and
 * keeps everything else distinct.
 */
export function foldChar(c: string, matchCase = false): string {
  // Tatweel, vowel marks, and zero-width characters (ZWSP, ZWNJ, ZWJ, BOM).
  if (c === 'ـ' || (c >= 'ً' && c <= 'ٟ') || c === 'ٰ' || c === '​' || c === '‌' || c === '‍' || c === '﻿') return ''
  // Alef with hamza above or below, with madda, and alef wasla: all to bare alef.
  if ('أإآٱ'.includes(c)) return 'ا'
  // Alef maksura to yeh: people type either.
  if (c === 'ى') return 'ي'
  if (c === ' ') return ' '
  // Turkish dotted İ and dotless ı fold with I and i, one letter for one: toLowerCase turns İ
  // into i and a combining dot, and ı has no case pair, so "istanbul" missed "İSTANBUL".
  if (!matchCase && (c === 'İ' || c === 'ı')) return 'i'
  // Greek final sigma ς is σ at the end of a word; a capital Σ folds to σ, so "ΛΟΓΟΣ" missed "λογος".
  if (!matchCase && c === 'ς') return 'σ'
  const n = c.normalize('NFKC')
  return matchCase ? n : n.toLowerCase()
}

/** Folds a whole query: each character as foldChar, and runs of white space as one space. */
export function foldQuery(s: string, matchCase = false): string {
  return foldString(s, matchCase).replace(/\s+/g, ' ').trim()
}

export function foldString(s: string, matchCase = false): string {
  let out = ''
  for (const c of s) out += foldChar(c, matchCase)
  return out
}

/** How Find (and Replace) compares: letter case, and whether a match must be a whole word. */
export interface MatchOptions {
  matchCase?: boolean
  wholeWords?: boolean
}

const WORD = /[\p{L}\p{N}\p{M}_]/u

/**
 * Where `query` occurs in a run of characters, compared as Find compares (Arabic letter forms,
 * vowel marks and tatweel folded; case folded unless asked). `units` are the run's characters
 * (or a line's glyphs); each match is the first and last unit it covers.
 */
export function matchUnits(units: string[], query: string, options: MatchOptions = {}): Array<[number, number]> {
  const needle = foldQuery(query, options.matchCase)
  if (!needle) return []
  let folded = ''
  const owner: number[] = []
  units.forEach((u, i) => {
    const f = foldString(u, options.matchCase)
    for (let k = 0; k < f.length; k++) {
      // A run of spaces or tabs on the page reads as one space, as the query does.
      const space = /\s/.test(f[k]!)
      if (space && folded.endsWith(' ')) continue
      folded += space ? ' ' : f[k]
      owner.push(i)
    }
  })
  const out: Array<[number, number]> = []
  let from = 0
  for (;;) {
    const at = folded.indexOf(needle, from)
    if (at < 0) break
    const end = at + needle.length
    // A whole word: no letter or digit right before or after.
    const whole = !options.wholeWords || ((at === 0 || !WORD.test(folded[at - 1]!)) && (end >= folded.length || !WORD.test(folded[end]!)))
    if (whole) out.push([owner[at]!, owner[end - 1]!])
    from = whole ? end : at + 1
  }
  return out
}

export interface SearchHit {
  page: number
  /** One rectangle per line the match touches, in displayed page points. */
  boxes: Array<[number, number, number, number]>
}

export interface SearchOptions extends MatchOptions {
  /**
   * Whether a phrase may run from the end of one line onto the next line of the same text
   * (default true), as Acrobat's Find does: the line break counts as one space.
   */
  acrossLines?: boolean
}

/**
 * Whether `next` carries on the text of `prev` on the line below: the same size of type, the
 * next baseline down (not a gap between paragraphs) and the same column. This mirrors how the
 * editor groups lines into paragraphs (paragraphs.ts), so a match Find shows across a line break
 * is one Replace can change; lines side by side (columns) and rotated text are never joined.
 */
function continues(prev: TextLine, next: TextLine): boolean {
  if (!prev.glyphs.length || !next.glyphs.length) return false
  const h0 = prev.box[3] - prev.box[1]
  const h1 = next.box[3] - next.box[1]
  if (!(h0 > 0 && h1 > 0 && h0 < 72 && h1 < 72)) return false
  if (Math.abs(h0 - h1) > Math.max(h0, h1) * 0.25) return false
  const gap = next.box[3] - prev.box[3]
  if (!(gap > h0 * 0.6 && gap < h0 * 1.9)) return false
  const overlap = Math.min(prev.box[2], next.box[2]) - Math.max(prev.box[0], next.box[0])
  return overlap > Math.min(prev.box[2] - prev.box[0], next.box[2] - next.box[0]) * 0.3
}

/** The page's lines in runs that read on from one line to the next (see `continues`). */
function runsOf(lines: TextLine[], acrossLines: boolean): TextLine[][] {
  const runs: TextLine[][] = []
  for (const line of lines) {
    const run = runs[runs.length - 1]
    if (acrossLines && run && continues(run[run.length - 1]!, line)) run.push(line)
    else runs.push([line])
  }
  return runs
}

/** Finds a phrase in one page's already-extracted lines; a match may wrap onto the next line. */
export function searchLines(lines: TextLine[], needle: string, pageIndex: number, limit = 500, options: SearchOptions = {}): SearchHit[] {
  if (!foldString(needle, options.matchCase).trim()) return []
  const hits: SearchHit[] = []
  for (const run of runsOf(lines, options.acrossLines !== false)) {
    // The run's characters, its lines joined by one space; each unit's line and glyph (none for the joining space).
    const units: string[] = []
    const where: Array<[number, number] | null> = []
    run.forEach((line, li) => {
      const before = units[units.length - 1]
      const first = line.glyphs[0]?.c
      if (li > 0 && before !== undefined && first !== undefined && !/\s/.test(before) && !/\s/.test(first)) {
        units.push(' ')
        where.push(null)
      }
      line.glyphs.forEach((g, gi) => {
        units.push(g.c)
        where.push([li, gi])
      })
    })
    for (const [a, b] of matchUnits(units, needle, options)) {
      // One rectangle per line the match touches.
      const boxes = new Map<number, [number, number, number, number]>()
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) {
        const at = where[k]
        if (!at) continue
        const g = run[at[0]]!.glyphs[at[1]]!.box
        const box = boxes.get(at[0])
        boxes.set(at[0], box ? [Math.min(box[0], g[0]), Math.min(box[1], g[1]), Math.max(box[2], g[2]), Math.max(box[3], g[3])] : [g[0], g[1], g[2], g[3]])
      }
      if (!boxes.size) continue
      hits.push({ page: pageIndex, boxes: [...boxes.entries()].sort((x, y) => x[0] - y[0]).map(([, box]) => box) })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

// --- selection --------------------------------------------------------------

export type SelectUnit = 'char' | 'word' | 'line' | 'page'

export interface Selection {
  /** The selected text in reading order; lines joined by newlines. */
  text: string
  /** One box per selected line part, displayed points. */
  boxes: Array<[number, number, number, number]>
  /** The centres of the first and last selected character: the same span for markup. */
  from: [number, number]
  to: [number, number]
}

/** The line a point is on, or the nearest one within three quarters of a line height. */
function lineAt(lines: TextLine[], x: number, y: number): number {
  let best = -1
  let bestD = Infinity
  lines.forEach((l, i) => {
    if (!l.glyphs.length) return
    const h = l.box[3] - l.box[1]
    if (h > 72) return // a rotated watermark's box would swallow the page
    const dy = y < l.box[1] ? l.box[1] - y : y > l.box[3] ? y - l.box[3] : 0
    if (dy > h * 0.75) return
    // Past the end of a line still selects to its end; sideways distance only decides
    // between lines side by side (columns).
    const dx = x < l.box[0] ? l.box[0] - x : x > l.box[2] ? x - l.box[2] : 0
    const d = dy * 1000 + dx
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** The character nearest to x in a line (logical index). */
function glyphAt(line: TextLine, x: number): number {
  let best = 0
  let bestD = Infinity
  line.glyphs.forEach((g, i) => {
    if (g.width < 0.01) return
    const d = x < g.box[0] ? g.box[0] - x : x > g.box[2] ? x - g.box[2] : 0
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

const isSpace = (c: string): boolean => /\s/.test(c)

/**
 * The text between two points, as a reader's text selection takes it: from the character
 * under the first point to the one under the second, in reading order, whole lines in
 * between. Right-to-left lines work the same way, since the order is the reading order.
 * `word` and `line` widen a single point to its word or line (double and triple click).
 */
export function selectText(lines: TextLine[], from: [number, number], to: [number, number], unit: SelectUnit = 'char'): Selection | null {
  let la: number
  let lb: number
  let ga: number
  let gb: number
  if (unit === 'page') {
    // Four clicks: the page's whole text, wherever the click was (as Acrobat).
    la = lines.findIndex((l) => l.glyphs.length > 0)
    if (la < 0) return null
    lb = lines.length - 1 - [...lines].reverse().findIndex((l) => l.glyphs.length > 0)
    ga = 0
    gb = lines[lb]!.glyphs.length - 1
  } else {
    la = lineAt(lines, from[0], from[1])
    lb = lineAt(lines, to[0], to[1])
    if (la < 0 || lb < 0) return null
    ga = glyphAt(lines[la]!, from[0])
    gb = glyphAt(lines[lb]!, to[0])
  }
  if (lb < la || (la === lb && gb < ga)) {
    ;[la, lb] = [lb, la]
    ;[ga, gb] = [gb, ga]
  }
  if (unit === 'word') {
    const a = lines[la]!.glyphs
    const b = lines[lb]!.glyphs
    while (ga > 0 && !isSpace(a[ga - 1]!.c)) ga--
    while (gb + 1 < b.length && !isSpace(b[gb + 1]!.c)) gb++
  } else if (unit === 'line') {
    ga = 0
    gb = lines[lb]!.glyphs.length - 1
  }
  const parts: string[] = []
  const boxes: Selection['boxes'] = []
  let first: Glyph | null = null
  let last: Glyph | null = null
  for (let i = la; i <= lb; i++) {
    const glyphs = lines[i]!.glyphs
    const start = i === la ? ga : 0
    const end = i === lb ? gb : glyphs.length - 1
    const chosen = glyphs.slice(start, end + 1)
    if (!chosen.length) continue
    parts.push(chosen.map((g) => g.c).join(''))
    const visible = chosen.filter((g) => g.width >= 0.01)
    if (visible.length) {
      boxes.push([Math.min(...visible.map((g) => g.box[0])), lines[i]!.box[1], Math.max(...visible.map((g) => g.box[2])), lines[i]!.box[3]])
      first ??= visible[0]!
      last = visible[visible.length - 1]!
    }
  }
  if (!first || !last) return null
  const centre = (g: Glyph): [number, number] => [(g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2]
  return { text: parts.join('\n').trim(), boxes, from: centre(first), to: centre(last) }
}

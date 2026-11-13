import type { StyleRun } from '../paragraphs'
import { ARABIC, fontsFor, SCRIPTS, widthIn } from './fonts'
import type { LineBlock, ParagraphBlock } from './model'

/**
 * Text boxes that keep the PDF's lines and still re-flow when edited (decisions §118).
 *
 * Every word is measured in the installed font Office will use (`@pdf-lib/fontkit`, Arabic shaped,
 * no kerning or ligatures — Word and PowerPoint use neither by default), one letter spacing is fitted
 * to the paragraph's full lines, and the box is given a width inside the window where Office breaks
 * every line where the PDF did: wider than every line, narrower than any line plus the first word of
 * the next. Measured on 8 real PDFs: 90 % of multi-line paragraphs (research §10). A paragraph
 * with no such window (a word broken with a hyphen, lines that are a list) keeps its lines, each
 * ending in a line break.
 */

const FORMAT = /\p{Cf}/gu

/** Office's width of `text` in the run's style, in points; null when no font to measure it with. */
export function textWidth(text: string, r: Pick<StyleRun, 'family' | 'kind' | 'bold' | 'italic' | 'size'>): number | null {
  const clean = text.replace(FORMAT, '')
  if (!clean) return 0
  const fonts = fontsFor(r)
  let width = 0
  // Script by script: Arabic letters (and what lies between them) in the Arabic font, the rest in the Latin one.
  for (const piece of clean.match(SCRIPTS) ?? []) {
    const arabic = ARABIC.test(piece)
    const w = widthIn(piece, arabic ? fonts.arabic : fonts.latin, r.bold, r.italic, r.size, arabic)
    if (w === null) return null
    width += w
  }
  return width
}

interface Word {
  width: number
  /** The spaces after it (no room needed at a line's end). */
  space: number
  /** Characters, spaces included: letter spacing is added after each. */
  chars: number
  /** Width and characters up to the first place Office may break inside it (after a hyphen or dash): the whole word when none. */
  head: number
  headChars: number
}

/** Hyphens and dashes Office breaks a word after (when a letter or digit comes before them). */
const DASHES = String.fromCodePoint(0x2d, 0x2010, 0x2013, 0x2014)
const BREAK_AFTER = new RegExp(`[\\p{L}\\p{N}][${DASHES}](?=\\S)`, 'u')

/** The line's words as Office lays them out; null when a font cannot be measured. */
function wordsOf(line: LineBlock): Word[] | null {
  const words: Word[] = []
  for (const r of line.runs) {
    for (const piece of r.text.replace(FORMAT, '').split(/(?<=\s)(?=\S)/)) {
      if (!piece) continue
      const word = piece.trimEnd()
      const w = textWidth(word, r)
      const s = textWidth(piece.slice(word.length), r)
      if (w === null || s === null) return null
      const cut = BREAK_AFTER.exec(word)
      const headText = cut ? word.slice(0, cut.index + 2) : word
      const head = cut ? textWidth(headText, r) : w
      if (head === null) return null
      // A run that starts mid-word (a bold letter) joins the word before it.
      const last = words[words.length - 1]
      if (last && last.space === 0 && word) {
        if (last.head === last.width && last.headChars === last.chars) {
          last.head += head
          last.headChars += [...headText].length
        }
        last.width += w
        last.space = s
        last.chars += [...piece].length
      } else words.push({ width: w, space: s, chars: [...piece].length, head, headChars: [...headText].length })
    }
  }
  return words
}

const natural = (words: Word[], spacing: number): number => words.reduce((n, w, i) => n + w.width + spacing * w.chars + (i < words.length - 1 ? w.space : 0), 0)

export interface TextBox {
  lines: LineBlock[]
  /** The box: its left edge and width (points). */
  left: number
  width: number
  /** Office breaks the lines itself (the lines joined by spaces); else every line ends with a break. */
  wrap: boolean
  /** Letter spacing in points: one for the paragraph when wrapping, else one per line. */
  spacing: number[]
  /** The first line's start past the others' (points; negative hangs it). */
  firstIndent: number
  /** Distance between baselines. */
  pitch: number
  /** Largest letters in the box. */
  size: number
  align: 'left' | 'right' | 'centre' | 'justify'
}

const sizeOf = (lines: LineBlock[]): number => Math.max(1, ...lines.flatMap((l) => l.runs.map((r) => r.size)))

/** The edge lines start at: the left one, or the right one for right-to-left text. */
const startOf = (l: LineBlock, rtl: boolean): number => (rtl ? l.box[2] : l.box[0])

/** A paragraph's text boxes: one, or one per run of lines that start at the same place. */
export function textBoxes(b: ParagraphBlock): TextBox[] {
  const lines = b.lines.filter((l) => l.runs.length > 0)
  if (lines.length === 0) return []
  const size = sizeOf(lines)
  const tol = Math.max(2, size * 0.3)
  // Lines that start together; a first line indented or hanging from the rest stays with them.
  const groups: LineBlock[][] = []
  if (b.alignment === 'centre' || b.alignment === 'end') groups.push(lines)
  else {
    for (const line of lines) {
      const last = groups[groups.length - 1]
      const ref = last ? (last.length > 1 ? last[last.length - 1]! : last[0]!) : null
      const sameAsRef = ref && Math.abs(startOf(ref, b.rtl) - startOf(line, b.rtl)) < tol
      // The second line of a group may differ from the first (an indent); later ones must match it.
      if (last && (sameAsRef || (last.length === 1 && Math.abs(startOf(last[0]!, b.rtl) - startOf(line, b.rtl)) < size * 6))) last.push(line)
      else groups.push([line])
    }
  }
  return groups.map((g) => boxFor(b, g))
}

function boxFor(b: ParagraphBlock, lines: LineBlock[]): TextBox {
  const rtl = b.rtl
  const size = sizeOf(lines)
  const pitch = lines.length > 1 ? (lines[lines.length - 1]!.baseline - lines[0]!.baseline) / (lines.length - 1) : size * 1.2
  const align: TextBox['align'] = b.alignment === 'centre' ? 'centre' : b.alignment === 'justify' && lines.length > 1 ? 'justify' : (b.alignment === 'end') !== rtl ? 'right' : 'left'
  const printed = lines.map((l) => l.box[2] - l.box[0])
  const x0 = Math.min(...lines.map((l) => l.box[0]))
  const x1 = Math.max(...lines.map((l) => l.box[2]))
  // Offsets of each line's start from the box's start edge (the second line's, for a first-line indent).
  const ref = lines.length > 1 ? startOf(lines[1]!, rtl) : startOf(lines[0]!, rtl)
  const offsets = lines.map((l, i) => (i === 0 ? (rtl ? ref - startOf(l, rtl) : startOf(l, rtl) - ref) : 0))
  const firstIndent = Math.abs(offsets[0]!) < Math.max(1, size * 0.15) ? 0 : offsets[0]!
  const anyArabic = lines.some((l) => l.runs.some((r) => ARABIC.test(r.text)))
  const words = lines.map(wordsOf)
  const measured = words.every((w): w is Word[] => w !== null)
  // Letter spacing breaks Arabic joins: Arabic keeps none.
  const fitLine = (i: number): number => {
    const w = words[i]
    if (!w || anyArabic) return lines[i]!.runs[0]?.tracking ?? 0
    const chars = w.reduce((n, x) => n + x.chars, 0)
    if (chars < 2) return 0
    const s = (printed[i]! - natural(w, 0)) / chars
    if (Math.abs(s) < size * 0.004) return 0
    return Math.max(-size * 0.08, Math.min(size * 0.5, s))
  }
  // Lines kept with breaks still start where they did: the lines after the first sit at the paragraph's
  // indent, so a first line hanging out (a bullet typed into the text) or indented keeps its place.
  const startAligned = b.alignment === 'start' || b.alignment === 'justify'
  const keptIndent = startAligned ? firstIndent : 0
  const lineBox = (wrapWidth: number, spacing: number[]): TextBox => {
    const left = align === 'right' ? x1 - wrapWidth : align === 'centre' ? (x0 + x1) / 2 - wrapWidth / 2 : x0
    return { lines, left, width: wrapWidth, wrap: false, spacing, firstIndent: keptIndent, pitch, size, align }
  }
  if (!measured) {
    // Office's width is not known: room a good deal wider than printed, nothing wraps.
    return lineBox((x1 - x0) * 1.15 + size, lines.map((_, i) => fitLine(i)))
  }
  const ws = words as Word[][]
  const lineSpacings = lines.map((_, i) => fitLine(i))
  const noWrap = (): TextBox => {
    const widest = Math.max(...ws.map((w, i) => natural(w, lineSpacings[i]!) + Math.max(0, offsets[i]!) - (i > 0 ? Math.min(0, keptIndent) : 0)))
    return lineBox(Math.max(widest, x1 - x0) + size * 0.4, lineSpacings)
  }
  if (lines.length < 2) return noWrap()
  // A word broken at a line's end with a hyphen cannot be broken there again by Office.
  for (let i = 0; i + 1 < lines.length; i++) {
    const end = lines[i]!.runs.map((r) => r.text).join('').trimEnd()
    const next = lines[i + 1]!.runs.map((r) => r.text).join('').trimStart()
    if (/\p{L}-$/u.test(end) && /^\p{L}/u.test(next)) return noWrap()
  }
  // One spacing for the paragraph: the full lines (all but the last) as wide as printed, on average.
  const full = ws.slice(0, -1)
  const chars = full.reduce((n, w) => n + w.reduce((m, x) => m + x.chars, 0), 0)
  const fitted = anyArabic || chars === 0 ? 0 : (full.reduce((n, w, i) => n + printed[i]!, 0) - full.reduce((n, w) => n + natural(w, 0), 0)) / chars
  const candidates = [...new Set([Math.max(-size * 0.06, Math.min(size * 0.15, fitted)), 0])]
  const width = (i: number, s: number): number => natural(ws[i]!, s) + Math.max(0, offsets[i]!) - Math.min(0, firstIndent) * (i === 0 ? 0 : 1)
  for (const s of candidates) {
    const lo = Math.max(...ws.map((_, i) => width(i, s)))
    const hi = Math.min(
      ...ws.slice(0, -1).map((w, i) => {
        const next = ws[i + 1]![0]
        return width(i, s) + (w[w.length - 1]?.space ?? 0) + (next ? next.head + s * (next.headChars - 1) : 0)
      })
    )
    if (hi - lo <= 0.5) continue
    // Justified text fills its column: the printed column width when it fits the window.
    const column = Math.max(...lines.map((l, i) => l.box[2] - l.box[0] + Math.max(0, offsets[i]!) - Math.min(0, firstIndent) * (i === 0 ? 0 : 1)))
    const w = align === 'justify' && column > lo + 0.2 && column < hi - 0.2 ? column : hi - lo < size * 2 ? (lo + hi) / 2 : lo + size
    const startEdge = rtl ? Math.max(...lines.map((l, i) => l.box[2] + (i === 0 ? offsets[0]! : 0))) : Math.min(...lines.map((l, i) => l.box[0] - (i === 0 ? offsets[0]! : 0)))
    const hanging = Math.min(0, firstIndent)
    let left: number
    if (align === 'centre') left = (x0 + x1) / 2 - w / 2
    else if (align === 'right' && !rtl) left = x1 - w
    else if (align === 'left' && rtl) left = x0
    else left = rtl ? startEdge - w - hanging : startEdge + hanging
    return { lines, left, width: w, wrap: true, spacing: [s], firstIndent, pitch, size, align }
  }
  return noWrap()
}

/** The paragraph's text for a wrapping box: its lines joined with a space, in one run list. */
/**
 * A run with a link, its spaces before and after kept out of the link: PowerPoint underlines linked
 * text, and a CV's links took in the space after their icon (" ORCID").
 */
export function linkTrimmed<T extends { text: string; link?: string }>(r: T): T[] {
  if (!r.link) return [r]
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)
  if (!m || !m[2] || (!m[1] && !m[3])) return [r]
  const { link: _link, ...plain } = r
  const space = (text: string): T[] => (text ? [{ ...plain, text } as T] : [])
  return [...space(m[1]!), { ...r, text: m[2] }, ...space(m[3]!)]
}

export function joinedRuns(lines: LineBlock[]): LineBlock['runs'] {
  const out: LineBlock['runs'] = []
  lines.forEach((l, i) => {
    l.runs.forEach((r, k) => {
      const last = k === l.runs.length - 1 && i < lines.length - 1
      out.push(last && !/\s$/.test(r.text) ? { ...r, text: `${r.text} ` } : r)
    })
  })
  return out
}

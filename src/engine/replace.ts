import { PdfError } from './errors'
import { replaceText, type Box } from './edit'
import { free, openPdf } from './mupdf'
import { paragraphs, styledLines, type Paragraph } from './paragraphs'
import { matchUnits, type MatchOptions } from './text'

/**
 * Find & Replace in a document's text (docs/decisions.md §64), as Foxit's Search & Replace and
 * PDFelement's: words are matched as Find matches them, and each paragraph that holds them is
 * set again through the same checked edit as typing (replaceText): lines before and after the
 * change keep their own letters, nothing else on the page may move, and a paragraph that cannot
 * be changed safely is left as it was and reported, never forced.
 */

export interface ReplaceScope {
  /** Pages to look in (0-based); all when absent. */
  pages?: number[]
  /** Replace one occurrence only: the match Find shows at this box on this page. */
  only?: { page: number; box: Box }
}

export interface Skipped {
  page: number
  /** The start of the paragraph, to show the person which one. */
  text: string
  /** `wraps`: one occurrence that runs from one line onto the next (Find shows it; Replace leaves it). */
  reason: 'unsafe' | 'drawn' | 'unreadable' | 'vertical' | 'longer' | 'wraps' | 'other'
}

export interface ReplaceResult {
  bytes: Uint8Array
  /** Occurrences replaced, and in how many paragraphs. */
  replaced: number
  paragraphs: number
  skipped: Skipped[]
  /** Paragraphs whose words in another style (a bold word) now share one style. */
  unified: number
}

const centre = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
const inside = (p: [number, number], b: Box): boolean => p[0] >= b[0] - 0.5 && p[0] <= b[2] + 0.5 && p[1] >= b[1] - 0.5 && p[1] <= b[3] + 0.5

/** Spans of `query` in a paragraph's text (its lines joined by spaces), as string offsets. */
function spans(text: string, query: string, options: MatchOptions): Array<[number, number]> {
  const units = Array.from(text)
  // Unit index → string offset (a unit may be two UTF-16 code units).
  const offsets: number[] = []
  let o = 0
  for (const u of units) {
    offsets.push(o)
    o += u.length
  }
  offsets.push(o)
  return matchUnits(units, query, options).map(([a, b]) => [offsets[a]!, offsets[b + 1]!])
}

/**
 * Whether a span of a paragraph's text runs from one of its lines onto the next. Find shows such
 * a phrase, but Replace leaves it: the new words would have to be split
 * between two lines, which typing a line again cannot promise to do as the reader expects.
 */
function wraps(p: Paragraph, [a, b]: [number, number]): boolean {
  let start = 0
  let touched = 0
  for (const line of p.lines) {
    const end = start + line.text.length
    if (a < end && b > start) touched++
    start = end + 1
  }
  return touched > 1
}

/** The text with the given spans replaced (spans in order, not overlapping). */
function applySpans(text: string, found: Array<[number, number]>, replacement: string): string {
  let out = ''
  let at = 0
  for (const [a, b] of found) {
    out += text.slice(at, a) + replacement
    at = b
  }
  return out + text.slice(at)
}

/**
 * For "Replace" (one occurrence): which match in the paragraph is the one at `hit` — its line,
 * then its place among that line's matches in reading order.
 */
function spanAt(p: Paragraph, hit: Box, query: string, options: MatchOptions, all: Array<[number, number]>): [number, number] | null {
  const c = centre(hit)
  const lineIndex = p.lines.findIndex((l) => inside(c, l.box))
  if (lineIndex < 0) return all[0] ?? null
  // Where each line starts in the paragraph's text.
  let offset = 0
  for (let i = 0; i < lineIndex; i++) offset += p.lines[i]!.text.length + 1
  const line = p.lines[lineIndex]!
  const inLine = all.filter(([a]) => a >= offset && a < offset + line.text.length)
  if (inLine.length <= 1) return inLine[0] ?? null
  // Several on the line: the hit's position along the line picks one (right to left for Arabic).
  const share = (c[0] - line.box[0]) / Math.max(1, line.box[2] - line.box[0])
  const along = p.style.rtl ? 1 - share : share
  const index = Math.min(inLine.length - 1, Math.max(0, Math.floor(along * inLine.length)))
  return inLine[index] ?? null
}

/** Replaces `query` with `replacement` in the document's text (see the module's note). */
export async function replaceInText(
  bytes: Uint8Array,
  query: string,
  replacement: string,
  options: MatchOptions,
  scope: ReplaceScope = {},
  password?: string,
  progress?: (done: number) => void
): Promise<ReplaceResult> {
  if (!query.trim()) throw new PdfError('bad-arguments', 'Type the words to find.')
  let current = bytes
  const result: ReplaceResult = { bytes, replaced: 0, paragraphs: 0, skipped: [], unified: 0 }
  const doc = openPdf(bytes, password)
  const count = doc.countPages()
  free(doc)
  const pages = scope.only ? [scope.only.page] : (scope.pages ?? Array.from({ length: count }, (_, i) => i)).filter((i) => i >= 0 && i < count)
  for (const [n, pageIndex] of pages.entries()) {
    // The page's paragraphs as they are before this page's changes; each is then edited by its
    // first line's box, which the edits of other paragraphs do not move.
    const before = openPdf(current, password)
    let found: Paragraph[]
    try {
      found = paragraphs(styledLines(before, pageIndex))
    } finally {
      free(before)
    }
    for (const p of found) {
      const all = spans(p.text, query, options)
      if (!all.length) continue
      const left = (n: number): void => {
        for (let i = 0; i < n; i++) result.skipped.push({ page: pageIndex, text: p.text.slice(0, 80), reason: 'wraps' })
      }
      let chosen = all.filter((s) => !wraps(p, s))
      if (scope.only) {
        if (!p.lines.some((l) => inside(centre(scope.only!.box), l.box))) continue
        const one = spanAt(p, scope.only.box, query, options, all)
        if (!one) continue
        if (wraps(p, one)) {
          left(1)
          break
        }
        chosen = [one]
      } else {
        // Each occurrence across a line break is left, and counted, whatever happens to the rest.
        left(all.length - chosen.length)
        if (!chosen.length) continue
      }
      const text = applySpans(p.text, chosen, replacement)
      try {
        // The paragraph keeps to its own column and lines: new words that do not fit would run into
        // what follows (a headline onto the body, a line into the next column), so that paragraph
        // is left as it was — still listed by Find, for the person to change by hand.
        const r = await replaceText(current, pageIndex, p.lines[0]!.box, text, password, { stayInColumn: true })
        if (r.grew) {
          result.skipped.push({ page: pageIndex, text: p.text.slice(0, 80), reason: 'longer' })
          if (scope.only) break
          continue
        }
        current = r.bytes
        result.replaced += chosen.length
        result.paragraphs++
        if (r.unified) result.unified++
      } catch (error) {
        const e = error as PdfError
        const reason: Skipped['reason'] = /drawn as shapes/.test(e.message) ? 'drawn' : e.code === 'edit-unsafe' ? 'unsafe' : /cannot be read/.test(e.message) ? 'unreadable' : /horizontal/.test(e.message) ? 'vertical' : 'other'
        result.skipped.push({ page: pageIndex, text: p.text.slice(0, 80), reason })
      }
      if (scope.only) break
    }
    progress?.((n + 1) / pages.length)
    if (scope.only && result.replaced) break
  }
  result.bytes = current
  return result
}

import { foldChar, extractLines, type TextLine } from './text'
import type { PdfDoc } from './mupdf'

/**
 * Compare two documents word by word (docs/decisions.md §45): two PDFs, two texts, or a PDF
 * and a text. Each side becomes a list of words — with where they are on the page for a
 * PDF, and where they are in the text for a text — and a word diff finds what was added,
 * removed and changed.
 *
 * The diff is "patience" first (words that occur once on each side anchor the two sides to
 * each other, so moved paragraphs and long documents stay readable and fast), and a plain
 * longest-common-subsequence within the small stretches between anchors.
 */

type Box = [number, number, number, number]

export interface CompareWord {
  text: string
  /** PDF: the page, and the word's box on it. */
  page?: number
  box?: Box
  /** Text: where the word is in the text (UTF-16 offsets). */
  start?: number
  end?: number
}

export interface CompareOptions {
  /** Ignore Arabic vowel marks and tatweel, and unify alef and yeh forms (on by default). */
  ignoreMarks: boolean
  /** Ignore punctuation around words. */
  ignorePunctuation: boolean
  /** Treat Arabic-Indic and Western digits as the same. */
  sameDigits: boolean
}

export interface Change {
  kind: 'insert' | 'delete' | 'replace'
  /** Word ranges [from, to) on each side; an empty range for an insert or a delete. */
  a: [number, number]
  b: [number, number]
}

export function pdfWords(doc: PdfDoc): CompareWord[] {
  const out: CompareWord[] = []
  const pages = doc.countPages()
  for (let p = 0; p < pages; p++) {
    for (const line of readingOrder(extractLines(doc, p))) {
      let word = ''
      let box: Box | null = null
      const flush = (): void => {
        if (word && box) out.push({ text: word, page: p, box })
        word = ''
        box = null
      }
      for (const g of line.glyphs) {
        if (/\s/.test(g.c)) {
          flush()
          continue
        }
        word += g.c
        box = box ? [Math.min(box[0], g.box[0]), Math.min(box[1], g.box[1]), Math.max(box[2], g.box[2]), Math.max(box[3], g.box[3])] : [...g.box]
      }
      flush()
    }
  }
  return out
}

/**
 * A page's lines top to bottom, and side by side lines along the reading direction. The order
 * a PDF draws its text in is not the reading order — an edited heading is drawn last, after
 * the whole page — and comparing in drawing order would see it as moved. (Several columns
 * are read across for now; column detection comes with PDF → Word, docs/research-pdf-to-office.md.)
 */
function readingOrder(lines: TextLine[]): TextLine[] {
  // Diagonal watermarks and the like are not text to compare.
  const flat = lines.filter((l) => l.box[3] - l.box[1] <= 72 && l.text.trim())
  const centre = (l: TextLine): number => (l.box[1] + l.box[3]) / 2
  flat.sort((x, y) => centre(x) - centre(y))
  const out: TextLine[] = []
  for (let i = 0; i < flat.length; ) {
    const first = flat[i]!
    const band = [first]
    let j = i + 1
    while (j < flat.length && centre(flat[j]!) - centre(first) < (first.box[3] - first.box[1]) * 0.5) band.push(flat[j++]!)
    const arabic = band.reduce((n, l) => n + (l.text.match(/[؀-ۿ]/g)?.length ?? 0), 0)
    const latin = band.reduce((n, l) => n + (l.text.match(/[A-Za-z]/g)?.length ?? 0), 0)
    band.sort(arabic > latin ? (x, y) => y.box[2] - x.box[2] : (x, y) => x.box[0] - y.box[0])
    out.push(...band)
    i = j
  }
  return out
}

export function textWords(text: string): CompareWord[] {
  const out: CompareWord[] = []
  for (const m of text.matchAll(/\S+/gu)) out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length })
  return out
}

const INDIC = /[٠-٩۰-۹]/g
const PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

/** The form of a word that is compared: the options decide what does not count as a change. */
export function wordKey(word: string, options: CompareOptions): string {
  let w = word
  if (options.sameDigits) w = w.replace(INDIC, (d) => String(d.charCodeAt(0) >= 0x06f0 ? d.charCodeAt(0) - 0x06f0 : d.charCodeAt(0) - 0x0660))
  if (options.ignoreMarks) {
    let f = ''
    for (const c of w) f += foldChar(c)
    w = f
  } else w = w.normalize('NFKC').toLowerCase()
  if (options.ignorePunctuation) w = w.replace(PUNCTUATION, '')
  return w
}

/** Matched word pairs (i on side a, j on side b), in order. */
function lcsSmall(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: Array<[number, number]>): void {
  const n = a1 - a0
  const m = b1 - b0
  if (n === 0 || m === 0) return
  // Too big for a table (no anchors split it): count it all as changed.
  if (n * m > 4_000_000) return
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * w + j] = a[a0 + i] === b[b0 + j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push([a0 + i, b0 + j])
      i++
      j++
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++
    else j++
  }
}

/** Longest increasing subsequence of `seq` (by value), as indices into `seq`. */
function lis(seq: number[]): number[] {
  const tails: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]!
    tails[lo] = i
  }
  const out: number[] = []
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push(k)
  return out.reverse()
}

function patience(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: Array<[number, number]>): void {
  // Same words at both ends match directly.
  const head: Array<[number, number]> = []
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) head.push([a0++, b0++])
  const tail: Array<[number, number]> = []
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) tail.unshift([--a1, --b1])
  out.push(...head)
  if (a0 < a1 && b0 < b1) {
    // Words that occur exactly once on each side of this stretch.
    const count = new Map<string, { a: number; b: number; ai: number; bi: number }>()
    for (let i = a0; i < a1; i++) {
      const c = count.get(a[i]!) ?? { a: 0, b: 0, ai: i, bi: -1 }
      c.a++
      c.ai = i
      count.set(a[i]!, c)
    }
    for (let j = b0; j < b1; j++) {
      const c = count.get(b[j]!)
      if (c) {
        c.b++
        c.bi = j
      }
    }
    const unique = [...count.values()].filter((c) => c.a === 1 && c.b === 1).sort((x, y) => x.ai - y.ai)
    const anchors = lis(unique.map((u) => u.bi)).map((k) => unique[k]!)
    if (anchors.length === 0) lcsSmall(a, b, a0, a1, b0, b1, out)
    else {
      let pa = a0
      let pb = b0
      for (const anchor of anchors) {
        patience(a, b, pa, anchor.ai, pb, anchor.bi, out)
        out.push([anchor.ai, anchor.bi])
        pa = anchor.ai + 1
        pb = anchor.bi + 1
      }
      patience(a, b, pa, a1, pb, b1, out)
    }
  }
  out.push(...tail)
}

/** The changes between two word lists, compared by `key`. */
export function diffWords(a: CompareWord[], b: CompareWord[], options: CompareOptions): Change[] {
  const ka = a.map((w) => wordKey(w.text, options))
  const kb = b.map((w) => wordKey(w.text, options))
  // Words that vanish under the options (a lone punctuation mark) are never a change by themselves.
  const matches: Array<[number, number]> = []
  patience(ka, kb, 0, ka.length, 0, kb.length, matches)
  const changes: Change[] = []
  let i = 0
  let j = 0
  const gap = (i1: number, j1: number): void => {
    const onlyEmptyA = ka.slice(i, i1).every((k) => k === '')
    const onlyEmptyB = kb.slice(j, j1).every((k) => k === '')
    if (i1 > i || j1 > j) {
      if (!(onlyEmptyA && onlyEmptyB)) changes.push({ kind: i1 === i ? 'insert' : j1 === j ? 'delete' : 'replace', a: [i, i1], b: [j, j1] })
    }
  }
  for (const [mi, mj] of matches) {
    gap(mi, mj)
    i = mi + 1
    j = mj + 1
  }
  gap(ka.length, kb.length)
  return joinRewrites(changes, a, b, ka)
}

/** The most equal words, each this short at most, that two changes may lie apart and still be one. */
const BRIDGE_WORDS = 2
const BRIDGE_LETTERS = 3

/**
 * One rewritten sentence is one change. A diff matches whatever it can, so a short common word that
 * both versions happen to use ("in", "the", "في") splits a rewritten sentence into two changes
 * around it (found in the phone test, decisions §82). Changes with only one or two such short
 * words between them are joined, those words included; a longer word, or three words, keeps them
 * apart. Never across a page.
 */
function joinRewrites(changes: Change[], a: CompareWord[], b: CompareWord[], ka: string[]): Change[] {
  const out: Change[] = []
  for (const c of changes) {
    const last = out[out.length - 1]
    const between = last ? c.a[0] - last.a[1] : -1
    const bridge =
      last &&
      between >= 1 &&
      between <= BRIDGE_WORDS &&
      c.b[0] - last.b[1] === between &&
      ka.slice(last.a[1], c.a[0]).every((k) => k.length > 0 && [...k].length <= BRIDGE_LETTERS) &&
      samePage(a, last.a[0], c.a[1]) &&
      samePage(b, last.b[0], c.b[1])
    if (bridge) out[out.length - 1] = { kind: 'replace', a: [last.a[0], c.a[1]], b: [last.b[0], c.b[1]] }
    else out.push(c)
  }
  return out
}

/** True when the words from..to (exclusive) are on one page (always, for a text). */
function samePage(words: CompareWord[], from: number, to: number): boolean {
  const pages = new Set(words.slice(from, to).map((w) => w.page))
  return pages.size <= 1
}

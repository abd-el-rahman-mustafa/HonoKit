import bidiFactory from 'bidi-js'

/**
 * Splitting one line of mixed Arabic/Latin/number text into runs that can be
 * shaped separately and laid out left to right.
 *
 * Why this exists: fontkit shapes Arabic correctly but flips a whole line as
 * right-to-left, so digits and Latin words inside an Arabic sentence come out
 * reversed («28» drawn as «82»). Docs/spikes.md S4. Here the Unicode
 * bidirectional algorithm (bidi-js) decides direction per character; each run
 * of one direction is then shaped on its own.
 */

const bidi = bidiFactory()

export type Direction = 'ltr' | 'rtl'

export interface Run {
  /**
   * Logical text of the run. In a right-to-left run, brackets and other mirrored
   * characters are already swapped for their mirror image: fontkit reverses the
   * glyph order of Arabic but does not mirror, so «(سري)» would otherwise draw as
   * «)سري(». (bidi-js's getMirroredCharactersMap returned an empty map here, so
   * the per-character lookup is used.)
   */
  text: string
  rtl: boolean
  /** True when the run contains Arabic-script letters, so it needs the Arabic font. */
  arabic: boolean
  /** Where its characters are in the text (UTF-16 indices, ascending): for text in several styles (§65). */
  indices: number[]
}

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/
const STRONG_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/
const STRONG_LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/

export function detectDirection(text: string): Direction {
  for (const c of text) {
    if (STRONG_RTL.test(c)) return 'rtl'
    if (STRONG_LTR.test(c)) return 'ltr'
  }
  return 'ltr'
}

export function hasArabic(text: string): boolean {
  return ARABIC_SCRIPT.test(text)
}

/**
 * Runs in visual (left-to-right) order. Each run's `text` is in logical order,
 * which is what a shaping engine expects; only the order of the runs is visual.
 */
export function visualRuns(text: string, base: Direction = detectDirection(text)): Run[] {
  if (text.length === 0) return []
  const levelsResult = bidi.getEmbeddingLevels(text, base)
  const { levels } = levelsResult
  const order = bidi.getReorderedIndices(text, levelsResult)

  const runs: Run[] = []
  let indices: number[] = []
  let rtl = false
  const flush = (): void => {
    if (indices.length === 0) return
    const logical = [...indices].sort((a, b) => a - b)
    const s = logical.map((i) => (rtl ? (bidi.getMirroredCharacter(text[i]!) ?? text[i]!) : text[i]!)).join('')
    runs.push({ text: s, rtl, arabic: hasArabic(s), indices: logical })
    indices = []
  }
  for (const i of order) {
    const isRtl = levels[i]! % 2 === 1
    if (indices.length > 0 && isRtl !== rtl) flush()
    rtl = isRtl
    indices.push(i)
  }
  flush()
  return runs
}

/** Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) for a string of Western digits. */
export function toArabicIndic(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)))
}

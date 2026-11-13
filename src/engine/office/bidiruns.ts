import type { StyleRun } from '../paragraphs'
import { ltrIslands, resolveKinds } from '../readorder'

/**
 * A paragraph's runs cut where the reading direction changes, each piece marked right to left or
 * not — what Word's w:rtl on a run means: the punctuation and spaces in it take that direction.
 * Word set w:rtl only on runs with Arabic letters, so a "·" between an English and an Arabic
 * heading went with the English words and moved to the far end.
 *
 * In a right-to-left paragraph, a stretch that reads left to right with punctuation or numbers
 * inside ("INV-2026-000024", "billing@example.ae", "AB-CDE3NV") is put between
 * LEFT-TO-RIGHT EMBEDDING and POP DIRECTIONAL FORMATTING (U+202A, U+202C): the bidi algorithm
 * alone splits it at the hyphen before a number, and PowerPoint moved "3NV" and ".ae" around.
 */

const LRE = '\u202A'
/** LEFT-TO-RIGHT MARK: after an Arabic word in a left-to-right line, keeps the punctuation after it with the Latin text. */
const LRM = String.fromCharCode(0x200e)
const PDF = '\u202C'

export type DirectedRun = StyleRun & { rtl: boolean }

export function directedRuns(runs: StyleRun[], rtl: boolean): DirectedRun[] {
  const chars: Array<{ c: string; run: number }> = []
  runs.forEach((r, i) => {
    for (const c of r.text) chars.push({ c, run: i })
  })
  if (chars.length === 0) return []
  const kinds = resolveKinds(chars.map((x) => x.c))
  const flags: boolean[] = new Array(chars.length).fill(rtl)
  const opens = new Set<number>()
  const closes = new Set<number>()
  if (rtl) {
    for (const [a, b] of ltrIslands(chars.map((x, i) => ({ t: kinds[i]!, c: x.c })))) {
      for (let i = a; i <= b; i++) flags[i] = false
      const mixed = kinds.slice(a, b + 1).some((k) => k === 'N') || (kinds.slice(a, b + 1).includes('L') && kinds.slice(a, b + 1).includes('EN'))
      if (mixed) {
        opens.add(a)
        closes.add(b)
      }
    }
  } else {
    // Arabic stretches, with what lies between their letters (numbers kept), read right to left.
    let i = 0
    while (i < kinds.length) {
      if (kinds[i] !== 'R') {
        i++
        continue
      }
      let end = i
      for (let j = i + 1; j < kinds.length && kinds[j] !== 'L'; j++) if (kinds[j] === 'R') end = j
      for (let k = i; k <= end; k++) flags[k] = true
      i = end + 1
    }
  }
  const out: DirectedRun[] = []
  chars.forEach((x, i) => {
    // PowerPoint took the Arabic comma after "مصر" in "مصر ، Cairo" with the Arabic word, before it.
    const mark = !rtl && i > 0 && flags[i - 1] && !flags[i] ? LRM : ''
    const text = mark + (opens.has(i) ? LRE : '') + x.c + (closes.has(i) ? PDF : '')
    const last = out[out.length - 1]
    const lastRun = i > 0 ? chars[i - 1]!.run : -1
    if (last && lastRun === x.run && last.rtl === flags[i] && !opens.has(i)) last.text += text
    else out.push({ ...runs[x.run]!, text, rtl: flags[i]! })
  })
  return out
}

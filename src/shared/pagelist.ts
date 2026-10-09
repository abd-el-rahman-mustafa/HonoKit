/**
 * Page lists as people type them: "1-3, 5, 8-" (8 to the end), "-4" (1 to 4).
 * Accepts Arabic-Indic and Eastern Arabic digits, the Arabic comma «،», semicolons,
 * spaces, and the en dash. Returns zero-based pages in the order given, without
 * duplicates, or null when the text is not a page list.
 */
export function parsePageList(text: string, pageCount: number): number[] | null {
  const normal = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[–—−]/g, '-')
    .replace(/[،;]/g, ',')
    // "1 - 3" is one range, not 1, everything, 3.
    .replace(/\s*-\s*/g, '-')
    .trim()
  if (!normal) return null
  const out: number[] = []
  const seen = new Set<number>()
  for (const raw of normal.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d*)-(\d*)$/.exec(raw) ?? /^(\d+)()$/.exec(raw)
    if (!m) return null
    const single = !raw.includes('-')
    const from = m[1] ? Number(m[1]) : 1
    const to = single ? from : m[2] ? Number(m[2]) : pageCount
    if (from < 1 || to > pageCount || from > to) return null
    for (let p = from; p <= to; p++) {
      if (!seen.has(p - 1)) {
        seen.add(p - 1)
        out.push(p - 1)
      }
    }
  }
  return out.length ? out : null
}

/**
 * Ranges for "split by ranges": each range stays a separate part. Ranges are separated by
 * commas, semicolons, new lines or plain spaces ("1-3 5-7" is two parts); spaces around a dash
 * belong to the range ("1 - 3" is one).
 */
export function parseRanges(text: string, pageCount: number): Array<[number, number]> | null {
  const parts = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .split(/[,،;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return null
  const ranges: Array<[number, number]> = []
  for (const part of parts) {
    const pages = parsePageList(part, pageCount)
    if (!pages) return null
    ranges.push([Math.min(...pages), Math.max(...pages)])
  }
  return ranges
}

/**
 * Choosing pages on a grid of thumbnails, as Explorer and Acrobat do: a plain click picks one
 * page; Ctrl, or the page's checkbox, adds or removes it; Shift picks the run from the last
 * page clicked (the anchor); Ctrl+Shift, or Shift on a checkbox, adds that run.
 */
export type PickHow = 'only' | 'toggle' | 'range' | 'addRange'

export function pickHow(keys: { shiftKey: boolean; ctrlKey: boolean; metaKey?: boolean }, checkbox = false): PickHow {
  const add = keys.ctrlKey || !!keys.metaKey || checkbox
  if (keys.shiftKey) return add ? 'addRange' : 'range'
  return add ? 'toggle' : 'only'
}

/** The selection after picking page `index`; sorted, no repeats. The anchor moves only on single picks. */
export function pickPages(selected: number[], anchor: number | null, index: number, how: PickHow): { selected: number[]; anchor: number | null } {
  const sorted = (pages: number[]): number[] => [...new Set(pages)].sort((a, b) => a - b)
  const run = (from: number): number[] => Array.from({ length: Math.abs(index - from) + 1 }, (_, k) => Math.min(from, index) + k)
  switch (how) {
    case 'only':
      return { selected: [index], anchor: index }
    case 'toggle':
      return { selected: sorted(selected.includes(index) ? selected.filter((p) => p !== index) : [...selected, index]), anchor: index }
    case 'range':
      return anchor === null ? { selected: [index], anchor: index } : { selected: run(anchor), anchor }
    case 'addRange':
      return { selected: sorted([...selected, ...run(anchor ?? index)]), anchor: anchor ?? index }
  }
}

/** What a page's menu acts on: every selected page when the page is one of them, otherwise that page alone. */
export function menuTargets(selected: number[], index: number): number[] {
  return selected.includes(index) ? [...selected].sort((a, b) => a - b) : [index]
}

/**
 * Replace pages: the pages of the other file that replace `targets`, one after another from
 * `start` (zero-based); null when the other file has too few pages.
 */
export function replacementPages(targets: number[], start: number, otherCount: number): number[] | null {
  if (!Number.isInteger(start) || start < 0 || start + targets.length > otherCount) return null
  return targets.map((_, k) => start + k)
}

/** Zero-based pages back into the short form: [0,1,2,4,7,8,9] → "1-3, 5, 8-10". */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(i === j ? `${sorted[i]! + 1}` : `${sorted[i]! + 1}-${sorted[j]! + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

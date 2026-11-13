/**
 * A line's letters in reading order, from where they sit on the page (docs/research-pdf-to-office.md
 * §5.1). MuPDF hands letters over in drawing order with right-to-left runs reversed, which is
 * logical only when the producer drew each run in logical order: a line mixing Arabic with Latin
 * words or numbers came out with its Arabic words reversed ("له ،للشركة محادثة برنامج" for
 * "برنامج محادثة للشركة، له"), and "(5%)" as ")5%(". So the letters are put left to right by
 * position, and the visual order is turned back into logical order (the inverse of the Unicode
 * bidi algorithm for one level of embedding, which is what print has): an Arabic line is
 * reversed, then every run of Latin letters and numbers in it is put back; a Latin line has
 * each Arabic run reversed (its numbers kept left to right). Brackets in Arabic runs are mirrored.
 *
 * Also, from the same positions: letters spaced out for effect ("D E P L O Y M E N T") lose the
 * spaces MuPDF put between them and keep the spacing as a measure; symbol-font bullets (private
 * codes such as U+F0B7) become real bullet characters.
 */

export type Box = [number, number, number, number]

export interface Placed {
  c: string
  width: number
  box: Box
  size: number
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const LETTER = /\p{L}/u
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/
/** Terminators that join an adjacent number (UAX #9 W5): "5%", "$10", "+971". */
const TERMINATOR = /[%\u066A\u2030\u2031#$\u00A2-\u00A5\u20A0-\u20CF\u00B0+\u2212\u00B1]/
/** Separators that join two numbers around them (W4): "1,200", "2026/11", "12:30", "3.5". */
const SEPARATOR = /[.,:/\u060C\u066B\u066C-]/
const MARK = /\p{M}/u
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '\u00AB': '\u00BB', '\u00BB': '\u00AB', '\u2039': '\u203A', '\u203A': '\u2039' }

const OPENING = '([{'
const CLOSING = ')]}'

/** Symbol and Wingdings private codes used as list bullets, as the characters they draw. */
const SYMBOL_BULLETS: Record<string, string> = {
  '\uF0B7': '\u2022',
  '\uF0A7': '\u25AA',
  '\uF06C': '\u25CF',
  '\uF06E': '\u25A0',
  '\uF0A8': '\u25CB',
  '\uF071': '\u2751',
  '\uF076': '\u2756',
  '\uF0D8': '\u27A2',
  '\uF0E8': '\u2794',
  '\uF0FC': '\u2713',
  '\uF0D2': '\u2022',
  '\uF02D': '\u2013'
}
const SYMBOL_PRIVATE = /^[\uF020-\uF0FF]$/

export type Kind = 'R' | 'L' | 'EN' | 'N'

function kindOf(c: string): Kind {
  if (RTL.test(c) && (LETTER.test(c) || MARK.test(c))) return 'R'
  if (DIGIT.test(c)) return 'EN'
  if (LETTER.test(c)) return 'L'
  return 'N'
}

/**
 * Letters that belong together, in MuPDF's order: a base letter with the marks drawn over it
 * (harakat, shadda) and the extra letters of a ligature glyph (lam-alef: the second letter comes
 * at zero width). A cluster keeps its inner order whatever happens to the line.
 */
export function clustersOf<G extends Placed>(glyphs: G[]): G[][] {
  const out: G[][] = []
  for (const g of glyphs) {
    const prev = out[out.length - 1]
    const base = prev?.[0]
    const riding = (MARK.test(g.c) || g.width < 0.01) && g.c.trim() !== ''
    const over = base && g.box[0] < base.box[2] + base.size * 0.3 && g.box[2] > base.box[0] - base.size * 0.3
    if (prev && riding && over) prev.push(g)
    else out.push([g])
  }
  return out
}

const centre = <G extends Placed>(k: G[]): number => {
  const widest = k.reduce((a, b) => (b.width > a.width ? b : a), k[0]!)
  return (widest.box[0] + widest.box[2]) / 2
}
const left = <G extends Placed>(k: G[]): number => Math.min(...k.map((g) => g.box[0]))
const right = <G extends Placed>(k: G[]): number => Math.max(...k.map((g) => g.box[2]))
const blank = <G extends Placed>(k: G[]): boolean => k.every((g) => g.c.trim() === '')

export interface Ordered<G> {
  glyphs: G[]
  rtl: boolean
  /** Letter spacing added for effect, in points (0 for ordinary text). */
  tracking: number
}

/**
 * The line in reading order. `glyphs` are copied where a character changes (a mirrored bracket,
 * a symbol bullet), so the caller's objects stay as they were.
 */
export function readingOrder<G extends Placed>(clusters: G[][]): Ordered<G> {
  // Left to right as drawn.
  let visual = clusters.map((k, i) => ({ k, i, x: centre(k) })).sort((a, b) => a.x - b.x || a.i - b.i).map((e) => e.k)

  // Letter-spaced text: a space (MuPDF's, from the gap) between nearly every two letters.
  let tracking = 0
  const printed = visual.filter((k) => !blank(k))
  if (printed.length >= 5) {
    const size = printed.map((k) => k[0]!.size).sort((a, b) => a - b)[Math.floor(printed.length / 2)]!
    const gaps: number[] = []
    let spaced = 0
    let pairs = 0
    // Letters with nothing between them yet apart (MuPDF adds no space for a small gap): letter-spaced too.
    let apart = 0
    for (let i = 0, prev = -1; i < visual.length; i++) {
      if (blank(visual[i]!)) continue
      if (prev >= 0) {
        pairs++
        const gap = left(visual[i]!) - right(visual[prev]!)
        if (i - prev > 1) spaced++
        else if (gap > size * 0.1) apart++
        gaps.push(gap)
      }
      prev = i
    }
    const sorted = [...gaps].sort((a, b) => a - b)
    const typical = sorted[Math.floor(sorted.length / 2)]!
    if (pairs > 0 && ((spaced / pairs > 0.6 && typical > size * 0.12) || apart / pairs > 0.6)) {
      tracking = typical
      // A word space is wider than the letter gap by about a space's width.
      visual = visual.filter((k, i) => {
        if (!blank(k)) return true
        const before = visual.slice(0, i).reverse().find((x) => !blank(x))
        const after = visual.slice(i + 1).find((x) => !blank(x))
        if (!before || !after) return false
        return left(after) - right(before) > typical + size * 0.18
      })
    }
  }

  // A word gap with no space in the file (a justified line set with positioned words: "TaughtAdvanced"
  // in a CV): a gap wider than a tenth of the letters' size is a space. Kerning moves letters a few
  // hundredths; joined Arabic letters have none.
  if (tracking === 0) {
    const spaced: G[][] = []
    for (const k of visual) {
      const prev = spaced[spaced.length - 1]
      if (prev && !blank(prev) && !blank(k)) {
        const gap = left(k) - right(prev)
        const g = prev[0]!
        if (gap > Math.max(g.size, k[0]!.size) * 0.1) spaced.push([{ ...g, c: ' ', width: gap, box: [right(prev), g.box[1], left(k), g.box[3]] }])
      }
      spaced.push(k)
    }
    visual = spaced
  }

  const kinds = visual.map((k) => kindOf(k[0]!.c))
  const strongR = kinds.filter((k) => k === 'R').length
  const strongL = kinds.filter((k) => k === 'L').length
  const rtl = strongR > strongL

  const resolved = resolveKinds(visual.map((k) => k[0]!.c))

  /** Reverses the stretches of `seq` (by kind) that start and end with a kind in `inner`, neutrals between included. */
  const reverseRuns = (seq: Array<{ k: G[]; t: Kind }>, inner: Kind[], stop: Kind[]): Array<{ k: G[]; t: Kind }> => {
    const out = [...seq]
    let i = 0
    while (i < out.length) {
      if (!inner.includes(out[i]!.t)) {
        i++
        continue
      }
      let end = i
      for (let j = i + 1; j < out.length; j++) {
        if (stop.includes(out[j]!.t)) break
        if (inner.includes(out[j]!.t)) end = j
      }
      const run = out.slice(i, end + 1).reverse()
      out.splice(i, run.length, ...run)
      i = end + 1
    }
    return out
  }

  let seq = visual.map((k, i) => ({ k, t: resolved[i]! }))
  const mirrored = new Set<G[]>()
  /**
   * Brackets right to left, as drawn (`drawn`, left to right), to be mirrored back — unless the file
   * already has them as read: a bracket pair whose left one is a closing bracket (Chrome writes the
   * character, not the shape drawn: "(5%)" in an Arabic line came out ")5%(").
   */
  const mirror = (drawn: Array<G[]>): void => {
    const brackets = drawn.filter((k) => OPENING.includes(k[0]!.c) || CLOSING.includes(k[0]!.c))
    const asRead = brackets.some((k) => OPENING.includes(k[0]!.c)) && CLOSING.includes(brackets[0]?.[0]!.c ?? '')
    if (!asRead) for (const k of drawn) mirrored.add(k)
  }
  if (rtl) {
    seq.reverse()
    // Latin words and numbers read left to right inside the Arabic line; brackets outside them are mirrored back.
    const islands = ltrIslands(seq.map((e) => ({ t: e.t, c: e.k[0]!.c })))
    const inside = new Set<number>()
    for (const [a, b] of islands) {
      const run = seq.slice(a, b + 1).reverse()
      seq.splice(a, run.length, ...run)
      for (let i = a; i <= b; i++) inside.add(i)
    }
    const outside = new Set(seq.filter((e, i) => e.t === 'N' && !inside.has(i)).map((e) => e.k))
    mirror(visual.filter((k) => outside.has(k)))
  } else {
    // Arabic runs inside a Latin line read right to left; their numbers stay left to right.
    const out: typeof seq = []
    let i = 0
    while (i < seq.length) {
      if (seq[i]!.t !== 'R') {
        out.push(seq[i]!)
        i++
        continue
      }
      let end = i
      for (let j = i + 1; j < seq.length; j++) {
        if (seq[j]!.t === 'L') break
        if (seq[j]!.t === 'R') end = j
      }
      const drawn = seq.slice(i, end + 1)
      mirror(drawn.filter((e) => e.t === 'N').map((e) => e.k))
      let run = [...drawn].reverse()
      run = reverseRuns(run, ['EN'], ['R', 'L', 'N'])
      out.push(...run)
      i = end + 1
    }
    seq = out
  }

  const glyphs: G[] = []
  let first = true
  for (const { k } of seq) {
    for (const g of k) {
      let c = g.c
      if (mirrored.has(k) && MIRROR[c]) c = MIRROR[c]!
      if (SYMBOL_BULLETS[c]) c = SYMBOL_BULLETS[c]!
      else if (first && SYMBOL_PRIVATE.test(c)) c = '\u2022'
      glyphs.push(c === g.c ? g : { ...g, c })
      if (c.trim()) first = false
    }
  }
  return { glyphs, rtl, tracking }
}

/**
 * Stretches of a right-to-left line (in logical order, or reversed: the rule is symmetric) that
 * read left to right: Latin words with the spaces and punctuation between them, numbers. Two
 * numbers apart (a date range "2032 – 2033", "09 مارس") are two stretches, as the bidi algorithm
 * has it; a number next to a word ("Office 2016", "TEST-INV-2026-000024") stays with it.
 * Inclusive index pairs.
 */
export function ltrIslands(items: Array<{ t: Kind; c: string }>): Array<[number, number]> {
  const strong = (t: Kind): boolean => t === 'L' || t === 'EN'
  /** The word around `k` has no letters (a number with its signs). */
  const numeric = (k: number): boolean => {
    for (let i = k; i >= 0 && items[i]!.c.trim() !== '' && items[i]!.t !== 'R'; i--) if (items[i]!.t === 'L') return false
    for (let i = k; i < items.length && items[i]!.c.trim() !== '' && items[i]!.t !== 'R'; i++) if (items[i]!.t === 'L') return false
    return true
  }
  const out: Array<[number, number]> = []
  let i = 0
  while (i < items.length) {
    if (!strong(items[i]!.t)) {
      i++
      continue
    }
    let end = i
    for (let j = i + 1; j < items.length; j++) {
      const t = items[j]!.t
      if (t === 'R') break
      if (!strong(t)) continue
      const gap = items.slice(end + 1, j)
      if (gap.length && numeric(end) && numeric(j) && !(gap.length === 1 && SEPARATOR.test(gap[0]!.c))) break
      end = j
    }
    out.push([i, end])
    i = end + 1
  }
  return out
}

/** Each character's kind, numbers taking their terminators and inner separators (UAX #9 W4, W5). */
export function resolveKinds(chars: string[]): Kind[] {
  const kinds = chars.map(kindOf)
  const resolved = [...kinds]
  for (let i = 0; i < resolved.length; i++)
    if (resolved[i] === 'N' && SEPARATOR.test(chars[i]!) && resolved[i - 1] === 'EN' && kinds[i + 1] === 'EN') resolved[i] = 'EN'
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < resolved.length; i++)
      if (resolved[i] === 'N' && TERMINATOR.test(chars[i]!) && (resolved[i - 1] === 'EN' || resolved[i + 1] === 'EN')) resolved[i] = 'EN'
  return resolved
}

/**
 * A line MuPDF read as one across a wide gap — a label and its value, the cells of a table row
 * ("Hosting · الاستضافة" and its decision) — cut into its pieces, by the rule `lineOf` uses to
 * call a line tabular: a gap far wider than a word space. Glyphs keep MuPDF's order in each piece.
 */
export function splitAtGaps<G extends Placed>(glyphs: G[]): G[][] {
  const printed = glyphs.filter((g) => g.c.trim() !== '').sort((a, b) => a.box[0] - b.box[0])
  if (printed.length < 2) return [glyphs]
  const size = printed.map((g) => g.size).sort((a, b) => a - b)[Math.floor(printed.length / 2)]!
  const gaps: Array<{ at: number; gap: number }> = []
  for (let i = 1; i < printed.length; i++) {
    const gap = printed[i]!.box[0] - Math.max(...printed.slice(0, i).map((g) => g.box[2]))
    if (gap > size * 0.15) gaps.push({ at: printed[i]!.box[0] - gap / 2, gap })
  }
  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b)
  const typical = sorted.length > 1 ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0
  const cuts = gaps.filter((g) => g.gap > size * 1.6 && (sorted.length < 2 || g.gap > typical * 2.5)).map((g) => g.at)
  if (cuts.length === 0) return [glyphs]
  const pieces: G[][] = cuts.map(() => []).concat([[]])
  for (const g of glyphs) {
    const x = (g.box[0] + g.box[2]) / 2
    pieces[cuts.filter((c) => c < x).length]!.push(g)
  }
  return pieces.filter((p) => p.some((g) => g.c.trim() !== ''))
}

/**
 * MuPDF splits a line where the script changes ("…في Microsoft …" came back as three lines).
 * Pieces on one baseline that touch (a word space apart at most) are one line again.
 * `pieces` carry their glyphs in MuPDF's order; the result keeps the first piece's order of appearance.
 */
export function joinPieces<G extends Placed & { origin: [number, number] }>(pieces: G[][]): G[][] {
  type Piece = { glyphs: G[]; baseline: number; size: number; box: Box }
  const info = (glyphs: G[]): Piece => {
    const printed = glyphs.filter((g) => g.c.trim() !== '')
    const ref = printed.length ? printed : glyphs
    const sizes = ref.map((g) => g.size).sort((a, b) => a - b)
    const ys = ref.map((g) => g.origin[1]).sort((a, b) => a - b)
    return {
      glyphs,
      baseline: ys[Math.floor(ys.length / 2)]!,
      size: sizes[Math.floor(sizes.length / 2)]!,
      box: [Math.min(...ref.map((g) => g.box[0])), Math.min(...ref.map((g) => g.box[1])), Math.max(...ref.map((g) => g.box[2])), Math.max(...ref.map((g) => g.box[3]))]
    }
  }
  const lines: Piece[] = []
  for (const glyphs of pieces) {
    if (glyphs.length === 0) continue
    const p = info(glyphs)
    const into = lines.find((l) => {
      const size = Math.min(l.size, p.size)
      if (Math.abs(l.baseline - p.baseline) > size * 0.25) return false
      const gap = Math.max(p.box[0] - l.box[2], l.box[0] - p.box[2])
      return gap < size * 0.45 && gap > -size * 0.5
    })
    if (!into) {
      lines.push(p)
      continue
    }
    const merged = info([...into.glyphs, ...p.glyphs])
    Object.assign(into, merged)
  }
  return lines.map((l) => l.glyphs)
}

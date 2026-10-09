/**
 * Text in several styles inside one paragraph (docs/decisions.md §65): a bold word, a red figure,
 * a larger first word. The layout code works on plain strings (words joined by spaces); styles
 * ride along as invisible markers — Unicode noncharacters U+FDD0…U+FDEF, which never occur in real
 * text (unlike private-use codes, which symbol fonts use) — one before each word and at each change
 * of style, so any word or line taken from the string knows its own style.
 */

/** How a stretch differs from the paragraph's body style. Absent fields: as the body. */
export interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  colour?: [number, number, number]
  size?: number
  /** A font installed on this PC. */
  family?: string
  /** The exact font object this stretch had in the file (subset tag included), to reuse it (§59). */
  font?: string
}

/** A stretch of the text (UTF-16 offsets, end exclusive) in a style. */
export interface StyledSpan {
  start: number
  end: number
  style: RunStyle
}

const FIRST = 0xfdd0
export const MAX_STYLES = 32
const MARKER = /[﷐-﷯]/g

export const markerOf = (index: number): string => String.fromCharCode(FIRST + Math.min(index, MAX_STYLES - 1))
export const isMarker = (c: string): boolean => c.length === 1 && c.charCodeAt(0) >= FIRST && c.charCodeAt(0) < FIRST + MAX_STYLES

/** The text without its style markers. */
export const plainText = (s: string): string => s.replace(MARKER, '')

/** A marked string split into its stretches, in logical order: text and style index (0 = body). */
export function segments(marked: string): Array<{ text: string; style: number }> {
  const out: Array<{ text: string; style: number }> = []
  let style = 0
  let text = ''
  for (const c of marked) {
    if (isMarker(c)) {
      if (text) out.push({ text, style })
      text = ''
      style = c.charCodeAt(0) - FIRST
      continue
    }
    text += c
  }
  if (text) out.push({ text, style })
  return out
}

/** The text and, for each UTF-16 unit, its style index. */
export function unmark(marked: string): { text: string; styles: number[] } {
  let text = ''
  const styles: number[] = []
  let style = 0
  for (const c of marked) {
    if (isMarker(c)) {
      style = c.charCodeAt(0) - FIRST
      continue
    }
    text += c
    for (let k = 0; k < c.length; k++) styles.push(style)
  }
  return { text, styles }
}

/**
 * `text` with markers: before every word and wherever the style changes. Whitespace takes no marker
 * (a space belongs to the stretch before it).
 */
export function mark(text: string, styles: number[]): string {
  let out = ''
  let prev = -1
  let afterSpace = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const space = /\s/.test(c)
    const s = styles[i] ?? 0
    if (!space && (afterSpace || s !== prev)) {
      out += markerOf(s)
      prev = s
    }
    out += c
    afterSpace = space
  }
  return out
}

// A stated "not bold" is not the body's unstated weight: in a bold paragraph it is a change.
const sameStyle = (a: RunStyle, b: RunStyle): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  (a.size ?? 0) === (b.size ?? 0) &&
  (a.family ?? '') === (b.family ?? '') &&
  (a.font ?? '') === (b.font ?? '') &&
  (a.colour ?? []).join() === (b.colour ?? []).join()

/** A list of distinct styles (index 0 the body: no change) and each UTF-16 unit's index in it. */
export function paletteOf(text: string, spans: StyledSpan[]): { palette: RunStyle[]; styles: number[] } {
  const palette: RunStyle[] = [{}]
  const styles = new Array<number>(text.length).fill(0)
  for (const span of spans) {
    if (!Object.keys(span.style).length) continue
    let index = palette.findIndex((p) => sameStyle(p, span.style))
    if (index < 0) {
      // More styles than markers: the rest are drawn in the body style.
      if (palette.length >= MAX_STYLES) continue
      index = palette.push(span.style) - 1
    }
    for (let i = Math.max(0, span.start); i < Math.min(text.length, span.end); i++) styles[i] = index
  }
  return { palette, styles }
}

/** Per-unit styles back to spans (consecutive units in one style merged). */
export function spansOf(styles: Array<RunStyle | null>): StyledSpan[] {
  const out: StyledSpan[] = []
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i]
    if (!s || !Object.keys(s).length) continue
    const last = out[out.length - 1]
    if (last && last.end === i && sameStyle(last.style, s)) last.end = i + 1
    else out.push({ start: i, end: i + 1, style: s })
  }
  return out
}

/**
 * The old text's styles carried to the new text (a plain retype, Find & Replace): what is
 * unchanged at the start and at the end keeps its style; new words in between take the style of
 * the letter they replace (the first letter of the changed stretch), so a bold word replaced by
 * another stays bold.
 */
export function carryStyles(oldText: string, oldStyles: Array<RunStyle | null>, newText: string): Array<RunStyle | null> {
  let head = 0
  while (head < oldText.length && head < newText.length && oldText[head] === newText[head]) head++
  let tail = 0
  while (tail < oldText.length - head && tail < newText.length - head && oldText[oldText.length - 1 - tail] === newText[newText.length - 1 - tail]) tail++
  const out: Array<RunStyle | null> = new Array(newText.length).fill(null)
  for (let i = 0; i < head; i++) out[i] = oldStyles[i] ?? null
  for (let i = 0; i < tail; i++) out[newText.length - 1 - i] = oldStyles[oldText.length - 1 - i] ?? null
  // The changed stretch: the style of what it replaced (or, for a pure insertion, of the letter before it).
  const replaced = head < oldText.length - tail ? (oldStyles[head] ?? null) : head > 0 ? (oldStyles[head - 1] ?? null) : (oldStyles[head] ?? null)
  for (let i = head; i < newText.length - tail; i++) out[i] = replaced
  return out
}

export const hasStyles = (spans: StyledSpan[] | undefined): boolean => !!spans?.some((s) => Object.keys(s.style).length > 0)

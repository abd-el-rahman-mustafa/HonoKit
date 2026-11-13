import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { mupdf } from '../mupdf'
import type { StyleRun } from '../paragraphs'
import { systemFonts } from '../systemFonts'

/**
 * Which installed fonts the Office file names (research §5.2): the PDF's own family when this PC
 * has it installed (decisions §118: a CV set in Calibri stays Calibri, an Arabic page in Dubai stays
 * Dubai); else the installed font whose letters are as wide as the PDF's (learnFallbacks: IBM Plex
 * Serif is far wider than Times New Roman, and its text stretched with letter spacing looked
 * spaced out); else one Windows and Office have of the same kind. The Latin family goes in
 * w:ascii / w:hAnsi (a:latin) and the Arabic one in w:cs (a:cs), so each script takes its own font;
 * an installed family is used for a script only when it has that script's letters.
 */

const LATIN: Record<string, string> = {
  arial: 'Arial',
  helvetica: 'Arial',
  timesnewroman: 'Times New Roman',
  times: 'Times New Roman',
  calibri: 'Calibri',
  cambria: 'Cambria',
  tahoma: 'Tahoma',
  segoeui: 'Segoe UI',
  verdana: 'Verdana',
  georgia: 'Georgia',
  garamond: 'Garamond',
  couriernew: 'Courier New',
  courier: 'Courier New',
  consolas: 'Consolas',
  trebuchetms: 'Trebuchet MS',
  century: 'Century',
  bookantiqua: 'Book Antiqua',
  palatinolinotype: 'Palatino Linotype'
}

/** Families with the very widths of a Windows font (the PDF base 14): never swapped for a closer one. */
const SAME_WIDTHS = new Set(['arial', 'helvetica', 'timesnewroman', 'times', 'couriernew', 'courier', 'arialmt', 'timesnewromanpsmt', 'couriernewpsmt'])

const ARABIC_FAMILIES: Record<string, string> = {
  arial: 'Arial',
  tahoma: 'Tahoma',
  segoeui: 'Segoe UI',
  simplifiedarabic: 'Simplified Arabic',
  traditionalarabic: 'Traditional Arabic',
  sakkalmajalla: 'Sakkal Majalla',
  dubai: 'Dubai',
  notonaskharabic: 'Noto Naskh Arabic',
  notosansarabic: 'Noto Sans Arabic',
  amiri: 'Amiri',
  ibmplexsansarabic: 'IBM Plex Sans Arabic',
  arabictypesetting: 'Arabic Typesetting',
  andalus: 'Andalus',
  aldhabi: 'Aldhabi',
  timesnewroman: 'Times New Roman'
}

/** Arabic letters, by code point (no invisible characters in the source). */
const LETTERS = [
  [0x600, 0x6ff],
  [0x750, 0x77f],
  [0x8a0, 0x8ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff]
]
  .map(([a, b]) => `${String.fromCodePoint(a!)}-${String.fromCodePoint(b!)}`)
  .join('')
export const ARABIC = new RegExp(`[${LETTERS}]`)
/** Arabic stretches (with the spaces and Arabic punctuation between their words) and the rest. */
export const SCRIPTS = new RegExp(`[${LETTERS}]+(?:[\\s${String.fromCodePoint(0x60c, 0x61b, 0x61f)}]+[${LETTERS}]+)*|[^${LETTERS}]+`, 'g')

/** Fonts every Windows with Office has, by kind: the ones a family not installed may become. */
const CANDIDATES: Record<StyleRun['kind'], string[]> = {
  serif: ['Times New Roman', 'Georgia', 'Cambria', 'Book Antiqua', 'Palatino Linotype', 'Garamond', 'Constantia'],
  sans: ['Arial', 'Calibri', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Arial Narrow', 'Corbel', 'Candara'],
  mono: ['Courier New', 'Consolas', 'Lucida Console']
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const keyOf = (family: string): string => compact(family).replace(/(regular|bold|italic|semibold|medium|light|black)+$/, '')

/** Installed families by compact name, and which scripts each has letters for. */
let installed: Map<string, { family: string; latin: boolean; arabic: boolean } | null> | null = null

function installedFamily(name: string): { family: string; latin: boolean; arabic: boolean } | null {
  installed ??= new Map()
  const key = keyOf(name)
  if (!key) return null
  const known = installed.get(key)
  if (known !== undefined) return known
  let found: { family: string; latin: boolean; arabic: boolean } | null = null
  try {
    for (const f of systemFonts().values()) {
      if (compact(f.family) !== key) continue
      const file = f.files.regular ?? f.files.bold ?? f.files.italic ?? f.files.bolditalic
      if (!file) continue
      const font = fontkit.create(readFileSync(file))
      found = { family: f.family, latin: font.hasGlyphForCodePoint(0x61), arabic: font.hasGlyphForCodePoint(0x627) }
      break
    }
  } catch {
    found = null
  }
  installed.set(key, found)
  return found
}

/** Stand-ins chosen by width for this document's families (learnFallbacks): Latin, and Arabic. */
const learned = new Map<string, string>()
const learnedArabic = new Map<string, string>()

/**
 * Fonts whose letters sit at private codes: Office draws Unicode text in them as other signs (a "®"
 * in Symbol came out "→"). The text read from them is Unicode already (readorder.ts), so it takes
 * an ordinary font.
 */
const SYMBOL_FONTS = /^(symbol|wingdings|webdings|zapfdingbats|dingbats|mtextra|marlett)/

export function fontsFor(r: Pick<StyleRun, 'family' | 'kind'>): { latin: string; arabic: string } {
  const key = compact(r.family)
  const known = (table: Record<string, string>): string | undefined => table[key] ?? Object.entries(table).find(([k]) => key.startsWith(k))?.[1]
  const own = SYMBOL_FONTS.test(key) ? null : installedFamily(r.family)
  const latin = (own?.latin ? own.family : undefined) ?? learned.get(keyOf(r.family)) ?? known(LATIN) ?? defaultLatin(r.kind)
  // Naskh-like Arabic (serif) reads best in Simplified Arabic; everything else in Arial, which every Windows has.
  const arabic = (own?.arabic ? own.family : undefined) ?? learnedArabic.get(keyOf(r.family)) ?? known(ARABIC_FAMILIES) ?? (r.kind === 'serif' ? 'Simplified Arabic' : 'Arial')
  return { latin, arabic }
}

const defaultLatin = (kind: StyleRun['kind']): string => (kind === 'serif' ? 'Times New Roman' : kind === 'mono' ? 'Courier New' : 'Arial')

type Font = ReturnType<typeof fontkit.create>
const loaded = new Map<string, Font | null>()

function fontOf(family: string, bold: boolean, italic: boolean): Font | null {
  const key = `${family}|${bold}|${italic}`
  if (loaded.has(key)) return loaded.get(key)!
  let font: Font | null = null
  try {
    const f = systemFonts().get(family)
    const want = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
    const order = [want, bold ? 'bold' : 'regular', italic ? 'italic' : 'regular', 'regular'] as const
    const file = f && order.map((k) => f.files[k]).find(Boolean)
    if (file) font = fontkit.create(readFileSync(file))
  } catch {
    font = null
  }
  loaded.set(key, font)
  return font
}

/** MuPDF's base-14 fonts have the metrics of Arial, Times New Roman and Courier New (no PC fonts needed). */
const BUILT_IN: Record<string, [string, string, string, string]> = {
  Arial: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  'Times New Roman': ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  'Courier New': ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
}
const builtIn = new Map<string, mupdf.Font | null>()
function builtInFont(family: string, bold: boolean, italic: boolean): mupdf.Font | null {
  const names = BUILT_IN[family]
  if (!names) return null
  const name = names[(bold ? 1 : 0) + (italic ? 2 : 0)]!
  if (!builtIn.has(name)) {
    try {
      builtIn.set(name, new mupdf.Font(name))
    } catch {
      builtIn.set(name, null)
    }
  }
  return builtIn.get(name) ?? null
}

/**
 * The width Office gives `text` in an installed `family` (points): Arabic shaped, no kerning or
 * ligatures (Word and PowerPoint use neither by default). Null when the font cannot be measured.
 */
export function widthIn(text: string, family: string, bold: boolean, italic: boolean, size: number, arabic: boolean): number | null {
  const font = fontOf(family, bold, italic)
  if (font) {
    const run = font.layout(text, arabic ? { kern: false } : { kern: false, liga: false })
    return (run.advanceWidth / font.unitsPerEm) * size
  }
  const m = arabic ? null : builtInFont(family, bold, italic)
  if (!m) return null
  let width = 0
  for (const c of text) {
    const gid = m.encodeCharacter(c.codePointAt(0)!)
    width += (gid > 0 ? m.advanceGlyph(gid, 0) : 0.55) * size
  }
  return width
}

type SampleRun = Pick<StyleRun, 'family' | 'kind' | 'bold' | 'italic' | 'size' | 'text' | 'tracking'>
type Sample = { runs: SampleRun[]; width: number }

/** Arabic fonts Windows has, by kind: the ones an Arabic family not installed may become. */
const ARABIC_CANDIDATES: Record<StyleRun['kind'], string[]> = {
  sans: ['Arial', 'Tahoma', 'Segoe UI', 'Dubai', 'Sakkal Majalla'],
  serif: ['Simplified Arabic', 'Traditional Arabic', 'Times New Roman', 'Sakkal Majalla'],
  mono: ['Arial', 'Tahoma', 'Courier New']
}

const FORMAT = /\p{Cf}/gu

/**
 * The candidate whose total width over `lines` is nearest the printed one; the usual stand-in stays
 * unless another is clearly nearer (by more than 1.5 %). Null to keep the usual one.
 */
function nearest(lines: Sample[], usual: string, candidates: string[], widthOf: (l: Sample, family: string) => number | null): string | null {
  const printed = lines.reduce((n, l) => n + l.width, 0)
  if (printed < 200) return null
  const score = (family: string): number | null => {
    let total = 0
    for (const l of lines) {
      const w = widthOf(l, family)
      if (w === null) return null
      total += w
    }
    return total > 0 ? Math.abs(Math.log(printed / total)) : null
  }
  const usualScore = score(usual) ?? Infinity
  let best = usual
  let bestScore = usualScore
  for (const c of candidates) {
    if (c === usual || !systemFonts().get(c)) continue
    const s = score(c)
    if (s !== null && s < bestScore) {
      best = c
      bestScore = s
    }
  }
  return best !== usual && usualScore - bestScore > 0.015 ? best : null
}

/**
 * Chooses, for each of the document's families not installed here, the installed font of its kind
 * whose letters are as wide as printed: over lines in that family alone (`width` as printed, not
 * stretched by justification), the font whose total width is nearest the printed one — for Latin
 * lines the Latin font, for lines with Arabic the Arabic one (their Latin words and digits in the
 * Latin font). A page set in DejaVu Sans had its Arabic in Arial, visibly smaller. For one export:
 * the choices are forgotten when the next document is learned.
 */
export function learnFallbacks(samples: Sample[]): void {
  learned.clear()
  learnedArabic.clear()
  const latinBy = new Map<string, { kind: StyleRun['kind']; lines: Sample[] }>()
  const arabicBy = new Map<string, { first: SampleRun; lines: Sample[] }>()
  for (const s of samples) {
    const first = s.runs[0]
    if (!first || s.width <= 0) continue
    const key = keyOf(first.family)
    if (!key || s.runs.some((r) => keyOf(r.family) !== key || r.tracking)) continue
    const text = s.runs.map((r) => r.text).join('')
    if (text.trim().length < 8) continue
    const own = installedFamily(first.family)
    if (ARABIC.test(text)) {
      if (own?.arabic) continue
      const entry = arabicBy.get(key) ?? { first, lines: [] }
      entry.lines.push(s)
      arabicBy.set(key, entry)
    } else {
      if (SAME_WIDTHS.has(key) || own?.latin) continue
      const entry = latinBy.get(key) ?? { kind: first.kind, lines: [] }
      entry.lines.push(s)
      latinBy.set(key, entry)
    }
  }
  for (const [key, { kind, lines }] of latinBy) {
    const usual = LATIN[key] ?? Object.entries(LATIN).find(([k]) => key.startsWith(k))?.[1] ?? defaultLatin(kind)
    const latinWidth = (l: Sample, family: string): number | null => {
      let total = 0
      for (const r of l.runs) {
        const w = widthIn(r.text, family, r.bold, r.italic, r.size, false)
        if (w === null) return null
        total += w
      }
      return total
    }
    const best = nearest(lines, usual, CANDIDATES[kind], latinWidth)
    if (best) learned.set(key, best)
  }
  // After the Latin choices: an Arabic line's Latin words are measured in the font they will have.
  for (const [key, { first, lines }] of arabicBy) {
    const fonts = fontsFor(first)
    const arabicWidth = (l: Sample, family: string): number | null => {
      let total = 0
      for (const r of l.runs)
        for (const piece of r.text.replace(FORMAT, '').match(SCRIPTS) ?? []) {
          const arabic = ARABIC.test(piece)
          const w = widthIn(piece, arabic ? family : fonts.latin, r.bold, r.italic, r.size, arabic)
          if (w === null) return null
          total += w
        }
      return total
    }
    const best = nearest(lines, fonts.arabic, ARABIC_CANDIDATES[first.kind], arabicWidth)
    if (best) learnedArabic.set(key, best)
  }
}

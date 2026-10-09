import fontkit from '@pdf-lib/fontkit'
import { beginText, endText, PDFDocument, PDFHexString, PDFNumber, PDFOperator, PDFOperatorNames, popGraphicsState, pushGraphicsState, rgb, setCharacterSqueeze, setFillingRgbColor, setFontAndSize, setTextMatrix, StandardFonts, type PDFFont, type PDFName, type PDFPage } from 'pdf-lib'
import type { ParagraphInfo } from '@shared/ipc'
import { detectDirection, visualRuns } from './bidi'
import { PdfError } from './errors'
import { embedFace } from './fonts'
import { systemFontBytes } from './systemFonts'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { paragraphAt, paragraphs, styledLines, type Alignment, type Paragraph, type StyledLine } from './paragraphs'
import { pageFrame, placeOverlay } from './stamp'
import { explicitLeading, repairLeading } from './contentfix'
import { safeRedact } from './saferedact'
import { covers, NATIVE_PREFIX, nativeFont, nativeTJ, nativeWidth, type NativeFont } from './nativefont'
import { embeddedFont, installedFamily, isStandardFamily } from './docfonts'
import { unreadable } from './text'
import { carryStyles, isMarker, mark, paletteOf, plainText, segments, spansOf, unmark, type RunStyle, type StyledSpan } from './richtext'

/**
 * Editing what is on a page: rewrite a paragraph, add text, erase an area.
 *
 * Rewriting is two proven steps (docs/decisions.md §26, §27):
 *   1. find the paragraph (paragraphs.ts), read its style, and REMOVE its glyphs with a
 *      text-only redaction per line, so the old words are really gone, not covered;
 *   2. wrap the new text inside the same column, at the same size, colour, weight and
 *      line spacing, keeping the alignment and a bullet's hanging indent, and draw it with
 *      a matched font: the PDF standard fonts for Latin (Times, Helvetica, Courier and their
 *      bold/italic, which every reader has), Noto Sans for Latin outside WinAnsi, and IBM
 *      Plex Sans Arabic for Arabic.
 * The original typeface is usually an embedded subset without the new letters, so it is
 * matched by kind, not reused; the interface says so.
 *
 * Coordinates are the page as displayed: points from the top-left, rotation applied.
 */

export type Box = [number, number, number, number]

export interface TextStyle {
  size: number
  colour: [number, number, number]
  bold: boolean
  italic: boolean
  kind: 'serif' | 'sans' | 'mono'
  /** A font installed on this PC, chosen by the person; otherwise one matched to `kind`. */
  family?: string
  /** The paragraph's own font file, taken from the PDF (TrueType/OpenType), to keep its look (§56). */
  embedded?: Uint8Array
  /** The paragraph's own font object on the page: words it has letters for are written with it (§59). */
  native?: NativeFont
  underline?: boolean
}

const STANDARD: Record<TextStyle['kind'], [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]
}

interface Piece {
  text: string
  /** Drawn with pdf-lib in this font… */
  font: PDFFont | null
  /** …or written with the page's own font object (§59). */
  native?: NativeFont
  width: number
}

/**
 * Measures and draws text in one style, choosing a font per direction run. Measuring and
 * drawing share this, so wrapping decisions match what is drawn exactly.
 */
class Typesetter {
  private readonly fonts = new Map<string, PDFFont>()
  dropped = 0
  /** Some letters were set in another font than the one asked for (it lacked them, or could not be used). */
  substituted = false
  private chosenFont: PDFFont | null | undefined
  /** Letters drawn narrower than the font's own (1 = as designed): a stand-in font kept to the original's line breaks. */
  squeeze = 1
  /** The size words in the page's own font are written at (the stand-in may be sized to look alike). */
  nativeSize: number
  /** The overlay's placeholder font name for each of the page's own fonts (swapped back when placed). */
  private readonly nativeKeys = new Map<number, PDFName>()

  constructor(
    private readonly pdf: PDFDocument,
    readonly style: TextStyle
  ) {
    this.nativeSize = style.size
  }

  private async font(key: string, make: () => Promise<PDFFont>): Promise<PDFFont> {
    if (!this.fonts.has(key)) this.fonts.set(key, await make())
    return this.fonts.get(key)!
  }

  /** The pieces of one line, left to right as drawn. Characters no font can draw are dropped (and counted if `count`). */
  async pieces(text: string, count = false, base?: 'rtl' | 'ltr'): Promise<Piece[]> {
    const { style } = this
    const standard = STANDARD[style.kind][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]!
    const out: Piece[] = []
    // A chosen installed font draws every letter it has; the matched fonts draw the rest.
    // The font asked for: an installed one, or the paragraph's own from the PDF. One that cannot be
    // used (a licence that forbids embedding, a file pdf-lib cannot read) falls back, and says so.
    if (this.chosenFont === undefined) {
      this.chosenFont = null
      if (style.family || style.embedded) {
        try {
          this.pdf.registerFontkit(fontkit)
          this.chosenFont = await this.pdf.embedFont(style.family ? systemFontBytes(style.family, style.bold, style.italic).bytes : style.embedded!, { subset: true })
        } catch {
          this.substituted = true
        }
      }
    }
    const chosen = this.chosenFont
    const chosenSet = chosen ? drawable(chosen) : null
    const pick = async (runText: string, arabic: boolean): Promise<void> => {
      let f: PDFFont
      const fits = !!chosen && [...runText].every((c) => chosenSet!.has(c.codePointAt(0)!) || c === ' ')
      // The asked-for font lacks some of these letters: they are set in a matched font instead.
      if (chosen && !fits && runText.trim()) this.substituted = true
      if (fits) f = chosen!
      else if (arabic) f = await this.font(style.bold ? 'arabic-bold' : 'arabic', () => embedFace(this.pdf, style.bold ? 'arabic-bold' : 'arabic'))
      else {
        const std = await this.font(standard, () => this.pdf.embedFont(standard))
        const covered = new Set(std.getCharacterSet())
        f = [...runText].every((c) => covered.has(c.codePointAt(0)!) || c === ' ')
          ? std
          : await this.font(style.bold ? 'latin-bold' : 'latin', () => embedFace(this.pdf, style.bold ? 'latin-bold' : 'latin'))
      }
      const set = new Set(f.getCharacterSet())
      const kept = [...runText].filter((c) => {
        const ok = set.has(c.codePointAt(0)!) || c === ' '
        if (!ok && count) this.dropped++
        return ok
      })
      if (kept.length) out.push({ text: kept.join(''), font: f, width: f.widthOfTextAtSize(kept.join(''), style.size) })
    }
    for (const run of visualRuns(text, base)) {
      const native = style.native
      if (!native) {
        await pick(run.text, run.arabic)
        continue
      }
      // Word by word: a word whose every letter the page's own font has is written with it;
      // the others go to the fonts above. Spaces stay with the word before them.
      const words = run.text.split(/(?<= )/)
      const chunks: Array<{ own: boolean; text: string }> = []
      let i = 0
      while (i < words.length) {
        const own = !!words[i]!.trim() && covers(native, words[i]!)
        let j = i
        let chunk = ''
        while (j < words.length && (covers(native, words[j]!) && !!words[j]!.trim()) === own) chunk += words[j++]
        if (j === i) chunk = words[j++]!
        chunks.push({ own, text: chunk })
        i = j
      }
      // An Arabic run is laid out right to left by the shaping engine — Arabic digits included, which
      // is how a line read as "٩١" shows 19 again. Words in the page's own font follow the same order.
      if (run.arabic) chunks.reverse()
      for (const { own, text: chunk } of chunks) {
        const shown = own && run.arabic ? [...chunk].reverse().join('') : chunk
        if (own) out.push({ text: shown, font: null, native, width: nativeWidth(native, shown, this.nativeSize) })
        else {
          // Without the font installed or its file reusable, these words go to a stand-in; with
          // them, pick() says whether that font lacked letters.
          if (!this.chosenFont && chunk.trim()) this.substituted = true
          await pick(chunk, run.arabic)
        }
      }
    }
    return out
  }

  async width(text: string, base?: 'rtl' | 'ltr'): Promise<number> {
    return (await this.pieces(text, false, base)).reduce((n, p) => n + p.width, 0) * this.squeeze
  }

  /**
   * Words in the page's own font (§59), in the same content as the rest of the line so they read in
   * order: a placeholder font stands for the page's font object until the overlay is placed.
   */
  private drawNative(page: PDFPage, font: NativeFont, text: string, x: number, y: number): void {
    let key = this.nativeKeys.get(font.num)
    if (!key) {
      const ref = this.pdf.context.register(this.pdf.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: `${NATIVE_PREFIX}${font.num}` }))
      key = page.node.newFontDictionary('HonoNative', ref)
      this.nativeKeys.set(font.num, key)
    }
    const parts = nativeTJ(font, text).map((p) => (typeof p === 'string' ? PDFHexString.of(p) : PDFNumber.of(p)))
    if (parts.length === 0) return
    page.pushOperators(
      beginText(),
      setFontAndSize(key, this.nativeSize),
      setFillingRgbColor(...this.style.colour),
      setTextMatrix(1, 0, 0, 1, x, y),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [this.pdf.context.obj(parts)]),
      endText()
    )
  }

  /** Draws `text` with its left end at `x` on baseline `y` (overlay coordinates, y up). */
  async draw(page: PDFPage, text: string, x: number, y: number, base?: 'rtl' | 'ltr'): Promise<number> {
    const pieces = await this.pieces(text, true, base)
    let cx = x
    if (this.squeeze !== 1) page.pushOperators(pushGraphicsState(), setCharacterSqueeze(Math.round(this.squeeze * 1000) / 10))
    for (const p of pieces) {
      if (p.native) this.drawNative(page, p.native, p.text, cx, y)
      else if (p.font) page.drawText(p.text, { x: cx, y, size: this.style.size, font: p.font, color: rgb(...this.style.colour) })
      cx += p.width * this.squeeze
    }
    if (this.squeeze !== 1) page.pushOperators(popGraphicsState())
    // Underline: a rule just under the baseline, as thick as a stem of the text.
    if (this.style.underline && cx > x) {
      const s = this.style.size
      page.drawLine({ start: { x, y: y - s * 0.12 }, end: { x: cx, y: y - s * 0.12 }, thickness: Math.max(0.5, s * 0.055), color: rgb(...this.style.colour) })
    }
    return cx - x
  }
}

/** What layout and drawing need of a typesetter: one style (Typesetter) or several (StyledSetter). */
interface Setter {
  readonly style: TextStyle
  squeeze: number
  readonly dropped: number
  readonly substituted: boolean
  width(text: string, base?: 'rtl' | 'ltr'): Promise<number>
  draw(page: PDFPage, text: string, x: number, y: number, base?: 'rtl' | 'ltr'): Promise<number>
}

/**
 * Text in several styles (§65): strings carry style markers (richtext.ts); each stretch is measured
 * and drawn by the typesetter of its style. A line is ordered by the bidi algorithm on its plain
 * text, then each direction run is cut where the style changes — right to left for Arabic runs.
 */
class StyledSetter implements Setter {
  constructor(private readonly setters: Typesetter[]) {}
  get style(): TextStyle {
    return this.setters[0]!.style
  }
  get squeeze(): number {
    return this.setters[0]!.squeeze
  }
  set squeeze(v: number) {
    for (const s of this.setters) s.squeeze = v
  }
  get dropped(): number {
    return this.setters.reduce((n, s) => n + s.dropped, 0)
  }
  get substituted(): boolean {
    return this.setters.some((s) => s.substituted)
  }
  private setter(index: number): Typesetter {
    return this.setters[index] ?? this.setters[0]!
  }
  async width(text: string): Promise<number> {
    let w = 0
    for (const seg of segments(text)) w += await this.setter(seg.style).width(seg.text)
    return w
  }
  async draw(page: PDFPage, text: string, x: number, y: number, base?: 'rtl' | 'ltr'): Promise<number> {
    const { text: plain, styles } = unmark(text)
    // Each stretch placed where it shows (runs left to right, an Arabic run's stretches right to
    // left), then written in reading order: readers (search, copy, MuPDF) take a line's text in
    // the order it is written.
    const placed: Array<{ text: string; style: number; dir: 'rtl' | 'ltr'; x: number; first: number }> = []
    let cx = x
    for (const run of visualRuns(plain, base ?? detectDirection(plain))) {
      const pieces: Array<{ text: string; style: number; first: number }> = []
      for (const i of run.indices) {
        const last = pieces[pieces.length - 1]
        if (last && last.style === styles[i]) last.text += plain[i]
        else pieces.push({ text: plain[i]!, style: styles[i] ?? 0, first: i })
      }
      if (run.rtl) pieces.reverse()
      const dir = run.rtl ? 'rtl' : 'ltr'
      for (const p of pieces) {
        placed.push({ ...p, dir, x: cx })
        cx += await this.setter(p.style).width(p.text, dir)
      }
    }
    for (const p of [...placed].sort((a, b) => a.first - b.first)) await this.setter(p.style).draw(page, p.text, p.x, y, p.dir)
    return cx - x
  }
}

// --- reading ------------------------------------------------------------------------------

/** The line of text at `box` with its style (kept for callers that work line by line). */
export function lineAt(doc: PdfDoc, pageIndex: number, box: Box): (StyledLine & { baseline: { x: number; y: number } }) | null {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  const lines = styledLines(doc, pageIndex)
  const hit = lines.find((l) => cx >= l.box[0] - 1 && cx <= l.box[2] + 1 && cy >= l.box[1] - 1 && cy <= l.box[3] + 1)
  if (!hit) return null
  return { ...hit, baseline: { x: hit.start, y: hit.baseline } } as StyledLine & { baseline: { x: number; y: number } }
}

// --- removing ------------------------------------------------------------------------------

/** Removes content inside `box` for real: text only, or everything. */
function redact(doc: PdfDoc, pageIndex: number, boxes: Box[], everything: boolean): void {
  // MuPDF's rewrite of the page misreads T*, ' and " after a Td: make every move explicit first (§58).
  try {
    explicitLeading(doc, pageIndex)
  } catch {
    // an unreadable stream is left as it is; the check after the removal still guards the page
  }
  // Only these boxes: the person's pending redaction marks, links and other annotations stay as
  // they are (MuPDF's redaction would apply every mark on the page and drop links under the area).
  safeRedact(doc, pageIndex, boxes, everything ? { images: 'pixels', lineArt: 'covered' } : {})
}

/** A line's box trimmed to the middle of its height, so neighbouring lines keep their letters. */
function core(l: StyledLine, trim = 0.2): Box {
  const h = l.box[3] - l.box[1]
  return [l.box[0] - 0.5, l.box[1] + h * trim, l.box[2] + 0.5, l.box[3] - h * trim]
}

/**
 * Removes `targets` and checks the page after: every other letter must still be there and every
 * letter of the targets gone. Tightly set lines (a magazine cover's headline) reach into each
 * other, and removing one took letters of the next; then a narrower band is tried on a fresh copy.
 * Returns the document the removal was made in (it may be a new one).
 */
function redactChecked(doc: PdfDoc, bytes: Uint8Array, password: string | undefined, pageIndex: number, all: StyledLine[], targets: StyledLine[]): Removal {
  // What a reader sees: spaces, tatweel, invisible marks and format characters do not count, and
  // mirrored pairs are one (an Arabic producer's text may store » where the page shows «).
  const visible = (t: string): string[] => [...t.replace(/[\sـً-ٰٟ­​-‏⁠﻿]/g, '').replace(/[«»]/g, '«').replace(/[(){}[\]]/g, '(')]
  const count = (lines: Array<{ text: string }>): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of lines) for (const c of visible(l.text)) m.set(c, (m.get(c) ?? 0) + 1)
    return m
  }
  const excess = (a: Map<string, number>, b: Map<string, number>): number => [...a].reduce((n, [c, k]) => n + Math.max(0, k - (b.get(c) ?? 0)), 0)
  const expected = count(all)
  for (const [c, k] of count(targets)) expected.set(c, (expected.get(c) ?? 0) - k)
  // Letters can also survive in the wrong place: MuPDF's rewrite of a text block moved the lines
  // after an edited one 275 pt up the page (a newspaper). Every other line must still be where it
  // was: whatever is now read on its baseline, over its old place, holds all its letters (MuPDF may
  // read it split or in another order after the rewrite — that is not a change on the page).
  const isTarget = (l: StyledLine): boolean => targets.some((t) => t.box.every((v, i) => Math.abs(v - l.box[i]!) < 0.6))
  const others = all.filter((l) => !isTarget(l) && visible(l.text).length > 0)
  const missingFrom = (l: StyledLine, after: StyledLine[]): number => {
    const there = after.filter((a) => Math.abs(a.baseline - l.baseline) < 1 && a.box[0] < l.box[2] + 1 && a.box[2] > l.box[0] - 1)
    return excess(count([l]), count(there))
  }
  const misplaced = (after: StyledLine[]): number => others.reduce((n, l) => n + missingFrom(l, after), 0)
  const lostOf = (lines: StyledLine[]): number => Math.max(excess(expected, count(lines)), misplaced(lines))
  // Lines away from the edited ones that went missing or moved: never acceptable. (A glyph lying
  // right under an edited line — a hidden label behind a headline — cannot be kept, and may go.)
  const touches = (l: StyledLine): boolean => targets.some((t) => l.box[0] < t.box[2] && l.box[2] > t.box[0] && l.box[1] < t.box[3] && l.box[3] > t.box[1])
  // A line read as one may span gaps that hold other lines (a masthead: "@paper … date"
  // around "www.paper.example"): the removal leaves those gaps alone.
  const cutAround = (box: Box, t: StyledLine): Box[] => {
    let pieces: Array<[number, number]> = [[box[0], box[2]]]
    for (const o of others) {
      const inside = o.box[0] > t.box[0] + 0.5 && o.box[2] < t.box[2] - 0.5 && o.box[1] < t.box[3] && o.box[3] > t.box[1]
      if (!inside) continue
      pieces = pieces.flatMap(([a, b]): Array<[number, number]> => (o.box[2] < a || o.box[0] > b ? [[a, b]] : ([[a, o.box[0] - 0.5], [o.box[2] + 0.5, b]] as Array<[number, number]>).filter(([x, y]) => y - x > 0.5)))
    }
    return pieces.map(([a, b]) => [a, box[1], b, box[3]])
  }
  const far = (after: StyledLine[]): number => others.filter((l) => !touches(l)).reduce((n, l) => n + missingFrom(l, after), 0)
  // The line's box trimmed, then bands measured from the baseline: some fonts report boxes far
  // taller than their letters (48 pt for 20 pt type), and any part of such a box reaches the next line.
  const bands: Array<(l: StyledLine) => Box> = [
    (l) => core(l, 0.2),
    (l) => core(l, 0.32),
    (l) => [l.box[0] - 0.5, l.baseline - l.size * 0.6, l.box[2] + 0.5, l.baseline - l.size * 0.1],
    (l) => [l.box[0] - 0.5, l.baseline - l.size * 0.45, l.box[2] + 0.5, l.baseline - l.size * 0.25]
  ]
  // Each band cut around other lines inside the edited one's span, then whole: a line read across a
  // masthead's gaps needs the cuts; a line whose own words were read as another line needs none.
  const attempts: Array<(t: StyledLine) => Box[]> = [...bands.map((band) => (t: StyledLine) => cutAround(band(t), t)), ...bands.map((band) => (t: StyledLine) => [band(t)])]
  let best = { band: 0, lost: Infinity, left: Infinity, far: Infinity }
  for (const [i, attempt] of attempts.entries()) {
    if (i > 0) {
      free(doc)
      doc = openPdf(bytes, password)
    }
    redact(doc, pageIndex, targets.flatMap(attempt), false)
    let lines = styledLines(doc, pageIndex)
    // Letters missing or moved: MuPDF may have thrown a block's following lines away (§58).
    if (lostOf(lines) > 0 && repairLeading(doc, pageIndex) > 0) lines = styledLines(doc, pageIndex)
    const lost = lostOf(lines)
    const left = excess(count(lines), expected)
    if (lost === 0 && left === 0) return { doc, lost: 0, far: 0, left: 0 }
    if (lost + left < best.lost + best.left || (lost + left === best.lost + best.left && lost < best.lost)) best = { band: i, lost, left, far: far(lines) }
  }
  // None was clean (letters of another line lie right under the edited one): the band with the
  // fewest letters wrong either way — old words left under the new ones are worse than a covered glyph.
  if (best.band !== attempts.length - 1) {
    free(doc)
    doc = openPdf(bytes, password)
    redact(doc, pageIndex, targets.flatMap(attempts[best.band]!), false)
    repairLeading(doc, pageIndex)
  }
  return { doc, lost: best.lost, far: best.far, left: best.left }
}

interface Removal {
  doc: PdfDoc
  /** Letters of other lines missing or moved. */
  lost: number
  /** …of those, in lines not touching the edited ones. */
  far: number
  /** Letters of the edited lines still on the page. */
  left: number
}

/** The removal moved or lost text away from the edit, or left the old words: the edit is refused. */
function unsafe(r: Removal): boolean {
  return r.far > 0 || r.left > 0
}

/** A page region drawn at `k` pixels per point, as RGB. */
function regionPixels(doc: PdfDoc, pageIndex: number, box: Box, k = 2): Uint8ClampedArray {
  const bbox: Box = [Math.floor(box[0] * k), Math.floor(box[1] * k), Math.ceil(box[2] * k), Math.ceil(box[3] * k)]
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return new Uint8ClampedArray(0)
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
  try {
    pix.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
    const page = doc.loadPage(pageIndex)
    try {
      page.run(dev, mupdf.Matrix.scale(k, k))
    } finally {
      dev.close()
      free(page, dev)
    }
    return new Uint8ClampedArray(pix.getPixels())
  } finally {
    pix.destroy()
  }
}

/**
 * How much of the ink of the edited lines is still drawn once their text is removed (0–1), or
 * null when it cannot be judged (the lines lie on a picture, not on a plain background). Near 1,
 * the words a reader sees are not that text: they are drawn as shapes, or are part of a scanned
 * picture under an invisible text layer (OCR) — removing the text and writing new words would
 * leave the old ones showing under them (a newspaper byline drawn as outlines).
 */
function inkKept(before: PdfDoc, after: PdfDoc, pageIndex: number, boxes: Box[]): number | null {
  let inkBefore = 0
  let inkAfter = 0
  for (const box of boxes) {
    const a = regionPixels(before, pageIndex, box)
    const b = regionPixels(after, pageIndex, box)
    if (!a.length || a.length !== b.length) continue
    // The background: the most common colour (quantised) once the text is removed — what lies
    // behind the letters. (Before, big bold letters can be the most common colour themselves:
    // white "THE AGE" over a photo on a magazine cover.)
    const counts = new Map<number, number>()
    for (let i = 0; i < b.length; i += 3) {
      const key = ((b[i]! >> 4) << 8) | ((b[i + 1]! >> 4) << 4) | (b[i + 2]! >> 4)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let bgKey = 0
    let bgCount = 0
    for (const [key, n] of counts) if (n > bgCount) [bgKey, bgCount] = [key, n]
    // On a picture there is no plain background to tell letters from: not judged.
    if (bgCount < (b.length / 3) * 0.45) return null
    const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8]
    const ink = (p: Uint8ClampedArray, i: number): boolean => Math.abs(p[i]! - bg[0]!) + Math.abs(p[i + 1]! - bg[1]!) + Math.abs(p[i + 2]! - bg[2]!) > 90
    for (let i = 0; i < a.length; i += 3) {
      if (ink(a, i)) inkBefore++
      if (ink(b, i)) inkAfter++
    }
  }
  // Too little ink to judge (a space, a dot).
  if (inkBefore < 30) return null
  return Math.min(1, inkAfter / inkBefore)
}

const DRAWN = 'Nothing was changed: these words are drawn as shapes, or are part of a picture (a scan), so they cannot be edited as text. To change them, erase them and add new text.'

/** Refuses an edit whose removed text was not what the page shows (see inkKept). */
function assertVisibleRemoved(bytes: Uint8Array, password: string | undefined, after: PdfDoc, pageIndex: number, lines: StyledLine[]): void {
  if (!lines.length) return
  const before = openPdf(bytes, password)
  try {
    const kept = inkKept(before, after, pageIndex, lines.map((l) => core(l, 0.2)))
    if (kept !== null && kept > 0.6) throw new PdfError('edit-unsafe', DRAWN)
  } finally {
    free(before)
  }
}

const UNSAFE = 'Nothing was changed: editing this paragraph would have moved other text on the page or left the old words under the new ones.'

// --- laying out -------------------------------------------------------------------------------

const BULLET = /^([•▪◦‣●○■□·\-–*]|\d{1,3}[.)])\s+/u

interface Placed {
  text: string
  /** Baseline y in displayed coordinates. */
  y: number
  /** Start edge (left for LTR, right for RTL) and the far edge of the column. */
  start: number
  far: number
  justify: boolean
  /** A bullet drawn apart, at the first line's start, before the hanging indent. */
  marker?: { text: string; at: number }
}

/** Greedy word wrap into the paragraph's column, one line after another. */
async function layout(ts: Setter, p: Paragraph, text: string, pageWidth: number, growToMargin: boolean, rtl: boolean): Promise<Placed[]> {
  const far = growToMargin ? (rtl ? Math.min(p.farEdge, 36) : Math.max(p.farEdge, pageWidth - 36)) : p.farEdge
  const placed: Placed[] = []
  let y = p.lines[0]!.baseline
  for (const hard of text.split(/\r?\n/)) {
    let body = hard.trim()
    let marker: Placed['marker']
    let first = placed.length === 0
    const startFirst = first ? p.firstStart : p.restStart
    // A bullet paragraph with a hanging indent: the bullet at the first start, words at the indent.
    // Style markers (§65) before the bullet are kept with it.
    let lead = ''
    while (lead.length < body.length && isMarker(body[lead.length]!)) lead += body[lead.length]
    const m = first && Math.abs(p.restStart - p.firstStart) > 2 ? BULLET.exec(body.slice(lead.length)) : null
    if (m) {
      marker = { text: lead + m[1]!, at: p.firstStart }
      const rest = body.slice(lead.length + m[0].length)
      body = rest && !isMarker(rest[0]!) ? lead + rest : rest
    }
    const words = body.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      y += p.pitch
      continue
    }
    let line = ''
    for (const word of words) {
      const start = first ? (marker ? p.restStart : startFirst) : p.restStart
      const width = Math.abs(far - start)
      const candidate = line ? `${line} ${word}` : word
      if (!line || (await ts.width(candidate)) <= width) {
        line = candidate
        continue
      }
      placed.push({ text: line, y, start, far, justify: true, ...(first && marker ? { marker } : {}) })
      y += p.pitch
      first = false
      line = word
    }
    const start = first ? (marker ? p.restStart : startFirst) : p.restStart
    placed.push({ text: line, y, start, far, justify: false, ...(first && marker ? { marker } : {}) })
    y += p.pitch
  }
  return placed
}

/** The direction of `text`: an explicit choice wins; otherwise its first strong letter, or the paragraph's. */
function directionOf(text: string, paragraphRtl: boolean, chosen?: 'rtl' | 'ltr'): boolean {
  if (chosen) return chosen === 'rtl'
  const d = detectDirection(text)
  return d === 'rtl' || (paragraphRtl && d !== 'ltr')
}

async function drawPlaced(ts: Setter, page: PDFPage, frameHeight: number, placed: Placed[], alignment: Alignment, rtl: boolean): Promise<void> {
  for (const line of placed) {
    const y = frameHeight - line.y
    if (line.marker) {
      const w = await ts.width(line.marker.text)
      await ts.draw(page, line.marker.text, rtl ? line.marker.at - w : line.marker.at, y)
    }
    const width = await ts.width(line.text)
    const left = rtl ? line.far : line.start
    const right = rtl ? line.start : line.far
    const words = line.text.split(' ')
    const plainLine = plainText(line.text)
    const oneDirection = visualRuns(plainLine).every((r) => r.rtl === rtl) || !/[֐-ࣿ]/.test(plainLine) === !rtl
    if (alignment === 'justify' && line.justify && words.length > 1 && oneDirection) {
      // Spread the words across the column. Each word keeps its space glyph and only the extra
      // is added, capped at half an em: stretched further, a reader (MuPDF among them) sees
      // separate words instead of one line, so such a line is left ragged, as typesetters do.
      const pieces = words.map((w, i) => (i < words.length - 1 ? `${w} ` : w))
      const widths = await Promise.all(pieces.map((w) => ts.width(w)))
      const extra = (right - left - widths.reduce((a, b) => a + b, 0)) / (words.length - 1)
      if (extra >= 0 && extra <= ts.style.size * 0.5) {
        let x = rtl ? right : left
        for (const [i, piece] of pieces.entries()) {
          if (rtl) {
            x -= widths[i]!
            await ts.draw(page, piece, x, y)
            x -= extra
          } else {
            await ts.draw(page, piece, x, y)
            x += widths[i]! + extra
          }
        }
        continue
      }
    }
    let x: number
    if (alignment === 'centre') x = (left + right) / 2 - width / 2
    else if ((alignment === 'end') !== rtl) x = right - width
    else x = left
    await ts.draw(page, line.text, x, y)
  }
}

// --- operations ----------------------------------------------------------------------------------

export interface EditResult {
  bytes: Uint8Array
  dropped: number
  /** The new text needs more lines than the old: it may run into what follows. */
  grew: boolean
  /** The paragraph had words in another style (a bold word); they now share the body style. */
  unified: boolean
  /** The paragraph's font, and how it was kept: the same installed font, its own embedded file, or a similar one. */
  font?: { name: string; kept: 'installed' | 'embedded' | 'similar' }
}

export interface TextChanges {
  style?: Partial<TextStyle> & { align?: Alignment; direction?: 'rtl' | 'ltr' }
  dx?: number
  dy?: number
  width?: number
  /** Distance between baselines as a multiple of the size (1.2 is "single"). */
  lineHeight?: number
  /**
   * Keep to the paragraph's own column: a one-line paragraph wraps at its own width instead of
   * running on to the margin (Find & Replace, §64 — the caller then refuses a result that grew).
   */
  stayInColumn?: boolean
  /**
   * Stretches of the new text in another style than the body (§65) — what the person set in the
   * editor. Without them, the paragraph's own styles are carried over to the new text.
   */
  spans?: StyledSpan[]
}

/**
 * Replaces the paragraph at `box` with `text` (empty text removes it). Line breaks in
 * `text` are kept; everything else is wrapped into the paragraph's column.
 */
export async function replaceText(bytes: Uint8Array, pageIndex: number, box: Box, text: string, password?: string, changes: TextChanges = {}): Promise<EditResult> {
  let doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const all = styledLines(doc, pageIndex)
    const cx = (box[0] + box[2]) / 2
    const cy = (box[1] + box[3]) / 2
    const at = (l: (typeof all)[number]): boolean => cx >= l.box[0] && cx <= l.box[2] && cy >= l.box[1] && cy <= l.box[3]
    // Refused only when the text there is not horizontal. A diagonal watermark's box covers
    // most of the page, so a horizontal line under it is still the one meant.
    if (!all.some((l) => l.horizontal && at(l)) && all.some((l) => !l.horizontal && at(l))) {
      throw new PdfError('unsupported', 'Only horizontal lines of text can be edited.')
    }
    const p = paragraphAt(doc, pageIndex, box)
    if (!p) throw new PdfError('bad-arguments', 'There is no text there to edit.')
    // Retyping letters the file does not map would only lose them; removing them is still allowed.
    if (text.trim() && unreadable(p.text)) throw new PdfError('unsupported', 'This text cannot be read from the file, so it cannot be edited. Recognize text (OCR) first.')
    // The paragraph's own font, looked up before its text is removed (removal prunes the page's fonts).
    const ownFamily = mainFamily(p)
    const keepOwn = !changes.style?.family && !changes.style?.kind
    const installed = keepOwn && ownFamily ? installedFamily(ownFamily) : null
    const ownFile = keepOwn && ownFamily && !installed ? ownFontFile(doc, pageIndex, ownFamily, changes.style?.bold ?? p.style.bold, changes.style?.italic ?? p.style.italic) : null
    // Only the words changed (no new style, place or width): the lines before the first change,
    // and after the last one, keep their own letters untouched — whatever font they are in (§58).
    // The styles of the new text (§65): as the person set them, or the paragraph's own carried over.
    const oldStyles = paragraphStyles(p)
    const carried = oldStyles ? carryStyles(p.text, oldStyles, text) : null
    const explicit = changes.spans ? spanStyles(text, changes.spans) : null
    const restyled = !!explicit && !sameStyles(explicit, carried ?? new Array<RunStyle | null>(text.length).fill(null))
    const runStyles = explicit ?? carried
    const plain = Object.values(changes.style ?? {}).every((v) => v === undefined) && !changes.dx && !changes.dy && changes.width === undefined && !changes.lineHeight && !restyled
    if (plain && text === p.text) return { bytes, dropped: 0, grew: false, unified: false }
    const kept = plain && text.trim() ? unchangedLines(p.lines.map((l) => l.text), text) : { head: 0, tail: 0, from: 0, to: text.length }
    let font: EditResult['font']
    let dropped = 0
    let grew = false
    if (!text.trim()) {
      const removal = redactChecked(doc, bytes, password, pageIndex, all, p.lines)
      doc = removal.doc
      if (unsafe(removal)) throw new PdfError('edit-unsafe', UNSAFE)
      assertVisibleRemoved(bytes, password, doc, pageIndex, p.lines)
    }
    if (text.trim()) {
      const frame = pageFrame(doc, pageIndex)
      const overlay = await PDFDocument.create()
      const page = overlay.addPage([frame.width, frame.height])
      const { align, direction, ...styleChange } = changes.style ?? {}
      const style: TextStyle = { size: p.style.size, colour: p.style.colour, bold: p.style.bold, italic: p.style.italic, kind: p.style.kind, ...styleChange }
      // Keep the paragraph's own font unless the person chose another (§56).
      if (keepOwn) {
        font = { name: ownFamily, kept: 'similar' }
        if (installed) style.family = installed
        else if (ownFile) style.embedded = ownFile
        // Not installed: the words the page's own font has letters for are written with it (§59),
        // unless the person made the text bold or italic (that font is the other weight).
        if (!installed && changes.style?.bold === undefined && changes.style?.italic === undefined) {
          const native = ownNativeFont(doc, pageIndex, all, p)
          if (native) style.native = native
        }
      }
      const ts = new Typesetter(overlay, style)
      const rtl = directionOf(text, p.style.rtl, direction)
      // Direction switched by hand: the column is anchored at its other edge, indents dropped.
      if (direction && rtl !== p.style.rtl) {
        p.firstStart = p.restStart = rtl ? p.box[2] : p.box[0]
        p.farEdge = rtl ? p.box[0] : p.box[2]
      }
      // A new size keeps the paragraph's proportions: line spacing scales with it.
      if (style.size !== p.style.size) p.pitch *= style.size / p.style.size
      if (changes.lineHeight) p.pitch = style.size * changes.lineHeight
      // A stand-in is sized to look like the original, not by the number: Arabic newspaper faces
      // draw small for their size (NASFont at 12 pt looks like 9 pt), and a stand-in at the same
      // size came out much larger than the lines kept around it. The paragraph's own lines are the
      // measure: how wide they are, against how wide the stand-in sets them (§58).
      const standIn = keepOwn && !installed && !ownFile && !isStandardFamily(ownFamily)
      if (standIn && plain) {
        const ratios: number[] = []
        for (const l of p.lines) {
          if (l.text.replace(/\s/g, '').length < 6) continue
          const w = await ts.width(l.text)
          if (w > 0) ratios.push((l.box[2] - l.box[0]) / w)
        }
        ratios.sort((a, b) => a - b)
        const median = ratios[Math.floor(ratios.length / 2)]
        if (median !== undefined && median < 0.97) style.size *= Math.max(0.75, median)
      }
      // Several styles (§65): a typesetter for each, sized as the body's stand-in was.
      const { setter, styleIndex } = await styledSetter(ts, overlay, doc, pageIndex, all, text, runStyles, {
        sizeFactor: style.size / (changes.style?.size ?? p.style.size),
        own: keepOwn && !installed ? ownFamily : null,
        installed
      })
      // The text to lay out between two offsets, trimmed, with its style markers.
      const bodyOf = (from: number, to: number = text.length): string => {
        let a = from
        let b = to
        while (a < b && /\s/.test(text[a]!)) a++
        while (b > a && /\s/.test(text[b - 1]!)) b--
        return styleIndex ? mark(text.slice(a, b), styleIndex.slice(a, b)) : text.slice(a, b)
      }
      // A new width: the column's far edge moves; one-line text no longer grows to the margin.
      if (changes.width !== undefined) p.farEdge = rtl ? p.restStart - changes.width : p.restStart + changes.width
      // A single line centred on the page (a title) stays centred. Not a line that merely spans the
      // page evenly: if other lines start or end at its edges, it is aligned like them (owner's
      // report: a table-of-contents entry jumped to the middle).
      let alignment = p.alignment
      if (p.lines.length === 1) {
        const middle = (p.box[0] + p.box[2]) / 2
        const onCentre = Math.abs(middle - frame.width / 2) < frame.width * 0.02 && p.box[2] - p.box[0] < frame.width * 0.8
        const own = p.lines[0]!
        // Compared by position: `all` and the paragraph come from separate reads of the page.
        const isOwn = (l: StyledLine): boolean => l.box.every((v, i) => Math.abs(v - own.box[i]!) < 0.5)
        const sharesEdge = all.some((l) => !isOwn(l) && l.horizontal && (Math.abs(l.box[0] - own.box[0]) < 2 || Math.abs(l.box[2] - own.box[2]) < 2))
        if (onCentre && !sharesEdge) alignment = 'centre'
      }
      if (align) alignment = align
      const lineCount = p.lines.length
      // The changed lines only: laid out from the first of them, with the column's own edges.
      const part = (head: number, tail: number): Paragraph => ({ ...p, lines: p.lines.slice(head, lineCount - tail), firstStart: head === 0 ? p.firstStart : p.restStart })
      // A stand-in for a font this PC lacks is usually wider: its lines may be drawn up to 15%
      // narrower, so they keep the original's line breaks instead of running into what follows (§58).
      const fit = async (head: number, tail: number, body: string, grow: boolean): Promise<Placed[]> => {
        const room = lineCount - head - tail
        setter.squeeze = 1
        const first = await layout(setter, part(head, tail), body, frame.width, grow, rtl)
        if (!standIn || !plain || first.length <= room) return first
        for (const squeeze of [0.95, 0.9, 0.85]) {
          setter.squeeze = squeeze
          const narrower = await layout(setter, part(head, tail), body, frame.width, grow, rtl)
          if (narrower.length <= room) return narrower
        }
        setter.squeeze = 1
        return first
      }
      // One-line text (a heading, a label) may grow to the margin, unless a width was chosen.
      const mayGrow = lineCount === 1 && changes.width === undefined && !changes.stayInColumn
      let placed = await fit(kept.head, kept.tail, bodyOf(kept.from, kept.to), mayGrow)
      // The lines after the change stay only if the new words fill exactly the lines they had;
      // otherwise everything after the first change flows again.
      if (kept.tail > 0 && placed.length !== lineCount - kept.head - kept.tail) {
        kept.tail = 0
        kept.to = text.length
        placed = await fit(kept.head, 0, bodyOf(kept.from), false)
      }
      // A line that is followed by kept lines was a full line: it stays justified.
      if (kept.tail > 0 && placed.length > 0) placed[placed.length - 1] = { ...placed[placed.length - 1]!, justify: true }
      let removal = redactChecked(doc, bytes, password, pageIndex, all, p.lines.slice(kept.head, lineCount - kept.tail))
      doc = removal.doc
      // Removing only some lines of a text block can move the rest: MuPDF rewrites the block, and
      // where its lines follow one another with T* or ', it repositioned them with TD — which also
      // sets the leading — and threw them off the page (a newspaper page). Then the whole
      // paragraph is set again instead: nothing of it is left to be moved, and no letter is lost.
      if ((removal.lost > 0 || removal.left > 0) && (kept.head > 0 || kept.tail > 0)) {
        free(doc)
        doc = openPdf(bytes, password)
        Object.assign(kept, { head: 0, tail: 0, from: 0, to: text.length })
        placed = await fit(0, 0, bodyOf(0), mayGrow)
        removal = redactChecked(doc, bytes, password, pageIndex, all, p.lines)
        doc = removal.doc
      }
      // Better no edit than a page with other text moved, lost or doubled (§58).
      if (unsafe(removal)) throw new PdfError('edit-unsafe', UNSAFE)
      // …or with the old words still showing under the new ones (§64).
      assertVisibleRemoved(bytes, password, doc, pageIndex, p.lines.slice(kept.head, lineCount - kept.tail))
      if (alignment === 'centre' && lineCount === 1 && changes.width === undefined) {
        const middle = (p.box[0] + p.box[2]) / 2
        const half = Math.min(middle, frame.width - middle) - 36
        placed = placed.map((l) => ({ ...l, start: rtl ? middle + half : middle - half, far: rtl ? middle - half : middle + half }))
      }
      // Moved: everything shifts together, the bullet included.
      const { dx = 0, dy = 0 } = changes
      if (dx || dy) placed = placed.map((l) => ({ ...l, y: l.y + dy, start: l.start + dx, far: l.far + dx, ...(l.marker ? { marker: { ...l.marker, at: l.marker.at + dx } } : {}) }))
      await drawPlaced(setter, page, frame.height, placed, alignment, rtl)
      dropped = setter.dropped
      if (font) font.kept = isStandardFamily(font.name) && !ts.substituted ? 'installed' : style.native && !ts.substituted && !style.family ? 'embedded' : ts.substituted || (!style.family && !style.embedded) ? 'similar' : style.family ? 'installed' : 'embedded'
      grew = changes.width === undefined && kept.head + placed.length + kept.tail > lineCount
      placeOverlay(doc, new Uint8Array(await overlay.save()), [frame])
    }
    // Words in another style are kept when their styles could be read (§65); otherwise they now share the body's.
    return { bytes: saveBytes(doc), dropped, grew, unified: p.mixedStyles && text.trim().length > 0 && !runStyles, ...(font ? { font } : {}) }
  } finally {
    free(doc)
  }
}

export interface NewTextBox {
  /** Column width in points: the text wraps inside it. Without one, each line runs on unwrapped. */
  width?: number
  /** Distance between baselines as a multiple of the size. */
  lineHeight?: number
  align?: Alignment
  direction?: 'rtl' | 'ltr'
  /** Stretches in other styles than the box (§65). */
  spans?: StyledSpan[]
}

/**
 * Adds text whose first baseline starts at (x, y) — for right-to-left text, (x, y) is where
 * it ends, its right edge. Laid out by the same engine as an edited paragraph, so a drawn
 * box wraps, aligns and justifies the same way.
 */
export async function addText(bytes: Uint8Array, pageIndex: number, x: number, y: number, text: string, style: TextStyle, password?: string, box: NewTextBox = {}): Promise<EditResult> {
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const frame = pageFrame(doc, pageIndex)
    const overlay = await PDFDocument.create()
    const page = overlay.addPage([frame.width, frame.height])
    const ts = new Typesetter(overlay, style)
    const rtl = directionOf(text, false, box.direction)
    // An unwrapped box is a column wide enough never to wrap.
    const width = box.width ?? 1e6
    const column: Paragraph = {
      lines: [{ baseline: y } as StyledLine],
      text,
      box: [x, y - style.size, x, y],
      style: { ...style, rtl },
      alignment: box.align ?? 'start',
      pitch: style.size * (box.lineHeight ?? 1.25),
      firstStart: x,
      restStart: x,
      farEdge: rtl ? x - width : x + width,
      mixedStyles: false
    }
    const { setter, styleIndex } = await styledSetter(ts, overlay, doc, pageIndex, [], text, box.spans ? spanStyles(text, box.spans) : null, { sizeFactor: 1, own: null, installed: null })
    const body = styleIndex ? mark(text, styleIndex) : text
    const placed = await layout(setter, column, body, frame.width, false, rtl)
    await drawPlaced(setter, page, frame.height, placed, box.width ? column.alignment : 'start', rtl)
    placeOverlay(doc, new Uint8Array(await overlay.save()), [frame])
    return { bytes: saveBytes(doc), dropped: setter.dropped, grew: false, unified: false }
  } finally {
    free(doc)
  }
}

/** Removes everything inside `box` (text, pictures, drawings) and leaves it blank. */
export function eraseArea(bytes: Uint8Array, pageIndex: number, box: Box, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    if (box[2] - box[0] < 1 || box[3] - box[1] < 1) throw new PdfError('bad-arguments', 'Draw a larger area to erase.')
    redact(doc, pageIndex, [box], true)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Paragraphs of a page for the interface: text and boxes only. */
export function pageParagraphs(doc: PdfDoc, pageIndex: number): ParagraphInfo[] {
  // The text flows (lines joined by spaces): the person edits sentences, the engine re-wraps them.
  const hex = (c: [number, number, number]): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`
  // How each paragraph's font can be kept when it is edited (§56), found once per family.
  const statuses = new Map<string, ParagraphInfo['fontStatus']>()
  const status = (family: string, bold: boolean, italic: boolean): ParagraphInfo['fontStatus'] => {
    const key = `${family}|${bold}|${italic}`
    if (!statuses.has(key)) statuses.set(key, !family ? 'missing' : installedFamily(family) || isStandardFamily(family) ? 'installed' : ownFontFile(doc, pageIndex, family, bold, italic) ? 'embedded' : 'missing')
    return statuses.get(key)!
  }
  // The page's own font object can write new words in it (§59): the paragraph counts as kept when
  // that font has nearly all of its letters (an Arabic paragraph's letters go to a stand-in).
  const lines = styledLines(doc, pageIndex)
  const natives = new Map<string, NativeFont | null>()
  const ownStatus = (p: Paragraph): ParagraphInfo['fontStatus'] => {
    const first = status(mainFamily(p), p.style.bold, p.style.italic)
    if (first !== 'missing') return first
    const name = mainFontName(p)
    if (!natives.has(name)) natives.set(name, ownNativeFont(doc, pageIndex, lines, p))
    const native = natives.get(name)
    if (!native) return 'missing'
    const letters = [...p.text.replace(/[\s\u0640]/g, '')]
    const have = letters.filter((c) => native.glyphs.has(c.codePointAt(0)!)).length
    return letters.length > 0 && have / letters.length >= 0.95 ? 'embedded' : 'missing'
  }
  return paragraphs(lines).map((p) => ({
    text: p.text,
    box: p.box,
    lines: p.lines.map((l) => l.box),
    rtl: p.style.rtl,
    size: p.style.size,
    colour: hex(p.style.colour),
    bold: p.style.bold,
    italic: p.style.italic,
    kind: p.style.kind,
    align: p.alignment,
    pitch: p.pitch,
    mixed: p.mixedStyles,
    unreadable: unreadable(p.text),
    font: mainFamily(p),
    fontStatus: ownStatus(p),
    // Words in another style, for the editor to show them as they are (§65).
    spans: spansOf(paragraphStyles(p) ?? []).map((sp) => ({
      start: sp.start,
      end: sp.end,
      style: {
        ...(sp.style.bold !== undefined ? { bold: sp.style.bold } : {}),
        ...(sp.style.italic !== undefined ? { italic: sp.style.italic } : {}),
        ...(sp.style.size !== undefined ? { size: Math.round(sp.style.size * 2) / 2 } : {}),
        ...(sp.style.colour ? { colour: hex(sp.style.colour) } : {})
      }
    }))
  }))
}

export interface FormatAllChange {
  kind?: TextStyle['kind']
  /** A font installed on this PC. */
  family?: string
  /** A new size in points for all text, or… */
  size?: number
  /** …every size multiplied by this (headings stay bigger than body text). */
  scale?: number
  colour?: [number, number, number]
}

/**
 * Formats all the text of some pages at once (docs/decisions.md §48): the same retyping the
 * text box does for one paragraph, for every paragraph — same words, same place and column,
 * a new typeface, size or colour. Each page is cleared and redrawn in one pass.
 */
export async function formatAllText(bytes: Uint8Array, pages: number[] | undefined, change: FormatAllChange, password?: string): Promise<{ bytes: Uint8Array; paragraphs: number; dropped: number; mixed: number }> {
  if (!change.kind && !change.family && !change.size && !change.scale && !change.colour) throw new PdfError('bad-arguments', 'Choose what to change first.')
  const doc = openPdf(bytes, password)
  try {
    const count = doc.countPages()
    const targets = pages ?? Array.from({ length: count }, (_, i) => i)
    for (const p of targets) if (p < 0 || p >= count) throw new PdfError('bad-arguments', `Page ${p + 1} does not exist.`)
    let total = 0
    let dropped = 0
    let mixed = 0
    for (const pageIndex of targets) {
      const paras = paragraphs(styledLines(doc, pageIndex)).filter((p) => p.text.trim())
      if (paras.length === 0) continue
      // Each paragraph keeps its own font unless a typeface was chosen (§56); found before removal prunes them.
      const keep = !change.kind && !change.family
      const own = paras.map((p) => {
        if (!keep) return {}
        const family = mainFamily(p)
        const installed = family ? installedFamily(family) : null
        if (installed) return { family: installed }
        const file = family ? ownFontFile(doc, pageIndex, family, p.style.bold, p.style.italic) : null
        return file ? { embedded: file } : {}
      })
      redact(doc, pageIndex, paras.flatMap((p) => p.lines.map((l) => core(l))), false)
      const frame = pageFrame(doc, pageIndex)
      const overlay = await PDFDocument.create()
      const sheet = overlay.addPage([frame.width, frame.height])
      for (const [k, p] of paras.entries()) {
        const size = change.size ?? Math.round(p.style.size * (change.scale ?? 1) * 2) / 2
        const style: TextStyle = {
          size,
          colour: change.colour ?? p.style.colour,
          bold: p.style.bold,
          italic: p.style.italic,
          kind: change.kind ?? p.style.kind,
          ...(change.family ? { family: change.family } : own[k])
        }
        const ts = new Typesetter(overlay, style)
        if (size !== p.style.size) p.pitch *= size / p.style.size
        const placed = await layout(ts, p, p.text, frame.width, p.lines.length === 1, p.style.rtl)
        await drawPlaced(ts, sheet, frame.height, placed, p.alignment, p.style.rtl)
        dropped += ts.dropped
        if (p.mixedStyles) mixed++
        total++
      }
      placeOverlay(doc, new Uint8Array(await overlay.save()), [frame])
    }
    if (total === 0) throw new PdfError('bad-arguments', 'There is no text on these pages to change.')
    return { bytes: saveBytes(doc), paragraphs: total, dropped, mixed }
  } finally {
    free(doc)
  }
}

/** The family most of a paragraph's letters are set in, as the PDF names it. */
function mainFamily(p: Paragraph): string {
  const by = new Map<string, number>()
  for (const l of p.lines) for (const r of l.runs) if (r.family) by.set(r.family, (by.get(r.family) ?? 0) + r.text.length)
  return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/** The paragraph's own embedded font file, or null; a damaged font only means a similar one is used. */
function ownFontFile(doc: PdfDoc, pageIndex: number, family: string, bold: boolean, italic: boolean): Uint8Array | null {
  try {
    return embeddedFont(doc, pageIndex, family, bold, italic)
  } catch {
    return null
  }
}

/**
 * The letters a font really has a drawing for (a code mapped to glyph 0 would print an empty box).
 * Asked with hasGlyphForCodePoint: glyphForCodePoint caches each glyph under the last letter asked,
 * and a glyph shared by two letters (Arabic and Persian yeh) would then be written as the wrong one.
 */
function drawable(font: PDFFont): Set<number> {
  const face = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?(cp: number): boolean } } }).embedder?.font
  const all = font.getCharacterSet()
  return new Set(face?.hasGlyphForCodePoint ? all.filter((cp) => face.hasGlyphForCodePoint!(cp)) : all)
}

/**
 * How much of a paragraph's text is unchanged at whole lines: the first `head` lines and the
 * last `tail` lines are word for word in `text`, which changes only between `from` and `to`.
 * At least one line is always left to be set again.
 */
export function unchangedLines(lines: string[], text: string): { head: number; tail: number; from: number; to: number } {
  const n = lines.length
  let head = 0
  let from = 0
  while (head < n - 1 && text.startsWith(`${lines[head]} `, from)) {
    from += lines[head]!.length + 1
    head++
  }
  let tail = 0
  let to = text.length
  while (head + tail < n - 1) {
    const segment = ` ${lines[n - 1 - tail]}`
    if (to - segment.length < from - 1 || !text.endsWith(segment, to)) break
    to -= segment.length
    tail++
  }
  return { head, tail, from, to: Math.max(from, to) }
}

/** Lives with the text reader now (§68): the Office export uses it too. */
export { unreadable } from './text'

/* --- several styles in a paragraph (§65) ----------------------------------------------------- */

const close = (a: [number, number, number], b: [number, number, number]): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 0.04)

/**
 * Each character's style in a paragraph where it differs from the body (a bold word, a red figure),
 * null where it is the body's; null for the whole paragraph when all is in one style or the runs do
 * not add up to its text. Lines are joined by a space, as the paragraph's text is.
 */
function paragraphStyles(p: Paragraph): Array<RunStyle | null> | null {
  const body = p.style
  const out: Array<RunStyle | null> = []
  let any = false
  for (const [li, l] of p.lines.entries()) {
    if (li > 0) out.push(out[out.length - 1] ?? null)
    if (l.runs.map((r) => r.text).join('') !== l.text) return null
    for (const r of l.runs) {
      const st: RunStyle = {}
      if (r.bold !== body.bold) st.bold = r.bold
      if (r.italic !== body.italic) st.italic = r.italic
      if (Math.abs(r.size - body.size) > 0.6) st.size = r.size
      if (!close(r.colour, body.colour)) st.colour = r.colour
      const styled = Object.keys(st).length > 0
      if (styled) {
        st.font = r.font
        any = true
      }
      for (let k = 0; k < r.text.length; k++) out.push(styled ? st : null)
    }
  }
  return any && out.length === p.text.length ? out : null
}

/** Spans (as the editor sends them) to a style per character. */
function spanStyles(text: string, spans: StyledSpan[]): Array<RunStyle | null> {
  const out = new Array<RunStyle | null>(text.length).fill(null)
  for (const sp of spans) for (let i = Math.max(0, sp.start); i < Math.min(text.length, sp.end); i++) out[i] = Object.keys(sp.style).length ? sp.style : null
  return out
}

/** The same look, character for character (the font object a style came from does not count). */
function sameStyles(a: Array<RunStyle | null>, b: Array<RunStyle | null>): boolean {
  const key = (s: RunStyle | null): string => (s ? JSON.stringify([!!s.bold, !!s.italic, !!s.underline, Math.round((s.size ?? 0) * 2) / 2, s.family ?? '', (s.colour ?? []).map((v) => Math.round(v * 50))]) : '')
  return a.length === b.length && a.every((s, i) => key(s) === key(b[i] ?? null))
}

/** The page's own font object of a name, with the letters the page shows in it; null if it cannot write new text. */
function nativeNamed(doc: PdfDoc, pageIndex: number, lines: StyledLine[], name: string): NativeFont | null {
  const seen = new Set<number>()
  for (const l of lines) for (const r of l.runs) if (r.font === name) for (const c of r.text) seen.add(c.codePointAt(0)!)
  if (!seen.size) return null
  try {
    return nativeFont(doc, pageIndex, name, seen)
  } catch {
    return null
  }
}

/**
 * The typesetters for text in several styles: the body's, and one per other style — its own font
 * object on the page when it has one (or one of the page's in that weight), else the paragraph's
 * embedded font in that weight, else a stand-in. Sizes follow the body's stand-in sizing.
 */
async function styledSetter(
  base: Typesetter,
  overlay: PDFDocument,
  doc: PdfDoc,
  pageIndex: number,
  all: StyledLine[],
  text: string,
  styles: Array<RunStyle | null> | null,
  opts: { sizeFactor: number; own: string | null; installed: string | null }
): Promise<{ setter: Setter; styleIndex: number[] | null }> {
  if (!styles || styles.every((st) => !st || !Object.keys(st).length)) return { setter: base, styleIndex: null }
  const { palette, styles: styleIndex } = paletteOf(text, spansOf(styles))
  const setters = [base]
  for (const entry of palette.slice(1)) {
    const st: TextStyle = { ...base.style }
    st.bold = entry.bold ?? base.style.bold
    st.italic = entry.italic ?? base.style.italic
    if (entry.underline !== undefined) st.underline = entry.underline
    if (entry.colour) st.colour = entry.colour
    if (entry.size) st.size = entry.size * opts.sizeFactor
    delete st.native
    if (entry.family) {
      st.family = entry.family
      delete st.embedded
    } else if (!opts.installed) {
      const weightChanged = st.bold !== base.style.bold || st.italic !== base.style.italic
      // Its own font object, or the page's font of the same family in this weight.
      const name = entry.font ?? (opts.own ? all.flatMap((l) => l.runs).find((r) => r.family === opts.own && r.bold === st.bold && r.italic === st.italic)?.font : undefined)
      const native = name ? nativeNamed(doc, pageIndex, all, name) : weightChanged ? null : (base.style.native ?? null)
      if (native) st.native = native
      if (weightChanged && opts.own) {
        const file = ownFontFile(doc, pageIndex, opts.own, st.bold, st.italic)
        if (file) st.embedded = file
        else delete st.embedded
      }
    }
    const t = new Typesetter(overlay, st)
    t.nativeSize = entry.size ?? base.nativeSize
    setters.push(t)
  }
  return { setter: new StyledSetter(setters), styleIndex }
}

/** The exact font (subset tag and all) most of a paragraph's letters are set in. */
function mainFontName(p: Paragraph): string {
  const by = new Map<string, number>()
  for (const l of p.lines) for (const r of l.runs) if (r.font) by.set(r.font, (by.get(r.font) ?? 0) + r.text.length)
  return [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/** The paragraph's own font object, with the letters the page shows in it; null if it cannot write new text. */
function ownNativeFont(doc: PdfDoc, pageIndex: number, lines: StyledLine[], p: Paragraph): NativeFont | null {
  const name = mainFontName(p)
  if (!name) return null
  const seen = new Set<number>()
  for (const l of lines) for (const r of l.runs) if (r.font === name) for (const c of r.text) seen.add(c.codePointAt(0)!)
  try {
    return nativeFont(doc, pageIndex, name, seen)
  } catch {
    return null
  }
}

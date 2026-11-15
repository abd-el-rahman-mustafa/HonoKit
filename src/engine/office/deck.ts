import PptxGenJS from 'pptxgenjs'
import { BRAND } from '@shared/brand'
import type { StyleRun } from '../paragraphs'
import { systemFonts } from '../systemFonts'
import type { RGB } from './drawings'
import { directedRuns, type DirectedRun } from './bidiruns'
import { EMU, hex, svgExtension } from './drawingml'
import { ARABIC, SCRIPTS, installedFamily, widthIn } from './fonts'
import type { DocModel, ParagraphBlock, TableBlock } from './model'
import { CONTROL, esc, linkXml, SlideXml, withShapes, type Media } from './pptx'
import { storiesOf, type Story, type StoryText } from './stories'

/**
 * "Make a presentation" (decisions §123, research-pdf-to-office.md §11): a deck built from what the
 * PDF says, not a copy of how its pages look. Each story (stories.ts) becomes slides of its own —
 *
 * - a contents slide first: the first page's picture beside the list of stories;
 * - a story's first slide: the line over its headline (in the accent colour), the headline, a short
 *   rule, then its text on the reading side and its main picture on the other, with its caption;
 * - its text goes on over as many slides as it takes ("every word"), broken at the end of a sentence,
 *   or only the opening paragraph on the slide with the rest in the notes ("opening");
 * - further pictures on slides of their own, tables as PowerPoint tables split over slides;
 * - a page title with only a line or two under it (a section opener) as a section slide.
 *
 * Every slide's notes hold the whole story, so nothing the PDF says is lost whatever the slides show.
 * The text keeps its words, emphasis, links and direction; the type is set again for a screen: the
 * PDF's own family when this PC has it, else Segoe UI (Latin) and Dubai (Arabic), headlines in
 * their Semibold and Medium. The accent colour is the one the PDF's kickers and headlines use most.
 *
 * Text is measured with the fonts' own widths (fonts.ts widthIn) to break it over slides; each box
 * may still shrink its text a little in PowerPoint (normAutofit) rather than run off the slide.
 */

export interface DeckOptions {
  /** Every word on the slides, or each story's opening paragraph (the rest in the notes). */
  text: 'all' | 'opening'
  /** The first page as a picture, for the contents slide. */
  cover?: { data: Uint8Array; width: number; height: number } | null
}

/** The slide: 13.33 × 7.5 inches (PowerPoint's widescreen), in points. */
const W = 960
const H = 540
const SIDE = 40
const TOP = 30
const BOTTOM = H - 30
const GAP = 24
const INK = '1F2328'
const GREY = '6B7280'
const LINE = 'D0D4DA'
const SECTION_FILL = 'F4F1EC'
const DEFAULT_ACCENT = '1F4E79'
/** Room kept on each line: PowerPoint's wrap and the measured widths differ a little. */
const SLACK = 0.96

type Role = 'title' | 'body'

const hasFont = (family: string): boolean => process.platform !== 'win32' || systemFonts().has(family)

/** The stock faces: Segoe UI and Dubai (Windows 10 and 11 have both), headlines in their heavier weights. */
function stockFaces(role: Role): { latin: string; cs: string } {
  const title = role === 'title'
  const latin = title && hasFont('Segoe UI Semibold') ? 'Segoe UI Semibold' : hasFont('Segoe UI') ? 'Segoe UI' : 'Arial'
  const cs = title && hasFont('Dubai Medium') ? 'Dubai Medium' : hasFont('Dubai') ? 'Dubai' : 'Arial'
  return { latin, cs }
}

interface Faces {
  latin: string
  cs: string
  /** A headline in the PDF's own family: its weight comes from bold, not from a heavier face. */
  latinBold: boolean
  csBold: boolean
}

const facesCache = new Map<string, Faces>()

/** The faces a run is set in: the PDF's family where this PC has it (for each script it has letters for), else the stock ones. */
function facesFor(r: Pick<StyleRun, 'family'>, role: Role): Faces {
  const key = `${r.family}|${role}`
  let f = facesCache.get(key)
  if (!f) {
    const own = installedFamily(r.family)
    const stock = stockFaces(role)
    const title = role === 'title'
    f = {
      latin: own?.latin ? own.family : stock.latin,
      cs: own?.arabic ? own.family : stock.cs,
      latinBold: title && !!own?.latin,
      csBold: title && !!own?.arabic
    }
    facesCache.set(key, f)
  }
  return f
}

const widths = new Map<string, number>()

/** The width of `text` at size 1 in the run's faces, each script in its own. */
function widthOf(text: string, r: Pick<StyleRun, 'family' | 'bold' | 'italic'>, role: Role): number {
  const f = facesFor(r, role)
  let total = 0
  for (const piece of text.match(SCRIPTS) ?? []) {
    const arabic = ARABIC.test(piece)
    const face = arabic ? f.cs : f.latin
    const bold = role === 'title' ? (arabic ? f.csBold : f.latinBold) : r.bold
    const key = `${face}|${bold}|${r.italic}|${arabic}|${piece}`
    let w = widths.get(key)
    if (w === undefined) {
      w = widthIn(piece, face, bold, r.italic, 1, arabic) ?? [...piece].length * (arabic ? 0.42 : 0.5)
      widths.set(key, w)
    }
    total += w
  }
  return total
}

interface Word {
  start: number
  end: number
  /** At size 1. */
  width: number
}

interface Measured {
  text: string
  words: Word[]
  space: number
}

/** A paragraph's words with their widths (at size 1), and the width of a space. */
function measure(runs: StyleRun[], role: Role): Measured {
  const words: Word[] = []
  let offset = 0
  let current: Word | null = null
  for (const r of runs) {
    for (const piece of r.text.split(/( )/)) {
      if (!piece) continue
      if (piece === ' ') {
        if (current) words.push(current)
        current = null
        offset += 1
        continue
      }
      current ??= { start: offset, end: offset, width: 0 }
      current.width += widthOf(piece, r, role)
      offset += piece.length
      current.end = offset
    }
  }
  if (current) words.push(current)
  const first = runs[0]
  return { text: runs.map((r) => r.text).join(''), words, space: first ? widthOf(' ', first, role) : 0.28 }
}

/** Lines the text between `from` and `to` takes at `size` in `width` points. */
function linesOf(m: Measured, size: number, width: number, from = 0, to = m.text.length): number {
  const room = (width * SLACK) / size
  let lines = 0
  let used = -1
  for (const w of m.words) {
    if (w.start < from || w.end > to) continue
    if (used < 0 || used + m.space + w.width > room) {
      lines += Math.max(1, Math.ceil(w.width / room))
      used = w.width > room ? w.width % room : w.width
    } else used += m.space + w.width
  }
  return lines
}

/** Where sentences end in `text` (offsets just after the stop and any closing quote). */
function sentenceEnds(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/[.!?؟…]+["'»”)\]]*(?=\s)/gu)) out.push(m.index + m[0].length)
  return out
}

/** The runs between two offsets of their joined text. */
function sliceRuns(runs: StyleRun[], from: number, to: number): StyleRun[] {
  const out: StyleRun[] = []
  let at = 0
  for (const r of runs) {
    const a = Math.max(from, at)
    const b = Math.min(to, at + r.text.length)
    if (b > a) out.push({ ...r, text: r.text.slice(a - at, b - at) })
    at += r.text.length
  }
  if (out.length) {
    out[0] = { ...out[0]!, text: out[0]!.text.trimStart() }
    out[out.length - 1] = { ...out[out.length - 1]!, text: out[out.length - 1]!.text.trimEnd() }
  }
  return out.filter((r) => r.text)
}

// Colours.

const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (c: RGB): number => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
/** Contrast with white (WCAG). */
const contrast = (c: RGB): number => 1.05 / (luminance(c) + 0.05)
const coloured = (c: RGB): boolean => Math.max(...c) - Math.min(...c) >= 0.25

/** A text colour worth keeping on a white slide: a real colour dark enough to read. */
function keptColour(c: RGB): string | null {
  return coloured(c) && contrast(c) >= 3 ? hex(c) : null
}

/** The colour the PDF's kickers, headlines and subheads use most, darkened to read on white; a deep blue when there is none. */
function accentOf(stories: Story[]): string {
  const counts = new Map<string, { c: RGB; n: number }>()
  const add = (c: RGB | null | undefined, n: number): void => {
    if (!c || !coloured(c)) return
    const key = hex(c)
    const was = counts.get(key)
    counts.set(key, { c, n: (was?.n ?? 0) + n })
  }
  for (const s of stories) {
    add(s.kickerColour, 2)
    add(s.titleRuns.find((r) => r.text.trim())?.colour, 1)
    for (const p of s.paragraphs) if (p.sub) add(p.runs.find((r) => r.text.trim())?.colour, 1)
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0]
  if (!best) return DEFAULT_ACCENT
  let c: RGB = [...best.c]
  for (let i = 0; i < 30 && contrast(c) < 4.5; i++) c = [c[0] * 0.9, c[1] * 0.9, c[2] * 0.9]
  return hex(c)
}

// Shapes.

const at = (sx: SlideXml, x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${Math.round(x * EMU)}" y="${Math.round(y * EMU)}"/><a:ext cx="${Math.max(1, Math.round(w * EMU))}" cy="${Math.max(1, Math.round(h * EMU))}"/></a:xfrm>`

interface ParaStyle {
  size: number
  role: Role
  /** Hex colour, or null to keep each run's own colour where it is a real colour (else ink). */
  colour: string | null
  after: number
  /** Line spacing, percent of single. */
  spacing?: number
  bullet?: string
  align?: 'l' | 'r' | 'ctr'
  /** No bold anywhere (a list of headlines set alike). */
  plain?: boolean
}

function runXml(sx: SlideXml, r: DirectedRun, s: ParaStyle): string {
  const f = facesFor(r, s.role)
  const arabic = ARABIC.test(r.text)
  const bold = !s.plain && (s.role === 'title' ? (arabic ? f.csBold : f.latinBold) : r.bold)
  const colour = s.colour ?? keptColour(r.colour) ?? INK
  return `<a:r><a:rPr lang="${r.rtl ? 'ar-AE' : 'en-US'}" sz="${Math.round(s.size * 100)}" b="${bold ? 1 : 0}" i="${r.italic && s.role === 'body' ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:latin typeface="${esc(f.latin)}"/><a:cs typeface="${esc(f.cs)}"/>${r.link ? linkXml(sx, r.link) : ''}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`
}

function paraXml(sx: SlideXml, runs: StyleRun[], rtl: boolean, s: ParaStyle, accent: string): string {
  const algn = s.align ?? (rtl ? 'r' : 'l')
  const hang = s.bullet ? Math.round(s.size * 1.2 * EMU) : 0
  const bullet = s.bullet ? `<a:buClr><a:srgbClr val="${accent}"/></a:buClr><a:buSzPct val="100000"/><a:buFont typeface="Arial"/><a:buChar char="${esc(s.bullet)}"/>` : '<a:buNone/>'
  const pPr = `<a:pPr algn="${algn}" rtl="${rtl ? 1 : 0}"${hang ? ` marL="${hang}" indent="${-hang}"` : ''}><a:lnSpc><a:spcPct val="${Math.round((s.spacing ?? 100) * 1000)}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="${Math.round(s.after * 100)}"/></a:spcAft>${bullet}</a:pPr>`
  return `<a:p>${pPr}${directedRuns(runs, rtl)
    .map((r) => runXml(sx, r, s))
    .join('')}</a:p>`
}

function textBoxXml(sx: SlideXml, x: number, y: number, w: number, h: number, paras: string, anchor: 't' | 'b' | 'ctr' = 't'): string {
  const id = sx.id()
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${at(sx, x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
}

function ruleXml(sx: SlideXml, x: number, y: number, w: number, h: number, colour: string): string {
  const id = sx.id()
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rule ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${at(sx, x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
}

function pictureXml(sx: SlideXml, data: Uint8Array, type: 'png' | 'jpg', svg: Uint8Array | undefined, box: Box4, alt: string, border = false): string {
  const id = sx.id()
  const rid = sx.embed(data, type === 'jpg' ? 'jpeg' : 'png')
  const ext = svg ? svgExtension(sx.embed(svg, 'svg')) : ''
  const line = border ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:ln>` : ''
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}">${ext}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${at(sx, box[0], box[1], box[2], box[3])}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${line}</p:spPr></p:pic>`
}

/** x, y, width, height. */
type Box4 = [number, number, number, number]

/** A picture fitted inside a box, its aspect kept: centred across, at the top. */
function fitted(p: { box: [number, number, number, number] }, x: number, y: number, w: number, h: number): Box4 {
  const ratio = (p.box[2] - p.box[0]) / Math.max(1, p.box[3] - p.box[1])
  let pw = w
  let ph = w / ratio
  if (ph > h) {
    ph = h
    pw = h * ratio
  }
  return [x + (w - pw) / 2, y, pw, ph]
}

// The deck.

interface Slide {
  sx: SlideXml
  parts: string[]
  notes: string
  background?: string
}

/** Plain text as one run: in the stock faces, or in `base`'s family (a kicker set like its headline). */
const plainRuns = (text: string, base?: StyleRun): StyleRun[] => [{ text, size: 10, colour: [0, 0, 0], bold: false, italic: false, kind: base?.kind ?? 'sans', family: base?.family ?? '', font: '' }]

/** The runs cut at a word so they take at most `most` lines, an ellipsis after the cut. */
function clipped(runs: StyleRun[], role: Role, size: number, width: number, most: number): StyleRun[] {
  const m = measure(runs, role)
  if (linesOf(m, size, width) <= most) return runs
  let end = 0
  for (const w of m.words) if (linesOf(m, size, width - size * 1.5, 0, w.end) <= most) end = w.end
  const kept = sliceRuns(runs, 0, end)
  return kept.length ? [...kept, { ...kept[kept.length - 1]!, text: ' …' }] : runs
}

/** Lines a caption takes at 12 pt (at most three are shown). */
const captionLines = (caption: string, width: number): number => (caption ? Math.min(3, linesOf(measure(plainRuns(caption), 'body'), 12, width)) : 0)

/** Where a piece of a story's text goes: which paragraph, which part of it. */
interface Piece {
  item: StoryText
  from: number
  to: number
}

interface Box {
  width: number
  height: number
}

/**
 * The story's text over boxes (the first slide's, then the others'): whole paragraphs where they
 * fit, else as many whole sentences as fit (words when one sentence is longer than a slide); a
 * subhead is kept with what follows it.
 */
function paginate(items: StoryText[], measured: Map<StoryText, Measured>, size: number, boxes: (i: number) => Box, bulleted: (t: StoryText) => boolean): Piece[][] {
  const pages: Piece[][] = [[]]
  let room = boxes(0).height
  const sizeOf = (t: StoryText): number => (t.sub ? size * 1.05 : size)
  const widthFor = (t: StoryText, i: number): number => boxes(i).width - (bulleted(t) ? size * 1.2 : 0)
  const newPage = (): void => {
    pages.push([])
    room = boxes(pages.length - 1).height
  }
  for (const [k, item] of items.entries()) {
    const m = measured.get(item)!
    const sz = sizeOf(item)
    const pitch = 1.2 * sz
    const after = sz * 0.5
    let from = 0
    let guard = 0
    while (from < m.text.length && guard++ < 1000) {
      const page = pages[pages.length - 1]!
      const width = widthFor(item, pages.length - 1)
      const need = linesOf(m, sz, width, from) * pitch
      // A subhead needs room for two lines of what follows it.
      const next = items[k + 1]
      const keep = item.sub && next && from === 0 ? 2 * 1.2 * sizeOf(next) + after : 0
      if (need + keep <= room + 0.5 || (!page.length && item.sub)) {
        page.push({ item, from, to: m.text.length })
        room -= need + after
        break
      }
      const fit = Math.floor((room + 0.5) / pitch)
      if (item.sub || fit < 2) {
        if (!page.length && fit >= 1) {
          // Not even two lines on an empty slide: what fits, then on.
        } else {
          newPage()
          continue
        }
      }
      // As many whole sentences as fit; on an empty slide, as many words.
      let cut = -1
      for (const e of sentenceEnds(m.text)) {
        if (e <= from) continue
        if (linesOf(m, sz, width, from, e) <= fit) cut = e
        else break
      }
      if (cut < 0 && !page.length) {
        for (const w of m.words) {
          if (w.start < from) continue
          if (linesOf(m, sz, width, from, w.end) <= fit) cut = w.end
          else break
        }
      }
      if (cut > from) {
        page.push({ item, from, to: cut })
        from = cut
        while (m.text[from] === ' ') from++
      }
      newPage()
    }
  }
  // The first stays, empty or not: it is the first slide's.
  return pages.filter((p, i) => i === 0 || p.length)
}

const textLength = (pieces: Piece[]): number => pieces.reduce((n, p) => n + p.to - p.from, 0)

class DeckWriter {
  readonly slides: Slide[] = []
  readonly media: Media[] = []
  constructor(
    readonly accent: string,
    readonly rtl: boolean,
    readonly body: number
  ) {}

  slide(notes: string): Slide {
    const s: Slide = { sx: new SlideXml(this.media, 1, 0, 0), parts: [], notes }
    this.slides.push(s)
    return s
  }

  /** A headline set to fit `width`: the largest of a few sizes that keeps it to `most` lines. */
  titleFit(runs: StyleRun[], sizes: number[], width: number, most: number): { size: number; lines: number } {
    const m = measure(runs, 'title')
    for (const size of sizes) {
      const lines = linesOf(m, size, width)
      if (lines <= most) return { size, lines }
    }
    const size = sizes[sizes.length - 1]!
    return { size, lines: linesOf(m, size, width) }
  }

  /** The story's heading on its first slide: kicker, headline, rule. Where the content starts. */
  header(s: Slide, story: Story, rtl: boolean): number {
    if (!story.title) return TOP
    const sx = s.sx
    let y = TOP
    if (story.kicker) {
      const kr = plainRuns(story.kicker, story.titleRuns[0])
      s.parts.push(textBoxXml(sx, SIDE, y, W - 2 * SIDE, 22, paraXml(sx, kr, rtl, { size: 15, role: 'body', colour: this.accent, after: 0 }, this.accent)))
      y += 24
    }
    const { size, lines } = this.titleFit(story.titleRuns, [34, 30, 26, 22], W - 2 * SIDE, 2)
    const height = lines * 1.2 * 0.92 * size + 4
    s.parts.push(textBoxXml(sx, SIDE, y, W - 2 * SIDE, height, paraXml(sx, story.titleRuns, story.titleRtl, { size, role: 'title', colour: INK, after: 0, spacing: 92 }, this.accent)))
    y += height + 8
    s.parts.push(ruleXml(sx, rtl ? W - SIDE - 56 : SIDE, y, 56, 3, this.accent))
    return y + 3 + 16
  }

  /** The story's title again on a slide that goes on with it: small, grey, one line. Where the content starts. */
  smallHeader(s: Slide, story: Story): number {
    if (!story.title) return TOP
    const runs = clipped(story.titleRuns, 'title', 18, W - 2 * SIDE, 1)
    s.parts.push(textBoxXml(s.sx, SIDE, TOP, W - 2 * SIDE, 24, paraXml(s.sx, runs, story.titleRtl, { size: 18, role: 'title', colour: GREY, after: 0 }, this.accent)))
    return TOP + 24 + 16
  }

  contents(stories: Story[], cover: DeckOptions['cover']): void {
    const titled = stories.filter((s) => s.title)
    if (titled.length < 2) return
    const s = this.slide(titled.map((t) => t.title).join('\n'))
    const sx = s.sx
    let textX = SIDE
    let textW = W - 2 * SIDE
    if (cover) {
      const ratio = cover.width / Math.max(1, cover.height)
      let ph = H - 56
      let pw = ph * ratio
      if (pw > W * 0.42) {
        pw = W * 0.42
        ph = pw / ratio
      }
      const px = this.rtl ? 28 : W - 28 - pw
      s.parts.push(pictureXml(sx, cover.data, 'jpg', undefined, [px, (H - ph) / 2, pw, ph], '', true))
      textW = W - pw - 28 - 36 - SIDE
      textX = this.rtl ? px + pw + 36 : SIDE
    }
    const heading = plainRuns(this.rtl ? 'المحتويات' : 'Contents')
    s.parts.push(textBoxXml(sx, textX, TOP + 6, textW, 44, paraXml(sx, heading, this.rtl, { size: 32, role: 'title', colour: this.accent, after: 0 }, this.accent)))
    // The biggest headlines (the main stories), in the order they come.
    const list = [...titled]
      .sort((a, b) => b.titleSize - a.titleSize)
      .slice(0, 12)
      .sort((a, b) => stories.indexOf(a) - stories.indexOf(b))
    const room = BOTTOM - (TOP + 66)
    let size = 18
    // Each headline on two lines at most.
    const runsOf = (t: Story): StyleRun[] => clipped(t.titleRuns, 'body', size, textW - size * 1.2, 2)
    const height = (): number => list.reduce((n, t) => n + linesOf(measure(runsOf(t), 'body'), size, textW - size * 1.2) * 1.2 * size + size * 0.55, 0)
    while (size > 12 && height() > room) size -= 1
    // Each set in the deck's direction, so the list keeps to one side.
    const paras = list.map((t) => paraXml(sx, runsOf(t), this.rtl, { size, role: 'body', colour: INK, after: size * 0.55, bullet: '■', plain: true }, this.accent)).join('')
    s.parts.push(textBoxXml(sx, textX, TOP + 66, textW, room, paras))
  }

  /** A page title with a line or two under it: a slide of its own on a tinted ground. */
  section(story: Story, notes: string): void {
    const s = this.slide(notes)
    s.background = SECTION_FILL
    const sx = s.sx
    const rtl = story.titleRtl
    const { size, lines } = this.titleFit(story.titleRuns, [48, 42, 36, 30], W - 2 * SIDE - 80, 3)
    const height = lines * 1.2 * 0.92 * size + 6
    s.parts.push(textBoxXml(sx, SIDE + 40, 290 - height, W - 2 * SIDE - 80, height, paraXml(sx, story.titleRuns, rtl, { size, role: 'title', colour: INK, after: 0, spacing: 92 }, this.accent), 'b'))
    s.parts.push(ruleXml(sx, rtl ? W - SIDE - 40 - 72 : SIDE + 40, 306, 72, 4, this.accent))
    const paras = story.paragraphs.map((p) => paraXml(sx, p.runs, p.rtl, { size: 22, role: 'body', colour: this.accent, after: 8 }, this.accent)).join('')
    if (paras) s.parts.push(textBoxXml(sx, SIDE + 40, 328, W - 2 * SIDE - 80, BOTTOM - 328, paras))
  }

  story(story: Story, mode: DeckOptions['text']): void {
    const notes = notesOf(story)
    // The side the text reads from (where the picture is not): the text's own direction, the headline's when there is none.
    const rtl = story.paragraphs.length ? story.paragraphs.filter((p) => p.rtl).length * 2 > story.paragraphs.length : story.titleRtl
    const chars = story.paragraphs.reduce((n, p) => n + p.text.length, 0)
    const pictures = story.pictures
    if (story.title && story.paragraphs.length && !pictures.length && !story.tables.length && (story.paragraphs.every((p) => p.sub) || (story.titleSize >= this.body * 2.5 && chars < 260))) {
      this.section(story, notes)
      return
    }
    const plain = story.paragraphs.filter((p) => !p.sub)
    // Short labels round a picture (a guide's callouts), or a list of short points: bullets.
    const bullets = plain.length >= 2 && plain.every((p) => p.text.length < 160) && (pictures.length > 0 || chars / plain.length < 90)
    let items = story.paragraphs
    if (mode === 'opening' && !bullets) {
      const first = items.findIndex((p) => !p.sub)
      items = first < 0 ? items : items.slice(0, first + 1)
    }
    // A numbered item keeps its number in its text; a bulleted one (or any, among callouts) takes a bullet.
    const shown = new Map(items.map((t) => [t, t.marker && t.marker !== '•' && t.runs.length ? [{ ...t.runs[0]!, text: `${t.marker} ` }, ...t.runs] : t.runs]))
    const numbered = (t: StoryText): boolean => (!!t.marker && t.marker !== '•') || /^[\d٠-٩]+[.)]\s/u.test(t.text)
    const bulleted = (t: StoryText): boolean => !t.sub && (t.marker === '•' || (bullets && !numbered(t)))
    const measured = new Map(items.map((t) => [t, measure(shown.get(t)!, t.sub ? 'title' : 'body')]))

    // The first slide: where its text starts depends on the headline's lines.
    const first = this.slide(notes)
    const top = this.header(first, story, story.titleRtl)
    const main = pictures[0]
    let picture: { box: Box4; caption: Box4 | null; item: (typeof pictures)[number] } | null = null
    let textX = SIDE
    let textW = W - 2 * SIDE
    if (main) {
      const ratio = (main.picture.box[2] - main.picture.box[0]) / Math.max(1, main.picture.box[3] - main.picture.box[1])
      // With no text, the picture takes the slide; a wide one (a screenshot, a chart) with little text, most of it.
      const share = !items.length ? 1 : ratio >= 1.2 && chars < 600 ? 0.58 : 0.42
      const colW = share === 1 ? W - 2 * SIDE : (W - 2 * SIDE - GAP) * share
      const colX = share === 1 ? SIDE : rtl ? SIDE : W - SIDE - colW
      // The caption under the picture as wide as the picture (200 points at least): fitted twice, as its lines depend on that width.
      let capW = colW
      let capLines = captionLines(main.caption, capW)
      let box = fitted(main.picture, colX, top, colW, BOTTOM - top - (capLines ? capLines * 14.4 + 6 : 0))
      capW = Math.min(colW, Math.max(box[2], 200))
      if (captionLines(main.caption, capW) !== capLines) {
        capLines = captionLines(main.caption, capW)
        box = fitted(main.picture, colX, top, colW, BOTTOM - top - (capLines ? capLines * 14.4 + 6 : 0))
      }
      if (share < 1) {
        // A tall picture leaves its column's spare width to the text, and keeps to the slide's edge.
        const spare = colW - box[2]
        box = [rtl ? SIDE : W - SIDE - box[2], box[1], box[2], box[3]]
        textW = W - 2 * SIDE - GAP - colW + spare
        textX = rtl ? W - SIDE - textW : SIDE
      }
      const capX = Math.min(Math.max(SIDE, box[0] + box[2] / 2 - capW / 2), W - SIDE - capW)
      picture = { box, caption: capLines ? [capX, box[1] + box[3] + 6, capW, capLines * 14.4 + 2] : null, item: main }
    }

    let size = bullets ? 18 : 20
    const boxes = (i: number): Box => (i === 0 ? { width: textW, height: BOTTOM - top } : { width: W - 2 * SIDE, height: BOTTOM - (story.title ? TOP + 40 : TOP) })
    let pages = items.length ? paginate(items, measured, size, boxes, bulleted) : []
    // A last slide with only a few words: a point or two smaller if that saves it.
    if (pages.length > 1 && textLength(pages[pages.length - 1]!) < 260) {
      for (const smaller of [size - 1, size - 2]) {
        const again = paginate(items, measured, smaller, boxes, bulleted)
        if (again.length < pages.length) {
          pages = again
          size = smaller
          break
        }
      }
    }
    // The opening: what the first slide holds (the slide after it when the headline left no room).
    if (mode === 'opening') pages = pages[0]?.length ? pages.slice(0, 1) : pages.slice(0, 2)

    const textXml = (s: Slide, pieces: Piece[]): string =>
      pieces
        .map((p) => {
          const all = shown.get(p.item)!
          const runs = p.from === 0 && p.to === measured.get(p.item)!.text.length ? all : sliceRuns(all, p.from, p.to)
          const sz = p.item.sub ? size * 1.05 : size
          return paraXml(s.sx, runs, p.item.rtl, { size: sz, role: p.item.sub ? 'title' : 'body', colour: p.item.sub ? this.accent : null, after: sz * 0.5, bullet: bulleted(p.item) ? '•' : undefined }, this.accent)
        })
        .join('')

    // The first slide's text may be empty (a headline that left no room): the text then starts on the next.
    const firstPieces = pages[0] ?? []
    if (firstPieces.length) first.parts.push(textBoxXml(first.sx, textX, top, textW, BOTTOM - top, textXml(first, firstPieces)))
    if (picture) {
      first.parts.push(pictureXml(first.sx, picture.item.picture.data, picture.item.picture.type, picture.item.picture.svg, picture.box, picture.item.caption))
      const [cx, cy, cw, ch] = picture.caption ?? [0, 0, 0, 0]
      if (picture.caption) first.parts.push(textBoxXml(first.sx, cx, cy, cw, ch, paraXml(first.sx, plainRuns(picture.item.caption), rtl, { size: 12, role: 'body', colour: GREY, after: 0 }, this.accent)))
    }
    for (const pieces of pages.slice(1)) {
      const s = this.slide(notes)
      const y = this.smallHeader(s, story)
      s.parts.push(textBoxXml(s.sx, SIDE, y, W - 2 * SIDE, BOTTOM - y, textXml(s, pieces)))
    }
    this.gallery(story, pictures.slice(1), notes, rtl)
    // A story that is only a table: its first rows under the headline.
    const alone = !firstPieces.length && !picture
    story.tables.forEach((t, i) => this.table(story, t, notes, i === 0 && alone ? { slide: first, top } : null))
  }

  /** Further pictures, up to three a slide, each with its caption. */
  gallery(story: Story, pictures: Story['pictures'], notes: string, rtl: boolean): void {
    const shown = pictures.filter((p) => Math.min(p.picture.box[2] - p.picture.box[0], p.picture.box[3] - p.picture.box[1]) >= 60)
    for (let i = 0; i < shown.length; i += 3) {
      const group = shown.slice(i, i + 3)
      const s = this.slide(notes)
      const top = this.smallHeader(s, story)
      const colW = (W - 2 * SIDE - (group.length - 1) * GAP) / group.length
      group.forEach((p, j) => {
        const x = rtl ? W - SIDE - (j + 1) * colW - j * GAP : SIDE + j * (colW + GAP)
        const capLines = captionLines(p.caption, colW)
        const capH = capLines ? capLines * 14.4 + 6 : 0
        const box = fitted(p.picture, x, top, colW, BOTTOM - top - capH)
        s.parts.push(pictureXml(s.sx, p.picture.data, p.picture.type, p.picture.svg, box, p.caption))
        if (capLines) s.parts.push(textBoxXml(s.sx, x, box[1] + box[3] + 6, colW, capH, paraXml(s.sx, plainRuns(p.caption), rtl, { size: 12, role: 'body', colour: GREY, after: 0 }, this.accent)))
      })
    }
  }

  /** A table as a PowerPoint table, its rows over as many slides as they need (a bold first row repeated). */
  table(story: Story, t: TableBlock, notes: string, start0: { slide: Slide; top: number } | null): void {
    const columns = Math.max(1, t.columns.length)
    const size = columns > 9 ? 10 : columns > 6 ? 12 : 14
    const total = t.columns.reduce((n, w) => n + w, 0)
    const width = W - 2 * SIDE
    const colW = t.columns.map((w) => (total > 0 ? (w / total) * width : width / columns))
    const pad = 5
    const cellText = (cell: TableBlock['rows'][number][number]): ParagraphBlock[] => cell.paragraphs.filter((p) => p.runs.some((r) => r.text.trim()))
    const rowHeight = (row: TableBlock['rows'][number]): number => {
      let tallest = 0
      let col = 0
      for (const cell of row) {
        const w = colW.slice(col, col + cell.span).reduce((n, v) => n + v, 0) - 2 * pad
        col += cell.span
        const lines = cellText(cell).reduce((n, p) => n + Math.max(1, linesOf(measure(cleanRuns(p.runs), 'body'), size, w)), 0)
        tallest = Math.max(tallest, Math.max(1, lines) * 1.2 * size)
      }
      return tallest + 2 * pad
    }
    const heights = t.rows.map(rowHeight)
    const head = t.rows[0]?.every((c) => cellText(c).every((p) => p.runs.every((r) => r.bold || !r.text.trim()))) && t.rows.length > 2
    let start = 0
    let given = start0
    while (start < t.rows.length) {
      const s = given?.slide ?? this.slide(notes)
      const top = given?.top ?? this.smallHeader(s, story)
      given = null
      const room = BOTTOM - top
      const rows: number[] = []
      let used = 0
      if (head && start > 0) {
        rows.push(0)
        used += heights[0]!
      }
      let r = start
      while (r < t.rows.length && (rows.length === 0 || (head && start > 0 && rows.length === 1) || used + heights[r]! <= room)) {
        rows.push(r)
        used += heights[r]!
        r++
      }
      start = r
      s.parts.push(this.tableXml(s.sx, t, rows, colW, heights, size, pad, top, head ?? false))
    }
  }

  tableXml(sx: SlideXml, t: TableBlock, rows: number[], colW: number[], heights: number[], size: number, pad: number, top: number, head: boolean): string {
    const id = sx.id()
    const grid = colW.map((w) => `<a:gridCol w="${Math.round(w * EMU)}"/>`).join('')
    const border = (side: string): string => `<a:ln${side} w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill><a:prstDash val="solid"/></a:ln${side}>`
    const filler = '<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" sz="100" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>'
    const body = rows
      .map((r) => {
        const isHead = head && r === 0
        const cells = t.rows[r]!.map((cell) => {
          const paras = cell.paragraphs
            .filter((p) => p.runs.some((x) => x.text.trim()))
            .map((p) => paraXml(sx, cleanRuns(p.runs), p.rtl, { size, role: isHead ? 'title' : 'body', colour: isHead ? INK : null, after: 0 }, this.accent))
            .join('')
          const text = paras || `<a:p><a:endParaRPr lang="en-US" sz="${size * 100}" dirty="0"/></a:p>`
          const m = Math.round(pad * EMU)
          const fill = isHead ? `<a:solidFill><a:srgbClr val="F3F4F6"/></a:solidFill>` : '<a:noFill/>'
          return `<a:tc${cell.span > 1 ? ` gridSpan="${cell.span}"` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${text}</a:txBody><a:tcPr marL="${m}" marR="${m}" marT="${m}" marB="${m}" anchor="t">${border('L')}${border('R')}${border('T')}${border('B')}${fill}</a:tcPr></a:tc>${filler.repeat(cell.span - 1)}`
        }).join('')
        return `<a:tr h="${Math.round(heights[r]! * EMU)}">${cells}</a:tr>`
      })
      .join('')
    const width = colW.reduce((n, w) => n + w, 0)
    const height = rows.reduce((n, r) => n + heights[r]!, 0)
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(SIDE * EMU)}" y="${Math.round(top * EMU)}"/><a:ext cx="${Math.round(width * EMU)}" cy="${Math.round(height * EMU)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"${t.rtl ? ' rtl="1"' : ''}/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  }
}

/** Runs with their spaces collapsed, trimmed at both ends (a table cell's text). */
function cleanRuns(runs: StyleRun[]): StyleRun[] {
  return sliceRuns(
    runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') })),
    0,
    Infinity
  )
}

/** The whole story as plain text: each of its slides' notes. */
function notesOf(story: Story): string {
  const tables = story.tables.map((t) => t.rows.map((row) => row.map((c) => c.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').replace(/\s+/g, ' ').trim()).join(' | ')).join('\n'))
  return [story.kicker, story.title, ...story.paragraphs.map((p) => p.text), ...story.pictures.map((p) => p.caption), ...tables]
    .filter((t) => t.trim())
    .join('\n\n')
}

export async function writeDeck(model: DocModel, options: DeckOptions): Promise<{ bytes: Uint8Array; stories: number; slides: number }> {
  const stories = storiesOf(model)
  const rtl = model.pages.filter((p) => p.rtl).length * 2 > model.pages.length
  const deck = new DeckWriter(accentOf(stories), rtl, model.bodySize || 10)
  deck.contents(stories, options.cover)
  for (const s of stories) deck.story(s, options.text)
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.author = BRAND.name
  const title = stories.find((s) => s.title)?.title
  if (title) pres.title = title
  if (rtl) pres.rtlMode = true
  for (const s of deck.slides) {
    const slide = pres.addSlide()
    if (s.background) slide.background = { color: s.background }
    const notes = s.notes.replace(CONTROL, '')
    if (notes) slide.addNotes(notes)
  }
  const bytes = await withShapes(
    pres,
    deck.slides.map((s) => ({ sx: s.sx, shapes: s.parts.join('') })),
    deck.media
  )
  return { bytes, stories: stories.length, slides: deck.slides.length }
}

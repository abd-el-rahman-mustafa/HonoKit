import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { BRAND } from '@shared/brand'
import type { StyleRun } from '../paragraphs'
import type { DocModel, LineBlock, PageModel, ParagraphBlock, PictureBlock } from './model'
import { directedRuns } from './bidiruns'
import { fontsFor } from './fonts'
import { spacingToFit } from './measure'

/**
 * The model as a PowerPoint deck (research §4.2, §7): one slide per page, looking like the page.
 * The page's drawings without text lie behind as the slide's background (art.ts: boxes, rules,
 * shading, logos, charts); pictures are their own movable objects where they were; text is
 * editable, in text boxes that keep the PDF's lines — each printed line ends where it ended,
 * nothing wraps anew, and the letter spacing is set so a line in Office's font is as wide as
 * printed (measure.ts). Ruled tables are text over the background's own rules and shading.
 *
 * Arabic: right-to-left paragraphs (rtl="1"), the Arabic font in the complex-script slot and the
 * Latin one in the Latin slot, so digits and Latin words keep a Latin font. pptxgenjs writes one
 * face for all three slots with charsets of Chinese code pages, which made Office substitute a
 * Chinese font for a missing one (digits drawn as "ĈĆĈ", Arabic names as boxes); the slots are
 * written again after (fixFonts).
 */

const inch = (pt: number): number => pt / 72
const hex = (c: [number, number, number]): string => c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
/** Joins the Latin and Arabic faces in one name, split again by fixFonts. */
const SPLIT = '|'

function picture(slide: PptxGenJS.Slide, b: PictureBlock, s: number, dx: number, dy: number): void {
  const [x0, y0, x1, y1] = b.box
  slide.addImage({ data: `image/${b.type === 'jpg' ? 'jpeg' : 'png'};base64,${Buffer.from(b.data).toString('base64')}`, x: inch(dx + x0 * s), y: inch(dy + y0 * s), w: inch((x1 - x0) * s), h: inch((y1 - y0) * s) })
}

function runProps(r: StyleRun, rtl: boolean, s: number, spacing: number, rtlPiece: boolean): PptxGenJS.TextPropsOptions {
  const fonts = fontsFor(r)
  return {
    bold: r.bold,
    italic: r.italic,
    fontSize: Math.max(1, Math.round(r.size * s * 100) / 100),
    color: hex(r.colour),
    fontFace: `${fonts.latin}${SPLIT}${fonts.arabic}`,
    ...(Math.abs(spacing) > 0.01 ? { charSpacing: Math.round(spacing * s * 100) / 100 } : {}),
    ...(rtl ? { rtlMode: true } : {}),
    lang: rtlPiece ? 'ar-AE' : 'en-US'
  }
}

/**
 * Lines of one paragraph that share a start edge go in one text box (a hanging bullet's first line
 * and the rest, a first-line indent and the rest are two), so every line starts where it did.
 */
function segments(b: ParagraphBlock): LineBlock[][] {
  if (b.alignment === 'centre' || b.alignment === 'end') return [b.lines]
  const startOf = (l: LineBlock): number => (b.rtl ? l.box[2] : l.box[0])
  const out: LineBlock[][] = []
  for (const line of b.lines) {
    const last = out[out.length - 1]
    if (last && Math.abs(startOf(last[last.length - 1]!) - startOf(line)) < Math.max(2, line.runs[0]?.size ?? 10) * 0.3) last.push(line)
    else out.push([line])
  }
  return out
}

function paragraphBoxes(slide: PptxGenJS.Slide, b: ParagraphBlock, s: number, dx: number, dy: number): void {
  // A bullet in its own box at its place: its text then starts where it did, not a space after it.
  for (const l of b.lines)
    if (l.marker?.runs.length) paragraphBoxes(slide, { ...b, alignment: 'start', lines: [{ runs: l.marker.runs, box: l.marker.box, baseline: l.baseline }] }, s, dx, dy)
  const lines = b.lines.filter((l) => l.runs.length > 0)
  if (lines.length === 0) return
  for (const seg of segments({ ...b, lines })) {
    const x0 = Math.min(...seg.map((l) => l.box[0]))
    const x1 = Math.max(...seg.map((l) => l.box[2]))
    const y0 = Math.min(...seg.map((l) => l.box[1]))
    const y1 = Math.max(...seg.map((l) => l.box[3]))
    const size = Math.max(...seg.flatMap((l) => l.runs.map((r) => r.size)))
    const pitch = seg.length > 1 ? (seg[seg.length - 1]!.baseline - seg[0]!.baseline) / (seg.length - 1) : size * 1.2
    const align = b.alignment === 'centre' ? 'center' : (b.alignment === 'end') !== b.rtl ? 'right' : 'left'
    // PowerPoint draws exact line spacing in whole points (11.5 came out 12, a line lower every
    // second line): whole points below the pitch, and a point of space before the lines that
    // keep the sum on the printed baselines (each line is a paragraph of its own).
    const scaled = pitch * s
    const whole = Math.floor(scaled)
    const extra = (i: number): number => (i === 0 ? 0 : Math.floor(i * (scaled - whole) + 0.5) - Math.floor((i - 1) * (scaled - whole) + 0.5))
    const props: PptxGenJS.TextProps[] = []
    seg.forEach((line, i) => {
      const spacing = spacingToFit(line.runs, line.box[2] - line.box[0])
      const pieces = directedRuns(line.runs, b.rtl)
      pieces.forEach((r, k) => {
        const last = k === pieces.length - 1 && i < seg.length - 1
        const before = k === 0 && seg.length > 1 && extra(i) > 0 ? { paraSpaceBefore: extra(i) } : {}
        props.push({ text: r.text, options: { ...runProps(r, b.rtl, s, spacing, r.rtl), ...before, ...(last ? { breakLine: true } : {}) } })
      })
    })
    // Room for the text a little wider than printed; the box is placed by its start edge (wrap is off).
    const w = (x1 - x0) * 1.02 + size * 0.2
    const left = align === 'right' ? x1 - w : align === 'center' ? (x0 + x1) / 2 - w / 2 : x0
    slide.addText(props, {
      x: inch(dx + left * s),
      y: inch(dy + y0 * s),
      w: inch(w * s),
      h: inch(Math.max(y1 - y0, size) * s),
      margin: 0,
      valign: 'top',
      align,
      wrap: false,
      fit: 'none',
      rtlMode: b.rtl,
      lang: b.rtl ? 'ar-AE' : 'en-US',
      paraSpaceBefore: 0,
      paraSpaceAfter: 0,
      ...(seg.length > 1 ? { lineSpacing: whole } : {})
    })
  }
}

function slideOf(pres: PptxGenJS, page: PageModel, slideW: number, slideH: number): void {
  const slide = pres.addSlide()
  // A page of another size is scaled to fit the slide, centred.
  const s = Math.min(slideW / page.width, slideH / page.height)
  const dx = (slideW - page.width * s) / 2
  const dy = (slideH - page.height * s) / 2
  if (page.background) {
    if (s === 1) slide.background = { data: `image/${page.background.type === 'jpg' ? 'jpeg' : 'png'};base64,${Buffer.from(page.background.data).toString('base64')}` }
    else picture(slide, page.background, s, dx, dy)
  }
  for (const b of page.blocks) {
    if (b.kind === 'picture') picture(slide, b, s, dx, dy)
    else if (b.kind === 'paragraph') paragraphBoxes(slide, b, s, dx, dy)
    else
      for (const row of b.rows)
        for (const cell of row) {
          for (const p of cell.pictures) picture(slide, p, s, dx, dy)
          for (const p of cell.paragraphs) paragraphBoxes(slide, p, s, dx, dy)
        }
  }
  // The page's text in the notes: found by PowerPoint's search and read by screen readers in order.
  const notes = page.blocks
    .flatMap((b) => (b.kind === 'paragraph' ? [b] : b.kind === 'table' ? b.rows.flat().flatMap((c) => c.paragraphs) : []))
    .map((p) => p.runs.map((r) => r.text).join(''))
    .filter((t) => t.trim())
    .join('\n')
  if (notes) slide.addNotes(notes)
}

/**
 * Each run's Latin and Arabic faces in their own slots, without pptxgenjs's charsets; and one
 * paragraph-properties element per paragraph, first, as the format requires (pptxgenjs writes one
 * before every run; the first, from the line's first run, is the paragraph's).
 */
async function fixFonts(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const pattern = /<a:(latin|ea|cs) typeface="([^"|]*)\|([^"]*)"[^>]*\/>/g
  const paraProps = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n))) {
    const xml = await zip.file(name)!.async('string')
    zip.file(
      name,
      xml
        .replace(pattern, (_m, slot: string, latin: string, arabic: string) => `<a:${slot} typeface="${slot === 'cs' ? arabic : latin}"/>`)
        .replace(/<a:p>[\s\S]*?<\/a:p>/g, (p) => {
          let n = 0
          return p.replace(paraProps, (pPr) => (n++ === 0 ? pPr : ''))
        })
    )
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
}

export async function writePptx(model: DocModel): Promise<Uint8Array> {
  const pres = new PptxGenJS()
  const first = model.pages[0] ?? { width: 960, height: 540, blocks: [], rtl: false, background: null }
  pres.defineLayout({ name: 'PDF', width: inch(first.width), height: inch(first.height) })
  pres.layout = 'PDF'
  pres.author = BRAND.name
  if (first.rtl) pres.rtlMode = true
  for (const page of model.pages) slideOf(pres, page, first.width, first.height)
  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer
  return fixFonts(new Uint8Array(out))
}


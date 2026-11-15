import type { StyleRun } from '../paragraphs'
import type { RGB } from './drawings'
import type { Block, Box, DocModel, PageModel, ParagraphBlock, PictureBlock, TableBlock } from './model'

/**
 * The stories a PDF tells, for "Make a presentation" (decisions §123, research-pdf-to-office.md §11):
 * slides built from what the pages say rather than one slide copying each page. A story is a
 * headline with what belongs to it — the line over it (kicker), its subheads, its text in reading
 * order, its pictures with their captions, its tables. Works on the flowing model (`modelOf` with
 * figures, no art), whatever the page: a newspaper front page with stories side by side, a guide
 * with one heading and a screenshot per page, a report whose sections run over several pages.
 *
 * 1. Headlines: paragraphs well above body size (≥ 1.25 ×), a few lines, with letters; same-size
 *    headings stacked closely are one (a standfirst set as three paragraphs).
 * 2. Kicker: a smaller line just above a headline and over it.
 * 3. Headlines by size, largest first: a much smaller heading (≤ 0.72 ×) inside a bigger one's
 *    region and close under what is above it is that story's subhead; any other starts a story.
 *    A story's region is its headline's width (widened to the block under it) down to the next
 *    headline below it.
 * 4. Everything else goes to the story whose region holds its centre (the nearest headline
 *    above); on pages whose headlines stand one under another, to the one headline whose band
 *    holds it; above a page's first headline, to the previous page's last story when that one
 *    spans the page (single-column documents). Running heads and feet, and small text printed over
 *    a photo (a magazine cover's own cover lines), are left out.
 * 5. Pictures (not strips or icons) go to their story, a small line right under one is its caption.
 * 6. A story's text in reading order: an XY-cut inside the story (columns first, right to left in
 *    Arabic; bands where a subhead spans the columns); a sentence a column break cut is joined.
 */

export interface StoryText {
  runs: StyleRun[]
  text: string
  rtl: boolean
  /** A subhead (or a short bold lead line) inside the story. */
  sub: boolean
  /** A list item's marker: its number as printed ("3.", "٣)"), "•" for a bullet, else empty. */
  marker: string
}

export interface StoryPicture {
  picture: PictureBlock
  caption: string
}

export interface Story {
  /** Index in the model's pages. */
  page: number
  /** Where the headline unit starts on its page (points from the top). */
  top: number
  kicker: string
  kickerColour: RGB | null
  /** Empty for the text of a page with no headline (a letter). */
  title: string
  titleRuns: StyleRun[]
  titleRtl: boolean
  /** The headline's size as printed (points). */
  titleSize: number
  paragraphs: StoryText[]
  /** Largest first. */
  pictures: StoryPicture[]
  tables: TableBlock[]
}

type Para = ParagraphBlock

const textOf = (b: Para): string =>
  b.runs
    .map((r) => r.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

/** The size most of the paragraph's letters have. */
function sizeOf(b: Para): number {
  const by = new Map<number, number>()
  for (const r of b.runs) {
    const k = Math.round(r.size * 2) / 2
    by.set(k, (by.get(k) ?? 0) + r.text.length)
  }
  let best = 0
  let most = -1
  for (const [k, n] of by)
    if (n > most) {
      best = k
      most = n
    }
  return best
}

const overlapX = (a: Box, b: Box): number => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
const widthOf = (b: Box): number => b[2] - b[0]
const heightOf = (b: Box): number => b[3] - b[1]
const LETTERS = /\p{L}{3}/u
const DIGITS = /[\d٠-٩۰-۹]+/g
/** The end of a sentence: a column break after it is a paragraph break. */
const CLOSED = /[.!?؟»"”:)]$/u
const MARKER = /^[{•▪]\s*/u

/** Runs with their spaces collapsed, trimmed at both ends. */
function cleanRuns(runs: StyleRun[]): StyleRun[] {
  const out = runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') })).filter((r) => r.text.length > 0)
  if (out.length) {
    out[0] = { ...out[0]!, text: out[0]!.text.trimStart() }
    out[out.length - 1] = { ...out[out.length - 1]!, text: out[out.length - 1]!.text.trimEnd() }
  }
  return out.filter((r) => r.text.length > 0)
}

/** A real picture: not a strip (a rule, a banner, a headline's backing) and not an icon. */
function isPhoto(p: PictureBlock): boolean {
  const w = widthOf(p.box)
  const h = heightOf(p.box)
  return w > 40 && h > 40 && w / h < 4.5 && h / w < 4.5
}

/** Text repeated on many pages (numbers aside): running heads and feet. */
function runningText(model: DocModel): Set<string> {
  const out = new Set<string>()
  if (model.pages.length < 3) return out
  const seen = new Map<string, number>()
  for (const p of model.pages) {
    const texts = new Set(p.blocks.filter((b): b is Para => b.kind === 'paragraph').map((b) => textOf(b).replace(DIGITS, '#')))
    for (const t of texts) seen.set(t, (seen.get(t) ?? 0) + 1)
  }
  for (const [t, n] of seen) if (n >= Math.max(3, model.pages.length * 0.4)) out.add(t)
  return out
}

/**
 * The page's blocks as the stories see them: small text printed over a photo and specks left out,
 * and headings set as several stacked paragraphs of one size joined (copies; the model is not changed).
 */
function preparedBlocks(page: PageModel, body: number): Block[] {
  const photos = page.blocks.filter((b): b is PictureBlock => b.kind === 'picture' && isPhoto(b) && widthOf(b.box) * heightOf(b.box) > 6000)
  const inside = (b: Box, p: Box): boolean => b[0] >= p[0] - 1 && b[2] <= p[2] + 1 && b[1] >= p[1] - 1 && b[3] <= p[3] + 1
  const blocks = page.blocks.filter((b) => b.kind !== 'paragraph' || (textOf(b).length > 0 && sizeOf(b) >= 4 && !(sizeOf(b) < body * 0.8 && photos.some((p) => inside(b.box, p.box)))))
  const tall = (b: Para): boolean => sizeOf(b) >= body * 1.25 && b.lines.length <= 4
  const ordered = blocks.filter((b): b is Para => b.kind === 'paragraph').sort((a, b) => a.box[1] - b.box[1])
  const merged = new Map<Para, Para>()
  const gone = new Set<Para>()
  for (let i = 0; i < ordered.length; i++) {
    const first = ordered[i]!
    if (gone.has(first) || !tall(first)) continue
    let unit = first
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j]!
      if (gone.has(b) || !tall(b)) continue
      if (b.box[1] - unit.box[3] > sizeOf(unit) * 0.6) break
      if (Math.abs(sizeOf(b) - sizeOf(first)) > sizeOf(first) * 0.05 || overlapX(unit.box, b.box) < 0.5 * Math.min(widthOf(unit.box), widthOf(b.box))) continue
      unit = {
        ...unit,
        runs: [...unit.runs, { ...b.runs[0]!, text: ' ' }, ...b.runs],
        lines: [...unit.lines, ...b.lines],
        box: [Math.min(unit.box[0], b.box[0]), Math.min(unit.box[1], b.box[1]), Math.max(unit.box[2], b.box[2]), Math.max(unit.box[3], b.box[3])]
      }
      gone.add(b)
    }
    if (unit !== first) merged.set(first, unit)
  }
  return blocks.filter((b) => !gone.has(b as Para)).map((b) => (b.kind === 'paragraph' ? (merged.get(b) ?? b) : b))
}

interface Draft {
  story: Story
  headline: Para | null
  /** The headline with its kicker. */
  unit: Box
  region: Box
  texts: Array<{ para: Para; sub: boolean; page: number }>
}

export function storiesOf(model: DocModel): Story[] {
  const body = model.bodySize || 10
  const running = runningText(model)
  const drafts: Draft[] = []
  for (const [pageIndex, page] of model.pages.entries()) {
    const blocks = preparedBlocks(page, body)
    const paras = blocks.filter((b): b is Para => b.kind === 'paragraph')
    const isHeading = (b: Para): boolean => {
      const t = textOf(b)
      return (b.heading > 0 || sizeOf(b) >= body * 1.25) && b.lines.length <= 4 && LETTERS.test(t) && t.length >= 6 && t.length <= 160
    }
    const heads = paras.filter(isHeading).sort((a, b) => a.box[1] - b.box[1])
    // Kickers: a smaller line just above a headline and over it.
    const kickerOf = new Map<Para, Para>()
    const kickers = new Set<Para>()
    for (const h of heads) {
      const size = sizeOf(h)
      const above = paras
        .filter((k) => k !== h && !kickers.has(k) && k.box[3] <= h.box[1] + 2 && h.box[1] - k.box[3] < size * 1.1 && overlapX(k.box, h.box) > 0.5 * Math.min(widthOf(k.box), widthOf(h.box)) && sizeOf(k) * 1.15 < size && k.lines.length <= 2)
        .sort((a, b) => b.box[3] - a.box[3])[0]
      if (above) {
        kickerOf.set(h, above)
        kickers.add(above)
      }
    }
    const mains: Para[] = []
    const subs = new Set<Para>()
    const regionOf = (h: Para): Box => {
      const k = kickerOf.get(h)
      let x0 = Math.min(h.box[0], k?.box[0] ?? Infinity)
      let x1 = Math.max(h.box[2], k?.box[2] ?? -Infinity)
      // Widened to the first block under the headline that it overlaps (a left-set heading over its column).
      const under = blocks.filter((b) => b !== h && b.box[1] >= h.box[3] - 2 && b.box[1] - h.box[3] < sizeOf(h) * 2.5 && overlapX(b.box, h.box) > 0).sort((a, b) => a.box[1] - b.box[1])[0]
      if (under && (under.kind !== 'paragraph' || !isHeading(under))) {
        x0 = Math.min(x0, under.box[0])
        x1 = Math.max(x1, under.box[2])
      }
      const top = Math.min(h.box[1], k?.box[1] ?? Infinity)
      let bottom = page.height
      for (const m of mains) {
        if (m === h || m.box[1] <= h.box[3]) continue
        if (overlapX([x0, 0, x1, 0], m.box) > 0.3 * Math.min(x1 - x0, widthOf(m.box))) bottom = Math.min(bottom, m.box[1], kickerOf.get(m)?.box[1] ?? Infinity)
      }
      return [x0 - 4, top, x1 + 4, bottom]
    }
    /** How far a heading stands below whatever is printed just above it, over it. */
    const gapAbove = (h: Para): number => {
      let low = -Infinity
      for (const b of blocks) if (b !== h && b.box[3] <= h.box[1] + 2 && overlapX(b.box, h.box) > 0) low = Math.max(low, b.box[3])
      return h.box[1] - low
    }
    for (const h of heads.filter((x) => !kickers.has(x)).sort((a, b) => sizeOf(b) - sizeOf(a))) {
      const cx = (h.box[0] + h.box[2]) / 2
      const parent = mains.find((m) => {
        const r = regionOf(m)
        return cx > r[0] && cx < r[2] && h.box[1] > m.box[3] - sizeOf(m) * 0.3 && h.box[1] < r[3] && sizeOf(h) <= sizeOf(m) * 0.72 && gapAbove(h) < Math.max(body * 2.2, sizeOf(h) * 1.2)
      })
      if (parent) subs.add(h)
      else mains.push(h)
    }
    const local: Draft[] = mains.map((h) => {
      const k = kickerOf.get(h)
      const region = regionOf(h)
      const titleRuns = cleanRuns(h.runs)
      return {
        headline: h,
        unit: [Math.min(h.box[0], k?.box[0] ?? Infinity), region[1], Math.max(h.box[2], k?.box[2] ?? -Infinity), h.box[3]],
        region,
        texts: [],
        story: {
          page: pageIndex,
          top: region[1],
          kicker: k ? textOf(k) : '',
          kickerColour: k?.runs.find((r) => r.text.trim())?.colour ?? null,
          title: textOf(h),
          titleRuns,
          titleRtl: h.rtl,
          titleSize: sizeOf(h),
          paragraphs: [],
          pictures: [],
          tables: []
        }
      }
    })
    const sideBySide = mains.some((m, i) => mains.some((n, j) => j > i && overlapX(m.box, n.box) <= 0 && Math.min(m.box[3], n.box[3]) - Math.max(m.box[1], n.box[1]) > -sizeOf(m) * 2))
    const previous = drafts[drafts.length - 1]
    const spans = (d: Draft | undefined): boolean => !!d && widthOf(d.region) > 0.6 * model.pages[d.story.page]!.width
    // A page with no headline: the previous page's last story goes on; on the first page (a letter), one untitled story.
    if (!local.length && !previous) {
      local.push({
        headline: null,
        unit: [0, 0, page.width, 0],
        region: [0, 0, page.width, page.height],
        texts: [],
        story: { page: pageIndex, top: 0, kicker: '', kickerColour: null, title: '', titleRuns: [], titleRtl: page.rtl, titleSize: 0, paragraphs: [], pictures: [], tables: [] }
      })
    }
    const owner = (b: { box: Box }): Draft | null => {
      const cx = (b.box[0] + b.box[2]) / 2
      const cy = (b.box[1] + b.box[3]) / 2
      const below = (d: Draft): boolean => b.box[1] >= d.unit[3] - Math.max(4, d.story.titleSize * 0.3)
      const fits = local.filter((d) => cx >= d.region[0] && cx <= d.region[2] && cy >= d.region[1] && cy <= d.region[3] && below(d))
      if (fits.length) return fits.sort((a, c) => c.story.top - a.story.top)[0]!
      // Beside a narrow heading, on a page whose headlines stand one under another: the one whose band holds it.
      const band = local.filter((d) => cy >= d.region[1] && cy <= d.region[3] && below(d))
      if (band.length === 1 && !sideBySide) return band[0]!
      // Above the page's first headline: the previous page's last story goes on (single-column documents).
      if (!local.some((d) => d.story.top <= b.box[1]) && previous && (spans(previous) || !local.length)) return previous
      return null
    }
    // Pictures, each with its caption: small lines right under it, or beside its foot (a caption set in the margin).
    const captions = new Set<Para>()
    for (const p of blocks.filter((b): b is PictureBlock => b.kind === 'picture' && isPhoto(b))) {
      let d = owner(p)
      // A picture no story's region holds (a cover between columns): the story above it it overlaps.
      if (!d && p.box[1] > page.height * 0.12) d = local.filter((x) => overlapX(x.region, p.box) > 0 && x.unit[3] <= p.box[1]).sort((a, c) => c.story.top - a.story.top)[0] ?? null
      if (!d) continue
      const small = (c: Para): boolean => !captions.has(c) && !isHeading(c) && c.lines.length <= 3 && /\p{L}/u.test(textOf(c)) && (sizeOf(c) < body * 0.98 || MARKER.test(textOf(c)))
      const under = (c: Para): boolean => overlapX(c.box, p.box) > 0.3 * widthOf(c.box) && c.box[1] >= p.box[3] - 30 && c.box[1] - p.box[3] < 14
      const beside = (c: Para): boolean => c.box[1] >= p.box[1] && c.box[3] <= p.box[3] + 14 && widthOf(c.box) < 0.5 * widthOf(p.box) && (Math.abs(c.box[2] - p.box[0]) < 14 || Math.abs(c.box[0] - p.box[2]) < 14)
      const parts: Para[] = []
      for (const c of paras.filter((x) => small(x) && (under(x) || beside(x))).sort((a, c) => a.box[1] - c.box[1])) {
        // Fragments one under another make one caption; one set beside the picture starts with a caption mark (a letter's signature beside it is no caption).
        const last = parts[parts.length - 1]
        if (!last && !under(c) && !MARKER.test(textOf(c))) continue
        if (last && c.box[1] - last.box[3] > sizeOf(c) * 1.5) break
        parts.push(c)
      }
      for (const c of parts) captions.add(c)
      d.story.pictures.push({ picture: p, caption: parts.map((c) => textOf(c).replace(MARKER, '')).join(' ') })
    }
    for (const b of blocks) {
      if (b.kind === 'table') {
        owner(b)?.story.tables.push(b)
        continue
      }
      if (b.kind !== 'paragraph' || mains.includes(b) || kickers.has(b) || captions.has(b)) continue
      const t = textOf(b)
      if (!t || running.has(t.replace(DIGITS, '#'))) continue
      // A line or two of small type in the page's top or bottom margin: a folio, a running head, a footer.
      if (sizeOf(b) <= body * 1.05 && b.lines.length <= 2 && (b.box[3] < page.height * 0.04 || b.box[1] > page.height * 0.95)) continue
      // A bare number ("13", a page reference or a step number) says nothing on a slide.
      if (!/\p{L}/u.test(t) && t.length < 6) continue
      owner(b)?.texts.push({ para: b, sub: subs.has(b), page: pageIndex })
    }
    // The page's stories in reading order (top to bottom, side by side from the reading side); on a
    // page of stories side by side (a newspaper's), the biggest headlines first, as the page ranks them.
    if (sideBySide) local.sort((a, c) => c.story.titleSize - a.story.titleSize || a.story.top - c.story.top)
    else local.sort((a, c) => (Math.abs(a.story.top - c.story.top) > 12 ? a.story.top - c.story.top : page.rtl ? c.unit[2] - a.unit[2] : a.unit[0] - c.unit[0]))
    drafts.push(...local)
  }
  const rtlDoc = model.pages.filter((p) => p.rtl).length * 2 >= model.pages.length
  const out: Story[] = []
  for (const d of drafts) {
    d.story.paragraphs = storyText(d.texts, rtlDoc)
    d.story.pictures.sort((a, b) => widthOf(b.picture.box) * heightOf(b.picture.box) - widthOf(a.picture.box) * heightOf(a.picture.box))
    if (d.story.paragraphs.length || d.story.pictures.length || d.story.tables.length) out.push(d.story)
  }
  return out
}

/** A story's text in reading order (page by page), a sentence a column or page break cut joined again. */
function storyText(items: Array<{ para: Para; sub: boolean; page: number }>, rtl: boolean): StoryText[] {
  type Item = { para: Para; sub: boolean; page: number }
  // XY-cut: columns first (right to left in Arabic), else bands top to bottom (a subhead over the columns).
  const cut = (list: Item[]): Item[] => {
    if (list.length <= 1) return list
    const byX = [...list].sort((p, q) => p.para.box[0] - q.para.box[0])
    const cols: Item[][] = []
    let reach = -Infinity
    for (const t of byX) {
      if (!cols.length || t.para.box[0] > reach + 1) cols.push([t])
      else cols[cols.length - 1]!.push(t)
      reach = Math.max(reach, t.para.box[2])
    }
    if (cols.length > 1) return (rtl ? cols.reverse() : cols).flatMap(cut)
    const byY = [...list].sort((p, q) => p.para.box[1] - q.para.box[1])
    const bands: Item[][] = []
    let low = -Infinity
    for (const t of byY) {
      if (!bands.length || t.para.box[1] > low - 1) bands.push([t])
      else bands[bands.length - 1]!.push(t)
      low = Math.max(low, t.para.box[3])
    }
    return bands.length > 1 ? bands.flatMap(cut) : byY
  }
  const out: Array<StoryText & { bottom: number; full: boolean }> = []
  const pages = [...new Set(items.map((t) => t.page))].sort((a, b) => a - b)
  for (const t of pages.flatMap((p) => cut(items.filter((x) => x.page === p)))) {
    const runs = cleanRuns(t.para.runs)
    const text = runs.map((r) => r.text).join('')
    if (!text) continue
    const sub = t.sub || (t.para.runs.every((r) => r.bold || !r.text.trim()) && t.para.lines.length <= 2 && text.length < 140)
    const last = t.para.lines[t.para.lines.length - 1]
    // Its last line runs to the column's edge: the paragraph may go on in the next column.
    const full = t.para.lines.length >= 2 && !!last && widthOf(last.box) >= 0.85 * widthOf(t.para.box)
    const marker = t.para.list === 'number' ? t.para.marker : t.para.list === 'bullet' ? '•' : ''
    const prev = out[out.length - 1]
    const joins = prev && !marker && ((!prev.sub && !sub && prev.full && !CLOSED.test(prev.text)) || (prev.sub && sub && t.para.box[1] - prev.bottom < sizeOf(t.para)))
    if (prev && joins) {
      prev.runs = [...prev.runs, { ...runs[0]!, text: ' ' }, ...runs]
      prev.text = `${prev.text} ${text}`
      prev.bottom = t.para.box[3]
      prev.full = full
    } else out.push({ runs, text, rtl: t.para.rtl, sub, marker, bottom: t.para.box[3], full })
  }
  return out.map(({ runs, text, rtl: r, sub, marker }) => ({ runs, text, rtl: r, sub, marker }))
}

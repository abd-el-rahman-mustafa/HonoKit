import { degrees, PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { exifOrientation } from '@shared/exif'
import type { Op, Position } from '@shared/ops'
import { detectDirection, toArabicIndic, visualRuns } from './bidi'
import { PdfError } from './errors'
import { embedFace, type FontFace } from './fonts'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { NATIVE_PREFIX } from './nativefont'
import { tokens } from './contentfix'
import { rotationOf } from './pages'

/**
 * Drawing text and images onto existing pages: watermarks and page numbers.
 *
 * Two libraries, each doing what it is good at (docs/decisions.md §18, §22):
 *
 *  1. pdf-lib + fontkit draw the stamp onto a small *overlay* document of their
 *     own, one overlay page per target page, in the page's displayed frame. They
 *     shape Arabic correctly, which MuPDF cannot; `bidi.ts` supplies direction
 *     runs so digits and Latin words inside an Arabic line are not reversed.
 *  2. MuPDF places each overlay page onto the real page as a form XObject, turned
 *     to match the page's /Rotate so the stamp is upright to the reader.
 *
 * pdf-lib never parses the person's document. That matters: it refuses encrypted
 * files and is stricter than MuPDF about damaged ones, and the document keeps its
 * encryption because MuPDF, which opened it, writes it back.
 */

type WatermarkOp = Extract<Op, { op: 'watermark' }>
type PageNumbersOp = Extract<Op, { op: 'pageNumbers' }>
type HeaderFooterOp = Extract<Op, { op: 'headerFooter' }>

export class FontSet {
  private readonly fonts = new Map<FontFace, PDFFont>()
  constructor(private readonly pdf: PDFDocument) {}
  async get(face: FontFace): Promise<PDFFont> {
    let font = this.fonts.get(face)
    if (!font) {
      font = await embedFace(this.pdf, face)
      this.fonts.set(face, font)
    }
    return font
  }
}

const rad = (deg: number): number => (deg * Math.PI) / 180

/** A target page as the reader sees it. */
export interface Frame {
  index: number
  /** /Rotate as MuPDF and readers apply it: snapped to 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270
  /** Visible box in the page's own coordinates: the CropBox clipped to the MediaBox. */
  box: [number, number, number, number]
  /** Displayed size, rotation and /UserUnit applied: what MuPDF's page bounds say. */
  width: number
  height: number
  /** Overlay (displayed frame, origin bottom-left, y up) → the page's own coordinates. */
  matrix: [number, number, number, number, number, number]
}

/**
 * The page as displayed, taken from MuPDF itself (page bounds and page transform), so that
 * everything drawn over a page lands where the viewer shows it, also when the CropBox reaches
 * past the MediaBox, /UserUnit is not 1, or /Rotate is not a multiple of 90.
 */
export function pageFrame(doc: PdfDoc, index: number): Frame {
  const page = doc.loadPage(index)
  try {
    const b = page.getBounds()
    const ctm = page.getTransform()
    const back = mupdf.Matrix.invert(ctm)
    // Overlay y-up → displayed y-down → the page's own space.
    const matrix = mupdf.Matrix.concat([1, 0, 0, -1, b[0], b[3]], back) as Frame['matrix']
    const own = mupdf.Rect.transform(b, back)
    return {
      index,
      rotation: rotationOf(doc.findPage(index)),
      box: [own[0]!, own[1]!, own[2]!, own[3]!],
      width: b[2] - b[0],
      height: b[3] - b[1],
      matrix
    }
  } finally {
    free(page)
  }
}

/**
 * The matrix that takes the overlay page (displayed frame, origin bottom-left) into the target
 * page's own coordinates; covered for all four angles by test/stamp.test.ts and test/rotated.test.ts,
 * and for odd boxes by test/pagesfix.test.ts.
 */
export function placement(frame: Frame): [number, number, number, number, number, number] {
  return frame.matrix
}

interface Anchor {
  /** Overlay coordinates of the anchor (origin bottom-left, y up). */
  x: number
  y: number
  /** 0 = text starts at the anchor, 0.5 = centred on it, 1 = ends at it. */
  alignX: number
  /** true = the anchor is the vertical middle; false = the baseline (text) or an edge (pictures). */
  centreY: boolean
}

function anchorFor(position: Position, width: number, height: number, margin: number, size: number): Anchor {
  const col = position.endsWith('left') ? 0 : position.endsWith('right') ? 1 : 0.5
  const row = position.startsWith('top') ? 'top' : position.startsWith('bottom') ? 'bottom' : 'middle'
  const x = col === 0 ? margin : col === 1 ? width - margin : width / 2
  if (row === 'top') return { x, y: height - margin - size * 0.8, alignX: col, centreY: false }
  if (row === 'bottom') return { x, y: margin, alignX: col, centreY: false }
  return { x, y: height / 2, alignX: col, centreY: true }
}

interface LineStyle {
  size: number
  bold: boolean
  colour: string
  opacity: number
  /** Counter-clockwise rotation in degrees, as seen on the page. */
  rotation: number
}

function parseColour(hex: string): ReturnType<typeof rgb> {
  const n = parseInt(hex.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Drops characters the bundled fonts cannot draw, and counts them. */
function drawable(font: PDFFont, text: string): { text: string; dropped: number } {
  const set = new Set(font.getCharacterSet())
  let out = ''
  let dropped = 0
  for (const c of text) {
    if (set.has(c.codePointAt(0)!) || c === ' ') out += c
    else dropped++
  }
  return { text: out, dropped }
}

interface Measured {
  runs: Array<{ text: string; font: PDFFont; width: number }>
  width: number
  dropped: number
}

export async function measureLine(fonts: FontSet, text: string, size: number, bold: boolean): Promise<Measured> {
  const runs: Measured['runs'] = []
  let dropped = 0
  for (const run of visualRuns(text, detectDirection(text))) {
    const font = await fonts.get(run.arabic ? (bold ? 'arabic-bold' : 'arabic') : bold ? 'latin-bold' : 'latin')
    const { text: clean, dropped: d } = drawable(font, run.text)
    dropped += d
    if (clean.length > 0) runs.push({ text: clean, font, width: font.widthOfTextAtSize(clean, size) })
  }
  return { runs, width: runs.reduce((sum, r) => sum + r.width, 0), dropped }
}

/**
 * How long a line at `degrees` can be and still stay on the page: the chord through the
 * page's middle, inside the margins. A watermark longer than this is scaled down to fit.
 */
function room(width: number, height: number, margin: number, degrees: number): number {
  const c = Math.abs(Math.cos(rad(degrees)))
  const s = Math.abs(Math.sin(rad(degrees)))
  const w = Math.max(1, width - 2 * margin)
  const h = Math.max(1, height - 2 * margin)
  return Math.min(c > 1e-6 ? w / c : Infinity, s > 1e-6 ? h / s : Infinity)
}

export async function drawLine(fonts: FontSet, page: PDFPage, text: string, anchor: Anchor, style: LineStyle, lineOffset = 0): Promise<number> {
  const line = await measureLine(fonts, text, style.size, style.bold)
  const measured = line.runs
  const dropped = line.dropped
  if (measured.length === 0) return dropped
  const total = measured.reduce((sum, m) => sum + m.width, 0)
  const dir = { x: Math.cos(rad(style.rotation)), y: Math.sin(rad(style.rotation)) }
  const up = { x: -dir.y, y: dir.x }
  // Centred text sits a little below its geometric middle so capitals and Arabic look centred.
  const lift = (anchor.centreY ? -style.size * 0.35 : 0) - lineOffset
  let dx = -total * anchor.alignX
  for (const m of measured) {
    page.drawText(m.text, {
      x: anchor.x + dx * dir.x + lift * up.x,
      y: anchor.y + dx * dir.y + lift * up.y,
      size: style.size,
      font: m.font,
      color: parseColour(style.colour),
      opacity: style.opacity,
      rotate: degrees(style.rotation)
    })
    dx += m.width
  }
  return dropped
}

async function embedPicture(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
  try {
    if (isPng) return await pdf.embedPng(bytes)
    // A phone photo stored sideways (EXIF orientation) is turned upright first, as its preview shows it (§61).
    if (isJpg && exifOrientation(bytes) !== 1) {
      const { default: sharp } = await import('sharp')
      return await pdf.embedJpg(new Uint8Array(await sharp(bytes).rotate().jpeg({ quality: 95 }).toBuffer()))
    }
    if (isJpg) return await pdf.embedJpg(bytes)
    // Other formats MuPDF reads (BMP, GIF, TIFF, PNM) are converted to PNG through it.
    const image = new mupdf.Image(bytes)
    const pixmap = image.toPixmap()
    const png = pixmap.asPNG()
    free(pixmap, image)
    return await pdf.embedPng(png)
  } catch {
    throw new PdfError('unsupported', 'This picture could not be read. Use PNG or JPEG.')
  }
}

function targetPages(count: number, wanted: number[] | undefined): number[] {
  const list = wanted ?? Array.from({ length: count }, (_, i) => i)
  for (const p of list) if (!Number.isInteger(p) || p < 0 || p >= count) throw new PdfError('bad-arguments', `Page ${p + 1} does not exist (the document has ${count}).`)
  // In page order: page numbers count through the chosen pages from the first one (N1).
  return [...new Set(list)].sort((a, b) => a - b)
}

/** Concatenates a page's content streams, decoded. */
export function contentOf(page: mupdf.PDFObject): Uint8Array {
  const contents = page.get('Contents')
  const parts: Uint8Array[] = []
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) parts.push(contents.get(i).readStream().asUint8Array())
  else if (contents.isStream()) parts.push(contents.readStream().asUint8Array())
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
    out[at++] = 0x0a
  }
  return out
}

const encoder = new TextEncoder()

/** The tag in the dictionary of our q/Q wrapper streams: /HonoWrap /Open or /Close. */
const WRAP = 'HonoWrap'

/**
 * How many q (or Q) the wrapper will write. PDF 32000 Annex C puts the graphics-state stack at 28,
 * so a page that needs more than this is already past what any reader honours, and the balance
 * cannot be restored for it anyway; every real file stays exact.
 */
const MAX_WRAP = 1024

function wrapTag(stream: mupdf.PDFObject): string | null {
  const tag = stream.get(WRAP)
  return tag.isName() ? tag.asName() : null
}

/**
 * How a content stream moves the graphics-state stack: the lowest depth it reaches (0 or less:
 * a stray Q) and where it ends, relative to where it starts. Strings, inline images and
 * comments are skipped (contentfix `tokens`).
 */
export function qDepth(content: string): { low: number; end: number } {
  let depth = 0
  let low = 0
  for (const t of tokens(content)) {
    if (t.kind !== 'op') continue
    if (t.value === 'q') depth++
    else if (t.value === 'Q') low = Math.min(low, --depth)
  }
  return { low, end: depth }
}

/**
 * Wraps the page's content in q/Q once, so what is drawn after it starts from the default
 * graphics state. The wrapper streams are tagged; while the page's content is still inside
 * them (only our overlays after them), the next overlay is simply appended, so nesting does not
 * grow with each stamp. The wrapper also balances the page's own
 * q/Q: extra q in front for stray Qs, extra Q after for unclosed qs, so a scale or clip the
 * page leaves open never reaches the overlay.
 */
function wrapContents(doc: PdfDoc, page: mupdf.PDFObject): mupdf.PDFObject[] {
  const old = page.get('Contents')
  const list: mupdf.PDFObject[] = []
  if (old.isArray()) for (let i = 0; i < old.length; i++) list.push(old.get(i))
  else if (!old.isNull()) list.push(old)
  const tags = list.map(wrapTag)
  const open = tags.indexOf('Open')
  const close = tags.lastIndexOf('Close')
  // Page content outside the wrapper (added in front of it or after it by another tool) means wrapping again.
  const outside = tags.some((tag, i) => tag === null && !list[i]!.get('HonoOverlay').isBoolean() && (i < open || i > close))
  if (open >= 0 && close > open && !outside) return list
  if (list.length === 0) return list
  const holder = doc.newDictionary()
  const all = doc.newArray()
  for (const s of list) all.push(s)
  holder.put('Contents', all)
  const { low, end } = qDepth(new TextDecoder('latin1').decode(contentOf(holder)))
  const opening = doc.newDictionary()
  opening.put(WRAP, doc.newName('Open'))
  const closing = doc.newDictionary()
  closing.put(WRAP, doc.newName('Close'))
  // Both counts come from the page's own operators, so a damaged or hostile stream of nothing but
  // q or Q would otherwise make a wrapper as large as itself (and store it in the saved file).
  const lead = Math.min(1 - low, MAX_WRAP)
  const trail = Math.max(1, Math.min(lead + end, MAX_WRAP))
  const before = doc.addStream(encoder.encode('q\n'.repeat(lead)), opening)
  const after = doc.addStream(encoder.encode('\n' + 'Q\n'.repeat(trail)), closing)
  return [before, ...list, after]
}

/**
 * Puts overlay page k on target page frames[k] as a form XObject.
 *
 * The page's own content is wrapped in q/Q first (once, see `wrapContents`): a content stream
 * may leave the graphics state changed (a scale, a clip), and the stamp must not inherit it.
 * Resources are copied onto the page before being extended, because they are often
 * shared by every page, or inherited from the page tree.
 */
export function placeOverlay(doc: PdfDoc, overlayBytes: Uint8Array, frames: Frame[]): void {
  const overlay = openPdf(overlayBytes)
  try {
    const graft = doc.newGraftMap()
    frames.forEach((frame, k) => {
      const source = overlay.findPage(k)
      const form = doc.newDictionary()
      form.put('Type', doc.newName('XObject'))
      form.put('Subtype', doc.newName('Form'))
      const bbox = doc.newArray()
      for (const v of [0, 0, frame.width, frame.height]) bbox.push(v)
      form.put('BBox', bbox)
      form.put('Resources', graft.graftObject(source.get('Resources')))
      restoreNativeFonts(doc, form.get('Resources'))
      const xobject = doc.addStream(contentOf(source), form)

      const page = doc.findPage(frame.index)
      const resources = doc.newDictionary()
      const inherited = page.getInheritable('Resources')
      if (inherited.isDictionary()) inherited.forEach((value, key) => resources.put(key, value))
      const xobjects = doc.newDictionary()
      const existing = resources.get('XObject')
      if (existing.isDictionary()) existing.forEach((value, key) => xobjects.put(key, value))
      let name = 'HonoStamp'
      for (let n = 1; !xobjects.get(name).isNull(); n++) name = `HonoStamp${n}`
      xobjects.put(name, xobject)
      resources.put('XObject', xobjects)
      page.put('Resources', resources)

      const m = placement(frame)
        .map((v) => +v.toFixed(4))
        .join(' ')
      const tagged = doc.newDictionary()
      tagged.put('HonoOverlay', true)
      const drawn = doc.addStream(encoder.encode(`\nq ${m} cm /${name} Do Q\n`), tagged)
      const contents = doc.newArray()
      for (const s of wrapContents(doc, page)) contents.push(s)
      contents.push(drawn)
      page.put('Contents', contents)
    })
    free(graft)
  } finally {
    free(overlay)
  }
}

/** Builds the overlay with `draw`, then applies it and saves. */
async function stamp(
  bytes: Uint8Array,
  pages: number[] | undefined,
  password: string | undefined,
  draw: (overlay: PDFDocument, page: PDFPage, frame: Frame, at: number, count: number) => Promise<void>
): Promise<Uint8Array> {
  const doc = openPdf(bytes, password)
  try {
    const frames = targetPages(doc.countPages(), pages).map((i) => pageFrame(doc, i))
    const overlay = await PDFDocument.create()
    for (const [k, frame] of frames.entries()) await draw(overlay, overlay.addPage([frame.width, frame.height]), frame, k, frames.length)
    placeOverlay(doc, new Uint8Array(await overlay.save()), frames)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

export async function addWatermark(bytes: Uint8Array, op: WatermarkOp, imageBytes?: Uint8Array, password?: string): Promise<{ bytes: Uint8Array; dropped: number }> {
  if (!op.text?.trim() && !imageBytes) throw new PdfError('bad-arguments', 'A watermark needs some text or an image.')
  let dropped = 0
  let fonts: FontSet | null = null
  let picture: PDFImage | null = null
  const out = await stamp(bytes, op.pages, password, async (overlay, page, frame) => {
    if (imageBytes) {
      picture ??= await embedPicture(overlay, imageBytes)
      const w = frame.width * op.imageScale
      const h = (picture.height / picture.width) * w
      const anchor = anchorFor(op.position, frame.width, frame.height, 36, 0)
      const dir = { x: Math.cos(rad(op.rotation)), y: Math.sin(rad(op.rotation)) }
      const up = { x: -dir.y, y: dir.x }
      // Vertical anchor: the middle for the middle row, the top edge for the top row, the bottom edge otherwise.
      const fy = anchor.centreY ? 0.5 : op.position.startsWith('top') ? 1 : 0
      page.drawImage(picture, {
        x: anchor.x - anchor.alignX * w * dir.x - fy * h * up.x,
        y: anchor.y - anchor.alignX * w * dir.y - fy * h * up.y,
        width: w,
        height: h,
        rotate: degrees(op.rotation),
        opacity: op.opacity
      })
    } else {
      fonts ??= new FontSet(overlay)
      const lines = op.text!.split(/\r?\n/).filter((l) => l.length > 0)
      // Too long for the page at this size and angle: shrink every line by the same factor.
      let size = op.size
      const widest = Math.max(0, ...(await Promise.all(lines.map((l) => measureLine(fonts!, l, size, op.bold)))).map((m) => m.width))
      const available = room(frame.width, frame.height, 24, op.rotation)
      if (widest > available) size = Math.max(4, size * (available / widest))
      const anchor = anchorFor(op.position, frame.width, frame.height, 36, size)
      const style: LineStyle = { size, bold: op.bold, colour: op.colour, opacity: op.opacity, rotation: op.rotation }
      // Centre a block of several lines on the anchor.
      const first = anchor.centreY ? ((lines.length - 1) * size * 1.2) / 2 : 0
      for (const [i, line] of lines.entries()) dropped += await drawLine(fonts, page, line, anchor, style, i * size * 1.2 - first)
    }
  })
  return { bytes: out, dropped }
}

/**
 * Page numbers. On a page range they count within the chosen pages, as Acrobat does (owner's
 * decision N1, 2026-10-08): "Start at 1" on pages 3–10 puts 1 on page 3; {N} is the last number shown.
 */
export async function addPageNumbers(bytes: Uint8Array, op: PageNumbersOp, password?: string): Promise<Uint8Array> {
  const digits = (n: number): string => (op.digits === 'arabic-indic' ? toArabicIndic(String(n)) : String(n))
  let fonts: FontSet | null = null
  return stamp(bytes, op.pages, password, async (overlay, page, frame, at, count) => {
    fonts ??= new FontSet(overlay)
    const label = op.template.replaceAll('{n}', digits(op.startAt + at)).replaceAll('{N}', digits(op.startAt + count - 1))
    const anchor = anchorFor(op.position, frame.width, frame.height, op.margin, op.size)
    await drawLine(fonts, page, label, anchor, { size: op.size, bold: false, colour: op.colour, opacity: 1, rotation: 0 })
  })
}

/**
 * Headers and footers: up to six lines per page, at the corners and middles of the top and bottom
 * margins. {n} and {N} count within the chosen pages, as for page numbers (N1).
 */
export async function addHeaderFooter(bytes: Uint8Array, op: HeaderFooterOp, password?: string): Promise<{ bytes: Uint8Array; dropped: number }> {
  const slots = Object.entries(op.slots).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0)
  if (slots.length === 0) throw new PdfError('bad-arguments', 'Type a header or a footer first.')
  const digits = (n: number): string => (op.digits === 'arabic-indic' ? toArabicIndic(String(n)) : String(n))
  let fonts: FontSet | null = null
  let dropped = 0
  const out = await stamp(bytes, op.pages, password, async (overlay, page, frame, at, count) => {
    fonts ??= new FontSet(overlay)
    for (const [slot, text] of slots) {
      const line = text
        .replaceAll('{n}', digits(op.startAt + at))
        .replaceAll('{N}', digits(op.startAt + count - 1))
        .replaceAll('{date}', op.date)
        .replaceAll('{file}', op.file)
      const col = slot.endsWith('Left') ? 0 : slot.endsWith('Right') ? 1 : 0.5
      const x = col === 0 ? op.marginX : col === 1 ? frame.width - op.marginX : frame.width / 2
      const y = slot.startsWith('top') ? frame.height - op.marginY - op.size * 0.8 : op.marginY
      dropped += await drawLine(fonts, page, line, { x, y, alignX: col, centreY: false }, { size: op.size, bold: op.bold, colour: op.colour, opacity: 1, rotation: 0 })
    }
  })
  return { bytes: out, dropped }
}

/**
 * An overlay that wrote words in the page's own font (decisions §59) used a placeholder named
 * HonoNative-<object number>: point it back at that font object of the page.
 */
function restoreNativeFonts(doc: PdfDoc, resources: mupdf.PDFObject): void {
  const fonts = resources.isDictionary() ? resources.get('Font') : null
  const dict = fonts && fonts.isIndirect() ? fonts.resolve() : fonts
  if (!dict || !dict.isDictionary()) return
  const swaps: Array<[string, number]> = []
  dict.forEach((value, key) => {
    const font = value.isIndirect() ? value.resolve() : value
    const base = font.isDictionary() ? font.get('BaseFont') : null
    const name = base && base.isName() ? base.asName() : ''
    if (name.startsWith(NATIVE_PREFIX)) swaps.push([String(key), Number(name.slice(NATIVE_PREFIX.length))])
  })
  for (const [key, num] of swaps) if (num > 0) dict.put(key, doc.newIndirect(num))
}

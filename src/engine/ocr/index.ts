import { PDFDocument, popGraphicsState, pushGraphicsState, rgb, setCharacterSqueeze, setTextRenderingMode, TextRenderingMode, type PDFPage } from 'pdf-lib'
import { detectDirection } from '../bidi'
import { PdfError } from '../errors'
import { free, mupdf, openPdf, saveBytes } from '../mupdf'
import { FontSet, measureLine, pageFrame, placeOverlay, type Frame } from '../stamp'
import { extractLines } from '../text'
import { cropImage, openOcr, type OcrEngine, type Reading, type RgbaImage } from './engine'

/**
 * Recognise text (docs/decisions.md §52), as Acrobat's "Recognize text": pages that are
 * pictures (scans, photographs of pages) get an invisible text layer placed exactly over the
 * words, so the page looks the same but can be searched, selected, copied, compared,
 * redacted and converted. Pages that already have text are left alone unless asked.
 */

export interface OcrOptions {
  pages?: number[]
  /** 'auto': Arabic, English and digits (each line by the recogniser that reads it best). */
  language: 'auto' | 'ar' | 'en'
  /** Also pages that already have text (their old layer stays; used rarely). */
  redo: boolean
  /** Stop: checked after each line; the document is left as it was. */
  signal?: AbortSignal
}

/** A page counts as having text when it has more than this many letters or digits. */
const HAS_TEXT = 30
/** Pages are read at this resolution: scans are usually 200–300 dpi, and S5 measured 150 dpi on print. */
const DPI = 200

async function readLine(engine: OcrEngine, line: RgbaImage, language: OcrOptions['language']): Promise<Reading> {
  if (language === 'en') return engine.read(line, 'latin')
  const arabic = await engine.read(line, 'arabic')
  if (language === 'ar' || /[؀-ۿ]/.test(arabic.text)) return arabic
  // A confident Latin reading from the Arabic model (it reads Latin and digits too) is kept: it has
  // the spaces right, and a second model would double the time for every English line.
  if (arabic.confidence >= 0.93) return { ...arabic, text: arabic.text.replace(/(\d) (?=\d)/g, '$1').replace(/(^|\s)([B-HJ-Z]) (?=[a-z])/g, '$1$2') }
  // No Arabic letters: the Latin recogniser may read the line better (it knows more of the Latin shapes).
  const latin = await engine.read(line, 'latin')
  // It also knows Chinese; on a stain it may "read" some. Those are dropped.
  const clean = { ...latin, text: latin.text.replace(/[⺀-鿿豈-﫿＀-￯]/g, '').trim() }
  // The Latin recogniser runs words together; the Arabic one keeps the spaces but may split a
  // number ("1 250"). When both read the same letters, the Arabic one's word breaks are used.
  const compact = (s: string): string => s.replace(/\s+/g, '')
  if (compact(clean.text) === compact(arabic.text)) {
    // …minus the spaces it invents: inside a number, and after a capital that starts a word ("T otal").
    const text = arabic.text.replace(/(\d) (?=\d)/g, '$1').replace(/(^|\s)([B-HJ-Z]) (?=[a-z])/g, '$1$2')
    return { text, confidence: Math.max(clean.confidence, arabic.confidence) }
  }
  return clean.confidence >= arabic.confidence && clean.text ? clean : arabic
}

/**
 * Our text layer is tagged so a second run replaces it instead of stacking a copy (Find and copy
 * would see every word twice): the form XObject holding the invisible text and the small content
 * stream that draws it both carry /HonoOcr true. Text the page had of its own is never touched.
 */
const OCR_TAG = 'HonoOcr'

/**
 * The layer written before the tag existed: an overlay (/HonoOverlay) whose form begins with
 * "q 3 Tr" — invisible text, which none of the other overlay tools (watermark, header and footer,
 * Bates, stamps) draw.
 */
function isLegacyOcrForm(form: mupdf.PDFObject): boolean {
  try {
    if (!form.isStream()) return false
    const head = new TextDecoder('latin1').decode(form.readStream().asUint8Array().slice(0, 64))
    return /^\s*q\s+3\s+Tr\b/.test(head)
  } catch {
    return false
  }
}

/** The name drawn by an overlay stream ("q … cm /HonoStamp Do Q"). */
function drawnName(stream: mupdf.PDFObject): string | null {
  try {
    const content = new TextDecoder('latin1').decode(stream.readStream().asUint8Array())
    return /\/([^\s/<>[\]()]+)\s+Do\b/.exec(content)?.[1] ?? null
  } catch {
    return null
  }
}

/** Removes the OCR layers this app put on the page. True when one was removed. */
function removeOcrLayers(doc: ReturnType<typeof openPdf>, pageIndex: number): boolean {
  const page = doc.findPage(pageIndex)
  const contents = page.get('Contents')
  if (!contents.isArray()) return false
  const xobjects = page.get('Resources').get('XObject')
  const kept = doc.newArray()
  const dropped: string[] = []
  for (let i = 0; i < contents.length; i++) {
    const stream = contents.get(i)
    if (stream.get('HonoOverlay').isBoolean()) {
      const name = drawnName(stream)
      const form = name && xobjects.isDictionary() ? xobjects.get(name) : null
      const ours = stream.get(OCR_TAG).isBoolean() || (form !== null && (form.get(OCR_TAG).isBoolean() || isLegacyOcrForm(form)))
      if (ours) {
        if (name) dropped.push(name)
        continue
      }
    }
    kept.push(stream)
  }
  if (dropped.length === 0) return false
  page.put('Contents', kept)
  // The form goes too (unless the resources are shared with other pages, which our overlays never are).
  if (xobjects.isDictionary() && !xobjects.isIndirect() && !page.get('Resources').isIndirect()) for (const name of dropped) xobjects.delete(name)
  return true
}

/** Marks the overlay just placed on each frame's page as our OCR layer. */
function tagOcrLayers(doc: ReturnType<typeof openPdf>, frames: Frame[]): void {
  for (const frame of frames) {
    const page = doc.findPage(frame.index)
    const contents = page.get('Contents')
    if (!contents.isArray() || contents.length === 0) continue
    const drawn = contents.get(contents.length - 1)
    if (!drawn.get('HonoOverlay').isBoolean()) continue
    drawn.put(OCR_TAG, true)
    const name = drawnName(drawn)
    const form = name ? page.get('Resources').get('XObject').get(name) : null
    if (form?.isStream()) form.put(OCR_TAG, true)
  }
}

function letters(doc: ReturnType<typeof openPdf>, page: number): number {
  return extractLines(doc, page).reduce((n, l) => n + (l.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0)
}

export async function recogniseText(bytes: Uint8Array, options: OcrOptions, password?: string, progress?: (fraction: number, message?: string) => void): Promise<{ bytes: Uint8Array; pages: number; lines: number; skipped: number }> {
  const doc = openPdf(bytes, password)
  let engine: OcrEngine | null = null
  try {
    const count = doc.countPages()
    const targets = options.pages ?? Array.from({ length: count }, (_, i) => i)
    const todo = targets.filter((p) => options.redo || letters(doc, p) <= HAS_TEXT)
    if (todo.length === 0) return { bytes, pages: 0, lines: 0, skipped: targets.length }
    // Recognising a page again replaces the layer we wrote last time (tagged, or detected on files
    // from earlier versions); the page's own text, if any, stays as it is.
    for (const pageIndex of todo) removeOcrLayers(doc, pageIndex)
    engine = await openOcr()
    const overlay = await PDFDocument.create()
    const fonts = new FontSet(overlay)
    const frames: Frame[] = []
    let lines = 0
    for (const [i, pageIndex] of todo.entries()) {
      if (options.signal?.aborted) throw new PdfError('cancelled', 'Cancelled.')
      progress?.(i / todo.length, `${i + 1}/${todo.length}`)
      const frame = pageFrame(doc, pageIndex)
      const scale = DPI / 72
      const page = doc.loadPage(pageIndex)
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
      const w = pixmap.getWidth()
      const h = pixmap.getHeight()
      const rgb = pixmap.getPixels()
      const rgba = new Uint8Array(w * h * 4)
      for (let k = 0, j = 0; k < w * h; k++, j += 3) {
        rgba[k * 4] = rgb[j]!
        rgba[k * 4 + 1] = rgb[j + 1]!
        rgba[k * 4 + 2] = rgb[j + 2]!
        rgba[k * 4 + 3] = 255
      }
      free(pixmap, page)
      const image: RgbaImage = { data: rgba, width: w, height: h }
      const sheet = overlay.addPage([frame.width, frame.height])
      // Invisible text (render mode 3): there to be found and selected, not seen.
      sheet.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
      const boxes = await engine.detectLines(image, () => !!options.signal?.aborted)
      if (options.signal?.aborted) throw new PdfError('cancelled', 'Cancelled.')
      for (const [n, box] of boxes.entries()) {
        // Line by line: a newspaper page has hundreds, so the bar moves on one page too.
        if (n % 8 === 0) progress?.((i + n / boxes.length) / todo.length, `${i + 1}/${todo.length}`)
        if (box.h < 8 || box.w < 12) continue
        if (options.signal?.aborted) throw new PdfError('cancelled', 'Cancelled.')
        const lineImage = cropImage(image, box.x, box.y, box.w, box.h)
        const reading = await readLine(engine, lineImage, options.language)
        const text = reading.text.replace(/\s+/g, ' ').trim()
        if (!text || reading.confidence < 0.5) continue
        // Pixels → points on the page as displayed.
        const top = box.y / scale
        const bh = box.h / scale
        const size = bh * 0.72
        const baseline = frame.height - (top + bh * 0.78)
        // Each word over its own place in the picture, stretched to it, so Find and selection mark
        // the word itself (a line set in our font drifts off the scan's words, worst on stretched
        // Arabic). When the gaps in the picture do not match the words, the line as a whole.
        const words = text.split(' ')
        const spans = wordSpans(lineImage, words.length)
        const toPoints = (s: Span): Span => ({ left: (box.x + s.left) / scale, right: (box.x + s.right) / scale })
        if (spans) {
          // Spans run left to right; the words are written in reading order (so copied text
          // reads right), each at the span it shows in.
          const order = visualOrder(words, detectDirection(text))
          const at = (i: number): Span => toPoints(spans[order.indexOf(i)]!)
          for (const [i, word] of words.entries()) {
            const span = at(i)
            await drawFitted(fonts, sheet, word, span, baseline, size)
            // The space, in the gap between this word and the next one read, so the text keeps its word breaks.
            if (i + 1 < words.length) {
              const next = at(i + 1)
              const gap = next.left >= span.right ? { left: span.right, right: next.left } : { left: next.right, right: span.left }
              await drawFitted(fonts, sheet, ' ', gap, baseline, size)
            }
          }
        } else {
          const ink = wordSpans(lineImage, 1)?.[0] ?? { left: 0, right: box.w }
          await drawFitted(fonts, sheet, text, toPoints(ink), baseline, size)
        }
        lines++
        if (options.signal?.aborted) throw new PdfError('cancelled', 'Cancelled.')
      }
      sheet.pushOperators(popGraphicsState())
      frames.push(frame)
    }
    placeOverlay(doc, new Uint8Array(await overlay.save()), frames)
    tagOcrLayers(doc, frames)
    progress?.(1)
    return { bytes: saveBytes(doc), pages: todo.length, lines, skipped: targets.length - todo.length }
  } finally {
    await engine?.release()
    free(doc)
  }
}

/** A stretch of a line, in pixels of the line picture (or points, once converted). */
interface Span {
  left: number
  right: number
}

/**
 * Where the `count` words of a line are in its picture: the ink is found column by column, and
 * the widest `count − 1` gaps are the word breaks (gaps inside an Arabic word, between letters
 * that do not join, are narrower than a space). Null when the line has fewer clear gaps than
 * that, or they are too narrow to be spaces: the caller then places the line as a whole.
 */
function wordSpans(line: RgbaImage, count: number): Span[] | null {
  const { data, width, height } = line
  if (width < 2 || height < 2) return null
  // Dark against light: Otsu's threshold over the line's grey levels.
  const grey = new Uint8Array(width * height)
  const histogram = new Array<number>(256).fill(0)
  for (let i = 0; i < width * height; i++) {
    const g = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000
    grey[i] = g
    histogram[grey[i]!]!++
  }
  const total = width * height
  let sum = 0
  for (let g = 0; g < 256; g++) sum += g * histogram[g]!
  let below = 0
  let belowSum = 0
  let best = 0
  let threshold = 128
  for (let g = 0; g < 256; g++) {
    below += histogram[g]!
    if (below === 0) continue
    const above = total - below
    if (above === 0) break
    belowSum += g * histogram[g]!
    const between = below * above * (belowSum / below - (sum - belowSum) / above) ** 2
    if (between > best) {
      best = between
      threshold = g
    }
  }
  // A column has ink when a few of its pixels are dark (a speck of dust is not a letter).
  const least = Math.max(1, Math.round(height * 0.04))
  const inked: boolean[] = []
  for (let x = 0; x < width; x++) {
    let dark = 0
    for (let y = 0; y < height; y++) if (grey[y * width + x]! <= threshold) dark++
    inked.push(dark >= least)
  }
  const first = inked.indexOf(true)
  const last = inked.lastIndexOf(true)
  if (first < 0) return null
  if (count === 1) return [{ left: first, right: last + 1 }]
  const gaps: Span[] = []
  for (let x = first; x <= last; x++) {
    if (inked[x]) continue
    const start = x
    while (x <= last && !inked[x]) x++
    gaps.push({ left: start, right: x })
  }
  if (gaps.length < count - 1) return null
  const breaks = [...gaps].sort((a, b) => b.right - b.left - (a.right - a.left)).slice(0, count - 1)
  // A space is at least about a sixth of the line's height; narrower, and the words are not where we think.
  if (breaks.some((g) => g.right - g.left < height * 0.15)) return null
  breaks.sort((a, b) => a.left - b.left)
  const spans: Span[] = []
  let left = first
  for (const gap of breaks) {
    spans.push({ left, right: gap.left })
    left = gap.right
  }
  spans.push({ left, right: last + 1 })
  return spans
}

/**
 * The words' order from left to right as the line shows them: an Arabic line runs right to left,
 * but a run of Latin words or numbers inside it keeps its own left-to-right order (and the other
 * way round in a Latin line). Indexes into `words`.
 */
function visualOrder(words: string[], base: 'ltr' | 'rtl'): number[] {
  const rtl = (w: string): boolean => (/[\p{L}\p{N}]/u.test(w) ? detectDirection(w) === 'rtl' : base === 'rtl')
  const groups: number[][] = []
  for (const [i, w] of words.entries()) {
    const last = groups[groups.length - 1]
    if (last && rtl(words[last[0]!]!) === rtl(w)) last.push(i)
    else groups.push([i])
  }
  const shown = groups.map((g) => (rtl(words[g[0]!]!) ? [...g].reverse() : g))
  return (base === 'rtl' ? shown.reverse() : shown).flat()
}

/**
 * Invisible text set over `span` (points), squeezed or stretched to fill it exactly (the
 * horizontal scaling, Tz), on `baseline`.
 */
async function drawFitted(fonts: FontSet, sheet: PDFPage, text: string, span: Span, baseline: number, size: number): Promise<void> {
  const line = await measureLine(fonts, text, size, false)
  const width = span.right - span.left
  if (line.runs.length === 0 || line.width <= 0 || width <= 0) return
  const stretch = width / line.width
  sheet.pushOperators(pushGraphicsState(), setCharacterSqueeze(stretch * 100))
  let dx = 0
  for (const run of line.runs) {
    sheet.drawText(run.text, { x: span.left + dx * stretch, y: baseline, size, font: run.font, color: rgb(0, 0, 0) })
    dx += run.width
  }
  sheet.pushOperators(popGraphicsState())
}

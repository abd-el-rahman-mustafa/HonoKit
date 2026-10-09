import { PDFDocument, popGraphicsState, pushGraphicsState, setTextRenderingMode, TextRenderingMode } from 'pdf-lib'
import { detectDirection } from '../bidi'
import { free, mupdf, openPdf, saveBytes } from '../mupdf'
import { drawLine, FontSet, measureLine, pageFrame, placeOverlay, type Frame } from '../stamp'
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
      for (const box of await engine.detectLines(image)) {
        if (box.h < 8 || box.w < 12) continue
        const reading = await readLine(engine, cropImage(image, box.x, box.y, box.w, box.h), options.language)
        const text = reading.text.replace(/\s+/g, ' ').trim()
        if (!text || reading.confidence < 0.5) continue
        // Pixels → points on the page as displayed.
        const x0 = box.x / scale
        const top = box.y / scale
        const bw = box.w / scale
        const bh = box.h / scale
        let size = bh * 0.72
        const natural = (await measureLine(fonts, text, size, false)).width
        if (natural > bw) size *= bw / natural
        const rtl = detectDirection(text) === 'rtl'
        await drawLine(fonts, sheet, text, { x: rtl ? x0 + bw : x0, y: frame.height - (top + bh * 0.78), alignX: rtl ? 1 : 0, centreY: false }, { size, bold: false, colour: '#000000', opacity: 1, rotation: 0 })
        lines++
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

import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import { BRAND, MARKUP_KEY, OLD_MARKUP_KEYS } from '@shared/brand'
import { detectDirection } from './bidi'
import { PdfError } from './errors'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { contentOf, FontSet, measureLine, drawLine } from './stamp'
import { isIdentity, uprightMatrix } from './upright'

/**
 * Markup whose look we draw ourselves: stamps, text boxes and callouts (docs/decisions.md §44).
 *
 * They are standard PDF annotations (Stamp, FreeText) so every reader lists, shows and moves
 * them — but their appearance is drawn by pdf-lib with the bundled fonts, because MuPDF's
 * own FreeText appearance cannot shape Arabic (tested: it draws nothing). The drawing is
 * grafted in as the annotation's /AP. What is needed to draw it again (after its text
 * changes) is kept in a private /HonoPDF entry (/PowerPDF in files marked up before the
 * rename, decisions §49, still read). Such annotations are moved by shifting
 * /Rect directly: MuPDF's setRect would replace the drawing with its own.
 */

type Point = [number, number]
type Box = [number, number, number, number]
type Rgb = [number, number, number]

export type DrawnMarkup =
  /** A rubber stamp centred on `at`: a big word, and an optional small line (who and when). */
  | { kind: 'stamp'; at: Point; label: string; sub?: string; colour: Rgb; scale?: number }
  /** A text box: text wrapped inside `rect`, with a thin border. */
  | { kind: 'textbox'; rect: Box; text: string; colour: Rgb; size: number }
  /** A callout: a text box and a line from it to the point it talks about, ending in an arrow. */
  | { kind: 'callout'; rect: Box; to: Point; text: string; colour: Rgb; size: number }

const hexOf = (c: Rgb): string => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`

/** Word-wraps `text` to `width` points; explicit line breaks are kept. */
async function wrap(fonts: FontSet, text: string, size: number, width: number): Promise<string[]> {
  const out: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = words[0]!
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`
      if ((await measureLine(fonts, next, size, false)).width <= width) line = next
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

interface Drawing {
  /** The appearance, one page of `width` × `height` points. */
  bytes: Uint8Array
  width: number
  height: number
  /** Where the drawing's origin (bottom-left) sits on the page, in page coordinates (top-left, y down): its top-left corner. */
  left: number
  top: number
  /** A callout's line in page coordinates: tip, knee, start at the box (as /CL wants it). */
  line?: [Point, Point, Point]
}

const PAD = 6

async function draw(m: DrawnMarkup): Promise<Drawing> {
  const pdf = await PDFDocument.create()
  const fonts = new FontSet(pdf)
  const colour = rgb(...m.colour)
  if (m.kind === 'stamp') {
    const scale = m.scale ?? 1
    const big = 20 * scale
    const small = 8.5 * scale
    const main = await measureLine(fonts, m.label, big, true)
    const second = m.sub ? await measureLine(fonts, m.sub, small, false) : null
    const width = Math.max(main.width, second?.width ?? 0) + 28 * scale
    const height = big + (second ? small + 8 * scale : 0) + 18 * scale
    const page = pdf.addPage([width, height])
    // Acrobat's stamps: a rounded double border, the word in capitals, the details under it.
    const border = (inset: number, thickness: number): void => {
      page.drawRectangle({ x: inset, y: inset, width: width - 2 * inset, height: height - 2 * inset, borderColor: colour, borderWidth: thickness, opacity: 0, borderOpacity: 1 })
    }
    border(1.5 * scale, 2.2 * scale)
    border(4.5 * scale, 0.8 * scale)
    const baseline = second ? height - 9 * scale - big * 0.85 : height / 2 - big * 0.35
    await drawLine(fonts, page, m.label, { x: width / 2, y: baseline, alignX: 0.5, centreY: false }, { size: big, bold: true, colour: hexOf(m.colour), opacity: 1, rotation: 0 })
    if (m.sub) await drawLine(fonts, page, m.sub, { x: width / 2, y: 8 * scale, alignX: 0.5, centreY: false }, { size: small, bold: false, colour: hexOf(m.colour), opacity: 1, rotation: 0 })
    return { bytes: await pdf.save(), width, height, left: m.at[0] - width / 2, top: m.at[1] - height / 2 }
  }
  const [x0, y0, x1, y1] = m.rect
  const boxW = Math.max(40, x1 - x0)
  const lines = await wrap(fonts, m.text, m.size, boxW - 2 * PAD)
  const boxH = Math.max(y1 - y0, lines.length * m.size * 1.3 + 2 * PAD)
  // The drawing covers the box, and for a callout the arrow's tip too.
  const left = m.kind === 'callout' ? Math.min(x0, m.to[0]) - 4 : x0
  const top = m.kind === 'callout' ? Math.min(y0, m.to[1]) - 4 : y0
  const right = m.kind === 'callout' ? Math.max(x0 + boxW, m.to[0]) + 4 : x0 + boxW
  const bottom = m.kind === 'callout' ? Math.max(y0 + boxH, m.to[1]) + 4 : y0 + boxH
  const width = right - left
  const height = bottom - top
  const page: PDFPage = pdf.addPage([width, height])
  // Page coordinates (y down) to the drawing's (y up).
  const X = (x: number): number => x - left
  const Y = (y: number): number => height - (y - top)
  page.drawRectangle({ x: X(x0), y: Y(y0 + boxH), width: boxW, height: boxH, color: rgb(1, 1, 1), borderColor: colour, borderWidth: 1 })
  let line: [Point, Point, Point] | undefined
  if (m.kind === 'callout') {
    // From the nearest side of the box to the tip, with a small knee as Acrobat draws it.
    const cx = Math.min(Math.max(m.to[0], x0), x0 + boxW)
    const cy = Math.min(Math.max(m.to[1], y0), y0 + boxH)
    const start: Point = m.to[0] < x0 ? [x0, y0 + boxH / 2] : m.to[0] > x0 + boxW ? [x0 + boxW, y0 + boxH / 2] : [cx, cy]
    const knee: Point = [start[0] + (m.to[0] < x0 ? -12 : m.to[0] > x0 + boxW ? 12 : 0), start[1]]
    line = [m.to, knee, start]
    page.drawLine({ start: { x: X(start[0]), y: Y(start[1]) }, end: { x: X(knee[0]), y: Y(knee[1]) }, thickness: 1, color: colour })
    page.drawLine({ start: { x: X(knee[0]), y: Y(knee[1]) }, end: { x: X(m.to[0]), y: Y(m.to[1]) }, thickness: 1, color: colour })
    const angle = Math.atan2(Y(m.to[1]) - Y(knee[1]), X(m.to[0]) - X(knee[0]))
    for (const side of [-1, 1]) {
      const a = angle + Math.PI - side * 0.45
      page.drawLine({ start: { x: X(m.to[0]), y: Y(m.to[1]) }, end: { x: X(m.to[0]) + 8 * Math.cos(a), y: Y(m.to[1]) + 8 * Math.sin(a) }, thickness: 1, color: colour })
    }
  }
  const rtl = detectDirection(m.text) === 'rtl'
  for (const [i, line] of lines.entries()) {
    const baseline = Y(y0 + PAD + m.size * (i * 1.3 + 0.95))
    await drawLine(fonts, page, line, { x: rtl ? X(x0 + boxW - PAD) : X(x0 + PAD), y: baseline, alignX: rtl ? 1 : 0, centreY: false }, { size: m.size, bold: false, colour: '#000000', opacity: 1, rotation: 0 })
  }
  return { bytes: await pdf.save(), width, height, left, top, ...(line ? { line } : {}) }
}

/** The page's transform from PDF space to page coordinates (top-left, y down). */
function toPdf(page: mupdf.PDFPage, x: number, y: number): Point {
  const [a, b, c, d, e, f] = page.getTransform()
  const det = a * d - b * c
  const px = x - e
  const py = y - f
  return [(d * px - c * py) / det, (-b * px + a * py) / det]
}

/** Puts `drawing` on `annot` as its appearance, and sets /Rect to match. */
function applyDrawing(doc: PdfDoc, page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, drawing: Drawing): void {
  const overlay = openPdf(drawing.bytes)
  try {
    const source = overlay.findPage(0)
    const graft = doc.newGraftMap()
    const form = doc.newDictionary()
    form.put('Type', doc.newName('XObject'))
    form.put('Subtype', doc.newName('Form'))
    const bbox = doc.newArray()
    for (const v of [0, 0, drawing.width, drawing.height]) bbox.push(v)
    form.put('BBox', bbox)
    // Upright as the page is shown, also on a turned page (/Rotate).
    const matrix = uprightMatrix(page)
    if (!isIdentity(matrix)) {
      const m = doc.newArray()
      for (const v of matrix) m.push(v)
      form.put('Matrix', m)
    }
    form.put('Resources', graft.graftObject(source.get('Resources')))
    const stream = doc.addStream(contentOf(source), form)
    const ap = doc.newDictionary()
    ap.put('N', stream)
    const obj = annot.getObject()
    obj.put('AP', ap)
    const a = toPdf(page, drawing.left, drawing.top + drawing.height)
    const b = toPdf(page, drawing.left + drawing.width, drawing.top)
    const rect = doc.newArray()
    for (const v of [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]) rect.push(+v.toFixed(3))
    obj.put('Rect', rect)
    // /Rect is the drawing itself: an inset (/RD) from another program no longer applies. A
    // callout's line goes in /CL as other readers expect it (tip first), so they move it with the box.
    obj.delete('RD')
    if (drawing.line) {
      const cl = doc.newArray()
      for (const p of drawing.line) for (const v of toPdf(page, p[0], p[1])) cl.push(+v.toFixed(3))
      obj.put('CL', cl)
    } else obj.delete('CL')
  } finally {
    free(overlay)
  }
}

/** Sets /M without MuPDF's setter, which would mark the annotation for a new (MuPDF-drawn) appearance. */
export function touch(doc: PdfDoc, annot: mupdf.PDFAnnotation): void {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  annot.getObject().put('M', doc.newString(`D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`))
}

/** What is kept on the annotation to draw it again. */
function remember(doc: PdfDoc, annot: mupdf.PDFAnnotation, m: DrawnMarkup): void {
  const note = doc.newDictionary()
  note.put('Spec', doc.newString(JSON.stringify(m)))
  for (const old of OLD_MARKUP_KEYS) annot.getObject().delete(old)
  annot.getObject().put(MARKUP_KEY, note)
}

export function recalled(annot: mupdf.PDFAnnotation): DrawnMarkup | null {
  for (const key of [MARKUP_KEY, ...OLD_MARKUP_KEYS]) {
    try {
      const spec = annot.getObject().get(key).get('Spec')
      if (spec.isString()) return JSON.parse(spec.asString()) as DrawnMarkup
    } catch {
      // Not ours, or not readable: try the older key, then give up.
    }
  }
  return null
}

export async function addDrawnMarkup(bytes: Uint8Array, pageIndex: number, m: DrawnMarkup, password?: string, author?: string): Promise<Uint8Array> {
  if (m.kind === 'stamp' ? !m.label.trim() : !m.text.trim()) throw new PdfError('bad-arguments', 'Type some text first.')
  const drawing = await draw(m)
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    try {
      const annot = page.createAnnotation(m.kind === 'stamp' ? 'Stamp' : 'FreeText')
      annot.setRect([drawing.left, drawing.top, drawing.left + drawing.width, drawing.top + drawing.height])
      annot.setColor(m.colour)
      annot.setContents(m.kind === 'stamp' ? [m.label, m.sub].filter(Boolean).join(' — ') : m.text)
      if (m.kind === 'stamp') annot.setIcon('Draft')
      if (m.kind === 'callout') annot.setIntent('FreeTextCallout')
      annot.setAuthor(author || BRAND.name)
      annot.setCreationDate(new Date())
      annot.setModificationDate(new Date())
      annot.update()
      applyDrawing(doc, page, annot, drawing)
      remember(doc, annot, m)
    } finally {
      free(page)
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

type Affine = [number, number, number, number, number, number]
const applyAffine = (m: Affine | number[], [x, y]: Point): Point => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!]

function numbers(o: mupdf.PDFObject, count: number): number[] | null {
  if (!o.isArray() || o.length !== count) return null
  const out = Array.from({ length: count }, (_, i) => o.get(i))
  return out.every((v) => v.isNumber()) ? out.map((v) => v.asNumber()) : null
}

/** The drawing's top-left corner as the spec places it (as `draw` does), for a drawing `width` × `height`. */
function originOf(m: DrawnMarkup, width: number, height: number): Point {
  if (m.kind === 'stamp') return [m.at[0] - width / 2, m.at[1] - height / 2]
  if (m.kind === 'textbox') return [m.rect[0], m.rect[1]]
  return [Math.min(m.rect[0], m.to[0]) - 4, Math.min(m.rect[1], m.to[1]) - 4]
}

/**
 * From the page as it was shown when the markup was drawn (the coordinates its spec is written
 * in) to the page as it is shown now. The page may have been turned (/Rotate) or cropped since,
 * or the annotation moved by another program: the drawing is fitted into /Rect as a reader does
 * it (PDF 32000 §12.5.5), so this follows it wherever it shows. Null when the look is not ours.
 */
function shownNow(page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, m: DrawnMarkup): { map: (p: Point) => Point; height: number } | null {
  const obj = annot.getObject()
  const ap = obj.get('AP')
  if (!ap.isDictionary()) return null
  const n = ap.get('N')
  if (!n.isStream()) return null
  const bbox = numbers(n.get('BBox'), 4)
  const r = numbers(obj.get('Rect'), 4)
  if (!bbox || !r) return null
  const matrix = numbers(n.get('Matrix'), 6) ?? [1, 0, 0, 1, 0, 0]
  const width = bbox[2]! - bbox[0]!
  const height = bbox[3]! - bbox[1]!
  if (width <= 0 || height <= 0) return null
  const corners = [
    [bbox[0]!, bbox[1]!],
    [bbox[2]!, bbox[1]!],
    [bbox[0]!, bbox[3]!],
    [bbox[2]!, bbox[3]!]
  ].map((p) => applyAffine(matrix, p as Point))
  const bx0 = Math.min(...corners.map((p) => p[0]))
  const by0 = Math.min(...corners.map((p) => p[1]))
  const bx1 = Math.max(...corners.map((p) => p[0]))
  const by1 = Math.max(...corners.map((p) => p[1]))
  if (bx1 - bx0 <= 0 || by1 - by0 <= 0) return null
  const [rx0, ry0, rx1, ry1] = [Math.min(r[0]!, r[2]!), Math.min(r[1]!, r[3]!), Math.max(r[0]!, r[2]!), Math.max(r[1]!, r[3]!)]
  const sx = (rx1 - rx0) / (bx1 - bx0)
  const sy = (ry1 - ry0) / (by1 - by0)
  const [left, top] = originOf(m, width, height)
  const transform = page.getTransform()
  const map = ([x, y]: Point): Point => {
    const q = applyAffine(matrix, [bbox[0]! + x - left, bbox[1]! + height - (y - top)])
    return applyAffine(transform, [rx0 + (q[0] - bx0) * sx, ry0 + (q[1] - by0) * sy])
  }
  // Unchanged frame: keep the spec exactly as it is (no rounding drift).
  const same = ([[0, 0], [100, 0], [0, 100]] as Point[]).every((p) => {
    const s = map(p)
    return Math.abs(s[0] - p[0]) < 0.01 && Math.abs(s[1] - p[1]) < 0.01
  })
  return same ? null : { map, height }
}

const round3 = (p: Point): Point => [+p[0].toFixed(3), +p[1].toFixed(3)]

/**
 * The spec in the page's coordinates as shown now (A2): a stamp, text box or callout revised
 * after the page was turned or cropped is drawn again where it shows, upright, not where the
 * page used to put it. Its size stays; a callout's tip keeps pointing at the same spot.
 */
function anchored(page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, m: DrawnMarkup): DrawnMarkup {
  const now = shownNow(page, annot, m)
  if (!now) return m
  const { map, height } = now
  if (m.kind === 'stamp') return { ...m, at: round3(map(m.at)) }
  const boxW = Math.max(40, m.rect[2] - m.rect[0])
  let boxH = m.rect[3] - m.rect[1]
  if (m.kind === 'textbox') boxH = height
  else {
    // The drawing reaches 4 points past the box, or past the tip when it lies lower.
    const bottom = Math.min(m.rect[1], m.to[1]) - 4 + height
    if (m.to[1] + 4 < bottom - 0.01) boxH = bottom - 4 - m.rect[1]
  }
  const c: Point = [m.rect[0] + boxW / 2, m.rect[1] + boxH / 2]
  const c2 = map(c)
  const [ddx, ddy] = [c2[0] - c[0], c2[1] - c[1]]
  const rect: Box = [m.rect[0] + ddx, m.rect[1] + ddy, m.rect[2] + ddx, m.rect[3] + ddy].map((v) => +v.toFixed(3)) as Box
  return m.kind === 'textbox' ? { ...m, rect } : { ...m, rect, to: round3(map(m.to)) }
}

/** Moves a drawn markup by (dx, dy) points, keeping its drawing. */
export function moveDrawn(doc: PdfDoc, page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, dx: number, dy: number): void {
  const m = recalled(annot)
  // Shift /Rect itself, in PDF space: the rectangle MuPDF reports for a stamp is adjusted
  // to its drawing, and rebuilding /Rect from it would change the size a little each time.
  const [a, b, c, d] = page.getTransform()
  const det = a * d - b * c
  const pdx = (d * dx - c * dy) / det
  const pdy = (-b * dx + a * dy) / det
  const obj = annot.getObject()
  const old = obj.get('Rect')
  const rect = doc.newArray()
  for (let i = 0; i < 4; i++) rect.push(+(old.get(i).asNumber() + (i % 2 === 0 ? pdx : pdy)).toFixed(3))
  // The move in the spec's own coordinates: those of the page as it was when it was drawn.
  const now = m ? shownNow(page, annot, m) : null
  obj.put('Rect', rect)
  // A callout's line (/CL, ours or another program's) moves with it, in PDF space (A3).
  const cl = obj.get('CL')
  if (cl.isArray() && cl.length >= 4) {
    const moved = doc.newArray()
    for (let i = 0; i < cl.length; i++) moved.push(+(cl.get(i).asNumber() + (i % 2 === 0 ? pdx : pdy)).toFixed(3))
    obj.put('CL', moved)
  }
  if (m) {
    let [u, v] = [dx, dy]
    if (now) {
      const o = now.map([0, 0])
      const ex = now.map([1, 0])
      const ey = now.map([0, 1])
      const [ax, ay, bx, by] = [ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1]]
      const det2 = ax * by - bx * ay
      if (Math.abs(det2) > 1e-9) [u, v] = [(dx * by - bx * dy) / det2, (ax * dy - dx * ay) / det2]
    }
    const shift = (p: Point): Point => [p[0] + u, p[1] + v]
    const moved: DrawnMarkup =
      m.kind === 'stamp' ? { ...m, at: shift(m.at) } : m.kind === 'textbox' ? { ...m, rect: [m.rect[0] + u, m.rect[1] + v, m.rect[2] + u, m.rect[3] + v] } : { ...m, rect: [m.rect[0] + u, m.rect[1] + v, m.rect[2] + u, m.rect[3] + v], to: shift(m.to) }
    remember(doc, annot, moved)
  }
}

/** Draws a drawn markup again with new text or colour (Comments panel, Properties). */
export async function reviseDrawn(doc: PdfDoc, page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, change: { colour?: Rgb; text?: string }): Promise<void> {
  const recalledSpec = recalled(annot)
  if (!recalledSpec) return
  const m = anchored(page, annot, recalledSpec)
  const next: DrawnMarkup =
    m.kind === 'stamp' ? { ...m, ...(change.colour ? { colour: change.colour } : {}), ...(change.text !== undefined ? { label: change.text } : {}) } : { ...m, ...(change.colour ? { colour: change.colour } : {}), ...(change.text !== undefined ? { text: change.text } : {}) }
  // Rich text from another program would show the old words when it is edited there.
  if (change.text !== undefined) annot.getObject().delete('RC')
  applyDrawing(doc, page, annot, await draw(next))
  remember(doc, annot, next)
}

/** Colour and size from a default appearance string ("/Helv 14 Tf 1 0 0 rg"). */
function fromDa(da: string): { size: number; colour: Rgb | null } {
  const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 0)
  const rgbMatch = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da)
  const grey = /([\d.]+)\s+g\b/.exec(da)
  const colour: Rgb | null = rgbMatch ? [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])] : grey ? [Number(grey[1]), Number(grey[1]), Number(grey[1])] : null
  return { size, colour }
}

/**
 * A text box or callout made by another program (Acrobat), revised here (A3): MuPDF would
 * draw it again itself and its drawing blanks Arabic (§44), so it becomes one of ours — the
 * same box, text size and colour, and a callout's tip from its /CL — drawn by `draw`.
 */
export async function adoptFreeText(doc: PdfDoc, page: mupdf.PDFPage, annot: mupdf.PDFAnnotation, change: { colour?: Rgb; text?: string }): Promise<void> {
  const obj = annot.getObject()
  const r = numbers(obj.get('Rect'), 4)
  if (!r) throw new PdfError('unsupported', 'This text box cannot be changed.')
  // /RD: the inner box's distance from /Rect at the left, top, right and bottom.
  const rd = numbers(obj.get('RD'), 4) ?? [0, 0, 0, 0]
  const box: Box = [Math.min(r[0]!, r[2]!) + rd[0]!, Math.min(r[1]!, r[3]!) + rd[3]!, Math.max(r[0]!, r[2]!) - rd[2]!, Math.max(r[1]!, r[3]!) - rd[1]!]
  const transform = page.getTransform()
  const corners = [applyAffine(transform, [box[0], box[1]]), applyAffine(transform, [box[2], box[3]]), applyAffine(transform, [box[0], box[3]]), applyAffine(transform, [box[2], box[1]])]
  const rect: Box = [Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])), Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))].map((v) => +v.toFixed(3)) as Box
  const daObj = obj.get('DA')
  const da = fromDa(daObj.isString() ? daObj.asString() : '')
  let colour: Rgb = change.colour ?? da.colour ?? [0, 0, 0]
  if (!change.colour && !da.colour) {
    try {
      const c = annot.getColor() as number[]
      if (c.length === 3) colour = [c[0]!, c[1]!, c[2]!]
    } catch {
      /* no colour */
    }
  }
  const size = da.size > 0 ? da.size : 12
  const contents = obj.get('Contents')
  // Acrobat saves line breaks as CR; the text box breaks lines at LF.
  const text = change.text ?? (contents.isString() ? contents.asString().replace(/\r\n?/g, '\n') : '')
  let intent = ''
  try {
    intent = annot.getIntent() ?? ''
  } catch {
    /* none */
  }
  const cl = numbers(obj.get('CL'), 6) ?? numbers(obj.get('CL'), 4)
  const m: DrawnMarkup = intent === 'FreeTextCallout' && cl ? { kind: 'callout', rect, to: round3(applyAffine(transform, [cl[0]!, cl[1]!])), text, colour, size } : { kind: 'textbox', rect, text, colour, size }
  if (change.text !== undefined) obj.put('Contents', doc.newString(change.text))
  obj.delete('RC')
  obj.delete('DS')
  applyDrawing(doc, page, annot, await draw(m))
  remember(doc, annot, m)
}

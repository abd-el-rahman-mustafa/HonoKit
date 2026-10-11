import { BRAND } from '@shared/brand'
import { smoothStroke } from '@shared/smooth'
import { PdfError } from './errors'
import { adoptFreeText, moveDrawn, recalled, reviseDrawn, touch } from './drawnMarkup'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'

/**
 * Markup: highlight, underline and strike-through of text, freehand pen, rectangles,
 * ellipses, lines and arrows (docs/decisions.md §30).
 *
 * These are standard PDF annotations, as Acrobat's and Foxit's comment tools make — not
 * drawings merged into the page. Every reader shows them, they can be selected, moved and
 * deleted later (here or in any other editor), and the page's own content is untouched.
 * MuPDF draws their appearance, so they look the same everywhere.
 *
 * Coordinates are the page as displayed: points from the top-left, the same space the
 * text editor and MuPDF's annotation calls use.
 */

type Point = [number, number]
export type Box = [number, number, number, number]
type Rgb = [number, number, number]

export type MarkupKind = 'highlight' | 'underline' | 'strikeout' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'note' | 'stamp' | 'textbox' | 'callout'

export type Markup =
  /** The text between two points, as a selection would take it. */
  | { kind: 'highlight' | 'underline' | 'strikeout'; from: Point; to: Point; colour: Rgb; opacity?: number }
  | { kind: 'ink'; strokes: Point[][]; colour: Rgb; width: number; opacity?: number }
  | { kind: 'rect' | 'ellipse'; rect: Box; colour: Rgb; width: number; fill?: Rgb | null; opacity?: number }
  | { kind: 'line' | 'arrow'; from: Point; to: Point; colour: Rgb; width: number; opacity?: number }
  /** A sticky note: an icon on the page holding a comment, as Acrobat's "Add a comment". */
  | { kind: 'note'; at: Point; text: string; colour: Rgb }

export interface MarkupInfo {
  /** Position among the page's annotations; with `box`, identifies it. */
  index: number
  kind: MarkupKind | 'other'
  box: Box
  colour: string
  /** Markup that can be moved by dragging (text markup follows its text instead). */
  movable: boolean
  /** The comment written on it (a sticky note's text). */
  text: string
  author: string
  /** Last change, ms since 1970; 0 if unknown. */
  modified: number
  /** The annotation's object number (0 when it has none): what a reply's `replyTo` names. */
  id: number
  /** A reply (/IRT): the object number of the comment it answers, which may be on another page. */
  replyTo?: number
  /** A review state set on the comment it answers (/State: Accepted, Rejected, Completed…). */
  state?: string
}

const TYPES: Record<string, MarkupKind> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Ink: 'ink',
  Square: 'rect',
  Circle: 'ellipse',
  Line: 'line',
  Text: 'note',
  Stamp: 'stamp',
  FreeText: 'textbox'
}

/**
 * Annotations this editor lists; widgets (form fields), links and popups are not markup, nor are
 * media, 3D, printer marks and watermarks (ISO 32000-2 §12.5.6), which Acrobat keeps out of Comments.
 */
const SKIP = new Set(['Widget', 'Link', 'Popup', 'Screen', 'Movie', 'RichMedia', '3D', 'PrinterMark', 'TrapNet', 'Watermark'])

function hex(c: number[]): string {
  if (c.length === 1) c = [c[0]!, c[0]!, c[0]!]
  if (c.length === 4) c = [1 - Math.min(1, c[0]! + c[3]!), 1 - Math.min(1, c[1]! + c[3]!), 1 - Math.min(1, c[2]! + c[3]!)]
  if (c.length !== 3) return '#000000'
  return `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
}

function kindOf(annot: mupdf.PDFAnnotation): MarkupKind | 'other' {
  const type = annot.getType()
  if (type === 'Line') {
    try {
      const { start, end } = annot.getLineEndingStyles()
      if ((start && start !== 'None') || (end && end !== 'None')) return 'arrow'
    } catch {
      /* no endings: a line */
    }
  }
  if (type === 'FreeText') {
    try {
      if (annot.getIntent() === 'FreeTextCallout') return 'callout'
    } catch {
      /* no intent: a text box */
    }
  }
  return TYPES[type] ?? 'other'
}

/** A text value of a dictionary, '' when it is not one. */
function textOf(obj: mupdf.PDFObject, key: string): string {
  const v = obj.get(key)
  return v.isString() ? v.asString() : v.isName() ? v.asName() : ''
}

/** Who an annotation answers (/IRT) and the review state it sets (§82). */
function thread(obj: mupdf.PDFObject): Pick<MarkupInfo, 'id' | 'replyTo' | 'state'> {
  const out: Pick<MarkupInfo, 'id' | 'replyTo' | 'state'> = { id: Math.max(0, numOf(obj)) }
  try {
    const irt = obj.get('IRT')
    if (irt.isIndirect()) out.replyTo = irt.asIndirect()
    const state = textOf(obj, 'State')
    if (state && out.replyTo) out.state = state
  } catch {
    /* a damaged annotation: no thread */
  }
  return out
}

/**
 * A comment's text with its line breaks. Acrobat saves them as CR ("first\r\rsecond"), which
 * MuPDF's getContents drops and a web page does not break on: read /Contents and use LF.
 */
export function commentText(annot: mupdf.PDFAnnotation): string {
  const raw = annot.getObject().get('Contents')
  const text = raw.isString() ? raw.asString() : annot.getContents()
  return text.replace(/\r\n?/g, '\n')
}

export function pageMarkups(doc: PdfDoc, pageIndex: number): MarkupInfo[] {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage
  try {
    const out: MarkupInfo[] = []
    page.getAnnotations().forEach((annot, index) => {
      if (SKIP.has(annot.getType())) return
      const b = annot.getBounds()
      const kind = kindOf(annot)
      let colour = '#000000'
      try {
        colour = hex(annot.getColor() as number[])
      } catch {
        /* no colour */
      }
      const safe = <T,>(get: () => T, fallback: T): T => {
        try {
          return get()
        } catch {
          return fallback
        }
      }
      out.push({
        index,
        kind,
        box: [b[0], b[1], b[2], b[3]],
        colour,
        movable: kind !== 'highlight' && kind !== 'underline' && kind !== 'strikeout' && kind !== 'other',
        text: safe(() => commentText(annot), ''),
        author: safe(() => annot.getAuthor(), ''),
        // No /M: unknown (MuPDF answers 1970 for it, which showed as "20,000 days ago").
        modified: safe(() => (annot.getObject().get('M').isNull() ? 0 : Math.max(0, annot.getModificationDate().getTime() || 0)), 0),
        ...thread(annot.getObject())
      })
    })
    return out
  } finally {
    free(page)
  }
}

function withPage<T>(bytes: Uint8Array, pageIndex: number, password: string | undefined, fn: (doc: PdfDoc, page: mupdf.PDFPage) => T): { bytes: Uint8Array; value: T } {
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    try {
      const value = fn(doc, page)
      return { bytes: saveBytes(doc), value }
    } finally {
      free(page)
    }
  } finally {
    free(doc)
  }
}

/** The quads of the text between two points, one per line, as a selection takes it. */
function textQuads(page: mupdf.PDFPage, from: Point, to: Point): mupdf.Quad[] {
  const stext = page.toStructuredText('preserve-whitespace')
  try {
    const quads = stext.highlight(from, to, 5000)
    if (quads.length > 0) return quads
    // A drag that ran just between two lines: take the nearest line, as Acrobat does.
    const lines: Box[] = []
    stext.walk({
      beginLine(bbox: mupdf.Rect) {
        // Horizontal lines only: a diagonal watermark's box would swallow the page.
        if (bbox[3] - bbox[1] < 72) lines.push([bbox[0], bbox[1], bbox[2], bbox[3]])
      }
    })
    const snap = (p: Point): Point => {
      let best: { d: number; line: Box } | null = null
      for (const line of lines) {
        if (p[0] < line[0] - 12 || p[0] > line[2] + 12) continue
        const h = line[3] - line[1]
        const d = p[1] < line[1] ? line[1] - p[1] : p[1] > line[3] ? p[1] - line[3] : 0
        if (d <= h * 0.75 && (!best || d < best.d)) best = { d, line }
      }
      return best ? [p[0], (best.line[1] + best.line[3]) / 2] : p
    }
    return stext.highlight(snap(from), snap(to), 5000)
  } finally {
    free(stext)
  }
}

/**
 * Where a note's /Rect goes so its icon shows with its top-left corner at `at`. Readers draw a
 * note's icon upright and unscaled from the top-left corner of /Rect in PDF space (Text
 * annotations behave as if NoRotate and NoZoom were set, PDF 32000 §12.5.6.4). On a turned page
 * (/Rotate) that corner is not the one shown top-left, so the icon landed away from the click.
 */
function noteRect(page: mupdf.PDFPage, at: Point, size = 20): Box {
  const [a, b, c, d, e, f] = page.getTransform()
  const det = a * d - b * c
  const px = (d * (at[0] - e) - c * (at[1] - f)) / det
  const py = (-b * (at[0] - e) + a * (at[1] - f)) / det
  const shown = ([x, y]: Point): Point => [a * x + c * y + e, b * x + d * y + f]
  const corners = [shown([px, py]), shown([px + size, py]), shown([px, py - size]), shown([px + size, py - size])]
  const xs = corners.map((p) => p[0])
  const ys = corners.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function stamp(annot: mupdf.PDFAnnotation, opacity: number | undefined, author: string = BRAND.name): void {
  annot.setAuthor(author || BRAND.name)
  annot.setCreationDate(new Date())
  annot.setModificationDate(new Date())
  if (opacity !== undefined && opacity < 1) annot.setOpacity(opacity)
  annot.update()
}

/** Adds one piece of markup. Returns false as `added` when a text markup found no text. */
export function addMarkup(bytes: Uint8Array, pageIndex: number, markup: Markup, password?: string, author?: string): { bytes: Uint8Array; added: boolean } {
  const r = withPage(bytes, pageIndex, password, (_doc, page) => {
    switch (markup.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout': {
        const quads = textQuads(page, markup.from, markup.to)
        if (quads.length === 0) return false
        const annot = page.createAnnotation(markup.kind === 'highlight' ? 'Highlight' : markup.kind === 'underline' ? 'Underline' : 'StrikeOut')
        annot.setColor(markup.colour)
        annot.setQuadPoints(quads)
        stamp(annot, markup.opacity, author)
        return true
      }
      case 'ink': {
        const strokes = markup.strokes.filter((s) => s.length > 0)
        if (strokes.length === 0) return false
        const annot = page.createAnnotation('Ink')
        annot.setColor(markup.colour)
        annot.setBorderWidth(markup.width)
        // A single click is a dot: a stroke needs two points to be drawn. Longer strokes are
        // stored as the smooth curve through their points: MuPDF and other readers join the
        // listed points with straight lines (§82).
        annot.setInkList(strokes.map((s) => (s.length === 1 ? [s[0]!, [s[0]![0] + 0.01, s[0]![1] + 0.01] as Point] : smoothStroke(s))))
        stamp(annot, markup.opacity, author)
        return true
      }
      case 'rect':
      case 'ellipse': {
        const annot = page.createAnnotation(markup.kind === 'rect' ? 'Square' : 'Circle')
        annot.setRect(markup.rect)
        annot.setColor(markup.colour)
        annot.setBorderWidth(markup.width)
        if (markup.fill) annot.setInteriorColor(markup.fill)
        stamp(annot, markup.opacity, author)
        return true
      }
      case 'note': {
        const annot = page.createAnnotation('Text')
        annot.setRect(noteRect(page, markup.at))
        annot.setIcon('Comment')
        annot.setColor(markup.colour)
        annot.setContents(markup.text)
        stamp(annot, undefined, author)
        return true
      }
      case 'line':
      case 'arrow': {
        const annot = page.createAnnotation('Line')
        annot.setLine(markup.from, markup.to)
        annot.setColor(markup.colour)
        annot.setBorderWidth(markup.width)
        if (markup.kind === 'arrow') annot.setLineEndingStyles('None', 'OpenArrow')
        stamp(annot, markup.opacity, author)
        return true
      }
    }
  })
  return { bytes: r.bytes, added: r.value }
}

/** Finds the annotation the interface means: at `index`, and still where it was shown. */
function find(page: mupdf.PDFPage, index: number, box: Box): mupdf.PDFAnnotation {
  const annot = page.getAnnotations()[index]
  if (annot) {
    const b = annot.getBounds()
    if (b.every((v, i) => Math.abs(v - box[i]!) < 1.5)) return annot
  }
  throw new PdfError('bad-arguments', 'That markup is no longer there.')
}

const numOf = (o: mupdf.PDFObject): number => (o.isIndirect() ? o.asIndirect() : -1)

/**
 * Takes annotations off a page (`page` is the page object), with what belongs to them, as
 * Acrobat does (A4): their pop-ups, and every reply (/IRT), replies to replies included, with
 * the replies' pop-ups. Returns the object numbers removed. Widgets are taken off the page
 * only; their fields are the caller's business.
 */
export function removeAnnotationObjects(page: mupdf.PDFObject, targets: Iterable<number>): Set<number> {
  // A set is added to in place (removeThreads collects across pages).
  const gone = targets instanceof Set ? (targets as Set<number>) : new Set<number>([...targets].filter((n) => n > 0))
  const annots = page.get('Annots')
  if (!annots.isArray()) return gone
  const items = Array.from({ length: annots.length }, (_, i) => annots.get(i))
  const ref = (o: mupdf.PDFObject, key: string): number => {
    try {
      return numOf(o.get(key))
    } catch {
      return -1
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const item of items) {
      const n = numOf(item)
      if (n < 0) continue
      if (gone.has(n)) {
        const popup = ref(item, 'Popup')
        if (popup > 0 && !gone.has(popup)) {
          gone.add(popup)
          changed = true
        }
      } else {
        const subtype = item.get('Subtype')
        const popup = subtype.isName() && subtype.asName() === 'Popup'
        // A reply to a removed one, or its pop-up. (Only a pop-up's /Parent is an annotation.)
        if (gone.has(ref(item, 'IRT')) || (popup && gone.has(ref(item, 'Parent')))) {
          gone.add(n)
          changed = true
        }
      }
    }
  }
  for (let i = annots.length - 1; i >= 0; i--) if (gone.has(numOf(annots.get(i)))) annots.delete(i)
  return gone
}

/**
 * The same across the whole document (§82): a reply or a review state may sit on
 * another page than the comment it answers (Acrobat keeps them with the comment, but files made
 * elsewhere, and pages moved later, do not). Pages are gone over until nothing more is found.
 */
export function removeThreads(doc: PdfDoc, targets: Iterable<number>): Set<number> {
  const gone = new Set<number>([...targets].filter((n) => n > 0))
  const pages = Array.from({ length: doc.countPages() }, (_, i) => doc.findPage(i))
  for (let size = -1; size !== gone.size; ) {
    size = gone.size
    for (const page of pages) removeAnnotationObjects(page, gone)
  }
  return gone
}

export function removeMarkup(bytes: Uint8Array, pageIndex: number, index: number, box: Box, password?: string): Uint8Array {
  return withPage(bytes, pageIndex, password, (doc, page) => {
    const annot = find(page, index, box)
    const n = numOf(annot.getObject())
    if (n < 0) {
      page.deleteAnnotation(annot)
      return
    }
    removeThreads(doc, [n])
  }).bytes
}

/** Changes the colour of a piece of markup, or the text of its comment. */
export async function reviseMarkup(bytes: Uint8Array, pageIndex: number, index: number, box: Box, change: { colour?: Rgb; text?: string }, password?: string): Promise<Uint8Array> {
  const doc = openPdf(bytes, password)
  try {
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    try {
      const annot = find(page, index, box)
      if (recalled(annot)) {
        // Our own drawing (stamp, text box, callout): MuPDF's setters would make it draw its own
        // at save, so the text, date and drawing are written directly.
        if (change.text !== undefined) annot.getObject().put('Contents', doc.newString(change.text))
        touch(doc, annot)
        await reviseDrawn(doc, page, annot, change)
      } else if (annot.getType() === 'FreeText') {
        // Another program's text box: drawn by us from now on (MuPDF's drawing blanks Arabic).
        touch(doc, annot)
        await adoptFreeText(doc, page, annot, change)
      } else {
        if (change.text !== undefined) annot.setContents(change.text)
        annot.setModificationDate(new Date())
        if (change.colour) annot.setColor(change.colour)
        annot.update()
      }
      return saveBytes(doc)
    } finally {
      free(page)
    }
  } finally {
    free(doc)
  }
}

/** Moves a shape, line or pen stroke by (dx, dy) points. */
export function moveMarkup(bytes: Uint8Array, pageIndex: number, index: number, box: Box, dx: number, dy: number, password?: string): Uint8Array {
  return withPage(bytes, pageIndex, password, (doc, page) => {
    const annot = find(page, index, box)
    if (recalled(annot) || annot.getType() === 'Stamp' || annot.getType() === 'FreeText') {
      moveDrawn(doc, page, annot, dx, dy)
      touch(doc, annot)
      return
    }
    const shift = (p: Point): Point => [p[0] + dx, p[1] + dy]
    const type = annot.getType()
    if (type === 'Ink') annot.setInkList(annot.getInkList().map((s) => s.map((p) => shift(p as Point))))
    else if (type === 'Line') {
      const [a, b] = annot.getLine() as Point[]
      annot.setLine(shift(a!), shift(b!))
    } else if (type === 'Square' || type === 'Circle' || type === 'Text') {
      const r = annot.getRect()
      annot.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
    } else throw new PdfError('unsupported', 'This markup cannot be moved.')
    annot.setModificationDate(new Date())
    annot.update()
  }).bytes
}

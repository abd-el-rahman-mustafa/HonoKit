import { PDFDocument, rgb } from 'pdf-lib'
import { BRAND } from '@shared/brand'
import { explicitLeading } from './contentfix'
import { PdfError } from './errors'
import { removeFieldsOf } from './forms'
import { removeThreads } from './markup'
import { free, isSigned, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { drawLine, FontSet, measureLine, pageFrame, placeOverlay } from './stamp'
import { extractLines } from './text'
import { unlinkRemoved, xobjectsOf } from './redactresources'
import { clearReplacementText } from './replacementtext'
import { dropRemovedAnnotRefs } from './structtext'

/**
 * Redaction, as Acrobat's (docs/decisions.md §46): mark what must go — areas, text, or
 * what a search or a pattern finds — as Redact annotations the person can review, then
 * apply them all. Applying removes the text, the pictures' pixels and the drawings under
 * every mark for good (MuPDF's redaction), paints the boxes (black by default, optionally
 * with a label such as "REDACTED"), can remove hidden information, and then checks its own
 * work: no character may be left under any mark.
 */

type Box = [number, number, number, number]

export interface RedactHit {
  page: number
  boxes: Box[]
  text: string
  /** A few words around the hit, for the results list. */
  context: string
}

export type RedactPattern = 'email' | 'phone' | 'emiratesId' | 'iban' | 'card' | 'date'

const PATTERNS: Record<RedactPattern, RegExp> = {
  email: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  // UAE numbers (+971 / 00971 / 0 then 5x or a landline code), and other international numbers
  // (+ or 00, groups split by spaces, dashes or dots), taken whole so no part stays readable.
  // A phone number is a whole run of digit groups: one reached through a separator from a digit
  // before it (the tail of a social security number, a card, a reference) is not one, nor is the
  // head of a run that goes on past it; otherwise the start of the longer number stayed readable.
  phone: /(?<!\d[\s.-]?)(?:(?:(?:\+|\b00)971[\s.-]?|\b0)(?:5\d|[2-9])[\s.-]?\d{3}[\s.-]?\d{4}\b|(?:\+|\b00)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,5})(?![\s.-]?\d)/g,
  emiratesId: /\b784[\s-]?\d{4}[\s-]?\d{7}[\s-]?\d\b/g,
  // Case-insensitive because lines are matched folded; the checksum keeps it from matching words.
  iban: /\b[a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){2,7}(?:\s?[a-z0-9]{1,4})?\b/gi,
  // A whole run of digit groups; cardEnd finds the card in it.
  card: /\b\d(?:[\s-]?\d)*\b/g,
  date: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b/g
}

/** Card numbers must pass the Luhn check, or every long number would be marked. */
function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return digits.length >= 13 && sum % 10 === 0
}

/**
 * Where the card number in a run of digit groups ends, or -1. The run may carry a trailing number
 * (an expiry, a year, a CVV), so the whole run is tried, then each shorter one ending at a group
 * boundary, longest first. At most four digits are dropped, so a longer number (an IBAN's digits)
 * does not match on a card-shaped start.
 */
function cardEnd(run: string): number {
  const total = run.replace(/\D/g, '').length
  for (let e = run.length; e > 0; e--) {
    if (!/\d/.test(run[e - 1]!) || (e < run.length && /\d/.test(run[e]!))) continue
    const digits = run.slice(0, e).replace(/\D/g, '')
    if (total - digits.length > 4) break
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return e
  }
  return -1
}

/** The IBAN check (ISO 13616): the number, rearranged and read in base 36, leaves 1 when divided by 97. */
function ibanValid(text: string): boolean {
  const s = text.replace(/\s/g, '').toUpperCase()
  if (s.length < 15 || s.length > 34) return false
  let rest = 0
  for (const c of s.slice(4) + s.slice(0, 4)) {
    const v = parseInt(c, 36)
    rest = (v > 9 ? rest * 100 + v : rest * 10 + v) % 97
  }
  return rest === 1
}

/** Arabic-Indic digits read as Western ones, character for character (positions stay the same). */
const westernDigits = (s: string): string => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))

/**
 * Finds words or patterns to redact. Words are matched whole or as part of a word, ignoring
 * case and Arabic vowel marks; patterns run on each line with Arabic-Indic digits read as digits.
 */
export function findToRedact(doc: PdfDoc, query: { words: string[]; patterns: RedactPattern[]; wholeWords: boolean }): RedactHit[] {
  const hits: RedactHit[] = []
  // Turkish İ and ı fold to i one for one (toLowerCase makes İ two characters); white space as one space.
  const fold = (s: string): string => westernDigits(s).replace(/[ً-ٰٟـ]/g, '').replace(/[İı]/g, 'i').toLowerCase().replace(/\s+/g, ' ')
  const words = query.words.map((w) => w.trim()).filter(Boolean)
  for (let p = 0; p < doc.countPages(); p++) {
    for (const line of extractLines(doc, p)) {
      // Glyph i is character i of `text` (text.ts); folding drops marks, so keep a map back.
      const map: number[] = []
      let folded = ''
      line.glyphs.forEach((g, i) => {
        const f = fold(g.c)
        for (let k = 0; k < f.length; k++) {
          // A phrase still matches where the page has two spaces in a row.
          if (f[k] === ' ' && folded.endsWith(' ')) continue
          folded += f[k]
          map.push(i)
        }
      })
      const add = (start: number, end: number): void => {
        const first = map[start]
        const last = map[end - 1]
        if (first === undefined || last === undefined) return
        let box: Box | null = null
        for (let i = Math.min(first, last); i <= Math.max(first, last); i++) {
          const b = line.glyphs[i]!.box
          box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b]
        }
        if (!box) return
        const text = line.glyphs.slice(Math.min(first, last), Math.max(first, last) + 1).map((g) => g.c).join('')
        hits.push({ page: p, boxes: [box], text, context: line.text.trim().slice(0, 120) })
      }
      for (const word of words) {
        const needle = fold(word)
        let from = 0
        for (;;) {
          const at = folded.indexOf(needle, from)
          if (at < 0) break
          const end = at + needle.length
          const edge = (i: number): boolean => i < 0 || i >= folded.length || !/[\p{L}\p{N}]/u.test(folded[i]!)
          if (!query.wholeWords || (edge(at - 1) && edge(end))) add(at, end)
          from = end
        }
      }
      for (const pattern of query.patterns) {
        for (const m of folded.matchAll(PATTERNS[pattern])) {
          if (pattern === 'card') {
            const end = cardEnd(m[0])
            if (end > 0) add(m.index!, m.index! + end)
            continue
          }
          if (pattern === 'iban' && !ibanValid(m[0])) continue
          if (pattern === 'phone' && m[0].replace(/\D/g, '').length < 8) continue
          add(m.index!, m.index! + m[0].length)
        }
      }
    }
  }
  return hits
}

/** Adds redaction marks (Redact annotations, a red outline until applied). */
export function markForRedaction(bytes: Uint8Array, marks: Array<{ page: number; box: Box }>, password?: string, author?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const byPage = new Map<number, Box[]>()
    for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.box])
    for (const [p, boxes] of byPage) {
      if (p < 0 || p >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
      const page = doc.loadPage(p) as mupdf.PDFPage
      try {
        for (const box of boxes) {
          // A little room around text, so the tops and tails of letters go too.
          const annot = page.createAnnotation('Redact')
          annot.setRect([box[0] - 0.5, box[1] - 0.5, box[2] + 0.5, box[3] + 0.5])
          annot.setAuthor(author || BRAND.name)
          annot.setCreationDate(new Date())
          annot.update()
        }
      } finally {
        free(page)
      }
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Every mark waiting to be applied. */
export function redactionMarks(doc: PdfDoc): Array<{ page: number; box: Box }> {
  const out: Array<{ page: number; box: Box }> = []
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p) as mupdf.PDFPage
    try {
      for (const a of page.getAnnotations()) if (a.getType() === 'Redact') out.push({ page: p, box: a.getRect() as Box })
    } finally {
      free(page)
    }
  }
  return out
}

/** The object numbers of the marks on `pages`, to take what belongs to them with them (§102). */
function redactionMarkObjects(doc: PdfDoc, pages: number[]): number[] {
  const out: number[] = []
  for (const p of pages) {
    const page = doc.loadPage(p) as mupdf.PDFPage
    try {
      for (const a of page.getAnnotations()) {
        if (a.getType() !== 'Redact') continue
        const obj = a.getObject()
        if (obj.isIndirect()) out.push(obj.asIndirect())
      }
    } finally {
      free(page)
    }
  }
  return out
}

/** Removes the one mark at `box` (as `redactionMarks` gave it). */
export function removeRedactionMark(bytes: Uint8Array, pageIndex: number, box: Box, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    try {
      const mark = page.getAnnotations().find((a) => a.getType() === 'Redact' && (a.getRect() as Box).every((v, i) => Math.abs(v - box[i]!) < 1))
      if (!mark) throw new PdfError('bad-arguments', 'That mark is no longer there.')
      // What belongs to the mark goes with it: a reply to it, and its pop-up, would otherwise be
      // left answering a mark that is no longer there, and keep it in the file (§102).
      const obj = mark.getObject()
      const num = obj.isIndirect() ? obj.asIndirect() : -1
      page.deleteAnnotation(mark)
      if (num > 0) removeThreads(doc, [num])
    } finally {
      free(page)
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

export function clearRedactionMarks(bytes: Uint8Array, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const marks: number[] = []
    for (let p = 0; p < doc.countPages(); p++) {
      const page = doc.loadPage(p) as mupdf.PDFPage
      try {
        for (const a of page.getAnnotations()) {
          if (a.getType() !== 'Redact') continue
          const obj = a.getObject()
          if (obj.isIndirect()) marks.push(obj.asIndirect())
          page.deleteAnnotation(a)
        }
      } finally {
        free(page)
      }
    }
    // What belongs to the marks goes with them (§102): a reply left answering a mark that is no
    // longer there would be listed as a comment, and would keep the mark in the file.
    if (marks.length) removeThreads(doc, marks)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/**
 * Actions that run something, send or fetch data, or open another file — what Acrobat's Remove
 * Hidden Information takes out as "links, actions and JavaScripts". Going to a page (GoTo) and web
 * addresses (URI) are left: they are what a reader sees and follows.
 */
const RISKY_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'Rendition', 'GoToE', 'GoToR', 'Movie', 'Sound'])

/** Whether an action, or one chained after it (/Next), is one of RISKY_ACTIONS. */
function risky(action: mupdf.PDFObject, depth = 0): boolean {
  if (depth > 32) return true
  if (action.isArray()) {
    for (let i = 0; i < action.length; i++) if (risky(action.get(i), depth + 1)) return true
    return false
  }
  if (!action.isDictionary()) return false
  const s = action.get('S')
  if (s.isName() && RISKY_ACTIONS.has(s.asName())) return true
  const next = action.get('Next')
  return next.isNull() ? false : risky(next, depth + 1)
}

/** Takes the scripts and risky actions off a dictionary (an annotation, a field, an outline item). */
function disarm(obj: mupdf.PDFObject): void {
  if (!obj.isDictionary()) return
  obj.delete('AA')
  const a = obj.get('A')
  if (!a.isNull() && risky(a)) obj.delete('A')
}

/**
 * Removes what a document carries besides its pages (as Acrobat's Remove Hidden Information
 * does): metadata, attached files (the attachments list, file
 * attachment annotations and associated files /AF), scripts and risky actions (document, pages,
 * links, fields, bookmarks), other programs' private data (/PieceInfo), page thumbnails, and an
 * XFA form (which also carries the form's data).
 */
function sanitize(doc: PdfDoc): void {
  const trailer = doc.getTrailer()
  const root = trailer.get('Root')
  trailer.delete('Info')
  if (root.isDictionary()) {
    for (const key of ['Metadata', 'OpenAction', 'AA', 'AF', 'PieceInfo', 'Collection', 'NeedsRendering']) root.delete(key)
    const names = root.get('Names')
    if (names.isDictionary()) {
      names.delete('EmbeddedFiles')
      names.delete('JavaScript')
    }
    const acro = root.get('AcroForm')
    if (acro.isDictionary()) {
      acro.delete('XFA')
      // Every field, its kids too (a script can sit on a parent field).
      const seen = new Set<number>()
      const walk = (field: mupdf.PDFObject, depth: number): void => {
        if (depth > 32 || !field.isDictionary()) return
        if (field.isIndirect()) {
          if (seen.has(field.asIndirect())) return
          seen.add(field.asIndirect())
        }
        disarm(field)
        const kids = field.get('Kids')
        if (kids.isArray()) for (let i = 0; i < kids.length; i++) walk(kids.get(i), depth + 1)
      }
      const fields = acro.get('Fields')
      if (fields.isArray()) for (let i = 0; i < fields.length; i++) walk(fields.get(i), 0)
    }
    // Bookmarks stay; a script or a launch behind one does not.
    const outlines = root.get('Outlines')
    if (outlines.isDictionary()) {
      const seen = new Set<number>()
      const walk = (item: mupdf.PDFObject, depth: number): void => {
        for (let k = 0; item.isDictionary() && k < 100000 && depth < 64; k++) {
          if (item.isIndirect()) {
            if (seen.has(item.asIndirect())) return
            seen.add(item.asIndirect())
          }
          disarm(item)
          walk(item.get('First'), depth + 1)
          item = item.get('Next')
        }
      }
      walk(outlines.get('First'), 0)
    }
  }
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.findPage(p)
    for (const key of ['AA', 'Metadata', 'PieceInfo', 'Thumb', 'AF']) page.delete(key)
    const annots = page.get('Annots')
    if (!annots.isArray()) continue
    // An attached file goes with its pop-up (the pop-up is listed on the page too).
    const gone = new Set<number>()
    const popups = new Set<number>()
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i)
      if (!annot.isDictionary()) continue
      const type = annot.get('Subtype')
      if (type.isName() && type.asName() === 'FileAttachment') {
        gone.add(i)
        const popup = annot.get('Popup')
        if (popup.isIndirect()) popups.add(popup.asIndirect())
        continue
      }
      disarm(annot)
      annot.delete('AF')
      annot.delete('PieceInfo')
    }
    for (let i = 0; i < annots.length; i++) {
      const annot = annots.get(i)
      if (annot.isIndirect() && popups.has(annot.asIndirect())) gone.add(i)
    }
    for (const i of [...gone].sort((a, b) => b - a)) annots.delete(i)
  }
}

/**
 * Metadata, private data and associated files sit on images, fonts and forms too: an image's XMP
 * can carry the camera and the place it was taken. Only an entry holding that kind of data goes:
 * a resource map may call one of its resources Metadata or PieceInfo, and that name stays.
 * Runs on the saved file, opened again: walking every object of a document that redaction has
 * just changed in memory made MuPDF read some content streams back wrongly.
 */
function withoutOwnedHiddenData(bytes: Uint8Array, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    return stripOwnedHiddenData(doc) ? rewritten(doc) : bytes
  } finally {
    free(doc)
  }
}

function stripOwnedHiddenData(doc: PdfDoc): boolean {
  const isType = (o: mupdf.PDFObject, key: string, value: string): boolean => {
    const v = o.get(key)
    return v.isName() && v.asName() === value
  }
  const isFilespec = (o: mupdf.PDFObject): boolean => o.isDictionary() && !o.isStream() && (isType(o, 'Type', 'Filespec') || !o.get('EF').isNull() || !o.get('F').isNull() || !o.get('UF').isNull())
  let changed = false
  // Every object the document reaches, from the trailer.
  const seen = new Set<number>()
  const stack: mupdf.PDFObject[] = [doc.getTrailer()]
  const count = doc.countObjects()
  for (let budget = 5_000_000; stack.length > 0 && budget > 0; budget--) {
    let obj = stack.pop()!
    if (obj.isIndirect()) {
      const n = obj.asIndirect()
      if (seen.has(n)) continue
      seen.add(n)
      if (n <= 0 || n >= count) continue
      obj = obj.resolve()
    }
    if (obj.isArray()) {
      obj.forEach((v) => stack.push(v))
      continue
    }
    if (!obj.isDictionary()) continue
    strip(obj)
    obj.forEach((v) => stack.push(v))
  }
  return changed

  function strip(obj: mupdf.PDFObject): boolean {
    const before = changed
    const metadata = obj.get('Metadata')
    if (metadata.isStream() && (isType(metadata, 'Type', 'Metadata') || isType(metadata, 'Subtype', 'XML'))) {
      obj.delete('Metadata')
      changed = true
    }
    const piece = obj.get('PieceInfo')
    if (piece.isDictionary() && !piece.isStream()) {
      obj.delete('PieceInfo')
      changed = true
    }
    const af = obj.get('AF')
    if (af.isArray() && af.length > 0) {
      let files = true
      for (let i = 0; i < af.length; i++) if (!isFilespec(af.get(i))) files = false
      if (files) {
        obj.delete('AF')
        changed = true
      }
    }
    return changed !== before
  }
}

export interface RedactOptions {
  fill: [number, number, number]
  /** Written in each box, as Acrobat's overlay text. */
  label?: string
  /** Remove metadata, attachments and scripts too. */
  sanitize: boolean
}

const overlaps = (a: Box, b: Box): boolean => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])

const textOf = (o: mupdf.PDFObject, key: string): string => {
  try {
    const v = o.getInheritable(key)
    return v.isString() ? v.asString() : v.isName() ? v.asName() : ''
  } catch {
    return ''
  }
}

/**
 * What lies on a page's marks besides its content (R2): every annotation that touches a mark —
 * notes, highlights, stamps (with their text kept in our /HonoPDF spec), ink, shapes, text
 * boxes — with their pop-ups and replies, and every form field with a widget there (the whole
 * field: its value is shared by all its widgets). Readers draw these above the black box, and
 * their text stays in the file.
 */
function removeCovered(doc: PdfDoc, pageIndex: number, boxes: Box[]): void {
  const page = doc.loadPage(pageIndex) as mupdf.PDFPage
  const annots: number[] = []
  const widgets: mupdf.PDFObject[] = []
  try {
    // An entry written as a dictionary of its own in /Annots has no object number to collect: it
    // is taken off the page here, or a comment under a mark stayed in the file (§102).
    const inline: mupdf.PDFAnnotation[] = []
    for (const a of page.getAnnotations()) {
      const type = a.getType()
      // The marks themselves go when applied; a pop-up goes with its note.
      if (type === 'Redact' || type === 'Popup') continue
      const b = a.getBounds() as Box
      if (!boxes.some((m) => overlaps(m, b))) continue
      const obj = a.getObject()
      if (obj.isIndirect()) annots.push(obj.asIndirect())
      else inline.push(a)
    }
    for (const w of page.getWidgets()) if (boxes.some((m) => overlaps(m, w.getBounds() as Box))) widgets.push(w.getObject())
    for (const a of inline) page.deleteAnnotation(a)
  } finally {
    free(page)
  }
  if (widgets.length) removeFieldsOf(doc, widgets)
  // Their replies go too, also those on other pages (they may quote the redacted words).
  if (annots.length) removeThreads(doc, annots)
}

/**
 * Characters still readable on the marks of `check`: text on the page (our own boxes and labels
 * aside — only the overlay XObjects named in `overlays` are left out, nothing else), and the
 * comments and field values of anything still lying on a mark.
 */
function leftoverUnder(check: PdfDoc, pages: number[], marks: Array<{ page: number; box: Box }>, overlays: Map<number, Set<string>>): number {
  let leftover = 0
  for (const p of pages) {
    const boxes = marks.filter((m) => m.page === p).map((m) => m.box)
    // Our overlay is blanked in this copy only, so the label's letters are not counted.
    const ours = overlays.get(p)
    const xobjects = check.findPage(p).getInheritable('Resources')
    const dict = xobjects.isDictionary() ? xobjects.get('XObject') : null
    if (ours && dict?.isDictionary()) for (const name of ours) if (dict.get(name).isStream()) dict.get(name).writeStream(new Uint8Array(0))
    for (const line of extractLines(check, p))
      for (const g of line.glyphs) {
        if (/\s/.test(g.c)) continue
        const cx = (g.box[0] + g.box[2]) / 2
        const cy = (g.box[1] + g.box[3]) / 2
        if (boxes.some((b) => cx > b[0] && cx < b[2] && cy > b[1] && cy < b[3])) leftover++
      }
    const page = check.loadPage(p) as mupdf.PDFPage
    try {
      for (const a of [...page.getAnnotations(), ...page.getWidgets()]) {
        const type = a.getType()
        if (type === 'Popup' || type === 'Redact') continue
        if (!boxes.some((m) => overlaps(m, a.getBounds() as Box))) continue
        const obj = a.getObject()
        const words = (textOf(obj, 'Contents') + textOf(obj, 'V') + textOf(obj, 'RC')).replace(/\s/g, '')
        leftover += Math.max(1, [...words].length)
      }
    } finally {
      free(page)
    }
  }
  return leftover
}

/** XObject names in each page's resources, to tell afterwards which ones the overlay added. */
function xobjectNames(doc: PdfDoc, pages: number[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  for (const p of pages) {
    const names = new Set<string>()
    const resources = doc.findPage(p).getInheritable('Resources')
    const dict = resources.isDictionary() ? resources.get('XObject') : null
    if (dict?.isDictionary()) dict.forEach((_v, key) => names.add(String(key)))
    out.set(p, names)
  }
  return out
}

/**
 * The whole file written again, keeping only what is still used (R1). An incremental save
 * (what a signed file normally gets, §53) or the quick snapshot would keep the old content
 * streams — the redacted text — in the file, for anyone to read back.
 */
function rewritten(doc: PdfDoc): Uint8Array {
  const buffer = doc.saveToBuffer('garbage=deduplicate,compress')
  try {
    return new Uint8Array(buffer.asUint8Array())
  } finally {
    free(buffer)
  }
}

/**
 * Applies every redaction mark. Returns how many areas went, how many characters were found
 * under them afterwards (must be 0), and whether the file was signed: its signatures no longer
 * hold, since the whole file is rewritten (as Acrobat warns).
 */
export async function applyRedactions(bytes: Uint8Array, options: RedactOptions, password?: string): Promise<{ bytes: Uint8Array; areas: number; pages: number; leftover: number; signed: boolean }> {
  const doc = openPdf(bytes, password)
  try {
    const marks = redactionMarks(doc)
    if (marks.length === 0) throw new PdfError('bad-arguments', 'Mark something to redact first.')
    const signed = isSigned(doc)
    const pages = [...new Set(marks.map((m) => m.page))]
    for (const p of pages)
      removeCovered(
        doc,
        p,
        marks.filter((m) => m.page === p).map((m) => m.box)
      )
    // Collected before the marks are applied and taken off the pages; their replies go after.
    const markObjects = redactionMarkObjects(doc, pages)
    const drawn = xobjectsOf(doc, pages)
    for (const p of pages) {
      // MuPDF's rewrite of the page misreads T*, ' and " after a Td and can move text far from the
      // marks: every move is made explicit first (decisions §58).
      try {
        explicitLeading(doc, p)
      } catch {
        // left as it is
      }
      const page = doc.loadPage(p) as mupdf.PDFPage
      try {
        // The removed text's /ActualText and /Alt go with it.
        // A drawing goes when it touches a mark at all, not only when a mark covers it whole: a
        // drawing that reaches past the mark's edge — an outlined word, a signature, a line of a
        // chart — otherwise keeps every one of its drawing instructions in the file, under the
        // painted box, for anyone to read back (§105).
        clearReplacementText(doc, p, () => page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, mupdf.PDFPage.REDACT_TEXT_REMOVE))
      } finally {
        free(page)
      }
    }
    // A reply to a mark goes with the mark (§102): left behind, its /IRT would keep the mark
    // dictionary — the area it covered, and who marked it — in the saved file.
    if (markObjects.length) removeThreads(doc, markObjects)
    // What went may still be named by resources the page shared with others (inherited, shared).
    unlinkRemoved(doc, drawn)
    // The boxes (and labels) are drawn onto the pages themselves, so they cannot be removed.
    const frames = pages.map((p) => pageFrame(doc, p))
    const overlay = await PDFDocument.create()
    const fonts = new FontSet(overlay)
    for (const frame of frames) {
      const sheet = overlay.addPage([frame.width, frame.height])
      for (const m of marks.filter((x) => x.page === frame.index)) {
        const [x0, y0, x1, y1] = m.box
        sheet.drawRectangle({ x: x0, y: frame.height - y1, width: x1 - x0, height: y1 - y0, color: rgb(...options.fill) })
        if (options.label) {
          const h = y1 - y0
          let size = Math.min(12, h * 0.7)
          const width = (await measureLine(fonts, options.label, size, true)).width
          if (width > x1 - x0 - 4) size = Math.max(3, size * ((x1 - x0 - 4) / width))
          const light = options.fill[0] * 0.3 + options.fill[1] * 0.59 + options.fill[2] * 0.11 > 0.55
          await drawLine(fonts, sheet, options.label, { x: (x0 + x1) / 2, y: frame.height - (y0 + y1) / 2, alignX: 0.5, centreY: true }, { size, bold: true, colour: light ? '#000000' : '#ffffff', opacity: 1, rotation: 0 })
        }
      }
    }
    const before = xobjectNames(doc, pages)
    placeOverlay(doc, new Uint8Array(await overlay.save()), frames)
    const after = xobjectNames(doc, pages)
    const overlays = new Map([...after].map(([p, names]) => [p, new Set([...names].filter((n) => !before.get(p)?.has(n)))]))
    if (options.sanitize) sanitize(doc)
    // A removed comment's tag would still write it, its text included, into the file.
    dropRemovedAnnotRefs(doc)
    const out = options.sanitize ? withoutOwnedHiddenData(rewritten(doc), password) : rewritten(doc)
    // Check the saved file: nothing readable is left under any mark.
    const check = openPdf(out, password)
    let leftover = 0
    try {
      leftover = leftoverUnder(check, pages, marks, overlays)
    } finally {
      free(check)
    }
    return { bytes: out, areas: marks.length, pages: pages.length, leftover, signed }
  } finally {
    free(doc)
  }
}

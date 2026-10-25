import { PDFDocument, rgb } from 'pdf-lib'
import { detectDirection } from './bidi'
import { PdfError } from './errors'
import { free, isSigned, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { defaultFieldText } from './passwordfields'
import { contentOf, drawLine, FontSet, measureLine } from './stamp'
import { extractLines } from './text'
import { isIdentity, shownTurn, turnMatrix } from './upright'

/**
 * Filling in PDF forms (AcroForm) (docs/decisions.md §47): text fields, checkboxes, radio
 * buttons, drop-down and list boxes. MuPDF sets the values and draws checkboxes, radios and
 * choices; a text field's look is drawn by us — MuPDF's own drawing cannot shape Arabic
 * (tested: nothing shows) — with the field's size, colour and alignment, and wrapping for a
 * multi-line field.
 */

type Box = [number, number, number, number]

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature'

export interface FormField {
  page: number
  /** Position among the page's widgets; with `page`, names the widget. */
  index: number
  name: string
  kind: FieldKind
  box: Box
  value: string
  /** Checkbox or radio button: this one is on. */
  checked: boolean
  options: string[]
  multiline: boolean
  readOnly: boolean
  required: boolean
  maxLen: number
}

function kindOf(w: mupdf.PDFWidget): FieldKind {
  if (w.isRadioButton()) return 'radio'
  if (w.isCheckbox()) return 'checkbox'
  if (w.isPushButton()) return 'button'
  if (w.isComboBox()) return 'combo'
  if (w.isListBox()) return 'list'
  if (w.isText()) return 'text'
  return w.getFieldType() === 'signature' ? 'signature' : 'text'
}

/** A checkbox or radio button is on when its appearance state is not Off. */
function isOn(w: mupdf.PDFWidget): boolean {
  const as = w.getObject().get('AS')
  return as.isName() && as.asName() !== 'Off'
}

export function formFields(doc: PdfDoc, pageIndex?: number): FormField[] {
  const out: FormField[] = []
  const pages = pageIndex === undefined ? Array.from({ length: doc.countPages() }, (_, i) => i) : [pageIndex]
  for (const p of pages) {
    const page = doc.loadPage(p) as mupdf.PDFPage
    try {
      page.getWidgets().forEach((w, index) => {
        const kind = kindOf(w)
        const flags = w.getFieldFlags()
        const r = w.getRect()
        out.push({
          page: p,
          index,
          name: w.getName(),
          kind,
          box: [r[0], r[1], r[2], r[3]],
          value: kind === 'checkbox' || kind === 'radio' ? '' : w.getValue(),
          checked: kind === 'checkbox' || kind === 'radio' ? isOn(w) : false,
          options: kind === 'combo' || kind === 'list' ? w.getOptions() : [],
          multiline: kind === 'text' && w.isMultiline(),
          readOnly: (flags & mupdf.PDFWidget.FIELD_IS_READ_ONLY) !== 0,
          required: (flags & mupdf.PDFWidget.FIELD_IS_REQUIRED) !== 0,
          maxLen: kind === 'text' ? w.getMaxLen() : 0
        })
      })
    } finally {
      free(page)
    }
  }
  return out
}

/** Font size and colour from the field's default appearance ("/Helv 12 Tf 0 g"); 0 = fit. */
function daOf(w: mupdf.PDFWidget): string {
  return daOfObject(w.getObject())
}

function daOfObject(widget: mupdf.PDFObject): string {
  try {
    const obj = widget.getInheritable('DA')
    return obj.isString() ? obj.asString() : ''
  } catch {
    return ''
  }
}

function appearanceOf(da: string): { size: number; colour: string } {
  const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 0)
  const rgbMatch = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da)
  const grey = /([\d.]+)\s+g\b/.exec(da)
  const c = rgbMatch ? [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])] : grey ? [Number(grey[1]), Number(grey[1]), Number(grey[1])] : [0, 0, 0]
  return { size, colour: `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}` }
}

/** A field flag (/Ff, inherited from the field). */
function fieldFlags(obj: mupdf.PDFObject): number {
  try {
    const ff = obj.getInheritable('Ff')
    return ff.isNumber() ? ff.asNumber() : 0
  } catch {
    return 0
  }
}

const FF_MULTILINE = 1 << 12
const FF_PASSWORD = 1 << 13

const numOf = (o: mupdf.PDFObject): number => (o.isIndirect() ? o.asIndirect() : -1)

/** The field a widget belongs to: itself when it carries the name (/T), or its parent. */
function fieldOf(widget: mupdf.PDFObject): mupdf.PDFObject {
  const parent = widget.get('Parent')
  return widget.get('T').isString() || !parent.isDictionary() ? widget : parent
}

/** The field's fully qualified name: its /T after its ancestors', joined with dots. */
function fullNameOf(field: mupdf.PDFObject): string {
  const parts: string[] = []
  for (let o = field, k = 0; o.isDictionary() && k < 32; o = o.get('Parent'), k++) {
    const t = o.get('T')
    if (t.isString()) parts.unshift(t.asString())
  }
  return parts.join('.')
}

/**
 * Other field dictionaries of the form with `field`'s fully qualified name and type: one field
 * by the standard, written as several by some programs. Bounded, so a looping tree ends.
 */
function twinsOf(doc: PdfDoc, field: mupdf.PDFObject, type: string): mupdf.PDFObject[] {
  const name = fullNameOf(field)
  const self = numOf(field)
  if (!name || self < 0) return []
  const acro = doc.getTrailer().get('Root').get('AcroForm')
  const fields = acro.isDictionary() ? acro.get('Fields') : null
  if (!fields || !fields.isArray()) return []
  const twins: mupdf.PDFObject[] = []
  const seen = new Set<number>()
  const walk = (node: mupdf.PDFObject, depth: number): void => {
    if (depth > 32 || seen.size > 20_000 || !node.isDictionary()) return
    const num = numOf(node)
    if (num >= 0) {
      if (seen.has(num)) return
      seen.add(num)
    }
    const ft = node.getInheritable('FT')
    if (num !== self && num >= 0 && node.get('T').isString() && ft.isName() && ft.asName() === type && fullNameOf(node) === name) twins.push(node)
    const kids = node.get('Kids')
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) walk(kids.get(i), depth + 1)
  }
  for (let i = 0; i < fields.length; i++) walk(fields.get(i), 0)
  return twins
}

/** Every widget of the field `field` (itself when field and widget are one dictionary). */
function widgetsOf(field: mupdf.PDFObject): mupdf.PDFObject[] {
  const kids = field.get('Kids')
  if (!kids.isArray()) return [field]
  const out: mupdf.PDFObject[] = []
  for (let i = 0; i < kids.length; i++) {
    const k = kids.get(i)
    const subtype = k.get('Subtype')
    if (subtype.isName() && subtype.asName() === 'Widget') out.push(k)
    else if (k.get('Kids').isArray()) out.push(...widgetsOf(k))
  }
  return out
}

/**
 * Takes `node` (a field or widget) out of the field tree: out of its parent's /Kids, or out of
 * /AcroForm /Fields (and /CO) at the top. A parent left with no kids goes too.
 */
function unlinkField(doc: PdfDoc, node: mupdf.PDFObject): void {
  const n = numOf(node)
  const drop = (array: mupdf.PDFObject): void => {
    if (!array.isArray()) return
    for (let i = array.length - 1; i >= 0; i--) if (numOf(array.get(i)) === n && n > 0) array.delete(i)
  }
  const parent = node.get('Parent')
  if (parent.isDictionary()) {
    const kids = parent.get('Kids')
    drop(kids)
    if (!kids.isArray() || kids.length === 0) unlinkField(doc, parent)
  } else {
    const acro = doc.getTrailer().get('Root').get('AcroForm')
    if (!acro.isDictionary()) return
    drop(acro.get('Fields'))
  }
  const acro = doc.getTrailer().get('Root').get('AcroForm')
  if (acro.isDictionary()) drop(acro.get('CO'))
}

/**
 * Removes whole fields — every widget of each, from every page, and the field from the form —
 * given any of their widgets (redaction, R2: a field's value is shared by all its widgets, so
 * one widget under a mark takes the field). Returns the widgets' object numbers.
 */
export function removeFieldsOf(doc: PdfDoc, widgets: mupdf.PDFObject[]): Set<number> {
  const removed = new Set<number>()
  const fields = new Map<number, mupdf.PDFObject>()
  for (const w of widgets) {
    const f = fieldOf(w)
    fields.set(numOf(f) > 0 ? numOf(f) : -fields.size - 1, f)
  }
  for (const f of fields.values()) {
    for (const w of widgetsOf(f)) if (numOf(w) > 0) removed.add(numOf(w))
    unlinkField(doc, f)
  }
  if (removed.size === 0) return removed
  for (let p = 0; p < doc.countPages(); p++) {
    const annots = doc.findPage(p).get('Annots')
    if (!annots.isArray()) continue
    for (let i = annots.length - 1; i >= 0; i--) if (removed.has(numOf(annots.get(i)))) annots.delete(i)
  }
  return removed
}

/** Draws a text field's value as its appearance: shaped, aligned as the field says (or by its direction), wrapped if multi-line. */
async function drawTextField(doc: PdfDoc, widget: mupdf.PDFObject, value: string, da: string): Promise<void> {
  const rect = widget.get('Rect')
  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => rect.get(i).asNumber())
  // A password field shows bullets, never the characters (F1).
  if (fieldFlags(widget) & FF_PASSWORD) value = '•'.repeat([...value].length)
  // A field turned by /MK /R (fields on a turned page, as Acrobat makes them) is drawn upright
  // in its own box and turned into /Rect by the appearance's /Matrix.
  const mk = widget.get('MK')
  const r = mk.isDictionary() && mk.get('R').isNumber() ? mk.get('R').asNumber() : 0
  const sideways = Math.abs(Math.round(r / 90)) % 2 === 1
  const width = Math.abs(sideways ? y1! - y0! : x1! - x0!)
  const height = Math.abs(sideways ? x1! - x0! : y1! - y0!)
  const pdf = await PDFDocument.create()
  const sheet = pdf.addPage([width, height])
  const fonts = new FontSet(pdf)
  const { size: asked, colour } = appearanceOf(da)
  // The field's own frame: background and border colours (/MK) and border width (/BS).
  const colourOf = (key: string): [number, number, number] | null => {
    const a = mk.isDictionary() ? mk.get(key) : null
    if (!a || !a.isArray() || a.length === 0) return null
    const v = Array.from({ length: a.length }, (_, i) => a.get(i).asNumber())
    return v.length === 1 ? [v[0]!, v[0]!, v[0]!] : v.length === 3 ? [v[0]!, v[1]!, v[2]!] : v.length === 4 ? [1 - Math.min(1, v[0]! + v[3]!), 1 - Math.min(1, v[1]! + v[3]!), 1 - Math.min(1, v[2]! + v[3]!)] : null
  }
  const background = colourOf('BG')
  const border = colourOf('BC')
  const bs = widget.get('BS')
  const borderWidth = bs.isDictionary() && bs.get('W').isNumber() ? bs.get('W').asNumber() : 1
  if (background) sheet.drawRectangle({ x: 0, y: 0, width, height, color: rgb(...background) })
  if (border && borderWidth > 0) sheet.drawRectangle({ x: borderWidth / 2, y: borderWidth / 2, width: width - borderWidth, height: height - borderWidth, borderColor: rgb(...border), borderWidth })
  const multiline = (fieldFlags(widget) & FF_MULTILINE) !== 0
  // A size the field cannot hold (some tools write one fitted to the empty box) counts as "fit".
  const fits = asked > 0 && (multiline ? asked * 2.4 <= height : asked <= height * 0.9)
  let size = fits ? asked : multiline ? Math.min(11, height / 2.6) : Math.min(12, Math.max(6, height * 0.62))
  const pad = 2 + (border ? borderWidth : 0)
  const q = widget.getInheritable('Q')
  const rtl = detectDirection(value) === 'rtl'
  const align = q.isNumber() ? [0, 0.5, 1][q.asNumber()] ?? 0 : rtl ? 1 : 0
  const lines: string[] = []
  if (multiline) {
    for (const paragraph of value.split(/\r?\n/)) {
      let line = ''
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word
        if (line && (await measureLine(fonts, next, size, false)).width > width - 2 * pad) {
          lines.push(line)
          line = word
        } else line = next
      }
      lines.push(line)
    }
  } else {
    lines.push(value)
    // A single line too long for the field shrinks to fit, as Acrobat's auto size does.
    const needed = (await measureLine(fonts, value, size, false)).width
    if (!fits && needed > width - 2 * pad) size = Math.max(4, size * ((width - 2 * pad) / needed))
  }
  for (const [i, line] of lines.entries()) {
    const baseline = multiline ? height - pad - size * (i * 1.2 + 0.9) : (height - size * 0.7) / 2
    const x = align === 0 ? pad : align === 1 ? width - pad : width / 2
    await drawLine(fonts, sheet, line, { x, y: baseline, alignX: align, centreY: false }, { size, bold: false, colour, opacity: 1, rotation: 0 })
  }
  const overlay = openPdf(new Uint8Array(await pdf.save()))
  try {
    const source = overlay.findPage(0)
    const form = doc.newDictionary()
    form.put('Type', doc.newName('XObject'))
    form.put('Subtype', doc.newName('Form'))
    const bbox = doc.newArray()
    for (const v of [0, 0, width, height]) bbox.push(v)
    form.put('BBox', bbox)
    const matrix = turnMatrix(r)
    if (!isIdentity(matrix)) {
      const m = doc.newArray()
      for (const v of matrix) m.push(v)
      form.put('Matrix', m)
    }
    form.put('Resources', doc.newGraftMap().graftObject(source.get('Resources')))
    const ap = doc.newDictionary()
    ap.put('N', doc.addStream(contentOf(source), form))
    widget.put('AP', ap)
  } finally {
    free(overlay)
  }
}

// --- XFA forms ----------------------------------------------------------------------------

/**
 * Whether the form is (also) written in XFA, Adobe's XML forms:
 * - `hybrid`: XFA beside ordinary AcroForm fields. Acrobat builds the form from the XFA data,
 *   so a value filled in the AcroForm field alone disappears there. When it saves an AcroForm
 *   change to such a form, it drops the XFA; so do we (`dropXfa`).
 * - `dynamic`: XFA only (no fields, or /NeedsRendering): the pages hold only a "please wait"
 *   placeholder that Adobe's readers replace by laying the form out. We cannot show or fill it.
 */
export function xfaKind(doc: PdfDoc): 'dynamic' | 'hybrid' | null {
  try {
    const root = doc.getTrailer().get('Root')
    const acro = root.get('AcroForm')
    if (!acro.isDictionary()) return null
    const xfa = acro.get('XFA')
    if (!xfa.isArray() && !xfa.isStream()) return null
    const fields = acro.get('Fields')
    const needsRendering = root.get('NeedsRendering')
    if ((needsRendering.isBoolean() && needsRendering.asBoolean()) || !fields.isArray() || fields.length === 0) return 'dynamic'
    return 'hybrid'
  } catch {
    return null
  }
}

/** Removes the XFA form (and /NeedsRendering), leaving the AcroForm fields; true if there was one. */
export function dropXfa(doc: PdfDoc): boolean {
  const root = doc.getTrailer().get('Root')
  // A signed form keeps its catalog as signed: changing it could flag the signatures.
  if (!root.isDictionary() || isSigned(doc)) return false
  const acro = root.get('AcroForm')
  const had = acro.isDictionary() && !acro.get('XFA').isNull()
  if (had) acro.delete('XFA')
  if (!root.get('NeedsRendering').isNull()) root.delete('NeedsRendering')
  return had
}

/** A dynamic XFA form has no fields to fill: say so rather than change nothing. */
function refuseDynamicXfa(doc: PdfDoc): void {
  // `key`: the interface's own sentence for it, in the person's language (ApiError.key).
  if (xfaKind(doc) === 'dynamic')
    throw Object.assign(new PdfError('unsupported', 'This is a dynamic XFA form (Adobe LiveCycle). Its pages can only be shown and filled in Adobe Acrobat or Adobe Reader.'), { key: 'xfa.dynamic' })
}

export type FieldValue = { page: number; index: number; value: string | boolean }

export async function fillForm(bytes: Uint8Array, values: FieldValue[], password?: string): Promise<Uint8Array> {
  const doc = openPdf(bytes, password)
  try {
    refuseDynamicXfa(doc)
    const drawn: Array<{ w: mupdf.PDFWidget; value: string; da: string; others: Array<{ obj: mupdf.PDFObject; da: string }> }> = []
    const pages: mupdf.PDFPage[] = []
    try {
      for (const v of values) {
        if (v.page < 0 || v.page >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
        const page = doc.loadPage(v.page) as mupdf.PDFPage
        pages.push(page)
        const w = page.getWidgets()[v.index]
        if (!w) throw new PdfError('bad-arguments', 'That form field is no longer there.')
        if ((w.getFieldFlags() & mupdf.PDFWidget.FIELD_IS_READ_ONLY) !== 0) throw new PdfError('restricted', 'This field is read-only.')
        const kind = kindOf(w)
        if (kind === 'checkbox' || kind === 'radio') {
          if (isOn(w) !== Boolean(v.value)) w.toggle()
        } else if (kind === 'combo' || kind === 'list') {
          w.setChoiceValue(String(v.value))
        } else if (kind === 'text') {
          const max = w.getMaxLen()
          const text = max > 0 ? String(v.value).slice(0, max) : String(v.value)
          // MuPDF writes its own fitted size into /DA; keep the field's setting and put it back.
          const da = daOf(w)
          // The field's other widgets (the same value shown twice, F2) get our drawing too.
          const self = numOf(w.getObject())
          const field = fieldOf(w.getObject())
          const others = widgetsOf(field)
            .filter((o) => numOf(o) !== self)
            .map((obj) => ({ obj, da: daOfObject(obj) }))
          w.setTextValue(text)
          // Fields with the same fully qualified name are one field (PDF 32000 §12.7.3.1).
          // Writers that repeat a name as separate field dictionaries, instead of widgets under
          // one parent, get the value in each of them, drawn in their own widgets; otherwise
          // Acrobat shows whichever /V it reads first and the typed value seems lost.
          for (const twin of twinsOf(doc, field, 'Tx')) {
            twin.put('V', doc.newString(text))
            twin.delete('RV')
            for (const obj of widgetsOf(twin)) others.push({ obj, da: daOfObject(obj) })
          }
          drawn.push({ w, value: text, da, others })
        } else throw new PdfError('unsupported', 'This kind of field cannot be filled in here.')
        w.update()
      }
      // After MuPDF's own update, so it does not draw over ours.
      for (const d of drawn) {
        // Rich text (/RV) would be shown by readers instead of the new value.
        for (let o: mupdf.PDFObject = d.w.getObject(), k = 0; o.isDictionary() && k < 32; o = o.get('Parent'), k++) o.delete('RV')
        const password = (fieldFlags(d.w.getObject()) & FF_PASSWORD) !== 0
        if (isComb(d.w) && !password) continue
        // A password field is drawn from the value the file will hold — its default, or nothing —
        // never from what was typed, so the saved look does not say how long the password was
        // (§99). The value itself is taken out of every password field as the file is written.
        const shown = password ? (defaultFieldText(fieldOf(d.w.getObject())) ?? '') : d.value
        for (const { obj, da } of [{ obj: d.w.getObject(), da: d.da }, ...d.others]) {
          await drawTextField(doc, obj, shown, da)
          if (da && obj.get('DA').isString()) obj.put('DA', doc.newString(da))
        }
      }
    } finally {
      free(...pages)
    }
    // Readers should show our drawing, not make their own.
    const acro = doc.getTrailer().get('Root').get('AcroForm')
    if (acro.isDictionary()) acro.delete('NeedAppearances')
    // A hybrid form's XFA would bring the old values back in Acrobat (see xfaKind).
    // Taking the packet out only unlinks it: a plain save keeps what nothing points at, so the
    // old values would still be in the file for anyone to read back (§100). The file is written
    // again with its unused objects collected whenever a packet went.
    const strippedXfa = dropXfa(doc)
    return saveBytes(doc, strippedXfa ? 'garbage=deduplicate,compress' : undefined)
  } finally {
    free(doc)
  }
}

/** Comb fields (one character per box) keep MuPDF's drawing, which spaces the characters. */
function isComb(w: mupdf.PDFWidget): boolean {
  try {
    return w.isComb()
  } catch {
    return false
  }
}

// --- preparing a form (docs/decisions.md §55) ------------------------------------------------

export type NewFieldKind = 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'

export interface NewField {
  page: number
  /** Page coordinates (top-left, y down). */
  box: Box
  kind: NewFieldKind
  name: string
  /** Drop-down choices. */
  options?: string[]
}

/** The form's shared parts: /AcroForm with /Fields, a default appearance and the Helvetica it names. */
function acroForm(doc: PdfDoc): mupdf.PDFObject {
  const root = doc.getTrailer().get('Root')
  let acro = root.get('AcroForm')
  if (!acro.isDictionary()) {
    acro = doc.addObject(doc.newDictionary())
    root.put('AcroForm', acro)
  }
  if (!acro.get('Fields').isArray()) acro.put('Fields', doc.newArray())
  if (!acro.get('DA').isString()) acro.put('DA', doc.newString('/Helv 0 Tf 0 g'))
  let dr = acro.get('DR')
  if (!dr.isDictionary()) {
    dr = doc.newDictionary()
    acro.put('DR', dr)
  }
  let fonts = dr.get('Font')
  if (!fonts.isDictionary()) {
    fonts = doc.newDictionary()
    dr.put('Font', fonts)
  }
  if (fonts.get('Helv').isNull()) {
    const helv = doc.newDictionary()
    helv.put('Type', doc.newName('Font'))
    helv.put('Subtype', doc.newName('Type1'))
    helv.put('BaseFont', doc.newName('Helvetica'))
    helv.put('Encoding', doc.newName('WinAnsiEncoding'))
    fonts.put('Helv', doc.addObject(helv))
  }
  return acro
}

function existingNames(acro: mupdf.PDFObject): Set<string> {
  const names = new Set<string>()
  const fields = acro.get('Fields')
  for (let i = 0; i < fields.length; i++) {
    const t = fields.get(i).get('T')
    if (t.isString()) names.add(t.asString())
  }
  return names
}

/** Adds fields; each is a field and its widget in one dictionary, drawn by MuPDF (they start empty). */
export function addFormFields(bytes: Uint8Array, fields: NewField[], password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const acro = acroForm(doc)
    const taken = existingNames(acro)
    const unique = (name: string): string => {
      const base = name.trim().replace(/[.()]/g, '') || 'Field'
      let n = base
      for (let k = 2; taken.has(n); k++) n = `${base} ${k}`
      taken.add(n)
      return n
    }
    const pages = new Set<number>()
    for (const f of fields) {
      if (f.page < 0 || f.page >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
      const pageRef = doc.findPage(f.page)
      const page = doc.loadPage(f.page) as mupdf.PDFPage
      const [a, b, c, d, e, g] = page.getTransform()
      const turn = shownTurn(page)
      free(page)
      const det = a * d - b * c
      const toPdf = (x: number, y: number): [number, number] => [(d * (x - e) - c * (y - g)) / det, (-b * (x - e) + a * (y - g)) / det]
      const p0 = toPdf(f.box[0], f.box[3])
      const p1 = toPdf(f.box[2], f.box[1])
      const w = doc.newDictionary()
      w.put('Type', doc.newName('Annot'))
      w.put('Subtype', doc.newName('Widget'))
      w.put('T', doc.newString(unique(f.name)))
      w.put('F', 4)
      const rect = doc.newArray()
      for (const v of [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])]) rect.push(+v.toFixed(2))
      w.put('Rect', rect)
      w.put('P', pageRef)
      const mk = doc.newDictionary()
      const border = doc.newArray()
      for (const v of [0.45, 0.45, 0.45]) border.push(v)
      mk.put('BC', border)
      // On a turned page the field is turned with it, so its text reads upright as shown.
      if (turn) mk.put('R', turn)
      w.put('MK', mk)
      const height = f.box[3] - f.box[1]
      // Text fields take Acrobat's Auto size (0): 12 pt where there is room, smaller in a short
      // box or for a long value, so nothing clips; a size fitted to the empty box did once filled.
      w.put('DA', doc.newString(f.kind === 'text' || f.kind === 'multiline' ? '/Helv 0 Tf 0 g' : `/Helv ${Math.max(6, Math.min(12, Math.round(height * 0.6)))} Tf 0 g`))
      if (f.kind === 'text' || f.kind === 'multiline') {
        w.put('FT', doc.newName('Tx'))
        if (f.kind === 'multiline') w.put('Ff', 4096)
      } else if (f.kind === 'checkbox') {
        w.put('FT', doc.newName('Btn'))
        w.put('V', doc.newName('Off'))
        w.put('AS', doc.newName('Off'))
        mk.put('CA', doc.newString('4'))
      } else if (f.kind === 'dropdown') {
        w.put('FT', doc.newName('Ch'))
        w.put('Ff', 131072)
        const opt = doc.newArray()
        for (const o of f.options ?? []) opt.push(doc.newString(o))
        w.put('Opt', opt)
      } else {
        w.put('FT', doc.newName('Sig'))
      }
      const ref = doc.addObject(w)
      let annots = pageRef.get('Annots')
      if (!annots.isArray()) {
        annots = doc.newArray()
        pageRef.put('Annots', annots)
      }
      annots.push(ref)
      acro.get('Fields').push(ref)
      pages.add(f.page)
    }
    // MuPDF draws the new, empty fields.
    for (const p of pages) {
      const page = doc.loadPage(p) as mupdf.PDFPage
      try {
        for (const w of page.getWidgets()) if (w.getFieldType() !== 'signature') w.update()
      } finally {
        free(page)
      }
    }
    // Acrobat would rebuild a hybrid form from its XFA and lose the new fields (see xfaKind).
    dropXfa(doc)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Removes the field shown as widget `index` of `page`. */
export function removeFormField(bytes: Uint8Array, pageIndex: number, index: number, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const page = doc.loadPage(pageIndex) as mupdf.PDFPage
    try {
      const w = page.getWidgets()[index]
      if (!w) throw new PdfError('bad-arguments', 'That field is no longer there.')
      // Only this widget goes; its field goes with its last widget (a field whose widgets are
      // its kids, as most programs make them, stayed in /Fields before).
      unlinkField(doc, w.getObject())
      page.deleteAnnotation(w)
    } finally {
      free(page)
    }
    dropXfa(doc)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/**
 * Where a flat form wants fields (Acrobat's automatic field detection): lines of underscores
 * or dots (a blank to write on), empty boxes, and small squares (tick boxes). Each is named
 * after the words just before it on its line, or just above it.
 */
export function detectFormFields(doc: PdfDoc, pageIndex: number): NewField[] {
  const out: NewField[] = []
  const lines = extractLines(doc, pageIndex)
  const label = (box: Box): string => {
    const cy = (box[1] + box[3]) / 2
    const same = lines.filter((l) => cy >= l.box[1] - 2 && cy <= l.box[3] + 2)
    let text = ''
    for (const l of same) text += l.glyphs.filter((g) => g.box[2] <= box[0] + 1 && !/[_.…]/.test(g.c)).map((g) => g.c).join('')
    text = text.replace(/[:：_.…]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) {
      const above = lines.filter((l) => l.box[3] <= box[1] + 1 && box[1] - l.box[3] < 24 && l.box[2] > box[0] && l.box[0] < box[2]).sort((a, b) => b.box[3] - a.box[3])[0]
      text = above?.text.replace(/[:：_.…]+/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
    }
    return text.slice(-40) || 'Field'
  }
  /** A tick box's words sit right beside it, on either side: the nearest run of them. */
  const tickLabel = (box: Box): string => {
    const cy = (box[1] + box[3]) / 2
    const near = lines.flatMap((l) => l.glyphs).filter((g) => cy >= g.box[1] - 2 && cy <= g.box[3] + 2)
    const after = near.filter((g) => g.box[0] >= box[2] - 1).sort((a, b) => a.box[0] - b.box[0])
    const before = near.filter((g) => g.box[2] <= box[0] + 1).sort((a, b) => b.box[2] - a.box[2])
    const take = (glyphs: typeof near, edge: number, forward: boolean): string => {
      const out: typeof near = []
      let last = edge
      for (const g of glyphs) {
        const gap = forward ? g.box[0] - last : last - g.box[2]
        if (gap > 14) break
        out.push(g)
        last = forward ? g.box[2] : g.box[0]
      }
      return (forward ? out : out.reverse()).map((g) => g.c).join('').trim()
    }
    const right = take(after, box[2], true)
    const left = take(before, box[0], false)
    const firstRight = after[0] ? after[0].box[0] - box[2] : Infinity
    const firstLeft = before[0] ? box[0] - before[0].box[2] : Infinity
    return (firstRight <= firstLeft ? right || left : left || right).replace(/[:：]+$/, '').slice(0, 40)
  }
  // Blanks drawn with characters: ____ or ....... (at least 5, and 30 points long).
  for (const l of lines) {
    let start = -1
    const flush = (end: number): void => {
      if (start < 0) return
      const run = l.glyphs.slice(start, end)
      if (run.length >= 5) {
        const x0 = Math.min(...run.map((g) => g.box[0]))
        const x1 = Math.max(...run.map((g) => g.box[2]))
        const bottom = Math.max(...run.map((g) => g.box[3]))
        if (x1 - x0 > 30) {
          const box: Box = [x0, bottom - 16, x1, bottom + 1]
          out.push({ page: pageIndex, box, kind: 'text', name: label(box) })
        }
      }
      start = -1
    }
    l.glyphs.forEach((g, i) => {
      if (/[_.…]/.test(g.c)) {
        if (start < 0) start = i
      } else flush(i)
    })
    flush(l.glyphs.length)
  }
  // Boxes and squares drawn with lines.
  const page = doc.loadPage(pageIndex)
  const stext = page.toStructuredText('vectors')
  const rects: Box[] = []
  try {
    stext.walk({
      onVector(bbox: mupdf.Rect, flags: { isStroked: boolean; isRectangle: boolean }) {
        if (flags.isRectangle && flags.isStroked) rects.push([bbox[0], bbox[1], bbox[2], bbox[3]])
      }
    })
  } finally {
    free(stext, page)
  }
  const hasText = (b: Box): boolean =>
    lines.some((l) => l.glyphs.some((g) => (g.box[0] + g.box[2]) / 2 > b[0] && (g.box[0] + g.box[2]) / 2 < b[2] && (g.box[1] + g.box[3]) / 2 > b[1] && (g.box[1] + g.box[3]) / 2 < b[3]))
  for (const r of rects) {
    const w = r[2] - r[0]
    const h = r[3] - r[1]
    if (hasText(r)) continue
    if (w >= 6 && w <= 20 && Math.abs(w - h) < 3) out.push({ page: pageIndex, box: r, kind: 'checkbox', name: tickLabel(r) || label(r) })
    else if (h >= 12 && h <= 40 && w >= 60) out.push({ page: pageIndex, box: [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1], kind: 'text', name: label(r) })
    else if (h > 40 && h <= 200 && w >= 100) out.push({ page: pageIndex, box: [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1], kind: 'multiline', name: label(r) })
  }
  // Not where fields already are, and not twice.
  const existingPage = doc.loadPage(pageIndex) as mupdf.PDFPage
  const existing = existingPage.getWidgets().map((w) => w.getRect() as Box)
  free(existingPage)
  const overlaps = (a: Box, b: Box): boolean => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 2 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 2
  return out.filter((f, i) => !existing.some((e) => overlaps(e, f.box)) && !out.slice(0, i).some((g) => overlaps(g.box, f.box)))
}

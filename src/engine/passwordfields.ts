import type * as mupdf from 'mupdf'
import type { PdfDoc } from './mupdf'

/**
 * A text field with the Password flag must never have its value stored in the file
 * (PDF 32000-2 §12.7.5.3, Table 231, note to the Password flag: a processor is never to store the
 * value of such a field in the PDF file). Acrobat, tested on a form saved with Ctrl+S and with
 * Save As, writes the typed value nowhere: a field with a default value (/DV) is saved holding
 * that default, a field without one is left empty, and the masking characters are drawn from the
 * saved value, so the file does not even say how long the typed password was. /DV and /AA stay.
 *
 * `clearPasswordValues` does the same to the document about to be written, and every save goes
 * through it (`saveBytes`), so no path — filling in a form, Save as, Reduce file size, splitting,
 * combining, signing — can carry a typed password into a file. The value a password field holds
 * may also sit on an ancestor it inherits from or on one of its widgets, so all three are cleared.
 */

const FF_PASSWORD = 1 << 13
const MAX_DEPTH = 64
const MAX_NODES = 20_000

const numOf = (o: mupdf.PDFObject): number => (o.isIndirect() ? o.asIndirect() : -1)

function inheritedName(obj: mupdf.PDFObject, key: string): string | null {
  try {
    const v = obj.getInheritable(key)
    return v.isName() ? v.asName() : null
  } catch {
    return null
  }
}

function inheritedNumber(obj: mupdf.PDFObject, key: string): number {
  try {
    const v = obj.getInheritable(key)
    return v.isNumber() ? v.asNumber() : 0
  } catch {
    return 0
  }
}

/** A text field whose value is a password: /FT Tx and the Password flag, both inheritable. */
function isPasswordText(obj: mupdf.PDFObject): boolean {
  return inheritedName(obj, 'FT') === 'Tx' && (inheritedNumber(obj, 'Ff') & FF_PASSWORD) !== 0
}

/** The field a node belongs to: itself when it carries the name (/T), or its parent. */
function fieldOf(node: mupdf.PDFObject): mupdf.PDFObject {
  const parent = node.get('Parent')
  return node.get('T').isString() || !parent.isDictionary() ? node : parent
}

/** The field's ancestors, nearest first, bounded so a looping /Parent chain ends. */
function ancestorsOf(field: mupdf.PDFObject): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = []
  const seen = new Set<number>()
  for (let o = field.get('Parent'), k = 0; o.isDictionary() && k < MAX_DEPTH; o = o.get('Parent'), k++) {
    const num = numOf(o)
    if (num >= 0) {
      if (seen.has(num)) break
      seen.add(num)
    }
    out.push(o)
  }
  return out
}

/** Every widget of the field (itself when field and widget are one dictionary). */
function widgetsOf(field: mupdf.PDFObject, depth = 0): mupdf.PDFObject[] {
  const kids = field.get('Kids')
  if (!kids.isArray() || depth > MAX_DEPTH) return [field]
  const out: mupdf.PDFObject[] = []
  for (let i = 0; i < kids.length; i++) {
    const k = kids.get(i)
    if (!k.isDictionary()) continue
    const subtype = k.get('Subtype')
    if (subtype.isName() && subtype.asName() === 'Widget') out.push(k)
    else if (k.get('Kids').isArray()) out.push(...widgetsOf(k, depth + 1))
  }
  return out.length > 0 ? out : [field]
}

/** Whether a /V is there at all, readable as text or not (a stream value counts). */
function hasOwnValue(obj: mupdf.PDFObject): boolean {
  if (!obj.isDictionary()) return false
  return !obj.get('V').isNull()
}

/** The text a /V holds, as far as it can be read. */
function textOf(v: mupdf.PDFObject): string {
  if (v.isString()) return v.asString()
  if (v.isName()) return v.asName()
  return ''
}

/** The value a field holds: its own /V, else one inherited from an ancestor, else one on a widget. */
function heldValue(field: mupdf.PDFObject): { present: boolean; fromAncestor: boolean } {
  if (hasOwnValue(field)) return { present: textOf(field.get('V')) !== '', fromAncestor: false }
  for (const a of ancestorsOf(field)) {
    if (hasOwnValue(a)) return { present: textOf(a.get('V')) !== '', fromAncestor: true }
  }
  for (const w of widgetsOf(field)) {
    if (numOf(w) !== numOf(field) && hasOwnValue(w)) return { present: textOf(w.get('V')) !== '', fromAncestor: false }
  }
  return { present: false, fromAncestor: false }
}

/** The field's default value (/DV, inheritable) as text, or null when it has none. */
export function defaultFieldText(field: mupdf.PDFObject): string | null {
  try {
    const dv = field.getInheritable('DV')
    return dv.isNull() ? null : textOf(dv)
  } catch {
    return null
  }
}

/**
 * Every password text field of the form, found the way the fields are listed: the tree under
 * /AcroForm /Fields, and the widgets of every page with the fields above them, so a widget that
 * no /Fields entry reaches is covered too. `stopAtFirst` returns as soon as one holds a value.
 */
function passwordFields(doc: PdfDoc, stopAtFirst: boolean): mupdf.PDFObject[] {
  let acro: mupdf.PDFObject
  try {
    acro = doc.getTrailer().get('Root').get('AcroForm')
  } catch {
    return []
  }
  if (!acro.isDictionary()) return []
  const out: mupdf.PDFObject[] = []
  const seen = new Set<number>()
  const taken = new Set<number>()
  const take = (node: mupdf.PDFObject): boolean => {
    if (!isPasswordText(node)) return false
    const field = fieldOf(node)
    const num = numOf(field)
    if (num >= 0) {
      if (taken.has(num)) return false
      taken.add(num)
    }
    if (!heldValue(field).present) return false
    out.push(field)
    return stopAtFirst
  }
  const walk = (node: mupdf.PDFObject, depth: number): boolean => {
    if (depth > MAX_DEPTH || seen.size > MAX_NODES || !node.isDictionary()) return false
    const num = numOf(node)
    if (num >= 0) {
      if (seen.has(num)) return false
      seen.add(num)
    }
    const kids = node.get('Kids')
    if (kids.isArray()) {
      for (let i = 0; i < kids.length; i++) if (walk(kids.get(i), depth + 1)) return true
      // A merged field and widget carrying its own value is taken too.
    }
    return take(node)
  }
  const fields = acro.get('Fields')
  if (fields.isArray()) {
    for (let i = 0; i < fields.length; i++) if (walk(fields.get(i), 0)) return out
  }
  // Widgets on the pages, as the fields are listed when /Fields is incomplete.
  let pages = 0
  try {
    pages = doc.countPages()
  } catch {
    pages = 0
  }
  for (let p = 0; p < pages; p++) {
    let annots: mupdf.PDFObject
    try {
      annots = doc.findPage(p).get('Annots')
    } catch {
      continue
    }
    if (!annots.isArray()) continue
    for (let i = 0; i < annots.length; i++) {
      const a = annots.get(i)
      if (!a.isDictionary()) continue
      const subtype = a.get('Subtype')
      if (!subtype.isName() || subtype.asName() !== 'Widget') continue
      if (take(a)) return out
    }
  }
  return out
}

/** Whether any password text field of the document holds a value that a save would store. */
export function hasPasswordValues(doc: PdfDoc): boolean {
  return passwordFields(doc, true).length > 0
}

/**
 * Takes the value out of every password text field, as Acrobat does on save: the field is left
 * holding its default value (/DV) or nothing at all, and the same is done to its widgets and to
 * the ancestors only password fields inherit from. Where an ancestor's value has to stay because
 * an ordinary field inherits it too, the field is given an empty value of its own instead, so it
 * no longer inherits the password. Returns how many fields were changed.
 */
export function clearPasswordValues(doc: PdfDoc): number {
  const fields = passwordFields(doc, false)
  let changed = 0
  for (const field of fields) {
    const held = heldValue(field)
    if (!held.present) continue
    const def = defaultFieldText(field)
    let shadow = false
    for (const w of widgetsOf(field)) {
      if (numOf(w) === numOf(field)) continue
      w.delete('V')
      w.delete('RV')
    }
    for (const a of ancestorsOf(field)) {
      if (!hasOwnValue(a)) continue
      if (onlyPasswordFieldsUnder(a)) a.delete('V')
      else shadow = true
    }
    field.delete('RV')
    if (def !== null) field.put('V', doc.newString(def))
    else if (shadow) field.put('V', doc.newString(''))
    else field.delete('V')
    changed++
  }
  return changed
}

/** Whether every field under `node` that could inherit its value is a password text field. */
function onlyPasswordFieldsUnder(node: mupdf.PDFObject, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false
  const kids = node.get('Kids')
  if (!kids.isArray()) return isPasswordText(node)
  let any = false
  for (let i = 0; i < kids.length; i++) {
    const k = kids.get(i)
    if (!k.isDictionary()) continue
    const subtype = k.get('Subtype')
    // A widget of this very field, not a field of its own.
    if (subtype.isName() && subtype.asName() === 'Widget' && !k.get('T').isString()) continue
    any = true
    if (!onlyPasswordFieldsUnder(k, depth + 1)) return false
  }
  return any ? true : isPasswordText(node)
}

import * as mupdf from 'mupdf'
import { PdfError } from './errors'
import { repairLigatures } from './ligatures'

/**
 * The only file that imports MuPDF's document types into the rest of the engine.
 *
 * MuPDF is AGPL. Keeping its use behind this small surface is what keeps the
 * licence decision reversible (docs/decisions.md §4): no MuPDF type should appear
 * in a signature outside `src/engine/` and `src/ops/`.
 */
export { mupdf }
export type PdfDoc = mupdf.PDFDocument

/**
 * MuPDF.js 1.28.1 takes two references on every PDF object it hands out (the wrapping helper
 * keeps it, then the PDFObject constructor keeps it again) but releases one, so every object we
 * ever touched stayed in WASM memory after its document was closed — whole font dictionaries on
 * each opening of a newspaper, until "malloc failed" (decisions §58). The helpers are corrected
 * here, only while the constructor still takes its own reference.
 */
function fixObjectReferences(): void {
  type Proto = { _fromPDFObjectKeep(ptr: number): unknown; _fromPDFObjectNew(ptr: number): unknown }
  const proto = mupdf.PDFDocument.prototype as unknown as Proto
  const Obj = mupdf.PDFObject as unknown as { new (doc: unknown, ptr: number): unknown; Null: unknown; _drop(ptr: number): void }
  const constructorKeeps = /constructor\s*\(\s*doc\s*,\s*pointer\s*\)\s*\{\s*super\(\s*libmupdf\._wasm_pdf_keep_obj\(pointer\)\s*\)/.test(String(mupdf.PDFObject))
  if (!constructorKeeps || typeof proto._fromPDFObjectKeep !== 'function' || typeof Obj._drop !== 'function') return
  if (/keep_obj/.test(String(proto._fromPDFObjectKeep))) {
    // A borrowed pointer: the constructor's reference is the one we own.
    proto._fromPDFObjectKeep = function (this: unknown, ptr: number) {
      return ptr === 0 ? Obj.Null : new Obj(this, ptr)
    }
  }
  if (typeof proto._fromPDFObjectNew === 'function' && !/drop/.test(String(proto._fromPDFObjectNew))) {
    // A new object already owned by us: the constructor's extra reference is given back.
    proto._fromPDFObjectNew = function (this: unknown, ptr: number) {
      if (ptr === 0) return Obj.Null
      const obj = new Obj(this, ptr)
      Obj._drop(ptr)
      return obj
    }
  }
}
fixObjectReferences()

/**
 * Opens PDF bytes. Throws a `PdfError` a person can act on.
 *
 * `password` is either password. A file that opens without one may still carry a
 * permissions password that lifts its restrictions; when one is given it is checked
 * even though opening does not need it, so a wrong one is reported, not ignored.
 */
export function openPdf(bytes: Uint8Array, password?: string): PdfDoc {
  let doc: mupdf.Document
  try {
    doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  } catch (error) {
    throw new PdfError('corrupt', `This file could not be opened as a PDF: ${(error as Error).message}`)
  }
  const pdf = doc.asPDF()
  if (!pdf) throw new PdfError('not-pdf', 'This is not a PDF document.')
  const given = password !== undefined && password !== ''
  // Asked once, before authenticating: MuPDF answers needsPassword() by trying the empty
  // password, which silently drops rights already granted by a permissions password.
  const needs = pdf.needsPassword()
  openPasswordNeeded.set(pdf, needs)
  if (needs) {
    if (!given) throw new PdfError('password-required', 'This PDF is protected by a password.')
    if (!pdf.authenticatePassword(password)) throw new PdfError('wrong-password', 'That password is not correct.')
  } else if (given && isEncrypted(pdf) && !pdf.authenticatePassword(password)) {
    throw new PdfError('wrong-password', 'That password is not correct.')
  }
  // MuPDF "repairs" almost anything, including a text file, into an empty document.
  if (pdf.countPages() === 0) throw new PdfError('corrupt', 'This file has no readable pages.')
  // Ligatures whose text map gives only part of them ("giftshop" read as "gitshop"), §57.
  // A signed file is left untouched: any change would show as a change after signing.
  if (!isSigned(pdf)) {
    try {
      repairLigatures(pdf)
    } catch {
      // a damaged font only keeps its old reading
    }
  }
  return pdf
}

const openPasswordNeeded = new WeakMap<PdfDoc, boolean>()

/**
 * Whether the file needs a password to open at all. Use this, never
 * `doc.needsPassword()` after `openPdf`: that call re-authenticates with an empty
 * password and silently drops the rights a permissions password granted.
 */
export function needsOpenPassword(doc: PdfDoc): boolean {
  return openPasswordNeeded.get(doc) ?? false
}

export function isEncrypted(doc: PdfDoc): boolean {
  return doc.getTrailer().get('Encrypt').isDictionary()
}

/**
 * What the file's author allows, for whoever opened it. MuPDF answers "yes" to
 * everything once the permissions (owner) password has been given.
 */
export interface Rights {
  encrypted: boolean
  /** Opened with the permissions password, or nothing is restricted. */
  full: boolean
  edit: boolean
  assemble: boolean
  annotate: boolean
  forms: boolean
  copy: boolean
  print: boolean
}

export function rightsOf(doc: PdfDoc): Rights {
  const has = (p: mupdf.DocumentPermission): boolean => doc.hasPermission(p)
  const r = { edit: has('edit'), assemble: has('assemble'), annotate: has('annotate'), forms: has('form'), copy: has('copy'), print: has('print') }
  return { encrypted: isEncrypted(doc), full: Object.values(r).every(Boolean), ...r }
}

/** Cheap snapshot, used between edits so undo is fast. */
export const SAVE_SNAPSHOT = 'compress'
/** What "Save" writes: smaller, and safe to open anywhere. */
export const SAVE_FINAL = 'garbage=deduplicate,compress,objstms'

/** The file carries a digital signature (AcroForm SigFlags: SignaturesExist). */
export function isSigned(doc: PdfDoc): boolean {
  try {
    const acro = doc.getTrailer().get('Root').get('AcroForm')
    if (!acro.isDictionary()) return false
    const flags = acro.get('SigFlags')
    return flags.isNumber() && (flags.asNumber() & 1) === 1
  } catch {
    return false
  }
}

export function saveBytes(doc: PdfDoc, options: string = SAVE_SNAPSHOT): Uint8Array {
  // A signed file is only ever appended to (decisions §53): rewriting it — compressing, renumbering,
  // object streams — changes the signed bytes and every signature in it becomes invalid.
  const incremental = isSigned(doc) && doc.canBeSavedIncrementally()
  const buffer = doc.saveToBuffer(incremental ? 'incremental' : options)
  // asUint8Array is a view into WASM memory; copy it, then free the buffer now. Left to the
  // garbage collector, a whole file's worth of WASM memory stays taken per save, and a long
  // session of edits on a newspaper runs MuPDF out of memory ("malloc failed").
  try {
    return new Uint8Array(buffer.asUint8Array())
  } finally {
    free(buffer)
  }
}

/** A blank PDF with no pages, ready for grafting into. */
export function newPdf(): PdfDoc {
  return new mupdf.PDFDocument()
}

/** Releases WASM memory. Safe to call on anything MuPDF handed out. */
export function free(...things: Array<{ destroy?: () => void } | null | undefined>): void {
  for (const thing of things) {
    try {
      thing?.destroy?.()
    } catch {
      /* already freed */
    }
  }
}

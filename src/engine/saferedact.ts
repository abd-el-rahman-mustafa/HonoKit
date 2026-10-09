import { free, mupdf, type PdfDoc } from './mupdf'

/** A rectangle in the page's displayed coordinates (points from the top-left, rotation applied). */
export type RedactBox = [number, number, number, number]

/** What goes under the boxes. Each defaults to being left alone, except text, which is removed. */
export interface RedactWhat {
  /** Pictures under the boxes: left ('keep'), their covered pixels blanked ('pixels'), or removed whole ('remove'). */
  images?: 'keep' | 'pixels' | 'remove'
  /** Drawings: left, removed when the boxes cover them ('covered'), or when they touch them at all ('touched'). */
  lineArt?: 'keep' | 'covered' | 'touched'
  /** Text: removed (the default) or left. */
  text?: 'remove' | 'keep'
  /** Paint black boxes where the content went (default false). */
  blackBoxes?: boolean
}

const IMAGE = { keep: mupdf.PDFPage.REDACT_IMAGE_NONE, pixels: mupdf.PDFPage.REDACT_IMAGE_PIXELS, remove: mupdf.PDFPage.REDACT_IMAGE_REMOVE }
const LINE_ART = { keep: mupdf.PDFPage.REDACT_LINE_ART_NONE, covered: mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, touched: mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED }
const TEXT = { remove: mupdf.PDFPage.REDACT_TEXT_REMOVE, keep: mupdf.PDFPage.REDACT_TEXT_NONE }

/** A Subtype MuPDF does not know, given for a moment to an annotation it must not touch. */
const HELD = 'HonoHeld'

/**
 * Removes what lies under `boxes` on one page with MuPDF's redaction, and nothing else.
 *
 * `page.applyRedactions` applies EVERY Redact annotation on the page — the marks the person has
 * drawn but not applied yet too — and deletes Link and FreeText annotations under the area
 * (measured on MuPDF 1.28.1; highlights, shapes, notes, ink and form fields are kept). An edit,
 * Erase area or a picture removal must change none of them. So the page's /Annots is swapped for
 * an empty array while the removal runs, only the redactions made here are on the page, and the
 * page's own /Annots — the same object, every annotation in the same order — is put back after.
 *
 * A page MuPDF already holds open keeps the annotation list it loaded, whatever /Annots says now.
 * For that case every annotation in that list is renamed to a type MuPDF does not know while the
 * removal runs, and given its own type back after.
 */
export function safeRedact(doc: PdfDoc, pageIndex: number, boxes: RedactBox[], what: RedactWhat = {}): void {
  if (boxes.length === 0) return
  const pageObj = doc.findPage(pageIndex)
  const own = pageObj.get('Annots')
  const hadAnnots = !own.isNull()
  const empty = doc.newArray()
  pageObj.put('Annots', empty)
  const renamed: Array<{ obj: mupdf.PDFObject; subtype: mupdf.PDFObject }> = []
  const handles: Array<{ destroy(): void }> = []
  let page: mupdf.PDFPage | null = null
  try {
    page = doc.loadPage(pageIndex) as mupdf.PDFPage
    for (const annot of page.getAnnotations()) {
      handles.push(annot)
      const obj = annot.getObject()
      renamed.push({ obj, subtype: obj.get('Subtype') })
      const held = doc.newName(HELD)
      obj.put('Subtype', held)
      free(held)
    }
    for (const box of boxes) {
      const mark = page.createAnnotation('Redact')
      handles.push(mark)
      mark.setRect(box)
    }
    page.applyRedactions(what.blackBoxes ?? false, IMAGE[what.images ?? 'keep'], LINE_ART[what.lineArt ?? 'keep'], TEXT[what.text ?? 'remove'])
  } finally {
    for (const { obj, subtype } of renamed) {
      if (subtype.isNull()) obj.delete('Subtype')
      else obj.put('Subtype', subtype)
      free(obj, subtype)
    }
    // Our own Redact annotations are gone with the temporary array (MuPDF deletes them once
    // applied; after a failure they would otherwise stay on the page as marks).
    if (hadAnnots) pageObj.put('Annots', own)
    else pageObj.delete('Annots')
    free(...handles, page, own, empty, pageObj)
  }
}

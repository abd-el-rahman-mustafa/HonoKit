import { readFile } from 'node:fs/promises'
import { OpSchema, type Op, type OpInput, type OpName, type OpResult } from '@shared/ops'
import { compressPdf } from '@engine/compress'
import { addText, eraseArea, formatAllText, replaceText } from '@engine/edit'
import { replaceInText } from '@engine/replace'
import type { StyledSpan } from '@engine/richtext'
import { addDrawnMarkup } from '@engine/drawnMarkup'
import { addFormFields, fillForm, removeFormField } from '@engine/forms'
import { applyRedactions, clearRedactionMarks, markForRedaction, removeRedactionMark } from '@engine/redact'
import { addMarkup, moveMarkup, removeMarkup, reviseMarkup, type Markup } from '@engine/markup'
import { addPicture, changePicture } from '@engine/pictures'
import { PdfError } from '@engine/errors'
import { free, openPdf, rightsOf, saveBytes, SAVE_FINAL, type Rights } from '@engine/mupdf'
import { cropPages, deletePages, duplicatePages, insertBlankPages, insertPdfPages, keepPages, replacePages, rotatePages } from '@engine/pages'
import { protectPdf, unlockPdf } from '@engine/security'
import { addHeaderFooter, addPageNumbers, addWatermark } from '@engine/stamp'

/**
 * Applies one operation to a document. Bytes in, bytes out; nothing stays open.
 *
 * This is the seam the workflow feature will use later (docs/decisions.md §5):
 * a workflow is a list of `Op`s applied in turn. The interface, the batch tools
 * and the tests all call `applyOperation` and nothing deeper.
 */

export interface OpContext {
  /** The open password, or the permissions password of a restricted file. */
  password?: string
  /** 0..1, with an optional short message. */
  progress?: (fraction: number, message?: string) => void
  signal?: AbortSignal
}

/**
 * An error with a sentence of the interface's own (an i18n key and its values), when the code's
 * general sentence would give the wrong reason; the worker passes both on (ApiError.key).
 */
export function withKey(error: PdfError, key: string, values?: Record<string, string | number>): PdfError & { key: string; values?: Record<string, string | number> } {
  return Object.assign(error, { key, ...(values ? { values } : {}) })
}

export function parseOp(input: OpInput | unknown): Op {
  const result = OpSchema.safeParse(input)
  if (!result.success) throw new PdfError('bad-arguments', `Invalid operation: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  return result.data
}

/**
 * What the file's author must allow for each operation (docs/decisions.md §23).
 * Rearranging pages is "assemble"; changing what is on them is "edit"; changing
 * the security itself needs the permissions password, or a file with no restrictions.
 */
const NEEDS: Record<OpName, (r: Rights) => boolean> = {
  rotate: (r) => r.assemble || r.edit,
  delete: (r) => r.assemble || r.edit,
  keep: (r) => r.assemble || r.edit,
  duplicate: (r) => r.assemble || r.edit,
  insertBlank: (r) => r.assemble || r.edit,
  insertPdf: (r) => r.assemble || r.edit,
  replacePages: (r) => r.assemble || r.edit,
  crop: (r) => r.edit,
  watermark: (r) => r.edit,
  pageNumbers: (r) => r.edit,
  headerFooter: (r) => r.edit,
  compress: (r) => r.edit,
  metadata: (r) => r.edit,
  repair: (r) => r.edit,
  protect: (r) => r.full,
  unlock: (r) => r.full,
  replaceText: (r) => r.edit,
  addText: (r) => r.edit,
  erase: (r) => r.edit,
  addPicture: (r) => r.edit,
  changePicture: (r) => r.edit,
  // Markup is commenting: the author's "annotate" right is enough.
  markup: (r) => r.annotate || r.edit,
  changeMarkup: (r) => r.annotate || r.edit,
  redactMark: (r) => r.edit,
  redactApply: (r) => r.edit,
  redactClear: (r) => r.edit,
  redactUnmark: (r) => r.edit,
  // Filling in a form is its own right, as in Acrobat.
  fillForm: (r) => r.forms || r.edit,
  formatText: (r) => r.edit,
  replaceAll: (r) => r.edit,
  // Adding an invisible text layer changes the content: edit.
  ocr: (r) => r.edit,
  // Signing is what the author allows as filling in or signing.
  certSign: (r) => r.forms || r.edit,
  addFields: (r) => r.edit,
  removeField: (r) => r.edit
}

async function pictureBytes(source: { path: string } | { data: string }): Promise<Uint8Array> {
  return 'path' in source ? new Uint8Array(await readFile(source.path)) : new Uint8Array(Buffer.from(source.data, 'base64'))
}

/** The rights the document grants to whoever opens it with `password`. */
export function rightsFor(bytes: Uint8Array, password?: string): Rights {
  const doc = openPdf(bytes, password)
  try {
    return rightsOf(doc)
  } finally {
    free(doc)
  }
}

export function assertAllowed(op: OpName, rights: Rights): void {
  if (!NEEDS[op](rights)) {
    throw new PdfError('restricted', "The author of this PDF does not allow this change. Enter the file's permissions password to make it.")
  }
}

/** Copying or exporting the content (text, page pictures, Office files) needs the author's "copy" right, as in Acrobat. */
export function assertCanCopy(rights: Rights): void {
  if (!rights.copy) {
    throw withKey(new PdfError('restricted', "The author of this PDF does not allow copying its content. Enter the file's permissions password to copy or export it."), 'error.noCopy')
  }
}

export async function applyOperation(bytes: Uint8Array, input: OpInput, ctx: OpContext = {}): Promise<OpResult> {
  const op = parseOp(input)
  if (ctx.signal?.aborted) throw new PdfError('cancelled', 'Cancelled.')
  assertAllowed(op.op, rightsFor(bytes, ctx.password))
  ctx.progress?.(0, op.op)
  const result = await run(bytes, op, ctx.password, ctx.progress)
  ctx.progress?.(1, op.op)
  return result
}

/** Spans from the editor, colours as the engine takes them. */
function spansOf(spans: Array<{ start: number; end: number; style: { colour?: string; [k: string]: unknown } }>): StyledSpan[] {
  return spans.map((s) => {
    const { colour, ...rest } = s.style
    return { start: s.start, end: s.end, style: { ...rest, ...(colour ? { colour: rgbOf(colour) } : {}) } as StyledSpan['style'] }
  })
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

async function run(bytes: Uint8Array, op: Op, password: string | undefined, progress?: OpContext['progress']): Promise<OpResult> {
  switch (op.op) {
    case 'rotate':
      return { bytes: rotatePages(bytes, op.pages, op.angle, password) }
    case 'delete':
      return { bytes: deletePages(bytes, op.pages, password) }
    case 'keep':
      return { bytes: keepPages(bytes, op.pages, password) }
    case 'duplicate':
      return { bytes: duplicatePages(bytes, op.pages, password) }
    case 'insertBlank':
      return { bytes: insertBlankPages(bytes, op.at, op.count, op.width, op.height, password) }
    case 'insertPdf':
      return { bytes: insertPdfPages(bytes, op.at, new Uint8Array(await readFile(op.path)), op.pages, op.password, password) }
    case 'replacePages':
      return { bytes: replacePages(bytes, op.pages, new Uint8Array(await readFile(op.path)), op.from, op.password, password) }
    case 'crop':
      return { bytes: cropPages(bytes, op.pages, op.margins, password) }
    case 'watermark': {
      const image = op.imagePath ? new Uint8Array(await readFile(op.imagePath)) : undefined
      const { bytes: out, dropped } = await addWatermark(bytes, op, image, password)
      return dropped > 0 ? { bytes: out, note: { key: 'note.droppedCharacters', values: { count: dropped } } } : { bytes: out }
    }
    case 'pageNumbers':
      return { bytes: await addPageNumbers(bytes, op, password) }
    case 'headerFooter': {
      const { bytes: out, dropped } = await addHeaderFooter(bytes, op, password)
      return dropped > 0 ? { bytes: out, note: { key: 'note.droppedCharacters', values: { count: dropped } } } : { bytes: out }
    }
    case 'compress': {
      const r = compressPdf(bytes, op.level, password)
      return { bytes: r.bytes, note: { key: 'note.compressed', values: { before: r.before, after: r.after, images: r.imagesRecompressed } } }
    }
    case 'protect':
      return { bytes: protectPdf(bytes, op, password) }
    case 'unlock':
      return { bytes: unlockPdf(bytes, password) }
    case 'metadata': {
      const doc = openPdf(bytes, password)
      try {
        if (op.title !== undefined) doc.setMetaData('info:Title', op.title)
        if (op.author !== undefined) doc.setMetaData('info:Author', op.author)
        if (op.subject !== undefined) doc.setMetaData('info:Subject', op.subject)
        if (op.keywords !== undefined) doc.setMetaData('info:Keywords', op.keywords)
        return { bytes: saveBytes(doc) }
      } finally {
        free(doc)
      }
    }
    case 'replaceText': {
      const { colour: hexColour, ...styleRest } = op.style ?? {}
      const style = { ...styleRest, ...(hexColour ? { colour: rgbOf(hexColour) } : {}) }
      const r = await replaceText(bytes, op.page, op.box, op.text, password, { style, dx: op.dx, dy: op.dy, width: op.width, ...(op.lineHeight ? { lineHeight: op.lineHeight } : {}), ...(op.spans ? { spans: spansOf(op.spans) } : {}) })
      // One note, the most important first.
      if (r.dropped > 0) return { bytes: r.bytes, note: { key: 'note.droppedCharacters', values: { count: r.dropped } } }
      if (r.grew) return { bytes: r.bytes, note: { key: 'note.paragraphLonger' } }
      if (r.unified) return { bytes: r.bytes, note: { key: 'note.stylesUnified' } }
      if (r.font?.kept === 'similar' && r.font.name) return { bytes: r.bytes, note: { key: 'note.fontSimilar', values: { font: r.font.name } } }
      return { bytes: r.bytes }
    }
    case 'addText': {
      const r = await addText(bytes, op.page, op.x, op.y, op.text, { size: op.size, colour: rgbOf(op.colour), bold: op.bold, italic: op.italic, kind: op.kind, ...(op.family ? { family: op.family } : {}), ...(op.underline ? { underline: true } : {}) }, password, {
        ...(op.lineHeight ? { lineHeight: op.lineHeight } : {}),
        width: op.width,
        align: op.align,
        direction: op.direction,
        ...(op.spans ? { spans: spansOf(op.spans) } : {})
      })
      return r.dropped > 0 ? { bytes: r.bytes, note: { key: 'note.droppedCharacters', values: { count: r.dropped } } } : { bytes: r.bytes }
    }
    case 'erase':
      return { bytes: eraseArea(bytes, op.page, op.box, password) }
    case 'addPicture':
      return { bytes: await addPicture(bytes, op.page, op.rect, await pictureBytes(op.source), op.opacity, password) }
    case 'changePicture': {
      const change = op.change.kind === 'replace' ? { kind: 'replace' as const, picture: await pictureBytes(op.change.source) } : op.change
      const r = await changePicture(bytes, op.page, op.box, change, password)
      return r.hole ? { bytes: r.bytes, note: { key: 'note.pictureHole' } } : { bytes: r.bytes }
    }
    case 'markup': {
      const m = op.markup
      const colour = rgbOf(m.colour)
      if (m.kind === 'stamp' || m.kind === 'textbox' || m.kind === 'callout') return { bytes: await addDrawnMarkup(bytes, op.page, { ...m, colour }, password, op.author) }
      const markup: Markup =
        m.kind === 'rect' || m.kind === 'ellipse'
          ? { kind: m.kind, rect: m.rect, width: m.width, ...(m.opacity !== undefined ? { opacity: m.opacity } : {}), colour, fill: m.fill ? rgbOf(m.fill) : null }
          : ({ ...m, colour } as Markup)
      const r = addMarkup(bytes, op.page, markup, password, op.author)
      return r.added ? { bytes: r.bytes } : { bytes, note: { key: 'note.noTextThere' } }
    }
    case 'redactMark':
      return { bytes: markForRedaction(bytes, op.marks, password, op.author) }
    case 'addFields':
      return { bytes: addFormFields(bytes, op.fields, password) }
    case 'removeField':
      return { bytes: removeFormField(bytes, op.page, op.index, password) }
    case 'certSign': {
      const { signWithCertificate } = await import('@engine/sign')
      const p12 = new Uint8Array(await readFile(op.p12Path))
      const signed = await signWithCertificate(bytes, { p12, password: op.password, page: op.page, box: op.box, ...(op.reason ? { reason: op.reason } : {}), ...(op.location ? { location: op.location } : {}), ...(op.picture ? { picture: new Uint8Array(Buffer.from(op.picture, 'base64')) } : {}), labels: op.labels }, password)
      return { bytes: signed, note: { key: 'note.certSigned' } }
    }
    case 'ocr': {
      const { recogniseText } = await import('@engine/ocr')
      const r = await recogniseText(bytes, { ...(op.pages ? { pages: op.pages } : {}), language: op.language, redo: op.redo }, password, progress)
      return { bytes: r.bytes, note: r.pages === 0 ? { key: 'note.ocrNothing' } : { key: 'note.ocr', values: { pages: r.pages, lines: r.lines, skipped: r.skipped } } }
    }
    case 'replaceAll': {
      const r = await replaceInText(bytes, op.find, op.replace, { matchCase: op.matchCase, wholeWords: op.wholeWords }, { ...(op.pages ? { pages: op.pages } : {}), ...(op.only ? { only: op.only } : {}) }, password, (f) => progress?.(f, op.op))
      const values = { count: r.replaced, paragraphs: r.paragraphs, skipped: r.skipped.length, unified: r.unified }
      if (!r.replaced && !r.skipped.length) throw new PdfError('bad-arguments', `"${op.find}" was not found.`)
      if (!r.replaced) {
        // The reason given is the one that held: across a line break, would not fit, or both.
        const wrapped = r.skipped.filter((s) => s.reason === 'wraps').length
        const rest = r.skipped.length - wrapped
        if (!rest)
          throw withKey(new PdfError('edit-unsafe', `Nothing was replaced: ${wrapped === 1 ? 'the match runs' : `all ${wrapped} matches run`} from one line onto the next, which Replace leaves as it is. Change ${wrapped === 1 ? 'it' : 'them'} by hand: Find still lists ${wrapped === 1 ? 'it' : 'them'}.`), 'error.replaceWraps', { count: wrapped })
        if (!wrapped)
          throw withKey(new PdfError('edit-unsafe', `Nothing was replaced: the new words would not fit in their lines, or changing them would move other text (${rest} paragraphs). Change them by hand: Find still lists them.`), 'error.replaceNoFit', { count: rest })
        throw withKey(
          new PdfError('edit-unsafe', `Nothing was replaced: ${wrapped} matches run from one line onto the next, and in ${rest} paragraphs the new words would not fit in their lines or would move other text. Change them by hand: Find still lists them.`),
          'error.replaceMixed',
          { wraps: wrapped, count: rest }
        )
      }
      if (r.skipped.length) return { bytes: r.bytes, note: { key: 'note.replacedSome', values } }
      if (r.unified) return { bytes: r.bytes, note: { key: 'note.replacedUnified', values } }
      return { bytes: r.bytes, note: { key: 'note.replaced', values } }
    }
    case 'formatText': {
      const r = await formatAllText(bytes, op.pages, { ...(op.kind ? { kind: op.kind } : {}), ...(op.family ? { family: op.family } : {}), ...(op.size ? { size: op.size } : {}), ...(op.scale ? { scale: op.scale } : {}), ...(op.colour ? { colour: rgbOf(op.colour) } : {}) }, password)
      return { bytes: r.bytes, note: r.dropped > 0 ? { key: 'note.droppedCharacters', values: { count: r.dropped } } : { key: 'note.formatted', values: { count: r.paragraphs } } }
    }
    case 'fillForm':
      return { bytes: await fillForm(bytes, op.values, password) }
    case 'redactUnmark':
      return { bytes: removeRedactionMark(bytes, op.page, op.box, password) }
    case 'redactClear':
      return { bytes: clearRedactionMarks(bytes, password) }
    case 'redactApply': {
      const r = await applyRedactions(bytes, { fill: rgbOf(op.fill), ...(op.label ? { label: op.label } : {}), sanitize: op.sanitize }, password)
      return { bytes: r.bytes, note: { key: r.leftover > 0 ? 'note.redactLeftover' : r.signed ? 'note.redactedSigned' : 'note.redacted', values: { areas: r.areas, pages: r.pages, leftover: r.leftover } } }
    }
    case 'changeMarkup':
      return {
        bytes:
          op.change.kind === 'delete'
            ? removeMarkup(bytes, op.page, op.index, op.box, password)
            : op.change.kind === 'move'
              ? moveMarkup(bytes, op.page, op.index, op.box, op.change.dx, op.change.dy, password)
              : await reviseMarkup(
                  bytes,
                  op.page,
                  op.index,
                  op.box,
                  { ...(op.change.colour ? { colour: rgbOf(op.change.colour) } : {}), ...(op.change.text !== undefined ? { text: op.change.text } : {}) },
                  password
                )
      }
    case 'repair': {
      const doc = openPdf(bytes, password)
      try {
        const repaired = doc.wasRepaired()
        return { bytes: saveBytes(doc, `${SAVE_FINAL},clean`), note: { key: repaired ? 'note.repaired' : 'note.nothingToRepair' } }
      } finally {
        free(doc)
      }
    }
  }
}

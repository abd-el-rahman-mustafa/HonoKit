import { z } from 'zod'

/**
 * Every operation the engine can apply to a document, as data.
 *
 * One schema serves three jobs: the renderer builds these objects, the main
 * process validates them before they reach the worker (anything crossing a
 * process boundary is untrusted), and a saved workflow is just a list of them.
 * Page numbers are zero-based everywhere below the interface.
 */

const pages = z.array(z.number().int().min(0)).min(1)
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const RotateOp = z.object({
  op: z.literal('rotate'),
  pages,
  angle: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)])
})
export const DeleteOp = z.object({ op: z.literal('delete'), pages })
/** Keep only these pages, in this order (extract, and reorder, are both this). */
export const KeepOp = z.object({ op: z.literal('keep'), pages })
export const DuplicateOp = z.object({ op: z.literal('duplicate'), pages })
export const InsertBlankOp = z.object({
  op: z.literal('insertBlank'),
  at: z.number().int().min(0),
  count: z.number().int().min(1).max(500).default(1),
  /** Points; omitted means "the size of the neighbouring page". */
  width: z.number().min(36).max(14400).optional(),
  height: z.number().min(36).max(14400).optional()
})
export const InsertPdfOp = z.object({
  op: z.literal('insertPdf'),
  at: z.number().int().min(0),
  path: z.string().min(1),
  pages: pages.optional(),
  password: z.string().optional()
})
/** Replace pages (Acrobat's Replace Pages): page `pages[k]` shows page `from[k]` of the PDF at `path`. */
export const ReplacePagesOp = z.object({
  op: z.literal('replacePages'),
  pages,
  path: z.string().min(1),
  /** As many as `pages`; the engine refuses anything else. */
  from: pages,
  password: z.string().optional()
})
export const CropOp = z.object({
  op: z.literal('crop'),
  pages,
  /** Points to cut from each side, measured on the page as displayed. */
  margins: z.object({
    left: z.number().min(0),
    top: z.number().min(0),
    right: z.number().min(0),
    bottom: z.number().min(0)
  })
})

const position = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
])
export type Position = z.infer<typeof position>

export const WatermarkOp = z.object({
  op: z.literal('watermark'),
  /** Which pages, or every page. */
  pages: pages.optional(),
  text: z.string().max(500).optional(),
  /** Path to a PNG/JPEG/other image; used instead of text when set. */
  imagePath: z.string().optional(),
  size: z.number().min(4).max(600).default(64),
  colour: colour.default('#c0392b'),
  opacity: z.number().min(0.02).max(1).default(0.25),
  /** Degrees, counter-clockwise as seen on the page. */
  rotation: z.number().min(-180).max(180).default(45),
  position: position.default('center'),
  bold: z.boolean().default(true),
  /** Image width as a fraction of the page width. */
  imageScale: z.number().min(0.05).max(1).default(0.5)
})

export const PageNumbersOp = z.object({
  op: z.literal('pageNumbers'),
  pages: pages.optional(),
  /** `{n}` is the number, `{N}` the total. */
  template: z.string().min(1).max(100).default('{n}'),
  position: position.default('bottom-center'),
  startAt: z.number().int().min(-9999).max(99999).default(1),
  size: z.number().min(4).max(72).default(11),
  margin: z.number().min(0).max(200).default(28),
  colour: colour.default('#333333'),
  digits: z.enum(['latin', 'arabic-indic']).default('latin')
})

const slotText = z.string().max(300).optional()

/**
 * Acrobat's Add Header and Footer: six boxes (left, centre, right; top and bottom), each a
 * line of text with tokens — {n} page number, {N} last number, {date}, {file}.
 */
export const HeaderFooterOp = z.object({
  op: z.literal('headerFooter'),
  pages: pages.optional(),
  slots: z.object({ topLeft: slotText, topCenter: slotText, topRight: slotText, bottomLeft: slotText, bottomCenter: slotText, bottomRight: slotText }),
  size: z.number().min(4).max(72).default(10),
  bold: z.boolean().default(false),
  colour: colour.default('#333333'),
  /** Distance from the left and right edges, and from the top and bottom edges, in points. */
  marginX: z.number().min(0).max(400).default(51),
  marginY: z.number().min(0).max(400).default(28),
  startAt: z.number().int().min(-9999).max(99999).default(1),
  digits: z.enum(['latin', 'arabic-indic']).default('latin'),
  /** Filled in by the interface, in the person's own date format. */
  date: z.string().max(100).default(''),
  file: z.string().max(300).default('')
})

export const CompressOp = z.object({
  op: z.literal('compress'),
  level: z.enum(['low', 'medium', 'high'])
})
export const ProtectOp = z.object({
  op: z.literal('protect'),
  /** Needed to open the file; empty = anyone opens it and only the permissions password changes it (Acrobat's "Editing"). */
  userPassword: z.string().max(127).default(''),
  ownerPassword: z.string().max(127).optional(),
  allowPrint: z.boolean().default(true),
  allowCopy: z.boolean().default(true),
  allowModify: z.boolean().default(false),
  allowAnnotate: z.boolean().default(true)
})
export const UnlockOp = z.object({ op: z.literal('unlock') })
export const MetadataOp = z.object({
  op: z.literal('metadata'),
  title: z.string().max(1000).optional(),
  author: z.string().max(1000).optional(),
  subject: z.string().max(1000).optional(),
  keywords: z.string().max(2000).optional()
})
export const RepairOp = z.object({ op: z.literal('repair') })

/** A rectangle on the page as displayed: points from the top-left, [x0, y0, x1, y1]. */
const box = z.tuple([z.number(), z.number(), z.number(), z.number()]).refine((b) => b[2] > b[0] && b[3] > b[1], 'empty box')
const page = z.number().int().min(0)

/**
 * A stretch of the text (UTF-16 offsets, end exclusive) in another style than the box (§65):
 * a bold word, a red figure, a larger first word.
 */
const span = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  style: z
    .object({
      bold: z.boolean(),
      italic: z.boolean(),
      underline: z.boolean(),
      colour,
      size: z.number().min(2).max(400),
      family: z.string().min(1).max(200)
    })
    .partial()
})
export type SpanInput = z.input<typeof span>

/**
 * Rewrites the paragraph at `box`; empty text removes it. Optional changes, like the text
 * box of any PDF editor: its style, where it sits (moved by dx, dy points) and how wide
 * its column is.
 */
export const ReplaceTextOp = z.object({
  op: z.literal('replaceText'),
  page,
  box,
  text: z.string().max(20000),
  style: z
    .object({
      size: z.number().min(2).max(400),
      colour,
      bold: z.boolean(),
      italic: z.boolean(),
      kind: z.enum(['sans', 'serif', 'mono']),
      align: z.enum(['start', 'end', 'centre', 'justify']),
      /** Chosen by hand; otherwise the first strong letter decides. */
      direction: z.enum(['rtl', 'ltr']),
      /** A font installed on this PC. */
      family: z.string().min(1).max(200),
      underline: z.boolean()
    })
    .partial()
    .optional(),
  /** Distance between baselines as a multiple of the size. */
  lineHeight: z.number().min(0.8).max(4).optional(),
  dx: z.number().min(-20000).max(20000).default(0),
  dy: z.number().min(-20000).max(20000).default(0),
  /** New column width in points. */
  width: z.number().min(10).max(20000).optional(),
  /** Stretches in other styles, as set in the editor (§65); without them the paragraph's own are kept. */
  spans: z.array(span).max(2000).optional()
})
export const AddTextOp = z.object({
  op: z.literal('addText'),
  page,
  /** Baseline start, displayed points from the top-left; right-to-left text ends here. */
  x: z.number(),
  y: z.number(),
  text: z.string().min(1).max(5000),
  size: z.number().min(2).max(400).default(14),
  colour: colour.default('#000000'),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  kind: z.enum(['sans', 'serif', 'mono']).default('sans'),
  /** A drawn box: the text wraps inside this width. */
  width: z.number().min(10).max(20000).optional(),
  align: z.enum(['start', 'end', 'centre', 'justify']).optional(),
  direction: z.enum(['rtl', 'ltr']).optional(),
  family: z.string().min(1).max(200).optional(),
  underline: z.boolean().optional(),
  lineHeight: z.number().min(0.8).max(4).optional(),
  spans: z.array(span).max(2000).optional()
})
/**
 * Find & Replace (§64): `find` is matched as Find matches it; each paragraph holding it is set
 * again through the checked edit. `only` replaces just the match Find shows at that box.
 */
export const ReplaceAllOp = z.object({
  op: z.literal('replaceAll'),
  find: z.string().min(1).max(500),
  replace: z.string().max(2000),
  matchCase: z.boolean().default(false),
  wholeWords: z.boolean().default(false),
  pages: z.array(page).max(100_000).optional(),
  only: z.object({ page, box }).optional()
})
/** Removes text, pictures and drawings inside `box`, leaving it blank. */
export const EraseOp = z.object({ op: z.literal('erase'), page, box })

/** A picture: a file the person chose, or PNG/JPEG data (a signature drawn in the app), base64. */
const pictureSource = z.union([z.object({ path: z.string().min(1) }), z.object({ data: z.string().min(8).max(30_000_000) })])

export const AddPictureOp = z.object({ op: z.literal('addPicture'), page, rect: box, source: pictureSource, opacity: z.number().min(0.05).max(1).default(1) })
/** Moves or resizes (to `rect`), deletes, or replaces the picture at `box`. */
export const ChangePictureOp = z.object({
  op: z.literal('changePicture'),
  page,
  box,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('move'), rect: box }),
    z.object({ kind: z.literal('delete') }),
    z.object({ kind: z.literal('replace'), source: pictureSource })
  ])
})

const point = z.tuple([z.number(), z.number()])
const strokeWidth = z.number().min(0.25).max(50).default(2)
const opacity = z.number().min(0.05).max(1).optional()

/** Markup as PDF annotations: text markup, pen, shapes and lines (docs/decisions.md §30). */
export const MarkupOp = z.object({
  op: z.literal('markup'),
  page,
  /** The name written on it (Settings → identity). */
  author: z.string().max(120).optional(),
  markup: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['highlight', 'underline', 'strikeout']), from: point, to: point, colour, opacity }),
    z.object({ kind: z.literal('ink'), strokes: z.array(z.array(point).min(1).max(20000)).min(1).max(500), colour, width: strokeWidth, opacity }),
    z.object({ kind: z.enum(['rect', 'ellipse']), rect: box, colour, width: strokeWidth, fill: colour.nullable().optional(), opacity }),
    z.object({ kind: z.enum(['line', 'arrow']), from: point, to: point, colour, width: strokeWidth, opacity }),
    z.object({ kind: z.literal('note'), at: point, text: z.string().max(20000), colour }),
    /** A rubber stamp centred on `at` (docs/decisions.md §44). */
    z.object({ kind: z.literal('stamp'), at: point, label: z.string().min(1).max(60), sub: z.string().max(120).optional(), colour, scale: z.number().min(0.4).max(4).optional() }),
    z.object({ kind: z.literal('textbox'), rect: box, text: z.string().min(1).max(20000), colour, size: z.number().min(4).max(72).default(12) }),
    z.object({ kind: z.literal('callout'), rect: box, to: point, text: z.string().min(1).max(20000), colour, size: z.number().min(4).max(72).default(12) })
  ])
})
/** Deletes, or moves by (dx, dy), the markup shown at `box` as the page's annotation `index`. */
export const ChangeMarkupOp = z.object({
  op: z.literal('changeMarkup'),
  page,
  index: z.number().int().min(0),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('delete') }),
    z.object({ kind: z.literal('move'), dx: z.number().min(-20000).max(20000), dy: z.number().min(-20000).max(20000) }),
    z.object({ kind: z.literal('revise'), colour: colour.optional(), text: z.string().max(20000).optional() })
  ])
})

/** Redaction (docs/decisions.md §46): marks to review, then applied all at once. */
export const RedactMarkOp = z.object({
  op: z.literal('redactMark'),
  author: z.string().max(120).optional(),
  marks: z.array(z.object({ page, box })).min(1).max(5000)
})
export const RedactApplyOp = z.object({
  op: z.literal('redactApply'),
  fill: colour.default('#000000'),
  label: z.string().max(60).optional(),
  sanitize: z.boolean().default(true)
})
export const RedactClearOp = z.object({ op: z.literal('redactClear') })
/** Prepare a form: new fields (docs/decisions.md §55). */
export const AddFieldsOp = z.object({
  op: z.literal('addFields'),
  fields: z
    .array(
      z.object({
        page,
        box,
        kind: z.enum(['text', 'multiline', 'checkbox', 'dropdown', 'signature']),
        name: z.string().min(1).max(120),
        options: z.array(z.string().max(200)).max(200).optional()
      })
    )
    .min(1)
    .max(2000)
})
export const RemoveFieldOp = z.object({ op: z.literal('removeField'), page, index: z.number().int().min(0) })
/** A certificate (digital ID) signature (docs/decisions.md §53). */
export const CertSignOp = z.object({
  op: z.literal('certSign'),
  page,
  box,
  p12Path: z.string().min(1).max(4000),
  password: z.string().max(200),
  reason: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  /** A drawn signature shown beside the name (PNG, base64). */
  picture: z.string().max(10_000_000).optional(),
  labels: z.object({ signedBy: z.string().max(200), date: z.string().max(100) })
})
/** Recognise text (OCR): an invisible text layer on picture-only pages (docs/decisions.md §52). */
export const OcrOp = z.object({
  op: z.literal('ocr'),
  pages: pages.optional(),
  language: z.enum(['auto', 'ar', 'en']).default('auto'),
  redo: z.boolean().default(false)
})
/** All the text of some pages in a new typeface, size or colour (docs/decisions.md §48). */
export const FormatTextOp = z.object({
  op: z.literal('formatText'),
  pages: pages.optional(),
  kind: z.enum(['serif', 'sans', 'mono']).optional(),
  family: z.string().min(1).max(200).optional(),
  size: z.number().min(4).max(200).optional(),
  scale: z.number().min(0.25).max(4).optional(),
  colour: colour.optional()
})
/** Form filling: values for fields named by page and widget index (docs/decisions.md §47). */
export const FillFormOp = z.object({
  op: z.literal('fillForm'),
  values: z.array(z.object({ page, index: z.number().int().min(0), value: z.union([z.string().max(100_000), z.boolean()]) })).min(1).max(5000)
})
export const RedactUnmarkOp = z.object({ op: z.literal('redactUnmark'), page, box })

export const OpSchema = z.discriminatedUnion('op', [
  RotateOp,
  DeleteOp,
  KeepOp,
  DuplicateOp,
  InsertBlankOp,
  InsertPdfOp,
  ReplacePagesOp,
  CropOp,
  WatermarkOp,
  PageNumbersOp,
  HeaderFooterOp,
  CompressOp,
  ProtectOp,
  UnlockOp,
  MetadataOp,
  RepairOp,
  ReplaceTextOp,
  AddTextOp,
  EraseOp,
  AddPictureOp,
  ChangePictureOp,
  MarkupOp,
  ChangeMarkupOp,
  RedactMarkOp,
  RedactApplyOp,
  RedactClearOp,
  RedactUnmarkOp,
  FillFormOp,
  FormatTextOp,
  ReplaceAllOp,
  OcrOp,
  CertSignOp,
  AddFieldsOp,
  RemoveFieldOp
])

/** What a caller writes: defaults not yet filled in. */
export type OpInput = z.input<typeof OpSchema>
/** What the engine receives: defaults filled in. */
export type Op = z.output<typeof OpSchema>
export type OpName = Op['op']

/** Result of one operation, for messages like "saved 3.2 MB". */
export interface OpResult {
  bytes: Uint8Array
  /** A short machine-readable note the interface may turn into a message. */
  note?: { key: string; values?: Record<string, string | number> }
}

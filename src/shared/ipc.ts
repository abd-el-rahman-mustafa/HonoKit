import type { Animate, Destination, Detect, DetectedRegion, ImageFileInfo, ImageJob, ImageMetadata, ImageResult, ImageRunResult, Output } from './imageOps'
import type { OpInput } from './ops'
import type { OpenRequest } from './opening'
import type { RecentKind } from './recent'

/**
 * The contract between the interface and the rest of the application.
 *
 * The renderer can do exactly what `PowerApi` lists and nothing else: it has no
 * Node and no file system (docs/architecture.md). Documents live in the worker
 * process; the renderer holds only `DocInfo` snapshots and asks for page pictures
 * through the `pdfpage:` protocol.
 */

export interface PageSize {
  /** Displayed size in points (rotation applied). */
  width: number
  height: number
}

/** A picture on the Scan board (§61): corners in its upright pixels, clockwise from top-left. */
export type ScanCorners = [[number, number], [number, number], [number, number], [number, number]]
export type ScanMode = 'original' | 'color' | 'gray' | 'bw'

export interface ScanItem {
  path: string
  corners: ScanCorners | null
  mode: ScanMode
  rotate: 0 | 90 | 180 | 270
  /** Scan ID card: which side of the card this picture is. */
  side?: 'front' | 'back'
  /** Scan book (§62): where the fold is, as a share of the straightened width; null: one page. Absent for other tools. */
  split?: number | null
}

export interface PrinterInfo {
  name: string
  displayName: string
  isDefault: boolean
}

export interface PrintOptions {
  printer: string
  copies: number
  /** Page indexes, in the order to print. */
  pages: number[]
  /** Fit each page to its place, shrink only pages too big, print at actual size, or at `scale` %. */
  fit: 'fit' | 'shrink' | 'actual' | 'custom'
  scale: number
  /** Pages on each sheet. */
  perSheet: 1 | 2 | 4 | 6
  orientation: 'auto' | 'portrait' | 'landscape'
  grayscale: boolean
  duplex: 'simplex' | 'longEdge' | 'shortEdge'
  /** Print comments and form fields. */
  annotations: boolean
  /** The paper; 'default' leaves it to the printer. */
  paper: Paper
  /** Hand the job to Windows' own print dialog, for every setting the printer's driver has. */
  system: boolean
}

export type Paper = 'default' | 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5' | 'Tabloid'

export interface DocRights {
  encrypted: boolean
  full: boolean
  edit: boolean
  assemble: boolean
  copy: boolean
  print: boolean
}

export interface DocInfo {
  id: string
  /** File name shown on the tab. */
  name: string
  /** Where it was opened from or last saved to; null for a new, unsaved document. */
  path: string | null
  pages: PageSize[]
  /** Increases with every change; part of every page picture's address. */
  revision: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  rights: DocRights
  /** Needs its open password again to be reopened from disk. */
  hasOpenPassword: boolean
  bytes: number
  meta: { title: string; author: string; subject: string; keywords: string }
  /** An XFA form: `dynamic` cannot be shown or filled here (only its placeholder page shows). */
  xfa?: 'dynamic' | 'hybrid'
}

/** A bookmark (outline entry), nested. */
export interface OutlineItem {
  title: string
  /** The page it goes to (0-based); null when it leads outside this document or nowhere. */
  page: number | null
  /** Where on that page, in points as displayed, when the bookmark says. */
  point?: [number, number]
  /** An address outside the document: shown, not opened. */
  uri?: string
  open: boolean
  children: OutlineItem[]
}

/** A link on a page: to a page of this document, or an outside address (shown, not opened). */
export interface PageLink {
  box: [number, number, number, number]
  page?: number
  point?: [number, number]
  uri?: string
}

export interface OpNote {
  key: string
  values?: Record<string, string | number>
}

export interface ApplyResult {
  doc: DocInfo
  note?: OpNote
}

export interface SearchHit {
  page: number
  boxes: Array<[number, number, number, number]>
}

/** A paragraph as the editor shows it: flowing text, where it is, and how it looks. */
export interface ParagraphInfo {
  text: string
  box: [number, number, number, number]
  lines: Array<[number, number, number, number]>
  rtl: boolean
  size: number
  colour: string
  bold: boolean
  italic: boolean
  kind: 'serif' | 'sans' | 'mono'
  align: 'start' | 'end' | 'centre' | 'justify'
  /** Distance between baselines, points. */
  pitch: number
  /** Some words were in another style (a bold word); retyping makes them uniform. */
  mixed: boolean
  /** Most letters have no meaning in the file (shown as "�"): it cannot be edited as text. */
  unreadable: boolean
  /** The font it is set in, as the PDF names it. */
  font: string
  /** How an edit keeps that font: the same one installed here, the PDF's own copy, or neither (a similar one is used). */
  fontStatus: 'installed' | 'embedded' | 'missing'
  /** Stretches of `text` in another style than the body (a bold word, a red figure), §65. */
  spans: TextSpan[]
}

/** A stretch of text (UTF-16 offsets, end exclusive) in another style than its box (§65). */
export interface TextSpan {
  start: number
  end: number
  style: { bold?: boolean; italic?: boolean; underline?: boolean; colour?: string; size?: number; family?: string }
}

export interface TextSelection {
  text: string
  boxes: Array<[number, number, number, number]>
  from: [number, number]
  to: [number, number]
}

/** A picture on a page, for the editor. */
export interface PictureInfo {
  box: [number, number, number, number]
  /** Size in pixels. */
  pixels: { width: number; height: number }
}

/** A piece of markup (a PDF annotation) on a page. */
export interface FormFieldInfo {
  page: number
  index: number
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature'
  box: [number, number, number, number]
  value: string
  checked: boolean
  options: string[]
  multiline: boolean
  readOnly: boolean
  required: boolean
  maxLen: number
}

/** One step of a batch workflow (docs/decisions.md §54). */
export type BatchStep =
  | { kind: 'compress'; level: 'low' | 'medium' | 'high' }
  | { kind: 'ocr'; language: 'auto' | 'ar' | 'en' }
  | { kind: 'watermark'; text: string }
  | { kind: 'pageNumbers'; template: string }
  | { kind: 'rotate'; angle: 90 | 180 | 270 }
  | { kind: 'protect'; password: string }
  | { kind: 'convert'; format: 'docx' | 'xlsx' | 'pptx' | 'md' | 'txt' }

/** A workflow kept for reuse (passwords are never kept). */
export interface SavedWorkflow {
  name: string
  steps: BatchStep[]
  suffix: string
}

/** One side of a comparison: an open document, a PDF file, or text. */
export type CompareSource = { kind: 'doc'; docId: string } | { kind: 'file'; path: string } | { kind: 'text'; text: string; name: string }

export interface CompareWordInfo {
  text: string
  page?: number
  box?: [number, number, number, number]
  start?: number
  end?: number
}

export interface CompareSide {
  kind: 'pdf' | 'text'
  name: string
  words: CompareWordInfo[]
  /** PDF: page sizes in points. */
  pages?: Array<{ width: number; height: number }>
  /** Text: the text itself. */
  text?: string
}

export interface CompareResult {
  /** Names the comparison for its page pictures; closed with compareClose. */
  token: string
  a: CompareSide
  b: CompareSide
  changes: Array<{ kind: 'insert' | 'delete' | 'replace'; a: [number, number]; b: [number, number] }>
}

export interface CompareOptions {
  ignoreMarks: boolean
  ignorePunctuation: boolean
  sameDigits: boolean
}

export interface MarkupInfo {
  /** Position among the page's annotations; with `box`, identifies it. */
  index: number
  kind: 'highlight' | 'underline' | 'strikeout' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'note' | 'stamp' | 'textbox' | 'callout' | 'other'
  box: [number, number, number, number]
  colour: string
  movable: boolean
  text: string
  author: string
  modified: number
  /** The annotation's object number (0 when it has none). */
  id: number
  /** A reply: the `id` of the comment it answers, which may be on another page (§82). */
  replyTo?: number
  /** A review state set on that comment (Accepted, Rejected, Cancelled, Completed…). */
  state?: string
}

/** A picture file the person chose, to place: its size and a small preview. */
export interface PictureFile {
  path: string
  width: number
  height: number
  /** A small preview as a data: URL. */
  preview: string
  /** Degrees the picture is turned to show it upright (its EXIF orientation), already applied to width and height. */
  turn?: 0 | 90 | 180 | 270
}

export interface TextLineInfo {
  text: string
  /** Displayed page points, top-left origin. */
  box: [number, number, number, number]
}

/** A code the interface turns into a sentence in the person's language. */
export type ErrorCode =
  | 'not-pdf'
  | 'password-required'
  | 'wrong-password'
  | 'restricted'
  | 'corrupt'
  | 'bad-arguments'
  | 'unsupported'
  | 'edit-unsafe'
  | 'signed'
  | 'cancelled'
  | 'io'
  | 'internal'

export interface ApiError {
  code: ErrorCode
  message: string
  /** A sentence of the interface's own, more precise than the code's (with its values). */
  key?: string
  values?: Record<string, string | number>
}

/** Every call resolves to one of these, so errors cross the process boundary intact. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export type Theme = 'system' | 'light' | 'dark'
export type Language = 'en' | 'ar'

/** A signature kept for reuse: a transparent PNG, base64, and its size in pixels. */
export interface SavedSignature {
  id: string
  data: string
  width: number
  height: number
}

export interface Settings {
  /** Batch workflows kept for reuse. */
  workflows?: SavedWorkflow[]
  /** The digital ID last used to sign (a path; the password is never kept). */
  digitalId?: string
  language: Language
  theme: Theme
  checkForUpdates: boolean
  recent: string[]
  /** Home › Recent's tab, kept across launches (§83). */
  recentTab: RecentKind
  /** Kept on this computer only, in the settings file; never sent anywhere. */
  signatures: SavedSignature[]
  /** Quick tools the person removed from the floating bar. */
  quickHidden: string[]
  /** Single keys choose tools (V, E, U, D…), as Acrobat's optional accelerators. */
  singleKeys: boolean
  /** What Save does to a file opened from disk: write a copy beside it (default), or replace it. */
  saveMode: 'copy' | 'replace'
  /** Where copies go: '' = next to the original; otherwise this folder. */
  saveFolder: string
  /** The name written on comments and marks (Acrobat's Identity); '' = the Windows user name. */
  authorName: string
  /** Folders the person linked: a cloud drive's synced folder, a network share, any folder. */
  places: Array<{ path: string; label: string }>
  /** How documents open. */
  defaultZoom: 'width' | 'page' | '100'
  /** Misspelled words are underlined while editing text (§67). */
  spellCheck: boolean
  /** Sites whose links open without asking ("Always allow", §81). */
  trustedLinkHosts: string[]
}

/** A storage place shown on Home: found on this PC (OneDrive, Google Drive…) or linked by hand. */
export interface Place {
  path: string
  label: string
  kind: 'onedrive' | 'google' | 'dropbox' | 'icloud' | 'documents' | 'desktop' | 'downloads' | 'folder'
  /** Found automatically (not removable, only hideable). */
  detected: boolean
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; version: string }
  | { state: 'available'; version: string; canInstall: boolean }
  | { state: 'downloading'; percent: number; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'disabled' }

export interface Progress {
  task: string
  fraction: number
  message?: string
}

export interface ShareFile {
  path: string
  /** A copy with unsaved changes, rather than the file itself. */
  temporary: boolean
  bytes: number
  /** How "Email as attachment" will work on this PC. */
  mail: 'outlook' | 'thunderbird' | 'sheet' | 'none'
}

export type ShareOutcome = 'done' | 'canceled' | 'fallback' | 'failed'

export interface ImagesToPdfOptions {
  paper: 'fit' | 'a4' | 'letter'
  margin: number
  autoOrientation: boolean
  orientation?: 'auto' | 'portrait' | 'landscape'
  /** Degrees clockwise per picture. */
  rotations?: number[]
}

export type MergeItem = { path: string; password?: string } | { docId: string }

export interface PowerApi {
  version: string
  platform: string
  /** The computer's system, as a problem report names it (systemLabel in shared/brand.ts). */
  system: string

  // documents
  open(path: string, password?: string): Promise<Result<DocInfo>>
  close(id: string): Promise<Result<void>>
  /** A file's first page as a small picture, and its page count, without opening it. */
  fileThumbnail(path: string, width: number): Promise<Result<{ pages: number; image: { data: Uint8Array; mime: string; width: number; height: number } | null; locked: boolean }>>
  apply(id: string, op: OpInput): Promise<Result<ApplyResult>>
  undo(id: string): Promise<Result<DocInfo>>
  redo(id: string): Promise<Result<DocInfo>>
  /** Saves to `path`, or to the document's own path when omitted. */
  save(id: string, path?: string): Promise<Result<DocInfo>>
  /** Readies the document for sharing: its file, or a copy with the unsaved changes. */
  shareFile(id: string): Promise<Result<ShareFile>>
  /** Shares a file readied by shareFile. `at` is the Share button's centre, in window pixels. */
  shareAction(path: string, action: 'sheet' | 'email' | 'copy' | 'folder', at?: { x: number; y: number }): Promise<ShareOutcome>
  /** Starts dragging a readied file out of the window (into an email, a chat, a folder). */
  startDragOut(path: string): void
  /** Gives the permissions password of a restricted document for this session. */
  authorize(id: string, password: string): Promise<Result<DocInfo>>
  /** Finds a phrase (Arabic letter forms folded; case folded unless asked; whole words if asked). */
  search(id: string, query: string, options?: { matchCase?: boolean; wholeWords?: boolean }): Promise<Result<SearchHit[]>>
  pageText(id: string, page: number): Promise<Result<TextLineInfo[]>>
  /** The text between two points of a page, as a text selection (unit: drag, double or triple click). */
  selectText(id: string, page: number, from: [number, number], to: [number, number], unit: 'char' | 'word' | 'line' | 'page'): Promise<Result<TextSelection | null>>
  /** Puts text on the clipboard. */
  copyText(text: string): Promise<void>
  /** The misspelled words of a text, as [start, end) offsets (§67); empty when spell check is off. */
  spellCheck(text: string): Promise<Array<[number, number]>>
  /** Corrections for a misspelled word, best first. */
  spellSuggest(word: string): Promise<string[]>
  /** Adds a word to the person's dictionary (kept on this PC). */
  spellAdd(word: string): Promise<void>
  /** The paragraphs of a page, for the text editor. */
  pageParagraphs(id: string, page: number): Promise<Result<ParagraphInfo[]>>
  /** The font faces of a family that the page carries (usable files), as data URLs: typing shows in them (§66). */
  paragraphFonts(id: string, page: number, family: string): Promise<Result<{ installed: string | null; faces: Array<{ bold: boolean; italic: boolean; url: string }> }>>
  /** The pictures of a page, for the editor. */
  pagePictures(id: string, page: number): Promise<Result<PictureInfo[]>>
  /** The font families installed on this PC that can be put in a PDF. */
  systemFonts(): Promise<Result<string[]>>
  /** How far the page's content sits from each edge, in points (Crop's Trim white margins). */
  whiteMargins(id: string, page: number): Promise<Result<{ left: number; top: number; right: number; bottom: number }>>
  /** The markup (annotations) of a page. */
  pageMarkups(id: string, page: number): Promise<Result<MarkupInfo[]>>
  /** The document's bookmarks, nested (read only). */
  outline(id: string): Promise<Result<OutlineItem[]>>
  /** The links of a page. */
  pageLinks(id: string, page: number): Promise<Result<PageLink[]>>
  /** Size and a preview of a picture file, to place it; null if it cannot be read. */
  pictureInfo(path: string): Promise<PictureFile | null>

  // tools that make new documents or files
  extract(id: string, pages: number[]): Promise<Result<DocInfo>>
  merge(items: MergeItem[]): Promise<Result<DocInfo>>
  imagesToPdf(paths: string[], options: ImagesToPdfOptions): Promise<Result<DocInfo>>
  /** A picture for the Scan board: its upright size, the page found in it, and a preview (data URL). */
  /** For a book (§62), also where the fold is (null: the picture is one page). */
  scanDetect(path: string, book?: boolean): Promise<Result<{ width: number; height: number; corners: ScanCorners | null; preview: string; split?: number | null }>>
  /** Where a book's fold is once straightened with the item's corners and turn. */
  scanFold(item: ScanItem): Promise<Result<number | null>>
  /** How a picture comes out, straightened and cleaned, as small previews (data URLs): one page, or a spread's two. */
  scanPreview(item: ScanItem): Promise<Result<string[]>>
  /** PDFs' pages as pictures for the Scan board (a scanned book's spreads, §62); their paths. */
  scanPdfPictures(paths: string[]): Promise<Result<string[]>>
  /** Straightened, cleaned pictures as a new PDF: one per page (A4/Letter, or each its own size), a book's pages (in reading order: `rtl` starts each spread on the right), or an ID card's two sides on one A4 page. */
  scanToPdf(items: ScanItem[], goal: 'pages' | 'idcard' | 'book', paper: 'a4' | 'letter' | 'fit', rtl?: boolean): Promise<Result<DocInfo>>
  /** Scans a page with Windows' own scanner window; the picture's path, or null when cancelled. */
  scannerAcquire(): Promise<Result<string | null>>
  /** Create › Blank document: `count` empty pages of `width` × `height` points. */
  newBlank(width: number, height: number, count: number, name: string): Promise<Result<DocInfo>>
  /** Create › from a template: a new untitled document with the template's pages. */
  newFromTemplate(path: string, name: string): Promise<Result<DocInfo>>
  /** The person's own templates (PDFs kept in the app's templates folder). */
  templates(): Promise<Array<{ name: string; path: string }>>
  /** Asks for PDFs and keeps copies of them as templates. */
  addTemplates(): Promise<Array<{ name: string; path: string }>>
  removeTemplate(path: string): Promise<Array<{ name: string; path: string }>>
  split(id: string, ranges: Array<[number, number]>, folder: string): Promise<Result<string[]>>
  exportImages(id: string, pages: number[] | null, format: 'png' | 'jpeg', dpi: number, folder: string): Promise<Result<string[]>>
  /** The printers Windows knows. */
  printers(): Promise<Result<PrinterInfo[]>>
  /** Prints the chosen pages (§60); `sizes` are their displayed sizes in points. */
  printDoc(id: string, options: PrintOptions, sizes: Array<[number, number]>): Promise<Result<boolean>>
  /** Opens a printer's own preferences window (Windows). */
  printerPreferences(name: string): Promise<Result<boolean>>
  /** Opens Windows Settings → Printers & scanners. */
  printerSettings(): Promise<Result<boolean>>
  /** Runs a batch workflow over PDF files; each result is a new file, or why it failed. */
  runBatch(files: string[], steps: BatchStep[], output: { folder: string | null; suffix: string }): Promise<Result<Array<{ input: string; output?: string; error?: string }>>>
  /** The PDFs directly inside a folder. */
  pdfsIn(folder: string): Promise<string[]>
  /** Where a flat form wants fields (Prepare a form › Detect fields). */
  detectFields(id: string, page: number): Promise<Result<Array<{ page: number; box: [number, number, number, number]; kind: 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'; name: string }>>>
  /** The document's certificate signatures, checked. */
  signatures(id: string): Promise<Result<Array<{ signer: string; name: string; reason: string; date: string; valid: boolean; modifiedAfter: boolean; selfSigned: boolean; problem?: string }>>>
  /** Asks for a digital ID file (.pfx, .p12); null if cancelled. */
  pickDigitalId(): Promise<string | null>
  /** Makes a new self-signed digital ID and asks where to keep it; its path, or null. */
  createDigitalId(details: { name: string; email: string; organisation: string; password: string }): Promise<string | null>
  /** The fonts the document uses, and whether each is embedded, reusable, installed here. */
  documentFonts(id: string): Promise<Result<Array<{ name: string; family: string; embedded: boolean; subset: boolean; reusable: boolean; installed: string | null }>>>
  /** Opens a web search for a font's name in the person's browser (Find this font). */
  findFont(name: string): Promise<void>
  /** The form fields of a page (all pages without `page`). */
  formFields(id: string, page?: number): Promise<Result<FormFieldInfo[]>>
  /** Finds words or patterns to redact (Redact › Find text). */
  redactFind(id: string, query: { words: string[]; patterns: Array<'email' | 'phone' | 'emiratesId' | 'iban' | 'card' | 'date'>; wholeWords: boolean }): Promise<Result<Array<{ page: number; boxes: Array<[number, number, number, number]>; text: string; context: string }>>>
  /** The redaction marks waiting to be applied. */
  redactMarks(id: string): Promise<Result<Array<{ page: number; box: [number, number, number, number] }>>>
  /** Create PDF: Word, Excel, PowerPoint, web pages and text files as new PDFs (combined into one if asked). */
  createPdf(paths: string[], combine: boolean): Promise<Result<{ docs: DocInfo[]; methods: Array<'office' | 'libreoffice' | 'built-in' | 'browser'>; notes?: string[] }>>
  /** Which converters this PC has, for Create PDF's note. */
  officeApps(): Promise<{ word: boolean; excel: boolean; powerpoint: boolean; libreoffice: boolean }>
  /** Asks for files Create PDF can convert. */
  /** Files Create PDF can convert; `kind` puts that type's filter first (Word/Excel/PowerPoint to PDF). */
  pickConvertible(kind?: 'word' | 'excel' | 'powerpoint'): Promise<string[]>
  /** Asks where to save a converted file; the extension follows the format. */
  pickExportPath(suggestedName: string, format: 'docx' | 'pptx' | 'xlsx' | 'md' | 'txt'): Promise<string | null>
  /** PDF → Word / PowerPoint / Markdown / text, written to `path` (Markdown's pictures in a folder beside it). */
  exportOffice(id: string, options: { format: 'docx' | 'pptx' | 'xlsx' | 'md' | 'txt'; pages: number[] | null; pageBreaks: boolean; removeTatweel: boolean; digits: 'keep' | 'western' | 'arabic'; sheets?: 'page' | 'tables' }, path: string): Promise<Result<{ path: string; pages: number; paragraphs: number; tables: number; pictures: number }>>
  /** Opens a file this session converted, in the app Windows uses for it. */
  openConverted(path: string): Promise<void>
  /** Compares two documents or texts word by word. */
  compare(a: CompareSource, b: CompareSource, options: CompareOptions): Promise<Result<CompareResult>>
  /** A page of one side of a comparison, as a picture. */
  comparePage(token: string, side: 'a' | 'b', page: number, scale: number): Promise<Result<{ data: Uint8Array; mime: string; width: number; height: number }>>
  compareClose(token: string): Promise<void>
  /** Asks for a text file (.txt, .md, .csv) and reads it; null if cancelled. */
  pickTextFile(): Promise<{ name: string; text: string } | null>
  /** One page as it would look after `op` (a page tool), without changing the document. */
  preview(id: string, op: OpInput, page: number, scale: number): Promise<Result<{ data: Uint8Array; mime: string; width: number; height: number }>>

  // image tools (decisions §69): one file per call, so the board shows each file's progress
  /** A picture's facts and a preview (320 px, or `size` up to 2400), for any format (HEIC, RAW, PSD …). */
  imageDescribe(path: string, size?: number): Promise<Result<ImageFileInfo>>
  imageMetadata(path: string): Promise<Result<ImageMetadata>>
  /**
   * Runs a tool's job on one picture and writes the result; never overwrites a file of the person's.
   * `replacing`: this session's earlier result for it ("Try again", decisions §77), replaced by the new one.
   */
  imageRun(path: string, job: ImageJob, destination: Destination, replacing?: string | null): Promise<Result<ImageRunResult>>
  /** Several pictures as one animation, named `name` + the destination's suffix. */
  imageAnimate(paths: string[], options: Animate, destination: Destination, name: string, replacing?: string | null): Promise<Result<ImageRunResult>>
  /** Every frame of an animation as PNG files, in a new folder. */
  imageFrames(path: string, destination: Destination): Promise<Result<ImageResult[]>>
  /** Faces and licence plates found by the offline models (Blur faces). */
  imageDetect(path: string, what: Detect): Promise<Result<DetectedRegion[]>>
  /** A picture's first frame, upright, as PNG bytes, for the Photo editor. */
  imageDecode(path: string): Promise<Result<{ data: Uint8Array; width: number; height: number }>>
  /** Writes the Photo editor's result (PNG bytes) in the chosen format; never overwrites. */
  imageSaveEdited(png: Uint8Array, path: string, output: Output, destination: Destination, replacing?: string | null): Promise<Result<ImageRunResult>>
  /** The picture viewer (§75): every picture in the same folder, in Explorer's order, for previous and next. */
  picturesBeside(path: string): Promise<string[]>
  /** Adds a picture opened in the viewer to the Recent list. */
  rememberPicture(path: string): Promise<Settings>
  /** Readies a picture for the Share menu (the file itself). */
  sharePicture(path: string): Promise<Result<ShareFile>>

  // the operating system
  pickPdfs(multiple: boolean): Promise<string[]>
  /** Open…: PDFs and pictures together (§75). */
  pickOpenable(): Promise<string[]>
  /** Pictures of every format the image tools read. */
  pickAnyImages(): Promise<string[]>
  /** Pictures to add; with `pdf`, PDFs may be picked too (Scan book). */
  pickImages(pdf?: boolean): Promise<string[]>
  pickSavePath(suggestedName: string): Promise<string | null>
  pickFolder(): Promise<string | null>
  /** The path of a file dropped onto the window. */
  pathForFile(file: File): string
  showInFolder(path: string): Promise<void>
  /** Size and last change of files (the recent list); null when a file is gone. */
  fileInfo(paths: string[]): Promise<Array<{ path: string; size: number | null; modified: number | null }>>
  openExternal(url: string): Promise<void>
  /** Opens a web or email link from a document, after the window has asked (§81); false when refused. */
  openLink(url: string): Promise<boolean>

  // settings, updates, lifecycle
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Omit<Settings, 'recent'>>): Promise<Settings>
  /** Forgets one recent file, every recent file of a kind (Clear on that tab), or all. */
  forgetRecent(path?: string, kind?: RecentKind): Promise<Settings>
  /** Storage places: cloud drives' folders on this PC, the usual folders, and linked folders. */
  places(): Promise<Place[]>
  /** The subfolders, PDFs and pictures of a folder. */
  listFolder(path: string): Promise<Array<{ name: string; path: string; folder: boolean; size: number; modified: number }>>
  /** A free "name (edited).pdf" path for a copy, beside the original or in `folder`. */
  copyPath(original: string, folder?: string): Promise<string>
  /** Closes the window after the app's own "unsaved changes" dialog said it may. */
  quit(): Promise<void>
  /** The window is closing with unsaved documents: ask the person. */
  onConfirmQuit(listener: () => void): () => void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  /** Tells the main process how many documents have unsaved changes, and how to ask about them. */
  setUnsaved(count: number, prompt: { title: string; message: string; discard: string; cancel: string }): void

  onProgress(listener: (p: Progress | null) => void): () => void
  onUpdate(listener: (u: UpdateState) => void): () => void
  /** Files the operating system asks us to open (double-click, "Open with", "Edit with HonoKit", a second launch). */
  onOpenFiles(listener: (requests: OpenRequest[]) => void): () => void
  /** The document engine crashed and was restarted: every open document is gone. */
  onEngineRestarted(listener: () => void): () => void
}

/**
 * The address of one rendered page. Scale is pixels per point, rounded by the caller. With `size`
 * (pixels wide and high), the picture is exactly that size, to map pixel for pixel onto the screen
 * (decisions §82); the size is part of the address, so with the revision an address
 * still never stands for two different pictures (§25).
 */
export function pageUrl(docId: string, revision: number, page: number, scale: number, size?: [number, number]): string {
  const base = `pdfpage://doc/${encodeURIComponent(docId)}/${revision}/${page}/${scale.toFixed(3)}`
  return size ? `${base}/${Math.round(size[0])}x${Math.round(size[1])}` : base
}

export interface PageAddress {
  docId: string
  revision: number
  page: number
  scale: number
  size?: [number, number]
}

/** Reads a `pageUrl` address's path ("/<id>/<revision>/<page>/<scale>[/<w>x<h>]"); null when it is not one. */
export function pageAddress(pathname: string): PageAddress | null {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const [docId, revision, page, scale, size] = parts
  if (!docId || parts.length < 4 || parts.length > 5) return null
  const out: PageAddress = { docId, revision: Number(revision), page: Number(page), scale: Number(scale) }
  if (![out.revision, out.page, out.scale].every(Number.isFinite)) return null
  if (size !== undefined) {
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(size)
    if (!m) return null
    out.size = [Number(m[1]), Number(m[2])]
  }
  return out
}

export const IPC = {
  call: 'powerpdf:call',
  progress: 'powerpdf:progress',
  update: 'powerpdf:update',
  openFiles: 'powerpdf:open-files',
  unsaved: 'powerpdf:unsaved',
  engine: 'powerpdf:engine',
  dragOut: 'powerpdf:drag-out',
  confirmQuit: 'powerpdf:confirm-quit'
} as const

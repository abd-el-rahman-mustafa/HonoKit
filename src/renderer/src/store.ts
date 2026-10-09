import { create } from 'zustand'
import type { ApiError, ApplyResult, DocInfo, OpNote, Progress, Result, SearchHit, Settings, TextSelection, UpdateState } from '@shared/ipc'
import type { OpInput } from '@shared/ops'
import { fileKind, type OpenRequest } from '@shared/opening'
import { errorKey, formatBytes, hasKey, translate, translateCount, type CountKey, type Key } from './i18n'
import { MAX_TRUSTED_HOSTS, safeLink, type SafeLink } from '@shared/links'
import { beforeWindowCloses, PendingTyping, unsavedIds } from '@shared/typing'

/**
 * Everything the interface remembers, and every action that talks to the rest of the
 * application. Components read slices of this and call its actions; none of them
 * calls `window.api` for anything that changes a document.
 */

export type ToolId =
  | 'edit'
  | 'comment'
  | 'sign'
  | 'organize'
  | 'rotate'
  | 'watermark'
  | 'pageNumbers'
  | 'headerFooter'
  | 'compare'
  | 'redact'
  | 'formatText'
  | 'convert'
  | 'toWord'
  | 'toPowerPoint'
  | 'toMarkdown'
  | 'toText'
  | 'toExcel'
  | 'createPdf'
  | 'wordToPdf'
  | 'excelToPdf'
  | 'pptToPdf'
  | 'ocr'
  | 'batch'
  | 'prepareForm'
  | 'compress'
  | 'crop'
  | 'protect'
  | 'unlock'
  | 'metadata'
  | 'split'
  | 'toImages'
  | 'merge'
  | 'imagesToPdf'
  | 'scanDocuments'
  | 'scanIdCard'
  | 'scanBook'
  | 'imageToText'
  | 'imageToWord'
  | 'imageToExcel'
  | 'repair'
  | ImageToolId

/** The image tools (decisions §69): each a files board of its own (components/ImageToolView.tsx). */
export type ImageToolId = 'imgCompress' | 'imgResize' | 'imgCrop' | 'imgConvert' | 'imgToJpg' | 'imgRotate' | 'imgUpscale' | 'imgRemoveBg' | 'imgBlur' | 'imgWatermark' | 'imgMeme' | 'imgEditor' | 'imgGif' | 'imgFrames' | 'imgIcon' | 'imgInfo'
export const IMAGE_TOOLS: ImageToolId[] = ['imgCompress', 'imgResize', 'imgCrop', 'imgConvert', 'imgToJpg', 'imgRotate', 'imgUpscale', 'imgRemoveBg', 'imgBlur', 'imgWatermark', 'imgMeme', 'imgEditor', 'imgGif', 'imgFrames', 'imgIcon', 'imgInfo']
export const isImageTool = (tool: ToolId | null): tool is ImageToolId => !!tool && (IMAGE_TOOLS as ToolId[]).includes(tool)

/** The tools that are also tabs in the global bar, as Acrobat's Edit / Convert / E-Sign. */
export const MODE_TOOLS: ToolId[] = ['edit', 'comment', 'sign', 'organize']

/** Tools that work without an open document. */
export const STANDALONE_TOOLS: ToolId[] = ['merge', 'imagesToPdf', 'compare', 'createPdf', 'wordToPdf', 'excelToPdf', 'pptToPdf', 'batch', 'scanDocuments', 'scanIdCard', 'scanBook', 'imageToText', 'imageToWord', 'imageToExcel', ...IMAGE_TOOLS]

export type Zoom = number | 'width' | 'page'

export type EditTool = 'text' | 'erase' | 'highlight' | 'pen' | 'shape' | 'note' | 'stamp' | 'textbox' | 'callout'

/** The Comment tools: markup kept as annotations, drawn on the markup layer. */
export const MARKUP_TOOLS: EditTool[] = ['highlight', 'pen', 'shape', 'note', 'stamp', 'textbox', 'callout']
export const isMarkupTool = (tool: EditTool): boolean => MARKUP_TOOLS.includes(tool)

export interface MarkStyle {
  /** Pen, shapes, underline and strike-through. */
  colour: string
  /** Highlighter. */
  highlight: string
  /** Sticky notes. */
  note: string
  /** Line width, points. */
  width: number
  textMark: 'highlight' | 'underline' | 'strikeout'
  shape: 'rect' | 'ellipse' | 'line' | 'arrow'
  /** Shapes: filled with a light tint of the colour. */
  fill: boolean
  /** The stamp to place: its word, colour, and whether the name and date go under it. */
  stamp: { label: string; colour: string; identity: boolean }
  /** Text boxes and callouts: text size in points. */
  textSize: number
}

export interface TextStyle {
  size: number
  colour: string
  bold: boolean
  italic: boolean
  kind: 'serif' | 'sans' | 'mono'
  align: 'start' | 'end' | 'centre' | 'justify'
  /** A font installed on this PC; otherwise one matched to `kind`. */
  family?: string
  underline?: boolean
}

export interface TextEdit {
  style: TextStyle
  /** Writing direction chosen by hand; null = the first strong letter decides. */
  direction: 'rtl' | 'ltr' | null
  rtl: boolean
  /** The box wraps (a paragraph, or a width was set): alignment applies. */
  wraps: boolean
  /** Some words were in another style; retyping makes them uniform. */
  mixed: boolean
  /** Distance between baselines as a multiple of the size; undefined = as it was. */
  lineHeight?: number
  /** The paragraph's own font, how an edit keeps it, and the kind it was matched to (§56). */
  font?: { name: string; status: 'installed' | 'embedded' | 'missing'; kind: 'serif' | 'sans' | 'mono' }
  /** The look of the words selected in the box (§65): the format bar then changes only them. */
  selection?: { bold: boolean; italic: boolean; underline: boolean; colour: string; size: number } | null
}

/** Changes the open text box (from its own bar or the Edit panel). */
export function patchTextEdit(id: string, patch: Partial<TextEdit>): void {
  const current = get().docs[id]?.textEdit
  if (current) updateView(id, { textEdit: { ...current, ...patch } })
}

export interface Placing {
  source: { path: string } | { data: string }
  /** Pixels, for the proportions. */
  width: number
  height: number
  /** Shown under the pointer while placing. */
  preview: string
  signature: boolean
}

export interface DocView {
  info: DocInfo
  zoom: Zoom
  /** The zoom actually shown (1 = 100%), which in the fit modes depends on the window. */
  shownZoom: number
  /** The page most in view, zero-based. */
  page: number
  mode: 'view' | 'edit' | 'organize'
  /**
   * The reader (decisions §75): a PDF opens with the pages and a slim bar only — no tool tabs,
   * tool panel or quick tools — until Edit is chosen. Text can still be selected and copied,
   * forms filled and links followed.
   */
  reading: boolean
  /** What a click on the page does in Edit mode: text and pictures, erasing, or markup. */
  editTool: EditTool
  /** Style for new text in Edit mode. */
  addStyle: { size: number; colour: string; bold: boolean }
  /** Style for markup (highlight, pen, shapes). */
  markStyle: MarkStyle
  /** A picture or signature waiting to be placed with a click or a drag. */
  placing: Placing | null
  selected: number[]
  search: { query: string; hits: SearchHit[]; index: number; busy: boolean }
  /** Find & Replace (§64): how Find compares, and the replacement typed. Kept when the document changes. */
  find: { matchCase: boolean; wholeWords: boolean; replace: string }
  /** Ask the viewer to scroll this page into view (bumped to re-trigger); with `box` (page points), that part of it (a search match). */
  /** With `point` (page points), that point at the top-left of the view (a bookmark's or a link's destination, as Acrobat). */
  scrollTo: { page: number; nonce: number; box?: [number, number, number, number]; point?: [number, number] } | null
  /** The side panel opened from the right rail, if any. */
  side: SidePanel | null
  /** Thumbnail width in Organize, CSS pixels. */
  gridSize: number
  /** Thumbnail width in the Page thumbnails side panel, CSS pixels. */
  thumbSize: number
  /** Text selected on a page with the select tool. */
  selection: (TextSelection & { page: number }) | null
  /** While Prepare a form is open: the kind of field a drag adds, and a drop-down's choices (one per line). */
  prepare: { kind: 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'; options: string } | null
  /** The first pages are pictures without text (a scan): offer Recognize text. */
  scanned: 'yes' | 'no' | 'dismissed' | null
  /** The document's form fields (found when it opens) and whether they are tinted. */
  forms: { count: number; highlight: boolean } | null
  /** While the Redact tool is open: the marks waiting to be applied, and how the page marks. */
  redact: { marks: Array<{ page: number; box: [number, number, number, number] }>; by: 'text' | 'area' } | null
  /** The crop box while the Crop tool is open: points cut from each side of the page in view. */
  crop: { left: number; top: number; right: number; bottom: number } | null
  /** The text box being edited, shared with the Edit panel's FORMAT TEXT section. */
  textEdit: TextEdit | null
  /** The picture selected in Edit, shared with the panel's ADJUST OBJECTS section. */
  pictureSel: { page: number; box: [number, number, number, number] } | null
  /** The piece of markup selected on a page (from the page or the Comments panel). */
  markSel: { page: number; index: number } | null
}

export type SidePanel = 'thumbnails' | 'bookmarks' | 'search' | 'comments' | 'info'

/** A picture open in the picture viewer (decisions §75): a tab like a document's, beside them. */
export interface PictureView {
  id: string
  path: string
  name: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export type Dialog =
  | { kind: 'password'; path: string; name: string; wrong: boolean; resolve: (password: string | null) => void }
  | { kind: 'permissions'; docId: string; name: string; wrong: boolean; resolve: (password: string | null) => void }
  | { kind: 'settings'; page?: 'general' | 'appearance' | 'saving' | 'places' | 'keyboard' | 'updates' | 'about' }
  | { kind: 'signature'; docId: string }
  | { kind: 'certSign'; docId: string }
  | { kind: 'shortcuts' }
  /** Print (§60), and saving only some pages. */
  | { kind: 'print'; docId: string; pages?: number[] }
  | { kind: 'savePages'; docId: string; pages?: number[] }
  /** The page menu's dialogs (Acrobat's Extract / Delete / Rotate / Replace Pages…), the pages filled in. */
  | { kind: 'pages'; action: 'extract' | 'delete' | 'rotate' | 'replace'; docId: string; pages: number[]; source?: PageSource }
  | { kind: 'confirm'; title: string; message: string; action: string; danger: boolean; resolve: (ok: boolean) => void }
  /** A web or email link in a document, asked about before it opens (§81). */
  | { kind: 'link'; link: SafeLink; resolve: (choice: { open: boolean; always: boolean }) => void }
  /** Unsaved documents about to be closed: one tab, or all of them when the window closes. */
  | { kind: 'unsaved'; docIds: string[]; quitting: boolean }

interface State {
  settings: Settings | null
  update: UpdateState
  docs: Record<string, DocView>
  /** Pictures open in the picture viewer; their ids are in `order` with the documents'. */
  pictures: Record<string, PictureView>
  /** The tabs, documents and pictures, left to right. */
  order: string[]
  active: string | null
  /** The tool shown in the left panel; null = the All tools list. */
  tool: ToolId | null
  /** The left panel is open (Acrobat's tool pane can be closed with ×). */
  panelOpen: boolean
  progress: Progress | null
  busy: string | null
  toasts: Toast[]
  dialog: Dialog | null
  /** Home's page (Recent, PDF tools, Image tools, a place): a tool closed returns to it (§77). */
  homeSection: string
}

const blankSearch = { query: '', hits: [], index: 0, busy: false }
let toastId = 1

export const useStore = create<State>(() => ({
  settings: null,
  update: { state: 'idle' },
  docs: {},
  pictures: {},
  order: [],
  active: null,
  tool: null,
  panelOpen: true,
  progress: null,
  busy: null,
  toasts: [],
  dialog: null,
  homeSection: 'recent'
}))

const set = useStore.setState
const get = useStore.getState

// --- language ------------------------------------------------------------------------

export function t(key: Key, values?: Record<string, string | number>): string {
  return translate(get().settings?.language ?? 'en', key, values)
}

/** A string holding a count, in the right plural form (Arabic: one, two, few, many). */
export function tc(key: CountKey, count: number, values?: Record<string, string | number>): string {
  return translateCount(get().settings?.language ?? 'en', key, count, values)
}

export function useT(): typeof t {
  // Subscribing to the language makes components re-render when it changes.
  useStore((s) => s.settings?.language)
  return t
}

// --- plumbing ------------------------------------------------------------------------

class Failure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message)
  }
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Failure(result.error)
  return result.value
}

function messageFor(error: unknown): string {
  if (error instanceof Failure) {
    // The engine named a more precise sentence of ours (Replace: why nothing was replaced).
    const { key, values } = error.error
    if (key && hasKey(key)) return t(key, values)
    return t(errorKey(error.error.code), { message: error.error.message })
  }
  return t('error.internal', { message: error instanceof Error ? error.message : String(error) })
}

export function toast(kind: Toast['kind'], text: string, action?: Toast['action']): void {
  const id = toastId++
  set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }].slice(-4) }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : 5000)
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}

function noteText(note: OpNote | undefined): string | null {
  if (!note) return null
  const language = get().settings?.language ?? 'en'
  if (note.key === 'note.compressed') {
    const before = Number(note.values?.before)
    const after = Number(note.values?.after)
    if (after >= before) return t('note.compressedNothing')
    return t('note.compressed', { before: formatBytes(language, before), after: formatBytes(language, after) })
  }
  return t(note.key as Key, note.values)
}

/** Runs `work` with the busy overlay up; any failure becomes a toast. Returns undefined on failure. */
/**
 * Form fields still being typed in (decisions §82). Their text is committed before
 * anything reads or changes the document — Save, Print, Export, Share, Extract, Split, the tools —
 * so a Ctrl+S pressed while typing saves the typed text. FormLayer registers each field's commit.
 */
export const typing = new PendingTyping()

/** Commits what is being typed in any document's form fields; false when a field refused it. */
export async function commitTyping(id?: string): Promise<boolean> {
  let ok = true
  for (const docId of id ? [id] : Object.keys(get().docs)) if (typing.has(docId)) ok = (await typing.commit(docId)) && ok
  return ok
}

async function busy<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
  await commitTyping()
  set({ busy: label })
  try {
    return await work()
  } catch (error) {
    toast('error', messageFor(error))
    return undefined
  } finally {
    set({ busy: null })
  }
}

/** Adds or refreshes a document. A new one opens in the reader unless `reading` is false (§75). */
function putDoc(info: DocInfo, activate = true, reading = true): void {
  set((s) => {
    const existing = s.docs[info.id]
    const view: DocView = existing
      ? {
          ...existing,
          info,
          page: Math.min(existing.page, info.pages.length - 1),
          selected: existing.selected.filter((p) => p < info.pages.length),
          // Old search results point at old content.
          search: existing.info.revision === info.revision ? existing.search : { ...blankSearch, query: existing.search.query },
          selection: existing.info.revision === info.revision ? existing.selection : null,
          markSel: existing.info.revision === info.revision ? existing.markSel : null
        }
      : {
          info,
          zoom: ((z) => (z === '100' ? 1 : (z ?? 'width')))(get().settings?.defaultZoom),
          shownZoom: 1,
          page: 0,
          mode: 'view',
          reading,
          editTool: 'text',
          addStyle: { size: 14, colour: '#000000', bold: false },
          markStyle: { colour: '#e11d48', highlight: '#facc15', note: '#facc15', width: 2, textMark: 'highlight', shape: 'rect', fill: false, stamp: { label: t('stamp.approved'), colour: '#1a7f37', identity: true }, textSize: 12 },
          placing: null,
          side: null,
          gridSize: 150,
          thumbSize: THUMB_SIZES.panel.start,
          selection: null,
          markSel: null,
          textEdit: null,
          crop: null,
          redact: null,
          forms: null,
          scanned: null,
          prepare: null,
          pictureSel: null,
          selected: [],
          search: blankSearch,
          find: { matchCase: false, wholeWords: false, replace: '' },
          scrollTo: null
        }
    return {
      docs: { ...s.docs, [info.id]: view },
      order: s.order.includes(info.id) ? s.order : [...s.order, info.id],
      active: activate ? info.id : s.active
    }
  })
  reportUnsaved()
}

export function updateView(id: string, patch: Partial<DocView>): void {
  set((s) => (s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id]!, ...patch } } } : {}))
}

/**
 * Tells the main process how many documents have unsaved work — changes, or typing not yet
 * committed in a form field (§83) — so closing the window asks instead of losing it.
 */
function reportUnsaved(): void {
  const docs = get().docs
  const dirty = unsavedIds(Object.keys(docs), (id) => !!docs[id]?.info.dirty, typing).map((id) => docs[id]!)
  window.api.setUnsaved(dirty.length, {
    title: t('unsavedTitle'),
    message: dirty.length === 1 ? t('unsavedOne', { name: dirty[0]!.info.name }) : t('unsavedMany', { count: dirty.length }),
    discard: t('closeWithoutSaving'),
    cancel: t('cancel')
  })
}

export function activeView(): DocView | null {
  const s = get()
  return s.active ? (s.docs[s.active] ?? null) : null
}

// --- start-up ------------------------------------------------------------------------

export async function initialise(): Promise<void> {
  // Files handed over at start-up (Explorer's double-click, "Open with") arrive as soon as the page
  // has loaded, before the settings below: listen first, open them once the settings are in.
  let early: OpenRequest[] | null = []
  window.api.onOpenFiles((requests) => {
    if (early) early.push(...requests)
    else void openRequested(requests)
  })
  const settings = await window.api.getSettings()
  set({ settings, update: await window.api.updateState() })
  const waiting = early
  early = null
  if (waiting.length) void openRequested(waiting)
  window.api.onProgress((progress) => set({ progress }))
  window.api.onUpdate((update) => set({ update }))
  // The window is closing with unsaved documents: the app asks, in its own dialog.
  // Typing in a form field counts as unsaved work (§83): committed first, so the dialog asks about
  // it and Save keeps it.
  typing.onChange(reportUnsaved)
  window.api.onConfirmQuit(async () => {
    const dirty = await beforeWindowCloses(get().order, typing, (id) => !!get().docs[id]?.info.dirty)
    if (dirty === null) return
    if (dirty.length === 0) void window.api.quit()
    else set({ dialog: { kind: 'unsaved', docIds: dirty, quitting: true } })
  })
  window.api.onEngineRestarted(() => {
    // Pictures are read again as they are shown; only the documents are gone.
    set((s) => ({ docs: {}, order: s.order.filter((id) => s.pictures[id]), active: null, tool: null, busy: null, progress: null }))
    reportUnsaved()
    toast('error', t('engineRestarted'))
  })
}

export async function changeSettings(patch: Partial<Omit<Settings, 'recent'>>): Promise<void> {
  set({ settings: await window.api.setSettings(patch) })
  reportUnsaved()
}

// --- opening, closing, saving -----------------------------------------------------------

function askPassword(path: string, wrong: boolean): Promise<string | null> {
  const name = path.split(/[\\/]/).pop() ?? path
  return new Promise((resolve) => set({ dialog: { kind: 'password', path, name, wrong, resolve } }))
}

/**
 * A web or email link from a document (a link on a page, a bookmark). Only http, https and mailto;
 * the person is asked first, as Acrobat's "Security Warning" does, unless they chose "Always allow"
 * for that site (§81). Main checks the address again before opening it.
 */
export async function openWebLink(address: string): Promise<void> {
  const link = safeLink(address)
  if (!link) {
    toast('error', t('link.refused'))
    return
  }
  const trusted = get().settings?.trustedLinkHosts ?? []
  if (!trusted.includes(link.host)) {
    const choice = await new Promise<{ open: boolean; always: boolean }>((resolve) =>
      set({
        dialog: {
          kind: 'link',
          link,
          resolve: (c) => {
            set({ dialog: null })
            resolve(c)
          }
        }
      })
    )
    if (!choice.open) return
    if (choice.always) await changeSettings({ trustedLinkHosts: [...trusted, link.host].slice(-MAX_TRUSTED_HOSTS) })
  }
  if (!(await window.api.openLink(link.url))) toast('error', t('link.refused'))
}

/** Asks the person to confirm something that changes a lot at once (Acrobat asks before deleting pages). */
export function confirmAction(title: string, message: string, action: string, danger = true): Promise<boolean> {
  return new Promise((resolve) =>
    set({
      dialog: {
        kind: 'confirm',
        title,
        message,
        action,
        danger,
        resolve: (ok) => {
          set({ dialog: null })
          resolve(ok)
        }
      }
    })
  )
}

/** Deletes pages after asking, as Acrobat does; the last page can never be deleted. */
export async function deletePagesAsking(id: string, pages: number[]): Promise<boolean> {
  const view = get().docs[id]
  if (!view || !pages.length || pages.length >= view.info.pages.length) return false
  const list = pages.length === 1 ? String(pages[0]! + 1) : pages.length <= 6 ? pages.map((p) => p + 1).join(', ') : t('pages', { count: pages.length })
  if (!(await confirmAction(t('deletePagesTitle'), t('deletePagesMessage', { pages: list }), t('delete')))) return false
  return !!(await apply(id, { op: 'delete', pages }, t('delete')))
}

/** Asks for a file's open password (Combine files, for a protected file); null if cancelled. */
export async function requestPassword(path: string, wrong = false): Promise<string | null> {
  const given = await askPassword(path, wrong)
  set({ dialog: null })
  return given
}

/**
 * Opens PDFs. Each opens in the reader (§75); with `thenTool` (a tool picked on Home) or `edit`
 * ("Edit with HonoKit") it goes straight to the editor instead.
 */
export async function openPaths(paths: string[], thenTool: ToolId | null = null, edit = false): Promise<void> {
  for (const path of paths) {
    let password: string | undefined
    for (let attempt = 0; ; attempt++) {
      const result = await window.api.open(path, password)
      if (result.ok) {
        const reading = !thenTool && !edit
        putDoc(result.value, true, reading)
        if (thenTool) openTool(thenTool)
        else if (!reading) editDoc(result.value.id)
        // A window-filling tool (Combine, an image tool…) gives way to the document just opened.
        else if (get().tool) set({ tool: null })
        break
      }
      if (result.error.code === 'password-required' || result.error.code === 'wrong-password') {
        const given = await askPassword(path, attempt > 0)
        set({ dialog: null })
        if (given === null) break
        password = given
        continue
      }
      toast('error', `${path.split(/[\\/]/).pop()}: ${messageFor(new Failure(result.error))}`)
      if (result.error.code === 'bad-arguments') await refreshSettings()
      break
    }
  }
}

async function refreshSettings(): Promise<void> {
  set({ settings: await window.api.getSettings() })
}

export async function openWithPicker(thenTool: ToolId | null = null): Promise<void> {
  const paths = await window.api.pickPdfs(true)
  if (paths.length) await openPaths(paths, thenTool)
}

/** What the operating system handed over: PDFs to the reader, pictures to the picture viewer (§75). */
async function openRequested(requests: OpenRequest[]): Promise<void> {
  for (const r of requests) {
    if (r.kind === 'image') await openPicture(r.path, r.edit)
    else await openPaths([r.path], null, r.edit)
  }
}

/** Opens PDFs and pictures alike (Recent, Places, drag and drop, Open…), each in its viewer. */
export async function openAny(paths: string[]): Promise<void> {
  await openRequested(
    paths.flatMap((path): OpenRequest[] => {
      const kind = fileKind(path)
      return kind ? [{ path, kind, edit: false }] : []
    })
  )
}

/** Open… (Ctrl+O): PDFs and pictures. */
export async function openAnyWithPicker(): Promise<void> {
  const paths = await window.api.pickOpenable()
  if (paths.length) await openAny(paths)
}

/** Open image: the pictures chosen open in the picture viewer. */
export async function openPictureWithPicker(): Promise<void> {
  for (const path of await window.api.pickAnyImages()) if (fileKind(path) === 'image') await openPicture(path)
}

let pictureCounter = 1
const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * Shows a picture in the picture viewer, in a tab of its own (the one it already has, if open).
 * With `edit` ("Edit with HonoKit") it opens in the Photo editor, whose Close comes back here.
 */
export async function openPicture(path: string, edit = false): Promise<void> {
  let id = Object.values(get().pictures).find((p) => p.path === path)?.id
  if (!id) {
    const fresh = `picture-${pictureCounter++}`
    id = fresh
    set((s) => ({ pictures: { ...s.pictures, [fresh]: { id: fresh, path, name: nameOf(path) } }, order: [...s.order, fresh] }))
  }
  set({ active: id, tool: null })
  if (edit) editPicture(id)
  // The Recent list holds pictures too.
  const settings = await window.api.rememberPicture(path)
  if (settings && 'recent' in settings) set({ settings })
}

/** The picture viewer moved to another picture of the folder (previous / next). */
export function showPicture(id: string, path: string): void {
  set((s) => (s.pictures[id] ? { pictures: { ...s.pictures, [id]: { ...s.pictures[id]!, path, name: nameOf(path) } } } : {}))
}

/** Edit: the picture in the Photo editor; its Close returns to the viewer, which stays the active tab. */
export function editPicture(id: string): void {
  const picture = get().pictures[id]
  if (picture) handOverTo('imgEditor', [picture.path])
}

/** Home's page; kept here so closing a tool comes back to the hub it was opened from. */
export function setHomeSection(section: string): void {
  set({ homeSection: section })
}

/** Pictures waiting for the image tool about to open (the viewer's Tools and Edit, "Continue with"). */
let handOver: string[] = []

/** Opens an image tool with these pictures already on its board. */
export function handOverTo(tool: ImageToolId, paths: string[]): void {
  handOver = paths
  openTool(tool)
}

/** The pictures handed to the image tool that just opened (once). */
export function takeHandOver(): string[] {
  const paths = handOver
  handOver = []
  return paths
}

/** Edit (§75): the reader becomes the full editor, with the tool tabs, the tool panel and the quick tools. */
export function editDoc(id: string): void {
  updateView(id, { reading: false })
  set((s) => ({ panelOpen: true, tool: s.tool && !STANDALONE_TOOLS.includes(s.tool) ? s.tool : null }))
}

/** Read: back to the reader; the tools are put away (an open tool panel closes, unapplied). */
export function readDoc(id: string): void {
  const view = get().docs[id]
  if (!view) return
  updateView(id, { reading: true, mode: 'view', placing: null, side: view.side === 'comments' ? null : view.side })
  set({ tool: null })
}

export async function closeDoc(id: string, force = false): Promise<void> {
  if (get().pictures[id]) {
    closePicture(id)
    return
  }
  // Text still being typed in a form field is unsaved work too: committed, so closing asks (§82).
  if (!force) await commitTyping(id)
  const view = get().docs[id]
  if (!view) return
  if (view.info.dirty && !force) {
    set({ dialog: { kind: 'unsaved', docIds: [id], quitting: false } })
    return
  }
  await window.api.close(id)
  set((s) => {
    const docs = { ...s.docs }
    delete docs[id]
    const order = s.order.filter((x) => x !== id)
    const index = s.order.indexOf(id)
    const active = s.active === id ? (order[Math.min(index, order.length - 1)] ?? null) : s.active
    return { docs, order, active, tool: active ? s.tool : null, dialog: null }
  })
  reportUnsaved()
}

/** Closes a picture's tab; the tab beside it becomes active. */
function closePicture(id: string): void {
  set((s) => {
    const pictures = { ...s.pictures }
    delete pictures[id]
    const order = s.order.filter((x) => x !== id)
    const index = s.order.indexOf(id)
    const active = s.active === id ? (order[Math.min(index, order.length - 1)] ?? null) : s.active
    return { pictures, order, active }
  })
}

/** Documents already saved as a copy in this session: saving again updates that copy. */
const copied = new Set<string>()

/** What Save will do for a document, for button labels and the unsaved-changes dialog. */
export function saveWillCopy(id: string): boolean {
  const view = get().docs[id]
  return !!view?.info.path && get().settings?.saveMode !== 'replace' && !copied.has(id)
}

/**
 * Saves a document. A file opened from disk is, by default, saved as a copy beside it
 * ("name (edited).pdf", or in the chosen folder) — the original is kept; after that, Save
 * updates the copy. With "Replace the original" in Settings, Save writes over the file, as
 * Acrobat does. A new document, or Save as…, asks where.
 */
export async function save(id: string, as = false): Promise<boolean> {
  const view = get().docs[id]
  if (!view) return false
  let path: string | undefined
  const copy = !as && saveWillCopy(id)
  if (as || !view.info.path) {
    const chosen = await window.api.pickSavePath(view.info.name)
    if (!chosen) return false
    path = chosen
  } else if (copy) {
    path = await window.api.copyPath(view.info.path!, get().settings?.saveFolder || undefined)
  }
  const info = await busy(t('save'), async () => unwrap(await window.api.save(id, path)))
  if (!info) return false
  if (copy) copied.add(id)
  putDoc(info, false)
  await refreshSettings()
  toast('success', t(copy ? 'savedCopyTo' : 'savedTo', { path: info.path ?? '' }), { label: t('showInFolder'), run: () => void window.api.showInFolder(info.path!) })
  return true
}

// --- changing documents ------------------------------------------------------------------

async function askPermissions(docId: string, wrong: boolean): Promise<string | null> {
  const name = get().docs[docId]?.info.name ?? ''
  return new Promise((resolve) => set({ dialog: { kind: 'permissions', docId, name, wrong, resolve } }))
}

/** Offers the permissions password, and keeps it for this document if it is right. */
export async function authorize(docId: string): Promise<boolean> {
  for (let wrong = false; ; wrong = true) {
    const password = await askPermissions(docId, wrong)
    set({ dialog: null })
    if (password === null) return false
    const result = await window.api.authorize(docId, password)
    if (result.ok) {
      putDoc(result.value, false)
      return true
    }
    if (result.error.code !== 'wrong-password') {
      toast('error', messageFor(new Failure(result.error)))
      return false
    }
  }
}

/** Applies an operation to a document; offers the permissions password if the author restricted it. */
export async function apply(id: string, op: OpInput, label: string): Promise<ApplyResult | undefined> {
  // Comments and marks carry the person's name (Settings → identity), as in Acrobat.
  if (op.op === 'markup' && !op.author) op = { ...op, author: get().settings?.authorName || undefined }
  // Any other change first takes in what is being typed in a form field: the change gives the
  // document a new revision, which would otherwise redraw the field without the typing (§82).
  if (op.op !== 'fillForm') await commitTyping(id)
  const run = async (): Promise<Result<ApplyResult>> => window.api.apply(id, op)
  set({ busy: label })
  try {
    let result = await run()
    if (!result.ok && result.error.code === 'restricted') {
      set({ busy: null })
      if (!(await authorize(id))) return undefined
      set({ busy: label })
      result = await run()
    }
    const value = unwrap(result)
    putDoc(value.doc, false)
    const note = noteText(value.note)
    const missingFont = value.note?.key === 'note.fontSimilar' ? String(value.note.values?.font ?? '') : ''
    if (note) toast('info', note, missingFont ? { label: t('font.find'), run: () => void window.api.findFont(missingFont) } : undefined)
    return value
  } catch (error) {
    toast('error', messageFor(error))
    return undefined
  } finally {
    set({ busy: null })
  }
}

export async function undo(id: string): Promise<void> {
  const info = await busy(t('undo'), async () => unwrap(await window.api.undo(id)))
  if (info) putDoc(info, false)
}

export async function redo(id: string): Promise<void> {
  const info = await busy(t('redo'), async () => unwrap(await window.api.redo(id)))
  if (info) putDoc(info, false)
}

export async function extractPages(id: string, pages: number[]): Promise<void> {
  const info = await busy(t('extract'), async () => unwrap(await window.api.extract(id, pages)))
  if (info) putDoc(info)
}

/**
 * Acrobat's Extract: the pages as one new document (a new tab, unsaved) or as a file per page in
 * a folder the person chooses; with `remove`, they then leave this document (one Undo).
 */
export async function extractPagesAs(id: string, pages: number[], each: boolean, remove: boolean): Promise<boolean> {
  const view = get().docs[id]
  if (!view || !pages.length) return false
  if (each) {
    const folder = await window.api.pickFolder()
    if (!folder) return false
    await writeFiles(() => window.api.split(id, pages.map((p) => [p, p] as [number, number]), folder), t('extract'), folder)
  } else await extractPages(id, pages)
  if (remove && pages.length < view.info.pages.length) {
    // The new document is in front now; the pages go from this one.
    if (await apply(id, { op: 'delete', pages }, t('delete'))) updateView(id, { selected: [] })
  }
  return true
}

/** The PDF whose pages replace pages of a document (Replace pages…), with its page count. */
export interface PageSource {
  path: string
  name: string
  /** 0 when the file could not be read before replacing (the engine then checks the pages). */
  count: number
  password?: string
}

/** Replace pages…: choose the PDF first, as Acrobat does, then the dialog opens with the pages. */
export async function replacePagesAsking(id: string, pages: number[]): Promise<void> {
  const source = await pickPageSource()
  if (source) set({ dialog: { kind: 'pages', action: 'replace', docId: id, pages, source } })
}

export async function pickPageSource(): Promise<PageSource | null> {
  const [path] = await window.api.pickPdfs(false)
  if (!path) return null
  const name = nameOf(path)
  const probe = await window.api.fileThumbnail(path, 60)
  if (!probe.ok) {
    toast('error', `${name}: ${messageFor(new Failure(probe.error))}`)
    return null
  }
  if (!probe.value.locked) return { path, name, count: probe.value.pages }
  // A protected file: its open password, then it is read when the pages are replaced.
  const password = await requestPassword(path)
  return password === null ? null : { path, name, count: 0, password }
}

/** Thumbnail sizes, CSS pixels: Organize's grid and the Page thumbnails panel. */
export const THUMB_SIZES = { grid: { min: 90, max: 320, step: 30 }, panel: { min: 72, max: 192, step: 24, start: 120 } } as const

/** Enlarge / Reduce page thumbnails, where the menu was opened. */
export function resizeThumbs(id: string, where: 'grid' | 'panel', grow: boolean): void {
  const view = get().docs[id]
  if (!view) return
  const s = THUMB_SIZES[where]
  const now = where === 'grid' ? view.gridSize : view.thumbSize
  const next = Math.max(s.min, Math.min(s.max, now + (grow ? s.step : -s.step)))
  updateView(id, where === 'grid' ? { gridSize: next } : { thumbSize: next })
}

/** Runs a call with the busy indicator; a failure is shown as a toast and gives undefined. */
export async function runBusy<T>(label: string, make: () => Promise<Result<T>>): Promise<T | undefined> {
  return busy(label, async () => unwrap(await make()))
}

/** A new document from a tool (merged, scanned, pictures…) opens in the reader; a blank page or a template (`reading` false) in the editor. */
export async function newDocument(make: () => Promise<Result<DocInfo>>, label: string, reading = true): Promise<boolean> {
  const info = await busy(label, async () => unwrap(await make()))
  if (!info) return false
  putDoc(info, true, reading)
  set({ tool: null })
  if (!reading) editDoc(info.id)
  return true
}

export async function writeFiles(make: () => Promise<Result<string[]>>, label: string, folder: string): Promise<void> {
  const files = await busy(label, async () => unwrap(await make()))
  if (files) toast('success', t('filesWritten', { count: files.length, folder }), { label: t('showInFolder'), run: () => void window.api.showInFolder(files[0] ?? folder) })
}

// --- viewing ---------------------------------------------------------------------------------

/**
 * Shows a tool in the left panel (null: the All tools list), and puts the pages in the
 * matching mode, as Acrobat's global-bar tabs do: Edit and Sign edit the page, Comment
 * marks it up, Organize shows the page grid, anything else views it.
 */
/** Files Create PDF turns into PDFs (Word, Excel, PowerPoint, web pages, text). */
export const CONVERTIBLE = /\.(docx?|rtf|odt|xlsx?|ods|csv|pptx?|odp|x?html?|txt|md)$/i

/** Create PDF: each file becomes a new, unsaved PDF (or one combined PDF). */
export async function createPdfFrom(paths: string[], combine = false): Promise<void> {
  if (paths.length === 0) return
  const r = await runBusy(t('create.converting', { count: paths.length }), () => window.api.createPdf(paths, combine))
  if (!r) return
  r.docs.forEach((d, i) => putDoc(d, i === r.docs.length - 1))
  set({ tool: null })
  // What our own converter could not draw faithfully is said with the note about it.
  if (r.methods.includes('built-in')) toast('info', [t('create.builtIn'), ...(r.notes ?? [])].join(' '))
}

async function createPdfFromPicker(kind?: 'word' | 'excel' | 'powerpoint'): Promise<void> {
  const paths = await window.api.pickConvertible(kind)
  if (paths.length) await createPdfFrom(paths, false)
}

export function openTool(tool: ToolId | null): void {
  // Create PDF is a file choice, not a panel: it goes straight to the files.
  if (tool === 'createPdf' || tool === 'wordToPdf' || tool === 'excelToPdf' || tool === 'pptToPdf') {
    void createPdfFromPicker(tool === 'wordToPdf' ? 'word' : tool === 'excelToPdf' ? 'excel' : tool === 'pptToPdf' ? 'powerpoint' : undefined)
    return
  }
  set({ tool, panelOpen: true })
  const view = activeView()
  if (!view) return
  // A tool that works on the document leaves the reader for the editor (§75).
  if (view.reading && tool && !STANDALONE_TOOLS.includes(tool)) updateView(view.info.id, { reading: false })
  const markup = isMarkupTool(view.editTool)
  if (tool === 'organize') updateView(view.info.id, { mode: 'organize', placing: null })
  else if (tool === 'edit' || tool === 'sign') updateView(view.info.id, { mode: 'edit', editTool: markup ? 'text' : view.editTool })
  else if (tool === 'comment') updateView(view.info.id, { mode: 'edit', editTool: markup ? view.editTool : 'highlight', placing: null })
  else updateView(view.info.id, { mode: 'view', placing: null })
}

/** The quick tools beside the page: each also brings up its panel, where its options are. */
export function quickTool(view: DocView, choice: 'select' | EditTool): void {
  if (choice === 'select') {
    if (get().tool && MODE_TOOLS.includes(get().tool!)) set({ tool: null })
    updateView(view.info.id, { mode: 'view', placing: null })
    return
  }
  const panel: ToolId = isMarkupTool(choice) ? 'comment' : 'edit'
  set({ tool: panel, panelOpen: true })
  updateView(view.info.id, { mode: 'edit', reading: false, editTool: choice, placing: null })
}

export function togglePanel(open?: boolean): void {
  set((s) => ({ panelOpen: open ?? !s.panelOpen }))
}

export function toggleSide(view: DocView, side: SidePanel): void {
  updateView(view.info.id, { side: view.side === side ? null : side })
}

export function goToPage(id: string, page: number): void {
  const view = get().docs[id]
  if (!view) return
  const p = Math.max(0, Math.min(page, view.info.pages.length - 1))
  updateView(id, { page: p, scrollTo: { page: p, nonce: Date.now() } })
}

/** Goes to a bookmark's or a link's destination: the page, and the point on it when one is given. */
export function goToDestination(id: string, page: number, point?: [number, number]): void {
  const view = get().docs[id]
  if (!view) return
  const p = Math.max(0, Math.min(page, view.info.pages.length - 1))
  updateView(id, { page: p, scrollTo: { page: p, nonce: Date.now(), ...(point ? { point } : {}) } })
}

/** Scrolls a search match into view: the part of the page where it is, not the page's top. */
export function showHit(id: string, hit: SearchHit): void {
  const view = get().docs[id]
  if (!view) return
  const p = Math.max(0, Math.min(hit.page, view.info.pages.length - 1))
  const box: [number, number, number, number] | undefined = hit.boxes.length
    ? [Math.min(...hit.boxes.map((b) => b[0])), Math.min(...hit.boxes.map((b) => b[1])), Math.max(...hit.boxes.map((b) => b[2])), Math.max(...hit.boxes.map((b) => b[3]))]
    : undefined
  updateView(id, { page: p, scrollTo: { page: p, nonce: Date.now(), ...(box ? { box } : {}) } })
}

export async function runSearch(id: string, query: string, startAt = 0): Promise<void> {
  const trimmed = query.trim()
  updateView(id, { search: { query, hits: [], index: 0, busy: trimmed.length > 0 } })
  if (!trimmed) return
  const options = get().docs[id]?.find
  const result = await window.api.search(id, trimmed, { matchCase: !!options?.matchCase, wholeWords: !!options?.wholeWords })
  const view = get().docs[id]
  if (!view || view.search.query !== query) return // a newer search replaced this one
  const hits = result.ok ? result.value : []
  const index = Math.max(0, Math.min(startAt, hits.length - 1))
  updateView(id, { search: { query, hits, index, busy: false } })
  if (hits[index]) showHit(id, hits[index])
}

/** Find & Replace (§64): the match Find shows, replaced; then Find moves on to the next one. */
export async function replaceCurrent(id: string): Promise<void> {
  const view = get().docs[id]
  const hit = view?.search.hits[view.search.index]
  // A match across a line break is left as it is (the engine would skip it too): the panel's Replace is off for it.
  if (!view || !hit?.boxes[0] || hit.boxes.length > 1) return
  const { query, index } = view.search
  const r = await apply(id, { op: 'replaceAll', find: query.trim(), replace: view.find.replace, matchCase: view.find.matchCase, wholeWords: view.find.wholeWords, only: { page: hit.page, box: hit.boxes[0] } }, t('replace'))
  // The replaced match is gone: the one that was next now has its index.
  if (r) await runSearch(id, query, index)
}

/** Find & Replace: every match in the document, as one change (one Undo). */
export async function replaceAll(id: string): Promise<void> {
  const view = get().docs[id]
  if (!view || !view.search.query.trim()) return
  const { query } = view.search
  const r = await apply(id, { op: 'replaceAll', find: query.trim(), replace: view.find.replace, matchCase: view.find.matchCase, wholeWords: view.find.wholeWords }, t('replaceAll'))
  if (r) await runSearch(id, query)
}

export function stepSearch(id: string, delta: number): void {
  const view = get().docs[id]
  if (!view || view.search.hits.length === 0) return
  const n = view.search.hits.length
  const index = (view.search.index + delta + n) % n
  updateView(id, { search: { ...view.search, index } })
  showHit(id, view.search.hits[index]!)
}

export function setDialog(dialog: Dialog | null): void {
  set({ dialog })
}

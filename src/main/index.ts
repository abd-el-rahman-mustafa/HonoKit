import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, screen, session, shell, type NativeImage } from 'electron'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { APP_ID, BRAND, isProjectUrl, systemLabel } from '@shared/brand'
import { IPC, pageAddress, type DocInfo, type Progress, type Result, type Settings, type ShareFile, type UpdateState } from '@shared/ipc'
import { OpSchema } from '@shared/ops'
import { READABLE_EXTENSIONS } from '@shared/imageFormats'
import { openRequests, PICTURE_EXTENSIONS, sortPictures, type OpenRequest } from '@shared/opening'
import { AnimateSchema, DestinationSchema, DetectSchema, ImageJobSchema, OutputSchema, type Destination, type ImageRunResult } from '@shared/imageOps'
import { addRecent, forgetRecent, getSettings, MAX_SIGNATURES, PlaceSchema, SignatureSchema, updateSettings } from './settings'
import { detectedPlaces, exists, listFolder } from './places'
import { carryOverPreviousData } from './previous'
import { CONVERTIBLE, fileToPdf, officeApps, type Method } from './create'
import { cleanShareFolder, copyFileToClipboard, emailWithAttachment, ensureShareFolder, mailApp, showShareSheet } from './share'
import { runSmoke, smokeFolder } from './smoke'
import { addPersonalWord, spellerFor } from './spell'
import { Updater } from './updater'
import { WorkerClient } from './worker-client'
import { WrittenFiles } from './written'
import { printerPreferences, printers, printPages } from './print'
import { acquireFromScanner, scanFolder } from './scanner'
import { exifOrientation, orientationTurn } from '@shared/exif'
import { MAX_TRUSTED_HOSTS, safeLink } from '@shared/links'

/** Save targets chosen in the export window, and files converted this session (the only ones openConverted opens). */
const exportTargets = new Set<string>()
const converted = new Set<string>()

/** The person's templates: PDFs kept in the app's own folder (Create › My templates). */
const templatesFolder = (): string => join(app.getPath('userData'), 'templates')
async function listTemplates(): Promise<Array<{ name: string; path: string }>> {
  try {
    const names = (await readdir(templatesFolder())).filter((n) => n.toLowerCase().endsWith('.pdf'))
    return names.sort((a, b) => a.localeCompare(b)).map((n) => ({ name: basename(n, extname(n)), path: join(templatesFolder(), n) }))
  } catch {
    return []
  }
}

/**
 * The main process: the window, the operating system (dialogs, files handed to us,
 * the page-picture protocol), settings and updates. All PDF work is in the worker;
 * everything the interface may ask for is the `handlers` table below, each argument
 * checked with Zod, because the renderer is untrusted from here.
 */

const PAGE_SCHEME = 'pdfpage'
const PDF_EXTENSIONS = new Set(['.pdf'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff'])
/** Every picture the image tools open (decisions §69); the worker then checks the bytes. */
const ANY_IMAGE_EXTENSIONS = new Set(READABLE_EXTENSIONS.map((e) => `.${e}`))
/** Pictures the picture viewer opens: the same, without PDF (decisions §75). */
const PICTURE_FILE_EXTENSIONS = new Set(PICTURE_EXTENSIONS.map((e) => `.${e}`))
const OPENABLE_EXTENSIONS = new Set([...PDF_EXTENSIONS, ...PICTURE_FILE_EXTENSIONS])

protocol.registerSchemesAsPrivileged([{ scheme: PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// A smoke run gets its own settings and recent files, never the person's. And it keeps painting
// when another window covers it: Windows stops repainting "occluded" windows, which froze the
// screenshots and the visibility checks of a run started behind the owner's own window.
if (smokeFolder) {
  app.setPath('userData', join(smokeFolder, 'userdata'))
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}
if (!app.requestSingleInstanceLock()) app.quit()
else if (!smokeFolder) carryOverPreviousData()
app.setAppUserModelId(APP_ID)

const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
let window: BrowserWindow | null = null
let rendererReady = false
const pendingFiles: OpenRequest[] = []
let unsaved = { count: 0, prompt: { title: '', message: '', discard: 'Close without saving', cancel: 'Cancel' } }
let allowClose = false

const send = (channel: string, value: unknown): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value)
}

const worker = new WorkerClient(
  resources,
  (p: Progress | null) => send(IPC.progress, p),
  () => send(IPC.engine, 'restarted')
)
const updater = new Updater((s: UpdateState) => send(IPC.update, s))

// --- files the operating system hands us -----------------------------------------

/** A path we are willing to read: absolute, an existing file, with an expected extension. */
function usableFile(path: unknown, extensions: Set<string>): string | null {
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  try {
    if (!statSync(path).isFile()) return null
  } catch {
    return null
  }
  return extensions.has(extname(path).toLowerCase()) ? path : null
}

/** The PDFs and pictures in a command line, and whether "Edit with HonoKit" (`--edit`) asked to edit them. */
function requestsIn(argv: string[]): OpenRequest[] {
  return openRequests(argv, (a) => usableFile(a, OPENABLE_EXTENSIONS) !== null)
}

function openFiles(requests: OpenRequest[]): void {
  if (requests.length === 0) return
  if (rendererReady) send(IPC.openFiles, requests)
  else pendingFiles.push(...requests)
  if (window) bringForward(window)
}

/**
 * Brings the window forward for a file opened from File Explorer while the app runs. Windows
 * refuses a plain focus() from the background and paints the taskbar button red ("needs
 * attention") instead; being topmost for a moment is the usual way round it (decisions §49).
 */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) return // still starting: ready-to-show will show it
  win.setAlwaysOnTop(true)
  win.focus()
  win.setAlwaysOnTop(false)
  win.flashFrame(false)
}

app.on('second-instance', (_event, argv) => openFiles(requestsIn(argv)))
app.on('open-file', (event, path) => {
  event.preventDefault()
  openFiles(requestsIn([path]))
})
pendingFiles.push(...requestsIn(process.argv.slice(1)))

// --- what the interface may ask for -----------------------------------------------

const id = z.string().min(1).max(100)
const pdfPath = z.string().refine((p) => usableFile(p, PDF_EXTENSIONS) !== null, 'not a readable PDF file')
const imagePath = z.string().refine((p) => usableFile(p, IMAGE_EXTENSIONS) !== null, 'not a readable picture')
const anyImage = z.string().refine((p) => usableFile(p, ANY_IMAGE_EXTENSIONS) !== null, 'not a picture the image tools read')
const picture = z.string().refine((p) => usableFile(p, PICTURE_FILE_EXTENSIONS) !== null, 'not a picture the viewer opens')

/** The image tools' results of this session, which "Try again" may replace (decisions §77). */
const written = new WrittenFiles()
const replacing = z.string().max(4000).nullable().optional()
/** Records a result (and drops the one it replaced) before handing it to the window. */
function noteWritten<T extends { path: string; replaced?: string }>(r: Result<T>): Result<T> {
  if (r.ok) {
    if (r.value.replaced) written.forget(r.value.replaced)
    written.remember(r.value.path)
  }
  return r
}

/** Where an image tool writes a result for `source`: a folder and a name, without extension. */
function outputBase(source: string, destination: Destination, name?: string): string {
  const folder = destination.folder ?? dirname(source)
  if (!isAbsolute(folder)) throw new Error('not an absolute folder')
  const stem = (name ?? basename(source, extname(source))) + destination.suffix
  // Characters Windows refuses in file names (and control characters) become _.
  const unsafe = '<>:"/|?*' + String.fromCharCode(92)
  const safe = [...stem].map((c) => (c.charCodeAt(0) < 32 || unsafe.includes(c) ? '_' : c)).join('').trim()
  return join(folder, safe || 'picture')
}
const folder = z.string().refine((p) => isAbsolute(p), 'not an absolute folder')
const savePath = z.string().refine((p) => isAbsolute(p) && extname(p).toLowerCase() === '.pdf', 'not a PDF path')
const pages = z.array(z.number().int().min(0)).min(1).max(100_000)
const point = z.tuple([z.number().min(-1e5).max(1e5), z.number().min(-1e5).max(1e5)])
const scanItem = z.object({
  path: imagePath,
  corners: z.tuple([point, point, point, point]).nullable(),
  mode: z.enum(['original', 'color', 'gray', 'bw']),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  side: z.enum(['front', 'back']).optional(),
  split: z.number().min(0.1).max(0.9).nullable().optional()
})

async function remember(result: { ok: boolean; value?: unknown }): Promise<typeof result> {
  if (result.ok) {
    const doc = result.value as DocInfo
    if (doc?.path) addRecent(doc.path)
  }
  return result
}

/** Files readied for sharing (and their drag icons): only these may be shared or dragged out. */
const shareable = new Map<string, NativeImage>()

/** The Share button's centre (window pixels) as a screen point in physical pixels, for the share window. */
function screenPoint(at: { x: number; y: number } | undefined): { x: number; y: number } {
  if (!window || !at) return { x: -1, y: -1 }
  const b = window.getContentBounds()
  const dip = { x: b.x + at.x, y: b.y + at.y }
  const scale = screen.getDisplayNearestPoint(dip).scaleFactor
  return { x: dip.x * scale, y: dip.y * scale }
}

/** Allows a file to be shared or dragged out (with its drag icon); says how "Email as attachment" works here. */
async function readyToShare(path: string): Promise<ShareFile['mail']> {
  const app0 = await mailApp()
  const mail = app0.kind === 'outlook' || app0.kind === 'thunderbird' ? app0.kind : app0.kind === 'none' ? 'none' : 'sheet'
  let icon: NativeImage
  try {
    icon = await app.getFileIcon(path, { size: 'normal' })
  } catch {
    icon = nativeImage.createEmpty()
  }
  // startDrag needs an icon; Windows' own icon for the file type, or a plain square if none.
  shareable.set(path, icon.isEmpty() ? nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 0xc0), { width: 32, height: 32 }) : icon)
  return mail
}

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  open: (path, password) => worker.call('open', pdfPath.parse(path), z.string().max(127).optional().parse(password)).then(remember),
  close: (docId) => worker.call('close', id.parse(docId)),
  fileThumbnail: (path, width) => worker.call('fileThumbnail', pdfPath.parse(path), z.number().min(40).max(600).parse(width)),
  apply: (docId, op) => {
    const parsed = OpSchema.parse(op)
    if (parsed.op === 'insertPdf' || parsed.op === 'replacePages') pdfPath.parse(parsed.path)
    if (parsed.op === 'watermark' && parsed.imagePath) imagePath.parse(parsed.imagePath)
    if (parsed.op === 'addPicture' && 'path' in parsed.source) imagePath.parse(parsed.source.path)
    if (parsed.op === 'changePicture' && parsed.change.kind === 'replace' && 'path' in parsed.change.source) imagePath.parse(parsed.change.source.path)
    return worker.call('apply', id.parse(docId), parsed)
  },
  undo: (docId) => worker.call('undo', id.parse(docId)),
  redo: (docId) => worker.call('redo', id.parse(docId)),
  shareFile: async (docId) => {
    const r = (await worker.call('shareCopy', id.parse(docId), ensureShareFolder())) as { ok: boolean; value?: { path: string; temporary: boolean; bytes: number } }
    if (!r.ok || !r.value) return r
    return { ok: true, value: { ...r.value, mail: await readyToShare(r.value.path) } }
  },
  // The picture viewer shares the picture itself (§75): nothing to save first.
  sharePicture: async (path) => {
    const file = picture.parse(path)
    return { ok: true, value: { path: file, temporary: false, bytes: statSync(file).size, mail: await readyToShare(file) } }
  },
  shareAction: async (path, action, at) => {
    const file = z.string().parse(path)
    if (!shareable.has(file)) return 'failed'
    const point = z.object({ x: z.number(), y: z.number() }).optional().parse(at)
    const sheet = async (): Promise<'done' | 'canceled' | 'fallback'> => {
      const outcome = await showShareSheet(file, screenPoint(point))
      if (outcome === 'completed') return 'done'
      if (outcome === 'canceled' || outcome === 'timeout') return 'canceled'
      // No share window (blocked by policy, old Windows): the file in Explorer, where right-click > Share works.
      shell.showItemInFolder(file)
      return 'fallback'
    }
    switch (z.enum(['sheet', 'email', 'copy', 'folder']).parse(action)) {
      case 'folder':
        shell.showItemInFolder(file)
        return 'done'
      case 'copy':
        return (await copyFileToClipboard(file)) ? 'done' : 'failed'
      case 'email':
        return (await emailWithAttachment(file)) ? 'done' : sheet()
      case 'sheet':
        return sheet()
    }
  },
  save: (docId, path) => worker.call('save', id.parse(docId), path === undefined ? undefined : savePath.parse(path)).then(remember),
  authorize: (docId, password) => worker.call('authorize', id.parse(docId), z.string().min(1).max(127).parse(password)),
  search: (docId, query, options) => worker.call('search', id.parse(docId), z.string().max(500).parse(query), z.object({ matchCase: z.boolean().optional(), wholeWords: z.boolean().optional() }).optional().parse(options) ?? {}),
  pageText: (docId, page) => worker.call('pageText', id.parse(docId), z.number().int().min(0).parse(page)),
  selectText: (docId, page, from, to, unit) =>
    worker.call(
      'selectText',
      id.parse(docId),
      z.number().int().min(0).parse(page),
      z.tuple([z.number(), z.number()]).parse(from),
      z.tuple([z.number(), z.number()]).parse(to),
      z.enum(['char', 'word', 'line', 'page']).parse(unit)
    ),
  copyText: (text) => clipboard.writeText(z.string().max(5_000_000).parse(text)),
  spellCheck: (text) => (getSettings().spellCheck ? spellerFor(resources).check(z.string().max(100_000).parse(text)) : []),
  spellSuggest: (word) => spellerFor(resources).suggest(z.string().min(1).max(100).parse(word)),
  spellAdd: (word) => addPersonalWord(resources, z.string().trim().min(1).max(100).regex(/^\S+$/).parse(word)),
  preview: (docId, op, page, scale) => {
    const parsed = OpSchema.parse(op)
    // Only tools that change what pages look like, one page at a time.
    if (!['watermark', 'pageNumbers', 'headerFooter', 'crop', 'rotate', 'formatText'].includes(parsed.op)) throw new Error('no preview for this tool')
    if (parsed.op === 'watermark' && parsed.imagePath) imagePath.parse(parsed.imagePath)
    return worker.call('preview', id.parse(docId), parsed, z.number().int().min(0).parse(page), z.number().min(0.05).max(4).parse(scale))
  },
  pageParagraphs: (docId, page) => worker.call('pageParagraphs', id.parse(docId), z.number().int().min(0).parse(page)),
  paragraphFonts: (docId, page, family) => worker.call('paragraphFonts', id.parse(docId), z.number().int().min(0).parse(page), z.string().max(300).parse(family)),
  pagePictures: (docId, page) => worker.call('pagePictures', id.parse(docId), z.number().int().min(0).parse(page)),
  systemFonts: () => worker.call('systemFonts'),
  whiteMargins: (docId, page) => worker.call('whiteMargins', id.parse(docId), z.number().int().min(0).parse(page)),
  pageMarkups: (docId, page) => worker.call('pageMarkups', id.parse(docId), z.number().int().min(0).parse(page)),
  outline: (docId) => worker.call('outline', id.parse(docId)),
  pageLinks: (docId, page) => worker.call('pageLinks', id.parse(docId), z.number().int().min(0).parse(page)),
  scanDetect: (path, book) => worker.call('scanDetect', imagePath.parse(path), book === true),
  scanFold: (item) => worker.call('scanFold', scanItem.parse(item)),
  scanPreview: (item) => worker.call('scanPreview', scanItem.parse(item)),
  scanPdfPictures: async (paths) => {
    const list = z.array(pdfPath).min(1).max(50).parse(paths)
    const pictures: string[] = []
    for (const file of list) {
      const r = await worker.call<string[]>('scanPdfPages', file, join(await scanFolder(), `pdf-${Date.now()}-${pictures.length}`))
      if (!r.ok) return r
      pictures.push(...r.value)
    }
    return { ok: true, value: pictures }
  },
  scanToPdf: (items, goal, paper, rtl) => {
    const list = z.array(scanItem).min(1).max(500).parse(items)
    const kind = z.enum(['pages', 'idcard', 'book']).parse(goal)
    return worker.call('scanToPdf', list, kind, z.enum(['a4', 'letter', 'fit']).parse(paper), kind === 'idcard' ? 'ID card.pdf' : kind === 'book' ? 'Book.pdf' : 'Scan.pdf', rtl === true)
  },
  scannerAcquire: async () => (smokeFolder ? { ok: true, value: null } : acquireFromScanner()),
  pictureInfo: async (path) => {
    const file = anyImage.safeParse(path)
    if (!file.success) return null
    const image = IMAGE_EXTENSIONS.has(extname(file.data).toLowerCase()) ? nativeImage.createFromPath(file.data) : nativeImage.createEmpty()
    if (image.isEmpty()) {
      // HEIC, WebP, RAW, PSD …: the image engine draws the preview, already upright (§69).
      const r = await worker.call<{ width: number; height: number; preview: string }>('imageDescribe', file.data)
      return r.ok ? { path: file.data, width: r.value.width, height: r.value.height, preview: r.value.preview, turn: 0 } : null
    }
    const { width, height } = image.getSize()
    const scale = Math.min(1, 320 / Math.max(width, height))
    const preview = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL()
    // A phone photo stored sideways: Electron's decoder ignores its EXIF orientation, the PDF does not (§61).
    const turn = orientationTurn(exifOrientation(new Uint8Array(readFileSync(file.data).subarray(0, 131072))))
    return { path: file.data, width: turn === 90 || turn === 270 ? height : width, height: turn === 90 || turn === 270 ? width : height, preview, turn }
  },
  extract: (docId, list) => worker.call('extract', id.parse(docId), pages.parse(list)),
  merge: (items) =>
    worker.call(
      'merge',
      z.array(z.union([z.object({ path: pdfPath, password: z.string().max(127).optional() }), z.object({ docId: id })])).min(1).max(500).parse(items),
      'Merged.pdf'
    ),
  imagesToPdf: (paths, options) =>
    worker.call(
      'imagesToPdf',
      z.array(anyImage).min(1).max(2000).parse(paths),
      z
        .object({
          paper: z.enum(['fit', 'a4', 'letter']),
          margin: z.number().min(0).max(144),
          autoOrientation: z.boolean(),
          orientation: z.enum(['auto', 'portrait', 'landscape']).optional(),
          rotations: z.array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])).max(2000).optional()
        })
        .parse(options),
      'Pictures.pdf'
    ),
  imageDescribe: (path, size) => worker.call('imageDescribe', anyImage.parse(path), z.number().int().min(64).max(2400).optional().parse(size)),
  imageMetadata: (path) => worker.call('imageMetadata', anyImage.parse(path)),
  imageRun: async (path, job, destination, previous) => {
    const source = anyImage.parse(path)
    const old = written.replaceable(replacing.parse(previous))
    return noteWritten(await worker.call<ImageRunResult>('imageRun', source, ImageJobSchema.parse(job), outputBase(source, DestinationSchema.parse(destination)), old))
  },
  imageAnimate: async (paths, options, destination, name, previous) => {
    const sources = z.array(anyImage).min(1).max(2000).parse(paths)
    const old = written.replaceable(replacing.parse(previous))
    return noteWritten(await worker.call<ImageRunResult>('imageAnimate', sources, AnimateSchema.parse(options), outputBase(sources[0]!, DestinationSchema.parse(destination), z.string().min(1).max(120).parse(name)), old))
  },
  imageDecode: (path) => worker.call('imageDecode', anyImage.parse(path)),
  // The picture viewer (§75): the pictures beside one, for previous and next; and the Recent list.
  picturesBeside: async (path) => {
    const file = picture.parse(path)
    const names = await readdir(dirname(file)).catch(() => [] as string[])
    return sortPictures(names).slice(0, 10_000).map((n) => join(dirname(file), n))
  },
  rememberPicture: (path) => {
    addRecent(picture.parse(path))
    return getSettings()
  },
  imageDetect: (path, what) => worker.call('imageDetect', anyImage.parse(path), DetectSchema.parse(what)),
  imageSaveEdited: async (png, path, output, destination, previous) => {
    const source = anyImage.parse(path)
    const data = z.instanceof(Uint8Array).refine((d) => d.byteLength > 8 && d.byteLength < 1_500_000_000, 'not a picture').parse(png)
    const old = written.replaceable(replacing.parse(previous))
    return noteWritten(await worker.call<ImageRunResult>('imageSaveEdited', data, source, OutputSchema.parse(output), outputBase(source, DestinationSchema.parse(destination)), old))
  },
  imageFrames: (path, destination) => {
    const source = anyImage.parse(path)
    return worker.call('imageFrames', source, outputBase(source, DestinationSchema.parse(destination)))
  },
  redactFind: (docId, query) =>
    worker.call(
      'redactFind',
      id.parse(docId),
      z.object({ words: z.array(z.string().max(200)).max(200), patterns: z.array(z.enum(['email', 'phone', 'emiratesId', 'iban', 'card', 'date'])).max(6), wholeWords: z.boolean() }).parse(query)
    ),
  redactMarks: (docId) => worker.call('redactMarks', id.parse(docId)),
  createPdf: async (paths, combine) => {
    const files = z
      .array(z.string().max(4000).refine((p) => isAbsolute(p) && CONVERTIBLE.includes(extname(p).toLowerCase()), 'not a file this app can convert'))
      .min(1)
      .max(200)
      .parse(paths)
    const docs: DocInfo[] = []
    const methods: Method[] = []
    // What our own converters could not draw faithfully, said once.
    const notes = new Set<string>()
    for (const file of files) {
      let made: Awaited<ReturnType<typeof fileToPdf>>
      try {
        made = await fileToPdf(file)
      } catch (error) {
        return { ok: false, error: { code: 'unsupported', message: `${basename(file)}: ${(error as Error).message}` } }
      }
      methods.push(made.method)
      for (const n of made.notes ?? []) notes.add(n)
      const doc = await worker.call<DocInfo>('openNew', `${basename(file, extname(file))}.pdf`, made.bytes)
      if (!doc.ok) return doc
      docs.push(doc.value)
    }
    if (combine && docs.length > 1) {
      const merged = await worker.call<DocInfo>('merge', docs.map((d) => ({ docId: d.id })), 'Combined.pdf')
      for (const d of docs) await worker.call('close', d.id)
      if (!merged.ok) return merged
      return { ok: true, value: { docs: [merged.value], methods, notes: [...notes] } }
    }
    return { ok: true, value: { docs, methods, notes: [...notes] } }
  },
  officeApps: () => officeApps(),
  pickConvertible: async (kind) => {
    const all = [
      { name: 'Word, Excel, PowerPoint, web pages, text', extensions: CONVERTIBLE.map((e) => e.slice(1)) },
      { name: 'Word', extensions: ['docx', 'doc', 'rtf', 'odt'] },
      { name: 'Excel', extensions: ['xlsx', 'xls', 'ods', 'csv'] },
      { name: 'PowerPoint', extensions: ['pptx', 'ppt', 'odp'] },
      { name: 'Web page', extensions: ['html', 'htm', 'xhtml'] },
      { name: 'Text', extensions: ['txt', 'md'] }
    ]
    // Word/Excel/PowerPoint to PDF show their own files first.
    const only = z.enum(['word', 'excel', 'powerpoint']).optional().parse(kind)
    const name = only === 'word' ? 'Word' : only === 'excel' ? 'Excel' : only === 'powerpoint' ? 'PowerPoint' : null
    const filters = name ? [all.find((f) => f.name === name)!, ...all.filter((f) => f.name !== name)] : all
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters })
    return r.canceled ? [] : r.filePaths
  },
  pickExportPath: async (suggested, format) => {
    const ext = z.enum(['docx', 'pptx', 'xlsx', 'md', 'txt']).parse(format)
    const names = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', md: 'Markdown', txt: 'Text' } as const
    const base = z.string().max(250).parse(suggested).replace(/\.pdf$/i, '')
    // The scripted smoke run has nobody to answer the save window: its own folder.
    if (smokeFolder) {
      const path = join(smokeFolder, `${base}.${ext}`)
      exportTargets.add(path)
      return path
    }
    const r = await dialog.showSaveDialog(window!, { defaultPath: `${base}.${ext}`, filters: [{ name: names[ext], extensions: [ext] }] })
    if (r.canceled || !r.filePath) return null
    const path = extname(r.filePath).toLowerCase() === `.${ext}` ? r.filePath : `${r.filePath}.${ext}`
    exportTargets.add(path)
    return path
  },
  exportOffice: async (docId, options, path) => {
    // Only a path the person chose in the save window.
    const target = z.string().parse(path)
    if (!exportTargets.has(target)) throw new Error('choose where to save first')
    const opts = z
      .object({
        format: z.enum(['docx', 'pptx', 'xlsx', 'md', 'txt']),
        sheets: z.enum(['page', 'tables']).optional(),
        pages: pages.nullable(),
        pageBreaks: z.boolean(),
        removeTatweel: z.boolean(),
        digits: z.enum(['keep', 'western', 'arabic'])
      })
      .parse(options)
    const r = await worker.call('exportOffice', id.parse(docId), opts, target)
    if (r.ok) converted.add(target)
    return r
  },
  openConverted: async (path) => {
    const target = z.string().parse(path)
    if (converted.has(target) && !smokeFolder) await shell.openPath(target)
  },
  signatures: (docId) => worker.call('signatures', id.parse(docId)),
  documentFonts: (docId) => worker.call('documentFonts', id.parse(docId)),
  // The person asked to look a font up: their own browser searches for its name (the app itself stays offline).
  findFont: async (name) => {
    const font = z.string().min(1).max(200).parse(name)
    await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(`"${font}" font download`)}`)
  },
  detectFields: (docId, page) => worker.call('detectFields', id.parse(docId), z.number().int().min(0).parse(page)),
  runBatch: (files, steps, output) => {
    const step = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('compress'), level: z.enum(['low', 'medium', 'high']) }),
      z.object({ kind: z.literal('ocr'), language: z.enum(['auto', 'ar', 'en']) }),
      z.object({ kind: z.literal('watermark'), text: z.string().min(1).max(500) }),
      z.object({ kind: z.literal('pageNumbers'), template: z.string().min(1).max(100) }),
      z.object({ kind: z.literal('rotate'), angle: z.union([z.literal(90), z.literal(180), z.literal(270)]) }),
      z.object({ kind: z.literal('protect'), password: z.string().min(1).max(127) }),
      z.object({ kind: z.literal('convert'), format: z.enum(['docx', 'xlsx', 'pptx', 'md', 'txt']) })
    ])
    return worker.call(
      'runBatch',
      z.array(pdfPath).min(1).max(2000).parse(files),
      z.array(step).min(1).max(20).parse(steps),
      z.object({ folder: z.string().refine((p) => isAbsolute(p)).nullable(), suffix: z.string().max(60).refine((s) => !/[\/:*?"<>|]/.test(s)) }).parse(output)
    )
  },
  pdfsIn: async (folder) => {
    const dir = z.string().refine((p) => isAbsolute(p)).parse(folder)
    const names = await readdir(dir).catch(() => [] as string[])
    return names.filter((n) => n.toLowerCase().endsWith('.pdf')).map((n) => join(dir, n))
  },
  pickDigitalId: async () => {
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Digital ID', extensions: ['pfx', 'p12'] }] })
    const path = r.canceled ? undefined : r.filePaths[0]
    if (path) updateSettings({ digitalId: path })
    return path ?? null
  },
  createDigitalId: async (details) => {
    const d = z.object({ name: z.string().min(1).max(200), email: z.string().max(200), organisation: z.string().max(200), password: z.string().min(4).max(200) }).parse(details)
    const r = smokeFolder ? { canceled: false, filePath: join(smokeFolder, 'smoke-id.pfx') } : await dialog.showSaveDialog(window!, { defaultPath: join(app.getPath('documents'), `${d.name.replace(/[\\/:*?"<>|]/g, '')}.pfx`), filters: [{ name: 'Digital ID', extensions: ['pfx'] }] })
    if (r.canceled || !r.filePath) return null
    const { createDigitalId } = await import('@engine/sign')
    const bytes = createDigitalId(d.name, d.email, d.organisation, d.password)
    // A new private key: written through an exclusively created file and renamed into place, so a
    // link planted at the chosen name is replaced, never written through (§82).
    const { writeStaged } = await import('../worker/staging')
    await writeStaged(r.filePath, bytes)
    updateSettings({ digitalId: r.filePath })
    return r.filePath
  },
  formFields: (docId, page) => worker.call('formFields', id.parse(docId), page === undefined ? undefined : z.number().int().min(0).parse(page)),
  compare: (a, b, options) => {
    const source = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('doc'), docId: id }),
      z.object({ kind: z.literal('file'), path: pdfPath }),
      z.object({ kind: z.literal('text'), text: z.string().max(20_000_000), name: z.string().max(300) })
    ])
    const opts = z.object({ ignoreMarks: z.boolean(), ignorePunctuation: z.boolean(), sameDigits: z.boolean() }).parse(options)
    return worker.call('compare', source.parse(a), source.parse(b), opts)
  },
  comparePage: (token, side, page, scale) => worker.call('comparePage', z.string().uuid().parse(token), z.enum(['a', 'b']).parse(side), z.number().int().min(0).parse(page), z.number().min(0.05).max(4).parse(scale)),
  compareClose: async (token) => {
    await worker.call('compareClose', z.string().uuid().parse(token))
  },
  pickTextFile: async () => {
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt', 'md', 'csv', 'text'] }] })
    const file = r.canceled ? undefined : r.filePaths[0]
    if (!file) return null
    if (statSync(file).size > 20 * 1024 * 1024) return null
    return { name: basename(file), text: await readFile(file, 'utf8') }
  },
  newBlank: (width, height, count, name) =>
    worker.call('newBlank', z.number().min(72).max(14400).parse(width), z.number().min(72).max(14400).parse(height), z.number().int().min(1).max(500).parse(count), z.string().min(1).max(200).parse(name)),
  newFromTemplate: (path, name) => worker.call('openCopy', pdfPath.parse(path), z.string().min(1).max(200).parse(name)),
  templates: () => listTemplates(),
  addTemplates: async () => {
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (!r.canceled) {
      await mkdir(templatesFolder(), { recursive: true })
      for (const file of r.filePaths) {
        let target = join(templatesFolder(), basename(file))
        for (let n = 2; existsSync(target); n++) target = join(templatesFolder(), `${basename(file, extname(file))} (${n}).pdf`)
        await copyFile(file, target)
      }
    }
    return listTemplates()
  },
  removeTemplate: async (path) => {
    const file = z.string().max(4000).parse(path)
    // Only files in the templates folder itself can be removed this way.
    if (dirname(file) === templatesFolder()) await rm(file, { force: true })
    return listTemplates()
  },
  split: (docId, ranges, target) => worker.call('split', id.parse(docId), z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).min(1).max(10_000).parse(ranges), folder.parse(target)),
  printers: async () => ({ ok: true, value: await printers() }),
  // The printer's own preferences window, only for a printer Windows lists (the name is passed as one argument, no shell).
  printerPreferences: async (name) => {
    const printer = z.string().min(1).max(300).parse(name)
    if (!(await printers()).some((p) => p.name === printer)) return { ok: false, error: { code: 'bad-arguments', message: 'That printer is not set up on this PC.' } }
    if (!smokeFolder) await printerPreferences(printer)
    return { ok: true, value: true }
  },
  printerSettings: async () => {
    if (!smokeFolder) await shell.openExternal('ms-settings:printers')
    return { ok: true, value: true }
  },
  // Printing respects the author's restriction, as reading programs do (§23).
  printDoc: async (docId, options, sizes) => {
    const docIdOk = id.parse(docId)
    const opts = z
      .object({
        printer: z.string().min(1).max(300),
        copies: z.number().int().min(1).max(999),
        pages,
        fit: z.enum(['fit', 'shrink', 'actual', 'custom']),
        scale: z.number().min(10).max(400),
        perSheet: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]),
        annotations: z.boolean(),
        paper: z.enum(['default', 'A4', 'Letter', 'Legal', 'A3', 'A5', 'Tabloid']),
        system: z.boolean(),
        orientation: z.enum(['auto', 'portrait', 'landscape']),
        grayscale: z.boolean(),
        duplex: z.enum(['simplex', 'longEdge', 'shortEdge'])
      })
      .parse(options)
    const dims = z.array(z.tuple([z.number().positive(), z.number().positive()])).parse(sizes)
    const info = await worker.call('info', docIdOk)
    if (!info.ok) return info
    const rights = (info.value as { rights?: { print?: boolean } }).rights
    if (rights && rights.print === false) return { ok: false, error: { code: 'restricted', message: 'The author of this PDF does not allow printing.' } }
    try {
      await printPages(opts, dims, async (target, dpi) => {
        const r = await worker.call('exportImages', docIdOk, opts.pages, 'jpeg', dpi, target, opts.annotations ? 'print' : 'print-none')
        if (!r.ok) throw new Error(r.error.message)
        return r.value as string[]
      }, smokeFolder ? join(smokeFolder, 'printed.pdf') : undefined)
      return { ok: true, value: true }
    } catch (error) {
      // Cancelled in Windows' print dialog: nothing to report.
      if ((error as Error).message === 'cancelled') return { ok: true, value: false }
      return { ok: false, error: { code: 'io', message: (error as Error).message } }
    }
  },
  exportImages: (docId, list, format, dpi, target) =>
    worker.call('exportImages', id.parse(docId), pages.nullable().parse(list), z.enum(['png', 'jpeg']).parse(format), z.number().min(36).max(600).parse(dpi), folder.parse(target)),

  pickPdfs: async (multiple) => {
    const r = await dialog.showOpenDialog(window!, { properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    return r.canceled ? [] : r.filePaths
  },
  // Open… (Ctrl+O, the title bar, Home): PDFs and pictures together; each opens in its viewer (§75).
  pickOpenable: async () => {
    const pdf = ['pdf']
    const pictures = PICTURE_EXTENSIONS.slice()
    const r = await dialog.showOpenDialog(window!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDFs and pictures', extensions: [...pdf, ...pictures] }, { name: 'PDF', extensions: pdf }, { name: 'Pictures', extensions: pictures }]
    })
    return r.canceled ? [] : r.filePaths.filter((p) => OPENABLE_EXTENSIONS.has(extname(p).toLowerCase()))
  },
  pickImages: async (pdf) => {
    const pictures = [...IMAGE_EXTENSIONS].map((e) => e.slice(1))
    const filters = pdf === true ? [{ name: 'Pictures and PDFs', extensions: [...pictures, 'pdf'] }, { name: 'Pictures', extensions: pictures }, { name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Pictures', extensions: pictures }]
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters })
    return r.canceled ? [] : r.filePaths
  },
  pickAnyImages: async () => {
    const extensions = [...ANY_IMAGE_EXTENSIONS].map((e) => e.slice(1))
    const r = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Pictures', extensions }, { name: '*', extensions: ['*'] }] })
    return r.canceled ? [] : r.filePaths.filter((p) => ANY_IMAGE_EXTENSIONS.has(extname(p).toLowerCase()))
  },
  pickSavePath: async (suggested) => {
    const name = z.string().max(250).parse(suggested)
    const r = await dialog.showSaveDialog(window!, { defaultPath: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return null
    return extname(r.filePath).toLowerCase() === '.pdf' ? r.filePath : `${r.filePath}.pdf`
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  showInFolder: (path) => shell.showItemInFolder(z.string().parse(path)),
  fileInfo: (paths) =>
    z
      .array(z.string().max(4000))
      .max(100)
      .parse(paths)
      .map((path) => {
        try {
          const s = statSync(path)
          return { path, size: s.size, modified: s.mtimeMs }
        } catch {
          return { path, size: null, modified: null }
        }
      }),
  openLink: (url) => {
    // Asked in the window first (§81); checked again here so no document gets past the rules.
    const link = safeLink(z.string().max(4096).parse(url))
    if (!link) return false
    void shell.openExternal(link.url)
    return true
  },
  openExternal: (url) => {
    const u = z.string().url().parse(url)
    // Only the project's own pages (source and releases): nothing a document could smuggle in.
    if (isProjectUrl(u)) return shell.openExternal(u)
  },

  getSettings: () => getSettings(),
  setSettings: (patch) => {
    const p = z
      .object({
        language: z.enum(['en', 'ar']),
        theme: z.enum(['system', 'light', 'dark']),
        checkForUpdates: z.boolean(),
        recentTab: z.enum(['pdf', 'image']),
        signatures: z.array(SignatureSchema).max(MAX_SIGNATURES),
        quickHidden: z.array(z.string().max(20)).max(20),
        singleKeys: z.boolean(),
        saveMode: z.enum(['copy', 'replace']),
        saveFolder: z.string().max(4000).refine((p) => p === '' || isAbsolute(p), 'not an absolute folder'),
        authorName: z.string().max(120),
        places: z.array(PlaceSchema.refine((p) => isAbsolute(p.path), 'not an absolute folder')).max(30),
        defaultZoom: z.enum(['width', 'page', '100']),
        spellCheck: z.boolean(),
        trustedLinkHosts: z.array(z.string().min(1).max(253)).max(MAX_TRUSTED_HOSTS),
        workflows: z.array(z.object({ name: z.string().min(1).max(100), steps: z.array(z.any()).max(20), suffix: z.string().max(60) })).max(50)
      })
      .partial()
      .parse(patch)
    const before = getSettings().checkForUpdates
    const next: Settings = updateSettings(p)
    if (next.checkForUpdates !== before) updater.schedule(BRAND.online && next.checkForUpdates)
    return next
  },
  forgetRecent: (path, kind) => forgetRecent(z.string().optional().parse(path), z.enum(['pdf', 'image']).optional().parse(kind)),
  places: () => {
    const linked = getSettings().places.filter((p) => exists(p.path)).map((p) => ({ ...p, kind: 'folder' as const, detected: false }))
    return [...detectedPlaces(), ...linked]
  },
  listFolder: (path) => listFolder(folder.parse(path)),
  /** A free file name for a copy: "name (edited).pdf", then "(edited 2)"… */
  copyPath: (original, target) => {
    const src = z.string().refine((p) => isAbsolute(p)).parse(original)
    const dir = target ? folder.parse(target) : dirname(src)
    const stem = basename(src).replace(/\.pdf$/i, '').replace(/ \(edited(?: \d+)?\)$/, '')
    for (let n = 1; n < 1000; n++) {
      const candidate = join(dir, `${stem} (edited${n > 1 ? ` ${n}` : ''}).pdf`)
      if (!exists(candidate)) return candidate
    }
    return join(dir, `${stem} (edited ${Date.now()}).pdf`)
  },
  /** The person chose to close the window from the app's own dialog. */
  quit: () => {
    allowClose = true
    window?.close()
  },
  checkForUpdates: async () => (BRAND.online ? updater.check() : undefined),
  downloadUpdate: async () => (BRAND.online ? updater.download() : undefined),
  installUpdate: () => {
    allowClose = true
    updater.install()
  },
  updateState: () => updater.current()
}

ipcMain.handle(IPC.call, async (_event, method: unknown, args: unknown) => {
  const fn = typeof method === 'string' ? handlers[method] : undefined
  if (!fn || !Array.isArray(args)) return { ok: false, error: { code: 'bad-arguments', message: 'Unknown request.' } }
  try {
    return await fn(...args)
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, error: { code: 'bad-arguments', message: error.issues.map((i) => i.message).join('; ') } }
    return { ok: false, error: { code: 'internal', message: (error as Error).message } }
  }
})

// Dragging a readied file out of the window, into an email, a chat or a folder.
ipcMain.on(IPC.dragOut, (event, path: unknown) => {
  const icon = typeof path === 'string' ? shareable.get(path) : undefined
  if (icon && typeof path === 'string') event.sender.startDrag({ file: path, icon })
})

ipcMain.on(IPC.unsaved, (_event, value: unknown) => {
  const parsed = z
    .object({ count: z.number().int().min(0), prompt: z.object({ title: z.string(), message: z.string(), discard: z.string(), cancel: z.string() }) })
    .safeParse(value)
  if (parsed.success) unsaved = parsed.data
})

// --- the window --------------------------------------------------------------------

function createWindow(): void {
  window = new BrowserWindow({
    width: Number(process.env.POWERPDF_SMOKE_WIDTH) || 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: BRAND.name,
    backgroundColor: '#f6f7f9',
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !smokeFolder,
      additionalArguments: [`--powerpdf-version=${app.getVersion()}`, `--powerpdf-system=${systemLabel(process.platform, process.getSystemVersion())}`]
    }
  })

  window.once('ready-to-show', () => window?.show())
  window.webContents.on('did-finish-load', () => {
    const first = !rendererReady
    rendererReady = true
    if (pendingFiles.length) send(IPC.openFiles, pendingFiles.splice(0))
    send(IPC.update, updater.current())
    if (first && smokeFolder && window) void runSmoke(window, (paths) => openFiles(requestsIn(paths)))
  })
  // The interface never navigates, and never opens windows; links to the project open in the browser.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isProjectUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.on('close', (event) => {
    if (allowClose || unsaved.count === 0) return
    event.preventDefault()
    // The app asks in its own dialog (save, don't save, cancel), and calls quit() if it may close.
    if (rendererReady) {
      window?.webContents.send(IPC.confirmQuit)
      return
    }
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'warning',
      title: unsaved.prompt.title,
      message: unsaved.prompt.message,
      buttons: [unsaved.prompt.discard, unsaved.prompt.cancel],
      defaultId: 1,
      cancelId: 1
    })
    if (choice === 0) {
      allowClose = true
      window?.close()
    }
  })
  window.on('closed', () => {
    window = null
    rendererReady = false
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

function applicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  // macOS needs a menu for copy and paste to work in text fields at all.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
}

app.whenReady().then(() => {
  // Shared copies from earlier days are no longer needed.
  cleanShareFolder()
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  if (smokeFolder) {
    const language = process.env.POWERPDF_SMOKE_LANG === 'ar' ? 'ar' : 'en'
    const theme = process.env.POWERPDF_SMOKE_THEME === 'dark' ? 'dark' : 'light'
    updateSettings({ language, theme, checkForUpdates: false })
  }

  protocol.handle(PAGE_SCHEME, async (request) => {
    // pdfpage://doc/<id>/<revision>/<page>/<scale>[/<w>x<h>] (pageUrl in shared/ipc.ts)
    const at = pageAddress(new URL(request.url).pathname)
    if (!at) return new Response('Not a page address', { status: 404 })
    // An exact size (pixel for pixel on screen, §82) is held to what the scale cap allows.
    const size = at.size && at.size[0] * at.size[1] <= 120_000_000 ? at.size : undefined
    const r = await worker.call<{ data: Uint8Array; mime: string }>('render', at.docId, at.revision, at.page, Math.min(8, Math.max(0.05, at.scale)), ...(size ? [size] : []))
    if (!r.ok) return new Response(r.error.message, { status: 404 })
    return new Response(Buffer.from(r.value.data), { headers: { 'content-type': r.value.mime, 'cache-control': 'max-age=31536000, immutable' } })
  })

  applicationMenu()
  createWindow()
  updater.schedule(BRAND.online && getSettings().checkForUpdates)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  worker.stop()
  if (process.platform !== 'darwin') app.quit()
})


import { systemFontFamilies } from '@engine/systemFonts'
import { PdfError } from '@engine/errors'
import { setFontDirectory } from '@engine/fonts'
import { Sessions } from './sessions'
import { runBatch } from './batch'
import { imageAnimate, imageDecode, imageDescribe, imageDetect, imageFrames, imageMetadata, imageRun, imageSaveEdited } from './images'

/**
 * The worker: a separate process (Electron's utilityProcess) that owns every open
 * document and does all PDF work, so the window never freezes while a big file is
 * compressed or a page is rendered (docs/architecture.md).
 *
 * Messages in:  { id, method, args }
 * Messages out: { id, ok: true, value } | { id, ok: false, error: { code, message } }
 *               { progress: { task, fraction, message? } | null }
 */

interface Call {
  id: number
  method: string
  args: unknown[]
}

if (process.env.POWERPDF_RESOURCES) setFontDirectory(`${process.env.POWERPDF_RESOURCES}/fonts`)

const sessions = new Sessions()
const port = process.parentPort

function progress(task: string) {
  return (fraction: number, message?: string): void => port.postMessage({ progress: { task, fraction, message } })
}

const methods: Record<string, (...args: never[]) => unknown> = {
  open: (path: string, password?: string) => sessions.openFile(path, password),
  fileThumbnail: (path: string, width: number) => sessions.fileThumbnail(path, width),
  close: (id: string) => sessions.close(id),
  info: (id: string) => sessions.info(id),
  render: (id: string, revision: number, page: number, scale: number, size?: [number, number]) => sessions.render(id, revision, page, scale, size),
  search: (id: string, query: string, options: { matchCase?: boolean; wholeWords?: boolean }) => sessions.search(id, query, options),
  pageText: (id: string, page: number) => sessions.pageText(id, page),
  selectText: (id: string, page: number, from: never, to: never, unit: never) => sessions.selectText(id, page, from, to, unit),
  preview: (id: string, op: never, page: number, scale: number) => sessions.preview(id, op, page, scale),
  pageParagraphs: (id: string, page: number) => sessions.pageParagraphs(id, page),
  paragraphFonts: (id: string, page: number, family: string) => sessions.paragraphFonts(id, page, family),
  pagePictures: (id: string, page: number) => sessions.pagePictures(id, page),
  whiteMargins: (id: string, page: number) => sessions.whiteMargins(id, page),
  systemFonts: () => systemFontFamilies(),
  pageMarkups: (id: string, page: number) => sessions.pageMarkups(id, page),
  outline: (id: string) => sessions.outline(id),
  pageLinks: (id: string, page: number) => sessions.pageLinks(id, page),
  apply: (id: string, op: never) => sessions.apply(id, op, { progress: progress('apply') }),
  undo: (id: string) => sessions.undo(id),
  redo: (id: string) => sessions.redo(id),
  authorize: (id: string, password: string) => sessions.authorize(id, password),
  save: (id: string, path?: string) => sessions.save(id, path),
  shareCopy: (id: string, folder: string) => sessions.shareCopy(id, folder),
  extract: (id: string, pages: number[]) => sessions.extract(id, pages),
  merge: (items: never, name: string) => sessions.merge(items, name),
  imagesToPdf: (paths: string[], options: never, name: string) => sessions.imagesToPdf(paths, options, name),
  scanDetect: (path: string, book: boolean) => sessions.scanDetect(path, book),
  scanFold: (item: never) => sessions.scanFold(item),
  scanPreview: (item: never) => sessions.scanPreview(item),
  scanPdfPages: (path: string, folder: string) => sessions.scanPdfPages(path, folder),
  scanToPdf: (items: never[], goal: 'pages' | 'idcard' | 'book', paper: 'a4' | 'letter' | 'fit', name: string, rtl: boolean) => sessions.scanToPdf(items, goal, paper, name, rtl),
  openNew: (name: string, bytes: Uint8Array) => sessions.openBytes(name, bytes),
  exportOffice: (id: string, options: never, path: string) => sessions.exportOffice(id, options, path),
  signatures: (id: string) => sessions.signatures(id),
  documentFonts: (id: string) => sessions.documentFonts(id),
  detectFields: (id: string, page: number) => sessions.detectFields(id, page),
  runBatch: (files: string[], steps: never, output: never) => runBatch(files, steps, output, progress('batch')),
  formFields: (id: string, page?: number) => sessions.formFields(id, page),
  redactFind: (id: string, query: never) => sessions.redactFind(id, query),
  redactMarks: (id: string) => sessions.redactMarks(id),
  compare: (a: never, b: never, options: never) => sessions.compare(a, b, options),
  comparePage: (token: string, side: 'a' | 'b', page: number, scale: number) => sessions.comparePage(token, side, page, scale),
  compareClose: (token: string) => sessions.compareClose(token),
  newBlank: (width: number, height: number, count: number, name: string) => sessions.newBlank(width, height, count, name),
  openCopy: (path: string, name: string) => sessions.openCopy(path, name),
  split: (id: string, ranges: Array<[number, number]>, folder: string) => sessions.split(id, ranges, folder),
  // image tools (decisions §69)
  imageDescribe: (path: string, size?: number) => imageDescribe(path, size),
  imageMetadata: (path: string) => imageMetadata(path),
  imageRun: (path: string, job: never, base: string, replacing?: string | null) => imageRun(path, job, base, replacing, progress('image')),
  imageDetect: (path: string, what: never) => imageDetect(path, what),
  imageAnimate: (paths: string[], options: never, base: string, replacing?: string | null) => imageAnimate(paths, options, base, replacing),
  imageFrames: (path: string, base: string) => imageFrames(path, base),
  imageDecode: (path: string) => imageDecode(path),
  imageSaveEdited: (png: Uint8Array, source: string, output: never, base: string, replacing?: string | null) => imageSaveEdited(png, source, output, base, replacing),
  exportImages: (id: string, pages: number[] | null, format: 'png' | 'jpeg', dpi: number, folder: string, annotations?: boolean | 'print' | 'print-none') =>
    sessions.exportImages(id, pages, format, dpi, folder, progress('exportImages'), annotations ?? true)
}

/**
 * MuPDF.js frees its object handles in finalizers, which run only after JavaScript collects
 * garbage — and JavaScript sees each handle as a few bytes while it holds WASM memory (a font
 * dictionary, a page tree). Without a collection, a long session of edits on a newspaper grew until
 * "malloc failed". So the worker collects once it goes quiet after a request.
 */
let collect: ReturnType<typeof setTimeout> | null = null
const collectSoon = (): void => {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) return
  if (collect) clearTimeout(collect)
  collect = setTimeout(() => {
    collect = null
    gc()
  }, 200)
}

port.on('message', async (event: { data: Call }) => {
  const { id, method, args } = event.data
  try {
    const fn = methods[method]
    if (!fn) throw new PdfError('bad-arguments', `Unknown method ${method}`)
    const value = await (fn as (...a: unknown[]) => unknown)(...args)
    port.postMessage({ id, ok: true, value })
  } catch (error) {
    const code = error instanceof PdfError ? error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'internal') console.error(`worker: ${method} failed`, error)
    // A sentence of the interface's own, when the engine named one (see src/ops withKey).
    const keyed = error as { key?: unknown; values?: unknown }
    const extra = typeof keyed.key === 'string' ? { key: keyed.key, ...(keyed.values && typeof keyed.values === 'object' ? { values: keyed.values } : {}) } : {}
    port.postMessage({ id, ok: false, error: { code, message, ...extra } })
  } finally {
    if (method === 'apply' || method === 'exportImages' || method === 'runBatch' || method === 'imageRun') port.postMessage({ progress: null })
    collectSoon()
  }
})

port.postMessage({ ready: true })

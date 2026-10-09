import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { sniff } from '@engine/img/sniff'
import { openBytes, pagesAsPng } from '@engine/img/picture'
import { basename, dirname, extname, join } from 'node:path'
import { writeStaged } from './staging'
import { diffWords, pdfWords, textWords } from '@engine/compare'
import { exportOffice, type OfficeFormat } from '@engine/office'
import { documentFonts, embeddedFaces, installedFamily, type DocFont } from '@engine/docfonts'
import { detectFormFields, formFields, xfaKind, type FormField, type NewField } from '@engine/forms'
import { mayBeSigned, verifySignatures, type SignatureInfo } from '@engine/sign'
import { findToRedact, redactionMarks, type RedactHit, type RedactPattern } from '@engine/redact'
import type { ApplyResult, CompareOptions, CompareResult, CompareSide, CompareSource, DocInfo, ImagesToPdfOptions, MarkupInfo, MergeItem, OutlineItem, PageLink, ParagraphInfo, PictureInfo, SearchHit, TextLineInfo } from '@shared/ipc'
import { pageParagraphs } from '@engine/edit'
import { styledLines } from '@engine/paragraphs'
import { browserFont } from '@engine/webfont'
import { pageMarkups } from '@engine/markup'
import { documentOutline, pageLinks } from '@engine/navigation'
import { pagePictures } from '@engine/pictures'
import type { OpInput } from '@shared/ops'
import { BRAND } from '@shared/brand'
import { PdfError } from '@engine/errors'
import { imagesToPdf, pdfToImages } from '@engine/images'
import { free, needsOpenPassword, openPdf, rightsOf, saveBytes, SAVE_FINAL, type PdfDoc } from '@engine/mupdf'
import { keepPages, mergePdfs, splitByRanges, blankPdf } from '@engine/pages'
import { pageGeometry, renderPage, whiteMargins, type RenderedPage } from '@engine/render'
import { extractLines, searchLines, selectText, type Selection, type SelectUnit, type TextLine } from '@engine/text'
import { applyOperation, type OpContext } from '@ops/index'
import { detectFold, detectPicture, idCardPage, scanBookPicture, scanPicture, type Corners, type ScannedImage } from '@engine/scan'
import type { ScanItem } from '@shared/ipc'

/**
 * The open documents, each with its history.
 *
 * A session holds the current bytes plus one open MuPDF document for rendering and
 * text. Every change produces new bytes (operations are pure, decisions §5) and the
 * old bytes go on the undo stack. The stack is bounded by count and total size so
 * a long editing session on a big file cannot exhaust memory on a modest PC.
 *
 * Nothing here knows about Electron, so it is tested directly (test/sessions.test.ts).
 */

const UNDO_STEPS = 30
const UNDO_BYTES = 400 * 1024 * 1024
const RENDER_CACHE = 48

/**
 * A state of the document: its bytes, a stamp that identifies exactly those bytes,
 * and the password that opens them. The password belongs to the version, not the
 * session: undoing "Protect" returns bytes that need a different one, or none.
 */
interface Version {
  bytes: Uint8Array
  stamp: number
  password: string | undefined
}

let stamps = 0

interface Session {
  id: string
  name: string
  path: string | null
  bytes: Uint8Array
  /** Open password, or permissions password given with `authorize`. */
  password?: string
  /** The file needs a password to open at all. */
  hasOpenPassword: boolean
  doc: PdfDoc
  /** Identifies the current bytes; "unsaved" means it differs from savedStamp. */
  stamp: number
  savedStamp: number
  undo: Version[]
  redo: Version[]
  /**
   * Only ever increases, including on undo. It is part of every page picture's
   * address, so an address never stands for two different pictures.
   */
  revision: number
}

export class Sessions {
  private readonly sessions = new Map<string, Session>()
  /** Open comparisons: the PDF of each side, kept for its page pictures until closed. */
  private readonly comparisons = new Map<string, { a: PdfDoc | null; b: PdfDoc | null }>()
  private readonly renders = new Map<string, RenderedPage>()

  // --- opening and closing --------------------------------------------------

  /**
   * The first page of a file on disk as a small picture, and its page count, without opening
   * it as a document: the file tiles of Combine files. A protected file answers `locked`.
   */
  async fileThumbnail(path: string, width: number): Promise<{ pages: number; image: RenderedPage | null; locked: boolean }> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new PdfError('bad-arguments', `The file could not be read: ${(error as Error).message}`)
    }
    let doc: PdfDoc
    try {
      doc = openPdf(bytes)
    } catch (error) {
      if (error instanceof PdfError && error.code === 'password-required') return { pages: 0, image: null, locked: true }
      throw error
    }
    try {
      const g = pageGeometry(doc, 0)
      return { pages: doc.countPages(), image: renderPage(doc, 0, { scale: width / g.width, format: 'jpeg', quality: 80 }), locked: false }
    } finally {
      free(doc)
    }
  }

  async openFile(path: string, password?: string): Promise<DocInfo> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new PdfError('bad-arguments', `The file could not be read: ${(error as Error).message}`)
    }
    // The same file opened twice is the same tab.
    for (const s of this.sessions.values()) if (s.path === path) return this.info(s)
    return this.info(this.create(basename(path), path, bytes, password))
  }

  /** A new, unsaved document (the result of merge, extract, images to PDF). */
  openBytes(name: string, bytes: Uint8Array): DocInfo {
    const s = this.create(name, null, bytes)
    s.savedStamp = -1
    return this.info(s)
  }

  private create(name: string, path: string | null, bytes: Uint8Array, password?: string): Session {
    const doc = openPdf(bytes, password)
    const session: Session = {
      id: randomUUID(),
      name,
      path,
      bytes,
      password: password || undefined,
      hasOpenPassword: needsOpenPassword(doc),
      doc,
      stamp: ++stamps,
      savedStamp: 0,
      undo: [],
      redo: [],
      revision: 0
    }
    session.savedStamp = session.stamp
    this.sessions.set(session.id, session)
    return session
  }

  close(id: string): void {
    const s = this.get(id)
    free(s.doc)
    this.sessions.delete(id)
    this.dropRenders(id)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  // --- reading ---------------------------------------------------------------

  info(target: Session | string): DocInfo {
    const s = typeof target === 'string' ? this.get(target) : target
    const count = s.doc.countPages()
    const pages = Array.from({ length: count }, (_, i) => {
      const g = pageGeometry(s.doc, i)
      return { width: g.width, height: g.height }
    })
    const r = rightsOf(s.doc)
    return {
      id: s.id,
      name: s.name,
      path: s.path,
      pages,
      revision: s.revision,
      dirty: s.stamp !== s.savedStamp,
      canUndo: s.undo.length > 0,
      canRedo: s.redo.length > 0,
      rights: { encrypted: r.encrypted, full: r.full, edit: r.edit, assemble: r.assemble, copy: r.copy, print: r.print },
      hasOpenPassword: s.hasOpenPassword,
      bytes: s.bytes.length,
      meta: {
        title: s.doc.getMetaData('info:Title') ?? '',
        author: s.doc.getMetaData('info:Author') ?? '',
        subject: s.doc.getMetaData('info:Subject') ?? '',
        keywords: s.doc.getMetaData('info:Keywords') ?? ''
      },
      ...((x) => (x ? { xfa: x } : {}))(xfaKind(s.doc))
    }
  }

  render(id: string, revision: number, page: number, scale: number, size?: [number, number]): RenderedPage {
    const s = this.get(id)
    const key = `${id}/${revision}/${page}/${scale}${size ? `/${size[0]}x${size[1]}` : ''}`
    const cached = this.renders.get(key)
    if (cached) {
      // Most recently used goes to the back.
      this.renders.delete(key)
      this.renders.set(key, cached)
      return cached
    }
    if (revision !== s.revision) throw new PdfError('bad-arguments', 'That version of the document is gone.')
    if (page < 0 || page >= s.doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const rendered = renderPage(s.doc, page, { scale, format: 'auto', quality: 88, ...(size ? { size } : {}) })
    this.renders.set(key, rendered)
    while (this.renders.size > RENDER_CACHE) this.renders.delete(this.renders.keys().next().value!)
    return rendered
  }

  search(id: string, query: string, options: { matchCase?: boolean; wholeWords?: boolean } = {}): SearchHit[] {
    const s = this.get(id)
    const hits: SearchHit[] = []
    const count = s.doc.countPages()
    for (let p = 0; p < count && hits.length < 1000; p++) hits.push(...searchLines(extractLines(s.doc, p), query, p, 1000 - hits.length, options))
    return hits
  }

  pageParagraphs(id: string, page: number): ParagraphInfo[] {
    return pageParagraphs(this.get(id).doc, page)
  }

  /** A paragraph's font faces from the file, as data URLs, for typing in them (§66). */
  paragraphFonts(id: string, page: number, family: string): { installed: string | null; faces: Array<{ bold: boolean; italic: boolean; url: string }> } {
    const installed = installedFamily(family)
    if (installed) return { installed, faces: [] }
    const doc = this.get(id).doc
    // Each font of the family on the page, made into one the editor can show (§66).
    const lines = styledLines(doc, page)
    const fonts = new Map<string, { bold: boolean; italic: boolean; seen: Set<number> }>()
    for (const l of lines)
      for (const r of l.runs) {
        if (r.family !== family || !r.font) continue
        const f = fonts.get(r.font) ?? { bold: r.bold, italic: r.italic, seen: new Set<number>() }
        for (const c of r.text) f.seen.add(c.codePointAt(0)!)
        fonts.set(r.font, f)
      }
    const faces: Array<{ bold: boolean; italic: boolean; url: string }> = []
    const done = new Set<string>()
    // The face used most first, so it is the one kept for its weight.
    for (const [name, f] of [...fonts].sort((a, b) => b[1].seen.size - a[1].seen.size)) {
      const key = `${f.bold}|${f.italic}`
      if (done.has(key)) continue
      const bytes = browserFont(doc, page, name, f.seen, { bold: f.bold, italic: f.italic, family })
      if (!bytes) continue
      done.add(key)
      faces.push({ bold: f.bold, italic: f.italic, url: `data:font/${bytes[0] === 0x4f ? 'otf' : 'ttf'};base64,${Buffer.from(bytes).toString('base64')}` })
    }
    if (faces.length) return { installed: null, faces }
    return { installed: null, faces: embeddedFaces(doc, page, family).map((f) => ({ bold: f.bold, italic: f.italic, url: `data:font/${f.kind === 'truetype' ? 'ttf' : 'otf'};base64,${Buffer.from(f.bytes).toString('base64')}` })) }
  }

  pageMarkups(id: string, page: number): MarkupInfo[] {
    return pageMarkups(this.get(id).doc, page)
  }

  /** The bookmarks (read only). */
  outline(id: string): OutlineItem[] {
    return documentOutline(this.get(id).doc)
  }

  pageLinks(id: string, page: number): PageLink[] {
    return pageLinks(this.get(id).doc, page)
  }

  /** The page's white margins, for Crop's "Trim white margins". */
  whiteMargins(id: string, page: number): { left: number; top: number; right: number; bottom: number } {
    const s = this.get(id)
    if (page < 0 || page >= s.doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    return whiteMargins(s.doc, page)
  }

  pagePictures(id: string, page: number): PictureInfo[] {
    return pagePictures(this.get(id).doc, page)
  }

  /**
   * What one page would look like after `op`, without changing the document: the live
   * preview in tool panels (watermark, page numbers, crop, rotate), as Acrobat's dialogs
   * show. Only that page is changed, so it is quick on long documents.
   */
  async preview(id: string, op: OpInput, page: number, scale: number): Promise<RenderedPage> {
    const s = this.get(id)
    if (page < 0 || page >= s.doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const one = { ...op, pages: [page] } as OpInput
    const result = await applyOperation(s.bytes, one, { password: s.password })
    const doc = openPdf(result.bytes, s.password)
    try {
      return renderPage(doc, page, { scale, format: 'jpeg', quality: 85 })
    } finally {
      free(doc)
    }
  }

  /** Lines of text per page, kept while the pointer drags a selection (the page does not change meanwhile). */
  private lineCache = new Map<string, TextLine[]>()

  private linesOf(id: string, page: number): TextLine[] {
    const s = this.get(id)
    if (page < 0 || page >= s.doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const key = `${id}/${s.revision}/${page}`
    let lines = this.lineCache.get(key)
    if (!lines) {
      lines = extractLines(s.doc, page)
      this.lineCache.set(key, lines)
      while (this.lineCache.size > 24) this.lineCache.delete(this.lineCache.keys().next().value!)
    }
    return lines
  }

  /** Text selection on a page (docs/decisions.md §33). */
  selectText(id: string, page: number, from: [number, number], to: [number, number], unit: SelectUnit): Selection | null {
    return selectText(this.linesOf(id, page), from, to, unit)
  }

  pageText(id: string, page: number): TextLineInfo[] {
    const s = this.get(id)
    return extractLines(s.doc, page).map((l) => ({ text: l.text, box: l.box }))
  }

  // --- changing ----------------------------------------------------------------

  async apply(id: string, op: OpInput, ctx: Omit<OpContext, 'password'> = {}): Promise<ApplyResult> {
    const s = this.get(id)
    // Protecting: the session must still be able to open, and change, what it just encrypted.
    // Without a permissions password from the person, one is made up and kept for this
    // session only, so they keep full control while editing and the saved file has exactly
    // the restrictions they chose (docs/decisions.md §21).
    let password = s.password
    if (op.op === 'protect') {
      const ownerPassword = op.ownerPassword || randomBytes(24).toString('base64url')
      op = { ...op, ownerPassword }
      password = ownerPassword
    }
    // After Unlock the bytes need no password at all.
    if (op.op === 'unlock') password = undefined
    const result = await applyOperation(s.bytes, op, { ...ctx, password: s.password })
    // Nothing changed (a highlight over no text): no undo step, just the note.
    if (result.bytes === s.bytes) return { doc: this.info(s), note: result.note }
    this.replace(s, { bytes: result.bytes, stamp: ++stamps, password })
    return { doc: this.info(s), note: result.note }
  }

  undo(id: string): DocInfo {
    const s = this.get(id)
    const previous = s.undo.pop()
    if (!previous) return this.info(s)
    s.redo.push(current(s))
    this.load(s, previous)
    return this.info(s)
  }

  redo(id: string): DocInfo {
    const s = this.get(id)
    const next = s.redo.pop()
    if (!next) return this.info(s)
    s.undo.push(current(s))
    this.load(s, next)
    return this.info(s)
  }

  /** Checks a permissions password and keeps it for this session's changes. */
  authorize(id: string, password: string): DocInfo {
    const s = this.get(id)
    const doc = openPdf(s.bytes, password)
    const full = rightsOf(doc).full
    free(doc)
    if (!full) throw new PdfError('wrong-password', 'That password opens the file but does not lift its restrictions.')
    // Earlier and later versions encrypted the same way open with it too.
    const before = s.password
    for (const v of [...s.undo, ...s.redo]) if (v.password === before) v.password = password
    this.load(s, { bytes: s.bytes, stamp: s.stamp, password })
    return this.info(s)
  }

  /**
   * Writes the document. Written to a temporary file beside the target first and then
   * renamed over it, so a failure half-way never leaves a damaged file behind.
   */
  async save(id: string, path?: string): Promise<DocInfo> {
    const s = this.get(id)
    const target = path ?? s.path
    if (!target) throw new PdfError('bad-arguments', 'Choose where to save this document.')
    const doc = openPdf(s.bytes, s.password)
    let out: Uint8Array
    try {
      out = saveBytes(doc, SAVE_FINAL)
    } finally {
      free(doc)
    }
    // Through a temporary file created exclusively under a random name: a failed save (disk full,
    // the file open in another program) leaves nothing behind (P9), and a file or link planted at
    // the temporary name is never written through (§82).
    await writeStaged(target, out)
    s.path = target
    s.name = basename(target)
    s.savedStamp = s.stamp
    return this.info(s)
  }

  /**
   * The file to share: the document on disk when it has no unsaved changes; otherwise a copy
   * with the changes, under its own name, in `folder` (Share never forces a save).
   */
  async shareCopy(id: string, folder: string): Promise<{ path: string; temporary: boolean; bytes: number }> {
    const s = this.get(id)
    if (s.path && s.savedStamp === s.stamp) return { path: s.path, temporary: false, bytes: s.bytes.length }
    const doc = openPdf(s.bytes, s.password)
    let out: Uint8Array
    try {
      out = saveBytes(doc, SAVE_FINAL)
    } finally {
      free(doc)
    }
    const name = /\.pdf$/i.test(s.name) ? s.name : `${s.name}.pdf`
    await mkdir(folder, { recursive: true })
    const target = join(folder, name.replace(/[<>:"/\\|?*]/g, '_'))
    // The share folder is in the temporary folder: a link planted at the name is replaced, not written through.
    await writeStaged(target, out)
    return { path: target, temporary: true, bytes: out.length }
  }

  // --- tools that produce new documents or files -------------------------------------

  extract(id: string, pages: number[]): DocInfo {
    const s = this.get(id)
    const bytes = keepPages(s.bytes, pages, s.password)
    return this.openBytes(`${stem(s.name)} (${pages.length === 1 ? `p${pages[0]! + 1}` : `${pages.length}p`}).pdf`, bytes)
  }

  async merge(items: MergeItem[], name: string): Promise<DocInfo> {
    const inputs = await Promise.all(
      items.map(async (item) => {
        if ('docId' in item) {
          const s = this.get(item.docId)
          return { bytes: s.bytes, password: s.password }
        }
        return { bytes: new Uint8Array(await readFile(item.path)), password: item.password }
      })
    )
    return this.openBytes(name, mergePdfs(inputs))
  }

  /** Create › Blank document. */
  newBlank(width: number, height: number, count: number, name: string): DocInfo {
    return this.openBytes(name, blankPdf(width, height, count))
  }

  /** Create › from a template: the template's pages as a new, untitled document; the template stays as it was. */
  async openCopy(path: string, name: string): Promise<DocInfo> {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch (error) {
      throw new PdfError('bad-arguments', `The file could not be read: ${(error as Error).message}`)
    }
    return this.openBytes(name, bytes)
  }

  async signatures(id: string): Promise<SignatureInfo[]> {
    const s = this.get(id)
    return mayBeSigned(s.bytes) ? verifySignatures(s.bytes) : []
  }

  detectFields(id: string, page: number): NewField[] {
    return detectFormFields(this.get(id).doc, page)
  }

  documentFonts(id: string): DocFont[] {
    return documentFonts(this.get(id).doc)
  }

  formFields(id: string, page?: number): FormField[] {
    return formFields(this.get(id).doc, page)
  }

  // --- redact ---------------------------------------------------------------------

  redactFind(id: string, query: { words: string[]; patterns: RedactPattern[]; wholeWords: boolean }): RedactHit[] {
    return findToRedact(this.get(id).doc, query)
  }

  redactMarks(id: string): Array<{ page: number; box: [number, number, number, number] }> {
    return redactionMarks(this.get(id).doc)
  }

  // --- export to Office -------------------------------------------------------------

  async exportOffice(id: string, options: { format: OfficeFormat; pages: number[] | null; pageBreaks: boolean; removeTatweel: boolean; digits: 'keep' | 'western' | 'arabic'; sheets?: 'page' | 'tables' }, path: string): Promise<{ path: string; pages: number; paragraphs: number; tables: number; pictures: number }> {
    const s = this.get(id)
    const folder = `${basename(path, extname(path))}_pictures`
    const { pages, ...rest } = options
    const r = await exportOffice(s.bytes, { ...rest, ...(pages ? { pages } : {}), pictureFolder: folder }, s.password)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, r.bytes)
    if (r.extra.length) {
      const dir = join(dirname(path), folder)
      await mkdir(dir, { recursive: true })
      for (const f of r.extra) await writeFile(join(dir, f.name), f.bytes)
    }
    return { path, pages: r.pages, paragraphs: r.paragraphs, tables: r.tables, pictures: r.pictures }
  }

  // --- compare ------------------------------------------------------------------

  async compare(a: CompareSource, b: CompareSource, options: CompareOptions): Promise<CompareResult> {
    const open = async (source: CompareSource): Promise<{ doc: PdfDoc | null; side: CompareSide }> => {
      if (source.kind === 'text') return { doc: null, side: { kind: 'text', name: source.name, text: source.text, words: textWords(source.text) } }
      let doc: PdfDoc
      let name: string
      if (source.kind === 'doc') {
        const s = this.get(source.docId)
        doc = openPdf(s.bytes, s.password)
        name = s.name
      } else {
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await readFile(source.path))
        } catch (error) {
          throw new PdfError('bad-arguments', `The file could not be read: ${(error as Error).message}`)
        }
        doc = openPdf(bytes)
        if (needsOpenPassword(doc)) {
          free(doc)
          throw new PdfError('password-required', `“${basename(source.path)}” needs a password. Open it in ${BRAND.name} first, then compare the open document.`)
        }
        name = basename(source.path)
      }
      const pages = Array.from({ length: doc.countPages() }, (_, i) => {
        const g = pageGeometry(doc, i)
        return { width: g.width, height: g.height }
      })
      return { doc, side: { kind: 'pdf', name, pages, words: pdfWords(doc) } }
    }
    const left = await open(a)
    let right: Awaited<ReturnType<typeof open>>
    try {
      right = await open(b)
    } catch (error) {
      free(left.doc)
      throw error
    }
    const token = randomUUID()
    this.comparisons.set(token, { a: left.doc, b: right.doc })
    return { token, a: left.side, b: right.side, changes: diffWords(left.side.words, right.side.words, options) }
  }

  comparePage(token: string, side: 'a' | 'b', page: number, scale: number): RenderedPage {
    const doc = this.comparisons.get(token)?.[side]
    if (!doc) throw new PdfError('bad-arguments', 'That comparison is closed.')
    if (page < 0 || page >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    return renderPage(doc, page, { scale, format: 'auto', quality: 85 })
  }

  compareClose(token: string): void {
    const c = this.comparisons.get(token)
    if (!c) return
    free(c.a, c.b)
    this.comparisons.delete(token)
  }

  /** The page found in a picture; for a book (§62), also where its fold is. */
  async scanDetect(path: string, book = false): Promise<{ width: number; height: number; corners: Corners | null; preview: string; split?: number | null }> {
    const bytes = new Uint8Array(await readFile(path))
    const found = detectPicture(bytes)
    const preview = `data:image/jpeg;base64,${Buffer.from(found.preview).toString('base64')}`
    if (!book) return { width: found.width, height: found.height, corners: found.corners, preview }
    return { width: found.width, height: found.height, corners: found.corners, preview, split: detectFold(bytes, found.corners) }
  }

  /** Where a book's fold is once the picture is straightened by these corners and turn (§62). */
  async scanFold(item: ScanItem): Promise<number | null> {
    return detectFold(new Uint8Array(await readFile(item.path)), item.corners, item.rotate)
  }

  /** The picture as it comes out: one page, or a book spread's two pages, left to right. */
  async scanPreview(item: ScanItem): Promise<string[]> {
    const bytes = new Uint8Array(await readFile(item.path))
    const pages = item.split !== undefined ? scanBookPicture(bytes, { corners: item.corners, mode: item.mode, rotate: item.rotate, split: item.split, maxSide: 900 }) : [scanPicture(bytes, { corners: item.corners, mode: item.mode, rotate: item.rotate, maxSide: 700 })]
    return pages.map((out) => `data:image/${out.format};base64,${Buffer.from(out.bytes).toString('base64')}`)
  }

  /** A PDF's pages as pictures in `folder`, for the Scan board (a scanned book's spreads, §62). */
  async scanPdfPages(path: string, folder: string): Promise<string[]> {
    const doc = openPdf(new Uint8Array(await readFile(path)))
    try {
      const count = doc.countPages()
      if (count > 500) throw new PdfError('bad-arguments', 'This PDF has more than 500 pages; split it first.')
      await mkdir(folder, { recursive: true })
      const files: string[] = []
      for (let i = 0; i < count; i++) {
        const g = pageGeometry(doc, i)
        // About 2400 px on the long side: enough for clean pages and for recognising text.
        const scale = Math.min(4, 2400 / Math.max(g.width, g.height))
        const page = renderPage(doc, i, { scale, format: 'jpeg', quality: 90, annotations: false })
        const file = join(folder, `${stem(basename(path))} - ${String(i + 1).padStart(3, '0')}.jpg`)
        // The scan folder is a fixed name in the temporary folder: never written through a planted link (§82).
        await writeStaged(file, page.data)
        files.push(file)
      }
      return files
    } finally {
      free(doc)
    }
  }

  /** Scanned pictures as a new PDF: one page each (two for a book's spread), or both sides of an ID card on one A4 page (§61, §62). */
  async scanToPdf(items: ScanItem[], goal: 'pages' | 'idcard' | 'book', paper: 'a4' | 'letter' | 'fit', name: string, rtl = false): Promise<DocInfo> {
    // One picture at a time: hundreds of phone photos read at once would fill the worker's memory.
    const scanned: ScannedImage[] = []
    for (const item of items) {
      const bytes = new Uint8Array(await readFile(item.path))
      if (goal !== 'book') {
        scanned.push(scanPicture(bytes, { corners: item.corners, mode: item.mode, rotate: item.rotate }))
        continue
      }
      // A book read right to left (Arabic) starts each spread with its right page.
      const pages = scanBookPicture(bytes, { corners: item.corners, mode: item.mode, rotate: item.rotate, split: item.split ?? null })
      scanned.push(...(rtl ? pages.reverse() : pages))
    }
    if (goal === 'idcard') {
      // Front and back by their side, not their order: a retaken front is added after the back.
      const front = items.findIndex((i) => i.side !== 'back')
      const back = items.findIndex((i) => i.side === 'back')
      if (front < 0) return this.openBytes(name, await idCardPage(scanned[back]!, null))
      return this.openBytes(name, await idCardPage(scanned[front]!, back >= 0 ? scanned[back]! : null))
    }
    return this.openBytes(name, imagesToPdf(scanned.map((s) => s.bytes), { paper, margin: 0, autoOrientation: true, orientation: 'auto' }))
  }

  async imagesToPdf(paths: string[], options: ImagesToPdfOptions, name: string): Promise<DocInfo> {
    // MuPDF embeds JPEG, PNG, GIF, BMP and TIFF; every other picture (HEIC, WebP, AVIF, RAW, PSD …)
    // is turned upright and into PNG (transparent) or JPEG first by the image engine (§69).
    // MuPDF reads only the first page of a TIFF, so a multi-page TIFF becomes one PNG per page,
    // each taking the TIFF's own rotation.
    const perPath = await Promise.all(
      paths.map(async (p): Promise<Uint8Array[]> => {
        const bytes = new Uint8Array(await readFile(p))
        const kind = sniff(bytes.subarray(0, 4096), p)
        if (kind === 'tiff') return (await pagesAsPng(bytes, p)) ?? [bytes]
        if (kind === 'jpg' || kind === 'png' || kind === 'gif' || kind === 'bmp') return [bytes]
        const picture = await openBytes(bytes, p)
        const out = picture.hasAlpha ? await picture.pipeline().png().toBuffer() : await picture.pipeline().jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        return [new Uint8Array(out)]
      })
    )
    const images = perPath.flat()
    const rotations = options.rotations && perPath.flatMap((pages, i) => pages.map(() => options.rotations![i] ?? 0))
    return this.openBytes(name, imagesToPdf(images, rotations ? { ...options, rotations } : options))
  }

  async split(id: string, ranges: Array<[number, number]>, folder: string): Promise<string[]> {
    const s = this.get(id)
    const parts = splitByRanges(s.bytes, ranges, s.password)
    await mkdir(folder, { recursive: true })
    const written: string[] = []
    for (const [i, part] of parts.entries()) {
      const [from, to] = ranges[i]!
      const file = join(folder, `${stem(s.name)} - ${from === to ? from + 1 : `${from + 1}-${to + 1}`}.pdf`)
      await writeFile(file, part)
      written.push(file)
    }
    return written
  }

  async exportImages(id: string, pages: number[] | null, format: 'png' | 'jpeg', dpi: number, folder: string, progress?: (f: number) => void, annotations: boolean | 'print' | 'print-none' = true): Promise<string[]> {
    const s = this.get(id)
    await mkdir(folder, { recursive: true })
    const list = pages ?? Array.from({ length: s.doc.countPages() }, (_, i) => i)
    const written: string[] = []
    const width = String(s.doc.countPages()).length
    // One page at a time, so a long document at a high resolution never sits in memory at once.
    for (const [k, page] of list.entries()) {
      const [image] = pdfToImages(s.bytes, [page], format, dpi, s.password, undefined, annotations)
      const file = join(folder, `${stem(s.name)} - ${String(page + 1).padStart(width, '0')}${list.indexOf(page) !== k ? ` (${k + 1})` : ''}.${format === 'png' ? 'png' : 'jpg'}`)
      await writeFile(file, image!.data)
      written.push(file)
      progress?.((k + 1) / list.length)
    }
    return written
  }

  // --- internals -----------------------------------------------------------------

  private get(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new PdfError('bad-arguments', 'That document is no longer open.')
    return s
  }

  private replace(s: Session, next: Version): void {
    // Open the new version first: if it cannot be opened, nothing about the session changes.
    const doc = openPdf(next.bytes, next.password)
    s.undo.push(current(s))
    s.redo = []
    let total = s.undo.reduce((n, v) => n + v.bytes.length, 0)
    while (s.undo.length > UNDO_STEPS || (total > UNDO_BYTES && s.undo.length > 1)) total -= s.undo.shift()!.bytes.length
    this.install(s, next, doc)
  }

  private load(s: Session, version: Version): void {
    this.install(s, version, openPdf(version.bytes, version.password))
  }

  private install(s: Session, version: Version, doc: PdfDoc): void {
    free(s.doc)
    s.doc = doc
    s.bytes = version.bytes
    s.stamp = version.stamp
    s.password = version.password
    s.hasOpenPassword = needsOpenPassword(doc)
    s.revision++
    this.dropRenders(s.id)
  }

  private dropRenders(id: string): void {
    for (const key of [...this.renders.keys()]) if (key.startsWith(`${id}/`)) this.renders.delete(key)
  }
}

function current(s: Session): Version {
  return { bytes: s.bytes, stamp: s.stamp, password: s.password }
}

function stem(name: string): string {
  return basename(name, extname(name))
}

import { useEffect, useState } from 'react'
import { FileDown } from 'lucide-react'
import { CombineView } from './components/CombineView'
import { ImagesView } from './components/ImagesView'
import { ImageToolView } from './components/ImageToolView'
import { PhotoEditor } from './components/PhotoEditor'
import { READABLE_EXTENSIONS } from '@shared/imageFormats'
import { fileKind } from '@shared/opening'
import { ScanView, SCAN_TOOLS, type ScanGoal } from './components/ScanView'
import { ContextMenu, menuIsOpen } from './components/ContextMenu'
import { Home } from './components/Home'
import { Organizer } from './components/Organizer'
import { Busy, Dialogs, Toasts, UpdateBanner } from './components/Overlays'
import { BatchView } from './components/BatchView'
import { CompareView } from './components/CompareView'
import { EditFormatBar } from './components/EditFormatBar'
import { FormBar, ScanBar, SignatureBar, XfaBar } from './components/FormLayer'
import { GlobalBar, pickPictureToPlace, QuickTools, ReadBar, RightRail, TitleBar } from './components/Shell'
import { PictureViewer } from './components/PictureViewer'
import { SidePanel } from './components/SidePanels'
import { Viewer } from './components/Viewer'
import { activeView, closeDoc, deletePagesAsking, goToPage, openAny, openAnyWithPicker, quickTool, redo, save, setDialog, t, toast, undo, updateView, useStore, useT, type DocView, CONVERTIBLE, createPdfFrom, isImageTool } from './store'
import { ToolPanel } from './tools/ToolPanel'

function useThemeAndLanguage(): void {
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.lang = settings.language
    root.dir = settings.language === 'ar' ? 'rtl' : 'ltr'
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      root.dataset.theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])
}

/** Keyboard shortcuts, the ones every desktop editor has. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (s.dialog || s.busy) return
      const view = activeView()
      const mod = e.ctrlKey || e.metaKey
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      const k = e.key.toLowerCase()
      if (mod && k === 'o') {
        // Open…: PDFs and pictures, each to its viewer (§75).
        e.preventDefault()
        void openAnyWithPicker()
      } else if (view && mod && k === 's') {
        e.preventDefault()
        void save(view.info.id, e.shiftKey)
      } else if ((view || (s.active && !s.tool)) && mod && k === 'w') {
        // Closes the tab in front: a document's, or a picture's while no tool covers it.
        e.preventDefault()
        void closeDoc(view ? view.info.id : s.active!)
      } else if (!typing && !mod && e.key === '?') {
        e.preventDefault()
        setDialog({ kind: 'shortcuts' })
      } else if (view && !typing && !mod && !e.altKey && s.settings?.singleKeys && view.mode !== 'organize' && ['v', 't', 's', 'e', 'u', 'd'].includes(k)) {
        // Acrobat's optional single-key accelerators (off unless chosen in Settings).
        e.preventDefault()
        const style = view.markStyle
        if (k === 'v') quickTool(view, 'select')
        else if (k === 't') quickTool(view, 'text')
        else if (k === 's') quickTool(view, 'note')
        else if (k === 'e') quickTool(view, 'erase')
        else if (k === 'u') {
          const order = ['highlight', 'underline', 'strikeout'] as const
          const next = e.shiftKey && view.editTool === 'highlight' ? order[(order.indexOf(style.textMark) + 1) % 3]! : style.textMark
          updateView(view.info.id, { markStyle: { ...style, textMark: next } })
          quickTool(view, 'highlight')
        } else if (e.shiftKey) {
          const order = ['rect', 'ellipse', 'line', 'arrow'] as const
          const next = view.editTool === 'shape' ? order[(order.indexOf(style.shape) + 1) % 4]! : style.shape
          updateView(view.info.id, { markStyle: { ...style, shape: next } })
          quickTool(view, 'shape')
        } else quickTool(view, 'pen')
      } else if (view && mod && k === 'c' && !typing && view.selection) {
        e.preventDefault()
        void window.api.copyText(view.selection.text)
        toast('success', t('copied'))
      } else if (view && mod && k === 'p') {
        // Print (§60): HonoPDF's own dialog, not the window's.
        e.preventDefault()
        setDialog({ kind: 'print', docId: view.info.id })
      } else if (view && mod && k === 'f') {
        e.preventDefault()
        window.dispatchEvent(new Event('powerpdf:find'))
      } else if (view && mod && k === 'h') {
        // Find & Replace (§64): the panel, with the replacement field ready.
        e.preventDefault()
        updateView(view.info.id, { side: 'search' })
        setTimeout(() => window.dispatchEvent(new Event('powerpdf:replace')), 50)
      } else if (view && !typing && !mod && view.mode === 'view' && (k === 'home' || k === 'end')) {
        e.preventDefault()
        goToPage(view.info.id, k === 'home' ? 0 : view.info.pages.length - 1)
      } else if (view && mod && (k === 'pageup' || k === 'pagedown')) {
        e.preventDefault()
        goToPage(view.info.id, view.page + (k === 'pageup' ? -1 : 1))
      } else if (view && !typing && mod && k === 'z' && !e.shiftKey) {
        e.preventDefault()
        void undo(view.info.id)
      } else if (view && !typing && mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault()
        void redo(view.info.id)
      } else if (view && mod && (k === '=' || k === '+' || k === '-' || k === '0')) {
        e.preventDefault()
        const now = view.shownZoom
        updateView(view.info.id, { zoom: k === '0' ? 'width' : Math.min(6, Math.max(0.1, k === '-' ? now / 1.2 : now * 1.2)) })
      } else if (view && !typing && view.mode === 'organize' && (k === 'delete' || k === 'backspace') && view.selected.length && view.selected.length < view.info.pages.length) {
        e.preventDefault()
        void deletePagesAsking(view.info.id, view.selected).then((ok) => ok && updateView(view.info.id, { selected: [] }))
      } else if (view && !typing && view.mode === 'organize' && mod && k === 'a') {
        e.preventDefault()
        updateView(view.info.id, { selected: view.info.pages.map((_, i) => i) })
      } else if (view && !typing && view.mode === 'organize' && e.key === 'Escape' && view.selected.length && !menuIsOpen()) {
        // Esc clears the selection in Organize (the bar's Clear).
        e.preventDefault()
        updateView(view.info.id, { selected: [] })
      } else if (mod && e.key === 'Tab') {
        e.preventDefault()
        const { order, active } = s
        if (order.length) {
          const i = active ? order.indexOf(active) : -1
          useStore.setState({ active: order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]! })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Files dropped anywhere on the window open as documents. */
function useDropFiles(): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      setOver(true)
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setOver(false)
    }
    const overHandler = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setOver(false)
      const all = [...(e.dataTransfer?.files ?? [])].map((f) => window.api.pathForFile(f))
      const anyPicture = (p: string): boolean => READABLE_EXTENSIONS.includes(p.split('.').pop()?.toLowerCase() ?? '') && !p.toLowerCase().endsWith('.pdf')
      // Pictures of any format dropped on an image tool join its board (decisions §69).
      if (isImageTool(useStore.getState().tool)) {
        window.dispatchEvent(new CustomEvent('powerpdf:imgtool-add', { detail: all.filter((p) => anyPicture(p) || (useStore.getState().tool === 'imgConvert' && p.toLowerCase().endsWith('.pdf'))) }))
        return
      }
      // Pictures dropped while making a PDF from pictures join that list.
      if (useStore.getState().tool === 'imagesToPdf' || SCAN_TOOLS.includes(useStore.getState().tool!)) {
        // Scan book also takes PDFs of scanned spreads.
        const book = useStore.getState().tool === 'scanBook'
        const imagesToPdf = useStore.getState().tool === 'imagesToPdf'
        window.dispatchEvent(new CustomEvent('powerpdf:images-add', { detail: all.filter((p) => /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(p) || (imagesToPdf && anyPicture(p)) || (book && /\.pdf$/i.test(p))) }))
        return
      }
      const paths = all.filter((p) => p.toLowerCase().endsWith('.pdf'))
      // Word, Excel, PowerPoint, web pages and text become PDFs.
      const convertible = all.filter((p) => CONVERTIBLE.test(p))
      if (convertible.length && useStore.getState().tool !== 'merge') void createPdfFrom(convertible)
      // While combining, dropped files join the list instead of opening.
      if (useStore.getState().tool === 'merge') window.dispatchEvent(new CustomEvent('powerpdf:combine-add', { detail: paths }))
      else if (useStore.getState().tool === 'batch') window.dispatchEvent(new CustomEvent('powerpdf:batch-add', { detail: paths }))
      // Otherwise PDFs open in the reader and pictures in the picture viewer (§75).
      else void openAny(all.filter((p) => fileKind(p)))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overHandler)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overHandler)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return over
}

export function App() {
  const t = useT()
  useThemeAndLanguage()
  useShortcuts()
  const dropping = useDropFiles()
  const view = useStore((s) => (s.active ? (s.docs[s.active] ?? null) : null))
  const picture = useStore((s) => (s.active ? (s.pictures[s.active] ?? null) : null))
  const settings = useStore((s) => s.settings)
  const tool = useStore((s) => s.tool)
  // Combine files and Images to PDF have views of their own over the whole window.
  const scanning = !!tool && SCAN_TOOLS.includes(tool)
  const combining = tool === 'merge' || tool === 'imagesToPdf' || tool === 'compare' || tool === 'batch' || scanning || isImageTool(tool)
  if (!settings) return null
  // The reader (§75): a slim bar instead of the tool tabs, no tool panel or rail; side panels at the start.
  const reading = !!view && !combining && view.reading

  return (
    <div className="flex h-full flex-col bg-bg">
      <UpdateBanner />
      <TitleBar view={view} />
      {view && !combining && (reading ? <ReadBar view={view} /> : <GlobalBar view={view} />)}
      <div className="flex min-h-0 flex-1">
        <ToolPanel />
        {reading && <SidePanel view={view} start />}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {scanning ? <ScanView key={tool} goal={tool as ScanGoal} /> : isImageTool(tool) ? tool === 'imgEditor' ? <PhotoEditor /> : <ImageToolView key={tool} tool={tool} /> : tool === 'imagesToPdf' ? <ImagesView /> : tool === 'compare' ? <CompareView /> : tool === 'batch' ? <BatchView /> : combining ? <CombineView /> : view ? view.mode === 'organize' ? <Organizer view={view} /> : <Canvas view={view} /> : picture ? <PictureViewer key={picture.id} picture={picture} /> : <Home />}
        </main>
        {view && !combining && !reading && <SidePanel view={view} />}
        {view && !combining && !reading && <RightRail view={view} />}
      </div>
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-2xl border-4 border-dashed border-accent bg-accent-soft/80">
          <div className="flex flex-col items-center gap-2 text-accent">
            <FileDown size={48} />
            <span className="text-[16px] font-semibold">{t('open.drop')}</span>
          </div>
        </div>
      )}
      <Dialogs />
      <ContextMenu />
      <Toasts />
      <Busy />
    </div>
  )
}

/** The pages, with the quick tools floating at their top corner and the placing hint above them. */
function Canvas({ view }: { view: DocView }) {
  const t = useT()
  const docId = view.info.id
  // A scan: the first pages (up to three) carry no text. Checked once, and again after each change.
  const revision = view.info.revision
  useEffect(() => {
    const now = useStore.getState().docs[docId]?.scanned
    if (now === 'dismissed') return
    const pages = Math.min(3, useStore.getState().docs[docId]?.info.pages.length ?? 0)
    void Promise.all(Array.from({ length: pages }, (_, p) => window.api.pageText(docId, p))).then((all) => {
      const letters = all.reduce((n, r) => n + (r.ok ? r.value.reduce((m, l) => m + (l.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0) : 99), 0)
      const scanned = pages > 0 && letters < 20 * pages ? 'yes' : 'no'
      if (useStore.getState().docs[docId]?.scanned !== 'dismissed') updateView(docId, { scanned })
    })
  }, [docId, revision])
  // Forms: count the fields once when the document opens (the message bar and live fields).
  useEffect(() => {
    if (useStore.getState().docs[docId]?.forms) return
    void window.api.formFields(docId).then((r) => {
      if (r.ok) updateView(docId, { forms: { count: r.value.filter((f) => !f.readOnly && f.kind !== 'button').length, highlight: true } })
    })
  }, [docId])
  return (
    <>
      {view.mode === 'edit' && view.editTool === 'text' && <EditFormatBar view={view} />}
      {view.mode === 'view' && view.forms && view.forms.count > 0 && <FormBar view={view} />}
      {view.info.xfa === 'dynamic' && <XfaBar />}
      {view.scanned === 'yes' && view.info.xfa !== 'dynamic' && <ScanBar view={view} />}
      <SignatureBar view={view} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <Viewer key={view.info.id} view={view} />
        </div>
        {!view.reading && <QuickTools view={view} onPicture={() => void pickPictureToPlace(view, () => toast('error', t('pictureUnreadable')))} />}
        {view.placing && (
          <div className="pointer-events-auto absolute start-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-[12px] text-surface shadow-lg rtl:translate-x-1/2" role="status">
            <span>{t('placeHint')}</span>
            <button type="button" className="font-semibold underline" onClick={() => updateView(view.info.id, { placing: null })}>
              {t('cancel')}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

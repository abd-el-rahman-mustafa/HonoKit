import clsx from 'clsx'
import {
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  Circle,
  ChevronUp,
  Ellipsis,
  Eraser,
  FileImage,
  FileText,
  GalleryVerticalEnd,
  Highlighter,
  House,
  ImagePlus,
  Info,
  Maximize,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveUpRight,
  PenLine,
  Plus,
  Redo2,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  Signature,
  Square,
  SquarePen,
  Strikethrough,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Printer
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  changeSettings,
  closeDoc,
  editDoc,
  goToPage,
  MODE_TOOLS,
  openAnyWithPicker,
  openTool,
  quickTool,
  readDoc,
  redo,
  runSearch,
  save,
  setDialog,
  stepSearch,
  toggleSide,
  undo,
  updateView,
  useStore,
  useT,
  type DocView,
  resizeThumbs,
  type MarkStyle,
  type SidePanel,
  type ToolId
} from '../store'
import type { Key } from '../i18n'
import { HUB_LABEL, hubOf, TOOLS, type Hub } from '../tools/catalogue'
import { Logo } from './Home'
import { quickPlaceAt, quickPlaceOffset, QUICK_MARGIN, type QuickPlace, type Size } from './quickPlace'
import { ShareMenu } from './ShareMenu'
import { Spinner } from './ui'

/**
 * The window's frame, laid out as the new Acrobat (docs/ui-design.md): a title bar with the
 * menu, Home and the document tabs; a global bar with the main tools as tabs, undo/redo,
 * find and save; a floating quick-tools bar beside the pages; and a right rail with side
 * panels and the page and zoom controls. Mirrored as a whole in Arabic.
 */

function useOutside(open: boolean, close: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open, close])
  return ref
}

function MenuItem({ label, shortcut, onClick, disabled }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="flex h-8 w-full items-center gap-6 rounded px-3 text-start text-[13px] hover:bg-surface-2 disabled:opacity-40">
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[11px] text-faint" dir="ltr">
          {shortcut}
        </span>
      )}
    </button>
  )
}

/** Acrobat's ≡ Menu: the file commands and settings. */
function AppMenu({ view }: { view: DocView | null }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useOutside(open, () => setOpen(false))
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px]', open ? 'bg-surface' : 'hover:bg-surface')} aria-expanded={open}>
        <Menu size={16} />
        <span className="@max-[760px]:hidden">{t('menu')}</span>
      </button>
      {open && (
        <div className="absolute start-0 top-9 z-40 w-64 rounded-lg border border-line bg-surface p-1 shadow-xl" role="menu">
          <MenuItem label={t('openAny')} shortcut="Ctrl+O" onClick={run(() => void openAnyWithPicker())} />
          <MenuItem label={t('save')} shortcut="Ctrl+S" disabled={!view} onClick={run(() => view && void save(view.info.id))} />
          <MenuItem label={t('saveAs')} shortcut="Ctrl+Shift+S" disabled={!view} onClick={run(() => view && void save(view.info.id, true))} />
          <MenuItem label={t('savePages.menu')} disabled={!view} onClick={run(() => view && setDialog({ kind: 'savePages', docId: view.info.id }))} />
          <MenuItem label={t('print.menu')} shortcut="Ctrl+P" disabled={!view} onClick={run(() => view && setDialog({ kind: 'print', docId: view.info.id }))} />
          <MenuItem label={t('close')} shortcut="Ctrl+W" disabled={!view} onClick={run(() => view && void closeDoc(view.info.id))} />
          <div className="my-1 h-px bg-line" />
          <MenuItem
            label={t('allTools')}
            onClick={run(() => {
              // From the reader, All tools means the editor with its tool list.
              if (view?.reading) editDoc(view.info.id)
              openTool(null)
            })}
          />
          <MenuItem label={t('keyboardShortcuts')} shortcut="?" onClick={run(() => setDialog({ kind: 'shortcuts' }))} />
          <MenuItem label={t('settings')} onClick={run(() => setDialog({ kind: 'settings' }))} />
        </div>
      )}
    </div>
  )
}

/** Row 1: menu, Home, the open documents, Open. */
export function TitleBar({ view }: { view: DocView | null }) {
  const t = useT()
  const order = useStore((s) => s.order)
  const docs = useStore((s) => s.docs)
  const pictures = useStore((s) => s.pictures)
  const active = useStore((s) => s.active)
  return (
    <div className="@container flex h-10 shrink-0 items-center gap-1 bg-bg px-2" data-title-bar="">
      <AppMenu view={view} />
      <button
        type="button"
        title={t('home')}
        aria-label={t('home')}
        onClick={() => useStore.setState({ active: null, tool: null })}
        data-home-button=""
        className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2', active === null ? 'bg-surface shadow-sm' : 'hover:bg-surface')}
      >
        <Logo size={18} />
        <House size={15} className="text-muted" />
      </button>
      <div className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pt-1.5">
        {order.map((id) => {
          const d = docs[id]
          const picture = pictures[id]
          if (!d && !picture) return null
          const name = d ? d.info.name : picture!.name
          const Icon = picture ? FileImage : FileText
          return (
            <div
              key={id}
              className={clsx(
                'group flex h-full max-w-60 min-w-28 shrink items-center gap-1.5 rounded-t-lg ps-2.5 pe-1 text-[12px]',
                id === active ? 'bg-surface font-medium shadow-[0_-1px_0_var(--line)]' : 'text-muted hover:bg-surface/60'
              )}
              onMouseDown={(e) => {
                if (e.button === 1) void closeDoc(id)
              }}
            >
              <Icon size={13} className={clsx('shrink-0', id === active ? (picture ? 'text-[hsl(160_60%_40%)]' : 'text-brand') : 'text-faint')} aria-hidden="true" />
              <button type="button" className="min-w-0 flex-1 truncate text-start" dir="auto" onClick={() => useStore.setState({ active: id })} title={d ? (d.info.path ?? d.info.name) : picture!.path} data-tab={picture ? 'picture' : 'pdf'}>
                {name}
              </button>
              {d?.info.dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" title={t('unsavedDot')} />}
              <button type="button" title={t('close')} aria-label={t('close')} className="rounded p-0.5 text-faint hover:bg-surface-2 hover:text-ink" onClick={() => void closeDoc(id)}>
                <X size={14} />
              </button>
            </div>
          )
        })}
        <button type="button" title={`${t('openAny')} (Ctrl+O)`} onClick={() => void openAnyWithPicker()} className="mb-1 ms-1 flex h-7 shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[12px] hover:bg-surface-2">
          <Plus size={13} />
          {t('open')}
        </button>
      </div>
      <button type="button" title={t('settings')} aria-label={t('settings')} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface" onClick={() => setDialog({ kind: 'settings' })}>
        <SettingsIcon size={16} />
      </button>
    </div>
  )
}

/** The tools under the Convert tab: it stays selected while one of them is open. */
const CONVERT_TOOLS: ToolId[] = ['convert', 'toWord', 'toExcel', 'toPowerPoint', 'toMarkdown', 'toText']

const TABS: Array<ToolId | null> = [null, 'edit', 'convert', 'comment', 'sign', 'organize']

/** Acrobat's "Find text or tools": Enter searches the text; matching tools are offered as you type. */
function FindBox({ view }: { view: DocView }) {
  const t = useT()
  const [text, setText] = useState(view.search.query)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const { hits, index, busy, query } = view.search
  useEffect(() => {
    const focus = (): void => {
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('powerpdf:find', focus)
    return () => window.removeEventListener('powerpdf:find', focus)
  }, [])
  const q = text.trim().toLowerCase()
  // Matching tools, PDF tools and image tools apart (§75), a few of each.
  const matches = q.length > 1 && text !== query ? TOOLS.filter((x) => t(`tool.${x.id}`).toLowerCase().includes(q)) : []
  const groups = (['pdf', 'images'] as Hub[]).map((hub) => ({ hub, tools: matches.filter((x) => hubOf(x) === hub).slice(0, 4) })).filter((g) => g.tools.length > 0)
  return (
    <div className="relative">
      <div className="flex h-8 items-center gap-1 rounded-full border border-line bg-surface ps-3 pe-1 focus-within:border-focus">
        <Search size={14} className="shrink-0 text-faint" />
        <input
          ref={input}
          className="w-44 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-faint @max-[1100px]:w-28 @max-[860px]:w-20"
          dir="auto"
          value={text}
          placeholder={t('findTextOrTools')}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (text === query && hits.length) stepSearch(view.info.id, e.shiftKey ? -1 : 1)
              else {
                void runSearch(view.info.id, text)
                if (text.trim()) updateView(view.info.id, { side: 'search' })
              }
            }
            if (e.key === 'Escape') {
              setText('')
              void runSearch(view.info.id, '')
            }
          }}
        />
        {busy ? (
          <Spinner size={14} />
        ) : query ? (
          <span className="text-[11px] whitespace-nowrap text-muted tabular-nums">{hits.length ? t('searchResults', { index: index + 1, count: hits.length }) : t('noResults')}</span>
        ) : null}
        {query && hits.length > 0 && (
          <>
            <button type="button" title={t('previous')} aria-label={t('previous')} className="rounded-full p-1 hover:bg-surface-2" onClick={() => stepSearch(view.info.id, -1)}>
              <ChevronUp size={14} />
            </button>
            <button type="button" title={t('next')} aria-label={t('next')} className="rounded-full p-1 hover:bg-surface-2" onClick={() => stepSearch(view.info.id, 1)}>
              <ChevronDown size={14} />
            </button>
          </>
        )}
      </div>
      {focused && groups.length > 0 && (
        <div className="absolute end-0 top-9 z-40 w-64 rounded-lg border border-line bg-surface p-1 shadow-xl" data-find-tools="">
          {groups.map(({ hub, tools }, i) => (
            <div key={hub} className={clsx(i > 0 && 'mt-1 border-t border-line pt-1')}>
              <div className="px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">{t(HUB_LABEL[hub])}</div>
              {tools.map(({ id, icon: Icon, hue }) => (
                <button
                  key={id}
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded px-2 text-start text-[13px] hover:bg-surface-2"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setText('')
                    openTool(id)
                  }}
                >
                  <Icon size={16} className="shrink-0" style={{ color: `hsl(${hue} 70% 45%)` }} />
                  <span className="truncate">{t(`tool.${id}`)}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="px-2 py-1 text-[11px] text-faint">{t('findEnterHint')}</div>
        </div>
      )}
    </div>
  )
}

/** Row 2: the main tools as tabs, undo/redo; find and save on the other side. */
export function GlobalBar({ view }: { view: DocView }) {
  const t = useT()
  const tool = useStore((s) => s.tool)
  const current = tool && (MODE_TOOLS.includes(tool) || CONVERT_TOOLS.includes(tool)) ? (CONVERT_TOOLS.includes(tool) ? 'convert' : tool) : null
  const { info } = view
  return (
    <div className="@container flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2" data-global-bar="">
      <nav className="flex h-full items-stretch" aria-label={t('tools')}>
        {TABS.map((id) => {
          const active = id === current
          return (
            <button
              key={id ?? 'all'}
              type="button"
              onClick={() => openTool(id)}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'relative px-3 text-[13px] whitespace-nowrap',
                active ? 'font-semibold text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink' : 'text-muted hover:text-ink'
              )}
            >
              {id ? t(`tab.${id}` as Key) : t('allTools')}
            </button>
          )
        })}
      </nav>
      <span className="mx-1 h-5 w-px bg-line" />
      <BarButton label={`${t('undo')} (Ctrl+Z)`} disabled={!info.canUndo} onClick={() => void undo(info.id)}>
        <Undo2 size={16} />
      </BarButton>
      <BarButton label={`${t('redo')} (Ctrl+Y)`} disabled={!info.canRedo} onClick={() => void redo(info.id)}>
        <Redo2 size={16} />
      </BarButton>
      <span className="flex-1" />
      {!info.rights.full && (
        <button type="button" className="me-1 flex h-7 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] px-2.5 text-[12px] text-warn" title={t('restrictedHint')} onClick={() => openTool('unlock')}>
          <ShieldAlert size={13} />
          <span className="@max-[900px]:hidden">{t('restricted')}</span>
        </button>
      )}
      <FindBox view={view} />
      <button
        type="button"
        title={`${t('print.menu')} (Ctrl+P)`}
        aria-label={t('print.menu')}
        onClick={() => setDialog({ kind: 'print', docId: info.id })}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        data-print-button=""
      >
        <Printer size={17} />
      </button>
      <ShareMenu view={view} />
      <button
        type="button"
        title={`${t('save')} (Ctrl+S)`}
        disabled={!info.dirty && info.path !== null}
        onClick={() => void save(info.id)}
        className={clsx(
          'ms-1 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium disabled:opacity-45',
          info.dirty ? 'bg-accent text-accent-ink hover:brightness-110' : 'border border-line hover:bg-surface-2'
        )}
      >
        <Save size={15} />
        <span className="@max-[760px]:hidden">{t('save')}</span>
      </button>
      {/* Back to the reader (§75), where the reader's Edit button stands. */}
      <button
        type="button"
        title={t('read.backHint')}
        onClick={() => readDoc(info.id)}
        className="ms-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        data-read-button=""
      >
        <BookOpen size={15} />
        <span className="@max-[900px]:hidden">{t('read.back')}</span>
      </button>
    </div>
  )
}

/** Steps the zoom to the next of the usual sizes, up or down. */
function stepZoom(view: DocView, dir: 1 | -1): void {
  const now = view.shownZoom
  const next = dir > 0 ? (ZOOMS.find((z) => z > now + 0.01) ?? 4) : ([...ZOOMS].reverse().find((z) => z < now - 0.01) ?? 0.25)
  updateView(view.info.id, { zoom: next })
}

/** The page box: type a number and press Enter (Arabic-Indic digits too). */
function PageBox({ view, className }: { view: DocView; className: string }) {
  const t = useT()
  const [pageText, setPageText] = useState(String(view.page + 1))
  useEffect(() => setPageText(String(view.page + 1)), [view.page])
  return (
    <input
      aria-label={t('page')}
      className={className}
      dir="ltr"
      value={pageText}
      onChange={(e) => setPageText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const n = Number(pageText.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)))
          if (Number.isInteger(n)) goToPage(view.info.id, n - 1)
        }
      }}
      onBlur={() => setPageText(String(view.page + 1))}
    />
  )
}

/**
 * The reader's bar (decisions §75): only what reading needs — thumbnails, bookmarks and document info, the
 * page, zoom, find, print, share, Save once a form was filled — and Edit, which brings back every
 * tool. Text selection, copying, form filling and links work on the pages as in the editor.
 */
export function ReadBar({ view }: { view: DocView }) {
  const t = useT()
  const { info } = view
  const language = useStore((s) => s.settings?.language ?? 'en')
  const count = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US').format(info.pages.length)
  const percent = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US', { style: 'percent' }).format(view.shownZoom)
  return (
    <div className="@container flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2" data-read-bar="">
      <BarToggle label={t('side.thumbnails')} active={view.side === 'thumbnails'} onClick={() => toggleSide(view, 'thumbnails')}>
        <GalleryVerticalEnd size={17} />
      </BarToggle>
      <BarToggle label={t('side.bookmarks')} active={view.side === 'bookmarks'} onClick={() => toggleSide(view, 'bookmarks')}>
        <Bookmark size={17} />
      </BarToggle>
      <BarToggle label={t('side.info')} active={view.side === 'info'} onClick={() => toggleSide(view, 'info')}>
        <Info size={17} />
      </BarToggle>
      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" />
      <BarButton label={t('previousPage')} disabled={view.page === 0} onClick={() => goToPage(info.id, view.page - 1)}>
        <ChevronUp size={17} />
      </BarButton>
      <PageBox view={view} className="h-7 w-11 rounded-md border border-line bg-surface text-center text-[12px] tabular-nums focus:border-focus focus:outline-none" />
      <span className="px-1 text-[12px] whitespace-nowrap text-muted tabular-nums">/ {count}</span>
      <BarButton label={t('nextPage')} disabled={view.page >= info.pages.length - 1} onClick={() => goToPage(info.id, view.page + 1)}>
        <ChevronDown size={17} />
      </BarButton>
      <span className="mx-1.5 h-5 w-px shrink-0 bg-line" />
      <BarButton label={`${t('zoomOut')} (Ctrl −)`} onClick={() => stepZoom(view, -1)}>
        <ZoomOut size={17} />
      </BarButton>
      <span className="w-12 text-center text-[12px] text-muted tabular-nums" data-zoom-shown="">
        {percent}
      </span>
      <BarButton label={`${t('zoomIn')} (Ctrl +)`} onClick={() => stepZoom(view, 1)}>
        <ZoomIn size={17} />
      </BarButton>
      <span className="flex @max-[820px]:hidden">
        <BarToggle label={t('fitWidth')} active={view.zoom === 'width'} onClick={() => updateView(info.id, { zoom: 'width' })}>
          <MoveHorizontal size={17} />
        </BarToggle>
        <BarToggle label={t('fitPage')} active={view.zoom === 'page'} onClick={() => updateView(info.id, { zoom: 'page' })}>
          <Maximize size={16} />
        </BarToggle>
      </span>
      <span className="min-w-2 flex-1" />
      <FindBox view={view} />
      <button
        type="button"
        title={`${t('print.menu')} (Ctrl+P)`}
        aria-label={t('print.menu')}
        onClick={() => setDialog({ kind: 'print', docId: info.id })}
        className="ms-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        data-print-button=""
      >
        <Printer size={17} />
      </button>
      <ShareMenu view={view} />
      {(info.dirty || info.path === null) && (
        <button
          type="button"
          title={`${t('save')} (Ctrl+S)`}
          onClick={() => void save(info.id)}
          className="ms-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-accent px-3.5 text-[13px] font-medium text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Save size={15} />
          <span className="@max-[760px]:hidden">{t('save')}</span>
        </button>
      )}
      <button
        type="button"
        title={t('read.editHint')}
        onClick={() => editDoc(info.id)}
        className="ms-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-sm hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        data-edit-button=""
      >
        <SquarePen size={15} />
        {t('read.edit')}
      </button>
    </div>
  )
}

function BarToggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink')}
    >
      {children}
    </button>
  )
}

function BarButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:opacity-35">
      {children}
    </button>
  )
}

/**
 * Acrobat's quick action toolbar: a floating vertical card at the top of the pages. The
 * active tool is a blue square. Each choice also brings up the panel holding its options.
 */
/** Where the person dragged the quick tools, for this session (null: the default corner). */
let quickPosition: QuickPlace | null = null

type DrawVariant = 'pen' | MarkStyle['shape']
type TextVariant = MarkStyle['textMark']

const DRAW_ICONS: Record<DrawVariant, ReactNode> = {
  pen: <PenLine size={17} />,
  line: <Minus size={17} />,
  arrow: <MoveUpRight size={17} />,
  rect: <Square size={16} />,
  ellipse: <Circle size={16} />
}
const TEXT_ICONS: Record<TextVariant, ReactNode> = {
  highlight: <Highlighter size={17} />,
  underline: <Underline size={17} />,
  strikeout: <Strikethrough size={17} />
}
const DOT_COLOURS = ['#facc15', '#86efac', '#7dd3fc', '#f9a8d4', '#e11d48', '#ea580c', '#16a34a', '#1473e6', '#7c3aed', '#111827']

/**
 * Acrobat's quick action toolbar: a floating vertical card beside the pages. Select, Edit,
 * Add a comment, Highlight ▾ and Draw ▾ (flyouts that remember the last variant, marked by a
 * small corner triangle), picture, sign, erase, then ⋯ to customise. The active tool is a
 * blue square; a markup tool also shows its colour, which opens a palette.
 */
export function QuickTools({ view, onPicture }: { view: DocView; onPicture: () => void }) {
  const t = useT()
  const hidden = useStore((s) => s.settings?.quickHidden ?? [])
  const [pos, setPos] = useState(quickPosition)
  const [menu, setMenu] = useState<null | 'customize' | 'highlight' | 'draw' | 'colour'>(null)
  const card = useRef<HTMLDivElement>(null)
  // The sizes of the card and of the pages' area, followed as the window is resized (§92).
  const [sizes, setSizes] = useState<{ card: Size; area: Size } | null>(null)
  useLayoutEffect(() => {
    const el = card.current
    const area = el?.offsetParent as HTMLElement | null
    if (!el || !area) return
    const measure = (): void =>
      setSizes({ card: { width: el.offsetWidth, height: el.offsetHeight }, area: { width: area.clientWidth, height: area.clientHeight } })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const menuRef = useOutside(menu !== null, () => setMenu(null))
  const { markStyle, editTool } = view
  const style = (patch: Partial<MarkStyle>): void => updateView(view.info.id, { markStyle: { ...markStyle, ...patch } })
  const editing = view.mode === 'edit' && !view.placing
  const drawVariant: DrawVariant = editTool === 'pen' || (editTool !== 'shape' && lastDraw === 'pen') ? 'pen' : markStyle.shape
  const current: string = view.placing ? (view.placing.signature ? 'sign' : 'picture') : !editing ? 'select' : editTool === 'pen' || editTool === 'shape' ? 'draw' : editTool
  const markupActive = current === 'highlight' || current === 'draw' || current === 'note'
  const colourOf = current === 'highlight' && markStyle.textMark === 'highlight' ? markStyle.highlight : current === 'note' ? markStyle.note : markStyle.colour
  const setColour = (c: string): void =>
    style(current === 'highlight' && markStyle.textMark === 'highlight' ? { highlight: c } : current === 'note' ? { note: c } : { colour: c })

  const chooseDraw = (v: DrawVariant): void => {
    lastDraw = v
    if (v === 'pen') quickTool(view, 'pen')
    else {
      style({ shape: v })
      quickTool(view, 'shape')
    }
    setMenu(null)
  }
  const chooseText = (v: TextVariant): void => {
    style({ textMark: v })
    quickTool(view, 'highlight')
    setMenu(null)
  }

  const items: Array<{ id: string; icon: ReactNode; label: string; key?: string; flyout?: 'highlight' | 'draw'; run: () => void }> = [
    { id: 'select', icon: <MousePointer2 size={17} />, label: t('quick.select'), key: 'V', run: () => quickTool(view, 'select') },
    { id: 'text', icon: <SquarePen size={17} />, label: t('quick.edit'), key: 'T', run: () => quickTool(view, 'text') },
    { id: 'note', icon: <MessageSquarePlus size={17} />, label: t('addComment'), key: 'S', run: () => quickTool(view, 'note') },
    { id: 'highlight', icon: TEXT_ICONS[markStyle.textMark], label: t(`markup.${markStyle.textMark}`), key: 'U', flyout: 'highlight', run: () => chooseText(markStyle.textMark) },
    { id: 'draw', icon: DRAW_ICONS[drawVariant], label: drawVariant === 'pen' ? t('penTool') : t(`markup.${drawVariant}`), key: 'D', flyout: 'draw', run: () => chooseDraw(drawVariant) },
    { id: 'picture', icon: <ImagePlus size={17} />, label: t('addPicture'), run: onPicture },
    {
      id: 'sign',
      icon: <Signature size={17} />,
      label: t('signTool'),
      run: () => {
        openTool('sign')
        setDialog({ kind: 'signature', docId: view.info.id })
      }
    },
    { id: 'erase', icon: <Eraser size={17} />, label: t('eraseArea'), key: 'E', run: () => quickTool(view, 'erase') }
  ]
  // Select always stays, so there is a way back to reading.
  const shown = items.filter((x) => x.id === 'select' || !hidden.includes(x.id))

  /** Drag by the grip, kept inside the area of the pages; a double click puts it back. */
  const grab = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = card.current
    const area = el?.offsetParent as HTMLElement | null
    if (!el || !area) return
    const a = area.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    const move = (m: MouseEvent): void => {
      const x = Math.min(Math.max(QUICK_MARGIN, m.clientX - a.left - dx), a.width - r.width - QUICK_MARGIN)
      const y = Math.min(Math.max(QUICK_MARGIN, m.clientY - a.top - dy), a.height - r.height - QUICK_MARGIN)
      quickPosition = quickPlaceAt(x, y, r, a)
      setPos(quickPosition)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const toggle = (id: string): void => void changeSettings({ quickHidden: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] })
  const popover = 'absolute start-11 top-0 z-40 rounded-lg border border-line bg-surface p-1 shadow-xl'

  const at = pos && sizes ? quickPlaceOffset(pos, sizes.card, sizes.area) : null
  return (
    <div ref={card} className={clsx('absolute z-20', !at && 'start-3 top-3')} style={at ?? undefined}>
      <div ref={menuRef} className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-lg" role="toolbar" aria-orientation="vertical" aria-label={t('quickTools')} data-quick-tools="">
        <button
          type="button"
          title={t('quickMove')}
          aria-label={t('quickMove')}
          onMouseDown={grab}
          onDoubleClick={() => {
            quickPosition = null
            setPos(null)
          }}
          className="mx-auto flex h-3 w-8 cursor-grab items-center justify-center active:cursor-grabbing"
        >
          <span className="h-1 w-5 rounded-full bg-line" />
        </button>
        {shown.map(({ id, icon, label, key, flyout, run }, i) => (
          <div key={id} className="relative">
            {i > 0 && (id === 'note' || id === 'picture') && <div className="mx-1.5 my-0.5 h-px bg-line" />}
            <button
              type="button"
              title={key ? `${label} (${key})` : label}
              aria-label={label}
              aria-pressed={current === id}
              onClick={() => {
                // A second click on an active tool with variants opens its flyout, as in Acrobat.
                if (flyout && current === id) setMenu(menu === flyout ? null : flyout)
                else {
                  setMenu(null)
                  run()
                }
              }}
              onContextMenu={(e) => {
                if (!flyout) return
                e.preventDefault()
                setMenu(flyout)
              }}
              className={clsx('relative flex h-8 w-8 items-center justify-center rounded-lg', current === id ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-surface-2 hover:text-ink')}
            >
              {icon}
              {flyout && (
                <span
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenu(menu === flyout ? null : flyout)
                  }}
                  className="absolute end-0.5 bottom-0.5 h-0 w-0 border-s-[5px] border-t-[5px] border-s-transparent border-t-transparent"
                  style={{ borderBottom: '5px solid currentColor', borderInlineEnd: '0' }}
                />
              )}
            </button>
            {menu === 'highlight' && flyout === 'highlight' && (
              <div className={popover} role="menu">
                {(['highlight', 'underline', 'strikeout'] as const).map((v) => (
                  <FlyoutItem key={v} icon={TEXT_ICONS[v]} label={t(`markup.${v}`)} checked={current === 'highlight' && markStyle.textMark === v} onClick={() => chooseText(v)} />
                ))}
              </div>
            )}
            {menu === 'draw' && flyout === 'draw' && (
              <div className={popover} role="menu">
                {(['pen', 'line', 'arrow', 'rect', 'ellipse'] as const).map((v) => (
                  <FlyoutItem key={v} icon={DRAW_ICONS[v]} label={v === 'pen' ? t('penTool') : t(`markup.${v}`)} checked={current === 'draw' && drawVariant === v} onClick={() => chooseDraw(v)} />
                ))}
              </div>
            )}
            {current === id && markupActive && (
              <div className="relative">
                <button
                  type="button"
                  title={t('colour')}
                  aria-label={t('colour')}
                  onClick={() => setMenu(menu === 'colour' ? null : 'colour')}
                  className="mt-0.5 flex h-7 w-8 items-center justify-center rounded-lg hover:bg-surface-2"
                >
                  <span className="h-4 w-4 rounded-full border border-black/15" style={{ background: colourOf }} />
                </button>
                {menu === 'colour' && (
                  <div className={clsx(popover, 'grid w-[152px] grid-cols-5 gap-1.5 p-2')}>
                    {DOT_COLOURS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        onClick={() => {
                          setColour(c)
                          setMenu(null)
                        }}
                        className={clsx('h-6 w-6 rounded-full border', colourOf.toLowerCase() === c ? 'border-ink ring-2 ring-accent' : 'border-black/10')}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div className="mx-1.5 my-0.5 h-px bg-line" />
        <div className="relative">
          <button
            type="button"
            title={t('quickCustomize')}
            aria-label={t('quickCustomize')}
            aria-expanded={menu === 'customize'}
            onClick={() => setMenu(menu === 'customize' ? null : 'customize')}
            className={clsx('flex h-8 w-8 items-center justify-center rounded-lg', menu === 'customize' ? 'bg-surface-2 text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink')}
          >
            <Ellipsis size={17} />
          </button>
          {menu === 'customize' && (
            <div className="absolute start-11 bottom-0 z-40 w-60 rounded-lg border border-line bg-surface p-1 shadow-xl" role="menu">
              <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{t('quickCustomize')}</div>
              {items
                .filter((x) => x.id !== 'select')
                .map(({ id, icon, label }) => (
                  <label key={id} className="flex h-8 cursor-pointer items-center gap-2.5 rounded px-2 text-[13px] hover:bg-surface-2">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={!hidden.includes(id)} onChange={() => toggle(id)} />
                    <span className="text-muted">{icon}</span>
                    {label}
                  </label>
                ))}
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                className="flex h-8 w-full items-center rounded px-2 text-start text-[13px] hover:bg-surface-2"
                onClick={() => {
                  void changeSettings({ quickHidden: [] })
                  quickPosition = null
                  setPos(null)
                  setMenu(null)
                }}
              >
                {t('quickReset')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** The last Draw variant chosen, so the Draw button shows it (Acrobat keeps the last one). */
let lastDraw: DrawVariant = 'pen'

function FlyoutItem({ icon, label, checked, onClick }: { icon: ReactNode; label: string; checked: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} onClick={onClick} className="flex h-8 w-44 items-center gap-2.5 rounded px-2 text-start text-[13px] hover:bg-surface-2">
      <span className="text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {checked && <Check size={14} className="text-accent" />}
    </button>
  )
}


const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

function RailButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx('flex h-9 w-9 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink')}
    >
      {children}
    </button>
  )
}

/** The right rail: side panels on top; the page and zoom controls at the bottom, as in Acrobat. */
export function RightRail({ view }: { view: DocView }) {
  const t = useT()
  const { info } = view
  const panels: Array<{ id: SidePanel; icon: typeof Info; label: string }> = [
    { id: 'thumbnails', icon: GalleryVerticalEnd, label: t('side.thumbnails') },
    { id: 'bookmarks', icon: Bookmark, label: t('side.bookmarks') },
    { id: 'search', icon: Search, label: t('side.search') },
    { id: 'comments', icon: MessageSquareText, label: t('side.comments') },
    { id: 'info', icon: Info, label: t('side.info') }
  ]
  const organizing = view.mode === 'organize'
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-s border-line bg-surface py-2" data-right-rail="">
      {!organizing && panels.map(({ id, icon: Icon, label }) => (
        <RailButton key={id} label={label} active={view.side === id} onClick={() => toggleSide(view, id)}>
          <Icon size={18} />
        </RailButton>
      ))}
      <span className="flex-1" />
      {organizing && (
        <>
          <RailButton label={t('pagesMenu.bigger')} onClick={() => resizeThumbs(info.id, 'grid', true)}>
            <ZoomIn size={17} />
          </RailButton>
          <RailButton label={t('pagesMenu.smaller')} onClick={() => resizeThumbs(info.id, 'grid', false)}>
            <ZoomOut size={17} />
          </RailButton>
        </>
      )}
      {!organizing && (
        <>
          <PageBox view={view} className="h-7 w-9 rounded-md border border-line bg-surface text-center text-[12px] tabular-nums focus:border-focus focus:outline-none" />
          <span className="text-[11px] text-muted tabular-nums">{info.pages.length}</span>
          <RailButton label={t('previousPage')} onClick={() => goToPage(info.id, view.page - 1)}>
            <ChevronUp size={17} />
          </RailButton>
          <RailButton label={t('nextPage')} onClick={() => goToPage(info.id, view.page + 1)}>
            <ChevronDown size={17} />
          </RailButton>
          <div className="my-1 h-px w-6 bg-line" />
          <RailButton label={`${t('zoomIn')} (Ctrl +)`} onClick={() => stepZoom(view, 1)}>
            <ZoomIn size={17} />
          </RailButton>
          <span className="text-[10px] text-muted tabular-nums">{Math.round(view.shownZoom * 100)}%</span>
          <RailButton label={`${t('zoomOut')} (Ctrl −)`} onClick={() => stepZoom(view, -1)}>
            <ZoomOut size={17} />
          </RailButton>
          <RailButton label={t('fitWidth')} active={view.zoom === 'width'} onClick={() => updateView(info.id, { zoom: 'width' })}>
            <MoveHorizontal size={17} />
          </RailButton>
          <RailButton label={t('fitPage')} active={view.zoom === 'page'} onClick={() => updateView(info.id, { zoom: 'page' })}>
            <Maximize size={16} />
          </RailButton>
        </>
      )}
    </div>
  )
}

/** Opens a picture file to place, as the Add picture quick tool and panel button do. */
export async function pickPictureToPlace(view: DocView, onError: () => void): Promise<void> {
  const [path] = await window.api.pickImages()
  if (!path) return
  const picture = await window.api.pictureInfo(path)
  if (!picture) {
    onError()
    return
  }
  openTool('edit')
  updateView(view.info.id, { placing: { source: { path }, width: picture.width, height: picture.height, preview: picture.preview, signature: false } })
}


import clsx from 'clsx'
import { ChevronDown, ChevronRight, Ellipsis, Globe, Lock, ShieldAlert, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MarkupInfo, OutlineItem } from '@shared/ipc'
import { menuTargets, pickHow, pickPages, type PickHow } from '@shared/pagelist'
import { commentThreads } from '@shared/threads'
import { formatBytes, hasKey } from '../i18n'
import { apply, deletePagesAsking, goToDestination, goToPage, openTool, openWebLink, quickTool, replaceAll, replaceCurrent, runSearch, showHit, stepSearch, tc, updateView, useStore, useT, type DocView } from '../store'
import { openMenu, useMenuOpen } from './ContextMenu'
import { pageEntries } from './menus'
import { PageCheck } from './Organizer'
import { PageImage } from './ui'

/** A panel that slides in between the pages and the right rail (Acrobat's side panels). */
/** A side panel; in the reader (§75) it opens at the start side, where readers keep thumbnails. */
export function SidePanel({ view, start }: { view: DocView; start?: boolean }) {
  const t = useT()
  if (!view.side || view.mode === 'organize') return null
  return (
    <aside className={clsx('flex w-[232px] shrink-0 flex-col border-line bg-surface', start ? 'border-e' : 'border-s')} data-side-panel={view.side}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line ps-4 pe-2">
        <h2 className="flex-1 text-[13px] font-semibold">{t(`side.${view.side}`)}</h2>
        <button type="button" title={t('close')} aria-label={t('close')} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => updateView(view.info.id, { side: null })}>
          <X size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.side === 'thumbnails' && <ThumbnailList view={view} />}
        {view.side === 'bookmarks' && <BookmarkList view={view} />}
        {view.side === 'search' && <SearchResults view={view} />}
        {view.side === 'comments' && <MarkupList view={view} />}
        {view.side === 'info' && <DocumentInfo view={view} />}
      </div>
    </aside>
  )
}

/**
 * Page thumbnails (decisions §76): a click goes to the page; Ctrl, Shift or a page's checkbox
 * selects several, for the page menu (right-click), the page tools ("Selected") and Delete.
 * A plain click only moves — so reading through the thumbnails never leaves pages selected that
 * a tool would then act on. Works the same in the reader and the editor; page changes make the
 * document unsaved, so the reader's Save appears.
 */
function ThumbnailList({ view }: { view: DocView }) {
  const t = useT()
  const { info, selected } = view
  const id = info.id
  const count = info.pages.length
  const list = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  // The page whose menu is open, outlined while it is.
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const menuOpen = useMenuOpen()
  const width = view.thumbSize
  const any = selected.length > 0
  const setSelected = (pages: number[]): void => updateView(id, { selected: [...new Set(pages)].sort((a, b) => a - b) })
  // Keep the current page's thumbnail in sight as the reader scrolls.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-thumb="${view.page}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [view.page])

  const pick = (i: number, how: PickHow): void => {
    if (how === 'only') {
      // A plain click reads: it goes to the page and drops a selection made earlier.
      setAnchor(i)
      if (selected.length) setSelected([])
      goToPage(id, i)
      return
    }
    const r = pickPages(selected, anchor ?? view.page, i, how)
    setSelected(r.selected)
    setAnchor(r.anchor)
  }

  const menu = (e: React.MouseEvent, i: number): void => {
    setMenuFor(i)
    openMenu(e, pageEntries(view, menuTargets(selected, i), 'panel'), t('pagesMenu.label'))
  }

  const onKey = (e: React.KeyboardEvent, i: number): void => {
    const mod = e.ctrlKey || e.metaKey
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-thumb]') ?? [])]
    const columns = Math.max(1, items.filter((c) => c.offsetTop === items[0]?.offsetTop).length)
    const rtl = document.documentElement.dir === 'rtl'
    const step: Record<string, number> = { ArrowDown: columns, ArrowUp: -columns, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, Home: -count, End: count }
    if (e.key in step) {
      e.preventDefault()
      const next = Math.max(0, Math.min(count - 1, i + step[e.key]!))
      items[next]?.focus()
      if (e.shiftKey) pick(next, mod ? 'addRange' : 'range')
      else if (!mod) pick(next, 'only')
    } else if (e.key === ' ') {
      e.preventDefault()
      pick(i, e.shiftKey ? 'addRange' : 'toggle')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(i, 'only')
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelected(info.pages.map((_, k) => k))
    } else if (e.key === 'Escape' && any) {
      e.preventDefault()
      e.stopPropagation()
      setSelected([])
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      const pages = menuTargets(selected, i)
      if (pages.length < count && (info.rights.assemble || info.rights.edit)) {
        e.preventDefault()
        void deletePagesAsking(id, pages).then((ok) => ok && setSelected([]))
      }
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {any && (
        <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-1 border-b border-line bg-surface/95 ps-3 pe-1.5 backdrop-blur" data-thumbs-selection="">
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{tc('pages.selected', selected.length)}</span>
          <button
            type="button"
            title={t('select.actions')}
            aria-label={t('select.actions')}
            onClick={(e) => openMenu(e, pageEntries(view, selected, 'panel'), t('pagesMenu.label'))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Ellipsis size={15} />
          </button>
          <button type="button" title="Esc" onClick={() => setSelected([])} className="h-7 rounded-md px-2 text-[12px] text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
            {t('select.clear')}
          </button>
        </div>
      )}
      <div ref={list} role="listbox" aria-multiselectable="true" aria-label={t('side.thumbnails')} className="flex flex-wrap content-start justify-center gap-x-3 gap-y-3 px-2 py-4" data-thumb-list="">
        {info.pages.map((p, i) => {
          const isSelected = selected.includes(i)
          const current = i === view.page
          const target = menuOpen && menuFor === i
          return (
            <div
              key={i}
              role="option"
              aria-selected={isSelected}
              aria-current={current ? 'page' : undefined}
              tabIndex={current ? 0 : -1}
              data-thumb={i}
              data-selected={isSelected || undefined}
              onClick={(e) => pick(i, pickHow(e))}
              onContextMenu={(e) => menu(e, i)}
              onKeyDown={(e) => onKey(e, i)}
              className="group relative flex cursor-pointer flex-col items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              title={t('pageN', { n: i + 1 })}
            >
              <span
                className={clsx(
                  'relative overflow-hidden rounded-sm outline-offset-2',
                  isSelected || target ? 'outline-[3px] outline-accent' : current ? 'outline-2 outline-accent' : 'outline-2 outline-transparent group-hover:outline-line'
                )}
              >
                <PageImage docId={id} revision={info.revision} page={i} width={width} height={(p.height / p.width) * width} pointsWide={p.width} />
                {isSelected && <span className="pointer-events-none absolute inset-0 bg-accent/15" />}
              </span>
              <PageCheck small checked={isSelected} shown={any} label={t('select.page', { n: i + 1 })} onPick={(shift) => pick(i, shift ? 'addRange' : 'toggle')} className="absolute start-1 top-1" />
              <span className={clsx('text-[11px] tabular-nums', isSelected || current ? 'font-semibold text-accent' : 'text-muted')}>{i + 1}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Find & Replace (§64), as Foxit's Search & Replace: the words, what replaces them, how they are
 * compared, Replace (the match shown) and Replace all — then the matches by page.
 */
function FindReplace({ view }: { view: DocView }) {
  const t = useT()
  const { query, hits, busy } = view.search
  const [text, setText] = useState(query)
  const replaceInput = useRef<HTMLInputElement>(null)
  useEffect(() => setText(query), [query])
  // Ctrl+H opens this panel with the replacement field ready.
  useEffect(() => {
    const focus = (): void => {
      replaceInput.current?.focus()
      replaceInput.current?.select()
    }
    window.addEventListener('powerpdf:replace', focus)
    return () => window.removeEventListener('powerpdf:replace', focus)
  }, [])
  const id = view.info.id
  const setFind = (patch: Partial<DocView['find']>, rerun = false): void => {
    updateView(id, { find: { ...view.find, ...patch } })
    if (rerun && query.trim()) setTimeout(() => void runSearch(id, query), 0)
  }
  const readOnly = !view.info.rights.edit
  const ready = !!query.trim() && query === text && hits.length > 0 && !busy && !readOnly
  // The match shown runs onto the next line: Find shows it, Replace leaves it (Replace all counts it as left).
  const wraps = (hits[view.search.index]?.boxes.length ?? 0) > 1
  return (
    <div className="flex flex-col gap-2 border-b border-line p-3" data-find-replace="">
      <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
        {t('find')}
        <input
          className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-focus"
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (text === query && hits.length) stepSearch(id, e.shiftKey ? -1 : 1)
              else void runSearch(id, text)
            }
          }}
          data-find-input=""
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
        {t('replaceWith')}
        <input
          ref={replaceInput}
          className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-focus disabled:opacity-60"
          dir="auto"
          value={view.find.replace}
          disabled={readOnly}
          onChange={(e) => setFind({ replace: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) {
              if (e.ctrlKey || e.metaKey) void replaceAll(id)
              else if (wraps) stepSearch(id, 1)
              else void replaceCurrent(id)
            }
          }}
          data-replace-input=""
        />
      </label>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--accent)]" checked={view.find.matchCase} onChange={(e) => setFind({ matchCase: e.target.checked }, true)} />
          {t('matchCase')}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--accent)]" checked={view.find.wholeWords} onChange={(e) => setFind({ wholeWords: e.target.checked }, true)} />
          {t('wholeWords')}
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!ready || wraps}
          title={ready && wraps ? t('replaceWraps') : undefined}
          aria-describedby={ready && wraps ? 'replace-wraps-hint' : undefined}
          onClick={() => void replaceCurrent(id)}
          className="h-8 flex-1 rounded-full border border-line text-[12px] font-medium hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent"
          data-replace-one=""
        >
          {t('replace')}
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void replaceAll(id)}
          className="h-8 flex-1 rounded-full bg-accent text-[12px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50"
          data-replace-all=""
        >
          {t('replaceAll')}
        </button>
      </div>
      {ready && wraps && (
        <p id="replace-wraps-hint" className="text-[11px] leading-snug text-muted" data-replace-wraps="">
          {t('replaceWraps')}
        </p>
      )}
      {readOnly && <p className="text-[11px] text-muted">{t('replaceReadOnly')}</p>}
    </div>
  )
}

interface BookmarkRow {
  item: OutlineItem
  /** Its path in the tree ("0.2.1"): stable while the outline is unchanged. */
  key: string
  level: number
  parent: string | null
}

/**
 * Bookmarks, as Acrobat's panel shows them (read only for now): nested, each level opened or
 * closed with its arrow, as the author left it at first. A click goes to the page, and to the
 * place on it when the bookmark names one. A bookmark to a web address or another file shows the
 * address and is not opened. Keyboard: arrows move, open and close (mirrored in Arabic), Enter goes.
 */
function BookmarkList({ view }: { view: DocView }) {
  const t = useT()
  const id = view.info.id
  const [items, setItems] = useState<OutlineItem[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    let gone = false
    void window.api.outline(id).then((r) => {
      if (gone) return
      const value = r.ok ? r.value : []
      setItems(value)
      // The first time, open what the file has open; after a change, keep what the person opened.
      if (first.current) {
        first.current = false
        const start = new Set<string>()
        const walk = (level: OutlineItem[], prefix: string): void =>
          level.forEach((it, i) => {
            const key = `${prefix}${i}`
            if (it.open && it.children.length) start.add(key)
            walk(it.children, `${key}.`)
          })
        walk(value, '')
        setOpen(start)
      }
    })
    return () => {
      gone = true
    }
  }, [id, view.info.revision])

  const rows: BookmarkRow[] = []
  const flatten = (level: OutlineItem[], prefix: string, depth: number, parent: string | null): void =>
    level.forEach((item, i) => {
      const key = `${prefix}${i}`
      rows.push({ item, key, level: depth, parent })
      if (item.children.length && open.has(key)) flatten(item.children, `${key}.`, depth + 1, key)
    })
  flatten(items ?? [], '', 0, null)

  useEffect(() => {
    if (focusKey) list.current?.querySelector<HTMLElement>(`[data-bookmark="${focusKey}"]`)?.focus()
  }, [focusKey])

  if (!items) return null
  if (!items.length) return <p className="p-4 text-[12px] leading-relaxed text-muted" data-bookmarks-empty="">{t('bookmarks.empty')}</p>

  const toggle = (key: string, to?: boolean): void =>
    setOpen((now) => {
      const next = new Set(now)
      if (to ?? !next.has(key)) next.add(key)
      else next.delete(key)
      return next
    })
  const follow = (item: OutlineItem): void => {
    if (item.page !== null) goToDestination(id, item.page, item.point)
    else if (item.uri) void openWebLink(item.uri)
  }
  const onKey = (e: React.KeyboardEvent, n: number): void => {
    const row = rows[n]!
    const rtl = document.documentElement.dir === 'rtl'
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight'
    const back = rtl ? 'ArrowRight' : 'ArrowLeft'
    const hasKids = row.item.children.length > 0
    const move = (to: number): void => setFocusKey(rows[Math.max(0, Math.min(rows.length - 1, to))]!.key)
    if (e.key === 'ArrowDown') move(n + 1)
    else if (e.key === 'ArrowUp') move(n - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(rows.length - 1)
    else if (e.key === forward) {
      if (hasKids && !open.has(row.key)) toggle(row.key, true)
      else if (hasKids) move(n + 1)
    } else if (e.key === back) {
      if (hasKids && open.has(row.key)) toggle(row.key, false)
      else if (row.parent) setFocusKey(row.parent)
    } else if (e.key === 'Enter' || e.key === ' ') follow(row.item)
    else return
    e.preventDefault()
  }

  const tabStop = rows.some((r) => r.key === focusKey) ? focusKey : rows[0]?.key
  return (
    <div ref={list} role="tree" aria-label={t('side.bookmarks')} className="flex flex-col gap-px px-1.5 py-2" data-bookmarks="">
      {rows.map((row, n) => {
        const { item, key, level } = row
        const hasKids = item.children.length > 0
        const expanded = open.has(key)
        const goes = item.page !== null || !!item.uri
        const title = item.title || t('bookmarks.untitled')
        const tip = item.uri ? t('bookmarks.outside', { address: item.uri }) : goes ? `${title} · ${t('pageN', { n: item.page! + 1 })}` : t('bookmarks.nowhere')
        return (
          <div
            key={key}
            role="treeitem"
            aria-level={level + 1}
            aria-expanded={hasKids ? expanded : undefined}
            aria-disabled={goes ? undefined : true}
            tabIndex={key === tabStop ? 0 : -1}
            title={tip}
            onClick={() => {
              setFocusKey(key)
              follow(item)
            }}
            onKeyDown={(e) => onKey(e, n)}
            className={clsx(
              'flex min-h-8 items-start gap-1 rounded-md py-[5px] pe-2 text-[12.5px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              goes ? 'cursor-pointer text-ink hover:bg-surface-2' : 'cursor-default text-muted'
            )}
            style={{ paddingInlineStart: 2 + Math.min(level, 8) * 14 }}
            data-bookmark={key}
          >
            {hasKids ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                title={expanded ? t('bookmarks.collapse') : t('bookmarks.expand')}
                onClick={(e) => {
                  e.stopPropagation()
                  setFocusKey(key)
                  toggle(key)
                }}
                className="flex h-[18px] w-5 shrink-0 items-center justify-center rounded text-muted hover:text-ink"
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} className="rtl:-scale-x-100" />}
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            {item.uri && <Globe size={13} className="mt-[3px] shrink-0 text-muted" aria-hidden="true" />}
            <span dir="auto" className="line-clamp-3 min-w-0 flex-1 text-start [overflow-wrap:anywhere]">
              {title}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SearchResults({ view }: { view: DocView }) {
  return (
    <>
      <FindReplace view={view} />
      <SearchHits view={view} />
    </>
  )
}

function SearchHits({ view }: { view: DocView }) {
  const t = useT()
  const { hits, index, query, busy } = view.search
  if (!query) return <p className="p-4 text-[12px] leading-relaxed text-muted">{t('searchPanelHint')}</p>
  if (busy) return <p className="p-4 text-[12px] text-muted">{t('searching')}</p>
  if (!hits.length) return <p className="p-4 text-[12px] text-muted">{t('noResults')}</p>
  // One row per page, with how many matches it has.
  const pages = [...new Set(hits.map((h) => h.page))]
  const current = hits[index]?.page
  return (
    <div className="flex flex-col p-2">
      <p className="px-2 pb-2 text-[12px] text-muted">{t('matchesOnPages', { count: hits.length, pages: pages.length })}</p>
      {pages.map((p) => {
        // Matches, not rectangles: a phrase that wraps onto the next line is one match with two.
        const n = hits.filter((h) => h.page === p).length
        return (
          <button
            key={p}
            type="button"
            onClick={() => {
              const i = hits.findIndex((h) => h.page === p)
              updateView(view.info.id, { search: { ...view.search, index: i } })
              showHit(view.info.id, hits[i]!)
            }}
            className={clsx('flex h-8 items-center justify-between rounded-md px-2 text-[13px]', p === current ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2')}
          >
            <span>{t('pageN', { n: p + 1 })}</span>
            <span className="text-[11px] text-muted tabular-nums">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A short "3 min ago" / "yesterday", in the interface's language. */
function ago(ms: number, language: string): string {
  if (!ms) return ''
  const minutes = Math.round((ms - Date.now()) / 60000)
  const rtf = new Intl.RelativeTimeFormat(language === 'ar' ? 'ar' : 'en', { numeric: 'auto' })
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  if (Math.abs(minutes) < 60 * 24) return rtf.format(Math.round(minutes / 60), 'hour')
  return rtf.format(Math.round(minutes / 1440), 'day')
}

/**
 * Every comment and mark in the document, by page — Acrobat's Comments panel: a card per
 * item with its type, author, time and text; clicking one selects it on the page.
 */
function MarkupList({ view }: { view: DocView }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const { info } = view
  const [items, setItems] = useState<Array<MarkupInfo & { page: number }> | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const all: Array<MarkupInfo & { page: number }> = []
      for (let p = 0; p < Math.min(info.pages.length, 500); p++) {
        const r = await window.api.pageMarkups(info.id, p)
        if (cancelled) return
        if (r.ok) all.push(...r.value.filter((m) => m.kind !== 'other').map((m) => ({ ...m, page: p })))
      }
      setItems(all)
    })()
    return () => {
      cancelled = true
    }
  }, [info.id, info.revision, info.pages.length])
  if (!items) return <p className="p-4 text-[12px] text-muted">{t('loading')}</p>
  if (!items.length)
    return (
      <div className="flex flex-col gap-3 p-4 text-[12px] leading-relaxed text-muted">
        <p>{t('noMarkup')}</p>
        <button type="button" className="self-start rounded-full border border-line px-3 py-1 text-[12px] text-ink hover:bg-surface-2" onClick={() => quickTool(view, 'note')}>
          {t('addComment')}
        </button>
      </div>
    )
  const q = filter.trim().toLowerCase()
  const matches = (m: MarkupInfo): boolean => !q || m.text.toLowerCase().includes(q) || t(`markup.${m.kind}` as never).toLowerCase().includes(q)
  // Replies (and review states) go under the comment they answer, wherever they sit (§82).
  const threads = commentThreads(items)
  const shown = threads.top.filter((m) => matches(m) || threads.repliesOf(m).some(matches))
  const pages = [...new Set(shown.map((m) => m.page))]
  const select = (m: MarkupInfo & { page: number }): void => {
    goToPage(info.id, m.page)
    if (view.mode !== 'edit' || view.editTool === 'text' || view.editTool === 'erase') openTool('comment')
    updateView(info.id, { markSel: { page: m.page, index: m.index } })
  }
  return (
    <div className="flex flex-col gap-3 p-3" data-comments-list="">
      <div className="flex items-center justify-between px-1 text-[12px] text-muted">
        <span>{t('commentsCount', { count: items.length })}</span>
      </div>
      <input
        className="h-8 rounded-full border border-line bg-surface px-3 text-[12px] focus:border-focus focus:outline-none"
        dir="auto"
        placeholder={t('searchComments')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {pages.map((p) => (
        <section key={p} className="flex flex-col gap-1.5">
          <h3 className="px-1 text-[10px] font-semibold tracking-wider text-faint uppercase">{t('pageN', { n: p + 1 })}</h3>
          {shown
            .filter((m) => m.page === p)
            .map((m) => {
              const active = view.markSel?.page === m.page && view.markSel.index === m.index
              return (
                <div
                  key={`${m.index}-${m.box.join(',')}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(m)}
                  onKeyDown={(e) => e.key === 'Enter' && select(m)}
                  className={clsx(
                    'group relative flex flex-col gap-1 rounded-lg border bg-surface px-3 py-2 text-start text-[12px]',
                    active ? 'border-accent shadow-[inset_3px_0_0_var(--accent)]' : 'border-line hover:border-faint'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: m.colour }} />
                    <span className="font-medium">{m.author || t('you')}</span>
                    <span className="text-[11px] text-faint">{ago(m.modified, language)}</span>
                  </div>
                  <span className="text-[11px] text-muted italic">{t(`markup.${m.kind}` as never)}</span>
                  {m.text && (
                    <p className="line-clamp-4 text-[12px] leading-snug whitespace-pre-wrap" dir="auto">
                      {m.text}
                    </p>
                  )}
                  {threads.statesOf(m).length > 0 && (
                    <div className="flex flex-wrap gap-1" data-review-states="">
                      {threads.statesOf(m).map((s) => (
                        <span key={`${s.page}-${s.index}`} className="rounded-full border border-line bg-surface-2 px-2 py-px text-[10px] text-muted" dir="auto">
                          {t('reviewBy', { state: hasKey(`review.${s.state}`) ? t(`review.${s.state}` as never) : (s.state ?? ''), who: s.author || t('you') })}
                        </span>
                      ))}
                    </div>
                  )}
                  {threads.repliesOf(m).length > 0 && (
                    <ul className="mt-0.5 flex flex-col gap-0.5 border-s-2 border-line ps-2" aria-label={t('repliesCount')} data-comment-replies="">
                      {threads.repliesOf(m).map((r) => (
                        <li key={`${r.page}-${r.index}`} style={{ marginInlineStart: (r.depth - 1) * 10 }}>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              select(r)
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              e.stopPropagation()
                              select(r)
                            }}
                            className={clsx('flex flex-col gap-0.5 rounded-md px-1.5 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent', view.markSel?.page === r.page && view.markSel.index === r.index && 'bg-surface-2')}
                          >
                            <span className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="text-[11px] font-medium">{r.author || t('you')}</span>
                              <span className="text-[10px] whitespace-nowrap text-faint">{ago(r.modified, language)}</span>
                              {r.page !== m.page && <span className="text-[10px] whitespace-nowrap text-faint">{t('pageN', { n: r.page + 1 })}</span>}
                            </span>
                            {r.text && (
                              <span className="line-clamp-3 text-[12px] leading-snug whitespace-pre-wrap" dir="auto">
                                {r.text}
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    title={t('delete')}
                    aria-label={t('delete')}
                    className="absolute end-1.5 top-1.5 hidden rounded p-1 text-faint group-hover:block hover:bg-surface-2 hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      void apply(info.id, { op: 'changeMarkup', page: m.page, index: m.index, box: m.box, change: { kind: 'delete' } }, t('deleteMarkup'))
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            })}
        </section>
      ))}
    </div>
  )
}

function DocumentInfo({ view }: { view: DocView }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const { info } = view
  const row = (label: string, value: React.ReactNode, ltr = false) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-semibold tracking-wider text-faint uppercase">{label}</dt>
      <dd className="text-[12px] break-words" dir={ltr ? 'ltr' : 'auto'}>
        {value || '—'}
      </dd>
    </div>
  )
  return (
    <dl className="flex flex-col gap-3 p-4">
      {row(t('fileName'), info.name)}
      {row(t('location'), info.path ?? t('notSavedYet'), true)}
      {row(t('pagesLabel'), String(info.pages.length))}
      {row(t('fileSize'), formatBytes(language, info.bytes))}
      {row(t('title'), info.meta.title)}
      {row(t('author'), info.meta.author)}
      {info.hasOpenPassword && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Lock size={13} /> {t('protected')}
        </p>
      )}
      {!info.rights.full && (
        <button type="button" className="flex items-center gap-1.5 text-start text-[12px] text-warn hover:underline" onClick={() => openTool('unlock')}>
          <ShieldAlert size={13} /> {t('restrictedHint')}
        </button>
      )}
      <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => openTool('metadata')}>
        {t('editProperties')}
      </button>
      <DocumentFonts id={info.id} revision={info.revision} />
    </dl>
  )
}

/**
 * The fonts the document uses (docs/decisions.md §56): for each, whether it is on this PC (edits
 * look the same), only in the PDF, or missing — with a way to find it.
 */
function DocumentFonts({ id, revision }: { id: string; revision: number }) {
  const t = useT()
  const [fonts, setFonts] = useState<Array<{ name: string; family: string; embedded: boolean; subset: boolean; reusable: boolean; installed: string | null }> | null>(null)
  useEffect(() => void window.api.documentFonts(id).then((r) => r.ok && setFonts(r.value)), [id, revision])
  if (!fonts || fonts.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-3" data-document-fonts="">
      <dt className="text-[10px] font-semibold tracking-wider text-faint uppercase">{t('fonts.title')}</dt>
      {fonts.map((f) => (
        <div key={f.name} className="flex items-start gap-2 text-[12px]">
          <span className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', f.installed ? 'bg-ok' : f.reusable && !f.subset ? 'bg-accent' : 'bg-warn')} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate" dir="ltr" title={f.name}>
              {f.name}
            </span>
            <span className="text-[11px] text-muted">{f.installed ? t('fonts.status.installed') : f.embedded ? (f.subset ? t('fonts.embeddedPart') : t('fonts.embeddedOnly')) : t('fonts.notEmbedded')}</span>
          </span>
          {!f.installed && (
            <button type="button" className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => void window.api.findFont(f.family)}>
              {t('font.find')}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

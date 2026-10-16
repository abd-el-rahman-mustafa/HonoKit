import clsx from 'clsx'
import { Check, Ellipsis, Minus, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { menuTargets, pickHow, pickPages, type PickHow } from '@shared/pagelist'
import { apply, deletePagesAsking, tc, updateView, useStore, useT, type DocView } from '../store'
import { openMenu } from './ContextMenu'
import { pageEntries } from './menus'
import { PageImage } from './ui'

/**
 * Organize pages, as in Acrobat: the pages as a grid. A plain click selects one page; Ctrl or
 * the page's checkbox adds and removes; Shift selects a run (decisions §76). The bar above says
 * how many are selected, with Select all (Ctrl+A) and Clear (Esc). Drag to reorder with a blue
 * insertion line; hovering a page shows its own small toolbar; right-click or ⋯ opens the page
 * menu, which acts on the whole selection when the page is part of it. Keyboard: arrows move
 * (Shift extends, Ctrl only moves the focus), Space ticks, Enter selects one, the menu key opens
 * the menu. The commands for the selection are also in the left panel (OrganizePanel).
 */
export function Organizer({ view }: { view: DocView }) {
  const t = useT()
  const { info, selected } = view
  const size = view.gridSize
  const [dragging, setDragging] = useState<number[] | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [focus, setFocus] = useState(Math.min(view.page, info.pages.length - 1))
  const grid = useRef<HTMLDivElement>(null)
  const count = info.pages.length
  const id = info.id

  // Organize opens on the page being read, as Acrobat does: its card in view and focused, so the
  // keyboard and the page commands start from it; a selection made earlier stays.
  useEffect(() => {
    const card = grid.current?.querySelector<HTMLElement>(`[data-organize-page="${Math.min(view.page, count - 1)}"]`)
    card?.scrollIntoView({ block: 'center' })
    card?.focus({ preventScroll: true })
    // Only when the grid opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setSelected = (pages: number[]): void => updateView(id, { selected: [...new Set(pages)].sort((a, b) => a - b) })
  const any = selected.length > 0

  const pick = (i: number, how: PickHow): void => {
    const now = useStore.getState().docs[id]?.selected ?? selected
    const r = pickPages(now, anchor, i, how)
    setSelected(r.selected)
    setAnchor(r.anchor)
    setFocus(i)
  }

  /** The page menu for page `i`: on the selection when `i` is in it, otherwise on `i` alone (now selected). */
  const menu = (e: React.MouseEvent, i: number): void => {
    const pages = menuTargets(selected, i)
    if (!selected.includes(i)) {
      setSelected([i])
      setAnchor(i)
    }
    setFocus(i)
    openMenu(e, pageEntries(view, pages, 'grid'), t('pagesMenu.label'))
  }

  /** Moves the dragged pages so they sit before position `at` (0..count). */
  const drop = (at: number): void => {
    const moving = dragging
    setDragging(null)
    setDropAt(null)
    if (!moving?.length) return
    const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !moving.includes(i))
    const before = rest.filter((i) => i < at).length
    const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)]
    if (order.every((p, i) => p === i)) return
    void apply(id, { op: 'keep', pages: order }, t('organize')).then((r) => {
      if (r) setSelected(moving.map((_, k) => before + k))
    })
  }

  /** Keyboard on a page: arrows (mirrored in Arabic), Home/End, Space, Enter. */
  const onKey = (e: React.KeyboardEvent, i: number): void => {
    const rtl = document.documentElement.dir === 'rtl'
    const cards = [...(grid.current?.querySelectorAll<HTMLElement>('[data-organize-page]') ?? [])]
    const columns = Math.max(1, cards.filter((c) => c.offsetTop === cards[0]?.offsetTop).length)
    const step: Record<string, number> = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: columns, ArrowUp: -columns, Home: -count, End: count }
    if (e.key in step) {
      e.preventDefault()
      const next = Math.max(0, Math.min(count - 1, i + step[e.key]!))
      setFocus(next)
      cards[next]?.focus()
      cards[next]?.scrollIntoView({ block: 'nearest' })
      if (e.shiftKey) pick(next, e.ctrlKey || e.metaKey ? 'addRange' : 'range')
      else if (!(e.ctrlKey || e.metaKey)) pick(next, 'only')
    } else if (e.key === ' ') {
      e.preventDefault()
      pick(i, e.shiftKey ? 'addRange' : 'toggle')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(i, 'only')
    }
  }

  return (
    <div
      className="h-full overflow-y-auto bg-sunken px-6 pb-6"
      data-organizer=""
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelected([])
      }}
    >
      <SelectionBar view={view} onMenu={(e) => openMenu(e, pageEntries(view, selected, 'grid'), t('pagesMenu.label'))} />
      <div
        ref={grid}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('select.grid')}
        className="flex flex-wrap gap-x-4 gap-y-5"
        onClick={(e) => e.target === e.currentTarget && setSelected([])}
      >
        {info.pages.map((p, i) => {
          const scale = Math.min(size / p.width, (size * 1.3) / p.height)
          const w = p.width * scale
          const h = p.height * scale
          const isSelected = selected.includes(i)
          // The hover buttons act like the menu: on the selection when this page is in it.
          const targets = isSelected ? selected : [i]
          return (
            <div
              key={i}
              role="option"
              aria-selected={isSelected}
              aria-label={t('pageN', { n: i + 1 })}
              tabIndex={i === Math.min(focus, count - 1) ? 0 : -1}
              draggable
              data-organize-page={i}
              data-selected={isSelected || undefined}
              onFocus={() => setFocus(i)}
              onKeyDown={(e) => e.target === e.currentTarget && onKey(e, i)}
              onDragStart={(e) => {
                const moving = isSelected ? selected : [i]
                if (!isSelected) setSelected([i])
                setDragging(moving)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropAt(null)
              }}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                const rtl = document.documentElement.dir === 'rtl'
                const firstHalf = rtl ? e.clientX > rect.left + rect.width / 2 : e.clientX < rect.left + rect.width / 2
                setDropAt(firstHalf ? i : i + 1)
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(dropAt ?? i)
              }}
              onClick={(e) => pick(i, pickHow(e))}
              onContextMenu={(e) => menu(e, i)}
              className={clsx(
                'group relative flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                isSelected ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-transparent hover:border-line hover:bg-surface/60',
                dragging?.includes(i) && 'opacity-40'
              )}
              style={{ width: size + 18 }}
            >
              {dropAt === i && <span className="absolute -start-2.5 top-0 h-full w-1 rounded bg-accent" />}
              {dropAt === i + 1 && i === count - 1 && <span className="absolute -end-2.5 top-0 h-full w-1 rounded bg-accent" />}
              <div className="flex items-center justify-center" style={{ width: size, height: size * 1.3 }}>
                <div className="page-shadow overflow-hidden rounded-sm bg-white">
                  <PageImage docId={id} revision={info.revision} page={i} width={w} height={h} pointsWide={p.width} />
                </div>
              </div>
              <span className={clsx('text-[12px] tabular-nums', isSelected ? 'font-semibold text-accent' : 'text-muted')}>{i + 1}</span>
              {/* Acrobat's checkbox at the top-start corner: on hover, and on every page once any is selected. */}
              <PageCheck checked={isSelected} shown={any} label={t('select.page', { n: i + 1 })} onPick={(shift) => pick(i, shift ? 'addRange' : 'toggle')} className="absolute start-1.5 top-1.5" />
              {/* Acrobat's per-page mini toolbar, shown on hover. */}
              <div className="absolute end-1.5 top-1.5 hidden flex-col gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-md group-hover:flex" onClick={(e) => e.stopPropagation()}>
                <MiniAction label={tc('pagesMenu.rotateLeft', targets.length)} onClick={() => void apply(id, { op: 'rotate', pages: targets, angle: -90 }, t('rotateLeft'))}>
                  <RotateCcw size={14} />
                </MiniAction>
                <MiniAction label={tc('pagesMenu.rotateRight', targets.length)} onClick={() => void apply(id, { op: 'rotate', pages: targets, angle: 90 }, t('rotateRight'))}>
                  <RotateCw size={14} />
                </MiniAction>
                <MiniAction label={t('more')} onClick={(e) => menu(e, i)} data-page-more="">
                  <Ellipsis size={14} />
                </MiniAction>
                {targets.length < count && (
                  <MiniAction label={tc('pagesMenu.deleteNow', targets.length)} danger onClick={() => void deletePagesAsking(id, targets).then((ok) => ok && setSelected([]))}>
                    <Trash2 size={14} />
                  </MiniAction>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The bar over the grid: how many pages are selected, Select all and Clear, and the page menu
 * for the selection — so everything can be done with the mouse alone.
 */
function SelectionBar({ view, onMenu }: { view: DocView; onMenu: (e: React.MouseEvent) => void }) {
  const t = useT()
  const n = view.selected.length
  const count = view.info.pages.length
  const all = n === count
  const select = (pages: number[]): void => updateView(view.info.id, { selected: pages })
  return (
    <div className="sticky top-0 z-10 -mx-6 mb-5 flex h-11 items-center gap-2 border-b border-line bg-surface/95 px-6 backdrop-blur" data-selection-bar="">
      <button
        type="button"
        role="checkbox"
        aria-checked={all ? 'true' : n ? 'mixed' : 'false'}
        aria-label={all ? t('select.clear') : t('select.all')}
        title={all ? `${t('select.clear')} (Esc)` : `${t('select.all')} (Ctrl+A)`}
        onClick={() => select(all ? [] : view.info.pages.map((_, i) => i))}
        className={clsx(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          n ? 'border-accent bg-accent text-accent-ink' : 'border-faint bg-surface hover:border-muted'
        )}
      >
        {all ? <Check size={13} strokeWidth={3} /> : n ? <Minus size={13} strokeWidth={3} /> : null}
      </button>
      {n ? (
        <span className="text-[13px] font-medium whitespace-nowrap" data-selection-count="">
          {tc('pages.selected', n)}
        </span>
      ) : (
        <span className="min-w-0 truncate text-[12px] text-muted">{t('select.hint')}</span>
      )}
      <span className="flex-1" />
      {n > 0 && (
        <button type="button" onClick={onMenu} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[12px] font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" data-selection-actions="">
          <Ellipsis size={14} />
          {t('select.actions')}
        </button>
      )}
      {!all && (
        <button type="button" title="Ctrl+A" onClick={() => select(view.info.pages.map((_, i) => i))} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" data-select-all="">
          {t('select.all')}
        </button>
      )}
      {n > 0 && (
        <button type="button" title="Esc" onClick={() => select([])} className="h-7 shrink-0 rounded-full px-3 text-[12px] font-medium text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" data-select-clear="">
          {t('select.clear')}
        </button>
      )}
    </div>
  )
}

/**
 * A page's checkbox, drawn over the thumbnail's corner. It is a mouse target only: on the
 * keyboard, Space on the page does the same, so screen readers hear one option, not two controls.
 */
export function PageCheck({ checked, shown, label, onPick, className, small }: { checked: boolean; shown: boolean; label: string; onPick: (shift: boolean) => void; className?: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      title={label}
      data-page-check={checked ? 'on' : 'off'}
      onClick={(e) => {
        e.stopPropagation()
        onPick(e.shiftKey)
      }}
      onMouseDown={(e) => e.preventDefault()}
      className={clsx(
        'z-[1] flex items-center justify-center rounded-[5px] border-[1.5px] shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-opacity',
        small ? 'h-[18px] w-[18px]' : 'h-5 w-5',
        checked ? 'border-accent bg-accent text-accent-ink opacity-100' : 'border-[#8a8a8a] bg-white text-transparent hover:border-accent',
        !checked && (shown ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'),
        className
      )}
    >
      <Check size={small ? 12 : 14} strokeWidth={3} />
    </span>
  )
}

function MiniAction({ label, onClick, danger, children, ...rest }: { label: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode } & Record<`data-${string}`, string>) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} {...rest} className={clsx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-2', danger ? 'text-danger' : 'text-muted hover:text-ink')}>
      {children}
    </button>
  )
}


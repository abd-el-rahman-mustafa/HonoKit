import clsx from 'clsx'
import { Check as CheckIcon, LayoutGrid } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { parsePageList } from '@shared/pagelist'
import type { Position } from '@shared/ops'
import { openTool, updateView, useT, type DocView } from '../store'
import { Button, Field, PageImage, Segmented, TextInput } from '../components/ui'

export type Scope = 'all' | 'current' | 'selected' | 'custom'

/**
 * "Which pages" for a page tool: all of them, the page in view, the pages selected (in
 * Organize, or with Choose pages… right here), or a typed list. `pages` is the zero-based
 * list, `undefined` for all, or `null` while nothing valid is chosen; `preview` is always a
 * usable list, so the live preview never goes blank while the choice is being made.
 */
export function usePageScope(view: DocView, defaultScope: Scope = 'all') {
  const [scope, setScopeState] = useState<Scope>(view.selected.length ? 'selected' : defaultScope)
  const [text, setText] = useState('')
  const count = view.info.pages.length
  // A selection that is cleared elsewhere does not leave the tool pointing at nothing.
  useEffect(() => {
    if (scope === 'selected' && view.selected.length === 0) setScopeState('all')
  }, [scope, view.selected.length])
  const pages: number[] | undefined | null =
    scope === 'all' ? undefined : scope === 'current' ? [view.page] : scope === 'selected' ? (view.selected.length ? view.selected : null) : parsePageList(text, count)
  const all = Array.from({ length: count }, (_, i) => i)
  return { scope, setScope: setScopeState, text, setText, pages, count, all, preview: pages ?? (scope === 'all' ? all : [view.page]), view }
}

export function PageScopeField({ state }: { state: ReturnType<typeof usePageScope> }) {
  const t = useT()
  const { view } = state
  const [picking, setPicking] = useState(false)
  const options: Array<{ value: Scope; label: string }> = [
    { value: 'all', label: t('allPages') },
    { value: 'current', label: t('thisPage', { n: view.page + 1 }) }
  ]
  if (view.selected.length) options.push({ value: 'selected', label: t('selectedCount', { count: view.selected.length }) })
  options.push({ value: 'custom', label: t('customPages') })
  const invalid = state.scope === 'custom' && state.text.trim() !== '' && state.pages === null
  return (
    <Field label={t('pagesToChange')}>
      <Segmented value={state.scope} onChange={state.setScope} options={options} />
      {state.scope === 'custom' && (
        <div className="mt-1.5">
          <TextInput dir="ltr" value={state.text} placeholder={t('customPagesHint')} onChange={(e) => state.setText(e.target.value)} />
          {invalid && <p className="mt-1 text-[12px] text-danger">{t('badPageList')}</p>}
        </div>
      )}
      <button type="button" onClick={() => setPicking(true)} className="mt-1.5 flex items-center gap-1.5 self-start text-[12px] font-medium text-accent hover:underline">
        <LayoutGrid size={13} />
        {t('choosePages')}
      </button>
      {picking && (
        <PagePicker
          view={view}
          onClose={(chosen) => {
            setPicking(false)
            if (chosen) state.setScope(chosen.length ? 'selected' : 'all')
          }}
        />
      )}
    </Field>
  )
}

/**
 * Choosing pages without leaving the tool: every page as a small thumbnail to tick
 * (Shift for a range), with All / None / Odd / Even. The choice is the document's page
 * selection, the same one Organize shows.
 */
function PagePicker({ view, onClose }: { view: DocView; onClose: (chosen: number[] | null) => void }) {
  const t = useT()
  const { info } = view
  const [chosen, setChosen] = useState<number[]>(view.selected)
  const anchor = useRef<number | null>(null)
  const all = info.pages.map((_, i) => i)
  const toggle = (i: number, range: boolean): void => {
    if (range && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
      setChosen([...new Set([...chosen, ...all.slice(a, b + 1)])].sort((x, y) => x - y))
    } else setChosen(chosen.includes(i) ? chosen.filter((p) => p !== i) : [...chosen, i].sort((x, y) => x - y))
    anchor.current = i
  }
  const done = (): void => {
    updateView(info.id, { selected: chosen })
    onClose(chosen)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(null)
      if (e.key === 'Enter') done()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  const W = 84
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <div role="dialog" aria-modal="true" aria-label={t('choosePages')} className="flex max-h-full w-[min(760px,100%)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl" data-page-picker="">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="me-auto text-[15px] font-semibold">{t('choosePages')}</h2>
          {(
            [
              ['all', all],
              ['odd', all.filter((i) => i % 2 === 0)],
              ['even', all.filter((i) => i % 2 === 1)],
              ['none', []]
            ] as const
          ).map(([key, pages]) => (
            <button key={key} type="button" className="rounded-full border border-line px-3 py-1 text-[12px] hover:bg-surface-2" onClick={() => setChosen([...pages])}>
              {t(`pick.${key}`)}
            </button>
          ))}
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-3 overflow-y-auto bg-sunken p-4">
          {info.pages.slice(0, 2000).map((p, i) => {
            const on = chosen.includes(i)
            const h = Math.min(W * 1.4, (p.height / p.width) * W)
            return (
              <button
                key={i}
                type="button"
                onClick={(e) => toggle(i, e.shiftKey)}
                aria-pressed={on}
                className={clsx('relative flex flex-col items-center gap-1 rounded-lg border-2 p-1.5', on ? 'border-accent bg-accent-soft' : 'border-transparent hover:border-line')}
              >
                <span className="flex items-center justify-center" style={{ height: W * 1.4 }}>
                  <PageImage docId={info.id} revision={info.revision} page={i} width={(p.width / p.height) * h} height={h} pointsWide={p.width} className="page-shadow rounded-sm" />
                </span>
                <span className={clsx('text-[11px] tabular-nums', on ? 'font-semibold text-accent' : 'text-muted')}>{i + 1}</span>
                <span className={clsx('absolute end-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border-2', on ? 'border-accent bg-accent text-accent-ink' : 'border-faint bg-surface/80')}>
                  {on && <CheckIcon size={12} strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="me-auto text-[12px] text-muted">{chosen.length ? t('selected', { count: chosen.length }) : t('pickerHint')}</span>
          <Button onClick={() => onClose(null)}>{t('cancel')}</Button>
          <Button variant="primary" onClick={done}>
            {chosen.length ? t('useTheseCount', { count: chosen.length }) : t('useAllPages')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

const GRID: Position[] = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']

/** A 3×3 picker. Always laid out as the page is, left to right, whatever the interface direction. */
export function PositionPicker({ value, onChange, only }: { value: Position; onChange: (p: Position) => void; only?: Position[] }) {
  const t = useT()
  return (
    <div className="grid w-[96px] grid-cols-3 gap-1 rounded-md border border-line bg-surface-2 p-1" dir="ltr">
      {GRID.map((p) => {
        const enabled = !only || only.includes(p)
        return (
          <button
            key={p}
            type="button"
            title={t(`pos.${p}` as never)}
            disabled={!enabled}
            onClick={() => onChange(p)}
            className={`h-6 rounded ${p === value ? 'bg-accent' : enabled ? 'bg-surface hover:bg-line' : 'bg-transparent'}`}
          />
        )
      })}
    </div>
  )
}

/**
 * The panel's foot, as Acrobat's: an outlined Cancel beside the primary button, which names
 * what it does ("Add watermark", not "Apply"), at the bottom right.
 */
export function ToolFooter({ children }: { children: React.ReactNode }) {
  const t = useT()
  return (
    <div className="sticky -bottom-4 -mx-4 -mb-4 mt-auto flex justify-end gap-2 border-t border-line bg-surface px-4 py-3" data-tool-footer="">
      <Button onClick={() => openTool(null)}>{t('cancel')}</Button>
      {children}
    </div>
  )
}

export const MM = 72 / 25.4

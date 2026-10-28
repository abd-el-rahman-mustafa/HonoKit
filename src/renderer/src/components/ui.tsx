import clsx from 'clsx'
import { Check as CheckIcon, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeBox } from './menuPlace'
import { t } from '../store'
import { pageUrl } from '@shared/ipc'
import { exactPixels, stepScale, watchPixelRatio } from '@shared/pixels'

/** The few building blocks every screen uses. Logical properties only (ms-, pe-, start-) so RTL just works. */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: ReactNode }

export function Button({ variant = 'secondary', icon, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink hover:bg-surface-2',
        variant === 'danger' && 'border border-line bg-surface text-danger hover:bg-surface-2',
        className
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={clsx(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-35',
        active && 'bg-accent-soft text-accent',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="text-[12px] text-danger">{error}</span> : hint ? <span className="text-[12px] leading-snug text-faint">{hint}</span> : null}
    </label>
  )
}

const inputClass =
  'h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-faint focus:border-accent focus:ring-3 focus:ring-accent/20'

export function TextInput(props: React.ComponentProps<'input'>) {
  return <input {...props} className={clsx(inputClass, props.className)} />
}

export function NumberInput({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  // Numbers and their unit always read left to right, in either interface direction;
  // otherwise the unit sits on top of the digits in Arabic.
  return (
    <div className="relative" dir="ltr">
      <input
        type="number"
        className={clsx(inputClass, 'tabular-nums', suffix && (suffix.length > 2 ? 'pe-11' : 'pe-7'))}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)))
        }}
      />
      {suffix ? <span className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-[12px] text-faint">{suffix}</span> : null}
    </div>
  )
}

/** Where a popover goes: under its button, flipped above near the window's foot, kept on screen. */
export function place(anchor: DOMRect, width: number, height: number): React.CSSProperties {
  const view = { width: window.innerWidth, height: window.innerHeight }
  return { position: 'fixed', ...placeBox(anchor, width, height, view, document.documentElement.dir === 'rtl') }
}

/** Closes a popover on a click elsewhere, Escape, scrolling or the window losing focus. */
export function useDismiss(open: boolean, close: () => void, ...inside: Array<React.RefObject<HTMLElement | null>>): void {
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!inside.some((r) => r.current?.contains(e.target as Node))) close()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const scroll = (e: Event): void => {
      if (!inside.some((r) => r.current?.contains(e.target as Node))) close()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', close)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A dropdown in the app's own style (a native <select> looks like an old Windows control and
 * cannot follow the theme): a field-like button with a chevron, and a list with a check on
 * the current choice. Arrow keys move, Enter chooses, Escape closes.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  compact,
  className
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; hint?: string }>
  label?: string
  compact?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), button, list)
  const current = options.find((o) => o.value === value)
  /**
   * How tall the list really is, read once it has been laid out. A choice is one line, or two
   * when it carries a hint, or more when a long hint wraps, so the only honest answer is the
   * measured one: the height decides whether the list fits under the control or has to flip
   * above it, and a guess left a menu of two-line choices running off the foot of the window.
   */
  const [height, setHeight] = useState<number | null>(null)
  const shape = JSON.stringify(options.map((o) => [o.label, o.hint ?? '']))
  useLayoutEffect(() => {
    if (!open) return setHeight(null)
    if (list.current) setHeight(list.current.getBoundingClientRect().height)
  }, [open, shape])
  const show = (): void => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const choose = (v: T): void => {
    onChange(v)
    setOpen(false)
    button.current?.focus()
  }
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            show()
          } else if (open && e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(options.length - 1, a + 1))
          } else if (open && e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (open && e.key === 'Enter') {
            e.preventDefault()
            choose(options[active]!.value)
          }
        }}
        className={clsx(
          'flex items-center gap-1.5 rounded-lg border border-line bg-surface text-start text-[13px] text-ink outline-none transition-[border-color,box-shadow] hover:border-faint focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20',
          compact ? 'h-7 px-2' : 'h-8 w-full px-2.5',
          open && 'border-accent ring-3 ring-accent/20',
          className
        )}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown size={14} className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            className="z-[60] max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-xl"
            // Laid out out of sight at its own height first, then placed by what it measures.
            style={
              height === null
                ? { position: 'fixed', left: rect.left, top: 0, width: Math.max(rect.width, 160), visibility: 'hidden' }
                : place(rect, Math.max(rect.width, 160), height)
            }
            data-select-list=""
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
                className={clsx('flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1 text-start text-[13px]', i === active && 'bg-surface-2')}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{o.label}</span>
                  {o.hint && <span className="text-[11px] text-muted">{o.hint}</span>}
                </span>
                {o.value === value && <CheckIcon size={14} className="shrink-0 text-accent" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

/**
 * Choices side by side (Spectrum's segmented control), the chosen one raised. Labels never
 * wrap or get cut: when they do not fit the space (a narrow panel, a long Arabic label), the
 * same choices are shown as a stacked list instead, measured again whenever the space changes.
 */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; icon?: ReactNode; hint?: string }> }) {
  const wrap = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  /** The width the choices need side by side, measured once they were laid out that way. */
  const natural = useRef(0)
  const [stacked, setStacked] = useState(false)
  const key = options.map((o) => o.label).join('|')
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const check = (): void => {
      if (row.current) natural.current = row.current.scrollWidth
      const need = natural.current
      setStacked(need > 0 && need > el.clientWidth + 1)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [key, stacked])
  return (
    <div ref={wrap} className="w-full" role="radiogroup">
      {stacked ? (
        <div className="flex flex-col gap-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              onClick={() => onChange(o.value)}
              className={clsx(
                'flex min-h-9 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-start text-[13px] transition-colors',
                o.value === value ? 'border-accent bg-accent-soft/60 font-medium' : 'border-line hover:border-faint'
              )}
            >
              <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', o.value === value ? 'border-accent' : 'border-faint')}>
                {o.value === value && <span className="h-2 w-2 rounded-full bg-accent" />}
              </span>
              {o.icon}
              <span className="flex flex-col">
                <span>{o.label}</span>
                {o.hint && <span className="text-[11px] text-muted">{o.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div ref={row} className="flex w-max min-w-full rounded-lg border border-line bg-surface-2 p-0.5">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              title={o.hint ?? o.label}
              onClick={() => onChange(o.value)}
              className={clsx(
                'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors',
                o.value === value ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink'
              )}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A checkbox drawn in the app's style, with its label; the whole row is clickable. */
export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="group flex cursor-pointer items-start gap-2.5 text-[13px]">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        className={clsx(
          'mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-3 peer-focus-visible:ring-accent/25',
          checked ? 'border-accent bg-accent text-accent-ink' : 'border-faint bg-surface group-hover:border-muted'
        )}
        aria-hidden="true"
      >
        {checked && <CheckIcon size={13} strokeWidth={3} />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="leading-[20px]">{label}</span>
        {hint && <span className="text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
    </label>
  )
}

/** An on/off switch, for settings that take effect at once (Fluent and Spectrum both use these there). */
export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 text-[13px]">
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden="true"
        className={clsx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors peer-focus-visible:ring-3 peer-focus-visible:ring-accent/25',
          checked ? 'bg-accent' : 'bg-line'
        )}
      >
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[inset-inline-start]', checked ? 'start-[18px]' : 'start-0.5')} />
      </span>
    </label>
  )
}

const SWATCHES = ['#000000', '#374151', '#9ca3af', '#ffffff', '#c0392b', '#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#1473e6', '#1e3a8a', '#7c3aed', '#db2777']

/**
 * A colour choice as a swatch (the native colour input is a grey Windows box): a palette of
 * common colours, and "Custom colour…" for any other.
 */
export function ColourPicker({ value, onChange, label, compact }: { value: string; onChange: (c: string) => void; label: string; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const custom = useRef<HTMLInputElement>(null)
  useDismiss(open, () => setOpen(false), button, panel)
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  return (
    <>
      <button
        ref={button}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface outline-none hover:border-faint focus-visible:ring-3 focus-visible:ring-accent/20',
          compact ? 'h-7 w-9' : 'h-8 w-full justify-start px-2',
          open && 'border-accent'
        )}
      >
        <span className="h-4 w-4 shrink-0 rounded-full border border-black/15 shadow-inner" style={{ background: value }} />
        {!compact && (
          <span className="text-[12px] text-muted uppercase" dir="ltr">
            {value}
          </span>
        )}
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={panel} className="z-[60] rounded-xl border border-line bg-surface p-2.5 shadow-xl" style={place(rect, 212, 150)} data-colour-picker="">
            <div className="grid grid-cols-7 gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  title={c}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(c)
                    setOpen(false)
                  }}
                  className={clsx('h-6 w-6 rounded-full border border-black/15 transition-transform hover:scale-110', value.toLowerCase() === c && 'ring-2 ring-accent ring-offset-2 ring-offset-surface')}
                  style={{ background: c }}
                />
              ))}
            </div>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => custom.current?.click()}
              className="mt-2 flex h-7 w-full items-center gap-2 rounded-lg px-1.5 text-[12px] text-muted hover:bg-surface-2 hover:text-ink"
            >
              <span className="h-4 w-4 rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" />
              {t('customColour')}
            </button>
            <input ref={custom} type="color" className="sr-only" value={value} onChange={(e) => onChange(e.target.value)} tabIndex={-1} aria-hidden="true" />
          </div>,
          document.body
        )}
    </>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spin inline-block rounded-full border-2 border-line border-t-accent" style={{ width: size, height: size }} />
}

/**
 * The window's devicePixelRatio, kept current (§83): it changes when the window moves to a monitor
 * with another scaling, so every page picture asks again for the pixels it now covers and stays
 * sharp, without waiting for the next zoom.
 */
const ratioListeners = new Set<() => void>()
let stopWatching: (() => void) | null = null
function subscribePixelRatio(listener: () => void): () => void {
  ratioListeners.add(listener)
  if (!stopWatching)
    stopWatching = watchPixelRatio(window, () => {
      for (const l of ratioListeners) l()
    })
  return () => {
    ratioListeners.delete(listener)
    if (ratioListeners.size === 0 && stopWatching) {
      stopWatching()
      stopWatching = null
    }
  }
}

/** The current devicePixelRatio; the component renders again when it changes. */
export function usePixelRatio(): number {
  return useSyncExternalStore(subscribePixelRatio, () => window.devicePixelRatio || 1)
}

/** The render scale (pixels per point) for a page shown at `displayScale` CSS pixels per point. */
export function scaleFor(displayScale: number, dpr = window.devicePixelRatio || 1): number {
  return stepScale(displayScale, dpr)
}

/**
 * One rendered page, shown `width` × `height` CSS pixels. The picture is requested
 * lazily and at a resolution matching what is shown; `pointsWide` is the page's width
 * in points. With `exact`, the viewer's page pixel for pixel (§82): rendered at
 * exactly the device pixels it covers and shown at that size (`exactPixels`).
 */
export function PageImage({ docId, revision, page, width, height, pointsWide, className, exact }: { docId: string; revision: number; page: number; width: number; height: number; pointsWide: number; className?: string; exact?: boolean }) {
  const dpr = usePixelRatio()
  const scale = scaleFor(width / Math.max(1, pointsWide), dpr)
  const sharp = exact ? exactPixels(width, height, pointsWide, dpr) : null
  if (sharp)
    return (
      <img
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        className={clsx('block bg-white', className)}
        style={{ width: sharp.cssWidth, height: sharp.cssHeight }}
        src={pageUrl(docId, revision, page, scale, sharp.size)}
        data-exact=""
      />
    )
  return <img alt="" draggable={false} loading="lazy" decoding="async" className={clsx('block bg-white', className)} style={{ width, height }} src={pageUrl(docId, revision, page, scale)} />
}

/** A titled group in a panel: Acrobat's small UPPERCASE section headings. */
export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

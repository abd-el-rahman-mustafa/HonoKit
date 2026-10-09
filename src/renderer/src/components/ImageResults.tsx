import clsx from 'clsx'
import { ArrowRight, Check as CheckIcon, ChevronDown, CircleAlert, Maximize, Minus, Plus, Sparkles, Square, TriangleAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { format as formatSpec } from '@shared/imageFormats'
import type { ImageFileInfo, ImageRunResult } from '@shared/imageOps'
import { compareMode, resultFacts } from '@shared/imageResults'
import { formatBytes } from '../i18n'
import { handOverTo, useStore, useT, type ImageToolId } from '../store'
import { TOOLS, toolEntry } from '../tools/catalogue'
import { place, Spinner, useDismiss } from './ui'

/**
 * The image tools' results you can see (decisions §77): the output picture large, before and after
 * (a slider when the two have the same shape, a switch when the shape changed), what changed, how it
 * was made; and the tool switcher in the title that keeps the pictures.
 */

/** A whole number in the interface's digits (Arabic-Indic in Arabic). */
export const num = (language: string, n: number, digits = 0): string => new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US', { maximumFractionDigits: digits }).format(n)
/** A file name inside a sentence, kept whole in either direction (Unicode first-strong isolate). */
export const isolate = (text: string): string => String.fromCharCode(0x2068) + text + String.fromCharCode(0x2069)
const dims = (language: string, w: number, h: number): string => `${num(language, w)} × ${num(language, h)}`

/** The image tools, in the hub's order. */
const IMAGE_TOOL_LIST = TOOLS.filter((x) => x.group === 'images')

/** Where Close goes back to (the tab or the Home page the tool was opened over), for its tooltip. */
export function useBackLabel(): string {
  const t = useT()
  const place = useStore((s) => {
    const active = s.active
    if (active && s.pictures[active]) return s.pictures[active].name
    if (active && s.docs[active]) return s.docs[active].info.name
    return s.homeSection === 'images' ? t('group.images') : s.homeSection === 'pdf' ? t('hub.pdf') : t('home')
  })
  return t('img.backTo', { place })
}

/**
 * The tool's title as a menu: every image tool; the chosen one opens with the pictures on the board.
 * After a run it asks which pictures go along — the results (default) or the originals.
 */
export function ToolSwitcher({ tool, originals, results, disabled }: { tool: ImageToolId; originals: string[]; results: string[]; disabled?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [take, setTake] = useState<'results' | 'originals'>('results')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    button.current?.focus()
  }
  useDismiss(open, close, button, menu)
  const { icon: Icon, hue } = toolEntry(tool)
  const both = results.length > 0 && originals.length > 0
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true], [role=menuitem]')?.focus()
  }, [open])
  const go = (next: ImageToolId): void => {
    setOpen(false)
    if (next === tool) return
    handOverTo(next, both && take === 'originals' ? originals : results.length ? results : originals)
  }
  const keys = (e: React.KeyboardEvent): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem], [role=menuitemradio]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (i: number): void => {
      e.preventDefault()
      items[(i + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'Tab') close()
  }
  const height = Math.min(window.innerHeight * 0.8, IMAGE_TOOL_LIST.length * 36 + (both ? 92 : 12))
  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        title={t('img.switchTool')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx(
          'group -ms-1.5 me-2 flex h-10 min-w-0 items-center gap-2.5 rounded-xl border px-1.5 pe-2.5 text-start transition-colors disabled:cursor-default disabled:opacity-100',
          open ? 'border-accent bg-accent-soft/50' : 'border-transparent hover:border-line hover:bg-surface-2'
        )}
        data-tool-switcher=""
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `hsl(${hue} 80% 55% / 0.14)`, color: `hsl(${hue} 68% 44%)` }}>
          <Icon size={18} />
        </span>
        <h1 className="truncate text-[16px] font-semibold">{t(`tool.${tool}`)}</h1>
        {!disabled && <ChevronDown size={16} className={clsx('shrink-0 text-faint transition-transform group-hover:text-muted', open && 'rotate-180')} />}
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={menu} role="menu" aria-label={t('img.switchTool')} onKeyDown={keys} className="z-[60] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-2xl" style={{ ...place(rect, 288, height), maxHeight: height }} data-tool-switcher-menu="">
            {both && (
              <div className="mb-1 flex flex-col gap-1 border-b border-line px-2 pt-1.5 pb-2" role="group" aria-label={t('img.take')}>
                <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('img.take')}</span>
                <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
                  {(['results', 'originals'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="menuitemradio"
                      aria-checked={take === k}
                      onClick={() => setTake(k)}
                      className={clsx('h-7 flex-1 truncate rounded-md px-2 text-[12px] font-medium', take === k ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}
                      data-switch-take={k}
                    >
                      {k === 'results' ? t('img.takeResults', { count: results.length }) : t('img.takeOriginals', { count: originals.length })}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {IMAGE_TOOL_LIST.map(({ id, icon: ItemIcon, hue: h }) => {
              const current = id === tool
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  aria-current={current || undefined}
                  onClick={() => (current ? close() : go(id as ImageToolId))}
                  className={clsx('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] focus-visible:outline-none', current ? 'bg-accent-soft/60 font-medium' : 'hover:bg-surface-2 focus-visible:bg-surface-2')}
                  data-switch-to={id}
                >
                  <ItemIcon size={17} className="shrink-0" style={{ color: `hsl(${h} 68% 46%)` }} />
                  <span className="flex-1 truncate">{t(`tool.${id}`)}</span>
                  {current && (
                    <span className="flex items-center gap-1 text-[11px] text-accent">
                      <CheckIcon size={14} />
                      {t('img.openNow')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

/** "Continue with ▾": the image tools, each opening with these pictures (the Photo editor's saved copy). */
export function ContinueMenu({ paths, exclude }: { paths: string[]; exclude: ImageToolId }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    button.current?.focus()
  }
  useDismiss(open, close, button, menu)
  const tools = IMAGE_TOOL_LIST.filter((x) => x.id !== exclude && x.id !== 'imgGif')
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [open])
  const keys = (e: React.KeyboardEvent): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const move = (i: number): void => {
      e.preventDefault()
      items[(i + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'Tab') close()
  }
  const height = Math.min(window.innerHeight * 0.7, tools.length * 36 + 8)
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx('inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap', open ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface hover:bg-surface-2')}
        data-continue-menu=""
      >
        {t('editor.continueWith')}
        <ChevronDown size={14} className="text-faint" />
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={menu} role="menu" onKeyDown={keys} className="z-[60] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-2xl" style={{ ...place(rect, 260, height), maxHeight: height }}>
            {tools.map(({ id, icon: ItemIcon, hue }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  handOverTo(id as ImageToolId, paths)
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              >
                <ItemIcon size={17} className="shrink-0" style={{ color: `hsl(${hue} 68% 46%)` }} />
                <span className="truncate">{t(`tool.${id}`)}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

/** A picture's preview at about `size` px, drawn by the worker (any format). */
function usePreview(path: string | null, size: number): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!path) return
    let live = true
    void window.api.imageDescribe(path, size).then((r) => live && r.ok && setSrc(r.value.preview))
    return () => {
      live = false
    }
  }, [path, size])
  return src
}

/** A result's own small picture on a checkerboard (transparency shows). */
export function ResultThumb({ path, fallback, size = 48 }: { path: string; fallback?: string; size?: number }) {
  const src = usePreview(path, 160)
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:8px_8px] ring-1 ring-line" style={{ width: size, height: Math.round(size * 0.8) }}>
      {(src ?? fallback) ? <img src={src ?? fallback} alt="" className="max-h-full max-w-full object-contain" /> : <Square size={16} className="text-faint" />}
    </span>
  )
}

const CHECKER = 'bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:16px_16px]'
const ZOOMS = [1, 2, 4, 8]

/**
 * The output large, compared with the original. Slider: the two drawn over each other at the same
 * size, the original on the start side of the handle. Switch: one at a time, each at its own shape.
 * Zoom (1–8×) moves both together; drag to pan when zoomed. The original is never enlarged by the
 * worker, so an upscale is compared with what plain enlarging would show.
 */
export function CompareStage({ tool, before, after }: { tool: ImageToolId; before: { path: string; info: ImageFileInfo }; after: ImageRunResult }) {
  const t = useT()
  const mode = compareMode(tool, before.info, after)
  const size = Math.min(2400, Math.max(640, after.width, after.height))
  const afterSrc = usePreview(after.path, size)
  const beforeSrc = usePreview(mode === 'none' ? null : before.path, size)
  const [side, setSide] = useState<'before' | 'after'>('after')
  const [split, setSplit] = useState(0.5)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const box = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  const drag = useRef<{ kind: 'split' | 'pan'; x: number; y: number; pan: { x: number; y: number } } | null>(null)
  const rtl = document.documentElement.dir === 'rtl'

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setArea({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setSplit(0.5)
    setSide('after')
  }, [after.path, after.size])

  // What is drawn: the after picture's shape (or the one shown, in switch mode), fitted.
  const shown = mode === 'switch' && side === 'before' ? before.info : after
  const pad = 24
  const fit = area.w > 0 ? Math.min((area.w - 2 * pad) / shown.width, (area.h - 2 * pad) / shown.height) : 0
  const w = Math.max(1, Math.round(shown.width * fit))
  const h = Math.max(1, Math.round(shown.height * fit))
  const left = Math.round((area.w - w) / 2)
  const top = Math.round((area.h - h) / 2)
  const limit = (p: { x: number; y: number }, z = zoom): { x: number; y: number } => ({ x: Math.max(-(w * (z - 1)) / 2, Math.min((w * (z - 1)) / 2, p.x)), y: Math.max(-(h * (z - 1)) / 2, Math.min((h * (z - 1)) / 2, p.y)) })
  const setZoomTo = (z: number): void => {
    setZoom(z)
    setPan((p) => limit({ x: (p.x * z) / zoom, y: (p.y * z) / zoom }, z))
  }
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
  /** The handle, in px from the stage's left edge. */
  const handleX = left + (rtl ? 1 - split : split) * w
  const layer = (src: string | null, label: string): React.ReactNode =>
    src ? (
      <img src={src} alt={label} draggable={false} className="absolute max-w-none select-none" style={{ left, top, width: w, height: h, transform, transformOrigin: 'center' }} />
    ) : null

  const pointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const onHandle = (e.target as HTMLElement).closest('[data-compare-handle]')
    const kind = mode === 'slider' && (onHandle || zoom === 1) ? 'split' : zoom > 1 ? 'pan' : null
    if (!kind) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.clientX, y: e.clientY, pan }
    if (kind === 'split') moveSplit(e.clientX)
  }
  const moveSplit = (clientX: number): void => {
    const r = box.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left - left) / w))
    setSplit(rtl ? 1 - f : f)
  }
  const pointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'split') moveSplit(e.clientX)
    else setPan(limit({ x: d.pan.x + e.clientX - d.x, y: d.pan.y + e.clientY - d.y }))
  }
  const sliderKeys = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 0.1 : 0.02
    const towardsEnd = e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')
    const towardsStart = e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
    if (towardsEnd || towardsStart || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setSplit((s) => (e.key === 'Home' ? 0 : e.key === 'End' ? 1 : Math.max(0, Math.min(1, s + (towardsEnd ? step : -step)))))
    }
  }
  const loading = !afterSrc || (mode !== 'none' && !beforeSrc)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-compare-stage="" data-compare-mode={mode}>
      <div
        ref={box}
        className={clsx('relative min-h-0 flex-1 overflow-hidden', zoom > 1 && 'cursor-grab active:cursor-grabbing', mode === 'slider' && zoom === 1 && 'cursor-ew-resize')}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => {
          if (!e.ctrlKey) return
          const i = ZOOMS.indexOf(zoom)
          setZoomTo(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (e.deltaY < 0 ? 1 : -1)))]!)
        }}
      >
        {/* The picture's area, a checkerboard so transparency shows; the zoomed pictures are clipped to it. */}
        <div className={clsx('absolute overflow-hidden rounded-[3px] shadow-[0_1px_3px_rgb(0_0_0/0.12),0_0_0_1px_var(--line)]', CHECKER)} style={{ left, top, width: w, height: h }}>
          <div className="absolute" style={{ left: -left, top: -top, width: area.w, height: area.h }}>
            {mode === 'switch' ? layer(side === 'before' ? beforeSrc : afterSrc, t(side === 'before' ? 'img.before' : 'img.after')) : layer(afterSrc, t('img.after'))}
            {mode === 'slider' && beforeSrc && (
              <div className="absolute inset-0" style={{ clipPath: rtl ? `inset(0 0 0 ${handleX}px)` : `inset(0 ${area.w - handleX}px 0 0)` }}>
                {/* The original's own checkerboard: its transparency shows on its side too. */}
                <div className={clsx('absolute', CHECKER)} style={{ left, top, width: w, height: h }} />
                {layer(beforeSrc, t('img.before'))}
              </div>
            )}
          </div>
        </div>
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size={24} />
          </span>
        )}
        {mode === 'slider' && !loading && (
          <>
            <span className="pointer-events-none absolute w-0.5 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" style={{ left: handleX - 1, top, height: h }} />
            <span
              role="slider"
              tabIndex={0}
              aria-label={t('img.compareSlider')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(split * 100)}
              aria-valuetext={`${t('img.before')} ${Math.round(split * 100)}%`}
              onKeyDown={sliderKeys}
              className="absolute flex h-9 w-9 cursor-ew-resize items-center justify-center rounded-full border-2 border-white bg-ink/70 text-white shadow-lg backdrop-blur-sm"
              style={{ left: handleX - 18, top: top + h / 2 - 18 }}
              data-compare-handle=""
            >
              <ChevronDown size={14} className="rotate-90" />
              <ChevronDown size={14} className="-rotate-90" />
            </span>
            <span className="pointer-events-none absolute rounded-full bg-ink/70 px-2.5 py-0.5 text-[11px] font-semibold text-white" style={{ top: top + 10, insetInlineStart: rtl ? area.w - left - w + 10 : left + 10 }}>
              {t('img.before')}
            </span>
            <span className="pointer-events-none absolute rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-accent-ink" style={{ top: top + 10, insetInlineEnd: rtl ? left + 10 : area.w - left - w + 10 }}>
              {t('img.after')}
            </span>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-line bg-surface px-4 py-2">
        {mode === 'switch' && (
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5" role="radiogroup" aria-label={`${t('img.before')} / ${t('img.after')}`}>
            {(['before', 'after'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={side === k}
                onClick={() => setSide(k)}
                className={clsx('h-7 min-w-20 rounded-md px-3 text-[12px] font-medium', side === k ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}
                data-compare-side={k}
              >
                {t(k === 'before' ? 'img.before' : 'img.after')}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5" dir="ltr">
          <ZoomButton label={t('img.zoomOut')} disabled={zoom === 1} onClick={() => setZoomTo(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}>
            <Minus size={14} />
          </ZoomButton>
          <span className="w-10 text-center text-[12px] font-medium tabular-nums">{zoom}×</span>
          <ZoomButton label={t('img.zoomIn')} disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoomTo(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}>
            <Plus size={14} />
          </ZoomButton>
          <ZoomButton label={t('img.zoomFit')} disabled={zoom === 1} onClick={() => setZoomTo(1)}>
            <Maximize size={13} />
          </ZoomButton>
        </div>
      </div>
    </div>
  )
}

function ZoomButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-ink hover:bg-surface-2 disabled:opacity-35 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

/** How the picture was made: AI with its model, or — said plainly — a smooth resize, and why. */
export function MethodLine({ result }: { result: ImageRunResult }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const m = result.method
  if (!m) return null
  const seconds = result.ms !== undefined && result.ms >= 1000 ? ` · ${t('img.took', { seconds: num(language, result.ms / 1000, result.ms < 10_000 ? 1 : 0) })}` : ''
  if (m.kind === 'smooth-upscale')
    return (
      <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-snug" data-method={m.kind}>
        <TriangleAlert size={15} className="mt-px shrink-0 text-warn" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">{t('img.method.smooth-upscale') + seconds}</span>
          <span className="[overflow-wrap:anywhere] text-muted" dir="auto">
            {t('img.method.smoothWhy', { reason: m.reason ?? '' })}
          </span>
        </span>
      </p>
    )
  // Model names never break at their hyphen (a non-breaking hyphen, U+2011).
  const label = (m.kind === 'hidden' ? t('img.method.hidden', { count: num(language, m.count ?? 0) }) : t(`img.method.${m.kind}`)).replace(/(Real|U²)-(ESRGAN|Net)/g, (_, a: string, b: string) => a + String.fromCharCode(0x2011) + b)
  return (
    <p className="flex items-start gap-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-[12px] leading-snug font-medium text-ink" data-method={m.kind} title={m.model}>
      <Sparkles size={15} className="mt-px shrink-0 text-accent" />
      <span>{label + seconds}</span>
    </p>
  )
}

/** One result's facts: file, pixels before → after (and the factor), bytes before → after, format. */
export function ResultFacts({ before, result }: { before: ImageFileInfo; result: ImageRunResult }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const f = resultFacts(before, result)
  const factor = f.scale !== null && f.scale !== 1 ? `${num(language, f.scale, 2)}×` : null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]" data-result-facts="">
      <dt className="text-muted">{t('img.dimensions')}</dt>
      <dd className="flex flex-wrap items-center gap-1 font-medium tabular-nums">
        {f.resized ? (
          <>
            <span className="text-muted" dir="ltr">{dims(language, before.width, before.height)}</span>
            <ArrowRight size={12} className="text-faint rtl:rotate-180" />
            <span dir="ltr">{dims(language, result.width, result.height)}</span>
            {factor && <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent">{factor}</span>}
          </>
        ) : (
          <span dir="ltr">{dims(language, result.width, result.height)}</span>
        )}
      </dd>
      <dt className="text-muted">{t('img.fileSize')}</dt>
      <dd className="flex flex-wrap items-center gap-1 font-medium tabular-nums">
        <span className="text-muted">{formatBytes(language, before.size)}</span>
        <ArrowRight size={12} className="text-faint rtl:rotate-180" />
        <span>{formatBytes(language, result.size)}</span>
        {result.unchanged ? null : f.sizeChange > 0 ? (
          <span className="rounded-full bg-ok/12 px-1.5 text-[11px] text-ok" data-size-change="">
            {t('img.saved', { percent: num(language, f.sizeChange) })}
          </span>
        ) : f.sizeChange < 0 ? (
          <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted" data-size-change="">
            {t('img.bigger', { percent: num(language, -f.sizeChange) })}
          </span>
        ) : null}
      </dd>
      <dt className="text-muted">{t('img.format')}</dt>
      <dd className="flex flex-wrap items-center gap-1 font-medium">
        {f.converted ? (
          <>
            <span className="text-muted">{formatSpec(before.format).label}</span>
            <ArrowRight size={12} className="text-faint rtl:rotate-180" />
          </>
        ) : null}
        {formatSpec(result.format).label}
        {result.quality !== undefined && <span className="ms-1 font-normal text-muted">· {t('img.qualityUsed', { quality: num(language, result.quality) })}</span>}
      </dd>
      {result.unchanged && <dd className="col-span-2 text-muted">{t('img.unchangedLong')}</dd>}
    </dl>
  )
}

/** The result cards under the stage, when there are several (or one failed): pick one to look at. */
export function ResultStrip({ items, selected, onSelect }: { items: Array<{ key: string; name: string; preview?: string; result?: ImageRunResult; error?: string; before?: ImageFileInfo }>; selected: string | null; onSelect: (key: string) => void }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-line bg-surface px-4 py-3" role="listbox" aria-label={t('img.results')} data-result-strip="">
      {items.map((x) => {
        const change = x.result && x.before && !x.result.unchanged ? resultFacts(x.before, x.result).sizeChange : null
        return (
          <button
            key={x.key}
            type="button"
            role="option"
            aria-selected={selected === x.key}
            disabled={!x.result}
            onClick={() => onSelect(x.key)}
            title={x.error ?? x.result?.path}
            className={clsx(
              'flex w-[150px] shrink-0 items-center gap-2 rounded-lg border p-1.5 text-start transition-colors',
              selected === x.key ? 'border-accent bg-accent-soft/50 ring-2 ring-accent/20' : 'border-line hover:border-faint',
              !x.result && 'cursor-default border-danger/40'
            )}
            data-result-item=""
          >
            {x.result ? <ResultThumb path={x.result.path} fallback={x.preview} size={44} /> : <CircleAlert size={20} className="mx-3 shrink-0 text-danger" />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12px] font-medium" dir="auto">
                {x.result ? x.result.path.split(/[\\/]/).pop() : x.name}
              </span>
              <span className={clsx('truncate text-[11px] tabular-nums', !x.result ? 'text-danger' : change && change > 0 ? 'text-ok' : 'text-muted')}>
                {!x.result ? t('img.failedOne') : change !== null && change !== 0 ? t(change > 0 ? 'img.saved' : 'img.bigger', { percent: num(language, Math.abs(change)) }) : formatBytes(language, x.result.size)}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

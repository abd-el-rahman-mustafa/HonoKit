import clsx from 'clsx'
import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, FolderOpen, Maximize, RotateCcw, RotateCw, SquarePen, Wrench, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { format as formatSpec } from '@shared/imageFormats'
import type { ImageFileInfo } from '@shared/imageOps'
import { formatBytes } from '../i18n'
import { editPicture, handOverTo, showPicture, useStore, useT, type ImageToolId, type PictureView } from '../store'
import { HUBS, TOOLS } from '../tools/catalogue'
import { SharePictureMenu } from './ShareMenu'
import { place, Spinner, useDismiss, usePixelRatio } from './ui'

/**
 * The picture viewer (decisions §75): a picture opened from Explorer, Recent, Places, drag and
 * drop or Open image, in a tab like a document's. Fit to the window, zoom (wheel, keys, buttons)
 * around the pointer, drag to move, turn the view, previous and next among the pictures of the
 * same folder (arrow keys, mirrored in Arabic). Edit opens the Photo editor with the picture, and
 * Tools any image tool with it already added; closing either comes back here. The worker decodes
 * the picture (imageDecode), so every format the image tools read shows: HEIC, RAW, PSD, JXL …
 * Turning here only turns the view; the file is never changed.
 */

/** Zoom levels: picture pixels per screen pixel (1 = actual size). */
const LEVELS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]
const MARGIN = 24

interface Loaded {
  url: string
  width: number
  height: number
}

/** The tools the Tools menu offers for one picture: Make a GIF needs several; GIF to pictures an animation. */
const toolsFor = (info: ImageFileInfo | null): typeof TOOLS =>
  TOOLS.filter((x) => HUBS.images.includes(x.group) && x.id !== 'imgEditor' && x.id !== 'imgGif' && (x.id !== 'imgFrames' || (info?.frames ?? 1) > 1))

export function PictureViewer({ picture }: { picture: PictureView }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const { path } = picture
  const [siblings, setSiblings] = useState<string[]>([path])
  const [info, setInfo] = useState<ImageFileInfo | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [level, setLevel] = useState<number | 'fit'>('fit')
  const [turn, setTurn] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [box, setBox] = useState({ width: 800, height: 600 })
  const stage = useRef<HTMLDivElement>(null)
  // Kept current: moved to a monitor with another scaling, 1:1 is still one picture pixel per screen pixel (§83).
  const dpr = usePixelRatio()
  const folder = path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))

  // The pictures beside this one, once per folder.
  useEffect(() => {
    let live = true
    void window.api.picturesBeside(path).then((list) => live && setSiblings(list.length ? list : [path]))
    return () => {
      live = false
    }
  }, [folder]) // eslint-disable-line react-hooks/exhaustive-deps

  // Describe first (a small preview, the size and format), then decode the whole picture.
  useEffect(() => {
    let live = true
    let url: string | null = null
    setInfo(null)
    setLoaded(null)
    setFailed(null)
    setLevel('fit')
    setTurn(0)
    setPan({ x: 0, y: 0 })
    void window.api.imageDescribe(path).then((r) => {
      if (!live) return
      if (r.ok) setInfo(r.value)
      else setFailed(r.error.message)
    })
    void window.api.imageDecode(path).then((r) => {
      if (!live) return
      if (!r.ok) {
        setFailed(r.error.message)
        return
      }
      url = URL.createObjectURL(new Blob([r.value.data as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
      setLoaded({ url, width: r.value.width, height: r.value.height })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    setBox({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const width = loaded?.width ?? info?.width ?? 0
  const height = loaded?.height ?? info?.height ?? 0
  const sideways = turn % 180 !== 0
  const shownW = sideways ? height : width
  const shownH = sideways ? width : height
  // Fit: the whole picture in the window, never enlarged past actual size.
  const fitScale = width && height ? Math.min(1 / dpr, (box.width - MARGIN * 2) / shownW, (box.height - MARGIN * 2) / shownH) : 1 / dpr
  const fitLevel = Math.max(0.01, fitScale * dpr)
  const current = level === 'fit' ? fitLevel : level
  /** CSS pixels per picture pixel. */
  const scale = current / dpr

  /** Keeps the picture from being dragged out of sight. */
  const clamp = useCallback(
    (p: { x: number; y: number }, s: number): { x: number; y: number } => {
      const maxX = Math.max(0, (shownW * s - box.width) / 2 + MARGIN)
      const maxY = Math.max(0, (shownH * s - box.height) / 2 + MARGIN)
      return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) }
    },
    [shownW, shownH, box.width, box.height]
  )

  /** Zooms to `next` keeping the point under `at` (stage pixels from its centre) where it is. */
  const zoomTo = useCallback(
    (next: number | 'fit', at = { x: 0, y: 0 }): void => {
      if (next === 'fit') {
        setLevel('fit')
        setPan({ x: 0, y: 0 })
        return
      }
      const target = Math.min(16, Math.max(Math.min(0.05, fitLevel), next))
      const ratio = target / current
      setLevel(target)
      setPan((p) => clamp({ x: at.x - (at.x - p.x) * ratio, y: at.y - (at.y - p.y) * ratio }, target / dpr))
    },
    [current, fitLevel, clamp, dpr]
  )
  const step = (dir: 1 | -1): void => {
    const next = dir > 0 ? (LEVELS.find((z) => z > current + 0.001) ?? 16) : ([...LEVELS].reverse().find((z) => z < current - 0.001) ?? 0.05)
    // Coming back down past the fitted size lands on it, as viewers do.
    if ((dir < 0 && next < fitLevel && current > fitLevel) || (dir > 0 && next > fitLevel && current < fitLevel)) zoomTo('fit')
    else zoomTo(next)
  }

  const index = Math.max(0, siblings.indexOf(path))
  const go = (delta: number): void => {
    if (siblings.length < 2) return
    const next = siblings[(index + delta + siblings.length) % siblings.length]!
    if (next !== path) showPicture(picture.id, next)
  }

  // Keys: arrows for previous/next (mirrored in Arabic), + − 0 1 for zoom, R to turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (s.dialog || s.tool || s.active !== picture.id) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const rtl = document.documentElement.dir === 'rtl'
      const k = e.key
      const mod = e.ctrlKey || e.metaKey
      if ((k === 'ArrowRight' || k === 'ArrowLeft') && !mod && !e.altKey) {
        e.preventDefault()
        go((k === 'ArrowRight') !== rtl ? 1 : -1)
      } else if (k === 'PageDown' || k === 'PageUp') {
        e.preventDefault()
        go(k === 'PageDown' ? 1 : -1)
      } else if (k === 'Home' || k === 'End') {
        e.preventDefault()
        const target = siblings[k === 'Home' ? 0 : siblings.length - 1]
        if (target && target !== path) showPicture(picture.id, target)
      } else if (k === '+' || k === '=') {
        e.preventDefault()
        step(1)
      } else if (k === '-' || k === '_') {
        e.preventDefault()
        step(-1)
      } else if (k === '0') {
        e.preventDefault()
        zoomTo('fit')
      } else if (k === '1' && !mod) {
        e.preventDefault()
        zoomTo(1)
      } else if ((k === 'r' || k === 'R') && !mod) {
        e.preventDefault()
        setTurn((n) => (n + (e.shiftKey ? 270 : 90)) % 360)
        setLevel('fit')
        setPan({ x: 0, y: 0 })
      } else if (k === 'e' && !mod) {
        e.preventDefault()
        editPicture(picture.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pointerAt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect()
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
  }
  const onWheel = (e: React.WheelEvent): void => {
    if (!loaded) return
    zoomTo(current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), pointerAt(e))
  }
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const zoomed = shownW * scale > box.width - MARGIN * 2 + 1 || shownH * scale > box.height - MARGIN * 2 + 1

  const bytes = info ? formatBytes(language, info.size) : null
  const digits = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US')
  const percent = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(current)
  const facts = info ? [formatSpec(info.format).label, `${digits.format(info.width)} × ${digits.format(info.height)}`, bytes, info.frames > 1 ? t('pic.frames', { count: digits.format(info.frames) }) : null].filter(Boolean).join(' · ') : ''

  return (
    <div className="flex h-full min-h-0 flex-col" data-picture-viewer="">
      <div className="@container flex h-11 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2" data-picture-bar="">
        <IconButton label={`${t('pic.previous')} (←)`} disabled={siblings.length < 2} onClick={() => go(-1)}>
          <ChevronLeft size={18} className="rtl:rotate-180" />
        </IconButton>
        <span className="min-w-14 px-1 text-center text-[12px] whitespace-nowrap text-muted tabular-nums" data-picture-position="">
          {t('pic.position', { index: digits.format(index + 1), count: digits.format(siblings.length) })}
        </span>
        <IconButton label={`${t('pic.next')} (→)`} disabled={siblings.length < 2} onClick={() => go(1)}>
          <ChevronRight size={18} className="rtl:rotate-180" />
        </IconButton>
        <span className="mx-1.5 h-5 w-px shrink-0 bg-line" />
        <IconButton label={`${t('zoomOut')} (−)`} disabled={!loaded} onClick={() => step(-1)}>
          <ZoomOut size={17} />
        </IconButton>
        <span className="w-12 text-center text-[12px] text-muted tabular-nums" title={t('pic.zoomHint')} data-zoom-shown="">
          {percent}
        </span>
        <IconButton label={`${t('zoomIn')} (+)`} disabled={!loaded} onClick={() => step(1)}>
          <ZoomIn size={17} />
        </IconButton>
        <IconButton label={`${t('pic.fit')} (0)`} active={level === 'fit'} disabled={!loaded} onClick={() => zoomTo('fit')}>
          <Maximize size={16} />
        </IconButton>
        <button
          type="button"
          title={`${t('pic.actual')} (1)`}
          aria-label={t('pic.actual')}
          aria-pressed={level === 1}
          disabled={!loaded}
          onClick={() => zoomTo(1)}
          className={clsx(
            'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1 text-[11px] font-semibold tabular-nums focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:opacity-35',
            level === 1 ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
          )}
          dir="ltr"
        >
          1:1
        </button>
        <span className="mx-1.5 h-5 w-px shrink-0 bg-line @max-[700px]:hidden" />
        <span className="flex @max-[700px]:hidden">
          <IconButton label={`${t('pic.rotateLeft')} (Shift+R)`} disabled={!loaded} onClick={() => (setTurn((n) => (n + 270) % 360), zoomTo('fit'))}>
            <RotateCcw size={16} />
          </IconButton>
          <IconButton label={`${t('pic.rotateRight')} (R)`} disabled={!loaded} onClick={() => (setTurn((n) => (n + 90) % 360), zoomTo('fit'))}>
            <RotateCw size={16} />
          </IconButton>
        </span>
        <span className="ms-2 min-w-0 flex-1 truncate text-[12px] text-muted @max-[900px]:hidden" data-picture-facts="">
          {facts}
        </span>
        <span className="flex-1 @min-[900px]:hidden" />
        <IconButton label={t('showInFolder')} onClick={() => void window.api.showInFolder(path)}>
          <FolderOpen size={17} />
        </IconButton>
        <SharePictureMenu path={path} name={picture.name} />
        <ToolsMenu info={info} onTool={(tool) => handOverTo(tool, [path])} />
        <button
          type="button"
          title={`${t('pic.editHint')} (E)`}
          onClick={() => editPicture(picture.id)}
          className="ms-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-sm hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          data-edit-button=""
        >
          <SquarePen size={15} />
          {t('read.edit')}
        </button>
      </div>

      <div
        ref={stage}
        className={clsx('relative min-h-0 flex-1 overflow-hidden bg-sunken select-none', loaded && (zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'))}
        onWheel={onWheel}
        onDoubleClick={(e) => (level === 'fit' || current < 0.999 || current > 1.001 ? zoomTo(1, pointerAt(e)) : zoomTo('fit'))}
        onPointerDown={(e) => {
          if (e.button !== 0 || !zoomed) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setPan(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }, scale))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        dir="ltr"
        data-picture-stage=""
      >
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <CircleAlert size={30} className="text-danger" />
            <p className="text-[14px] font-semibold" dir="auto">
              {t('pic.unreadable')}
            </p>
            <p className="max-w-md text-[12px] break-words text-muted" dir="auto">
              {failed}
            </p>
            <button type="button" onClick={() => void window.api.showInFolder(path)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] hover:bg-surface-2">
              <FolderOpen size={15} />
              {t('showInFolder')}
            </button>
          </div>
        ) : (
          (loaded || info) && (
            <img
              src={loaded?.url ?? info!.preview}
              alt={picture.name}
              draggable={false}
              className={clsx('absolute top-1/2 left-1/2 max-w-none shadow-[0_2px_12px_rgb(0_0_0/0.18)]', !loaded && 'blur-[2px]', info?.hasAlpha && 'picture-checker')}
              style={{
                width: width * scale,
                height: height * scale,
                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${turn}deg)`,
                imageRendering: current >= 4 ? 'pixelated' : 'auto'
              }}
              data-picture-image={loaded ? 'full' : 'preview'}
            />
          )
        )}
        {!loaded && !failed && (
          <div className="absolute start-1/2 bottom-5 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink/85 px-3.5 py-1.5 text-[12px] text-surface shadow-lg" role="status">
            <Spinner size={13} />
            {t('pic.opening')}
          </div>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:opacity-35',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}

/** Tools ▾: the image tools that take this one picture; the chosen one opens with it added. */
function ToolsMenu({ info, onTool }: { info: ImageFileInfo | null; onTool: (tool: ImageToolId) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), button, menu)
  const tools = toolsFor(info)
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  return (
    <>
      <button
        ref={button}
        type="button"
        title={t('pic.toolsHint')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className={clsx(
          'ms-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          open ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2'
        )}
        data-picture-tools=""
      >
        <Wrench size={15} />
        <span className="@max-[760px]:hidden">{t('pic.tools')}</span>
        <ChevronDown size={14} className="text-faint" />
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={menu} role="menu" className="z-[60] max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-2xl" style={place(rect, 260, Math.min(window.innerHeight * 0.7, tools.length * 36 + 8))} data-picture-tools-menu="">
            {tools.map(({ id, icon: Icon, hue }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onTool(id as ImageToolId)
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              >
                <Icon size={17} className="shrink-0" style={{ color: `hsl(${hue} 68% 46%)` }} />
                <span className="truncate">{t(`tool.${id}`)}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

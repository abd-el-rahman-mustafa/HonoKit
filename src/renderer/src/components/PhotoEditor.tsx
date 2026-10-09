import clsx from 'clsx'
import { Brush, CircleCheck, Crop, Eye, FlipHorizontal2, FlipVertical2, FolderOpen, Frame, ImagePlus, Redo2, RotateCcw, RotateCw, Save, SlidersHorizontal, Smile, Sparkles, Type, Undo2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { format as formatSpec } from '@shared/imageFormats'
import type { ImageRunResult } from '@shared/imageOps'
import { formatBytes } from '../i18n'
import { openPicture, openTool, takeHandOver, toast, useStore, useT } from '../store'
import { ContinueMenu, isolate, num, ResultThumb, ToolSwitcher, useBackLabel } from './ImageResults'
import { Button, ColourPicker, IconButton, NumberInput, Section, Select, Spinner } from './ui'
import { MarksPanel, newTextLayer, type MarkLayer } from '../tools/MarkLayers'

/**
 * The Photo editor (decisions §69), iLoveIMG's Pixie editor done offline: adjust, filters, crop
 * and turn, text, stickers, drawing, frame and rounded corners. The worker decodes any format
 * (HEIC, RAW, PSD …) to full-size pixels once; every edit is drawn here on a canvas by one
 * function, `draw`, used for the screen and for saving — so what is saved is what was shown.
 * After saving (§77) a bar shows the saved copy with Open in viewer, Show in folder and Continue
 * with; saving again in the same session updates that copy rather than adding another file.
 */

interface Adjust {
  brightness: number
  contrast: number
  saturation: number
  hue: number
  warmth: number
  fade: number
  vignette: number
  blur: number
}

interface Stroke {
  /** Points as fractions of the edited picture. */
  points: Array<[number, number]>
  colour: string
  /** Fraction of the picture's width. */
  size: number
}

interface EditState {
  adjust: Adjust
  filter: FilterId
  turn: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
  straighten: number
  /** Fractions of the turned picture; null = all of it. */
  crop: { x: number; y: number; w: number; h: number } | null
  layers: MarkLayer[]
  strokes: Stroke[]
  frame: { size: number; colour: string }
  radius: number
  background: string | null
}

type FilterId = 'none' | 'vivid' | 'warm' | 'cool' | 'mono' | 'noir' | 'sepia' | 'vintage' | 'fade' | 'dramatic' | 'polaroid' | 'kodachrome' | 'invert'

const FILTERS: Record<FilterId, string> = {
  none: '',
  vivid: 'saturate(1.45) contrast(1.1)',
  warm: 'sepia(0.25) saturate(1.25) brightness(1.03)',
  cool: 'hue-rotate(-12deg) saturate(1.1) brightness(1.03)',
  mono: 'grayscale(1)',
  noir: 'grayscale(1) contrast(1.45) brightness(0.95)',
  sepia: 'sepia(0.85)',
  vintage: 'sepia(0.4) contrast(0.9) brightness(1.05) saturate(0.85)',
  fade: 'contrast(0.85) brightness(1.08) saturate(0.8)',
  dramatic: 'contrast(1.35) saturate(1.15) brightness(0.95)',
  polaroid: 'contrast(1.1) brightness(1.05) sepia(0.15) saturate(1.2)',
  kodachrome: 'contrast(1.2) saturate(1.35) sepia(0.1) hue-rotate(-5deg)',
  invert: 'invert(1)'
}

const NO_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0, warmth: 0, fade: 0, vignette: 0, blur: 0 }
const FRESH: EditState = { adjust: NO_ADJUST, filter: 'none', turn: 0, flipH: false, flipV: false, straighten: 0, crop: null, layers: [], strokes: [], frame: { size: 0, colour: '#ffffff' }, radius: 0, background: null }

const STICKERS = ['😀', '😂', '🥰', '😎', '🤩', '😮', '😢', '😡', '👍', '👏', '🙏', '💪', '❤️', '💔', '🔥', '⭐', '✨', '🎉', '🎂', '🎁', '🌹', '🌸', '🌙', '☀️', '⛅', '🌈', '☕', '🍕', '⚽', '🏆', '📷', '🎵', '✅', '❌', '⚠️', '❓', '💯', '👉', '👈', '🕌', '🇦🇪', '🐪', '🌴', '🏖️', '✈️', '🚗', '💡', '📌']

type Tab = 'adjust' | 'filters' | 'crop' | 'text' | 'stickers' | 'draw' | 'frame'

interface Source {
  path: string
  name: string
  bitmap: ImageBitmap
  width: number
  height: number
}

/** The turned picture's size (before the crop). */
function turned(src: Source, e: EditState): { W: number; H: number } {
  return e.turn % 180 === 0 ? { W: src.width, H: src.height } : { W: src.height, H: src.width }
}

/** The edited picture's size in pixels. */
export function outputSize(src: Source, e: EditState, ignoreCrop = false): { w: number; h: number } {
  const { W, H } = turned(src, e)
  const c = !ignoreCrop && e.crop ? e.crop : { x: 0, y: 0, w: 1, h: 1 }
  return { w: Math.max(1, Math.round(c.w * W)), h: Math.max(1, Math.round(c.h * H)) }
}

/**
 * Draws the edited picture into `canvas` at `scale` (1 = full size). Stamps are the layers'
 * drawn marks, loaded. With `ignoreCrop` the whole turned picture is drawn (the crop screen).
 */
function draw(canvas: HTMLCanvasElement, src: Source, e: EditState, scale: number, stamps: Map<string, HTMLImageElement>, options: { ignoreCrop?: boolean; original?: boolean } = {}): void {
  const view: EditState = options.original ? FRESH : e
  const { W, H } = turned(src, view)
  const crop = !options.ignoreCrop && view.crop ? view.crop : { x: 0, y: 0, w: 1, h: 1 }
  const { w, h } = outputSize(src, view, options.ignoreCrop)
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.scale(scale, scale)
  const short = Math.min(w, h)
  const radius = (view.radius / 100) * short
  if (radius > 0) {
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, radius)
    ctx.clip()
  }
  if (view.background) {
    ctx.fillStyle = view.background
    ctx.fillRect(0, 0, w, h)
  }

  // The picture: turned, flipped, straightened (enlarged so no corner shows), filtered.
  ctx.save()
  ctx.translate(-crop.x * W, -crop.y * H)
  ctx.translate(W / 2, H / 2)
  const a = (view.straighten * Math.PI) / 180
  if (a) {
    const cos = Math.abs(Math.cos(a))
    const sin = Math.abs(Math.sin(a))
    const cover = Math.max((W * cos + H * sin) / W, (W * sin + H * cos) / H)
    ctx.rotate(a)
    ctx.scale(cover, cover)
  }
  ctx.scale(view.flipH ? -1 : 1, view.flipV ? -1 : 1)
  ctx.rotate((view.turn * Math.PI) / 180)
  const adj = view.adjust
  const blur = adj.blur ? ` blur(${((adj.blur / 100) * W * 0.02).toFixed(2)}px)` : ''
  ctx.filter = `${FILTERS[view.filter]} brightness(${1 + adj.brightness / 100}) contrast(${1 + adj.contrast / 100}) saturate(${1 + adj.saturation / 100}) hue-rotate(${adj.hue}deg)${blur}`.trim()
  ctx.drawImage(src.bitmap, -src.width / 2, -src.height / 2)
  ctx.restore()
  ctx.filter = 'none'

  // Warmth, fade and vignette: tinted layers over the picture.
  if (adj.warmth) {
    ctx.save()
    ctx.globalCompositeOperation = 'soft-light'
    ctx.globalAlpha = Math.min(1, Math.abs(adj.warmth) / 100) * 0.5
    ctx.fillStyle = adj.warmth > 0 ? '#ff8a1f' : '#1f7aff'
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
  if (adj.fade) {
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.globalAlpha = (adj.fade / 100) * 0.35
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }
  if (adj.vignette) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `rgba(0,0,0,${(adj.vignette / 100) * 0.75})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }

  // Drawing, then text and stickers, in the edited picture's own coordinates.
  if (!options.ignoreCrop) {
    for (const s of view.strokes) {
      if (!s.points.length) continue
      ctx.save()
      ctx.strokeStyle = s.colour
      ctx.fillStyle = s.colour
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = s.size * w
      ctx.beginPath()
      const [x0, y0] = s.points[0]!
      ctx.moveTo(x0 * w, y0 * h)
      if (s.points.length === 1) {
        ctx.arc(x0 * w, y0 * h, (s.size * w) / 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        for (const [x, y] of s.points.slice(1)) ctx.lineTo(x * w, y * h)
        ctx.stroke()
      }
      ctx.restore()
    }
    for (const l of view.layers) {
      const img = stamps.get(l.id)
      if (!img || !img.complete) continue
      const lw = l.width * w
      const lh = lw * l.aspect
      ctx.save()
      ctx.globalAlpha = l.opacity
      ctx.translate(l.x * w, l.y * h)
      ctx.rotate((l.rotate * Math.PI) / 180)
      ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh)
      ctx.restore()
    }
  }
  if (view.frame.size > 0) {
    const f = (view.frame.size / 100) * short
    ctx.strokeStyle = view.frame.colour
    ctx.lineWidth = f * 2
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, radius)
    ctx.stroke()
  }
  ctx.restore()
}

const SAVE_FORMATS = [
  { value: 'same', label: 'same' },
  { value: 'jpg', label: 'JPG' },
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WEBP' },
  { value: 'avif', label: 'AVIF' }
] as const

export function PhotoEditor() {
  const t = useT()
  const [src, setSrc] = useState<Source | null>(null)
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState<EditState>(FRESH)
  const [past, setPast] = useState<EditState[]>([])
  const [future, setFuture] = useState<EditState[]>([])
  const [tab, setTab] = useState<Tab>('adjust')
  const [layerSel, setLayerSel] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [brush, setBrush] = useState({ colour: '#e11d48', size: 1.2 })
  const [saveAs, setSaveAs] = useState<(typeof SAVE_FORMATS)[number]['value']>('same')
  const [saving, setSaving] = useState(false)
  /** The copy saved in this session (saving again replaces it), and whether its bar is shown. */
  const [saved, setSaved] = useState<ImageRunResult | null>(null)
  const [savedShown, setSavedShown] = useState(false)
  const language = useStore((s) => s.settings?.language ?? 'en')
  const backLabel = useBackLabel()
  const [ratio, setRatio] = useState<string>('free')
  const lastKey = useRef<{ key: string; at: number } | null>(null)
  const stamps = useRef(new Map<string, HTMLImageElement>())
  const [, setStampsLoaded] = useState(0)

  /** Changes the edit; slider moves of the same control within a second are one undo step. */
  const change = (patch: Partial<EditState> | ((e: EditState) => Partial<EditState>), key = ''): void => {
    setEdit((now) => {
      const p = typeof patch === 'function' ? patch(now) : patch
      const next = { ...now, ...p }
      const coalesce = key && lastKey.current?.key === key && Date.now() - lastKey.current.at < 1000
      if (!coalesce) {
        setPast((list) => [...list.slice(-49), now])
        setFuture([])
      }
      lastKey.current = key ? { key, at: Date.now() } : null
      return next
    })
  }
  const undo = (): void => {
    if (!past.length) return
    setFuture((f) => [edit, ...f])
    setEdit(past[past.length - 1]!)
    setPast((p) => p.slice(0, -1))
    lastKey.current = null
  }
  const redo = (): void => {
    if (!future.length) return
    setPast((p) => [...p, edit])
    setEdit(future[0]!)
    setFuture((f) => f.slice(1))
    lastKey.current = null
  }

  // The marks' drawn PNGs, loaded once each for drawing on the canvas.
  useEffect(() => {
    for (const l of edit.layers) {
      const url = l.kind === 'text' ? l.stamp : l.preview
      const have = stamps.current.get(l.id)
      if (url && (!have || have.src !== url)) {
        const img = new Image()
        img.onload = () => setStampsLoaded((n) => n + 1)
        img.src = url
        stamps.current.set(l.id, img)
      }
    }
  }, [edit.layers])

  const open = async (path?: string): Promise<void> => {
    const chosen = path ?? (await window.api.pickAnyImages())[0]
    if (!chosen) return
    setLoading(true)
    const r = await window.api.imageDecode(chosen)
    if (!r.ok) {
      setLoading(false)
      toast('error', t('cannotRead'))
      return
    }
    const bitmap = await createImageBitmap(new Blob([r.value.data as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
    setSrc({ path: chosen, name: chosen.split(/[\\/]/).pop() ?? chosen, bitmap, width: r.value.width, height: r.value.height })
    setSaved(null)
    setSavedShown(false)
    setEdit(FRESH)
    setPast([])
    setFuture([])
    setLoading(false)
  }

  useEffect(() => {
    // A picture handed over by the picture viewer's Edit or "Continue with" (store.handOverTo).
    const given = takeHandOver()[0]
    if (given) void open(given)
    const onAdd = (e: Event): void => void open((e as CustomEvent<string[]>).detail[0])
    window.addEventListener('powerpdf:imgtool-add', onAdd)
    return () => window.removeEventListener('powerpdf:imgtool-add', onAdd)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('input, textarea')) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const save = async (): Promise<void> => {
    if (!src) return
    setSaving(true)
    try {
      const canvas = document.createElement('canvas')
      // Every mark must be loaded before the full-size drawing.
      await Promise.all([...stamps.current.values()].map((img) => (img.complete ? null : new Promise((r) => (img.onload = r)))))
      draw(canvas, src, edit, 1, stamps.current)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) throw new Error('canvas')
      const png = new Uint8Array(await blob.arrayBuffer())
      const r = await window.api.imageSaveEdited(png, src.path, { format: saveAs, quality: 92 }, { folder: null, suffix: t('img.suffix.imgEditor') }, saved?.path ?? null)
      if (!r.ok) toast('error', r.error.message)
      else {
        setSaved(r.value)
        setSavedShown(true)
      }
    } catch (error) {
      toast('error', (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const TABS: Array<{ id: Tab; icon: React.ReactNode }> = [
    { id: 'adjust', icon: <SlidersHorizontal size={18} /> },
    { id: 'filters', icon: <Sparkles size={18} /> },
    { id: 'crop', icon: <Crop size={18} /> },
    { id: 'text', icon: <Type size={18} /> },
    { id: 'stickers', icon: <Smile size={18} /> },
    { id: 'draw', icon: <Brush size={18} /> },
    { id: 'frame', icon: <Frame size={18} /> }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col" data-photo-editor="">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <ToolSwitcher tool="imgEditor" originals={src ? [src.path] : []} results={saved ? [saved.path] : []} />
        {src && (
          <>
            <Button icon={<ImagePlus size={15} />} onClick={() => void open()}>
              {t('editor.openOther')}
            </Button>
            <span className="mx-1 h-6 w-px bg-line" />
            <button type="button" title={t('undo')} aria-label={t('undo')} disabled={!past.length} onClick={undo} className="flex h-8 w-8 items-center justify-center rounded-md text-ink hover:bg-surface-2 disabled:opacity-35">
              <Undo2 size={17} />
            </button>
            <button type="button" title={t('redo')} aria-label={t('redo')} disabled={!future.length} onClick={redo} className="flex h-8 w-8 items-center justify-center rounded-md text-ink hover:bg-surface-2 disabled:opacity-35">
              <Redo2 size={17} />
            </button>
            <button
              type="button"
              title={t('editor.compare')}
              aria-label={t('editor.compare')}
              onPointerDown={() => setComparing(true)}
              onPointerUp={() => setComparing(false)}
              onPointerLeave={() => setComparing(false)}
              className={clsx('flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-surface-2', comparing && 'bg-accent-soft text-accent')}
            >
              <Eye size={16} />
              {t('editor.compare')}
            </button>
            <Button variant="ghost" onClick={() => change(FRESH)} disabled={!past.length}>
              {t('editor.reset')}
            </Button>
          </>
        )}
        <span className="flex-1" />
        {src && (
          <>
            <div className="w-36">
              <Select value={saveAs} label={t('editor.format')} onChange={setSaveAs} options={SAVE_FORMATS.map((f) => ({ value: f.value, label: f.value === 'same' ? t('editor.sameFormat') : f.label }))} />
            </div>
            <Button variant="primary" icon={saving ? <Spinner size={14} /> : <Save size={15} />} disabled={saving} onClick={() => void save()} data-editor-save="">
              {t('editor.save')}
            </Button>
          </>
        )}
        <Button icon={<X size={15} />} onClick={() => openTool(null)} title={backLabel} data-tool-close="">
          {t('close')}
        </Button>
      </header>
      {saved && savedShown && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-ok/8 px-5 py-2" role="status" data-editor-saved="">
          <ResultThumb path={saved.path} size={46} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
              <CircleCheck size={15} className="shrink-0 text-ok" />
              <span className="truncate" dir="auto" title={saved.path}>
                {t(saved.replaced ? 'editor.updatedAs' : 'editor.savedAs', { name: isolate(saved.path.split(/[\\/]/).pop() ?? '') })}
              </span>
            </span>
            <span className="truncate text-[11px] text-muted">
              <span dir="ltr" className="tabular-nums">
                {num(language, saved.width)} × {num(language, saved.height)} · {formatSpec(saved.format).label}
              </span>
              {' · '}
              {formatBytes(language, saved.size)} · {t('editor.saveAgainNote')}
            </span>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Eye size={15} />} onClick={() => void openPicture(saved.path)} data-open-viewer="">
              {t('img.openViewer')}
            </Button>
            <Button icon={<FolderOpen size={15} />} onClick={() => void window.api.showInFolder(saved.path)}>
              {t('showInFolder')}
            </Button>
            <ContinueMenu paths={[saved.path]} exclude="imgEditor" />
            <IconButton label={t('editor.hideSaved')} onClick={() => setSavedShown(false)}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
      )}

      {!src ? (
        <div className="flex flex-1 items-start justify-center bg-sunken p-6">
          <button
            type="button"
            onClick={() => void open()}
            className="mt-10 flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-14 text-center transition-colors hover:border-accent hover:bg-accent-soft/40"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">{loading ? <Spinner size={24} /> : <Upload size={26} />}</span>
            <span className="text-[15px] font-semibold">{t('tool.imgEditor.empty')}</span>
            <span className="max-w-md text-[13px] text-muted">{t('img.emptyHint')}</span>
            <span className="mt-1 rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink">{t('editor.choose')}</span>
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[76px] shrink-0 flex-col gap-1 border-e border-line bg-surface p-2" aria-label={t('tool.imgEditor')}>
            {TABS.map((x) => (
              <button
                key={x.id}
                type="button"
                aria-pressed={tab === x.id}
                onClick={() => setTab(x.id)}
                className={clsx('flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] leading-tight', tab === x.id ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink')}
                data-editor-tab={x.id}
              >
                {x.icon}
                <span className="text-center">{t(`editor.tab.${x.id}`)}</span>
              </button>
            ))}
          </nav>
          <Stage src={src} edit={edit} change={change} tab={tab} stamps={stamps.current} comparing={comparing} layerSel={layerSel} setLayerSel={setLayerSel} brush={brush} ratio={ratio} />
          <aside className="flex w-[300px] shrink-0 flex-col gap-5 overflow-y-auto border-s border-line bg-surface p-5" data-editor-panel={tab}>
            <Panel tab={tab} src={src} edit={edit} change={change} layerSel={layerSel} setLayerSel={setLayerSel} brush={brush} setBrush={setBrush} ratio={ratio} setRatio={setRatio} />
          </aside>
        </div>
      )}
    </div>
  )
}

/** The picture, fitted to the space; marks can be dragged, the crop box shaped, strokes drawn. */
function Stage({
  src,
  edit,
  change,
  tab,
  stamps,
  comparing,
  layerSel,
  setLayerSel,
  brush,
  ratio
}: {
  src: Source
  edit: EditState
  change: (p: Partial<EditState> | ((e: EditState) => Partial<EditState>), key?: string) => void
  tab: Tab
  stamps: Map<string, HTMLImageElement>
  comparing: boolean
  layerSel: string | null
  setLayerSel: (id: string | null) => void
  brush: { colour: string; size: number }
  ratio: string
}) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [space, setSpace] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setSpace({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const cropping = tab === 'crop'
  const size = outputSize(src, edit, cropping)
  const scale = Math.min(1, (space.w - 48) / size.w, (space.h - 48) / size.h)
  const shownW = size.w * scale
  const shownH = size.h * scale

  useEffect(() => {
    if (!canvas.current || space.w === 0) return
    const dpr = window.devicePixelRatio || 1
    draw(canvas.current, src, edit, scale * dpr, stamps, { ignoreCrop: cropping, original: comparing })
  })

  // Drawing strokes.
  const drawing = useRef<Stroke | null>(null)
  const point = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }

  const crop = edit.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const { W, H } = turned(src, edit)
  const lockRatio = ratio === 'free' ? null : ratio === 'original' ? W / H : Number(ratio.split(':')[0]) / Number(ratio.split(':')[1])

  const dragCrop = (e: React.PointerEvent, handle: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const start = { ...crop }
    const x0 = e.clientX
    const y0 = e.clientY
    const lock = lockRatio ? (lockRatio * H) / W : null
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - x0) / shownW
      const dy = (ev.clientY - y0) / shownH
      let { x, y, w, h } = start
      if (handle === 'move') {
        x = Math.min(Math.max(0, x + dx), 1 - w)
        y = Math.min(Math.max(0, y + dy), 1 - h)
      } else {
        let l = x
        let tp = y
        let r = x + w
        let b = y + h
        if (handle.includes('w')) l = Math.min(Math.max(0, l + dx), r - 0.03)
        if (handle.includes('e')) r = Math.max(Math.min(1, r + dx), l + 0.03)
        if (handle.includes('n')) tp = Math.min(Math.max(0, tp + dy), b - 0.03)
        if (handle.includes('s')) b = Math.max(Math.min(1, b + dy), tp + 0.03)
        w = r - l
        h = b - tp
        if (lock) {
          h = w / lock
          if (h > 1) {
            h = 1
            w = lock
          }
          if (handle.includes('n')) tp = b - h
          tp = Math.min(Math.max(0, tp), 1 - h)
          l = Math.min(Math.max(0, l), 1 - w)
        }
        x = l
        y = tp
      }
      change({ crop: { x, y, w, h } }, 'crop')
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragLayer = (e: React.PointerEvent, layer: MarkLayer, how: 'move' | 'size' | 'turn'): void => {
    e.preventDefault()
    e.stopPropagation()
    setLayerSel(layer.id)
    const start = { ...layer }
    const r = canvas.current!.getBoundingClientRect()
    const cx = r.left + start.x * r.width
    const cy = r.top + start.y * r.height
    const x0 = e.clientX
    const y0 = e.clientY
    const move = (ev: PointerEvent): void => {
      let p: Partial<MarkLayer>
      if (how === 'move') p = { x: start.x + (ev.clientX - x0) / r.width, y: start.y + (ev.clientY - y0) / r.height }
      else if (how === 'size') p = { width: Math.min(3, Math.max(0.02, (start.width * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / Math.max(1, Math.hypot(x0 - cx, y0 - cy)))) }
      else p = { rotate: Math.round((((Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90 + 540) % 360) - 180) }
      change((now) => ({ layers: now.layers.map((l) => (l.id === layer.id ? { ...l, ...p } : l)) }), `layer-${layer.id}-${how}`)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-sunken" dir="ltr" onPointerDown={() => setLayerSel(null)} data-editor-stage="">
      <div className="relative bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:16px_16px] shadow-md" style={{ width: shownW, height: shownH }}>
        <canvas
          ref={canvas}
          style={{ width: shownW, height: shownH, cursor: tab === 'draw' ? 'crosshair' : undefined }}
          className="block"
          onPointerDown={(e) => {
            if (tab !== 'draw') return
            e.stopPropagation()
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            drawing.current = { points: [point(e)], colour: brush.colour, size: brush.size / 100 }
            change((now) => ({ strokes: [...now.strokes, drawing.current!] }))
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return
            drawing.current = { ...drawing.current, points: [...drawing.current.points, point(e)] }
            const stroke = drawing.current
            change((now) => ({ strokes: [...now.strokes.slice(0, -1), stroke] }), 'stroke')
          }}
          onPointerUp={() => {
            drawing.current = null
          }}
        />
        {cropping && (
          <div
            className="absolute cursor-move border-2 border-white outline outline-1 outline-black/40"
            style={{ left: crop.x * shownW, top: crop.y * shownH, width: crop.w * shownW, height: crop.h * shownH, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.5)' }}
            onPointerDown={(e) => dragCrop(e, 'move')}
            data-editor-crop=""
          >
            <span className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="border border-white/25" />
              ))}
            </span>
            {handles.map((h) => (
              <span
                key={h}
                onPointerDown={(e) => dragCrop(e, h)}
                className="absolute h-3 w-3 rounded-sm border border-black/40 bg-white shadow"
                style={{ left: h.includes('w') ? -6 : h.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)', top: h.includes('n') ? -6 : h.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)', cursor: `${h}-resize` }}
              />
            ))}
            <span className="pointer-events-none absolute start-1/2 top-full mt-1.5 -translate-x-1/2 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-surface tabular-nums">
              {Math.round(crop.w * W)} × {Math.round(crop.h * H)}
            </span>
          </div>
        )}
        {!cropping &&
          !comparing &&
          (tab === 'text' || tab === 'stickers') &&
          edit.layers.map((l) => {
            const w = l.width * shownW
            const h = w * l.aspect
            return (
              <div key={l.id} className="absolute" style={{ left: l.x * shownW - w / 2, top: l.y * shownH - h / 2, width: w, height: h, transform: `rotate(${l.rotate}deg)` }}>
                <span className="absolute inset-0 cursor-move" onPointerDown={(e) => dragLayer(e, l, 'move')} />
                {layerSel === l.id && (
                  <>
                    <span className="pointer-events-none absolute -inset-1 rounded-sm border-2 border-dashed border-accent" />
                    <span onPointerDown={(e) => dragLayer(e, l, 'size')} title={t('mark.resize')} className="absolute -end-2 -bottom-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-accent bg-white shadow" />
                    <span onPointerDown={(e) => dragLayer(e, l, 'turn')} title={t('mark.turn')} className="absolute start-1/2 -top-7 flex h-5 w-5 -translate-x-1/2 cursor-grab items-center justify-center rounded-full border-2 border-accent bg-white text-accent shadow">
                      <RotateCw size={11} strokeWidth={3} />
                    </span>
                  </>
                )}
              </div>
            )
          })}
      </div>
      {comparing && <span className="absolute start-3 top-3 rounded-full bg-ink/80 px-2.5 py-1 text-[11px] text-surface">{t('editor.original')}</span>}
    </div>
  )
}

const RATIOS = ['free', 'original', '1:1', '4:3', '3:2', '16:9', '4:5', '9:16']

function Panel({
  tab,
  src,
  edit,
  change,
  layerSel,
  setLayerSel,
  brush,
  setBrush,
  ratio,
  setRatio
}: {
  tab: Tab
  src: Source
  edit: EditState
  change: (p: Partial<EditState> | ((e: EditState) => Partial<EditState>), key?: string) => void
  layerSel: string | null
  setLayerSel: (id: string | null) => void
  brush: { colour: string; size: number }
  setBrush: (b: { colour: string; size: number }) => void
  ratio: string
  setRatio: (r: string) => void
}) {
  const t = useT()
  const thumb = useMemo(() => {
    const c = document.createElement('canvas')
    const s = 96 / Math.max(src.width, src.height)
    c.width = Math.max(1, Math.round(src.width * s))
    c.height = Math.max(1, Math.round(src.height * s))
    c.getContext('2d')!.drawImage(src.bitmap, 0, 0, c.width, c.height)
    return c
  }, [src])

  switch (tab) {
    case 'adjust': {
      const sliders: Array<[keyof Adjust, number, number]> = [
        ['brightness', -100, 100],
        ['contrast', -100, 100],
        ['saturation', -100, 100],
        ['warmth', -100, 100],
        ['hue', -180, 180],
        ['fade', 0, 100],
        ['vignette', 0, 100],
        ['blur', 0, 100]
      ]
      return (
        <Section title={t('editor.tab.adjust')} action={<button type="button" className="text-[12px] text-accent hover:underline" onClick={() => change({ adjust: NO_ADJUST })}>{t('editor.resetThese')}</button>}>
          {sliders.map(([key, min, max]) => (
            <div key={key} className="flex flex-col gap-1">
              <span className="flex justify-between text-[12px] text-muted">
                <span>{t(`editor.adjust.${key}`)}</span>
                <span className="tabular-nums" dir="ltr">
                  {edit.adjust[key] > 0 && min < 0 ? '+' : ''}
                  {edit.adjust[key]}
                </span>
              </span>
              <input
                type="range"
                min={min}
                max={max}
                value={edit.adjust[key]}
                onChange={(e) => change((now) => ({ adjust: { ...now.adjust, [key]: Number(e.target.value) } }), `adjust-${key}`)}
                onDoubleClick={() => change((now) => ({ adjust: { ...now.adjust, [key]: 0 } }))}
                className="h-1.5 w-full cursor-pointer accent-[var(--accent)]"
                dir="ltr"
                aria-label={t(`editor.adjust.${key}`)}
              />
            </div>
          ))}
        </Section>
      )
    }
    case 'filters':
      return (
        <Section title={t('editor.tab.filters')}>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(FILTERS) as FilterId[]).map((f) => (
              <button key={f} type="button" aria-pressed={edit.filter === f} onClick={() => change({ filter: f })} className={clsx('flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[11px]', edit.filter === f ? 'border-accent bg-accent-soft/60 font-semibold' : 'border-line hover:border-faint')}>
                <FilterThumb source={thumb} filter={FILTERS[f]} />
                {t(`editor.filter.${f}`)}
              </button>
            ))}
          </div>
        </Section>
      )
    case 'crop':
      return (
        <>
          <Section title={t('editor.turn')}>
            <div className="grid grid-cols-2 gap-2">
              <Button icon={<RotateCcw size={15} />} onClick={() => change((n) => ({ turn: (((n.turn + 270) % 360) as EditState['turn']), crop: null }))}>
                {t('img.left')}
              </Button>
              <Button icon={<RotateCw size={15} />} onClick={() => change((n) => ({ turn: (((n.turn + 90) % 360) as EditState['turn']), crop: null }))}>
                {t('img.right')}
              </Button>
              <Button icon={<FlipHorizontal2 size={15} />} onClick={() => change((n) => ({ flipH: !n.flipH }))}>
                {t('img.flipH')}
              </Button>
              <Button icon={<FlipVertical2 size={15} />} onClick={() => change((n) => ({ flipV: !n.flipV }))}>
                {t('img.flipV')}
              </Button>
            </div>
          </Section>
          <Section title={t('editor.straighten')}>
            <div className="flex items-center gap-3">
              <input type="range" min={-45} max={45} step={0.5} value={edit.straighten} onChange={(e) => change({ straighten: Number(e.target.value) }, 'straighten')} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" dir="ltr" aria-label={t('editor.straighten')} />
              <div className="w-[72px]">
                <NumberInput value={edit.straighten} onChange={(straighten) => change({ straighten }, 'straighten')} min={-45} max={45} step={0.5} suffix="°" />
              </div>
            </div>
          </Section>
          <Section title={t('img.shape')}>
            <div className="grid grid-cols-4 gap-1.5" dir="ltr">
              {RATIOS.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={ratio === r}
                  onClick={() => {
                    setRatio(r)
                    if (r === 'free') return
                    const { W, H } = turned(src, edit)
                    const want = r === 'original' ? W / H : Number(r.split(':')[0]) / Number(r.split(':')[1])
                    // The largest box of that shape, in the middle.
                    let w = 1
                    let h = (W / want) / H
                    if (h > 1) {
                      h = 1
                      w = (H * want) / W
                    }
                    change({ crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } })
                  }}
                  className={clsx('h-8 rounded-lg border text-[12px] font-medium', ratio === r ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-faint')}
                >
                  {r === 'free' ? t('img.free') : r === 'original' ? t('editor.originalShape') : r}
                </button>
              ))}
            </div>
            <Button variant="ghost" onClick={() => change({ crop: null })} disabled={!edit.crop}>
              {t('editor.noCrop')}
            </Button>
          </Section>
        </>
      )
    case 'text':
      return <MarksPanel layers={edit.layers} setLayers={(layers) => change({ layers })} selected={layerSel} setSelected={setLayerSel} plain />
    case 'stickers':
      return (
        <>
          <Section title={t('editor.tab.stickers')}>
            <div className="grid grid-cols-6 gap-1">
              {STICKERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  title={s}
                  onClick={async () => {
                    const l = await newTextLayer(s, { font: 'Segoe UI Emoji', bold: false, colour: '#000000', shadow: false, opacity: 1, width: 0.16, x: 0.3 + Math.random() * 0.4, y: 0.3 + Math.random() * 0.4 })
                    change((now) => ({ layers: [...now.layers, l] }))
                    setLayerSel(l.id)
                  }}
                  className="flex h-10 items-center justify-center rounded-lg text-[22px] hover:bg-surface-2"
                  style={{ fontFamily: '"Segoe UI Emoji", sans-serif' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </Section>
          {layerSel && <MarksPanel layers={edit.layers} setLayers={(layers) => change({ layers })} selected={layerSel} setSelected={setLayerSel} plain />}
        </>
      )
    case 'draw':
      return (
        <Section title={t('editor.tab.draw')}>
          <p className="text-[12px] text-muted">{t('editor.drawHint')}</p>
          <ColourPicker value={brush.colour} onChange={(colour) => setBrush({ ...brush, colour })} label={t('mark.colour')} />
          <span className="text-[12px] text-muted">{t('editor.brushSize')}</span>
          <div className="flex gap-1.5">
            {[0.4, 0.8, 1.2, 2, 3.5].map((s) => (
              <button key={s} type="button" aria-pressed={brush.size === s} onClick={() => setBrush({ ...brush, size: s })} className={clsx('flex h-9 w-9 items-center justify-center rounded-lg border', brush.size === s ? 'border-accent bg-accent-soft' : 'border-line hover:border-faint')}>
                <span className="rounded-full" style={{ width: 4 + s * 5, height: 4 + s * 5, background: brush.colour }} />
              </button>
            ))}
          </div>
          <Button variant="danger" onClick={() => change({ strokes: [] })} disabled={!edit.strokes.length}>
            {t('editor.clearDrawing')}
          </Button>
        </Section>
      )
    case 'frame':
      return (
        <>
          <Section title={t('editor.frame')}>
            <div className="flex items-center gap-3">
              <input type="range" min={0} max={20} step={0.5} value={edit.frame.size} onChange={(e) => change((n) => ({ frame: { ...n.frame, size: Number(e.target.value) } }), 'frame')} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" dir="ltr" aria-label={t('editor.frame')} />
              <span className="w-10 text-end text-[12px] text-muted tabular-nums">{edit.frame.size}%</span>
            </div>
            <ColourPicker value={edit.frame.colour} onChange={(colour) => change((n) => ({ frame: { ...n.frame, colour } }))} label={t('editor.frameColour')} />
          </Section>
          <Section title={t('editor.corners')}>
            <div className="flex items-center gap-3">
              <input type="range" min={0} max={50} value={edit.radius} onChange={(e) => change({ radius: Number(e.target.value) }, 'radius')} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" dir="ltr" aria-label={t('editor.corners')} />
              <span className="w-10 text-end text-[12px] text-muted tabular-nums">{edit.radius}%</span>
            </div>
            <p className="text-[11px] text-muted">{t('editor.cornersHint')}</p>
          </Section>
          <Section title={t('img.background')}>
            <div className="flex items-center gap-2">
              <Button onClick={() => change({ background: null })} className={clsx(!edit.background && 'border-accent! text-accent!')}>
                {t('img.bg.transparent')}
              </Button>
              <div className="w-28">
                <ColourPicker value={edit.background ?? '#ffffff'} onChange={(background) => change({ background })} label={t('img.background')} />
              </div>
            </div>
          </Section>
        </>
      )
  }
}

function FilterThumb({ source, filter }: { source: HTMLCanvasElement; filter: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = source.width
    c.height = source.height
    const ctx = c.getContext('2d')!
    ctx.filter = filter || 'none'
    ctx.drawImage(source, 0, 0)
  }, [source, filter])
  return <canvas ref={ref} className="h-14 w-full rounded object-cover" />
}

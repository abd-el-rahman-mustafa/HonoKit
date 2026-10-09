import clsx from 'clsx'
import { ArrowUpToLine, Bold, ImagePlus, Italic, RotateCw, Trash2, Type } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Layer, Marks } from '@shared/imageOps'
import { useT } from '../store'
import { Button, Check, ColourPicker, NumberInput, Section, Segmented, Select } from '../components/ui'
import type { Card } from '../components/ImageToolView'

/**
 * Marks laid on pictures — Watermark image and Meme generator (decisions §69). Text is drawn
 * here, in the window, into a PNG "stamp": Chromium shapes Arabic and joins its letters, and the
 * worker places that same PNG, so the preview is exactly what is written. Positions and sizes
 * are fractions of the picture, so one layout suits a whole batch of different sizes.
 */

export interface MarkLayer {
  id: string
  kind: 'text' | 'image'
  text: string
  font: string
  bold: boolean
  italic: boolean
  colour: string
  outline: string | null
  shadow: boolean
  background: string | null
  align: 'start' | 'center' | 'end'
  /** Picture marks: the file, and a preview to show while placing. */
  path?: string
  preview?: string
  /** The drawn mark (data: URL), its height per width, and its width in pixels. */
  stamp: string
  aspect: number
  pixels: number
  x: number
  y: number
  width: number
  rotate: number
  opacity: number
  tile: boolean
  gap: number
}

let ids = 0
const SIZE = 160
/** Hebrew, Arabic, Syriac, Thaana … and the Arabic presentation forms (built from code points: escapes get mangled by tools). */
const range = (a: number, b: number): string => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`
const RTL = new RegExp(`[${range(0x590, 0x8ff)}${range(0xfb1d, 0xfdff)}${range(0xfe70, 0xfefe)}]`)

/** Fonts offered for marks: the bundled Arabic face first, then ones every Windows PC has. */
export const MARK_FONTS = ['Plex Arabic', 'Segoe UI', 'Arial', 'Arial Black', 'Impact', 'Tahoma', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New', 'Comic Sans MS', 'Trebuchet MS']

/** Faces on Windows that have Arabic letters of their own. */
const ARABIC_CAPABLE = new Set(['Plex Arabic', 'Segoe UI', 'Arial', 'Tahoma', 'Times New Roman', 'Courier New'])

/** Draws a text mark into a PNG, large enough to stay sharp on a big photo. */
export async function drawText(layer: Pick<MarkLayer, 'text' | 'font' | 'bold' | 'italic' | 'colour' | 'outline' | 'shadow' | 'background' | 'align'>): Promise<{ stamp: string; aspect: number; pixels: number }> {
  // Arabic in a face without Arabic letters (Impact, Georgia …) is drawn in the bundled Arabic face,
  // not in whatever the system falls back to.
  const families = RTL.test(layer.text) && !ARABIC_CAPABLE.has(layer.font) ? `"Plex Arabic", "${layer.font}"` : `"${layer.font}", "Plex Arabic"`
  const font = `${layer.italic ? 'italic ' : ''}${layer.bold ? '700 ' : '400 '}${SIZE}px ${families}, sans-serif`
  try {
    await document.fonts.load(font, layer.text || 'A')
    // Arabic in a Latin-only face (Impact, Georgia …) falls back to the bundled Arabic face: load it too.
    if (RTL.test(layer.text)) await document.fonts.load(`${SIZE}px "Plex Arabic"`, layer.text)
  } catch {
    /* a system font: nothing to load */
  }
  const lines = (layer.text || ' ').split('\n')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  const rtl = RTL.test(layer.text)
  const widths = lines.map((l) => ctx.measureText(l).width)
  const pad = Math.round(SIZE * (layer.background ? 0.3 : layer.outline ? 0.16 : 0.1))
  const lineHeight = SIZE * 1.3
  const w = Math.max(...widths, SIZE * 0.5) + pad * 2
  const h = lines.length * lineHeight + pad * 2 - SIZE * 0.15
  canvas.width = Math.ceil(w)
  canvas.height = Math.ceil(h)
  ctx.font = font
  ctx.direction = rtl ? 'rtl' : 'ltr'
  ctx.textBaseline = 'middle'
  if (layer.background) {
    ctx.fillStyle = layer.background
    const r = SIZE * 0.2
    ctx.beginPath()
    ctx.roundRect(0, 0, canvas.width, canvas.height, r)
    ctx.fill()
  }
  // Start/end follow the text's own direction, as in a word processor.
  const align = layer.align === 'center' ? 'center' : (layer.align === 'start') !== rtl ? 'left' : 'right'
  ctx.textAlign = align
  const x = align === 'center' ? canvas.width / 2 : align === 'left' ? pad : canvas.width - pad
  lines.forEach((line, i) => {
    const y = pad + lineHeight * i + lineHeight / 2 - SIZE * 0.075
    if (layer.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = SIZE * 0.08
      ctx.shadowOffsetX = SIZE * 0.03
      ctx.shadowOffsetY = SIZE * 0.04
    }
    if (layer.outline) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = SIZE * 0.12
      ctx.strokeStyle = layer.outline
      ctx.strokeText(line, x, y)
      ctx.shadowColor = 'transparent'
    }
    ctx.fillStyle = layer.colour
    ctx.fillText(line, x, y)
    ctx.shadowColor = 'transparent'
  })
  return { stamp: canvas.toDataURL('image/png'), aspect: canvas.height / canvas.width, pixels: canvas.width }
}

export async function newTextLayer(text: string, patch: Partial<MarkLayer> = {}): Promise<MarkLayer> {
  const base: MarkLayer = {
    id: `m${ids++}`,
    kind: 'text',
    text,
    font: RTL.test(text) ? 'Plex Arabic' : 'Segoe UI',
    bold: true,
    italic: false,
    colour: '#ffffff',
    outline: null,
    shadow: true,
    background: null,
    align: 'center',
    stamp: '',
    aspect: 0.3,
    pixels: 1,
    x: 0.5,
    y: 0.5,
    width: 0.4,
    rotate: 0,
    opacity: 0.8,
    tile: false,
    gap: 1,
    ...patch
  }
  return { ...base, ...(await drawText(base)) }
}

/** The width that makes a text mark's height `height` (a fraction of the picture's height). */
export function widthForHeight(layer: Pick<MarkLayer, 'aspect'>, pictureRatio: number, height: number): number {
  return Math.min(0.92, (height * pictureRatio) / Math.max(0.01, layer.aspect))
}

/** The job's marks for these layers (and meme bands). */
export function marksFor(layers: MarkLayer[], bands?: Marks['bands']): Marks {
  const out: Layer[] = layers.map((l) => ({
    source: l.kind === 'text' ? { png: l.stamp } : { path: l.path! },
    x: l.x,
    y: l.y,
    width: l.width,
    rotate: l.rotate,
    opacity: l.opacity,
    tile: l.tile ? { gap: l.gap } : undefined
  }))
  return { layers: out, bands }
}

/**
 * The selected picture with its marks, as they will be: drag a mark to move it, its corner to
 * resize it, the round handle above it to turn it. Meme bands show as white strips.
 */
export function MarksStage({
  card,
  layers,
  selected,
  onSelect,
  onChange,
  bands
}: {
  card: Card
  layers: MarkLayer[]
  selected: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<MarkLayer>) => void
  bands?: Marks['bands']
}) {
  const t = useT()
  const info = card.info!
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const top = bands ? bands.top * info.height : 0
  const bottom = bands ? bands.bottom * info.height : 0
  const fullH = info.height + top + bottom
  const scale = Math.min((size.w - 48) / info.width, (size.h - 48) / fullH)
  const W = Math.max(1, info.width * scale)
  const H = Math.max(1, fullH * scale)

  const drag = (e: React.PointerEvent, layer: MarkLayer, how: 'move' | 'size' | 'turn'): void => {
    e.preventDefault()
    e.stopPropagation()
    onSelect(layer.id)
    const start = { ...layer }
    const x0 = e.clientX
    const y0 = e.clientY
    const rect = (e.currentTarget as HTMLElement).closest('[data-marks-canvas]')!.getBoundingClientRect()
    const cx = rect.left + start.x * W
    const cy = rect.top + start.y * H
    const move = (ev: PointerEvent): void => {
      if (how === 'move') onChange(layer.id, { x: start.x + (ev.clientX - x0) / W, y: start.y + (ev.clientY - y0) / H })
      else if (how === 'size') {
        // Distance from the centre sets the size: the corner follows the pointer.
        const d0 = Math.hypot(x0 - cx, y0 - cy)
        const d1 = Math.hypot(ev.clientX - cx, ev.clientY - cy)
        onChange(layer.id, { width: Math.min(4, Math.max(0.01, (start.width * d1) / Math.max(1, d0))) })
      } else {
        const angle = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90
        const snapped = ev.shiftKey ? Math.round(angle / 15) * 15 : Math.abs(angle % 90) < 3 ? Math.round(angle / 90) * 90 : angle
        onChange(layer.id, { rotate: Math.round(((snapped + 540) % 360) - 180) })
      }
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={stage} className="relative flex min-h-[280px] flex-1 items-center justify-center overflow-hidden" data-marks-stage="" dir="ltr" onPointerDown={() => onSelect(null)}>
      {size.w > 0 && (
        <div className="relative overflow-hidden bg-white shadow-md" style={{ width: W, height: H }} data-marks-canvas="">
          <img src={info.preview} alt="" draggable={false} className="absolute start-0 w-full select-none" style={{ top: top * scale, height: info.height * scale }} />
          {layers.map((l) => {
            const w = l.width * W
            const h = w * l.aspect
            const shown = l.kind === 'text' ? l.stamp : l.preview
            if (l.tile) {
              const gw = (w * (1 + l.gap)) | 0
              const gh = (h * (1 + l.gap)) | 0
              return (
                <div
                  key={l.id}
                  className={clsx('absolute inset-0 cursor-pointer', selected === l.id && 'outline-2 -outline-offset-2 outline-accent outline-dashed')}
                  style={{ opacity: l.opacity }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    onSelect(l.id)
                  }}
                >
                  {Array.from({ length: Math.ceil(H / Math.max(4, gh)) + 1 }, (_, r) =>
                    Array.from({ length: Math.ceil(W / Math.max(4, gw)) + 1 }, (_, c) => (
                      <img key={`${r}-${c}`} src={shown} alt="" draggable={false} className="absolute max-w-none select-none" style={{ width: w, height: h, left: c * gw + (gw - w) / 2, top: r * gh + (gh - h) / 2, transform: `rotate(${l.rotate}deg)` }} />
                    ))
                  )}
                </div>
              )
            }
            return (
              <div
                key={l.id}
                className="absolute"
                style={{ left: l.x * W - w / 2, top: l.y * H - h / 2, width: w, height: h, transform: `rotate(${l.rotate}deg)` }}
                data-mark-layer=""
              >
                <img src={shown} alt="" draggable={false} className="h-full w-full cursor-move select-none" style={{ opacity: l.opacity }} onPointerDown={(e) => drag(e, l, 'move')} />
                {selected === l.id && (
                  <>
                    <span className="pointer-events-none absolute -inset-1 rounded-sm border-2 border-dashed border-accent" />
                    <span onPointerDown={(e) => drag(e, l, 'size')} title={t('mark.resize')} className="absolute -end-2 -bottom-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-accent bg-white shadow" />
                    <span onPointerDown={(e) => drag(e, l, 'turn')} title={t('mark.turn')} className="absolute start-1/2 -top-7 flex h-5 w-5 -translate-x-1/2 cursor-grab items-center justify-center rounded-full border-2 border-accent bg-white text-accent shadow">
                      <RotateCw size={11} strokeWidth={3} />
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <span className="absolute start-3 top-3 rounded-full bg-surface/90 px-2.5 py-1 text-[11px] text-muted shadow-sm" dir="auto">
        {t('mark.stageHint')}
      </span>
    </div>
  )
}

const GRID: Array<[number, number]> = [
  [0.12, 0.1],
  [0.5, 0.1],
  [0.88, 0.1],
  [0.12, 0.5],
  [0.5, 0.5],
  [0.88, 0.5],
  [0.12, 0.9],
  [0.5, 0.9],
  [0.88, 0.9]
]

/** The marks panel: add text or a picture; the selected mark's look and placement. */
export function MarksPanel({
  layers,
  setLayers,
  selected,
  setSelected,
  meme,
  plain
}: {
  layers: MarkLayer[]
  setLayers: (next: MarkLayer[]) => void
  selected: string | null
  setSelected: (id: string | null) => void
  meme?: boolean
  /** The Photo editor: no repeating pattern, no introduction. */
  plain?: boolean
}) {
  const t = useT()
  const layer = layers.find((l) => l.id === selected) ?? null
  const patch = async (p: Partial<MarkLayer>): Promise<void> => {
    if (!layer) return
    let next = { ...layer, ...p }
    const look = ['text', 'font', 'bold', 'italic', 'colour', 'outline', 'shadow', 'background', 'align'] as const
    if (next.kind === 'text' && look.some((k) => k in p)) {
      const drawn = await drawText(next)
      // Keep the letters the same size when the text gets longer or shorter.
      next = { ...next, ...drawn, width: Math.min(4, (next.width * drawn.pixels) / Math.max(1, layer.pixels)) }
    }
    setLayers(layers.map((l) => (l.id === layer.id ? next : l)))
  }
  const addText = async (): Promise<void> => {
    const l = await newTextLayer(t('mark.sampleText'))
    setLayers([...layers, l])
    setSelected(l.id)
  }
  const addPicture = async (): Promise<void> => {
    const [path] = await window.api.pickAnyImages()
    if (!path) return
    const r = await window.api.imageDescribe(path)
    if (!r.ok) return
    const l: MarkLayer = { ...(await newTextLayer('')), kind: 'image', path, preview: r.value.preview, stamp: '', aspect: r.value.height / r.value.width, width: 0.25, opacity: 0.85, shadow: false, x: 0.85, y: 0.85 }
    setLayers([...layers, l])
    setSelected(l.id)
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button icon={<Type size={15} />} onClick={() => void addText()}>
          {t('mark.addText')}
        </Button>
        <Button icon={<ImagePlus size={15} />} onClick={() => void addPicture()}>
          {t('mark.addPicture')}
        </Button>
      </div>
      {layers.length > 0 && (
        <div className="flex flex-col gap-1" role="listbox" aria-label={t('mark.layers')}>
          {[...layers].reverse().map((l) => (
            <button
              key={l.id}
              type="button"
              role="option"
              aria-selected={l.id === selected}
              onClick={() => setSelected(l.id)}
              className={clsx('flex h-9 items-center gap-2 rounded-lg border px-2 text-start text-[12px]', l.id === selected ? 'border-accent bg-accent-soft/60' : 'border-line hover:border-faint')}
            >
              {l.kind === 'text' ? <Type size={14} className="shrink-0 text-muted" /> : <img src={l.preview} alt="" className="h-6 w-6 shrink-0 rounded object-contain" />}
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {l.kind === 'text' ? l.text.split('\n')[0] || '…' : (l.path?.split(/[\\/]/).pop() ?? '')}
              </span>
            </button>
          ))}
        </div>
      )}
      {!layer && layers.length === 0 && !plain && <p className="text-[12px] leading-relaxed text-muted">{meme ? t('meme.intro') : t('mark.intro')}</p>}
      {layer && (
        <>
          {layer.kind === 'text' && (
            <Section title={t('mark.text')}>
              <textarea
                dir="auto"
                rows={2}
                value={layer.text}
                onChange={(e) => void patch({ text: e.target.value })}
                className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none transition-[border-color,box-shadow] hover:border-faint focus:border-accent focus:ring-3 focus:ring-accent/20"
                data-mark-text=""
              />
              <Select value={layer.font} label={t('mark.font')} onChange={(font) => void patch({ font })} options={MARK_FONTS.map((f) => ({ value: f, label: f === 'Plex Arabic' ? `IBM Plex Sans Arabic` : f }))} />
              <div className="flex items-center gap-1.5">
                <ToggleIcon on={layer.bold} label={t('mark.bold')} onClick={() => void patch({ bold: !layer.bold })}>
                  <Bold size={15} />
                </ToggleIcon>
                <ToggleIcon on={layer.italic} label={t('mark.italic')} onClick={() => void patch({ italic: !layer.italic })}>
                  <Italic size={15} />
                </ToggleIcon>
                <div className="w-24">
                  <ColourPicker value={layer.colour} onChange={(colour) => void patch({ colour })} label={t('mark.colour')} />
                </div>
              </div>
              <Check checked={!!layer.outline} onChange={(v) => void patch({ outline: v ? (layer.colour.toLowerCase() === '#000000' ? '#ffffff' : '#000000') : null })} label={t('mark.outline')} />
              {layer.outline && <ColourPicker value={layer.outline} onChange={(outline) => void patch({ outline })} label={t('mark.outlineColour')} />}
              <Check checked={layer.shadow} onChange={(shadow) => void patch({ shadow })} label={t('mark.shadow')} />
              <Check checked={!!layer.background} onChange={(v) => void patch({ background: v ? '#000000' : null })} label={t('mark.background')} />
              {layer.background && <ColourPicker value={layer.background} onChange={(background) => void patch({ background })} label={t('mark.backgroundColour')} />}
              {layer.text.includes('\n') && (
                <Segmented
                  value={layer.align}
                  onChange={(align) => void patch({ align })}
                  options={[
                    { value: 'start', label: t('alignStart') },
                    { value: 'center', label: t('alignCentre') },
                    { value: 'end', label: t('alignEnd') }
                  ]}
                />
              )}
            </Section>
          )}
          <Section title={t('mark.placement')}>
            {!layer.tile && (
              <div className="grid w-28 grid-cols-3 gap-1" dir="ltr" aria-label={t('mark.position')}>
                {GRID.map(([x, y], i) => (
                  <button
                    key={i}
                    type="button"
                    title={t('mark.position')}
                    onClick={() => void patch({ x, y })}
                    className={clsx('h-7 rounded-md border', Math.abs(layer.x - x) < 0.02 && Math.abs(layer.y - y) < 0.02 ? 'border-accent bg-accent' : 'border-line bg-surface-2 hover:border-faint')}
                  />
                ))}
              </div>
            )}
            <Labelled label={t('mark.size')}>
              <Slider value={Math.round(layer.width * 100)} onChange={(v) => void patch({ width: v / 100 })} min={1} max={150} suffix="%" />
            </Labelled>
            <Labelled label={t('mark.opacity')}>
              <Slider value={Math.round(layer.opacity * 100)} onChange={(v) => void patch({ opacity: v / 100 })} min={5} max={100} suffix="%" />
            </Labelled>
            <Labelled label={t('mark.rotation')}>
              <Slider value={layer.rotate} onChange={(rotate) => void patch({ rotate })} min={-180} max={180} suffix="°" />
            </Labelled>
            {!meme && !plain && <Check checked={layer.tile} onChange={(tile) => void patch({ tile })} label={t('mark.tile')} hint={t('mark.tileHint')} />}
            {layer.tile && (
              <Labelled label={t('mark.gap')}>
                <Slider value={Math.round(layer.gap * 100)} onChange={(v) => void patch({ gap: v / 100 })} min={0} max={300} suffix="%" />
              </Labelled>
            )}
          </Section>
          <div className="flex gap-2">
            <Button icon={<ArrowUpToLine size={15} />} onClick={() => setLayers([...layers.filter((l) => l.id !== layer.id), layer])} disabled={layers[layers.length - 1]?.id === layer.id}>
              {t('mark.toFront')}
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 size={15} />}
              onClick={() => {
                setLayers(layers.filter((l) => l.id !== layer.id))
                setSelected(null)
              }}
            >
              {t('remove')}
            </Button>
          </div>
        </>
      )}
    </>
  )
}

function ToggleIcon({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={on} onClick={onClick} className={clsx('flex h-8 w-8 items-center justify-center rounded-lg border', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-faint hover:text-ink')}>
      {children}
    </button>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </div>
  )
}

function Slider({ value, onChange, min, max, suffix }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix: string }) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" dir="ltr" />
      <div className="w-[80px] shrink-0">
        <NumberInput value={value} onChange={onChange} min={min} max={max} suffix={suffix} />
      </div>
    </div>
  )
}

import clsx from 'clsx'
import { FlipHorizontal2, FlipVertical2, MapPin, RotateCcw, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { format as formatSpec, GROUP_ORDER, WRITABLE, type FormatId } from '@shared/imageFormats'
import { resizedSize, type Animate, type ImageJob, type ImageMetadata, type Output } from '@shared/imageOps'
import { formatBytes } from '../i18n'
import { useStore, useT, type ImageToolId, type t as translateFn } from '../store'
import { Button, Check, ColourPicker, NumberInput, Section, Segmented, Select, Spinner, Switch } from '../components/ui'
import type { Card } from '../components/ImageToolView'
import { drawText, marksFor, MarksPanel, type MarkLayer } from './MarkLayers'

/**
 * The options of each image tool (decisions §69), and how they become a job for one picture.
 * Defaults follow iLoveIMG where it has the tool (Resize by pixels keeping the shape, Compress
 * "recommended", Make GIF at half a second per picture, looping) and the offline tools'
 * extras where it does not (any format, quality, target size, metadata).
 */

type T = typeof translateFn

export interface ImgOptions {
  // convert / to JPG
  format: FormatId
  ext: string
  quality: number
  lossless: boolean
  background: string
  keepMetadata: boolean
  keepAnimation: boolean
  palette: boolean
  // compress
  level: 'recommended' | 'strong' | 'light' | 'quality' | 'target'
  targetKb: number
  compressTo: 'same' | 'webp' | 'avif' | 'jpg'
  // resize
  resizeBy: 'pixels' | 'percent' | 'longest'
  width: number | null
  height: number | null
  keepShape: boolean
  noEnlarge: boolean
  percent: number
  longest: number
  // crop
  cropBy: 'ratio' | 'box'
  ratio: string
  position: 'centre' | 'top' | 'bottom' | 'left' | 'right' | 'smart'
  box: { x: number; y: number; width: number; height: number }
  // rotate (all pictures, on top of each card's own turn)
  angle: number
  flipH: boolean
  flipV: boolean
  rotateBackground: 'transparent' | 'white' | 'black'
  applyTo: 'all' | 'portrait' | 'landscape'
  // make GIF
  animFormat: 'gif' | 'webp' | 'apng'
  seconds: number
  loop: boolean
  animSize: 'first' | 'custom'
  animWidth: number
  animHeight: number
  animFit: 'contain' | 'cover'
  // icon
  iconFormat: 'ico' | 'icns' | 'cur'
  iconSizes: number[]
  // watermark / meme
  layers: MarkLayer[]
  memeOutside: boolean
  // offline AI
  upscale: 2 | 4
  bgMode: 'transparent' | 'colour'
  bgColour: string
  bgFormat: 'png' | 'webp'
  findFaces: boolean
  findPlates: boolean
  sensitivity: 'low' | 'normal' | 'high'
  hideStyle: 'blur' | 'pixelate' | 'box'
  hideStrength: number
}

export function defaultOptions(tool: ImageToolId): ImgOptions {
  return {
    format: tool === 'imgToJpg' ? 'jpg' : tool === 'imgConvert' ? 'png' : 'jpg',
    ext: 'jpg',
    quality: 85,
    lossless: false,
    background: '#ffffff',
    keepMetadata: tool === 'imgConvert' || tool === 'imgToJpg',
    keepAnimation: true,
    palette: false,
    level: 'recommended',
    targetKb: 200,
    compressTo: 'same',
    resizeBy: 'pixels',
    width: 1920,
    height: null,
    keepShape: true,
    noEnlarge: true,
    percent: 50,
    longest: 1600,
    cropBy: 'ratio',
    ratio: '1:1',
    position: 'centre',
    box: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    angle: 0,
    flipH: false,
    flipV: false,
    rotateBackground: 'transparent',
    applyTo: 'all',
    animFormat: 'gif',
    seconds: 0.5,
    loop: true,
    animSize: 'first',
    animWidth: 800,
    animHeight: 600,
    animFit: 'contain',
    iconFormat: 'ico',
    iconSizes: [256, 128, 64, 48, 32, 16],
    layers: [],
    memeOutside: false,
    upscale: 2,
    bgMode: 'transparent',
    bgColour: '#ffffff',
    bgFormat: 'png',
    findFaces: true,
    findPlates: true,
    sensitivity: 'normal',
    hideStyle: 'blur',
    hideStrength: 60
  }
}

/** Meme "text outside": white bands above and below the picture. */
export function memeBands(o: ImgOptions): { top: number; bottom: number; colour: string } | undefined {
  return o.memeOutside ? { top: 0.22, bottom: 0.22, colour: '#ffffff' } : undefined
}

const RATIOS: Array<{ value: string; ratio: number | null }> = [
  { value: 'free', ratio: null },
  { value: '1:1', ratio: 1 },
  { value: '4:3', ratio: 4 / 3 },
  { value: '3:4', ratio: 3 / 4 },
  { value: '3:2', ratio: 3 / 2 },
  { value: '2:3', ratio: 2 / 3 },
  { value: '16:9', ratio: 16 / 9 },
  { value: '9:16', ratio: 9 / 16 },
  { value: '4:5', ratio: 4 / 5 },
  { value: '1.91:1', ratio: 1.91 }
]
const ratioOf = (value: string): number | null => RATIOS.find((r) => r.value === value)?.ratio ?? null

/** Quality per format for Compress's levels (measured trade-offs: mozjpeg, libwebp, libaom). */
const LEVELS = {
  recommended: { jpg: 78, webp: 76, avif: 60, png: 80, colours: 256 },
  strong: { jpg: 62, webp: 60, avif: 45, png: 60, colours: 128 },
  light: { jpg: 90, webp: 88, avif: 75, png: 100, colours: 256 }
} as const

/** The job that turns one card into the tool's result. */
export function jobFor(tool: ImageToolId, o: ImgOptions, card: Card): ImageJob {
  const info = card.info!
  switch (tool) {
    case 'imgCompress': {
      const to = o.compressTo === 'same' ? null : o.compressTo
      const target = to ?? 'same'
      const own = to ?? (formatSpec(info.format).write && info.format !== 'pdf' ? info.format : 'jpg')
      const output: Output = { format: target, keepMetadata: o.keepMetadata, neverLarger: true, keepAnimation: true }
      if (o.level === 'quality') output.quality = o.quality
      else if (o.level === 'target') output.targetBytes = Math.max(1024, Math.round(o.targetKb * 1024))
      else {
        const level = LEVELS[o.level]
        if (own === 'png') {
          // PNG is lossless: the real saving is fewer colours (a palette), except at "light".
          output.palette = o.level !== 'light'
          output.quality = level.png
          output.colours = level.colours
        } else if (own === 'gif') output.colours = level.colours
        else output.quality = own === 'webp' ? level.webp : own === 'avif' ? level.avif : level.jpg
      }
      return { output }
    }
    case 'imgResize':
      return {
        resize:
          o.resizeBy === 'percent'
            ? { by: 'percent', percent: o.percent }
            : o.resizeBy === 'longest'
              ? { by: 'longest', pixels: o.longest, noEnlarge: o.noEnlarge }
              : { by: 'pixels', width: o.width, height: o.height, fit: o.keepShape ? 'max' : 'exact', noEnlarge: o.noEnlarge },
        output: { format: 'same', quality: 90, keepMetadata: false, keepAnimation: true }
      }
    case 'imgCrop': {
      const ratio = ratioOf(o.ratio)
      const crop = o.cropBy === 'box' || ratio === null ? { by: 'box' as const, ...o.box } : { by: 'ratio' as const, ratio, position: o.position }
      return { crop, output: { format: 'same', quality: 92, keepAnimation: true } }
    }
    case 'imgRotate': {
      const angle = card.rotate + o.angle
      const background = o.rotateBackground === 'white' ? '#ffffff' : o.rotateBackground === 'black' ? '#000000' : '#00000000'
      return { rotate: { angle, flipH: o.flipH, flipV: o.flipV, background }, output: { format: 'same', quality: 92, keepAnimation: true } }
    }
    case 'imgIcon':
      return { output: { format: o.iconFormat, iconSizes: o.iconFormat === 'cur' ? [Math.min(256, Math.max(...o.iconSizes.filter((s) => s <= 256), 32))] : o.iconSizes } }
    case 'imgInfo':
      return { output: { format: 'same', quality: 95, keepMetadata: false, keepAnimation: true } }
    case 'imgUpscale':
      return { ai: { upscale: o.upscale }, output: { format: 'same', quality: 92 } }
    case 'imgRemoveBg':
      return o.bgMode === 'colour' ? { ai: { background: { colour: o.bgColour } }, output: { format: 'same', quality: 92 } } : { ai: { background: { colour: null } }, output: { format: o.bgFormat, quality: 92 } }
    case 'imgBlur':
      // Hidden areas are about privacy: camera details and location go too.
      return { ai: { hide: { regions: (card.regions ?? []).map(({ x, y, w, h, kind }) => ({ x, y, w, h, kind })), style: o.hideStyle, strength: o.hideStrength } }, output: { format: 'same', quality: 92, keepMetadata: false } }
    case 'imgWatermark':
    case 'imgMeme':
      return { marks: marksFor(o.layers, tool === 'imgMeme' ? memeBands(o) : undefined), output: { format: 'same', quality: 92, keepAnimation: true } }
    case 'imgToJpg':
    case 'imgConvert':
    default: {
      const spec = formatSpec(o.format)
      return {
        output: {
          format: o.format,
          ext: o.format === 'jpg' ? o.ext : undefined,
          quality: spec.quality ? o.quality : undefined,
          lossless: spec.quality ? o.lossless : undefined,
          background: o.background,
          keepMetadata: o.keepMetadata,
          keepAnimation: o.keepAnimation,
          palette: o.format === 'png' ? o.palette : undefined,
          iconSizes: o.format === 'ico' || o.format === 'icns' ? o.iconSizes : undefined
        }
      }
    }
  }
}

export function animateOptions(o: ImgOptions, cards: Card[]): Animate {
  const first = cards[0]?.info
  // GIFs larger than this become very big files; the first picture's size is capped to it.
  const cap = (w: number, h: number): [number, number] => {
    const s = Math.min(1, 1200 / Math.max(w, h))
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
  }
  const [w, h] = o.animSize === 'custom' ? [o.animWidth, o.animHeight] : first ? cap(first.width, first.height) : [800, 600]
  return { format: o.animFormat, delay: Math.round(o.seconds * 1000), loop: o.loop, width: w, height: h, fit: o.animFit, background: o.background, quality: 85 }
}

/** The line under a card saying what it will become. */
export function previewLine(tool: ImageToolId, o: ImgOptions, card: Card, t: T): string | null {
  const info = card.info!
  switch (tool) {
    case 'imgResize': {
      const job = jobFor(tool, o, card)
      const s = resizedSize(info.width, info.height, job.resize!)
      return `${s.width} × ${s.height}`
    }
    case 'imgConvert':
    case 'imgToJpg':
      return `.${o.format === 'jpg' ? o.ext : formatSpec(o.format).ext[0]}`
    case 'imgRotate': {
      const angle = (((card.rotate + o.angle) % 360) + 360) % 360
      return angle || o.flipH || o.flipV ? [angle ? `${angle}°` : '', o.flipH ? t('img.flipH') : '', o.flipV ? t('img.flipV') : ''].filter(Boolean).join(' · ') : null
    }
    case 'imgCompress':
      return o.compressTo === 'same' ? null : `.${formatSpec(o.compressTo).ext[0]}`
    case 'imgIcon':
      return `.${formatSpec(o.iconFormat).ext[0]}`
    case 'imgUpscale':
      return `${info.width * o.upscale} × ${info.height * o.upscale}`
    case 'imgRemoveBg':
      return o.bgMode === 'colour' ? t('rbg.onColour') : `.${o.bgFormat}`
    case 'imgBlur': {
      if (card.detecting || !card.regions) return t('blur.finding')
      const faces = card.regions.filter((r) => r.kind === 'face').length
      const plates = card.regions.filter((r) => r.kind === 'plate').length
      const manual = card.regions.filter((r) => r.kind === 'manual').length
      return t('blur.count', { faces, plates, manual })
    }
    default:
      return null
  }
}

/** A short note under the options (what happens to transparency, animation, metadata). */
export function outputNote(tool: ImageToolId, o: ImgOptions, t: T): string | null {
  if (tool === 'imgCompress') return t('img.note.compress')
  if (tool === 'imgConvert' || tool === 'imgToJpg') return formatSpec(o.format).alpha ? null : t('img.note.noAlpha')
  if (tool === 'imgFrames') return t('img.note.frames')
  if (tool === 'imgGif') return t('img.note.gif')
  if (tool === 'imgUpscale') return t('ai.note.upscale')
  if (tool === 'imgRemoveBg') return t('ai.note.background')
  if (tool === 'imgBlur') return t('ai.note.blur')
  return null
}

function Range({ value, onChange, min, max, step = 1, label, suffix }: { value: number; onChange: (n: number) => void; min: number; max: number; step?: number; label: string; suffix?: string }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]"
        dir="ltr"
      />
      <div className="w-[80px] shrink-0">
        <NumberInput value={value} onChange={onChange} min={min} max={max} step={step} suffix={suffix} />
      </div>
    </div>
  )
}

/** A nullable whole number: empty means "automatic". */
function AutoNumber({ value, onChange, placeholder, suffix }: { value: number | null; onChange: (n: number | null) => void; placeholder: string; suffix?: string }) {
  return (
    <div className="relative" dir="ltr">
      <input
        type="number"
        min={1}
        className="h-8 w-full rounded-lg border border-line bg-surface px-2.5 pe-9 text-[13px] text-ink tabular-nums outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-faint focus:border-accent focus:ring-3 focus:ring-accent/20"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          onChange(e.target.value === '' || !Number.isFinite(n) || n < 1 ? null : Math.min(100_000, n))
        }}
      />
      {suffix && <span className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-[12px] text-faint">{suffix}</span>}
    </div>
  )
}

const POPULAR: FormatId[] = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'bmp', 'ico', 'pdf', 'jxl']

function FormatPicker({ value, onChange }: { value: FormatId; onChange: (f: FormatId) => void }) {
  const t = useT()
  const others = WRITABLE.filter((f) => !POPULAR.includes(f.id)).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  return (
    <div className="flex flex-col gap-2" data-format-picker="">
      <div className="grid grid-cols-5 gap-1.5">
        {POPULAR.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            title={formatSpec(id).name}
            onClick={() => onChange(id)}
            className={clsx('h-8 rounded-lg border text-[12px] font-semibold transition-colors', value === id ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface hover:border-faint')}
          >
            {formatSpec(id).label}
          </button>
        ))}
      </div>
      <Select
        value={POPULAR.includes(value) ? ('' as string) : value}
        label={t('img.moreFormats')}
        onChange={(v) => v && onChange(v as FormatId)}
        options={[{ value: '', label: t('img.moreFormats') }, ...others.map((f) => ({ value: f.id as string, label: `${f.label} — ${f.name}`, hint: `.${f.ext.slice(0, 4).join(' .')}` }))]}
      />
    </div>
  )
}

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

function IconSizes({ o, setOpts, max }: { o: ImgOptions; setOpts: (p: Partial<ImgOptions>) => void; max: number }) {
  return (
    <div className="flex flex-wrap gap-1.5" dir="ltr">
      {ICON_SIZES.filter((s) => s <= max).map((s) => {
        const on = o.iconSizes.includes(s)
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => setOpts({ iconSizes: on ? o.iconSizes.filter((x) => x !== s) : [...o.iconSizes, s].sort((a, b) => b - a) })}
            className={clsx('h-7 min-w-11 rounded-md border px-2 text-[12px] font-medium tabular-nums', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-faint')}
          >
            {s}
          </button>
        )
      })}
    </div>
  )
}

/** The options panel of one tool. */
export function ImageOptions({
  tool,
  opts: o,
  setOpts,
  cards,
  setCards,
  selected,
  layerSel,
  setLayerSel,
  setLayers
}: {
  tool: ImageToolId
  opts: ImgOptions
  setOpts: (p: Partial<ImgOptions>) => void
  cards: Card[]
  setCards: React.Dispatch<React.SetStateAction<Card[]>>
  selected: Card | null
  layerSel: string | null
  setLayerSel: (id: string | null) => void
  setLayers: (next: MarkLayer[] | ((now: MarkLayer[]) => MarkLayer[])) => void
}) {
  const t = useT()
  const anyAlpha = cards.some((c) => c.info?.hasAlpha)
  const anyAnimated = cards.some((c) => c.info && c.info.frames > 1 && c.info.format !== 'pdf')

  switch (tool) {
    case 'imgCompress':
      return (
        <>
          <Section title={t('img.level')}>
            <Segmented
              value={o.level}
              onChange={(level) => setOpts({ level })}
              options={[
                { value: 'recommended', label: t('img.level.recommended'), hint: t('img.level.recommendedHint') },
                { value: 'strong', label: t('img.level.strong'), hint: t('img.level.strongHint') },
                { value: 'light', label: t('img.level.light'), hint: t('img.level.lightHint') },
                { value: 'quality', label: t('img.level.quality'), hint: t('img.level.qualityHint') },
                { value: 'target', label: t('img.level.target'), hint: t('img.level.targetHint') }
              ]}
            />
            {o.level === 'quality' && <Range label={t('img.quality')} value={o.quality} onChange={(quality) => setOpts({ quality })} min={1} max={100} suffix="%" />}
            {o.level === 'target' && (
              <div className="w-40">
                <NumberInput value={o.targetKb} onChange={(targetKb) => setOpts({ targetKb })} min={5} max={100_000} suffix={t('img.kb')} />
              </div>
            )}
          </Section>
          <Section title={t('img.compressTo')}>
            <Select
              value={o.compressTo}
              onChange={(compressTo) => setOpts({ compressTo })}
              options={[
                { value: 'same', label: t('img.keepFormat'), hint: t('img.keepFormatHint') },
                { value: 'webp', label: 'WebP', hint: t('img.toWebpHint') },
                { value: 'avif', label: 'AVIF', hint: t('img.toAvifHint') },
                { value: 'jpg', label: 'JPG', hint: t('img.toJpgHint') }
              ]}
            />
          </Section>
          <Switch checked={o.keepMetadata} onChange={(keepMetadata) => setOpts({ keepMetadata })} label={t('img.keepMetadata')} hint={t('img.keepMetadataHint')} />
        </>
      )

    case 'imgResize': {
      const sel = selected?.info
      return (
        <>
          <Section title={t('img.resizeBy')}>
            <Segmented
              value={o.resizeBy}
              onChange={(resizeBy) => setOpts({ resizeBy })}
              options={[
                { value: 'pixels', label: t('img.byPixels') },
                { value: 'percent', label: t('img.byPercent') },
                { value: 'longest', label: t('img.byLongest') }
              ]}
            />
          </Section>
          {o.resizeBy === 'pixels' && (
            <Section title={o.keepShape ? t('img.maxSize') : t('img.exactSize')}>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-muted">{t('img.width')}</span>
                  <AutoNumber value={o.width} onChange={(width) => setOpts({ width })} placeholder={t('img.auto')} suffix="px" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-muted">{t('img.height')}</span>
                  <AutoNumber value={o.height} onChange={(height) => setOpts({ height })} placeholder={t('img.auto')} suffix="px" />
                </label>
              </div>
              <Check checked={o.keepShape} onChange={(keepShape) => setOpts({ keepShape })} label={t('img.keepShape')} hint={o.keepShape ? t('img.keepShapeHint') : t('img.exactHint')} />
            </Section>
          )}
          {o.resizeBy === 'percent' && (
            <Section title={t('img.newSize')}>
              <Segmented
                value={String(o.percent)}
                onChange={(v) => setOpts({ percent: Number(v) })}
                options={[
                  { value: '75', label: t('img.smaller', { percent: 25 }) },
                  { value: '50', label: t('img.smaller', { percent: 50 }) },
                  { value: '25', label: t('img.smaller', { percent: 75 }) }
                ]}
              />
              <Range label={t('img.percentOfSize')} value={o.percent} onChange={(percent) => setOpts({ percent })} min={1} max={400} suffix="%" />
            </Section>
          )}
          {o.resizeBy === 'longest' && (
            <Section title={t('img.longestSide')}>
              <div className="w-40">
                <NumberInput value={o.longest} onChange={(longest) => setOpts({ longest })} min={1} max={100_000} suffix="px" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[640, 1080, 1280, 1600, 1920, 2560, 3840].map((p) => (
                  <button key={p} type="button" onClick={() => setOpts({ longest: p })} className={clsx('h-7 rounded-md border px-2 text-[12px] tabular-nums', o.longest === p ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:border-faint')}>
                    {p}
                  </button>
                ))}
              </div>
            </Section>
          )}
          {o.resizeBy !== 'percent' && <Check checked={o.noEnlarge} onChange={(noEnlarge) => setOpts({ noEnlarge })} label={t('img.noEnlarge')} />}
          {sel && <p className="text-[11px] text-muted">{t('img.selectedSize', { name: selected!.name, width: sel.width, height: sel.height })}</p>}
        </>
      )
    }

    case 'imgCrop': {
      const sel = selected?.info
      const px = (f: number, of: number): number => Math.round(f * of)
      const setPx = (key: 'x' | 'y' | 'width' | 'height', value: number): void => {
        if (!sel) return
        const of = key === 'x' || key === 'width' ? sel.width : sel.height
        setOpts({ cropBy: 'box', ratio: 'free', box: { ...o.box, [key]: Math.min(1, Math.max(0, value / of)) } })
      }
      return (
        <>
          <Section title={t('img.shape')}>
            <div className="grid grid-cols-5 gap-1.5" dir="ltr">
              {RATIOS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={o.ratio === r.value}
                  onClick={() => setOpts({ ratio: r.value, cropBy: r.ratio === null ? 'box' : 'ratio' })}
                  className={clsx('h-8 rounded-lg border text-[12px] font-medium', o.ratio === r.value ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-faint')}
                >
                  {r.value === 'free' ? t('img.free') : r.value}
                </button>
              ))}
            </div>
          </Section>
          {o.cropBy === 'ratio' && ratioOf(o.ratio) !== null && (
            <Section title={t('img.position')}>
              <Select
                value={o.position}
                onChange={(position) => setOpts({ position })}
                options={[
                  { value: 'centre', label: t('img.pos.centre') },
                  { value: 'smart', label: t('img.pos.smart'), hint: t('img.pos.smartHint') },
                  { value: 'top', label: t('img.pos.top') },
                  { value: 'bottom', label: t('img.pos.bottom') },
                  { value: 'left', label: t('img.pos.left') },
                  { value: 'right', label: t('img.pos.right') }
                ]}
              />
              <p className="text-[11px] text-muted">{t('img.ratioHint')}</p>
            </Section>
          )}
          {o.cropBy === 'box' && sel && (
            <Section title={t('img.boxPixels', { name: selected!.name })}>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['width', t('img.width'), sel.width],
                    ['height', t('img.height'), sel.height],
                    ['x', t('img.posX'), sel.width],
                    ['y', t('img.posY'), sel.height]
                  ] as const
                ).map(([key, label, of]) => (
                  <label key={key} className="flex flex-col gap-1">
                    <span className="text-[12px] text-muted">{label}</span>
                    <NumberInput value={px(o.box[key], of)} onChange={(v) => setPx(key, v)} min={0} max={of} suffix="px" />
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted">{t('img.boxHint')}</p>
            </Section>
          )}
        </>
      )
    }

    case 'imgRotate': {
      const turnAll = (by: number): void =>
        setCards((now) =>
          now.map((c) => {
            if (!c.info) return c
            const landscape = c.info.width >= c.info.height
            if ((o.applyTo === 'portrait' && landscape) || (o.applyTo === 'landscape' && !landscape)) return c
            return { ...c, rotate: (((c.rotate + by) % 360) + 360) % 360 }
          })
        )
      return (
        <>
          <Section title={t('img.turnPictures')}>
            <Segmented
              value={o.applyTo}
              onChange={(applyTo) => setOpts({ applyTo })}
              options={[
                { value: 'all', label: t('img.applyAll') },
                { value: 'portrait', label: t('images.portrait') },
                { value: 'landscape', label: t('images.landscape') }
              ]}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button icon={<RotateCcw size={15} />} onClick={() => turnAll(-90)}>
                {t('img.left')}
              </Button>
              <Button icon={<RotateCw size={15} />} onClick={() => turnAll(90)}>
                {t('img.right')}
              </Button>
            </div>
            <p className="text-[11px] text-muted">{t('img.rotateHint')}</p>
          </Section>
          <Section title={t('img.flip')}>
            <div className="grid grid-cols-2 gap-2">
              <Button icon={<FlipHorizontal2 size={15} />} className={clsx(o.flipH && 'border-accent! bg-accent-soft! text-accent!')} aria-pressed={o.flipH} onClick={() => setOpts({ flipH: !o.flipH })}>
                {t('img.flipH')}
              </Button>
              <Button icon={<FlipVertical2 size={15} />} className={clsx(o.flipV && 'border-accent! bg-accent-soft! text-accent!')} aria-pressed={o.flipV} onClick={() => setOpts({ flipV: !o.flipV })}>
                {t('img.flipV')}
              </Button>
            </div>
          </Section>
          <Section title={t('img.anyAngle')}>
            <Range label={t('img.anyAngle')} value={o.angle} onChange={(angle) => setOpts({ angle })} min={-180} max={180} suffix="°" />
            {o.angle % 90 !== 0 && (
              <Segmented
                value={o.rotateBackground}
                onChange={(rotateBackground) => setOpts({ rotateBackground })}
                options={[
                  { value: 'transparent', label: t('img.bg.transparent') },
                  { value: 'white', label: t('img.bg.white') },
                  { value: 'black', label: t('img.bg.black') }
                ]}
              />
            )}
          </Section>
          <Button
            variant="ghost"
            onClick={() => {
              setCards((now) => now.map((c) => ({ ...c, rotate: 0 })))
              setOpts({ angle: 0, flipH: false, flipV: false })
            }}
          >
            {t('img.resetRotation')}
          </Button>
        </>
      )
    }

    case 'imgGif':
      return (
        <>
          <Section title={t('img.animFormat')}>
            <Segmented
              value={o.animFormat}
              onChange={(animFormat) => setOpts({ animFormat })}
              options={[
                { value: 'gif', label: 'GIF', hint: t('img.gifHint') },
                { value: 'webp', label: 'WebP', hint: t('img.webpAnimHint') },
                { value: 'apng', label: 'APNG', hint: t('img.apngHint') }
              ]}
            />
          </Section>
          <Section title={t('img.secondsPerPicture')}>
            <Range label={t('img.secondsPerPicture')} value={o.seconds} onChange={(seconds) => setOpts({ seconds })} min={0.1} max={10} step={0.1} suffix={t('img.sec')} />
            <Check checked={o.loop} onChange={(loop) => setOpts({ loop })} label={t('img.loop')} />
          </Section>
          <Section title={t('img.frameSize')}>
            <Segmented
              value={o.animSize}
              onChange={(animSize) => setOpts({ animSize })}
              options={[
                { value: 'first', label: t('img.likeFirst') },
                { value: 'custom', label: t('img.custom') }
              ]}
            />
            {o.animSize === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <NumberInput value={o.animWidth} onChange={(animWidth) => setOpts({ animWidth })} min={1} max={4000} suffix="px" />
                <NumberInput value={o.animHeight} onChange={(animHeight) => setOpts({ animHeight })} min={1} max={4000} suffix="px" />
              </div>
            )}
            <Segmented
              value={o.animFit}
              onChange={(animFit) => setOpts({ animFit })}
              options={[
                { value: 'contain', label: t('img.fitWhole'), hint: t('img.fitWholeHint') },
                { value: 'cover', label: t('img.fitFill'), hint: t('img.fitFillHint') }
              ]}
            />
            {o.animFit === 'contain' && <ColourPicker value={o.background} onChange={(background) => setOpts({ background })} label={t('img.background')} />}
          </Section>
        </>
      )

    case 'imgUpscale': {
      const big = cards.some((c) => c.info && c.info.width * c.info.height * o.upscale * o.upscale > 60e6)
      return (
        <>
          <Section title={t('up.factor')}>
            <Segmented
              value={String(o.upscale) as '2' | '4'}
              onChange={(v) => setOpts({ upscale: Number(v) as 2 | 4 })}
              options={[
                { value: '2', label: '2×', hint: t('up.twoHint') },
                { value: '4', label: '4×', hint: t('up.fourHint') }
              ]}
            />
          </Section>
          {big && <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-snug">{t('up.tooBig')}</p>}
        </>
      )
    }

    case 'imgRemoveBg':
      return (
        <>
          <Section title={t('rbg.background')}>
            <Segmented
              value={o.bgMode}
              onChange={(bgMode) => setOpts({ bgMode })}
              options={[
                { value: 'transparent', label: t('img.bg.transparent'), hint: t('rbg.transparentHint') },
                { value: 'colour', label: t('rbg.colour'), hint: t('rbg.colourHint') }
              ]}
            />
            {o.bgMode === 'colour' ? (
              <ColourPicker value={o.bgColour} onChange={(bgColour) => setOpts({ bgColour })} label={t('rbg.colour')} />
            ) : (
              <Segmented
                value={o.bgFormat}
                onChange={(bgFormat) => setOpts({ bgFormat })}
                options={[
                  { value: 'png', label: 'PNG', hint: t('rbg.pngHint') },
                  { value: 'webp', label: 'WebP', hint: t('rbg.webpHint') }
                ]}
              />
            )}
          </Section>
        </>
      )

    case 'imgBlur':
      return (
        <>
          <Section title={t('blur.find')}>
            <Check checked={o.findFaces} onChange={(findFaces) => setOpts({ findFaces })} label={t('blur.faces')} />
            <Check checked={o.findPlates} onChange={(findPlates) => setOpts({ findPlates })} label={t('blur.plates')} />
            <Segmented
              value={o.sensitivity}
              onChange={(sensitivity) => setOpts({ sensitivity })}
              options={[
                { value: 'low', label: t('blur.low'), hint: t('blur.lowHint') },
                { value: 'normal', label: t('blur.normal'), hint: t('blur.normalHint') },
                { value: 'high', label: t('blur.high'), hint: t('blur.highHint') }
              ]}
            />
          </Section>
          <Section title={t('blur.how')}>
            <Segmented
              value={o.hideStyle}
              onChange={(hideStyle) => setOpts({ hideStyle })}
              options={[
                { value: 'blur', label: t('blur.blur') },
                { value: 'pixelate', label: t('blur.pixelate') },
                { value: 'box', label: t('blur.box') }
              ]}
            />
            {o.hideStyle !== 'box' && <Range label={t('blur.strength')} value={o.hideStrength} onChange={(hideStrength) => setOpts({ hideStrength })} min={10} max={100} suffix="%" />}
          </Section>
          {selected?.regions && (
            <Button variant="ghost" onClick={() => setCards((now) => now.map((c) => (c.key === selected.key ? { ...c, regions: [] } : c)))} disabled={!selected.regions.length}>
              {t('blur.clear')}
            </Button>
          )}
        </>
      )

    case 'imgWatermark':
      return <MarksPanel layers={o.layers} setLayers={setLayers} selected={layerSel} setSelected={setLayerSel} />

    case 'imgMeme':
      return (
        <>
          <Section title={t('meme.where')}>
            <Segmented
              value={o.memeOutside ? 'outside' : 'inside'}
              onChange={async (v) => {
                const outside = v === 'outside'
                // The two captions move into the white bands, in black, or back onto the picture.
                const total = 1.44
                const next = await Promise.all(
                  o.layers.map(async (l, i) => {
                    if (i > 1 || l.kind !== 'text') return l
                    const look = { ...l, colour: outside ? '#000000' : '#ffffff', outline: outside ? null : '#000000' }
                    return { ...look, ...(await drawText(look)), y: outside ? (i === 0 ? 0.11 / total : 1.33 / total) : i === 0 ? 0.12 : 0.88 }
                  })
                )
                setLayers(next)
                setOpts({ memeOutside: outside })
              }}
              options={[
                { value: 'inside', label: t('meme.inside'), hint: t('meme.insideHint') },
                { value: 'outside', label: t('meme.outside'), hint: t('meme.outsideHint') }
              ]}
            />
          </Section>
          <MarksPanel layers={o.layers} setLayers={setLayers} selected={layerSel} setSelected={setLayerSel} meme />
        </>
      )

    case 'imgFrames':
      return <p className="text-[13px] leading-relaxed text-muted">{t('img.framesIntro')}</p>

    case 'imgIcon':
      return (
        <>
          <Section title={t('img.iconKind')}>
            <Segmented
              value={o.iconFormat}
              onChange={(iconFormat) => setOpts({ iconFormat, iconSizes: iconFormat === 'icns' ? [1024, 512, 256, 128, 64, 32, 16] : [256, 128, 64, 48, 32, 16] })}
              options={[
                { value: 'ico', label: 'ICO', hint: t('img.icoHint') },
                { value: 'icns', label: 'ICNS', hint: t('img.icnsHint') },
                { value: 'cur', label: 'CUR', hint: t('img.curHint') }
              ]}
            />
          </Section>
          {o.iconFormat !== 'cur' && (
            <Section title={t('img.iconSizes')}>
              <IconSizes o={o} setOpts={setOpts} max={o.iconFormat === 'icns' ? 1024 : 256} />
              <p className="text-[11px] text-muted">{t('img.iconSizesHint')}</p>
            </Section>
          )}
        </>
      )

    case 'imgToJpg':
    case 'imgConvert':
    default: {
      const spec = formatSpec(o.format)
      return (
        <>
          {tool === 'imgConvert' && (
            <Section title={t('img.convertTo')}>
              <FormatPicker value={o.format} onChange={(format) => setOpts({ format })} />
              <p className="text-[11px] text-muted">{spec.name}</p>
            </Section>
          )}
          {o.format === 'jpg' && (
            <Section title={t('img.extension')}>
              <Segmented
                value={o.ext}
                onChange={(ext) => setOpts({ ext })}
                options={['jpg', 'jpeg', 'jfif', 'jpe'].map((e) => ({ value: e, label: `.${e}` }))}
              />
            </Section>
          )}
          {spec.quality && (
            <Section title={t('img.quality')}>
              {o.format !== 'jpg' && <Check checked={o.lossless} onChange={(lossless) => setOpts({ lossless })} label={t('img.lossless')} hint={t('img.losslessHint')} />}
              {!(o.lossless && o.format !== 'jpg') && <Range label={t('img.quality')} value={o.quality} onChange={(quality) => setOpts({ quality })} min={1} max={100} suffix="%" />}
            </Section>
          )}
          {o.format === 'png' && <Check checked={o.palette} onChange={(palette) => setOpts({ palette })} label={t('img.palette')} hint={t('img.paletteHint')} />}
          {(o.format === 'ico' || o.format === 'icns') && (
            <Section title={t('img.iconSizes')}>
              <IconSizes o={o} setOpts={setOpts} max={o.format === 'icns' ? 1024 : 256} />
            </Section>
          )}
          {!spec.alpha && anyAlpha && (
            <Section title={t('img.background')}>
              <ColourPicker value={o.background} onChange={(background) => setOpts({ background })} label={t('img.background')} />
              <p className="text-[11px] text-muted">{t('img.backgroundHint')}</p>
            </Section>
          )}
          {anyAnimated && spec.animation && <Check checked={o.keepAnimation} onChange={(keepAnimation) => setOpts({ keepAnimation })} label={t('img.keepAnimation')} />}
          {anyAnimated && !spec.animation && <p className="text-[11px] text-muted">{t('img.firstFrameOnly')}</p>}
          <Switch checked={o.keepMetadata} onChange={(keepMetadata) => setOpts({ keepMetadata })} label={t('img.keepMetadata')} hint={t('img.keepMetadataHint')} />
        </>
      )
    }
  }
}

/**
 * Crop's stage: the selected picture large, with the kept box on it — drag inside to move it,
 * a handle to resize it; the shape chosen in the panel holds while dragging. The box is kept as
 * fractions of the picture, so the same box suits every picture in the batch.
 */
export function CropStage({ card, opts: o, setOpts }: { card: Card; opts: ImgOptions; setOpts: (p: Partial<ImgOptions>) => void }) {
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
  const scale = Math.min((size.w - 48) / info.width, (size.h - 48) / info.height)
  const W = Math.max(1, info.width * scale)
  const H = Math.max(1, info.height * scale)
  const ratio = ratioOf(o.ratio)

  // The box shown: the dragged one, or the shape placed by the chosen position.
  let box = o.box
  if (o.cropBy === 'ratio' && ratio !== null) {
    let w = info.width
    let h = info.width / ratio
    if (h > info.height) {
      h = info.height
      w = h * ratio
    }
    const fx = { centre: 0.5, top: 0.5, bottom: 0.5, left: 0, right: 1, smart: 0.5 }[o.position]
    const fy = { centre: 0.5, top: 0, bottom: 1, left: 0.5, right: 0.5, smart: 0.5 }[o.position]
    box = { x: ((info.width - w) * fx) / info.width, y: ((info.height - h) * fy) / info.height, width: w / info.width, height: h / info.height }
  }

  const press = (e: React.PointerEvent, handle: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const start = { ...box }
    const x0 = e.clientX
    const y0 = e.clientY
    // In fractions of the picture, the box's width per height when a shape is locked.
    const lock = ratio !== null ? (ratio * info.height) / info.width : null
    const min = 0.02
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - x0) / W
      const dy = (ev.clientY - y0) / H
      let { x, y, width, height } = start
      if (handle === 'move') {
        x = Math.min(Math.max(0, x + dx), 1 - width)
        y = Math.min(Math.max(0, y + dy), 1 - height)
      } else {
        let left = x
        let top = y
        let right = x + width
        let bottom = y + height
        if (handle.includes('w')) left = Math.min(Math.max(0, left + dx), right - min)
        if (handle.includes('e')) right = Math.max(Math.min(1, right + dx), left + min)
        if (handle.includes('n')) top = Math.min(Math.max(0, top + dy), bottom - min)
        if (handle.includes('s')) bottom = Math.max(Math.min(1, bottom + dy), top + min)
        width = right - left
        height = bottom - top
        if (lock !== null) {
          // Keep the shape: the side dragged leads, the other follows, within the picture.
          if (handle === 'n' || handle === 's') width = height * lock
          else height = width / lock
          if (width > 1) {
            width = 1
            height = width / lock
          }
          if (height > 1) {
            height = 1
            width = height * lock
          }
          if (handle.includes('w')) left = right - width
          if (handle.includes('n')) top = bottom - height
          left = Math.min(Math.max(0, left), 1 - width)
          top = Math.min(Math.max(0, top), 1 - height)
        }
        x = left
        y = top
      }
      setOpts({ cropBy: 'box', box: { x, y, width, height } })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  const pos = (h: string): React.CSSProperties => ({
    left: h.includes('w') ? -6 : h.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
    top: h.includes('n') ? -6 : h.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
    cursor: `${h}-resize`
  })
  return (
    <div ref={stage} className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden" data-crop-stage="" dir="ltr">
      {size.w > 0 && (
        <div className="relative shadow-md" style={{ width: W, height: H }}>
          <img src={info.preview} alt="" draggable={false} className="block h-full w-full select-none" />
          <div
            className="absolute cursor-move border-2 border-white outline outline-1 outline-black/40"
            style={{ left: box.x * W, top: box.y * H, width: box.width * W, height: box.height * H, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.5)' }}
            onPointerDown={(e) => press(e, 'move')}
            aria-label={t('img.cropBox')}
          >
            <span className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="border border-white/25" />
              ))}
            </span>
            {handles.map((h) => (
              <span key={h} onPointerDown={(e) => press(e, h)} className="absolute h-3 w-3 rounded-sm border border-black/40 bg-white shadow" style={pos(h)} />
            ))}
            <span className="pointer-events-none absolute start-1/2 top-full mt-1.5 -translate-x-1/2 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-surface tabular-nums">
              {Math.round(box.width * info.width)} × {Math.round(box.height * info.height)}
            </span>
          </div>
        </div>
      )}
      <span className="absolute start-3 top-3 rounded-full bg-surface/90 px-2.5 py-1 text-[11px] text-muted shadow-sm" dir="auto">
        {o.cropBy === 'ratio' && o.position === 'smart' ? t('img.smartPreview') : t('img.cropApplies')}
      </span>
    </div>
  )
}

/** Info & metadata: the selected picture's facts and its EXIF, GPS, IPTC, XMP. */
export function InfoPanel({ card }: { card: Card | null }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [meta, setMeta] = useState<ImageMetadata | null | 'loading'>(null)
  useEffect(() => {
    if (!card?.info) return setMeta(null)
    setMeta('loading')
    let live = true
    void window.api.imageMetadata(card.path).then((r) => live && setMeta(r.ok ? r.value : { groups: [], location: null }))
    return () => {
      live = false
    }
  }, [card?.path, card?.info])
  if (!card) return <p className="text-[13px] text-muted">{t('img.infoEmpty')}</p>
  const info = card.info
  if (!info) return <p className="text-[13px] text-muted">{card.failed ? t('cannotRead') : t('loading')}</p>
  const spec = formatSpec(info.format)
  const facts: Array<[string, string]> = [
    [t('img.info.format'), `${spec.label} — ${spec.name}`],
    [t('img.info.dimensions'), `${info.width} × ${info.height} px (${((info.width * info.height) / 1e6).toFixed(1)} MP)`],
    [t('img.info.fileSize'), formatBytes(language, info.size)],
    [t('img.info.transparency'), info.hasAlpha ? t('img.yes') : t('img.no')]
  ]
  if (info.frames > 1) facts.push([info.format === 'pdf' || info.format === 'tiff' ? t('img.info.pages') : t('img.info.frames'), String(info.frames)])
  if (info.density) facts.push([t('img.info.dpi'), `${Math.round(info.density)} dpi`])
  return (
    <div className="flex flex-col gap-4" data-info-panel="">
      <div className="flex items-center gap-3">
        <img src={info.preview} alt="" className="h-14 w-14 rounded-lg border border-line bg-surface-2 object-contain" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" dir="auto" title={card.path}>
          {card.name}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 truncate font-medium" dir="auto" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {meta === 'loading' ? (
        <Spinner />
      ) : meta && meta.location ? (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-snug" data-gps-warning="">
          <MapPin size={15} className="mt-px shrink-0 text-warn" />
          <span>
            {t('img.gpsWarning')}{' '}
            <span className="text-muted tabular-nums" dir="ltr">
              ({meta.location.latitude.toFixed(5)}, {meta.location.longitude.toFixed(5)})
            </span>
          </span>
        </p>
      ) : null}
      {meta && meta !== 'loading' && meta.groups.length === 0 && <p className="text-[12px] text-muted">{t('img.noMetadata')}</p>}
      {meta &&
        meta !== 'loading' &&
        meta.groups.map((g) => (
          <Section key={g.name} title={(['IFD0', 'EXIF', 'GPS', 'IPTC', 'XMP', 'ICC', 'JFIF', 'IHDR'].includes(g.name) ? t(`img.meta.${g.name.toLowerCase() as 'ifd0'}`) : g.name)}>
            <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-3 gap-y-1 text-[12px]" dir="ltr">
              {g.entries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="truncate text-muted" title={k}>
                    {k}
                  </dt>
                  <dd className="min-w-0 break-words select-text">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ))}
    </div>
  )
}

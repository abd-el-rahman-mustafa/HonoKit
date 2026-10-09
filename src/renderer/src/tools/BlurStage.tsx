import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DetectedRegion } from '@shared/imageOps'
import { useT } from '../store'
import { Spinner } from '../components/ui'
import type { Card } from '../components/ImageToolView'

/**
 * Blur faces' stage (decisions §69): the selected picture with what the models found, hidden as
 * it will be (a live blur; pixels and black boxes show as such). Click an area to keep it
 * visible after all, drag across the picture to hide something the models missed — no detector
 * is perfect, and for privacy the person decides.
 */
export function BlurStage({ card, style, onRegions }: { card: Card; style: 'blur' | 'pixelate' | 'box'; onRegions: (regions: DetectedRegion[]) => void }) {
  const t = useT()
  const info = card.info!
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
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
  const regions = card.regions ?? []

  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    setDrawing({ x0: x, y0: y, x1: x, y1: y })
    const move = (ev: PointerEvent): void => setDrawing({ x0: x, y0: y, x1: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y1: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) })
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrawing(null)
      const x1 = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
      const y1 = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
      const w = Math.abs(x1 - x)
      const h = Math.abs(y1 - y)
      if (w * W > 6 && h * H > 6) onRegions([...regions, { x: Math.min(x, x1), y: Math.min(y, y1), w, h, kind: 'manual', score: 1 }])
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const look = (kind: DetectedRegion['kind']): React.CSSProperties =>
    style === 'box'
      ? { background: '#000' }
      : { backdropFilter: `blur(${Math.max(4, Math.min(W, H) * 0.02)}px)`, WebkitBackdropFilter: 'blur(8px)', borderRadius: kind === 'face' ? '50%' : 4 }

  return (
    <div ref={stage} className="relative flex min-h-[280px] flex-1 items-center justify-center overflow-hidden" data-blur-stage="" dir="ltr">
      {size.w > 0 && (
        <div className="relative shadow-md select-none" style={{ width: W, height: H }}>
          <img src={info.preview} alt="" draggable={false} className="block h-full w-full" />
          <div className="absolute inset-0 cursor-crosshair" onPointerDown={start} />
          {regions.map((r, i) => {
            // As hidden: faces a little larger than the model's box, as the engine does.
            const grow = r.kind === 'face' ? 0.2 : 0.06
            return (
              <div
                key={i}
                className="group absolute"
                style={{ left: (r.x - r.w * grow) * W, top: (r.y - r.h * grow * (r.kind === 'face' ? 1.3 : 1)) * H, width: r.w * (1 + 2 * grow) * W, height: r.h * (1 + grow * (r.kind === 'face' ? 2.3 : 2)) * H }}
                data-blur-region={r.kind}
              >
                <div className="absolute inset-0" style={look(r.kind)} />
                <div className={clsx('pointer-events-none absolute inset-0 border-2', r.kind === 'face' ? 'rounded-[50%]' : 'rounded', r.kind === 'manual' ? 'border-dashed border-white' : 'border-accent')} />
                <button
                  type="button"
                  title={t('blur.keepVisible')}
                  aria-label={t('blur.keepVisible')}
                  onClick={() => onRegions(regions.filter((_, j) => j !== i))}
                  className="absolute -end-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-ink shadow group-hover:flex"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          {drawing && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-white bg-white/15"
              style={{ left: Math.min(drawing.x0, drawing.x1) * W, top: Math.min(drawing.y0, drawing.y1) * H, width: Math.abs(drawing.x1 - drawing.x0) * W, height: Math.abs(drawing.y1 - drawing.y0) * H }}
            />
          )}
          {card.detecting && (
            <span className="absolute start-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-surface/95 px-3 py-1.5 text-[12px] shadow">
              <Spinner size={14} />
              {t('blur.finding')}
            </span>
          )}
        </div>
      )}
      <span className="absolute start-3 top-3 rounded-full bg-surface/90 px-2.5 py-1 text-[11px] text-muted shadow-sm" dir="auto">
        {t('blur.stageHint')}
      </span>
    </div>
  )
}

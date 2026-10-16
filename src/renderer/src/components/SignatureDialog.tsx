import clsx from 'clsx'
import { ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SavedSignature } from '@shared/ipc'
import { changeSettings, setDialog, toast, updateView, useStore, useT, type Placing } from '../store'
import { Modal } from './Overlays'
import { Button, Check, Segmented, TextInput } from './ui'

/**
 * Making a signature, as Acrobat's Fill & Sign and Foxit's signature tool do: draw it, type
 * it, or use a picture of it. The result is a transparent PNG placed like any picture, then
 * moved and resized on the page. Saved signatures stay on this computer, in the settings
 * file, and are offered first next time. A drawn signature is a picture, not a digital
 * (certificate) signature — that is a separate, later feature (docs/features.md).
 */

const INKS = ['#111827', '#1d3f9e', '#0b6b3a']
/** Handwriting faces Windows (and Office) usually has; the browser falls back in order. */
const FACES = [
  { id: 'script', css: "'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Diwani Letter', 'Arabic Typesetting', cursive" },
  { id: 'hand', css: "'Lucida Handwriting', 'Segoe Print', 'Ink Free', 'Aldhabi', 'Arabic Typesetting', cursive" },
  { id: 'formal', css: "'Brush Script MT', 'Edwardian Script ITC', 'Sakkal Majalla', 'Arabic Typesetting', cursive" }
]
const MAX_SAVED = 8

/** Crops a canvas to its ink with a small margin; null if nothing is drawn. */
function trimmed(canvas: HTMLCanvasElement): { data: string; width: number; height: number; url: string } | null {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas
  const pixels = ctx.getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  const pad = 6
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(width - 1, x1 + pad)
  y1 = Math.min(height - 1, y1 + pad)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  const url = out.toDataURL('image/png')
  return { data: url.slice(url.indexOf(',') + 1), width: out.width, height: out.height, url }
}

export function SignatureDialog({ docId }: { docId: string }) {
  const t = useT()
  const saved = useStore((s) => s.settings?.signatures ?? [])
  const [tab, setTab] = useState<'draw' | 'type' | 'image'>('draw')
  const [ink, setInk] = useState(INKS[0]!)
  const [typed, setTyped] = useState('')
  const [face, setFace] = useState(FACES[0]!.id)
  const [keep, setKeep] = useState(true)
  const [drawn, setDrawn] = useState(false)
  const pad = useRef<HTMLCanvasElement>(null)
  const close = (): void => setDialog(null)

  const place = (placing: Placing): void => {
    updateView(docId, { placing, mode: 'edit' })
    close()
    toast('info', t('placeSignatureHint'))
  }
  const useSaved = (s: SavedSignature): void => place({ source: { data: s.data }, width: s.width, height: s.height, preview: `data:image/png;base64,${s.data}`, signature: true })
  const remove = (s: SavedSignature): void => void changeSettings({ signatures: saved.filter((x) => x.id !== s.id) })

  // The drawing pad: pointer strokes, smoothed with midpoint curves, at the screen's resolution.
  useEffect(() => {
    const canvas = pad.current
    if (!canvas || tab !== 'draw') return
    const ratio = Math.max(2, window.devicePixelRatio || 1)
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(rect.height * ratio)
    const ctx = canvas.getContext('2d')!
    ctx.scale(ratio, ratio)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    let points: Array<[number, number]> = []
    strokes.current = []
    const at = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const dot = (p: [number, number], colour: string): void => {
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(p[0], p[1], 1.3, 0, Math.PI * 2)
      ctx.fill()
    }
    const segment = (a: [number, number], b: [number, number], c: [number, number], colour: string): void => {
      ctx.strokeStyle = colour
      ctx.lineWidth = 3.2
      ctx.beginPath()
      ctx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
      ctx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2)
      ctx.stroke()
    }
    // Draws every stroke kept so far, after one is taken back.
    redraw.current = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const s of strokes.current) {
        dot(s.points[0]!, s.colour)
        for (let i = 2; i < s.points.length; i++) segment(s.points[i - 2]!, s.points[i - 1]!, s.points[i]!, s.colour)
      }
    }
    const down = (e: PointerEvent): void => {
      canvas.setPointerCapture(e.pointerId)
      points = [at(e)]
      strokes.current.push({ colour: inkRef.current, points })
      dot(points[0]!, inkRef.current)
      setDrawn(true)
    }
    const move = (e: PointerEvent): void => {
      if (points.length === 0) return
      const p = at(e)
      const last = points[points.length - 1]!
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return
      points.push(p)
      if (points.length < 3) return
      const [a, b, c] = points.slice(-3) as Array<[number, number]>
      segment(a!, b!, c!, inkRef.current)
    }
    const up = (): void => {
      points = []
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [tab])
  const inkRef = useRef(ink)
  inkRef.current = ink
  /** The strokes drawn on the pad, each in the ink it was drawn with, so the last can be taken back. */
  const strokes = useRef<Array<{ colour: string; points: Array<[number, number]> }>>([])
  const redraw = useRef<() => void>(() => {})

  const clearPad = (): void => {
    const canvas = pad.current
    if (!canvas) return
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    strokes.current = []
    setDrawn(false)
  }

  /** Takes back the last stroke (the Undo link, or Ctrl+Z while drawing), as Acrobat's pad does. */
  const undoStroke = (): void => {
    if (!strokes.current.length) return
    strokes.current.pop()
    redraw.current()
    setDrawn(strokes.current.length > 0)
  }

  useEffect(() => {
    if (tab !== 'draw') return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !(e.target as HTMLElement | null)?.closest('input, textarea')) {
        e.preventDefault()
        undoStroke()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab])

  const typedCanvas = (): HTMLCanvasElement => {
    const css = FACES.find((f) => f.id === face)!.css
    const canvas = document.createElement('canvas')
    const size = 120
    const ctx = canvas.getContext('2d')!
    ctx.font = `${size}px ${css}`
    const width = Math.ceil(ctx.measureText(typed).width) + size
    canvas.width = Math.min(8000, width)
    canvas.height = Math.round(size * 1.8)
    const c = canvas.getContext('2d')!
    c.font = `${size}px ${css}`
    c.fillStyle = ink
    c.textBaseline = 'middle'
    c.direction = /[֐-ࣿ]/.test(typed) ? 'rtl' : 'ltr'
    c.textAlign = 'center'
    c.fillText(typed, canvas.width / 2, canvas.height / 2)
    return canvas
  }

  const finish = async (): Promise<void> => {
    if (tab === 'image') {
      const [path] = await window.api.pickImages()
      if (!path) return
      const info = await window.api.pictureInfo(path)
      if (!info) {
        toast('error', t('pictureUnreadable'))
        return
      }
      place({ source: { path }, width: info.width, height: info.height, preview: info.preview, signature: true })
      return
    }
    const canvas = tab === 'draw' ? pad.current : typedCanvas()
    const result = canvas ? trimmed(canvas) : null
    if (!result) return
    if (keep) {
      const entry: SavedSignature = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, data: result.data, width: result.width, height: result.height }
      await changeSettings({ signatures: [entry, ...saved].slice(0, MAX_SAVED) })
    }
    place({ source: { data: result.data }, width: result.width, height: result.height, preview: result.url, signature: true })
  }

  const ready = tab === 'image' || (tab === 'draw' ? drawn : typed.trim().length > 0)

  return (
    <Modal title={t('signature')} onClose={close} width={620}>
      {saved.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-muted">{t('savedSignatures')}</span>
          <div className="flex flex-wrap gap-2">
            {saved.map((s) => (
              <div key={s.id} className="group relative">
                <button type="button" onClick={() => useSaved(s)} title={t('useSignature')} className="flex h-16 w-40 items-center justify-center rounded-lg border border-line bg-white p-2 hover:border-accent">
                  <img src={`data:image/png;base64,${s.data}`} alt={t('signature')} className="max-h-full max-w-full" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  title={t('delete')}
                  aria-label={t('delete')}
                  className="absolute -end-2 -top-2 hidden rounded-full border border-line bg-surface p-1 text-muted shadow group-hover:block hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'draw', label: t('signDraw') },
          { value: 'type', label: t('signType') },
          { value: 'image', label: t('signImage') }
        ]}
      />

      {tab !== 'image' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">{t('ink')}</span>
          {INKS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setInk(c)}
              className={clsx('h-6 w-6 rounded-full border-2', ink === c ? 'border-accent' : 'border-transparent')}
              style={{ background: c }}
            />
          ))}
        </div>
      )}

      {tab === 'draw' && (
        <div className="flex flex-col gap-1.5">
          <canvas ref={pad} className="h-[180px] w-full touch-none rounded-lg border border-dashed border-line bg-white" style={{ cursor: 'crosshair' }} aria-label={t('signDrawHint')} />
          <div className="flex items-center justify-between text-[12px] text-muted">
            <span>{t('signDrawHint')}</span>
            <span className="flex gap-3">
              <button type="button" className="text-accent hover:underline disabled:text-muted disabled:no-underline" disabled={!drawn} onClick={undoStroke} title="Ctrl+Z">
                {t('undo')}
              </button>
              <button type="button" className="text-accent hover:underline" onClick={clearPad}>
                {t('clear')}
              </button>
            </span>
          </div>
        </div>
      )}

      {tab === 'type' && (
        <div className="flex flex-col gap-2">
          <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('signTypeHint')} dir="auto" autoFocus />
          <div className="flex flex-col gap-1.5">
            {FACES.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFace(f.id)}
                className={clsx('h-16 truncate rounded-lg border bg-white px-3 text-start text-[34px] leading-none', face === f.id ? 'border-accent ring-2 ring-accent-soft' : 'border-line')}
                style={{ fontFamily: f.css, color: ink }}
                dir="auto"
              >
                {typed || t('signTypeSample')}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'image' && (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-4 text-[13px] text-muted">
          <ImagePlus size={22} className="shrink-0" />
          <span>{t('signImageHint')}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        {tab !== 'image' ? <Check checked={keep} onChange={setKeep} label={t('saveSignature')} /> : <span />}
        <div className="flex gap-2">
          <Button onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void finish()}>
            {tab === 'image' ? t('chooseImage') : t('placeSignature')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

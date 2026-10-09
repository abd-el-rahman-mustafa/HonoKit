import clsx from 'clsx'
import { Check, ImageUp, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PictureInfo } from '@shared/ipc'
import { apply, updateView, useT, type DocView, type Placing } from '../store'
import { follow, keepOnPage, px, snap, typing, type Box, type Guide } from './editGeometry'

/**
 * Pictures in Edit mode, as in Acrobat's "Edit text & images": every picture has an outline;
 * click one to select it, drag it to move it, drag a corner to resize it (proportions kept;
 * Shift frees them), and Replace or Delete it from its toolbar. Each change is one step
 * that Undo takes back. A picture covering most of the page (a scan, a background) is not
 * offered, so clicks there still add text; Erase removes it if needed.
 */

/** A picture covering more than this share of the page is a background, not offered for editing. */
export const BACKGROUND_SHARE = 0.55

/** Shows the picture's pixels, taken from the rendered page, stretched into `to`. */
export function cropStyle(src: string, from: Box, to: Box, scale: number, page: { width: number; height: number }): React.CSSProperties {
  const kx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0])
  const ky = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1])
  return {
    ...px(to, scale),
    backgroundImage: `url("${src}")`,
    backgroundSize: `${page.width * scale * kx}px ${page.height * scale * ky}px`,
    backgroundPosition: `${-from[0] * scale * kx}px ${-from[1] * scale * ky}px`,
    backgroundRepeat: 'no-repeat'
  }
}

export interface PictureMotion {
  pic: PictureInfo
  to: Box
}

/** The dashed outline of an unselected picture; press to select, drag to move. */
export function PictureOutline({ pic, scale, onPress, onMenu }: { pic: PictureInfo; scale: number; onPress: (e: React.MouseEvent) => void; onMenu?: (e: React.MouseEvent) => void }) {
  const t = useT()
  return (
    <button
      type="button"
      title={t('pictureHint')}
      aria-label={t('picture')}
      data-picture=""
      className="absolute cursor-move outline-1 -outline-offset-1 outline-accent/40 outline-dashed hover:bg-accent/5 hover:outline-solid hover:outline-accent"
      style={px(pic.box, scale)}
      onMouseDown={onPress}
      onContextMenu={onMenu}
    />
  )
}

/** Moving, or resizing, a picture: its pixels follow the mouse; the old place is shown faded. */
export function PictureMotionPreview({ motion, scale, src, page }: { motion: PictureMotion; scale: number; src: string | null; page: { width: number; height: number } }) {
  return (
    <>
      <div className="pointer-events-none absolute bg-[rgb(255_255_255/0.7)]" style={px(motion.pic.box, scale)} />
      <div
        className="pointer-events-none absolute outline-2 outline-accent outline-dashed"
        style={src ? cropStyle(src, motion.pic.box, motion.to, scale, page) : px(motion.to, scale)}
      />
    </>
  )
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** A selected picture: corner handles and a toolbar. */
export function SelectedPicture({
  view,
  page,
  scale,
  pic,
  others,
  pageSrc,
  onMoved,
  onClose,
  setGuides
}: {
  view: DocView
  page: number
  scale: number
  pic: PictureInfo
  others: Box[]
  pageSrc: () => string | null
  onMoved: (to: Box | null) => void
  onClose: () => void
  setGuides: (g: Guide[]) => void
}) {
  const t = useT()
  const [motion, setMotion] = useState<PictureMotion | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const pageSize = view.info.pages[page]!

  const remove = (): void => {
    onClose()
    void apply(view.info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'delete' } }, t('deletePicture'))
  }
  const replace = async (): Promise<void> => {
    const [path] = await window.api.pickImages()
    if (!path) return
    onMoved(null)
    void apply(view.info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'replace', source: { path } } }, t('replacePicture'))
  }

  // Delete removes the selected picture; Esc lets go of it, as in every editor.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (typing()) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove()
      } else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const commit = (to: Box): void => {
    setMotion(null)
    setGuides([])
    if (to.every((v, i) => Math.abs(v - pic.box[i]!) < 0.5)) return
    onMoved(to)
    void apply(view.info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'move', rect: to } }, t('movePicture'))
  }

  const pressBody = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    setSrc(pageSrc())
    let to: Box = pic.box
    follow(
      e,
      scale,
      (dx, dy, m) => {
        const s = m.altKey ? { dx, dy, guides: [] } : snap(pic.box, dx, dy, others, pageSize, 5 / scale)
        if (m.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) s.dy = 0
          else s.dx = 0
        }
        const k = keepOnPage(pic.box, s.dx, s.dy, pageSize)
        to = [pic.box[0] + k.dx, pic.box[1] + k.dy, pic.box[2] + k.dx, pic.box[3] + k.dy]
        setGuides(s.guides)
        setMotion({ pic, to })
      },
      (dragged) => (dragged ? commit(to) : undefined)
    )
  }

  /**
   * Acrobat's eight handles: a corner resizes keeping the proportions (Shift frees them); a
   * side handle changes only the width or the height. The opposite side stays put.
   */
  const pressHandle = (e: React.MouseEvent, handle: Handle): void => {
    e.stopPropagation()
    e.preventDefault()
    setSrc(pageSrc())
    const [x0, y0, x1, y1] = pic.box
    const ratio = (y1 - y0) / Math.max(1e-6, x1 - x0)
    const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0
    const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
    const corner = sx !== 0 && sy !== 0
    let to: Box = pic.box
    follow(
      e,
      scale,
      (dx, dy, m) => {
        let w = sx ? Math.max(4, x1 - x0 + sx * dx) : x1 - x0
        let h = sy ? Math.max(4, y1 - y0 + sy * dy) : y1 - y0
        if (corner && !m.shiftKey) {
          // Proportions kept: the larger change wins.
          if (w / (x1 - x0) > h / (y1 - y0)) h = w * ratio
          else w = h / ratio
        }
        const nx = sx < 0 ? x1 - w : x0
        const ny = sy < 0 ? y1 - h : y0
        to = [nx, ny, nx + w, ny + h]
        setMotion({ pic, to })
      },
      (dragged) => (dragged ? commit(to) : undefined)
    )
  }

  const box = motion?.to ?? pic.box
  const toolbarAbove = box[1] * scale > 44
  return (
    <>
      {motion && <PictureMotionPreview motion={motion} scale={scale} src={src} page={pageSize} />}
      <div className="absolute z-10 cursor-move outline-1 outline-accent" style={px(box, scale)} onMouseDown={pressBody} data-selected-picture="">
        {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((c) => (
          <span
            key={c}
            onMouseDown={(e) => pressHandle(e, c)}
            data-handle={c}
            className={clsx(
              'absolute h-2.5 w-2.5 rounded-full border-[1.5px] border-accent bg-surface shadow-sm',
              c.includes('n') && '-top-[5px]',
              c.includes('s') && '-bottom-[5px]',
              c.includes('w') && '-left-[5px]',
              c.includes('e') && '-right-[5px]',
              (c === 'n' || c === 's') && 'left-1/2 -translate-x-1/2 cursor-ns-resize',
              (c === 'e' || c === 'w') && 'top-1/2 -translate-y-1/2 cursor-ew-resize',
              (c === 'nw' || c === 'se') && 'cursor-nwse-resize',
              (c === 'ne' || c === 'sw') && 'cursor-nesw-resize'
            )}
          />
        ))}
        {!motion && (
          <div
            className={clsx('absolute flex cursor-default items-center gap-0.5 rounded-lg border border-line bg-surface p-1 text-ink shadow-lg', toolbarAbove ? 'bottom-full mb-2' : 'top-full mt-2')}
            dir="ltr"
            style={{ left: 0 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <MiniButton label={t('done')} onClick={onClose} className="bg-accent text-accent-ink hover:brightness-110">
              <Check size={15} />
            </MiniButton>
            <MiniButton label={t('replacePicture')} onClick={() => void replace()}>
              <ImageUp size={15} />
            </MiniButton>
            <MiniButton label={`${t('delete')} (Del)`} onClick={remove}>
              <Trash2 size={15} />
            </MiniButton>
            <span className="px-1 text-[11px] whitespace-nowrap text-muted">{t('resizeHint')}</span>
          </div>
        )}
      </div>
    </>
  )
}

export function MiniButton({ label, onClick, active, className, children }: { label: string; onClick: () => void; active?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('flex h-7 min-w-7 items-center justify-center rounded px-1', active ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2', className)}
    >
      {children}
    </button>
  )
}

/** Default size of a placed picture, in points: its size at 96 dpi, or a signature's usual width, kept on the page. */
export function defaultSize(placing: Placing, page: { width: number; height: number }): { w: number; h: number } {
  const ratio = placing.height / Math.max(1, placing.width)
  let w = placing.signature ? Math.min(160, page.width * 0.35) : Math.min(placing.width * 0.75, page.width * 0.6)
  let h = w * ratio
  if (h > page.height * 0.6) {
    h = page.height * 0.6
    w = h / ratio
  }
  return { w, h }
}

/**
 * Placing a picture or signature: it follows the pointer; a click puts it there at its
 * default size, a drag draws the size (proportions kept). Esc cancels.
 */
export function PlacementLayer({ view, page, scale, placing, onPlaced }: { view: DocView; page: number; scale: number; placing: Placing; onPlaced: (box: Box) => void }) {
  const t = useT()
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const pageSize = view.info.pages[page]!
  const { w, h } = defaultSize(placing, pageSize)
  const ratio = placing.height / Math.max(1, placing.width)

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') updateView(view.info.id, { placing: null })
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [view.info.id])

  const at = (e: React.MouseEvent): { x: number; y: number } => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const clamp = (b: Box): Box => {
    const bw = Math.min(b[2] - b[0], pageSize.width)
    const bh = Math.min(b[3] - b[1], pageSize.height)
    const x = Math.min(Math.max(0, b[0]), pageSize.width - bw)
    const y = Math.min(Math.max(0, b[1]), pageSize.height - bh)
    return [x, y, x + bw, y + bh]
  }
  const dragged = (d: NonNullable<typeof drag>): Box | null => {
    const dw = Math.abs(d.x1 - d.x0)
    if (dw * scale < 8) return null
    const dh = dw * ratio
    const x = d.x1 >= d.x0 ? d.x0 : d.x0 - dw
    const y = d.y1 >= d.y0 ? d.y0 : d.y0 - dh
    return [x, y, x + dw, y + dh]
  }
  const shown: Box | null = drag ? (dragged(drag) ?? null) : hover ? clamp([hover.x - w / 2, hover.y - h / 2, hover.x + w / 2, hover.y + h / 2]) : null

  return (
    <div
      className="absolute inset-0 z-30 cursor-copy"
      data-placing=""
      onMouseMove={(e) => {
        const p = at(e)
        setHover(p)
        if (drag) setDrag({ ...drag, x1: p.x, y1: p.y })
      }}
      onMouseLeave={() => setHover(null)}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const p = at(e)
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onMouseUp={(e) => {
        if (!drag) return
        const p = at(e)
        const d = { ...drag, x1: p.x, y1: p.y }
        setDrag(null)
        const rect = clamp(dragged(d) ?? [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2])
        updateView(view.info.id, { placing: null })
        onPlaced(rect)
        void apply(view.info.id, { op: 'addPicture', page, rect, source: placing.source }, placing.signature ? t('addSignature') : t('addPicture'))
      }}
    >
      {shown && <img src={placing.preview} alt="" className="pointer-events-none absolute opacity-80 outline-1 outline-accent outline-dashed" style={px(shown, scale)} draggable={false} />}
    </div>
  )
}

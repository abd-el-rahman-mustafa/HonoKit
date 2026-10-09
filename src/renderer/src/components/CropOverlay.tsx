import clsx from 'clsx'
import { updateView, useT, type DocView } from '../store'
import { follow } from './editGeometry'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

/**
 * Crop on the page, as Acrobat's crop tool: the kept area is a box on the page in view —
 * drag inside it to move it, drag a handle to resize it; what will be cut away is dimmed.
 * It shares its margins with the Crop panel's number fields (points in the store).
 */
export function CropOverlay({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const t = useT()
  const crop = view.crop!
  const size = view.info.pages[page]!
  const box = { x0: crop.left, y0: crop.top, x1: size.width - crop.right, y1: size.height - crop.bottom }
  const MIN = 36

  const press = (e: React.MouseEvent, handle: Handle): void => {
    e.preventDefault()
    e.stopPropagation()
    const start = { ...box }
    follow(
      e,
      scale,
      (dx, dy) => {
        let { x0, y0, x1, y1 } = start
        if (handle === 'move') {
          const w = x1 - x0
          const h = y1 - y0
          x0 = Math.min(Math.max(0, x0 + dx), size.width - w)
          y0 = Math.min(Math.max(0, y0 + dy), size.height - h)
          x1 = x0 + w
          y1 = y0 + h
        } else {
          if (handle.includes('w')) x0 = Math.min(Math.max(0, x0 + dx), x1 - MIN)
          if (handle.includes('e')) x1 = Math.max(Math.min(size.width, x1 + dx), x0 + MIN)
          if (handle.includes('n')) y0 = Math.min(Math.max(0, y0 + dy), y1 - MIN)
          if (handle.includes('s')) y1 = Math.max(Math.min(size.height, y1 + dy), y0 + MIN)
        }
        updateView(view.info.id, { crop: { left: x0, top: y0, right: size.width - x1, bottom: size.height - y1 } })
      },
      () => undefined
    )
  }

  const px = (v: number): number => v * scale
  return (
    <div className="absolute inset-0 z-20 overflow-hidden" data-crop-overlay="">
      <div
        className="absolute cursor-move border-2 border-dashed border-white outline-2 outline-accent shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]"
        style={{ left: px(box.x0), top: px(box.y0), width: px(box.x1 - box.x0), height: px(box.y1 - box.y0) }}
        onMouseDown={(e) => press(e, 'move')}
        title={t('crop.dragHint')}
      >
        {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => (
          <span
            key={h}
            onMouseDown={(e) => press(e, h)}
            className={clsx(
              'absolute h-3 w-3 rounded-full border-2 border-accent bg-white shadow',
              h.includes('n') && '-top-[7px]',
              h.includes('s') && '-bottom-[7px]',
              h.includes('w') && '-left-[7px]',
              h.includes('e') && '-right-[7px]',
              (h === 'n' || h === 's') && 'left-1/2 -translate-x-1/2 cursor-ns-resize',
              (h === 'e' || h === 'w') && 'top-1/2 -translate-y-1/2 cursor-ew-resize',
              (h === 'nw' || h === 'se') && 'cursor-nwse-resize',
              (h === 'ne' || h === 'sw') && 'cursor-nesw-resize'
            )}
          />
        ))}
        <span className="pointer-events-none absolute start-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white tabular-nums" dir="ltr">
          {Math.round(((box.x1 - box.x0) * 25.4) / 72)} × {Math.round(((box.y1 - box.y0) * 25.4) / 72)} mm
        </span>
      </div>
    </div>
  )
}

import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { apply, useStore, useT, type DocView } from '../store'
import { follow, px, type Box } from './editGeometry'
import { MiniButton } from './PictureEdit'

type Point = [number, number]

/**
 * Marking on the page while Redact is open: drag across text (it snaps to the words, as a
 * selection does) or drag a box; double-click a picture to mark all of it. The marks show as
 * red outlines with a light red fill; click one to remove it.
 */
export function RedactLayer({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const author = useStore((s) => s.settings?.authorName ?? '')
  const [drag, setDrag] = useState<Box | null>(null)
  const [preview, setPreview] = useState<Box[]>([])
  const [chosen, setChosen] = useState<Box | null>(null)
  const redact = view.redact!
  const id = view.info.id
  const mine = redact.marks.filter((m) => m.page === page)

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = layer.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }
  const mark = (boxes: Box[]): void => {
    if (boxes.length) void apply(id, { op: 'redactMark', author: author || undefined, marks: boxes.map((box) => ({ page, box })) }, t('redact.marking'))
  }

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = at(e)
    const hit = mine.find((m) => start[0] >= m.box[0] && start[0] <= m.box[2] && start[1] >= m.box[1] && start[1] <= m.box[3])
    if (e.detail >= 2) {
      // Double-click: the whole picture under the pointer.
      void window.api.pagePictures(id, page).then((r) => {
        if (!r.ok) return
        const pic = r.value.filter((p) => start[0] >= p.box[0] && start[0] <= p.box[2] && start[1] >= p.box[1] && start[1] <= p.box[3]).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0]
        if (pic) mark([pic.box])
      })
      return
    }
    let end = start
    let seq = 0
    follow(
      e,
      scale,
      (dx, dy) => {
        end = [start[0] + dx, start[1] + dy]
        if (redact.by === 'area') setDrag([Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])])
        else {
          const n = ++seq
          void window.api.selectText(id, page, start, end, 'char').then((r) => {
            if (n === seq && r.ok) setPreview(r.value?.boxes ?? [])
          })
        }
      },
      (dragged) => {
        setDrag(null)
        if (!dragged) {
          setPreview([])
          setChosen(hit?.box ?? null)
          return
        }
        setChosen(null)
        if (redact.by === 'area') {
          const box: Box = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]
          if (box[2] - box[0] > 2 && box[3] - box[1] > 2) mark([box])
        } else {
          void window.api.selectText(id, page, start, end, 'char').then((r) => {
            setPreview([])
            if (r.ok && r.value) mark(r.value.boxes)
          })
        }
      }
    )
  }

  return (
    <div ref={layer} className={redact.by === 'area' ? 'absolute inset-0 cursor-crosshair' : 'absolute inset-0 cursor-text'} onMouseDown={onDown} data-redact-layer="">
      {mine.map((m, i) => (
        <div key={i} className="pointer-events-none absolute border-2 border-red-600 bg-red-600/15" style={px(m.box, scale)} />
      ))}
      {preview.map((b, i) => (
        <div key={`p${i}`} className="pointer-events-none absolute bg-red-600/25" style={px(b, scale)} />
      ))}
      {drag && <div className="pointer-events-none absolute border-2 border-dashed border-red-600 bg-red-600/10" style={px(drag, scale)} />}
      {chosen && (
        <div className="absolute z-10 outline-2 outline-offset-2 outline-red-600 outline-dashed" style={px(chosen, scale)}>
          <div className="absolute bottom-full mb-2 flex rounded-lg border border-line bg-surface p-1 shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
            <MiniButton
              label={t('redact.unmark')}
              onClick={() => {
                setChosen(null)
                void apply(id, { op: 'redactUnmark', page, box: chosen }, t('redact.unmark'))
              }}
            >
              <Trash2 size={15} />
            </MiniButton>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { FormFieldInfo } from '@shared/ipc'
import { apply, useT, type DocView } from '../store'
import { follow, px, type Box } from './editGeometry'
import type { Key } from '../i18n'

type Point = [number, number]

/**
 * The page while Prepare a form is open: every field outlined in blue with its name (as in
 * Acrobat's editing mode); drag a box to add a field of the chosen kind, or click for one of
 * the usual size.
 */
export function FieldLayer({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const [fields, setFields] = useState<FormFieldInfo[]>([])
  const [drag, setDrag] = useState<Box | null>(null)
  const prepare = view.prepare!
  const id = view.info.id
  useEffect(() => void window.api.formFields(id, page).then((r) => r.ok && setFields(r.value)), [id, page, view.info.revision])

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = layer.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }
  const add = (box: Box): void => {
    const count = fields.filter((f) => f.name.startsWith(t(`prepare.kind.${prepare.kind}` as Key))).length
    const options = prepare.kind === 'dropdown' ? prepare.options.split(/\r?\n/).map((o) => o.trim()).filter(Boolean) : undefined
    void apply(id, { op: 'addFields', fields: [{ page, box, kind: prepare.kind, name: `${t(`prepare.kind.${prepare.kind}` as Key)} ${count + 1}`, ...(options ? { options } : {}) }] }, t('prepare.add'))
  }
  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = at(e)
    let end = start
    follow(
      e,
      scale,
      (dx, dy) => {
        end = [start[0] + dx, start[1] + dy]
        setDrag([Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])])
      },
      (dragged) => {
        setDrag(null)
        const size = view.info.pages[page]!
        if (dragged) {
          const box: Box = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]
          if (box[2] - box[0] > 6 && box[3] - box[1] > 6) add(box)
          return
        }
        // A click: the usual size for the kind, starting at the point (kept on the page).
        const [w, h] = { text: [180, 22], multiline: [240, 70], checkbox: [14, 14], dropdown: [150, 22], signature: [200, 60] }[prepare.kind] as [number, number]
        const x = Math.min(Math.max(0, start[0]), size.width - w)
        const y = Math.min(Math.max(0, start[1] - h / 2), size.height - h)
        add([x, y, x + w, y + h])
      }
    )
  }
  return (
    <div ref={layer} className="absolute inset-0 z-10 cursor-crosshair" onMouseDown={onDown} data-field-layer="">
      {fields.map((f) => (
        <div key={f.index} className="pointer-events-none absolute border border-[#1473e6] bg-[rgb(20_115_230/0.1)]" style={px(f.box, scale)}>
          <span className="absolute -top-4 start-0 max-w-[220px] truncate rounded-sm bg-[#1473e6] px-1 text-[10px] leading-4 text-white" dir="auto">
            {f.name}
          </span>
        </div>
      ))}
      {drag && <div className="pointer-events-none absolute border-2 border-dashed border-[#1473e6] bg-[rgb(20_115_230/0.08)]" style={px(drag, scale)} />}
    </div>
  )
}

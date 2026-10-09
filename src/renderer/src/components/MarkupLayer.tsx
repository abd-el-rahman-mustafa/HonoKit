import clsx from 'clsx'
import { MessageSquareText, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MarkupInfo, TextLineInfo } from '@shared/ipc'
import type { OpInput } from '@shared/ops'
import { smoothStroke } from '@shared/smooth'
import { apply, updateView, useStore, useT, type DocView } from '../store'
import { area, dragMove, follow, inside, px, typing, type Box, type Guide } from './editGeometry'
import { MiniButton } from './PictureEdit'

/**
 * Markup in Edit mode, as Acrobat's and Foxit's comment tools: highlight (or underline, or
 * strike through) by dragging over text, draw with the pen, drag out a rectangle, ellipse,
 * line or arrow. Shift keeps shapes square and lines at 45°. A click (no drag) on existing
 * markup selects it: drag it to move it (shapes and pen), Delete removes it.
 * Everything is saved as standard PDF annotations (docs/decisions.md §30).
 */

type Point = [number, number]
type MarkupSpec = Extract<OpInput, { op: 'markup' }>['markup']

/** A comment or text being written: a new note, text box or callout, or the text of existing markup. */
interface Draft {
  at: Point
  text: string
  /** Existing markup whose text is being changed. */
  note?: MarkupInfo
  /** New markup made from the text once it is posted. */
  make?: (text: string) => MarkupSpec
  title?: string
}

/** Markup whose text can be changed after it was placed. */
const WRITTEN = new Set(['note', 'stamp', 'textbox', 'callout'])

/** A light tint of a colour, for filled shapes, so what is under them stays readable. */
function tint(hex: string, amount = 0.78): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number): number => Math.round(c + (255 - c) * amount)
  return `#${[mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Shift: a square box, or a line at a multiple of 45°. */
function constrain(a: Point, b: Point, line: boolean): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (line) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const len = Math.hypot(dx, dy)
    return [a[0] + Math.cos(angle) * len, a[1] + Math.sin(angle) * len]
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return [a[0] + Math.sign(dx || 1) * s, a[1] + Math.sign(dy || 1) * s]
}

/** The text lines a highlight from `a` to `b` would cover, roughly, for the preview. */
function highlightPreview(all: TextLineInfo[], a: Point, b: Point): Box[] {
  // Horizontal lines only (a diagonal watermark's box would cover the page), and a point
  // just between two lines belongs to the nearer one — as the engine decides (markup.ts).
  const lines = all.filter((l) => l.box[3] - l.box[1] < 72)
  const snapY = (p: Point): number => {
    let best: { d: number; y: number } | null = null
    for (const { box: l } of lines) {
      if (p[0] < l[0] - 12 || p[0] > l[2] + 12) continue
      const d = p[1] < l[1] ? l[1] - p[1] : p[1] > l[3] ? p[1] - l[3] : 0
      if (d <= (l[3] - l[1]) * 0.75 && (!best || d < best.d)) best = { d, y: (l[1] + l[3]) / 2 }
    }
    return best ? best.y : p[1]
  }
  const top = Math.min(snapY(a), snapY(b))
  const bottom = Math.max(snapY(a), snapY(b))
  const hit = lines.filter((l) => l.box[3] >= top && l.box[1] <= bottom)
  if (hit.length === 0) return []
  if (hit.length === 1) {
    const l = hit[0]!.box
    return [[Math.max(l[0], Math.min(a[0], b[0])), l[1], Math.min(l[2], Math.max(a[0], b[0])), l[3]]]
  }
  return hit.map((l) => l.box)
}

export function MarkupLayer({ view, page, scale, visible }: { view: DocView; page: number; scale: number; visible: boolean }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const { info, editTool, markStyle } = view
  const [marks, setMarks] = useState<MarkupInfo[]>([])
  const [lines, setLines] = useState<TextLineInfo[]>([])
  const selected = view.markSel?.page === page ? (marks.find((m) => m.index === view.markSel!.index) ?? null) : null
  const setSelected = (m: MarkupInfo | null): void => updateView(info.id, { markSel: m ? { page, index: m.index } : null })
  /** A comment being written: a new sticky note at a point, or an existing note's text. */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const author = useStore((s) => s.settings?.authorName ?? '')
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [points, setPoints] = useState<Point[] | null>(null)
  const [shift, setShift] = useState(false)
  const [moving, setMoving] = useState<{ dx: number; dy: number } | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])

  useEffect(() => {
    setDraft(null)
    if (!visible) return
    let cancelled = false
    void window.api.pageMarkups(info.id, page).then((r) => {
      if (!cancelled && r.ok) setMarks(r.value)
    })
    if (editTool === 'highlight')
      void window.api.pageText(info.id, page).then((r) => {
        if (!cancelled && r.ok) setLines(r.value)
      })
    return () => {
      cancelled = true
    }
  }, [visible, editTool, info.id, info.revision, page])

  const remove = (m: MarkupInfo): void => {
    setSelected(null)
    void apply(info.id, { op: 'changeMarkup', page, index: m.index, box: m.box, change: { kind: 'delete' } }, t('deleteMarkup'))
  }

  useEffect(() => {
    if (!selected || draft) return
    const key = (e: KeyboardEvent): void => {
      if (typing()) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove(selected)
      } else if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = layer.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }

  const create = (pts: Point[], constrained: boolean): void => {
    const a = pts[0]!
    let b = pts[pts.length - 1]!
    const colour = markStyle.colour
    const width = markStyle.width
    let markup: Extract<OpInput, { op: 'markup' }>['markup'] | null = null
    if (editTool === 'highlight') {
      const kind = markStyle.textMark
      markup = { kind, from: a, to: b, colour: kind === 'highlight' ? markStyle.highlight : colour }
    } else if (editTool === 'pen') {
      markup = { kind: 'ink', strokes: [pts], colour, width }
    } else if (editTool === 'shape') {
      const shape = markStyle.shape
      const line = shape === 'line' || shape === 'arrow'
      if (constrained) b = constrain(a, b, line)
      if (line) markup = { kind: shape, from: a, to: b, colour, width }
      else {
        const rect: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
        if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return
        markup = { kind: shape, rect, colour, width, fill: markStyle.fill ? tint(colour) : null }
      }
    }
    if (markup) void apply(info.id, { op: 'markup', page, markup }, t('addMarkup'))
  }

  const post = (): void => {
    if (!draft) return
    const text = draft.text.trim()
    setDraft(null)
    if (draft.note) {
      if (text !== draft.note.text && (text || draft.note.kind === 'note')) void apply(info.id, { op: 'changeMarkup', page, index: draft.note.index, box: draft.note.box, change: { kind: 'revise', text } }, t('editComment'))
    } else if (text && draft.make) void apply(info.id, { op: 'markup', page, markup: draft.make(text) }, draft.title ?? t('addMarkup'))
    else if (text) void apply(info.id, { op: 'markup', page, markup: { kind: 'note', at: draft.at, text, colour: markStyle.note } }, t('addComment'))
  }

  const recolour = (m: MarkupInfo, colour: string): void =>
    void apply(info.id, { op: 'changeMarkup', page, index: m.index, box: m.box, change: { kind: 'revise', colour } }, t('changeColour'))

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = at(e)
    // A press on the selected shape moves it.
    if (selected?.movable && inside(selected.box, { x: start[0], y: start[1] }, 3 / scale)) {
      let last = { dx: 0, dy: 0 }
      // It lines up with the other markup and the page centre, and stays on the page (as paragraphs and pictures do).
      const others = marks.filter((k) => k.kind !== 'other' && k.index !== selected.index).map((k) => k.box)
      follow(
        e,
        scale,
        (dx, dy, m) => {
          const s = dragMove(selected.box, dx, dy, others, info.pages[page]!, 5 / scale, { alt: m.altKey, shift: m.shiftKey })
          last = { dx: s.dx, dy: s.dy }
          setGuides(s.guides)
          setMoving(last)
        },
        (dragged) => {
          setMoving(null)
          setGuides([])
          if (!dragged) return
          if (Math.abs(last.dx) < 0.25 && Math.abs(last.dy) < 0.25) return
          const m = selected
          setSelected(null)
          void apply(info.id, { op: 'changeMarkup', page, index: m.index, box: m.box, change: { kind: 'move', dx: last.dx, dy: last.dy } }, t('moveMarkup'))
        }
      )
      return
    }
    const pts: Point[] = [start]
    setPoints(pts)
    const minStep = 1.5 / scale
    const move = (m: MouseEvent): void => {
      const p = at(m)
      const last = pts[pts.length - 1]!
      if (editTool === 'pen') {
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < minStep) return
        pts.push(p)
      } else pts[1] = p
      setShift(m.shiftKey)
      setPoints([...pts])
    }
    const up = (m: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setPoints(null)
      const end = at(m)
      const moved = Math.hypot(end[0] - start[0], end[1] - start[1]) * scale
      if (moved < 4 && pts.length < 3) {
        // A click: select the markup under it (the smallest, if several), or let go.
        const p = { x: end[0], y: end[1] }
        const hits = marks.filter((k) => k.kind !== 'other' && inside(k.box, p, 3 / scale)).sort((x, y) => area(x.box) - area(y.box))
        // With the comment tool, a click on empty page starts a sticky note there (Acrobat's "Add a comment").
        if (!hits[0] && editTool === 'note' && !selected) {
          setDraft({ at: [end[0] - 10, end[1] - 10], text: '' })
          return
        }
        if (!hits[0] && editTool === 'stamp' && !selected) {
          placeStamp(end)
          return
        }
        if (!hits[0] && !selected && (editTool === 'textbox' || editTool === 'callout')) {
          // A click: a box of the usual size (a callout's box up and to the side of the point).
          if (editTool === 'textbox') startText([end[0], end[1], end[0] + 180, end[1] + 30])
          else startCallout(end, [end[0] + 40, end[1] - 70, end[0] + 220, end[1] - 40])
          return
        }
        setSelected(hits[0] ?? null)
        if (hits[0] && WRITTEN.has(hits[0].kind) && m.detail >= 2) editText(hits[0])
        return
      }
      if (editTool === 'note' || editTool === 'stamp') return
      if (editTool === 'textbox') {
        startText([Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])])
        return
      }
      if (editTool === 'callout') {
        // Pressed at the point being talked about, released where the box goes.
        startCallout(start, [end[0], end[1] - 15, end[0] + 180, end[1] + 15])
        return
      }
      setSelected(null)
      if (editTool !== 'pen') pts[1] = end
      create(pts, m.shiftKey)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const placeStamp = (p: Point): void => {
    const s = markStyle.stamp
    const date = new Date().toLocaleString(language === 'ar' ? 'ar-AE' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    const sub = s.identity ? [author, date].filter(Boolean).join(' · ') : undefined
    void apply(info.id, { op: 'markup', page, markup: { kind: 'stamp', at: p, label: s.label, ...(sub ? { sub } : {}), colour: s.colour } }, t('stamp.add'))
  }
  const startText = (rect: Box): void =>
    setDraft({ at: [rect[0], rect[1]], text: '', title: t('textbox.add'), make: (text) => ({ kind: 'textbox', rect, text, colour: markStyle.colour, size: markStyle.textSize }) })
  const startCallout = (to: Point, rect: Box): void =>
    setDraft({ at: [rect[0], rect[1]], text: '', title: t('callout.add'), make: (text) => ({ kind: 'callout', rect, to, text, colour: markStyle.colour, size: markStyle.textSize }) })
  const editText = (m: MarkupInfo): void => setDraft({ at: [m.box[0], m.box[1]], text: m.kind === 'stamp' ? m.text.split(' — ')[0]! : m.text, note: m, title: m.kind === 'note' ? t('editComment') : t('editText') })

  const size = info.pages[page]!
  const preview = points && points.length > 1 ? points : null
  let shapePreview: React.ReactNode = null
  if (preview) {
    const a = preview[0]!
    const colour = markStyle.colour
    const w = markStyle.width
    // The curve the stroke will be stored as (§82).
    if (editTool === 'pen') shapePreview = <polyline points={smoothStroke(preview).map((p) => p.join(',')).join(' ')} fill="none" stroke={colour} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
    else if (editTool === 'shape') {
      const line = markStyle.shape === 'line' || markStyle.shape === 'arrow'
      const b = shift ? constrain(a, preview[1]!, line) : preview[1]!
      if (line)
        shapePreview = <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={colour} strokeWidth={w} markerEnd={markStyle.shape === 'arrow' ? `url(#arrow-${page})` : undefined} />
      else {
        const x = Math.min(a[0], b[0])
        const y = Math.min(a[1], b[1])
        const rw = Math.abs(b[0] - a[0])
        const rh = Math.abs(b[1] - a[1])
        const fill = markStyle.fill ? tint(colour) : 'none'
        shapePreview =
          markStyle.shape === 'rect' ? (
            <rect x={x} y={y} width={rw} height={rh} fill={fill} stroke={colour} strokeWidth={w} />
          ) : (
            <ellipse cx={x + rw / 2} cy={y + rh / 2} rx={rw / 2} ry={rh / 2} fill={fill} stroke={colour} strokeWidth={w} />
          )
      }
    } else if (editTool === 'textbox' || editTool === 'callout') {
      const b = preview[1]!
      shapePreview =
        editTool === 'textbox' ? (
          <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} fill="white" fillOpacity={0.6} stroke={markStyle.colour} strokeDasharray="4 3" />
        ) : (
          <>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={markStyle.colour} markerStart={`url(#arrow-${page})`} />
            <rect x={b[0]} y={b[1] - 15} width={180} height={30} fill="white" fillOpacity={0.6} stroke={markStyle.colour} strokeDasharray="4 3" />
          </>
        )
    } else if (editTool === 'highlight') {
      const kind = markStyle.textMark
      shapePreview = highlightPreview(lines, a, preview[1]!).map((b, i) =>
        kind === 'highlight' ? (
          <rect key={i} x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} fill={markStyle.highlight} opacity={0.45} />
        ) : (
          <line key={i} x1={b[0]} x2={b[2]} y1={kind === 'underline' ? b[3] - 0.5 : (b[1] + b[3]) / 2} y2={kind === 'underline' ? b[3] - 0.5 : (b[1] + b[3]) / 2} stroke={markStyle.colour} strokeWidth={1.2} />
        )
      )
    }
  }

  const cursor = editTool === 'highlight' ? 'cursor-text' : editTool === 'note' || editTool === 'stamp' ? 'cursor-copy' : 'cursor-crosshair'
  return (
    <div
      ref={layer}
      className={clsx('absolute inset-0', cursor)}
      onMouseDown={onDown}
      onMouseMove={editTool === 'stamp' ? (e) => setHover(at(e)) : undefined}
      onMouseLeave={() => setHover(null)}
      data-markup-layer=""
    >
      {editTool === 'stamp' && hover && !selected && <StampGhost at={hover} scale={scale} label={markStyle.stamp.label} colour={markStyle.stamp.colour} />}
      {marks
        .filter((m) => m.kind !== 'other')
        .map((m) => (
          <div key={`${m.index}-${m.box.join(',')}`} className="pointer-events-none absolute rounded-[2px] outline-1 outline-[rgb(225_29_72/0.3)] outline-dotted" style={px(m.box, scale)} />
        ))}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none">
        <defs>
          <marker id={`arrow-${page}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke={markStyle.colour} strokeWidth="1.5" />
          </marker>
        </defs>
        {shapePreview}
      </svg>
      {guides.map((g, i) => (
        <div
          key={i}
          className="pointer-events-none absolute bg-[#16a34a]"
          style={g.axis === 'x' ? { left: g.at * scale, top: 0, width: 1, height: '100%' } : { top: g.at * scale, left: 0, height: 1, width: '100%' }}
        />
      ))}
      {draft && <CommentEditor draft={draft} scale={scale} onChange={(text) => setDraft({ ...draft, text })} onPost={post} onCancel={() => setDraft(null)} />}
      {selected && (
        <div
          className={clsx('absolute z-10 outline-2 outline-[var(--focus)] outline-dashed', selected.movable ? 'cursor-move' : 'pointer-events-none')}
          style={px(moving ? [selected.box[0] + moving.dx, selected.box[1] + moving.dy, selected.box[2] + moving.dx, selected.box[3] + moving.dy] : selected.box, scale)}
          data-selected-markup=""
        >
          {!moving && (
            <div
              className={clsx('pointer-events-auto absolute flex cursor-default items-center gap-0.5 rounded-lg border border-line bg-surface p-1 text-ink shadow-lg', selected.box[1] * scale > 44 ? 'bottom-full mb-2' : 'top-full mt-2')}
              style={{ left: 0 }}
              dir="ltr"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {WRITTEN.has(selected.kind) && (
                <MiniButton label={selected.kind === 'note' ? t('editComment') : t('editText')} onClick={() => editText(selected)}>
                  <MessageSquareText size={15} />
                </MiniButton>
              )}
              {(selected.kind === 'highlight' ? HIGHLIGHT_COLOURS : MARK_COLOURS).map((c) => (
                <button
                  key={c}
                  type="button"
                  title={t('changeColour')}
                  aria-label={`${t('changeColour')} ${c}`}
                  onClick={() => recolour(selected, c)}
                  className={clsx('mx-0.5 h-5 w-5 rounded-full border', selected.colour.toLowerCase() === c ? 'border-ink ring-2 ring-accent' : 'border-black/10')}
                  style={{ background: c }}
                />
              ))}
              <span className="mx-0.5 h-5 w-px bg-line" />
              <MiniButton label={`${t('delete')} (Del)`} onClick={() => remove(selected)}>
                <Trash2 size={15} />
              </MiniButton>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MARK_COLOURS = ['#e11d48', '#ea580c', '#16a34a', '#1473e6', '#111827']
const HIGHLIGHT_COLOURS = ['#facc15', '#86efac', '#7dd3fc', '#f9a8d4', '#fdba74']

/**
 * Writing a comment, as Acrobat's comment card: a small box by the note with Cancel and
 * Post; Ctrl+Enter posts, Esc cancels. Nothing is added until Post.
 */
function CommentEditor({ draft, scale, onChange, onPost, onCancel }: { draft: Draft; scale: number; onChange: (text: string) => void; onPost: () => void; onCancel: () => void }) {
  const t = useT()
  return (
    <div
      className="absolute z-30 flex w-64 flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-ink shadow-xl"
      style={{ left: draft.at[0] * scale + 28, top: draft.at[1] * scale }}
      onMouseDown={(e) => e.stopPropagation()}
      data-comment-editor=""
    >
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <MessageSquareText size={14} />
        {draft.title ?? (draft.note ? t('editComment') : t('addComment'))}
      </div>
      <textarea
        autoFocus
        dir="auto"
        value={draft.text}
        placeholder={draft.make || (draft.note && draft.note.kind !== 'note') ? t('typeHere') : t('commentPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onPost()
          }
        }}
        className="min-h-20 w-full resize-y rounded-md border border-line bg-surface p-2 text-[13px] focus:border-focus focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-7 rounded-full border border-line px-3 text-[12px] hover:bg-surface-2">
          {t('cancel')}
        </button>
        <button type="button" onClick={onPost} disabled={!draft.text.trim() && !draft.note} className="h-7 rounded-full bg-accent px-3 text-[12px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-45">
          {t('post')}
        </button>
      </div>
    </div>
  )
}

/** The stamp under the pointer before it is placed, as Acrobat shows it. */
function StampGhost({ at, scale, label, colour }: { at: Point; scale: number; label: string; colour: string }) {
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-[2.5px] px-3 py-1 font-bold whitespace-nowrap opacity-70"
      style={{ left: at[0] * scale, top: at[1] * scale, color: colour, borderColor: colour, fontSize: 20 * scale, outline: `1px solid ${colour}`, outlineOffset: -5 * scale }}
      dir="auto"
    >
      {label}
    </div>
  )
}

import clsx from 'clsx'
import { BookPlus, Check, Copy, EyeOff, ImageUp, Move, SquarePen, Trash2, Type, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ParagraphInfo, PictureInfo, TextSpan } from '@shared/ipc'
import { apply, isMarkupTool, patchTextEdit, toast, updateView, useT, type DocView, type TextStyle } from '../store'
import { area, closeBoxes, follow, keepOnPage, snap, type Box, type Guide } from './editGeometry'
import { openMenu } from './ContextMenu'
import { activeEditor, fillEditor, mapText, readEditor, selectionStyle, setActiveEditor, styleSelection } from './richEdit'
import { MarkupLayer } from './MarkupLayer'
import { clearSpelling, ignoreWord, markSpelling, misspelledAt } from './spellMarks'
import { pageEntries } from './menus'
import { BACKGROUND_SHARE, PictureMotionPreview, PictureOutline, PlacementLayer, SelectedPicture, type PictureMotion } from './PictureEdit'

type Kind = TextStyle['kind']

type BoxStyle = TextStyle

/**
 * What is being edited: an existing paragraph, or a new text box — at a point (it grows as
 * you type) or drawn by dragging (fixed width, the text wraps), as in Acrobat.
 */
type Target = { mode: 'edit'; para: ParagraphInfo } | { mode: 'new'; x: number; y: number; width?: number }

const FAMILY: Record<Kind, string> = {
  serif: "'Times New Roman', Times, 'Plex Arabic', serif",
  sans: "Helvetica, Arial, 'Plex Arabic', sans-serif",
  mono: "'Courier New', Courier, monospace"
}

/**
 * The page in Edit mode, behaving like the text tool of Acrobat or Foxit:
 * every block of text has a faint outline; click one to edit it in place, click an empty
 * spot to add text; click outside the box to apply, Esc to cancel, Enter for a new line.
 * The box can be dragged to move it and its edge dragged to change the column width.
 * Coordinates from the engine are page points (top-left origin); `scale` makes CSS pixels.
 */
export function EditLayer({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [paras, setParas] = useState<ParagraphInfo[] | null>(null)
  const [pics, setPics] = useState<PictureInfo[]>([])
  const [selectedPic, setSelectedPic] = useState<PictureInfo | null>(null)
  /** Where a picture went (moved, resized, placed): selected again once the page is re-read. */
  const pendingPic = useRef<Box | null>(null)
  const [picMotion, setPicMotion] = useState<PictureMotion | null>(null)
  const [picSrc, setPicSrc] = useState<string | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const { info, editTool, placing } = view
  useEffect(() => {
    const now = view.pictureSel
    const next = selectedPic ? { page, box: selectedPic.box } : null
    if (next && (!now || now.page !== page || now.box.join() !== next.box.join())) updateView(info.id, { pictureSel: next })
    else if (!next && now?.page === page) updateView(info.id, { pictureSel: null })
  }, [selectedPic]) // eslint-disable-line react-hooks/exhaustive-deps
  const markupTool = isMarkupTool(editTool)

  useEffect(() => {
    const el = layer.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Paragraphs and pictures are read only for pages in view, and again after every change.
  useEffect(() => {
    setParas(null)
    setTarget(null)
    setSelectedPic(null)
    if (!visible || editTool !== 'text') return
    let cancelled = false
    void window.api.pageParagraphs(info.id, page).then((r) => {
      if (!cancelled && r.ok) setParas(r.value)
    })
    void window.api.pagePictures(info.id, page).then((r) => {
      if (cancelled || !r.ok) return
      setPics(r.value)
      const want = pendingPic.current
      pendingPic.current = null
      if (want) setSelectedPic(r.value.find((p) => closeBoxes(p.box, want, 2)) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [visible, editTool, info.id, info.revision, page])

  const point = (e: React.MouseEvent): { x: number; y: number } => {
    const r = layer.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const px = (b: Box): React.CSSProperties => ({ left: b[0] * scale, top: b[1] * scale, width: (b[2] - b[0]) * scale, height: (b[3] - b[1]) * scale })
  const close = useCallback(() => setTarget(null), [])
  // Text whose letters the file does not map (it would show as "����") is not opened: retyping it
  // could only lose it (decisions §58). Recognize text (OCR) gives it letters.
  const startEdit = useCallback((para: ParagraphInfo) => {
    if (para.unreadable) toast('info', t('edit.unreadable'))
    else setTarget({ mode: 'edit', para })
  }, [t])
  const [moving, setMoving] = useState<{ para: ParagraphInfo; dx: number; dy: number } | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const pageSize = info.pages[page]!
  /** The rendered page, whose pixels show a picture while it is dragged. */
  const pageSrc = (): string | null => layer.current?.parentElement?.querySelector('img')?.currentSrc || null
  const editablePics = pics.filter((p) => area(p.box) < BACKGROUND_SHARE * pageSize.width * pageSize.height)
  const blocks = (): Box[] => [...(paras ?? []).map((p) => p.box), ...editablePics.map((p) => p.box)]

  /**
   * Press on a block: a click (no movement) opens the editor; a drag moves the block, as in
   * desktop editors. The block follows the mouse as a dashed outline and moves on release.
   */
  const pressBlock = (e: React.MouseEvent, para: ParagraphInfo): void => {
    e.stopPropagation()
    if (e.button !== 0 || target) return
    e.preventDefault()
    setSelectedPic(null)
    let last = { dx: 0, dy: 0 }
    const others = blocks().filter((b) => b !== para.box)
    follow(
      e,
      scale,
      (dx, dy, m) => {
        // Shift keeps the move straight: along whichever axis it has gone further.
        if (m.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        const snapped = m.altKey ? { dx, dy, guides: [] } : snap(para.box, dx, dy, others, pageSize, 5 / scale)
        if (m.shiftKey) {
          if (dy === 0) snapped.dy = 0
          if (dx === 0) snapped.dx = 0
        }
        last = keepOnPage(para.box, snapped.dx, snapped.dy, pageSize)
        setGuides(snapped.guides)
        setMoving({ para, ...last })
      },
      (dragged) => {
        setMoving(null)
        setGuides([])
        if (!dragged) {
          startEdit(para)
          return
        }
        if (Math.abs(last.dx) < 0.5 && Math.abs(last.dy) < 0.5) return
        void apply(info.id, { op: 'replaceText', page, box: para.lines[0]!, text: para.text, dx: last.dx, dy: last.dy }, t('moveBox'))
      }
    )
  }

  /** Press on a picture: a click selects it; a drag moves it straight away. */
  const pressPicture = (e: React.MouseEvent, pic: PictureInfo): void => {
    e.stopPropagation()
    if (e.button !== 0 || target) return
    e.preventDefault()
    setPicSrc(pageSrc())
    let to: Box = pic.box
    const others = blocks().filter((b) => b !== pic.box)
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
        setPicMotion({ pic, to })
      },
      (dragged) => {
        setPicMotion(null)
        setGuides([])
        if (!dragged) {
          setSelectedPic(pic)
          return
        }
        pendingPic.current = to
        void apply(info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'move', rect: to } }, t('movePicture'))
      }
    )
  }

  return (
    <div
      ref={layer}
      className={clsx('absolute inset-0', editTool === 'text' && !target && 'cursor-text', editTool === 'erase' && 'cursor-crosshair')}
      data-edit-layer=""
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget || markupTool) return
        const p = point(e)
        openMenu(e, [
          ...(editTool === 'text' ? [{ label: t('addTextHere'), icon: <Type size={14} />, onClick: () => setTarget({ mode: 'new', x: p.x, y: p.y }) }, 'separator' as const] : []),
          ...pageEntries(view, [page])
        ])
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget || e.button !== 0 || markupTool) return
        // An open editor is applied by its own outside-click handler first.
        if (editTool === 'text' && target) return
        // A click beside a selected picture lets go of it, as in every editor.
        if (selectedPic) {
          setSelectedPic(null)
          return
        }
        e.preventDefault()
        const p = point(e)
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onMouseMove={(e) => {
        if (!drag) return
        const p = point(e)
        setDrag({ ...drag, x1: p.x, y1: p.y })
      }}
      onMouseUp={() => {
        if (!drag) return
        const box: Box = [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)]
        setDrag(null)
        const drawn = box[2] - box[0] > 12 / scale
        if (editTool === 'erase') {
          if (drawn && box[3] - box[1] > 3) void apply(info.id, { op: 'erase', page, box }, t('eraseArea'))
          return
        }
        // Text tool: a click starts text that grows as you type; a drag draws a box that wraps.
        const size = view.addStyle.size
        if (drawn) setTarget({ mode: 'new', x: box[0], y: box[1] + size, width: box[2] - box[0] })
        else setTarget({ mode: 'new', x: drag.x0, y: drag.y0 })
      }}
    >
      {/* Pictures first, so text over a picture is still clicked as text. */}
      {editTool === 'text' &&
        editablePics.map((pic, i) => (selectedPic && closeBoxes(selectedPic.box, pic.box) ? null : <PictureOutline
              key={`p${i}`}
              pic={pic}
              scale={scale}
              onPress={(e) => pressPicture(e, pic)}
              onMenu={(e) => {
                setSelectedPic(pic)
                openMenu(e, [
                  {
                    label: t('replacePicture'),
                    icon: <ImageUp size={14} />,
                    onClick: async () => {
                      const [path] = await window.api.pickImages()
                      if (path) void apply(info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'replace', source: { path } } }, t('replacePicture'))
                    }
                  },
                  { label: t('deletePicture'), icon: <Trash2 size={14} />, danger: true, shortcut: 'Del', onClick: () => void apply(info.id, { op: 'changePicture', page, box: pic.box, change: { kind: 'delete' } }, t('deletePicture')) }
                ])
              }}
            />))}
      {picMotion && <PictureMotionPreview motion={picMotion} scale={scale} src={picSrc} page={pageSize} />}

      {editTool === 'text' &&
        paras?.map((para, i) =>
          target?.mode === 'edit' && target.para === para ? null : (
            <button
              key={i}
              type="button"
              title={t('clickOrDrag')}
              aria-label={t('clickToEdit')}
              data-para=""
              className={clsx(
                'absolute cursor-move rounded-[2px] outline-1 -outline-offset-1 outline-[rgb(37_99_235/0.18)] outline-dashed hover:bg-[rgb(37_99_235/0.07)] hover:outline-solid hover:outline-[var(--focus)]',
                moving?.para === para && 'bg-[rgb(255_255_255/0.85)]'
              )}
              style={px([para.box[0] - 2, para.box[1] - 1, para.box[2] + 2, para.box[3] + 1])}
              onMouseDown={(e) => pressBlock(e, para)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t('editText'), icon: <SquarePen size={14} />, onClick: () => startEdit(para) },
                  { label: t('copy'), icon: <Copy size={14} />, onClick: () => void window.api.copyText(para.text) },
                  'separator',
                  { label: t('deleteText'), icon: <Trash2 size={14} />, danger: true, onClick: () => void apply(info.id, { op: 'replaceText', page, box: para.lines[0]!, text: '' }, t('delete')) }
                ])
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !target) startEdit(para)
              }}
            />
          )
        )}
      {moving && (
        <div
          className="pointer-events-none absolute rounded-[2px] border-2 border-dashed border-[var(--focus)] bg-[rgb(37_99_235/0.08)]"
          style={px([moving.para.box[0] - 2 + moving.dx, moving.para.box[1] - 1 + moving.dy, moving.para.box[2] + 2 + moving.dx, moving.para.box[3] + 1 + moving.dy])}
        />
      )}

      {editTool === 'text' && selectedPic && (
        <SelectedPicture
          key={selectedPic.box.join(',')}
          view={view}
          page={page}
          scale={scale}
          pic={selectedPic}
          others={blocks().filter((b) => !closeBoxes(b, selectedPic.box))}
          pageSrc={pageSrc}
          onMoved={(to) => {
            pendingPic.current = to ?? selectedPic.box
          }}
          onClose={() => setSelectedPic(null)}
          setGuides={setGuides}
        />
      )}

      {target && <TextBoxEditor key={target.mode === 'edit' ? `e-${target.para.box.join(',')}` : `n-${target.x},${target.y}`} view={view} page={page} scale={scale} target={target} onClose={close} />}

      {drag && (Math.abs(drag.x1 - drag.x0) > 3 / scale || Math.abs(drag.y1 - drag.y0) > 3 / scale) && (
        <div
          className={clsx(
            'pointer-events-none absolute border-2 border-dashed',
            editTool === 'erase' ? 'border-danger bg-[rgb(197_48_48/0.12)]' : 'border-[var(--focus)] bg-[rgb(37_99_235/0.06)]'
          )}
          style={px([Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1)])}
        />
      )}

      {guides.map((g, i) => (
        <div
          key={i}
          className="pointer-events-none absolute bg-[#16a34a]"
          style={g.axis === 'x' ? { left: g.at * scale, top: 0, width: 1, height: '100%' } : { top: g.at * scale, left: 0, height: 1, width: '100%' }}
        />
      ))}

      {markupTool && <MarkupLayer view={view} page={page} scale={scale} visible={visible} />}

      {placing && (
        <PlacementLayer
          view={view}
          page={page}
          scale={scale}
          placing={placing}
          onPlaced={(box) => {
            pendingPic.current = box
            if (editTool !== 'text') updateView(info.id, { editTool: 'text' })
          }}
        />
      )}
    </div>
  )
}

/**
 * The paragraph's own typeface for the editing surface (§66): the installed font of that name, or
 * the faces the PDF carries, loaded into the window once per document and font. Letters a subset
 * lacks fall back to the next family in the list. Arabic keeps the stand-in the engine draws it in.
 */
const loadedFaces = new Map<string, Promise<string | null>>()
function ownTypeface(docId: string, page: number, para: ParagraphInfo | null): Promise<string | null> {
  if (!para || para.rtl || !para.font || para.fontStatus === 'missing') return Promise.resolve(null)
  const key = `${docId}|${page}|${para.font}`
  let pending = loadedFaces.get(key)
  if (!pending) {
    pending = (async () => {
      const r = await window.api.paragraphFonts(docId, page, para.font)
      if (!r.ok) return null
      if (r.value.installed) return r.value.installed
      if (!r.value.faces.length) return null
      const family = `hono-own-${loadedFaces.size}`
      const loaded = await Promise.all(
        r.value.faces.map(async (face) => {
          try {
            // Given as bytes, not a URL: the window's security policy loads fonts from the app only.
            const bytes = Uint8Array.from(atob(face.url.slice(face.url.indexOf(',') + 1)), (c) => c.charCodeAt(0))
            const ff = new FontFace(family, bytes, { weight: face.bold ? '700' : '400', style: face.italic ? 'italic' : 'normal' })
            document.fonts.add(await ff.load())
            return true
          } catch {
            // a face the browser cannot read: the others, or the stand-in, show instead
            return false
          }
        })
      )
      return loaded.some(Boolean) ? family : null
    })()
    loadedFaces.set(key, pending)
  }
  return pending
}

function TextBoxEditor({ view, page, scale, target, onClose }: { view: DocView; page: number; scale: number; target: Target; onClose: () => void }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  // The editing surface (§65): words can be in their own style; read back on every change.
  const area = useRef<HTMLDivElement>(null)
  const para = target.mode === 'edit' ? target.para : null
  const defaults = view.addStyle
  const initialStyle: BoxStyle = para
    ? { size: round(para.size), colour: para.colour, bold: para.bold, italic: para.italic, kind: para.kind, align: para.align }
    : { size: defaults.size, colour: defaults.colour, bold: defaults.bold, italic: false, kind: 'sans', align: 'start' }
  const [text, setText] = useState(para?.text ?? '')
  // Typing shows in the paragraph's own typeface when it can be had (§66).
  const [ownFamily, setOwnFamily] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void ownTypeface(view.info.id, page, para).then((f) => live && setOwnFamily(f))
    return () => {
      live = false
    }
  }, [view.info.id, page, para])
  // Style and direction live in the document's state, so the Edit panel's FORMAT TEXT
  // section shows and changes the same values as this box's own bar (Acrobat's panel).
  const shared = view.textEdit
  const style: BoxStyle = shared?.style ?? initialStyle
  const setStyle = (next: BoxStyle): void => patchTextEdit(view.info.id, { style: next })
  const [offset, setOffset] = useState({ dx: 0, dy: 0 })
  /** Writing direction chosen by hand (Foxit's per-box setting); null = automatic. */
  const chosenDirection = shared?.direction ?? null
  const drawnWidth = target.mode === 'new' ? target.width : undefined
  const done = useRef(false)
  // The same rule as the engine: the first strong letter decides, unless chosen by hand.
  const autoRtl = para ? para.rtl : firstStrongIsRtl(text)
  const rtl = chosenDirection ? chosenDirection === 'rtl' : autoRtl
  // A new box: drawn (its rectangle), or clicked (a point where the text starts — its right end for RTL).
  const origin: Box = para
    ? para.box
    : target.mode === 'new'
      ? drawnWidth
        ? [target.x, target.y - style.size, target.x + drawnWidth, target.y]
        : rtl
          ? [target.x - 200, target.y - style.size, target.x, target.y]
          : [target.x, target.y - style.size, target.x + 200, target.y]
      : [0, 0, 0, 0]
  const [width, setWidth] = useState(drawnWidth ?? origin[2] - origin[0])
  const widthChanged = useRef(drawnWidth !== undefined)
  // Light text (white on a coloured band) is edited on a dark box, or it would be invisible.
  const light = luminance(style.colour) > 0.6
  const pitch = para ? para.pitch * (style.size / para.size) : style.size * 1.25

  const wrapsNow = widthChanged.current || (para ? para.lines.length > 1 : false)
  // The surface filled once with the paragraph's text and its words in other styles, the caret at the end.
  const initialSpans = useRef(para?.spans ?? [])
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    fillEditor(el, para?.text ?? '', initialSpans.current, { size: initialStyle.size })
    el.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const readNow = (): { text: string; spans: TextSpan[] } => (area.current ? readEditor(area.current, { size: style.size }) : { text, spans: [] })
  // Spelling (§67): checked when the box opens and after typing pauses.
  const spellTimer = useRef(0)
  const checkSpelling = (delay: number): void => {
    window.clearTimeout(spellTimer.current)
    spellTimer.current = window.setTimeout(() => area.current && void markSpelling(area.current), delay)
  }
  useEffect(() => {
    checkSpelling(0)
    return () => {
      window.clearTimeout(spellTimer.current)
      clearSpelling()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const spellingMenu = async (e: React.MouseEvent): Promise<void> => {
    const word = misspelledAt(e.clientX, e.clientY)
    if (!word) return
    const text = word.toString()
    const at = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {}, stopPropagation: () => {} } as MouseEvent
    const replace = (s: string): void => {
      area.current?.focus()
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(word)
      // Through the browser's own command: the word keeps its style, and Undo takes it back.
      document.execCommand('insertText', false, s)
    }
    const suggestions = await window.api.spellSuggest(text).catch(() => [] as string[])
    openMenu(at, [
      ...(suggestions.length ? suggestions.map((s) => ({ label: s, onClick: () => replace(s) })) : [{ label: t('spell.none'), disabled: true, onClick: () => {} }]),
      'separator',
      {
        label: t('spell.add'),
        icon: <BookPlus size={14} />,
        onClick: () => void window.api.spellAdd(text).then(() => checkSpelling(0))
      },
      {
        label: t('spell.ignore'),
        icon: <EyeOff size={14} />,
        onClick: () => {
          ignoreWord(text)
          checkSpelling(0)
        }
      }
    ])
  }
  // The selection: kept (a field of the format bar takes the focus), and its look shown on the bar.
  const savedRange = useRef<Range | null>(null)
  useEffect(() => {
    const onChange = (): void => {
      const el = area.current
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return
      savedRange.current = range.collapsed ? null : range.cloneRange()
      patchTextEdit(view.info.id, { selection: range.collapsed ? null : selectionStyle(el, { size: style.size }) })
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [style.size, view.info.id])
  useEffect(() => {
    setActiveEditor({
      hasSelection: () => !!savedRange.current && !savedRange.current.collapsed,
      applyToSelection: (patch) => {
        const el = area.current
        const range = savedRange.current
        if (!el || !range) return
        el.focus()
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        styleSelection(el, patch, selectionStyle(el, { size: style.size }), { size: style.size })
        setText(readNow().text)
        patchTextEdit(view.info.id, { selection: selectionStyle(el, { size: style.size }) })
      }
    })
    return () => setActiveEditor(null)
  })

  useEffect(() => {
    updateView(view.info.id, { textEdit: { style: initialStyle, direction: null, rtl, wraps: wrapsNow, mixed: !!para?.mixed, ...(para?.font ? { font: { name: para.font, status: para.fontStatus, kind: para.kind } } : {}) } })
    return () => updateView(view.info.id, { textEdit: null })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (shared && (shared.rtl !== rtl || shared.wraps !== wrapsNow)) patchTextEdit(view.info.id, { rtl, wraps: wrapsNow })
  }, [rtl, wrapsNow, shared, view.info.id])

  const changedStyle = (Object.keys(style) as Array<keyof BoxStyle>).filter((k) => style[k] !== initialStyle[k] && style[k] !== undefined)
  const lineHeight = shared?.lineHeight

  const commit = useCallback(async () => {
    if (done.current) return
    done.current = true
    // What the box holds: its text, and its words in other styles (§65).
    const { text, spans } = readNow()
    onClose()
    const direction = chosenDirection && chosenDirection !== (para ? (para.rtl ? 'rtl' : 'ltr') : null) ? { direction: chosenDirection } : {}
    if (para) {
      const sameSpans = JSON.stringify(spans) === JSON.stringify(initialSpans.current)
      const nothing = text === para.text && sameSpans && changedStyle.length === 0 && offset.dx === 0 && offset.dy === 0 && !widthChanged.current && !('direction' in direction) && !lineHeight
      if (nothing) return
      await apply(
        view.info.id,
        {
          op: 'replaceText',
          page,
          box: para.lines[0]!,
          text,
          style: { ...Object.fromEntries(changedStyle.map((k) => [k, style[k]])), ...direction },
          dx: offset.dx,
          dy: offset.dy,
          ...(widthChanged.current ? { width } : {}),
          ...(lineHeight ? { lineHeight } : {}),
          ...(text.trim() ? { spans } : {})
        },
        t('editText')
      )
    } else if (target.mode === 'new' && text.trim()) {
      const wrapped = widthChanged.current
      // The engine takes the start edge: the left for LTR, the right for RTL.
      const x = (wrapped ? (rtl ? origin[0] + width : origin[0]) : target.x) + offset.dx
      const baseline = target.y + offset.dy
      await apply(
        view.info.id,
        {
          op: 'addText',
          page,
          x,
          y: baseline,
          text,
          size: style.size,
          colour: style.colour,
          bold: style.bold,
          italic: style.italic,
          kind: style.kind,
          ...(style.family ? { family: style.family } : {}),
          ...(style.underline ? { underline: true } : {}),
          ...(lineHeight ? { lineHeight } : {}),
          ...(wrapped ? { width, align: style.align } : {}),
          ...(chosenDirection ? { direction: chosenDirection } : {}),
          ...(spans.length ? { spans } : {})
        },
        t('addText')
      )
      updateView(view.info.id, { addStyle: { size: style.size, colour: style.colour, bold: style.bold } })
    }
  }, [para, changedStyle, lineHeight, offset, width, style, page, target, rtl, origin, chosenDirection, view.info.id, onClose, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = (): void => {
    done.current = true
    onClose()
  }

  // A click anywhere outside the box applies the change, as in every desktop editor — except
  // in the Edit panel's FORMAT TEXT section, which changes this box.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      // The panel's FORMAT TEXT section and this box's own dropdowns and spelling menu (opened outside it) are part of the box.
      if ((e.target as Element).closest?.('[data-format-panel], [data-select-list], [data-colour-picker], [data-context-menu]')) return
      if (box.current && !box.current.contains(e.target as Node)) void commit()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [commit])

  const startDrag = (e: React.MouseEvent, kind: 'move' | 'width'): void => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const y0 = e.clientY
    const start = { ...offset }
    const w0 = width
    const move = (m: MouseEvent): void => {
      const dx = (m.clientX - x0) / scale
      const dy = (m.clientY - y0) / scale
      if (kind === 'move') setOffset({ dx: start.dx + dx, dy: start.dy + dy })
      else {
        widthChanged.current = true
        setWidth(Math.max(24, w0 + (rtl ? -dx : dx)))
      }
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // What you see while typing is what you get: a one-line block (a heading, a label, new text)
  // extends instead of wrapping, as the engine lays it out; a paragraph, or a box whose width
  // was dragged, wraps at its width.
  const wraps = widthChanged.current || (para ? para.lines.length > 1 : false)
  const left = (rtl && para && !drawnWidth ? origin[2] - width : origin[0]) + offset.dx
  const top = origin[1] + offset.dy
  const toolbarAbove = top * scale > 52
  // Keep the toolbar inside the pages' area: in a narrow window it would run off the edge.
  const toolbar = useRef<HTMLDivElement>(null)
  const [toolbarShift, setToolbarShift] = useState(0)
  const [toolbarMax, setToolbarMax] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = toolbar.current
    const area = el?.closest('main')?.getBoundingClientRect()
    if (!el || !area) return
    // Too narrow for one row: wrap onto two (never wider than the pages' area).
    const max = Math.floor(area.width - 16)
    if (max !== toolbarMax) setToolbarMax(max)
    const r = el.getBoundingClientRect()
    const natural = r.left - toolbarShift
    const overflow = natural + r.width - (area.right - 8)
    const next = overflow > 0 ? -Math.min(overflow, Math.max(0, natural - area.left - 8)) : 0
    if (Math.abs(next - toolbarShift) > 0.5) setToolbarShift(next)
  })

  return (
    <>
      {/* While a block is moved, its old place is shown empty, as it will be. */}
      {para && (offset.dx !== 0 || offset.dy !== 0) && (
        <div className="pointer-events-none absolute bg-white" style={{ left: origin[0] * scale - 2, top: origin[1] * scale - 1, width: (origin[2] - origin[0]) * scale + 4, height: (origin[3] - origin[1]) * scale + 2 }} />
      )}
      <div
        ref={box}
        className="absolute z-30"
        style={{
          ...(rtl && !wraps ? { right: `calc(100% - ${(origin[2] + offset.dx) * scale + 3}px)` } : { left: left * scale - 3 }),
          top: top * scale - 2,
          ...(wraps ? { width: width * scale + 6 } : { minWidth: Math.max(width, 60) * scale + 6 })
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className={clsx(
            'absolute flex min-h-10 w-max flex-wrap items-center gap-1 rounded-xl border border-line bg-surface px-1.5 py-1 text-ink shadow-[0_8px_24px_rgb(0_0_0/0.18)]',
            toolbarAbove ? 'bottom-full mb-2.5' : 'top-full mt-2.5'
          )}
          dir="ltr"
          ref={toolbar}
          style={{ left: 0, maxWidth: toolbarMax, transform: toolbarShift ? `translateX(${toolbarShift}px)` : undefined }}
          data-text-toolbar=""
        >
          <ToolbarButton
            label={t('arabicDigitsToggle')}
            onClick={() => {
              // Rewritten in place, letter by letter: words keep their styles.
              const el = area.current
              if (!el) return
              const western = /[0-9]/.test(readNow().text)
              mapText(el, (t) => (western ? t.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d))) : t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))))
              setText(readNow().text)
            }}
          >
            <span className="text-[12px] leading-none">١٢٣</span>
          </ToolbarButton>
          <span className="mx-0.5 h-5 w-px bg-line" />
          {para && (
            <ToolbarButton
              label={t('delete')}
              className="text-danger"
              onClick={() => {
                done.current = true
                onClose()
                void apply(view.info.id, { op: 'replaceText', page, box: para.lines[0]!, text: '' }, t('delete'))
              }}
            >
              <Trash2 size={15} />
            </ToolbarButton>
          )}
          <ToolbarButton label={`${t('cancel')} (Esc)`} onClick={cancel}>
            <X size={15} />
          </ToolbarButton>
          <button
            type="button"
            title={`${t('done')} (Ctrl+Enter)`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commit()}
            className="ms-0.5 flex h-7 items-center gap-1 rounded-full bg-accent ps-2 pe-3 text-[12px] font-semibold text-accent-ink hover:brightness-110"
          >
            <Check size={14} strokeWidth={2.5} />
            {t('done')}
          </button>
        </div>

        <div
          ref={area}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          dir={chosenDirection ?? 'auto'}
          spellCheck={false}
          data-placeholder={t('typeHere')}
          data-rich-editor=""
          onInput={() => {
            setText(readNow().text)
            checkSpelling(400)
          }}
          onContextMenu={(e) => {
            // The page's own menu stays away; a misspelled word gets its corrections.
            e.preventDefault()
            e.stopPropagation()
            void spellingMenu(e)
          }}
          onPaste={(e) => {
            // Plain text only: the words take the style where they are pasted.
            e.preventDefault()
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
          }}
          onDrop={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void commit()
            } else if (e.key === 'Enter') {
              // A line break, not a new block.
              e.preventDefault()
              document.execCommand('insertLineBreak')
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
              e.preventDefault()
              // Selected words: only they change (§65); otherwise the whole box.
              const editor = activeEditor()
              const sel = view.textEdit?.selection
              if (editor?.hasSelection() && sel) editor.applyToSelection(e.key === 'b' ? { bold: !sel.bold } : e.key === 'i' ? { italic: !sel.italic } : { underline: !sel.underline })
              else setStyle(e.key === 'b' ? { ...style, bold: !style.bold } : e.key === 'i' ? { ...style, italic: !style.italic } : { ...style, underline: !style.underline })
            } else if (e.altKey && e.key.startsWith('Arrow')) {
              // Nudge the box: 1 point, 10 with Shift (arrow keys alone move the caret).
              e.preventDefault()
              const step = e.shiftKey ? 10 : 1
              const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0]
              setOffset({ dx: offset.dx + d[0]!, dy: offset.dy + d[1]! })
            }
          }}
          className="block rounded-[3px] px-[3px] py-[2px] shadow-[0_0_0_1.5px_var(--accent),0_0_0_5px_rgb(20_115_230/0.18)] outline-none empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)]"
          style={{
            background: light ? '#3a3f4a' : '#ffffff',
            fontFamily: style.family ? `'${style.family}', ${FAMILY[style.kind]}` : ownFamily && para && style.kind === para.kind ? `'${ownFamily}', ${FAMILY[style.kind]}` : FAMILY[style.kind],
            textDecoration: style.underline ? 'underline' : 'none',
            fontSize: style.size * scale,
            lineHeight: `${(lineHeight ? style.size * lineHeight : pitch) * scale}px`,
            fontWeight: style.bold ? 700 : 400,
            fontStyle: style.italic ? 'italic' : 'normal',
            color: style.colour,
            textAlign: style.align === 'centre' ? 'center' : style.align === 'justify' ? 'justify' : style.align,
            whiteSpace: wraps ? 'pre-wrap' : 'pre',
            // A one-line block grows with its text; a paragraph wraps at its width.
            width: wraps ? undefined : 'max-content',
            minWidth: wraps ? undefined : Math.max(width, 60) * scale,
            minHeight: pitch * scale
          }}
        />

        <button
          type="button"
          title={t('moveBox')}
          aria-label={t('moveBox')}
          onMouseDown={(e) => startDrag(e, 'move')}
          className="absolute -start-7 -top-0.5 flex h-6 w-6 cursor-move items-center justify-center rounded-full border border-line bg-surface text-accent shadow-md hover:bg-accent hover:text-accent-ink"
        >
          <Move size={12} />
        </button>
        <span
          title={t('resizeBox')}
          onMouseDown={(e) => startDrag(e, 'width')}
          className={clsx('absolute top-1/2 h-3 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border-[1.5px] border-accent bg-surface shadow-sm', rtl ? '-left-[7px]' : '-right-[7px]')}
        />
      </div>
    </>
  )
}

function ToolbarButton({ label, onClick, active, className, children }: { label: string; onClick: () => void; active?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('flex h-7 min-w-7 items-center justify-center rounded-md px-1', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink', className)}
    >
      {children}
    </button>
  )
}

const round = (n: number): number => Math.round(n * 2) / 2

function firstStrongIsRtl(text: string): boolean {
  for (const c of text) {
    if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(c)) return true
    if (/[A-Za-zÀ-ɏͰ-ӿ]/.test(c)) return false
  }
  return false
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

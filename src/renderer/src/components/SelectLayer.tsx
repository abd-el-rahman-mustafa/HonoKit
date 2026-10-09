import { Copy, Highlighter, SquarePen, Strikethrough, Underline } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PageLink } from '@shared/ipc'
import { apply, goToDestination, openTool, openWebLink, toast, updateView, useT, type DocView } from '../store'
import { openMenu } from './ContextMenu'
import { px } from './editGeometry'
import { pageEntries } from './menus'
import { MiniButton } from './PictureEdit'

/**
 * The select tool on a page, as in Acrobat: drag over text to select it (double click: a
 * word, triple click: the line); a small toolbar appears by the selection to copy it,
 * highlight, underline or strike it through, or edit it. The selection comes from the
 * engine, so Arabic is selected and copied in reading order (docs/decisions.md §33).
 *
 * Links work here too, as with Acrobat's hand and select tools: over a link to a page of this
 * document the pointer is a hand and a click (not a drag) goes there. A link to a web address
 * shows the address as a tooltip and is not opened (opening outside addresses is the owner's call;
 * docs/roadmap.md).
 */
export function SelectLayer({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const { info } = view
  const selection = view.selection?.page === page ? view.selection : null
  const links = usePageLinks(layer, info.id, info.revision, page)
  const [hover, setHover] = useState<PageLink | null>(null)
  const linkAt = (p: [number, number]): PageLink | null => links.find((l) => p[0] >= l.box[0] && p[0] <= l.box[2] && p[1] >= l.box[1] && p[1] <= l.box[3]) ?? null

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = layer.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = at(e)
    // Two clicks a word, three the line, four the whole page (as Acrobat).
    const unit = e.detail >= 4 ? 'page' : e.detail === 3 ? 'line' : e.detail === 2 ? 'word' : 'char'
    let pending = false
    let latest: [number, number] = start
    const ask = (to: [number, number]): void => {
      latest = to
      if (pending) return
      pending = true
      // One request at a time; the newest pointer position wins.
      void window.api.selectText(info.id, page, start, latest, unit).then((r) => {
        pending = false
        updateView(info.id, { selection: r.ok && r.value ? { ...r.value, page } : null })
        if (latest !== to) ask(latest)
      })
    }
    if (unit === 'char') updateView(info.id, { selection: null })
    else ask(start)
    setDragging(true)
    const move = (m: MouseEvent): void => {
      if (unit === 'char' && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return
      ask(at(m))
    }
    const up = (m: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setDragging(false)
      // A click (no drag) on a link follows it: a page of this document at once, a web or email
      // address after asking (§81).
      if (unit !== 'char' || Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) >= 3) return
      const link = linkAt(start)
      if (link?.page !== undefined) {
        updateView(info.id, { selection: null })
        goToDestination(info.id, link.page, link.point)
      } else if (link?.uri) {
        updateView(info.id, { selection: null })
        void openWebLink(link.uri)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  useEffect(() => {
    if (!selection) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') updateView(info.id, { selection: null })
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [selection, info.id])

  const mark = (kind: 'highlight' | 'underline' | 'strikeout'): void => {
    if (!selection) return
    const colour = kind === 'highlight' ? view.markStyle.highlight : view.markStyle.colour
    updateView(info.id, { selection: null })
    void apply(info.id, { op: 'markup', page, markup: { kind, from: selection.from, to: selection.to, colour } }, t('addMarkup'))
  }

  const first = selection?.boxes[0]
  const above = first ? first[1] * scale > 48 : true
  return (
    <div
      ref={layer}
      className={hover && (hover.page !== undefined || hover.uri) && !dragging ? 'absolute inset-0 cursor-pointer' : 'absolute inset-0 cursor-text'}
      title={hover && !dragging ? (hover.page !== undefined ? t('link.goTo', { n: hover.page + 1 }) : t('link.external', { address: hover.uri ?? '' })) : undefined}
      onMouseDown={onDown}
      onMouseMove={(e) => {
        if (!links.length) return
        const link = linkAt(at(e))
        if (link !== hover) setHover(link)
      }}
      onMouseLeave={() => hover && setHover(null)}
      onContextMenu={(e) =>
        openMenu(e, [
          ...(selection
            ? [
                { label: t('copy'), icon: <Copy size={14} />, shortcut: 'Ctrl+C', onClick: () => void window.api.copyText(selection.text).then(() => toast('success', t('copied'))) },
                { label: t('markup.highlight'), icon: <Highlighter size={14} />, onClick: () => mark('highlight') },
                { label: t('markup.underline'), icon: <Underline size={14} />, onClick: () => mark('underline') },
                { label: t('markup.strikeout'), icon: <Strikethrough size={14} />, onClick: () => mark('strikeout') },
                'separator' as const
              ]
            : []),
          { label: t('editText'), icon: <SquarePen size={14} />, onClick: () => openTool('edit') },
          'separator',
          ...pageEntries(view, [page])
        ])
      }
      data-select-layer=""
    >
      {selection?.boxes.map((b, i) => <div key={i} className="pointer-events-none absolute rounded-[1px] bg-[rgb(20_115_230/0.28)]" style={px(b, scale)} />)}
      {selection && first && !dragging && (
        <div
          className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-1 text-ink shadow-lg"
          style={{ left: first[0] * scale, top: above ? first[1] * scale - 42 : (selection.boxes[selection.boxes.length - 1]![3] * scale) + 8 }}
          dir="ltr"
          onMouseDown={(e) => e.stopPropagation()}
          data-selection-toolbar=""
        >
          <MiniButton label={t('markup.highlight')} onClick={() => mark('highlight')}>
            <Highlighter size={15} />
          </MiniButton>
          <MiniButton label={t('markup.underline')} onClick={() => mark('underline')}>
            <Underline size={15} />
          </MiniButton>
          <MiniButton label={t('markup.strikeout')} onClick={() => mark('strikeout')}>
            <Strikethrough size={15} />
          </MiniButton>
          <MiniButton
            label={`${t('copy')} (Ctrl+C)`}
            onClick={() => {
              void window.api.copyText(selection.text)
              toast('success', t('copied'))
            }}
          >
            <Copy size={15} />
          </MiniButton>
          <span className="mx-0.5 h-5 w-px bg-line" />
          <MiniButton
            label={t('editText')}
            onClick={() => {
              updateView(info.id, { selection: null })
              openTool('edit')
            }}
          >
            <SquarePen size={15} />
          </MiniButton>
        </div>
      )}
    </div>
  )
}

/** The links of a page, read once it comes near the view, and again after each change. */
function usePageLinks(layer: React.RefObject<HTMLDivElement | null>, id: string, revision: number, page: number): PageLink[] {
  const [links, setLinks] = useState<PageLink[]>([])
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const observer = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: '300px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [layer])
  useEffect(() => {
    if (!visible) return
    let gone = false
    void window.api.pageLinks(id, page).then((r) => {
      if (!gone) setLinks(r.ok ? r.value : [])
    })
    return () => {
      gone = true
    }
  }, [visible, id, revision, page])
  return links
}

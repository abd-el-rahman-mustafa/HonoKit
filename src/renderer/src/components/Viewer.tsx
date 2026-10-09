import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { updateView, type DocView } from '../store'
import { EditLayer } from './EditLayer'
import { anchoredScroll, pageSpots, scrollToBox, zoomAnchor, type ZoomAnchor } from './editGeometry'
import { CropOverlay } from './CropOverlay'
import { FieldLayer } from './FieldLayer'
import { FormLayer } from './FormLayer'
import { RedactLayer } from './RedactLayer'
import { SelectLayer } from './SelectLayer'
import { PageImage } from './ui'

/** 100% means actual size: 96 CSS pixels per inch, 72 points per inch. */
export const POINT = 96 / 72
const GAP = 16
const PADDING = 24
/** Room at the sides for the floating quick tools, as in Acrobat; the reader has none (§75). */
const SIDE = 64
const READING_SIDE = 24

export function displayScale(view: DocView, box: { width: number; height: number }): number {
  const pages = view.info.pages
  const side = view.reading ? READING_SIDE : SIDE
  const widest = Math.max(...pages.map((p) => p.width), 1)
  if (view.zoom === 'width') return Math.max(0.1, (box.width - side * 2) / widest)
  if (view.zoom === 'page') {
    const current = pages[view.page] ?? pages[0]!
    return Math.max(0.1, Math.min((box.width - side * 2) / current.width, (box.height - PADDING * 2) / current.height))
  }
  return view.zoom * POINT
}

export function Viewer({ view }: { view: DocView }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 800, height: 600 })
  const { info, search } = view
  const scale = displayScale(view, box)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    setBox({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const side = view.reading ? READING_SIDE : SIDE
  /** Each page's place in the scrolled content at a scale (pages are centred in it). */
  const spotsAt = (at: number): ReturnType<typeof pageSpots> => pageSpots(info.pages, at, { padding: PADDING, gap: GAP, side, viewWidth: scroller.current?.clientWidth ?? box.width })
  // Where each page starts, for scrolling to a page and for knowing which page is in view.
  const tops = useMemo(() => pageSpots(info.pages, scale, { padding: PADDING, gap: GAP, side, viewWidth: box.width }).map((p) => p.top), [info.pages, scale, side, box.width])
  const total = (tops[tops.length - 1] ?? 0) + (info.pages[info.pages.length - 1]?.height ?? 0) * scale + PADDING
  const widest = Math.max(...info.pages.map((p) => p.width)) * scale
  const contentWidth = Math.max(widest + side * 2, box.width - 1)

  // Scroll to a page when asked (thumbnail click, page box); a search match is scrolled into
  // view itself, sideways too when zoomed in, and stays put if it is already showing.
  useEffect(() => {
    const target = view.scrollTo
    const el = scroller.current
    if (!target || !el) return
    const spot = spotsAt(scale)[target.page]
    if (target.point && spot) {
      // A destination: its point at the top of the view (and at the side, if it is out of sight).
      const x = spot.left + target.point[0] * scale
      const left = x >= el.scrollLeft && x <= el.scrollLeft + el.clientWidth - 24 ? el.scrollLeft : Math.max(0, x - 8)
      el.scrollTo({ left, top: Math.max(0, spot.top + target.point[1] * scale - 8) })
    } else if (target.box && spot) {
      const to = scrollToBox(spot, scale, target.box, { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight })
      el.scrollTo({ left: to.left, top: to.top })
    } else el.scrollTo({ top: (tops[target.page] ?? 0) - 8 })
  }, [view.scrollTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // The toolbar shows the zoom actually in use, which in the fit modes depends on the window.
  useEffect(() => {
    const shown = Math.round((scale / POINT) * 100) / 100
    if (shown !== view.shownZoom) updateView(info.id, { shownZoom: shown })
  }, [scale, info.id, view.shownZoom])

  // When the zoom changes: Ctrl+wheel keeps the point under the pointer where it is (as
  // Acrobat does); other zooms keep the middle of the view, and Fit page
  // shows the current page from its top.
  const lastScale = useRef(scale)
  const wheelAnchor = useRef<ZoomAnchor | null>(null)
  // The scroll position before the zoom: by the time the layout effect runs, a smaller content
  // has already pulled the scroller's own position in, so the last scroll event's is used.
  const scrolled = useRef({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const el = scroller.current
    if (lastScale.current !== scale && el) {
      const old = lastScale.current
      const anchor =
        wheelAnchor.current ??
        (view.zoom === 'page' ? null : zoomAnchor(spotsAt(old), old, scrolled.current, { x: el.clientWidth / 2, y: el.clientHeight / 2 }))
      wheelAnchor.current = null
      if (anchor) {
        const to = anchoredScroll(spotsAt(scale), scale, anchor)
        el.scrollTop = to.top
        el.scrollLeft = to.left
      } else el.scrollTop = (tops[view.page] ?? 0) - 8
    }
    lastScale.current = scale
  }, [scale]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    scrolled.current = { left: el.scrollLeft, top: el.scrollTop }
    const probe = el.scrollTop + el.clientHeight * 0.35
    let page = 0
    while (page + 1 < tops.length && tops[page + 1]! <= probe) page++
    if (page !== view.page) updateView(info.id, { page })
  }

  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const current = scale / POINT
    const next = Math.round(Math.min(6, Math.max(0.1, current * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) * 100) / 100
    const el = scroller.current
    if (!el || Math.abs(next * POINT - scale) < 1e-6) return
    const r = el.getBoundingClientRect()
    wheelAnchor.current = zoomAnchor(spotsAt(scale), scale, { left: el.scrollLeft, top: el.scrollTop }, { x: e.clientX - r.left, y: e.clientY - r.top })
    updateView(info.id, { zoom: next })
  }

  const current = search.hits[search.index]
  return (
    <div ref={scroller} onScroll={onScroll} onWheel={onWheel} className="relative h-full overflow-auto bg-sunken" dir="ltr" data-doc-id={info.id}>
      <div className="relative mx-auto" style={{ height: total, width: contentWidth }}>
        {info.pages.map((p, i) => {
          const w = p.width * scale
          const h = p.height * scale
          const hits = search.hits.filter((hit) => hit.page === i)
          return (
            <div key={i} className="page-shadow absolute bg-white" style={{ top: tops[i], left: `calc(50% - ${w / 2}px)`, width: w, height: h }} data-page={i}>
              <PageImage docId={info.id} revision={info.revision} page={i} width={w} height={h} pointsWide={p.width} exact />
              {hits.map((hit, k) =>
                hit.boxes.map((b, j) => (
                  <div
                    key={`${k}-${j}`}
                    className={hit === current ? 'hit hit-current absolute rounded-[2px]' : 'hit absolute rounded-[2px]'}
                    style={{ left: b[0] * scale - 1, top: b[1] * scale - 1, width: (b[2] - b[0]) * scale + 2, height: (b[3] - b[1]) * scale + 2 }}
                  />
                ))
              )}
              {view.mode === 'edit' && <EditLayer view={view} page={i} scale={scale} />}
              {view.mode === 'view' && !view.redact && !view.prepare && !(view.crop && i === view.page) && <SelectLayer view={view} page={i} scale={scale} />}
              {view.redact && <RedactLayer view={view} page={i} scale={scale} />}
              {view.mode === 'view' && !view.redact && !view.crop && !view.prepare && view.forms && view.forms.count > 0 && <FormLayer view={view} page={i} scale={scale} />}
              {view.prepare && <FieldLayer view={view} page={i} scale={scale} />}
              {view.crop && i === view.page && <CropOverlay view={view} page={i} scale={scale} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

import clsx from 'clsx'
import { BookOpen, CreditCard, FileSpreadsheet, FileText, ImagePlus, Maximize2, Plus, RotateCcw, RotateCw, ScanLine, ScanText, SeparatorVertical, Sparkles, Trash2, Type, Upload } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScanCorners, ScanItem, ScanMode } from '@shared/ipc'
import { apply, newDocument, openTool, runBusy, toast, useStore, useT, type ToolId } from '../store'
import { Button, Check, Segmented, Select, Spinner } from './ui'

/**
 * The Scan board (docs/decisions.md §61, §62), shared by six tools:
 *  - Scan documents: photos or a scanner → straightened, cleaned pages → a PDF (searchable if asked);
 *  - Scan ID card: front and back → one A4 page at the card's real size;
 *  - Scan book: photos, scans or a PDF of an open book → each spread flattened and split at its fold;
 *  - Image to Text / Word / Excel: the same pages → recognised text → a .txt, .docx or .xlsx.
 * Each picture's page is found automatically; its four corners can be dragged, it can be turned,
 * and cleaned as colour, grayscale or black and white, as phone scanner apps do.
 */
export type ScanGoal = 'scanDocuments' | 'scanIdCard' | 'scanBook' | 'imageToText' | 'imageToWord' | 'imageToExcel'
export const SCAN_TOOLS: ToolId[] = ['scanDocuments', 'scanIdCard', 'scanBook', 'imageToText', 'imageToWord', 'imageToExcel']

interface Item {
  key: string
  path: string
  name: string
  width: number
  height: number
  /** The picture upright, small, to draw the corners on. */
  preview: string | null
  /** The page as it comes out (a book spread's two pages, left to right). */
  result: string[] | null
  detected: ScanCorners | null
  corners: ScanCorners | null
  mode: ScanMode
  rotate: 0 | 90 | 180 | 270
  /** Scan ID card: the slot it fills; removing the front leaves the back where it is. */
  side?: 'front' | 'back'
  /** Scan book: where the fold is (a share of the straightened width), null for one page; and where it was found. */
  split?: number | null
  foundSplit?: number | null
  failed?: boolean
}

let counter = 0
const OFFICE: Partial<Record<ScanGoal, 'txt' | 'docx' | 'xlsx'>> = { imageToText: 'txt', imageToWord: 'docx', imageToExcel: 'xlsx' }
const ICON: Record<ScanGoal, typeof ScanLine> = { scanDocuments: ScanLine, scanIdCard: CreditCard, scanBook: BookOpen, imageToText: Type, imageToWord: FileText, imageToExcel: FileSpreadsheet }

/** What goes to the worker for an item; a book's items carry their fold. */
const specOf = (x: Item, book: boolean): ScanItem => ({ path: x.path, corners: x.corners, mode: x.mode, rotate: x.rotate, ...(x.side ? { side: x.side } : {}), ...(book ? { split: x.split ?? null } : {}) })

/** The corners in the order the result is drawn (as the engine's turnedSource): a turn starts them from another corner. */
const turned = (c: ScanCorners, turn: 0 | 90 | 180 | 270): ScanCorners => {
  const steps = turn / 90
  return [0, 1, 2, 3].map((i) => c[(i + 4 - steps) % 4]!) as ScanCorners
}

const whole = (w: number, h: number): ScanCorners => [
  [0, 0],
  [w, 0],
  [w, h],
  [0, h]
]

export function ScanView({ goal }: { goal: ScanGoal }) {
  const t = useT()
  const idCard = goal === 'scanIdCard'
  const book = goal === 'scanBook'
  const office = OFFICE[goal]
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [paper, setPaper] = useState<'a4' | 'letter' | 'fit'>(book ? 'fit' : 'a4')
  // An Arabic book starts each spread on the right; the app's language is the best first guess.
  const [rtl, setRtl] = useState(() => useStore.getState().settings?.language === 'ar')
  const [reading, setReading] = useState(0)
  const [searchable, setSearchable] = useState(true)
  const [language, setLanguage] = useState<'auto' | 'ar' | 'en'>('auto')
  const [scanning, setScanning] = useState(false)
  const Icon = ICON[goal]

  const update = useCallback((key: string, patch: Partial<Item>): void => setItems((now) => now.map((x) => (x.key === key ? { ...x, ...patch } : x))), [])
  // The latest pictures, for work that finishes later (detection, previews): it must not act on an old copy.
  const latest = useRef(items)
  latest.current = items

  // The page as it comes out, made again shortly after its corners, turn or cleaning change — from
  // the picture as it is then. A preview that comes back after a newer one was asked for is dropped.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const asked = useRef(new Map<string, number>())
  const refresh = useCallback(
    (key: string): void => {
      const old = timers.current.get(key)
      if (old) clearTimeout(old)
      timers.current.set(
        key,
        setTimeout(() => {
          const item = latest.current.find((x) => x.key === key)
          if (!item) return
          const n = (asked.current.get(key) ?? 0) + 1
          asked.current.set(key, n)
          void window.api.scanPreview(specOf(item, book)).then((r) => r.ok && asked.current.get(key) === n && update(key, { result: r.value }))
        }, 220)
      )
    },
    [update, book]
  )

  const add = useCallback(
    (all: string[]): void => {
      // A book's PDF (scanned spreads) joins as one picture per page.
      const pdfs = book ? all.filter((p) => /\.pdf$/i.test(p)) : []
      const paths = all.filter((p) => !/\.pdf$/i.test(p))
      if (pdfs.length) {
        setReading((n) => n + 1)
        void window.api.scanPdfPictures(pdfs).then((r) => {
          setReading((n) => n - 1)
          if (!r.ok) toast('error', r.error.message)
          else if (r.value.length) add(r.value)
        })
      }
      // An ID card's pictures fill the empty sides, front first.
      const free = goal === 'scanIdCard' ? (['front', 'back'] as const).filter((s) => !latest.current.some((x) => x.side === s)) : null
      const fresh = (free ? paths.slice(0, free.length) : paths).map((path, i): Item => ({
        key: `s${counter++}`,
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        width: 1,
        height: 1,
        preview: null,
        result: null,
        detected: null,
        corners: null,
        mode: goal === 'scanIdCard' || goal === 'scanDocuments' || goal === 'scanBook' ? 'color' : 'gray',
        rotate: 0,
        ...(free ? { side: free[i] } : {})
      }))
      if (!fresh.length) return
      setItems((now) => [...now, ...fresh])
      setSelected((s) => s ?? fresh[0]?.key ?? null)
      for (const item of fresh) {
        void window.api.scanDetect(item.path, book).then((r) => {
          if (!r.ok) {
            update(item.key, { failed: true })
            return
          }
          // Only what detection found: a look or turn chosen meanwhile stays.
          update(item.key, {
            width: r.value.width,
            height: r.value.height,
            preview: r.value.preview,
            detected: r.value.corners,
            corners: r.value.corners,
            ...(book ? { split: r.value.split ?? null, foundSplit: r.value.split ?? null } : {})
          })
          refresh(item.key)
        })
      }
    },
    [goal, refresh, update, book]
  )
  const pick = async (): Promise<void> => {
    const paths = await window.api.pickImages(book)
    if (paths.length) add(paths)
  }
  /** The fold found again, after the outline or turn changed. */
  const findFold = async (item: Item): Promise<void> => {
    const r = await window.api.scanFold(specOf(item, true))
    if (!r.ok) return
    const split = r.value ?? 0.5
    change(item, { split, foundSplit: split })
  }
  const scan = async (): Promise<void> => {
    setScanning(true)
    const r = await window.api.scannerAcquire()
    setScanning(false)
    if (!r.ok) toast('error', r.error.message)
    else if (r.value) add([r.value])
  }
  useEffect(() => {
    const onAdd = (e: Event): void => add((e as CustomEvent<string[]>).detail)
    window.addEventListener('powerpdf:images-add', onAdd)
    return () => window.removeEventListener('powerpdf:images-add', onAdd)
  }, [add])

  const change = (item: Item, patch: Partial<Item>): void => {
    update(item.key, patch)
    refresh(item.key)
  }
  const current = items.find((x) => x.key === selected) ?? items[0] ?? null
  const usable = items.filter((x) => !x.failed && x.preview)
  const ready = idCard ? usable.length >= 1 : usable.length > 0

  const make = async (): Promise<void> => {
    const specs: ScanItem[] = usable.map((x) => specOf(x, book))
    if (idCard) {
      await newDocument(() => window.api.scanToPdf(specs, 'idcard', 'a4'), t('tool.scanIdCard'))
      return
    }
    if (!(await newDocument(() => window.api.scanToPdf(specs, book ? 'book' : 'pages', office ? 'fit' : paper, rtl), t(`tool.${goal}`)))) return
    const id = useStore.getState().active
    if (!id) return
    if (office || searchable) await apply(id, { op: 'ocr', language, redo: false }, t('tool.ocr'))
    if (!office) return
    const name = useStore.getState().docs[id]?.info.name ?? 'Scan.pdf'
    const path = await window.api.pickExportPath(name, office)
    if (!path) return
    const r = await runBusy(t('convert.working'), () => window.api.exportOffice(id, { format: office, pages: null, pageBreaks: true, removeTatweel: true, digits: 'keep', sheets: 'tables' }, path))
    if (!r) return
    void window.api.openConverted(r.path)
    toast('success', t('scan.saved', { name: r.path.split(/[\\/]/).pop() ?? r.path }), { label: t('showInFolder'), run: () => void window.api.showInFolder(r.path) })
  }

  // The strip: an ID card's two sides in their places (empty ones to fill), or every picture in order.
  const strip: Array<{ item: Item | undefined; i: number }> = idCard
    ? (['front', 'back'] as const).map((side, i) => ({ item: items.find((x) => x.side === side), i }))
    : items.map((item, i) => ({ item, i }))
  return (
    <div className="flex h-full min-h-0 flex-col" data-scan-view={goal}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <Icon size={20} className="text-brand" />
        <h1 className="me-3 text-[16px] font-semibold">{t(`tool.${goal}`)}</h1>
        <Button icon={<ImagePlus size={15} />} disabled={idCard && items.length >= 2} onClick={() => void pick()} data-scan-add="">
          {t(book ? 'scan.addPages' : 'scan.addPhotos')}
        </Button>
        <Button icon={scanning ? <Spinner size={14} /> : <ScanLine size={15} />} disabled={scanning || (idCard && items.length >= 2)} onClick={() => void scan()} data-scan-scanner="">
          {t('scan.fromScanner')}
        </Button>
        <span className="flex-1" />
        {items.length > 0 && !idCard && <span className="text-[12px] text-muted">{t('images.count', { count: items.length })}</span>}
        <Button onClick={() => openTool(null)}>{t('cancel')}</Button>
        <Button variant="primary" icon={<Icon size={15} />} disabled={!ready} onClick={() => void make()} data-scan-go="">
          {t(`scan.go.${goal}`)}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {items.length === 0 && reading === 0 ? (
          <div className="min-w-0 flex-1 overflow-y-auto bg-sunken p-6">
            <div className="mx-auto mt-8 flex w-full max-w-2xl flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-12 text-center" data-scan-empty="">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Upload size={26} />
              </span>
              <span className="text-[15px] font-semibold">{t(idCard ? 'scan.emptyCard' : book ? 'scan.emptyBook' : 'scan.empty')}</span>
              <span className="max-w-md text-[13px] text-muted">{t(idCard ? 'scan.emptyCardHint' : book ? 'scan.emptyBookHint' : 'scan.emptyHint')}</span>
              <div className="mt-1 flex gap-2">
                <Button variant="primary" icon={<ImagePlus size={15} />} onClick={() => void pick()}>
                  {t(book ? 'scan.addPages' : 'scan.addPhotos')}
                </Button>
                <Button icon={<ScanLine size={15} />} onClick={() => void scan()}>
                  {t('scan.fromScanner')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* The pictures, each with how it comes out. */}
            <div className="flex w-[176px] shrink-0 flex-col gap-3 overflow-y-auto border-e border-line bg-sunken p-3" data-scan-strip="">
              {strip.map(({ item, i }) => {
                if (!item)
                  return (
                    <button
                      key={`slot${i}`}
                      type="button"
                      onClick={() => void pick()}
                      className="flex h-[118px] flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-line text-muted hover:border-accent hover:text-accent"
                    >
                      <Plus size={20} />
                      <span className="text-[12px] font-medium">{t(i === 0 ? 'scan.front' : 'scan.back')}</span>
                    </button>
                  )
                return (
                  <div
                    key={item.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(item.key)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(item.key)}
                    className={clsx('group relative flex flex-col overflow-hidden rounded-xl border bg-surface shadow-sm', current?.key === item.key ? 'border-accent ring-3 ring-accent/20' : 'border-line hover:border-faint')}
                    data-scan-card=""
                  >
                    <div className="flex h-[118px] items-center justify-center bg-surface-2 p-2">
                      {item.result ? (
                        <div className="flex h-full max-w-full items-center justify-center gap-0.5">
                          {item.result.map((src, p) => (
                            <img key={p} src={src} alt="" draggable={false} className={clsx('max-h-full min-w-0 shadow-sm', item.result!.length > 1 ? 'max-w-[50%]' : 'max-w-full')} />
                          ))}
                        </div>
                      ) : item.failed ? <span className="text-[12px] text-danger">{t('cannotRead')}</span> : <Spinner size={16} />}
                    </div>
                    <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5">
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-ink/75 px-1.5 text-[11px] font-semibold text-surface tabular-nums">{idCard ? (i === 0 ? t('scan.frontShort') : t('scan.backShort')) : i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted" dir="auto" title={item.path}>
                        {item.name}
                      </span>
                      <button
                        type="button"
                        title={t('remove')}
                        aria-label={t('remove')}
                        onClick={(e) => {
                          e.stopPropagation()
                          setItems((now) => now.filter((x) => x.key !== item.key))
                          if (selected === item.key) setSelected(null)
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-danger focus-visible:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )
              })}
              {reading > 0 && (
                <div className="flex h-[118px] flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface text-[11px] text-muted" data-scan-reading="">
                  <Spinner size={16} />
                  {t('scan.pdfPages')}
                </div>
              )}
              {!idCard && (
                <button type="button" onClick={() => void pick()} className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-muted hover:border-accent hover:text-accent">
                  <Plus size={18} />
                  <span className="text-[11px] font-medium">{t('images.addMore')}</span>
                </button>
              )}
            </div>

            {/* The selected picture with its page's corners, to drag. */}
            <div className="flex min-w-0 flex-1 flex-col bg-sunken">
              {current && current.preview ? (
                <>
                  <CornerEditor item={current} onCorners={(corners) => change(current, { corners })} onSplit={book ? (split) => change(current, { split }) : undefined} />
                  <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line bg-surface px-4 py-2.5" data-scan-tools="">
                    <Button variant="ghost" icon={<Sparkles size={14} />} disabled={!current.detected} onClick={() => change(current, { corners: current.detected })}>
                      {t('scan.autoDetect')}
                    </Button>
                    <Button variant="ghost" icon={<Maximize2 size={14} />} onClick={() => change(current, { corners: null })}>
                      {t('scan.wholePicture')}
                    </Button>
                    <span className="mx-1 h-5 w-px bg-line" />
                    <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => change(current, { rotate: (((current.rotate - 90) % 360) + 360) % 360 as Item['rotate'] })}>
                      {t('rotateLeft')}
                    </Button>
                    <Button variant="ghost" icon={<RotateCw size={14} />} onClick={() => change(current, { rotate: ((current.rotate + 90) % 360) as Item['rotate'] })}>
                      {t('rotateRight')}
                    </Button>
                    {book && (
                      <>
                        <span className="mx-1 h-5 w-px bg-line" />
                        <Button variant="ghost" icon={<SeparatorVertical size={14} />} onClick={() => void findFold(current)} data-scan-fold="">
                          {t('scan.findFold')}
                        </Button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center">{current?.failed ? <span className="text-[13px] text-danger">{t('cannotRead')}</span> : <Spinner size={22} />}</div>
              )}
            </div>
          </>
        )}

        <aside className="flex w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-s border-line bg-surface p-5" data-scan-options="">
          {current && (
            <Option title={t('scan.look')}>
              <Segmented
                value={current.mode}
                onChange={(mode) => change(current, { mode })}
                options={[
                  { value: 'color', label: t('scan.color') },
                  { value: 'gray', label: t('scan.gray') },
                  { value: 'bw', label: t('scan.bw') },
                  { value: 'original', label: t('scan.original') }
                ]}
              />
              <p className="text-[11px] text-muted">{t(`scan.lookHint.${current.mode}`)}</p>
              {items.length > 1 && (
                <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => items.forEach((x) => x.key !== current.key && change(x, { mode: current.mode }))}>
                  {t('scan.applyAll')}
                </button>
              )}
            </Option>
          )}
          {book && current && (
            <Option title={t('scan.spread')}>
              <Segmented
                value={current.split === null || current.split === undefined ? 'one' : 'two'}
                onChange={(v) => change(current, { split: v === 'one' ? null : (current.foundSplit ?? 0.5) })}
                options={[
                  { value: 'two', label: t('scan.twoPages') },
                  { value: 'one', label: t('scan.onePage') }
                ]}
              />
              {current.split !== null && current.split !== undefined && <p className="text-[11px] text-muted">{t('scan.foldHint')}</p>}
            </Option>
          )}
          {book && (
            <Option title={t('scan.reading')}>
              <Segmented
                value={rtl ? 'rtl' : 'ltr'}
                onChange={(v) => setRtl(v === 'rtl')}
                options={[
                  { value: 'rtl', label: t('scan.rtl') },
                  { value: 'ltr', label: t('scan.ltr') }
                ]}
              />
              <p className="text-[11px] text-muted">{t(rtl ? 'scan.readingHint.rtl' : 'scan.readingHint.ltr')}</p>
            </Option>
          )}
          {(goal === 'scanDocuments' || book) && (
            <Option title={t('images.pageSize')}>
              <Segmented
                value={paper}
                onChange={setPaper}
                options={[
                  { value: 'a4', label: 'A4' },
                  { value: 'letter', label: 'Letter' },
                  { value: 'fit', label: t('scan.asScanned') }
                ]}
              />
            </Option>
          )}
          {!idCard && (
            <Option title={t('scan.text')}>
              {!office && <Check checked={searchable} onChange={setSearchable} label={t('scan.searchable')} />}
              {(office || searchable) && (
                <Select
                  value={language}
                  onChange={setLanguage}
                  label={t('ocr.language')}
                  options={[
                    { value: 'auto', label: t('ocr.auto') },
                    { value: 'ar', label: t('ocr.arabic') },
                    { value: 'en', label: t('ocr.english') }
                  ]}
                />
              )}
            </Option>
          )}
          <p className="mt-auto text-[11px] leading-relaxed text-faint">
            <ScanText size={12} className="me-1 inline align-[-2px]" />
            {t(idCard ? 'scan.noteCard' : book ? 'scan.noteBook' : office ? 'scan.noteOffice' : 'scan.note')}
          </p>
        </aside>
      </div>
    </div>
  )
}

/**
 * The picture, fitted to the space, with the page's outline and four handles to drag. Corners are
 * kept in the picture's own pixels.
 */
function CornerEditor({ item, onCorners, onSplit }: { item: Item; onCorners: (c: ScanCorners) => void; onSplit?: (split: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 600, h: 500 })
  const [drag, setDrag] = useState<{ i: number; corners: ScanCorners } | null>(null)
  const [fold, setFold] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth - 48, h: el.clientHeight - 48 })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const k = Math.min(size.w / item.width, size.h / item.height)
  const w = item.width * k
  const h = item.height * k
  const corners = drag?.corners ?? item.corners ?? whole(item.width, item.height)
  const start = (i: number) => (e: React.PointerEvent): void => {
    e.preventDefault()
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!
    const rect = svg.getBoundingClientRect()
    let live: ScanCorners = corners.map((p) => [...p]) as ScanCorners
    const move = (ev: PointerEvent): void => {
      const x = Math.max(0, Math.min(item.width, (ev.clientX - rect.left) / k))
      const y = Math.max(0, Math.min(item.height, (ev.clientY - rect.top) / k))
      live = live.map((p, j) => (j === i ? [Math.round(x), Math.round(y)] : p)) as ScanCorners
      setDrag({ i, corners: live })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDrag(null)
      onCorners(live)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // A pen or touch the system takes away ends the drag too.
    window.addEventListener('pointercancel', up)
  }
  const points = corners.map(([x, y]) => `${x * k},${y * k}`).join(' ')
  // A book's fold: a line across the outline at `split` of its width, as the result is drawn (after its turn).
  const split = fold ?? item.split
  const src = turned(corners, item.rotate)
  const along = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
  const foldTop = split != null ? along(src[0], src[1], split) : null
  const foldBottom = split != null ? along(src[3], src[2], split) : null
  const startFold = (e: React.PointerEvent): void => {
    e.preventDefault()
    const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    // The pointer projected on the line from the middle of the left edge to the middle of the right one.
    const left = along(src[0], src[3], 0.5)
    const right = along(src[1], src[2], 0.5)
    const dx = right[0] - left[0]
    const dy = right[1] - left[1]
    let live = split ?? 0.5
    const move = (ev: PointerEvent): void => {
      const x = (ev.clientX - rect.left) / k
      const y = (ev.clientY - rect.top) / k
      live = Math.round(Math.min(0.9, Math.max(0.1, ((x - left[0]) * dx + (y - left[1]) * dy) / (dx * dx + dy * dy || 1))) * 1000) / 1000
      setFold(live)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setFold(null)
      onSplit?.(live)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return (
    <div ref={box} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" data-corner-editor="">
      <div className="relative shadow-lg" style={{ width: w, height: h }}>
        <img src={item.preview!} alt="" draggable={false} className="block h-full w-full select-none" />
        <svg className="absolute inset-0 overflow-visible" width={w} height={h}>
          <defs>
            <mask id={`m${item.key}`}>
              <rect width={w} height={h} fill="white" />
              <polygon points={points} fill="black" />
            </mask>
          </defs>
          {/* Outside the page is dimmed, as scanner apps show it. */}
          <rect width={w} height={h} fill="rgba(0,0,0,0.38)" mask={`url(#m${item.key})`} />
          <polygon points={points} fill="none" stroke="var(--accent)" strokeWidth={2} />
          {onSplit && foldTop && foldBottom && (
            <g data-fold="">
              <line x1={foldTop[0] * k} y1={foldTop[1] * k} x2={foldBottom[0] * k} y2={foldBottom[1] * k} stroke="var(--accent)" strokeWidth={2} strokeDasharray="7 5" />
              {/* A wide invisible line makes the fold easy to grab anywhere along it. */}
              <line x1={foldTop[0] * k} y1={foldTop[1] * k} x2={foldBottom[0] * k} y2={foldBottom[1] * k} stroke="transparent" strokeWidth={16} className="cursor-ew-resize touch-none" onPointerDown={startFold} />
              <rect
                x={((foldTop[0] + foldBottom[0]) / 2) * k - 7}
                y={((foldTop[1] + foldBottom[1]) / 2) * k - 16}
                width={14}
                height={32}
                rx={7}
                fill="var(--surface)"
                stroke="var(--accent)"
                strokeWidth={3}
                className="cursor-ew-resize touch-none"
                onPointerDown={startFold}
                data-fold-handle=""
              />
            </g>
          )}
          {corners.map(([x, y], i) => (
            <circle
              key={i}
              cx={x * k}
              cy={y * k}
              r={drag?.i === i ? 11 : 9}
              fill="var(--surface)"
              stroke="var(--accent)"
              strokeWidth={3}
              className="cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={start(i)}
              data-corner={i}
            />
          ))}
        </svg>
      </div>
    </div>
  )
}

function Option({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h3>
      {children}
    </section>
  )
}

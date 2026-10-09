import clsx from 'clsx'
import { FileImage, ImagePlus, Plus, RectangleVertical, RotateCcw, RotateCw, Scan, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { newDocument, openTool, toast, useT } from '../store'
import { Button, Segmented, Select } from './ui'

/**
 * Images to PDF as a view of its own, the way the best converters show it (iLovePDF,
 * Smallpdf, Acrobat's Create PDF): each picture is a card with its thumbnail; turn or
 * remove it from the card, drag cards into order, add more with the + card or by dropping
 * files on the window; page size, orientation and margin sit in a panel beside them; one
 * button makes the PDF, which opens as a new document.
 */

interface Picture {
  key: string
  path: string
  name: string
  preview: string | null
  width: number
  height: number
  rotate: 0 | 90 | 180 | 270
  /** The photo's own EXIF turn: the preview is drawn as stored, the PDF upright (§61). */
  turn: 0 | 90 | 180 | 270
  failed?: boolean
}

const MARGINS = { none: 0, small: 10, large: 25 } as const
let counter = 0

export function ImagesView() {
  const t = useT()
  const [pictures, setPictures] = useState<Picture[]>([])
  const [paper, setPaper] = useState<'a4' | 'letter' | 'fit'>('a4')
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto')
  const [margin, setMargin] = useState<keyof typeof MARGINS>('small')
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const add = (paths: string[]): void => {
    const fresh = paths.map((path): Picture => ({ key: `i${counter++}`, path, name: path.split(/[\\/]/).pop() ?? path, preview: null, width: 1, height: 1, rotate: 0, turn: 0 }))
    setPictures((now) => [...now, ...fresh])
    for (const p of fresh) {
      void window.api.pictureInfo(p.path).then((info) =>
        setPictures((now) => now.map((x) => (x.key !== p.key ? x : info ? { ...x, preview: info.preview, width: info.width, height: info.height, turn: info.turn ?? 0 } : { ...x, failed: true })))
      )
    }
  }
  const pick = async (): Promise<void> => {
    const paths = await window.api.pickAnyImages()
    if (paths.length) add(paths)
  }

  useEffect(() => {
    const onAdd = (e: Event): void => add((e as CustomEvent<string[]>).detail)
    window.addEventListener('powerpdf:images-add', onAdd)
    return () => window.removeEventListener('powerpdf:images-add', onAdd)
  }, [])

  const turn = (key: string, by: 90 | -90): void =>
    setPictures((now) => now.map((x) => (x.key === key ? { ...x, rotate: (((x.rotate + by) % 360) + 360) % 360 as Picture['rotate'] } : x)))
  const move = (from: number, to: number): void =>
    setPictures((now) => {
      const next = [...now]
      const [x] = next.splice(from, 1)
      next.splice(to > from ? to - 1 : to, 0, x!)
      return next
    })
  const sort = (how: string): void =>
    setPictures((now) => {
      const next = [...now].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      return how === 'za' ? next.reverse() : next
    })

  const usable = pictures.filter((p) => !p.failed)
  const convert = (): void => {
    if (pictures.some((p) => p.failed)) toast('info', t('images.skipped'))
    void newDocument(
      () =>
        window.api.imagesToPdf(
          usable.map((p) => p.path),
          { paper, margin: (MARGINS[margin] * 72) / 25.4, autoOrientation: orientation === 'auto', orientation, rotations: usable.map((p) => p.rotate) }
        ),
      t('tool.imagesToPdf')
    )
  }

  const CARD = 156
  return (
    <div className="flex h-full min-h-0 flex-col" data-images-view="">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <FileImage size={20} className="text-brand" />
        <h1 className="me-3 text-[16px] font-semibold">{t('tool.imagesToPdf')}</h1>
        <Button icon={<ImagePlus size={15} />} onClick={() => void pick()}>
          {t('addPictures')}
        </Button>
        {pictures.length > 1 && (
          <div className="w-36">
            <Select
              value=""
              label={t('images.sort')}
              onChange={(v) => v && sort(v)}
              options={[
                { value: '', label: t('images.sort') },
                { value: 'az', label: t('images.sortAz') },
                { value: 'za', label: t('images.sortZa') }
              ]}
            />
          </div>
        )}
        <span className="flex-1" />
        {pictures.length > 0 && <span className="text-[12px] text-muted">{t('images.count', { count: pictures.length })}</span>}
        <Button onClick={() => openTool(null)}>{t('cancel')}</Button>
        <Button variant="primary" icon={<FileImage size={15} />} disabled={usable.length === 0} onClick={convert}>
          {t('act.imagesToPdf')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto bg-sunken p-6">
          {pictures.length === 0 ? (
            <button
              type="button"
              onClick={() => void pick()}
              className="mx-auto mt-10 flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-14 text-center transition-colors hover:border-accent hover:bg-accent-soft/40"
              data-images-empty=""
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Upload size={26} />
              </span>
              <span className="text-[15px] font-semibold">{t('images.empty')}</span>
              <span className="text-[13px] text-muted">{t('images.emptyHint')}</span>
              <span className="mt-1 rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink">{t('images.choose')}</span>
            </button>
          ) : (
            <div className="flex flex-wrap gap-4">
              {pictures.map((p, i) => {
                const turned = p.rotate === 90 || p.rotate === 270
                const total = (p.rotate + p.turn) % 360
                const drawnTurned = total === 90 || total === 270
                const ratio = turned ? p.width / p.height : p.height / p.width
                const boxH = CARD * 1.15
                // The thumbnail as it will be, turned; scaled to sit inside the card.
                const shownW = Math.min(CARD - 20, (boxH - 20) / ratio)
                const shownH = shownW * ratio
                return (
                  <div
                    key={p.key}
                    draggable
                    data-image-card=""
                    onDragStart={(e) => {
                      setDragging(p.key)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setDropAt(null)
                    }}
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      const r = e.currentTarget.getBoundingClientRect()
                      const rtl = document.documentElement.dir === 'rtl'
                      const first = rtl ? e.clientX > r.left + r.width / 2 : e.clientX < r.left + r.width / 2
                      setDropAt(first ? i : i + 1)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const from = pictures.findIndex((x) => x.key === dragging)
                      if (from >= 0 && dropAt !== null && dropAt !== from && dropAt !== from + 1) move(from, dropAt)
                      setDragging(null)
                      setDropAt(null)
                    }}
                    className={clsx(
                      'group relative flex cursor-grab flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing',
                      dragging === p.key && 'opacity-40'
                    )}
                    style={{ width: CARD }}
                  >
                    {dropAt === i && <span className="absolute -start-2.5 top-0 z-10 h-full w-1 rounded bg-accent" />}
                    {dropAt === i + 1 && i === pictures.length - 1 && <span className="absolute -end-2.5 top-0 z-10 h-full w-1 rounded bg-accent" />}
                    <div className="relative flex items-center justify-center bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:14px_14px]" style={{ height: boxH }}>
                      {p.preview ? (
                        <img
                          src={p.preview}
                          alt=""
                          draggable={false}
                          className="max-w-none rounded-[2px] shadow-sm transition-transform duration-200"
                          style={{ width: drawnTurned ? shownH : shownW, height: drawnTurned ? shownW : shownH, transform: `rotate(${total}deg)` }}
                        />
                      ) : (
                        <span className="text-[12px] text-faint">{p.failed ? t('cannotRead') : '…'}</span>
                      )}
                      <span className="absolute start-2 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-ink/75 px-1.5 text-[11px] font-semibold text-surface tabular-nums">{i + 1}</span>
                      <div className="absolute end-2 top-2 hidden gap-0.5 rounded-lg border border-line bg-surface/95 p-0.5 shadow-md group-hover:flex" dir="ltr">
                        <CardAction label={t('rotateLeft')} onClick={() => turn(p.key, -90)}>
                          <RotateCcw size={14} />
                        </CardAction>
                        <CardAction label={t('rotateRight')} onClick={() => turn(p.key, 90)}>
                          <RotateCw size={14} />
                        </CardAction>
                        <CardAction label={t('remove')} danger onClick={() => setPictures((now) => now.filter((x) => x.key !== p.key))}>
                          <Trash2 size={14} />
                        </CardAction>
                      </div>
                    </div>
                    <div className="border-t border-line px-2.5 py-2">
                      <p className={clsx('truncate text-[12px] font-medium', p.failed && 'text-danger')} dir="auto" title={p.path}>
                        {p.name}
                      </p>
                      <p className="text-[11px] text-muted tabular-nums" dir="ltr">
                        {p.preview ? `${p.width} × ${p.height}` : ''}
                      </p>
                    </div>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => void pick()}
                title={t('addPictures')}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent"
                style={{ width: CARD, minHeight: CARD * 1.15 + 50 }}
              >
                <Plus size={26} />
                <span className="text-[12px] font-medium">{t('images.addMore')}</span>
              </button>
            </div>
          )}
        </div>

        <aside className="flex w-[288px] shrink-0 flex-col gap-5 overflow-y-auto border-s border-line bg-surface p-5" data-images-options="">
          <Option title={t('images.pageSize')}>
            {(
              [
                ['a4', t('paper.a4'), '210 × 297 mm'],
                ['letter', t('paper.letter'), '8.5 × 11 in'],
                ['fit', t('images.fit'), t('images.fitHint')]
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPaper(value)}
                aria-pressed={paper === value}
                className={clsx('flex items-center gap-3 rounded-xl border px-3 py-2.5 text-start', paper === value ? 'border-accent bg-accent-soft/60 ring-3 ring-accent/15' : 'border-line hover:border-faint')}
              >
                <span className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', paper === value ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted')}>
                  {value === 'fit' ? <Scan size={16} /> : <RectangleVertical size={16} />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium">{label}</span>
                  <span className="text-[11px] text-muted">{hint}</span>
                </span>
              </button>
            ))}
          </Option>
          {paper !== 'fit' && (
            <Option title={t('images.orientation')}>
              <Segmented
                value={orientation}
                onChange={setOrientation}
                options={[
                  { value: 'auto', label: t('images.auto') },
                  { value: 'portrait', label: t('images.portrait') },
                  { value: 'landscape', label: t('images.landscape') }
                ]}
              />
              <p className="text-[11px] text-muted">{orientation === 'auto' ? t('images.autoHint') : ''}</p>
            </Option>
          )}
          <Option title={t('margin')}>
            <Segmented
              value={margin}
              onChange={setMargin}
              options={[
                { value: 'none', label: t('images.noMargin') },
                { value: 'small', label: t('images.smallMargin') },
                { value: 'large', label: t('images.largeMargin') }
              ]}
            />
          </Option>
          <p className="mt-auto text-[11px] leading-relaxed text-faint">{t('images.note')}</p>
        </aside>
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

function CardAction({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={clsx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-2', danger ? 'text-danger' : 'text-muted hover:text-ink')}>
      {children}
    </button>
  )
}

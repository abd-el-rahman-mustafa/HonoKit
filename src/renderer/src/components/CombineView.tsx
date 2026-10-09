import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Combine, FilePlus2, Files, Lock, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MergeItem } from '@shared/ipc'
import { newDocument, openTool, requestPassword, useStore, useT } from '../store'
import { Button, PageImage, Spinner } from './ui'

/**
 * Combine files, as Acrobat's: a view of its own over the whole window. Each file is a tile
 * with its first page, name and page count; add files (or drop them here), add the open
 * documents, drag tiles to reorder, remove one from its tile, then Combine at the top. The
 * result opens as a new, unsaved document; the files themselves are not changed.
 */

type Tile =
  | { key: string; kind: 'doc'; docId: string; name: string }
  | { key: string; kind: 'file'; path: string; name: string; pages: number | null; thumb: string | null; locked: boolean; password?: string; failed?: boolean }

const WIDTH = 150
let counter = 0

export function CombineView() {
  const t = useT()
  const docs = useStore((s) => s.docs)
  const order = useStore((s) => s.order)
  const active = useStore((s) => s.active)
  const [tiles, setTiles] = useState<Tile[]>(() => (active && docs[active] ? [{ key: `d${active}`, kind: 'doc', docId: active, name: docs[active]!.info.name }] : []))
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const addPaths = (paths: string[]): void => {
    const fresh: Tile[] = paths.map((path) => ({ key: `f${counter++}`, kind: 'file', path, name: path.split(/[\\/]/).pop() ?? path, pages: null, thumb: null, locked: false }))
    setTiles((now) => [...now, ...fresh])
    for (const tile of fresh) {
      if (tile.kind !== 'file') continue
      void window.api.fileThumbnail(tile.path, WIDTH * 2).then((r) => {
        setTiles((now) =>
          now.map((x) => {
            if (x.key !== tile.key || x.kind !== 'file') return x
            if (!r.ok) return { ...x, failed: true }
            const thumb = r.value.image ? URL.createObjectURL(new Blob([r.value.image.data as Uint8Array<ArrayBuffer>], { type: r.value.image.mime })) : null
            return { ...x, pages: r.value.pages, thumb, locked: r.value.locked }
          })
        )
      })
    }
  }

  // Files dropped on the window while combining are added here instead of opened.
  useEffect(() => {
    const add = (e: Event): void => addPaths((e as CustomEvent<string[]>).detail)
    window.addEventListener('powerpdf:combine-add', add)
    return () => window.removeEventListener('powerpdf:combine-add', add)
  }, [])

  const openNotIncluded = order.filter((id) => docs[id] && !tiles.some((x) => x.kind === 'doc' && x.docId === id))
  const move = (from: number, to: number): void =>
    setTiles((now) => {
      const next = [...now]
      const [x] = next.splice(from, 1)
      next.splice(to > from ? to - 1 : to, 0, x!)
      return next
    })
  const locked = tiles.filter((x) => x.kind === 'file' && x.locked && !x.password)
  const ready = tiles.length >= 2 && locked.length === 0 && !tiles.some((x) => x.kind === 'file' && x.failed)

  const combine = (): void => {
    const items: MergeItem[] = tiles.map((x) => (x.kind === 'doc' ? { docId: x.docId } : { path: x.path, ...(x.password ? { password: x.password } : {}) }))
    void newDocument(() => window.api.merge(items), t('tool.merge'))
  }

  return (
    <div className="flex h-full flex-col" data-combine="">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <Combine size={20} className="text-brand" />
        <h1 className="me-3 text-[16px] font-semibold">{t('tool.merge')}</h1>
        <Button
          icon={<FilePlus2 size={15} />}
          onClick={async () => {
            const paths = await window.api.pickPdfs(true)
            if (paths.length) addPaths(paths)
          }}
        >
          {t('addFiles')}
        </Button>
        {openNotIncluded.length > 0 && (
          <Button
            icon={<Files size={15} />}
            onClick={() => setTiles((now) => [...now, ...openNotIncluded.map((id): Tile => ({ key: `d${id}`, kind: 'doc', docId: id, name: docs[id]!.info.name }))])}
          >
            {t('addOpenFiles')}
          </Button>
        )}
        <span className="flex-1" />
        <span className="text-[12px] text-muted">{tiles.length > 0 && t('filesCount', { count: tiles.length })}</span>
        <Button onClick={() => openTool(null)}>{t('cancel')}</Button>
        <Button variant="primary" icon={<Combine size={15} />} disabled={!ready} onClick={combine}>
          {t('act.combine')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-sunken p-6">
        {tiles.length === 0 ? (
          <button
            type="button"
            onClick={async () => {
              const paths = await window.api.pickPdfs(true)
              if (paths.length) addPaths(paths)
            }}
            className="mx-auto mt-10 flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-14 text-center hover:border-accent"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Upload size={26} />
            </span>
            <span className="text-[15px] font-semibold">{t('combineEmpty')}</span>
            <span className="text-[13px] text-muted">{t('combineEmptyHint')}</span>
          </button>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-6">
              {tiles.map((tile, i) => (
                <div
                  key={tile.key}
                  draggable
                  data-combine-tile=""
                  onDragStart={(e) => {
                    setDragging(tile.key)
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
                    const from = tiles.findIndex((x) => x.key === dragging)
                    if (from >= 0 && dropAt !== null && dropAt !== from && dropAt !== from + 1) move(from, dropAt)
                    setDragging(null)
                    setDropAt(null)
                  }}
                  className={clsx('group relative flex cursor-grab flex-col items-center gap-2 rounded-xl p-2 hover:bg-surface/70', dragging === tile.key && 'opacity-40')}
                  style={{ width: WIDTH + 16 }}
                >
                  {dropAt === i && <span className="absolute -start-3 top-0 h-full w-1 rounded bg-accent" />}
                  {dropAt === i + 1 && i === tiles.length - 1 && <span className="absolute -end-3 top-0 h-full w-1 rounded bg-accent" />}
                  <div className="flex items-end justify-center" style={{ width: WIDTH, height: WIDTH * 1.3 }}>
                    <TileImage tile={tile} />
                  </div>
                  <span className="w-full truncate text-center text-[12px] font-medium" dir="auto" title={tile.kind === 'file' ? tile.path : tile.name}>
                    {tile.name}
                  </span>
                  <span className="text-[11px] text-muted">
                    {tile.kind === 'doc'
                      ? t('pages', { count: docs[tile.docId]?.info.pages.length ?? 0 })
                      : tile.failed
                        ? t('cannotRead')
                        : tile.locked
                          ? tile.password
                            ? t('passwordGiven')
                            : t('protected')
                          : tile.pages !== null
                            ? t('pages', { count: tile.pages })
                            : '…'}
                  </span>
                  {tile.kind === 'file' && tile.locked && !tile.password && (
                    <button
                      type="button"
                      className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] hover:bg-surface-2"
                      onClick={async () => {
                        const password = await requestPassword(tile.path)
                        if (password) setTiles((now) => now.map((x) => (x.key === tile.key && x.kind === 'file' ? { ...x, password } : x)))
                      }}
                    >
                      {t('enterPassword')}
                    </button>
                  )}
                  <div className="absolute end-2 top-2 hidden flex-col gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-md group-hover:flex" dir="ltr">
                    <TileAction label={t('moveEarlier')} disabled={i === 0} onClick={() => move(i, i - 1)}>
                      <ArrowLeft size={14} className="rtl:rotate-180" />
                    </TileAction>
                    <TileAction label={t('moveLater')} disabled={i === tiles.length - 1} onClick={() => move(i, i + 2)}>
                      <ArrowRight size={14} className="rtl:rotate-180" />
                    </TileAction>
                    <TileAction label={t('remove')} danger onClick={() => setTiles((now) => now.filter((x) => x.key !== tile.key))}>
                      <Trash2 size={14} />
                    </TileAction>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-[12px] text-muted">
              {tiles.length < 2 ? t('combineNeedTwo') : locked.length ? t('combineLocked') : t('combineHint')} {t('mergeHint')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function TileImage({ tile }: { tile: Tile }) {
  const docs = useStore((s) => s.docs)
  if (tile.kind === 'doc') {
    const view = docs[tile.docId]
    const p = view?.info.pages[0]
    if (!view || !p) return null
    const scale = Math.min(WIDTH / p.width, (WIDTH * 1.3) / p.height)
    return (
      <div className="page-shadow overflow-hidden rounded-sm bg-white">
        <PageImage docId={view.info.id} revision={view.info.revision} page={0} width={p.width * scale} height={p.height * scale} pointsWide={p.width} />
      </div>
    )
  }
  if (tile.thumb) return <img src={tile.thumb} alt="" className="page-shadow max-h-full max-w-full rounded-sm bg-white" draggable={false} />
  return (
    <div className="page-shadow flex items-center justify-center rounded-sm bg-white text-faint" style={{ width: WIDTH * 0.77, height: WIDTH }}>
      {tile.locked ? <Lock size={28} /> : tile.failed ? '!' : <Spinner size={18} />}
    </div>
  )
}

function TileAction({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-2 disabled:opacity-30', danger ? 'text-danger' : 'text-muted hover:text-ink')}
    >
      {children}
    </button>
  )
}

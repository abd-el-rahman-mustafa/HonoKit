import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { OpInput } from '@shared/ops'
import { useT, type DocView } from '../store'
import { IconButton, Spinner } from './ui'

/**
 * A live preview of a page tool, as Acrobat's watermark and header/footer dialogs have: the
 * page as it will look, rendered by the engine from the tool's current settings without
 * changing the document. Re-rendered shortly after the settings stop changing.
 */
export function LivePreview({ view, op, width = 248 }: { view: DocView; op: OpInput | null; width?: number }) {
  const t = useT()
  const [page, setPage] = useState(view.page)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const last = useRef<string | null>(null)
  const count = view.info.pages.length
  const size = view.info.pages[page] ?? view.info.pages[0]!
  const height = (size.height / size.width) * width
  const key = op ? JSON.stringify(op) : null

  useEffect(() => {
    if (!op) {
      setUrl(null)
      return
    }
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(() => {
      // Twice the shown size, for a sharp picture on high-density screens.
      const scale = Math.min(2, (width * 2) / size.width)
      void window.api.preview(view.info.id, op, page, scale).then((r) => {
        if (cancelled) return
        setBusy(false)
        if (!r.ok) {
          setFailed(true)
          return
        }
        setFailed(false)
        const next = URL.createObjectURL(new Blob([r.value.data as Uint8Array<ArrayBuffer>], { type: r.value.mime }))
        if (last.current) URL.revokeObjectURL(last.current)
        last.current = next
        setUrl(next)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key, page, view.info.id, view.info.revision]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => void (last.current && URL.revokeObjectURL(last.current)), [])

  return (
    <div className="flex flex-col items-center gap-2" data-live-preview="">
      <div className="relative overflow-hidden rounded-sm bg-white page-shadow" style={{ width, height }}>
        {url ? <img src={url} alt={t('preview')} className="h-full w-full" draggable={false} /> : null}
        {!url && !busy && <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-faint">{failed ? t('previewFailed') : t('previewEmpty')}</div>}
        {busy && (
          <div className="absolute end-2 top-2 rounded-full bg-surface/90 p-1 shadow">
            <Spinner size={14} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 text-[12px] text-muted" dir="ltr">
        <IconButton label={t('previous')} disabled={page === 0} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="tabular-nums">{t('pageNOfM', { n: page + 1, m: count })}</span>
        <IconButton label={t('next')} disabled={page >= count - 1} onClick={() => setPage(page + 1)}>
          <ChevronRight size={14} />
        </IconButton>
      </div>
    </div>
  )
}

import clsx from 'clsx'
import { Copy, FileImage, FileText, FolderOpen, GripVertical, Mail, Share2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Result, ShareFile } from '@shared/ipc'
import { formatBytes } from '../i18n'
import { commitTyping, toast, useStore, useT, type DocView } from '../store'
import { Spinner } from './ui'

/**
 * Share, offline (docs/research-files-share-style.md B.3): a menu under the Share button.
 * Its first row is the file itself — drag it into an email, a chat or a folder — then the
 * Windows share window, a new email with the file attached, copy the file (paste it
 * anywhere), and show it in its folder. With unsaved changes, a copy that includes them is
 * shared; the document is not saved behind the person's back.
 */
export function ShareMenu({ view }: { view: DocView }) {
  return <ShareButton name={view.info.name} prepare={async () => (await commitTyping(view.info.id), window.api.shareFile(view.info.id))} version={`${view.info.id}-${view.info.revision}`} />
}

/** The picture viewer's Share (§75): the picture file itself. */
export function SharePictureMenu({ path, name }: { path: string; name: string }) {
  return <ShareButton name={name} picture prepare={() => window.api.sharePicture(path)} version={path} />
}

/** The Share button and its menu, for any file `prepare` readies; `version` changes when the file does. */
function ShareButton({ name, picture, prepare, version }: { name: string; picture?: boolean; prepare: () => Promise<Result<ShareFile>>; version: string }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<ShareFile | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setFile(null)
    void prepare().then((r) => {
      if (cancelled) return
      if (r.ok) setFile(r.value)
      else {
        toast('error', r.error.message)
        setOpen(false)
      }
    })
    const down = (e: MouseEvent): void => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      cancelled = true
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [open, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: 'sheet' | 'email' | 'copy' | 'folder'): Promise<void> => {
    if (!file) return
    const r = button.current?.getBoundingClientRect()
    const at = r ? { x: r.left + r.width / 2, y: r.bottom } : undefined
    setBusy(action)
    const outcome = await window.api.shareAction(file.path, action, at)
    setBusy(null)
    setOpen(false)
    if (outcome === 'failed') toast('error', t('share.failed'))
    else if (outcome === 'fallback') toast('info', t('share.fallback'))
    else if (outcome === 'done' && action === 'copy') toast('success', t('share.copied'))
  }

  const rect = open ? button.current?.getBoundingClientRect() : undefined
  const rtl = document.documentElement.dir === 'rtl'
  const mailHint = file?.mail === 'outlook' ? t('share.mailOutlook') : file?.mail === 'thunderbird' ? t('share.mailThunderbird') : t('share.mailSheet')

  return (
    <>
      <button
        ref={button}
        type="button"
        title={t('share.title')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={clsx('ms-1 inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium', open ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}
        data-share-button=""
      >
        <Share2 size={15} />
        <span className="@max-[860px]:hidden">{t('share.title')}</span>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className="fixed z-[60] w-[340px] rounded-2xl border border-line bg-surface p-2 text-ink shadow-2xl"
            style={{ top: rect.bottom + 6, ...(rtl ? { left: Math.max(8, rect.left) } : { left: Math.min(window.innerWidth - 348, rect.right - 340) }) }}
            data-share-menu=""
          >
            {/* The file itself: drag it anywhere that takes files. */}
            <div
              draggable={!!file}
              onDragStart={(e) => {
                e.preventDefault()
                if (file) window.api.startDragOut(file.path)
              }}
              className={clsx('flex items-center gap-3 rounded-xl border border-dashed border-line bg-surface-2 px-3 py-2.5', file ? 'cursor-grab active:cursor-grabbing' : 'opacity-70')}
              title={t('share.dragHint')}
              data-share-drag=""
            >
              <span className="flex h-10 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-brand shadow-sm">
                {picture ? <FileImage size={20} /> : <FileText size={20} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold" dir="auto">
                  {name}
                </span>
                <span className="text-[11px] text-muted">{file ? `${formatBytes(language, file.bytes)} · ${t('share.dragHint')}` : t('share.preparing')}</span>
              </span>
              {file ? <GripVertical size={16} className="shrink-0 text-faint" /> : <Spinner size={14} />}
            </div>
            {file?.temporary && <p className="px-2 pt-2 text-[11px] leading-snug text-warn">{t('share.unsavedNote')}</p>}
            <div className="mt-1.5 flex flex-col">
              <ShareItem icon={<Share2 size={17} />} label={t('share.sheet')} hint={t('share.sheetHint')} busy={busy === 'sheet'} disabled={!file || !!busy} onClick={() => void act('sheet')} />
              {file?.mail !== 'none' && <ShareItem icon={<Mail size={17} />} label={t('share.email')} hint={mailHint} busy={busy === 'email'} disabled={!file || !!busy} onClick={() => void act('email')} />}
              <ShareItem icon={<Copy size={17} />} label={t('share.copy')} hint={t('share.copyHint')} busy={busy === 'copy'} disabled={!file || !!busy} onClick={() => void act('copy')} />
              <ShareItem icon={<FolderOpen size={17} />} label={t('share.folder')} busy={busy === 'folder'} disabled={!file || !!busy} onClick={() => void act('folder')} />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function ShareItem({ icon, label, hint, busy, disabled, onClick }: { icon: React.ReactNode; label: string; hint?: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-surface-2 disabled:opacity-50">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{busy ? <Spinner size={14} /> : icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium">{label}</span>
        {hint && <span className="text-[11px] leading-snug text-muted">{hint}</span>}
      </span>
    </button>
  )
}

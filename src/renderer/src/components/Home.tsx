import clsx from 'clsx'
import { ChevronRight, Clock, FileImage, FileInput, Plus, Trash2, FileText, Folder, FolderOpen, FolderPlus, Image as ImageIcon, Search, Settings as SettingsIcon, Upload, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BRAND } from '@shared/brand'
import mark from '../../../../build/icon.svg'
import markSmall from '../../../../build/icon-small.svg'
import type { Place } from '@shared/ipc'
import { fileKind } from '@shared/opening'
import { recentOfKind, type RecentKind } from '@shared/recent'
import { formatBytes } from '../i18n'
import { changeSettings, newDocument, openAny, openAnyWithPicker, openPictureWithPicker, openTool, openWithPicker, setDialog, setHomeSection, STANDALONE_TOOLS, useStore, useT, type ToolId } from '../store'
import { Select } from './ui'
import { HUB_LABEL, HUBS, TOOLS, type Hub } from '../tools/catalogue'
import { PlaceIcon, placeLabel } from './Overlays'

/**
 * The Home screen, as Acrobat's: a navigation column (Recent, PDF tools, Image tools, places,
 * Open, Settings). Recent shows the two hubs as cards (decisions §75), new documents, an open
 * card and the recent files as a table with size and date, PDFs and pictures on two tabs (§83). Each hub
 * shows its own tools in groups, with a filter.
 */

/** The look of each hub: its icon, and the hue of its card and tile. */
const HUB_STYLE: Record<Hub, { icon: typeof FileText; hue: number; sample: ToolId[] }> = {
  pdf: { icon: FileText, hue: 245, sample: ['edit', 'sign', 'merge', 'compress', 'toWord', 'organize'] },
  images: { icon: ImageIcon, hue: 160, sample: ['imgCompress', 'imgResize', 'imgConvert', 'imgRemoveBg', 'imgUpscale', 'imgEditor'] }
}

const toolsOf = (hub: Hub): typeof TOOLS => TOOLS.filter((x) => HUBS[hub].includes(x.group))

export function Home() {
  const t = useT()
  const section = useStore((s) => s.homeSection)
  const setSection = setHomeSection
  const [places, setPlaces] = useState<Place[]>([])
  const linked = useStore((s) => s.settings?.places)
  useEffect(() => void window.api.places().then(setPlaces), [linked])
  const place = places.find((p) => p.path === section)
  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[220px] shrink-0 flex-col gap-0.5 border-e border-line bg-surface p-3" aria-label={t('home')}>
        <NavItem icon={<Clock size={17} />} label={t('recent')} active={section === 'recent'} onClick={() => setSection('recent')} nav="recent" />
        <NavItem icon={<FileText size={17} />} label={t('hub.pdf')} active={section === 'pdf'} onClick={() => setSection('pdf')} nav="pdf" />
        <NavItem icon={<ImageIcon size={17} />} label={t('group.images')} active={section === 'images'} onClick={() => setSection('images')} nav="images" />
        {places.length > 0 && <p className="mt-3 px-2.5 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{t('home.places')}</p>}
        {places.map((p) => (
          <NavItem key={p.path} icon={<PlaceIcon kind={p.kind} />} label={placeLabel(p)} active={section === p.path} onClick={() => setSection(p.path)} />
        ))}
        <NavItem icon={<FolderPlus size={17} />} label={t('places.add')} onClick={() => setDialog({ kind: 'settings', page: 'places' })} />
        <div className="my-2 h-px bg-line" />
        <NavItem icon={<FolderOpen size={17} />} label={t('openAny')} onClick={() => void openAnyWithPicker()} />
        <NavItem icon={<SettingsIcon size={17} />} label={t('settings')} onClick={() => setDialog({ kind: 'settings' })} />
        <span className="flex-1" />
        <p className="px-2 text-[11px] leading-relaxed text-faint">{t('appTagline')}</p>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto" data-home={section}>
        {place ? (
          <FolderView key={place.path} root={place} />
        ) : section === 'pdf' || section === 'images' ? (
          <HubView key={section} hub={section} onHub={setSection} />
        ) : (
          <RecentView onHub={setSection} />
        )}
      </div>
    </div>
  )
}

function NavItem({ icon, label, active, onClick, nav }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void; nav?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-nav={nav}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        active ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-surface-2'
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function startTool(id: ToolId): void {
  if (STANDALONE_TOOLS.includes(id)) openTool(id)
  else void openWithPicker(id)
}

function RecentView({ onHub }: { onHub: (hub: Hub) => void }) {
  const t = useT()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-7 px-8 py-8">
      <header className="flex items-center gap-3">
        <Logo size={34} />
        <h1 className="text-[22px] font-semibold tracking-tight">{t('welcome', { name: BRAND.name })}</h1>
      </header>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4" data-hubs="">
        <HubCard hub="pdf" onOpen={() => onHub('pdf')} />
        <HubCard hub="images" onOpen={() => onHub('images')} />
      </section>

      <NewDocumentRow />

      <div className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-5 text-start" data-drop-card="">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Upload size={22} />
        </span>
        <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{t('open.title')}</span>
          <span className="text-[13px] leading-snug text-muted">{t('open.subtitle')}</span>
        </span>
        <span className="flex shrink-0 flex-wrap gap-2">
          <OpenButton primary icon={<FileText size={15} />} label={t('openPdf')} onClick={() => void openWithPicker()} />
          <OpenButton icon={<ImageIcon size={15} />} label={t('openImage')} onClick={() => void openPictureWithPicker()} />
        </span>
      </div>

      <RecentTable />
    </div>
  )
}

function OpenButton({ icon, label, primary, onClick }: { icon: React.ReactNode; label: string; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        primary ? 'bg-accent text-accent-ink hover:brightness-110' : 'border border-line bg-surface hover:bg-surface-2'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** One of the two hubs on Recent: its name, what it does, a few of its tools, and how many there are. */
function HubCard({ hub, onOpen }: { hub: Hub; onOpen: () => void }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const { icon: Icon, hue, sample } = HUB_STYLE[hub]
  const count = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US').format(toolsOf(hub).length)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-w-0 flex-col gap-3 rounded-2xl border border-line p-5 text-start transition-[box-shadow,border-color] hover:border-[color:var(--hub)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      style={{ '--hub': `hsl(${hue} 70% 55%)`, background: `linear-gradient(120deg, color-mix(in srgb, hsl(${hue} 80% 55%) 11%, var(--surface)), var(--surface) 70%)` } as React.CSSProperties}
      data-hub-card={hub}
    >
      <span className="flex w-full items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: `hsl(${hue} 80% 55% / 0.16)`, color: `hsl(${hue} 65% 45%)` }}>
          <Icon size={23} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[17px] font-semibold tracking-tight">{t(HUB_LABEL[hub])}</span>
          <span className="text-[12px] text-muted">{t('hub.count', { count })}</span>
        </span>
        <ChevronRight size={20} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
      </span>
      <span className="text-[13px] leading-snug text-muted">{t(hub === 'pdf' ? 'hub.pdf.desc' : 'hub.images.desc')}</span>
      <span className="flex flex-wrap gap-1.5" aria-hidden="true">
        {sample.map((id) => {
          const entry = TOOLS.find((x) => x.id === id)!
          const ToolIcon = entry.icon
          return (
            <span key={id} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface" title={t(`tool.${id}`)} style={{ color: `hsl(${entry.hue} 68% 46%)` }}>
              <ToolIcon size={16} />
            </span>
          )
        })}
      </span>
    </button>
  )
}

/**
 * Recent files on two tabs, PDFs and Images (owner, 2026-10-09; as Android's §53): a segmented
 * control under the heading, the tab kept across launches (settings `recentTab`), each tab listing
 * only its kind with its own empty message. Clear empties the tab shown.
 */
function RecentTable() {
  const t = useT()
  const recent = useStore((s) => s.settings?.recent ?? [])
  const tab = useStore((s) => s.settings?.recentTab ?? 'pdf')
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [info, setInfo] = useState<Record<string, { size: number | null; modified: number | null }>>({})
  useEffect(() => {
    if (!recent.length) return
    void window.api.fileInfo(recent).then((rows) => setInfo(Object.fromEntries(rows.map((r) => [r.path, r]))))
  }, [recent])
  const date = (ms: number): string => new Intl.DateTimeFormat(language === 'ar' ? 'ar-AE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  const shown = recentOfKind(recent, tab)
  const picture = tab === 'image'
  return (
    <section className="flex flex-col gap-2.5" data-recent={tab}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{t('recent')}</h2>
        {shown.length > 0 && (
          <button
            type="button"
            title={t(picture ? 'clearRecentImages' : 'clearRecentPdfs')}
            aria-label={t(picture ? 'clearRecentImages' : 'clearRecentPdfs')}
            className="rounded-full px-3 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
            onClick={async () => useStore.setState({ settings: await window.api.forgetRecent(undefined, tab) })}
          >
            {t('clearRecent')}
          </button>
        )}
      </div>
      <RecentTabs tab={tab} counts={{ pdf: recentOfKind(recent, 'pdf').length, image: recentOfKind(recent, 'image').length }} />
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-4 py-7 text-center" role="tabpanel" id="recent-panel" aria-labelledby={`recent-tab-${tab}`} data-recent-empty="">
          {picture ? <FileImage size={26} className="text-faint" /> : <FileText size={26} className="text-faint" />}
          <p className="max-w-[46ch] text-[13px] leading-relaxed text-muted">{t(picture ? 'noRecentImages' : 'noRecentPdfs')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface" role="tabpanel" id="recent-panel" aria-labelledby={`recent-tab-${tab}`}>
          <div className="grid grid-cols-[1fr_120px_170px_36px] items-center gap-3 border-b border-line px-4 py-2 text-[11px] font-semibold tracking-wider text-muted uppercase" role="row">
            <span>{t('name')}</span>
            <span>{t('fileSize')}</span>
            <span>{t('modified')}</span>
            <span />
          </div>
          {shown.map((path) => {
            const row = info[path]
            const missing = row && row.size === null
            return (
              <div key={path} className="group grid grid-cols-[1fr_120px_170px_36px] items-center gap-3 border-b border-line px-4 last:border-b-0 hover:bg-surface-2" role="row">
                <button
                  type="button"
                  onClick={() => void openAny([path])}
                  className="flex min-w-0 items-center gap-3 rounded-md py-2.5 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                  disabled={missing}
                  data-recent-kind={fileKind(path) ?? ''}
                >
                  <FileKindIcon path={path} size={20} faint={missing} />
                  <span className="flex min-w-0 flex-col">
                    <span className={clsx('truncate text-[13px] font-medium', missing && 'text-faint line-through')} dir="auto">
                      {path.split(/[\\/]/).pop()}
                    </span>
                    <span className="truncate text-[11px] text-faint" dir="ltr">
                      {missing ? t('missingFile') : path}
                    </span>
                  </span>
                </button>
                <span className="text-[12px] text-muted tabular-nums">{row?.size != null ? formatBytes(language, row.size) : '—'}</span>
                <span className="text-[12px] text-muted">{row?.modified != null ? date(row.modified) : '—'}</span>
                <button
                  type="button"
                  title={t('remove')}
                  aria-label={t('remove')}
                  className="rounded p-1.5 text-faint opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={async () => useStore.setState({ settings: await window.api.forgetRecent(path) })}
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** PDFs | Images: a segmented control (tabs to assistive technology); the arrow keys move between them. */
function RecentTabs({ tab, counts }: { tab: RecentKind; counts: Record<RecentKind, number> }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const number = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US')
  const choose = (kind: RecentKind, focus = false): void => {
    if (kind !== tab) void changeSettings({ recentTab: kind })
    if (focus) document.getElementById(`recent-tab-${kind}`)?.focus()
  }
  const options: Array<{ kind: RecentKind; label: string; icon: React.ReactNode }> = [
    { kind: 'pdf', label: t('recentTabPdfs'), icon: <FileText size={15} /> },
    { kind: 'image', label: t('recentTabImages'), icon: <ImageIcon size={15} /> }
  ]
  return (
    <div
      role="tablist"
      aria-label={t('recent')}
      className="inline-flex w-fit max-w-full items-center gap-0.5 self-start rounded-[10px] border border-line bg-surface-2 p-[3px]"
      data-recent-tabs=""
      onKeyDown={(e) => {
        // Two tabs: either arrow goes to the other one (in Arabic too); Home and End to the first and last.
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') choose(tab === 'pdf' ? 'image' : 'pdf', true)
        else if (e.key === 'Home') choose('pdf', true)
        else if (e.key === 'End') choose('image', true)
        else return
        e.preventDefault()
      }}
    >
      {options.map((o) => {
        const on = o.kind === tab
        return (
          <button
            key={o.kind}
            id={`recent-tab-${o.kind}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls="recent-panel"
            tabIndex={on ? 0 : -1}
            onClick={() => choose(o.kind)}
            data-recent-tab={o.kind}
            className={clsx(
              'flex h-8 min-w-[104px] items-center justify-center gap-2 rounded-[7px] px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
              on ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:bg-surface hover:text-ink'
            )}
          >
            <span className={clsx('shrink-0', on && (o.kind === 'image' ? 'text-[hsl(160_60%_40%)]' : 'text-brand'))}>{o.icon}</span>
            <span>{o.label}</span>
            <span className={clsx('min-w-5 rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums', on ? 'bg-accent-soft text-accent' : 'bg-surface text-faint')}>{number.format(counts[o.kind])}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A PDF's or a picture's icon in the file lists. */
function FileKindIcon({ path, size, faint }: { path: string; size: number; faint?: boolean }) {
  const picture = fileKind(path) === 'image'
  const Icon = picture ? FileImage : FileText
  return <Icon size={size} className={clsx('shrink-0', faint ? 'text-faint' : picture ? 'text-[hsl(160_60%_40%)]' : 'text-brand')} />
}

/**
 * A storage place on Home (a cloud drive's folder, a linked folder): its folders, PDFs and pictures,
 * with a path to go back up. Opening a file here and saving works on the drive directly.
 */
function FolderView({ root }: { root: Place }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [path, setPath] = useState(root.path)
  const [items, setItems] = useState<Array<{ name: string; path: string; folder: boolean; size: number; modified: number }> | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    setItems(null)
    void window.api.listFolder(path).then(setItems)
  }, [path])
  const crumbs = path
    .slice(root.path.length)
    .split(/[\\/]/)
    .filter(Boolean)
  const q = filter.trim().toLowerCase()
  const shown = (items ?? []).filter((x) => !q || x.name.toLowerCase().includes(q))
  const date = (ms: number): string => new Intl.DateTimeFormat(language === 'ar' ? 'ar-AE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-8 py-8" data-folder-view="">
      <header className="flex flex-wrap items-center gap-3">
        <PlaceIcon kind={root.kind} />
        <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[18px] font-semibold" aria-label={t('home.path')}>
          <button type="button" className="hover:underline" onClick={() => setPath(root.path)}>
            {placeLabel(root)}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={16} className="text-faint rtl:rotate-180" />
              <button type="button" className="hover:underline" dir="auto" onClick={() => setPath([root.path, ...crumbs.slice(0, i + 1)].join('\\'))}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex h-9 w-60 items-center gap-2 rounded-full border border-line bg-surface px-3 focus-within:border-accent">
          <Search size={15} className="text-faint" />
          <input className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" dir="auto" placeholder={t('home.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </header>
      <p className="text-[12px] text-muted" dir="ltr">
        {path}
      </p>
      {items === null ? (
        <p className="text-[13px] text-muted">{t('loading')}</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-[13px] text-faint">{t('home.emptyFolder')}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface" role="table">
          <div className="grid grid-cols-[1fr_110px_170px] items-center gap-3 border-b border-line px-4 py-2 text-[11px] font-semibold tracking-wider text-muted uppercase" role="row">
            <span>{t('name')}</span>
            <span>{t('fileSize')}</span>
            <span>{t('modified')}</span>
          </div>
          {shown.map((x) => (
            <button
              key={x.path}
              type="button"
              role="row"
              onClick={() => (x.folder ? setPath(x.path) : void openAny([x.path]))}
              className="grid w-full grid-cols-[1fr_110px_170px] items-center gap-3 border-b border-line px-4 py-2.5 text-start last:border-b-0 hover:bg-surface-2"
            >
              <span className="flex min-w-0 items-center gap-3">
                {x.folder ? <Folder size={19} className="shrink-0 text-accent" /> : <FileKindIcon path={x.path} size={19} />}
                <span className="truncate text-[13px] font-medium" dir="auto">
                  {x.name}
                </span>
              </span>
              <span className="text-[12px] text-muted tabular-nums">{x.folder ? '' : formatBytes(language, x.size)}</span>
              <span className="text-[12px] text-muted">{date(x.modified)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One hub (decisions §75): every PDF tool, or every image tool, as a card in its groups, with a
 * filter. Tools of the other hub that match the filter are offered underneath.
 */
function HubView({ hub, onHub }: { hub: Hub; onHub: (hub: Hub) => void }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const match = (id: ToolId): boolean => !q || t(`tool.${id}`).toLowerCase().includes(q) || t(`tool.${id}.desc`).toLowerCase().includes(q)
  const other: Hub = hub === 'pdf' ? 'images' : 'pdf'
  const elsewhere = q ? toolsOf(other).filter((x) => match(x.id)) : []
  const shown = toolsOf(hub).filter((x) => match(x.id))
  const { icon: Icon, hue } = HUB_STYLE[hub]
  const count = new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-US').format(toolsOf(hub).length)
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-8" data-hub={hub}>
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `hsl(${hue} 80% 55% / 0.16)`, color: `hsl(${hue} 65% 45%)` }}>
          <Icon size={21} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{t(HUB_LABEL[hub])}</h1>
          <span className="text-[12px] text-muted">{t('hub.count', { count })}</span>
        </div>
        <span className="flex-1" />
        <div className="flex h-9 w-72 max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 focus-within:border-focus">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
            dir="auto"
            placeholder={t(hub === 'pdf' ? 'hub.find.pdf' : 'hub.find.images')}
            aria-label={t(hub === 'pdf' ? 'hub.find.pdf' : 'hub.find.images')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
        </div>
        <OpenButton icon={hub === 'pdf' ? <FileText size={15} /> : <ImageIcon size={15} />} label={t(hub === 'pdf' ? 'openPdf' : 'openImage')} onClick={() => void (hub === 'pdf' ? openWithPicker() : openPictureWithPicker())} />
      </header>
      {HUBS[hub].map((group) => {
        const tools = shown.filter((x) => x.group === group)
        if (!tools.length) return null
        return (
          <section key={group} className="flex flex-col gap-3">
            {HUBS[hub].length > 1 && <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t(`group.${group}`)}</h2>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {tools.map(({ id }) => (
                <ToolCard key={id} id={id} />
              ))}
            </div>
          </section>
        )
      })}
      {q && !shown.length && <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-[13px] text-faint">{t('hub.none')}</p>}
      {elsewhere.length > 0 && (
        <section className="flex flex-col gap-3 border-t border-line pt-5" data-hub-elsewhere="">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            {t('hub.alsoIn', { hub: t(HUB_LABEL[other]) })}
            <button type="button" onClick={() => onHub(other)} className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent-soft">
              {t('seeAllTools')}
              <ChevronRight size={13} className="rtl:rotate-180" />
            </button>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {elsewhere.map(({ id }) => (
              <ToolCard key={id} id={id} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ToolCard({ id }: { id: ToolId }) {
  const t = useT()
  const { icon: Icon, hue } = TOOLS.find((x) => x.id === id)!
  return (
    <button
      type="button"
      onClick={() => startTool(id)}
      className="flex min-w-0 items-start gap-3 rounded-xl border border-line bg-surface p-4 text-start transition-[box-shadow,border-color] hover:border-[color:var(--faint)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: `hsl(${hue} 80% 55% / 0.14)`, color: `hsl(${hue} 68% 44%)` }}>
        <Icon size={20} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-semibold">{t(`tool.${id}`)}</span>
        <span className="text-[12px] leading-snug text-muted">{t(`tool.${id}.desc`)}</span>
      </span>
    </button>
  )
}

/**
 * The application's mark: build/icon.svg itself (decisions §72), shown as a picture so each
 * copy keeps its own gradients and there is only one drawing to change. Small copies (the title
 * bar's) use build/icon-small.svg, the same mark with fewer details, as Windows does at 16–48 px.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return <img src={size <= 24 ? markSmall : mark} width={size} height={size} alt="" aria-hidden="true" draggable={false} className="shrink-0 select-none" />
}

/** Paper sizes for a new document, in points (portrait). */
const PAPER = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28] } as const
type Paper = keyof typeof PAPER

/**
 * "Start a new document", as Google Docs' and Word's start screens: a blank page (upright or
 * sideways) in the chosen paper size, then the person's own templates — PDFs they added,
 * each opened as a new untitled copy — and a card to add more (docs/decisions.md §43).
 */
function NewDocumentRow() {
  const t = useT()
  const [paper, setPaper] = useState<Paper>('a4')
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([])
  useEffect(() => void window.api.templates().then(setTemplates), [])
  const blank = (landscape: boolean): void => {
    const [w, h] = PAPER[paper]
    void newDocument(() => window.api.newBlank(landscape ? h : w, landscape ? w : h, 1, `${t('untitled')}.pdf`), t('create.blank'), false)
  }
  return (
    <section className="flex flex-col gap-3" data-new-document="">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{t('create.title')}</h2>
        <span className="ms-auto text-[12px] text-muted">{t('create.paper')}</span>
        <div className="w-32">
          <Select
            compact
            className="w-full"
            label={t('create.paper')}
            value={paper}
            onChange={setPaper}
            options={[
              { value: 'a4', label: 'A4' },
              { value: 'letter', label: 'Letter' },
              { value: 'legal', label: 'Legal' },
              { value: 'a3', label: 'A3' },
              { value: 'a5', label: 'A5' }
            ]}
          />
        </div>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-1">
        <StartCard label={t('create.blank')} sub={t('create.portrait')} onClick={() => blank(false)}>
          <BlankPage landscape={false} />
        </StartCard>
        <StartCard label={t('create.blank')} sub={t('create.landscape')} onClick={() => blank(true)}>
          <BlankPage landscape />
        </StartCard>
        {templates.map((tpl) => (
          <StartCard
            key={tpl.path}
            label={tpl.name}
            sub={t('create.template')}
            onClick={() => void newDocument(() => window.api.newFromTemplate(tpl.path, `${tpl.name}.pdf`), t('create.template'), false)}
            onRemove={async () => setTemplates(await window.api.removeTemplate(tpl.path))}
          >
            <TemplateThumb path={tpl.path} />
          </StartCard>
        ))}
        <StartCard label={t('create.fromFile')} sub={t('create.fromFileHint')} onClick={() => openTool('createPdf')}>
          <span className="flex h-full w-full items-center justify-center rounded-md border-2 border-dashed border-line text-muted">
            <FileInput size={26} />
          </span>
        </StartCard>
        <StartCard label={t('create.addTemplate')} sub={t('create.addTemplateHint')} onClick={async () => setTemplates(await window.api.addTemplates())}>
          <span className="flex h-full w-full items-center justify-center rounded-md border-2 border-dashed border-line text-muted">
            <FolderPlus size={26} />
          </span>
        </StartCard>
      </div>
    </section>
  )
}

function StartCard({ label, sub, onClick, onRemove, children }: { label: string; sub: string; onClick: () => void; onRemove?: () => void; children: React.ReactNode }) {
  const t = useT()
  return (
    <div className="group relative flex w-[132px] shrink-0 flex-col gap-1.5">
      <button type="button" onClick={onClick} className="flex h-[168px] w-full items-center justify-center rounded-lg border border-line bg-surface p-3 transition-[border-color,box-shadow] hover:border-accent hover:shadow-md" title={label}>
        {children}
      </button>
      <span className="truncate text-[13px] font-medium" title={label} dir="auto">
        {label}
      </span>
      <span className="-mt-1 line-clamp-2 text-[12px] leading-snug text-muted">{sub}</span>
      {onRemove && (
        <button
          type="button"
          title={t('create.removeTemplate')}
          aria-label={t('create.removeTemplate')}
          onClick={onRemove}
          className="absolute end-1.5 top-1.5 hidden h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm group-hover:flex hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

function BlankPage({ landscape }: { landscape: boolean }) {
  return (
    <span className={clsx('flex items-center justify-center rounded-sm bg-white shadow-[0_1px_4px_rgb(0_0_0/0.18)]', landscape ? 'h-[76px] w-[106px]' : 'h-[140px] w-[100px]')}>
      <Plus size={34} strokeWidth={2.5} className="text-brand" />
    </span>
  )
}

function TemplateThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null
    void window.api.fileThumbnail(path, 200).then((r) => {
      if (r.ok && r.value.image) {
        url = URL.createObjectURL(new Blob([r.value.image.data as Uint8Array<ArrayBuffer>], { type: r.value.image.mime }))
        setSrc(url)
      }
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])
  return src ? <img src={src} alt="" className="max-h-full max-w-full rounded-sm shadow-[0_1px_4px_rgb(0_0_0/0.18)]" /> : <FileText size={30} className="text-faint" />
}

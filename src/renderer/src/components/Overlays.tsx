import clsx from 'clsx'
import { Bug, CheckCircle2, Cloud, CodeXml, Download, FileText, FileWarning, FolderOpen, FolderPlus, HardDrive, Save, Globe, Info, Keyboard, Monitor, Moon, Palette, RefreshCw, Scale, ShieldCheck, Sun, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BRAND, problemReportUrl } from '@shared/brand'
import { changeSettings, closeDoc, dismissToast, save, saveWillCopy, setDialog, t, useStore, useT, type Dialog } from '../store'
import type { Place } from '@shared/ipc'
import type { Key } from '../i18n'
import { Logo } from './Home'
import { SignatureDialog } from './SignatureDialog'
import { CertSignDialog } from './CertSignDialog'
import { PrintDialog, SavePagesDialog } from './PrintDialog'
import { PagesDialog } from './PagesDialog'
import { Button, Check, Field, Segmented, Select, Spinner, Switch, TextInput } from './ui'

export function Modal({ title, onClose, children, width = 420 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" style={{ width }}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button type="button" aria-label={t('close')} title={t('close')} onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink">
            <X size={16} />
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

function PasswordDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'password' | 'permissions' }> }) {
  const t = useT()
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const cancel = (): void => dialog.resolve(null)
  const submit = (): void => {
    if (value) dialog.resolve(value)
  }
  const isOpen = dialog.kind === 'password'
  return (
    <Modal title={t(isOpen ? 'passwordTitle' : 'permissionsTitle')} onClose={cancel}>
      <p className="text-[13px] leading-relaxed">{t(isOpen ? 'passwordPrompt' : 'permissionsPrompt', { name: dialog.name })}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label={t('password')} error={dialog.wrong ? t('wrongPassword') : null}>
          <TextInput ref={input} type="password" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={cancel}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!value}>
            {t(isOpen ? 'openFile' : 'apply')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function UpdateLine() {
  const t = useT()
  const update = useStore((s) => s.update)
  const text = (() => {
    switch (update.state) {
      case 'checking':
        return t('update.checking')
      case 'none':
        return t('update.none')
      case 'available':
        return t('update.available', { version: update.version })
      case 'downloading':
        return t('update.downloading', { version: update.version, percent: update.percent })
      case 'ready':
        return t('update.ready', { version: update.version })
      case 'error':
        return t('update.error', { message: update.message })
      case 'disabled':
        return t('update.disabled')
      default:
        return ''
    }
  })()
  return (
    <div className="flex flex-col gap-2">
      {text && <p className={clsx('text-[12px]', update.state === 'error' ? 'text-danger' : 'text-muted')}>{text}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void window.api.checkForUpdates()} disabled={update.state === 'checking' || update.state === 'downloading'}>
          {t('checkNow')}
        </Button>
        {update.state === 'available' &&
          (update.canInstall ? (
            <Button variant="primary" onClick={() => void window.api.downloadUpdate()}>
              {t('download')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void window.api.openExternal(BRAND.releasesUrl)}>
              {t('openReleases')}
            </Button>
          ))}
        {update.state === 'ready' && (
          <Button variant="primary" onClick={() => void window.api.installUpdate()}>
            {t('restartNow')}
          </Button>
        )}
      </div>
    </div>
  )
}

type SettingsPage = 'general' | 'appearance' | 'saving' | 'places' | 'keyboard' | 'updates' | 'about'

/** A mini picture of the app in a theme, for the theme cards. */
function ThemePreview({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  const part = (dark: boolean) => (
    <div className={clsx('flex h-full flex-1 flex-col gap-1 p-1.5', dark ? 'bg-[#1b1b1b]' : 'bg-[#f3f3f3]')}>
      <div className={clsx('h-1.5 w-full rounded-sm', dark ? 'bg-[#2c2c2c]' : 'bg-white')} />
      <div className="flex flex-1 gap-1">
        <div className={clsx('w-3 rounded-sm', dark ? 'bg-[#252525]' : 'bg-white')} />
        <div className={clsx('flex-1 rounded-sm', dark ? 'bg-[#3a3a3a]' : 'bg-white shadow-sm')} />
      </div>
      <div className="h-1.5 w-6 rounded-full bg-[#1473e6]" />
    </div>
  )
  return <div className="flex h-16 w-full overflow-hidden rounded-lg border border-line">{theme === 'system' ? [part(false), part(true)] : part(theme === 'dark')}</div>
}

/** A group of rows in a rounded card, as Windows 11 Settings and Acrobat's preferences show them. */
function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{children}</div>
}
function Row({ children }: { children: ReactNode }) {
  return <div className="px-4 py-3.5">{children}</div>
}

/**
 * Settings, laid out as Acrobat's Preferences and Windows 11 Settings: categories on the
 * side, the chosen one on the right as cards of rows; on/off options are switches and take
 * effect at once (there is no Save button to forget).
 */
/** A text setting saved when the field loses focus or Enter is pressed (not on every key). */
function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value)
  return <TextInput value={text} dir="auto" maxLength={120} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== value && onSave(text.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
}

/** Settings → Saving: what Save does, and where copies go. */
function SavingSettings() {
  const t = useT()
  const settings = useStore((s) => s.settings)!
  const [places, setPlaces] = useState<Place[]>([])
  useEffect(() => void window.api.places().then(setPlaces), [])
  const folderOptions = [
    { value: '', label: t('saving.besideOriginal') },
    ...places.map((p) => ({ value: p.path, label: placeLabel(p), hint: p.path })),
    ...(settings.saveFolder && !places.some((p) => p.path === settings.saveFolder) ? [{ value: settings.saveFolder, label: settings.saveFolder }] : []),
    { value: '\u0000choose', label: t('saving.chooseFolder') }
  ]
  return (
    <>
      <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t('saving.whenISave')}</p>
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            ['copy', t('saving.copy'), t('saving.copyHint')],
            ['replace', t('saving.replace'), t('saving.replaceHint')]
          ] as const
        ).map(([mode, title, hint]) => (
          <button
            key={mode}
            type="button"
            onClick={() => void changeSettings({ saveMode: mode })}
            aria-pressed={settings.saveMode === mode}
            className={clsx('flex flex-col items-start gap-1.5 rounded-xl border bg-surface p-4 text-start', settings.saveMode === mode ? 'border-accent ring-3 ring-accent/15' : 'border-line hover:border-faint')}
          >
            <span className="flex w-full items-center justify-between text-[14px] font-semibold">
              {title}
              {settings.saveMode === mode && <CheckCircle2 size={17} className="text-accent" />}
            </span>
            <span className="text-[12px] leading-snug text-muted">{hint}</span>
            {mode === 'copy' && <span className="mt-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">{t('saving.recommended')}</span>}
          </button>
        ))}
      </div>
      {settings.saveMode === 'copy' && (
        <Card>
          <Row>
            <Field label={t('saving.copiesGo')} hint={t('saving.copiesGoHint')}>
              <Select
                value={settings.saveFolder}
                label={t('saving.copiesGo')}
                options={folderOptions}
                onChange={async (v) => {
                  if (v === '\u0000choose') {
                    const chosen = await window.api.pickFolder()
                    if (chosen) void changeSettings({ saveFolder: chosen })
                  } else void changeSettings({ saveFolder: v })
                }}
              />
            </Field>
          </Row>
        </Card>
      )}
      <p className="text-[12px] leading-relaxed text-muted">{t('saving.note')}</p>
    </>
  )
}

const PLACE_ICONS: Record<Place['kind'], ReactNode> = {
  onedrive: <Cloud size={18} className="text-[#0a64d6]" />,
  google: <Cloud size={18} className="text-[#1a9e55]" />,
  dropbox: <Cloud size={18} className="text-[#0061fe]" />,
  icloud: <Cloud size={18} className="text-[#3b82f6]" />,
  documents: <FileText size={18} className="text-muted" />,
  desktop: <Monitor size={18} className="text-muted" />,
  downloads: <Download size={18} className="text-muted" />,
  folder: <FolderOpen size={18} className="text-accent" />
}
/** A place's name: the usual folders in the interface's language, others as they are called. */
export function placeLabel(p: Place): string {
  return p.kind === 'documents' || p.kind === 'desktop' || p.kind === 'downloads' ? t(`places.kind.${p.kind}`) : p.label
}

export function PlaceIcon({ kind }: { kind: Place['kind'] }) {
  return <>{PLACE_ICONS[kind]}</>
}

/** Settings → Storage places: drives found on this PC, and folders linked by hand. */
function PlacesSettings() {
  const t = useT()
  const settings = useStore((s) => s.settings)!
  const [places, setPlaces] = useState<Place[]>([])
  const load = (): void => void window.api.places().then(setPlaces)
  useEffect(load, [settings.places])
  const cloud = places.filter((p) => p.detected && ['onedrive', 'google', 'dropbox', 'icloud'].includes(p.kind))
  return (
    <>
      <p className="text-[12px] leading-relaxed text-muted">{t('places.explain', { app: BRAND.name })}</p>
      <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t('places.found')}</p>
      <Card>
        {places.filter((p) => p.detected).map((p) => (
          <Row key={p.path}>
            <div className="flex items-center gap-3">
              <PlaceIcon kind={p.kind} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{placeLabel(p)}</span>
                <span className="truncate text-[11px] text-muted" dir="ltr">{p.path}</span>
              </span>
            </div>
          </Row>
        ))}
      </Card>
      {cloud.length === 0 && <p className="text-[12px] leading-relaxed text-muted">{t('places.noCloud')}</p>}
      <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t('places.linked')}</p>
      <Card>
        {settings.places.map((p) => (
          <Row key={p.path}>
            <div className="flex items-center gap-3">
              <PlaceIcon kind="folder" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] font-medium">{p.label}</span>
                <span className="truncate text-[11px] text-muted" dir="ltr">{p.path}</span>
              </span>
              <button type="button" className="rounded-lg px-2 py-1 text-[12px] text-danger hover:bg-surface-2" onClick={() => void changeSettings({ places: settings.places.filter((x) => x.path !== p.path) })}>
                {t('remove')}
              </button>
            </div>
          </Row>
        ))}
        <Row>
          <Button
            icon={<FolderPlus size={15} />}
            onClick={async () => {
              const path = await window.api.pickFolder()
              if (!path || settings.places.some((x) => x.path === path)) return
              void changeSettings({ places: [...settings.places, { path, label: path.split(/[\\/]/).filter(Boolean).pop() ?? path }] })
            }}
          >
            {t('places.add')}
          </Button>
        </Row>
      </Card>
    </>
  )
}

function SettingsDialog({ start }: { start?: SettingsPage }) {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const [page, setPage] = useState<SettingsPage>(start ?? 'general')
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDialog(null)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  if (!settings) return null
  const pages: Array<{ id: SettingsPage; icon: ReactNode; label: string }> = [
    { id: 'general', icon: <Globe size={17} />, label: t('settings.general') },
    { id: 'saving', icon: <Save size={17} />, label: t('settings.saving') },
    { id: 'places', icon: <HardDrive size={17} />, label: t('settings.places') },
    { id: 'appearance', icon: <Palette size={17} />, label: t('settings.appearance') },
    { id: 'keyboard', icon: <Keyboard size={17} />, label: t('keyboard') },
    ...(BRAND.online ? [{ id: 'updates' as const, icon: <RefreshCw size={17} />, label: t('updates') }] : []),
    { id: 'about', icon: <Info size={17} />, label: t('about') }
  ]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && setDialog(null)}>
      <div role="dialog" aria-modal="true" aria-label={t('settings')} className="flex h-[min(560px,100%)] w-[min(760px,100%)] overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl" data-settings="">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-e border-line bg-surface p-3">
          <h2 className="px-2.5 pt-1 pb-3 text-[17px] font-semibold">{t('settings')}</h2>
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPage(p.id)}
              aria-current={page === p.id ? 'page' : undefined}
              className={clsx('relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-start text-[13px]', page === p.id ? 'bg-surface-2 font-semibold' : 'text-muted hover:bg-surface-2 hover:text-ink')}
            >
              {page === p.id && <span className="absolute start-0 top-2 h-5 w-[3px] rounded-full bg-accent" />}
              {p.icon}
              {p.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between px-6">
            <h3 className="text-[15px] font-semibold">{pages.find((p) => p.id === page)!.label}</h3>
            <button type="button" aria-label={t('close')} title={t('close')} onClick={() => setDialog(null)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink">
              <X size={17} />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
            {page === 'general' && (
              <>
                <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t('language')}</p>
                <div className="grid grid-cols-2 gap-3">
                  {(
                    [
                      ['en', 'English', 'Left to right'],
                      ['ar', 'العربية', 'من اليمين إلى اليسار']
                    ] as const
                  ).map(([code, name, note]) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => void changeSettings({ language: code })}
                      aria-pressed={settings.language === code}
                      className={clsx('flex flex-col items-start gap-1 rounded-xl border bg-surface p-4 text-start', settings.language === code ? 'border-accent ring-3 ring-accent/15' : 'border-line hover:border-faint')}
                      dir={code === 'ar' ? 'rtl' : 'ltr'}
                    >
                      <span className="flex w-full items-center justify-between text-[15px] font-semibold">
                        {name}
                        {settings.language === code && <CheckCircle2 size={17} className="text-accent" />}
                      </span>
                      <span className="text-[12px] text-muted">{note}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[12px] leading-relaxed text-muted">{t('settings.languageHint')}</p>
                <Card>
                  <Row>
                    <Field label={t('settings.yourName')} hint={t('settings.yourNameHint')}>
                      <NameField value={settings.authorName} onSave={(authorName) => void changeSettings({ authorName })} />
                    </Field>
                  </Row>
                  <Row>
                    <Field label={t('settings.openAt')}>
                      <Segmented
                        value={settings.defaultZoom}
                        onChange={(defaultZoom) => void changeSettings({ defaultZoom })}
                        options={[
                          { value: 'width', label: t('fitWidth') },
                          { value: 'page', label: t('fitPage') },
                          { value: '100', label: '100%' }
                        ]}
                      />
                    </Field>
                  </Row>
                  <Row>
                    <Switch checked={settings.spellCheck} onChange={(spellCheck) => void changeSettings({ spellCheck })} label={t('settings.spellCheck')} hint={t('settings.spellCheckHint')} />
                  </Row>
                  <Row>
                    <div className="flex items-center justify-between gap-3" data-trusted-links="">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{t('settings.links')}</p>
                        <p className="text-[12px] leading-relaxed text-muted">
                          {settings.trustedLinkHosts.length ? t('settings.linksTrusted', { count: settings.trustedLinkHosts.length, sites: settings.trustedLinkHosts.slice(0, 3).join(', ') }) : t('settings.linksAsk')}
                        </p>
                      </div>
                      {settings.trustedLinkHosts.length > 0 && (
                        <Button className="shrink-0" onClick={() => void changeSettings({ trustedLinkHosts: [] })}>
                          {t('settings.linksForget')}
                        </Button>
                      )}
                    </div>
                  </Row>
                </Card>
              </>
            )}
            {page === 'saving' && <SavingSettings />}
            {page === 'places' && <PlacesSettings />}
            {page === 'appearance' && (
              <>
                <p className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t('theme')}</p>
                <div className="grid grid-cols-3 gap-3">
                  {(['system', 'light', 'dark'] as const).map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      onClick={() => void changeSettings({ theme })}
                      aria-pressed={settings.theme === theme}
                      className={clsx('flex flex-col gap-2.5 rounded-xl border bg-surface p-2.5 text-start', settings.theme === theme ? 'border-accent ring-3 ring-accent/15' : 'border-line hover:border-faint')}
                    >
                      <ThemePreview theme={theme} />
                      <span className="flex items-center gap-2 px-0.5 text-[13px] font-medium">
                        {theme === 'system' ? <Monitor size={15} /> : theme === 'light' ? <Sun size={15} /> : <Moon size={15} />}
                        {t(`theme.${theme}`)}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {page === 'keyboard' && (
              <>
                <Card>
                  <Row>
                    <Switch checked={settings.singleKeys} onChange={(singleKeys) => void changeSettings({ singleKeys })} label={t('singleKeys')} hint={t('singleKeysHint')} />
                  </Row>
                  <Row>
                    <div className="flex items-center justify-between gap-4">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-[13px] font-medium">{t('keyboardShortcuts')}</span>
                        <span className="text-[12px] text-muted">{t('settings.shortcutsHint')}</span>
                      </span>
                      <Button onClick={() => setDialog({ kind: 'shortcuts' })}>{t('settings.showShortcuts')}</Button>
                    </div>
                  </Row>
                </Card>
              </>
            )}
            {page === 'updates' && BRAND.online && (
              <Card>
                <Row>
                  <Switch checked={settings.checkForUpdates} onChange={(checkForUpdates) => void changeSettings({ checkForUpdates })} label={t('checkAutomatically')} hint={t('settings.updatesHint')} />
                </Row>
                <Row>
                  <UpdateLine />
                </Row>
              </Card>
            )}
            {page === 'about' && (
              <>
                <div className="flex items-center gap-4 rounded-xl border border-line bg-surface p-5">
                  <Logo size={52} />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[17px] font-semibold">{BRAND.name}</span>
                    <span className="text-[12px] text-muted">{t('version', { version: window.api.version })}</span>
                  </div>
                </div>
                <Card>
                  <Row>
                    <p className="flex items-start gap-2.5 text-[13px] leading-relaxed">
                      <ShieldCheck size={17} className="mt-0.5 shrink-0 text-ok" />
                      {t('privacy')}
                    </p>
                  </Row>
                  <Row>
                    <p className="flex items-start gap-2.5 text-[13px] leading-relaxed">
                      <Scale size={17} className="mt-0.5 shrink-0 text-muted" />
                      {t('licence')}
                    </p>
                  </Row>
                </Card>
                {/* Links open in the browser only when clicked; the app itself sends nothing (§84). */}
                <div className="flex flex-wrap gap-2" data-about-links="">
                  {BRAND.online && (
                    <Button icon={<Download size={15} />} onClick={() => void window.api.openExternal(BRAND.releasesUrl)}>
                      {t('openReleases')}
                    </Button>
                  )}
                  <Button
                    icon={<Bug size={15} />}
                    title={t('reportProblemHint')}
                    onClick={() => void window.api.openExternal(problemReportUrl({ version: window.api.version, system: window.api.system, language: settings.language }))}
                  >
                    {t('reportProblem')}
                  </Button>
                  <Button icon={<CodeXml size={15} />} onClick={() => void window.api.openExternal(BRAND.sourceUrl)}>
                    {t('sourceCode')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'confirm' }> }) {
  const t = useT()
  return (
    <Modal title={dialog.title} onClose={() => dialog.resolve(false)}>
      <p className="text-[13px] leading-relaxed">{dialog.message}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => dialog.resolve(false)}>{t('cancel')}</Button>
        <Button variant={dialog.danger ? 'danger' : 'primary'} autoFocus onClick={() => dialog.resolve(true)} data-confirm="">
          {dialog.action}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Acrobat's "Security Warning" for a link in a document (§81): the whole address, the site's name in
 * bold (look-alike letters show as xn--…), and "Always allow" for that site. Cancel has the focus,
 * so a stray Enter does not open anything.
 */
function LinkDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'link' }> }) {
  const t = useT()
  const [always, setAlways] = useState(false)
  const { link } = dialog
  const email = link.kind === 'email'
  const at = link.url.toLowerCase().indexOf(link.host)
  return (
    <Modal title={t(email ? 'link.askEmailTitle' : 'link.askTitle')} onClose={() => dialog.resolve({ open: false, always: false })} width={460}>
      <p className="text-[13px] leading-relaxed">{t(email ? 'link.askEmail' : 'link.ask')}</p>
      <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5" data-link-address="">
        <Globe size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <p className="min-w-0 font-mono text-[12.5px] leading-relaxed break-all text-ink" dir="ltr">
          {at >= 0 ? (
            <>
              <span className="text-muted">{link.url.slice(0, at)}</span>
              <span className="font-semibold">{link.url.slice(at, at + link.host.length)}</span>
              <span className="text-muted">{link.url.slice(at + link.host.length)}</span>
            </>
          ) : (
            link.url
          )}
        </p>
      </div>
      <p className="text-[12px] leading-relaxed text-muted">{t('link.trustHint')}</p>
      <Check checked={always} onChange={setAlways} label={t(email ? 'link.alwaysEmail' : 'link.always', { site: link.host })} />
      <div className="flex justify-end gap-2">
        <Button autoFocus onClick={() => dialog.resolve({ open: false, always: false })}>{t('cancel')}</Button>
        <Button variant="primary" onClick={() => dialog.resolve({ open: true, always })} data-confirm="">
          {t(email ? 'link.openEmail' : 'link.open')}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Unsaved changes, in the app's own dialog (not Windows' message box): Save, Don't save or
 * Cancel for one document; for the whole window, a list to tick. Save follows the save
 * setting (a copy beside the original by default), and the button says which.
 */
function UnsavedDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'unsaved' }> }) {
  const t = useT()
  const docs = useStore((s) => s.docs)
  const views = dialog.docIds.map((id) => docs[id]).filter((v): v is NonNullable<typeof v> => !!v)
  const [chosen, setChosen] = useState<string[]>(views.map((v) => v.info.id))
  const [working, setWorking] = useState(false)
  const single = views.length === 1 ? views[0]! : null
  const finish = async (): Promise<void> => {
    setDialog(null)
    if (dialog.quitting) await window.api.quit()
    else for (const v of views) await closeDoc(v.info.id, true)
  }
  const saveThen = async (): Promise<void> => {
    setWorking(true)
    for (const id of chosen) {
      // A new document asks where to save; cancelling that keeps everything open.
      if (!(await save(id))) {
        setWorking(false)
        return
      }
    }
    await finish()
  }
  const copyNote = single && saveWillCopy(single.info.id)
  return (
    <Modal title={t('unsavedTitle')} onClose={() => setDialog(null)} width={single ? 440 : 480}>
      <div className="flex items-start gap-3.5" data-unsaved-dialog="">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-warn">
          <FileWarning size={20} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[14px] font-semibold" dir="auto">
            {single ? t('unsavedOneQuestion', { name: single.info.name }) : t('unsavedManyQuestion', { count: views.length })}
          </p>
          <p className="text-[13px] text-muted">{t('unsavedLost')}</p>
          {copyNote && <p className="text-[12px] text-muted">{t('unsavedCopyNote')}</p>}
        </div>
      </div>
      {!single && (
        <div className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {views.map((v) => (
            <div key={v.info.id} className="px-3 py-2">
              <Check
                checked={chosen.includes(v.info.id)}
                onChange={(on) => setChosen(on ? [...chosen, v.info.id] : chosen.filter((x) => x !== v.info.id))}
                label={v.info.name}
                hint={v.info.path ? (saveWillCopy(v.info.id) ? t('willSaveCopy') : t('willReplace')) : t('willAskWhere')}
              />
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="danger" disabled={working} onClick={() => void finish()}>
          {t('dontSave')}
        </Button>
        <span className="flex-1" />
        <Button disabled={working} onClick={() => setDialog(null)}>
          {t('cancel')}
        </Button>
        <Button variant="primary" autoFocus disabled={working || chosen.length === 0} onClick={() => void saveThen()}>
          {working ? t('saving') : single ? (copyNote ? t('saveCopy') : t('save')) : t('saveCount', { count: chosen.length })}
        </Button>
      </div>
    </Modal>
  )
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  if (!dialog) return null
  if (dialog.kind === 'password' || dialog.kind === 'permissions') return <PasswordDialog key={`${dialog.kind}-${dialog.wrong}`} dialog={dialog} />
  if (dialog.kind === 'settings') return <SettingsDialog start={dialog.page} />
  if (dialog.kind === 'signature') return <SignatureDialog docId={dialog.docId} />
  if (dialog.kind === 'certSign') return <CertSignDialog docId={dialog.docId} />
  if (dialog.kind === 'shortcuts') return <ShortcutsDialog />
  if (dialog.kind === 'print') return <PrintDialog docId={dialog.docId} {...(dialog.pages ? { pages: dialog.pages } : {})} />
  if (dialog.kind === 'savePages') return <SavePagesDialog docId={dialog.docId} {...(dialog.pages ? { pages: dialog.pages } : {})} />
  if (dialog.kind === 'pages') return <PagesDialog key={`${dialog.action}-${dialog.pages.join()}`} dialog={dialog} />
  if (dialog.kind === 'confirm') return <ConfirmDialog dialog={dialog} />
  if (dialog.kind === 'link') return <LinkDialog key={dialog.link.url} dialog={dialog} />
  if (dialog.kind === 'unsaved') return <UnsavedDialog key={dialog.docIds.join()} dialog={dialog} />
  return null
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-10 end-4 z-40 flex w-[380px] flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = toast.kind === 'error' ? XCircle : toast.kind === 'success' ? CheckCircle2 : Info
        return (
          <div key={toast.id} className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 shadow-lg" role="status">
            <Icon size={18} className={clsx('mt-0.5 shrink-0', toast.kind === 'error' ? 'text-danger' : toast.kind === 'success' ? 'text-ok' : 'text-focus')} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-[13px] leading-snug break-words" dir="auto">
                {toast.text}
              </p>
              {toast.action && (
                <button type="button" className="self-start text-[12px] font-medium text-accent hover:underline" onClick={toast.action.run}>
                  {toast.action.label}
                </button>
              )}
            </div>
            <button type="button" onClick={() => dismissToast(toast.id)} className="rounded p-0.5 text-faint hover:text-ink">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A slim bar when a new version exists or is ready, so nobody has to open Settings
 * to find out. Dismissed per version; nothing downloads without a click.
 */
export function UpdateBanner() {
  const t = useT()
  const update = useStore((s) => s.update)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!BRAND.online) return null
  if (update.state !== 'available' && update.state !== 'downloading' && update.state !== 'ready') return null
  if (dismissed === `${update.state === 'ready' ? 'ready' : 'available'}-${update.version}`) return null
  const text =
    update.state === 'ready'
      ? t('update.ready', { version: update.version })
      : update.state === 'downloading'
        ? t('update.downloading', { version: update.version, percent: update.percent })
        : t('update.available', { version: update.version })
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-accent-soft px-3 text-[13px]" role="status">
      <span className="flex-1">{text}</span>
      {update.state === 'available' &&
        (update.canInstall ? (
          <Button variant="primary" className="h-7" onClick={() => void window.api.downloadUpdate()}>
            {t('download')}
          </Button>
        ) : (
          <Button variant="primary" className="h-7" onClick={() => void window.api.openExternal(BRAND.releasesUrl)}>
            {t('openReleases')}
          </Button>
        ))}
      {update.state === 'ready' && (
        <Button variant="primary" className="h-7" onClick={() => void window.api.installUpdate()}>
          {t('restartNow')}
        </Button>
      )}
      {update.state !== 'downloading' && (
        <button type="button" title={t('close')} className="rounded p-1 text-muted hover:text-ink" onClick={() => setDismissed(`${update.state === 'ready' ? 'ready' : 'available'}-${update.version}`)}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}

/** Covers the window while the engine works, so nothing is changed half-way. */
export function Busy() {
  const t = useT()
  const busy = useStore((s) => s.busy)
  const progress = useStore((s) => s.progress)
  const [visible, setVisible] = useState(false)
  // Quick operations should not flash a screen; show it only after a moment.
  useEffect(() => {
    if (!busy) return setVisible(false)
    const timer = setTimeout(() => setVisible(true), 250)
    return () => clearTimeout(timer)
  }, [busy])
  if (!busy) return null
  return (
    <div className={clsx('fixed inset-0 z-40 flex items-center justify-center transition-colors', visible ? 'bg-black/20' : 'bg-transparent')}>
      {visible && (
        <div className="flex min-w-64 flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <Spinner size={20} />
            <span className="text-[14px] font-medium">{busy}</span>
          </div>
          {progress && progress.fraction > 0 && progress.fraction < 1 ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          ) : (
            <span className="text-[12px] text-muted">{t('working')}</span>
          )}
        </div>
      )}
    </div>
  )
}

const SHORTCUTS: Array<[string, Key]> = [
  ['Ctrl+O', 'openPdf'],
  ['Ctrl+S', 'save'],
  ['Ctrl+Shift+S', 'saveAs'],
  ['Ctrl+W', 'close'],
  ['Ctrl+Tab', 'sc.nextTab'],
  ['Ctrl+Z', 'undo'],
  ['Ctrl+Y', 'redo'],
  ['Ctrl+F', 'sc.find'],
  ['Ctrl+H', 'sc.replace'],
  ['Ctrl+C', 'sc.copy'],
  ['Ctrl + / Ctrl −', 'sc.zoom'],
  ['Ctrl+0', 'fitWidth'],
  ['Home / End', 'sc.firstLast'],
  ['Ctrl+PgUp / Ctrl+PgDn', 'sc.prevNext'],
  ['Esc', 'sc.escape'],
  ['Del', 'sc.delete'],
  ['Ctrl+A', 'sc.selectPages'],
  ['Space', 'sc.tickPage'],
  ['Shift+F10', 'sc.pageMenu'],
  ['Alt+Arrows', 'sc.nudge'],
  ['Ctrl+Enter', 'sc.apply'],
  ['?', 'keyboardShortcuts']
]
const SINGLE: Array<[string, Key]> = [
  ['V', 'quick.select'],
  ['T', 'quick.edit'],
  ['S', 'addComment'],
  ['U', 'sc.highlightCycle'],
  ['D', 'penTool'],
  ['Shift+D', 'sc.shapesCycle'],
  ['E', 'eraseArea']
]

/** Every shortcut on one page (Menu → Keyboard shortcuts, or "?"). */
function ShortcutsDialog() {
  const t = useT()
  const single = useStore((s) => s.settings?.singleKeys ?? false)
  const row = ([keys, label]: [string, Key]) => (
    <div key={keys} className="flex items-center justify-between gap-4 py-1 text-[13px]">
      <span>{t(label)}</span>
      <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] whitespace-nowrap" dir="ltr">
        {keys}
      </kbd>
    </div>
  )
  return (
    <Modal title={t('keyboardShortcuts')} onClose={() => setDialog(null)} width={520}>
      <div className="grid grid-cols-1 gap-x-8 divide-y divide-line">{SHORTCUTS.map(row)}</div>
      <div className="flex flex-col gap-1">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('singleKeys')}</h3>
        {!single && <p className="text-[12px] text-muted">{t('singleKeysOff')}</p>}
        <div className={single ? '' : 'opacity-50'}>{SINGLE.map(row)}</div>
      </div>
    </Modal>
  )
}

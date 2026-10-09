import { FileOutput, FileText, Repeat2, RotateCw, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { formatPageList, parsePageList, replacementPages } from '@shared/pagelist'
import { apply, extractPagesAs, pickPageSource, setDialog, tc, updateView, useStore, useT, type Dialog, type PageSource } from '../store'
import { Modal } from './Overlays'
import { Button, Check, Field, NumberInput, PageImage, Segmented, TextInput } from './ui'

/**
 * The page menu's dialogs (decisions §76), as Acrobat's Extract / Delete / Rotate / Replace
 * Pages…: the pages field starts with the pages the menu was opened on and takes any list
 * ("1-3, 5"); the pages are shown small underneath, so it is clear what will change.
 */
export function PagesDialog({ dialog }: { dialog: Extract<Dialog, { kind: 'pages' }> }) {
  const t = useT()
  const view = useStore((s) => s.docs[dialog.docId])
  const [text, setText] = useState(formatPageList(dialog.pages))
  const [each, setEach] = useState(false)
  const [remove, setRemove] = useState(false)
  const [angle, setAngle] = useState<'90' | '180' | '-90'>('90')
  const [source, setSource] = useState<PageSource | undefined>(dialog.source)
  const [start, setStart] = useState(1)
  const count = view?.info.pages.length ?? 0
  // Pages as typed, in page order: what changes is the same whatever order they were typed in.
  const pages = useMemo(() => parsePageList(text, count)?.sort((a, b) => a - b) ?? null, [text, count])
  if (!view) return null
  const close = (): void => setDialog(null)
  const { action } = dialog
  const id = view.info.id

  const all = !!pages && pages.length >= count
  const from = pages && source && source.count > 0 ? replacementPages(pages, start - 1, source.count) : null
  const problem = !pages
    ? t('pagesDialog.invalid', { count })
    : action === 'delete' && all
      ? t('pagesDialog.notAll')
      : action === 'replace' && source && source.count > 0 && !from
        ? t('pagesDialog.replaceTooFew', { name: source.name, count: source.count, start })
        : null
  const ready = !!pages && !problem && (action !== 'replace' || !!source)

  const go = async (): Promise<void> => {
    if (!pages || !ready) return
    close()
    if (action === 'extract') await extractPagesAs(id, pages, each, remove && pages.length < count)
    else if (action === 'delete') {
      if (await apply(id, { op: 'delete', pages }, t('delete'))) updateView(id, { selected: [] })
    } else if (action === 'rotate') await apply(id, { op: 'rotate', pages, angle: Number(angle) as 90 | 180 | -90 }, t('tool.rotate'))
    else if (action === 'replace' && source) {
      // A source whose pages could not be counted (it has an open password) is checked by the engine.
      const taken = from ?? pages.map((_, k) => start - 1 + k)
      await apply(id, { op: 'replacePages', pages, path: source.path, from: taken, ...(source.password ? { password: source.password } : {}) }, t('pagesDialog.replaceTitle'))
    }
  }

  const title = t(action === 'extract' ? 'pagesDialog.extractTitle' : action === 'delete' ? 'pagesDialog.deleteTitle' : action === 'rotate' ? 'pagesDialog.rotateTitle' : 'pagesDialog.replaceTitle')
  const goLabel = action === 'extract' ? t('pagesDialog.extract') : action === 'delete' ? (pages ? tc('pagesMenu.deleteNow', pages.length) : t('delete')) : action === 'rotate' ? t('act.rotate') : t('pagesDialog.replace')
  const goIcon = action === 'extract' ? <FileOutput size={15} /> : action === 'delete' ? <Trash2 size={15} /> : action === 'rotate' ? <RotateCw size={15} /> : <Repeat2 size={15} />
  const shown = (pages ?? []).slice(0, 7)
  const more = (pages?.length ?? 0) - shown.length

  return (
    <Modal title={title} onClose={close} width={500}>
      <form
        className="flex flex-col gap-4"
        data-pages-dialog={action}
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        <Field label={action === 'replace' ? t('pagesDialog.replaceThese') : t('pagesDialog.pages')} error={text.trim() ? problem : null} hint={problem && text.trim() ? undefined : t('pagesDialog.hint')}>
          <div className="flex items-center gap-2">
            <TextInput className="min-w-0 flex-1" dir="ltr" value={text} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setText(e.target.value)} aria-invalid={!!problem} data-pages-field="" />
            <span className="shrink-0 text-[12px] text-muted tabular-nums">{t('pagesDialog.of', { count })}</span>
          </div>
        </Field>
        <div className="flex min-h-[86px] items-center gap-2.5 overflow-hidden rounded-lg bg-surface-2 px-3 py-2.5" aria-hidden="true">
          {shown.map((p) => {
            const size = view.info.pages[p]!
            const k = ((pages?.length ?? 0) <= 3 ? 96 : 60) / Math.max(size.width, size.height)
            return (
              <div key={p} className="flex shrink-0 flex-col items-center gap-1">
                <PageImage docId={id} revision={view.info.revision} page={p} width={Math.round(size.width * k)} height={Math.round(size.height * k)} pointsWide={size.width} className="ring-1 ring-black/10" />
                <span className="text-[10px] text-faint tabular-nums">{p + 1}</span>
              </div>
            )
          })}
          {more > 0 && <span className="ms-1 text-[12px] text-muted">+{more}</span>}
          {pages && <span className="ms-auto self-end text-[12px] text-muted">{tc('pages.count', pages.length)}</span>}
        </div>

        {action === 'extract' && (
          <>
            <Group label={t('pagesDialog.extractAs')} hint={each ? t('savePages.separateHint', { name: view.info.name.replace(/\.pdf$/i, '') }) : t('pagesDialog.extractOneHint')}>
              <Segmented
                value={each ? 'each' : 'one'}
                onChange={(v) => setEach(v === 'each')}
                options={[
                  { value: 'one', label: t('pagesDialog.extractOne') },
                  { value: 'each', label: t('pagesDialog.extractEach') }
                ]}
              />
            </Group>
            {(view.info.rights.assemble || view.info.rights.edit) && pages && pages.length < count && <Check checked={remove} onChange={setRemove} label={t('extractDelete')} />}
          </>
        )}

        {action === 'delete' && <p className="text-[12px] text-muted">{t('pagesDialog.deleteNote')}</p>}

        {action === 'rotate' && (
          <Group label={t('angle')}>
            <Segmented value={angle} onChange={setAngle} options={[{ value: '-90', label: '↺ 90°' }, { value: '180', label: '180°' }, { value: '90', label: '↻ 90°' }]} />
          </Group>
        )}

        {action === 'replace' && (
          <>
            <Group label={t('pagesDialog.replaceWith')}>
              <div className="flex items-center gap-2 rounded-lg border border-line py-1.5 ps-3 pe-1.5" data-replace-source="">
                <FileText size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-[13px]" dir="auto" title={source?.path}>
                  {source?.name ?? '—'}
                </span>
                {source && source.count > 0 && <span className="shrink-0 text-[12px] text-muted">{tc('pages.count', source.count)}</span>}
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const chosen = await pickPageSource()
                    if (chosen) {
                      setSource(chosen)
                      setStart(1)
                    }
                  }}
                >
                  {t('pagesDialog.replaceChoose')}
                </Button>
              </div>
            </Group>
            <Field label={t('pagesDialog.replaceStart')}>
              <div className="w-32">
                <NumberInput value={start} onChange={(v) => setStart(Math.max(1, Math.round(v)))} min={1} {...(source && source.count > 0 ? { max: source.count } : {})} />
              </div>
            </Field>
            {pages && source && (from || source.count === 0) && (
              <p className="text-[12px] text-ink" dir="auto">
                {t('pagesDialog.replaceSummary', { from: start, to: start + pages.length - 1, name: source.name })}
              </p>
            )}
            <p className="text-[12px] leading-relaxed text-muted">{t('pagesDialog.replaceKeeps')}</p>
          </>
        )}
        {/* Enter in a field applies, as in any dialog. */}
        <button type="submit" hidden />
      </form>
      <div className="flex justify-end gap-2">
        <Button onClick={close}>{t('cancel')}</Button>
        <Button variant={action === 'delete' ? 'danger' : 'primary'} icon={goIcon} disabled={!ready} onClick={() => void go()} data-pages-go="">
          {goLabel}
        </Button>
      </div>
    </Modal>
  )
}

/** A labelled row of buttons: a group, not a <label>, so a click on its words presses nothing. */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[12px] leading-snug text-faint">{hint}</span>}
    </div>
  )
}

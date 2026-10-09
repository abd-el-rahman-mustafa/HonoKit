import clsx from 'clsx'
import { FileCode2, FileImage, FileSpreadsheet, FileText, Presentation, Type } from 'lucide-react'
import { useState } from 'react'
import { openTool, runBusy, toast, useT, type DocView } from '../store'
import { Button, Check, Field, Section, Select } from '../components/ui'
import { PageScopeField, ToolFooter, usePageScope } from './common'
import type { Key } from '../i18n'

type Format = 'docx' | 'pptx' | 'xlsx' | 'md' | 'txt'

const FORMATS: Array<{ id: Format; icon: typeof FileText; hue: number }> = [
  { id: 'docx', icon: FileText, hue: 215 },
  { id: 'xlsx', icon: FileSpreadsheet, hue: 145 },
  { id: 'pptx', icon: Presentation, hue: 18 },
  { id: 'md', icon: FileCode2, hue: 260 },
  { id: 'txt', icon: Type, hue: 200 }
]

/**
 * Export a PDF, as Acrobat's Convert panel (research-acrobat-tools §7): a list of formats,
 * options for the chosen one, and a button that says what it will make ("Convert to DOCX").
 * The result is an editable approximation, and the panel says so (docs/decisions.md §49).
 */
export function ConvertTool({ view, initial = 'docx' }: { view: DocView; initial?: Format }) {
  const t = useT()
  const scope = usePageScope(view)
  const [format, setFormat] = useState<Format>(initial)
  const [pageBreaks, setPageBreaks] = useState(false)
  const [removeTatweel, setRemoveTatweel] = useState(true)
  const [digits, setDigits] = useState<'keep' | 'western' | 'arabic'>('keep')
  const [openAfter, setOpenAfter] = useState(true)
  const [sheets, setSheets] = useState<'page' | 'tables'>('page')
  const convert = async (): Promise<void> => {
    const path = await window.api.pickExportPath(view.info.name, format)
    if (!path) return
    const r = await runBusy(t('convert.working'), () =>
      window.api.exportOffice(view.info.id, { format, pages: scope.pages ?? (scope.scope === 'all' ? null : scope.preview), pageBreaks, removeTatweel, digits, sheets }, path)
    )
    if (!r) return
    if (openAfter) void window.api.openConverted(r.path)
    toast('success', t('convert.done', { name: r.path.split(/[\\/]/).pop() ?? r.path, paragraphs: r.paragraphs, tables: r.tables, pictures: r.pictures }), {
      label: t('showInFolder'),
      run: () => void window.api.showInFolder(r.path)
    })
  }
  return (
    <>
      <Section title={t('convert.format')}>
        <div className="flex flex-col gap-1" role="radiogroup" data-convert-formats="">
          {FORMATS.map(({ id, icon: Icon, hue }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={format === id}
              onClick={() => setFormat(id)}
              className={clsx('flex items-center gap-3 rounded-lg border px-3 py-2 text-start', format === id ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2')}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `hsl(${hue} 80% 55% / 0.14)`, color: `hsl(${hue} 68% 44%)` }}>
                <Icon size={17} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{t(`convert.${id}` as Key)}</span>
                <span className="text-[11px] text-muted">{t(`convert.${id}.hint` as Key)}</span>
              </span>
            </button>
          ))}
          <button type="button" onClick={() => openTool('toImages')} className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-start hover:bg-surface-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: 'hsl(45 80% 55% / 0.14)', color: 'hsl(45 68% 40%)' }}>
              <FileImage size={17} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">{t('convert.images')}</span>
              <span className="text-[11px] text-muted">{t('convert.images.hint')}</span>
            </span>
          </button>
        </div>
      </Section>
      <Section title={t('convert.options')}>
        {format === 'docx' && <Check checked={pageBreaks} onChange={setPageBreaks} label={t('convert.pageBreaks')} hint={t('convert.pageBreaksHint')} />}
        {format === 'xlsx' && (
          <Field label={t('convert.sheets')}>
            <Select
              value={sheets}
              onChange={setSheets}
              options={[
                { value: 'page', label: t('convert.sheetPerPage'), hint: t('convert.sheetPerPageHint') },
                { value: 'tables', label: t('convert.sheetPerTable'), hint: t('convert.sheetPerTableHint') }
              ]}
            />
          </Field>
        )}
        <Check checked={removeTatweel} onChange={setRemoveTatweel} label={t('convert.tatweel')} hint={t('convert.tatweelHint')} />
        <Field label={t('digits')}>
          <Select
            value={digits}
            onChange={setDigits}
            options={[
              { value: 'keep', label: t('convert.digitsKeep') },
              { value: 'western', label: t('convert.digitsWestern') },
              { value: 'arabic', label: t('convert.digitsArabic') }
            ]}
          />
        </Field>
        <Check checked={openAfter} onChange={setOpenAfter} label={t('convert.openAfter')} />
      </Section>
      <PageScopeField state={scope} />
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-snug text-muted">{t('convert.note')}</p>
      <ToolFooter>
        <Button variant="primary" disabled={scope.pages === null} onClick={() => void convert()}>
          {t('convert.to', { format: format === 'md' ? 'Markdown' : format.toUpperCase() })}
        </Button>
      </ToolFooter>
    </>
  )
}

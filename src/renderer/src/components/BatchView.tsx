import clsx from 'clsx'
import { ArrowDown, ArrowUp, CheckCircle2, FilePlus2, FolderOpen, FolderPlus, ListChecks, Play, Plus, Save, Trash2, X, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BatchStep, SavedWorkflow } from '@shared/ipc'
import { changeSettings, openTool, runBusy, toast, useStore, useT } from '../store'
import { Button, Select, TextInput } from './ui'
import type { Key } from '../i18n'

/**
 * Batch workflows (docs/decisions.md §54), as Acrobat's Action Wizard and iLovePDF's batch
 * tools: files on the left, the steps in the middle (in order, each with its options), where
 * the results go on the right; Run; then a list of what was made, file by file. A workflow can
 * be kept for next time (passwords are never kept).
 */

const STEP_KINDS: Array<BatchStep['kind']> = ['compress', 'ocr', 'watermark', 'pageNumbers', 'rotate', 'protect', 'convert']

function defaultStep(kind: BatchStep['kind'], t: (k: Key) => string): BatchStep {
  switch (kind) {
    case 'compress':
      return { kind, level: 'medium' }
    case 'ocr':
      return { kind, language: 'auto' }
    case 'watermark':
      return { kind, text: t('batch.defaultWatermark') }
    case 'pageNumbers':
      return { kind, template: '{n} / {N}' }
    case 'rotate':
      return { kind, angle: 90 }
    case 'protect':
      return { kind, password: '' }
    case 'convert':
      return { kind, format: 'docx' }
  }
}

export function BatchView() {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const [files, setFiles] = useState<string[]>([])
  const [steps, setSteps] = useState<BatchStep[]>([{ kind: 'compress', level: 'medium' }])
  const [folder, setFolder] = useState<string | null>(null)
  const [suffix, setSuffix] = useState('-done')
  const [results, setResults] = useState<Array<{ input: string; output?: string; error?: string }> | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const saved = settings?.workflows ?? []

  const addFiles = (paths: string[]): void => setFiles((now) => [...now, ...paths.filter((p) => !now.includes(p))])
  useEffect(() => {
    const add = (e: Event): void => addFiles((e as CustomEvent<string[]>).detail)
    window.addEventListener('powerpdf:batch-add', add)
    return () => window.removeEventListener('powerpdf:batch-add', add)
  }, [])

  const convertIndex = steps.findIndex((s) => s.kind === 'convert')
  const problem = files.length === 0 ? t('batch.needFiles') : steps.length === 0 ? t('batch.needSteps') : steps.some((s) => s.kind === 'protect' && s.password.length < 1) ? t('batch.needPassword') : convertIndex >= 0 && convertIndex !== steps.length - 1 ? t('batch.convertLast') : steps.some((s) => s.kind === 'watermark' && !s.text.trim()) ? t('batch.needText') : null

  const run = async (): Promise<void> => {
    const r = await runBusy(t('batch.running'), () => window.api.runBatch(files, steps, { folder, suffix }))
    if (!r) return
    setResults(r)
    const ok = r.filter((x) => x.output).length
    toast(ok === r.length ? 'success' : 'error', t('batch.done', { ok, count: r.length }))
  }
  const keep = async (): Promise<void> => {
    if (!name.trim()) return
    const workflow: SavedWorkflow = { name: name.trim(), steps: steps.map((s) => (s.kind === 'protect' ? { ...s, password: '' } : s)), suffix }
    await changeSettings({ workflows: [...saved.filter((w) => w.name !== workflow.name), workflow] })
    toast('success', t('batch.saved', { name: workflow.name }))
    setName('')
  }
  const update = (i: number, step: BatchStep): void => setSteps(steps.map((s, k) => (k === i ? step : s)))
  const move = (i: number, by: number): void => {
    const next = [...steps]
    const [s] = next.splice(i, 1)
    next.splice(i + by, 0, s!)
    setSteps(next)
  }

  return (
    <div className="flex h-full flex-col" data-batch="">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <ListChecks size={20} className="text-brand" />
        <h1 className="me-3 text-[16px] font-semibold">{t('tool.batch')}</h1>
        {saved.length > 0 && (
          <div className="w-56">
            <Select
              value=""
              label={t('batch.load')}
              onChange={(n) => {
                const w = saved.find((x) => x.name === n)
                if (w) {
                  setSteps(w.steps)
                  setSuffix(w.suffix)
                }
              }}
              options={[{ value: '', label: t('batch.load') }, ...saved.map((w) => ({ value: w.name, label: w.name }))]}
            />
          </div>
        )}
        <span className="flex-1" />
        <Button onClick={() => openTool(null)}>{t('close')}</Button>
        <Button variant="primary" icon={<Play size={15} />} disabled={!!problem} title={problem ?? undefined} onClick={() => void run()}>
          {files.length === 1 ? t('batch.runOne') : t('batch.run', { count: files.length })}
        </Button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto bg-sunken p-5 lg:grid-cols-[1fr_1.2fr_0.9fr]">
        <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[14px] font-semibold">{t('batch.files', { count: files.length })}</h2>
          <div className="flex flex-wrap gap-2">
            <Button icon={<FilePlus2 size={15} />} onClick={async () => addFiles(await window.api.pickPdfs(true))}>
              {t('addFiles')}
            </Button>
            <Button
              icon={<FolderPlus size={15} />}
              onClick={async () => {
                const dir = await window.api.pickFolder()
                if (dir) addFiles(await window.api.pdfsIn(dir))
              }}
            >
              {t('batch.addFolder')}
            </Button>
          </div>
          {files.length === 0 ? (
            <p className="rounded-lg border-2 border-dashed border-line p-6 text-center text-[13px] text-muted">{t('batch.drop')}</p>
          ) : (
            <ul className="flex max-h-[50vh] flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line" data-batch-files="">
              {files.map((f) => {
                const r = results?.find((x) => x.input === f)
                return (
                  <li key={f} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                    {r ? r.output ? <CheckCircle2 size={14} className="shrink-0 text-ok" /> : <XCircle size={14} className="shrink-0 text-danger" /> : null}
                    <span className="min-w-0 flex-1 truncate" title={r?.error ?? f} dir="auto">
                      {f.split(/[\\/]/).pop()}
                      {r?.error && <span className="block truncate text-[11px] text-danger">{r.error}</span>}
                    </span>
                    {r?.output && (
                      <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => void window.api.showInFolder(r.output!)}>
                        {t('showInFolder')}
                      </button>
                    )}
                    <button type="button" aria-label={t('delete')} className="shrink-0 rounded p-0.5 text-muted hover:text-danger" onClick={() => setFiles(files.filter((x) => x !== f))}>
                      <X size={13} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[14px] font-semibold">{t('batch.steps')}</h2>
          <ol className="flex flex-col gap-2" data-batch-steps="">
            {steps.map((s, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{i + 1}</span>
                  <span className="flex-1 text-[13px] font-medium">{t(`batch.step.${s.kind}` as Key)}</span>
                  <button type="button" aria-label={t('moveUp')} disabled={i === 0} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" aria-label={t('moveDown')} disabled={i === steps.length - 1} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30" onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button type="button" aria-label={t('delete')} className="rounded p-1 text-muted hover:text-danger" onClick={() => setSteps(steps.filter((_, k) => k !== i))}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <StepOptions step={s} onChange={(n) => update(i, n)} />
              </li>
            ))}
          </ol>
          {adding ? (
            <div className="grid grid-cols-2 gap-1.5">
              {STEP_KINDS.filter((k) => k !== 'convert' || convertIndex < 0).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setSteps([...steps, defaultStep(k, t)])
                    setAdding(false)
                  }}
                  className="rounded-lg border border-line px-2.5 py-2 text-start text-[12px] hover:border-accent hover:bg-accent-soft"
                >
                  {t(`batch.step.${k}` as Key)}
                </button>
              ))}
            </div>
          ) : (
            <Button icon={<Plus size={15} />} className="self-start" onClick={() => setAdding(true)}>
              {t('batch.addStep')}
            </Button>
          )}
          {problem && files.length > 0 && <p className="text-[12px] text-warn">{problem}</p>}
        </section>

        <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[14px] font-semibold">{t('batch.output')}</h2>
          <div className="flex flex-col gap-1.5">
            <label className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px]', folder === null ? 'border-accent bg-accent-soft' : 'border-line')}>
              <input type="radio" checked={folder === null} onChange={() => setFolder(null)} className="accent-[var(--accent)]" />
              {t('batch.sameFolder')}
            </label>
            <label className={clsx('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px]', folder !== null ? 'border-accent bg-accent-soft' : 'border-line')}>
              <input
                type="radio"
                checked={folder !== null}
                onChange={async () => {
                  const dir = await window.api.pickFolder()
                  if (dir) setFolder(dir)
                }}
                className="accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1 truncate" dir="ltr">
                {folder ?? t('batch.otherFolder')}
              </span>
              <FolderOpen size={14} className="shrink-0 text-muted" />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted">{t('batch.suffix')}</span>
            <TextInput value={suffix} onChange={(e) => setSuffix(e.target.value.replace(/[\\/:*?"<>|]/g, ''))} dir="ltr" />
            <span className="text-[11px] text-faint">{t('batch.suffixHint', { example: `report${suffix}.pdf` })}</span>
          </label>
          <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="text-[12px] font-medium text-muted">{t('batch.keep')}</span>
            <div className="flex gap-2">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t('batch.keepName')} dir="auto" />
              <Button icon={<Save size={14} />} disabled={!name.trim() || steps.length === 0} onClick={() => void keep()}>
                {t('batch.keepButton')}
              </Button>
            </div>
            <span className="text-[11px] text-faint">{t('batch.keepHint')}</span>
          </div>
        </section>
      </div>
    </div>
  )
}

function StepOptions({ step, onChange }: { step: BatchStep; onChange: (s: BatchStep) => void }) {
  const t = useT()
  switch (step.kind) {
    case 'compress':
      return <Select compact value={step.level} onChange={(level) => onChange({ ...step, level })} options={(['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: t(`level.${v}` as Key) }))} />
    case 'ocr':
      return <Select compact value={step.language} onChange={(language) => onChange({ ...step, language })} options={[{ value: 'auto', label: t('ocr.auto') }, { value: 'ar', label: t('ocr.arabic') }, { value: 'en', label: t('ocr.english') }]} />
    case 'watermark':
      return <TextInput value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} dir="auto" />
    case 'pageNumbers':
      return <Select compact value={step.template} onChange={(template) => onChange({ ...step, template })} options={['{n}', '{n} / {N}', 'Page {n} of {N}', 'صفحة {n} من {N}'].map((v) => ({ value: v, label: v }))} />
    case 'rotate':
      return <Select compact value={String(step.angle)} onChange={(a) => onChange({ ...step, angle: Number(a) as 90 | 180 | 270 })} options={[{ value: '90', label: '90°' }, { value: '180', label: '180°' }, { value: '270', label: '270°' }]} />
    case 'protect':
      return <TextInput type="password" value={step.password} placeholder={t('batch.password')} onChange={(e) => onChange({ ...step, password: e.target.value })} />
    case 'convert':
      return <Select compact value={step.format} onChange={(format) => onChange({ ...step, format })} options={(['docx', 'xlsx', 'pptx', 'md', 'txt'] as const).map((v) => ({ value: v, label: t(`convert.${v}` as Key) }))} />
  }
}

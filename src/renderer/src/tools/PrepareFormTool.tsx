import { CheckSquare, ChevronDown, PenLine, ScanSearch, TextCursorInput, Trash2, Type } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormFieldInfo, Result } from '@shared/ipc'

type Detected = { page: number; box: [number, number, number, number]; kind: 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'; name: string }
import { apply, runBusy, toast, updateView, useStore, useT, type DocView } from '../store'
import { Button, Field, Section } from '../components/ui'
import { IconRow } from './ModePanels'
import type { Key } from '../i18n'

export type FieldKind = 'text' | 'multiline' | 'checkbox' | 'dropdown' | 'signature'

/**
 * Prepare a form, as Acrobat's (research-acrobat-tools §11): detect the blanks of a flat form
 * and make them fields, or draw fields of a chosen kind on the page; the fields are listed and
 * outlined on the page with their names (docs/decisions.md §55).
 */
export function PrepareFormTool({ view }: { view: DocView }) {
  const t = useT()
  const id = view.info.id
  const prepare = view.prepare
  const [fields, setFields] = useState<FormFieldInfo[]>([])
  useEffect(() => {
    updateView(id, { prepare: { kind: 'text', options: 'Option 1\nOption 2' } })
    return () => updateView(id, { prepare: null })
  }, [id])
  useEffect(() => void window.api.formFields(id).then((r) => r.ok && setFields(r.value)), [id, view.info.revision])
  const setKind = (kind: FieldKind): void => {
    const now = useStore.getState().docs[id]?.prepare
    if (now) updateView(id, { prepare: { ...now, kind } })
  }
  const detect = async (): Promise<void> => {
    const found = await runBusy(t('prepare.detecting'), async (): Promise<Result<Detected[]>> => {
      const all: Detected[] = []
      for (let p = 0; p < view.info.pages.length; p++) {
        const r = await window.api.detectFields(id, p)
        if (!r.ok) return r
        all.push(...r.value)
      }
      return { ok: true, value: all }
    })
    if (!found) return
    if (found.length === 0) {
      toast('info', t('prepare.noneFound'))
      return
    }
    await apply(id, { op: 'addFields', fields: found }, t('prepare.detect'))
    toast('success', t('prepare.found', { count: found.length }))
  }
  const kinds: Array<{ kind: FieldKind; icon: React.ReactNode }> = [
    { kind: 'text', icon: <TextCursorInput size={16} /> },
    { kind: 'multiline', icon: <Type size={16} /> },
    { kind: 'checkbox', icon: <CheckSquare size={16} /> },
    { kind: 'dropdown', icon: <ChevronDown size={16} /> },
    { kind: 'signature', icon: <PenLine size={16} /> }
  ]
  return (
    <>
      <Section title={t('prepare.auto')}>
        <p className="text-[12px] leading-snug text-muted">{t('prepare.autoHint')}</p>
        <Button icon={<ScanSearch size={15} />} className="self-start" onClick={() => void detect()}>
          {t('prepare.detect')}
        </Button>
      </Section>
      <Section title={t('prepare.add')}>
        <IconRow items={kinds.map((k) => ({ icon: k.icon, label: t(`prepare.kind.${k.kind}` as Key), active: prepare?.kind === k.kind, onClick: () => setKind(k.kind) }))} />
        {prepare && <p className="text-[12px] font-medium">{t(`prepare.kind.${prepare.kind}` as Key)}</p>}
        <p className="text-[12px] leading-snug text-muted">{t('prepare.drawHint')}</p>
        {prepare?.kind === 'dropdown' && (
          <Field label={t('prepare.options')} hint={t('prepare.optionsHint')}>
            <textarea
              value={prepare.options}
              onChange={(e) => updateView(id, { prepare: { ...prepare, options: e.target.value } })}
              rows={3}
              dir="auto"
              className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/20"
            />
          </Field>
        )}
      </Section>
      <Section title={t('prepare.fields', { count: fields.length })}>
        {fields.length === 0 ? (
          <p className="text-[12px] text-muted">{t('prepare.noFields')}</p>
        ) : (
          <ul className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line" data-prepare-fields="">
            {fields.map((f) => (
              <li key={`${f.page}-${f.index}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {f.name}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {t(`prepare.kind.${f.kind === 'combo' || f.kind === 'list' ? 'dropdown' : f.kind === 'text' && f.multiline ? 'multiline' : f.kind === 'radio' ? 'checkbox' : f.kind === 'button' ? 'text' : f.kind}` as Key)} · {t('pageN', { n: f.page + 1 })}
                </span>
                <button type="button" aria-label={t('delete')} title={t('delete')} className="shrink-0 rounded p-0.5 text-muted hover:text-danger" onClick={() => void apply(id, { op: 'removeField', page: f.page, index: f.index }, t('delete'))}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

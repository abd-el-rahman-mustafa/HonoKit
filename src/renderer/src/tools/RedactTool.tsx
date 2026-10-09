import { Search, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apply, confirmAction, updateView, useStore, useT, type DocView } from '../store'
import { Button, Check, Field, Section, Segmented } from '../components/ui'
import { ToolFooter } from './common'
import type { Key } from '../i18n'

type Pattern = 'email' | 'phone' | 'emiratesId' | 'iban' | 'card' | 'date'
const PATTERNS: Pattern[] = ['email', 'phone', 'emiratesId', 'iban', 'card', 'date']
type Hit = { page: number; boxes: Array<[number, number, number, number]>; text: string; context: string }
const FILLS = ['#000000', '#4b5563', '#ffffff']

/**
 * Redact, as Acrobat's (docs/research-acrobat-tools.md §5): mark text or areas on the page,
 * or find words and patterns and mark what was found; the marks stay as red outlines to
 * review. Apply removes everything under them for good, paints the boxes, optionally cleans
 * hidden information, and checks that no text is left (docs/decisions.md §46).
 */
export function RedactTool({ view }: { view: DocView }) {
  const t = useT()
  const id = view.info.id
  const revision = view.info.revision
  const author = useStore((s) => s.settings?.authorName ?? '')
  const redact = view.redact
  useEffect(() => {
    updateView(id, { redact: { marks: [], by: 'text' } })
    return () => updateView(id, { redact: null })
  }, [id])
  // The marks are in the document: read them again after every change.
  useEffect(() => {
    void window.api.redactMarks(id).then((r) => {
      if (!r.ok) return
      const now = useStore.getState().docs[id]?.redact
      if (now) updateView(id, { redact: { ...now, marks: r.value } })
    })
  }, [id, revision])
  const [words, setWords] = useState('')
  const [whole, setWhole] = useState(true)
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [fill, setFill] = useState('#000000')
  const [label, setLabel] = useState('')
  const [clean, setClean] = useState(true)
  const marks = redact?.marks ?? []
  const pages = new Set(marks.map((m) => m.page)).size

  const find = async (): Promise<void> => {
    const r = await window.api.redactFind(id, { words: words.split(/\r?\n/).map((w) => w.trim()).filter(Boolean), patterns, wholeWords: whole })
    if (!r.ok) return
    setHits(r.value)
    setChecked(new Set(r.value.map((_, i) => i)))
  }
  const markChecked = async (): Promise<void> => {
    if (!hits) return
    const chosen = hits.filter((_, i) => checked.has(i))
    if (chosen.length === 0) return
    await apply(id, { op: 'redactMark', author: author || undefined, marks: chosen.flatMap((h) => h.boxes.map((box) => ({ page: h.page, box }))) }, t('redact.marking'))
    setHits(null)
  }
  const applyAll = async (): Promise<void> => {
    // A signed file is rewritten in full, which breaks its signatures: say so first, as Acrobat does.
    const sigs = await window.api.signatures(id)
    const signed = sigs.ok && sigs.value.length > 0
    const message = t('redact.confirmMessage', { count: marks.length }) + (signed ? ` ${t('redact.confirmSigned')}` : '')
    if (!(await confirmAction(t('redact.confirmTitle'), message, t('act.redact')))) return
    await apply(id, { op: 'redactApply', fill, ...(label.trim() ? { label: label.trim() } : {}), sanitize: clean }, t('tool.redact'))
  }

  return (
    <>
      <Section title={t('redact.mark')}>
        {redact && (
          <Segmented
            value={redact.by}
            onChange={(by) => updateView(id, { redact: { ...redact, by } })}
            options={[
              { value: 'text', label: t('redact.byText') },
              { value: 'area', label: t('redact.byArea') }
            ]}
          />
        )}
        <p className="text-[12px] leading-snug text-muted">{redact?.by === 'area' ? t('redact.byAreaHint') : t('redact.byTextHint')}</p>
      </Section>

      <Section title={t('redact.find')}>
        <Field label={t('redact.words')}>
          <textarea
            value={words}
            onChange={(e) => setWords(e.target.value)}
            dir="auto"
            rows={2}
            className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/20"
          />
        </Field>
        <Check checked={whole} onChange={setWhole} label={t('redact.wholeWords')} />
        <span className="text-[12px] font-medium text-muted">{t('redact.patterns')}</span>
        <div className="flex flex-col gap-1">
          {PATTERNS.map((p) => (
            <Check key={p} checked={patterns.includes(p)} onChange={(on) => setPatterns(on ? [...patterns, p] : patterns.filter((x) => x !== p))} label={t(`redact.pattern.${p}` as Key)} />
          ))}
        </div>
        <Button icon={<Search size={15} />} disabled={!words.trim() && patterns.length === 0} onClick={() => void find()} className="self-start">
          {t('redact.search')}
        </Button>
        {hits && (
          <div className="flex flex-col gap-2" data-redact-results="">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-medium">{hits.length ? t('redact.found', { count: hits.length }) : t('redact.noneFound')}</span>
              {hits.length > 0 && (
                <button type="button" className="ms-auto text-accent hover:underline" onClick={() => setChecked(new Set(hits.map((_, i) => i)))}>
                  {t('redact.checkAll')}
                </button>
              )}
            </div>
            {hits.length > 0 && (
              <div className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {hits.map((h, i) => (
                  <div key={i} className="px-2 py-1.5">
                    <Check
                      checked={checked.has(i)}
                      onChange={(on) => {
                        const next = new Set(checked)
                        if (on) next.add(i)
                        else next.delete(i)
                        setChecked(next)
                      }}
                      label={h.text}
                      hint={`${t('pageN', { n: h.page + 1 })} · ${h.context}`}
                    />
                  </div>
                ))}
              </div>
            )}
            {hits.length > 0 && (
              <Button variant="primary" disabled={checked.size === 0} onClick={() => void markChecked()} className="self-start">
                {t('redact.markChecked', { count: checked.size })}
              </Button>
            )}
          </div>
        )}
      </Section>

      <Section title={t('redact.appearance')}>
        <div className="flex items-center gap-2">
          {FILLS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={fill === c}
              onClick={() => setFill(c)}
              className={`h-7 w-7 rounded-md border ${fill === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''} border-line`}
              style={{ background: c }}
            />
          ))}
        </div>
        <Field label={t('redact.label')} hint={t('redact.labelHint')}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            dir="auto"
            className="h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/20"
          />
        </Field>
        <Check checked={clean} onChange={setClean} label={t('redact.sanitize')} hint={t('redact.sanitizeHint')} />
      </Section>

      <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px]" data-redact-count={marks.length}>
        <span className="flex-1">{marks.length ? t('redact.marks', { count: marks.length, pages }) : t('redact.noMarks')}</span>
        {marks.length > 0 && (
          <button type="button" className="flex items-center gap-1 text-danger hover:underline" onClick={() => void apply(id, { op: 'redactClear' }, t('redact.clear'))}>
            <Trash2 size={13} />
            {t('redact.clear')}
          </button>
        )}
      </div>

      <ToolFooter>
        <Button variant="primary" disabled={marks.length === 0} onClick={() => void applyAll()}>
          {t('act.redact')}
        </Button>
      </ToolFooter>
    </>
  )
}

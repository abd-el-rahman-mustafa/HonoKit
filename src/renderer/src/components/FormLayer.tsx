import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { autoFieldSize } from '@shared/fieldText'
import type { FormFieldInfo } from '@shared/ipc'
import { BadgeCheck, FileWarning, ScanText, ShieldAlert, X } from 'lucide-react'
import { apply, openTool, typing, updateView, useT, type DocView } from '../store'
import { px } from './editGeometry'

/**
 * Filling in a form, as Acrobat's: the fields are live on the page — type in a text field,
 * click a checkbox or a radio button, pick from a drop-down. With "Highlight fields" on they
 * are tinted blue and required ones outlined red. Each change is applied to the document
 * (undoable) and drawn by the engine, Arabic included (docs/decisions.md §47).
 */
/** The largest text a live field asks the browser for, in screen pixels. */
const MAX_SCREEN_FIELD_FONT = 256

export function FormLayer({ view, page, scale }: { view: DocView; page: number; scale: number }) {
  const [fields, setFields] = useState<FormFieldInfo[]>([])
  const layer = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const { info } = view
  useEffect(() => {
    const el = layer.current
    if (!el) return
    const observer = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: '300px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let gone = false
    void window.api.formFields(info.id, page).then((r) => {
      if (!gone && r.ok) setFields(r.value)
    })
    return () => {
      gone = true
    }
  }, [visible, info.id, info.revision, page])
  const highlight = view.forms?.highlight ?? true
  const fill = (f: FormFieldInfo, value: string | boolean): Promise<unknown> => apply(info.id, { op: 'fillForm', values: [{ page, index: f.index, value }] }, f.name || 'Form')
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10" data-form-layer="">
      {fields
        .filter((f) => !f.readOnly && f.kind !== 'button' && f.kind !== 'signature')
        .map((f) => (
          <Field key={`${f.index}-${info.revision}`} docId={info.id} fieldKey={`${page}/${f.index}`} field={f} scale={scale} highlight={highlight} onFill={(v) => fill(f, v)} />
        ))}
    </div>
  )
}

function Field({ docId, fieldKey, field: f, scale, highlight, onFill }: { docId: string; fieldKey: string; field: FormFieldInfo; scale: number; highlight: boolean; onFill: (v: string | boolean) => Promise<unknown> }) {
  const t = useT()
  const [text, setText] = useState(f.value)
  const [focused, setFocused] = useState(false)
  // What is typed is committed when the field is left, or first thing when Save, Print, Export…
  // read the document while it is still being typed (§82): once either way.
  const latest = useRef(f.value)
  const committed = useRef(f.value)
  const commitTyped = (): Promise<unknown> => {
    typing.set(docId, fieldKey, null)
    const value = latest.current
    if (value === committed.current) return Promise.resolve()
    committed.current = value
    return onFill(value)
  }
  const type = (value: string): void => {
    latest.current = value
    setText(value)
    typing.set(docId, fieldKey, value === committed.current ? null : commitTyped)
  }
  // A field redrawn for a new revision starts again from the document's value.
  useEffect(() => () => typing.set(docId, fieldKey, null), [docId, fieldKey])
  const style = px(f.box, scale)
  const tint = highlight ? 'bg-[rgb(20_115_230/0.12)] hover:bg-[rgb(20_115_230/0.2)]' : 'hover:bg-[rgb(20_115_230/0.1)]'
  const outline = highlight && f.required ? 'outline-1 outline-red-500' : ''
  if (f.kind === 'checkbox' || f.kind === 'radio')
    return (
      <button
        type="button"
        role={f.kind}
        aria-checked={f.checked}
        aria-label={f.name}
        title={f.name}
        onClick={() => (f.kind === 'radio' && f.checked ? undefined : onFill(!f.checked))}
        className={clsx('pointer-events-auto absolute cursor-pointer', f.kind === 'radio' ? 'rounded-full' : 'rounded-[2px]', tint, outline)}
        style={style}
      />
    )
  if (f.kind === 'combo' || f.kind === 'list')
    return (
      <select
        aria-label={f.name}
        title={f.name}
        value={f.value}
        onChange={(e) => onFill(e.target.value)}
        className={clsx('pointer-events-auto absolute cursor-pointer appearance-none bg-transparent text-transparent outline-none focus:ring-2 focus:ring-accent', tint, outline)}
        style={style}
      >
        {!f.options.includes(f.value) && <option value={f.value}>{f.value || '—'}</option>}
        {f.options.map((o) => (
          <option key={o} value={o} className="text-black">
            {o}
          </option>
        ))}
      </select>
    )
  const height = f.box[3] - f.box[1]
  // The size the engine will draw the value at, so what is typed matches the saved page. The
  // size on screen is capped after the zoom: a tall field at a high zoom must not ask the
  // browser for a glyph hundreds of points tall.
  const size = Math.min(autoFieldSize(height, f.multiline) * scale, MAX_SCREEN_FIELD_FONT)
  const commit = (): void => {
    setFocused(false)
    void commitTyped()
  }
  const common = {
    value: text,
    dir: 'auto' as const,
    'aria-label': f.name,
    title: f.name,
    maxLength: f.maxLen > 0 ? f.maxLen : undefined,
    placeholder: focused ? t('form.typeHere') : undefined,
    onFocus: () => setFocused(true),
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => type(e.target.value),
    // While typing, the field is opaque: the page's drawing of the old value is hidden under it.
    className: clsx(
      'pointer-events-auto absolute resize-none rounded-[2px] border-0 px-[2px] outline-none',
      focused ? 'bg-white text-black ring-2 ring-accent' : clsx('text-transparent caret-transparent', tint),
      outline
    ),
    style: { ...style, fontSize: size, lineHeight: 1.2 }
  }
  return f.multiline ? (
    <textarea {...common} onKeyDown={(e) => e.key === 'Escape' && (type(f.value), (e.target as HTMLTextAreaElement).blur())} />
  ) : (
    <input
      {...common}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') {
          type(f.value)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

/** Acrobat's signature bar: who signed, and whether the signatures hold (docs/decisions.md §53). */
export function SignatureBar({ view }: { view: DocView }) {
  const t = useT()
  const [sigs, setSigs] = useState<Array<{ signer: string; name: string; valid: boolean; modifiedAfter: boolean; selfSigned: boolean }> | null>(null)
  useEffect(() => {
    let gone = false
    void window.api.signatures(view.info.id).then((r) => !gone && r.ok && setSigs(r.value))
    return () => {
      gone = true
    }
  }, [view.info.id, view.info.revision])
  if (!sigs || sigs.length === 0) return null
  const bad = sigs.filter((s) => !s.valid)
  const who = [...new Set(sigs.map((s) => s.name || s.signer))].join('، ')
  const text = bad.length ? t('sig.invalid', { count: bad.length }) : sigs.some((s) => s.modifiedAfter) ? t('sig.validChanged', { who }) : t('sig.valid', { who })
  return (
    <div
      className={clsx('flex min-h-10 shrink-0 items-center gap-3 border-b border-line px-4 py-1.5 text-[13px]', bad.length ? 'bg-[color-mix(in_srgb,var(--danger)_12%,var(--surface))]' : 'bg-[color-mix(in_srgb,var(--ok)_12%,var(--surface))]')}
      role="status"
      data-signature-bar=""
    >
      {bad.length ? <ShieldAlert size={16} className="shrink-0 text-danger" /> : <BadgeCheck size={16} className="shrink-0 text-ok" />}
      <span className="flex-1" dir="auto">
        {text}
      </span>
      {!bad.length && sigs.some((s) => s.selfSigned) && <span className="text-[11px] text-muted">{t('sig.selfSigned')}</span>}
    </div>
  )
}

/** Acrobat's bar for a scanned document: its pages are pictures, so offer to recognise the text. */
export function ScanBar({ view }: { view: DocView }) {
  const t = useT()
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-line bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-4 py-1.5 text-[13px]" role="status" data-scan-bar="">
      <ScanText size={16} className="shrink-0 text-accent" />
      <span className="flex-1">{t('ocr.bar')}</span>
      <button type="button" className="shrink-0 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink hover:brightness-110" onClick={() => openTool('ocr')}>
        {t('tool.ocr')}
      </button>
      <button type="button" aria-label={t('close')} title={t('close')} className="shrink-0 rounded-md p-1 text-muted hover:bg-surface-2" onClick={() => updateView(view.info.id, { scanned: 'dismissed' })}>
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * A dynamic XFA form (Adobe LiveCycle): its pages are a placeholder that only Adobe's readers
 * replace by laying the form out. Said plainly, as Chrome and Edge show the placeholder alone.
 */
export function XfaBar() {
  const t = useT()
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-line bg-[color-mix(in_srgb,var(--warn)_12%,var(--surface))] px-4 py-1.5 text-[13px]" role="status" data-xfa-bar="">
      <FileWarning size={16} className="shrink-0 text-warn" />
      <span className="flex-1 leading-snug">{t('xfa.dynamic')}</span>
    </div>
  )
}

/** Acrobat's message bar for documents with form fields. */
export function FormBar({ view }: { view: DocView }) {
  const t = useT()
  const forms = view.forms!
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-line bg-[color-mix(in_srgb,var(--brand)_10%,var(--surface))] px-4 py-1.5 text-[13px]" role="status" data-form-bar="">
      <span className="flex-1">{t('form.bar', { count: forms.count })}</span>
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px]">
        <input type="checkbox" checked={forms.highlight} onChange={(e) => updateForms(view, { highlight: e.target.checked })} className="accent-[var(--accent)]" />
        {t('form.highlight')}
      </label>
    </div>
  )
}

function updateForms(view: DocView, patch: Partial<NonNullable<DocView['forms']>>): void {
  updateView(view.info.id, { forms: { ...view.forms!, ...patch } })
}

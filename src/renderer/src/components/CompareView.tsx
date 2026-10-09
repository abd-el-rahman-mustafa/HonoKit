import clsx from 'clsx'
import { ArrowLeft, ArrowLeftRight, ChevronDown, ChevronUp, FileText, FolderOpen, GitCompareArrows, TextCursorInput } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CompareOptions, CompareResult, CompareSide, CompareSource } from '@shared/ipc'
import { openTool, runBusy, useStore, useT } from '../store'
import { Button, Check, Segmented, Select, usePixelRatio } from './ui'

/**
 * Compare, as Acrobat's Compare files — and also texts (docs/decisions.md §45): choose the
 * old and the new version (an open document, a PDF file, or text pasted or opened from a
 * file), then see both side by side with every change marked, a list of the changes, and
 * Previous / Next. Removed words are red on the old side, added words green on the new
 * side, changed words amber on both.
 */

type Choice = { kind: 'doc'; docId: string; name: string } | { kind: 'file'; path: string; name: string } | { kind: 'text'; text: string; name: string } | null

const DEFAULT_OPTIONS: CompareOptions = { ignoreMarks: true, ignorePunctuation: false, sameDigits: true }

export function CompareView() {
  const t = useT()
  const docs = useStore((s) => s.docs)
  const order = useStore((s) => s.order)
  const active = useStore((s) => s.active)
  const [a, setA] = useState<Choice>(() => (active && docs[active] ? { kind: 'doc', docId: active, name: docs[active]!.info.name } : null))
  const [b, setB] = useState<Choice>(null)
  const [options, setOptions] = useState<CompareOptions>(DEFAULT_OPTIONS)
  const [result, setResult] = useState<CompareResult | null>(null)
  useEffect(() => () => void (result && window.api.compareClose(result.token)), [result])

  const source = (c: NonNullable<Choice>): CompareSource => (c.kind === 'doc' ? { kind: 'doc', docId: c.docId } : c.kind === 'file' ? { kind: 'file', path: c.path } : { kind: 'text', text: c.text, name: c.name })
  const ready = !!a && !!b && (a.kind !== 'text' || a.text.trim().length > 0) && (b.kind !== 'text' || b.text.trim().length > 0)
  const run = async (): Promise<void> => {
    if (!a || !b) return
    const r = await runBusy(t('compare.working'), () => window.api.compare(source(a), source(b), options))
    if (r) setResult(r)
  }

  return (
    <div className="flex h-full flex-col" data-compare="">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <GitCompareArrows size={20} className="text-brand" />
        <h1 className="me-3 text-[16px] font-semibold">{t('tool.compare')}</h1>
        {result && (
          <Button icon={<ArrowLeft size={15} className="rtl:rotate-180" />} onClick={() => setResult(null)}>
            {t('compare.change')}
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={() => openTool(null)}>{t('close')}</Button>
        {!result && (
          <Button variant="primary" icon={<GitCompareArrows size={15} />} disabled={!ready} onClick={() => void run()}>
            {t('act.compare')}
          </Button>
        )}
      </header>
      {result ? (
        <Results result={result} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto bg-sunken p-6">
          <div className="mx-auto flex max-w-5xl flex-col gap-5">
            <div className="flex flex-col items-stretch gap-3 md:flex-row">
              <SideCard title={t('compare.old')} value={a} onChange={setA} docs={order.filter((id) => docs[id]).map((id) => ({ id, name: docs[id]!.info.name }))} />
              <button
                type="button"
                title={t('compare.swap')}
                aria-label={t('compare.swap')}
                onClick={() => {
                  setA(b)
                  setB(a)
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-full border border-line bg-surface text-muted shadow-sm hover:text-ink"
              >
                <ArrowLeftRight size={17} className="max-md:rotate-90" />
              </button>
              <SideCard title={t('compare.new')} value={b} onChange={setB} docs={order.filter((id) => docs[id]).map((id) => ({ id, name: docs[id]!.info.name }))} />
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
              <span className="text-[12px] font-semibold tracking-wide text-muted uppercase">{t('compare.options')}</span>
              <Check checked={options.ignoreMarks} onChange={(ignoreMarks) => setOptions({ ...options, ignoreMarks })} label={t('compare.ignoreMarks')} hint={t('compare.ignoreMarksHint')} />
              <Check checked={options.sameDigits} onChange={(sameDigits) => setOptions({ ...options, sameDigits })} label={t('compare.sameDigits')} />
              <Check checked={options.ignorePunctuation} onChange={(ignorePunctuation) => setOptions({ ...options, ignorePunctuation })} label={t('compare.ignorePunctuation')} />
            </div>
            <p className="text-[12px] text-muted">{t('compare.about')}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function SideCard({ title, value, onChange, docs }: { title: string; value: Choice; onChange: (c: Choice) => void; docs: Array<{ id: string; name: string }> }) {
  const t = useT()
  const mode = value?.kind === 'text' ? 'text' : 'pdf'
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-line bg-surface p-4" data-compare-side="">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <div className="w-44">
          <Segmented
            value={mode}
            onChange={(m) => onChange(m === 'text' ? { kind: 'text', text: '', name: t('compare.pasted') } : null)}
            options={[
              { value: 'pdf', label: t('compare.pdf') },
              { value: 'text', label: t('compare.text') }
            ]}
          />
        </div>
      </div>
      {mode === 'pdf' ? (
        <div className="flex flex-col gap-2">
          <div className="flex min-h-24 items-center gap-3 rounded-lg border border-dashed border-line p-3">
            <FileText size={28} className={value ? 'text-brand' : 'text-faint'} />
            <span className={clsx('min-w-0 flex-1 truncate text-[13px]', value ? 'font-medium' : 'text-muted')} dir="auto">
              {value && value.kind !== 'text' ? value.name : t('compare.nothing')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {docs.length > 0 && (
              <div className="min-w-40 flex-1">
                <Select
                  value={value?.kind === 'doc' ? value.docId : ''}
                  label={t('compare.openDoc')}
                  onChange={(id) => {
                    const d = docs.find((x) => x.id === id)
                    if (d) onChange({ kind: 'doc', docId: d.id, name: d.name })
                  }}
                  options={[{ value: '', label: t('compare.openDoc') }, ...docs.map((d) => ({ value: d.id, label: d.name }))]}
                />
              </div>
            )}
            <Button
              icon={<FolderOpen size={15} />}
              onClick={async () => {
                const [path] = await window.api.pickPdfs(false)
                if (path) onChange({ kind: 'file', path, name: path.split(/[\\/]/).pop() ?? path })
              }}
            >
              {t('compare.chooseFile')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={value?.kind === 'text' ? value.text : ''}
            onChange={(e) => onChange({ kind: 'text', text: e.target.value, name: value?.kind === 'text' ? value.name : t('compare.pasted') })}
            placeholder={t('compare.paste')}
            dir="auto"
            spellCheck={false}
            className="h-40 w-full resize-y rounded-lg border border-line bg-surface p-2.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/20"
            data-compare-text=""
          />
          <Button
            className="self-start"
            icon={<TextCursorInput size={15} />}
            onClick={async () => {
              const file = await window.api.pickTextFile()
              if (file) onChange({ kind: 'text', text: file.text, name: file.name })
            }}
          >
            {t('compare.openText')}
          </Button>
        </div>
      )}
    </section>
  )
}

type Mark = 'delete' | 'insert' | 'replace'

/** For each word index on one side: which change it belongs to and how it changed. */
function marksFor(result: CompareResult, side: 'a' | 'b'): Map<number, { change: number; kind: Mark }> {
  const out = new Map<number, { change: number; kind: Mark }>()
  result.changes.forEach((c, index) => {
    const [from, to] = c[side]
    for (let i = from; i < to; i++) out.set(i, { change: index, kind: c.kind })
  })
  return out
}

const COLOUR: Record<Mark, string> = { delete: 'rgb(220 38 38 / 0.28)', insert: 'rgb(22 163 74 / 0.28)', replace: 'rgb(245 158 11 / 0.32)' }
const LINE: Record<Mark, string> = { delete: '#dc2626', insert: '#16a34a', replace: '#d97706' }

function Results({ result }: { result: CompareResult }) {
  const t = useT()
  const [current, setCurrent] = useState(0)
  const count = result.changes.length
  const added = result.changes.reduce((n, c) => n + (c.kind === 'insert' ? c.b[1] - c.b[0] : 0), 0)
  const removed = result.changes.reduce((n, c) => n + (c.kind === 'delete' ? c.a[1] - c.a[0] : 0), 0)
  const changed = result.changes.filter((c) => c.kind === 'replace').length
  const words = (side: CompareSide, range: [number, number]): string =>
    side.words
      .slice(range[0], Math.min(range[1], range[0] + 12))
      .map((w) => w.text)
      .join(' ') + (range[1] - range[0] > 12 ? ' …' : '')
  const go = (i: number): void => setCurrent(Math.max(0, Math.min(count - 1, i)))
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'F3' || (e.key === 'ArrowDown' && e.altKey)) {
        e.preventDefault()
        go(current + (e.shiftKey ? -1 : 1))
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  return (
    <div className="flex min-h-0 flex-1" data-compare-results="">
      <aside className="flex w-72 shrink-0 flex-col border-e border-line bg-surface">
        <div className="flex flex-col gap-2 border-b border-line p-4">
          <span className="text-[15px] font-semibold">{count === 0 ? t('compare.same') : t('compare.count', { count })}</span>
          {count > 0 && (
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded-full px-2 py-0.5" style={{ background: COLOUR.insert }}>
                {t('compare.added', { count: added })}
              </span>
              <span className="rounded-full px-2 py-0.5" style={{ background: COLOUR.delete }}>
                {t('compare.removed', { count: removed })}
              </span>
              <span className="rounded-full px-2 py-0.5" style={{ background: COLOUR.replace }}>
                {t('compare.changed', { count: changed })}
              </span>
            </div>
          )}
          {count > 0 && (
            <div className="flex items-center gap-1.5">
              <Button className="h-7 px-2.5" icon={<ChevronUp size={14} />} disabled={current === 0} onClick={() => go(current - 1)}>
                {t('compare.previous')}
              </Button>
              <Button className="h-7 px-2.5" icon={<ChevronDown size={14} />} disabled={current >= count - 1} onClick={() => go(current + 1)}>
                {t('compare.next')}
              </Button>
              <span className="ms-auto text-[12px] text-muted tabular-nums">
                {current + 1}/{count}
              </span>
            </div>
          )}
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto p-2" data-compare-list="">
          {result.changes.map((c, i) => {
            const page = (side: CompareSide, range: [number, number]): number | undefined => side.words[range[0]]?.page ?? side.words[Math.max(0, range[0] - 1)]?.page
            const where = result.a.kind === 'pdf' ? page(result.a, c.a) : page(result.b, c.b)
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => setCurrent(i)}
                  className={clsx('flex w-full flex-col gap-1 rounded-lg border-s-[3px] px-2.5 py-2 text-start text-[12px]', i === current ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                  style={{ borderInlineStartColor: LINE[c.kind] }}
                >
                  <span className="flex items-center gap-2 text-[11px] text-muted">
                    {t(`compare.kind.${c.kind}`)}
                    {where !== undefined && <span>· {t('pageN', { n: where + 1 })}</span>}
                  </span>
                  {c.kind !== 'insert' && (
                    <span className="line-through decoration-red-500/60" dir="auto">
                      {words(result.a, c.a)}
                    </span>
                  )}
                  {c.kind !== 'delete' && <span dir="auto">{words(result.b, c.b)}</span>}
                </button>
              </li>
            )
          })}
        </ol>
      </aside>
      <div className="grid min-w-0 flex-1 grid-cols-2 divide-x divide-line rtl:divide-x-reverse">
        <Pane result={result} side="a" current={current} onPick={setCurrent} />
        <Pane result={result} side="b" current={current} onPick={setCurrent} />
      </div>
    </div>
  )
}

function Pane({ result, side, current, onPick }: { result: CompareResult; side: 'a' | 'b'; current: number; onPick: (i: number) => void }) {
  const t = useT()
  const data = result[side]
  const marks = useMemo(() => marksFor(result, side), [result, side])
  const scroller = useRef<HTMLDivElement>(null)
  // Bring the current change into view on this side.
  useEffect(() => {
    const el = scroller.current?.querySelector(`[data-change="${current}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else if (data.kind === 'pdf') {
      // A change with no words on this side (an insert seen from the old side): its neighbour.
      const c = result.changes[current]
      const near = c ? data.words[Math.max(0, Math.min(data.words.length - 1, c[side][0]))] : undefined
      if (near?.page !== undefined) scroller.current?.querySelector(`[data-compare-page="${near.page}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [current, result, side, data])
  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 text-[12px]">
        <span className="font-semibold">{side === 'a' ? t('compare.old') : t('compare.new')}</span>
        <span className="truncate text-muted" dir="auto">
          {data.name}
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-sunken" data-compare-pane={side}>
        {data.kind === 'pdf' ? <PdfPages token={result.token} side={side} data={data} marks={marks} current={current} onPick={onPick} /> : <TextView data={data} marks={marks} current={current} onPick={onPick} />}
      </div>
    </div>
  )
}

function PdfPages({ token, side, data, marks, current, onPick }: { token: string; side: 'a' | 'b'; data: CompareSide; marks: Map<number, { change: number; kind: Mark }>; current: number; onPick: (i: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  const dpr = usePixelRatio()
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - 32)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const byPage = useMemo(() => {
    const out = new Map<number, Array<{ box: [number, number, number, number]; change: number; kind: Mark }>>()
    data.words.forEach((w, i) => {
      const m = marks.get(i)
      if (!m || w.page === undefined || !w.box) return
      const list = out.get(w.page) ?? []
      list.push({ box: w.box, ...m })
      out.set(w.page, list)
    })
    return out
  }, [data, marks])
  return (
    <div ref={box} className="flex flex-col items-center gap-4 p-4">
      {(data.pages ?? []).map((p, i) => {
        const scale = width / p.width
        return (
          <div key={i} className="relative bg-white shadow-md" style={{ width: p.width * scale, height: p.height * scale }} data-compare-page={i}>
            <ComparePageImage token={token} side={side} page={i} scale={Math.min(2, scale * dpr)} />
            {(byPage.get(i) ?? []).map((m, k) => (
              <button
                key={k}
                type="button"
                onClick={() => onPick(m.change)}
                data-change={k === (byPage.get(i) ?? []).findIndex((x) => x.change === m.change) ? m.change : undefined}
                className="absolute rounded-[2px]"
                style={{
                  left: m.box[0] * scale - 1,
                  top: m.box[1] * scale - 1,
                  width: (m.box[2] - m.box[0]) * scale + 2,
                  height: (m.box[3] - m.box[1]) * scale + 2,
                  background: COLOUR[m.kind],
                  outline: m.change === current ? `2px solid ${LINE[m.kind]}` : undefined
                }}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** One page of a compared PDF, drawn when it scrolls near. */
function ComparePageImage({ token, side, page, scale }: { token: string; side: 'a' | 'b'; page: number; scale: number }) {
  const ref = useRef<HTMLImageElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: '600px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!near) return
    let url: string | null = null
    let gone = false
    void window.api.comparePage(token, side, page, Math.round(scale * 20) / 20).then((r) => {
      if (gone || !r.ok) return
      url = URL.createObjectURL(new Blob([r.value.data as Uint8Array<ArrayBuffer>], { type: r.value.mime }))
      setSrc(url)
    })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [near, token, side, page, scale])
  return <img ref={ref} src={src ?? undefined} alt="" className={clsx('absolute inset-0 h-full w-full', !src && 'invisible')} draggable={false} />
}

function TextView({ data, marks, current, onPick }: { data: CompareSide; marks: Map<number, { change: number; kind: Mark }>; current: number; onPick: (i: number) => void }) {
  const text = data.text ?? ''
  const parts: React.ReactNode[] = []
  let at = 0
  let seen = new Set<number>()
  data.words.forEach((w, i) => {
    const m = marks.get(i)
    if (!m || w.start === undefined || w.end === undefined) return
    if (w.start > at) parts.push(text.slice(at, w.start))
    const first = !seen.has(m.change)
    seen.add(m.change)
    parts.push(
      <mark
        key={i}
        onClick={() => onPick(m.change)}
        data-change={first ? m.change : undefined}
        className={clsx('cursor-pointer rounded-[2px] text-inherit', m.kind === 'delete' && 'line-through')}
        style={{ background: COLOUR[m.kind], outline: m.change === current ? `2px solid ${LINE[m.kind]}` : undefined }}
      >
        {text.slice(w.start, w.end)}
      </mark>
    )
    at = w.end
  })
  parts.push(text.slice(at))
  seen = new Set()
  return (
    <div className="m-4 rounded-lg border border-line bg-surface p-5 text-[14px] leading-7 whitespace-pre-wrap text-ink" dir="auto">
      {parts}
    </div>
  )
}

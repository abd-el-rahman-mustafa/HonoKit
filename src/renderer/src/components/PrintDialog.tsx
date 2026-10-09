import { ChevronLeft, ChevronRight, ExternalLink, FileOutput, Printer, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { parsePageList } from '@shared/pagelist'
import type { Paper, PrinterInfo, PrintOptions } from '@shared/ipc'
import { grid, sheetLandscape, sheets, type PerSheet } from '@shared/printlayout'
import { apply, newDocument, runBusy, save, setDialog, toast, useStore, useT, writeFiles, type DocView } from '../store'
import { Modal } from './Overlays'
import { Button, Check, Field, IconButton, NumberInput, PageImage, Segmented, Select, Spinner, TextInput } from './ui'

/** Which pages: all of them, the one in view, those picked on the page grid, or a typed list. */
type Scope = 'all' | 'current' | 'selected' | 'custom'

/** The pages a scope means; null when a typed list does not parse. */
function pagesFor(scope: Scope, custom: string, count: number, current: number, selected: number[]): number[] | null {
  if (scope === 'all') return Array.from({ length: count }, (_, i) => i)
  if (scope === 'current') return [current]
  if (scope === 'selected') return selected.length ? [...selected] : null
  return parsePageList(custom, count)
}

/** Pages as people write them, one-based: "2, 4-6". */
export function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j > i ? `${sorted[i]! + 1}-${sorted[j]! + 1}` : `${sorted[i]! + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** The scope a dialog opens on: the pages it was asked for (right-click), the selection, or the default. */
function initialScope(view: DocView | undefined, preset: number[] | undefined, fallback: Scope): { scope: Scope; custom: string } {
  if (preset?.length) return preset.length === 1 && view && preset[0] === view.page ? { scope: 'current', custom: '' } : { scope: 'custom', custom: formatPages(preset) }
  if (view && view.selected.length > 1) return { scope: 'selected', custom: '' }
  return { scope: fallback, custom: '' }
}

const LAST_PRINTER = 'hono.lastPrinter'

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_PRINTER)
  } catch {
    return null
  }
}

/**
 * Shared page picker: the scope choices and, for a typed list, the box with its hint. Not inside a
 * <label>: a label around buttons clicks the first of them when its text is clicked.
 */
function PagePicker({ scope, setScope, custom, setCustom, hasSelection, valid, title }: { scope: Scope; setScope: (s: Scope) => void; custom: string; setCustom: (s: string) => void; hasSelection: boolean; valid: boolean; title?: string }) {
  const t = useT()
  const options: Array<{ value: Scope; label: string }> = [
    { value: 'all', label: t('print.all') },
    { value: 'current', label: t('print.current') },
    ...(hasSelection ? [{ value: 'selected' as Scope, label: t('print.selected') }] : []),
    { value: 'custom', label: t('print.custom') }
  ]
  return (
    <div className="flex flex-col gap-1">
      {title && <span className="text-[12px] font-medium text-muted">{title}</span>}
      <Segmented value={scope} onChange={setScope} options={options} />
      {scope === 'custom' && <TextInput autoFocus dir="ltr" value={custom} placeholder={t('customPagesHint')} aria-label={t('print.custom')} onChange={(e) => setCustom(e.target.value)} className="mt-1" />}
      {scope === 'custom' && (custom.trim() && !valid ? <span className="text-[12px] text-danger">{t('print.badPages')}</span> : !custom.trim() ? <span className="text-[12px] leading-snug text-faint">{t('print.badPages')}</span> : null)}
    </div>
  )
}

/** A small uppercase heading, as the tool panels have. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-faint uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** Paper sizes in points (portrait). "Printer default" is previewed on A4, the usual default here. */
const PAPER: Record<Paper, [number, number]> = { default: [595, 842], A4: [595, 842], Letter: [612, 792], Legal: [612, 1008], A3: [842, 1191], A5: [420, 595], Tabloid: [792, 1224] }

const LAST_PAPER = 'hono.lastPaper'

/**
 * One printed sheet, drawn as it will come out: the paper, and each page placed and sized as the
 * job places it (same rules as the job: @shared/printlayout).
 */
function SheetPreview({ view, pages, options, sheet }: { view: DocView; pages: number[]; options: Pick<PrintOptions, 'fit' | 'scale' | 'perSheet' | 'orientation' | 'grayscale' | 'paper'>; sheet: number }) {
  const sizes = pages.map((p) => [view.info.pages[p]!.width, view.info.pages[p]!.height] as [number, number])
  const landscape = sheetLandscape(sizes, options.orientation, options.perSheet)
  const paper = PAPER[options.paper]
  const [pw, ph] = landscape ? [paper[1], paper[0]] : paper
  const k = Math.min(214 / pw, 270 / ph)
  const [cols, rows] = grid(options.perSheet, landscape)
  const pad = options.perSheet > 1 ? (6 * 72) / 25.4 : 0
  const gap = options.perSheet > 1 ? (4 * 72) / 25.4 : 0
  const cellW = (pw - pad * 2 - gap * (cols - 1)) / cols
  const cellH = (ph - pad * 2 - gap * (rows - 1)) / rows
  const list = sheets(pages.length, options.perSheet)[sheet] ?? []
  return (
    <div className="relative bg-white shadow-md ring-1 ring-line" style={{ width: pw * k, height: ph * k }} data-sheet-preview="">
      <div className="absolute inset-0 grid" style={{ padding: pad * k, gap: gap * k, gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
        {list.map((i) => {
          const [w, h] = sizes[i]!
          const fit = Math.min(cellW / w, cellH / h)
          const s = options.fit === 'fit' ? fit : options.fit === 'shrink' ? Math.min(1, fit) : options.fit === 'custom' ? options.scale / 100 : 1
          return (
            <div key={i} className="flex min-h-0 min-w-0 items-center justify-center overflow-hidden">
              <PageImage docId={view.info.id} revision={view.info.revision} page={pages[i]!} width={Math.round(w * s * k)} height={Math.round(h * s * k)} pointsWide={w} className={options.grayscale ? 'shrink-0 ring-1 ring-black/10 grayscale' : 'shrink-0 ring-1 ring-black/10'} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Print, in HonoPDF's own dialog as Acrobat has (docs/decisions.md §60): printer, copies and
 * sides; which pages (odd/even, reversed); sizing (fit, shrink, actual, scale) and pages per sheet;
 * orientation; black and white; comments and forms; and a preview of every sheet.
 */
export function PrintDialog({ docId, pages: preset }: { docId: string; pages?: number[] }) {
  const t = useT()
  const view = useStore((s) => s.docs[docId])
  const start = initialScope(view, preset, 'all')
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null)
  const [printer, setPrinter] = useState('')
  const [copies, setCopies] = useState(1)
  const [scope, setScope] = useState<Scope>(start.scope)
  const [custom, setCustom] = useState(start.custom)
  const [subset, setSubset] = useState<'all' | 'odd' | 'even'>('all')
  const [reverse, setReverse] = useState(false)
  const [fit, setFit] = useState<PrintOptions['fit']>('fit')
  const [scale, setScale] = useState(100)
  const [perSheet, setPerSheet] = useState<PerSheet>(1)
  const [orientation, setOrientation] = useState<PrintOptions['orientation']>('auto')
  const [duplex, setDuplex] = useState<PrintOptions['duplex']>('simplex')
  const [grayscale, setGrayscale] = useState(false)
  const [annotations, setAnnotations] = useState(true)
  const [paper, setPaper] = useState<Paper>(() => {
    try {
      const last = localStorage.getItem(LAST_PAPER) as Paper | null
      return last && last in PAPER ? last : 'default'
    } catch {
      return 'default'
    }
  })
  const [sheet, setSheet] = useState(0)
  useEffect(() => {
    void window.api.printers().then((r) => {
      const list = r.ok ? r.value : []
      setPrinters(list)
      const last = remembered()
      setPrinter((list.find((p) => p.name === last) ?? list.find((p) => p.isDefault) ?? list[0])?.name ?? '')
    })
  }, [])
  const count = view?.info.pages.length ?? 0
  const chosen = useMemo(() => (view ? pagesFor(scope, custom, count, view.page, view.selected) : null), [view, scope, custom, count])
  // Odd or even pages by their number; reversed for printing the second side by hand.
  const pages = useMemo(() => {
    if (!chosen) return null
    const kept = subset === 'all' ? chosen : chosen.filter((p) => (p + 1) % 2 === (subset === 'odd' ? 1 : 0))
    if (kept.length === 0) return null
    return reverse ? [...kept].reverse() : kept
  }, [chosen, subset, reverse])
  const sheetCount = pages ? Math.ceil(pages.length / perSheet) : 0
  useEffect(() => setSheet((s) => Math.min(s, Math.max(0, sheetCount - 1))), [sheetCount])
  if (!view) return null
  const allowed = view.info.rights.print
  /** `system`: through Windows' own print dialog, for every setting the printer's driver has. */
  const go = async (system = false): Promise<void> => {
    if (!pages || !printer || !allowed) return
    try {
      localStorage.setItem(LAST_PRINTER, printer)
      localStorage.setItem(LAST_PAPER, paper)
    } catch {
      // remembered for convenience only
    }
    setDialog(null)
    const sizes = pages.map((p) => [view.info.pages[p]!.width, view.info.pages[p]!.height] as [number, number])
    const name = printers?.find((p) => p.name === printer)?.displayName ?? printer
    const done = await runBusy(t('print.printing'), () => window.api.printDoc(view.info.id, { printer, copies, pages, fit, scale, perSheet, orientation, grayscale, duplex, annotations, paper, system }, sizes))
    // false: cancelled in Windows' dialog.
    if (done === true) toast('success', pages.length === 1 ? t('print.sentOne', { printer: name }) : t('print.sent', { count: pages.length, printer: name }))
  }
  return (
    <Modal title={t('print.title')} onClose={() => setDialog(null)} width={780}>
      <form
        className="flex gap-6"
        data-print-dialog=""
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Group title={t('print.printer')}>
            {printers === null ? (
              <span className="flex h-9 items-center gap-2 text-[12px] text-muted">
                <Spinner size={14} /> {t('print.findingPrinters')}
              </span>
            ) : printers.length === 0 ? (
              <div className="flex flex-col items-start gap-2">
                <span className="text-[12px] text-warn">{t('print.noPrinters')}</span>
                <Button icon={<ExternalLink size={14} />} onClick={() => void window.api.printerSettings()}>
                  {t('print.openPrinterSettings')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Select value={printer} onChange={setPrinter} label={t('print.printer')} options={printers.map((p) => ({ value: p.name, label: p.displayName, ...(p.isDefault ? { hint: t('print.default') } : {}) }))} />
                </div>
                <Button icon={<Settings2 size={14} />} title={t('print.preferencesHint')} disabled={!printer} onClick={() => void window.api.printerPreferences(printer)} data-printer-preferences="">
                  {t('print.preferences')}
                </Button>
              </div>
            )}
            <div className="flex gap-3">
              <div className="w-24 shrink-0">
                <Field label={t('print.copies')}>
                  <NumberInput value={copies} min={1} max={999} onChange={(n) => setCopies(Math.max(1, Math.min(999, Math.round(n) || 1)))} />
                </Field>
              </div>
              <div className="w-36 shrink-0">
                <Field label={t('print.paper')}>
                  <Select
                    value={paper}
                    onChange={setPaper}
                    label={t('print.paper')}
                    options={(['default', 'A4', 'Letter', 'Legal', 'A3', 'A5', 'Tabloid'] as const).map((v) => ({ value: v, label: v === 'default' ? t('print.paperDefault') : v }))}
                  />
                </Field>
              </div>
              <div className="min-w-0 flex-1">
                <Field label={t('print.sides')}>
                  <Select
                    value={duplex}
                    onChange={setDuplex}
                    label={t('print.sides')}
                    options={[
                      { value: 'simplex', label: t('print.oneSided') },
                      { value: 'longEdge', label: t('print.longEdge') },
                      { value: 'shortEdge', label: t('print.shortEdge') }
                    ]}
                  />
                </Field>
              </div>
            </div>
          </Group>
          <Group title={t('print.pages')}>
            <PagePicker scope={scope} setScope={setScope} custom={custom} setCustom={setCustom} hasSelection={view.selected.length > 0} valid={!!chosen} />
            <div className="flex items-center gap-4">
              <div className="w-48 shrink-0">
                <Select
                  value={subset}
                  onChange={setSubset}
                  label={t('print.subset')}
                  options={[
                    { value: 'all', label: t('print.subsetAll') },
                    { value: 'odd', label: t('print.subsetOdd') },
                    { value: 'even', label: t('print.subsetEven') }
                  ]}
                />
              </div>
              <Check checked={reverse} onChange={setReverse} label={t('print.reverse')} />
            </div>
          </Group>
          <Group title={t('print.sizing')}>
            <Segmented
              value={fit}
              onChange={setFit}
              options={[
                { value: 'fit', label: t('print.fit'), hint: t('print.fitHint') },
                { value: 'shrink', label: t('print.shrink'), hint: t('print.shrinkHint') },
                { value: 'actual', label: t('print.actual') },
                { value: 'custom', label: t('print.customScale') }
              ]}
            />
            <div className="flex items-end gap-3">
              {fit === 'custom' && (
                <div className="w-28 shrink-0">
                  <Field label={t('print.scale')}>
                    <NumberInput value={scale} min={10} max={400} step={5} suffix="%" onChange={(n) => setScale(Math.max(10, Math.min(400, Math.round(n) || 100)))} />
                  </Field>
                </div>
              )}
              <div className="w-32 shrink-0">
                <Field label={t('print.perSheet')}>
                  <Select value={String(perSheet)} onChange={(v) => setPerSheet(Number(v) as PerSheet)} label={t('print.perSheet')} options={(['1', '2', '4', '6'] as const).map((n) => ({ value: n, label: n }))} />
                </Field>
              </div>
              <div className="min-w-0 flex-1">
                <Field label={t('print.orientation')}>
                  <Segmented
                    value={orientation}
                    onChange={setOrientation}
                    options={[
                      { value: 'auto', label: t('print.auto') },
                      { value: 'portrait', label: t('print.portrait') },
                      { value: 'landscape', label: t('print.landscape') }
                    ]}
                  />
                </Field>
              </div>
            </div>
          </Group>
          <Group title={t('print.options')}>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Check checked={annotations} onChange={setAnnotations} label={t('print.annotations')} />
              <Check checked={grayscale} onChange={setGrayscale} label={t('print.grayscale')} />
            </div>
          </Group>
        </div>
        <div className="flex w-[244px] shrink-0 flex-col items-center gap-2.5 rounded-xl bg-surface-2 p-3">
          <div className="flex h-[284px] w-full items-center justify-center">{pages ? <SheetPreview view={view} pages={pages} options={{ fit, scale, perSheet, orientation, grayscale, paper }} sheet={sheet} /> : <span className="text-[12px] text-faint">—</span>}</div>
          <div className="flex w-full items-center justify-between gap-1">
            <IconButton label={t('print.prevSheet')} disabled={sheet <= 0} onClick={() => setSheet(sheet - 1)}>
              <ChevronLeft size={16} className="rtl:rotate-180" />
            </IconButton>
            <span className="text-center text-[12px] text-muted tabular-nums" dir="auto">
              {pages ? t('print.sheetOf', { sheet: sheet + 1, sheets: sheetCount }) : '—'}
            </span>
            <IconButton label={t('print.nextSheet')} disabled={sheet >= sheetCount - 1} onClick={() => setSheet(sheet + 1)}>
              <ChevronRight size={16} className="rtl:rotate-180" />
            </IconButton>
          </div>
          <span className="text-center text-[12px] text-muted" dir="auto">
            {!pages ? t('print.noPages') : pages.length === 1 ? t('print.summaryOne', { copies }) : t('print.summary', { count: pages.length, copies })}
          </span>
          <span className="text-center text-[11px] text-faint">{paper === 'default' ? t('print.previewPaper') : t('print.previewOn', { paper })}</span>
        </div>
      </form>
      {!allowed && <p className="text-[12px] text-warn">{t('print.restricted')}</p>}
      <div className="flex items-center gap-2">
        <Button variant="ghost" icon={<ExternalLink size={14} />} title={t('print.systemHint')} disabled={!pages || !printer || !allowed} onClick={() => void go(true)} data-print-system="">
          {t('print.system')}
        </Button>
        <span className="flex-1" />
        <Button onClick={() => setDialog(null)}>{t('cancel')}</Button>
        <Button variant="primary" autoFocus icon={<Printer size={15} />} disabled={!pages || !printer || !allowed} onClick={() => void go()} data-print-go="">
          {t('print.go')}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Save only some pages: the one in view, those picked, or a typed list — as one new PDF (Save As
 * opens for it), or one PDF per page into a folder; optionally removed from this document after.
 */
export function SavePagesDialog({ docId, pages: preset }: { docId: string; pages?: number[] }) {
  const t = useT()
  const view = useStore((s) => s.docs[docId])
  const start = initialScope(view, preset, 'current')
  const [scope, setScope] = useState<Scope>(view && !preset && view.selected.length > 0 ? 'selected' : start.scope)
  const [custom, setCustom] = useState(start.custom)
  const [separate, setSeparate] = useState(false)
  const [remove, setRemove] = useState(false)
  const count = view?.info.pages.length ?? 0
  const pages = useMemo(() => (view ? pagesFor(scope, custom, count, view.page, view.selected) : null), [view, scope, custom, count])
  if (!view) return null
  const canRemove = !!pages && pages.length < count && view.info.rights.assemble
  const go = async (): Promise<void> => {
    if (!pages) return
    setDialog(null)
    if (separate) {
      const folder = await window.api.pickFolder()
      if (!folder) return
      await writeFiles(() => window.api.split(view.info.id, pages.map((p) => [p, p] as [number, number]), folder), t('savePages.title'), folder)
    } else {
      if (!(await newDocument(() => window.api.extract(view.info.id, pages), t('savePages.title')))) return
      const created = useStore.getState().active
      if (created) await save(created, true)
    }
    if (remove && canRemove) await apply(view.info.id, { op: 'delete', pages }, t('delete'))
  }
  const shown = (pages ?? []).slice(0, 7)
  const more = (pages?.length ?? 0) - shown.length
  return (
    <Modal title={t('savePages.title')} onClose={() => setDialog(null)} width={520}>
      <form
        className="flex flex-col gap-4"
        data-save-pages-dialog=""
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        <PagePicker title={t('print.whichPages')} scope={scope} setScope={setScope} custom={custom} setCustom={setCustom} hasSelection={view.selected.length > 0} valid={!!pages} />
        {/* The pages that will be saved, as small pictures. */}
        <div className="flex min-h-[90px] items-center gap-2.5 overflow-hidden rounded-lg bg-surface-2 px-3 py-2.5">
          {shown.map((p) => {
            const size = view.info.pages[p]!
            // A few pages are shown larger; many, smaller, so a row holds them.
            const k = ((pages?.length ?? 0) <= 3 ? 104 : 64) / Math.max(size.width, size.height)
            return (
              <div key={p} className="flex shrink-0 flex-col items-center gap-1">
                <PageImage docId={view.info.id} revision={view.info.revision} page={p} width={Math.round(size.width * k)} height={Math.round(size.height * k)} pointsWide={size.width} className="ring-1 ring-black/10" />
                <span className="text-[10px] text-faint tabular-nums">{p + 1}</span>
              </div>
            )
          })}
          {more > 0 && <span className="ms-1 text-[12px] text-muted">+{more}</span>}
          {!pages && <span className="text-[12px] text-faint">—</span>}
        </div>
        <Field label={t('savePages.as')} {...(separate ? { hint: t('savePages.separateHint', { name: view.info.name.replace(/\.pdf$/i, '') }) } : {})}>
          <Segmented
            value={separate ? 'separate' : 'one'}
            onChange={(v) => setSeparate(v === 'separate')}
            options={[
              { value: 'one', label: t('savePages.one') },
              { value: 'separate', label: t('savePages.separate') }
            ]}
          />
        </Field>
        {canRemove && <Check checked={remove} onChange={setRemove} label={pages.length === 1 ? t('savePages.removeOne') : t('savePages.remove')} />}
        {pages && <p className="text-[12px] text-muted">{pages.length === 1 ? t('savePages.summaryOne') : t('savePages.summary', { count: pages.length })}</p>}
      </form>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setDialog(null)}>{t('cancel')}</Button>
        <Button variant="primary" autoFocus icon={<FileOutput size={15} />} disabled={!pages} onClick={() => void go()} data-save-pages-go="">
          {t('savePages.go')}
        </Button>
      </div>
    </Modal>
  )
}

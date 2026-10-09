import clsx from 'clsx'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check as CheckIcon, ChevronDown, ImageUp, Italic, Minus, MousePointerClick, PilcrowLeft, PilcrowRight, Plus, Search, Trash2, Underline } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apply, patchTextEdit, updateView, useT, type DocView, type TextStyle, toast } from '../store'
import { activeEditor } from './richEdit'
import { ColourPicker, place, Select, useDismiss } from './ui'
import type { Key } from '../i18n'

/**
 * Acrobat's text formatting, as a bar across the top of the pages while Edit text & pictures
 * is on (docs/decisions.md §40): typeface (matched or installed on this PC), size, bold,
 * italic, underline, colour, alignment, line spacing and direction for the open text box;
 * the picture's actions when a picture is selected; a hint when nothing is. Marked as part
 * of the box, so using it does not close the box.
 */
export function EditFormatBar({ view }: { view: DocView }) {
  const t = useT()
  const edit = view.textEdit
  const pic = !edit ? view.pictureSel : null
  const id = view.info.id

  if (pic) {
    const [x0, y0, x1, y1] = pic.box
    const mm = (pt: number): string => ((pt * 25.4) / 72).toFixed(1)
    return (
      <Bar>
        <span className="px-1 text-[12px] font-semibold text-ink">{t('picture')}</span>
        <span className="text-[12px] text-muted tabular-nums" dir="ltr">
          {t('pictureSize', { w: mm(x1 - x0), h: mm(y1 - y0) })}
        </span>
        <Divider />
        <BarText
          icon={<ImageUp size={15} />}
          label={t('replacePicture')}
          onClick={async () => {
            const [path] = await window.api.pickImages()
            if (path) void apply(id, { op: 'changePicture', page: pic.page, box: pic.box, change: { kind: 'replace', source: { path } } }, t('replacePicture'))
          }}
        />
        <BarText
          icon={<Trash2 size={15} />}
          label={t('deletePicture')}
          danger
          onClick={() => {
            updateView(id, { pictureSel: null })
            void apply(id, { op: 'changePicture', page: pic.page, box: pic.box, change: { kind: 'delete' } }, t('deletePicture'))
          }}
        />
        <span className="ms-auto hidden text-[11px] text-faint @[720px]:inline">{t('resizeHint')}</span>
      </Bar>
    )
  }

  const style: TextStyle = edit?.style ?? { size: 12, colour: '#000000', bold: false, italic: false, kind: 'sans', align: 'start' }
  // Words selected in the box (§65): bold, italic, underline, colour, size and font change only
  // them, as in Acrobat; nothing selected, the whole box. Alignment and spacing are the box's.
  const sel = edit?.selection ?? null
  const set = (patch: Partial<TextStyle>): void => {
    const editor = activeEditor()
    const forWords = Object.keys(patch).every((k) => ['bold', 'italic', 'underline', 'colour', 'size', 'family'].includes(k))
    if (sel && forWords && editor?.hasSelection()) editor.applyToSelection(patch)
    else patchTextEdit(id, { style: { ...style, ...patch } })
  }
  const shown = { size: sel?.size ?? style.size, bold: sel ? sel.bold : style.bold, italic: sel ? sel.italic : style.italic, underline: sel ? sel.underline : !!style.underline, colour: sel?.colour ?? style.colour }
  const round = (n: number): number => Math.round(n * 2) / 2
  const direction = edit ? (edit.direction ?? (edit.rtl ? 'rtl' : 'ltr')) : 'ltr'
  const rtl = direction === 'rtl'
  return (
    <Bar>
      <fieldset disabled={!edit} className={clsx('contents', !edit && '[&_button]:opacity-40 [&_input]:opacity-40')}>
        <FontSelect style={style} onChange={set} docFont={edit?.font} />
        <div className="flex h-8 items-center rounded-lg border border-line" title={t('size')} dir="ltr">
          <button type="button" aria-label={t('smaller')} onMouseDown={(e) => e.preventDefault()} onClick={() => set({ size: Math.max(4, round(shown.size - 1)) })} className="flex h-full w-7 items-center justify-center rounded-s-lg text-muted hover:bg-surface-2 hover:text-ink">
            <Minus size={13} />
          </button>
          <input
            type="number"
            aria-label={t('size')}
            className="h-full w-10 bg-transparent text-center text-[13px] tabular-nums outline-none"
            min={4}
            max={200}
            step={0.5}
            value={shown.size}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (n >= 4 && n <= 200) set({ size: n })
            }}
          />
          <button type="button" aria-label={t('bigger')} onMouseDown={(e) => e.preventDefault()} onClick={() => set({ size: Math.min(200, round(shown.size + 1)) })} className="flex h-full w-7 items-center justify-center rounded-e-lg text-muted hover:bg-surface-2 hover:text-ink">
            <Plus size={13} />
          </button>
        </div>
        <Divider />
        <Toggle label={`${t('bold')} (Ctrl+B)`} active={shown.bold} onClick={() => set({ bold: !shown.bold })}>
          <Bold size={16} />
        </Toggle>
        <Toggle label={`${t('italic')} (Ctrl+I)`} active={shown.italic} onClick={() => set({ italic: !shown.italic })}>
          <Italic size={16} />
        </Toggle>
        <Toggle label={`${t('underline')} (Ctrl+U)`} active={shown.underline} onClick={() => set({ underline: !shown.underline })}>
          <Underline size={16} />
        </Toggle>
        <ColourPicker compact value={shown.colour} onChange={(colour) => set({ colour })} label={t('colour')} />
        <Divider />
        {(
          [
            ['start', rtl ? AlignRight : AlignLeft, t('alignStart')],
            ['centre', AlignCenter, t('alignCentre')],
            ['end', rtl ? AlignLeft : AlignRight, t('alignEnd')],
            ['justify', AlignJustify, t('alignJustify')]
          ] as const
        ).map(([value, Icon, label]) => (
          <Toggle key={value} label={edit && !edit.wraps ? t('alignNeedsWidth') : label} active={!!edit && style.align === value} disabled={!edit?.wraps} onClick={() => set({ align: value })}>
            <Icon size={16} />
          </Toggle>
        ))}
        <Divider />
        <Select
          compact
          className="w-[118px]"
          label={t('lineSpacing')}
          value={edit?.lineHeight ? String(edit.lineHeight) : 'keep'}
          onChange={(v) => patchTextEdit(id, { lineHeight: v === 'keep' ? undefined : Number(v) })}
          options={[
            { value: 'keep', label: t('lineSpacing.keep'), hint: t('lineSpacing.keepHint') },
            { value: '1', label: t('lineSpacing.single', { n: '1.0' }) },
            { value: '1.15', label: t('lineSpacing.single', { n: '1.15' }) },
            { value: '1.5', label: t('lineSpacing.single', { n: '1.5' }) },
            { value: '2', label: t('lineSpacing.single', { n: '2.0' }) }
          ]}
        />
        {/* Writing direction (Word's pilcrow arrows): for a line that starts with a Latin word or a number but reads right to left. */}
        <Toggle label={t('rtlShort')} active={!!edit && direction === 'rtl'} onClick={() => patchTextEdit(id, { direction: 'rtl' })}>
          <PilcrowLeft size={16} />
        </Toggle>
        <Toggle label={t('ltrShort')} active={!!edit && direction === 'ltr'} onClick={() => patchTextEdit(id, { direction: 'ltr' })}>
          <PilcrowRight size={16} />
        </Toggle>
      </fieldset>
      {!edit && (
        <span className="ms-1 flex items-center gap-1.5 text-[12px] text-muted">
          <MousePointerClick size={14} className="shrink-0" />
          {t('formatBar.hint')}
        </span>
      )}
      {sel && <span className="ms-1 text-[11px] text-accent">{t('formatSelection')}</span>}
      {edit?.font?.status === 'missing' && !style.family && style.kind === edit.font.kind && (
        <span className="ms-1 flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] py-0.5 ps-2.5 pe-1 text-[12px]" data-missing-font="">
          <span className="text-warn" dir="auto">
            {t('font.missing', { font: edit.font.name })}
          </span>
          <button type="button" className="rounded-full px-2 py-0.5 font-medium hover:bg-surface-2" onMouseDown={(e) => e.preventDefault()} onClick={() => void window.api.copyText(edit.font!.name).then(() => toast('success', t('copied')))}>
            {t('font.copy')}
          </button>
          <button type="button" className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-accent-ink hover:brightness-110" onMouseDown={(e) => e.preventDefault()} onClick={() => void window.api.findFont(edit.font!.name)}>
            {t('font.find')}
          </button>
        </span>
      )}
    </Bar>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div data-format-panel="" data-format-bar="" className="@container relative z-20 flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-1.5">
      {children}
    </div>
  )
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-line" />
}

function Toggle({ label, active, disabled, onClick, children }: { label: string; active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-35', active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink')}
    >
      {children}
    </button>
  )
}

function BarText({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={clsx('flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium hover:bg-surface-2', danger ? 'text-danger' : 'text-ink')}>
      {icon}
      {label}
    </button>
  )
}

const MATCHED: Record<TextStyle['kind'], string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "'Segoe UI', Arial, sans-serif",
  mono: "Consolas, 'Courier New', monospace"
}

/** The installed fonts, asked for once per run. */
let fontsOnce: Promise<string[]> | null = null
function useSystemFonts(open: boolean): string[] | null {
  const [fonts, setFonts] = useState<string[] | null>(null)
  useEffect(() => {
    if (!open || fonts) return
    fontsOnce ??= window.api.systemFonts().then((r) => (r.ok ? r.value : []))
    void fontsOnce.then(setFonts)
  }, [open, fonts])
  return fonts
}

/**
 * The typeface list, as Word's and Acrobat's: a search box; "Match the original" (the three
 * kinds the engine matches to the document's own fonts, with Arabic always in a matching
 * Arabic face); then every font installed on this PC, each shown in itself.
 */
function FontSelect({ style, onChange, docFont }: { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void; docFont?: { name: string; status: 'installed' | 'embedded' | 'missing'; kind: TextStyle['kind'] } }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useDismiss(open, () => setOpen(false), button, list)
  const fonts = useSystemFonts(open)
  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => search.current?.focus())
    }
  }, [open])
  const kinds = [
    { kind: 'serif' as const, label: t('fontSerif'), hint: t('fontSerifHint') },
    { kind: 'sans' as const, label: t('fontSans'), hint: t('fontSansHint') },
    { kind: 'mono' as const, label: t('fontMono'), hint: t('fontMonoHint') }
  ]
  const q = query.trim().toLowerCase()
  const shownKinds = kinds.filter((k) => !q || k.label.toLowerCase().includes(q))
  const shownFonts = (fonts ?? []).filter((f) => !q || f.toLowerCase().includes(q))
  const ownFont = !!docFont && !style.family && style.kind === docFont.kind
  const current = style.family ?? (ownFont ? docFont!.name : kinds.find((k) => k.kind === style.kind)!.label)
  const rect = open ? button.current?.getBoundingClientRect() : undefined
  const choose = (patch: Partial<TextStyle>): void => {
    onChange(patch)
    setOpen(false)
  }
  const row = (key: string, label: string, family: string, chosen: boolean, onClick: () => void, hint?: string) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={chosen}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1 text-start hover:bg-surface-2"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px]" style={{ fontFamily: family }}>
          {label}
        </span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </span>
      {chosen && <CheckIcon size={14} className="shrink-0 text-accent" />}
    </button>
  )
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('typeface')}
        aria-label={t('typeface')}
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex h-8 w-44 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-start text-[13px] text-ink outline-none hover:border-faint focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/20',
          open && 'border-accent ring-3 ring-accent/20'
        )}
      >
        <span className="min-w-0 flex-1 truncate" style={{ fontFamily: style.family ? `'${style.family}', ${MATCHED[style.kind]}` : MATCHED[style.kind] }}>
          {current}
        </span>
        <ChevronDown size={14} className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={list} role="listbox" data-select-list="" className="z-[60] flex flex-col rounded-xl border border-line bg-surface text-ink shadow-xl" style={place(rect, 280, 420)}>
            <div className="relative m-1.5">
              <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (shownKinds[0]) choose({ kind: shownKinds[0].kind, family: undefined })
                    else if (shownFonts[0]) choose({ family: shownFonts[0] })
                  }
                }}
                placeholder={t('searchFonts')}
                aria-label={t('searchFonts')}
                className="h-8 w-full rounded-lg border border-line bg-surface ps-8 pe-2.5 text-[13px] outline-none focus:border-accent focus:ring-3 focus:ring-accent/20"
              />
            </div>
            <div className="max-h-[360px] overflow-y-auto px-1 pb-1">
              {docFont && (!q || docFont.name.toLowerCase().includes(q)) && (
                <>
                  <GroupTitle>{t('fonts.document')}</GroupTitle>
                  {row('document', docFont.name, `'${docFont.name}', ${MATCHED[docFont.kind]}`, ownFont, () => choose({ kind: docFont.kind, family: undefined }), t(`fonts.status.${docFont.status}` as Key))}
                </>
              )}
              {shownKinds.length > 0 && <GroupTitle>{t('fonts.match')}</GroupTitle>}
              {shownKinds.map((k) => row(k.kind, k.label, MATCHED[k.kind], !ownFont && !style.family && style.kind === k.kind, () => choose({ kind: k.kind, family: undefined }), k.hint))}
              <GroupTitle>{t('fonts.installed')}</GroupTitle>
              {fonts === null ? (
                <p className="px-2.5 py-2 text-[12px] text-muted">{t('fonts.loading')}</p>
              ) : shownFonts.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-muted">{t('fonts.none')}</p>
              ) : (
                shownFonts.map((f) => row(`f:${f}`, f, `'${f}', ${MATCHED.sans}`, style.family === f, () => choose({ family: f })))
              )}
            </div>
            <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-faint">{t('fonts.note')}</p>
          </div>,
          document.body
        )}
    </>
  )
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{children}</div>
}

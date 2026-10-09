import clsx from 'clsx'
import {
  BadgeCheck,
  CaseSensitive,
  MessageSquareQuote,
  PanelTopBottomDashed,
  Circle,
  Copy,
  Crop,
  Eraser,
  FileOutput,
  FilePlus2,
  Files,
  Hash,
  Highlighter,
  ImagePlus,
  MessageSquarePlus,
  Minus,
  MoveUpRight,
  PaintBucket,
  PenLine,
  Plus,
  RotateCcw,
  RotateCw,
  Scissors,
  Square,
  SquarePen,
  Stamp,
  Strikethrough,
  Trash2,
  Type,
  Underline
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { parsePageList } from '@shared/pagelist'
import type { SavedSignature } from '@shared/ipc'
import { apply, deletePagesAsking, extractPages, extractPagesAs, openTool, quickTool, setDialog, tc, toast, toggleSide, updateView, useStore, useT, type DocView, type EditTool, type MarkStyle } from '../store'
import type { Key } from '../i18n'
import { pickPictureToPlace } from '../components/Shell'
import { Button, Check, ColourPicker, Field, NumberInput, Section, Select, TextInput } from '../components/ui'

/**
 * The panels of the global-bar tabs — Edit, Comment, Sign, Organize — laid out as Acrobat's:
 * UPPERCASE sections of icon rows and tool rows, with the options of the tool in use.
 */

export function PanelRow({ icon, label, hint, active, onClick, disabled }: { icon: ReactNode; label: string; hint?: string; active?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx('flex min-h-9 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-start text-[13px] disabled:opacity-40', active ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2')}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{label}</span>
        {hint && <span className="text-[11px] leading-snug text-muted">{hint}</span>}
      </span>
    </button>
  )
}

export function IconRow({ items }: { items: Array<{ icon: ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean; danger?: boolean }> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((x) => (
        <button
          key={x.label}
          type="button"
          title={x.label}
          aria-label={x.label}
          aria-pressed={x.active}
          disabled={x.disabled}
          onClick={x.onClick}
          className={clsx(
            'flex h-9 w-9 items-center justify-center rounded-lg border disabled:opacity-35',
            x.active ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2',
            x.danger && 'text-danger'
          )}
        >
          {x.icon}
        </button>
      ))}
    </div>
  )
}

const COLOURS = ['#e11d48', '#ea580c', '#16a34a', '#1473e6', '#7c3aed', '#111827']
const HIGHLIGHTS = ['#facc15', '#86efac', '#7dd3fc', '#f9a8d4', '#fdba74']
const WIDTHS = [1, 2, 3, 5, 8]

function Swatches({ colours, value, onChange, label }: { colours: string[]; value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={clsx('h-6 w-6 rounded-full border', value === c ? 'border-surface ring-2 ring-accent' : 'border-line')}
          style={{ background: c }}
        />
      ))}
      <ColourPicker compact value={value} onChange={onChange} label={label} />
    </div>
  )
}

/** Page commands on the page in view: Acrobat's MODIFY PAGE row. */
function ModifyPage({ view }: { view: DocView }) {
  const t = useT()
  const { info, page } = view
  return (
    <Section title={t('section.modifyPage')}>
      <IconRow
        items={[
          { icon: <RotateCcw size={16} />, label: t('rotateLeft'), onClick: () => void apply(info.id, { op: 'rotate', pages: [page], angle: -90 }, t('rotateLeft')) },
          { icon: <RotateCw size={16} />, label: t('rotateRight'), onClick: () => void apply(info.id, { op: 'rotate', pages: [page], angle: 90 }, t('rotateRight')) },
          { icon: <FilePlus2 size={16} />, label: t('insertBlankAfter'), onClick: () => void apply(info.id, { op: 'insertBlank', at: page + 1, count: 1 }, t('insertBlank')) },
          { icon: <FileOutput size={16} />, label: t('extractPage'), onClick: () => void extractPages(info.id, [page]) },
          {
            icon: <Trash2 size={16} />,
            label: t('deletePage'),
            danger: true,
            disabled: info.pages.length < 2,
            onClick: () => void deletePagesAsking(info.id, [page])
          }
        ]}
      />
      <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => openTool('organize')}>
        {t('tool.organize')} ›
      </button>
    </Section>
  )
}

export function EditPanel({ view }: { view: DocView }) {
  const t = useT()
  const { editTool } = view
  const text = view.mode === 'edit' && editTool === 'text' && !view.placing
  return (
    <>
      <Section title={t('section.editContent')}>
        <PanelRow icon={<SquarePen size={18} />} label={t('textAndPictures')} hint={t('editPanel.textHint')} active={text} onClick={() => quickTool(view, 'text')} />
        <PanelRow icon={<Eraser size={18} />} label={t('eraseArea')} hint={t('editPanel.eraseHint')} active={view.mode === 'edit' && editTool === 'erase'} onClick={() => quickTool(view, 'erase')} />
      </Section>
      <Section title={t('section.addContent')}>
        <PanelRow icon={<Type size={18} />} label={t('addText')} hint={t('editPanel.addTextHint')} onClick={() => quickTool(view, 'text')} />
        <PanelRow
          icon={<ImagePlus size={18} />}
          label={t('addPicture')}
          hint={t('editPanel.addPictureHint')}
          active={!!view.placing && !view.placing.signature}
          onClick={() => void pickPictureToPlace(view, () => toast('error', t('pictureUnreadable')))}
        />
        <PanelRow icon={<Stamp size={18} />} label={t('tool.watermark')} onClick={() => openTool('watermark')} />
        <PanelRow icon={<Hash size={18} />} label={t('tool.pageNumbers')} onClick={() => openTool('pageNumbers')} />
        <PanelRow icon={<PanelTopBottomDashed size={18} />} label={t('tool.headerFooter')} onClick={() => openTool('headerFooter')} />
        <PanelRow icon={<CaseSensitive size={18} />} label={t('tool.formatText')} onClick={() => openTool('formatText')} />
        <PanelRow icon={<Crop size={18} />} label={t('tool.crop')} onClick={() => openTool('crop')} />
      </Section>
      <ModifyPage view={view} />
      <p className="text-[11px] leading-relaxed text-faint">{t('editPanel.fontNote')}</p>
    </>
  )
}

export function CommentPanel({ view }: { view: DocView }) {
  const t = useT()
  const { editTool, markStyle } = view
  const style = (patch: Partial<MarkStyle>): void => updateView(view.info.id, { markStyle: { ...markStyle, ...patch } })
  const on = (tool: EditTool): boolean => view.mode === 'edit' && editTool === tool
  return (
    <>
      <PanelRow icon={<MessageSquarePlus size={18} />} label={t('addComment')} hint={t('noteHint')} active={on('note')} onClick={() => quickTool(view, 'note')} />
      <Section title={t('section.markText')}>
        <IconRow
          items={[
            { icon: <Highlighter size={16} />, label: t('markup.highlight'), active: on('highlight') && markStyle.textMark === 'highlight', onClick: () => (style({ textMark: 'highlight' }), quickTool(view, 'highlight')) },
            { icon: <Underline size={16} />, label: t('markup.underline'), active: on('highlight') && markStyle.textMark === 'underline', onClick: () => (style({ textMark: 'underline' }), quickTool(view, 'highlight')) },
            { icon: <Strikethrough size={16} />, label: t('markup.strikeout'), active: on('highlight') && markStyle.textMark === 'strikeout', onClick: () => (style({ textMark: 'strikeout' }), quickTool(view, 'highlight')) }
          ]}
        />
      </Section>
      <Section title={t('section.draw')}>
        <IconRow
          items={[
            { icon: <PenLine size={16} />, label: t('penTool'), active: on('pen'), onClick: () => quickTool(view, 'pen') },
            { icon: <Square size={16} />, label: t('markup.rect'), active: on('shape') && markStyle.shape === 'rect', onClick: () => (style({ shape: 'rect' }), quickTool(view, 'shape')) },
            { icon: <Circle size={16} />, label: t('markup.ellipse'), active: on('shape') && markStyle.shape === 'ellipse', onClick: () => (style({ shape: 'ellipse' }), quickTool(view, 'shape')) },
            { icon: <Minus size={16} />, label: t('markup.line'), active: on('shape') && markStyle.shape === 'line', onClick: () => (style({ shape: 'line' }), quickTool(view, 'shape')) },
            { icon: <MoveUpRight size={16} />, label: t('markup.arrow'), active: on('shape') && markStyle.shape === 'arrow', onClick: () => (style({ shape: 'arrow' }), quickTool(view, 'shape')) }
          ]}
        />
      </Section>
      <Section title={t('section.textStamps')}>
        <IconRow
          items={[
            { icon: <Type size={16} />, label: t('textbox.add'), active: on('textbox'), onClick: () => quickTool(view, 'textbox') },
            { icon: <MessageSquareQuote size={16} />, label: t('callout.add'), active: on('callout'), onClick: () => quickTool(view, 'callout') },
            { icon: <Stamp size={16} />, label: t('stamp.add'), active: on('stamp'), onClick: () => quickTool(view, 'stamp') }
          ]}
        />
        {on('stamp') && <StampPalette view={view} />}
      </Section>
      <Section title={t('section.appearance')}>
        {on('stamp') ? null : on('note') ? (
          <Swatches colours={HIGHLIGHTS} value={markStyle.note} onChange={(c) => style({ note: c })} label={t('colour')} />
        ) : on('highlight') && markStyle.textMark === 'highlight' ? (
          <Swatches colours={HIGHLIGHTS} value={markStyle.highlight} onChange={(c) => style({ highlight: c })} label={t('colour')} />
        ) : (
          <Swatches colours={COLOURS} value={markStyle.colour} onChange={(c) => style({ colour: c })} label={t('colour')} />
        )}
        {(on('pen') || on('shape')) && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">{t('lineWidth')}</span>
            <div className="flex gap-1">
              {WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  title={`${w} pt`}
                  aria-label={`${w} pt`}
                  aria-pressed={markStyle.width === w}
                  onClick={() => style({ width: w })}
                  className={clsx('flex h-7 w-7 items-center justify-center rounded-md border', markStyle.width === w ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
                >
                  <span className="rounded-full bg-ink" style={{ width: 14, height: Math.max(1, w * 0.9) }} />
                </button>
              ))}
            </div>
          </div>
        )}
        {(on('textbox') || on('callout')) && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">{t('size')}</span>
            <div className="w-28">
              <NumberInput value={markStyle.textSize} onChange={(textSize) => style({ textSize })} min={6} max={48} suffix={t('pt')} />
            </div>
          </div>
        )}
        {on('shape') && (markStyle.shape === 'rect' || markStyle.shape === 'ellipse') && (
          <PanelRow icon={<PaintBucket size={16} />} label={t('fillShape')} active={markStyle.fill} onClick={() => style({ fill: !markStyle.fill })} />
        )}
      </Section>
      <p className="text-[12px] leading-relaxed text-muted">{on('note') ? t('noteHint') : on('highlight') ? t('highlightHint') : on('pen') ? t('penHint') : on('shape') ? t('shapeHint') : on('stamp') ? t('stamp.hint') : on('textbox') ? t('textbox.hint') : on('callout') ? t('callout.hint') : t('commentPanel.pick')}</p>
      <button type="button" className="self-start rounded-full border border-line px-3 py-1.5 text-[12px] hover:bg-surface-2" onClick={() => view.side !== 'comments' && toggleSide(view, 'comments')}>
        {t('showAllMarkup')}
      </button>
    </>
  )
}

export function SignPanel({ view }: { view: DocView }) {
  const t = useT()
  const saved = useStore((s) => s.settings?.signatures ?? [])
  const place = (s: SavedSignature): void => {
    updateView(view.info.id, { mode: 'edit', editTool: 'text', placing: { source: { data: s.data }, width: s.width, height: s.height, preview: `data:image/png;base64,${s.data}`, signature: true } })
    toast('info', t('placeSignatureHint'))
  }
  return (
    <>
      <Section title={t('section.signYourself')}>
        {saved.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {saved.map((s) => (
              <button
                key={s.id}
                type="button"
                title={t('useSignature')}
                onClick={() => place(s)}
                className={clsx('flex h-14 items-center justify-center rounded-lg border bg-white p-2 hover:border-accent', view.placing?.signature && 'source' in view.placing && 'data' in view.placing.source && view.placing.source.data === s.data ? 'border-accent' : 'border-line')}
              >
                <img src={`data:image/png;base64,${s.data}`} alt={t('signature')} className="max-h-full max-w-full" />
              </button>
            ))}
          </div>
        )}
        <PanelRow icon={<Plus size={18} />} label={t('addSignature')} hint={t('signPanel.addHint')} onClick={() => setDialog({ kind: 'signature', docId: view.info.id })} />
      </Section>
      <Section title={t('section.fillIn')}>
        <PanelRow icon={<Type size={18} />} label={t('addText')} hint={t('signPanel.textHint')} active={view.mode === 'edit' && view.editTool === 'text' && !view.placing} onClick={() => quickTool(view, 'text')} />
        <PanelRow icon={<ImagePlus size={18} />} label={t('addPicture')} onClick={() => void pickPictureToPlace(view, () => toast('error', t('pictureUnreadable')))} />
      </Section>
      <Section title={t('section.certificate')}>
        <PanelRow icon={<BadgeCheck size={18} />} label={t('certSign.title')} hint={t('certSign.panelHint')} onClick={() => setDialog({ kind: 'certSign', docId: view.info.id })} />
      </Section>
    </>
  )
}

/** Acrobat's Organize pages panel: which pages, then what to do with them. */
export function OrganizePanel({ view }: { view: DocView }) {
  const t = useT()
  const { info, selected } = view
  const count = info.pages.length
  const [text, setText] = useState('')
  // The box shows the selection made on the grid, and a typed list selects those pages.
  useEffect(() => setText(formatList(selected)), [selected])
  const select = (pages: number[]): void => updateView(info.id, { selected: [...new Set(pages)].sort((a, b) => a - b) })
  const all = Array.from({ length: count }, (_, i) => i)
  const none = selected.length === 0
  const insertAt = none ? count : Math.max(...selected) + 1
  const sets = {
    all,
    odd: all.filter((i) => i % 2 === 0),
    even: all.filter((i) => i % 2 === 1),
    portrait: all.filter((i) => info.pages[i]!.height >= info.pages[i]!.width),
    landscape: all.filter((i) => info.pages[i]!.width > info.pages[i]!.height),
    none: [] as number[]
  }
  // Acrobat's Extract popover: delete the pages afterwards, or one file per page.
  const [extracting, setExtracting] = useState(false)
  const [extractDelete, setExtractDelete] = useState(false)
  const [extractSeparate, setExtractSeparate] = useState(false)
  const extract = async (): Promise<void> => {
    if (await extractPagesAs(info.id, [...selected], extractSeparate, extractDelete)) setExtracting(false)
  }
  return (
    <>
      <Section title={t('section.pagesSelected')}>
        {/* Acrobat's combo box: type "2, 4, 6-8", or pick a set from the list. */}
        <div className="flex gap-1.5">
          <TextInput
            className="min-w-0 flex-1"
            dir="auto"
            value={text}
            placeholder={t('customPagesHint')}
            aria-label={t('section.pagesSelected')}
            onChange={(e) => {
              setText(e.target.value)
              const pages = parsePageList(e.target.value, count)
              if (pages) select(pages)
            }}
          />
          <div className="w-28 shrink-0">
            <Select
              value=""
              label={t('pickPages')}
              onChange={(key) => key && select(sets[key as keyof typeof sets])}
              options={[{ value: '', label: t('pickPages') }, ...(Object.keys(sets) as Array<keyof typeof sets>).map((key) => ({ value: key as string, label: t(`pick.${key}`) }))]}
            />
          </div>
        </div>
        <p className="text-[12px] text-muted">{none ? t('organizePanel.selectFirst') : tc('pages.selected', selected.length)}</p>
      </Section>
      <Section title={t('section.pageOptions')}>
        <IconRow
          items={[
            { icon: <RotateCcw size={16} />, label: t('rotateLeft'), disabled: none, onClick: () => void apply(info.id, { op: 'rotate', pages: selected, angle: -90 }, t('rotateLeft')) },
            { icon: <RotateCw size={16} />, label: t('rotateRight'), disabled: none, onClick: () => void apply(info.id, { op: 'rotate', pages: selected, angle: 90 }, t('rotateRight')) },
            { icon: <Copy size={16} />, label: t('duplicate'), disabled: none, onClick: () => void apply(info.id, { op: 'duplicate', pages: selected }, t('duplicate')) },
            { icon: <FileOutput size={16} />, label: t('extract'), active: extracting, disabled: none, onClick: () => setExtracting(!extracting) },
            {
              icon: <Trash2 size={16} />,
              label: t('delete'),
              danger: true,
              disabled: none || selected.length >= count,
              onClick: () => void deletePagesAsking(info.id, selected).then((ok) => ok && select([]))
            }
          ]}
        />
        {extracting && !none && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3" data-extract-popover="">
            <Check checked={extractDelete} onChange={setExtractDelete} label={t('extractDelete')} />
            <Check checked={extractSeparate} onChange={setExtractSeparate} label={t('extractSeparate')} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setExtracting(false)}>{t('cancel')}</Button>
              <Button variant="primary" onClick={() => void extract()}>
                {t('extract')}
              </Button>
            </div>
          </div>
        )}

      </Section>
      <Section title={t('section.insert')}>
        <PanelRow icon={<FilePlus2 size={18} />} label={t('insertBlank')} hint={none ? t('atTheEnd') : t('afterSelection')} onClick={() => void apply(info.id, { op: 'insertBlank', at: insertAt, count: 1 }, t('insertBlank'))} />
        <PanelRow
          icon={<Files size={18} />}
          label={t('insertPdf')}
          hint={none ? t('atTheEnd') : t('afterSelection')}
          onClick={async () => {
            const [path] = await window.api.pickPdfs(false)
            if (path) await apply(info.id, { op: 'insertPdf', at: insertAt, path }, t('insertPdf'))
          }}
        />
      </Section>
      <Section title={t('section.more')}>
        <PanelRow icon={<Scissors size={18} />} label={t('tool.split')} onClick={() => openTool('split')} />
        <PanelRow icon={<Crop size={18} />} label={t('tool.crop')} onClick={() => openTool('crop')} />
      </Section>
      <p className="text-[12px] leading-relaxed text-muted">{t('dragToReorder')}</p>
    </>
  )
}

/** [0,1,2,4] → "1-3, 5". */
function formatList(pages: number[]): string {
  const out: string[] = []
  for (let i = 0; i < pages.length; i++) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++
    out.push(i === j ? String(pages[i]! + 1) : `${pages[i]! + 1}-${pages[j]! + 1}`)
    i = j
  }
  return out.join(', ')
}

const STAMPS: Array<{ key: string; colour: string }> = [
  { key: 'approved', colour: '#1a7f37' },
  { key: 'reviewed', colour: '#1f5fbf' },
  { key: 'received', colour: '#1f5fbf' },
  { key: 'draft', colour: '#1f5fbf' },
  { key: 'final', colour: '#1a7f37' },
  { key: 'completed', colour: '#1a7f37' },
  { key: 'confidential', colour: '#c62828' },
  { key: 'rejected', colour: '#c62828' },
  { key: 'notApproved', colour: '#c62828' }
]
const STAMP_COLOURS = ['#1a7f37', '#1f5fbf', '#c62828', '#6b21a8', '#374151']

/**
 * Acrobat's stamps palette: the standard business stamps in the interface's language, a
 * stamp of one's own words, and "my name and the date" under the word (a dynamic stamp).
 * The chosen stamp follows the pointer on the page; a click places it.
 */
function StampPalette({ view }: { view: DocView }) {
  const t = useT()
  const { markStyle } = view
  const stamp = markStyle.stamp
  const set = (patch: Partial<MarkStyle['stamp']>): void => updateView(view.info.id, { markStyle: { ...markStyle, stamp: { ...stamp, ...patch } } })
  const preset = STAMPS.find((p) => t(`stamp.${p.key}` as Key) === stamp.label)
  const [custom, setCustom] = useState(preset ? '' : stamp.label)
  return (
    <div className="flex flex-col gap-2.5" data-stamp-palette="">
      <div className="grid grid-cols-2 gap-1.5">
        {STAMPS.map((p) => {
          const label = t(`stamp.${p.key}` as Key)
          const chosen = stamp.label === label
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => set({ label, colour: p.colour })}
              aria-pressed={chosen}
              className={clsx('flex h-10 items-center justify-center rounded-lg border bg-white px-1.5', chosen ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-faint')}
            >
              <span className="truncate rounded-[3px] border-2 px-1.5 text-[11px] leading-5 font-bold" style={{ color: p.colour, borderColor: p.colour }} dir="auto">
                {label}
              </span>
            </button>
          )
        })}
      </div>
      <Field label={t('stamp.custom')}>
        <TextInput
          value={custom}
          dir="auto"
          maxLength={60}
          placeholder={t('stamp.customHint')}
          onChange={(e) => {
            setCustom(e.target.value)
            if (e.target.value.trim()) set({ label: e.target.value.trim() })
          }}
        />
      </Field>
      <Swatches colours={STAMP_COLOURS} value={stamp.colour} onChange={(colour) => set({ colour })} label={t('colour')} />
      <Check checked={stamp.identity} onChange={(identity) => set({ identity })} label={t('stamp.identity')} hint={t('stamp.identityHint')} />
    </div>
  )
}

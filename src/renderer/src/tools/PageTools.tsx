import clsx from 'clsx'
import { ImagePlus, Scan } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { OpInput, Position } from '@shared/ops'
import { apply, openTool, updateView, useStore, useT, type DocView } from '../store'
import { LivePreview } from '../components/LivePreview'
import { Button, Check, ColourPicker, Field, NumberInput, Section, Segmented, TextInput } from '../components/ui'
import { MM, PageScopeField, PositionPicker, ToolFooter, usePageScope } from './common'

export function RotateTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [angle, setAngle] = useState<'90' | '180' | '-90'>('90')
  const op: OpInput = { op: 'rotate', pages: scope.pages ?? scope.preview, angle: Number(angle) as 90 | 180 | -90 }
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      <Field label={t('angle')}>
        <Segmented value={angle} onChange={setAngle} options={[{ value: '-90', label: '↺ 90°' }, { value: '180', label: '180°' }, { value: '90', label: '↻ 90°' }]} />
      </Field>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button
          variant="primary"
          disabled={!op || scope.pages === null}
          onClick={() => op && void apply(view.info.id, op, t('tool.rotate'))}
        >
          {t('act.rotate')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function WatermarkTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [kind, setKind] = useState<'text' | 'picture'>('text')
  const [text, setText] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [size, setSize] = useState(64)
  const [colour, setColour] = useState('#c0392b')
  const [opacity, setOpacity] = useState(25)
  const [rotation, setRotation] = useState(45)
  const [position, setPosition] = useState<Position>('center')
  const [bold, setBold] = useState(true)
  const [width, setWidth] = useState(50)
  const op: OpInput | null = (kind === 'text' ? text.trim().length > 0 : image !== null)
    ? {
        op: 'watermark',
        pages: scope.pages ?? (scope.scope === 'all' ? undefined : scope.preview),
        text: kind === 'text' ? text : undefined,
        imagePath: kind === 'picture' ? (image ?? undefined) : undefined,
        size,
        colour,
        opacity: opacity / 100,
        rotation,
        position,
        bold,
        imageScale: width / 100
      }
    : null
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'text', label: t('text') }, { value: 'picture', label: t('picture') }]} />
      {kind === 'text' ? (
        <>
          <Field label={t('text')}>
            <textarea
              className="min-h-16 w-full rounded-md border border-line bg-surface p-2 text-[14px] text-ink focus:border-focus focus:outline-none"
              value={text}
              dir="auto"
              placeholder="سري للغاية — CONFIDENTIAL"
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('size')}>
              <NumberInput value={size} onChange={setSize} min={4} max={600} suffix={t('pt')} />
            </Field>
            <Field label={t('colour')}>
              <ColourPicker value={colour} onChange={setColour} label={t('colour')} />
            </Field>
          </div>
          <Check checked={bold} onChange={setBold} label={t('bold')} />
        </>
      ) : (
        <>
          <Button
            icon={<ImagePlus size={15} />}
            onClick={async () => {
              const [path] = await window.api.pickImages()
              if (path) setImage(path)
            }}
          >
            {t('choosePicture')}
          </Button>
          {image && <p className="truncate text-[12px] text-muted" dir="ltr">{image.split(/[\\/]/).pop()}</p>}
          <Field label={`${t('pictureWidth')} — ${width}%`}>
            <input type="range" min={5} max={100} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="accent-[var(--accent)]" />
          </Field>
        </>
      )}
      <Field label={`${t('opacity')} — ${opacity}%`}>
        <input type="range" min={2} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="accent-[var(--accent)]" />
      </Field>
      <div className="flex items-start gap-4">
        <Field label={t('position')}>
          <PositionPicker value={position} onChange={setPosition} />
        </Field>
        <div className="flex-1">
          <Field label={t('rotation')}>
            <NumberInput value={rotation} onChange={setRotation} min={-180} max={180} suffix="°" />
          </Field>
        </div>
      </div>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button
          variant="primary"
          disabled={!op || scope.pages === null}
          onClick={() => op && void apply(view.info.id, op, t('tool.watermark'))}
        >
          {t('act.watermark')}
        </Button>
      </ToolFooter>
    </>
  )
}

const TEMPLATES = ['{n}', '{n} / {N}', 'Page {n} of {N}', 'صفحة {n} من {N}', '- {n} -']

export function PageNumbersTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [template, setTemplate] = useState('{n}')
  const [position, setPosition] = useState<Position>('bottom-center')
  const [startAt, setStartAt] = useState(1)
  const [size, setSize] = useState(11)
  const [margin, setMargin] = useState(10)
  const [digits, setDigits] = useState<'latin' | 'arabic-indic'>('latin')
  const [colour, setColour] = useState('#333333')
  const op: OpInput | null =
    !template.includes('{n}') ? null : { op: 'pageNumbers', pages: scope.pages ?? (scope.scope === 'all' ? undefined : scope.preview), template, position, startAt, size, margin: margin * MM, digits, colour }
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      <Field label={t('template')} hint={t('templateHint')}>
        <TextInput value={template} dir="auto" onChange={(e) => setTemplate(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATES.map((tpl) => (
          <button key={tpl} type="button" dir="auto" onClick={() => setTemplate(tpl)} className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:bg-surface-2 hover:text-ink">
            {tpl}
          </button>
        ))}
      </div>
      <Field label={t('digits')}>
        <Segmented value={digits} onChange={setDigits} options={[{ value: 'latin', label: t('latinDigits') }, { value: 'arabic-indic', label: t('arabicDigits') }]} />
      </Field>
      <div className="flex items-start gap-4">
        <Field label={t('position')}>
          <PositionPicker value={position} onChange={setPosition} only={['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']} />
        </Field>
        <div className="grid flex-1 grid-cols-2 gap-3">
          <Field label={t('startAt')}>
            <NumberInput value={startAt} onChange={setStartAt} min={-9999} max={99999} />
          </Field>
          <Field label={t('size')}>
            <NumberInput value={size} onChange={setSize} min={4} max={72} suffix={t('pt')} />
          </Field>
          <Field label={t('margin')}>
            <NumberInput value={margin} onChange={setMargin} min={0} max={70} suffix={t('mm')} />
          </Field>
          <Field label={t('colour')}>
            <ColourPicker value={colour} onChange={setColour} label={t('colour')} />
          </Field>
        </div>
      </div>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button
          variant="primary"
          disabled={!op || scope.pages === null}
          onClick={() => op && void apply(view.info.id, op, t('tool.pageNumbers'))}
        >
          {t('act.pageNumbers')}
        </Button>
      </ToolFooter>
    </>
  )
}

type Slot = 'topLeft' | 'topCenter' | 'topRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight'

/**
 * Acrobat's Add Header and Footer: three boxes for the header and three for the footer,
 * tokens inserted where the caret is, font size, colour, margins, numbering; the preview
 * shows real values (docs/research-acrobat-tools.md §8).
 */
export function HeaderFooterTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [slots, setSlots] = useState<Record<Slot, string>>({ topLeft: '', topCenter: '', topRight: '', bottomLeft: '', bottomCenter: '{n} / {N}', bottomRight: '' })
  const [focused, setFocused] = useState<Slot>('bottomCenter')
  const inputs = useRef<Partial<Record<Slot, HTMLInputElement | null>>>({})
  const [size, setSize] = useState(10)
  const [bold, setBold] = useState(false)
  const [colour, setColour] = useState('#333333')
  const [marginX, setMarginX] = useState(18)
  const [marginY, setMarginY] = useState(10)
  const [startAt, setStartAt] = useState(1)
  const [digits, setDigits] = useState<'latin' | 'arabic-indic'>(language === 'ar' ? 'arabic-indic' : 'latin')
  const date = new Date().toLocaleDateString(language === 'ar' ? 'ar-AE' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
  const empty = Object.values(slots).every((v) => !v.trim())
  const op: OpInput | null = empty
    ? null
    : {
        op: 'headerFooter',
        pages: scope.pages ?? (scope.scope === 'all' ? undefined : scope.preview),
        slots,
        size,
        bold,
        colour,
        marginX: marginX * MM,
        marginY: marginY * MM,
        startAt,
        digits,
        date,
        file: view.info.name.replace(/\.pdf$/i, '')
      }
  const insert = (token: string): void => {
    const el = inputs.current[focused]
    const value = slots[focused]
    const at = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    setSlots({ ...slots, [focused]: value.slice(0, at) + token + value.slice(end) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }
  const box = (slot: Slot, label: string) => (
    <input
      ref={(el) => {
        inputs.current[slot] = el
      }}
      value={slots[slot]}
      dir="auto"
      aria-label={label}
      placeholder={label}
      onFocus={() => setFocused(slot)}
      onChange={(e) => setSlots({ ...slots, [slot]: e.target.value })}
      className={clsx(
        'h-8 w-full min-w-0 rounded-lg border bg-surface px-2 text-[12px] outline-none placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-accent/20',
        focused === slot ? 'border-accent/60' : 'border-line'
      )}
    />
  )
  const row = (title: string, a: Slot, b: Slot, c: Slot) => (
    <Field label={title}>
      {/* Physical left, centre, right, as on the page, in either interface direction. */}
      <div className="grid grid-cols-3 gap-1.5" dir="ltr">
        {box(a, t('hf.left'))}
        {box(b, t('hf.center'))}
        {box(c, t('hf.right'))}
      </div>
    </Field>
  )
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      {row(t('hf.header'), 'topLeft', 'topCenter', 'topRight')}
      {row(t('hf.footer'), 'bottomLeft', 'bottomCenter', 'bottomRight')}
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-muted">{t('hf.insert')}</span>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['{n}', t('hf.page')],
              ['{N}', t('hf.pages')],
              ['{date}', t('hf.date')],
              ['{file}', t('hf.file')]
            ] as const
          ).map(([token, label]) => (
            <button
              key={token}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(token)}
              className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink hover:border-accent hover:bg-accent-soft"
            >
              + {label}
            </button>
          ))}
        </div>
      </div>
      {empty && <p className="text-[12px] text-warn">{t('hf.empty')}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('size')}>
          <NumberInput value={size} onChange={setSize} min={4} max={72} suffix={t('pt')} />
        </Field>
        <Field label={t('colour')}>
          <div className="flex flex-wrap items-center gap-2">
            <ColourPicker compact value={colour} onChange={setColour} label={t('colour')} />
            <Check checked={bold} onChange={setBold} label={t('bold')} />
          </div>
        </Field>
        <Field label={t('hf.marginSides')}>
          <NumberInput value={marginX} onChange={setMarginX} min={0} max={100} suffix={t('mm')} />
        </Field>
        <Field label={t('hf.marginEdge')}>
          <NumberInput value={marginY} onChange={setMarginY} min={0} max={100} suffix={t('mm')} />
        </Field>
        <Field label={t('startAt')}>
          <NumberInput value={startAt} onChange={setStartAt} min={-9999} max={99999} />
        </Field>
      </div>
      <Field label={t('digits')}>
        <Segmented value={digits} onChange={setDigits} options={[{ value: 'latin', label: t('latinDigits') }, { value: 'arabic-indic', label: t('arabicDigits') }]} />
      </Field>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button variant="primary" disabled={!op || scope.pages === null} onClick={() => op && void apply(view.info.id, op, t('tool.headerFooter'))}>
          {t('act.headerFooter')}
        </Button>
      </ToolFooter>
    </>
  )
}

/**
 * Crop, as Acrobat's: drag the box on the page (or type the margins), or Trim white margins
 * to fit the content; the preview shows the result. The box lives in the store while the
 * tool is open, so the page and these fields always agree.
 */
export function CropTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const id = view.info.id
  useEffect(() => {
    const ten = 10 * MM
    updateView(id, { crop: { left: ten, top: ten, right: ten, bottom: ten } })
    return () => updateView(id, { crop: null })
  }, [id])
  const crop = view.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const set = (key: keyof typeof crop, mm: number): void => updateView(id, { crop: { ...crop, [key]: Math.max(0, mm * MM) } })
  const field = (key: keyof typeof crop, label: string) => (
    <Field label={label}>
      <NumberInput value={Math.round((crop[key] / MM) * 10) / 10} onChange={(v) => set(key, v)} min={0} max={500} step={0.5} suffix={t('mm')} />
    </Field>
  )
  const op: OpInput = { op: 'crop', pages: scope.pages ?? scope.preview, margins: crop }
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      <p className="text-[12px] leading-snug text-muted">{t('crop.howTo')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Scan size={15} />}
          onClick={async () => {
            const r = await window.api.whiteMargins(id, view.page)
            if (r.ok) updateView(id, { crop: r.value })
          }}
        >
          {t('crop.trim')}
        </Button>
        <Button onClick={() => updateView(id, { crop: { left: 0, top: 0, right: 0, bottom: 0 } })}>{t('crop.reset')}</Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field('top', t('cropTop'))}
        {field('bottom', t('cropBottom'))}
        {field('left', t('cropLeft'))}
        {field('right', t('cropRight'))}
      </div>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button variant="primary" disabled={scope.pages === null} onClick={() => void apply(id, op, t('tool.crop'))}>
          {t('act.crop')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function CompressTool({ view }: { view: DocView }) {
  const t = useT()
  const [level, setLevel] = useState<'low' | 'medium' | 'high'>('medium')
  return (
    <>
      <div className="flex flex-col gap-2">
        {(['low', 'medium', 'high'] as const).map((l) => (
          <label key={l} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-[13px] ${l === level ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'}`}>
            <input type="radio" name="level" checked={l === level} onChange={() => setLevel(l)} className="accent-[var(--accent)]" />
            {t(`level.${l}`)}
          </label>
        ))}
      </div>
      <p className="text-[12px] leading-snug text-muted">{t('compressHint')}</p>
      <ToolFooter>
        <Button variant="primary" onClick={() => void apply(view.info.id, { op: 'compress', level }, t('tool.compress')).then((r) => r && openTool(null))}>
          {t('act.compress')}
        </Button>
      </ToolFooter>
    </>
  )
}

import { useEffect, useState } from 'react'
import type { OpInput } from '@shared/ops'
import { apply, useT, type DocView } from '../store'
import { LivePreview } from '../components/LivePreview'
import { Check, ColourPicker, Field, NumberInput, Section, Segmented, Select, Button } from '../components/ui'
import { PageScopeField, ToolFooter, usePageScope } from './common'

/**
 * Format all text (docs/decisions.md §48): every paragraph of the chosen pages retyped in a
 * new typeface, size or colour — the text box's own formatting, for the whole file. Sizes
 * can be scaled (headings stay bigger than body text) or set to one size.
 */
export function FormatTextTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [font, setFont] = useState<string>('keep')
  const [fonts, setFonts] = useState<string[]>([])
  const [sizeMode, setSizeMode] = useState<'keep' | 'scale' | 'set'>('scale')
  const [percent, setPercent] = useState(120)
  const [points, setPoints] = useState(12)
  const [recolour, setRecolour] = useState(false)
  const [colour, setColour] = useState('#000000')
  useEffect(() => void window.api.systemFonts().then((r) => r.ok && setFonts(r.value)), [])
  const kind = font === 'serif' || font === 'sans' || font === 'mono' ? font : undefined
  const family = font.startsWith('pc:') ? font.slice(3) : undefined
  const nothing = font === 'keep' && sizeMode === 'keep' && !recolour
  const op: OpInput | null = nothing
    ? null
    : {
        op: 'formatText',
        pages: scope.pages ?? (scope.scope === 'all' ? undefined : scope.preview),
        ...(kind ? { kind } : {}),
        ...(family ? { family } : {}),
        ...(sizeMode === 'scale' && percent !== 100 ? { scale: percent / 100 } : {}),
        ...(sizeMode === 'set' ? { size: points } : {}),
        ...(recolour ? { colour } : {})
      }
  return (
    <>
      <Section title={t('preview')}>
        <LivePreview view={view} op={op} width={200} />
      </Section>
      <Field label={t('typeface')}>
        <Select
          value={font}
          onChange={setFont}
          options={[
            { value: 'keep', label: t('format.keepFont') },
            { value: 'serif', label: t('fontSerif'), hint: t('fontSerifHint') },
            { value: 'sans', label: t('fontSans'), hint: t('fontSansHint') },
            { value: 'mono', label: t('fontMono'), hint: t('fontMonoHint') },
            ...fonts.map((f) => ({ value: `pc:${f}`, label: f, hint: t('fonts.installed') }))
          ]}
        />
      </Field>
      <Field label={t('size')}>
        <Segmented
          value={sizeMode}
          onChange={setSizeMode}
          options={[
            { value: 'keep', label: t('format.keepSize') },
            { value: 'scale', label: t('format.scale') },
            { value: 'set', label: t('format.oneSize') }
          ]}
        />
      </Field>
      {sizeMode === 'scale' && (
        <Field label={t('format.scaleBy')} hint={t('format.scaleHint')}>
          <NumberInput value={percent} onChange={setPercent} min={25} max={400} step={5} suffix="%" />
        </Field>
      )}
      {sizeMode === 'set' && (
        <Field label={t('format.allAt')}>
          <NumberInput value={points} onChange={setPoints} min={4} max={200} step={0.5} suffix={t('pt')} />
        </Field>
      )}
      <div className="flex items-center gap-3">
        <Check checked={recolour} onChange={setRecolour} label={t('format.recolour')} />
        {recolour && <ColourPicker value={colour} onChange={setColour} label={t('colour')} />}
      </div>
      <PageScopeField state={scope} />
      <p className="text-[12px] leading-snug text-muted">{t('format.note')}</p>
      <ToolFooter>
        <Button variant="primary" disabled={!op || scope.pages === null} onClick={() => op && void apply(view.info.id, op, t('tool.formatText'))}>
          {t('act.formatText')}
        </Button>
      </ToolFooter>
    </>
  )
}

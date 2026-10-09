import { ScanText } from 'lucide-react'
import { useState } from 'react'
import { apply, useT, type DocView } from '../store'
import { Button, Check, Field, Section, Select } from '../components/ui'
import { PageScopeField, ToolFooter, usePageScope } from './common'

/**
 * Recognise text (OCR), as Acrobat's Scan & OCR › Recognize text (research-acrobat-tools
 * §6): the pages that are pictures get an invisible text layer, so they can be searched,
 * copied, edited, compared and converted. Runs on this PC; nothing is uploaded.
 */
export function OcrTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [language, setLanguage] = useState<'auto' | 'ar' | 'en'>('auto')
  const [redo, setRedo] = useState(false)
  return (
    <>
      <div className="flex items-start gap-3 rounded-xl bg-accent-soft p-3">
        <ScanText size={20} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-[12px] leading-snug">{t('ocr.explain')}</p>
      </div>
      <Section title={t('ocr.options')}>
        <Field label={t('ocr.language')}>
          <Select
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'auto', label: t('ocr.auto'), hint: t('ocr.autoHint') },
              { value: 'ar', label: t('ocr.arabic') },
              { value: 'en', label: t('ocr.english') }
            ]}
          />
        </Field>
        <Check checked={redo} onChange={setRedo} label={t('ocr.redo')} hint={t('ocr.redoHint')} />
      </Section>
      <PageScopeField state={scope} />
      <p className="text-[12px] leading-snug text-muted">{t('ocr.time')}</p>
      <ToolFooter>
        <Button
          variant="primary"
          disabled={scope.pages === null}
          onClick={() => void apply(view.info.id, { op: 'ocr', pages: scope.pages ?? (scope.scope === 'all' ? undefined : scope.preview), language, redo }, t('tool.ocr'))}
        >
          {t('act.ocr')}
        </Button>
      </ToolFooter>
    </>
  )
}

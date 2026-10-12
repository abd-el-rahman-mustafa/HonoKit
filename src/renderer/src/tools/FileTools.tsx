import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { parseRanges } from '@shared/pagelist'
import type { Key } from '../i18n'
import { apply, authorize, openTool, useT, writeFiles, type DocView } from '../store'
import { Button, Check, Field, NumberInput, Segmented, Select, TextInput } from '../components/ui'
import { PageScopeField, ToolFooter, usePageScope } from './common'

/** How hard a password is to guess: length and mixed kinds of characters (Acrobat shows Weak/Medium/Strong). */
function strength(p: string): 0 | 1 | 2 | 3 {
  if (!p) return 0
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length
  if (p.length >= 12 && kinds >= 3) return 3
  if (p.length >= 8 && kinds >= 2) return 2
  return 1
}

/**
 * Protect, as Acrobat's "Protect with password": a password to open the file (Viewing), or
 * only to change it (Editing: anyone opens it, the restrictions stay until this password is
 * given). Typed twice, with a strength meter; what others may do is under Advanced options.
 */
export function ProtectTool({ view }: { view: DocView }) {
  const t = useT()
  const [mode, setMode] = useState<'viewing' | 'editing'>('viewing')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [owner, setOwner] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [allow, setAllow] = useState({ allowPrint: true, allowCopy: true, allowModify: false, allowAnnotate: true })
  const differ = again.length > 0 && again !== password
  const comma = password.includes(',') || owner.includes(',')
  const level = strength(password)
  // The same password for both would make whoever opens the file its owner; the engine checks too.
  const same = mode === 'viewing' && !!owner && owner.normalize('NFKC') === password.normalize('NFKC')
  const ready = !!password && password === again && !comma && !same
  const op =
    mode === 'viewing'
      ? ({ op: 'protect', userPassword: password, ownerPassword: owner || undefined, ...allow } as const)
      : ({ op: 'protect', userPassword: '', ownerPassword: password, ...allow } as const)
  return (
    <>
      <Field label={t('protect.needed')}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'viewing', label: t('protect.viewing') },
            { value: 'editing', label: t('protect.editing') }
          ]}
        />
      </Field>
      <p className="text-[12px] leading-snug text-muted">{mode === 'viewing' ? t('protect.viewingHint') : t('protect.editingHint')}</p>
      <Field label={t('protect.type')}>
        <TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {password && (
        <div className="flex items-center gap-2" aria-live="polite">
          <div className="flex flex-1 gap-1">
            {[1, 2, 3].map((n) => (
              <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= level ? (level === 1 ? 'bg-danger' : level === 2 ? 'bg-warn' : 'bg-ok') : 'bg-line'}`} />
            ))}
          </div>
          <span className="text-[11px] text-muted">{t(`strength.${level}` as Key)}</span>
        </div>
      )}
      <Field label={t('protect.retype')} error={differ ? t('passwordsDiffer') : comma ? t('passwordComma') : null}>
        <TextInput type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? '▾' : '▸'} {t('protect.advanced')}
      </button>
      {advanced && (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('protect.othersMay')}</span>
          <Check checked={allow.allowPrint} onChange={(v) => setAllow({ ...allow, allowPrint: v })} label={t('allowPrint')} />
          <Check checked={allow.allowCopy} onChange={(v) => setAllow({ ...allow, allowCopy: v })} label={t('allowCopy')} />
          <Check checked={allow.allowModify} onChange={(v) => setAllow({ ...allow, allowModify: v })} label={t('allowModify')} />
          <Check checked={allow.allowAnnotate} onChange={(v) => setAllow({ ...allow, allowAnnotate: v })} label={t('allowAnnotate')} />
          {mode === 'viewing' && (
            <Field label={t('ownerPassword')} hint={same ? undefined : t('ownerPasswordHint')} error={same ? t('passwordSame') : null}>
              <TextInput type="password" autoComplete="new-password" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </Field>
          )}
        </div>
      )}
      <p className="text-[12px] leading-snug text-faint">{t('protectHint')}</p>
      <ToolFooter>
        <Button variant="primary" disabled={!ready} onClick={() => void apply(view.info.id, op, t('tool.protect')).then((r) => r && openTool(null))}>
          {t('act.protect')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function UnlockTool({ view }: { view: DocView }) {
  const t = useT()
  const { rights, hasOpenPassword } = view.info
  return (
    <>
      <p className="text-[13px] leading-relaxed">{hasOpenPassword || rights.encrypted ? t('unlockHint') : t('notProtected')}</p>
      {!rights.full && (
        <Button variant="secondary" onClick={() => void authorize(view.info.id)}>
          {t('unlockRestrictions')}
        </Button>
      )}
      <ToolFooter>
        <Button variant="primary" disabled={!rights.encrypted} onClick={() => void apply(view.info.id, { op: 'unlock' }, t('tool.unlock')).then((r) => r && openTool(null))}>
          {t('act.unlock')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function MetadataTool({ view }: { view: DocView }) {
  const t = useT()
  const [meta, setMeta] = useState(view.info.meta)
  const field = (key: keyof typeof meta, label: string) => (
    <Field label={label}>
      <TextInput dir="auto" value={meta[key]} onChange={(e) => setMeta({ ...meta, [key]: e.target.value })} />
    </Field>
  )
  return (
    <>
      {field('title', t('title'))}
      {field('author', t('author'))}
      {field('subject', t('subject'))}
      {field('keywords', t('keywords'))}
      <ToolFooter>
        <Button variant="primary" onClick={() => void apply(view.info.id, { op: 'metadata', ...meta }, t('tool.metadata')).then((r) => r && openTool(null))}>
          {t('act.metadata')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function RepairTool({ view }: { view: DocView }) {
  const t = useT()
  return (
    <>
      <p className="text-[13px] leading-relaxed">{t('repairHint')}</p>
      <ToolFooter>
        <Button variant="primary" onClick={() => void apply(view.info.id, { op: 'repair' }, t('tool.repair')).then((r) => r && openTool(null))}>
          {t('act.repair')}
        </Button>
      </ToolFooter>
    </>
  )
}

async function chooseFolder(): Promise<string | null> {
  return window.api.pickFolder()
}

export function SplitTool({ view }: { view: DocView }) {
  const t = useT()
  const count = view.info.pages.length
  const [mode, setMode] = useState<'each' | 'every' | 'ranges'>('every')
  const [every, setEvery] = useState(Math.min(2, count))
  const [text, setText] = useState('')
  const ranges: Array<[number, number]> | null =
    mode === 'each'
      ? Array.from({ length: count }, (_, i): [number, number] => [i, i])
      : mode === 'every'
        ? Array.from({ length: Math.ceil(count / every) }, (_, i): [number, number] => [i * every, Math.min(count, (i + 1) * every) - 1])
        : parseRanges(text, count)
  return (
    <>
      <Field label={t('splitMode')}>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'every', label: t('splitEvery') },
            { value: 'each', label: t('splitEach') },
            { value: 'ranges', label: t('splitRanges') }
          ]}
        />
      </Field>
      {mode === 'every' && (
        <Field label={t('everyN')}>
          <NumberInput value={every} onChange={(v) => setEvery(Math.max(1, Math.round(v)))} min={1} max={count} />
        </Field>
      )}
      {mode === 'ranges' && (
        <Field label={t('ranges')} hint={t('rangesHint')} error={text.trim() && !ranges ? t('badPageList') : null}>
          <TextInput dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder="1-3, 4-10, 11-" />
        </Field>
      )}
      {ranges && <p className="text-[12px] text-muted">{t('willCreate', { count: ranges.length })}</p>}
      <ToolFooter>
        <Button
          variant="primary"
          icon={<FolderOpen size={15} />}
          disabled={!ranges || ranges.length === 0}
          onClick={async () => {
            const folder = await chooseFolder()
            if (folder && ranges) await writeFiles(() => window.api.split(view.info.id, ranges, folder), t('tool.split'), folder)
          }}
        >
          {t('act.split')}
        </Button>
      </ToolFooter>
    </>
  )
}

export function ToImagesTool({ view }: { view: DocView }) {
  const t = useT()
  const scope = usePageScope(view)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [dpi, setDpi] = useState('150')
  return (
    <>
      <Field label={t('format')}>
        <Segmented value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }]} />
      </Field>
      <Field label={t('resolution')}>
        <Select value={dpi} onChange={setDpi} options={['72', '150', '200', '300', '600'].map((d) => ({ value: d, label: t('dpi', { n: d }) }))} />
      </Field>
      <PageScopeField state={scope} />
      <ToolFooter>
        <Button
          variant="primary"
          icon={<FolderOpen size={15} />}
          disabled={scope.pages === null}
          onClick={async () => {
            const folder = await chooseFolder()
            if (folder) await writeFiles(() => window.api.exportImages(view.info.id, scope.pages ?? null, format, Number(dpi), folder), t('tool.toImages'), folder)
          }}
        >
          {t('chooseFolder')}
        </Button>
      </ToolFooter>
    </>
  )
}


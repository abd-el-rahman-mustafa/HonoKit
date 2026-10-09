import { BadgeCheck, FileKey2, KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'
import type { Position } from '@shared/ops'
import { apply, setDialog, useStore, useT } from '../store'
import { PositionPicker } from '../tools/common'
import { Modal } from './Overlays'
import { Button, Field, Select, TextInput } from './ui'

/**
 * Sign with a digital ID (certificate), as Acrobat's "Use a certificate" (research-acrobat-editing
 * §4.6): choose the ID (a .pfx / .p12 file) or create one, its password, a reason and place, an
 * optional drawn signature beside the name, and where on the page. The password is used once
 * and never kept (docs/decisions.md §53).
 */
export function CertSignDialog({ docId }: { docId: string }) {
  const t = useT()
  const view = useStore((s) => s.docs[docId])
  const settings = useStore((s) => s.settings)
  const [idPath, setIdPath] = useState<string | null>(settings?.digitalId ?? null)
  const [creating, setCreating] = useState(!settings?.digitalId)
  const [name, setName] = useState(settings?.authorName ?? '')
  const [email, setEmail] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [again, setAgain] = useState('')
  const [password, setPassword] = useState('')
  const [reason, setReason] = useState<string>('approve')
  const [customReason, setCustomReason] = useState('')
  const [location, setLocation] = useState('')
  const [picture, setPicture] = useState<string>('none')
  const [position, setPosition] = useState<Position>('bottom-right')
  const [busy, setBusy] = useState(false)
  if (!view) return null
  const page = view.page
  const size = view.info.pages[page]!
  const reasons: Record<string, string> = { approve: t('certSign.reason.approve'), author: t('certSign.reason.author'), reviewed: t('certSign.reason.reviewed'), agree: t('certSign.reason.agree') }
  const reasonText = reason === 'custom' ? customReason.trim() : reasons[reason]
  const create = async (): Promise<void> => {
    const path = await window.api.createDigitalId({ name: name.trim(), email: email.trim(), organisation: organisation.trim(), password: newPassword })
    if (path) {
      setIdPath(path)
      setPassword(newPassword)
      setCreating(false)
    }
  }
  const sign = async (): Promise<void> => {
    if (!idPath) return
    const w = 200
    const h = 62
    const m = 36
    const col = position.endsWith('left') ? 0 : position.endsWith('right') ? 2 : 1
    const row = position.startsWith('top') ? 0 : position.startsWith('bottom') ? 2 : 1
    const x0 = col === 0 ? m : col === 2 ? size.width - m - w : (size.width - w) / 2
    const y0 = row === 0 ? m : row === 2 ? size.height - m - h : (size.height - h) / 2
    const drawn = picture === 'none' ? undefined : settings?.signatures.find((s) => s.id === picture)?.data
    const date = new Date().toLocaleString(settings?.language === 'ar' ? 'ar-AE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    setBusy(true)
    const r = await apply(
      docId,
      {
        op: 'certSign',
        page,
        box: [x0, y0, x0 + w, y0 + h],
        p12Path: idPath,
        password,
        ...(reasonText ? { reason: reasonText } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(drawn ? { picture: drawn } : {}),
        labels: { signedBy: t('certSign.signedBy'), date }
      },
      t('certSign.title')
    )
    setBusy(false)
    if (r) setDialog(null)
  }
  const passwordsMatch = newPassword.length >= 4 && newPassword === again
  return (
    <Modal title={t('certSign.title')} onClose={() => setDialog(null)} width={500}>
      <div className="flex items-start gap-3 rounded-lg bg-accent-soft p-3 text-[12px] leading-snug">
        <BadgeCheck size={18} className="mt-0.5 shrink-0 text-accent" />
        <span>{t('certSign.explain')}</span>
      </div>
      {creating ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3" data-create-id="">
          <span className="text-[13px] font-semibold">{t('certSign.createTitle')}</span>
          <Field label={t('certSign.name')}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} dir="auto" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('certSign.email')}>
              <TextInput value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
            </Field>
            <Field label={t('certSign.organisation')}>
              <TextInput value={organisation} onChange={(e) => setOrganisation(e.target.value)} dir="auto" />
            </Field>
            <Field label={t('certSign.newPassword')} hint={t('certSign.newPasswordHint')}>
              <TextInput type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
            <Field label={t('certSign.again')} error={again && !passwordsMatch ? t('certSign.mismatch') : null}>
              <TextInput type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
          </div>
          <p className="text-[11px] text-muted">{t('certSign.selfSignedNote')}</p>
          <div className="flex justify-end gap-2">
            {idPath && <Button onClick={() => setCreating(false)}>{t('cancel')}</Button>}
            <Button variant="primary" icon={<KeyRound size={15} />} disabled={!name.trim() || !passwordsMatch} onClick={() => void create()}>
              {t('certSign.create')}
            </Button>
          </div>
        </div>
      ) : (
        <Field label={t('certSign.id')}>
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[12px]" title={idPath ?? ''}>
              <FileKey2 size={15} className="shrink-0 text-accent" />
              <span className="truncate" dir="ltr">
                {idPath?.split(/[\\/]/).pop() ?? t('certSign.noId')}
              </span>
            </span>
            <Button onClick={async () => setIdPath((await window.api.pickDigitalId()) ?? idPath)}>{t('certSign.choose')}</Button>
            <Button icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              {t('certSign.new')}
            </Button>
          </div>
        </Field>
      )}
      {!creating && (
        <>
          <Field label={t('certSign.password')}>
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('certSign.reason')}>
              <Select
                value={reason}
                onChange={setReason}
                options={[...Object.entries(reasons).map(([value, label]) => ({ value, label })), { value: 'custom', label: t('certSign.reason.custom') }, { value: 'none', label: t('certSign.reason.none') }]}
              />
            </Field>
            <Field label={t('certSign.location')}>
              <TextInput value={location} onChange={(e) => setLocation(e.target.value)} dir="auto" placeholder={t('certSign.locationHint')} />
            </Field>
          </div>
          {reason === 'custom' && <TextInput value={customReason} onChange={(e) => setCustomReason(e.target.value)} dir="auto" placeholder={t('certSign.reason')} />}
          <div className="flex items-start gap-4">
            <Field label={t('position')}>
              <PositionPicker value={position} onChange={setPosition} />
            </Field>
            <div className="flex flex-1 flex-col gap-2">
              <span className="text-[12px] text-muted">{t('certSign.onPage', { n: page + 1 })}</span>
              {settings && settings.signatures.length > 0 && (
                <Field label={t('certSign.picture')}>
                  <Select value={picture} onChange={setPicture} options={[{ value: 'none', label: t('certSign.noPicture') }, ...settings.signatures.map((s, i) => ({ value: s.id, label: t('certSign.pictureN', { n: i + 1 }) }))]} />
                </Field>
              )}
            </div>
          </div>
          <p className="text-[12px] leading-snug text-muted">{t('certSign.keepHint')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={!idPath || !password || busy} onClick={() => void sign()}>
              {t('certSign.sign')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

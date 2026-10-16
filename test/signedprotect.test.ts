import { describe, expect, it } from 'vitest'
import { createDigitalId, signWithCertificate } from '@engine/sign'
import { isEncrypted } from '@engine/security'
import { applyOperation } from '@ops/index'
import { makeLatinPdf } from './fixtures'

/**
 * A signed file is only appended to (§53), and encryption cannot be appended: Protect used to
 * report success on a signed file and hand back the same bytes, opening without a password
 * (found 2026-10-08). It is refused now, with a reason the person can read.
 */
describe('protect and unlock on a signed file', () => {
  it('refuses instead of saying a file is protected when it is not', async () => {
    const p12 = createDigitalId('Test Signer', '', '', 'secret12')
    const signed = await signWithCertificate(await makeLatinPdf(1), { p12, password: 'secret12', page: 0, box: [200, 480, 380, 540], labels: { signedBy: 'Signed', date: '2026-10-08' } })
    await expect(applyOperation(signed, { op: 'protect', userPassword: 'open-me' })).rejects.toMatchObject({ code: 'signed' })
    await expect(applyOperation(signed, { op: 'protect', userPassword: '', ownerPassword: 'owner-pass' })).rejects.toMatchObject({ code: 'signed' })
    await expect(applyOperation(signed, { op: 'unlock' })).rejects.toMatchObject({ code: 'signed' })
    // An unsigned file is still protected as before.
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'protect', userPassword: 'open-me' })
    expect(isEncrypted(bytes)).toBe(true)
  })
})

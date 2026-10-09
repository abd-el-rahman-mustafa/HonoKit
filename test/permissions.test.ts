import { describe, expect, it } from 'vitest'
import { free, isEncrypted, openPdf, rightsOf } from '@engine/mupdf'
import { pageCount } from '@engine/pages'
import { extractText } from '@engine/text'
import type { OpInput } from '@shared/ops'
import { applyOperation, rightsFor } from '@ops/index'
import { makeLatinPdf, makeRestrictedPdf } from './fixtures'

/** docs/decisions.md §23: the author's restrictions are respected; the permissions password lifts them. */
describe('restricted PDFs', () => {
  it('opens and reads a restricted file without any password', async () => {
    const src = await makeRestrictedPdf(2)
    const doc = openPdf(src)
    try {
      expect(extractText(doc, 1)).toContain('Marker2')
      expect(rightsOf(doc)).toMatchObject({ encrypted: true, full: false, edit: false, assemble: false, print: true, copy: true })
    } finally {
      free(doc)
    }
  })

  it('refuses changes the author did not allow, with a clear reason', async () => {
    const src = await makeRestrictedPdf(2)
    for (const op of [{ op: 'rotate', pages: [0], angle: 90 }, { op: 'watermark', text: 'X' }, { op: 'compress', level: 'low' }, { op: 'unlock' }] satisfies OpInput[]) {
      await expect(applyOperation(src, op)).rejects.toMatchObject({ code: 'restricted' })
    }
  })

  it('allows page rearranging when the author allows assembling but not editing', async () => {
    const src = await makeRestrictedPdf(3, { assemble: true })
    const { bytes } = await applyOperation(src, { op: 'keep', pages: [2, 1, 0] })
    expect(pageCount(bytes)).toBe(3)
    await expect(applyOperation(src, { op: 'watermark', text: 'X' })).rejects.toMatchObject({ code: 'restricted' })
  })

  it('lifts the restrictions with the permissions password, and rejects a wrong one', async () => {
    const src = await makeRestrictedPdf(2)
    expect(rightsFor(src, 'owner-secret').full).toBe(true)
    expect(() => rightsFor(src, 'nope')).toThrowError(expect.objectContaining({ code: 'wrong-password' }))
    const { bytes } = await applyOperation(src, { op: 'watermark', text: 'APPROVED', rotation: 0 }, { password: 'owner-secret' })
    // Still encrypted, still restricted for everyone else, and the stamp is in it.
    expect(rightsFor(bytes).full).toBe(false)
    const doc = openPdf(bytes)
    try {
      expect(isEncrypted(doc)).toBe(true)
      expect(extractText(doc, 0)).toContain('APPROVED')
    } finally {
      free(doc)
    }
  })

  it('unlocks with the permissions password', async () => {
    const { bytes } = await applyOperation(await makeRestrictedPdf(1), { op: 'unlock' }, { password: 'owner-secret' })
    expect(rightsFor(bytes)).toMatchObject({ encrypted: false, full: true })
  })
})

describe('stamping keeps a password-protected file protected', () => {
  it('watermarks a file opened with its open password, and it still needs that password', async () => {
    const locked = (await applyOperation(await makeLatinPdf(2), { op: 'protect', userPassword: 'open-me', allowModify: true, allowAnnotate: true, allowCopy: true, allowPrint: true })).bytes
    const { bytes } = await applyOperation(locked, { op: 'pageNumbers', template: '{n}/{N}' }, { password: 'open-me' })
    expect(() => openPdf(bytes)).toThrowError(expect.objectContaining({ code: 'password-required' }))
    const doc = openPdf(bytes, 'open-me')
    try {
      expect(extractText(doc, 1)).toContain('2/2')
    } finally {
      free(doc)
    }
  })
})

describe('protecting for editing only (Acrobat\'s "Editing" mode)', () => {
  it('opens without a password, restricted; the permissions password lifts it', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'protect', userPassword: '', ownerPassword: 'change-me', allowModify: false, allowCopy: true, allowPrint: true, allowAnnotate: false })
    const rights = rightsFor(bytes)
    expect(rights).toMatchObject({ encrypted: true, edit: false, copy: true })
    expect(rightsFor(bytes, 'change-me')).toMatchObject({ full: true })
  })

  it('needs at least one password', async () => {
    await expect(applyOperation(await makeLatinPdf(1), { op: 'protect', userPassword: '' })).rejects.toMatchObject({ code: 'bad-arguments' })
  })
})

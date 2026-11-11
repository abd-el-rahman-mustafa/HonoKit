import { describe, expect, it } from 'vitest'
import { insertPdfPages, keepPages, mergePdfs, replacePages } from '@engine/pages'
import { protectPdf } from '@engine/security'
import { rightsFor } from '@ops/index'
import { makeLatinPdf } from './fixtures'

const OWNER = 'owner-pass'

/** A file anyone can open, with only a permissions password and the given switches. */
async function protectedPdf(allowCopy: boolean, allowModify: boolean): Promise<Uint8Array> {
  return protectPdf(await makeLatinPdf(2), { userPassword: '', ownerPassword: OWNER, allowPrint: true, allowCopy, allowModify, allowAnnotate: false })
}

/**
 * Combine, Insert from file and Replace pages put another file's pages into a document without
 * that file's protection. The author must allow copying and assembling for that; the permissions
 * password lifts it. Extract keeps the file's own protection, so it stays allowed.
 */
describe('pages taken out of a restricted file', () => {
  it('refuses Combine, Insert and Replace when copying or changes are withheld', async () => {
    const plain = await makeLatinPdf(1)
    for (const [copy, modify] of [[false, false], [false, true], [true, false]] as const) {
      const locked = await protectedPdf(copy, modify)
      expect(() => mergePdfs([{ bytes: plain }, { bytes: locked }])).toThrow(expect.objectContaining({ code: 'restricted', key: 'error.noPageExtraction' }))
      expect(() => insertPdfPages(plain, 1, locked)).toThrow(expect.objectContaining({ code: 'restricted' }))
      expect(() => replacePages(plain, [0], locked, [0])).toThrow(expect.objectContaining({ code: 'restricted' }))
    }
  })

  it('allows them with the permissions password, or when the author allows copying and changes', async () => {
    const plain = await makeLatinPdf(1)
    const locked = await protectedPdf(false, false)
    const merged = mergePdfs([{ bytes: plain }, { bytes: locked, password: OWNER }])
    expect(rightsFor(merged).full).toBe(true)
    expect(rightsFor(insertPdfPages(plain, 1, locked, undefined, OWNER)).full).toBe(true)
    expect(rightsFor(replacePages(plain, [0], locked, [0], OWNER)).full).toBe(true)
    const open = await protectedPdf(true, true)
    expect(rightsFor(mergePdfs([{ bytes: plain }, { bytes: open }])).full).toBe(true)
  })

  it('keeps Extract allowed: the pages stay under the same protection', async () => {
    const kept = keepPages(await protectedPdf(false, false), [0])
    const r = rightsFor(kept)
    expect(r.encrypted).toBe(true)
    expect(r.copy).toBe(false)
    expect(r.assemble || r.edit).toBe(false)
  })
})

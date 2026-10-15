import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSaved, free, openPdf } from '@engine/mupdf'
import { Sessions } from '../src/worker/sessions'
import { writeStaged } from '../src/worker/staging'
import { makeLatinPdf, makeRestrictedPdf } from './fixtures'

/**
 * A save is checked before it replaces the file (decisions §93): the staged bytes are flushed to
 * the disk before the rename, and a rewrite that does not open again with every page is refused.
 */

// A rewrite that loses pages is simulated: MuPDF reads and writes with one reader, so a real file
// that does this is not known; the check guards against one.
const lose = vi.hoisted(() => ({ with: null as Uint8Array | null }))
vi.mock('@engine/mupdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@engine/mupdf')>()
  return { ...real, saveBytes: (...args: Parameters<typeof real.saveBytes>) => lose.with ?? real.saveBytes(...args) }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honokit-savecheck-'))
  lose.with = null
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('staged writes are flushed before they replace the file', () => {
  it('a failed flush keeps the old file and removes the staging file', async () => {
    const target = join(dir, 'out.pdf')
    writeFileSync(target, 'OLD')
    const failing = async (): Promise<void> => {
      throw Object.assign(new Error('flush failed'), { code: 'EIO' })
    }
    await expect(writeStaged(target, new Uint8Array([1, 2, 3]), undefined, failing)).rejects.toThrow('flush failed')
    expect(readFileSync(target, 'utf8')).toBe('OLD')
    expect(readdirSync(dir)).toEqual(['out.pdf'])
  })

  it('flushes the staging file once, before the rename', async () => {
    const target = join(dir, 'out.pdf')
    const seen: number[] = []
    await writeStaged(target, new Uint8Array([9]), undefined, async (handle) => {
      seen.push(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length)
      await handle.sync()
    })
    expect(seen).toEqual([1])
    expect([...readFileSync(target)]).toEqual([9])
  })
})

describe('checkSaved: bytes that would replace a file open again with every page', () => {
  it('accepts a good copy, an encrypted one with its password, and refuses the rest', async () => {
    const three = await makeLatinPdf(3)
    expect(() => checkSaved(three, undefined, 3)).not.toThrow()
    expect(() => checkSaved(three, undefined, 4)).toThrow(/3 of 4 pages/)
    expect(() => checkSaved(three.slice(0, 40), undefined, 3)).toThrow(/0 of 3 pages/)
    expect(() => checkSaved(new Uint8Array(0), undefined, 1)).toThrow()
    const locked = await makeRestrictedPdf(2)
    expect(() => checkSaved(locked, 'owner-secret', 2)).not.toThrow()
    try {
      checkSaved(three, undefined, 5)
    } catch (error) {
      expect(error).toMatchObject({ code: 'corrupt', key: 'error.saveCheck', values: { found: 3, pages: 5 } })
    }
  })
})

describe('a save that would lose pages is refused before the file is replaced', () => {
  it('Save and Share leave the file on disk as it was', async () => {
    const original = await makeLatinPdf(3)
    const path = join(dir, 'doc.pdf')
    writeFileSync(path, original)
    const sessions = new Sessions()
    // Opened from memory: unsaved, so Share writes a copy too.
    const info = sessions.openBytes('doc.pdf', original)
    expect(info.pages).toHaveLength(3)
    lose.with = await makeLatinPdf(1)
    await expect(sessions.save(info.id, path)).rejects.toMatchObject({ key: 'error.saveCheck' })
    await expect(sessions.shareCopy(info.id, join(dir, 'share'))).rejects.toMatchObject({ key: 'error.saveCheck' })
    expect(Buffer.compare(readFileSync(path), Buffer.from(original))).toBe(0)
    expect(readdirSync(dir).filter((n) => n !== 'share')).toEqual(['doc.pdf'])
  })

  it('an ordinary file still saves', async () => {
    const path = join(dir, 'fine.pdf')
    writeFileSync(path, await makeLatinPdf(2))
    const sessions = new Sessions()
    const info = await sessions.openFile(path)
    await sessions.save(info.id, join(dir, 'copy.pdf'))
    const doc = openPdf(new Uint8Array(readFileSync(join(dir, 'copy.pdf'))))
    expect(doc.countPages()).toBe(2)
    free(doc)
  })
})

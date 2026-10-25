import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeStaged } from '../src/worker/staging'
import { flagsOf } from '../src/worker/winattrs'

/**
 * A save must not uncover a file (decisions §104): the staging file carries the attributes of the
 * file it replaces, so a hidden or system file is still hidden or system after the save.
 */

const windows = process.platform === 'win32'

/** What Windows says the file is now; `attrib` is the only reader available. */
const attributesOf = (path: string): { hidden: boolean; system: boolean } => flagsOf(execFileSync('attrib', [path], { encoding: 'latin1', windowsHide: true }))

const mark = (path: string, ...flags: string[]): void => void execFileSync('attrib', [...flags, path], { windowsHide: true })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'honokit-stagingattrs-'))
})
afterEach(() => {
  // A hidden file is removed as any other, but the folder must be plain again on Windows.
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!windows)('a staged write keeps the replaced file out of sight', () => {
  it('reads the flags attrib prints, and nothing from the path', () => {
    // attrib puts each flag in a column of its own: S and H end up side by side.
    expect(flagsOf('A  SH                C:\\dir\\Shown Hidden.pdf')).toEqual({ hidden: true, system: true })
    expect(flagsOf('A                    C:\\dir\\file.pdf')).toEqual({ hidden: false, system: false })
    expect(flagsOf('A   H                \\\\server\\share\\file.pdf')).toEqual({ hidden: true, system: false })
    expect(flagsOf('A  S                 C:\\dir\\file.pdf')).toEqual({ hidden: false, system: true })
    // A message, in any language, is not a line of flags.
    expect(flagsOf('File not found - C:\\dir\\gone.pdf')).toEqual({ hidden: false, system: false })
    expect(flagsOf('Datei nicht gefunden - C:\\dir\\Shown.pdf')).toEqual({ hidden: false, system: false })
    expect(flagsOf('')).toEqual({ hidden: false, system: false })
  })

  it('a hidden file is still hidden after it is saved over', async () => {
    const target = join(dir, 'hidden.pdf')
    writeFileSync(target, 'OLD')
    mark(target, '+H')
    await writeStaged(target, new Uint8Array([1, 2, 3]))
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
    expect(attributesOf(target)).toEqual({ hidden: true, system: false })
  })

  it('a system file, and a hidden system file, keep what they are', async () => {
    const system = join(dir, 'system.pdf')
    writeFileSync(system, 'OLD')
    mark(system, '+S')
    await writeStaged(system, 'NEW')
    expect(attributesOf(system)).toEqual({ hidden: false, system: true })

    const both = join(dir, 'both.pdf')
    writeFileSync(both, 'OLD')
    mark(both, '+H', '+S')
    await writeStaged(both, 'NEW')
    expect(readFileSync(both, 'utf8')).toBe('NEW')
    expect(attributesOf(both)).toEqual({ hidden: true, system: true })
  })

  it('a plain file stays plain, and a new file gets neither', async () => {
    const plain = join(dir, 'plain.pdf')
    writeFileSync(plain, 'OLD')
    await writeStaged(plain, 'NEW')
    expect(attributesOf(plain)).toEqual({ hidden: false, system: false })

    const fresh = join(dir, 'fresh.pdf')
    await writeStaged(fresh, 'NEW')
    expect(attributesOf(fresh)).toEqual({ hidden: false, system: false })
  })

  it('the staging file is hidden before the rename, so the file is never uncovered', async () => {
    const target = join(dir, 'hidden.pdf')
    writeFileSync(target, 'OLD')
    mark(target, '+H', '+S')
    const staged: Array<{ hidden: boolean; system: boolean }> = []
    await writeStaged(target, 'NEW', undefined, async (handle) => {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.tmp'))) staged.push(attributesOf(join(dir, name)))
      await handle.sync()
    })
    expect(staged).toEqual([{ hidden: true, system: true }])
  })
})

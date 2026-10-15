import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Staging files, created exclusively (decisions §82). A file is written to a
 * temporary name beside its target and then renamed over it, so a failure half-way never leaves a
 * damaged file. The temporary name is random and opened with 'wx' (create, fail if it exists): a
 * file or link someone planted at that name is never written through, and another name is tried.
 * The rename replaces a link at the target itself rather than writing into what it points to.
 */

/** How many names are tried before giving up. */
const ATTEMPTS = 16

/** Random suffixes: unguessable, so a name cannot be planted in advance. */
export function* stagingSuffixes(): Generator<string> {
  for (;;) yield randomBytes(8).toString('hex')
}

const stagingName = (target: string, suffix: string): string => join(dirname(target), `.${basename(target)}.${suffix}.tmp`)

const taken = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  // Windows answers EPERM for a name that is a folder (or is being deleted).
  return code === 'EEXIST' || code === 'EPERM' || code === 'EISDIR'
}

/** Flushes a staging file to the disk: a late write error then fails the save, not the next read. */
const flushToDisk = (handle: FileHandle): Promise<void> => handle.sync()

/**
 * Writes `data` to `target` through an exclusively created staging file beside it. The staging
 * file is flushed before the rename (§93), so the old file is only replaced by bytes the disk has
 * accepted; a failed flush leaves it as it was.
 */
export async function writeStaged(
  target: string,
  data: Uint8Array | string,
  suffixes: Iterator<string> = stagingSuffixes(),
  flush: (handle: FileHandle) => Promise<void> = flushToDisk,
): Promise<void> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const next = suffixes.next()
    if (next.done) break
    const temporary = stagingName(target, next.value)
    let handle
    try {
      handle = await open(temporary, 'wx')
    } catch (error) {
      if (taken(error)) continue
      throw error
    }
    try {
      try {
        await handle.writeFile(data)
        await flush(handle)
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
      return
    } catch (error) {
      // Only the file this call created is removed.
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
  throw new Error(`No free temporary name beside ${target}.`)
}

/** The same, synchronously (settings). */
export function writeStagedSync(target: string, data: string | Uint8Array, suffixes: Iterator<string> = stagingSuffixes()): void {
  for (let i = 0; i < ATTEMPTS; i++) {
    const next = suffixes.next()
    if (next.done) break
    const temporary = stagingName(target, next.value)
    let fd: number
    try {
      fd = openSync(temporary, 'wx')
    } catch (error) {
      if (taken(error)) continue
      throw error
    }
    try {
      try {
        const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
        for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, target)
      return
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
  throw new Error(`No free temporary name beside ${target}.`)
}

/** Writes a new file that must not exist yet (a fresh temporary folder's files): never through a planted one. */
export async function writeNew(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

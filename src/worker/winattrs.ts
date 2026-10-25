import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The Windows attributes that keep a file out of a plain listing (decisions §104). A save writes a
 * staging file and renames it over the target, and Windows gives the saved file the staging file's
 * attributes, not the replaced file's: a hidden or system file came out of a save visible. The
 * staging file is therefore marked before anything is written into it, so it is hidden from its
 * first moment when the target is, and plain when the target is plain. A new file gets neither.
 *
 * Windows has no attribute interface in Node, so `attrib` is asked. It is read only for a target
 * that exists (an export into a fresh folder never pays for it), and the file's own attributes are
 * read, not those of a file a link points at. A failed call leaves the save to go ahead: the file
 * then comes out as it did before this, never worse.
 */
export interface KeptAttributes {
  hidden: boolean
  system: boolean
}

export const NO_ATTRIBUTES: KeptAttributes = { hidden: false, system: false }

/** How long `attrib` is waited for; a hung call must not hold up a save. */
const TIMEOUT = 5000

/**
 * The flags `attrib` prints in front of the path, each in a column of its own, as in
 * `A  SH     C:\dir\file.pdf`. The path is found by its drive letter or its UNC prefix, so none of
 * its own letters is read as a flag, and a line whose front is not flags and spaces is not one
 * (a message in any language: "File not found - …") and carries none.
 */
export function flagsOf(output: string): KeptAttributes {
  const line = output.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  const at = line.search(/[A-Za-z]:[\\/]|\\\\/)
  if (at < 0) return NO_ATTRIBUTES
  const flags = line.slice(0, at)
  if (!/^[ARSHOIXVPUBCELN ]*$/.test(flags)) return NO_ATTRIBUTES
  return { hidden: flags.includes('H'), system: flags.includes('S') }
}

/** The attributes `target` would lose when a staging file is renamed over it. */
export async function keptAttributes(target: string): Promise<KeptAttributes> {
  if (process.platform !== 'win32') return NO_ATTRIBUTES
  try {
    // The link's own attributes, not its target's: the rename replaces the link itself (§82).
    await lstat(target)
  } catch {
    return NO_ATTRIBUTES
  }
  try {
    const { stdout } = await run('attrib', [target], { timeout: TIMEOUT, windowsHide: true })
    return flagsOf(stdout)
  } catch {
    return NO_ATTRIBUTES
  }
}

/** Puts `kept` on `path`; best effort, so a save is never lost to an attribute. */
export async function applyAttributes(path: string, kept: KeptAttributes): Promise<void> {
  if (process.platform !== 'win32' || (!kept.hidden && !kept.system)) return
  const flags = [...(kept.hidden ? ['+H'] : []), ...(kept.system ? ['+S'] : [])]
  try {
    await run('attrib', [...flags, path], { timeout: TIMEOUT, windowsHide: true })
  } catch {
    /* the file keeps the attributes it has */
  }
}

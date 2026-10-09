import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Place } from '@shared/ipc'
import { fileKind } from '@shared/opening'

/**
 * Storage places (docs/decisions.md §39): the folders a cloud drive keeps in sync on this PC —
 * OneDrive, Google Drive, Dropbox, iCloud — found where their desktop apps put them, plus the
 * usual Documents, Desktop and Downloads, plus any folder the person links (a network share,
 * a USB drive). Saving into one of them is saving to that drive: its own app uploads the file.
 * No account, no sign-in and no internet access from HonoPDF itself.
 */

function isFolder(path: string | undefined): path is string {
  if (!path) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function googleDrive(): string[] {
  const found: string[] = []
  // Google Drive for desktop mounts a drive letter with "My Drive" in it; older versions used a folder.
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const path = `${letter}:\\My Drive`
    if (isFolder(path)) found.push(path)
  }
  for (const path of [join(homedir(), 'Google Drive'), join(homedir(), 'My Drive')]) if (isFolder(path)) found.push(path)
  return found
}

function dropbox(): string[] {
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (!base) continue
    try {
      const info = JSON.parse(readFileSync(join(base, 'Dropbox', 'info.json'), 'utf8')) as Record<string, { path?: string }>
      const paths = Object.values(info)
        .map((v) => v.path)
        .filter(isFolder)
      if (paths.length) return paths
    } catch {
      /* not installed there */
    }
  }
  const home = join(homedir(), 'Dropbox')
  return isFolder(home) ? [home] : []
}

export function detectedPlaces(): Place[] {
  const out: Place[] = []
  const add = (path: string | undefined, kind: Place['kind'], label?: string): void => {
    if (!isFolder(path) || out.some((p) => p.path.toLowerCase() === path.toLowerCase())) return
    out.push({ path, kind, label: label ?? basename(path), detected: true })
  }
  add(process.env.OneDriveCommercial, 'onedrive', `OneDrive — ${basename(process.env.OneDriveCommercial ?? '').replace(/^OneDrive - /, '')}`)
  add(process.env.OneDriveConsumer ?? process.env.OneDrive, 'onedrive', 'OneDrive')
  for (const path of googleDrive()) add(path, 'google', 'Google Drive')
  for (const path of dropbox()) add(path, 'dropbox', 'Dropbox')
  add(join(homedir(), 'iCloudDrive'), 'icloud', 'iCloud Drive')
  add(app.getPath('documents'), 'documents')
  add(app.getPath('desktop'), 'desktop')
  add(app.getPath('downloads'), 'downloads')
  return out
}

export interface FolderEntry {
  name: string
  path: string
  folder: boolean
  size: number
  modified: number
}

/** The subfolders, PDFs and pictures of a folder (§75), folders first, for the Home screen's places. */
export function listFolder(path: string): FolderEntry[] {
  const out: FolderEntry[] = []
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return []
  }
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('~$') || name === 'desktop.ini') continue
    const full = join(path, name)
    try {
      const s = statSync(full)
      if (s.isDirectory()) out.push({ name, path: full, folder: true, size: 0, modified: s.mtimeMs })
      else if (fileKind(name)) out.push({ name, path: full, folder: false, size: s.size, modified: s.mtimeMs })
    } catch {
      /* not readable (an online-only placeholder may fail): skip */
    }
    if (out.length >= 1000) break
  }
  return out.sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.folder ? -1 : 1))
}

export function exists(path: string): boolean {
  return existsSync(path)
}

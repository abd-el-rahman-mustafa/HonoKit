import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BRAND } from '@shared/brand'
import shareScript from './share.ps1?raw'

/**
 * Share, offline (docs/research-files-share-style.md, Part B; decisions §37): the Windows
 * Share sheet, a new email with the file attached, the file on the clipboard as a real file,
 * and dragging the file out. Everything runs through Windows' own signed programs
 * (PowerShell 5.1, reg.exe, the mail app) — an extra helper .exe would be blocked unsigned.
 * Paths always travel in environment variables, never inside command text.
 */

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const REG = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')

/** Where copies with unsaved changes are written for sharing. */
export const SHARE_DIR = join(tmpdir(), BRAND.name, 'share')

/** Removes shared copies older than a day (never right after sharing: the other app may read it later). */
export function cleanShareFolder(): void {
  try {
    if (!existsSync(SHARE_DIR)) return
    for (const name of readdirSync(SHARE_DIR, { recursive: true }) as string[]) {
      const path = join(SHARE_DIR, name)
      try {
        const s = statSync(path)
        if (s.isFile() && Date.now() - s.mtimeMs > 24 * 60 * 60 * 1000) unlinkSync(path)
      } catch {
        /* in use or gone */
      }
    }
  } catch {
    /* nothing to clean */
  }
}

export function ensureShareFolder(): string {
  mkdirSync(SHARE_DIR, { recursive: true })
  return SHARE_DIR
}

function run(file: string, args: string[], env: Record<string, string>, timeout: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout }, (error, stdout) => resolve({ ok: !error, out: String(stdout ?? '').trim() }))
  })
}

/** The file on the clipboard as a file (CF_HDROP): Ctrl+V pastes it into Explorer, Outlook, WhatsApp, Teams. */
export async function copyFileToClipboard(path: string): Promise<boolean> {
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Set-Clipboard -LiteralPath $env:PP_FILE'], { PP_FILE: path }, 15000)
  return r.ok
}

/** Opens the Windows Share sheet for the file at a screen point. Resolves to its outcome. */
export async function showShareSheet(path: string, at: { x: number; y: number }): Promise<'completed' | 'canceled' | 'timeout' | 'error'> {
  const encoded = Buffer.from(shareScript, 'utf16le').toString('base64')
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { PP_SHARE_PATH: path, PP_SHARE_X: String(Math.round(at.x)), PP_SHARE_Y: String(Math.round(at.y)) }, 130000)
  if (!r.ok) return 'error'
  const last = r.out.split(/\r?\n/).pop() ?? ''
  return last.startsWith('completed') ? 'completed' : last === 'canceled' ? 'canceled' : last === 'timeout' ? 'timeout' : 'error'
}

async function regValue(key: string, value?: string): Promise<string | null> {
  const r = await run(REG, ['query', key, ...(value ? ['/v', value] : ['/ve'])], {}, 5000)
  if (!r.ok) return null
  const line = r.out.split(/\r?\n/).find((l) => /REG_(SZ|EXPAND_SZ)/.test(l))
  return line ? line.replace(/^.*REG_(?:EXPAND_)?SZ\s+/, '').trim() : null
}

export type MailApp = { kind: 'outlook' | 'thunderbird'; exe: string } | { kind: 'other'; name: string } | { kind: 'none' }

/** Which program opens mailto: links, and how to give it an attachment. */
export async function mailApp(): Promise<MailApp> {
  const progId = await regValue('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice', 'ProgId')
  if (!progId) return { kind: 'none' }
  if (/^Outlook\.URL\.mailto/i.test(progId)) {
    const exe = (await regValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE')) ?? (await regValue('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE'))
    if (exe && existsSync(exe)) return { kind: 'outlook', exe }
  }
  if (/thunderbird/i.test(progId)) {
    const exe = (await regValue('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\thunderbird.exe')) ?? null
    if (exe && existsSync(exe)) return { kind: 'thunderbird', exe }
  }
  return { kind: 'other', name: progId }
}

/**
 * A new email with the file attached. Classic Outlook and Thunderbird take the attachment on
 * their command line; the new Outlook, Windows Mail and webmail cannot, so the caller falls
 * back to the Share sheet. Returns whether a message was opened.
 */
export async function emailWithAttachment(path: string): Promise<boolean> {
  const app = await mailApp()
  if (app.kind === 'outlook') {
    execFile(app.exe, ['/a', path], { windowsHide: false }, () => undefined)
    return true
  }
  if (app.kind === 'thunderbird') {
    // A file URL escapes quotes and spaces, so an odd file name cannot break the argument.
    const url = pathToFileURL(path).href
    execFile(app.exe, ['-compose', `attachment='${url}'`], { windowsHide: false }, () => undefined)
    return true
  }
  return false
}

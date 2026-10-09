import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import { MAX_TRUSTED_HOSTS } from '@shared/links'
import { withoutRecent, withRecent, type RecentKind } from '@shared/recent'
import { writeStagedSync } from '../worker/staging'

/** Settings on disk: one JSON file in the user's application data folder. */

export const MAX_SIGNATURES = 8
export const SignatureSchema = z.object({
  id: z.string().min(1).max(64),
  data: z.string().min(8).max(4_000_000),
  width: z.number().int().min(1).max(10000),
  height: z.number().int().min(1).max(10000)
})

/** A folder the person linked (a cloud drive's folder, a network share, any folder). */
export const PlaceSchema = z.object({ path: z.string().min(1).max(4000), label: z.string().max(120) })

const SettingsSchema = z.object({
  language: z.enum(['en', 'ar']).catch('en'),
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  checkForUpdates: z.boolean().catch(true),
  recent: z.array(z.string()).catch([]),
  recentTab: z.enum(['pdf', 'image']).catch('pdf'),
  signatures: z.array(SignatureSchema).max(MAX_SIGNATURES).catch([]),
  digitalId: z.string().max(4000).optional().catch(undefined),
  workflows: z.array(z.object({ name: z.string().min(1).max(100), steps: z.array(z.any()).max(20), suffix: z.string().max(60) })).max(50).optional().catch(undefined),
  quickHidden: z.array(z.string().max(20)).max(20).catch([]),
  singleKeys: z.boolean().catch(false),
  saveMode: z.enum(['copy', 'replace']).catch('copy'),
  saveFolder: z.string().max(4000).catch(''),
  authorName: z.string().max(120).catch(''),
  places: z.array(PlaceSchema).max(30).catch([]),
  defaultZoom: z.enum(['width', 'page', '100']).catch('width'),
  spellCheck: z.boolean().catch(true),
  trustedLinkHosts: z.array(z.string().min(1).max(253)).max(MAX_TRUSTED_HOSTS).catch([])
})

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  // First run: Arabic for an Arabic-speaking system, otherwise English.
  // Smoke runs sign comments with a made-up name, so screenshots never show this PC's user.
  const author = process.env.POWERPDF_SMOKE ? 'Sam' : userInfo().username
  const language = app.getPreferredSystemLanguages().some((l) => l.toLowerCase().startsWith('ar')) ? 'ar' : 'en'
  return { language, theme: 'system', checkForUpdates: true, recent: [], recentTab: 'pdf', signatures: [], quickHidden: [], singleKeys: false, saveMode: 'copy', saveFolder: '', authorName: author, places: [], defaultZoom: 'width', spellCheck: true, trustedLinkHosts: [] }
}

let current: Settings | null = null

export function getSettings(): Settings {
  if (current) return current
  try {
    current = existsSync(file()) ? SettingsSchema.parse(JSON.parse(readFileSync(file(), 'utf8'))) : defaults()
  } catch {
    // A damaged settings file is replaced rather than preventing start-up.
    current = defaults()
  }
  return current
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = SettingsSchema.parse({ ...getSettings(), ...patch })
  // Through an exclusively created temporary file (§82): a planted file or link is never written through.
  writeStagedSync(file(), JSON.stringify(current, null, 2))
  return current
}

export function addRecent(path: string): Settings {
  // Each kind keeps its own newest twelve (Recent shows PDFs and pictures on separate tabs, §83).
  const recent = withRecent(getSettings().recent, path)
  app.addRecentDocument(path)
  return updateSettings({ recent })
}

export function forgetRecent(path?: string, kind?: RecentKind): Settings {
  const recent = withoutRecent(getSettings().recent, { path, kind })
  if (recent.length === 0) app.clearRecentDocuments()
  return updateSettings({ recent })
}

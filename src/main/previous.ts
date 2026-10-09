import { app } from 'electron'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PREVIOUS_NAMES } from '@shared/brand'

/**
 * The first start under a new name (decisions §49, §71). Settings live in a folder named after
 * the app (%APPDATA%\HonoKit), so the person's language, recent files, signatures, linked
 * places and templates, kept under an earlier name's folder (%APPDATA%\HonoPDF, then
 * %APPDATA%\PowerPDF), are copied across once. The old folder is left untouched; nothing happens once the new one
 * has its own settings.
 */
export function carryOverPreviousData(): void {
  try {
    const now = app.getPath('userData')
    if (existsSync(join(now, 'settings.json'))) return
    const before = PREVIOUS_NAMES.map((n) => join(app.getPath('appData'), n)).find((d) => existsSync(join(d, 'settings.json')))
    if (!before) return
    cpSync(join(before, 'settings.json'), join(now, 'settings.json'))
    const templates = join(before, 'templates')
    if (existsSync(templates) && !existsSync(join(now, 'templates'))) cpSync(templates, join(now, 'templates'), { recursive: true })
  } catch {
    // A failed copy only means starting with the default settings.
  }
}

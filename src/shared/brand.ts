/**
 * The product's name and where it lives, in one place.
 *
 * "HonoKit" (2026-10-02, decisions §71) replaced "HonoPDF" (炎 honō, "flame"; §49) once the app
 * took in the image tools (§69); "HonoPDF" had replaced the working title "PowerPDF" on
 * 2026-09-30. Nothing user-facing should spell the name anywhere else.
 * Renaming means editing this file, `package.json` (`name`, `productName`),
 * `electron-builder.yml` (`appId`, `productName`) and `APP_ID` below.
 *
 * The source is public in `sourceRepo`; issues and releases live there too, and installed copies
 * read its releases to update themselves (decisions §84, §85). Up to 0.18.0 installers went to the
 * shared HonoKit-Releases (§73); 0.19.0 was also put there so older copies move over.
 */
export const BRAND = {
  name: 'HonoKit',
  /** Where releases are published and read; equals `publish.repo` in electron-builder.yml (§85). */
  repo: 'abd-el-rahman-mustafa/HonoKit',
  releasesUrl: 'https://github.com/abd-el-rahman-mustafa/HonoKit/releases',
  /** The old shared releases repository (until 0.18.0, §73): still a project page. */
  oldReleasesRepo: 'abd-el-rahman-mustafa/HonoKit-Releases',
  /** The source code (decisions §84). */
  sourceRepo: 'abd-el-rahman-mustafa/HonoKit',
  sourceUrl: 'https://github.com/abd-el-rahman-mustafa/HonoKit',
  issuesUrl: 'https://github.com/abd-el-rahman-mustafa/HonoKit/issues',
  licence: 'AGPL-3.0-or-later',
  /**
   * The update check (decisions §73; off under §42). False: the app makes no connection at
   * all, and Settings has no Updates page.
   */
  online: true
} as const

/**
 * Whether `url` is one of the project's own pages on GitHub: the source repository or the
 * releases repository, and nothing else (not another repository whose name merely starts the
 * same, not another host). The only addresses the app itself opens in the browser.
 */
export function isProjectUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return false
  const path = u.pathname.toLowerCase()
  return [BRAND.sourceRepo, BRAND.repo, BRAND.oldReleasesRepo].some((repo) => {
    const base = `/${repo.toLowerCase()}`
    return path === base || path.startsWith(`${base}/`)
  })
}

/**
 * The computer's system for a problem report, from Electron's `process.getSystemVersion()`
 * (Windows: "10.0.26100"; Windows 11 is build 22000 and later).
 */
export function systemLabel(platform: string, version: string): string {
  if (platform === 'win32') {
    const build = Number(version.split('.')[2])
    const name = version.startsWith('10.') && build >= 22000 ? 'Windows 11' : version.startsWith('10.') ? 'Windows 10' : 'Windows'
    return `${name} (${version})`
  }
  if (platform === 'darwin') return `macOS ${version}`
  if (platform === 'linux') return `Linux ${version}`
  return `${platform} ${version}`.trim()
}

/**
 * "Report a problem" (decisions §84): a new issue on the source repository with the bug form,
 * its version, system and language fields filled in. Only opened in the browser when the
 * person clicks; the app sends nothing itself.
 */
export function problemReportUrl(facts: { version: string; system: string; language: 'en' | 'ar' }): string {
  const fields: Array<[string, string]> = [
    ['template', 'bug_report.yml'],
    ['version', facts.version],
    ['os', facts.system],
    ['language', facts.language === 'ar' ? 'Arabic' : 'English']
  ]
  return `${BRAND.issuesUrl}/new?${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
}

/** Windows' identity for the app (taskbar grouping, jump list); equals `appId` in electron-builder.yml. */
export const APP_ID = 'com.aamus.honokit'

/** Earlier names' settings folders, newest first: the first found is carried over once (§49, §71). */
export const PREVIOUS_NAMES = ['HonoPDF', 'PowerPDF'] as const

/**
 * The private entry markups keep in PDF files to be drawn again (engine/drawnMarkup.ts). Part of
 * the file format, not the product name: it stays "HonoPDF" whatever the app is called, and the
 * working title's "PowerPDF" entry is still read.
 */
export const MARKUP_KEY = 'HonoPDF'
export const OLD_MARKUP_KEYS = ['PowerPDF'] as const

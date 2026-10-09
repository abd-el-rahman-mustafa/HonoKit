import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/ipc'

/**
 * Updates from the repository's GitHub Releases (docs/release-and-updates.md).
 *
 * Nothing is downloaded without a click, and a downloaded update installs on the
 * next quit or when the person chooses "Restart now". Only Windows (NSIS) and the
 * Linux AppImage can install themselves; a Mac needs a signing certificate for that,
 * so there, and for a .deb or a portable .exe, the person is told and offered the
 * Releases page.
 */

const { autoUpdater } = electronUpdater
const EVERY = 6 * 60 * 60 * 1000

function canInstall(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

export class Updater {
  private state: UpdateState = { state: 'idle' }
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly publish: (s: UpdateState) => void) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version, canInstall: canInstall() }))
    autoUpdater.on('update-not-available', (info) => this.set({ state: 'none', version: info.version }))
    autoUpdater.on('download-progress', (p) => {
      if (this.state.state === 'downloading' || this.state.state === 'available') this.set({ state: 'downloading', percent: Math.round(p.percent), version: 'version' in this.state ? this.state.version : '' })
    })
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (error) => this.set({ state: 'error', message: error?.message ?? String(error) }))
  }

  current(): UpdateState {
    return this.state
  }

  private set(s: UpdateState): void {
    this.state = s
    this.publish(s)
  }

  /** Starts or stops the automatic checks. */
  schedule(enabled: boolean): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!enabled || !app.isPackaged) {
      this.set(app.isPackaged ? { state: 'disabled' } : { state: 'idle' })
      return
    }
    setTimeout(() => void this.check(), 15_000)
    this.timer = setInterval(() => void this.check(), EVERY)
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.set({ state: 'error', message: 'Updates are checked only in an installed copy.' })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({ state: 'error', message: (error as Error).message })
    }
  }

  async download(): Promise<void> {
    if (!canInstall()) return
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.set({ state: 'error', message: (error as Error).message })
    }
  }

  install(): void {
    if (this.state.state === 'ready') autoUpdater.quitAndInstall(false, true)
  }
}

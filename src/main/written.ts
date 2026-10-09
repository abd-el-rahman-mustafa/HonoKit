import { statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The image tools' results written while the app runs (decisions §77). "Try again" may replace
 * one of them — and only them: a path the window names is honoured only when this session wrote
 * it and the file has not changed since (same size, same modification time). Anything else — a
 * person's own file, a result edited in another app meanwhile — is never touched.
 */
export class WrittenFiles {
  private readonly files = new Map<string, { size: number; mtime: number }>()

  private static key(path: string): string {
    return resolve(path).toLowerCase()
  }

  /** Records a result just written. */
  remember(path: string): void {
    try {
      const s = statSync(path)
      this.files.set(WrittenFiles.key(path), { size: s.size, mtime: s.mtimeMs })
    } catch {
      /* not there: nothing to remember */
    }
  }

  forget(path: string): void {
    this.files.delete(WrittenFiles.key(path))
  }

  /** The path itself when it may be replaced, else null. */
  replaceable(path: string | null | undefined): string | null {
    if (!path) return null
    const known = this.files.get(WrittenFiles.key(path))
    if (!known) return null
    try {
      const s = statSync(path)
      return s.size === known.size && s.mtimeMs === known.mtime ? path : null
    } catch {
      return null
    }
  }
}

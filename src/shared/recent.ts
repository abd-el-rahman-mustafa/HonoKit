import { fileKind } from './opening'

/**
 * Home › Recent in two tabs, PDFs and Images (decisions §83, as Android's §53). One list in the
 * settings file, newest first; each kind keeps its own last `RECENT_PER_KIND` files, so opening
 * many pictures never pushes the PDFs out of Recent.
 */

export type RecentKind = 'pdf' | 'image'

export const RECENT_PER_KIND = 12

/** Which tab a recent file belongs to (anything that is not a picture counts as a PDF). */
export function recentKind(path: string): RecentKind {
  return fileKind(path) === 'image' ? 'image' : 'pdf'
}

/** The recent files of one kind, newest first. */
export function recentOfKind(list: readonly string[], kind: RecentKind): string[] {
  return list.filter((p) => recentKind(p) === kind)
}

/** The list with `path` first (once), each kind cut to its newest `max`. */
export function withRecent(list: readonly string[], path: string, max = RECENT_PER_KIND): string[] {
  const counts: Record<RecentKind, number> = { pdf: 0, image: 0 }
  return [path, ...list.filter((p) => p !== path)].filter((p) => ++counts[recentKind(p)] <= max)
}

/** The list without one file, without one kind (Clear on a tab), or empty. */
export function withoutRecent(list: readonly string[], forget: { path?: string; kind?: RecentKind }): string[] {
  if (forget.path) return list.filter((p) => p !== forget.path)
  if (forget.kind) return list.filter((p) => recentKind(p) !== forget.kind)
  return []
}

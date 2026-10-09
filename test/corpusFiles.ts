import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Real PDFs for the corpus tests: whatever is in `corpus/` (git-ignored; never committed). None
 * there, as on CI, and those tests are skipped. Files to leave out are named, one per line, in
 * `corpus/exclude.txt` (lines starting with # are comments) or in the POWERPDF_CORPUS_EXCLUDE
 * environment variable (names separated by ; or |). Matching ignores case.
 */
export const CORPUS_DIR = 'corpus'

export function corpusExcluded(): Set<string> {
  const names: string[] = (process.env.POWERPDF_CORPUS_EXCLUDE ?? '').split(/[;|]/)
  const list = resolve(CORPUS_DIR, 'exclude.txt')
  if (existsSync(list)) names.push(...readFileSync(list, 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')))
  return new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))
}

/** The corpus PDFs' file names, excluded ones left out. */
export function corpusPdfNames(): string[] {
  if (!existsSync(CORPUS_DIR)) return []
  const excluded = corpusExcluded()
  return readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf') && !excluded.has(f.toLowerCase()))
}

/** The corpus PDFs' full paths. */
export function corpusPdfPaths(): string[] {
  return corpusPdfNames().map((f) => resolve(CORPUS_DIR, f))
}

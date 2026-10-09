import type { StyleRun } from '../paragraphs'

/**
 * Which installed fonts the Office file names (research §5.2): the PDF's own family when it
 * is one Windows and Office have, otherwise one of the same kind. The Latin family goes in
 * w:ascii / w:hAnsi and the Arabic one in w:cs, so each script takes its own font.
 * Extend the lists from real files.
 */

const LATIN: Record<string, string> = {
  arial: 'Arial',
  helvetica: 'Arial',
  timesnewroman: 'Times New Roman',
  times: 'Times New Roman',
  calibri: 'Calibri',
  cambria: 'Cambria',
  tahoma: 'Tahoma',
  segoeui: 'Segoe UI',
  verdana: 'Verdana',
  georgia: 'Georgia',
  garamond: 'Garamond',
  couriernew: 'Courier New',
  courier: 'Courier New',
  consolas: 'Consolas',
  trebuchetms: 'Trebuchet MS',
  century: 'Century',
  bookantiqua: 'Book Antiqua',
  palatinolinotype: 'Palatino Linotype'
}

const ARABIC: Record<string, string> = {
  arial: 'Arial',
  tahoma: 'Tahoma',
  segoeui: 'Segoe UI',
  simplifiedarabic: 'Simplified Arabic',
  traditionalarabic: 'Traditional Arabic',
  sakkalmajalla: 'Sakkal Majalla',
  dubai: 'Dubai',
  notonaskharabic: 'Noto Naskh Arabic',
  notosansarabic: 'Noto Sans Arabic',
  amiri: 'Amiri',
  ibmplexsansarabic: 'IBM Plex Sans Arabic',
  arabictypesetting: 'Arabic Typesetting',
  andalus: 'Andalus',
  aldhabi: 'Aldhabi',
  timesnewroman: 'Times New Roman'
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '')

export function fontsFor(r: Pick<StyleRun, 'family' | 'kind'>): { latin: string; arabic: string } {
  const key = compact(r.family)
  const known = (table: Record<string, string>): string | undefined => table[key] ?? Object.entries(table).find(([k]) => key.startsWith(k))?.[1]
  const latin = known(LATIN) ?? (r.kind === 'serif' ? 'Times New Roman' : r.kind === 'mono' ? 'Courier New' : 'Arial')
  // Naskh-like Arabic (serif) reads best in Simplified Arabic; everything else in Arial, which every Windows has.
  const arabic = known(ARABIC) ?? (r.kind === 'serif' ? 'Simplified Arabic' : 'Arial')
  return { latin, arabic }
}

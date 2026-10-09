import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PdfError } from './errors'

/**
 * The fonts installed on this PC, for edited and added text (docs/decisions.md §40).
 *
 * Windows lists every installed font in the registry — for all users (HKLM) and for the
 * person alone (HKCU) — as "Family Style (TrueType)" = file. Reading that is instant, unlike
 * opening every file in the Fonts folder. Collections (.ttc) and bitmap fonts are left out:
 * pdf-lib embeds single TrueType/OpenType files. A font whose licence forbids embedding
 * (OS/2 fsType "restricted") is refused when used.
 */

export interface SystemFontFamily {
  family: string
  /** Files by style: regular, bold, italic, bolditalic. */
  files: Partial<Record<'regular' | 'bold' | 'italic' | 'bolditalic', string>>
}

let cache: Map<string, SystemFontFamily> | null = null

function registry(key: string): Array<[string, string]> {
  try {
    const out = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return out
      .split(/\r?\n/)
      .map((l) => /^\s{4}(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!.trim()])
  } catch {
    return []
  }
}

const STYLE = /\s+(Bold Italic|Bold Oblique|Italic|Oblique|Bold|Regular)$/i

export function systemFonts(): Map<string, SystemFontFamily> {
  if (cache) return cache
  const map = new Map<string, SystemFontFamily>()
  if (process.platform !== 'win32') return (cache = map)
  const fontsDir = join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts')
  const entries = [
    ...registry('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
    ...registry('HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')
  ]
  for (const [name, value] of entries) {
    if (!/\((TrueType|OpenType)\)$/i.test(name)) continue
    const file = /^[a-z]:\\/i.test(value) ? value : join(fontsDir, value)
    if (!/\.(ttf|otf)$/i.test(file)) continue // collections and bitmap fonts: not embeddable here
    const bare = name.replace(/\s*\((TrueType|OpenType)\)$/i, '').trim()
    // "Arial & Arial Bold" style names list several faces in one entry; take the first.
    const first = bare.split(' & ')[0]!.trim()
    const m = STYLE.exec(first)
    const family = (m ? first.slice(0, m.index) : first).trim()
    const style = (m?.[1] ?? 'Regular').toLowerCase().replace('oblique', 'italic').replace(' ', '') as keyof SystemFontFamily['files']
    if (!family) continue
    const entry = map.get(family) ?? { family, files: {} }
    if (!entry.files[style]) entry.files[style] = file
    map.set(family, entry)
  }
  // Families with no regular face (only a bold one) keep what they have.
  cache = map
  return map
}

/** The families, sorted, for the interface's font list. */
export function systemFontFamilies(): string[] {
  return [...systemFonts().values()]
    .filter((f) => Object.values(f.files).some((p) => p && existsSync(p)))
    .map((f) => f.family)
    .sort((a, b) => a.localeCompare(b))
}

const bytesCache = new Map<string, Uint8Array>()

/**
 * The file bytes for a family in a style: the exact style if installed, otherwise the nearest
 * (bold italic → bold → italic → regular). Refused if the font forbids embedding.
 */
export function systemFontBytes(family: string, bold: boolean, italic: boolean): { bytes: Uint8Array; exact: boolean } {
  const f = systemFonts().get(family)
  if (!f) throw new PdfError('unsupported', `The font “${family}” is not installed on this computer.`)
  const wanted = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'regular'
  const order: Array<keyof SystemFontFamily['files']> = [wanted, bold ? 'bold' : 'regular', italic ? 'italic' : 'regular', 'regular', 'bold', 'italic', 'bolditalic']
  const key = order.find((k) => f.files[k] && existsSync(f.files[k]!))
  if (!key) throw new PdfError('unsupported', `The font “${family}” could not be found.`)
  const path = f.files[key]!
  let bytes = bytesCache.get(path)
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(path))
    const font = fontkit.create(bytes as unknown as Buffer) as unknown as { 'OS/2'?: { fsType?: number } }
    // fsType bit 1 (value 2): "Restricted License embedding" — the font may not be put in documents.
    const fsType = font['OS/2']?.fsType ?? 0
    if ((fsType & 0x000f) === 0x0002) throw new PdfError('unsupported', `The licence of “${family}” does not allow putting it in documents. Choose another font.`)
    bytesCache.set(path, bytes)
  }
  return { bytes, exact: key === wanted }
}

import { mupdf } from '../mupdf'
import type { StyleRun } from '../paragraphs'
import { fontsFor } from './fonts'

/**
 * How wide a line comes out in the font Office will use, so writers that keep the PDF's lines
 * (PowerPoint, Word "keep the look") can set the letter spacing that makes it as wide as printed.
 * The PDF's own font is rarely installed; its stand-in is usually wider (Source Sans as Arial
 * ran 10 % wider and pushed lines into the next column). MuPDF's built-in fonts have the metrics
 * of Arial (Helvetica), Times New Roman (Times) and Courier New (Courier); other stand-ins and
 * Arabic text (shaped by Office) are not measured, and keep the PDF's spacing.
 */

const BUILT_IN: Record<string, [string, string, string, string]> = {
  Arial: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  'Times New Roman': ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  'Courier New': ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
}
const loaded = new Map<string, mupdf.Font>()
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

function fontFor(latin: string, bold: boolean, italic: boolean): mupdf.Font | null {
  const names = BUILT_IN[latin]
  if (!names) return null
  const name = names[(bold ? 1 : 0) + (italic ? 2 : 0)]!
  let font = loaded.get(name)
  if (!font) {
    try {
      font = new mupdf.Font(name)
    } catch {
      return null
    }
    loaded.set(name, font)
  }
  return font
}

/** Width in points of the runs in Office's font, or null when it cannot be known. */
export function officeWidth(runs: StyleRun[]): number | null {
  let width = 0
  for (const r of runs) {
    if (RTL.test(r.text)) return null
    const font = fontFor(fontsFor(r).latin, r.bold, r.italic)
    if (!font) return null
    for (const c of r.text) {
      // Direction marks and embeddings take no room.
      if (/\p{Cf}/u.test(c)) continue
      const gid = font.encodeCharacter(c.codePointAt(0)!)
      // A letter the font lacks: Office takes it from another font; its width is a guess.
      width += (gid > 0 ? font.advanceGlyph(gid, 0) : 0.55) * r.size
    }
  }
  return width
}

/**
 * The letter spacing (points, added after each letter) that makes `runs` as wide as `printed`.
 * Within limits: letters never squeezed into each other nor spread like a heading.
 */
export function spacingToFit(runs: StyleRun[], printed: number): number {
  const width = officeWidth(runs)
  const letters = runs.reduce((n, r) => n + [...r.text].length, 0)
  if (width === null || letters < 2) return runs[0]?.tracking ?? 0
  const size = Math.max(...runs.map((r) => r.size))
  const spacing = (printed - width) / letters
  if (Math.abs(spacing) < size * 0.004) return 0
  return Math.max(-size * 0.08, Math.min(size * 0.5, spacing))
}

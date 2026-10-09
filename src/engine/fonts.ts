import { existsSync, readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'
import { join, resolve } from 'node:path'

/**
 * Where the bundled fonts live, and loading them.
 *
 * IBM Plex Sans Arabic and Noto Sans, under the SIL Open Font License
 * (resources/fonts/OFL-IBMPlexSansArabic.txt, OFL-Noto.txt). They are bundled because a PDF stamp must carry
 * its own font, and because system fonts (Arial, Tahoma) may not be redistributed.
 */

export type FontFace = 'arabic' | 'arabic-bold' | 'latin' | 'latin-bold'

const FILES: Record<FontFace, string> = {
  arabic: 'IBMPlexSansArabic-Regular.ttf',
  'arabic-bold': 'IBMPlexSansArabic-Bold.ttf',
  latin: 'NotoSans-Regular.ttf',
  'latin-bold': 'NotoSans-Bold.ttf'
}

let directory: string | null = null

/** The application sets this at start-up; tests fall back to the repository's own folder. */
export function setFontDirectory(dir: string): void {
  directory = dir
}

function fontDirectory(): string {
  if (directory) return directory
  const candidates = [process.env.POWERPDF_RESOURCES && join(process.env.POWERPDF_RESOURCES, 'fonts'), resolve(process.cwd(), 'resources', 'fonts')].filter(Boolean) as string[]
  const found = candidates.find((d) => existsSync(join(d, FILES.latin)))
  if (!found) throw new Error(`Bundled fonts not found (looked in ${candidates.join(', ')})`)
  directory = found
  return found
}

const cache = new Map<FontFace, Uint8Array>()

export function fontBytes(face: FontFace): Uint8Array {
  let bytes = cache.get(face)
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(join(fontDirectory(), FILES[face])))
    cache.set(face, bytes)
  }
  return bytes
}

/**
 * Embeds a bundled face as a subset, ready to draw shaped text.
 *
 * Why IBM Plex Sans Arabic: fifteen open-licence Arabic fonts were scored on
 * whether a pdf-lib subset (a) draws visibly through MuPDF and (b) reads back as
 * the text that was typed (spikes/fontscore.mjs, docs/spikes.md S4). Noto Naskh
 * built dotted letters from dot glyphs with no Unicode value (86% read-back);
 * Amiri's subset drew nothing; Plex drew cleanly and read back 100%, in regular
 * and bold. Do not swap the face without re-running that script and the pixel
 * tests in test/stamp.test.ts.
 */
export async function embedFace(pdf: PDFDocument, face: FontFace): Promise<PDFFont> {
  pdf.registerFontkit(fontkit)
  return pdf.embedFont(fontBytes(face), { subset: true })
}

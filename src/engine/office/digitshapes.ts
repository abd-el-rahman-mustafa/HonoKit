import { fontBytes } from '../fonts'
import { free, mupdf, type PdfDoc } from '../mupdf'

/**
 * Fonts that draw Arabic-Indic digit codes (٠–٩, ۰–۹) as Western digits (0–9).
 *
 * Gulf newspapers set their numbers this way: the text says "٢٠٢٦", the page shows "2026". Office
 * draws the codes in its own font, so a converted page showed Arabic-Indic digits where the paper
 * printed Western ones. Each such digit's glyph is drawn alone and compared, cell by cell, with the
 * same digit drawn Western and Arabic-Indic in reference fonts (Helvetica, Times, Noto Sans and IBM
 * Plex Sans Arabic). A font is listed when most of its decisive digits look Western. 1 is never
 * decisive (a stroke either way), and a digit must look clearly Western, not just less Arabic-Indic.
 *
 * Measured on 13 installed Arabic fonts (none listed, their Arabic-Indic digits never pass) and on a
 * newspaper's five Arabic families (all listed). The reverse — Western codes drawn as Arabic-Indic
 * digits — is not detected: Arabic-Indic shapes vary too much between fonts to recognise reliably.
 */

const GRID = 24
type Shape = Uint8Array

/** The glyph drawn alone, its ink bounding box scaled into a GRID × GRID square (centred). */
function shapeOf(font: mupdf.Font, gid: number, unicode: number): Shape | null {
  const text = new mupdf.Text()
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 200, 200], false)
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
  try {
    text.showGlyph(font, [100, 0, 0, -100, 50, 150], gid, unicode)
    pixmap.clear(255)
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1)
    device.close()
    const px = pixmap.getPixels()
    const w = pixmap.getWidth()
    const h = pixmap.getHeight()
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (px[y * w + x]! < 128) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    if (x1 < 0) return null
    const grid = new Uint8Array(GRID * GRID)
    const side = Math.max(x1 - x0 + 1, y1 - y0 + 1)
    const ox = x0 - (side - (x1 - x0 + 1)) / 2
    const oy = y0 - (side - (y1 - y0 + 1)) / 2
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (px[y * w + x]! < 128) grid[Math.min(GRID - 1, Math.floor(((y - oy) / side) * GRID)) * GRID + Math.min(GRID - 1, Math.floor(((x - ox) / side) * GRID))] = 1
    return grid
  } catch {
    return null
  } finally {
    free(device, pixmap, text)
  }
}

/** Shared cells over cells inked in either. */
function overlap(a: Shape, b: Shape): number {
  let both = 0
  let either = 0
  for (let i = 0; i < a.length; i++) {
    both += a[i]! & b[i]!
    either += a[i]! | b[i]!
  }
  return either ? both / either : 0
}

interface References {
  western: Shape[][]
  indic: Shape[][]
  comma: Shape[]
  period: Shape[]
}

let references: References | null = null

function referenceShapes(): References {
  if (references) return references
  const fonts: mupdf.Font[] = [new mupdf.Font('Helvetica'), new mupdf.Font('Times-Roman')]
  for (const face of ['arabic', 'arabic-bold', 'latin', 'latin-bold'] as const) {
    try {
      fonts.push(new mupdf.Font(face, fontBytes(face)))
    } catch {
      /* bundled fonts missing: the built-in ones still give Western shapes */
    }
  }
  const draw = (code: number): Shape[] =>
    fonts.flatMap((f) => {
      const gid = f.encodeCharacter(code)
      const s = gid > 0 ? shapeOf(f, gid, code) : null
      return s ? [s] : []
    })
  references = {
    western: Array.from({ length: 10 }, (_, d) => draw(0x30 + d)),
    indic: Array.from({ length: 10 }, (_, d) => draw(0x660 + d)),
    comma: draw(0x2c),
    period: draw(0x2e)
  }
  return references
}

/** How a font's Arabic-Indic codes are written when it draws them as Western digits: digits, and its decimal and thousands marks. */
export type WesternDigits = Map<string, { decimal: string; thousands: string }>

const DECIMAL = 0x66b
const THOUSANDS = 0x66c

const indicValue = (unicode: number): number => (unicode >= 0x660 && unicode <= 0x669 ? unicode - 0x660 : unicode >= 0x6f0 && unicode <= 0x6f9 ? unicode - 0x6f0 : -1)

/** Whether a page's text has Arabic-Indic digits at all (the check is skipped otherwise). */
export const hasIndicDigits = (text: string): boolean => /[٠-٩۰-۹]/.test(text)

/**
 * The fonts on these pages (names as MuPDF gives them, subset tag included) that draw Arabic-Indic
 * digit codes as Western digits, each with the Western marks its Arabic decimal and thousands marks
 * look like. Written as Western digits, the Arabic marks would split a number: Office joins them only
 * with Arabic-Indic digits, and showed "1٫2" as "2٫1".
 */
export function westernDrawnFonts(doc: PdfDoc, pages: number[]): WesternDigits {
  const refs = referenceShapes()
  const votes = new Map<string, { western: number; other: number; seen: Set<number>; marks: Map<number, Shape> }>()
  for (const index of pages) {
    const page = doc.loadPage(index)
    const device = new mupdf.Device({
      fillText(text: mupdf.Text) {
        text.walk({
          showGlyph(font: mupdf.Font, _trm: mupdf.Matrix, gid: number, unicode: number) {
            const d = indicValue(unicode)
            const mark = unicode === DECIMAL || unicode === THOUSANDS
            if (!mark && (d < 0 || d === 1)) return
            const name = font.getName()
            const v = votes.get(name) ?? { western: 0, other: 0, seen: new Set<number>(), marks: new Map<number, Shape>() }
            votes.set(name, v)
            if (mark) {
              if (!v.marks.has(unicode)) {
                const shape = shapeOf(font, gid, unicode)
                if (shape) v.marks.set(unicode, shape)
              }
              return
            }
            if (v.seen.has(gid) || v.seen.size >= 12) return
            v.seen.add(gid)
            const shape = shapeOf(font, gid, unicode)
            if (!shape) return
            const western = Math.max(0, ...refs.western[d]!.map((r) => overlap(shape, r)))
            const indic = Math.max(0, ...refs.indic[d]!.map((r) => overlap(shape, r)))
            if (western >= 0.6 && western - indic >= 0.2) v.western++
            else v.other++
          }
        })
      }
    })
    try {
      page.run(device, mupdf.Matrix.identity)
    } catch {
      /* a page that fails to draw keeps its digits as coded */
    } finally {
      try {
        device.close()
      } catch {
        /* closed */
      }
      free(device, page)
    }
  }
  // A mark drawn like a full stop is one; anything else (a comma, the Arabic mark's own slanted stroke) is a comma.
  const markOf = (shape: Shape | undefined, fallback: string): string => {
    if (!shape) return fallback
    const comma = Math.max(0, ...refs.comma.map((r) => overlap(shape, r)))
    const period = Math.max(0, ...refs.period.map((r) => overlap(shape, r)))
    return period > comma ? '.' : ','
  }
  const out: WesternDigits = new Map()
  for (const [name, v] of votes)
    if (v.western > 0 && v.western >= 2 * v.other) out.set(name, { decimal: markOf(v.marks.get(DECIMAL), ','), thousands: markOf(v.marks.get(THOUSANDS), ',') })
  return out
}

/** Arabic-Indic digits written as the Western digits a font draws them as, its decimal and thousands marks between them too. */
export function asWestern(text: string, marks: { decimal: string; thousands: string }): string {
  const t = text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  return t.replace(/(?<=[0-9])[٫٬](?=[0-9])/g, (m) => (m === '٫' ? marks.decimal : marks.thousands))
}

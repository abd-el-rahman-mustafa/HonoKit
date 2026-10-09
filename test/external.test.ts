import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { describe, expect, it } from 'vitest'
import { documentFonts } from '@engine/docfonts'
import { styledLines } from '@engine/paragraphs'
import { browserFont } from '@engine/webfont'
import { pageParagraphs, replaceText } from '@engine/edit'
import { free, mupdf, openPdf, type PdfDoc } from '@engine/mupdf'
import { foldString } from '@engine/text'

/**
 * A strict probe over PDFs the owner names for a run (they stay where they are; nothing is
 * copied into the repo):
 *   POWERPDF_TEST_PDFS="a.pdf;b.pdf" POWERPDF_TEST_OUT=folder npx vitest run test/external.test.ts
 * For each chosen paragraph:
 *  - retyped unchanged, every letter comes back (none lost, none added);
 *  - with one word changed, every other word comes back, in order;
 * and a ligature audit flags letters drawn much wider than the same letter elsewhere in the same
 * font (a hidden "ft" read as "t"). Findings go to report.json with before/after pictures.
 */
const files = (process.env.POWERPDF_TEST_PDFS ?? '').split(';').map((f) => f.trim()).filter(Boolean)
const OUT = process.env.POWERPDF_TEST_OUT ?? 'smoke-out/external'
const PAGES = Number(process.env.POWERPDF_TEST_PAGES ?? 2)
const PER_PAGE = Number(process.env.POWERPDF_TEST_PARAS ?? 14)

type Box = [number, number, number, number]

/** Renders the box to a picture; returns its ink: pixels clearly unlike the most common colour. */
function crop(doc: PdfDoc, page: number, box: Box, file: string): number {
  const s = 2
  const pad = 6
  const bbox: Box = [Math.floor((box[0] - pad) * s), Math.floor((box[1] - pad) * s), Math.ceil((box[2] + pad) * s), Math.ceil((box[3] + pad) * s)]
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false)
  pix.clear(255)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix)
  const loaded = doc.loadPage(page)
  loaded.run(dev, mupdf.Matrix.identity)
  dev.close()
  dev.destroy()
  loaded.destroy()
  writeFileSync(file, pix.asPNG())
  const px = pix.getPixels()
  const counts = new Map<number, number>()
  for (let i = 0; i < px.length; i += 3) {
    const key = ((px[i]! >> 4) << 8) | ((px[i + 1]! >> 4) << 4) | (px[i + 2]! >> 4)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const bg = [...counts].sort((a, b) => b[1] - a[1])[0]![0]
  const [br, bgc, bb] = [((bg >> 8) & 15) * 16 + 8, ((bg >> 4) & 15) * 16 + 8, (bg & 15) * 16 + 8]
  let ink = 0
  for (let i = 0; i < px.length; i += 3) if (Math.abs(px[i]! - br) + Math.abs(px[i + 1]! - bgc) + Math.abs(px[i + 2]! - bb) > 150) ink++
  pix.destroy()
  return ink
}

// Mirrored pairs count as one: some Arabic producers store the glyph, not the letter (» for «).
const letters = (s: string): string[] => [...foldString(s).replace(/[\sـ­​-‏⁠﻿]+/g, '').replace(/[«»]/g, '«').replace(/[(){}]/g, '(')]
/** Letters of `before` missing from `after`, and letters of `after` not in `before`. */
function diff(before: string, after: string): { lost: string; added: string } {
  const count = (xs: string[]): Map<string, number> => xs.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())
  const a = count(letters(before))
  const b = count(letters(after))
  const minus = (x: Map<string, number>, y: Map<string, number>): string => [...x].flatMap(([c, n]) => Array<string>(Math.max(0, n - (y.get(c) ?? 0))).fill(c)).join('')
  return { lost: minus(a, b), added: minus(b, a) }
}
const minusLetters = (x: string, y: string): string => {
  const have = [...y].reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())
  return [...x].filter((c) => { const n = have.get(c) ?? 0; if (n > 0) { have.set(c, n - 1); return false } return true }).join('')
}
const words = (s: string): string[] => foldString(s).replace(/ـ/g, '').split(/\s+/).filter(Boolean)

/** Everything the editor reads on a page. */
const pageText = (doc: PdfDoc, page: number): string => pageParagraphs(doc, page).map((q) => q.text).join(' ')

/** The text of the paragraphs now covering a paragraph's old place. */
function textAt(doc: PdfDoc, page: number, box: Box): string {
  const inside = (q: { box: Box }): boolean => q.box[0] < box[2] - 1 && q.box[2] > box[0] + 1 && q.box[1] < box[3] - 1 && q.box[3] > box[1] + 1
  return pageParagraphs(doc, page).filter(inside).map((q) => q.text).join(' ')
}

/** Letters drawn much wider than the same letter in the same font on the page: likely ligatures read as one letter. */
function ligatureAudit(doc: PdfDoc, page: number): string[] {
  const seen = new Map<string, Array<{ w: number; at: string }>>()
  let line: Array<{ c: string; font: string; w: number }> = []
  const lines: Array<typeof line> = []
  doc.loadPage(page).toStructuredText('preserve-ligatures').walk({
    beginLine() { line = [] },
    onChar(c: string, _o: unknown, font: { getName(): string }, size: number, quad: number[]) {
      line.push({ c, font: font.getName(), w: (quad[2]! - quad[0]!) / Math.max(1, size) })
    },
    endLine() { lines.push(line) }
  })
  for (const l of lines) {
    const text = l.map((x) => x.c).join('')
    l.forEach((x, i) => {
      if (!/[A-Za-z]/.test(x.c)) return
      if (l[i + 1] && l[i + 1]!.w < 0.05) return
      const key = `${x.font}|${x.c}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push({ w: x.w, at: text.slice(Math.max(0, i - 8), i + 8) })
    })
  }
  const flagged: string[] = []
  for (const [key, all] of seen) {
    if (all.length < 4) continue
    const median = [...all].map((a) => a.w).sort((a, b) => a - b)[Math.floor(all.length / 2)]!
    for (const a of all) if (median > 0 && a.w > median * 1.6 && a.w - median > 0.15) flagged.push(`${key} ×${(a.w / median).toFixed(1)} in "${a.at}"`)
  }
  return flagged
}

describe.skipIf(files.length === 0)('PDFs named for this run', () => {
  const report: unknown[] = []
  for (const path of files) {
    it(basename(path), async () => {
      const bytes = new Uint8Array(readFileSync(path))
      const dir = join(OUT, basename(path, '.pdf'))
      mkdirSync(dir, { recursive: true })
      const doc = openPdf(bytes)
      const entry: Record<string, unknown> = { file: path, pages: doc.countPages(), edits: [] as unknown[], ligatures: [] as string[] }
      try {
        entry.fonts = documentFonts(doc).map((f) => `${f.name} [${f.installed ? 'installed' : f.reusable ? (f.subset ? 'embedded-subset' : 'embedded') : f.embedded ? 'embedded-unusable' : 'not-embedded'}]`)
        for (let page = 0; page < Math.min(PAGES, doc.countPages()); page++) {
          ;(entry.ligatures as string[]).push(...ligatureAudit(doc, page).map((s) => `p${page + 1} ${s}`))
          const paras = pageParagraphs(doc, page).filter((p) => p.text.trim().length >= 3)
          // The masthead lines the owner saw break, then an even spread over the page.
          const special = paras.filter((p) => /gulf|www\.|@/i.test(p.text))
          const step = Math.max(1, Math.floor(paras.length / PER_PAGE))
          const chosen = [...new Set([...special, ...paras.filter((_, i) => i % step === 0)])].slice(0, PER_PAGE + special.length)
          const before = pageText(doc, page)
          for (const [i, p] of chosen.entries()) {
            const tag = `p${page + 1}-${String(i).padStart(2, '0')}`
            const row: Record<string, unknown> = { tag, page: page + 1, text: p.text.slice(0, 90), font: p.font, status: p.fontStatus, size: Math.round(p.size * 10) / 10, rtl: p.rtl }
            const started = performance.now()
            try {
              const inkBefore = crop(doc, page, p.box, join(dir, `${tag}-a.png`))
              // 1. Retyped unchanged.
              const same = await replaceText(bytes, page, p.lines[0]!, p.text)
              row.ms = Math.round(performance.now() - started)
              row.kept = same.font?.kept
              row.dropped = same.dropped
              const after = openPdf(same.bytes)
              try {
                const text = textAt(after, page, p.box)
                // The whole page must read exactly as before: nothing lost anywhere, nothing added.
                const d = diff(before, pageText(after, page))
                row.lost = d.lost
                row.added = d.added
                if (d.lost || d.added) row.after = text.slice(0, 90)
                crop(after, page, p.box, join(dir, `${tag}-b.png`))
              } finally {
                free(after)
              }
              // 2. One word in the middle changed: every other word survives, in order.
              const ws = p.text.split(/(\s+)/)
              const idx = ws.findIndex((w, k) => k >= Math.floor(ws.length / 2) && /\S{2,}/.test(w))
              if (idx >= 0) {
                const marker = p.rtl ? 'تعديل' : 'EDITED'
                const changed = ws.map((w, k) => (k === idx ? marker : w)).join('')
                const one = await replaceText(bytes, page, p.lines[0]!, changed)
                const after2 = openPdf(one.bytes)
                try {
                  const got = words(textAt(after2, page, p.box))
                  const want = words(changed)
                  // The page lost exactly the old word and gained exactly the new one.
                  const d = diff(before, pageText(after2, page))
                  const old = letters(ws[idx]!).join('')
                  const neu = letters(marker).join('')
                  const lost = minusLetters(d.lost, old)
                  const added = minusLetters(d.added, neu)
                  row.oneWord = lost || added ? { lost, added, got: got.join(' ').slice(0, 90) } : 'ok'
                  // Read back in order (left-to-right text): words drawn out of order break search and copy.
                  if (!p.rtl) {
                    const k = want.indexOf(words(marker)[0]!)
                    const j = got.indexOf(words(marker)[0]!)
                    const before = k > 0 ? want[k - 1] : undefined
                    const after = want[k + 1]
                    const ok = j >= 0 && (before === undefined || got[j - 1] === before) && (got[j + 1] === undefined || after === undefined || got[j + 1] === after)
                    if (!ok) row.order = got.join(' ').slice(0, 90)
                  }
                  crop(after2, page, p.box, join(dir, `${tag}-c.png`))
                } finally {
                  free(after2)
                }
              }
              // 3. A Latin word rewritten with its own letters reversed: the same letters, so the same ink —
              // unless a letter prints nothing (a code whose glyph a subset never had). Arabic is skipped:
              // reversed, its letters join differently.
              const swapAt = ws.findIndex((w, k) => k >= Math.floor(ws.length / 3) && /^[A-Za-z]{4,}$/.test(w))
              if (swapAt >= 0) {
                const swapped = ws.map((w, k) => (k === swapAt ? [...w].reverse().join('') : w)).join('')
                const sw = await replaceText(bytes, page, p.lines[0]!, swapped)
                const after3 = openPdf(sw.bytes)
                try {
                  const inkAfter = crop(after3, page, p.box, join(dir, `${tag}-d.png`))
                  row.swapKept = sw.font?.kept
                  if (inkBefore > 200 && inkAfter < inkBefore * 0.9) row.faint = `${inkAfter} of ${inkBefore} (${sw.font?.kept ?? 'own font'})`
                } finally {
                  free(after3)
                }
              }
            } catch (error) {
              row.ms = Math.round(performance.now() - started)
              row.error = error instanceof Error ? error.message : String(error)
            }
            ;(entry.edits as unknown[]).push(row)
            // MuPDF handles are freed by finalizers: collect as the app's worker does (run with NODE_OPTIONS=--expose-gc).
            ;(globalThis as { gc?: () => void }).gc?.()
            await new Promise((r) => setTimeout(r, 0))
          }
        }
      } finally {
        free(doc)
      }
      report.push(entry)
      writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1))
    }, 1_800_000)
  }
})

// The editor's own typeface (§66): each left-to-right font on the first page made into a browser
// font that reads back, every letter the page shows in it mapped to a drawn glyph.
describe.skipIf(files.length === 0)('browser fonts from the PDFs named for this run', () => {
  for (const path of files) {
    it(basename(path), () => {
      const doc = openPdf(new Uint8Array(readFileSync(path)))
      try {
        const fonts = new Map<string, { seen: Set<number>; bold: boolean; italic: boolean; family: string }>()
        for (const l of styledLines(doc, 0)) {
          if (l.rtl) continue
          for (const r of l.runs) {
            const f = fonts.get(r.font) ?? { seen: new Set<number>(), bold: r.bold, italic: r.italic, family: r.family }
            for (const c of r.text) f.seen.add(c.codePointAt(0)!)
            fonts.set(r.font, f)
          }
        }
        let made = 0
        for (const [name, f] of fonts) {
          const bytes = browserFont(doc, 0, name, f.seen, f)
          if (!bytes) continue
          made++
          const font = fontkit.create(Buffer.from(bytes)) as unknown as { hasGlyphForCodePoint(c: number): boolean; glyphForCodePoint(c: number): { id: number } }
          // Joining letters (Arabic) are never taken from a subset (§59): they show in the stand-in.
          const lost = [...f.seen].filter((c) => c > 32 && !/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/.test(String.fromCodePoint(c)) && !font.hasGlyphForCodePoint(c))
          expect(lost.length / Math.max(1, f.seen.size), `${name}: ${String.fromCodePoint(...lost)}`).toBeLessThan(0.05)
        }
        console.log(`${basename(path)}: ${made}/${fonts.size} fonts shown as they are`)
      } finally {
        free(doc)
      }
    }, 300_000)
  }
})

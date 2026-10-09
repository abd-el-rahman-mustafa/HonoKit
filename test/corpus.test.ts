import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { CORPUS_DIR, corpusPdfNames } from './corpusFiles'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PdfError } from '@engine/errors'
import { free, openPdf } from '@engine/mupdf'
import { pageMarkups } from '@engine/markup'
import { pageCount } from '@engine/pages'
import { pagePictures } from '@engine/pictures'
import { renderPage } from '@engine/render'
import { extractLines, extractText, foldString } from '@engine/text'
import type { Rights } from '@engine/mupdf'
import type { OpInput } from '@shared/ops'
import { applyOperation, assertAllowed, rightsFor } from '@ops/index'

/**
 * Every operation on every real PDF in corpus/ (git-ignored; see test/corpusFiles.ts for how
 * files are left out). Skipped when there are none, as on CI.
 */
const DIR = CORPUS_DIR
const files = corpusPdfNames()

describe.skipIf(files.length === 0)('real PDFs in corpus/', () => {
  for (const name of files) {
    describe(name, () => {
      const bytes = new Uint8Array(readFileSync(join(DIR, name)))
      let pages = 0
      let encrypted = false
      let rights: Rights | null = null
      try {
        pages = pageCount(bytes)
        rights = rightsFor(bytes)
      } catch (error) {
        encrypted = error instanceof PdfError && error.code === 'password-required'
      }

      it('opens, renders and reads', () => {
        if (encrypted) return
        expect(pages).toBeGreaterThan(0)
        const doc = openPdf(bytes)
        try {
          const first = renderPage(doc, 0, { scale: 1 })
          expect(first.width).toBeGreaterThan(0)
          extractText(doc, 0)
        } finally {
          free(doc)
        }
      })

      const ops = [
        { op: 'rotate', pages: [0], angle: 90 },
        { op: 'keep', pages: [] as number[] }, // reverse order, filled in below
        { op: 'duplicate', pages: [0] },
        { op: 'insertBlank', at: 0 },
        { op: 'crop', pages: [0], margins: { left: 10, top: 10, right: 10, bottom: 10 } },
        { op: 'watermark', text: 'مسودة DRAFT 2026' },
        { op: 'pageNumbers', template: 'صفحة {n} من {N}' },
        { op: 'compress', level: 'medium' },
        { op: 'protect', userPassword: 'test-password' },
        { op: 'metadata', title: 'Checked' },
        { op: 'repair' }
      ] satisfies OpInput[]

      for (const op of ops) {
        it(`${op.op} keeps a readable document, or is refused if the author forbids it`, async () => {
          if (encrypted) return
          let allowed = true
          try {
            assertAllowed(op.op, rights!)
          } catch {
            allowed = false
          }
          if (!allowed) {
            await expect(applyOperation(bytes, op.op === 'keep' ? { op: 'keep', pages: [0] } : op)).rejects.toMatchObject({ code: 'restricted' })
            return
          }
          const input: OpInput = op.op === 'keep' ? { op: 'keep', pages: Array.from({ length: pages }, (_, i) => pages - 1 - i) } : op
          const started = performance.now()
          const { bytes: out } = await applyOperation(bytes, input)
          const ms = performance.now() - started
          const password = op.op === 'protect' ? 'test-password' : undefined
          const expected = op.op === 'duplicate' || op.op === 'insertBlank' ? pages + 1 : pages
          expect(pageCount(out, password)).toBe(expected)
          const doc = openPdf(out, password)
          try {
            renderPage(doc, 0, { scale: 0.5 })
          } finally {
            free(doc)
          }
          if (ms > 5000) console.warn(`${name}: ${op.op} took ${(ms / 1000).toFixed(1)} s`)
        })
      }

      it('edits the first line of text, or is refused if the author forbids it', async () => {
        if (encrypted) return
        const first = (() => {
          const doc = openPdf(bytes)
          try {
            return extractLines(doc, 0).find((l) => l.text.trim().length > 8)
          } finally {
            free(doc)
          }
        })()
        if (!first) return // a scanned page: nothing to edit until OCR
        const op = { op: 'replaceText' as const, page: 0, box: first.box, text: 'Edited by PowerPDF — تم التعديل' }
        if (!rights?.edit) {
          await expect(applyOperation(bytes, op)).rejects.toMatchObject({ code: 'restricted' })
          return
        }
        let out: Uint8Array
        try {
          out = (await applyOperation(bytes, op)).bytes
        } catch (error) {
          // Vertical text is refused on purpose; anything else is a failure.
          expect((error as Error).message).toMatch(/horizontal/)
          return
        }
        const doc = openPdf(out)
        try {
          const text = foldString(extractText(doc, 0))
          expect(text).toContain(foldString('Edited by PowerPDF'))
          mkdirSync('smoke-out/corpus', { recursive: true })
          writeFileSync(`smoke-out/corpus/${name}-edited.png`, renderPage(doc, 0, { scale: 1 }).data)
        } finally {
          free(doc)
        }
      })

      it('moves a picture, keeping every other picture, when there is one', async () => {
        if (encrypted || !rights?.edit) return
        const found = (() => {
          const doc = openPdf(bytes)
          try {
            for (let p = 0; p < Math.min(pages, 3); p++) {
              const size = doc.loadPage(p).getBounds()
              const pageArea = (size[2] - size[0]) * (size[3] - size[1])
              const pic = pagePictures(doc, p).find((x) => (x.box[2] - x.box[0]) * (x.box[3] - x.box[1]) < 0.55 * pageArea)
              if (pic) return { page: p, pic, count: pagePictures(doc, p).length }
            }
            return null
          } finally {
            free(doc)
          }
        })()
        if (!found) return
        const { box } = found.pic
        const rect: [number, number, number, number] = [box[0] + 20, box[1] + 10, box[2] + 20, box[3] + 10]
        const { bytes: out } = await applyOperation(bytes, { op: 'changePicture', page: found.page, box, change: { kind: 'move', rect } })
        const doc = openPdf(out)
        try {
          const after = pagePictures(doc, found.page)
          expect(after.length).toBe(found.count)
          expect(after.some((p) => Math.abs(p.box[0] - rect[0]) < 2 && Math.abs(p.box[1] - rect[1]) < 2)).toBe(true)
          mkdirSync('smoke-out/corpus', { recursive: true })
          writeFileSync(`smoke-out/corpus/${name}-picture-moved.png`, renderPage(doc, found.page, { scale: 1 }).data)
        } finally {
          free(doc)
        }
      })

      it('highlights the first line of text as an annotation', async () => {
        if (encrypted || !(rights?.annotate || rights?.edit)) return
        const first = (() => {
          const doc = openPdf(bytes)
          try {
            return extractLines(doc, 0).find((l) => l.text.trim().length > 8)
          } finally {
            free(doc)
          }
        })()
        if (!first) return
        const mid = (first.box[1] + first.box[3]) / 2
        const r = await applyOperation(bytes, { op: 'markup', page: 0, markup: { kind: 'highlight', from: [first.box[0] + 1, mid], to: [first.box[2] - 1, mid], colour: '#facc15' } })
        const doc = openPdf(r.bytes)
        try {
          expect(pageMarkups(doc, 0).some((m) => m.kind === 'highlight')).toBe(true)
        } finally {
          free(doc)
        }
      })
    })
  }
})

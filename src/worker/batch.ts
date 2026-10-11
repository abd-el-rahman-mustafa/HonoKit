import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { BatchStep } from '@shared/ipc'
import type { OpInput } from '@shared/ops'
import { PdfError } from '@engine/errors'
import { free, needsOpenPassword, openPdf, rightsOf, saveBytes, SAVE_FINAL } from '@engine/mupdf'
import { exportOffice } from '@engine/office'
import { applyOperation, assertCanCopy } from '@ops/index'

/**
 * Batch workflows (docs/decisions.md §54), as Acrobat's Action Wizard and iLovePDF's batch: the
 * same chain of steps over many files. Every file is read, changed step by step in memory and
 * written under a new name — beside the original or in a chosen folder — so no original is
 * ever overwritten. One file failing does not stop the others.
 */

export interface BatchResult {
  input: string
  output?: string
  error?: string
}

function opFor(step: BatchStep, pages: number): OpInput | null {
  switch (step.kind) {
    case 'compress':
      return { op: 'compress', level: step.level }
    case 'ocr':
      return { op: 'ocr', language: step.language }
    case 'watermark':
      return { op: 'watermark', text: step.text, opacity: 0.2, rotation: 45, size: 60 }
    case 'pageNumbers':
      return { op: 'pageNumbers', template: step.template }
    case 'rotate':
      return { op: 'rotate', pages: Array.from({ length: pages }, (_, i) => i), angle: step.angle }
    case 'protect':
      return { op: 'protect', userPassword: step.password }
    case 'convert':
      return null
  }
}

/** A name that does not exist yet: "report-done.pdf", then "report-done (2).pdf"… */
function freeName(folder: string, stem: string, ext: string): string {
  let path = join(folder, `${stem}${ext}`)
  for (let n = 2; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}

export async function runBatch(files: string[], steps: BatchStep[], output: { folder: string | null; suffix: string }, progress: (fraction: number, message?: string) => void): Promise<BatchResult[]> {
  const results: BatchResult[] = []
  const convert = steps.find((s): s is Extract<BatchStep, { kind: 'convert' }> => s.kind === 'convert')
  const changes = steps.filter((s) => s.kind !== 'convert')
  for (const [i, file] of files.entries()) {
    progress(i / files.length, `${i + 1}/${files.length} · ${basename(file)}`)
    try {
      let bytes: Uint8Array = new Uint8Array(await readFile(file))
      const doc = openPdf(bytes)
      const locked = needsOpenPassword(doc)
      const pages = doc.countPages()
      const rights = locked ? null : rightsOf(doc)
      free(doc)
      if (locked) throw new PdfError('password-required', 'It needs a password to open.')
      if (convert && rights) assertCanCopy(rights)
      for (const step of changes) {
        const op = opFor(step, pages)
        if (op) bytes = (await applyOperation(bytes, op)).bytes
      }
      const folder = output.folder ?? dirname(file)
      await mkdir(folder, { recursive: true })
      const stem = `${basename(file, extname(file))}${output.suffix}`
      if (convert) {
        const target = freeName(folder, stem, `.${convert.format}`)
        const r = await exportOffice(bytes, { format: convert.format, removeTatweel: true, digits: 'keep', pageBreaks: false, pictureFolder: `${basename(target, extname(target))}_pictures` })
        await writeFile(target, r.bytes)
        if (r.extra.length) {
          const pictures = join(folder, `${basename(target, extname(target))}_pictures`)
          await mkdir(pictures, { recursive: true })
          for (const x of r.extra) await writeFile(join(pictures, x.name), x.bytes)
        }
        results.push({ input: file, output: target })
      } else {
        const final = openPdf(bytes)
        let out: Uint8Array
        try {
          out = saveBytes(final, SAVE_FINAL)
        } finally {
          free(final)
        }
        const target = freeName(folder, stem, '.pdf')
        await writeFile(target, out)
        results.push({ input: file, output: target })
      }
    } catch (error) {
      results.push({ input: file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  progress(1)
  return results
}

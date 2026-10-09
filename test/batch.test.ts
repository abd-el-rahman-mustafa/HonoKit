import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBatch } from '../src/worker/batch'
import { free, openPdf } from '@engine/mupdf'
import { extractText } from '@engine/text'
import { makeLatinPdf } from './fixtures'

describe('batch workflows', () => {
  it('runs the steps over every file, writes new files, and keeps going past a bad one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hono-batch-'))
    const a = join(dir, 'a.pdf')
    const b = join(dir, 'b.pdf')
    const bad = join(dir, 'bad.pdf')
    writeFileSync(a, await makeLatinPdf(2))
    writeFileSync(b, await makeLatinPdf(3))
    writeFileSync(bad, 'not a pdf')
    const seen: number[] = []
    const results = await runBatch([a, b, bad], [{ kind: 'pageNumbers', template: 'Page {n} of {N}' }, { kind: 'watermark', text: 'DRAFT' }, { kind: 'compress', level: 'low' }], { folder: null, suffix: '-done' }, (f) => seen.push(f))
    expect(results.map((r) => !!r.output)).toEqual([true, true, false])
    expect(results[2]!.error).toBeTruthy()
    expect(results[0]!.output).toBe(join(dir, 'a-done.pdf'))
    const doc = openPdf(new Uint8Array(readFileSync(results[1]!.output!)))
    try {
      expect(extractText(doc, 2)).toContain('Page 3 of 3')
      expect(extractText(doc, 0)).toContain('DRAFT')
    } finally {
      free(doc)
    }
    // Originals untouched; a second run does not overwrite the first result.
    const again = await runBatch([a], [{ kind: 'compress', level: 'low' }], { folder: null, suffix: '-done' }, () => undefined)
    expect(again[0]!.output).toBe(join(dir, 'a-done (2).pdf'))
    expect(seen[seen.length - 1]).toBe(1)
    const word = await runBatch([b], [{ kind: 'convert', format: 'docx' }], { folder: join(dir, 'out'), suffix: '' }, () => undefined)
    expect(existsSync(join(dir, 'out', 'b.docx'))).toBe(true)
    expect(word[0]!.output).toBe(join(dir, 'out', 'b.docx'))
  }, 60_000)
})

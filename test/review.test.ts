import { describe, expect, it } from 'vitest'
import { PdfError } from '@engine/errors'
import { free, openPdf } from '@engine/mupdf'
import { deletePages, keepPages } from '@engine/pages'
import { protectPdf } from '@engine/security'
import { extractLines } from '@engine/text'
import { applyOperation } from '@ops/index'
import { makeFormWithBookmarks, makeLatinPdf } from './fixtures'

/**
 * Regression tests for defects found in the review of 2026-09-29 (docs/session-log.md).
 * Each one failed, or was shown by a probe to be wrong, before its fix.
 */

function outline(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    return (doc.loadOutline() ?? []).map((o) => `${o.title}->${o.page ?? '?'}`)
  } finally {
    free(doc)
  }
}

function fieldNames(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields')
    const names: string[] = []
    if (fields.isArray()) for (let i = 0; i < fields.length; i++) names.push(fields.get(i).get('T').asString())
    return names
  } finally {
    free(doc)
  }
}

describe('reorder and delete keep what lives outside the pages', () => {
  it('keeps form fields when pages are reordered', async () => {
    const src = await makeFormWithBookmarks(3)
    expect(fieldNames(src)).toEqual(['customerName'])
    expect(fieldNames(keepPages(src, [2, 1, 0]))).toEqual(['customerName'])
  })

  it('keeps bookmarks and points them at the moved pages', async () => {
    const src = await makeFormWithBookmarks(3)
    expect(outline(src)).toEqual(['Chapter 1->0', 'Chapter 2->1', 'Chapter 3->2'])
    // Chapter 1 now sits on the last page.
    expect(outline(keepPages(src, [1, 2, 0]))).toContain('Chapter 1->2')
  })

  it('drops the bookmark of a deleted page and keeps the others', async () => {
    const src = await makeFormWithBookmarks(3)
    const titles = outline(deletePages(src, [1])).map((t) => t.split('->')[0])
    expect(titles).toContain('Chapter 1')
    expect(titles).toContain('Chapter 3')
    expect(titles).not.toContain('Chapter 2')
  })
})

describe('protect', () => {
  it('does not use the open password as the permissions password', async () => {
    const locked = protectPdf(await makeLatinPdf(1), { userPassword: 'open-me', allowPrint: false, allowCopy: false, allowModify: false, allowAnnotate: false })
    const doc = openPdf(locked, 'open-me')
    try {
      // 2 = opened as the user; 4 = opened as the owner (MuPDF's authenticatePassword codes).
      const doc2 = openPdf(locked)
      free(doc2)
    } catch (error) {
      expect((error as PdfError).code).toBe('password-required')
    } finally {
      free(doc)
    }
    const raw = openPdf(locked, 'open-me')
    try {
      expect(raw.authenticatePassword('open-me') & 4).toBe(0)
    } finally {
      free(raw)
    }
  })

  it('refuses a comma in a password with a clear reason', async () => {
    const src = await makeLatinPdf(1)
    expect(() => protectPdf(src, { userPassword: 'ab,cd', allowPrint: true, allowCopy: true, allowModify: true, allowAnnotate: true })).toThrow(/cannot contain a comma/)
  })
})

describe('brackets in Arabic stamps', () => {
  it('draws «(سري) [مسودة]» with the brackets facing the right way', async () => {
    const { bytes } = await applyOperation(await makeLatinPdf(1), { op: 'watermark', text: '(سري) [مسودة]', rotation: 0, size: 30, position: 'top-center', colour: '#000000', opacity: 1 })
    const doc = openPdf(bytes)
    try {
      const order = extractLines(doc, 0)
        .flatMap((l) => l.glyphs)
        .filter((g) => '()[]'.includes(g.c))
        .sort((a, b) => a.box[0] - b.box[0])
        .map((g) => g.c)
        .join('')
      // Seen left to right on the page: [مسودة] (سري) — the glyphs a reader sees are [ ] ( ).
      expect(order).toBe('[]()')
    } finally {
      free(doc)
    }
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { keepPages, pageCount, replacePages, splitByRanges } from '@engine/pages'
import { extractText } from '@engine/text'
import { formatPageList, menuTargets, parsePageList, pickHow, pickPages, replacementPages } from '@shared/pagelist'
import { applyOperation } from '@ops/index'
import { translateCount } from '../src/renderer/src/i18n'
import { corpusPdfPaths } from './corpusFiles'
import { makeRestrictedPdf } from './fixtures'

/**
 * Organize with checkboxes and the page menu (decisions §76): choosing pages, the page lists the
 * dialogs take, and the page operations on several pages at once — rotate, delete, extract (one
 * file and a file per page) and replace — on real PDFs in corpus/ (git-ignored;
 * test/corpusFiles.ts). Forms survive (§20) on a corpus PDF given a form by Prepare a form.
 */
const corpus = corpusPdfPaths()
const name = (path: string): string => path.split(/[\\/]/).pop()!
/** The corpus PDFs with at least three pages, smallest first (quicker). */
const multi = corpus
  .map((path) => ({ path, bytes: new Uint8Array(readFileSync(path)) }))
  .map((f) => ({ ...f, pages: pageCount(f.bytes) }))
  .filter((f) => f.pages >= 3)
  .sort((a, b) => a.bytes.length - b.bytes.length)

const folder = mkdtempSync(join(tmpdir(), 'honokit-organize-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

function texts(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    return Array.from({ length: doc.countPages() }, (_, i) => extractText(doc, i).replace(/\s+/g, ' ').trim())
  } finally {
    free(doc)
  }
}

function look(bytes: Uint8Array): Array<{ rotate: number; size: string; annots: number }> {
  const doc = openPdf(bytes)
  try {
    return Array.from({ length: doc.countPages() }, (_, i) => {
      const page = doc.findPage(i)
      const r = page.getInheritable('Rotate')
      const b = doc.loadPage(i).getBounds()
      const annots = page.get('Annots')
      return { rotate: r.isNumber() ? r.asNumber() : 0, size: `${Math.round(b[2] - b[0])}x${Math.round(b[3] - b[1])}`, annots: annots.isArray() ? annots.length : 0 }
    })
  } finally {
    free(doc)
  }
}

function outline(bytes: Uint8Array): string[] {
  const doc = openPdf(bytes)
  try {
    const out: string[] = []
    const walk = (items: Array<{ title?: string; page?: number; down?: unknown[] }> | undefined): void => {
      for (const o of items ?? []) {
        out.push(`${o.title}->${o.page ?? '?'}`)
        walk(o.down as typeof items)
      }
    }
    walk(doc.loadOutline() as never)
    return out
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
    return names.sort()
  } finally {
    free(doc)
  }
}

describe('choosing pages on the grid', () => {
  it('reads the keys and the checkbox as Explorer does', () => {
    const k = (shiftKey: boolean, ctrlKey: boolean) => ({ shiftKey, ctrlKey })
    expect(pickHow(k(false, false))).toBe('only')
    expect(pickHow(k(false, true))).toBe('toggle')
    expect(pickHow(k(false, false), true)).toBe('toggle')
    expect(pickHow(k(true, false))).toBe('range')
    expect(pickHow(k(true, true))).toBe('addRange')
    expect(pickHow(k(true, false), true)).toBe('addRange')
    expect(pickHow({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe('toggle')
  })

  it('selects one, ticks more, runs from the anchor, adds runs', () => {
    let s = pickPages([], null, 2, 'only')
    expect(s).toEqual({ selected: [2], anchor: 2 })
    s = pickPages(s.selected, s.anchor, 5, 'toggle')
    expect(s).toEqual({ selected: [2, 5], anchor: 5 })
    s = pickPages(s.selected, s.anchor, 2, 'toggle')
    expect(s).toEqual({ selected: [5], anchor: 2 })
    // Shift: the run from the anchor replaces the selection, and the anchor stays.
    s = pickPages([0, 9], 2, 6, 'range')
    expect(s).toEqual({ selected: [2, 3, 4, 5, 6], anchor: 2 })
    expect(pickPages(s.selected, s.anchor, 0, 'range').selected).toEqual([0, 1, 2])
    // Ctrl+Shift: the run is added.
    expect(pickPages([9], 2, 4, 'addRange').selected).toEqual([2, 3, 4, 9])
    // No anchor yet: Shift picks the page alone.
    expect(pickPages([], null, 3, 'range')).toEqual({ selected: [3], anchor: 3 })
  })

  it('aims the menu at the selection only when the page is part of it', () => {
    expect(menuTargets([4, 1, 2], 2)).toEqual([1, 2, 4])
    expect(menuTargets([1, 2], 7)).toEqual([7])
    expect(menuTargets([], 0)).toEqual([0])
  })

  it('fills the dialogs with the selection and reads it back', () => {
    const sel = [0, 1, 2, 5, 9]
    expect(formatPageList(sel)).toBe('1-3, 6, 10')
    expect(parsePageList(formatPageList(sel), 10)).toEqual(sel)
    expect(parsePageList('١-٣، ٦', 10)).toEqual([0, 1, 2, 5])
  })

  it('takes replacement pages one after another, if the other file has them', () => {
    expect(replacementPages([3, 4, 7], 0, 5)).toEqual([0, 1, 2])
    expect(replacementPages([3, 4], 3, 5)).toEqual([3, 4])
    expect(replacementPages([3, 4], 4, 5)).toBeNull()
    expect(replacementPages([0], -1, 5)).toBeNull()
  })
})

describe('labels that count pages', () => {
  it('uses Arabic one, two, few and many', () => {
    expect(translateCount('ar', 'pagesMenu.rotateRight', 1)).toBe('تدوير الصفحة يمينًا')
    expect(translateCount('ar', 'pagesMenu.rotateRight', 2)).toBe('تدوير الصفحتين يمينًا')
    expect(translateCount('ar', 'pagesMenu.rotateRight', 3)).toBe('تدوير 3 صفحات يمينًا')
    expect(translateCount('ar', 'pagesMenu.rotateRight', 11)).toBe('تدوير 11 صفحة يمينًا')
    expect(translateCount('ar', 'pagesMenu.rotateRight', 100)).toBe('تدوير 100 صفحة يمينًا')
    expect(translateCount('ar', 'pages.selected', 2)).toBe('صفحتان محددتان')
  })

  it('uses English one and other', () => {
    expect(translateCount('en', 'pagesMenu.delete', 1)).toBe('Delete page…')
    expect(translateCount('en', 'pagesMenu.delete', 3)).toBe('Delete 3 pages…')
    expect(translateCount('en', 'pages.selected', 3)).toBe('3 pages selected')
  })
})

describe.skipIf(multi.length < 2)('several pages at once, on the owner\'s PDFs', () => {
  for (const file of multi) {
    describe(name(file.path), () => {
      const before = texts(file.bytes)
      const looks = look(file.bytes)
      const last = file.pages - 1

      it('rotates the chosen pages and no others', async () => {
        const { bytes } = await applyOperation(file.bytes, { op: 'rotate', pages: [0, 2], angle: 90 })
        const after = look(bytes)
        expect(after.map((p) => p.rotate)).toEqual(looks.map((p, i) => (i === 0 || i === 2 ? (p.rotate + 90) % 360 : p.rotate)))
        expect(texts(bytes)).toEqual(before)
      })

      it('deletes several pages and keeps the rest in order', async () => {
        const { bytes } = await applyOperation(file.bytes, { op: 'delete', pages: [1, last] })
        expect(pageCount(bytes)).toBe(file.pages - 2)
        expect(texts(bytes)).toEqual(before.filter((_, i) => i !== 1 && i !== last))
      })

      it('extracts several pages as one document, and as a file per page', () => {
        const pages = [0, 2, last]
        expect(texts(keepPages(file.bytes, pages))).toEqual(pages.map((p) => before[p]))
        const each = splitByRanges(file.bytes, pages.map((p) => [p, p] as [number, number]))
        expect(each.map((b) => pageCount(b))).toEqual([1, 1, 1])
        expect(each.map((b) => texts(b)[0])).toEqual(pages.map((p) => before[p]))
      })

      it('replaces pages with pages of another PDF, keeping the rest, the bookmarks and the links', async () => {
        const other = multi.find((f) => f.path !== file.path)!
        const otherTexts = texts(other.bytes)
        const otherLooks = look(other.bytes)
        const path = join(folder, `donor-${name(other.path)}`)
        writeFileSync(path, other.bytes)
        const targets = [1, 2]
        const { bytes } = await applyOperation(file.bytes, { op: 'replacePages', pages: targets, path, from: [0, 1] })
        expect(pageCount(bytes)).toBe(file.pages)
        const after = texts(bytes)
        expect(after[0]).toBe(before[0])
        expect(after[1]).toBe(otherTexts[0])
        expect(after[2]).toBe(otherTexts[1])
        expect(after.slice(3)).toEqual(before.slice(3))
        const now = look(bytes)
        expect([now[1]!.size, now[2]!.size]).toEqual([otherLooks[0]!.size, otherLooks[1]!.size])
        expect([now[1]!.rotate, now[2]!.rotate]).toEqual([otherLooks[0]!.rotate, otherLooks[1]!.rotate])
        // The page objects stay: their links and comments, and every bookmark, still point at them.
        expect(now.map((p) => p.annots)).toEqual(looks.map((p) => p.annots))
        expect(outline(bytes)).toEqual(outline(file.bytes))
      })

      it('refuses replacement pages the other PDF does not have', async () => {
        const path = join(folder, `self-${name(file.path)}`)
        writeFileSync(path, file.bytes)
        await expect(applyOperation(file.bytes, { op: 'replacePages', pages: [0], path, from: [file.pages + 3] })).rejects.toMatchObject({ code: 'bad-arguments' })
        expect(() => replacePages(file.bytes, [0, 1], file.bytes, [0])).toThrow(/as many/)
      })
    })
  }
})

describe.skipIf(multi.length < 2)('a form survives the page menu (§20)', () => {
  it('keeps every field through rotate, delete, replace and extract of several pages', async () => {
    const base = multi[0]!
    const other = multi[1]!
    const path = join(folder, 'form-donor.pdf')
    writeFileSync(path, other.bytes)
    // A corpus PDF given a form with Prepare a form: a field on the first three pages.
    let { bytes } = await applyOperation(base.bytes, {
      op: 'addFields',
      fields: [0, 1, 2].map((page) => ({ page, box: [40, 40, 220, 64] as [number, number, number, number], kind: 'text' as const, name: `field${page + 1}` }))
    })
    expect(fieldNames(bytes)).toEqual(['field1', 'field2', 'field3'])
    bytes = (await applyOperation(bytes, { op: 'rotate', pages: [0, 1], angle: 90 })).bytes
    expect(fieldNames(bytes)).toEqual(['field1', 'field2', 'field3'])
    // Replace keeps the page objects, so their fields stay (as in Acrobat).
    bytes = (await applyOperation(bytes, { op: 'replacePages', pages: [1], path, from: [0] })).bytes
    expect(fieldNames(bytes)).toEqual(['field1', 'field2', 'field3'])
    // Deleting several pages drops their fields and keeps the others in the form.
    const remaining = (await applyOperation(bytes, { op: 'delete', pages: [1, 2] })).bytes
    expect(fieldNames(remaining)).toEqual(['field1'])
    expect(fieldNames(keepPages(bytes, [0, 2]))).toEqual(['field1', 'field3'])
  })
})

describe('the author\'s restrictions (§23)', () => {
  it('refuses to replace pages of a restricted PDF without the permissions password', async () => {
    const src = await makeRestrictedPdf(3)
    const path = join(folder, 'restricted-donor.pdf')
    writeFileSync(path, await makeRestrictedPdf(2, { assemble: true }))
    await expect(applyOperation(src, { op: 'replacePages', pages: [0], path, from: [0] })).rejects.toMatchObject({ code: 'restricted' })
    const { bytes } = await applyOperation(src, { op: 'replacePages', pages: [0], path, from: [1] }, { password: 'owner-secret' })
    expect(texts(bytes)[0]).toContain('Marker2')
  })
})

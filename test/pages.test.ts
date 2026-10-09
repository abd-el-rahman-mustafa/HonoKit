import { describe, expect, it } from 'vitest'
import { PdfError } from '@engine/errors'
import { free, openPdf } from '@engine/mupdf'
import { cropPages, deletePages, duplicatePages, insertBlankPages, insertPdfPages, keepPages, mergePdfs, pageCount, rotatePages, splitByRanges } from '@engine/pages'
import { extractText } from '@engine/text'
import { makeLatinPdf } from './fixtures'

function textOf(bytes: Uint8Array, page: number): string {
  const doc = openPdf(bytes)
  try {
    return extractText(doc, page)
  } finally {
    free(doc)
  }
}

const markers = (bytes: Uint8Array): string[] => Array.from({ length: pageCount(bytes) }, (_, i) => /Marker\d+/.exec(textOf(bytes, i))?.[0] ?? '(blank)')

describe('page operations', () => {
  it('deletes pages and keeps the rest in order', async () => {
    const out = deletePages(await makeLatinPdf(5), [1, 3])
    expect(markers(out)).toEqual(['Marker1', 'Marker3', 'Marker5'])
  })

  it('refuses to delete every page', async () => {
    expect(() => deletePages(new Uint8Array(0), [0])).toThrow()
    const pdf = await makeLatinPdf(2)
    expect(() => deletePages(pdf, [0, 1])).toThrow(PdfError)
  })

  it('refuses a page that does not exist', async () => {
    const pdf = await makeLatinPdf(2)
    expect(() => deletePages(pdf, [5])).toThrow(/does not exist/)
    expect(() => rotatePages(pdf, [-1], 90)).toThrow(/does not exist/)
  })

  it('keeps chosen pages in the chosen order (extract and reorder)', async () => {
    const pdf = await makeLatinPdf(5)
    expect(markers(keepPages(pdf, [4, 0, 2]))).toEqual(['Marker5', 'Marker1', 'Marker3'])
  })

  it('duplicates a page right after itself', async () => {
    const pdf = await makeLatinPdf(3)
    expect(markers(duplicatePages(pdf, [1]))).toEqual(['Marker1', 'Marker2', 'Marker2', 'Marker3'])
  })

  it('rotates, accumulating rotation and wrapping at 360', async () => {
    let pdf = await makeLatinPdf(2)
    pdf = rotatePages(pdf, [0], 90)
    pdf = rotatePages(pdf, [0], 90)
    pdf = rotatePages(pdf, [1], -90)
    const doc = openPdf(pdf)
    try {
      expect(doc.findPage(0).getInheritable('Rotate').asNumber()).toBe(180)
      expect(doc.findPage(1).getInheritable('Rotate').asNumber()).toBe(270)
    } finally {
      free(doc)
    }
  })

  it('inserts blank pages sized like their neighbour', async () => {
    const out = insertBlankPages(await makeLatinPdf(2, { width: 300, height: 500 }), 1, 2)
    expect(pageCount(out)).toBe(4)
    expect(markers(out)).toEqual(['Marker1', '(blank)', '(blank)', 'Marker2'])
    const doc = openPdf(out)
    try {
      const b = doc.loadPage(1).getBounds()
      expect([b[2] - b[0], b[3] - b[1]]).toEqual([300, 500])
    } finally {
      free(doc)
    }
  })

  it('inserts pages from another document', async () => {
    const base = await makeLatinPdf(2)
    const other = await makeLatinPdf(3)
    const out = insertPdfPages(base, 1, other, [2, 0])
    expect(pageCount(out)).toBe(4)
    expect(markers(out)).toEqual(['Marker1', 'Marker3', 'Marker1', 'Marker2'])
  })

  it('merges documents in order', async () => {
    const out = mergePdfs([{ bytes: await makeLatinPdf(2) }, { bytes: await makeLatinPdf(1) }])
    expect(markers(out)).toEqual(['Marker1', 'Marker2', 'Marker1'])
  })

  it('keeps the first document\'s title when merging', async () => {
    const out = mergePdfs([{ bytes: await makeLatinPdf(1) }, { bytes: await makeLatinPdf(1) }])
    const doc = openPdf(out)
    try {
      expect(doc.getMetaData('info:Title')).toBe('Fixture')
    } finally {
      free(doc)
    }
  })

  it('splits by ranges', async () => {
    const parts = splitByRanges(await makeLatinPdf(6), [
      [0, 1],
      [2, 5]
    ])
    expect(parts.map((part) => pageCount(part))).toEqual([2, 4])
    expect(markers(parts[1]!)).toEqual(['Marker3', 'Marker4', 'Marker5', 'Marker6'])
  })

  it('rejects a bad split range', async () => {
    expect(() => splitByRanges(new Uint8Array(0), [[0, 1]])).toThrow()
    const pdf = await makeLatinPdf(3)
    expect(() => splitByRanges(pdf, [[2, 5]])).toThrow(/not valid/)
    expect(() => splitByRanges(pdf, [[2, 1]])).toThrow(/not valid/)
  })

  it('crops by margins as displayed, on an unrotated page', async () => {
    const out = cropPages(await makeLatinPdf(1, { width: 400, height: 600 }), [0], { left: 10, top: 20, right: 30, bottom: 40 })
    const doc = openPdf(out)
    try {
      const b = doc.findPage(0).get('CropBox')
      expect([0, 1, 2, 3].map((i) => b.get(i).asNumber())).toEqual([10, 40, 370, 580])
    } finally {
      free(doc)
    }
  })

  it('crops a rotated page by what the reader sees', async () => {
    // Rotated 90°: the displayed left edge is the page\'s own bottom edge.
    const out = cropPages(await makeLatinPdf(1, { width: 400, height: 600, rotate: 90 }), [0], { left: 10, top: 20, right: 30, bottom: 40 })
    const doc = openPdf(out)
    try {
      const b = doc.findPage(0).get('CropBox')
      // x0 += top(20), y0 += left(10), x1 -= bottom(40), y1 -= right(30)
      expect([0, 1, 2, 3].map((i) => b.get(i).asNumber())).toEqual([20, 10, 360, 570])
    } finally {
      free(doc)
    }
  })

  it('refuses a crop that leaves nothing', async () => {
    const pdf = await makeLatinPdf(1)
    expect(() => cropPages(pdf, [0], { left: 300, top: 0, right: 100, bottom: 0 })).toThrow(/almost nothing/)
  })
})

describe('new blank document', () => {
  it('makes empty pages of the asked size', async () => {
    const { blankPdf } = await import('@engine/pages')
    const doc = openPdf(blankPdf(842, 595, 3))
    try {
      expect(doc.countPages()).toBe(3)
      const b = doc.loadPage(2).getBounds()
      expect(Math.round(b[2] - b[0])).toBe(842)
      expect(Math.round(b[3] - b[1])).toBe(595)
    } finally {
      free(doc)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { free, openPdf, saveBytes } from '@engine/mupdf'
import { insertPdfPages, mergePdfs } from '@engine/pages'
import { makeLatinPdf } from './fixtures'

/**
 * A page whose resources reach a chain of thousands of shallow indirect objects: copying it
 * (Insert pages, Combine) must either bring it over or refuse it, never bring the engine down
 * with it.
 */
async function deepDonor(depth: number): Promise<Uint8Array> {
  const doc = openPdf(await makeLatinPdf(1))
  try {
    let next = doc.newDictionary()
    next.put('End', 1)
    let ref = doc.addObject(next)
    for (let i = 0; i < depth; i++) {
      const d = doc.newDictionary()
      d.put('Next', ref)
      ref = doc.addObject(d)
    }
    const page = doc.findPage(0)
    const resources = page.get('Resources')
    resources.put('Chain', ref)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

describe('a page that reaches a very deep object chain', () => {
  it('is inserted whole or refused, and the document is not harmed', async () => {
    const donor = await deepDonor(20_000)
    const target = await makeLatinPdf(2)
    let result: Uint8Array | null = null
    try {
      result = insertPdfPages(target, 1, donor)
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/./)
    }
    if (result) {
      const doc = openPdf(result)
      try {
        expect(doc.countPages()).toBe(3)
      } finally {
        free(doc)
      }
    }
    const merged = mergePdfs([{ bytes: target }, { bytes: donor }])
    const doc = openPdf(merged)
    try {
      expect(doc.countPages()).toBe(3)
    } finally {
      free(doc)
    }
  })
})

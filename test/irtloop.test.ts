import { describe, expect, it } from 'vitest'
import { pageMarkups, removeMarkup } from '@engine/markup'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { commentThreads } from '@shared/threads'
import { makeLatinPdf } from './fixtures'

/**
 * Two comments whose /IRT entries point at each other, and longer loops, have no comment at the
 * head of the chain: the panel shows each as a comment of its own (`commentThreads`). Removing
 * one must then leave the others where they are — the deleter used to follow /IRT whatever it
 * led to, so deleting one card took every comment of the loop with it. Decisions §101.
 */

function withDoc<T>(bytes: Uint8Array, f: (doc: ReturnType<typeof openPdf>) => T): T {
  const doc = openPdf(bytes)
  try {
    return f(doc)
  } finally {
    free(doc)
  }
}

/** One page of `count` notes, each a reply to the next, the last one a reply to the first. */
async function looped(count: number): Promise<Uint8Array> {
  const bytes = await makeLatinPdf(1)
  return withDoc(bytes, (doc) => {
    const page = doc.loadPage(0) as mupdf.PDFPage
    try {
      const notes = Array.from({ length: count }, (_, i) => {
        const a = page.createAnnotation('Text')
        a.setRect([60 + i * 40, 60, 80 + i * 40, 80])
        a.setContents(String.fromCharCode(65 + i))
        a.update()
        return a
      })
      for (let i = 0; i < count; i++) notes[i]!.getObject().put('IRT', notes[(i + 1) % count]!.getObject())
      return saveBytes(doc)
    } finally {
      free(page)
    }
  })
}

const marks = (bytes: Uint8Array) => withDoc(bytes, (doc) => pageMarkups(doc, 0))
const texts = (bytes: Uint8Array) => marks(bytes).map((m) => m.text).sort()

describe('a loop of replies (§101)', () => {
  it('shows two comments pointing at each other as comments of their own', async () => {
    const src = await looped(2)
    expect(commentThreads(marks(src)).top.map((m) => m.text).sort()).toEqual(['A', 'B'])
  })

  it('leaves the other comment of the pair where it is when one is removed', async () => {
    const src = await looped(2)
    const a = marks(src).find((m) => m.text === 'A')!
    const after = removeMarkup(src, 0, a.index, a.box)
    expect(texts(after)).toEqual(['B'])
  })

  it('leaves the rest of a longer loop where it is', async () => {
    const src = await looped(3)
    expect(commentThreads(marks(src)).top).toHaveLength(3)
    const a = marks(src).find((m) => m.text === 'A')!
    const after = removeMarkup(src, 0, a.index, a.box)
    expect(texts(after)).toEqual(['B', 'C'])
  })

  it('still takes a real reply with the comment it answers', async () => {
    const bytes = await makeLatinPdf(1)
    const src = withDoc(bytes, (doc) => {
      const page = doc.loadPage(0) as mupdf.PDFPage
      try {
        const note = (text: string, at: number): mupdf.PDFAnnotation => {
          const a = page.createAnnotation('Text')
          a.setRect([at, 60, at + 20, 80])
          a.setContents(text)
          a.update()
          return a
        }
        const parent = note('Parent', 60)
        const reply = note('Reply', 100)
        reply.getObject().put('IRT', parent.getObject())
        const deep = note('Reply to reply', 140)
        deep.getObject().put('IRT', reply.getObject())
        note('Alone', 200)
        return saveBytes(doc)
      } finally {
        free(page)
      }
    })
    const parent = marks(src).find((m) => m.text === 'Parent')!
    const after = removeMarkup(src, 0, parent.index, parent.box)
    expect(texts(after)).toEqual(['Alone'])
  })
})

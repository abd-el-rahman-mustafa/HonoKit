import { describe, expect, it } from 'vitest'
import { exactPixels, stepScale, watchPixelRatio, type PixelRatioWindow } from '@shared/pixels'
import { RECENT_PER_KIND, recentKind, recentOfKind, withoutRecent, withRecent } from '@shared/recent'
import { beforeWindowCloses, PendingTyping, unsavedIds } from '@shared/typing'

/** Decisions §83: closing the window while typing, a monitor with another scaling, Recent's tabs. */

describe('closing the window while typing in a form field (§83)', () => {
  it('counts a document with typing not yet committed as unsaved, so the window asks', () => {
    const typing = new PendingTyping()
    const dirty = new Set(['changed'])
    typing.set('typed', 'name', async () => undefined)
    expect(unsavedIds(['clean', 'changed', 'typed'], (id) => dirty.has(id), typing)).toEqual(['changed', 'typed'])
    typing.set('typed', 'name', null)
    expect(unsavedIds(['clean', 'changed', 'typed'], (id) => dirty.has(id), typing)).toEqual(['changed'])
  })

  it('tells the window when a document starts or stops having typing, not on every key', () => {
    const typing = new PendingTyping()
    let told = 0
    typing.onChange(() => told++)
    typing.set('doc', 'name', async () => undefined) // starts
    typing.set('doc', 'name', async () => undefined) // another key: nothing new
    typing.set('doc', 'city', async () => undefined) // a second field: still the same document
    expect(told).toBe(1)
    typing.set('doc', 'name', null)
    expect(told).toBe(1)
    typing.set('doc', 'city', null) // stops
    expect(told).toBe(2)
  })

  it('commits the typing first, then asks about the documents it changed', async () => {
    const typing = new PendingTyping()
    const dirty = new Set<string>()
    const values: Record<string, string> = {}
    // Committing fills the field: the document becomes changed, as apply() does.
    typing.set('form', 'name', async () => {
      values['form'] = 'Ahmed'
      dirty.add('form')
    })
    let told = 0
    typing.onChange(() => told++)
    const ask = await beforeWindowCloses(['other', 'form'], typing, (id) => dirty.has(id))
    expect(ask).toEqual(['form'])
    expect(values['form']).toBe('Ahmed')
    expect(typing.has('form')).toBe(false)
    expect(told).toBe(1) // the window learns the typing is no longer pending
  })

  it('closes at once when nothing is unsaved, and stays when a field refuses its text', async () => {
    const typing = new PendingTyping()
    expect(await beforeWindowCloses(['a', 'b'], typing, () => false)).toEqual([])
    typing.set('a', 'date', async () => false)
    expect(await beforeWindowCloses(['a', 'b'], typing, () => false)).toBeNull()
  })
})

describe('a monitor with another scaling (§83)', () => {
  /** A window whose devicePixelRatio the test changes, with media queries that fire as Chromium's do. */
  function fakeWindow(start: number): PixelRatioWindow & { move(dpr: number): void; armed(): string[] } {
    let ratio = start
    let queries: Array<{ query: string; listener: () => void }> = []
    return {
      get devicePixelRatio() {
        return ratio
      },
      matchMedia(query: string) {
        return {
          addEventListener: (_type: 'change', listener: () => void) => void queries.push({ query, listener }),
          removeEventListener: (_type: 'change', listener: () => void) => void (queries = queries.filter((q) => q.listener !== listener))
        }
      },
      move(dpr: number) {
        if (dpr === ratio) return
        // The query for the old resolution stops matching: its listeners hear "change" once.
        const old = `(resolution: ${ratio}dppx)`
        ratio = dpr
        const firing = queries.filter((q) => q.query === old)
        queries = queries.filter((q) => q.query !== old)
        for (const q of firing) q.listener()
      },
      armed: () => queries.map((q) => q.query)
    }
  }

  it('hears every change of devicePixelRatio, arming again for the new one', () => {
    const win = fakeWindow(1)
    const heard: number[] = []
    const stop = watchPixelRatio(win, (dpr) => heard.push(dpr))
    expect(win.armed()).toEqual(['(resolution: 1dppx)'])
    win.move(1.5) // to a 150 % monitor
    win.move(1.25) // to a 125 % one
    win.move(1.5) // and back
    expect(heard).toEqual([1.5, 1.25, 1.5])
    expect(win.armed()).toEqual(['(resolution: 1.5dppx)'])
    stop()
    expect(win.armed()).toEqual([])
    win.move(2)
    expect(heard).toEqual([1.5, 1.25, 1.5])
  })

  it('a page asks for the device pixels it covers on the new monitor', () => {
    // A page 612 pt wide shown 900 × 1164 CSS pixels.
    const at100 = exactPixels(900, 1164, 612, 1)!
    const at150 = exactPixels(900, 1164, 612, 1.5)!
    expect(at100.size).toEqual([900, 1164])
    expect(at150.size).toEqual([1350, 1746])
    // Shown at that size again: one picture pixel per screen pixel.
    expect(at150.cssWidth * 1.5).toBe(1350)
    // At 125 % a size that does not divide evenly is rounded, and the CSS size follows it.
    const at125 = exactPixels(901, 1165, 612, 1.25)!
    expect(at125.size).toEqual([1126, 1456])
    expect(at125.cssWidth).toBeCloseTo(1126 / 1.25, 9)
    // The stepped scale for thumbnails moves with the monitor too.
    expect(stepScale(900 / 612, 1)).toBe(1.5)
    expect(stepScale(900 / 612, 2)).toBe(3)
  })

  it('very large zooms keep the capped step', () => {
    expect(exactPixels(612 * 4, 792 * 4, 612, 2)).toBeNull()
    expect(stepScale(12, 2)).toBe(6)
  })
})

describe('Home › Recent on two tabs, PDFs and Images (§83)', () => {
  it('sorts recent files into PDFs and pictures', () => {
    const list = ['C:\\a.pdf', 'C:\\b.JPG', 'D:/c.png', 'D:/d.PDF', 'E:\\e.heic']
    expect(recentOfKind(list, 'pdf')).toEqual(['C:\\a.pdf', 'D:/d.PDF'])
    expect(recentOfKind(list, 'image')).toEqual(['C:\\b.JPG', 'D:/c.png', 'E:\\e.heic'])
    expect(recentKind('C:\\notes.pdf')).toBe('pdf')
  })

  it('keeps the newest twelve of each kind: many pictures never push the PDFs out', () => {
    let list: string[] = []
    for (let i = 0; i < 5; i++) list = withRecent(list, `C:\\doc${i}.pdf`)
    for (let i = 0; i < 30; i++) list = withRecent(list, `C:\\photo${i}.jpg`)
    expect(recentOfKind(list, 'pdf')).toEqual(['C:\\doc4.pdf', 'C:\\doc3.pdf', 'C:\\doc2.pdf', 'C:\\doc1.pdf', 'C:\\doc0.pdf'])
    expect(recentOfKind(list, 'image')).toHaveLength(RECENT_PER_KIND)
    expect(recentOfKind(list, 'image')[0]).toBe('C:\\photo29.jpg')
    // Opened again: first, once.
    list = withRecent(list, 'C:\\doc0.pdf')
    expect(list[0]).toBe('C:\\doc0.pdf')
    expect(list.filter((p) => p === 'C:\\doc0.pdf')).toHaveLength(1)
  })

  it('Clear on a tab empties that tab only; one file, or all, as before', () => {
    const list = ['C:\\a.pdf', 'C:\\b.jpg', 'C:\\c.pdf']
    expect(withoutRecent(list, { kind: 'image' })).toEqual(['C:\\a.pdf', 'C:\\c.pdf'])
    expect(withoutRecent(list, { kind: 'pdf' })).toEqual(['C:\\b.jpg'])
    expect(withoutRecent(list, { path: 'C:\\c.pdf' })).toEqual(['C:\\a.pdf', 'C:\\b.jpg'])
    expect(withoutRecent(list, {})).toEqual([])
  })
})

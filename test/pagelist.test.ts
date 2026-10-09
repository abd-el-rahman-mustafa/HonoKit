import { describe, expect, it } from 'vitest'
import { formatPageList, parsePageList, parseRanges } from '@shared/pagelist'

describe('page lists', () => {
  it('reads numbers, ranges and open ranges', () => {
    expect(parsePageList('1-3, 5, 8-', 10)).toEqual([0, 1, 2, 4, 7, 8, 9])
    expect(parsePageList('-2', 10)).toEqual([0, 1])
    expect(parsePageList('4', 10)).toEqual([3])
  })

  it('reads Arabic digits, the Arabic comma and the en dash', () => {
    expect(parsePageList('١-٣، ٥', 10)).toEqual([0, 1, 2, 4])
    expect(parsePageList('۲–۳', 10)).toEqual([1, 2])
  })

  it('keeps the typed order and drops repeats', () => {
    expect(parsePageList('5, 1, 5, 2', 10)).toEqual([4, 0, 1])
  })

  it('rejects what is not a page list', () => {
    for (const bad of ['', 'abc', '0', '11', '3-1', '1--2', '2-12']) expect(parsePageList(bad, 10)).toBeNull()
  })

  it('reads split ranges', () => {
    expect(parseRanges('1-3, 4-10', 12)).toEqual([
      [0, 2],
      [3, 9]
    ])
    expect(parseRanges('11-', 12)).toEqual([[10, 11]])
    expect(parseRanges('1-3, x', 12)).toBeNull()
  })

  it('writes pages back in the short form', () => {
    expect(formatPageList([0, 1, 2, 4, 7, 8, 9])).toBe('1-3, 5, 8-10')
    expect(formatPageList([3])).toBe('4')
  })
})

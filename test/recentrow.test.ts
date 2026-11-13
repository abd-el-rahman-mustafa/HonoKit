import { describe, expect, it } from 'vitest'
import { recentRowActions } from '@shared/recent'

describe('Home › Recent: what a row offers', () => {
  it('shows a file in its folder, and removes it from the list', () => {
    expect(recentRowActions({ size: 1200 })).toEqual(['folder', 'remove'])
  })

  it('offers the folder before the file facts arrive', () => {
    expect(recentRowActions(undefined)).toEqual(['folder', 'remove'])
  })

  it('only removes a file that is no longer there', () => {
    expect(recentRowActions({ size: null })).toEqual(['remove'])
  })
})

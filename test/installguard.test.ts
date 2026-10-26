import { describe, expect, it } from 'vitest'
import { mayInstallUpdate, type UnsavedState } from '../src/main/installguard'

/**
 * Installing an update quits the app. While documents have unsaved changes it must ask first, or
 * "Restart now" throws the work away without a word.
 */

const prompt = { title: 'Unsaved changes', message: 'Close without saving?', discard: 'Close without saving', cancel: 'Cancel' }
const state = (count: number): UnsavedState => ({ count, prompt })

describe('installing an update while documents have unsaved changes', () => {
  it('installs at once when nothing is unsaved, without asking', () => {
    let asked = 0
    expect(
      mayInstallUpdate(state(0), () => {
        asked++
        return false
      })
    ).toBe(true)
    expect(asked).toBe(0)
  })

  it('is held back when the person does not want to discard the changes', () => {
    const seen: Array<typeof prompt> = []
    expect(
      mayInstallUpdate(state(2), (p) => {
        seen.push(p)
        return false
      })
    ).toBe(false)
    // Asked in the same words as closing the window, which the interface has translated.
    expect(seen).toEqual([prompt])
  })

  it('installs when the person chooses to discard the changes', () => {
    expect(mayInstallUpdate(state(1), () => true)).toBe(true)
  })
})

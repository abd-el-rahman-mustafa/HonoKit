import { describe, expect, it } from 'vitest'
import { keysLeavePageAlone, modalIsOpen, type KeyScope } from '@shared/pagekeys'

// A key pressed while a dialog or a menu is open belongs to it: Delete must not remove the
// comment or picture selected on the page underneath.

function scope(open: string[], focused?: { tagName: string; isContentEditable?: boolean }): KeyScope {
  return {
    activeElement: (focused as Element | undefined) ?? null,
    querySelector: (selector: string) => (selector.split(',').some((s) => open.includes(s.trim())) ? ({} as Element) : null)
  }
}

describe('keys under a dialog or a menu', () => {
  it('reach the page when nothing covers it and no field has focus', () => {
    expect(keysLeavePageAlone(scope([], { tagName: 'BUTTON' }))).toBe(false)
    expect(keysLeavePageAlone(scope([]))).toBe(false)
  })

  it('stay with a field being typed in', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(keysLeavePageAlone(scope([], { tagName }))).toBe(true)
    expect(keysLeavePageAlone(scope([], { tagName: 'DIV', isContentEditable: true }))).toBe(true)
  })

  it('stay with an open dialog, even when its focus is on a button', () => {
    expect(keysLeavePageAlone(scope(['[aria-modal="true"]'], { tagName: 'BUTTON' }))).toBe(true)
    expect(modalIsOpen(scope(['[aria-modal="true"]']))).toBe(true)
  })

  it('stay with an open menu or drop-down list', () => {
    expect(keysLeavePageAlone(scope(['[role="menu"]']))).toBe(true)
    expect(keysLeavePageAlone(scope(['[data-select-list]']))).toBe(true)
    // A menu is not a dialog: shortcuts such as Ctrl+S still work while it is open.
    expect(modalIsOpen(scope(['[role="menu"]']))).toBe(false)
  })
})

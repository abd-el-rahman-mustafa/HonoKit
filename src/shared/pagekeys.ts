/**
 * Who a key press belongs to. The page's own keys (Delete removes the selected comment or picture,
 * Esc lets go of it) are window listeners; a key pressed while a dialog or a menu is open belongs
 * to that dialog or menu, as in Acrobat, even when its focus is on a button rather than a field.
 */

/** The parts of `document` this needs, so it can be tested without a browser. */
export type KeyScope = Pick<Document, 'activeElement' | 'querySelector'>

/** A modal dialog is open (every dialog carries aria-modal="true"). */
export const modalIsOpen = (scope: KeyScope = document): boolean => !!scope.querySelector('[aria-modal="true"]')

/** A menu or a drop-down list is open. */
export const menuIsShown = (scope: KeyScope = document): boolean => !!scope.querySelector('[role="menu"], [data-select-list]')

/** A field has the focus, so keys like Delete edit its text. */
export function typingInField(scope: KeyScope = document): boolean {
  const el = scope.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable)
}

/** True when a key must not act on the page: a field, a dialog or a menu has it. */
export const keysLeavePageAlone = (scope: KeyScope = document): boolean => typingInField(scope) || modalIsOpen(scope) || menuIsShown(scope)

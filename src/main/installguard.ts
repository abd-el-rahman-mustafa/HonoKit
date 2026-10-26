/** What the interface last reported about documents with unsaved changes. */
export interface UnsavedState {
  count: number
  prompt: { title: string; message: string; discard: string; cancel: string }
}

/**
 * Whether an update may be installed now. Installing quits the app, so unsaved changes would be
 * thrown away without a word: while any document has them the person is asked first, in the same
 * words as closing the window, and the install is held back unless they choose to discard.
 */
export function mayInstallUpdate(unsaved: UnsavedState, ask: (prompt: UnsavedState['prompt']) => boolean): boolean {
  if (unsaved.count === 0) return true
  return ask(unsaved.prompt)
}

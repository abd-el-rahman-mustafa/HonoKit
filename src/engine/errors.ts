export type PdfErrorCode =
  | 'not-pdf'
  | 'password-required'
  | 'wrong-password'
  /** The file's author does not allow this change; the permissions password lifts it. */
  | 'restricted'
  | 'corrupt'
  | 'bad-arguments'
  | 'unsupported'
  /** An edit was cancelled because it would have moved or left behind other text on the page (§58). */
  | 'edit-unsafe'
  /** The change would rewrite a digitally signed file and break its signatures. */
  | 'signed'
  | 'cancelled'

/** An error the interface can explain to a person; anything else is a bug. */
export class PdfError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PdfError'
  }
}

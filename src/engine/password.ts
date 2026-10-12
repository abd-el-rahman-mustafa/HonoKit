/**
 * AES-256 passwords (revision 6) are keyed on the password after SASLprep (ISO 32000-2
 * 7.6.4.3.3): characters that read as nothing are dropped, other spaces become a plain space, and
 * the text is NFKC-normalised. Acrobat does this; MuPDF uses the bytes as typed. So a password
 * with a no-break space, a soft hyphen, a zero-width joiner or a decomposed accent opened in one
 * and not the other.
 *
 * This is the mapping and normalisation part of SASLprep; a password it would refuse (bidi rules,
 * prohibited characters) is used as typed, as other readers fall back to.
 */

const NOTHING = /[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/g
const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g

export function preparedPassword(password: string): string {
  return password.replace(NOTHING, '').replace(SPACES, ' ').normalize('NFKC')
}

/** The bytes a reader keys the file on: the prepared password's UTF-8, of which only 127 count. */
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(preparedPassword(password)).length
}

/** Tries the password as typed, then prepared (a file written by Acrobat from the same text). */
export function authenticate(pdf: { authenticatePassword(p: string): number }, password: string): number {
  const typed = pdf.authenticatePassword(password)
  if (typed) return typed
  const prepared = preparedPassword(password)
  return prepared !== password ? pdf.authenticatePassword(prepared) : 0
}

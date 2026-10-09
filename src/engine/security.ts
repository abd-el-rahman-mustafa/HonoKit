import { randomBytes } from 'node:crypto'
import { PdfError } from './errors'
import { free, isSigned, openPdf, saveBytes, SAVE_FINAL, type PdfDoc } from './mupdf'

/** PDF permission bits (ISO 32000-1 table 22). Bits 7-8 and 13-32 are reserved and must be set. */
const P = { print: 1 << 2, modify: 1 << 3, copy: 1 << 4, annotate: 1 << 5, fillForms: 1 << 8, accessibility: 1 << 9, assemble: 1 << 10, printHq: 1 << 11 }

export interface ProtectOptions {
  userPassword: string
  ownerPassword?: string
  allowPrint: boolean
  allowCopy: boolean
  allowModify: boolean
  allowAnnotate: boolean
}

export function permissionsValue(o: Pick<ProtectOptions, 'allowPrint' | 'allowCopy' | 'allowModify' | 'allowAnnotate'>): number {
  let value = 0xfffff0c0 | P.accessibility
  if (o.allowPrint) value |= P.print | P.printHq
  if (o.allowCopy) value |= P.copy
  if (o.allowModify) value |= P.modify | P.assemble
  if (o.allowAnnotate) value |= P.annotate | P.fillForms
  return value | 0 // signed 32-bit, as the file stores it
}

/**
 * MuPDF takes write options as one comma-separated string with no escaping, so a
 * comma inside a password would split it (MuPDF then fails with "Unused pdf
 * arguments found"). Refuse it up front with a reason a person can act on.
 */
function assertUsablePassword(password: string, which: string): void {
  if (password.includes(',')) throw new PdfError('bad-arguments', `The ${which} password cannot contain a comma.`)
  if (password.length > 127) throw new PdfError('bad-arguments', `The ${which} password is too long (127 characters at most).`)
}

/**
 * Encrypts with AES-256.
 *
 * Without an owner password a random one is generated. Using the user password
 * for both would make the permission switches meaningless: whoever can open the
 * file would also be its owner, and readers grant the owner everything.
 */
/**
 * Encryption is a property of the whole file, so it cannot be appended: saveBytes keeps a signed
 * file incremental (§53) and the encrypt options were dropped — Protect reported success and the
 * file opened without a password (found 2026-10-08). Refused, as Acrobat does.
 */
function refuseSigned(doc: PdfDoc): void {
  if (isSigned(doc)) throw new PdfError('signed', 'This file is digitally signed; changing its password would break the signatures.')
}

export function protectPdf(bytes: Uint8Array, o: ProtectOptions, password?: string): Uint8Array {
  // An open password, or only a permissions password (the file opens for anyone, and only
  // that password lifts the restrictions) — Acrobat's Viewing and Editing modes.
  if (!o.userPassword && !o.ownerPassword) throw new PdfError('bad-arguments', 'A password is required.')
  if (o.userPassword) assertUsablePassword(o.userPassword, 'open')
  if (o.ownerPassword) assertUsablePassword(o.ownerPassword, 'permissions')
  const owner = o.ownerPassword || randomBytes(24).toString('base64url')
  const doc = openPdf(bytes, password)
  try {
    refuseSigned(doc)
    const options = [SAVE_FINAL, 'encrypt=aes-256', `user-password=${o.userPassword}`, `owner-password=${owner}`, `permissions=${permissionsValue(o)}`].join(',')
    return saveBytes(doc, options)
  } finally {
    free(doc)
  }
}

/** Opens with `password` and writes an unencrypted copy. */
export function unlockPdf(bytes: Uint8Array, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    refuseSigned(doc)
    return saveBytes(doc, `${SAVE_FINAL},encrypt=none`)
  } finally {
    free(doc)
  }
}

export function isEncrypted(bytes: Uint8Array): boolean {
  try {
    const doc = openPdf(bytes)
    free(doc)
    return false
  } catch (error) {
    return error instanceof PdfError && error.code === 'password-required'
  }
}

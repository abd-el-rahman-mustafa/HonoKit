import { describe, expect, it } from 'vitest'
import { createDigitalId, loadDigitalId } from '@engine/sign'

/** One DER element: tag byte, where its content starts and ends. */
function tlv(b: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = b[at]!
  let len = b[at + 1]!
  let start = at + 2
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i]!
    start += n
  }
  return { tag, start, end: start + len }
}

function children(b: Uint8Array, start: number, end: number): Array<{ tag: number; start: number; end: number; at: number }> {
  const out = []
  for (let at = start; at < end; ) {
    const t = tlv(b, at)
    out.push({ ...t, at })
    at = t.end
  }
  return out
}

const cat = (...parts: Array<Uint8Array | number[]>): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]))
const indefinite = (tag: number, body: Uint8Array): Uint8Array => cat([tag, 0x80], body, [0, 0])

/**
 * The shape Windows writes a .pfx in (BER): the PFX, its ContentInfo and the [0] around the
 * AuthenticatedSafe in the indefinite length form, and the AuthenticatedSafe's OCTET STRING split
 * into segments. The MacData is kept: it covers the joined octets, which do not change.
 */
function windowsShape(der: Uint8Array): Uint8Array {
  const pfx = tlv(der, 0)
  const [version, authSafe, ...rest] = children(der, pfx.start, pfx.end)
  const [type, wrapped] = children(der, authSafe!.start, authSafe!.end)
  const octets = tlv(der, wrapped!.start)
  const data = der.subarray(octets.start, octets.end)
  const segments: Uint8Array[] = []
  for (let i = 0; i < data.length; i += 1000) {
    const part = data.subarray(i, i + 1000)
    segments.push(cat([0x04, 0x82, part.length >> 8, part.length & 0xff], part))
  }
  const contentInfo = indefinite(0x30, cat(der.subarray(type!.at, type!.end), indefinite(0xa0, indefinite(0x24, cat(...segments)))))
  return indefinite(0x30, cat(der.subarray(version!.at, version!.end), contentInfo, ...rest.map((r) => der.subarray(r.at, r.end))))
}

describe('digital IDs', () => {
  it('opens a .pfx written in BER, as Windows exports them', () => {
    const der = createDigitalId('Test Signer', 'signer@example.com', 'Test', 'secret12', 1)
    const ber = windowsShape(der)
    expect(ber[1]).toBe(0x80)
    const id = loadDigitalId(ber, 'secret12')
    expect(id.cert.subject.getField('CN').value).toBe('Test Signer')
    expect(() => loadDigitalId(ber, 'wrong')).toThrow()
  })
})

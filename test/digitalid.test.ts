import { describe, expect, it } from 'vitest'
import forge from 'node-forge'
import { createDigitalId, loadDigitalId, ID_ROUNDS, MIN_ID_PASSWORD } from '@engine/sign'

/**
 * Digital IDs (.pfx / .p12) are hardened (decisions §94): a new ID is written with many more
 * rounds of key derivation than the library's 2048, its password has a minimum length, and
 * opening an ID is charged a budget of rounds before any hashing, so a crafted file that asks
 * for billions of rounds is refused at once instead of stalling the password check for hours.
 */

const { asn1 } = forge
type Node = forge.asn1.Asn1

/** The DER of a .pfx, parsed. */
const parse = (bytes: Uint8Array): Node => asn1.fromDer(forge.util.createBuffer(Buffer.from(bytes).toString('binary')))
const encode = (node: Node): Uint8Array => new Uint8Array(Buffer.from(asn1.toDer(node).getBytes(), 'binary'))

/** Every iteration count in the file: an INTEGER right after an OCTET STRING salt, at any depth, inside nested DER too. */
function counts(node: Node, found: number[] = [], depth = 0): number[] {
  if (depth > 24) return found
  const kids = Array.isArray(node.value) ? (node.value as Node[]) : []
  kids.forEach((kid, i) => {
    const prev = kids[i - 1]
    if (kid.type === asn1.Type.INTEGER && prev && prev.type === asn1.Type.OCTETSTRING && !Array.isArray(prev.value)) found.push(asn1.derToInteger(forge.util.createBuffer(kid.value as string)))
    if (Array.isArray(kid.value)) counts(kid, found, depth + 1)
    else if (kid.type === asn1.Type.OCTETSTRING) {
      try {
        counts(asn1.fromDer(forge.util.createBuffer(kid.value as string)), found, depth + 1)
      } catch {
        /* not DER inside */
      }
    }
  })
  return found
}

/** The same walk, setting every iteration count to `n` and re-encoding the nested DER. */
function setCounts(node: Node, n: number, depth = 0): void {
  if (depth > 24) return
  const kids = Array.isArray(node.value) ? (node.value as Node[]) : []
  kids.forEach((kid, i) => {
    const prev = kids[i - 1]
    if (kid.type === asn1.Type.INTEGER && prev && prev.type === asn1.Type.OCTETSTRING && !Array.isArray(prev.value)) kid.value = asn1.integerToDer(n).getBytes()
    if (Array.isArray(kid.value)) setCounts(kid, n, depth + 1)
    else if (kid.type === asn1.Type.OCTETSTRING) {
      try {
        const inner = asn1.fromDer(forge.util.createBuffer(kid.value as string))
        setCounts(inner, n, depth + 1)
        kid.value = asn1.toDer(inner).getBytes()
      } catch {
        /* not DER inside */
      }
    }
  })
}

describe('digital IDs are hardened', () => {
  const password = 'secret-12'

  it('a new ID uses many rounds of key derivation for its key and its MAC', () => {
    // The certificates, which are public, are written in a plain safe; the key is encrypted.
    const p12 = createDigitalId('Test Signer', '', '', password, 1)
    const all = counts(parse(p12))
    expect(ID_ROUNDS).toBeGreaterThanOrEqual(100_000)
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.every((c) => c === ID_ROUNDS)).toBe(true)
    expect(loadDigitalId(p12, password).cert).toBeTruthy()
  })

  it('a password shorter than the minimum is refused when creating, and any opens an existing ID', () => {
    expect(MIN_ID_PASSWORD).toBe(8)
    expect(() => createDigitalId('Test', '', '', 'short7!')).toThrow(/8 characters/)
    expect(() => createDigitalId('Test', '', '', 'عربي١٢٣٤')).not.toThrow()
  })

  it('an ID whose MAC asks for too many rounds is refused before any work', () => {
    const pfx = parse(createDigitalId('Test', '', '', password, 1))
    // PFX ::= SEQUENCE { version, authSafe, macData SEQUENCE { mac, macSalt OCTET STRING, iterations INTEGER } }
    const mac = (pfx.value as Node[])[2]!
    ;(mac.value as Node[])[2]!.value = asn1.integerToDer(2_000_000_000).getBytes()
    const started = Date.now()
    expect(() => loadDigitalId(encode(pfx), password)).toThrow(/rounds/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('an ID whose encrypted parts ask for too many rounds is refused, with or without a MAC', () => {
    const pfx = parse(createDigitalId('Test', '', '', password, 1))
    // Without the MAC, so the first work would be decrypting the safe contents.
    pfx.value = (pfx.value as Node[]).slice(0, 2)
    setCounts(pfx, 2_000_000_000)
    expect(counts(pfx).length).toBeGreaterThanOrEqual(1)
    const started = Date.now()
    expect(() => loadDigitalId(encode(pfx), password)).toThrow(/rounds/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('the budget covers the whole file: many moderate counts add up and are refused too', () => {
    const pfx = parse(createDigitalId('Test', '', '', password, 1))
    pfx.value = (pfx.value as Node[]).slice(0, 2)
    // Each part under the budget on its own, but together past it.
    setCounts(pfx, 6_000_000)
    expect(() => loadDigitalId(encode(pfx), password)).toThrow(/rounds/)
  })

  it('a wrong password is still reported as such', () => {
    const p12 = createDigitalId('Test', '', '', password, 1)
    expect(() => loadDigitalId(p12, 'not-it-123')).toThrow(/password/)
  })
})

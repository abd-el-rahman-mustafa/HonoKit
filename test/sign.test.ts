import { describe, expect, it } from 'vitest'
import { createDigitalId, loadDigitalId, commonName, signWithCertificate, verifySignatures } from '@engine/sign'
import { free, openPdf, saveBytes } from '@engine/mupdf'
import { applyOperation } from '@ops/index'
import { makeLatinPdf } from './fixtures'

const LABELS = { signedBy: 'Digitally signed', date: '2026-09-30' }

describe('certificate signatures', () => {
  it('makes a digital ID with an Arabic name and opens it again', () => {
    const p12 = createDigitalId('أحمد علي', 'ahmed@example.ae', 'شركة المثال', 'secret12')
    const id = loadDigitalId(p12, 'secret12')
    expect(commonName(id.cert)).toBe('أحمد علي')
    expect(() => loadDigitalId(p12, 'wrong')).toThrow(/password/)
  })

  it('signs, verifies, keeps the signature valid through later comments, and signs twice', async () => {
    const p12 = createDigitalId('أحمد علي', '', '', 'secret12')
    const src = await makeLatinPdf(2)
    const signed = await signWithCertificate(src, { p12, password: 'secret12', page: 0, box: [200, 480, 380, 540], reason: 'Approved', location: 'Dubai', labels: LABELS })
    // The original bytes are untouched at the start of the signed file (an incremental update).
    expect(Buffer.from(signed.subarray(0, src.length)).equals(Buffer.from(src))).toBe(true)
    let sigs = await verifySignatures(signed)
    expect(sigs).toHaveLength(1)
    expect(sigs[0]!.valid).toBe(true)
    expect(sigs[0]!.modifiedAfter).toBe(false)
    expect(sigs[0]!.name).toBe('أحمد علي')
    expect(sigs[0]!.selfSigned).toBe(true)
    // A comment afterwards: appended, the signature still checks and says content came later.
    const commented = await applyOperation(signed, { op: 'markup', page: 1, markup: { kind: 'note', at: [50, 50], text: 'after signing', colour: '#facc15' } })
    sigs = await verifySignatures(commented.bytes)
    expect(sigs[0]!.valid).toBe(true)
    expect(sigs[0]!.modifiedAfter).toBe(true)
    // Saved as "Save" does: still valid.
    const doc = openPdf(commented.bytes)
    const saved = saveBytes(doc, 'garbage=deduplicate,compress,objstms')
    free(doc)
    expect((await verifySignatures(saved))[0]!.valid).toBe(true)
    // A second signature: both valid.
    const twice = await signWithCertificate(saved, { p12, password: 'secret12', page: 1, box: [200, 300, 380, 360], labels: LABELS })
    sigs = await verifySignatures(twice)
    expect(sigs).toHaveLength(2)
    expect(sigs.every((s) => s.valid)).toBe(true)
  }, 60_000)

  it('notices when signed bytes were changed', async () => {
    const p12 = createDigitalId('Test', '', '', 'xxxxxxxx')
    const signed = await signWithCertificate(await makeLatinPdf(1), { p12, password: 'xxxxxxxx', page: 0, box: [100, 100, 300, 160], labels: LABELS })
    const tampered = Buffer.from(signed)
    // One byte early in the file (inside the signed range).
    tampered[40] = tampered[40]! ^ 0x01
    expect((await verifySignatures(new Uint8Array(tampered)))[0]!.valid).toBe(false)
  }, 60_000)
})

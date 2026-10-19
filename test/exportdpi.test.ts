import { describe, expect, it } from 'vitest'
import { pdfToImages } from '@engine/images'
import { makeLatinPdf } from './fixtures'

/** The JFIF density of a JPEG in dots per inch, or null when it records none. */
function jpegDpi(data: Uint8Array): [number, number] | null {
  for (let i = 2; i + 4 < data.length && data[i] === 0xff; ) {
    const marker = data[i + 1]!
    const length = (data[i + 2]! << 8) | data[i + 3]!
    if (marker === 0xe0 && String.fromCharCode(...data.subarray(i + 4, i + 8)) === 'JFIF') {
      const units = data[i + 11]
      const x = (data[i + 12]! << 8) | data[i + 13]!
      const y = (data[i + 14]! << 8) | data[i + 15]!
      if (units === 1) return [x, y]
      if (units === 2) return [Math.round(x * 2.54), Math.round(y * 2.54)]
      return null
    }
    i += 2 + length
  }
  return null
}

/** The pHYs resolution of a PNG in dots per inch, or null when it records none. */
function pngDpi(data: Uint8Array): [number, number] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let i = 8; i + 8 < data.length; ) {
    const length = view.getUint32(i)
    const type = String.fromCharCode(...data.subarray(i + 4, i + 8))
    if (type === 'pHYs' && data[i + 16] === 1) return [Math.round(view.getUint32(i + 8) * 0.0254), Math.round(view.getUint32(i + 12) * 0.0254)]
    i += 12 + length
  }
  return null
}

describe('exported pages record the resolution they were drawn at', () => {
  it('a JPEG and a PNG at 300 dpi say 300 dpi', async () => {
    const pdf = await makeLatinPdf(1)
    const [jpeg] = pdfToImages(pdf, [0], 'jpeg', 300)
    expect(jpegDpi(jpeg!.data)).toEqual([300, 300])
    const [png] = pdfToImages(pdf, [0], 'png', 150)
    expect(pngDpi(png!.data)).toEqual([150, 150])
  })
})

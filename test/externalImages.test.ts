import { describe, expect, it } from 'vitest'
import { openPicture, encode } from '@engine/img/picture'

/**
 * Real pictures from this PC (decisions §69), read where they are and never copied into the
 * repository. Opt-in: POWERPDF_TEST_IMAGES holds the paths, separated by "|".
 *   POWERPDF_TEST_IMAGES="E:\a.dng|C:\b.jfif" npx vitest run test/externalImages.test.ts
 * Each file is opened, turned into a 512 px JPEG and PNG, and its timings printed.
 */
const files = (process.env.POWERPDF_TEST_IMAGES ?? '').split('|').filter(Boolean)

describe.skipIf(files.length === 0)('real pictures', () => {
  for (const path of files) {
    it(path, async () => {
      const t0 = performance.now()
      const picture = await openPicture(path)
      const t1 = performance.now()
      expect(picture.width).toBeGreaterThan(0)
      const jpg = await encode(picture.pipeline().resize(512, 512, { fit: 'inside' }), { format: 'jpg' })
      const png = await encode(picture.pipeline().resize(512, 512, { fit: 'inside' }), { format: 'png' })
      const t2 = performance.now()
      expect(jpg.data.length).toBeGreaterThan(100)
      expect(png.data.length).toBeGreaterThan(100)
      console.log(`${picture.format} ${picture.width}×${picture.height} ×${picture.frames} alpha=${picture.hasAlpha} open ${Math.round(t1 - t0)} ms, encode ${Math.round(t2 - t1)} ms — ${path}`)
    })
  }
})

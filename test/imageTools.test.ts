import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { animatePictures, describeImage, readMetadata, runImageJob } from '@engine/img/tools'
import { resizedSize } from '@shared/imageOps'
import { openBytes } from '@engine/img/picture'

/** Pictures made here, in a temporary folder (no personal files). */
const folder = mkdtempSync(join(tmpdir(), 'honopdf-img-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

async function photo(name: string, width = 800, height = 600): Promise<string> {
  // Noise compresses like a photo; a red block marks the top-left corner.
  const noise = Buffer.alloc(width * height * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  const base = await sharp(noise, { raw: { width, height, channels: 3 } })
    .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }, left: 0, top: 0 }])
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Make: 'TestCam', Model: 'Model X' } })
    .toBuffer()
  const path = join(folder, name)
  writeFileSync(path, base)
  return path
}

async function gif(name: string): Promise<string> {
  const frames = await Promise.all(['#e11d48', '#16a34a', '#1473e6'].map((c) => sharp({ create: { width: 60, height: 40, channels: 4, background: c } }).png().toBuffer()))
  const path = join(folder, name)
  writeFileSync(path, await sharp(frames, { join: { animated: true } }).gif({ delay: [300, 300, 300], loop: 0 }).toBuffer())
  return path
}

const red = async (data: Buffer, x: number, y: number): Promise<boolean> => {
  const { data: px, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return px[i]! > 200 && px[i + 1]! < 60 && px[i + 2]! < 60
}

describe('resize sizes', () => {
  it('max keeps the shape; exact does not; no enlarging', () => {
    expect(resizedSize(800, 600, { by: 'pixels', width: 400, height: null, fit: 'max', noEnlarge: false })).toEqual({ width: 400, height: 300 })
    expect(resizedSize(800, 600, { by: 'pixels', width: 400, height: 400, fit: 'max', noEnlarge: false })).toEqual({ width: 400, height: 300 })
    expect(resizedSize(800, 600, { by: 'pixels', width: 400, height: 400, fit: 'exact', noEnlarge: false })).toEqual({ width: 400, height: 400 })
    expect(resizedSize(800, 600, { by: 'pixels', width: 2000, height: null, fit: 'max', noEnlarge: true })).toEqual({ width: 800, height: 600 })
    expect(resizedSize(800, 600, { by: 'percent', percent: 25 })).toEqual({ width: 200, height: 150 })
    expect(resizedSize(800, 600, { by: 'longest', pixels: 1000, noEnlarge: true })).toEqual({ width: 800, height: 600 })
  })
})

describe('jobs', () => {
  it('converts to every common target, keeping .jfif when asked', async () => {
    const p = await photo('a.jfif')
    const same = await runImageJob(p, { output: { format: 'same' } })
    expect(same.format).toBe('jpg')
    expect(same.ext).toBe('jfif')
    const png = await runImageJob(p, { output: { format: 'png' } })
    expect(png.ext).toBe('png')
    const jpeg = await runImageJob(p, { output: { format: 'jpg', ext: 'jpeg' } })
    expect(jpeg.ext).toBe('jpeg')
  })

  it('resizes, crops and rotates in that order of meaning', async () => {
    const p = await photo('b.jpg')
    const out = await runImageJob(p, { crop: { by: 'box', x: 0, y: 0, width: 0.5, height: 0.5 }, rotate: { angle: 90, flipH: false, flipV: false }, resize: { by: 'percent', percent: 50 }, output: { format: 'png' } })
    // 400×300 crop → turned 300×400 → half: 150×200; the red corner is now top-right.
    expect([out.width, out.height]).toEqual([150, 200])
    expect(await red(out.data, 145, 5)).toBe(true)
    expect(await red(out.data, 5, 5)).toBe(false)
  })

  it('crops to a shape', async () => {
    const p = await photo('c.jpg')
    const out = await runImageJob(p, { crop: { by: 'ratio', ratio: 1, position: 'left' }, output: { format: 'png' } })
    expect([out.width, out.height]).toEqual([600, 600])
    expect(await red(out.data, 5, 5)).toBe(true)
    const smart = await runImageJob(p, { crop: { by: 'ratio', ratio: 16 / 9, position: 'smart' }, output: { format: 'jpg' } })
    expect(smart.width).toBe(800)
  })

  it('flips', async () => {
    const p = await photo('d.jpg')
    const out = await runImageJob(p, { rotate: { angle: 0, flipH: true, flipV: false }, output: { format: 'png' } })
    expect(await red(out.data, 795, 5)).toBe(true)
  })

  it('reaches a target size by lowering the quality', async () => {
    const p = await photo('e.jpg', 1200, 900)
    const free = await runImageJob(p, { output: { format: 'jpg', quality: 90 } })
    const target = Math.round(free.data.length / 3)
    const out = await runImageJob(p, { output: { format: 'jpg', targetBytes: target } })
    expect(out.data.length).toBeLessThanOrEqual(target)
    expect(out.quality).toBeLessThan(90)
  })

  it('strips metadata unless asked to keep it', async () => {
    const p = await photo('f.jpg')
    const stripped = await runImageJob(p, { output: { format: 'jpg' } })
    expect((await sharp(stripped.data).metadata()).exif).toBeUndefined()
    const kept = await runImageJob(p, { output: { format: 'jpg', keepMetadata: true } })
    expect((await sharp(kept.data).metadata()).exif).toBeDefined()
  })

  it('keeps an animation through resize and rotate, to WebP', async () => {
    const p = await gif('g.gif')
    const out = await runImageJob(p, { resize: { by: 'percent', percent: 50 }, rotate: { angle: 90, flipH: false, flipV: false }, output: { format: 'webp' } })
    expect(out.frames).toBe(3)
    expect([out.width, out.height]).toEqual([20, 30])
    const still = await runImageJob(p, { output: { format: 'jpg' } })
    expect(still.frames).toBe(1)
  })

  it('makes an animated GIF from pictures', async () => {
    const a = await photo('h1.jpg', 200, 100)
    const b = await photo('h2.jpg', 100, 200)
    const out = await animatePictures([a, b], { format: 'gif', delay: 500, loop: true, width: 120, height: 80, fit: 'contain', background: '#ffffff' })
    const back = await openBytes(out.data, 'x.gif')
    expect(back.frames).toBe(2)
    expect([back.width, back.height]).toEqual([120, 80])
    expect(back.delays[0]).toBe(500)
  })

  it('describes any picture with a preview, and reads EXIF', async () => {
    const p = await photo('i.jpg')
    const info = await describeImage(p)
    expect(info.preview.startsWith('data:image/webp;base64,')).toBe(true)
    expect([info.width, info.height]).toEqual([800, 600])
    const meta = await readMetadata(p)
    expect(meta.groups.flatMap((g) => g.entries).some(([k, v]) => k === 'Make' && v === 'TestCam')).toBe(true)
  })
})

describe('watermark marks', () => {
  const stamp = async (): Promise<string> => (await sharp({ create: { width: 200, height: 50, channels: 4, background: '#ff0000' } }).png().toBuffer()).toString('base64')

  it('places a mark by its centre, scaled to the picture width, with opacity', async () => {
    const p = await photo('w1.jpg', 800, 600)
    const out = await runImageJob(p, { marks: { layers: [{ source: { png: await stamp() }, x: 0.5, y: 0.5, width: 0.25, rotate: 0, opacity: 1 }] }, output: { format: 'png' } })
    // 25% of 800 = 200 wide, 50 high, centred: (300…500, 275…325).
    expect(await red(out.data, 400, 300)).toBe(true)
    expect(await red(out.data, 290, 300)).toBe(false)
    expect(await red(out.data, 400, 340)).toBe(false)
  })

  it('cuts a mark that overflows the edge instead of failing', async () => {
    const p = await photo('w2.jpg', 400, 300)
    const out = await runImageJob(p, { marks: { layers: [{ source: { png: await stamp() }, x: 1, y: 0, width: 0.5, rotate: 30, opacity: 0.5 }] }, output: { format: 'png' } })
    expect([out.width, out.height]).toEqual([400, 300])
  })

  it('tiles a mark over the whole picture', async () => {
    const p = await photo('w3.jpg', 800, 600)
    const out = await runImageJob(p, { marks: { layers: [{ source: { png: await stamp() }, x: 0.5, y: 0.5, width: 0.1, rotate: 0, opacity: 1, tile: { gap: 1 } }] }, output: { format: 'png' } })
    // Tiles of 80×20 with a 40×10 border each side: the first mark covers (40…120, 10…30).
    expect(await red(out.data, 80, 20)).toBe(true)
    expect(await red(out.data, 80 + 160, 20 + 40)).toBe(true)
  })

  it('adds meme bands above and below', async () => {
    const p = await photo('w4.jpg', 400, 300)
    const out = await runImageJob(p, { marks: { layers: [], bands: { top: 0.2, bottom: 0.1, colour: '#ffffff' } }, output: { format: 'png' } })
    expect([out.width, out.height]).toEqual([400, 390])
  })

  it('keeps an animation under a mark', async () => {
    const p = await gif('w5.gif')
    const out = await runImageJob(p, { marks: { layers: [{ source: { png: await stamp() }, x: 0.5, y: 0.5, width: 0.5, rotate: 0, opacity: 1 }] }, output: { format: 'gif' } })
    expect(out.frames).toBe(3)
  })
})

describe('offline AI', () => {
  it('upscales ×2 and ×4 through a job, keeping transparency', async () => {
    const png = join(folder, 'ai1.png')
    writeFileSync(png, await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } }).png().toBuffer())
    const two = await runImageJob(png, { ai: { upscale: 2 }, output: { format: 'png' } })
    expect([two.width, two.height]).toEqual([80, 60])
    const four = await runImageJob(png, { ai: { upscale: 4 }, output: { format: 'png' } })
    expect([four.width, four.height]).toEqual([160, 120])
    const { data } = await sharp(four.data).raw().toBuffer({ resolveWithObject: true })
    expect(Math.abs(data[3]! - 128)).toBeLessThan(10)
  })

  it('removes a background: a plain backdrop becomes transparent', async () => {
    const p = join(folder, 'ai2.png')
    writeFileSync(p, await sharp({ create: { width: 320, height: 320, channels: 3, background: '#eeeeee' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><circle cx="160" cy="170" r="90" fill="#c0392b"/></svg>') }]).png().toBuffer())
    const out = await runImageJob(p, { ai: { background: { colour: null } }, output: { format: 'png' } })
    const { data, info } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true })
    const alpha = (x: number, y: number): number => data[(y * info.width + x) * info.channels + 3]!
    expect(alpha(5, 5)).toBeLessThan(60)
    expect(alpha(160, 170)).toBeGreaterThan(200)
  })

  it('hides regions with blur, pixels or a black box', async () => {
    const p = await photo('ai3.jpg', 400, 300)
    // Detail in an area: how much neighbouring pixels differ (the photo is noise there).
    const detail = async (png: Buffer): Promise<number> => {
      const { data, info } = await sharp(png).extract({ left: 220, top: 120, width: 60, height: 60 }).greyscale().raw().toBuffer({ resolveWithObject: true })
      let sum = 0
      for (let i = 1; i < data.length; i++) if (i % info.width) sum += Math.abs(data[i]! - data[i - 1]!)
      return sum / data.length
    }
    const before = await detail(await sharp(p).png().toBuffer())
    const region = { x: 0.5, y: 0.33, w: 0.25, h: 0.33, kind: 'manual' as const }
    for (const style of ['blur', 'pixelate'] as const) {
      const out = await runImageJob(p, { ai: { hide: { regions: [region], style, strength: 60 } }, output: { format: 'png' } })
      expect(await detail(out.data)).toBeLessThan(before / 3)
    }
    const box = await runImageJob(p, { ai: { hide: { regions: [region], style: 'box', strength: 0 } }, output: { format: 'png' } })
    const { data } = await sharp(box.data).extract({ left: 240, top: 140, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]! + data[1]! + data[2]!).toBeLessThan(10)
  })
})

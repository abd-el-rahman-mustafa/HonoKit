import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { AI_MODELS, useModelDirectory } from '@engine/img/ai'
import { describeImage, runImageJob, upscaleStep } from '@engine/img/tools'
import type { ImageJob } from '@shared/imageOps'
import { compareMode, resultFacts } from '@shared/imageResults'
import { imageAnimate, imageRun, imageSaveEdited, replaceable } from '../src/worker/images'
import { WrittenFiles } from '../src/main/written'

/**
 * Image tool results (decisions §77): "Try again" replaces this session's earlier result and leaves
 * no superseded file; the result says how it was made (AI or a smooth resize, honestly); the facts
 * the result screen shows. Pictures are made here with sharp, in several formats.
 */

const root = mkdtempSync(join(tmpdir(), 'honokit-results-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => useModelDirectory(null))

let n = 0
const folder = (): string => {
  const f = join(root, `case-${n++}`)
  mkdirSync(f)
  return f
}

/** A drawn scene with edges, letters and gradients, like a photo of a sign. */
const scene = (w: number, h: number): Buffer =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa0e6"/><stop offset="1" stop-color="#f3d9a4"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#s)"/>
  <circle cx="${w * 0.75}" cy="${h * 0.3}" r="${h * 0.15}" fill="#ffd23f"/>
  <rect x="${w * 0.08}" y="${h * 0.45}" width="${w * 0.55}" height="${h * 0.32}" fill="#1f2937" rx="8"/>
  <text x="${w * 0.12}" y="${h * 0.6}" font-size="${h * 0.09}" font-family="Arial" fill="#fff">HonoKit 2026</text>
  <text x="${w * 0.12}" y="${h * 0.72}" font-size="${h * 0.06}" font-family="Arial" fill="#facc15">Upscale · Sharp edges</text>
  ${Array.from({ length: 12 }, (_, i) => `<line x1="${w * 0.66 + i * 6}" y1="${h * 0.5}" x2="${w * 0.66 + i * 6}" y2="${h * 0.9}" stroke="#111" stroke-width="2"/>`).join('')}
</svg>`)

async function jpgRotated(dir: string): Promise<string> {
  // Stored 600 × 400 with EXIF orientation 6: upright it is 400 × 600.
  const path = join(dir, 'phone photo.jpg')
  await sharp(scene(600, 400)).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toFile(path)
  return path
}
async function pngAlpha(dir: string): Promise<string> {
  const path = join(dir, 'logo.png')
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><circle cx="160" cy="160" r="140" fill="#7c3aed"/><text x="160" y="190" font-size="96" text-anchor="middle" fill="#fff" font-family="Arial">Ho</text></svg>')).png().toFile(path)
  return path
}
async function webp(dir: string): Promise<string> {
  const path = join(dir, 'street.webp')
  await sharp(scene(640, 480)).webp({ quality: 90 }).toFile(path)
  return path
}
async function avif(dir: string): Promise<string> {
  const path = join(dir, 'garden.avif')
  await sharp(scene(480, 320)).avif({ quality: 70 }).toFile(path)
  return path
}

const compress = (quality: number): ImageJob => ({ output: { format: 'same', quality, neverLarger: true } })
const convert = (format: 'webp' | 'png' | 'jpg'): ImageJob => ({ output: { format, quality: 85 } })
const base = (dir: string, stem: string): string => join(dir, stem)

/** Laplacian variance: higher is sharper. */
async function sharpness(png: Buffer | string): Promise<number> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  let s = 0
  let s2 = 0
  let count = 0
  for (let y = 1; y < info.height - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!
      s += v
      s2 += v * v
      count++
    }
  return s2 / count - (s / count) ** 2
}

describe('try again: replacing the earlier result', () => {
  it('only a result of the same picture and tool can be replaced, never the source', () => {
    const dir = folder()
    const b = base(dir, 'photo (compressed)')
    for (const name of ['photo (compressed).jpg', 'photo (compressed) (2).webp']) writeFileSync(join(dir, name), 'x')
    writeFileSync(join(dir, 'photo.jpg'), 'x')
    writeFileSync(join(dir, 'photo (compressed) copy.jpg'), 'x')
    expect(replaceable(b, join(dir, 'photo (compressed).jpg'), [join(dir, 'photo.jpg')])).toBe(join(dir, 'photo (compressed).jpg'))
    expect(replaceable(b, join(dir, 'photo (compressed) (2).webp'), [join(dir, 'photo.jpg')])).toBe(join(dir, 'photo (compressed) (2).webp'))
    expect(replaceable(b, join(dir, 'photo.jpg'), [join(dir, 'photo.jpg')])).toBeNull()
    expect(replaceable(b, join(dir, 'photo (compressed) copy.jpg'), [join(dir, 'photo.jpg')])).toBeNull()
    expect(replaceable(b, join(dir, 'missing (compressed).jpg'), [])).toBeNull()
    expect(replaceable(b, null, [])).toBeNull()
    // A source that happens to carry the suffix is still the source.
    expect(replaceable(b, join(dir, 'photo (compressed).jpg'), [join(dir, 'photo (compressed).jpg')])).toBeNull()
  })

  it('same format: the earlier file is overwritten in place; no second file', async () => {
    const dir = folder()
    const src = await webp(dir)
    const first = await imageRun(src, compress(90), base(dir, 'street (compressed)'))
    const again = await imageRun(src, compress(30), base(dir, 'street (compressed)'), first.path)
    expect(again.path).toBe(first.path)
    expect(again.replaced).toBe(first.path)
    expect(again.size).toBeLessThan(first.size)
    expect(statSync(again.path).size).toBe(again.size)
    expect(readdirSync(dir).sort()).toEqual(['street (compressed).webp', 'street.webp'])
  })

  it('another format: the new file is written, the superseded one removed', async () => {
    const dir = folder()
    const src = await jpgRotated(dir)
    const first = await imageRun(src, convert('webp'), base(dir, 'phone photo (converted)'))
    expect(first.path.endsWith('.webp')).toBe(true)
    const again = await imageRun(src, convert('png'), base(dir, 'phone photo (converted)'), first.path)
    expect(again.path.endsWith('.png')).toBe(true)
    expect(again.replaced).toBe(first.path)
    expect(existsSync(first.path)).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['phone photo (converted).png', 'phone photo.jpg'])
  })

  it('without an earlier result nothing is replaced: a second run gets a free name', async () => {
    const dir = folder()
    const src = await pngAlpha(dir)
    const a = await imageRun(src, compress(80), base(dir, 'logo (compressed)'))
    const b = await imageRun(src, compress(80), base(dir, 'logo (compressed)'))
    expect(b.path).not.toBe(a.path)
    expect(b.replaced).toBeUndefined()
    expect(existsSync(a.path)).toBe(true)
  })

  it('a run that fails leaves the earlier result as it was', async () => {
    const dir = folder()
    const src = await webp(dir)
    const first = await imageRun(src, compress(80), base(dir, 'street (compressed)'))
    const before = readFileSync(first.path)
    const broken = join(dir, 'street.webp')
    writeFileSync(broken, Buffer.from('not a picture at all'))
    await expect(imageRun(broken, compress(20), base(dir, 'street (compressed)'), first.path)).rejects.toThrow()
    expect(readFileSync(first.path).equals(before)).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('the source itself is never replaced, even when named', async () => {
    const dir = folder()
    const src = await webp(dir)
    const original = readFileSync(src)
    const r = await imageRun(src, convert('webp'), base(dir, 'street'), src)
    expect(r.replaced).toBeUndefined()
    expect(readFileSync(src).equals(original)).toBe(true)
    expect(r.path).not.toBe(src)
  })

  it('Make a GIF and the Photo editor replace their earlier file too', async () => {
    const dir = folder()
    const a = await webp(dir)
    const b = await avif(dir)
    const options = { format: 'gif' as const, delay: 500, loop: true, width: 200, height: 150, fit: 'contain' as const, background: '#ffffff' }
    const first = await imageAnimate([a, b], options, base(dir, 'Animation'))
    const again = await imageAnimate([a, b], { ...options, delay: 900 }, base(dir, 'Animation'), first.path)
    expect(again.path).toBe(first.path)
    expect(readdirSync(dir).filter((f) => f.startsWith('Animation'))).toEqual(['Animation.gif'])

    const png = new Uint8Array(await sharp(scene(300, 200)).png().toBuffer())
    const saved = await imageSaveEdited(png, a, { format: 'same', quality: 90 }, base(dir, 'street (edited)'))
    const resaved = await imageSaveEdited(png, a, { format: 'png' }, base(dir, 'street (edited)'), saved.path)
    expect(resaved.replaced).toBe(saved.path)
    expect(readdirSync(dir).filter((f) => f.includes('(edited)'))).toEqual(['street (edited).png'])
  })

  it('main honours a replace only for files this session wrote and nobody changed since', async () => {
    const dir = folder()
    const src = await webp(dir)
    const written = new WrittenFiles()
    const r = await imageRun(src, compress(70), base(dir, 'street (compressed)'))
    expect(written.replaceable(r.path)).toBeNull()
    written.remember(r.path)
    expect(written.replaceable(r.path)).toBe(r.path)
    expect(written.replaceable(r.path.toUpperCase())).toBe(r.path.toUpperCase())
    expect(written.replaceable(src)).toBeNull()
    // Changed in another app meanwhile: kept.
    utimesSync(r.path, new Date(), new Date(Date.now() + 5000))
    expect(written.replaceable(r.path)).toBeNull()
    written.remember(r.path)
    writeFileSync(r.path, Buffer.concat([readFileSync(r.path), Buffer.from([0])]))
    expect(written.replaceable(r.path)).toBeNull()
    written.forget(r.path)
    expect(written.replaceable(r.path)).toBeNull()
    expect(written.replaceable(null)).toBeNull()
  })
})

describe('upscale says how it was done', () => {
  it('the AI model ships and is used; it is sharper than a bicubic resize', async () => {
    expect(existsSync(join('resources', 'ai', AI_MODELS.upscale))).toBe(true)
    // A 512 px scene reduced to 128 px, then enlarged 4× again by each method.
    const truth = await sharp(scene(512, 512)).png().toBuffer()
    const { data, info } = await sharp(truth).resize(128, 128, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const started = Date.now()
    const up = await upscaleStep({ data, width: info.width, height: info.height }, 4)
    const ms = Date.now() - started
    expect(up.method).toEqual({ kind: 'ai-upscale', model: 'realesr-general-x4v3.onnx' })
    expect([up.raw.width, up.raw.height]).toEqual([512, 512])
    const ai = await sharp(up.raw.data, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer()
    const bicubic = await sharp(data, { raw: { width: 128, height: 128, channels: 4 } }).resize(512, 512, { kernel: 'cubic' }).png().toBuffer()
    const [sTruth, sAi, sBicubic] = [await sharpness(truth), await sharpness(ai), await sharpness(bicubic)]
    console.log(`upscale 128→512 px ×4: AI ${ms} ms; sharpness (Laplacian variance) original ${sTruth.toFixed(0)}, AI ${sAi.toFixed(0)}, bicubic ${sBicubic.toFixed(0)}`)
    expect(sAi).toBeGreaterThan(sBicubic * 1.5)
  })

  it.skipIf(!existsSync('C:/Windows/Web/Wallpaper/Windows/img19.jpg'))('on a real picture of this PC (Windows wallpaper), 2× and 4×', async () => {
    const file = 'C:/Windows/Web/Wallpaper/Windows/img19.jpg'
    const meta = await sharp(file).metadata()
    const truth = await sharp(file).extract({ left: Math.round(meta.width! * 0.3), top: Math.round(meta.height! * 0.4), width: 512, height: 512 }).png().toBuffer()
    for (const factor of [2, 4] as const) {
      const small = 512 / factor
      const { data } = await sharp(truth).resize(small, small, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const started = Date.now()
      const up = await upscaleStep({ data, width: small, height: small }, factor)
      const ms = Date.now() - started
      expect(up.method.kind).toBe('ai-upscale')
      const ai = await sharp(up.raw.data, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer()
      const bicubic = await sharp(data, { raw: { width: small, height: small, channels: 4 } }).resize(512, 512, { kernel: 'cubic' }).png().toBuffer()
      const [sTruth, sAi, sBicubic] = [await sharpness(truth), await sharpness(ai), await sharpness(bicubic)]
      console.log(`wallpaper ${small}→512 px ×${factor}: ${ms} ms; sharpness original ${sTruth.toFixed(0)}, AI ${sAi.toFixed(0)}, bicubic ${sBicubic.toFixed(0)}`)
      expect(sAi).toBeGreaterThan(sBicubic * 1.5)
    }
  })

  it('without the model: a smooth resize to the same size, and the result says so with the reason', async () => {
    const dir = folder()
    const src = await pngAlpha(dir)
    useModelDirectory(folder()) // an empty folder: the model cannot be read
    const r = await imageRun(src, { ai: { upscale: 2 }, output: { format: 'same' } }, base(dir, 'logo (upscaled)'))
    expect(r.method?.kind).toBe('smooth-upscale')
    expect(r.method?.reason).toMatch(/ENOENT|no such file/i)
    expect([r.width, r.height]).toEqual([640, 640])
    useModelDirectory(null)
    const ai = await imageRun(src, { ai: { upscale: 2 }, output: { format: 'same' } }, base(dir, 'logo (upscaled)'), r.path)
    expect(ai.method).toEqual({ kind: 'ai-upscale', model: AI_MODELS.upscale })
    expect(ai.path).toBe(r.path)
    expect(typeof ai.ms).toBe('number')
    // Transparency survives the AI.
    const { data } = await sharp(ai.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[3]).toBe(0)
  })

  it('remove background and blur faces report their method', async () => {
    const dir = folder()
    const src = await webp(dir)
    const cut = await imageRun(src, { ai: { background: { colour: null } }, output: { format: 'png' } }, base(dir, 'street (no background)'))
    expect(cut.method).toEqual({ kind: 'ai-background', model: AI_MODELS.background })
    expect((await sharp(cut.path).metadata()).hasAlpha).toBe(true)
    const hidden = await imageRun(src, { ai: { hide: { regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, kind: 'manual' }], style: 'blur', strength: 60 } }, output: { format: 'same' } }, base(dir, 'street (hidden)'))
    expect(hidden.method).toEqual({ kind: 'hidden', count: 1 })
    const plain = await runImageJob(src, compress(70))
    expect(plain.method).toBeUndefined()
  })
})

describe('watermark repeated across the picture', () => {
  it('a mark whose tile is larger than the picture is cut to it, not refused (found by imgcheck)', async () => {
    const dir = folder()
    const src = await pngAlpha(dir)
    const mark = (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><text x="10" y="90" font-size="80" font-family="Arial" fill="#e11d48">HonoKit ©</text></svg>')).png().toBuffer()).toString('base64')
    const job: ImageJob = { marks: { layers: [{ source: { png: mark }, x: 0.5, y: 0.5, width: 0.9, rotate: -30, opacity: 0.5, tile: { gap: 1 } }] }, output: { format: 'same' } }
    const out = await runImageJob(src, job)
    expect([out.width, out.height]).toEqual([320, 320])
  })
})

describe('result facts', () => {
  it('compress, upscale, convert and rotate on pictures of several formats', async () => {
    const dir = folder()
    const jpg = await jpgRotated(dir)
    const png = await pngAlpha(dir)
    const wp = await webp(dir)
    const av = await avif(dir)

    // The upright size counts: the phone photo is 400 × 600.
    const jpgInfo = await describeImage(jpg)
    expect([jpgInfo.width, jpgInfo.height]).toEqual([400, 600])
    const smaller = await imageRun(jpg, compress(40), base(dir, 'phone photo (compressed)'))
    const f1 = resultFacts(jpgInfo, smaller)
    expect(f1.sizeChange).toBeGreaterThan(20)
    expect(f1.resized).toBe(false)
    expect(compareMode('imgCompress', jpgInfo, smaller)).toBe('slider')

    const pngInfo = await describeImage(png)
    const up = await imageRun(png, { ai: { upscale: 2 }, output: { format: 'same' } }, base(dir, 'logo (upscaled)'))
    const f2 = resultFacts(pngInfo, up)
    expect(f2).toMatchObject({ resized: true, scale: 2, converted: false })
    expect(compareMode('imgUpscale', pngInfo, up)).toBe('slider')

    const wpInfo = await describeImage(wp)
    const conv = await imageRun(wp, convert('jpg'), base(dir, 'street (converted)'))
    expect(resultFacts(wpInfo, conv)).toMatchObject({ converted: true, resized: false, scale: null })

    const avInfo = await describeImage(av)
    const turned = await imageRun(av, { rotate: { angle: 90, flipH: false, flipV: false }, output: { format: 'same' } }, base(dir, 'garden (rotated)'))
    expect([turned.width, turned.height]).toEqual([320, 480])
    expect(resultFacts(avInfo, turned)).toMatchObject({ resized: true, scale: null })
    expect(compareMode('imgRotate', avInfo, turned)).toBe('switch')
    expect(compareMode('imgInfo', avInfo, avInfo)).toBe('none')
  })

  it('odd sizes halved still count as one scale', () => {
    expect(resultFacts({ width: 1001, height: 667, size: 1000, format: 'jpg' }, { width: 500, height: 333, size: 400, format: 'jpg' })).toEqual({ sizeChange: 60, resized: true, scale: 0.5, converted: false })
    expect(resultFacts({ width: 100, height: 100, size: 0, format: 'png' }, { width: 100, height: 100, size: 10, format: 'png' }).sizeChange).toBe(0)
  })

  it('a HEIC picture, when this sharp can write one', async () => {
    const dir = folder()
    const path = join(dir, 'iphone.heic')
    try {
      await sharp(scene(400, 300)).heif({ compression: 'hevc' }).toFile(path)
    } catch {
      return // libvips here has no HEVC encoder (decisions §69): nothing to test
    }
    const info = await describeImage(path)
    const r = await imageRun(path, convert('jpg'), base(dir, 'iphone (converted)'))
    expect(resultFacts(info, r).converted).toBe(true)
  })
})

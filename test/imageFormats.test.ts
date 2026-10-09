import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { FORMATS, WRITABLE, formatOfName } from '@shared/imageFormats'
import { encode, openBytes } from '@engine/img/picture'
import { sniff } from '@engine/img/sniff'

/** A small picture with colour, a gradient and transparency, made here (no personal files). */
async function sample(width = 96, height = 64): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#e11d48"/><stop offset="1" stop-color="#1473e6"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width / 2}" cy="${height / 2}" r="${height / 3}" fill="#ffd23f" fill-opacity=".8"/>
    <rect x="0" y="0" width="12" height="12" fill="#000" fill-opacity="0"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

describe('format registry', () => {
  it('knows JFIF and the other JPEG names', () => {
    for (const name of ['a.jfif', 'a.JPE', 'a.jpeg', 'a.pjpeg', 'a.pjp', 'a.jif']) expect(formatOfName(name)?.id).toBe('jpg')
  })
  it('has unique ids', () => {
    expect(new Set(FORMATS.map((f) => f.id)).size).toBe(FORMATS.length)
  })
})

describe('every writable format round-trips', async () => {
  const png = await sample()
  for (const spec of WRITABLE) {
    it(`${spec.label} (.${spec.ext[0]})`, async () => {
      const source = await openBytes(png, 'sample.png')
      const out = await encode(source.pipeline(), { format: spec.id, quality: 90, iconSizes: spec.id === 'icns' ? [16, 32, 128] : undefined })
      expect(out.data.length).toBeGreaterThan(20)
      // What we wrote must be recognised as what we said it is …
      const seen = sniff(out.data.subarray(0, 4096), `out.${spec.ext[0]}`)
      // A one-frame APNG is a plain PNG.
      expect(seen === spec.id || (spec.id === 'apng' && seen === 'png')).toBe(true)
      // … and open again at the same size (icons at their largest size; EPS and ICNS are write-only).
      if (!spec.read || spec.id === 'pdf') return
      const back = await openBytes(out.data, `out.${spec.ext[0]}`)
      if (spec.id === 'ico') expect(back.width).toBe(256)
      else if (spec.id === 'cur') expect(back.width).toBe(32)
      else {
        expect(back.width).toBe(96)
        expect(back.height).toBe(64)
      }
      const raw = await back.pipeline().raw().toBuffer()
      expect(raw.length).toBeGreaterThan(0)
    })
  }
})

describe('sniffing beats the extension', () => {
  it('reads a JPEG named .png and a PNG named .jfif', async () => {
    const png = await sample()
    const jpg = await sharp(png).jpeg().toBuffer()
    expect((await openBytes(jpg, 'photo.png')).format).toBe('jpg')
    expect((await openBytes(png, 'photo.jfif')).format).toBe('png')
  })
})

describe('animation', () => {
  it('keeps every frame from GIF to WebP and to APNG', async () => {
    const frames = await Promise.all(['#e11d48', '#16a34a', '#1473e6'].map((c) => sharp({ create: { width: 40, height: 30, channels: 4, background: c } }).png().toBuffer()))
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [200, 200, 200], loop: 0 }).toBuffer()
    const picture = await openBytes(gif, 'a.gif')
    expect(picture.frames).toBe(3)
    const webp = await encode(picture.pipeline(true), { format: 'webp' }, picture)
    expect(webp.frames).toBe(3)
    const apng = await encode(picture.pipeline(true), { format: 'apng' }, picture)
    const back = await openBytes(apng.data, 'a.apng')
    expect(back.format).toBe('apng')
    expect(back.frames).toBe(3)
  })
})

describe('colour spaces', () => {
  it('reads a CMYK Photoshop file in its true colours', async () => {
    const { ImageMagick, MagickFormat, MagickReadSettings, ColorSpace } = await import('@imagemagick/magick-wasm')
    const { startMagick } = await import('@engine/img/magick')
    await startMagick()
    const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } }).raw().toBuffer()
    const psd = ImageMagick.read(red, new MagickReadSettings({ format: MagickFormat.Rgba, width: 8, height: 8, depth: 8 }), (image) => {
      image.colorSpace = ColorSpace.CMYK
      return image.write(MagickFormat.Psd, (data) => data.slice())
    })
    const back = await openBytes(psd, 'print.psd')
    const px = await back.pipeline().raw().toBuffer()
    expect(px[0]).toBeGreaterThan(200)
    expect(px[1]).toBeLessThan(60)
    expect(px[2]).toBeLessThan(60)
  })
})

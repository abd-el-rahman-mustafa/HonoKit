import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ColorSpace, Density, ImageMagick, initializeImageMagick, MagickFormat, MagickImage, MagickImageCollection, MagickReadSettings, type IMagickImage } from '@imagemagick/magick-wasm'

/**
 * ImageMagick, compiled to WebAssembly (@imagemagick/magick-wasm, Apache-2.0): the engine for
 * every format libvips's prebuilt binaries do not handle — HEIC, camera RAW (LibRaw), PSD,
 * JPEG XL, JPEG 2000, EXR, DDS, TGA, ICO and the old ones (docs/formats.md). Pixels cross
 * between it and sharp as plain 8-bit RGBA.
 */

let ready: Promise<void> | null = null

export function startMagick(): Promise<void> {
  if (!ready) {
    const require = createRequire(import.meta.url)
    const wasm = readFileSync(require.resolve('@imagemagick/magick-wasm/magick.wasm'))
    ready = initializeImageMagick(wasm)
  }
  return ready
}

export interface RgbaFrame {
  data: Uint8Array
  width: number
  height: number
  /** Hundredths of a second, for animations. */
  delay: number
}

export interface MagickDecoded {
  frames: RgbaFrame[]
  /** 0 = forever. */
  loop: number
  /** ImageMagick's own name for what it read ("HEIC", "CR2" …). */
  format: string
  density: number | null
}

/** The magick format value for a name such as "HEIC"; throws for an unknown one. */
export function magickFormat(name: string): MagickFormat {
  const match = Object.values(MagickFormat).find((v) => v.toUpperCase() === name.toUpperCase())
  if (!match) throw new Error(`ImageMagick has no format ${name}`)
  return match
}

function rgbaOf(image: IMagickImage): Uint8Array {
  // CMYK pictures (print PSDs, TIFFs, JPEGs) are turned into RGB first; read as they are, their
  // channels come out as an inverted-looking negative.
  if (image.colorSpace === ColorSpace.CMYK) image.colorSpace = ColorSpace.sRGB
  return image.getPixels((pixels) => pixels.toByteArray(0, 0, image.width, image.height, 'RGBA')) ?? new Uint8Array(image.width * image.height * 4)
}

/**
 * Decodes a file. `allFrames` keeps every frame (animations, multi-page files); otherwise only
 * the picture people expect: a Photoshop file's flattened composite, an icon's largest size,
 * a photo turned upright by its EXIF orientation.
 */
export async function magickDecode(bytes: Uint8Array, hint: string | undefined, allFrames: boolean): Promise<MagickDecoded> {
  await startMagick()
  const settings = new MagickReadSettings(hint ? { format: magickFormat(hint) } : {})
  if (!allFrames || hint === 'PSD' || hint === 'XCF') {
    // Photoshop and GIMP files read as one picture give the merged image, not the layers.
    if (hint === 'ICO' || hint === 'CUR') return largestIcon(bytes, settings)
    return ImageMagick.read(bytes, settings, (image) => {
      image.autoOrient()
      return { frames: [{ data: rgbaOf(image), width: image.width, height: image.height, delay: 0 }], loop: 0, format: String(image.format), density: image.density?.x || null }
    })
  }
  const collection = MagickImageCollection.create()
  try {
    collection.read(bytes, settings)
    collection.coalesce()
    const first = collection[0]!
    return {
      frames: collection.map((image) => {
        image.autoOrient()
        return { data: rgbaOf(image), width: image.width, height: image.height, delay: image.animationDelay }
      }),
      loop: first.animationIterations,
      format: String(first.format),
      density: first.density?.x || null
    }
  } finally {
    collection.dispose()
  }
}

function largestIcon(bytes: Uint8Array, settings: MagickReadSettings): MagickDecoded {
  const collection = MagickImageCollection.create()
  try {
    collection.read(bytes, settings)
    const best = [...collection].sort((a, b) => b.width * b.height - a.width * a.height)[0]!
    return { frames: [{ data: rgbaOf(best), width: best.width, height: best.height, delay: 0 }], loop: 0, format: String(best.format), density: null }
  } finally {
    collection.dispose()
  }
}

export interface MagickEncodeOptions {
  quality?: number
  lossless?: boolean
  /** PDF/EPS: dots per inch the picture is placed at. */
  density?: number
  /** Extra ImageMagick defines, e.g. ["jxl", "effort", "7"]. */
  defines?: Array<[string, string, string]>
}

function readRgba(image: IMagickImage, frame: RgbaFrame): void {
  image.read(frame.data, new MagickReadSettings({ format: MagickFormat.Rgba, width: frame.width, height: frame.height, depth: 8 }))
}

/**
 * Encodes RGBA frames to an ImageMagick format. More than one frame makes an animation, or for
 * ICO/CUR/TIFF/PDF the sizes or pages of one file.
 */
export async function magickEncode(frames: RgbaFrame[], target: string, options: MagickEncodeOptions = {}, loop = 0): Promise<Uint8Array> {
  await startMagick()
  const format = magickFormat(target)
  const prepare = (image: IMagickImage): void => {
    if (options.quality !== undefined) image.quality = options.quality
    if (options.lossless) image.quality = 100
    if (options.density) image.density = new Density(options.density)
    for (const [f, name, value] of options.defines ?? []) image.settings.setDefine(magickFormat(f), name, value)
  }

  if (frames.length === 1) {
    const image = MagickImage.create()
    try {
      readRgba(image, frames[0]!)
      prepare(image)
      return image.write(format, (data) => data.slice())
    } finally {
      image.dispose()
    }
  }

  const collection = MagickImageCollection.create()
  try {
    for (const frame of frames) {
      const image = MagickImage.create()
      readRgba(image, frame)
      image.animationDelay = frame.delay
      image.animationIterations = loop
      prepare(image)
      collection.push(image)
    }
    return collection.write(format, (data) => data.slice())
  } finally {
    collection.dispose()
  }
}

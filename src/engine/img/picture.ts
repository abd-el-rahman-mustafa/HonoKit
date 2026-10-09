import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import UPNG from 'upng-js'
import { format, type FormatId } from '@shared/imageFormats'
import { PdfError } from '../errors'
import { magickDecode, magickEncode, type RgbaFrame } from './magick'
import { sniff } from './sniff'
import { writeIco, writeIcns } from './icns'
import { pdfOfJpeg, pdfPageCount, renderPdfPage } from './pdfio'

/**
 * A picture opened for work (decisions §69): what it really is, its size, and a way to get a
 * fresh sharp pipeline over it. Formats libvips reads go straight to sharp; the rest are decoded
 * once (ImageMagick, UPNG, MuPDF) into RGBA frames that sharp then reads as raw pixels, so every
 * tool has one code path.
 */
export interface Picture {
  name: string
  format: FormatId
  /** Upright size (EXIF orientation applied) of one frame. */
  width: number
  height: number
  /** More than one when animated (GIF, WebP, APNG) or for several pages (TIFF, PDF). */
  frames: number
  /** Milliseconds per frame, when animated. */
  delays: number[]
  /** 0 = loops forever. */
  loop: number
  hasAlpha: boolean
  /** Size of the file, in bytes. */
  size: number
  /** Dots per inch the file declares, if any. */
  density: number | null
  /** A new pipeline over the picture; `animated` keeps every frame. */
  pipeline(animated?: boolean): Sharp
}

/** sharp refuses pictures over 268 megapixels by default; a panorama or a scan may be bigger. */
const LIMIT = 1_000_000_000

/** Formats libvips reads in the prebuilt sharp (docs/research-image-formats.md). */
const SHARP_READS = new Set<FormatId>(['jpg', 'png', 'webp', 'gif', 'avif', 'tiff', 'svg', 'vips'])

export async function openPicture(path: string, options: { page?: number } = {}): Promise<Picture> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new PdfError('corrupt', `${basename(path)}: ${(error as Error).message}`)
  }
  return openBytes(bytes, basename(path), options)
}

export async function openBytes(bytes: Uint8Array, name: string, options: { page?: number } = {}): Promise<Picture> {
  const id = sniff(bytes.subarray(0, 4096), name)
  if (!id) throw new PdfError('unsupported', `${name}: not a picture this app can read`)
  const spec = format(id)
  if (!spec.read) throw new PdfError('unsupported', `${name}: ${spec.label} files can be written but not read`)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (id === 'pdf') {
    const frame = renderPdfPage(bytes, options.page ?? 0, 150)
    const picture = fromFrames(name, id, [frame], 0, buffer.length, 150)
    return { ...picture, frames: pdfPageCount(bytes) }
  }

  if (id === 'apng') {
    try {
      const png = UPNG.decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
      const rgba = UPNG.toRGBA8(png)
      const frames = rgba.map((data, i) => ({ data: new Uint8Array(data), width: png.width, height: png.height, delay: Math.round((png.frames[i]?.delay ?? 100) / 10) }))
      return fromFrames(name, id, frames, png.tabs.acTL?.num_plays ?? 0, buffer.length, null)
    } catch (error) {
      throw new PdfError('corrupt', `${name}: ${(error as Error).message}`)
    }
  }

  if (SHARP_READS.has(id)) {
    try {
      const meta = await sharp(buffer, { limitInputPixels: LIMIT, animated: true }).metadata()
      const pages = meta.pages ?? 1
      const turned = (meta.orientation ?? 1) >= 5
      const width = meta.width ?? 0
      const height = meta.pageHeight ?? meta.height ?? 0
      return {
        name,
        format: id,
        width: turned ? height : width,
        height: turned ? width : height,
        frames: pages,
        delays: meta.delay ?? [],
        loop: meta.loop ?? 0,
        hasAlpha: meta.hasAlpha ?? false,
        size: buffer.length,
        density: meta.density ?? null,
        pipeline: (animated = false) => sharp(buffer, { limitInputPixels: LIMIT, animated: animated && pages > 1, autoOrient: true, failOn: 'none' })
      }
    } catch (error) {
      // A file libvips refuses (an unusual TIFF, a broken GIF) gets a second chance in ImageMagick.
      if (!spec.magick) throw new PdfError('corrupt', `${name}: ${(error as Error).message}`)
    }
  }

  try {
    const decoded = await magickDecode(bytes, spec.magick, spec.animation === true)
    return fromFrames(name, id, decoded.frames, decoded.loop, buffer.length, decoded.density)
  } catch (error) {
    throw new PdfError('corrupt', `${name}: ${(error as Error).message}`)
  }
}

/** A picture from decoded RGBA frames (all the same size, as ImageMagick's coalesce leaves them). */
export function fromFrames(name: string, id: FormatId, frames: RgbaFrame[], loop: number, size: number, density: number | null): Picture {
  const first = frames[0]!
  const { width, height } = first
  const all = frames.length === 1 ? first.data : Buffer.concat(frames.map((f) => f.data))
  return {
    name,
    format: id,
    width,
    height,
    frames: frames.length,
    delays: frames.map((f) => f.delay * 10),
    loop,
    hasAlpha: hasTransparency(first.data),
    size,
    density,
    pipeline: (animated = false) => {
      const many = animated && frames.length > 1
      return sharp(many ? all : first.data, {
        raw: { width, height: many ? height * frames.length : height, channels: 4, ...(many ? { pageHeight: height } : {}) },
        limitInputPixels: LIMIT
      })
    }
  }
}

/**
 * Every page of a multi-page picture (a TIFF scan or fax) as its own lossless PNG, upright and
 * in order, keeping transparency and the declared dpi; null when the picture has one page.
 * MuPDF reads only the first page of a TIFF, so Images to PDF hands it these instead.
 */
export async function pagesAsPng(bytes: Uint8Array, name: string): Promise<Uint8Array[] | null> {
  const picture = await openBytes(bytes, name)
  if (picture.frames <= 1) return null
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    const pages: Uint8Array[] = []
    // One page at a time: a long scan read whole would fill the worker's memory.
    for (let page = 0; page < picture.frames; page++) {
      const one = sharp(buffer, { page, limitInputPixels: LIMIT, autoOrient: true, failOn: 'none' })
      const { density } = await one.metadata()
      pages.push(new Uint8Array(await one.withMetadata({ orientation: 1, ...(density ? { density } : {}) }).png().toBuffer()))
    }
    return pages
  } catch {
    // libvips refused it: ImageMagick decodes every page instead.
    const decoded = await magickDecode(bytes, format(picture.format).magick, true)
    return Promise.all(
      decoded.frames.map(async (f) => {
        const png = sharp(f.data, { raw: { width: f.width, height: f.height, channels: 4 }, limitInputPixels: LIMIT })
        return new Uint8Array(await (decoded.density ? png.withMetadata({ density: decoded.density }) : png).png().toBuffer())
      })
    )
  }
}

function hasTransparency(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 255) return true
  return false
}

// --- writing -----------------------------------------------------------------------------

export interface EncodeOptions {
  format: FormatId
  /** 1–100, for lossy formats. */
  quality?: number
  lossless?: boolean
  /** Background for formats without transparency (JPG, BMP …): a hex colour. */
  background?: string
  /** Keep EXIF, ICC profile and the rest (off by default: privacy). */
  keepMetadata?: boolean
  /** JPG progressive / PNG interlaced. */
  progressive?: boolean
  /** PNG and GIF: at most this many colours (PNG: a palette, lossy and much smaller). */
  palette?: boolean
  colours?: number
  /** CPU effort, 0–9 (WebP up to 6, AVIF up to 9). */
  effort?: number
  /** ICO / CUR / ICNS sizes in pixels. */
  iconSizes?: number[]
  tiffCompression?: 'lzw' | 'deflate' | 'jpeg' | 'none'
  /** Animations: loop count, 0 = forever. */
  loop?: number
  /** Milliseconds per frame, for animations built here. */
  delays?: number[]
}

export interface Encoded {
  data: Buffer
  width: number
  height: number
  frames: number
}

/**
 * Writes the result of a pipeline. An animated pipeline (opened with animated = true) stays
 * animated in GIF, WebP and APNG and gives its first frame elsewhere.
 */
export async function encode(input: Sharp, options: EncodeOptions, source?: Pick<Picture, 'delays' | 'loop'>): Promise<Encoded> {
  const spec = format(options.format)
  if (!spec.write) throw new PdfError('unsupported', `${spec.label} files cannot be written`)
  const quality = Math.round(Math.min(100, Math.max(1, options.quality ?? 82)))
  let pipe = input
  // sharp drops metadata and converts to sRGB unless told otherwise.
  if (options.keepMetadata) pipe = pipe.keepMetadata()
  if (!spec.alpha) pipe = pipe.flatten({ background: options.background ?? '#ffffff' })
  const delay = options.delays ?? source?.delays
  const loop = options.loop ?? source?.loop ?? 0
  const animation = delay && delay.length > 1 ? { delay: delay.map((d) => Math.max(20, d)), loop } : {}

  const finish = async (p: Sharp): Promise<Encoded> => {
    const { data, info } = await p.toBuffer({ resolveWithObject: true })
    const frames = (info as { pages?: number }).pages ?? 1
    const pageHeight = (info as { pageHeight?: number }).pageHeight ?? info.height
    return { data, width: info.width, height: pageHeight, frames }
  }

  /** The pipeline as RGBA frames (one per page when animated). */
  const frames = async (animated: boolean): Promise<RgbaFrame[]> => {
    const { data: raw, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pageHeight = (info as { pageHeight?: number }).pageHeight ?? info.height
    const count = animated ? Math.max(1, Math.round(info.height / pageHeight)) : 1
    const size = info.width * pageHeight * 4
    return Array.from({ length: count }, (_, i) => ({ data: raw.subarray(i * size, (i + 1) * size), width: info.width, height: pageHeight, delay: Math.round((delay?.[i] ?? 100) / 10) }))
  }

  switch (spec.write) {
    case 'sharp':
      switch (options.format) {
        case 'jpg':
          return finish(pipe.jpeg({ quality, mozjpeg: true, progressive: options.progressive ?? true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' }))
        case 'png':
          return finish(
            pipe.png({
              compressionLevel: 9,
              adaptiveFiltering: true,
              progressive: options.progressive ?? false,
              palette: options.palette ?? false,
              ...(options.palette ? { quality, colours: options.colours ?? 256, effort: options.effort ?? 7, dither: 1 } : {})
            })
          )
        case 'webp':
          return finish(pipe.webp({ quality, lossless: options.lossless ?? false, effort: Math.min(6, options.effort ?? 4), smartSubsample: true, ...animation }))
        case 'avif':
          return finish(pipe.avif({ quality: Math.max(1, quality - 10), lossless: options.lossless ?? false, effort: options.effort ?? 4 }))
        case 'gif':
          return finish(pipe.gif({ colours: options.colours ?? 256, effort: Math.min(10, options.effort ?? 7), dither: 1, reuse: true, ...animation }))
        case 'tiff':
          return finish(pipe.tiff({ compression: options.tiffCompression ?? 'lzw', quality, predictor: options.tiffCompression === 'jpeg' ? 'none' : 'horizontal' }))
      }
      throw new PdfError('unsupported', `no writer for ${spec.label}`)

    case 'upng': {
      const list = await frames(true)
      const first = list[0]!
      const data = Buffer.from(
        UPNG.encode(
          list.map((f) => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer),
          first.width,
          first.height,
          0,
          list.length > 1 ? list.map((f) => f.delay * 10) : undefined
        )
      )
      return { data, width: first.width, height: first.height, frames: list.length }
    }

    case 'own': {
      if (options.format === 'ico' || options.format === 'cur') {
        const sizes = (options.iconSizes?.length ? options.iconSizes : options.format === 'cur' ? [32] : [256, 128, 64, 48, 32, 16]).filter((s) => s >= 1 && s <= 256).sort((a, b) => b - a)
        const master = await pipe.ensureAlpha().png().toBuffer()
        const data = await writeIco(master, sizes, options.format === 'cur')
        return { data, width: sizes[0]!, height: sizes[0]!, frames: 1 }
      }
      const master = await pipe.ensureAlpha().png().toBuffer()
      const data = await writeIcns(master, options.iconSizes)
      return { data, width: Math.max(...(options.iconSizes?.length ? options.iconSizes : [1024])), height: Math.max(...(options.iconSizes?.length ? options.iconSizes : [1024])), frames: 1 }
    }

    case 'magick': {
      if (options.format === 'pdf') {
        const page = await pipe.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        const data = await pdfOfJpeg(page.data, page.info.width, page.info.height)
        return { data, width: page.info.width, height: page.info.height, frames: 1 }
      }
      const list = await frames(spec.animation === true)
      const defines: Array<[string, string, string]> = []
      if (options.format === 'jxl') defines.push(['JXL', 'effort', String(Math.min(9, Math.max(1, options.effort ?? 7)))])
      const data = Buffer.from(await magickEncode(list, spec.magick!, { quality, lossless: options.lossless, defines }, loop))
      return { data, width: list[0]!.width, height: list[0]!.height, frames: list.length }
    }
    default:
      throw new PdfError('unsupported', `${spec.label} files cannot be written`)
  }
}

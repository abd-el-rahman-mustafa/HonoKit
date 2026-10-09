import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import sharp, { type OverlayOptions, type Sharp } from 'sharp'
import exifr from 'exifr'
import { format, type FormatId } from '@shared/imageFormats'
import { AI_MODELS, detectFaces, detectPlates, hideRegions, removeBackground, upscale } from './ai'
import { resizedSize, type Animate, type DetectedRegion, type Detect, type Crop, type ImageFileInfo, type ImageJob, type ImageMetadata, type ImageMethod, type Layer, type Marks, type Resize, type Rotate } from '@shared/imageOps'
import { PdfError } from '../errors'
import { encode, openPicture, type EncodeOptions, type Encoded, type Picture } from './picture'

/**
 * The image tools' work on one file (decisions §69): crop → rotate/flip → resize → write.
 * Each step is its own pass over RGBA pixels: sharp applies the operations of one pipeline in
 * a fixed order of its own, whatever order they were called in. An animation is worked frame by
 * frame and stays animated when the format it is written to can hold one.
 */

interface Raw {
  data: Buffer
  width: number
  height: number
}

const fromRaw = (r: Raw): Sharp => sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } })

async function rawOf(s: Sharp): Promise<Raw> {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** The pixel box a crop takes from a picture of `width` × `height`. */
export async function cropBox(first: Raw, crop: Crop): Promise<{ left: number; top: number; width: number; height: number }> {
  const W = first.width
  const H = first.height
  if (crop.by === 'box') {
    const left = Math.min(W - 1, Math.max(0, Math.round(crop.x * W)))
    const top = Math.min(H - 1, Math.max(0, Math.round(crop.y * H)))
    return { left, top, width: Math.max(1, Math.min(W - left, Math.round(crop.width * W))), height: Math.max(1, Math.min(H - top, Math.round(crop.height * H))) }
  }
  // The largest box of the wanted shape.
  let width = W
  let height = Math.round(W / crop.ratio)
  if (height > H) {
    height = H
    width = Math.max(1, Math.round(H * crop.ratio))
  }
  if (crop.position === 'smart') {
    const { info } = await fromRaw(first).resize(width, height, { fit: 'cover', position: sharp.strategy.attention }).raw().toBuffer({ resolveWithObject: true })
    const left = -((info as { cropOffsetLeft?: number }).cropOffsetLeft ?? -Math.round((W - width) / 2))
    const top = -((info as { cropOffsetTop?: number }).cropOffsetTop ?? -Math.round((H - height) / 2))
    return { left: Math.min(W - width, Math.max(0, left)), top: Math.min(H - height, Math.max(0, top)), width, height }
  }
  const x = { centre: (W - width) / 2, top: (W - width) / 2, bottom: (W - width) / 2, left: 0, right: W - width }[crop.position]
  const y = { centre: (H - height) / 2, top: 0, bottom: H - height, left: (H - height) / 2, right: (H - height) / 2 }[crop.position]
  return { left: Math.round(x), top: Math.round(y), width, height }
}

async function rotateStep(r: Raw, rotate: Rotate): Promise<Raw> {
  let out = r
  const angle = ((rotate.angle % 360) + 360) % 360
  if (angle !== 0) {
    const background = rotate.background ?? '#00000000'
    out = await rawOf(fromRaw(out).rotate(angle, { background }))
  }
  if (rotate.flipH) out = await rawOf(fromRaw(out).flop())
  if (rotate.flipV) out = await rawOf(fromRaw(out).flip())
  return out
}

async function resizeStep(r: Raw, resize: Resize): Promise<Raw> {
  const size = resizedSize(r.width, r.height, resize)
  if (size.width === r.width && size.height === r.height) return r
  const fit = resize.by === 'pixels' && resize.width && resize.height ? (resize.fit === 'exact' ? 'fill' : resize.fit === 'cover' ? 'cover' : 'inside') : 'fill'
  return rawOf(fromRaw(r).resize(size.width, size.height, { fit, kernel: 'lanczos3' }))
}

/** A mark's picture: drawn by the window (PNG) or read from a file at full size. */
async function stampOf(layer: Layer): Promise<Buffer> {
  if ('png' in layer.source) {
    // A data: URL or bare base64.
    const png = layer.source.png
    return Buffer.from(png.startsWith('data:') ? png.slice(png.indexOf(',') + 1) : png, 'base64')
  }
  return (await openPicture(layer.source.path)).pipeline().ensureAlpha().png().toBuffer()
}

/** Marks on one frame: bands added first (meme text outside), then each layer over the result. */
async function marksStep(r: Raw, marks: Marks, stamps: Buffer[]): Promise<Raw> {
  let out = r
  if (marks.bands && (marks.bands.top > 0 || marks.bands.bottom > 0)) {
    const top = Math.round(marks.bands.top * r.height)
    const bottom = Math.round(marks.bands.bottom * r.height)
    out = await rawOf(fromRaw(out).extend({ top, bottom, background: marks.bands.colour }))
  }
  const W = out.width
  const H = out.height
  const overlays: OverlayOptions[] = []
  for (const [i, layer] of marks.layers.entries()) {
    const width = Math.max(1, Math.round(layer.width * W))
    let mark = sharp(stamps[i]!).resize({ width, kernel: 'lanczos3' }).ensureAlpha()
    if (layer.opacity < 1) {
      const { data, info } = await mark.raw().toBuffer({ resolveWithObject: true })
      for (let a = 3; a < data.length; a += 4) data[a] = Math.round(data[a]! * layer.opacity)
      mark = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    }
    if (layer.rotate % 360 !== 0) mark = sharp(await mark.rotate(layer.rotate, { background: '#00000000' }).png().toBuffer())
    let { data, info } = await mark.raw().toBuffer({ resolveWithObject: true })
    if (layer.tile) {
      // One tile: the mark with its gap around it, repeated over the whole picture.
      const gx = Math.round((info.width * layer.tile.gap) / 2)
      const gy = Math.round((info.height * layer.tile.gap) / 2)
      let cell = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extend({ top: gy, bottom: gy, left: gx, right: gx, background: '#00000000' }).png().toBuffer()
      // A tile larger than the picture (a wide mark with its gap on a small picture) is cut to the
      // picture: sharp refuses an overlay bigger than what it is laid on (found by imgcheck, §77).
      const cw = info.width + 2 * gx
      const ch = info.height + 2 * gy
      if (cw > W || ch > H) cell = await sharp(cell).extract({ left: 0, top: 0, width: Math.min(cw, W), height: Math.min(ch, H) }).png().toBuffer()
      overlays.push({ input: cell, tile: true, gravity: 'northwest' })
      continue
    }
    // Placed by its centre; the part outside the picture is cut off.
    let left = Math.round(layer.x * W - info.width / 2)
    let top = Math.round(layer.y * H - info.height / 2)
    const x0 = Math.max(0, -left)
    const y0 = Math.max(0, -top)
    const x1 = Math.min(info.width, W - left)
    const y1 = Math.min(info.height, H - top)
    if (x1 <= x0 || y1 <= y0) continue
    if (x0 > 0 || y0 > 0 || x1 < info.width || y1 < info.height) {
      const cut = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).raw().toBuffer({ resolveWithObject: true })
      data = cut.data
      info = cut.info
      left += x0
      top += y0
    }
    overlays.push({ input: data, raw: { width: info.width, height: info.height, channels: 4 }, left, top })
  }
  if (!overlays.length) return out
  return rawOf(fromRaw(out).composite(overlays))
}

/** The format a picture is written in for "same format": its own when that can be written. */
export function sameFormat(picture: Pick<Picture, 'format' | 'hasAlpha'>): FormatId {
  const own = format(picture.format)
  if (own.write && own.id !== 'pdf') return own.id
  return picture.hasAlpha ? 'png' : 'jpg'
}

const LOSSY: ReadonlySet<FormatId> = new Set<FormatId>(['jpg', 'webp', 'avif', 'jxl', 'jp2'])

export interface JobOutput extends Encoded {
  format: FormatId
  ext: string
  /** The quality used, when a target size chose it. */
  quality?: number
  /** A target size that could not be reached even at the lowest quality. */
  missedTarget?: boolean
  /** How an AI step was really done (decisions §77). */
  method?: ImageMethod
}

/**
 * Upscale, honestly: Real-ESRGAN on this computer; if the model cannot run (missing from the
 * installation, the runtime failing to load, too little memory) a smooth Lanczos resize to the same
 * size instead, and the result says so with the reason — never a plain resize passed off as AI.
 */
export async function upscaleStep(r: Raw, factor: 2 | 4, progress?: (fraction: number) => void): Promise<{ raw: Raw; method: ImageMethod }> {
  try {
    return { raw: (await upscale(r, factor, progress)) as Raw, method: { kind: 'ai-upscale', model: AI_MODELS.upscale } }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const raw = await rawOf(fromRaw(r).resize(r.width * factor, r.height * factor, { kernel: 'lanczos3' }))
    return { raw, method: { kind: 'smooth-upscale', reason } }
  }
}

/** Runs a job on one file. */
export async function runImageJob(path: string, job: ImageJob, progress?: (fraction: number) => void): Promise<JobOutput> {
  const picture = await openPicture(path, { page: job.page })
  const target = job.output.format === 'same' ? sameFormat(picture) : job.output.format
  const spec = format(target)
  const sourceExt = extname(path).slice(1).toLowerCase()
  const ext = job.output.ext && spec.ext.includes(job.output.ext) ? job.output.ext : job.output.format === 'same' && spec.ext.includes(sourceExt) ? sourceExt : spec.ext[0]!
  // The AI steps work on one picture: an animation gives its first frame.
  const animated = !job.ai && picture.frames > 1 && spec.animation === true && job.output.keepAnimation !== false && picture.format !== 'pdf' && picture.format !== 'tiff'
  const geometry = !!(job.crop || job.rotate || job.resize || job.marks || job.ai)

  const options: EncodeOptions = {
    format: target,
    quality: job.output.quality,
    lossless: job.output.lossless,
    background: job.output.background,
    // Metadata is kept only when the picture is not reshaped (its orientation and size would lie).
    keepMetadata: job.output.keepMetadata && !geometry,
    progressive: job.output.progressive,
    palette: job.output.palette,
    colours: job.output.colours,
    effort: job.output.effort,
    iconSizes: job.output.iconSizes,
    tiffCompression: job.output.tiffCompression
  }

  // The pipeline to write: the picture itself, or its frames after the steps.
  let make: () => Sharp
  let source: Pick<Picture, 'delays' | 'loop'> = picture
  let method: ImageMethod | undefined
  if (!geometry) make = () => picture.pipeline(animated)
  else {
    const frames = await framesOf(picture, animated)
    const box = job.crop ? await cropBox(frames[0]!, job.crop) : null
    const stamps = job.marks ? await Promise.all(job.marks.layers.map(stampOf)) : []
    const done: Raw[] = []
    for (const frame of frames) {
      let r = frame
      // Hidden areas were found on the picture as it is: hide them before anything moves.
      if (job.ai?.hide) {
        r = (await hideRegions(r, job.ai.hide.regions, job.ai.hide.style, job.ai.hide.strength)) as Raw
        method = { kind: 'hidden', count: job.ai.hide.regions.length }
      }
      if (box) r = await rawOf(fromRaw(r).extract(box))
      if (job.rotate) r = await rotateStep(r, job.rotate)
      if (job.resize) r = await resizeStep(r, job.resize)
      if (job.ai?.upscale) {
        const up = await upscaleStep(r, job.ai.upscale, progress)
        r = up.raw
        method = up.method
      }
      if (job.ai?.background) {
        r = (await removeBackground(r, job.ai.background.colour)) as Raw
        method = { kind: 'ai-background', model: AI_MODELS.background }
      }
      if (job.marks) r = await marksStep(r, job.marks, stamps)
      done.push(r)
    }
    const first = done[0]!
    const joined = done.length === 1 ? first.data : Buffer.concat(done.map((d) => d.data))
    make = () => sharp(joined, { raw: { width: first.width, height: first.height * done.length, channels: 4, ...(done.length > 1 ? { pageHeight: first.height } : {}) } })
    source = { delays: picture.delays, loop: picture.loop }
  }

  if (job.output.targetBytes && LOSSY.has(target)) {
    // The highest quality that fits: a binary search, seven tries at most.
    let low = 5
    let high = Math.min(95, job.output.quality ?? 95)
    let best: Encoded | null = null
    let bestQuality = low
    for (let i = 0; i < 7 && low <= high; i++) {
      const q = Math.round((low + high) / 2)
      const out = await encode(make(), { ...options, quality: q }, source)
      if (out.data.length <= job.output.targetBytes) {
        best = out
        bestQuality = q
        low = q + 1
      } else high = q - 1
    }
    if (best) return { ...best, format: target, ext, quality: bestQuality, method }
    const smallest = await encode(make(), { ...options, quality: 5 }, source)
    return { ...smallest, format: target, ext, quality: 5, missedTarget: smallest.data.length > job.output.targetBytes, method }
  }
  return { ...(await encode(make(), options, source)), format: target, ext, method }
}

/** The picture's frames as RGBA (just the first unless `all`). */
async function framesOf(picture: Picture, all: boolean): Promise<Raw[]> {
  const { data, info } = await picture.pipeline(all).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const pageHeight = all ? ((info as { pageHeight?: number }).pageHeight ?? info.height) : info.height
  const count = Math.max(1, Math.round(info.height / pageHeight))
  const size = info.width * pageHeight * 4
  return Array.from({ length: count }, (_, i) => ({ data: data.subarray(i * size, (i + 1) * size), width: info.width, height: pageHeight }))
}

/** Faces and licence plates in a picture, for Blur faces (fractions of the upright picture). */
export async function detectRegions(path: string, what: Detect): Promise<DetectedRegion[]> {
  const picture = await openPicture(path)
  // Detection needs no more than ~2,000 px: smaller is faster, and the finds are fractions anyway.
  const { data, info } = await picture.pipeline().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const raw = { data, width: info.width, height: info.height }
  const found = [...(what.faces ? await detectFaces(raw, what.sensitivity) : []), ...(what.plates ? await detectPlates(raw, what.sensitivity) : [])]
  return found.map(({ x, y, w, h, kind, score }) => ({ x, y, w, h, kind, score }))
}

/** A card's facts and a small preview (data: URL), for any format, even ones the window cannot show. */
export async function describeImage(path: string, previewSize = 320): Promise<ImageFileInfo> {
  const picture = await openPicture(path)
  const small = await picture
    .pipeline()
    .resize(previewSize, previewSize, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72, alphaQuality: 80 })
    .toBuffer()
  return {
    path,
    name: basename(path),
    format: picture.format,
    size: picture.size,
    width: picture.width,
    height: picture.height,
    frames: picture.frames,
    hasAlpha: picture.hasAlpha,
    density: picture.density,
    preview: `data:image/webp;base64,${small.toString('base64')}`
  }
}

/** Several pictures as one animation (Make GIF): each fitted into the same size, in order. */
export async function animatePictures(paths: string[], options: Animate): Promise<Encoded> {
  if (paths.length < 1) throw new PdfError('bad-arguments', 'no pictures')
  const pictures: Picture[] = []
  for (const p of paths) pictures.push(await openPicture(p))
  const width = options.width ?? pictures[0]!.width
  const height = options.height ?? pictures[0]!.height
  const frames: Buffer[] = []
  for (const picture of pictures) {
    frames.push(await picture.pipeline().resize(width, height, { fit: options.fit, background: options.background, kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer())
  }
  const joined = sharp(Buffer.concat(frames), { raw: { width, height: height * frames.length, channels: 4, ...(frames.length > 1 ? { pageHeight: height } : {}) } })
  return encode(joined, { format: options.format, quality: options.quality, delays: frames.map(() => options.delay), loop: options.loop ? 0 : 1 })
}

/** Every frame of an animation as its own picture (Extract frames). */
export async function animationFrames(path: string): Promise<{ frames: Raw[]; delays: number[] }> {
  const picture = await openPicture(path)
  return { frames: await framesOf(picture, picture.frames > 1), delays: picture.delays }
}

export async function frameToPng(frame: Raw): Promise<Buffer> {
  return fromRaw(frame).png({ compressionLevel: 9 }).toBuffer()
}

/** EXIF, GPS, IPTC, XMP and the colour profile, as text, grouped. */
export async function readMetadata(path: string): Promise<ImageMetadata> {
  const bytes = await readFile(path)
  let raw: Record<string, Record<string, unknown> | undefined> | undefined
  try {
    raw = await exifr.parse(bytes, { tiff: true, ifd0: {}, exif: true, gps: true, interop: false, ifd1: false, iptc: true, xmp: true, icc: true, jfif: true, ihdr: true, mergeOutput: false, translateValues: true, reviveValues: true, sanitize: true } as never)
  } catch {
    raw = undefined
  }
  const groups: ImageMetadata['groups'] = []
  for (const [name, values] of Object.entries(raw ?? {})) {
    if (!values || typeof values !== 'object') continue
    const entries: Array<[string, string]> = []
    for (const [key, value] of Object.entries(values)) {
      const text = show(value)
      if (text) entries.push([key, text])
    }
    if (entries.length) groups.push({ name: name.toUpperCase(), entries })
  }
  let location: ImageMetadata['location'] = null
  try {
    const g = await exifr.gps(bytes)
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) location = { latitude: g.latitude, longitude: g.longitude }
  } catch {
    location = null
  }
  return { groups, location }
}

function show(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) return ''
  if (Array.isArray(value)) return value.length > 16 ? '' : value.map(show).filter(Boolean).join(', ')
  if (typeof value === 'object') return ''
  const text = String(value).replace(/\0/g, '').trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

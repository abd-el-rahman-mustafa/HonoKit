import { constants, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { Animate, ImageJob, ImageResult, ImageRunResult } from '@shared/imageOps'
import { animatePictures, animationFrames, describeImage, detectRegions, frameToPng, readMetadata, runImageJob, sameFormat } from '@engine/img/tools'
import { encode, openBytes, openPicture } from '@engine/img/picture'
import type { Detect, Output } from '@shared/imageOps'
import { format } from '@shared/imageFormats'
import { writeNew } from './staging'

/**
 * The worker's image tools (decisions §69). The main process decides where each result goes
 * (`base`: folder and name, no extension); the worker picks the extension from the format it
 * wrote and never overwrites a file: "photo (compressed).jpg", then "photo (compressed) (2).jpg".
 */

export function freePath(base: string, ext: string): string {
  let path = `${base}.${ext}`
  for (let n = 2; existsSync(path); n++) path = `${base} (${n}).${ext}`
  return path
}

/**
 * "Try again" (decisions §77): an earlier result of this session, which the new one replaces so no
 * superseded file is left behind. Only a file named like a result of the same picture and tool
 * qualifies ("photo (compressed).jpg", "photo (compressed) (2).webp" for the base "photo
 * (compressed)"), never the source; main checks first that this session wrote it, unchanged since.
 */
export function replaceable(base: string, replacing: string | null | undefined, sources: string[]): string | null {
  if (!replacing || sources.some((s) => resolve(s).toLowerCase() === resolve(replacing).toLowerCase())) return null
  const stem = basename(base)
  const name = basename(replacing, extname(replacing))
  if (name !== stem && !(name.startsWith(`${stem} (`) && /^ \(\d+\)$/.test(name.slice(stem.length)))) return null
  return existsSync(replacing) ? replacing : null
}

/**
 * Writes a result. With an earlier result to replace: the same file is overwritten when the name and
 * extension still fit (written beside it first, then moved over it, so a failure leaves the old one);
 * otherwise the new file gets a free name and the old one is removed once the new one is written.
 */
async function writeResult(base: string, ext: string, write: (path: string) => Promise<void>, old: string | null): Promise<{ path: string; replaced?: string }> {
  await mkdir(dirname(base), { recursive: true })
  if (old && dirname(old).toLowerCase() === dirname(base).toLowerCase() && extname(old).toLowerCase() === `.${ext}`) {
    // A random name, created exclusively: a planted file or link there is never written through (§82).
    const part = `${old}.${randomBytes(8).toString('hex')}.part`
    try {
      await write(part)
      await rename(part, old)
      return { path: old, replaced: old }
    } catch (error) {
      // Only a file this call made is removed (not one already at that name).
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await rm(part, { force: true })
      // The old file could not be overwritten (held open elsewhere): write beside it instead.
    }
  }
  const path = freePath(base, ext)
  await write(path)
  if (old && old !== path) {
    try {
      await rm(old)
      return { path, replaced: old }
    } catch {
      return { path }
    }
  }
  return { path }
}

export async function imageRun(source: string, job: ImageJob, base: string, replacing?: string | null, progress?: (fraction: number) => void): Promise<ImageRunResult> {
  const started = Date.now()
  const out = await runImageJob(source, job, progress)
  const old = replaceable(base, replacing, [source])
  const original = await stat(source)
  const timing = { method: out.method, ms: Date.now() - started }
  // Compress: a picture that is already as small as it gets is kept as it was, not made bigger.
  if (job.output.neverLarger && !job.crop && !job.rotate && !job.resize && out.data.length >= original.size && extname(source).slice(1).toLowerCase() === out.ext) {
    const { path, replaced } = await writeResult(base, out.ext, (to) => copyFile(source, to, constants.COPYFILE_EXCL), old)
    return { source, path, size: original.size, width: out.width, height: out.height, format: out.format, frames: out.frames, unchanged: true, ...timing, replaced }
  }
  const { path, replaced } = await writeResult(base, out.ext, (to) => writeNew(to, out.data), old)
  return { source, path, size: out.data.length, width: out.width, height: out.height, format: out.format, frames: out.frames, quality: out.quality, missedTarget: out.missedTarget, ...timing, replaced }
}

export async function imageAnimate(sources: string[], options: Animate, base: string, replacing?: string | null): Promise<ImageRunResult> {
  const started = Date.now()
  const out = await animatePictures(sources, options)
  const { path, replaced } = await writeResult(base, options.format === 'apng' ? 'png' : options.format, (to) => writeNew(to, out.data), replaceable(base, replacing, sources))
  return { source: sources[0]!, path, size: out.data.length, width: out.width, height: out.height, format: options.format, frames: out.frames, ms: Date.now() - started, replaced }
}

/** Every frame of an animation as PNG files in a new folder beside `base`. */
export async function imageFrames(source: string, base: string): Promise<ImageResult[]> {
  const { frames } = await animationFrames(source)
  let folder = base
  for (let n = 2; existsSync(folder); n++) folder = `${base} (${n})`
  await mkdir(folder, { recursive: true })
  const stem = basename(source, extname(source))
  const digits = String(frames.length).length
  const results: ImageResult[] = []
  for (const [i, frame] of frames.entries()) {
    const path = join(folder, `${stem} ${String(i + 1).padStart(digits, '0')}.png`)
    const data = await frameToPng(frame)
    await writeNew(path, data)
    results.push({ source, path, size: data.length, width: frame.width, height: frame.height, format: 'png', frames: 1 })
  }
  return results
}

/** A picture's first frame, upright, as a quickly made PNG: the Photo editor works on it in the window. */
export async function imageDecode(path: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const picture = await openPicture(path)
  const { data, info } = await picture.pipeline().png({ compressionLevel: 1 }).toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }
}

/** Writes what the Photo editor drew (a PNG) in the chosen format, beside the original by default. */
export async function imageSaveEdited(png: Uint8Array, source: string, output: Output, base: string, replacing?: string | null): Promise<ImageRunResult> {
  const original = await openPicture(source)
  const edited = await openBytes(png, 'edited.png')
  const target = output.format === 'same' ? sameFormat(original) : output.format
  const spec = format(target)
  const sourceExt = extname(source).slice(1).toLowerCase()
  const ext = output.ext && spec.ext.includes(output.ext) ? output.ext : output.format === 'same' && spec.ext.includes(sourceExt) ? sourceExt : spec.ext[0]!
  const out = await encode(edited.pipeline(), { format: target, quality: output.quality ?? 92, background: output.background, iconSizes: output.iconSizes })
  // Saving again in the same editing session updates the copy saved before (§77).
  const { path, replaced } = await writeResult(base, ext, (to) => writeNew(to, out.data), replaceable(base, replacing, [source]))
  return { source, path, size: out.data.length, width: out.width, height: out.height, format: target, frames: 1, replaced }
}

export const imageDetect = (path: string, what: Detect): ReturnType<typeof detectRegions> => detectRegions(path, what)
export const imageDescribe = (path: string, size?: number): ReturnType<typeof describeImage> => describeImage(path, size ?? 320)
export const imageMetadata = (path: string): ReturnType<typeof readMetadata> => readMetadata(path)

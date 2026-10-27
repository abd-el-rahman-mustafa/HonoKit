import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { PdfError } from '../errors'

/**
 * The image tools' offline AI (decisions §69, docs/research-image-ai.md): four small models
 * shipped in resources/ai, run on the CPU by onnxruntime (the runtime OCR already uses).
 *   realesr-general-x4v3   Real-ESRGAN compact, BSD-3: upscale ×4 (×2 = ×4 then halved)
 *   u2netp                 U²-Net small, Apache-2.0: background removal
 *   YuNet 2026may          OpenCV, MIT: faces
 *   YOLOv9-t 384 plates    open-image-models, MIT: licence plates
 * Nothing is downloaded at run time; the larger background models are not shipped (owner, 2026-10-02).
 */

export const AI_MODELS = {
  upscale: 'realesr-general-x4v3.onnx',
  background: 'u2netp.onnx',
  faces: 'face_detection_yunet_2026may.onnx',
  plates: 'yolo-v9-t-384-license-plates-end2end.onnx'
} as const

export interface Raw {
  data: Buffer | Uint8Array
  width: number
  height: number
}

/** A detected area, in fractions of the picture. */
export interface Region {
  x: number
  y: number
  w: number
  h: number
  kind: 'face' | 'plate' | 'manual'
  score: number
}

let directory: string | null = null
const sessions = new Map<string, Promise<InferenceSession>>()

/** Tests: read the models from this folder (null: find them as the app does). Drops loaded models. */
export function useModelDirectory(dir: string | null): void {
  directory = dir
  sessions.clear()
}

/**
 * Whether `dir` holds **every** model. Choosing the folder on the face detector alone took one
 * left half-written by an interrupted install, or an empty folder named by POWERPDF_RESOURCES over
 * a complete `resources/ai` beside it, and the tool then failed inside onnxruntime with a
 * missing-file error instead of saying the installation is incomplete. The four models ship
 * together, so a folder missing one is not the models' folder.
 */
export const hasAiModels = (dir: string): boolean => Object.values(AI_MODELS).every((file) => existsSync(join(dir, file)))

function modelDirectory(): string {
  if (directory) return directory
  const candidates = [process.env.POWERPDF_RESOURCES && join(process.env.POWERPDF_RESOURCES, 'ai'), resolve(process.cwd(), 'resources', 'ai')].filter(Boolean) as string[]
  const found = candidates.find(hasAiModels)
  if (!found) throw new PdfError('unsupported', 'The image AI models are missing from this installation.')
  directory = found
  return found
}

async function session(file: string): Promise<InferenceSession> {
  if (!sessions.has(file)) {
    const ort = await import('onnxruntime-node')
    const threads = Math.max(1, Math.min(8, (await import('node:os')).availableParallelism() - 1))
    const created = (async () => ort.InferenceSession.create(readFileSync(join(modelDirectory(), file)), { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 }))()
    // A model that could not load is tried again next time, not remembered as broken.
    created.catch(() => sessions.delete(file))
    sessions.set(file, created)
  }
  return sessions.get(file)!
}

async function run(file: string, data: Float32Array, dims: number[]): Promise<Record<string, Tensor>> {
  const ort = await import('onnxruntime-node')
  const model = await session(file)
  return model.run({ [model.inputNames[0]!]: new ort.Tensor('float32', data, dims) })
}

/** RGBA → planar float RGB (or BGR), multiplied by `scale`. */
function planar(raw: Raw, x0: number, y0: number, w: number, h: number, scale: number, bgr = false): Float32Array {
  const out = new Float32Array(3 * w * h)
  const plane = w * h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * raw.width + (x0 + x)) * 4
      const o = y * w + x
      const r = raw.data[i]! * scale
      const g = raw.data[i + 1]! * scale
      const b = raw.data[i + 2]! * scale
      out[o] = bgr ? b : r
      out[plane + o] = g
      out[2 * plane + o] = bgr ? r : b
    }
  }
  return out
}

// --- upscale -----------------------------------------------------------------------------

const TILE = 192
const PAD = 16

/**
 * Upscales by 2 or 4 with Real-ESRGAN, in tiles of 192 px with 16 px of context each side (the
 * seams then match), so a big photo never needs gigabytes. Transparency is enlarged separately.
 */
export async function upscale(raw: Raw, factor: 2 | 4, progress?: (fraction: number) => void): Promise<Raw> {
  const S = 4
  const W = raw.width
  const H = raw.height
  const outW = W * S
  const outH = H * S
  const out = Buffer.alloc(outW * outH * 4)
  const cols = Math.ceil(W / TILE)
  const rows = Math.ceil(H / TILE)
  let done = 0
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * TILE
      const y0 = ty * TILE
      const x1 = Math.min(W, x0 + TILE)
      const y1 = Math.min(H, y0 + TILE)
      const px0 = Math.max(0, x0 - PAD)
      const py0 = Math.max(0, y0 - PAD)
      const px1 = Math.min(W, x1 + PAD)
      const py1 = Math.min(H, y1 + PAD)
      const pw = px1 - px0
      const ph = py1 - py0
      const result = await run(AI_MODELS.upscale, planar(raw, px0, py0, pw, ph, 1 / 255), [1, 3, ph, pw])
      const t = Object.values(result)[0]!.data as Float32Array
      const plane = pw * S * ph * S
      // Copy the tile's own part, without its context, into place.
      for (let y = (y0 - py0) * S; y < (y1 - py0) * S; y++) {
        for (let x = (x0 - px0) * S; x < (x1 - px0) * S; x++) {
          const s = y * pw * S + x
          const o = ((py0 * S + y) * outW + (px0 * S + x)) * 4
          out[o] = Math.max(0, Math.min(255, Math.round(t[s]! * 255)))
          out[o + 1] = Math.max(0, Math.min(255, Math.round(t[plane + s]! * 255)))
          out[o + 2] = Math.max(0, Math.min(255, Math.round(t[2 * plane + s]! * 255)))
          out[o + 3] = 255
        }
      }
      progress?.(++done / (rows * cols))
    }
  }
  // Transparency: the original alpha enlarged smoothly, when there is any.
  let transparent = false
  for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i]! < 255) {
    transparent = true
    break
  }
  if (transparent) {
    const alpha = await sharp(Buffer.from(raw.data), { raw: { width: W, height: H, channels: 4 } }).extractChannel(3).resize(outW, outH, { kernel: 'lanczos3' }).raw().toBuffer()
    for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i]!
  }
  if (factor === 4) return { data: out, width: outW, height: outH }
  const half = await sharp(out, { raw: { width: outW, height: outH, channels: 4 } }).resize(W * 2, H * 2, { kernel: 'lanczos3' }).raw().toBuffer()
  return { data: half, width: W * 2, height: H * 2 }
}

// --- background --------------------------------------------------------------------------

const BG = 320

/**
 * The subject's mask (0 = background, 255 = subject) at the picture's size: U²-Net-p at 320 px,
 * stretched to 0–1, enlarged smoothly and tightened a little so edges stay clean.
 */
export async function subjectMask(raw: Raw): Promise<Buffer> {
  const small = await sharp(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: 4 } }).removeAlpha().resize(BG, BG, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  let max = 1
  for (const v of small) if (v > max) max = v
  const input = new Float32Array(3 * BG * BG)
  for (let i = 0; i < BG * BG; i++) for (let c = 0; c < 3; c++) input[c * BG * BG + i] = (small[i * 3 + c]! / max - mean[c]!) / std[c]!
  const result = await run(AI_MODELS.background, input, [1, 3, BG, BG])
  const model = await session(AI_MODELS.background)
  const pred = result[model.outputNames[0]!]!.data as Float32Array
  let lo = Infinity
  let hi = -Infinity
  for (const v of pred) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const mask = Buffer.alloc(BG * BG)
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(((pred[i]! - lo) / Math.max(1e-6, hi - lo)) * 255)
  // One channel out: sharp may otherwise hand back a grey picture as three.
  const big = await sharp(mask, { raw: { width: BG, height: BG, channels: 1 } }).resize(raw.width, raw.height, { fit: 'fill', kernel: 'cubic' }).blur(0.6).extractChannel(0).raw().toBuffer()
  if (big.length !== raw.width * raw.height) throw new Error('background mask has the wrong size')
  // A gentle curve: faint haze becomes background, near-certain subject becomes solid.
  for (let i = 0; i < big.length; i++) big[i] = Math.max(0, Math.min(255, Math.round(((big[i]! - 40) * 255) / 175)))
  return big
}

/** The picture with its background removed (transparent), or replaced by a colour. */
export async function removeBackground(raw: Raw, background: string | null): Promise<Raw> {
  const mask = await subjectMask(raw)
  const out = Buffer.from(raw.data)
  for (let i = 0; i < mask.length; i++) out[i * 4 + 3] = Math.round((out[i * 4 + 3]! * mask[i]!) / 255)
  if (!background) return { data: out, width: raw.width, height: raw.height }
  const flat = await sharp(out, { raw: { width: raw.width, height: raw.height, channels: 4 } }).flatten({ background }).ensureAlpha().raw().toBuffer()
  return { data: flat, width: raw.width, height: raw.height }
}

// --- faces and plates --------------------------------------------------------------------

function iou(a: Region, b: Region): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = x * y
  return inter / Math.max(1e-9, a.w * a.h + b.w * b.h - inter)
}

function nms(regions: Region[], threshold: number): Region[] {
  const kept: Region[] = []
  for (const r of [...regions].sort((a, b) => b.score - a.score)) if (!kept.some((k) => iou(k, r) > threshold)) kept.push(r)
  return kept
}

/**
 * Faces with YuNet. It finds faces of roughly 10–300 px, so the picture is searched at several
 * sizes (a group photo's small faces, a portrait's one big face) and the finds merged.
 * `sensitivity`: 'low' finds only clear faces, 'high' also doubtful ones (privacy first).
 */
export async function detectFaces(raw: Raw, sensitivity: 'low' | 'normal' | 'high' = 'normal'): Promise<Region[]> {
  const threshold = { low: 0.75, normal: 0.6, high: 0.45 }[sensitivity]
  const longest = Math.max(raw.width, raw.height)
  const sizes = [...new Set([320, 640, 1280, 1920].filter((s) => s <= Math.max(320, longest)).concat(longest <= 1920 ? [longest] : []))]
  const found: Region[] = []
  for (const size of sizes) {
    const scale = size / longest
    const w = Math.max(32, Math.round(raw.width * scale))
    const h = Math.max(32, Math.round(raw.height * scale))
    const pw = Math.ceil(w / 32) * 32
    const ph = Math.ceil(h / 32) * 32
    const pixels = await sharp(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: 4 } })
      .resize(w, h, { fit: 'fill' })
      .extend({ right: pw - w, bottom: ph - h, background: '#000000' })
      .ensureAlpha()
      .raw()
      .toBuffer()
    const out = await run(AI_MODELS.faces, planar({ data: pixels, width: pw, height: ph }, 0, 0, pw, ph, 1, true), [1, 3, ph, pw])
    for (const stride of [8, 16, 32]) {
      const cls = out[`cls_${stride}`]!.data as Float32Array
      const obj = out[`obj_${stride}`]!.data as Float32Array
      const box = out[`bbox_${stride}`]!.data as Float32Array
      const cols = pw / stride
      for (let i = 0; i < cls.length; i++) {
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)))
        if (score < threshold) continue
        const r = Math.floor(i / cols)
        const c = i % cols
        const cx = (c + box[i * 4]!) * stride
        const cy = (r + box[i * 4 + 1]!) * stride
        const bw = Math.exp(box[i * 4 + 2]!) * stride
        const bh = Math.exp(box[i * 4 + 3]!) * stride
        found.push({ x: (cx - bw / 2) / w, y: (cy - bh / 2) / h, w: bw / w, h: bh / h, kind: 'face', score })
      }
    }
  }
  return nms(found, 0.3).filter((r) => r.w > 0 && r.h > 0)
}

const PLATE = 384

/** Licence plates with YOLOv9-t (its graph already merges overlapping finds). */
export async function detectPlates(raw: Raw, sensitivity: 'low' | 'normal' | 'high' = 'normal'): Promise<Region[]> {
  const threshold = { low: 0.6, normal: 0.4, high: 0.25 }[sensitivity]
  const scale = PLATE / Math.max(raw.width, raw.height)
  const w = Math.round(raw.width * scale)
  const h = Math.round(raw.height * scale)
  const left = Math.floor((PLATE - w) / 2)
  const top = Math.floor((PLATE - h) / 2)
  const pixels = await sharp(Buffer.from(raw.data), { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize(w, h, { fit: 'fill' })
    .extend({ left, top, right: PLATE - w - left, bottom: PLATE - h - top, background: { r: 114, g: 114, b: 114, alpha: 1 } })
    .ensureAlpha()
    .raw()
    .toBuffer()
  const out = await run(AI_MODELS.plates, planar({ data: pixels, width: PLATE, height: PLATE }, 0, 0, PLATE, PLATE, 1 / 255), [1, 3, PLATE, PLATE])
  const rows = Object.values(out)[0]!.data as Float32Array
  const found: Region[] = []
  // Each row: batch, x1, y1, x2, y2, class, score — in the 384 px letterboxed picture.
  for (let i = 0; i + 6 < rows.length; i += 7) {
    const score = rows[i + 6]!
    if (score < threshold) continue
    const x1 = (rows[i + 1]! - left) / w
    const y1 = (rows[i + 2]! - top) / h
    const x2 = (rows[i + 3]! - left) / w
    const y2 = (rows[i + 4]! - top) / h
    found.push({ x: Math.max(0, x1), y: Math.max(0, y1), w: Math.min(1, x2) - Math.max(0, x1), h: Math.min(1, y2) - Math.max(0, y1), kind: 'plate', score })
  }
  return found.filter((r) => r.w > 0 && r.h > 0)
}

// --- hiding ------------------------------------------------------------------------------

export type HideStyle = 'blur' | 'pixelate' | 'box'

/**
 * Hides each area: blurred or pixelated past recognition, or covered in black. Faces get an
 * oval with a soft edge, plates and hand-drawn boxes a rectangle. Areas are grown a little:
 * detectors draw tight boxes, and a forehead or chin left sharp still identifies a person.
 */
export async function hideRegions(raw: Raw, regions: Array<Pick<Region, 'x' | 'y' | 'w' | 'h' | 'kind'>>, style: HideStyle, strength: number): Promise<Raw> {
  const W = raw.width
  const H = raw.height
  const overlays: OverlayOptions[] = []
  for (const r of regions) {
    const grow = r.kind === 'face' ? 0.2 : 0.06
    const x0 = Math.max(0, Math.floor((r.x - r.w * grow) * W))
    const y0 = Math.max(0, Math.floor((r.y - r.h * grow * (r.kind === 'face' ? 1.3 : 1)) * H))
    const x1 = Math.min(W, Math.ceil((r.x + r.w * (1 + grow)) * W))
    const y1 = Math.min(H, Math.ceil((r.y + r.h * (1 + grow)) * H))
    const w = x1 - x0
    const h = y1 - y0
    if (w < 2 || h < 2) continue
    const region = sharp(Buffer.from(raw.data), { raw: { width: W, height: H, channels: 4 } }).extract({ left: x0, top: y0, width: w, height: h })
    let hidden: Buffer
    if (style === 'box') hidden = await sharp({ create: { width: w, height: h, channels: 4, background: '#000000' } }).raw().toBuffer()
    else if (style === 'pixelate') {
      const blocks = Math.max(3, Math.round(16 - strength * 0.12))
      const bw = Math.max(1, Math.round(blocks * Math.min(1, w / h)))
      const bh = Math.max(1, Math.round(blocks * Math.min(1, h / w)))
      hidden = await sharp(await region.resize(bw, bh, { kernel: 'cubic' }).raw().toBuffer(), { raw: { width: bw, height: bh, channels: 4 } }).resize(w, h, { kernel: 'nearest' }).raw().toBuffer()
    } else {
      const sigma = Math.max(2, (Math.min(w, h) * (0.05 + strength / 400)))
      hidden = await region.blur(sigma).raw().toBuffer()
    }
    // The shape: an oval with a soft edge for faces, a rectangle otherwise.
    if (r.kind === 'face' && style !== 'box') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="g"><stop offset="0.8" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="url(#g)"/></svg>`
      const shape = await sharp(Buffer.from(svg)).extractChannel(3).raw().toBuffer()
      for (let i = 0; i < w * h; i++) hidden[i * 4 + 3] = Math.round((hidden[i * 4 + 3]! * shape[i]!) / 255)
    }
    overlays.push({ input: hidden, raw: { width: w, height: h, channels: 4 }, left: x0, top: y0 })
  }
  if (!overlays.length) return raw
  const data = await sharp(Buffer.from(raw.data), { raw: { width: W, height: H, channels: 4 } }).composite(overlays).raw().toBuffer()
  return { data, width: W, height: H }
}

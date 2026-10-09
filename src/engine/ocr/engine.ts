import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { boxesFromProbability, overlapOfSmaller, type TextBox } from './boxes'
import { alphabetFrom, decodeCtc, type DecodedChar } from './ctc'
import { visualToLogical } from './order'

/**
 * Reading text out of page pictures (docs/decisions.md §52), in the worker, offline:
 * PaddleOCR's models run by onnxruntime (spike S5). A detector finds
 * the lines; each line is read by the Arabic recogniser (PP-OCRv5, which also reads Latin
 * and digits) or the Latin one (PP-OCRv4). Pictures are scaled here in plain code, so no
 * canvas library is needed.
 *
 * Memory (S5): the detector runs without onnxruntime's memory arena — that alone took the
 * peak from ~1.1 GB to ~320 MB — and every model is released when the job ends.
 */

export interface RgbaImage {
  data: Uint8Array
  width: number
  height: number
}

export type Recogniser = 'arabic' | 'latin'

export interface Reading {
  text: string
  confidence: number
}

const MODELS = {
  detector: 'ch_PP-OCRv4_det_infer.onnx',
  latin: 'ch_PP-OCRv4_rec_infer.onnx',
  latinKeys: 'ppocr_keys_v1.txt',
  arabic: 'arabic_PP-OCRv5_mobile_rec.onnx',
  arabicKeys: 'arabic_PP-OCRv5_mobile_rec_dict.txt'
}

let directory: string | null = null

/** The application sets this at start-up; tests use the repository's resources folder. */
export function setOcrDirectory(dir: string): void {
  directory = dir
}

function modelDirectory(): string {
  if (directory) return directory
  const candidates = [process.env.POWERPDF_RESOURCES && join(process.env.POWERPDF_RESOURCES, 'ocr'), resolve(process.cwd(), 'resources', 'ocr')].filter(Boolean) as string[]
  const found = candidates.find((d) => existsSync(join(d, MODELS.detector)))
  if (!found) throw new Error('The text recognition models are missing from this installation.')
  directory = found
  return found
}

/** Recognisers read a line scaled to this height, as they were trained. */
const LINE_HEIGHT = 48
/** Lines are read a little wider than their shape: doubled digits survive (S5: 1.3–1.6× read all). */
const LINE_STRETCH = 1.5
const DETECT_BAND = 1280
const DETECT_OVERLAP = 96

/**
 * `image` scaled into a white `width`×`height` picture (drawn at `drawWidth`×`drawHeight` from the
 * top-left), as the planes the models take: blue first (they were trained on OpenCV's BGR), normalised.
 */
function toPlanes(image: RgbaImage, width: number, height: number, drawWidth: number, drawHeight: number, mean: number[], std: number[]): Float32Array {
  const plane = width * height
  const out = new Float32Array(3 * plane)
  const sx = image.width / drawWidth
  const sy = image.height / drawHeight
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 255
      let g = 255
      let b = 255
      if (x < drawWidth && y < drawHeight) {
        // Bilinear sample of the source. (Channel order and mean/std exactly as the S5 engine, which was measured.)
        const fx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * sx - 0.5))
        const fy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * sy - 0.5))
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const x1 = Math.min(image.width - 1, x0 + 1)
        const y1 = Math.min(image.height - 1, y0 + 1)
        const dx = fx - x0
        const dy = fy - y0
        const at = (xx: number, yy: number, c: number): number => image.data[(yy * image.width + xx) * 4 + c]!
        const mix = (c: number): number => (at(x0, y0, c) * (1 - dx) + at(x1, y0, c) * dx) * (1 - dy) + (at(x0, y1, c) * (1 - dx) + at(x1, y1, c) * dx) * dy
        r = mix(0)
        g = mix(1)
        b = mix(2)
      }
      const i = y * width + x
      out[i] = (b / 255 - mean[0]!) / std[0]!
      out[plane + i] = (g / 255 - mean[1]!) / std[1]!
      out[2 * plane + i] = (r / 255 - mean[2]!) / std[2]!
    }
  }
  return out
}

export function cropImage(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const left = Math.max(0, Math.round(x))
  const top = Math.max(0, Math.round(y))
  const w = Math.max(1, Math.min(image.width - left, Math.round(width)))
  const h = Math.max(1, Math.min(image.height - top, Math.round(height)))
  const data = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const from = ((top + row) * image.width + left) * 4
    data.set(image.data.subarray(from, from + w * 4), row * w * 4)
  }
  return { data, width: w, height: h }
}

/**
 * The Latin recogniser (trained mostly on Chinese, which has no spaces) often runs words
 * together. Where two letters were read much further apart than letters usually are, a
 * word ended: a space goes there.
 */
function withSpaces(chars: DecodedChar[]): string {
  const gaps: number[] = []
  for (let i = 1; i < chars.length; i++) if (chars[i]!.char !== ' ' && chars[i - 1]!.char !== ' ') gaps.push(chars[i]!.step - chars[i - 1]!.step)
  const sorted = [...gaps].sort((a, b) => a - b)
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0
  let out = chars[0]?.char ?? ''
  for (let i = 1; i < chars.length; i++) {
    const gap = chars[i]!.step - chars[i - 1]!.step
    if (chars[i]!.char !== ' ' && chars[i - 1]!.char !== ' ' && typical > 0 && gap >= Math.max(3, typical * 1.8)) out += ' '
    out += chars[i]!.char
  }
  return out.replace(/ {2,}/g, ' ')
}

export interface OcrEngine {
  detectLines(image: RgbaImage): Promise<TextBox[]>
  read(line: RgbaImage, recogniser: Recogniser): Promise<Reading>
  release(): Promise<void>
}

export async function openOcr(threads = 4): Promise<OcrEngine> {
  const dir = modelDirectory()
  const ort = await import('onnxruntime-node')
  const base: InferenceSession.SessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 }
  const sessions = new Map<string, Promise<InferenceSession>>()
  const session = (file: string, arena: boolean): Promise<InferenceSession> => {
    if (!sessions.has(file)) sessions.set(file, ort.InferenceSession.create(readFileSync(join(dir, file)), { ...base, enableCpuMemArena: arena, enableMemPattern: arena }))
    return sessions.get(file)!
  }
  const alphabets = {
    latin: alphabetFrom(readFileSync(join(dir, MODELS.latinKeys), 'utf8')),
    arabic: alphabetFrom(readFileSync(join(dir, MODELS.arabicKeys), 'utf8'))
  }
  const run = async (model: InferenceSession, data: Float32Array, dims: number[]): Promise<Tensor> => {
    const input = new ort.Tensor('float32', data, dims)
    const outputs = await model.run({ [model.inputNames[0]!]: input })
    return outputs[model.outputNames[0]!]!
  }
  return {
    async detectLines(image) {
      const model = await session(MODELS.detector, false)
      const found: TextBox[] = []
      for (let top = 0; top < image.height; top += DETECT_BAND - DETECT_OVERLAP) {
        const bandHeight = Math.min(DETECT_BAND, image.height - top)
        const band: RgbaImage = { data: image.data.subarray(top * image.width * 4, (top + bandHeight) * image.width * 4), width: image.width, height: bandHeight }
        const width = Math.ceil(image.width / 32) * 32
        const height = Math.ceil(bandHeight / 32) * 32
        const out = await run(model, toPlanes(band, width, height, image.width, bandHeight, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, height, width])
        for (const box of boxesFromProbability(out.data as Float32Array, width, height, { width: image.width, height: bandHeight })) {
          const placed = { ...box, y: box.y + top }
          // A line cut by a band edge is found twice; keep the larger copy.
          const twin = found.findIndex((other) => overlapOfSmaller(other, placed) > 0.5)
          if (twin < 0) found.push(placed)
          else if (placed.w * placed.h > found[twin]!.w * found[twin]!.h) found[twin] = placed
        }
        if (top + bandHeight >= image.height) break
      }
      return found.sort((a, b) => a.y - b.y || b.x - a.x)
    },
    async read(line, recogniser) {
      const width = Math.max(16, Math.round(((line.width * LINE_HEIGHT) / line.height) * LINE_STRETCH))
      const model = await session(recogniser === 'arabic' ? MODELS.arabic : MODELS.latin, true)
      const out = await run(model, toPlanes(line, width, LINE_HEIGHT, width, LINE_HEIGHT, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, LINE_HEIGHT, width])
      const [, steps, classes] = out.dims as number[]
      const decoded = decodeCtc(out.data as Float32Array, steps!, classes!, alphabets[recogniser])
      // Arabic text comes out in visual order; a line with no Arabic letters is Latin, and spaced like Latin.
      const arabic = recogniser === 'arabic' && /[؀-ۿ]/.test(decoded.text)
      return { text: arabic ? visualToLogical(decoded.text) : withSpaces(decoded.chars), confidence: decoded.confidence }
    },
    async release() {
      const opened = await Promise.allSettled(sessions.values())
      sessions.clear()
      await Promise.all(opened.map((s) => (s.status === 'fulfilled' ? s.value.release() : undefined)))
    }
  }
}

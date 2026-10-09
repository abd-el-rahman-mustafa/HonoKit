import { z } from 'zod'
import { FORMATS, type FormatId } from './imageFormats'

/**
 * What an image tool asks the worker to do with one picture (decisions §69). Every tool is the
 * same pipeline with different steps switched on: crop → rotate/flip → resize → write. The
 * window builds a job; the main process checks it with this schema; the worker runs it
 * (engine/img/tools.ts) once per file, so the board can show each file's progress.
 */

const formatIds = FORMATS.map((f) => f.id) as [FormatId, ...FormatId[]]

export const ResizeSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('pixels'),
    width: z.number().int().min(1).max(100_000).nullable(),
    height: z.number().int().min(1).max(100_000).nullable(),
    /** 'max': fit inside width × height, keeping the shape; 'exact': exactly that size. */
    fit: z.enum(['max', 'exact', 'cover']),
    noEnlarge: z.boolean()
  }),
  z.object({ by: z.literal('percent'), percent: z.number().min(1).max(1000) }),
  /** The longest side becomes this many pixels. */
  z.object({ by: z.literal('longest'), pixels: z.number().int().min(1).max(100_000), noEnlarge: z.boolean() })
])
export type Resize = z.infer<typeof ResizeSchema>

/** The size a resize gives a picture of `width` × `height` (what the board shows before running). */
export function resizedSize(width: number, height: number, resize: Resize): { width: number; height: number } {
  if (resize.by === 'percent') return { width: Math.max(1, Math.round((width * resize.percent) / 100)), height: Math.max(1, Math.round((height * resize.percent) / 100)) }
  if (resize.by === 'longest') {
    const scale = resize.pixels / Math.max(width, height)
    if (resize.noEnlarge && scale >= 1) return { width, height }
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  }
  const w = resize.width
  const h = resize.height
  if (!w && !h) return { width, height }
  let out: { width: number; height: number }
  if (resize.fit === 'max' || !w || !h) {
    const scale = Math.min(w ? w / width : Infinity, h ? h / height : Infinity)
    out = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  } else out = { width: w, height: h }
  if (resize.noEnlarge && (out.width > width || out.height > height)) {
    if (resize.fit === 'max' || !w || !h) return { width, height }
    out = { width: Math.min(out.width, width), height: Math.min(out.height, height) }
  }
  return out
}

export const CropSchema = z.discriminatedUnion('by', [
  /** A box in fractions (0–1) of the upright picture, so one box suits pictures of any size. */
  z.object({ by: z.literal('box'), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.0001).max(1), height: z.number().min(0.0001).max(1) }),
  /** The largest box of this shape (width : height), placed by `position`; 'smart' finds the subject. */
  z.object({ by: z.literal('ratio'), ratio: z.number().min(0.01).max(100), position: z.enum(['centre', 'top', 'bottom', 'left', 'right', 'smart']) })
])
export type Crop = z.infer<typeof CropSchema>

export const RotateSchema = z.object({
  /** Degrees clockwise, any angle; the corners a free angle uncovers get `background`. */
  angle: z.number().min(-360).max(360),
  flipH: z.boolean(),
  flipV: z.boolean(),
  background: z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i).optional()
})
export type Rotate = z.infer<typeof RotateSchema>

/**
 * A mark laid on every picture (Watermark image, Meme generator). Text is drawn by the window into
 * a PNG (Chromium shapes Arabic and joins its letters), so what is previewed is what is written;
 * a picture mark is read from its file. Placement is relative, so one layout suits every size.
 */
export const LayerSchema = z.object({
  source: z.union([z.object({ png: z.string().min(16).max(30_000_000) }), z.object({ path: z.string().min(1).max(4000) })]),
  /** Centre, as fractions of the picture's width and height. */
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  /** Width as a fraction of the picture's width. */
  width: z.number().min(0.005).max(4),
  /** Degrees clockwise. */
  rotate: z.number().min(-360).max(360),
  opacity: z.number().min(0).max(1),
  /** Repeat across the whole picture (mosaic), with this gap as a fraction of the mark's size. */
  tile: z.object({ gap: z.number().min(0).max(5) }).optional()
})
export type Layer = z.infer<typeof LayerSchema>

export const MarksSchema = z.object({
  layers: z.array(LayerSchema).max(30),
  /** Meme "text outside": white bands added above and below, as fractions of the height. */
  bands: z.object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1), colour: z.string().regex(/^#[0-9a-f]{6}$/i) }).optional()
})
export type Marks = z.infer<typeof MarksSchema>

/** An area to hide (Blur faces), in fractions of the upright picture. */
export const RegionSchema = z.object({
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  w: z.number().min(0).max(2),
  h: z.number().min(0).max(2),
  kind: z.enum(['face', 'plate', 'manual'])
})
export type HideRegion = z.infer<typeof RegionSchema>

/** The offline AI steps (engine/img/ai.ts). Animations keep only their first frame. */
export const AiSchema = z.object({
  upscale: z.union([z.literal(2), z.literal(4)]).optional(),
  /** Remove the background: transparent (null) or this colour. */
  background: z.object({ colour: z.string().regex(/^#[0-9a-f]{6}$/i).nullable() }).optional(),
  hide: z.object({ regions: z.array(RegionSchema).max(1000), style: z.enum(['blur', 'pixelate', 'box']), strength: z.number().min(0).max(100) }).optional()
})
export type Ai = z.infer<typeof AiSchema>

/** What Blur faces looks for. */
export const DetectSchema = z.object({ faces: z.boolean(), plates: z.boolean(), sensitivity: z.enum(['low', 'normal', 'high']) })
export type Detect = z.infer<typeof DetectSchema>

/** A found area, with how sure the model is. */
export interface DetectedRegion extends HideRegion {
  score: number
}

export const OutputSchema = z.object({
  /** 'same' keeps each picture's own format when it can be written (else JPG or PNG). */
  format: z.union([z.literal('same'), z.enum(formatIds)]),
  /** The extension to write, when the format has several (.jpg / .jpeg / .jfif). */
  ext: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  lossless: z.boolean().optional(),
  /** Aim for at most this many bytes (lossy formats): the quality is lowered until it fits. */
  targetBytes: z.number().int().min(1024).max(2_000_000_000).optional(),
  background: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  keepMetadata: z.boolean().optional(),
  progressive: z.boolean().optional(),
  palette: z.boolean().optional(),
  colours: z.number().int().min(2).max(256).optional(),
  effort: z.number().int().min(0).max(10).optional(),
  iconSizes: z.array(z.number().int().min(16).max(1024)).max(12).optional(),
  tiffCompression: z.enum(['lzw', 'deflate', 'jpeg', 'none']).optional(),
  /** Keep every frame of an animation when the output format can hold one. */
  keepAnimation: z.boolean().optional(),
  /** Compress: when the result is not smaller than the original in the same format, keep the original. */
  neverLarger: z.boolean().optional()
})
export type Output = z.infer<typeof OutputSchema>

export const ImageJobSchema = z.object({
  crop: CropSchema.optional(),
  rotate: RotateSchema.optional(),
  resize: ResizeSchema.optional(),
  marks: MarksSchema.optional(),
  ai: AiSchema.optional(),
  /** For PDF and multi-page files: which page (0-based). */
  page: z.number().int().min(0).max(100_000).optional(),
  output: OutputSchema
})
export type ImageJob = z.infer<typeof ImageJobSchema>

/** Several pictures as one animation (Make GIF). */
export const AnimateSchema = z.object({
  format: z.enum(['gif', 'webp', 'apng']),
  /** Milliseconds each picture shows. */
  delay: z.number().int().min(20).max(120_000),
  loop: z.boolean(),
  /** Every frame is fitted into this size; null = the first picture's size. */
  width: z.number().int().min(1).max(4000).nullable(),
  height: z.number().int().min(1).max(4000).nullable(),
  fit: z.enum(['contain', 'cover']),
  background: z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i),
  quality: z.number().int().min(1).max(100).optional()
})
export type Animate = z.infer<typeof AnimateSchema>

/** Where results go: beside each original, or one folder; names get a suffix and never overwrite. */
export const DestinationSchema = z.object({
  folder: z.string().max(4000).nullable(),
  suffix: z.string().max(60)
})
export type Destination = z.infer<typeof DestinationSchema>

/** What a picture is, for the board's cards and the Info tool. */
export interface ImageFileInfo {
  path: string
  name: string
  format: FormatId
  /** Bytes on disk. */
  size: number
  width: number
  height: number
  frames: number
  hasAlpha: boolean
  density: number | null
  /** A small picture for the card (data: URL), any format. */
  preview: string
}

export interface ImageResult {
  source: string
  path: string
  size: number
  width: number
  height: number
  format: FormatId
  frames: number
}

/**
 * How a picture was really made, said plainly on the result screen (decisions §77): an AI step
 * names its model; an upscale the AI could not do is a smooth resize, with the reason.
 */
export interface ImageMethod {
  kind: 'ai-upscale' | 'smooth-upscale' | 'ai-background' | 'hidden'
  /** The model file, for an AI step. */
  model?: string
  /** Why the AI was not used (smooth-upscale). */
  reason?: string
  /** Hidden areas (Blur faces). */
  count?: number
}

/** One picture's result: the quality a target size chose, or that the original was kept. */
export interface ImageRunResult extends ImageResult {
  quality?: number
  missedTarget?: boolean
  unchanged?: boolean
  method?: ImageMethod
  /** How long the work took, in milliseconds. */
  ms?: number
  /** An earlier result of this session that this one replaced ("Try again", §77). */
  replaced?: string
}

/** EXIF, GPS and the rest, as label → value pairs grouped for display. */
export interface ImageMetadata {
  groups: Array<{ name: string; entries: Array<[string, string]> }>
  /** Has a location (GPS). */
  location: { latitude: number; longitude: number } | null
}

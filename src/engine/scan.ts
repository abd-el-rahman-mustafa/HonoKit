import { PDFDocument } from 'pdf-lib'
import { PdfError } from './errors'
import { free, mupdf } from './mupdf'
import { exifOrientation, orientationTurn } from '@shared/exif'

export { exifOrientation, orientationTurn }

/**
 * Photos and scans made clean (docs/decisions.md §61): the page found in a photo, straightened,
 * and cleaned up — colour, grayscale or black and white — as a scanner app does. Used by Scan
 * documents, Scan ID card and Image to Text/Word/Excel.
 *
 * Corners are given in the picture's own pixels, after its EXIF orientation is applied (a phone
 * photo taken upright has orientation 6 and is stored sideways), in the order top-left,
 * top-right, bottom-right, bottom-left.
 */
export type Point = [number, number]
export type Corners = [Point, Point, Point, Point]
export type ScanMode = 'original' | 'color' | 'gray' | 'bw'

export interface ScanOptions {
  /** The page in the picture; the whole picture when absent. */
  corners?: Corners | null
  mode: ScanMode
  /** A further turn, clockwise. */
  rotate?: 0 | 90 | 180 | 270
  /** The longest side of the result, in pixels. */
  maxSide?: number
}

export interface ScannedImage {
  bytes: Uint8Array
  format: 'jpeg' | 'png'
  width: number
  height: number
}

/** The picture's corners, clockwise from top-left, as seen after turning it `turn` degrees clockwise. */
function turnedCorners(w: number, h: number, turn: 0 | 90 | 180 | 270): Corners {
  const tl: Point = [0, 0]
  const tr: Point = [w, 0]
  const br: Point = [w, h]
  const bl: Point = [0, h]
  if (turn === 90) return [bl, tl, tr, br]
  if (turn === 180) return [br, bl, tl, tr]
  if (turn === 270) return [tr, br, bl, tl]
  return [tl, tr, br, bl]
}

/** MuPDF.js's warp takes the corners clockwise from top-left, as Corners are (checked in test/scan.test.ts). */
const quad = (c: Corners): Point[] => [c[0], c[1], c[2], c[3]]

/** The picture decoded as RGB, upright (its EXIF orientation applied). */
export function loadUpright(bytes: Uint8Array): mupdf.Pixmap {
  let image: mupdf.Image
  try {
    image = new mupdf.Image(bytes)
  } catch (error) {
    throw new PdfError('bad-arguments', `This picture could not be read: ${(error as Error).message}`)
  }
  let pix = image.toPixmap()
  image.destroy()
  if (pix.getColorSpace()?.getName() !== 'DeviceRGB' || pix.getAlpha()) {
    const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false)
    pix.destroy()
    pix = rgb
  }
  const turn = orientationTurn(exifOrientation(bytes))
  if (turn === 0) return pix
  const w = pix.getWidth()
  const h = pix.getHeight()
  const [outW, outH] = turn === 180 ? [w, h] : [h, w]
  const upright = pix.warp(quad(turnedCorners(w, h, turn)), outW, outH)
  pix.destroy()
  return upright
}

/**
 * How far each pixel's colour is from the table's, on a copy scaled so its longest side is `side`.
 * The table's colour is the median of the picture's border: whatever the page or card is — white
 * paper, a card with a dark blue band — it differs from what it lies on.
 */
function smallDifference(pix: mupdf.Pixmap, side: number): { gray: Uint8Array; w: number; h: number; k: number; table: [number, number, number] } {
  const W = pix.getWidth()
  const H = pix.getHeight()
  const k = Math.min(1, side / Math.max(W, H))
  const w = Math.max(8, Math.round(W * k))
  const h = Math.max(8, Math.round(H * k))
  const small = pix.warp(quad([[0, 0], [W, 0], [W, H], [0, H]]), w, h)
  const px = small.getPixels()
  const n = small.getNumberOfComponents()
  const stride = small.getStride()
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.03))
  const border: number[][] = [[], [], []]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= edge && x < w - edge && y >= edge && y < h - edge) continue
    const o = y * stride + x * n
    for (let c = 0; c < 3; c++) border[c]!.push(px[o + c]!)
  }
  const table = border.map((values) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0) as [number, number, number]
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride + x * n
    gray[y * w + x] = Math.min(255, (Math.abs(px[o]! - table[0]!) + Math.abs(px[o + 1]! - table[1]!) + Math.abs(px[o + 2]! - table[2]!)) / 1.5)
  }
  small.destroy()
  return { gray, w, h, k: W / w, table }
}

/**
 * Where the page is in a photo: the largest region that differs from the table it lies on (its
 * colour taken from the picture's border), and its four extreme corners. Null when no clear page stands out — the whole
 * picture is then used, and the person can drag the corners.
 */
export function findPage(pix: mupdf.Pixmap): Corners | null {
  const { gray, w, h, k } = smallDifference(pix, 640)
  // Differs from the table: clearly more than the table itself varies (its grain, the light across it),
  // measured on the border. Not Otsu: with a light card body and a dark band, Otsu split the card.
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.03))
  const border: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < edge || x >= w - edge || y < edge || y >= h - edge) border.push(gray[y * w + x]!)
  border.sort((p, q) => p - q)
  const t = Math.min(110, Math.max(28, border[Math.floor(border.length * 0.95)]! * 1.8))
  // The bright pixels, as regions; the largest one is the page.
  const label = new Int32Array(w * h).fill(-1)
  let bestSize = 0
  let bestLabel = -1
  let next = 0
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || gray[start]! <= t) continue
    let size = 0
    stack.push(start)
    label[start] = next
    while (stack.length) {
      const p = stack.pop()!
      size++
      const x = p % w
      const y = (p - x) / w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && label[q] === -1 && gray[q]! > t) {
          label[q] = next
          stack.push(q)
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      bestLabel = next
    }
    next++
  }
  const share = bestSize / (w * h)
  // Too small to be the page, or the whole frame (the page fills the photo, or a white table).
  if (share < 0.08 || share > 0.97) return null
  let tl = [Infinity, 0, 0]
  let br = [-Infinity, 0, 0]
  let tr = [-Infinity, 0, 0]
  let bl = [Infinity, 0, 0]
  for (let p = 0; p < w * h; p++) {
    if (label[p] !== bestLabel) continue
    const x = p % w
    const y = (p - x) / w
    if (x + y < tl[0]!) tl = [x + y, x, y]
    if (x + y > br[0]!) br = [x + y, x, y]
    if (x - y > tr[0]!) tr = [x - y, x, y]
    if (x - y < bl[0]!) bl = [x - y, x, y]
  }
  const at = (c: number[]): Point => [Math.round((c[1]! + 0.5) * k), Math.round((c[2]! + 0.5) * k)]
  return [at(tl), at(tr), at(br), at(bl)]
}

const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The size a page with these corners straightens to: its edges' average lengths, capped. */
function outputSize(c: Corners, maxSide: number): [number, number] {
  let w = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2
  let h = (dist(c[0], c[3]) + dist(c[1], c[2])) / 2
  const k = Math.min(1, maxSide / Math.max(w, h))
  w = Math.max(16, Math.round(w * k))
  h = Math.max(16, Math.round(h * k))
  return [w, h]
}

/**
 * Colour or gray made clean, as scanner apps do: the paper's own tone (the brightest tenth of the
 * picture, averaged per channel) becomes white — a white balance — and one black point, from
 * brightness, is shared by all channels. Stretching each channel on its own shifted hues: a card's
 * blue band turned black and a gray-blue photo tan.
 */
function stretch(px: Uint8ClampedArray, n: number, channels: number): void {
  const lum = (i: number): number => (channels === 1 ? px[i]! : (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000)
  const hist = new Array<number>(256).fill(0)
  let count = 0
  for (let i = 0; i < px.length; i += n * 7) {
    hist[Math.round(lum(i))]!++
    count++
  }
  const at = (p: number): number => {
    let acc = 0
    for (let v = 0; v < 256; v++) if ((acc += hist[v]!) >= count * p) return v
    return 255
  }
  const bright = at(0.9)
  // The black point never rises into the paper: on a blank or sparse page (under 2% ink) the 2nd
  // percentile is the paper itself, and the whole page turned nearly black.
  const lo = Math.min(at(0.02), Math.round(bright * 0.5))
  // The paper's colour: the average of its brightest pixels, per channel.
  const paper = new Array<number>(channels).fill(0)
  let samples = 0
  for (let i = 0; i < px.length; i += n * 7) {
    if (lum(i) < bright) continue
    for (let c = 0; c < channels; c++) paper[c] = paper[c]! + px[i + c]!
    samples++
  }
  for (let c = 0; c < channels; c++) {
    const white = Math.max(lo + 40, samples ? paper[c]! / samples : 255)
    const scale = 255 / (white - lo)
    for (let i = c; i < px.length; i += n) px[i] = (px[i]! - lo) * scale
  }
}

/**
 * Black and white the way scanner apps do it: each pixel against the average of its
 * neighbourhood (Bradley's adaptive threshold), so shadows and uneven light do not blacken
 * the page.
 */
function adaptive(gray: Uint8Array, w: number, h: number): Uint8Array {
  const sums = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x]!
      sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1]! + row
    }
  }
  const r = Math.max(4, Math.round(Math.max(w, h) / 32))
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const area = (x1 - x0) * (y1 - y0)
      const sum = sums[y1 * (w + 1) + x1]! - sums[y0 * (w + 1) + x1]! - sums[y1 * (w + 1) + x0]! + sums[y0 * (w + 1) + x0]!
      out[y * w + x] = gray[y * w + x]! * area <= sum * 0.85 ? 0 : 255
    }
  }
  return out
}

/** The corners in the order the result is drawn: a further clockwise turn starts them from another corner. */
export function turnedSource(corners: Corners, turn: 0 | 90 | 180 | 270): Corners {
  if (!turn) return corners
  const steps = turn / 90
  return [0, 1, 2, 3].map((i) => corners[(i + 4 - steps) % 4]!) as Corners
}

/**
 * A straightened picture (RGB) cleaned and encoded. A photo has no real size; the page is taken to
 * be as long as A4 (MuPDF's default 96 dpi made "As scanned" pages three times A4's size).
 */
function finish(flat: mupdf.Pixmap, mode: ScanMode): ScannedImage {
  const w = flat.getWidth()
  const h = flat.getHeight()
  const dpi = Math.max(24, Math.min(1200, Math.round(Math.max(w, h) / (297 / 25.4))))
  flat.setResolution(dpi, dpi)
  const px = flat.getPixels()
  const n = flat.getNumberOfComponents()
  const stride = flat.getStride()
  if (mode === 'original') return { bytes: new Uint8Array(flat.asJPEG(90)), format: 'jpeg', width: w, height: h }
  if (mode === 'color') {
    stretch(px, n, 3)
    return { bytes: new Uint8Array(flat.asJPEG(88)), format: 'jpeg', width: w, height: h }
  }
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride + x * n
    gray[y * w + x] = (px[o]! * 299 + px[o + 1]! * 587 + px[o + 2]! * 114) / 1000
  }
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false)
  try {
    out.setResolution(dpi, dpi)
    const dst = out.getPixels()
    const dstStride = out.getStride()
    if (mode === 'gray') {
      const tmp = new Uint8ClampedArray(gray)
      stretch(tmp, 1, 1)
      for (let y = 0; y < h; y++) dst.set(tmp.subarray(y * w, (y + 1) * w), y * dstStride)
      return { bytes: new Uint8Array(out.asJPEG(88)), format: 'jpeg', width: w, height: h }
    }
    const bw = adaptive(gray, w, h)
    for (let y = 0; y < h; y++) dst.set(bw.subarray(y * w, (y + 1) * w), y * dstStride)
    return { bytes: new Uint8Array(out.asPNG()), format: 'png', width: w, height: h }
  } finally {
    out.destroy()
  }
}

/** Straightens and cleans one picture. */
export function scanPicture(bytes: Uint8Array, options: ScanOptions): ScannedImage {
  const pix = loadUpright(bytes)
  const owned: Array<{ destroy(): void }> = [pix]
  try {
    const W = pix.getWidth()
    const H = pix.getHeight()
    const corners = options.corners ?? ([[0, 0], [W, 0], [W, H], [0, H]] as Corners)
    let [w, h] = outputSize(corners, options.maxSide ?? 3400)
    const turn = options.rotate ?? 0
    if (turn === 90 || turn === 270) [w, h] = [h, w]
    const flat = pix.warp(quad(turnedSource(corners, turn)), w, h)
    owned.push(flat)
    return finish(flat, options.mode)
  } finally {
    free(...owned)
  }
}

/* ------------------------------------------------------------------------------------------------
 * Books (§62): a photo or scan of an open book is one spread — two pages side by side, curved
 * toward the fold. Each spread is straightened, its curve flattened (the pages' top and bottom
 * edges made straight, the lines between following), the fold's shadow lightened, and split at
 * the fold into two pages.
 */

export interface BookOptions extends ScanOptions {
  /** Where the fold is, as a share of the straightened width; null: the picture is one page. */
  split: number | null
  /** Straighten the curve toward the fold (only when the book's outline was found on a table). */
  flatten?: boolean
}

/** The table's colour (the median of the picture's border) and how much it varies. */
function tableOf(pix: mupdf.Pixmap): { colour: [number, number, number]; noise: number } {
  const { gray, w, h, table } = smallDifference(pix, 480)
  const edge = Math.max(2, Math.round(Math.min(w, h) * 0.03))
  const border: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < edge || x >= w - edge || y < edge || y >= h - edge) border.push(gray[y * w + x]!)
  border.sort((p, q) => p - q)
  return { colour: table, noise: border[Math.floor(border.length * 0.95)] ?? 0 }
}

/** The corners pushed outward from their centre by `share` of the outline's size: a curved page bulges past them. */
function grow(c: Corners, share: number): Corners {
  const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4
  const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4
  return c.map(([x, y]) => [cx + (x - cx) * (1 + share), cy + (y - cy) * (1 + share)] as Point) as Corners
}

interface Edges {
  top: Float64Array
  bottom: Float64Array
  x0: number
  x1: number
}

/**
 * The pages' top and bottom edges in a straightened spread, per column, found where the colour
 * stops being the table's; and the first and last columns that are page. Null when the edges are
 * already straight (nothing to flatten) or cannot be found.
 */
function pageEdges(flat: mupdf.Pixmap, table: { colour: [number, number, number]; noise: number }): Edges | null {
  const W = flat.getWidth()
  const H = flat.getHeight()
  const k = Math.min(1, 700 / Math.max(W, H))
  const w = Math.max(8, Math.round(W * k))
  const h = Math.max(8, Math.round(H * k))
  const small = flat.warp(quad([[0, 0], [W, 0], [W, H], [0, H]]), w, h)
  const topS: number[] = []
  const botS: number[] = []
  try {
    const px = small.getPixels()
    const n = small.getNumberOfComponents()
    const stride = small.getStride()
    const t = Math.min(110, Math.max(28, table.noise * 1.8))
    const [r0, g0, b0] = table.colour
    const page = (x: number, y: number): boolean => {
      const o = y * stride + x * n
      return (Math.abs(px[o]! - r0) + Math.abs(px[o + 1]! - g0) + Math.abs(px[o + 2]! - b0)) / 1.5 > t
    }
    // Three page pixels in a row: a speck on the table is not the page's edge.
    const run = (x: number, y: number, dy: number): boolean => page(x, y) && page(x, Math.min(h - 1, Math.max(0, y + dy))) && page(x, Math.min(h - 1, Math.max(0, y + 2 * dy)))
    for (let x = 0; x < w; x++) {
      let top = -1
      for (let y = 0; y < h * 0.4; y++)
        if (run(x, y, 1)) {
          top = y
          break
        }
      let bottom = -1
      for (let y = h - 1; y > h * 0.6; y--)
        if (run(x, y, -1)) {
          bottom = y + 1
          break
        }
      topS.push(top)
      botS.push(bottom)
    }
  } finally {
    small.destroy()
  }
  // The columns that are page (both edges found), then the edges smoothed across columns.
  const ok = topS.map((t, x) => t >= 0 && botS[x]! >= 0)
  const first = ok.indexOf(true)
  const last = ok.lastIndexOf(true)
  if (first < 0 || last - first < w * 0.5) return null
  const fill = (v: number[]): number[] => {
    const out = v.slice()
    for (let x = first; x <= last; x++) if (!ok[x]) out[x] = out[x - 1]!
    return out
  }
  const median = (v: number[], r: number): number[] =>
    v.map((_, x) => {
      const win = v.slice(Math.max(first, x - r), Math.min(last, x + r) + 1).sort((a, b) => a - b)
      return win[win.length >> 1]!
    })
  const tops = median(fill(topS), 6)
  const bots = median(fill(botS), 6)
  // How far the edges stray from straight lines between their ends.
  let bend = 0
  for (let x = first; x <= last; x++) {
    const f = (x - first) / Math.max(1, last - first)
    bend = Math.max(bend, Math.abs(tops[x]! - (tops[first]! * (1 - f) + tops[last]! * f)), Math.abs(bots[x]! - (bots[first]! * (1 - f) + bots[last]! * f)))
  }
  const top = new Float64Array(W)
  const bottom = new Float64Array(W)
  // Straight already (under 1% of the height): the margin around the corners is trimmed, nothing bent.
  const straight = bend < h * 0.01
  for (let X = 0; X < W; X++) {
    const s = Math.min(last, Math.max(first, X * k))
    if (straight) {
      const f = (s - first) / Math.max(1, last - first)
      top[X] = (tops[first]! * (1 - f) + tops[last]! * f) / k
      bottom[X] = (bots[first]! * (1 - f) + bots[last]! * f) / k
      continue
    }
    const a = Math.floor(s)
    const f = s - a
    const b = Math.min(last, a + 1)
    top[X] = (tops[a]! * (1 - f) + tops[b]! * f) / k
    bottom[X] = (bots[a]! * (1 - f) + bots[b]! * f) / k
  }
  // A sliver inside the outer edges: the last columns mix page and table, and left a dark fringe.
  const trim = Math.round(W * 0.006)
  return { top, bottom, x0: Math.round(first / k) + trim, x1: Math.min(W, Math.round((last + 1) / k)) - trim }
}

/** Each column stretched from its top edge to its bottom edge: the pages' curve made flat. */
function flattenColumns(flat: mupdf.Pixmap, edges: Edges): mupdf.Pixmap {
  const H = flat.getHeight()
  const w = Math.max(8, edges.x1 - edges.x0)
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, H], false)
  const src = flat.getPixels()
  const n = flat.getNumberOfComponents()
  const stride = flat.getStride()
  const dst = out.getPixels()
  const dStride = out.getStride()
  const dn = out.getNumberOfComponents()
  for (let x = 0; x < w; x++) {
    const X = Math.min(flat.getWidth() - 1, x + edges.x0)
    // A sliver inside the top and bottom edges too: their last rows mix page and table.
    const inset = (edges.bottom[X]! - edges.top[X]!) * 0.006
    const top = edges.top[X]! + inset
    const span = edges.bottom[X]! - inset - top
    for (let y = 0; y < H; y++) {
      const sy = Math.min(H - 1.001, Math.max(0, top + (y / (H - 1)) * span))
      const a = Math.floor(sy)
      const f = sy - a
      const o1 = a * stride + X * n
      const o2 = o1 + stride
      const d = y * dStride + x * dn
      for (let c = 0; c < 3; c++) dst[d + c] = src[o1 + c]! * (1 - f) + src[o2 + c]! * f
    }
  }
  return out
}

/** Lightens the shadow along the fold: each column brought up to the paper's brightness (at most 2.5×). */
function evenColumns(pix: mupdf.Pixmap): void {
  const w = pix.getWidth()
  const h = pix.getHeight()
  const px = pix.getPixels()
  const n = pix.getNumberOfComponents()
  const stride = pix.getStride()
  const level = new Float64Array(w)
  const step = Math.max(1, Math.floor(h / 300))
  for (let x = 0; x < w; x++) {
    const values: number[] = []
    for (let y = 0; y < h; y += step) {
      const o = y * stride + x * n
      values.push((px[o]! * 299 + px[o + 1]! * 587 + px[o + 2]! * 114) / 1000)
    }
    values.sort((a, b) => a - b)
    level[x] = values[Math.floor(values.length * 0.9)]!
  }
  // Smoothed, so a column of text or a picture's edge does not make a stripe.
  const r = Math.max(2, Math.round(w / 150))
  const smooth = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let sum = 0
    let count = 0
    for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
      sum += level[i]!
      count++
    }
    smooth[x] = sum / count
  }
  const sorted = Array.from(smooth).sort((a, b) => a - b)
  // The brightest paper (not a typical column): a lifted shadow left a faint gray band beside white.
  const paper = sorted[Math.floor(sorted.length * 0.95)]!
  for (let x = 0; x < w; x++) {
    const gain = Math.min(2.5, paper / Math.max(1, smooth[x]!))
    if (gain <= 1.02) continue
    for (let y = 0; y < h; y++) {
      const o = y * stride + x * n
      for (let c = 0; c < 3; c++) px[o + c] = Math.min(255, px[o + c]! * gain)
    }
  }
}

/**
 * Where the fold is in a straightened spread, as a share of its width: the darkest band (its
 * shadow) near the middle, a little in favour of the middle. Null when the picture is taller than
 * wide — one page, not a spread.
 */
export function findFold(flat: mupdf.Pixmap): number | null {
  const W = flat.getWidth()
  const H = flat.getHeight()
  if (W < H) return null
  const k = Math.min(1, 600 / W)
  const w = Math.max(8, Math.round(W * k))
  const h = Math.max(8, Math.round(H * k))
  const small = flat.warp(quad([[0, 0], [W, 0], [W, H], [0, H]]), w, h)
  try {
    const px = small.getPixels()
    const n = small.getNumberOfComponents()
    const stride = small.getStride()
    const column = new Float64Array(w)
    const y0 = Math.floor(h * 0.05)
    const y1 = Math.ceil(h * 0.95)
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = y0; y < y1; y++) {
        const o = y * stride + x * n
        sum += (px[o]! * 299 + px[o + 1]! * 587 + px[o + 2]! * 114) / 1000
      }
      column[x] = sum / (y1 - y0)
    }
    const r = Math.max(1, Math.round(w / 120))
    let best = 0.5
    let bestScore = Infinity
    for (let x = Math.floor(w * 0.35); x <= Math.ceil(w * 0.65); x++) {
      let sum = 0
      let count = 0
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
        sum += column[i]!
        count++
      }
      const score = sum / count + 60 * Math.abs(x / w - 0.5)
      if (score < bestScore) {
        bestScore = score
        best = x / w
      }
    }
    return Math.round(best * 1000) / 1000
  } finally {
    small.destroy()
  }
}

/** The spread straightened and, when it can be, flattened; the caller owns the result. */
function bookSpread(pix: mupdf.Pixmap, options: BookOptions): mupdf.Pixmap {
  const W = pix.getWidth()
  const H = pix.getHeight()
  const turn = options.rotate ?? 0
  const found = options.corners ?? null
  const flatten = options.flatten !== false && found !== null
  // A curved page bulges past its corners: take a little more, then follow its real edges.
  const corners = found ? (flatten ? grow(found, 0.04) : found) : ([[0, 0], [W, 0], [W, H], [0, H]] as Corners)
  let [w, h] = outputSize(corners, options.maxSide ?? 4200)
  if (turn === 90 || turn === 270) [w, h] = [h, w]
  const flat = pix.warp(quad(turnedSource(corners, turn)), w, h)
  if (!flatten || !found) return flat
  const edges = pageEdges(flat, tableOf(pix))
  if (!edges) {
    // The edges were not found: the corners as found, without the margin taken around them.
    flat.destroy()
    let [w2, h2] = outputSize(found, options.maxSide ?? 4200)
    if (turn === 90 || turn === 270) [w2, h2] = [h2, w2]
    return pix.warp(quad(turnedSource(found, turn)), w2, h2)
  }
  const flatter = flattenColumns(flat, edges)
  flat.destroy()
  return flatter
}

/** One picture of a book: its pages, left to right (one when it is not a spread). */
export function scanBookPicture(bytes: Uint8Array, options: BookOptions): ScannedImage[] {
  const pix = loadUpright(bytes)
  const owned: Array<{ destroy(): void }> = [pix]
  try {
    const spread = bookSpread(pix, options)
    owned.push(spread)
    if (options.mode !== 'original') evenColumns(spread)
    const w = spread.getWidth()
    const h = spread.getHeight()
    if (options.split === null) return [finish(spread, options.mode)]
    const at = Math.round(Math.min(0.9, Math.max(0.1, options.split)) * w)
    const pages: ScannedImage[] = []
    for (const [x0, x1] of [
      [0, at],
      [at, w]
    ] as const) {
      const half = spread.warp(quad([[x0, 0], [x1, 0], [x1, h], [x0, h]]), x1 - x0, h)
      owned.push(half)
      pages.push(finish(half, options.mode))
    }
    return pages
  } finally {
    free(...owned)
  }
}

/** Where the fold is in a picture of a book, once straightened (null: one page). */
export function detectFold(bytes: Uint8Array, corners: Corners | null, rotate: 0 | 90 | 180 | 270 = 0): number | null {
  const pix = loadUpright(bytes)
  try {
    const spread = bookSpread(pix, { corners, rotate, mode: 'original', split: null, maxSide: 1400 })
    try {
      return findFold(spread)
    } finally {
      spread.destroy()
    }
  } finally {
    pix.destroy()
  }
}

/** The page found in a picture, with the picture's upright size and a small preview (JPEG). */
export function detectPicture(bytes: Uint8Array): { width: number; height: number; corners: Corners | null; preview: Uint8Array } {
  const pix = loadUpright(bytes)
  try {
    const W = pix.getWidth()
    const H = pix.getHeight()
    const corners = findPage(pix)
    const k = Math.min(1, 900 / Math.max(W, H))
    const small = pix.warp(quad([[0, 0], [W, 0], [W, H], [0, H]]), Math.round(W * k), Math.round(H * k))
    const preview = new Uint8Array(small.asJPEG(82))
    small.destroy()
    return { width: W, height: H, corners, preview }
  } finally {
    pix.destroy()
  }
}

/** ID-1 cards (identity, bank, driving licence): 85.6 × 54 mm. */
export const ID_CARD_MM: [number, number] = [85.6, 54]

/**
 * Front and back of a card on one A4 page at their real size, one above the other in the upper
 * half of the page, as copy shops print them.
 */
export async function idCardPage(front: ScannedImage, back: ScannedImage | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89])
  const cw = (ID_CARD_MM[0] * 72) / 25.4
  const ch = (ID_CARD_MM[1] * 72) / 25.4
  const x = (595.28 - cw) / 2
  const sides = back ? [front, back] : [front]
  let top = 841.89 - 110
  for (const side of sides) {
    const image = side.format === 'png' ? await pdf.embedPng(side.bytes) : await pdf.embedJpg(side.bytes)
    // A card photographed upright is turned to lie flat.
    if (side.height > side.width) page.drawImage(image, { x: x + cw, y: top - ch, width: ch, height: cw, rotate: { type: 'degrees', angle: 90 } as never })
    else page.drawImage(image, { x, y: top - ch, width: cw, height: ch })
    top -= ch + 42
  }
  pdf.setTitle('ID card')
  return new Uint8Array(await pdf.save())
}

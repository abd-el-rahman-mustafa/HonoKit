import { createHash } from 'node:crypto'
import { exifOrientation, orientationTurn } from '@shared/exif'
import { PdfError } from './errors'
import { free, mupdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { safeRedact } from './saferedact'
import { pageFrame, placeOverlay } from './stamp'

/**
 * Pictures on a page: add, move, resize, replace, delete (docs/decisions.md §29).
 *
 * Moving, resizing or replacing a picture changes it where it is drawn:
 * the picture's resource is swapped, on this page only, for a small
 * form that draws the same picture object with one more `cm` (X = P·T·P⁻¹: P the picture's
 * placement, T the move from its old box to the new). So the picture keeps its own encoded data
 * (a JPEG stays a JPEG, CMYK and ICC colour stay), its turn or mirror, its clip, its layer and its
 * place in the drawing order (a caption over a photo stays over it). A picture object drawn
 * several times on the page has just the one use renamed in the page's content. A picture its
 * frame crops (newspapers: every InDesign photo; the clip is in the page's content, outside the
 * picture) moves together with its frame: the group that draws just the frame and the picture gets
 * one more `cm` (`moveWithFrame`, §83). The result is checked; when it does not show where it
 * should — an inline picture (no object), a cropped picture inside a form or in a group that also
 * draws something else — the picture is removed and drawn again on top, from its own data where
 * MuPDF can copy it, in its own direction, cropped to its moved frame.
 *
 * Deleting a picture (and the fallback above) means removing the original. Removal
 * has to take exactly that picture: MuPDF's image redaction either punches a white hole
 * in a picture behind it (a scanned page, a background) or deletes that picture too —
 * measured, see the decision. So the picture object itself is found among the page's
 * resources (same size and pixels) and disconnected on this page alone. Only when it
 * cannot be found (an inline image, one nested in a form) is pixel redaction used, and
 * only if no other picture lies under it.
 *
 * Coordinates are the page as displayed: points from the top-left.
 */

export type Box = [number, number, number, number]

export interface PictureInfo {
  box: Box
  /** Size in pixels. */
  pixels: { width: number; height: number }
}

interface Found {
  box: Box
  /**
   * Where the picture is drawn, as PDF places images: its unit square (0,0 its bottom-left
   * corner) onto the page as displayed (points from the top-left, /Rotate included).
   */
  matrix: mupdf.Matrix
  image: mupdf.Image
}

/** MuPDF reports an image's unit square with its top row at 0; PDF puts the top row at 1. */
const FLIP: mupdf.Matrix = [1, 0, 0, -1, 0, 1]

function findPictures(doc: PdfDoc, pageIndex: number): Found[] {
  const page = doc.loadPage(pageIndex)
  const stext = page.toStructuredText('preserve-images')
  const out: Found[] = []
  try {
    stext.walk({
      onImageBlock(bbox: mupdf.Rect, m: mupdf.Matrix, image: mupdf.Image) {
        out.push({ box: [bbox[0], bbox[1], bbox[2], bbox[3]], matrix: mupdf.Matrix.concat(FLIP, [m[0], m[1], m[2], m[3], m[4], m[5]]), image })
      }
    })
  } finally {
    free(stext, page)
  }
  return out
}

export function pagePictures(doc: PdfDoc, pageIndex: number): PictureInfo[] {
  return findPictures(doc, pageIndex).map((p) => ({ box: p.box, pixels: { width: p.image.getWidth(), height: p.image.getHeight() } }))
}

const close = (a: Box, b: Box): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 1.5)

/** Draws an image (any colour space, decode array) at its pixel size onto a new pixmap. */
function rasterise(image: mupdf.Image, w: number, h: number, space: mupdf.ColorSpace): mupdf.Pixmap {
  const target = new mupdf.Pixmap(space, [0, 0, w, h], false)
  target.clear(255)
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, target)
  try {
    device.fillImage(image, mupdf.Matrix.scale(w, h), 1)
    device.close()
  } finally {
    free(device)
  }
  return target
}

/**
 * The picture as PNG, with its transparency. The draw device ignores an image's soft mask
 * (MuPDF's page interpreter applies it, not the device), so the mask is drawn on its own
 * and combined here; without this a moved signature got a black background.
 */
function toPng(image: mupdf.Image): Uint8Array {
  const w = image.getWidth()
  const h = image.getHeight()
  const colour = rasterise(image, w, h, mupdf.ColorSpace.DeviceRGB)
  const maskImage = image.getMask()
  if (!maskImage) {
    try {
      return new Uint8Array(colour.asPNG())
    } finally {
      free(colour)
    }
  }
  // The mask at its own size (it may differ from the picture's), one grey byte per pixel.
  const mask = maskImage.toPixmap()
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true)
  try {
    const rgb = colour.getPixels()
    const a = mask.getPixels()
    const mw = mask.getWidth()
    const mh = mask.getHeight()
    // MuPDF's "number of components" already counts alpha; rows may be padded (stride).
    const mn = mask.getNumberOfComponents()
    const ms = mask.getStride()
    const cs = colour.getStride()
    const os = out.getStride()
    const rgba = out.getPixels()
    // MuPDF's pixmaps with alpha hold premultiplied colour; the PNG writer undoes it.
    for (let y = 0; y < h; y++) {
      const my = Math.min(mh - 1, Math.floor((y * mh) / h))
      for (let x = 0; x < w; x++) {
        const mx = Math.min(mw - 1, Math.floor((x * mw) / w))
        const alpha = a[my * ms + mx * mn]!
        const i = y * cs + x * 3
        const j = y * os + x * 4
        rgba[j] = (rgb[i]! * alpha) / 255
        rgba[j + 1] = (rgb[i + 1]! * alpha) / 255
        rgba[j + 2] = (rgb[i + 2]! * alpha) / 255
        rgba[j + 3] = alpha
      }
    }
    return new Uint8Array(out.asPNG())
  } finally {
    free(colour, mask, out, maskImage)
  }
}

function fingerprint(image: mupdf.Image): string {
  const pixmap = image.toPixmap()
  try {
    return `${image.getWidth()}x${image.getHeight()}:${createHash('sha1').update(pixmap.getPixels()).digest('hex')}`
  } finally {
    free(pixmap)
  }
}

/** A shallow copy of a dictionary, as a new direct object. */
function copyDict(doc: PdfDoc, dict: mupdf.PDFObject): mupdf.PDFObject {
  const copy = doc.newDictionary()
  dict.forEach((v, k) => copy.put(k, v))
  return copy
}

/**
 * What takes a picture's place in the resources: given the picture object and the matrix it
 * was already drawn with inside the resource (identity, or that of a form this editor made
 * around it earlier), the new resource.
 */
type Maker = (picture: mupdf.PDFObject, before: mupdf.Matrix) => mupdf.PDFObject

/** Marks the form this editor puts around a moved picture; holds the matrix it adds. */
const WRAPPED = 'HonoKitPicture'

/** Whether a resource is an image object with this picture's size and pixels. */
function isThePicture(doc: PdfDoc, value: mupdf.PDFObject, wanted: string, image: mupdf.Image): boolean {
  if (!value.isDictionary() || value.get('Subtype').asName() !== 'Image') return false
  if (value.get('Width').asNumber() !== image.getWidth() || value.get('Height').asNumber() !== image.getHeight()) return false
  const candidate = doc.loadImage(value)
  try {
    return fingerprint(candidate) === wanted
  } finally {
    free(candidate)
  }
}

/** If the resource is this picture, or a form this editor put around it: the picture object and the matrix it is drawn with. */
function asThePicture(doc: PdfDoc, value: mupdf.PDFObject, wanted: string, image: mupdf.Image): { picture: mupdf.PDFObject; before: mupdf.Matrix } | null {
  if (!value.isDictionary()) return null
  const subtype = value.get('Subtype').asName()
  if (subtype === 'Image') return isThePicture(doc, value, wanted, image) ? { picture: value, before: mupdf.Matrix.identity } : null
  if (subtype !== 'Form') return null
  const m = value.get(WRAPPED)
  if (!m.isArray() || m.length !== 6) return null
  const inner = value.get('Resources').get('XObject').get('Im')
  if (!isThePicture(doc, inner, wanted, image)) return null
  const before: mupdf.Matrix = [0, 1, 2, 3, 4, 5].map((i) => m.get(i).asNumber()) as mupdf.Matrix
  return { picture: inner, before }
}

/** Numbers for a content stream: plain decimals, never exponents. */
function num(v: number): string {
  if (Math.abs(v) < 1e-9) return '0'
  return v.toFixed(9).replace(/\.?0+$/, '')
}

/** A form that draws `picture` with `m` (in the picture's own unit square) added before it. */
function wrapped(doc: PdfDoc, picture: mupdf.PDFObject, m: mupdf.Matrix): mupdf.PDFObject {
  const form = doc.newDictionary()
  form.put('Type', doc.newName('XObject'))
  form.put('Subtype', doc.newName('Form'))
  // The form's own space is the picture's unit square as placed; the box holds it with room.
  const r = mupdf.Rect.transform([0, 0, 1, 1], m)
  const pad = Math.max(r[2] - r[0], r[3] - r[1]) * 0.01 + 1e-6
  const bbox = doc.newArray()
  for (const v of [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]) bbox.push(Number(num(v)))
  form.put('BBox', bbox)
  const resources = doc.newDictionary()
  const xobjects = doc.newDictionary()
  xobjects.put('Im', picture)
  resources.put('XObject', xobjects)
  form.put('Resources', resources)
  const kept = doc.newArray()
  for (const v of m) kept.push(Number(num(v)))
  form.put(WRAPPED, kept)
  return doc.addStream(new TextEncoder().encode(`q ${m.map(num).join(' ')} cm /Im Do Q`), form)
}

/**
 * Looks for the picture among these resources and, inside forms, theirs (pictures this
 * editor placed live in a form, the overlay). Returns new resources with the picture
 * replaced by what `make` gives (an empty form to remove it), or null. Everything on the way
 * is copied rather than changed, so a resource or form shared with other pages stays as it
 * was there.
 */
function withPictureSwapped(doc: PdfDoc, resources: mupdf.PDFObject, content: string, wanted: string, image: mupdf.Image, make: Maker, depth: number): mupdf.PDFObject | null {
  const xobjects = resources.get('XObject')
  if (!xobjects.isDictionary()) return null
  // Only the names this content really draws: one resources dictionary is often shared by the page
  // and its forms, so the picture listed there may be drawn only from inside a form.
  const drawn = new Set(doOperands(content).map((u) => u.name))
  let replacement: { key: string; value: mupdf.PDFObject } | null = null
  xobjects.forEach((value, key) => {
    if (replacement !== null || !drawn.has(String(key))) return
    try {
      if (!value.isDictionary()) return
      const found = asThePicture(doc, value, wanted, image)
      if (found) {
        replacement = { key: String(key), value: make(found.picture, found.before) }
        return
      }
      if (value.get('Subtype').asName() === 'Form' && depth < 4) {
        const inner = value.get('Resources')
        if (!inner.isDictionary()) return
        const changed = withPictureSwapped(doc, inner, streamText(value), wanted, image, make, depth + 1)
        if (!changed) return
        const dict = copyDict(doc, value)
        dict.put('Resources', changed)
        replacement = { key: String(key), value: doc.addRawStream(value.readRawStream(), dict) }
      }
    } catch {
      /* not something we can read: not the one */
    }
  })
  if (replacement === null) return null
  const found = replacement as { key: string; value: mupdf.PDFObject }
  const ownXObjects = copyDict(doc, xobjects)
  ownXObjects.put(found.key, found.value)
  const ownResources = copyDict(doc, resources)
  ownResources.put('XObject', ownXObjects)
  return ownResources
}

/** A stream's decoded bytes as text (one character per byte). */
function streamText(stream: mupdf.PDFObject): string {
  const buffer = stream.readStream()
  try {
    return Buffer.from(buffer.asUint8Array()).toString('latin1')
  } finally {
    free(buffer)
  }
}

/** The page's content, all its streams joined as a reader joins them. */
function pageText(page: mupdf.PDFObject): string {
  const contents = page.get('Contents')
  const parts: string[] = []
  if (contents.isArray()) {
    for (let i = 0; i < contents.length; i++) if (contents.get(i).isStream()) parts.push(streamText(contents.get(i)))
  } else if (contents.isStream()) parts.push(streamText(contents))
  return parts.join(' ')
}

function emptyForm(doc: PdfDoc): mupdf.PDFObject {
  const empty = doc.newDictionary()
  empty.put('Type', doc.newName('XObject'))
  empty.put('Subtype', doc.newName('Form'))
  const bbox = doc.newArray()
  for (const v of [0, 0, 0, 0]) bbox.push(v)
  empty.put('BBox', bbox)
  return doc.addStream(new Uint8Array(0), empty)
}

/**
 * Disconnects the image resource that is this picture, on this page only. Returns false
 * when it is not an image resource of the page or of a form on it (an inline image).
 * If the same picture object is drawn twice on the page, both go: a known limit.
 */
function disconnect(doc: PdfDoc, pageIndex: number, image: mupdf.Image): boolean {
  const page = doc.findPage(pageIndex)
  const resources = page.getInheritable('Resources')
  if (!resources.isDictionary()) return false
  const changed = withPictureSwapped(doc, resources, pageText(page), fingerprint(image), image, () => emptyForm(doc), 0)
  if (!changed) return false
  page.put('Resources', changed)
  return true
}

// --- one use of a picture object drawn several times ------------------------------------------

/** Where the page's content draws a named XObject: the name operand of each `Do`, as offsets. */
export function doOperands(content: string): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = []
  const n = content.length
  const white = (c: string): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'
  const delimiter = (c: string): boolean => '()<>[]{}/%'.includes(c)
  let last: { name: string; start: number; end: number } | null = null
  let i = 0
  while (i < n) {
    const c = content[i]!
    if (white(c)) {
      i++
    } else if (c === '%') {
      while (i < n && content[i] !== '\n' && content[i] !== '\r') i++
    } else if (c === '(') {
      // A string: nested brackets, backslash escapes.
      let depth = 0
      for (; i < n; i++) {
        const d = content[i]
        if (d === '\\') i++
        else if (d === '(') depth++
        else if (d === ')' && --depth === 0) break
      }
      i++
      last = null
    } else if (c === '<' && content[i + 1] === '<') {
      i += 2
      last = null
    } else if (c === '>' && content[i + 1] === '>') {
      i += 2
      last = null
    } else if (c === '<') {
      while (i < n && content[i] !== '>') i++
      i++
      last = null
    } else if (c === '/') {
      const start = i
      i++
      while (i < n && !white(content[i]!) && !delimiter(content[i]!)) i++
      const raw = content.slice(start + 1, i)
      last = { name: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), start, end: i }
    } else if (delimiter(c)) {
      i++
      last = null
    } else {
      const start = i
      while (i < n && !white(content[i]!) && !delimiter(content[i]!)) i++
      const word = content.slice(start, i)
      if (word === 'Do' && last) out.push(last)
      else if (word === 'BI') {
        // An inline image: its data runs from ID to an EI standing alone.
        const id = content.indexOf('ID', i)
        if (id < 0) break
        let j = id + 3
        for (;;) {
          const ei = content.indexOf('EI', j)
          if (ei < 0) {
            j = n
            break
          }
          const before = content[ei - 1]
          const after = content[ei + 2]
          if (before !== undefined && white(before) && (after === undefined || white(after) || delimiter(after))) {
            j = ei + 2
            break
          }
          j = ei + 2
        }
        i = j
      }
      last = null
    }
  }
  return out
}

/**
 * When the page draws the same picture object more than once: gives just the `k`-th of the
 * `count` uses a resource name of its own (the page's content is rewritten at that one `Do`) and
 * makes that name `make`'s. False when the uses cannot be told apart this way (some are inside
 * forms, or the counts disagree).
 */
function changeOneUse(doc: PdfDoc, pageIndex: number, wanted: string, image: mupdf.Image, k: number, count: number, make: Maker): boolean {
  const page = doc.findPage(pageIndex)
  const resources = page.getInheritable('Resources')
  if (!resources.isDictionary()) return false
  const xobjects = resources.get('XObject')
  if (!xobjects.isDictionary()) return false
  const names = new Map<string, { picture: mupdf.PDFObject; before: mupdf.Matrix }>()
  xobjects.forEach((value, key) => {
    try {
      const found = asThePicture(doc, value, wanted, image)
      if (found) names.set(String(key), found)
    } catch {
      /* not readable: not the one */
    }
  })
  if (!names.size) return false
  const contents = page.get('Contents')
  const streams: mupdf.PDFObject[] = []
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) streams.push(contents.get(i))
  else if (contents.isStream()) streams.push(contents)
  let seen = 0
  let target: { stream: number; text: string; use: { name: string; start: number; end: number } } | null = null
  for (const [s, stream] of streams.entries()) {
    if (!stream.isStream()) continue
    const text = streamText(stream)
    for (const use of doOperands(text)) {
      if (!names.has(use.name)) continue
      if (seen === k) target = { stream: s, text, use }
      seen++
    }
  }
  if (seen !== count || !target) return false
  let fresh = 'HonoPic'
  for (let i = 1; !xobjects.get(fresh).isNull(); i++) fresh = `HonoPic${i}`
  const { stream, text, use } = target
  const old = streams[stream]!
  const dict = copyDict(doc, old)
  for (const key of ['Filter', 'DecodeParms', 'Length']) dict.delete(key)
  const rewritten = doc.addStream(Buffer.from(`${text.slice(0, use.start)}/${fresh}${text.slice(use.end)}`, 'latin1'), dict)
  if (contents.isArray()) {
    const list = doc.newArray()
    streams.forEach((s, i) => list.push(i === stream ? rewritten : s))
    page.put('Contents', list)
  } else page.put('Contents', rewritten)
  const found = names.get(use.name)!
  const ownXObjects = copyDict(doc, xobjects)
  ownXObjects.put(fresh, make(found.picture, found.before))
  const ownResources = copyDict(doc, resources)
  ownResources.put('XObject', ownXObjects)
  page.put('Resources', ownResources)
  return true
}

/**
 * Changes the picture where it is drawn (see the module's note), on this page only. Returns
 * false when it cannot: an inline picture, or uses of one object that cannot be told apart.
 */
function changeInPlace(doc: PdfDoc, pageIndex: number, all: Found[], found: Found, make: Maker): boolean {
  const wanted = fingerprint(found.image)
  const same = all.filter((p) => p === found || (p.image.getWidth() === found.image.getWidth() && p.image.getHeight() === found.image.getHeight() && fingerprint(p.image) === wanted))
  if (same.length > 1) return changeOneUse(doc, pageIndex, wanted, found.image, same.indexOf(found), same.length, make)
  const page = doc.findPage(pageIndex)
  const resources = page.getInheritable('Resources')
  if (!resources.isDictionary()) return false
  const changed = withPictureSwapped(doc, resources, pageText(page), wanted, found.image, make, 0)
  if (!changed) return false
  page.put('Resources', changed)
  return true
}

// --- a picture its frame crops (newspaper photos) -------------------------------------------------

/** One operator of a content stream: its operands as written, and where the operator itself ends. */
export interface ContentOp {
  op: string
  operands: string[]
  end: number
}

/**
 * The operators of a content stream, in order, each with its operands as written (an array or a
 * dictionary is one operand). An inline image is one `BI` operator whose data is skipped.
 */
export function contentOps(content: string): ContentOp[] {
  const out: ContentOp[] = []
  const n = content.length
  const white = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'
  const delimiter = (c: string | undefined): boolean => c !== undefined && '()<>[]{}/%'.includes(c)
  /** The end of the token (or the bracketed object) that starts at `i`. */
  const skip = (i: number): number => {
    const c = content[i]!
    if (c === '(') {
      let depth = 0
      for (; i < n; i++) {
        const d = content[i]
        if (d === '\\') i++
        else if (d === '(') depth++
        else if (d === ')' && --depth === 0) return i + 1
      }
      return n
    }
    if (c === '<' && content[i + 1] === '<') return bracketed(i + 2, '>>')
    if (c === '<') {
      const close = content.indexOf('>', i)
      return close < 0 ? n : close + 1
    }
    if (c === '[') return bracketed(i + 1, ']')
    if (c === '/') {
      i++
      while (i < n && !white(content[i]) && !delimiter(content[i])) i++
      return i
    }
    if (delimiter(c)) return i + 1
    while (i < n && !white(content[i]) && !delimiter(content[i])) i++
    return i
  }
  /** Skips the objects inside an array or a dictionary up to its closing mark. */
  const bracketed = (i: number, closing: string): number => {
    while (i < n) {
      const c = content[i]!
      if (white(c)) i++
      else if (c === '%') while (i < n && content[i] !== '\n' && content[i] !== '\r') i++
      else if (content.startsWith(closing, i)) return i + closing.length
      else i = Math.max(i + 1, skip(i))
    }
    return n
  }
  let operands: string[] = []
  let i = 0
  while (i < n) {
    const c = content[i]!
    if (white(c)) {
      i++
      continue
    }
    if (c === '%') {
      while (i < n && content[i] !== '\n' && content[i] !== '\r') i++
      continue
    }
    const start = i
    i = Math.max(i + 1, skip(i))
    const token = content.slice(start, i)
    const operand = c === '/' || c === '(' || c === '<' || c === '[' || /^[+\-.\d]/.test(token) || token === 'true' || token === 'false' || token === 'null'
    if (operand) {
      operands.push(token)
      continue
    }
    if (token === 'BI') {
      // An inline image: its data runs from ID to an EI standing alone.
      const id = content.indexOf('ID', i)
      let j = id < 0 ? n : id + 3
      for (;;) {
        const ei = content.indexOf('EI', j)
        if (ei < 0) {
          j = n
          break
        }
        if (white(content[ei - 1]) && (ei + 2 >= n || white(content[ei + 2]) || delimiter(content[ei + 2]))) {
          j = ei + 2
          break
        }
        j = ei + 2
      }
      i = j
    }
    out.push({ op: token, operands, end: i })
    operands = []
  }
  return out
}

/** The name a `Do` draws, #xx escapes decoded. */
function nameOf(operands: string[]): string {
  return (operands[operands.length - 1] ?? '').slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
}

/** Operators that put marks on the page (anything but the picture would move with its frame). */
const PAINTS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'BI', 'BT', 'Tj', 'TJ', "'", '"', 'Do', 'd0', 'd1'])

/**
 * A picture its frame crops, moved or resized where it is drawn (decisions §83, review item E2).
 * Newspaper pages (InDesign) draw a photo as `q <frame path> W n q <cm> /Im Do Q Q`: the frame's
 * clip is in the page's content, outside the picture, so changing only the picture would leave the
 * crop behind. Instead the outermost group (q … Q) around this use that draws nothing but the
 * picture gets one more `cm` at its start: A = G·T·G⁻¹, with G the group's space on the displayed
 * page and T the move (displayed coordinates). Clip and picture move together, the picture object
 * and its data stay, and so does its place in the drawing order (a caption drawn after it stays on
 * top). False, with nothing changed, when there is no such group: the picture is drawn inside a
 * form, the uses of one picture object cannot be told apart, or its group also draws something else.
 */
function moveWithFrame(doc: PdfDoc, pageIndex: number, all: Found[], found: Found, T: mupdf.Matrix): boolean {
  const wanted = fingerprint(found.image)
  const same = all.filter((p) => p === found || (p.image.getWidth() === found.image.getWidth() && p.image.getHeight() === found.image.getHeight() && fingerprint(p.image) === wanted))
  const k = same.indexOf(found)
  const page = doc.findPage(pageIndex)
  const resources = page.getInheritable('Resources')
  if (!resources.isDictionary()) return false
  const xobjects = resources.get('XObject')
  if (!xobjects.isDictionary()) return false
  // The names that draw this picture, with the matrix a form this editor made adds around it.
  const names = new Map<string, mupdf.Matrix>()
  xobjects.forEach((value, key) => {
    try {
      const it = asThePicture(doc, value, wanted, found.image)
      if (it) names.set(String(key), it.before)
    } catch {
      /* not readable: not the one */
    }
  })
  if (!names.size) return false
  const contents = page.get('Contents')
  const streams: mupdf.PDFObject[] = []
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) streams.push(contents.get(i))
  else if (contents.isStream()) streams.push(contents)

  interface Group {
    stream: number
    at: number
    ctm: mupdf.Matrix
    others: number
    target: boolean
  }
  const texts: string[] = []
  const open: Group[] = []
  const closed: Group[] = []
  let ctm: mupdf.Matrix = mupdf.Matrix.identity
  let drawn: mupdf.Matrix | null = null
  let seen = 0
  for (const [s, stream] of streams.entries()) {
    const text = stream.isStream() ? streamText(stream) : ''
    texts.push(text)
    for (const { op, operands, end } of contentOps(text)) {
      if (op === 'q') open.push({ stream: s, at: end, ctm, others: 0, target: false })
      else if (op === 'Q') {
        const group = open.pop()
        if (group) {
          ctm = group.ctm
          if (group.target) closed.push(group)
        }
      } else if (op === 'cm') {
        const m = operands.slice(-6).map(Number)
        if (m.length !== 6 || m.some((v) => !Number.isFinite(v))) return false
        ctm = mupdf.Matrix.concat(m as mupdf.Matrix, ctm)
      } else if (op === 'Do' && names.has(nameOf(operands))) {
        if (seen === k) {
          drawn = mupdf.Matrix.concat(names.get(nameOf(operands))!, ctm)
          for (const g of open) g.target = true
        } else for (const g of open) g.others++
        seen++
      } else if (PAINTS.has(op)) for (const g of open) g.others++
    }
  }
  // Every use found in the page's own content (none inside a form), and the chosen one drawn.
  if (seen !== same.length || !drawn || !invertible(drawn)) return false
  // The outermost group that draws only this picture (an inner one draws less, never more).
  const group = closed.filter((g) => g.others === 0).pop()
  if (!group) return false
  // The page as displayed, from where the picture is: P = drawn · D.
  const D = mupdf.Matrix.concat(mupdf.Matrix.invert(drawn), found.matrix)
  const G = mupdf.Matrix.concat(group.ctm, D)
  if (!invertible(G)) return false
  const A = mupdf.Matrix.concat(mupdf.Matrix.concat(G, T), mupdf.Matrix.invert(G))
  const text = texts[group.stream]!
  const old = streams[group.stream]!
  const dict = copyDict(doc, old)
  for (const key of ['Filter', 'DecodeParms', 'Length']) dict.delete(key)
  const rewritten = doc.addStream(Buffer.from(`${text.slice(0, group.at)} ${A.map(num).join(' ')} cm${text.slice(group.at)}`, 'latin1'), dict)
  if (contents.isArray()) {
    const list = doc.newArray()
    streams.forEach((s, i) => list.push(i === group.stream ? rewritten : s))
    page.put('Contents', list)
  } else page.put('Contents', rewritten)
  return true
}

/** Takes out just this use of a picture object, checked; false (and nothing changed) when it cannot. */
function removeOneUse(doc: PdfDoc, pageIndex: number, before: Found[], found: Found): boolean {
  const undo = snapshot(doc, pageIndex)
  try {
    if (changeInPlace(doc, pageIndex, before, found, () => emptyForm(doc)) && findPictures(doc, pageIndex).length === before.length - 1) return true
  } catch {
    /* left as it was below */
  }
  undo()
  return false
}

/** The page's own Resources and Contents entries, to undo a change that did not work. */
function snapshot(doc: PdfDoc, pageIndex: number): () => void {
  const page = doc.findPage(pageIndex)
  const resources = page.get('Resources')
  const contents = page.get('Contents')
  return () => {
    if (resources.isNull()) page.delete('Resources')
    else page.put('Resources', resources)
    if (contents.isNull()) page.delete('Contents')
    else page.put('Contents', contents)
  }
}

/** The matrix that takes box `from` onto box `to` (move and resize), displayed coordinates. */
export function boxToBox(from: Box, to: Box): mupdf.Matrix {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0])
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1])
  return [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy]
}

const invertible = (m: mupdf.Matrix): boolean => Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-9

/** Removes the picture at `box`. Returns whether a picture behind it may show a blank area. */
function removePicture(doc: PdfDoc, pageIndex: number, box: Box): { found: Found; hole: boolean } {
  const all = findPictures(doc, pageIndex)
  const found = all.find((p) => close(p.box, box)) ?? all.find((p) => overlapShare(p.box, box) > 0.8)
  if (!found) throw new PdfError('bad-arguments', 'There is no picture there.')
  if (disconnect(doc, pageIndex, found.image)) return { found, hole: false }
  const behind = all.some((p) => p !== found && overlapShare(found.box, p.box) > 0)
  // Only this box: the person's pending redaction marks and links stay (E1, see saferedact.ts).
  safeRedact(doc, pageIndex, [found.box], { images: 'pixels', text: 'keep' })
  return { found, hole: behind }
}

function overlapShare(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const area = Math.max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
  return (w * h) / area
}

/**
 * Draws a picture on an overlay placed over the page: into `rect` (displayed coordinates), or
 * with `matrix` (its unit square onto the displayed page, as `Found.matrix`), which keeps a turn
 * or mirror. A picture given as a MuPDF image keeps its own encoded data (a JPEG stays one).
 *
 * The overlay is built with MuPDF, not pdf-lib: pdf-lib drops the transparency of some
 * PNGs (it wrote no soft mask for the ones MuPDF and browsers produce), which turned a
 * signature's empty background into a black box. MuPDF keeps the alpha as a soft mask.
 */
/** The picture's unit square turned clockwise by that many degrees, still in the unit square. */
const TURNS: Record<0 | 90 | 180 | 270, mupdf.Matrix | null> = {
  0: null,
  90: [0, -1, 1, 0, 0, 1],
  180: [-1, 0, 0, -1, 1, 1],
  270: [0, 1, -1, 0, 1, 0]
}

function draw(doc: PdfDoc, pageIndex: number, picture: Uint8Array | mupdf.Image, place: { rect: Box } | { matrix: mupdf.Matrix; clip?: Box }, opacity = 1): void {
  const frame = pageFrame(doc, pageIndex)
  const own = !(picture instanceof mupdf.Image)
  let image: mupdf.Image
  if (picture instanceof mupdf.Image) image = picture
  else
    try {
      image = new mupdf.Image(picture)
    } catch {
      throw new PdfError('unsupported', 'This picture could not be read. Use PNG or JPEG.')
    }
  const overlay = new mupdf.PDFDocument()
  try {
    const resources = overlay.newDictionary()
    const xobjects = overlay.newDictionary()
    let added: mupdf.PDFObject
    try {
      added = overlay.addImage(image)
    } catch (error) {
      // MuPDF writes only Gray, RGB and CMYK pictures as they are (not ICC, Indexed, Lab…): as PNG then.
      if (own) throw error
      const png = new mupdf.Image(toPng(image))
      try {
        added = overlay.addImage(png)
      } finally {
        free(png)
      }
    }
    xobjects.put('Im0', added)
    resources.put('XObject', xobjects)
    const gs = overlay.newDictionary()
    const alpha = overlay.newDictionary()
    alpha.put('ca', opacity)
    alpha.put('CA', opacity)
    gs.put('GS0', alpha)
    resources.put('ExtGState', gs)
    // The overlay page is the displayed page with its origin at the bottom-left.
    const placed: mupdf.Matrix =
      'rect' in place
        ? [place.rect[2] - place.rect[0], 0, 0, place.rect[3] - place.rect[1], place.rect[0], frame.height - place.rect[3]]
        : mupdf.Matrix.concat(place.matrix, [1, 0, 0, -1, 0, frame.height])
    // A phone photo stored sideways (EXIF orientation) is placed as it was taken, as its preview shows it (§61).
    const turn = own ? TURNS[orientationTurn(exifOrientation(picture))] : null
    const m = turn ? mupdf.Matrix.concat(turn, placed) : placed
    // A picture its frame cropped stays cropped: the visible part only, at its new place.
    const c = 'clip' in place && place.clip ? place.clip : null
    const clip = c ? `${num(c[0])} ${num(frame.height - c[3])} ${num(c[2] - c[0])} ${num(c[3] - c[1])} re W n ` : ''
    const content = `q /GS0 gs ${clip}${m.map(num).join(' ')} cm /Im0 Do Q`
    overlay.insertPage(-1, overlay.addPage([0, 0, frame.width, frame.height], 0, resources, content))
    placeOverlay(doc, saveBytes(overlay), [frame])
  } finally {
    if (own) free(overlay, image)
    else free(overlay)
  }
}

function checkRect(rect: Box): void {
  if (!(rect[2] - rect[0] >= 2 && rect[3] - rect[1] >= 2)) throw new PdfError('bad-arguments', 'The picture is too small.')
}

export async function addPicture(bytes: Uint8Array, pageIndex: number, rect: Box, picture: Uint8Array, opacity = 1, password?: string): Promise<Uint8Array> {
  checkRect(rect)
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    draw(doc, pageIndex, picture, { rect }, opacity)
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

export type PictureChange = { kind: 'move'; rect: Box } | { kind: 'delete' } | { kind: 'replace'; picture: Uint8Array }

export async function changePicture(bytes: Uint8Array, pageIndex: number, box: Box, change: PictureChange, password?: string): Promise<{ bytes: Uint8Array; hole: boolean }> {
  const doc = openPdf(bytes, password)
  try {
    if (pageIndex < 0 || pageIndex >= doc.countPages()) throw new PdfError('bad-arguments', 'No such page.')
    const before = findPictures(doc, pageIndex)
    const original = before.find((p) => close(p.box, box)) ?? before.find((p) => overlapShare(p.box, box) > 0.8)
    if (!original) throw new PdfError('bad-arguments', 'There is no picture there.')
    const P = original.matrix
    const P1 = invertible(P) ? mupdf.Matrix.invert(P) : null

    // What takes the picture's place, and where it should then be seen (to check that it took).
    let make: Maker = () => emptyForm(doc)
    let expected: Box | null = null
    /** For the fallback: where the original is drawn again, its direction kept. */
    let placed: mupdf.Matrix | null = null
    let replacement: { bytes: Uint8Array; rect: Box } | null = null
    if (change.kind === 'move') {
      checkRect(change.rect)
      placed = mupdf.Matrix.concat(P, boxToBox(original.box, change.rect))
      if (P1) {
        // X = P·T·P⁻¹, added in the picture's own unit square: it then lands on P·T.
        const X = mupdf.Matrix.concat(placed, P1)
        make = (picture, was) => wrapped(doc, picture, mupdf.Matrix.concat(X, was))
        expected = change.rect
      }
    } else if (change.kind === 'replace') {
      // The new picture fits inside the old one's box, keeping its own proportions.
      let size: { width: number; height: number }
      try {
        const probe = new mupdf.Image(change.picture)
        size = { width: probe.getWidth(), height: probe.getHeight() }
        free(probe)
      } catch {
        throw new PdfError('unsupported', 'This picture could not be read. Use PNG or JPEG.')
      }
      const bw = original.box[2] - original.box[0]
      const bh = original.box[3] - original.box[1]
      const s = Math.min(bw / size.width, bh / size.height)
      const w = size.width * s
      const h = size.height * s
      const x = original.box[0] + (bw - w) / 2
      const y = original.box[1] + (bh - h) / 2
      const rect: Box = [x, y, x + w, y + h]
      replacement = { bytes: change.picture, rect }
      if (P1) {
        // Upright in the box: the new picture's unit square onto it, then back through P.
        const X = mupdf.Matrix.concat([w, 0, 0, -h, x, y + h], P1)
        let added: mupdf.PDFObject | null = null
        make = (_picture, was) => {
          if (!added) {
            const image = new mupdf.Image(change.picture)
            try {
              added = doc.addImage(image)
            } finally {
              free(image)
            }
          }
          return wrapped(doc, added, mupdf.Matrix.concat(X, was))
        }
        expected = rect
      }
    }

    /** Tries one way of changing the picture where it is drawn; kept only when the result shows where it should. */
    const attempt = (way: () => boolean): boolean => {
      const undo = snapshot(doc, pageIndex)
      let done = false
      try {
        done = way()
      } catch {
        done = false
      }
      if (done) {
        const after = findPictures(doc, pageIndex)
        const want = expected
        const ok = want
          ? after.length === before.length && after.some((p) => p.box.every((v, i) => Math.abs(v - want[i]!) < 1))
          : after.length === before.length - 1
        if (ok) return true
      }
      undo()
      return false
    }
    // In place first: the picture keeps its data, direction and place in the drawing order. A picture
    // its frame crops (it shows less than its whole square) moves together with its frame (§83, E2).
    const inPlace = (): boolean => changeInPlace(doc, pageIndex, before, original, make)
    const withFrame = (): boolean => change.kind === 'move' && moveWithFrame(doc, pageIndex, before, original, boxToBox(original.box, change.rect))
    const whole = mupdf.Rect.transform([0, 0, 1, 1], P)
    const cropped = !close(original.box, [whole[0], whole[1], whole[2], whole[3]])
    if (change.kind === 'delete' || expected) {
      for (const way of cropped ? [withFrame, inPlace] : [inPlace, withFrame]) if (attempt(way)) return { bytes: saveBytes(doc), hole: false }
    }

    // Otherwise (an inline picture, or a cropped one whose crop cannot move with it: inside a form,
    // or in a group that draws more than the picture): removed, and drawn again over the page. Only this use of the picture goes when the
    // same object is drawn more than once.
    let hole = false
    if (change.kind === 'delete' || !removeOneUse(doc, pageIndex, before, original)) hole = removePicture(doc, pageIndex, box).hole
    if (change.kind === 'move') {
      // From its own data where possible (a JPEG stays one), turned as it was, cropped as it was.
      // A picture with a soft mask goes as PNG with its transparency combined (MuPDF draws the
      // mask separately).
      const mask = original.image.getMask()
      if (mask) free(mask)
      if (placed && invertible(placed)) draw(doc, pageIndex, mask ? toPng(original.image) : original.image, { matrix: placed, clip: change.rect })
      else draw(doc, pageIndex, toPng(original.image), { rect: change.rect })
    } else if (replacement) draw(doc, pageIndex, replacement.bytes, { rect: replacement.rect })
    return { bytes: saveBytes(doc), hole }
  } finally {
    free(doc)
  }
}

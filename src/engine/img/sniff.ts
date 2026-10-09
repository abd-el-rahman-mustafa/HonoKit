import { formatOfName, type FormatId } from '@shared/imageFormats'

/**
 * What a file really is, from its first bytes. Phones save HEIC photos as .jpg, web sites
 * serve WebP as .png, and .jfif is simply JPEG; the extension is only a fallback for formats
 * without a signature (Targa, some RAW, Netpbm variants without one, ICNS …).
 */
export function sniff(head: Uint8Array, name = ''): FormatId | null {
  const b = head
  const ascii = (start: number, text: string): boolean => {
    if (b.length < start + text.length) return false
    for (let i = 0; i < text.length; i++) if (b[start + i] !== text.charCodeAt(i)) return false
    return true
  }
  const bytes = (start: number, ...values: number[]): boolean => values.every((v, i) => b[start + i] === v)

  if (bytes(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (bytes(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return isApng(b) ? 'apng' : 'png'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp'
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.slice(8, 12))
    const compatible = String.fromCharCode(...b.slice(16, Math.min(b.length, 64)))
    if (brand === 'avif' || brand === 'avis') return 'avif'
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(brand)) {
      // mif1/msf1 are generic HEIF: AVIF when an AV1 brand is listed.
      return /avif|avis/.test(compatible) ? 'avif' : 'heic'
    }
    if (brand === 'crx ') return 'cr2'
    if (brand === 'jxl ') return 'jxl'
  }
  if (bytes(0, 0x00, 0x00, 0x00, 0x0c) && ascii(4, 'jP  ')) return 'jp2'
  if (bytes(0, 0xff, 0x4f, 0xff, 0x51)) return 'jp2'
  if (bytes(0, 0xff, 0x0a)) return 'jxl'
  if (bytes(0, 0x00, 0x00, 0x00, 0x0c) && ascii(4, 'JXL ')) return 'jxl'
  if (ascii(0, 'II*\0') || ascii(0, 'MM\0*') || ascii(0, 'II+\0') || ascii(0, 'MM\0+')) return tiffFamily(b, name)
  if (ascii(0, 'IIRO') || ascii(0, 'IIRS')) return 'orf'
  if (ascii(0, 'IIU\0')) return 'rw2'
  if (ascii(0, 'FUJIFILMCCD-RAW')) return 'raf'
  if (ascii(0, 'BM')) return 'bmp'
  // A Targa header has no signature and often begins 00 00 02 00, like a cursor: trust its name.
  if (formatOfName(name)?.id === 'tga') return 'tga'
  if (bytes(0, 0x00, 0x00, 0x01, 0x00) && b[4]! > 0) return 'ico'
  if (bytes(0, 0x00, 0x00, 0x02, 0x00) && b[4]! > 0) return 'cur'
  if (ascii(0, '8BPS')) return 'psd'
  if (ascii(0, 'gimp xcf')) return 'xcf'
  if (ascii(0, '%PDF')) return 'pdf'
  if (ascii(0, 'icns')) return 'icns'
  if (ascii(0, 'qoif')) return 'qoi'
  if (bytes(0, 0x76, 0x2f, 0x31, 0x01)) return 'exr'
  if (ascii(0, '#?RADIANCE') || ascii(0, '#?RGBE')) return 'hdr'
  if (ascii(0, 'DDS ')) return 'dds'
  if (ascii(0, 'SDPX') || ascii(0, 'XPDS')) return 'dpx'
  if (ascii(0, 'SIMPLE  =')) return 'fits'
  if (ascii(128, 'DICM')) return 'dcm'
  if (bytes(0, 0x8a, 0x4d, 0x4e, 0x47)) return 'jng'
  if (bytes(0, 0x8b, 0x4a, 0x4e, 0x47)) return 'jng'
  if (bytes(0, 0x59, 0xa6, 0x6a, 0x95)) return 'ras'
  if (bytes(0, 0x01, 0xda)) return 'sgi'
  if (bytes(0, 0x0a) && b[2] === 0x01 && (b[1] ?? 9) <= 5) return 'pcx'
  if (ascii(0, 'farbfeld')) return 'farbfeld'
  if (ascii(0, 'id=ImageMagick')) return 'miff'
  if (ascii(0, '/* XPM */')) return 'xpm'
  if (b[0] === 0x50 && b[1] !== undefined && b[1] >= 0x31 && b[1] <= 0x37) {
    const kind = String.fromCharCode(b[1])
    if (kind === '1' || kind === '4') return 'pbm'
    if (kind === '2' || kind === '5') return 'pgm'
    if (kind === '3' || kind === '6') return 'ppm'
    if (kind === '7') return 'pam'
  }
  if (b[0] === 0x50 && (b[1] === 0x46 || b[1] === 0x66) && (b[2] === 0x0a || b[2] === 0x0d)) return 'pfm'
  if (isSvg(b)) return 'svg'
  if (bytes(0, 0x1f, 0x8b) && /\.svgz$/i.test(name)) return 'svg'
  if (bytes(0, 0x01, 0x00, 0x00, 0x00) && ascii(40, ' EMF')) return null
  // No signature: trust the name (Targa, WBMP, XBM, camera RAW without a TIFF header …).
  return formatOfName(name)?.id ?? null
}

/** Many RAW formats are TIFF inside; the name tells them apart. */
function tiffFamily(b: Uint8Array, name: string): FormatId {
  const byName = formatOfName(name)
  if (byName && (byName.group === 'raw' || byName.id === 'dng')) return byName.id
  // Canon CR2: "CR" at byte 8.
  if (b[8] === 0x43 && b[9] === 0x52) return 'cr2'
  return 'tiff'
}

/** A PNG with an animation control chunk before the first image data. */
function isApng(b: Uint8Array): boolean {
  let at = 8
  while (at + 8 <= b.length) {
    const length = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
    const type = String.fromCharCode(b[at + 4]!, b[at + 5]!, b[at + 6]!, b[at + 7]!)
    if (type === 'acTL') return true
    if (type === 'IDAT') return false
    at += 12 + length
  }
  return false
}

function isSvg(b: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 1024)).trimStart()
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)
}

/**
 * A JPEG's EXIF orientation, read without decoding it (docs/decisions.md §61): a phone stores an
 * upright photo sideways and says so here. No dependencies, so main can use it too.
 */

/** The EXIF orientation of a JPEG (1 = as stored), read from its APP1 segment. */
export function exifOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let i = 2
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
      const tiff = i + 10
      const little = bytes[tiff] === 0x49
      const u16 = (o: number): number => (little ? bytes[o]! | (bytes[o + 1]! << 8) : (bytes[o]! << 8) | bytes[o + 1]!)
      const u32 = (o: number): number => (little ? (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0 : ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0)
      const ifd = tiff + u32(tiff + 4)
      const entries = u16(ifd)
      for (let k = 0; k < entries; k++) {
        const e = ifd + 2 + k * 12
        if (e + 12 > bytes.length) break
        if (u16(e) === 0x0112) {
          const v = u16(e + 8)
          return v >= 1 && v <= 8 ? v : 1
        }
      }
      return 1
    }
    if (marker === 0xda) break
    i += 2 + length
  }
  return 1
}

/** Degrees clockwise to show a picture of that EXIF orientation upright (mirrored ones as their turn). */
export function orientationTurn(o: number): 0 | 90 | 180 | 270 {
  return o === 3 || o === 4 ? 180 : o === 6 || o === 5 ? 90 : o === 8 || o === 7 ? 270 : 0
}


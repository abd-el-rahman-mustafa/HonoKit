/**
 * Packs PNG images into a Windows .ico, which holds PNG images since Windows Vista: a 6-byte
 * header, a 16-byte entry per size, then each image's PNG bytes. Windows picks the size closest
 * to what it shows. Used by make-icon.mjs (the app) and make-file-icons.mjs (its files).
 */
export function packIco(sizes, images) {
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, at) // 0 means 256
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4) // colour planes
    head.writeUInt16LE(32, at + 6) // bits per pixel
    head.writeUInt32LE(images[i].length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  })
  return Buffer.concat([head, ...images])
}

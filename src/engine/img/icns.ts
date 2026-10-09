import sharp from 'sharp'

/**
 * Writes a macOS icon (.icns) — no library needed: the file is a header and a list of PNG
 * pictures, each tagged with its size (Apple's "ic07"…"ic14" and "icp4"…"icp6" types).
 */

const TYPES: Array<[type: string, pixels: number]> = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512]
]

export async function writeIcns(master: Buffer, sizes?: number[]): Promise<Buffer> {
  const wanted = sizes?.length ? new Set(sizes) : null
  const cache = new Map<number, Buffer>()
  const parts: Buffer[] = []
  for (const [type, pixels] of TYPES) {
    if (wanted && !wanted.has(pixels)) continue
    let png = cache.get(pixels)
    if (!png) {
      png = await sharp(master).resize(pixels, pixels, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer()
      cache.set(pixels, png)
    }
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(png.length + 8, 4)
    parts.push(head, png)
  }
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'latin1')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

/**
 * Writes a Windows icon (.ico) or cursor (.cur): a directory of PNG pictures, one per size. PNG
 * entries are what Windows Vista and later, and every browser's favicon, read; they are a
 * fraction of the size of the old uncompressed bitmaps ImageMagick writes (361 KB → ~20 KB for
 * the usual six sizes). A cursor's hotspot is its top-left corner.
 */
export async function writeIco(master: Buffer, sizes: number[], cursor = false): Promise<Buffer> {
  const pngs: Array<{ size: number; data: Buffer }> = []
  for (const size of sizes) {
    const data = await sharp(master).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer()
    pngs.push({ size, data })
  }
  const header = Buffer.alloc(6 + 16 * pngs.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(cursor ? 2 : 1, 2)
  header.writeUInt16LE(pngs.length, 4)
  let offset = header.length
  pngs.forEach((p, i) => {
    const e = 6 + i * 16
    header.writeUInt8(p.size >= 256 ? 0 : p.size, e)
    header.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1)
    header.writeUInt8(0, e + 2)
    header.writeUInt8(0, e + 3)
    // Icons: colour planes and bits per pixel; cursors: the hotspot's x and y.
    header.writeUInt16LE(cursor ? 0 : 1, e + 4)
    header.writeUInt16LE(cursor ? 0 : 32, e + 6)
    header.writeUInt32LE(p.data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += p.data.length
  })
  return Buffer.concat([header, ...pngs.map((p) => p.data)])
}

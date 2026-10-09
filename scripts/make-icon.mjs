/**
 * Generates the app's icons from the two drawings in build/ (decisions §72): `npm run icons`.
 * - build/icon.png, 1024 px from icon.svg: electron-builder's Mac and Linux icons, and the
 *   development window's icon.
 * - build/icon.ico for Windows, which electron-builder uses as it is: 16–48 px from
 *   icon-small.svg (fewer details, so the Start menu, taskbar and File Explorer stay crisp) and
 *   64–256 px from icon.svg. Windows picks the size closest to what it shows.
 * The SVGs have gradients and blur, so Electron's own renderer draws them, each at its own size
 * (scripts/icon-render.cjs). The ICO holds PNG images (Windows Vista and later).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'build')
const SMALL = [16, 20, 24, 32, 40, 48]
const LARGE = [64, 96, 128, 256]
const temp = mkdtempSync(join(tmpdir(), 'honokit-icons-'))

try {
  const png = (size) => join(temp, `${size}.png`)
  const jobs = [
    [join(build, 'icon.svg'), join(build, 'icon.png'), 1024],
    ...SMALL.map((size) => [join(build, 'icon-small.svg'), png(size), size]),
    ...LARGE.map((size) => [join(build, 'icon.svg'), png(size), size])
  ]
  execFileSync(String(electron), [join(root, 'scripts', 'icon-render.cjs'), ...jobs.flat().map(String)], { stdio: 'inherit' })

  // An ICO: a 6-byte header, a 16-byte entry per size, then each image's PNG bytes.
  const sizes = [...SMALL, ...LARGE]
  const images = sizes.map((size) => readFileSync(png(size)))
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
  writeFileSync(join(build, 'icon.ico'), Buffer.concat([head, ...images]))
  console.log(`${join(build, 'icon.ico')} ${sizes.join(', ')} px`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

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
import { packIco } from './ico.mjs'

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

  const sizes = [...SMALL, ...LARGE]
  writeFileSync(join(build, 'icon.ico'), packIco(sizes, sizes.map((size) => readFileSync(png(size)))))
  console.log(`${join(build, 'icon.ico')} ${sizes.join(', ')} px`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

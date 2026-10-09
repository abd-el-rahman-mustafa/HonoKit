// PowerPoint to PDF without Office (docs/decisions.md §63), checked on real decks in the built app:
//   npm run build && node scripts/pptxcheck.mjs "path/to/deck.pptx" [more.pptx …]
// Each deck goes through our own converter; its PDF and a picture of every page are written to
// smoke-out/pptxcheck, with PowerPoint's own picture of the first slide (docProps/thumbnail.jpeg)
// beside it and a rough measure of how far apart the two are.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import * as mupdf from 'mupdf'

const require = createRequire(import.meta.url)
const files = process.argv.slice(2).map((f) => resolve(f))
if (!files.length) {
  console.error('Name one or more .pptx files.')
  process.exit(2)
}
const out = resolve('smoke-out', 'pptxcheck')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const result = spawnSync(require('electron'), [resolve('.')], {
  env: { ...process.env, POWERPDF_SMOKE: out, POWERPDF_SMOKE_ONLY: 'pptx', POWERPDF_PPTX_FILES: JSON.stringify(files), POWERPDF_SMOKE_LANG: 'en', POWERPDF_SMOKE_THEME: 'light' },
  encoding: 'utf8',
  timeout: 600_000
})
let report = { steps: [], errors: [`no report (exit ${result.status})`] }
try {
  report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
} catch {
  /* keep the fallback */
}

/** Gray values of a picture scaled to 64 × 36 (for comparing two pictures of a slide). */
function small(pix) {
  const W = pix.getWidth()
  const H = pix.getHeight()
  const s = pix.warp([[0, 0], [W, 0], [W, H], [0, H]], 64, 36)
  const px = s.getPixels()
  const n = s.getNumberOfComponents()
  const g = new Float64Array(64 * 36)
  for (let i = 0; i < 64 * 36; i++) g[i] = (px[i * n] * 299 + px[i * n + 1] * 587 + px[i * n + 2] * 114) / 1000
  s.destroy()
  return g
}

let failed = !!report.errors.length
for (const step of report.steps) {
  const m = /^pptx ok (\S+) (\d+)ms notes=(.*)$/.exec(step)
  if (!m) {
    console.log(`FAIL ${step.slice(0, 400)}`)
    failed = true
    continue
  }
  const [, name, ms, notes] = m
  const doc = mupdf.Document.openDocument(readFileSync(join(out, name)), 'application/pdf')
  const pages = doc.countPages()
  const base = name.replace(/\.pdf$/, '')
  let first = null
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i)
    const pix = page.toPixmap(mupdf.Matrix.scale(1.2, 1.2), mupdf.ColorSpace.DeviceRGB, false, true)
    writeFileSync(join(out, `${base}-p${String(i + 1).padStart(2, '0')}.png`), pix.asPNG())
    if (i === 0) first = small(pix)
    pix.destroy()
  }
  // PowerPoint's own picture of the first slide.
  const source = files.find((f) => name.startsWith(f.split(/[\\/]/).slice(-3).join('_').replace(/[^\w.-]+/g, '_')))
  let compare = 'no thumbnail'
  if (source) {
    const zip = await JSZip.loadAsync(readFileSync(source))
    const thumb = zip.file('docProps/thumbnail.jpeg')
    if (thumb) {
      const bytes = await thumb.async('uint8array')
      writeFileSync(join(out, `${base}-thumbnail.jpg`), bytes)
      const img = new mupdf.Image(bytes)
      const pix = img.toPixmap()
      const t = small(pix)
      let diff = 0
      for (let i = 0; i < t.length; i++) diff += Math.abs(t[i] - first[i])
      compare = `differs from PowerPoint's thumbnail by ${(diff / t.length).toFixed(1)}/255`
      pix.destroy()
    }
  }
  console.log(`OK   ${name}: ${pages} pages in ${ms} ms; ${compare}`)
  if (notes !== '[]') console.log(`      notes: ${notes}`)
}
for (const e of report.errors) console.log(`      ERROR ${e.slice(0, 300)}`)
console.log(`Pictures in ${out} (${readdirSync(out).filter((f) => f.endsWith('.png')).length} pages).`)
process.exit(failed ? 1 : 0)

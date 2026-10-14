/**
 * Generates the icons Windows shows for the files HonoKit opens (decisions §91), one .ico per type
 * in build/file-icons: `npm run icons`, or `node scripts/make-file-icons.mjs [--keep <folder>]` to
 * keep every rendered PNG for a look.
 * A file is drawn as a document first and as HonoKit's second: a white page with a folded corner,
 * the format's name on a band that wraps past the page's edge, and HonoKit's paper flame as a badge.
 * PDF is violet and pictures gold, the two halves of the mark (§72). The app's own icon stays for
 * the program. Three drawings, each drawn at its own sizes so every size stays crisp: 16–20 px (no
 * words), 24–48 px (the name, large) and 64–256 px (the name, a hint of the content, the badge).
 * The names of the .ico files are electron-builder.yml's win.fileAssociations `icon` entries.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { packIco } from './ico.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build', 'file-icons')

/** [file name, the name on the band]. Pictures share one look; only the name changes. */
export const TYPES = [
  ['pdf', 'PDF'],
  ['jpg', 'JPG'],
  ['png', 'PNG'],
  ['webp', 'WEBP'],
  ['gif', 'GIF'],
  ['heic', 'HEIC'],
  ['heif', 'HEIF'],
  ['avif', 'AVIF'],
  ['tiff', 'TIFF'],
  ['bmp', 'BMP'],
  ['svg', 'SVG'],
  ['ico', 'ICO'],
  ['jxl', 'JXL']
]
const SMALL = [16, 20]
const MID = [24, 32, 40, 48]
const LARGE = [64, 96, 128, 256]

const COLOURS = {
  pdf: { band: ['#7b5cff', '#5233d8', '#4126b8'], text: '#ffffff', fold: ['#efeaff', '#b9a9ff'], small: '#5b3fe0' },
  picture: { band: ['#ffd65e', '#f7a928', '#ec8a1a'], text: '#3d1f00', fold: ['#fff4d2', '#f5c35a'], small: '#f5a524' }
}

// The flame of build/icon.svg: eight folds, each with its own light, drawn in a 64-unit box.
const FLAME_STOPS = [
  ['#fff6a0', '#ffc21e'], ['#ffb21e', '#ff641a'], ['#ff5a2a', '#e3342c'], ['#ff7a2a', '#f04a2c'],
  ['#ffd24d', '#ff942e'], ['#ffe48a', '#ffb23a'], ['#fffbe6', '#ffe066'], ['#ffc247', '#ff7a2a']
]
const FLAME_FOLDS = [
  '29,27 36,4 32,40', '36,4 48,28 32,40', '48,28 47,48 32,40', '47,48 32,60 32,40',
  '32,60 17,48 32,40', '17,48 19,30 32,40', '19,30 29,27 32,40', '24,16 29,27 19,30'
]
const FLAME_OUTLINE = '36,4 48,28 47,48 32,60 17,48 19,30 24,16 29,27'

const flameDefs = () =>
  FLAME_STOPS.map(([a, b], i) => `<linearGradient id="f${i + 1}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`).join('')

/** The flame centred on (x, y) at `scale` of its 64-unit drawing, cut out of what is under it by a white edge. */
function flame(x, y, scale, { edge, shadow }) {
  const at = `translate(${x} ${y}) scale(${scale}) translate(-32.5 -32)`
  const folds = FLAME_FOLDS.map((p, i) => `<polygon points="${p}" fill="url(#f${i + 1})" stroke="url(#f${i + 1})"/>`).join('')
  return (
    (shadow ? `<polygon transform="translate(${x + 0.6} ${y + 0.9}) scale(${scale}) translate(-32.5 -32)" points="${FLAME_OUTLINE}" fill="#1b0f5c" fill-opacity=".35" stroke="#1b0f5c" stroke-opacity=".35" stroke-width="${edge}" stroke-linejoin="round" filter="url(#soft)"/>` : '') +
    `<polygon transform="${at}" points="${FLAME_OUTLINE}" fill="#fff" stroke="#fff" stroke-width="${edge}" stroke-linejoin="round"/>` +
    `<g transform="${at}" stroke-width=".8" stroke-linejoin="round">${folds}</g>`
  )
}

const FONT = `font-family="'Segoe UI Variable Display','Segoe UI',Arial,sans-serif" font-weight="700"`

/** The name on the band, centred, squeezed only if it would not fit. */
function label(text, cx, baseline, size, room, colour) {
  const natural = text.length * size * 0.66
  const fit = natural > room ? ` textLength="${room}" lengthAdjust="spacingAndGlyphs"` : ''
  return `<text x="${cx}" y="${baseline}" text-anchor="middle" font-size="${size}" ${FONT} fill="${colour}" letter-spacing=".2"${fit}>${text}</text>`
}

const PAGE = 'M16 4H40L52 16V56a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z'
const FOLD = 'M40 4V12a4 4 0 0 0 4 4H52Z'

/** 64–256 px: the name, a hint of what is inside (lines of text, or a photo), the flame badge. */
function large(kind, name) {
  const c = COLOURS[kind]
  const inside =
    kind === 'pdf'
      ? '<rect x="18" y="20" width="28" height="2.4" rx="1.2" fill="#d9d3ef"/><rect x="18" y="25" width="24" height="2.4" rx="1.2" fill="#d9d3ef"/><rect x="18" y="30" width="18" height="2.4" rx="1.2" fill="#d9d3ef"/>'
      : '<clipPath id="photo"><rect x="18" y="17.5" width="28" height="14.5" rx="2.5"/></clipPath>' +
        '<g clip-path="url(#photo)"><rect x="18" y="17.5" width="28" height="14.5" fill="url(#sky)"/>' +
        '<polygon points="18,32 18,27 23,23 28,27.5 33.5,22 40,26.5 46,24 46,32" fill="url(#hills)"/>' +
        '<polygon points="18,32 22,29.5 27,31 33,27.5 40,30 46,28.5 46,32" fill="url(#hill)"/></g>' +
        '<circle cx="23" cy="21.6" r="3.2" fill="url(#sunGlow)"/><circle cx="23" cy="21.6" r="1.7" fill="#fff"/>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#efecf7"/></linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.fold[0]}"/><stop offset="1" stop-color="${c.fold[1]}"/></linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.band[0]}"/><stop offset=".55" stop-color="${c.band[1]}"/><stop offset="1" stop-color="${c.band[2]}"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a6"/><stop offset="1" stop-color="#ffc94a"/></linearGradient>
    <linearGradient id="hills" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a99bff"/><stop offset="1" stop-color="#7a62f5"/></linearGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6247e8"/><stop offset="1" stop-color="#3b23a8"/></linearGradient>
    <radialGradient id="sunGlow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation=".7"/></filter>
    ${flameDefs()}
  </defs>
  <path d="${PAGE}" fill="#1b0f5c" fill-opacity=".18" transform="translate(.4 .8)" filter="url(#soft)"/>
  <path d="${PAGE}" fill="url(#paper)" stroke="#a7a0c8" stroke-width=".75"/>
  ${inside}
  <path d="${FOLD}" fill="#1b0f5c" fill-opacity=".22" transform="translate(-.8 .9)" filter="url(#soft)"/>
  <path d="${FOLD}" fill="url(#fold)" stroke="#a7a0c8" stroke-width=".5" stroke-linejoin="round"/>
  <rect x="6" y="35.5" width="40" height="16" rx="2.5" fill="#1b0f5c" fill-opacity=".3" filter="url(#soft)"/>
  <rect x="6" y="34.5" width="40" height="16" rx="2.5" fill="url(#band)"/>
  <rect x="6" y="34.5" width="40" height="8" rx="2.5" fill="#fff" fill-opacity=".12"/>
  ${label(name, 24.5, 46.6, name.length > 3 ? 11 : 12.5, 32, c.text)}
  ${flame(50, 48.5, 0.42, { edge: 7, shadow: true })}
</svg>`
}

/** 24–48 px: the page, the name as large as it can be, the flame; nothing inside the page. */
function mid(kind, name) {
  const c = COLOURS[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.fold[0]}"/><stop offset="1" stop-color="${c.fold[1]}"/></linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.band[0]}"/><stop offset=".55" stop-color="${c.band[1]}"/><stop offset="1" stop-color="${c.band[2]}"/></linearGradient>
    ${flameDefs()}
  </defs>
  <path d="${PAGE}" fill="#ffffff" stroke="#8f88b5" stroke-width="2"/>
  <path d="${FOLD}" fill="url(#fold)" stroke="#8f88b5" stroke-width="1.5" stroke-linejoin="round"/>
  <rect x="3" y="26" width="47" height="22" rx="3" fill="url(#band)"/>
  ${label(name, 25.5, 42.6, name.length > 3 ? 15 : 17.5, 42, c.text)}
  ${flame(51.5, 50, 0.4, { edge: 9, shadow: false })}
</svg>`
}

/** 16–20 px, drawn on a 16-unit grid: the page, the type's colour, the flame. No words. */
function small(kind) {
  const c = COLOURS[kind]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs>${flameDefs()}</defs>
  <path d="M3.5 .5H10L13.5 4V15.5H3.5Z" fill="#ffffff" stroke="#857eaa" stroke-linejoin="round"/>
  <path d="M10 .5V4H13.5" fill="${c.fold[1]}" stroke="#857eaa" stroke-linejoin="round"/>
  <rect x="1" y="6" width="10" height="5" rx=".8" fill="${c.small}"/>
  ${flame(12.4, 12.3, 0.115, { edge: 14, shadow: false })}
</svg>`
}

function main() {
  const keepAt = process.argv.indexOf('--keep')
  const keep = keepAt > 0 ? resolve(process.argv[keepAt + 1]) : null
  const temp = mkdtempSync(join(tmpdir(), 'honokit-file-icons-'))
  try {
    const jobs = []
    const png = (file, size) => join(temp, `${file}-${size}.png`)
    for (const [file, name] of TYPES) {
      const kind = file === 'pdf' ? 'pdf' : 'picture'
      const drawings = [
        [SMALL, small(kind)],
        [MID, mid(kind, name)],
        [LARGE, large(kind, name)]
      ]
      drawings.forEach(([sizes, svg], i) => {
        const path = join(temp, `${file}-${i}.svg`)
        writeFileSync(path, svg)
        for (const size of sizes) jobs.push([path, png(file, size), size])
      })
    }
    execFileSync(String(electron), [join(root, 'scripts', 'icon-render.cjs'), ...jobs.flat().map(String)], { stdio: ['ignore', 'ignore', 'inherit'] })

    mkdirSync(out, { recursive: true })
    const sizes = [...SMALL, ...MID, ...LARGE]
    for (const [file] of TYPES) {
      writeFileSync(join(out, `${file}.ico`), packIco(sizes, sizes.map((size) => readFileSync(png(file, size)))))
      if (keep) {
        mkdirSync(keep, { recursive: true })
        for (const size of sizes) writeFileSync(join(keep, `${file}-${size}.png`), readFileSync(png(file, size)))
      }
    }
    console.log(`${out}: ${TYPES.map(([f]) => f).join(', ')} (${sizes.join(', ')} px)`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

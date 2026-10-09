/**
 * The image tools in the built app (decisions §69): makes a few pictures in a temporary folder
 * (a photo with camera details and a GPS position, a transparent PNG, an animated GIF, a BMP),
 * then drives every image tool in English/light and Arabic/dark (src/main/imgcheck.ts).
 * Screenshots and a report land in smoke-out/imgcheck/<run>/. Results are written beside the
 * pictures in the temporary folder, never into the person's folders.
 *
 *   npm run build && node scripts/imgcheck.mjs [more pictures to copy in …]
 *   node scripts/imgcheck.mjs --packaged release/win-unpacked/HonoKit.exe   (the installed-style build)
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const packagedAt = process.argv.indexOf('--packaged')
const executable = packagedAt > 0 ? resolve(process.argv[packagedAt + 1]) : require('electron')
const appArgs = packagedAt > 0 ? [] : [resolve('.')]
const extraArgs = process.argv.slice(2).filter((a, i, all) => a !== '--packaged' && all[i - 1] !== '--packaged')
const runs = [
  { name: 'en-light', lang: 'en', theme: 'light', labels: {} },
  {
    name: 'ar-dark',
    lang: 'ar',
    theme: 'dark',
    labels: {
      allTools: 'كل الأدوات',
      close: 'إغلاق',
      'group.images': 'أدوات الصور',
      'tool.imgConvert': 'تحويل الصور',
      'tool.imgCompress': 'ضغط الصور',
      'tool.imgResize': 'تغيير حجم الصور',
      'tool.imgCrop': 'قص الصور',
      'tool.imgRotate': 'تدوير الصور',
      'tool.imgGif': 'صنع صورة GIF',
      'tool.imgFrames': 'GIF إلى صور',
      'tool.imgIcon': 'صانع الأيقونات',
      'tool.imgInfo': 'معلومات الصورة وبياناتها',
      'img.level.strong': 'قوي',
      'img.byPercent': 'النسبة المئوية',
      'img.right': 'يمينًا',
      'img.startOver': 'البدء من جديد',
      'img.backToPictures': 'العودة إلى الصور',
      'tool.imgWatermark': 'إضافة علامة مائية للصور',
      'tool.imgMeme': 'صانع الميمز',
      'mark.addText': 'إضافة نص',
      'mark.tile': 'تكرار على الصورة كلها',
      'meme.outside': 'فوقها وتحتها',
      'tool.imgEditor': 'محرر الصور',
      'editor.adjust.brightness': 'السطوع',
      'editor.adjust.vignette': 'تعتيم الحواف',
      'editor.filter.vintage': 'عتيق',
      'editor.corners': 'زوايا مستديرة',
      'editor.frame': 'الإطار',
      'editor.savedPrefix': 'حُفظت باسم',
      'editor.updatedPrefix': 'حُدّثت',
      'img.level.light': 'خفيف',
      'img.zoomIn': 'تكبير العرض',
      'tool.imagesToPdf': 'تحويل الصور إلى PDF',
      'act.imagesToPdf': 'تحويل إلى PDF',
      home: 'الرئيسية',
      'tool.imgUpscale': 'تكبير الصور بالذكاء الاصطناعي',
      'tool.imgRemoveBg': 'إزالة الخلفية',
      'tool.imgBlur': 'إخفاء الوجوه'
    }
  }
]

let failed = false
for (const run of runs) {
  const inputs = join(tmpdir(), `honopdf-imgcheck-${run.name}`)
  rmSync(inputs, { recursive: true, force: true })
  mkdirSync(inputs, { recursive: true })
  // A "photo": noise compresses like one; EXIF says which camera and where.
  const w = 1600
  const h = 1067
  const noise = Buffer.alloc(w * h * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = ((i * 2654435761) >>> 24) & 0x7f | ((i / 3 / w) & 0x80)
  const photo = join(inputs, 'holiday photo.jfif')
  await sharp(noise, { raw: { width: w, height: h, channels: 3 } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="300" fill="#ffd23f"/><rect x="100" y="100" width="300" height="200" fill="#1473e6"/></svg>`) }])
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Make: 'Canon', Model: 'EOS R6' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 12/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '55/1 16/1 0/1' } })
    .toFile(photo)
  const transparent = join(inputs, 'logo.png')
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="220" fill="#7c3aed"/><text x="256" y="300" font-size="160" text-anchor="middle" fill="#fff" font-family="Arial">Ho</text></svg>')).png().toFile(transparent)
  const frames = await Promise.all(['#e11d48', '#16a34a', '#1473e6', '#ca8a04'].map((c, i) => sharp({ create: { width: 240, height: 160, channels: 4, background: c } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><text x="120" y="100" font-size="64" text-anchor="middle" fill="#fff" font-family="Arial">${i + 1}</text></svg>`) }]).png().toBuffer()))
  const animation = join(inputs, 'counter.gif')
  await sharp(frames, { join: { animated: true } }).gif({ delay: [400, 400, 400, 400], loop: 0 }).toFile(animation)
  // A BMP, written by hand (24-bit, bottom-up): read through ImageMagick, the WebAssembly engine.
  const bmp = join(inputs, 'paint.bmp')
  {
    const bw = 300
    const bh = 200
    const row = Math.ceil((bw * 3) / 4) * 4
    const file = Buffer.alloc(54 + row * bh)
    file.write('BM', 0, 'latin1')
    file.writeUInt32LE(file.length, 2)
    file.writeUInt32LE(54, 10)
    file.writeUInt32LE(40, 14)
    file.writeInt32LE(bw, 18)
    file.writeInt32LE(bh, 22)
    file.writeUInt16LE(1, 26)
    file.writeUInt16LE(24, 28)
    file.writeUInt32LE(row * bh, 34)
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) file.set([(x * 255) / bw, (y * 255) / bh, 160], 54 + y * row + x * 3)
    writeFileSync(bmp, file)
  }
  const tiff = join(inputs, 'scan.tif')
  await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).resize(800).tiff().toFile(tiff)
  const extra = extraArgs.map((p) => {
    const to = join(inputs, basename(p))
    copyFileSync(resolve(p), to)
    return to
  })

  const folder = resolve('smoke-out', 'imgcheck', packagedAt > 0 ? `packaged-${run.name}` : run.name)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const result = spawnSync(executable, appArgs, {
    env: {
      ...process.env,
      POWERPDF_SMOKE: folder,
      POWERPDF_SMOKE_ONLY: 'images',
      POWERPDF_IMAGE_FILES: JSON.stringify([photo, transparent, animation, tiff, bmp, ...extra]),
      POWERPDF_SMOKE_LANG: run.lang,
      POWERPDF_SMOKE_THEME: run.theme,
      POWERPDF_SMOKE_LABELS: JSON.stringify(run.labels)
    },
    encoding: 'utf8',
    timeout: 300_000
  })
  let report = { steps: [], errors: [`no report (exit ${result.status}): ${result.stderr?.slice(-1500)}`] }
  try {
    report = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8'))
  } catch {
    /* keep the fallback */
  }
  console.log(`\n== ${run.name}: exit ${result.status}`)
  for (const s of report.steps) if (!s.startsWith('shot ')) console.log(`  ${s.slice(0, 260)}`)
  for (const e of report.errors) console.log(`  ERROR ${e.slice(0, 300)}`)
  const bad = report.steps.filter((s) => /: false$/.test(s))
  if (result.status !== 0 || bad.length || report.errors.length) failed = true
}
process.exit(failed ? 1 : 0)

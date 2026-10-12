/**
 * Runs the built application in its scripted smoke mode (src/main/smoke.ts), in
 * English/light and in Arabic/dark, on a PDF generated here: no personal files. Then the
 * reader, picture viewer and hubs check (§75) on the real PDFs in corpus/ and pictures made here.
 * Screenshots and a report land in smoke-out/<run>/.
 *
 *   npm run smoke            (builds first)
 *   node scripts/smoke.mjs   (uses the existing build; --only=en-light,viewer-en-light for some runs)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument, PDFHexString, PDFString, StandardFonts, rgb } from 'pdf-lib'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
// With --packaged <exe>, the installed-style build is run instead of the development one.
const packagedAt = process.argv.indexOf('--packaged')
const executable = packagedAt > 0 ? resolve(process.argv[packagedAt + 1]) : require('electron')
const args = packagedAt > 0 ? [] : [resolve('.')]
const root = resolve('.')
const out = join(root, 'smoke-out')
mkdirSync(out, { recursive: true })

// A small, varied sample document.
const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
for (let i = 1; i <= 6; i++) {
  const page = pdf.addPage(i === 4 ? [792, 612] : [612, 792])
  const { width, height } = page.getSize()
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: rgb(0.15, 0.35, 0.65) })
  page.drawText(`Sample report — page ${i}`, { x: 48, y: height - 58, size: 24, font: bold, color: rgb(1, 1, 1) })
  for (let line = 0; line < 22; line++) {
    page.drawText(`Line ${line + 1}: The quick brown fox jumps over the lazy dog. Invoice total ${(i * 1000 + line * 37).toLocaleString('en-US')} AED.`, { x: 48, y: height - 130 - line * 22, size: 11, font })
  }
}
// A web link at the foot of page 1: clicking it asks before opening (§81).
{
  const first = pdf.getPage(0)
  first.drawText('www.example.com/annual-report', { x: 48, y: 36, size: 12, font, color: rgb(0.1, 0.35, 0.8) })
  const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [44, 30, 230, 52], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://www.example.com/annual-report') } }))
  first.node.addAnnot(link)
}
// A comment on page 2 with a reply and a review state on page 3: the Comments panel shows them
// under the comment (§82).
{
  const ctx = pdf.context
  const note = (rect, text, extra = {}) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: rect, Contents: PDFHexString.fromText(text), T: PDFHexString.fromText('Reviewer'), C: [1, 0.8, 0], Name: 'Comment', ...extra }))
  const parent = note([560, 40, 580, 60], 'Please check the totals on this page.')
  pdf.getPage(1).node.addAnnot(parent)
  const third = pdf.getPage(2).node
  third.addAnnot(note([560, 40, 580, 60], 'Checked: they add up — تم التحقق', { IRT: parent }))
  third.addAnnot(note([560, 40, 580, 60], 'Accepted set by Reviewer', { IRT: parent, State: PDFString.of('Accepted'), StateModel: PDFString.of('Review'), F: 30 }))
}
// A small form on the last page: a text field and a checkbox to fill in.
{
  const last = pdf.getPage(5)
  const form = pdf.getForm()
  last.drawText('Name:', { x: 48, y: 150, size: 12, font })
  form.createTextField('name').addToPage(last, { x: 100, y: 142, width: 260, height: 22 })
  form.createCheckBox('agree').addToPage(last, { x: 100, y: 110, width: 16, height: 16 })
  last.drawText('I agree', { x: 124, y: 113, size: 12, font })
}
const sample = join(out, 'sample.pdf')
// Written first: the scan below is made from it (a fresh smoke-out folder had none to read).
writeFileSync(sample, await pdf.save())

// A "scan" for Recognize text: page 1 of the sample as a picture, with no text layer.
{
  const mupdf = await import('mupdf')
  const rendered = mupdf.Document.openDocument(readFileSync(sample), 'application/pdf')
  const pix = rendered.loadPage(0).toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, true)
  const scan = await PDFDocument.create()
  const image = await scan.embedPng(pix.asPNG())
  scan.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  writeFileSync(join(out, 'sample-scan.pdf'), await scan.save())
}

// A Word file and a web page for Create PDF (Arabic, a table), made here: no personal files.
{
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel } = await import('docx')
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] })
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Quarterly report', heading: HeadingLevel.HEADING_1 }),
        new Paragraph('Sales grew in every region this quarter.'),
        new Paragraph({ bidirectional: true, children: [new TextRun({ text: 'نمت المبيعات في كل المناطق هذا الربع.', rightToLeft: true })] }),
        new Table({ rows: [new TableRow({ children: [cell('Region'), cell('Sales')] }), new TableRow({ children: [cell('Dubai'), cell('1,200')] })] })
      ]
    }]
  })
  writeFileSync(join(out, 'sample-create.docx'), await Packer.toBuffer(doc))
  writeFileSync(join(out, 'sample-create.html'), '<!doctype html><meta charset="utf-8"><h1>Web page</h1><p>Printed offline.</p><p dir="rtl">صفحة ويب بالعربية</p><img src="https://example.com/x.png">')
}

const runs = [
  { name: 'en-light', lang: 'en', theme: 'light', labels: {} },
  // A narrower window, like a laptop with the app not maximised: nothing may be cut off.
  { name: 'en-narrow', lang: 'en', theme: 'light', labels: {}, width: 960 },
  {
    name: 'ar-dark',
    lang: 'ar',
    theme: 'dark',
    labels: { organize: 'تنظيم', allTools: 'كل الأدوات', protect: 'حماية ملف PDF', edit: 'تحرير', watermark: 'إضافة علامة مائية', applyWatermark: 'إضافة العلامة المائية', settings: 'الإعدادات', signTool: 'توقيع', placeSignature: 'ضع التوقيع', highlightTool: 'تظليل', rect: 'مستطيل', penTool: 'قلم', addComment: 'أضف تعليقًا', post: 'نشر', comments: 'التعليقات', quickEdit: 'تحرير النص والصور', merge: 'دمج ملفات PDF', cancel: 'إلغاء', imagesToPdf: 'تحويل الصور إلى PDF', appearance: 'المظهر', about: 'حول', typeface: 'نوع الخط', underline: 'تسطير (Ctrl+U)', spellAdd: 'إضافة إلى القاموس', crop: 'قص الصفحات', split: 'تقسيم ملف PDF', choosePages: 'اختر الصفحات…', saving: 'الحفظ', places: 'أماكن التخزين', stamp: 'ختم', textbox: 'إضافة مربع نص', compare: 'مقارنة', compareText: 'نص', actCompare: 'قارن', close: 'إغلاق', redact: 'تنقيح', redactFind: 'بحث', actRedact: 'تطبيق التنقيح', formatText: 'تنسيق كل النص', headerFooter: 'الرأس والتذييل', convert: 'تحويل', sign: 'توقيع', certSign: 'التوقيع بمعرّف رقمي', batch: 'دفعة (سير عمل)', prepareForm: 'إعداد نموذج', info: 'معلومات المستند', bookmarks: 'الإشارات المرجعية', search: 'بحث واستبدال' }
  }
]

// The reader, the picture viewer and the hubs (decisions §75; src/main/viewercheck.ts): the app is
// started as Explorer starts it, with files on its command line — real PDFs from corpus/
// (git-ignored; files named in corpus/exclude.txt or POWERPDF_CORPUS_EXCLUDE left out) and pictures of many formats made here in a temporary folder.
const EXCLUDED = new Set(
  [...(process.env.POWERPDF_CORPUS_EXCLUDE ?? '').split(/[;|]/), ...(existsSync('corpus/exclude.txt') ? readFileSync('corpus/exclude.txt', 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')) : [])]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
)
const corpus = existsSync('corpus') ? readdirSync('corpus').filter((f) => f.toLowerCase().endsWith('.pdf') && !EXCLUDED.has(f.toLowerCase())).map((f) => resolve('corpus', f)) : []
const pdfs = corpus.length ? corpus : [sample]
const pictures = join(tmpdir(), 'honokit-viewercheck')
rmSync(pictures, { recursive: true, force: true })
mkdirSync(pictures, { recursive: true })
{
  const w = 1600
  const h = 1067
  const scene = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fb7ff"/><stop offset="1" stop-color="#ffe2b8"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="1180" cy="300" r="130" fill="#ffd23f"/><path d="M0 820 L420 430 L760 760 L1050 520 L1600 900 L1600 1067 L0 1067 Z" fill="#2f6b4f"/><path d="M0 930 L520 640 L900 900 L1300 700 L1600 960 L1600 1067 L0 1067 Z" fill="#1f4d39"/></svg>`)
  const photo = await sharp(scene).png().toBuffer()
  // A phone photo stored sideways: the viewer shows it upright (EXIF orientation 6).
  await sharp(photo).rotate(-90).jpeg({ quality: 88 }).withMetadata({ orientation: 6 }).toFile(join(pictures, '01 holiday.jpg'))
  await sharp(photo).resize(1200).webp({ quality: 80 }).toFile(join(pictures, '02 beach.webp'))
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><circle cx="320" cy="320" r="280" fill="#7c3aed"/><text x="320" y="380" font-size="180" text-anchor="middle" fill="#fff" font-family="Arial">Ho</text></svg>')).png().toFile(join(pictures, '03 logo.png'))
  const frames = await Promise.all(['#e11d48', '#16a34a', '#1473e6'].map((c, i) => sharp({ create: { width: 320, height: 200, channels: 4, background: c } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><text x="160" y="125" font-size="80" text-anchor="middle" fill="#fff" font-family="Arial">${i + 1}</text></svg>`) }]).png().toBuffer()))
  await sharp(frames, { join: { animated: true } }).gif({ delay: [500, 500, 500], loop: 0 }).toFile(join(pictures, '04 counter.gif'))
  await sharp(photo).resize(1000).avif({ quality: 50 }).toFile(join(pictures, '05 mountains.avif'))
  await sharp(photo).resize(900).tiff().toFile(join(pictures, '06 scan.tiff'))
  writeFileSync(join(pictures, '07 drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" rx="24" fill="#f8fafc"/><path d="M80 400 C 240 80, 560 80, 720 400" stroke="#1473e6" stroke-width="18" fill="none"/><circle cx="400" cy="190" r="60" fill="#e11d48"/></svg>')
  // A 24-bit BMP and an icon with a PNG entry, written by hand (read by the WebAssembly engine).
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
    writeFileSync(join(pictures, '08 paint.bmp'), file)
    const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#16a34a"/><path d="M18 34 l10 10 l18 -22" stroke="#fff" stroke-width="7" fill="none"/></svg>')).png().toBuffer()
    const ico = Buffer.alloc(22)
    ico.writeUInt16LE(1, 2)
    ico.writeUInt16LE(1, 4)
    ico[6] = 64
    ico[7] = 64
    ico.writeUInt16LE(1, 10)
    ico.writeUInt16LE(32, 12)
    ico.writeUInt32LE(png.length, 14)
    ico.writeUInt32LE(22, 18)
    writeFileSync(join(pictures, '09 app.ico'), Buffer.concat([ico, png]))
  }
  await sharp(photo).resize(800).jpeg({ quality: 80 }).toFile(join(pictures, '10 street.jfif'))
}
const firstPicture = join(pictures, '01 holiday.jpg')
const viewerRuns = [
  { name: 'viewer-en-light', lang: 'en', theme: 'light', mode: 'open', files: [pdfs[0], firstPicture], more: pdfs.slice(1) },
  { name: 'viewer-ar-dark', lang: 'ar', theme: 'dark', mode: 'open', files: [pdfs[1 % pdfs.length], firstPicture], more: pdfs.slice(2, 4) },
  { name: 'viewer-edit-en-light', lang: 'en', theme: 'light', mode: 'edit', files: ['--edit', pdfs[2 % pdfs.length], join(pictures, '02 beach.webp')], more: [] },
  { name: 'viewer-edit-ar-dark', lang: 'ar', theme: 'dark', mode: 'edit', files: ['--edit', pdfs[3 % pdfs.length], join(pictures, '05 mountains.avif')], more: [] }
]

let failed = false
// --only=en-light,viewer-ar-dark runs just those.
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
for (const run of [...runs, ...viewerRuns].filter((r) => !only || only.includes(r.name))) {
  const folder = join(out, packagedAt > 0 ? `packaged-${run.name}` : run.name)
  rmSync(folder, { recursive: true, force: true })
  const viewer = 'mode' in run
  const result = spawnSync(executable, viewer ? [...args, ...run.files] : args, {
    env: {
      ...process.env,
      POWERPDF_SMOKE: folder,
      POWERPDF_SMOKE_FILE: viewer ? '' : sample,
      POWERPDF_SMOKE_ONLY: viewer ? 'viewer' : (process.env.POWERPDF_SMOKE_ONLY ?? ''),
      POWERPDF_VIEWER_MODE: viewer ? run.mode : '',
      POWERPDF_VIEWER_PDFS: JSON.stringify(viewer ? run.more : []),
      POWERPDF_SMOKE_LANG: run.lang,
      POWERPDF_SMOKE_THEME: run.theme,
      POWERPDF_SMOKE_LABELS: JSON.stringify(run.labels),
      POWERPDF_SMOKE_WIDTH: String(run.width ?? ''),
      ELECTRON_ENABLE_LOGGING: '1'
    },
    encoding: 'utf8',
    timeout: viewer ? 420_000 : 240_000
  })
  let report = { steps: [], errors: [`no report (exit ${result.status}): ${result.stderr?.slice(-2000)}`] }
  try {
    report = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8'))
  } catch {
    /* keep the fallback */
  }
  console.log(`\n== ${run.name}: exit ${result.status}`)
  for (const s of report.steps) console.log(`  step  ${s}`)
  for (const e of report.errors) console.log(`  ERROR ${e}`)
  // The viewer check's yes/no steps must all be yes.
  const no = viewer ? report.steps.filter((s) => /: false|false,|false$/.test(s)) : []
  for (const s of no) console.log(`  FAILED ${s}`)
  if (result.status !== 0 || no.length) failed = true
}
process.exit(failed ? 1 : 0)

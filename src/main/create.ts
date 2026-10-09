import { BRAND } from '@shared/brand'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { BrowserWindow, session } from 'electron'

/**
 * Create a PDF from other files (docs/decisions.md §51), as Acrobat's Create PDF:
 *  - Word, Excel, PowerPoint and OpenDocument files through Microsoft Office when it is
 *    installed (its own "Save as PDF", best fidelity), else LibreOffice when installed;
 *  - without either, Word (.docx) and Excel (.xlsx) through our own route: the file read as
 *    HTML (mammoth for Word, exceljs for Excel) and printed by Chromium, which shapes Arabic;
 *  - web pages (.html) and text (.txt, .md, .csv) printed by Chromium directly.
 * Printing happens in a hidden window whose session refuses every network request: the app
 * never goes online (§42), and a web page cannot reach anything while it is turned into a PDF.
 */

export const CONVERTIBLE = ['.docx', '.doc', '.rtf', '.odt', '.xlsx', '.xls', '.ods', '.csv', '.pptx', '.ppt', '.odp', '.html', '.htm', '.xhtml', '.txt', '.md']

export type Method = 'office' | 'libreoffice' | 'built-in' | 'browser'

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function run(file: string, args: string[], env: Record<string, string>, timeout: number): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() }))
  )
}

/** Office applications that answer on this PC (their COM class is registered). */
export async function officeApps(): Promise<{ word: boolean; excel: boolean; powerpoint: boolean; libreoffice: boolean }> {
  if (process.platform !== 'win32') return { word: false, excel: false, powerpoint: false, libreoffice: !!libreOffice() }
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const has = async (prog: string): Promise<boolean> => (await run(reg, ['query', `HKCR\\${prog}\\CLSID`], {}, 5000)).ok
  const [word, excel, powerpoint] = await Promise.all([has('Word.Application'), has('Excel.Application'), has('PowerPoint.Application')])
  return { word, excel, powerpoint, libreoffice: !!libreOffice() }
}

function libreOffice(): string | null {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean) as string[]
  for (const r of roots) {
    const p = join(r, 'LibreOffice', 'program', 'soffice.exe')
    if (existsSync(p)) return p
  }
  return null
}

/** Office's own "Save as PDF". Paths go in environment variables, never in the script text. */
const OFFICE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = $env:HONO_IN; $out = $env:HONO_OUT
switch ($env:HONO_APP) {
  'word' {
    $app = New-Object -ComObject Word.Application; $app.Visible = $false; $app.DisplayAlerts = 0
    try { $d = $app.Documents.Open($in, $false, $true, $false); $d.ExportAsFixedFormat($out, 17); $d.Close(0) } finally { $app.Quit() }
  }
  'excel' {
    $app = New-Object -ComObject Excel.Application; $app.Visible = $false; $app.DisplayAlerts = $false
    try { $b = $app.Workbooks.Open($in, 0, $true); $b.ExportAsFixedFormat(0, $out); $b.Close($false) } finally { $app.Quit() }
  }
  'powerpoint' {
    $app = New-Object -ComObject PowerPoint.Application
    try { $p = $app.Presentations.Open($in, -1, 0, 0); $p.SaveAs($out, 32); $p.Close() } finally { $app.Quit() }
  }
}
'done'
`

async function viaOffice(app: 'word' | 'excel' | 'powerpoint', input: string, output: string): Promise<boolean> {
  const encoded = Buffer.from(OFFICE_SCRIPT, 'utf16le').toString('base64')
  const r = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { HONO_IN: input, HONO_OUT: output, HONO_APP: app }, 180_000)
  return r.ok && existsSync(output)
}

async function viaLibreOffice(input: string, folder: string): Promise<string | null> {
  const soffice = libreOffice()
  if (!soffice) return null
  // Its own profile folder, so a LibreOffice the person has open does not block the conversion.
  const profile = `file:///${join(folder, 'lo-profile').replace(/\\/g, '/')}`
  const r = await run(soffice, ['--headless', '--norestore', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', folder, input], {}, 180_000)
  const out = join(folder, `${basename(input, extname(input))}.pdf`)
  return r.ok && existsSync(out) ? out : null
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A page around converted content: readable type, Arabic-capable fonts, each block's direction from its own text. */
function page(body: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; margin: 0; }
    h1 { font-size: 20pt } h2 { font-size: 16pt } h3 { font-size: 13pt }
    table { border-collapse: collapse; margin: 8pt 0; max-width: 100% }
    td, th { border: 0.5pt solid #999; padding: 3pt 6pt; vertical-align: top; font-size: 10pt }
    img { max-width: 100% }
    pre { white-space: pre-wrap; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; margin: 0 }
    .sheet { page-break-before: always } .sheet:first-of-type { page-break-before: auto }
    .sheet h2 { font-size: 13pt; margin: 0 0 6pt }
  </style></head><body dir="auto">${body}</body></html>`
}

/** Paragraphs, headings, list items and cells take their direction from their first letter. */
const autoDirection = (html: string): string => html.replace(/<(p|h[1-6]|li|td|th)(\s|>)/g, '<$1 dir="auto"$2')

async function docxToHtml(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  const r = await mammoth.convertToHtml({ path })
  return page(autoDirection(r.value), basename(path))
}

async function xlsxToHtml(path: string): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(path)
  const parts: string[] = []
  book.eachSheet((sheet) => {
    const rows: string[] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      for (let c = 1; c <= sheet.actualColumnCount; c++) {
        const cell = row.getCell(c)
        const text = cell.text ?? ''
        const numeric = typeof cell.value === 'number'
        cells.push(`<td${numeric ? ' style="text-align:end"' : ''}>${escape(text)}</td>`)
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
    })
    if (rows.length) parts.push(`<section class="sheet"${sheet.views?.[0]?.rightToLeft ? ' dir="rtl"' : ''}><h2 dir="auto">${escape(sheet.name)}</h2><table>${rows.join('')}</table></section>`)
  })
  return page(autoDirection(parts.join('')), basename(path))
}

async function textToHtml(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  if (extname(path).toLowerCase() === '.csv') {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => `<tr>${l.split(',').map((c) => `<td>${escape(c.replace(/^"|"$/g, ''))}</td>`).join('')}</tr>`)
    return page(autoDirection(`<table>${rows.join('')}</table>`), basename(path))
  }
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => `<pre dir="auto">${escape(p)}</pre><br>`)
  return page(paragraphs.join(''), basename(path))
}

/** Prints HTML (a file, or markup) to PDF in a hidden window that cannot reach the network. */
async function printHtml(source: { file: string } | { html: string }): Promise<Uint8Array> {
  const offline = session.fromPartition('hono-print-offline')
  offline.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob|about|devtools):/i.test(details.url) }))
  const win = new BrowserWindow({ show: false, webPreferences: { session: offline, sandbox: true, javascript: 'file' in source, offscreen: false } })
  try {
    if ('file' in source) await win.loadFile(source.file)
    else await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(source.html, 'utf8').toString('base64')}`)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    return new Uint8Array(pdf)
  } finally {
    win.destroy()
  }
}

/**
 * Windows metafiles (EMF/WMF) drawn by Windows' own GDI+ into PNGs, all in one PowerShell run:
 * Chromium cannot draw them, and GDI+ draws them exactly (EMF+ included). The list of files to
 * draw comes in a JSON file named by an environment variable, never in the script text.
 */
const METAFILE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$list = Get-Content -Raw -LiteralPath $env:HONO_META_LIST | ConvertFrom-Json
foreach ($item in @($list)) {
  try {
    $mf = New-Object System.Drawing.Imaging.Metafile($item.in)
    $w = [double]$mf.Width; $h = [double]$mf.Height
    $k = [Math]::Min(8.0, 2400.0 / [Math]::Max(1.0, [Math]::Max($w, $h)))
    $bw = [int][Math]::Max(1, [Math]::Round($w * $k)); $bh = [int][Math]::Max(1, [Math]::Round($h * $k))
    $bmp = New-Object System.Drawing.Bitmap($bw, $bh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.DrawImage($mf, 0, 0, $bw, $bh)
    $g.Dispose(); $mf.Dispose()
    $bmp.Save($item.out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } catch { }
}
'done'
`

async function drawMetafiles(metafiles: Map<string, { bytes: Uint8Array; type: 'emf' | 'wmf' }>, folder: string): Promise<number> {
  if (!metafiles.size || process.platform !== 'win32') return metafiles.size
  const list: Array<{ in: string; out: string }> = []
  for (const [name, m] of metafiles) {
    const source = join(folder, `${name}.${m.type}`)
    await writeFile(source, m.bytes)
    list.push({ in: source, out: join(folder, 'media', name) })
  }
  const listFile = join(folder, 'metafiles.json')
  await writeFile(listFile, JSON.stringify(list), 'utf8')
  const encoded = Buffer.from(METAFILE_SCRIPT, 'utf16le').toString('base64')
  await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { HONO_META_LIST: listFile }, 120_000)
  return list.filter((i) => !existsSync(i.out)).length
}

/**
 * PowerPoint without Office (§63): the slides laid out as HTML by our converter, their pictures
 * beside it in a temporary folder, printed by Chromium at the slide's own size. Scripts are off:
 * the page is only markup we made.
 */
export async function pptxToPdf(path: string): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const { pptxToHtml } = await import('./pptx')
  const deck = await pptxToHtml(new Uint8Array(await readFile(path)))
  const folder = await mkdtemp(join(tmpdir(), 'hono-slides-'))
  try {
    await mkdir(join(folder, 'media'), { recursive: true })
    for (const [name, bytes] of deck.media) await writeFile(join(folder, 'media', name), bytes)
    const notes = [...deck.notes]
    if ((await drawMetafiles(deck.metafiles, folder)) > 0) notes.push('Some Windows metafile pictures (EMF/WMF) could not be drawn.')
    const page = join(folder, 'slides.html')
    await writeFile(page, deck.html, 'utf8')
    const offline = session.fromPartition('hono-print-offline')
    offline.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob|about|devtools):/i.test(details.url) }))
    const win = new BrowserWindow({ show: false, webPreferences: { session: offline, sandbox: true, javascript: false, offscreen: false } })
    try {
      await win.loadFile(page)
      const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: { width: deck.width / 72, height: deck.height / 72 }, margins: { marginType: 'none' } })
      return { bytes: new Uint8Array(pdf), notes }
    } finally {
      win.destroy()
    }
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One file → PDF bytes, and which way it went. */
export async function fileToPdf(path: string, options: { builtIn?: boolean } = {}): Promise<{ bytes: Uint8Array; method: Method; notes?: string[] }> {
  const ext = extname(path).toLowerCase()
  if (!CONVERTIBLE.includes(ext)) throw new Error(`${BRAND.name} cannot turn ${ext} files into PDF.`)
  if (['.html', '.htm', '.xhtml'].includes(ext)) return { bytes: await printHtml({ file: path }), method: 'browser' }
  if (['.txt', '.md'].includes(ext)) return { bytes: await printHtml({ html: await textToHtml(path) }), method: 'browser' }
  // A check run can ask for our own route even where Office is installed.
  if (options.builtIn && ext === '.pptx') {
    const r = await pptxToPdf(path)
    return { bytes: r.bytes, method: 'built-in', notes: r.notes }
  }
  const folder = await mkdtemp(join(tmpdir(), 'hono-create-'))
  try {
    await mkdir(folder, { recursive: true })
    const apps = await officeApps()
    const app = ['.docx', '.doc', '.rtf', '.odt'].includes(ext) ? 'word' : ['.xlsx', '.xls', '.ods', '.csv'].includes(ext) ? 'excel' : 'powerpoint'
    const out = join(folder, 'out.pdf')
    if (apps[app] && (await viaOffice(app, path, out))) return { bytes: new Uint8Array(await readFile(out)), method: 'office' }
    const lo = await viaLibreOffice(path, folder)
    if (lo) return { bytes: new Uint8Array(await readFile(lo)), method: 'libreoffice' }
    if (ext === '.docx') return { bytes: await printHtml({ html: await docxToHtml(path) }), method: 'built-in' }
    if (ext === '.xlsx') return { bytes: await printHtml({ html: await xlsxToHtml(path) }), method: 'built-in' }
    if (ext === '.csv') return { bytes: await printHtml({ html: await textToHtml(path) }), method: 'built-in' }
    if (ext === '.pptx') {
      const r = await pptxToPdf(path)
      return { bytes: r.bytes, method: 'built-in', notes: r.notes }
    }
    throw new Error(`To turn ${ext} files into PDF, install Microsoft Office or the free LibreOffice. Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files work without them.`)
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

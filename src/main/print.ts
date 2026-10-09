import { BrowserWindow, session } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PrintOptions, PrinterInfo } from '@shared/ipc'
import { grid, mm, sheetLandscape, sheets } from '@shared/printlayout'
import { writeNew, writeStaged } from '../worker/staging'

/**
 * Printing (docs/decisions.md §60). The chosen pages are rendered at print resolution by the
 * worker, laid out one per sheet in a hidden window that cannot reach the network, and sent to the
 * printer the person picked in HonoPDF's own dialog — Chromium cannot print a PDF from a hidden
 * window, but it prints pictures faithfully. "Microsoft Print to PDF" saves the pages as a PDF.
 */

export async function printers(): Promise<PrinterInfo[]> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    const list = await win.webContents.getPrintersAsync()
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!(p as { isDefault?: boolean }).isDefault }))
  } finally {
    win.destroy()
  }
}

/**
 * Prints `render(folder)`'s pictures (one file per page, in order). `sizes` are the pages' sizes
 * in points as displayed (rotation applied).
 */
export async function printPages(options: PrintOptions, sizes: Array<[number, number]>, render: (folder: string, dpi: number) => Promise<string[]>, toFile?: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'hono-print-'))
  try {
    // 300 dpi is what office printers print text at; a long document, or small pages, need less.
    const dpi = options.pages.length > 40 || options.perSheet > 2 ? 200 : 300
    const files = await render(folder, dpi)
    const landscape = sheetLandscape(sizes, options.orientation, options.perSheet)
    const [cols, rows] = grid(options.perSheet, landscape)
    // Fit fills the page's place; the others keep the page's real size (scaled), never larger than its place.
    const factor = options.fit === 'custom' ? options.scale / 100 : 1
    const img = (file: string, [w, h]: [number, number]): string => {
      const size = options.fit === 'fit' ? '' : `width:${(mm(w) * factor).toFixed(2)}mm;height:${(mm(h) * factor).toFixed(2)}mm;`
      const cls = options.fit === 'actual' || options.fit === 'custom' ? 'real' : options.fit
      return `<img class="${cls}" style="${size}" src="${pathToFileURL(file).href}">`
    }
    const body = sheets(files.length, options.perSheet)
      .map((list) => `<div class="sheet">${list.map((i) => `<div class="cell">${img(files[i]!, sizes[i] ?? [612, 792])}</div>`).join('')}</div>`)
      .join('\n')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.sheet { width: 100vw; height: 100vh; display: grid; grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr); gap: ${options.perSheet > 1 ? '4mm' : '0'}; padding: ${options.perSheet > 1 ? '6mm' : '0'}; box-sizing: border-box; overflow: hidden; break-after: page }
.sheet:last-child { break-after: auto }
.cell { display: flex; align-items: center; justify-content: center; overflow: hidden; min-width: 0; min-height: 0 }
img.fit { width: 100%; height: 100%; object-fit: contain }
img.shrink { max-width: 100%; max-height: 100%; object-fit: contain }
${options.grayscale ? 'img { filter: grayscale(1) }' : ''}
</style></head><body>${body}</body></html>`
    const page = join(folder, 'print.html')
    // In a fresh folder of our own; created exclusively all the same (§82).
    await writeNew(page, html)

    const offline = session.fromPartition('hono-print-offline')
    offline.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|blob|about|devtools):/i.test(details.url) }))
    const win = new BrowserWindow({ show: false, webPreferences: { session: offline, sandbox: true, javascript: false } })
    try {
      await win.loadFile(page)
      // A check run (smoke mode) lays the job out the same way but writes it to a file: nothing is printed.
      if (toFile) {
        await writeStaged(toFile, await win.webContents.printToPDF({ landscape, printBackground: true, margins: { marginType: 'none' }, ...(options.paper !== 'default' ? { pageSize: options.paper } : {}) }))
        return
      }
      await new Promise<void>((resolve, reject) => {
        win.webContents.print(
          {
            // Windows' own dialog when asked (the printer chosen here is preselected), otherwise straight to the printer.
            silent: !options.system,
            deviceName: options.printer,
            ...(options.paper !== 'default' ? { pageSize: options.paper } : {}),
            copies: options.copies,
            collate: true,
            color: !options.grayscale,
            landscape,
            printBackground: true,
            margins: { marginType: 'none' },
            duplexMode: options.duplex
          },
          (ok, reason) => (ok ? resolve() : reject(new Error(/cancel/i.test(reason) ? 'cancelled' : reason || 'The printer did not accept the job.')))
        )
      })
    } finally {
      win.destroy()
    }
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The printer's own preferences window, as the Properties button of a Windows print dialog opens
 * (paper source, quality, finishing — whatever its driver offers). Chosen there, they become that
 * printer's defaults, which HonoPDF's jobs then use.
 */
export function printerPreferences(name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', name], { windowsHide: false }, () => resolve())
  })
}

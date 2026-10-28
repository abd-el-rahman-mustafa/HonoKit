import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A scripted run of the real application, for checking a build end to end:
 * `POWERPDF_SMOKE=<folder> POWERPDF_SMOKE_FILE=<pdf>` (see scripts/smoke.mjs). It opens
 * the file, clicks through the main screens and a tool as a person would, saves a
 * screenshot of each, records every renderer error, and quits. Inert unless the
 * variable is set; it adds nothing a user can reach.
 */

export const smokeFolder = process.env.POWERPDF_SMOKE ?? null

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function runSmoke(window: BrowserWindow, openFiles: (paths: string[]) => void): Promise<void> {
  const out = smokeFolder!
  mkdirSync(out, { recursive: true })
  const errors: string[] = []
  const steps: string[] = []
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') errors.push(`${details.level}: ${details.message}`)
  })
  window.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`))

  const shot = async (name: string): Promise<void> => {
    await wait(400)
    const image = await window.webContents.capturePage()
    writeFileSync(join(out, `${name}.png`), image.toPNG())
    steps.push(name)
  }
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>
  /** Clicks the first element whose title, aria-label or text matches. */
  const click = (label: string): Promise<boolean> =>
    js<boolean>(`(() => {
      const want = ${JSON.stringify(label)}
      const el = [...document.querySelectorAll('button, [role=radio]')].find((b) => b.title === want || b.getAttribute('aria-label') === want || b.textContent.trim() === want)
      if (!el) return false
      el.click()
      return true
    })()`)
  /** The same, inside the first element matching `scope` (a label can appear twice, as a tab and a quick tool). */
  const clickIn = (scope: string, label: string): Promise<boolean> =>
    js<boolean>(`(async () => {
      const want = ${JSON.stringify(label)}
      // A document a tool just made opens in the reader (§75): Edit first, to reach the tool tabs.
      const edit = ${JSON.stringify(scope)} === '[data-global-bar]' && !document.querySelector('[data-global-bar]') && document.querySelector('[data-read-bar] [data-edit-button]')
      if (edit) {
        edit.click()
        await new Promise((r) => setTimeout(r, 400))
      }
      const root = document.querySelector(${JSON.stringify(scope)})
      const el = root && [...root.querySelectorAll('button')].find((b) => b.title === want || b.getAttribute('aria-label') === want || b.textContent.trim() === want)
      if (!el) return false
      el.click()
      return true
    })()`)
  const text = (): Promise<string> => js<string>('document.body.innerText')

  try {
    await wait(1500)
    // A PowerPoint-only check (scripts/pptxcheck.mjs): each file through our own converter (§63),
    // its PDF written to the folder; nothing is opened or clicked.
    if (process.env.POWERPDF_SMOKE_ONLY === 'pptx') {
      const { fileToPdf } = await import('./create')
      for (const f of JSON.parse(process.env.POWERPDF_PPTX_FILES ?? '[]') as string[]) {
        const started = Date.now()
        try {
          const r = await fileToPdf(f, { builtIn: true })
          const name = `${f.split(/[\\/]/).slice(-3).join('_').replace(/[^\w.-]+/g, '_')}.pdf`
          writeFileSync(join(out, name), r.bytes)
          steps.push(`pptx ok ${name} ${Date.now() - started}ms notes=${JSON.stringify(r.notes ?? [])}`)
        } catch (error) {
          steps.push(`pptx FAILED ${f}: ${(error as Error).stack ?? error}`)
        }
      }
      return
    }
    // The image tools' check (scripts/imgcheck.mjs, §69): pictures the script made, no PDF.
    if (process.env.POWERPDF_SMOKE_ONLY === 'images') {
      const { runImageCheck } = await import('./imgcheck')
      await runImageCheck(window, out, JSON.parse(process.env.POWERPDF_IMAGE_FILES ?? '[]') as string[], steps)
      return
    }
    // The reader, the picture viewer and the hubs (§75), on files given on the command line.
    if (process.env.POWERPDF_SMOKE_ONLY === 'viewer') {
      const { runViewerCheck } = await import('./viewercheck')
      await runViewerCheck(window, out, steps, openFiles)
      return
    }
    await shot('01-home')

    const file = process.env.POWERPDF_SMOKE_FILE
    if (file) {
      openFiles([file])
      await wait(3000)
      await shot('02-view')

      // The page pictures must actually have loaded, not just their frames.
      const loaded = await js<{ images: number; complete: number; broken: number }>(`(() => {
        const imgs = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('pdfpage:'))
        return { images: imgs.length, complete: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length }
      })()`)
      steps.push(`page images: ${JSON.stringify(loaded)}`)
      // The viewer's pages map pixel for pixel to the screen (§82).
      const exact = await js<{ exact: number; matching: number }>(`(() => {
        const imgs = [...document.querySelectorAll('img[data-exact]')].filter((i) => i.complete && i.naturalWidth > 0)
        const dpr = window.devicePixelRatio || 1
        const fits = (i) => Math.abs(i.naturalWidth - i.getBoundingClientRect().width * dpr) < 0.51 && Math.abs(i.naturalHeight - i.getBoundingClientRect().height * dpr) < 0.51
        return { exact: imgs.length, matching: imgs.filter(fits).length }
      })()`)
      steps.push(`page images pixel for pixel: ${exact.matching} of ${exact.exact}`)
      // A PDF opens in the reader (§75); Edit brings the editor the steps below drive.
      steps.push(`reader: ${await js<boolean>("!!document.querySelector('[data-read-bar] [data-edit-button]') && !document.querySelector('[data-global-bar]')")}`)
      if (!process.env.POWERPDF_SMOKE_ONLY) {
        // The Page thumbnails panel in the reader (§76): tick three pages, right-click one of them, rotate
        // the three from the menu — the document becomes unsaved and the reader's Save appears — then undo.
        await js("document.querySelector('[data-read-bar] button')?.click()")
        await wait(1200)
        for (const p of [0, 1, 2]) await js(`document.querySelector('[data-thumb="${p}"] [data-page-check]')?.click()`)
        await wait(300)
        steps.push(`thumbs: ticked: ${await js<number>("document.querySelectorAll('[data-thumb][data-selected]').length")}, bar: ${await js<string>("document.querySelector('[data-thumbs-selection]')?.innerText.split('\\n')[0] ?? ''")}`)
        await js(`(() => {
          const el = document.querySelector('[data-thumb="1"]')
          const r = el.getBoundingClientRect()
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 3 }))
        })()`)
        await wait(400)
        await shot('02a-reader-thumbs-menu')
        steps.push(`thumbs menu: ${await js<string>("[...document.querySelectorAll('[data-context-menu] [role=menuitem]')].map((b) => b.textContent.trim()).join(' | ')")}`)
        await js("document.querySelector('[data-context-menu] [data-menu-item=rotateRight]')?.click()")
        await wait(2500)
        steps.push(`thumbs: rotated 3 in the reader, Save shown: ${await js<boolean>("[...document.querySelectorAll('[data-read-bar] button')].some((b) => b.querySelector('.lucide-save'))")}`)
        await shot('02b-reader-rotated')
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] })
        await wait(1500)
        await js("document.querySelector('[data-thumbs-selection] button:last-child')?.click()")
        await js("document.querySelector('[data-read-bar] button')?.click()")
        await wait(300)
        steps.push(`thumbs: undone and closed: ${await js<boolean>("!document.querySelector('[data-side-panel]')")}`)
      }
      await js("document.querySelector('[data-read-bar] [data-edit-button]')?.click()")
      await wait(600)
      steps.push(`editor after Edit: ${await js<boolean>("!!document.querySelector('[data-global-bar]')")}`)
      await shot('02b-editor')

      const labels = JSON.parse(process.env.POWERPDF_SMOKE_LABELS ?? '{}') as Record<string, string>
      // A Find & Replace check (scripts/editcheck.mjs --replace=old:new, §64): Ctrl+H, find, Replace all.
      if (process.env.POWERPDF_SMOKE_ONLY === 'replace') {
        const [find, replacement] = (process.env.POWERPDF_REPLACE ?? ':').split(':') as [string, string]
        const typeInto = (selector: string, value: string): Promise<unknown> =>
          js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H', modifiers: ['control'] })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H', modifiers: ['control'] })
        await wait(600)
        steps.push(`replace: panel open: ${await js<boolean>("!!document.querySelector('[data-find-replace]')")}`)
        await typeInto('[data-find-input]', find)
        await js("document.querySelector('[data-find-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
        await wait(2500)
        const before = await js<string>("document.querySelector('[data-side-panel] p')?.innerText ?? ''")
        steps.push(`replace: found before: ${before}`)
        await typeInto('[data-replace-input]', replacement)
        await wait(200)
        await shot('60-replace-ready')
        await js("document.querySelector('[data-replace-all]')?.click()")
        // Wait for the change to finish (a progress bar shows while it runs).
        for (let i = 0; i < 120 && !(await js<string>("[...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(' ')")); i++) await wait(500)
        await wait(500)
        steps.push(`replace: toast: ${await js<string>("[...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(' | ')")}`)
        await shot('61-replaced')
        steps.push(`replace: old after: ${await js<string>("document.querySelector('[data-side-panel] p:last-child')?.innerText ?? ''")}`)
        await typeInto('[data-find-input]', replacement)
        await js("document.querySelector('[data-find-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))")
        await wait(2500)
        steps.push(`replace: new found: ${await js<string>("document.querySelector('[data-side-panel] p')?.innerText ?? ''")}`)
        await shot('62-new-found')
        return
      }
      // A scan-only check (scripts/editcheck.mjs --scan): Scan documents, Scan ID card and Image to text
      // on photos made by scripts/scanfixtures.mjs (§61).
      if (process.env.POWERPDF_SMOKE_ONLY === 'scan') {
        const fixtures = JSON.parse(process.env.POWERPDF_SCAN_FIXTURES ?? '{}') as { page: string; front: string; back: string; book?: string; bookPdf?: string }
        const openScanTool = async (label: string): Promise<boolean> => {
          await clickIn('[data-global-bar]', 'All tools')
          await wait(300)
          return clickIn('[data-all-tools]', label)
        }
        const addPhotos = (paths: string[]): Promise<unknown> => js(`window.dispatchEvent(new CustomEvent('powerpdf:images-add', { detail: ${JSON.stringify(paths)} }))`)
        const tabs = (): Promise<string> => js<string>("[...document.querySelectorAll('[role=tab], [data-tab]')].map((e) => e.textContent.trim()).join(' | ')")
        // 1. Scan documents: the page found in its photo, straightened, a PDF made.
        steps.push(`scan: tool opened: ${await openScanTool('Scan documents')}`)
        await wait(500)
        await addPhotos([fixtures.page])
        await wait(4000)
        await shot('50-scan-board')
        steps.push(`scan: corners ${await js<number>("document.querySelectorAll('[data-corner]').length")}, result shown: ${await js<boolean>("!!document.querySelector('[data-scan-card] img')")}`)
        await js("document.querySelector('[data-scan-go]')?.click()")
        await wait(9000)
        await shot('51-scan-pdf')
        steps.push(`scan: document opened: ${await js<string>("document.title + ' / ' + (document.querySelector('[data-page=\"0\"]') ? 'page shown' : 'no page')")}`)
        // 2. ID card: front and back on one A4 page.
        steps.push(`idcard: tool opened: ${await openScanTool('Scan ID card')}`)
        await wait(500)
        await addPhotos([fixtures.front, fixtures.back])
        await wait(4000)
        await shot('52-idcard-board')
        steps.push(`idcard: cards ${await js<number>("document.querySelectorAll('[data-scan-card]').length")}`)
        await js("document.querySelector('[data-scan-go]')?.click()")
        await wait(4000)
        await shot('53-idcard-pdf')
        steps.push(`idcard: document: ${await js<string>("document.querySelector('[data-page=\"0\"]') ? 'page shown' : 'no page'")}`)
        // 3. Image to text: recognised and saved.
        steps.push(`text: tool opened: ${await openScanTool('Image to text')}`)
        await wait(500)
        await addPhotos([fixtures.page])
        await wait(4000)
        await js("document.querySelector('[data-scan-go]')?.click()")
        await wait(25000)
        await shot('54-image-to-text')
        steps.push(`text: toast: ${await js<string>("[...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(' | ')")}`)
        // 4. Scan book (§62): a photo of an open spread and a PDF of two scanned spreads → six pages.
        if (fixtures.book) {
          steps.push(`book: tool opened: ${await openScanTool('Scan book')}`)
          await wait(500)
          await addPhotos([fixtures.book, fixtures.bookPdf!])
          await wait(9000)
          await shot('55-book-board')
          steps.push(
            `book: cards ${await js<number>("document.querySelectorAll('[data-scan-card]').length")}, pages in each ${await js<string>("[...document.querySelectorAll('[data-scan-card]')].map((c) => c.querySelectorAll('img').length).join(',')")}, fold line ${await js<boolean>("!!document.querySelector('[data-fold-handle]')")}`
          )
          // Not searchable here: recognising six newspaper pages would take minutes.
          await js("[...document.querySelectorAll('[data-scan-options] input[type=checkbox]')].forEach((c) => c.checked && c.click())")
          await js("document.querySelector('[data-scan-go]')?.click()")
          await wait(12000)
          await shot('56-book-pdf')
          steps.push(`book: document pages ${await js<number>("document.querySelectorAll('[data-page]').length")}`)
        }
        // Word, Excel and PowerPoint to PDF are in All tools (§63).
        await clickIn('[data-global-bar]', 'All tools')
        await wait(400)
        steps.push(`convert tools: ${await js<string>("[...document.querySelectorAll('[data-all-tools] button')].map((b) => b.textContent.trim()).filter((t) => /to PDF/.test(t)).join(' | ')")}`)
        await shot('57-all-tools')
        steps.push(`tabs: ${await tabs()}`)
        return
      }
      // A print-only check (scripts/editcheck.mjs --print): Ctrl+P, pages 2-3, Print; then Save pages.
      if (process.env.POWERPDF_SMOKE_ONLY === 'print') {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control'] })
        await wait(1500)
        await shot('40-print-dialog')
        steps.push(`print: dialog shown: ${await js<boolean>("!!document.querySelector('[data-print-dialog]')")}`)
        steps.push(`print: printers listed: ${await js<string>("document.querySelector('[data-print-dialog]')?.innerText.split('\\n').slice(0, 3).join(' | ') ?? ''")}`)
        await clickIn('[data-print-dialog]', 'Pages…')
        await wait(200)
        await js(`(() => {
          const input = document.querySelector('[data-print-dialog] input[dir=ltr]')
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set.call(input, '2-3')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
        await wait(400)
        // Two pages on one sheet: the sheet turns sideways, and the preview shows it.
        if (await clickIn('[data-print-dialog]', 'Pages per sheet')) {
          await wait(200)
          await js("[...document.querySelectorAll('[data-select-list] [role=option]')].find((o) => o.textContent.trim() === '2')?.click()")
          await wait(600)
        }
        if (await clickIn('[data-print-dialog]', 'Paper')) {
          await wait(200)
          await js("[...document.querySelectorAll('[data-select-list] [role=option]')].find((o) => o.textContent.trim() === 'A5')?.click()")
          await wait(400)
        }
        steps.push(`print: preferences button: ${await clickIn('[data-print-dialog]', 'Preferences…')}`)
        steps.push(`print: windows dialog button: ${await js<boolean>("!!document.querySelector('[data-print-system]')")}`)
        steps.push(`print: preview sheet: ${await js<string>("(() => { const r = document.querySelector('[data-sheet-preview]')?.getBoundingClientRect(); return r ? (r.width > r.height ? 'landscape' : 'portrait') + ' ' + document.querySelectorAll('[data-sheet-preview] img').length + ' pages' : 'none' })()")}`)
        await shot('41-print-pages')
        const enabled = await js<boolean>("!document.querySelector('[data-print-go]')?.disabled")
        steps.push(`print: button enabled: ${enabled}`)
        await js("document.querySelector('[data-print-go]')?.click()")
        await wait(8000)
        await shot('42-printed')
        steps.push(`print: toast: ${await js<string>("[...document.querySelectorAll('[role=status]')].map((e) => e.innerText).join(' | ')")}`)
        await js("document.querySelector('[data-app-menu-button]')?.click()")
        await click('Menu')
        await wait(300)
        await click('Save pages as PDF…')
        await wait(600)
        await shot('43-save-pages')
        steps.push(`savePages: dialog shown: ${await js<boolean>("!!document.querySelector('[data-save-pages-dialog]')")}`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await wait(300)
        // The page's right-click menu offers Save and Print for that page.
        await js(`(() => {
          const page = document.querySelector('[data-page="0"] [data-select-layer]') ?? document.querySelector('[data-page="0"]')
          const r = page.getBoundingClientRect()
          page.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.9 }))
        })()`)
        await wait(400)
        await shot('44-page-menu')
        steps.push(`page menu: ${await js<string>("[...document.querySelectorAll('[role=menu] [role=menuitem], [role=menu] button')].map((b) => b.textContent.trim()).filter(Boolean).join(' | ')")}`)
        await click('Save page as PDF…')
        await wait(600)
        await shot('45-save-page-from-menu')
        steps.push(`savePages from menu: ${await js<boolean>("!!document.querySelector('[data-save-pages-dialog]')")}`)
        return
      }
      // An edit-only check (scripts/editcheck.mjs) goes straight to editing: no watermark or selection steps on the owner's file.
      if (process.env.POWERPDF_SMOKE_ONLY !== 'edit') {
      if (await clickIn('[data-global-bar]', labels.organize ?? 'Organize')) {
        await shot('03-organize')
        // Organize with checkboxes (§76): three pages ticked with the mouse alone, the bar counts them,
        // the page menu on one of them acts on all three (plural labels), arrows move in the menu.
        for (const p of [0, 1, 2]) await js(`document.querySelector('[data-organize-page="${p}"] [data-page-check]')?.click()`)
        await wait(400)
        await shot('03a-organize-selected')
        steps.push(`organize: ticked: ${await js<number>("document.querySelectorAll('[data-organize-page][data-selected]').length")}, bar: ${await js<string>("document.querySelector('[data-selection-count]')?.innerText ?? ''")}`)
        await js(`(() => {
          const el = document.querySelector('[data-organize-page="1"]')
          const r = el.getBoundingClientRect()
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 3 }))
        })()`)
        await wait(400)
        await shot('03c-organize-menu')
        steps.push(`organize menu: ${await js<string>("[...document.querySelectorAll('[data-context-menu] [role=menuitem]')].map((b) => b.textContent.trim() + (b.getAttribute('aria-disabled') ? ' (off)' : '')).join(' | ')")}`)
        steps.push(`organize: still 3 selected after right-click: ${await js<boolean>("document.querySelectorAll('[data-organize-page][data-selected]').length === 3")}`)
        await js("document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))")
        steps.push(`organize menu: focus after ArrowDown: ${await js<string>("document.activeElement?.getAttribute('data-menu-item') ?? ''")}`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await wait(200)
        steps.push(`organize: menu closed by Esc: ${await js<boolean>("!document.querySelector('[data-context-menu]')")}`)
        // The Delete pages… dialog from the bar's Actions, the field filled with the selection.
        await js("document.querySelector('[data-selection-actions]')?.click()")
        await wait(300)
        await js("document.querySelector('[data-context-menu] [data-menu-item=delete]')?.click()")
        await wait(500)
        await shot('03d-organize-delete-dialog')
        steps.push(`organize: delete dialog pages: ${await js<string>("document.querySelector('[data-pages-field]')?.value ?? 'none'")}`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await wait(200)
        await js("document.querySelector('[data-select-clear]')?.click()")
        await wait(200)
        steps.push(`organize: cleared: ${await js<boolean>("document.querySelectorAll('[data-organize-page][data-selected]').length === 0")}`)
      }
      if (await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) await wait(300)
      await shot('03b-all-tools')

      // Protect: the same password for opening and for the permissions is refused before applying.
      if (await clickIn('[data-all-tools]', labels.protect ?? 'Protect PDF')) {
        await wait(300)
        const fill = (index: number, value: string): Promise<unknown> =>
          js(`(() => {
            const input = document.querySelectorAll('[data-tool-panel] input[type=password]')[${index}]
            if (!input) return false
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
            input.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`)
        await fill(0, 'سر-2026')
        await fill(1, 'سر-2026')
        await js("document.querySelector('[data-tool-panel] button[aria-expanded]')?.click()")
        await wait(300)
        await fill(2, 'سر-2026')
        await shot('03e-protect-same-password')
        steps.push(`protect: same password blocks Protect: ${await js<boolean>("!!document.querySelector('[data-tool-footer] button[disabled]')")}`)
        await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')
        await wait(300)
      }

      // A tool, end to end: open it from the All tools panel, fill it in (the preview follows), apply.
      if (await clickIn('[data-all-tools]', labels.watermark ?? 'Add watermark')) {
        await js(`(() => {
          const area = document.querySelector('[data-tool-panel] textarea')
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          set.call(area, 'سري للغاية — CONFIDENTIAL 2026')
          area.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
        await wait(1500)
        await shot('04-watermark-form')
        steps.push(`watermark: live preview shown: ${await js<boolean>("!!document.querySelector('[data-live-preview] img')")}`)
        await clickIn('[data-tool-footer]', labels.applyWatermark ?? 'Add watermark')
        await wait(3000)
        await shot('05-watermark-applied')
        steps.push(`unsaved marker shown: ${(await js<number>("document.querySelectorAll('.bg-accent.rounded-full').length")) > 0}`)
      }

      // Edit mode: click a line on the first page, retype it, press Enter.
      // Select text with the select tool: drag across a body line; the mini toolbar appears.
      {
        const drag = (type: string, fx: number, target: 'layer' | 'window'): Promise<unknown> =>
          js(`(() => {
            const layer = document.querySelector('[data-page="0"] [data-select-layer]')
            if (!layer) return false
            const r = layer.getBoundingClientRect()
            const el = ${target === 'layer' ? 'layer' : 'window'}
            el.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, detail: 1, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * 0.214 }))
            return true
          })()`)
        await drag('mousedown', 0.06, 'layer')
        await drag('mousemove', 0.5, 'window')
        await drag('mousemove', 0.9, 'window')
        await wait(900)
        await drag('mouseup', 0.9, 'window')
        await wait(900)
        await shot('05b-text-selected')
        steps.push(`select: mini toolbar shown: ${await js<boolean>("!!document.querySelector('[data-selection-toolbar]')")}`)
        // Right-click on the selection: the context menu offers copy, marks and page commands.
        await js(`(() => {
          const layer = document.querySelector('[data-page="0"] [data-select-layer]')
          const r = layer.getBoundingClientRect()
          layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.214 }))
        })()`)
        await shot('05c-context-menu')
        steps.push(`context menu items: ${await js<number>("document.querySelectorAll('[data-context-menu] [role=menuitem]').length")}`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        // Right-click on the selection: the context menu with copy, highlight and the page commands.
        await js(`(() => {
          const layer = document.querySelector('[data-page="0"] [data-select-layer]')
          const r = layer.getBoundingClientRect()
          layer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.214 }))
        })()`)
        await wait(300)
        await shot('05c-context-menu')
        steps.push(`context menu: ${await js<number>("document.querySelectorAll('[data-context-menu] [role=menuitem]').length")} items`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
      }
      } // end of the steps an edit-only check skips

      if (await clickIn('[data-global-bar]', labels.edit ?? 'Edit')) {
        await wait(1500)
        await shot('05d-format-bar-idle')
        // Click the first block of text, type, then click outside it to apply — no Enter.
        // Press and release on a body line, as a person clicks (a drag would move it instead).
        // The page's paragraphs arrive from the worker; on a busy PC they can take longer than the wait above.
        for (let i = 0; i < 20 && !(await js<boolean>("!!document.querySelector('[data-page=\"0\"] button[data-para]')")); i++) await wait(300)
        const clicked = await js<boolean>(`(() => {
          const blocks = [...document.querySelectorAll('[data-page="0"] button[data-para]')]
          // A body line; on a page of small cells (a table), the widest block.
          const target = blocks.find((e) => {
            const r = e.getBoundingClientRect()
            return r.top > 160 && r.height < 40 && r.width > 150
          }) ?? blocks.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
          if (!target) return false
          const r = target.getBoundingClientRect()
          const at = { bubbles: true, button: 0, clientX: r.left + 10, clientY: r.top + r.height / 2 }
          target.dispatchEvent(new MouseEvent('mousedown', at))
          window.dispatchEvent(new MouseEvent('mouseup', at))
          return true
        })()`)
        await wait(300)
        steps.push(`edit: opened a paragraph: ${clicked && (await js<boolean>("!!document.querySelector('[data-page=\"0\"] [data-rich-editor]')"))}`)
        await wait(300)
        await wait(700)
        // Typing shows in the paragraph's own typeface (§66).
        steps.push(`edit: box typeface: ${await js<string>("(() => { const e = document.querySelector('[data-page=\"0\"] [data-rich-editor]'); const f = getComputedStyle(e).fontFamily; const first = f.split(',')[0].trim().replace(/['\"]/g, ''); const faces = [...document.fonts].filter((x) => x.family.replace(/['\"]/g, '') === first); return f.slice(0, 80) + ' / faces: ' + faces.map((x) => x.weight + ' ' + x.style + ' ' + x.status).join(', ') })()")}`)
        await shot('05e-own-typeface')
        // The editing surface (§65): its text replaced as typing would, through the browser's own command.
        const typeInto = (value: string): Promise<unknown> =>
          js(`(() => {
            const area = document.querySelector('[data-page="0"] [data-rich-editor]')
            if (!area) return false
            area.focus()
            const range = document.createRange()
            range.selectNodeContents(area)
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
            document.execCommand('insertText', false, ${JSON.stringify(value)})
            return true
          })()`)
        // Spelling (§67): misspelled words underlined; right-click one, take the first correction.
        await typeInto('We recieve the reprot — المدارسس الحكومية')
        await wait(900)
        steps.push(`edit: misspelled words underlined: ${await js<string>("(() => { const h = CSS.highlights.get('hono-spell'); return h ? [...h].map((r) => r.toString()).join(', ') : 'none' })()")}`)
        await shot('05f-spelling')
        const menuAt = await js<boolean>(`(() => {
          const h = CSS.highlights.get('hono-spell')
          const first = h ? [...h][0] : null
          if (!first) return false
          const r = first.getBoundingClientRect()
          document.querySelector('[data-page="0"] [data-rich-editor]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
          return true
        })()`)
        await wait(700)
        await shot('05g-spelling-menu')
        steps.push(`edit: spelling menu: ${menuAt && (await js<string>("[...document.querySelectorAll('[data-context-menu] [role=menuitem]')].map((b) => b.textContent.trim()).join(' | ')"))}`)
        await js("document.querySelector('[data-context-menu] [role=menuitem]')?.click()")
        await wait(900)
        steps.push(`edit: after taking the correction: ${await js<string>("document.querySelector('[data-page=\"0\"] [data-rich-editor]')?.textContent ?? 'box closed'")}; still underlined: ${await js<string>("(() => { const h = CSS.highlights.get('hono-spell'); return h ? [...h].map((r) => r.toString()).join(', ') : 'none' })()")}`)
        // "Add to dictionary" on the next one (the smoke run has its own data folder).
        await js(`(() => {
          const first = [...(CSS.highlights.get('hono-spell') ?? [])][0]
          if (!first) return
          const r = first.getBoundingClientRect()
          document.querySelector('[data-page="0"] [data-rich-editor]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
        })()`)
        await wait(700)
        await js(`[...document.querySelectorAll('[data-context-menu] [role=menuitem]')].find((b) => b.textContent.trim() === ${JSON.stringify(labels.spellAdd ?? 'Add to dictionary')})?.click()`)
        await wait(900)
        steps.push(`edit: underlined after adding a word: ${await js<string>("(() => { const h = CSS.highlights.get('hono-spell'); return h ? [...h].map((r) => r.toString()).join(', ') || 'none' : 'none' })()")}`)
        await typeInto('Edited in HonoKit — تم التعديل')
        // One word made bold: selected, then Ctrl+B — only it changes (§65).
        const selected = await js<boolean>(`(() => {
          const area = document.querySelector('[data-page="0"] [data-rich-editor]')
          const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.textContent.indexOf('HonoKit')
            if (at < 0) continue
            const range = document.createRange()
            range.setStart(n, at)
            range.setEnd(n, at + 7)
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)
            return true
          }
          return false
        })()`)
        await wait(200)
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control'] })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control'] })
        await wait(300)
        // Ctrl+B switches the word's weight: bold in a regular paragraph, regular in a bold one.
        steps.push(`edit: word selected: ${selected}, weight switched in the box: ${await js<boolean>("(() => { const root = document.querySelector('[data-page=\"0\"] [data-rich-editor]'); const heavy = (e) => Number(getComputedStyle(e).fontWeight) >= 600; return [...root.querySelectorAll('span')].some((e) => e.textContent.includes('HonoKit') && heavy(e) !== heavy(root)) })()")}`)
        // Caret at the end again, so the box-wide formatting below applies to the box.
        await js("(() => { const a = document.querySelector('[data-page=\"0\"] [data-rich-editor]'); const r = document.createRange(); r.selectNodeContents(a); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r) })()")
        await wait(200)
        await shot('06-edit-typing')
        // The format bar: open the typeface list, wait for the fonts on this PC, pick Arial.
        if (await clickIn('[data-format-bar]', labels.typeface ?? 'Typeface')) {
          await wait(1500)
          await shot('06b-typeface-list')
          // The paragraph's own font heads the list, with how an edit keeps it (§56); a missing one shows a chip.
          steps.push(`edit: own font row: ${await js<string>("document.querySelector('[data-select-list] [role=option]')?.textContent?.trim() ?? 'none'")}, missing-font chip: ${await js<boolean>("!!document.querySelector('[data-missing-font]')")}`)
          const fonts = await js<number>("document.querySelectorAll('[data-select-list] [role=option]').length")
          const picked = await js<boolean>(`(() => {
            const b = [...document.querySelectorAll('[data-select-list] [role=option]')].find((o) => o.textContent.trim() === 'Arial')
            if (!b) return false
            b.click()
            return true
          })()`)
          steps.push(`edit: typeface list ${fonts} entries, picked Arial: ${picked}`)
          await wait(200)
        }
        await clickIn('[data-format-bar]', labels.underline ?? 'Underline (Ctrl+U)')
        await wait(200)
        await shot('06c-format-bar')
        steps.push(`edit: format bar while typing: ${await js<boolean>("!!document.querySelector('[data-format-bar] button[aria-pressed=true]')")}, box still open: ${await js<boolean>("!!document.querySelector('[data-page=\"0\"] [data-rich-editor]')")}`)
        const clickOutside = "document.querySelector('header, .border-b')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))"
        await js(clickOutside)
        await wait(2500)
        await shot('07-edit-applied')
        steps.push(`edit: editor closed after clicking outside: ${!(await js<boolean>("!!document.querySelector('[data-page=\"0\"] [data-rich-editor]')"))}`)
        // The word's switched weight is in the document, the rest of the paragraph unchanged (§65).
        steps.push(`edit: word's weight kept in the document: ${await js<string>(`(async () => {
          const id = document.querySelector('[data-doc-id]')?.getAttribute('data-doc-id')
          const r = await window.api.pageParagraphs(id, 0)
          const p = r.ok ? r.value.find((x) => x.text.includes('HonoKit')) : null
          if (!p) return 'paragraph not found'
          const at = p.text.indexOf('HonoKit')
          const word = p.spans.some((s) => s.style.bold !== undefined && s.start <= at && s.end >= at + 7)
          const others = p.spans.filter((s) => s.style.bold !== undefined && !(s.start <= at && s.end >= at + 7)).length
          return word ? (others ? 'yes, but other words too' : 'yes') : 'no: ' + JSON.stringify(p.spans)
        })()`)}`)
        // The edit really landed: find the new words with the find box.
        await js(`(() => {
          const input = document.querySelector('[data-global-bar] input')
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set.call(input, 'Edited in HonoKit')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })()`)
        await wait(1500)
        steps.push(`edit: new text found by search: ${await js<string>("(document.querySelector('[data-global-bar]')?.innerText ?? '').match(/[0-9]+ (of|من) [0-9]+/)?.[0] ?? 'no'")}`)
        await js(`(() => {
          const input = document.querySelector('[data-global-bar] input')
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })()`)
        // An edit-only check on a real file the owner names (scripts/editcheck.mjs): stop here.
        if (process.env.POWERPDF_SMOKE_ONLY === 'edit') return

        // Click an empty spot near the bottom of the page and type new text.
        await js(`(() => {
          const layer = document.querySelector('[data-page="0"] > div.absolute.inset-0')
          const r = layer.getBoundingClientRect()
          layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + r.width * 0.12, clientY: r.top + r.height * 0.93 }))
        })()`)
        await wait(50)
        await js(`(() => {
          const layer = document.querySelector('[data-page="0"] > div.absolute.inset-0')
          const r = layer.getBoundingClientRect()
          layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.left + r.width * 0.12, clientY: r.top + r.height * 0.93 }))
        })()`)
        await wait(300)
        await typeInto('Added note — ملاحظة مضافة')
        await shot('08-add-typing')
        await js(clickOutside)
        await wait(2500)
        await shot('09-add-applied')

        // Drag the added note 60 px up, as a person would, and check it moved (it sits at the page foot).
        const before = await js<{ top: number; x: number; y: number } | null>(`(() => {
          const blocks = [...document.querySelectorAll('[data-page="0"] button[data-para]')]
          const b = blocks.sort((a, c) => c.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
          if (!b) return null
          const r = b.getBoundingClientRect()
          const x = r.left + r.width / 2, y = r.top + r.height / 2
          b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }))
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 20, clientY: y - 30 }))
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 20, clientY: y - 60 }))
          return { top: r.top, x, y }
        })()`)
        await js(`window.dispatchEvent(new MouseEvent('mouseup', { clientX: ${(before?.x ?? 0) + 20}, clientY: ${(before?.y ?? 0) - 60} }))`)
        await wait(80)
        await wait(2500)
        await shot('10-dragged')
        const moved = await js<boolean>(`(() => {
          const tops = [...document.querySelectorAll('[data-page="0"] button[data-para]')].map((b) => b.getBoundingClientRect().top)
          return tops.some((t) => Math.abs(t - (${before?.top ?? 0} - 60)) < 8)
        })()`)
        steps.push(`drag: block moved 60 px up: ${moved}`)

        // Draw a text box by dragging on an empty area, type a long sentence: it must wrap in the box.
        await js(`(() => {
          const layer = document.querySelector('[data-page="0"] > div.absolute.inset-0')
          const r = layer.getBoundingClientRect()
          const x0 = r.left + r.width * 0.55, y0 = r.top + r.height * 0.70, x1 = r.left + r.width * 0.85
          layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x0, clientY: y0 }))
        })()`)
        for (const type of ['mousemove', 'mouseup']) {
          await wait(50)
          await js(`(() => {
            const layer = document.querySelector('[data-page="0"] > div.absolute.inset-0')
            const r = layer.getBoundingClientRect()
            layer.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, clientX: r.left + r.width * 0.85, clientY: r.top + r.height * 0.70 + 40 }))
          })()`)
        }
        await wait(300)
        await typeInto('A drawn box wraps its words inside the width that was dragged out on the page, like a column.')
        await shot('10b-box-typing')
        await js(clickOutside)
        await wait(2500)
        await shot('10c-box-applied')

        // Where the first line of text is, for the highlighter later (paragraphs show only in the text tool).
        const firstText = await js<{ x0: number; x1: number; y: number } | null>(`(() => {
          // A visible body line: one line high, on screen, not the diagonal watermark.
          const b = [...document.querySelectorAll('[data-page="0"] button[data-para]')].find((e) => {
            const r = e.getBoundingClientRect()
            return r.top > 160 && r.bottom < innerHeight - 40 && r.height < 40 && r.width > 150
          })
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x0: r.left + 2, x1: r.right - 2, y: r.top + r.height / 2 }
        })()`)

        // Signature: draw one on the pad, place it with a click, then drag it.
        if (await clickIn('[data-quick-tools]', labels.signTool ?? 'Sign')) {
          await wait(400)
          await js(`(() => {
            const c = document.querySelector('[role=dialog] canvas')
            const r = c.getBoundingClientRect()
            const at = (fx, fy) => ({ bubbles: true, pointerId: 1, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy })
            c.dispatchEvent(new PointerEvent('pointerdown', at(0.15, 0.6)))
            for (let i = 1; i <= 40; i++) c.dispatchEvent(new PointerEvent('pointermove', at(0.15 + i * 0.018, 0.6 - Math.sin(i / 4) * 0.25)))
            c.dispatchEvent(new PointerEvent('pointerup', at(0.87, 0.5)))
          })()`)
          await shot('12a-signature-pad')
          await click(labels.placeSignature ?? 'Place signature')
          await wait(300)
          const placeAt = (type: string, fx: number, fy: number): Promise<unknown> =>
            js(`(() => {
              const layer = document.querySelector('[data-page="0"] [data-placing]')
              if (!layer) return false
              const r = layer.getBoundingClientRect()
              layer.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} }))
              return true
            })()`)
          await placeAt('mousemove', 0.7, 0.86)
          await shot('12b-signature-following')
          await placeAt('mousedown', 0.7, 0.86)
          await wait(30)
          await placeAt('mouseup', 0.7, 0.86)
          await wait(2500)
          await shot('12c-signature-placed')
          const selected = await js<{ x: number; y: number } | null>(`(() => {
            const s = document.querySelector('[data-page="0"] [data-selected-picture]')
            if (!s) return null
            const r = s.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          })()`)
          steps.push(`signature: placed and selected: ${!!selected}`)
          steps.push(`signature: ${await js<number>("document.querySelectorAll('[data-page=\"0\"] [data-handle]').length")} handles`)
          if (selected) {
            await js(`(() => {
              const s = document.querySelector('[data-page="0"] [data-selected-picture]')
              s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${selected.x}, clientY: ${selected.y} }))
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${selected.x - 20}, clientY: ${selected.y - 20} }))
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${selected.x - 80}, clientY: ${selected.y - 50} }))
            })()`)
            await shot('13a-signature-dragging')
            await js(`window.dispatchEvent(new MouseEvent('mouseup', { clientX: ${selected.x - 80}, clientY: ${selected.y - 50} }))`)
            await wait(2500)
            await shot('13b-signature-moved')
            const after = await js<{ x: number; y: number } | null>(`(() => {
              const s = document.querySelector('[data-page="0"] [data-selected-picture]')
              if (!s) return null
              const r = s.getBoundingClientRect()
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
            })()`)
            steps.push(`signature: moved by ${after ? `${Math.round(after.x - selected.x)}, ${Math.round(after.y - selected.y)}` : 'nothing (not reselected)'}`)
            await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
          }
        }

        // Markup: highlight the first line, draw a rectangle and a pen stroke.
        const onMarkupLayer = (type: string, x: number, y: number, target: 'layer' | 'window'): Promise<unknown> =>
          js(`(() => {
            const layer = document.querySelector('[data-page="0"] [data-markup-layer]')
            if (!layer) return false
            const el = ${target === 'layer' ? 'layer' : 'window'}
            el.dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0, clientX: ${x}, clientY: ${y} }))
            return true
          })()`)
        const pageRect = (): Promise<{ left: number; top: number; width: number; height: number }> =>
          js(`(() => { const r = document.querySelector('[data-page="0"]').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
        const pageTop = (): Promise<number> => js<number>(`document.querySelector('[data-page="0"]').getBoundingClientRect().top`)
        const topBefore = await pageTop()
        if (firstText && (await clickIn('[data-quick-tools]', labels.highlightTool ?? 'Highlight'))) {
          await wait(800)
          // The tool's options can make the bar taller, moving the page down.
          firstText.y += (await pageTop()) - topBefore
          await onMarkupLayer('mousedown', firstText.x0, firstText.y, 'layer')
          await onMarkupLayer('mousemove', (firstText.x0 + firstText.x1) / 2, firstText.y, 'window')
          await onMarkupLayer('mousemove', firstText.x1, firstText.y, 'window')
          await shot('14a-highlighting')
          await onMarkupLayer('mouseup', firstText.x1, firstText.y, 'window')
          await wait(2500)
          await shot('14b-highlighted')
        }
        // Draw ▾: pick Pen, click it again to open its flyout, choose Rectangle.
        const pen = labels.penTool ?? 'Pen'
        const rect = labels.rect ?? 'Rectangle'
        if ((await clickIn('[data-quick-tools]', pen)) && (await clickIn('[data-quick-tools]', pen)) && (await clickIn('[data-quick-tools]', rect))) {
          await wait(500)
          const r = await pageRect()
          const x0 = r.left + r.width * 0.1
          const y0 = r.top + r.height * 0.55
          await onMarkupLayer('mousedown', x0, y0, 'layer')
          await onMarkupLayer('mousemove', x0 + 60, y0 + 30, 'window')
          await onMarkupLayer('mousemove', x0 + 140, y0 + 70, 'window')
          await onMarkupLayer('mouseup', x0 + 140, y0 + 70, 'window')
          await wait(2500)
        }
        // The Draw button now shows Rectangle; open its flyout again and go back to Pen.
        if ((await clickIn('[data-quick-tools]', rect)) && (await clickIn('[data-quick-tools]', pen))) {
          await wait(500)
          const r = await pageRect()
          const x0 = r.left + r.width * 0.45
          const y0 = r.top + r.height * 0.6
          await onMarkupLayer('mousedown', x0, y0, 'layer')
          for (let i = 1; i <= 20; i++) await onMarkupLayer('mousemove', x0 + i * 6, y0 + (i % 2 ? 12 : -12), 'window')
          await onMarkupLayer('mouseup', x0 + 120, y0, 'window')
          await wait(2500)
          await shot('15-shapes-and-pen')
        }
        // Add a comment: click an empty spot, type in the comment card, Post.
        if (await clickIn('[data-quick-tools]', labels.addComment ?? 'Add a comment')) {
          await wait(500)
          const r = await pageRect()
          const x = r.left + r.width * 0.8
          const y = r.top + r.height * 0.45
          await onMarkupLayer('mousedown', x, y, 'layer')
          await onMarkupLayer('mouseup', x, y, 'window')
          await wait(300)
          await js(`(() => {
            const area = document.querySelector('[data-comment-editor] textarea')
            if (!area) return false
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            set.call(area, 'Check this total — راجع المجموع')
            area.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`)
          await shot('15b-comment-card')
          await clickIn('[data-comment-editor]', labels.post ?? 'Post')
          await wait(2500)
          const marks = await js<number>(`document.querySelectorAll('[data-page="0"] [data-markup-layer] .outline-dotted').length`)
          steps.push(`markup: ${marks} pieces on page 1 (want 4: highlight, rectangle, pen, comment)`)
          await clickIn('[data-right-rail]', labels.comments ?? 'Comments')
          await wait(1500)
        }
        // The quick tools dragged to the far side stay in view when the window is made narrower (§92).
        {
          const card = "document.querySelector('[data-quick-tools]')"
          const area = `${card}.parentElement.offsetParent`
          const moved = await js<boolean>(`(() => {
            const grip = ${card}?.querySelector('button')
            if (!grip) return false
            const g = grip.getBoundingClientRect()
            const a = ${area}.getBoundingClientRect()
            const from = { bubbles: true, button: 0, clientX: g.left + g.width / 2, clientY: g.top + g.height / 2 }
            const to = { bubbles: true, button: 0, clientX: a.right - 12, clientY: from.clientY + 40 }
            grip.dispatchEvent(new MouseEvent('mousedown', from))
            window.dispatchEvent(new MouseEvent('mousemove', to))
            window.dispatchEvent(new MouseEvent('mouseup', to))
            return true
          })()`)
          await wait(300)
          const { width: w, height: h } = window.getBounds()
          window.setSize(Math.round(w * 0.6), h)
          await wait(1000)
          const inView = await js<string>(`(() => {
            const c = ${card}.getBoundingClientRect()
            const a = ${area}.getBoundingClientRect()
            return c.left >= a.left && c.right <= a.right && c.top >= a.top && c.bottom <= a.bottom ? 'yes' : 'NO ' + JSON.stringify({ card: c, area: a })
          })()`)
          steps.push(`quick tools: dragged to the far side ${moved}; in view after the window was narrowed: ${inView}`)
          await shot('15c-quick-tools-narrow')
          window.setSize(w, h)
          await wait(1000)
          await js(`${card}?.querySelector('button')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
          await wait(300)
        }
        // A stamp chosen in the panel, placed with a click; then a text box dragged out and typed in.
        if (await clickIn('[data-tool-panel]', labels.stamp ?? 'Stamp')) {
          await wait(500)
          const r = await pageRect()
          const x = r.left + r.width * 0.7
          const y = r.top + r.height * 0.72
          await onMarkupLayer('mousemove', x, y, 'layer')
          await wait(200)
          await shot('15c-stamp-palette')
          await onMarkupLayer('mousedown', x, y, 'layer')
          await onMarkupLayer('mouseup', x, y, 'window')
          await wait(2500)
        }
        if (await clickIn('[data-tool-panel]', labels.textbox ?? 'Add text box')) {
          await wait(400)
          const r = await pageRect()
          const x = r.left + r.width * 0.08
          const y = r.top + r.height * 0.8
          await onMarkupLayer('mousedown', x, y, 'layer')
          await onMarkupLayer('mousemove', x + r.width * 0.35, y + 30, 'window')
          await onMarkupLayer('mouseup', x + r.width * 0.35, y + 30, 'window')
          await wait(300)
          await js(`(() => {
            const area = document.querySelector('[data-comment-editor] textarea')
            if (!area) return false
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            set.call(area, 'A text box wraps its words — مربع نص يلتف فيه الكلام')
            area.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`)
          await clickIn('[data-comment-editor]', labels.post ?? 'Post')
          await wait(2500)
          await shot('15d-stamp-and-textbox')
          steps.push(`stamp and text box: ${await js<number>(`document.querySelectorAll('[data-page="0"] [data-markup-layer] .outline-dotted').length`)} pieces on page 1 (want 6)`)
        }
        await shot('16-comments-panel')
        // The reply on page 3 to the comment on page 2, and its review state, under that comment (§82).
        await js("document.querySelector('[data-comment-replies]')?.scrollIntoView({ block: 'center' })")
        await shot('16b-comments-replies')
        steps.push(`comments: replies under their comment ${await js<number>("document.querySelectorAll('[data-comment-replies] li').length")} (want 1), review states ${await js<number>("document.querySelectorAll('[data-review-states] span').length")} (want 1)`)
        await clickIn('[data-quick-tools]', labels.quickEdit ?? 'Edit text and pictures')
      }

      // Combine files: its own full-window view, the open document as the first tile.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.merge ?? 'Merge PDF'))) {
        await wait(1500)
        await shot('17-combine')
        steps.push(`combine: ${await js<number>("document.querySelectorAll('[data-combine-tile]').length")} tile(s) shown`)
        await clickIn('[data-combine]', labels.cancel ?? 'Cancel')
        await wait(300)
      }

      // Header & footer: the panel with its default footer and the live preview, not applied.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.headerFooter ?? 'Header & footer'))) {
        await wait(2500)
        await shot('27-header-footer')
        steps.push(`header & footer preview: ${await js<boolean>("!!document.querySelector('[data-live-preview] img[src]')")}`)
        const wide = await js<string>(`(() => {
          const body = document.querySelector('[data-tool-panel] .overflow-y-auto')
          if (!body) return 'no panel'
          const over = [...body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > body.getBoundingClientRect().right + 1 || el.getBoundingClientRect().left < body.getBoundingClientRect().left - 1)
          return body.scrollWidth > body.clientWidth + 1 ? 'overflows: ' + over.slice(0, 3).map((el) => el.tagName + '.' + String(el.className).slice(0, 40)).join(' | ') : 'fits'
        })()`)
        steps.push(`header & footer panel width: ${wide}`)
        await js("document.querySelector('[data-tool-footer] button')?.click()")
        await wait(300)
      }

      // Convert: the Convert tab, then Word and PowerPoint files written (smoke mode saves into its own folder).
      if (await clickIn('[data-global-bar]', labels.convert ?? 'Convert')) {
        await wait(800)
        await shot('28-convert')
        for (const format of ['docx', 'xlsx', 'pptx', 'md']) {
          await js(`document.querySelectorAll('[data-convert-formats] button[role=radio]')[${['docx', 'xlsx', 'pptx', 'md', 'txt'].indexOf(format)}]?.click()`)
          await wait(200)
          await js("document.querySelector('[data-tool-footer] button.bg-accent')?.click()")
          await wait(4000)
          const file = join(out, `sample.${format}`)
          steps.push(`convert ${format}: ${existsSync(file) ? `${statSync(file).size} bytes` : 'missing'}`)
        }
        await js("document.querySelector('[data-tool-footer] button')?.click()")
        await wait(300)
      }

      // Prepare a form: draw a text field on page 1; it is outlined with its name.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.prepareForm ?? 'Prepare a form'))) {
        await wait(900)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))")
        await wait(800)
        const drawn = await js<boolean>(`(() => {
          const layer = document.querySelector('[data-page="0"] [data-field-layer]')
          if (!layer) return false
          const r = layer.getBoundingClientRect()
          const x = r.left + r.width * 0.55, y = r.top + r.height * 0.9
          layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }))
          window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 120, clientY: y + 20 }))
          window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + 120, clientY: y + 20 }))
          return true
        })()`)
        await wait(2000)
        await shot('31-prepare-form')
        steps.push(`prepare form: drew ${drawn}, fields listed ${await js<number>("document.querySelectorAll('[data-prepare-fields] li').length")}`)
        await js("document.querySelector('[data-tool-panel] header button:last-child')?.click()")
        await wait(300)
      }

      // Format all text: the panel and its preview (120 %), not applied.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.formatText ?? 'Format all text'))) {
        await wait(2500)
        await shot('26-format-all-text')
        await js("document.querySelector('[data-tool-footer] button')?.click()")
        await wait(300)
      }

      // Forms: the message bar, then the last page's fields filled in (Arabic text and a checkbox).
      steps.push(`forms: bar ${await js<boolean>("!!document.querySelector('[data-form-bar]')")}`)
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))")
      await wait(1800)
      // Typed and saved with Ctrl+S without leaving the field (§82): the save must
      // include the typed text, and leave the document clean.
      const typedAt = Date.now()
      const filled = await js<boolean>(`(() => {
        const input = document.querySelector('[data-page="5"] [data-form-layer] input')
        if (!input) return false
        input.focus()
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'أحمد علي — Ahmed Ali')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
        return true
      })()`)
      await wait(3000)
      const typedSave = await js<{ value: string; dirty: boolean }>(`(async () => {
        const id = document.querySelector('[data-doc-id]')?.getAttribute('data-doc-id')
        const r = await window.api.formFields(id, 5)
        const field = r.ok ? r.value.find((f) => f.name === 'name') : null
        const tab = [...document.querySelectorAll('button[data-tab]')].find((b) => b.parentElement.classList.contains('font-medium'))
        return { value: field ? field.value : 'missing', dirty: !!tab?.parentElement.querySelector('.bg-accent.rounded-full') }
      })()`)
      steps.push(`forms: typed then Ctrl+S in the field: value in document "${typedSave.value}", unsaved after save: ${typedSave.dirty}`)
      await shot('25a-form-typed-saved')
      // The copy that save wrote beside the sample is not kept.
      try {
        const { readdirSync } = await import('node:fs')
        const { dirname: dir } = await import('node:path')
        for (const name of readdirSync(dir(file))) if (/^sample \(edited( \d+)?\)\.pdf$/.test(name) && statSync(join(dir(file), name)).mtimeMs >= typedAt - 1000) rmSync(join(dir(file), name), { force: true })
      } catch {
        /* nothing to tidy */
      }
      // Typed, then the window's close button without leaving the field (§83): the typing is
      // committed first, so the unsaved dialog asks (Cancel keeps the window and the typing).
      await js(`(() => {
        const input = document.querySelector('[data-page="5"] [data-form-layer] input')
        if (!input) return
        input.focus()
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(input, 'Typed before closing')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await wait(400)
      window.close()
      await wait(2000)
      const typedClose = await js<{ dialog: boolean; value: string }>(`(async () => {
        const id = document.querySelector('[data-doc-id]')?.getAttribute('data-doc-id')
        const r = await window.api.formFields(id, 5)
        const field = r.ok ? r.value.find((f) => f.name === 'name') : null
        return { dialog: !!document.querySelector('[data-unsaved-dialog]'), value: field ? field.value : 'missing' }
      })()`)
      steps.push(`forms: typed then the window closed: unsaved dialog ${typedClose.dialog}, value in document "${typedClose.value}"`)
      await shot('25b-form-typed-close')
      await clickIn('[role=dialog]', labels.cancel ?? 'Cancel')
      await wait(300)
      await js(`document.querySelector('[data-page="5"] [data-form-layer] button[role=checkbox]')?.click()`)
      await wait(2000)
      await shot('25-form-filled')
      steps.push(`forms: text filled ${filled}, checkbox now ${await js<string>(`document.querySelector('[data-page="5"] [data-form-layer] button[role=checkbox]')?.getAttribute('aria-checked') ?? 'missing'`)}`)

      // Compare: the edited document against a text (the pasted first lines, one word changed).
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.compare ?? 'Compare'))) {
        await wait(800)
        await js(`(() => {
          const side = document.querySelectorAll('[data-compare-side]')[1]
          const tab = [...side.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(labels.compareText ?? 'Text')})
          tab?.click()
        })()`)
        await wait(300)
        await js(`(() => {
          const area = document.querySelector('[data-compare-text]')
          if (!area) return false
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          set.call(area, 'Edited in HonoKit — تم التعديل\\nLine 1: The quick brown fox jumps over the lazy cat. Invoice total 1,000 AED.\\nLine 2: The quick brown fox jumps over the lazy dog. Invoice total 1,037 AED.\\nLine 3: A new line was added here.')
          area.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await wait(300)
        await shot('23a-compare-setup')
        await clickIn('[data-compare] header', labels.actCompare ?? 'Compare')
        await wait(3000)
        await shot('23b-compare-results')
        steps.push(`compare: ${await js<number>("document.querySelectorAll('[data-compare-list] li').length")} changes listed`)
        await clickIn('[data-compare] header', labels.close ?? 'Close')
        await wait(300)
      }

      // Redact: find a word, mark what was found, apply (confirmed), and the marks are gone.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.redact ?? 'Redact'))) {
        await wait(800)
        await js(`(() => {
          const area = document.querySelector('[data-tool-panel] textarea')
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          set.call(area, 'fox')
          area.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
        await wait(200)
        await clickIn('[data-tool-panel]', labels.redactFind ?? 'Find')
        await wait(1200)
        await shot('24a-redact-found')
        await js(`(() => { const b = [...document.querySelectorAll('[data-redact-results] button')].pop(); b?.click() })()`)
        await wait(2500)
        await shot('24b-redact-marked')
        const marked = await js<string>("document.querySelector('[data-redact-count]')?.getAttribute('data-redact-count') ?? '0'")
        await clickIn('[data-tool-footer]', labels.actRedact ?? 'Apply redactions')
        await wait(500)
        await shot('24c-redact-confirm')
        await clickIn('[role=dialog]', labels.actRedact ?? 'Apply redactions')
        await wait(3000)
        await shot('24d-redact-applied')
        steps.push(`redact: ${marked} marks, after applying ${await js<string>("document.querySelector('[data-redact-count]')?.getAttribute('data-redact-count') ?? '?'")} left`)
      }

      // Sign with a digital ID, through the dialog: create an ID (Arabic name), sign, and the bar says it is valid.
      if (await clickIn('[data-global-bar]', labels.sign ?? 'Sign')) {
        await wait(600)
        const certLabel = labels.certSign ?? 'Sign with a digital ID'
        if (await js<boolean>(`(() => { const b = [...document.querySelectorAll('[data-tool-panel] button')].find((x) => x.querySelector('span span')?.textContent === ${JSON.stringify(certLabel)}); b?.click(); return !!b })()`)) {
          await wait(600)
          await js(`(() => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            const inputs = [...document.querySelectorAll('[data-create-id] input')]
            const put = (el, v) => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
            put(inputs[0], 'أحمد علي')
            put(inputs[3], 'smoke-pass')
            put(inputs[4], 'smoke-pass')
          })()`)
          await wait(300)
          await shot('29a-digital-id-create')
          await js("[...document.querySelectorAll('[data-create-id] button')].pop()?.click()")
          await wait(2500)
          await shot('29b-digital-id-sign')
          await js("[...document.querySelectorAll('[role=dialog] button')].pop()?.click()")
          await wait(3000)
          await shot('29c-signed')
          steps.push(`digital signature: bar ${await js<string>("document.querySelector('[data-signature-bar]')?.textContent ?? 'missing'")}`)
        }
      }

      // Recognize text: the native recognition runtime inside the worker, on a generated scan.
      {
        const scanPath = join(out, '..', 'sample-scan.pdf')
        const started = Date.now()
        const r = await js<{ ok: boolean; value?: { note?: { key: string; values?: Record<string, number> } }; error?: { message: string } }>(`(async () => {
          const doc = await window.api.open(${JSON.stringify(scanPath)})
          if (!doc.ok) return doc
          const done = await window.api.apply(doc.value.id, { op: 'ocr' })
          if (done.ok) {
            const text = await window.api.pageText(doc.value.id, 0)
            done.value.note = { ...(done.value.note ?? { key: '' }), values: { ...(done.value.note?.values ?? {}), found: text.ok && text.value.some((l) => /quick brown fox/i.test(l.text)) ? 1 : 0 } }
          }
          await window.api.close(doc.value.id)
          return done
        })()`)
        steps.push(`recognize text: ${r.ok ? `${JSON.stringify(r.value?.note)} in ${Date.now() - started} ms` : 'failed: ' + r.error?.message}`)
      }

      // Create PDF: a Word file and a web page (made by scripts/smoke.mjs) become PDFs.
      {
        const files = [join(out, '..', 'sample-create.docx'), join(out, '..', 'sample-create.html')]
        const r = await js<{ ok: boolean; value?: { docs: Array<{ pages: unknown[]; name: string }>; methods: string[] }; error?: { message: string } }>(`window.api.createPdf(${JSON.stringify(files)}, false)`)
        steps.push(`create pdf: ${r.ok ? r.value!.docs.map((d) => `${d.name} ${d.pages.length} page(s)`).join(', ') + ' via ' + r.value!.methods.join('/') : 'failed: ' + r.error?.message}`)
      }

      // Batch: the sample through compress, then the result beside it.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.batch ?? 'Batch (workflows)'))) {
        await wait(600)
        const input = join(out, '..', 'sample-scan.pdf')
        await js(`window.dispatchEvent(new CustomEvent('powerpdf:batch-add', { detail: [${JSON.stringify(input)}] }))`)
        await wait(300)
        await shot('30a-batch')
        await js("document.querySelector('[data-batch] header button.bg-accent')?.click()")
        await wait(6000)
        await shot('30b-batch-done')
        const made = join(out, '..', 'sample-scan-done.pdf')
        steps.push(`batch: ${existsSync(made) ? 'sample-scan-done.pdf written' : 'no result'}`)
        rmSync(made, { force: true })
        await clickIn('[data-batch] header', labels.close ?? 'Close')
        await wait(300)
      }

      // Share: open the menu only (its actions open real Windows windows).
      if (await js<boolean>("(() => { const b = document.querySelector('[data-share-button]'); b?.click(); return !!b })()")) {
        await wait(1500)
        await shot('19-share-menu')
        steps.push(`share: menu with ${await js<number>("document.querySelectorAll('[data-share-menu] [role=menuitem]').length")} items, file ready: ${await js<boolean>("!!document.querySelector('[data-share-drag][draggable=true]')")}`)
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await wait(200)
      }

      // Images to PDF: its own view; this run's own screenshots serve as the pictures.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.imagesToPdf ?? 'Images to PDF'))) {
        await wait(600)
        await shot('18a-images-empty')
        const pictures = ['01-home.png', '02-view.png', '03-organize.png'].map((n) => join(out, n))
        await js(`window.dispatchEvent(new CustomEvent('powerpdf:images-add', { detail: ${JSON.stringify(pictures)} }))`)
        await wait(1500)
        await js(`(() => {
          const card = document.querySelector('[data-image-card]')
          const turn = card && [...card.querySelectorAll('button')][1]
          turn?.click()
        })()`)
        await wait(400)
        await shot('18b-images')
        steps.push(`images: ${await js<number>("document.querySelectorAll('[data-image-card] img').length")} thumbnails`)
        await clickIn('[data-images-view] header', labels.cancel ?? 'Cancel')
        await wait(300)
      }

      // A web link on page 1 asks before it opens (§81): the dialog, then Cancel (nothing opens).
      {
        const clicked = await js<boolean>(`(() => {
          const layer = document.querySelector('[data-page="0"] [data-select-layer]')
          if (!layer) return false
          const r = layer.getBoundingClientRect()
          const scale = r.width / 612
          const x = r.left + 120 * scale
          const y = r.top + (792 - 41) * scale
          const opts = { bubbles: true, clientX: x, clientY: y, button: 0, detail: 1 }
          layer.dispatchEvent(new MouseEvent('mousedown', opts))
          window.dispatchEvent(new MouseEvent('mouseup', opts))
          return true
        })()`)
        await wait(600)
        const asked = await js<boolean>("!!document.querySelector('[data-link-address]')")
        steps.push(`web link: clicked ${clicked}, asked first ${asked}`)
        if (asked) {
          await shot('35-link')
          await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
          await wait(300)
        }
      }

      // Crop: the box on the page, with the dimmed parts to be cut away.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.crop ?? 'Crop pages'))) {
        await wait(1500)
        await shot('20-crop')
        steps.push(`crop: box on the page: ${await js<boolean>("!!document.querySelector('[data-crop-overlay]')")}`)
        if (await clickIn('[data-tool-panel]', labels.choosePages ?? 'Choose pages…')) {
          await wait(1200)
          await shot('20b-page-picker')
          steps.push(`page picker: ${await js<number>("document.querySelectorAll('[role=dialog] img').length")} thumbnails`)
          await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
          await wait(300)
        }
      }

      // Document info lists the fonts the file uses and whether an edit keeps each (§56).
      if (await clickIn('[data-right-rail]', labels.info ?? 'Document info')) {
        await wait(1500)
        await shot('32-document-fonts')
        steps.push(`document fonts: ${await js<number>("document.querySelectorAll('[data-document-fonts] > div').length")} listed`)
        await clickIn('[data-right-rail]', labels.info ?? 'Document info')
        await wait(200)
      }

      // Bookmarks panel: the sample has none, so its empty state.
      if (await clickIn('[data-right-rail]', labels.bookmarks ?? 'Bookmarks')) {
        await wait(800)
        await shot('33-bookmarks')
        await clickIn('[data-right-rail]', labels.bookmarks ?? 'Bookmarks')
        await wait(200)
      }

      // Find & Replace: the match is scrolled into view, not the page top (V1).
      if (await clickIn('[data-right-rail]', labels.search ?? 'Find & Replace')) {
        await wait(500)
        await js(`(() => {
          const input = document.querySelector('[data-find-input]')
          if (!input) return false
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          set.call(input, 'lazy dog. Invoice total 1,185')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          return true
        })()`)
        await wait(2000)
        await shot('34-find')
        await clickIn('[data-right-rail]', labels.search ?? 'Find & Replace')
        await wait(200)
      }

      // Split: its choices stack when the panel is too narrow for them side by side.
      if ((await clickIn('[data-global-bar]', labels.allTools ?? 'All tools')) && (await clickIn('[data-all-tools]', labels.split ?? 'Split PDF'))) {
        await wait(800)
        await shot('21-split')
      }

      if (await click(labels.settings ?? 'Settings')) {
        await shot('11-settings')
        if (await clickIn('[data-settings] nav', labels.appearance ?? 'Appearance')) await shot('11b-settings-appearance')
        if (await clickIn('[data-settings] nav', labels.saving ?? 'Saving')) {
          await shot('11d-settings-saving')
          // Where copies go: its choices name a folder and show its path underneath, so each row
          // is two lines. The open menu must stay inside the window and must not cover the
          // control it belongs to, whichever side it lands on.
          const menu = await js<{ fits: boolean; clear: boolean; where: string } | null>(`(async () => {
            const button = document.querySelector('[data-settings] [aria-haspopup=listbox]')
            if (!button) return null
            button.click()
            await new Promise((r) => setTimeout(r, 300))
            const list = document.querySelector('[data-select-list]')
            if (!list) return null
            const m = list.getBoundingClientRect()
            const b = button.getBoundingClientRect()
            return {
              fits: m.top >= 0 && m.bottom <= window.innerHeight && m.left >= 0 && m.right <= window.innerWidth,
              clear: m.bottom <= b.top + 1 || m.top >= b.bottom - 1,
              where: 'menu ' + Math.round(m.top) + '–' + Math.round(m.bottom) + ', control ' + Math.round(b.top) + '–' + Math.round(b.bottom) + ', window ' + window.innerHeight
            }
          })()`)
          if (!menu) errors.push('saving: the folder choices did not open')
          else {
            if (!menu.fits) errors.push(`saving: the folder choices are off the window (${menu.where})`)
            if (!menu.clear) errors.push(`saving: the folder choices cover the control they belong to (${menu.where})`)
            await shot('11d2-settings-folder-choices')
            await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
            await wait(200)
          }
        }
        if (await clickIn('[data-settings] nav', labels.places ?? 'Storage places')) {
          await wait(600)
          await shot('11e-settings-places')
        }
        if (await clickIn('[data-settings] nav', labels.about ?? 'About')) {
          await shot('11c-settings-about')
          // Open download page, Report a problem and Source code (§84), each fully shown.
          const links = (await js("[...document.querySelectorAll('[data-about-links] button')].map((b) => b.scrollWidth <= b.clientWidth + 1)")) as boolean[]
          if (links.length !== 3 || links.includes(false)) errors.push(`About: expected 3 link buttons, fully shown; got ${JSON.stringify(links)}`)
        }
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        await wait(300)
      }

      // Closing the edited document asks in the app's own dialog; Cancel keeps it open.
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }))")
      await wait(600)
      await shot('22-unsaved')
      steps.push(`unsaved dialog: ${await js<boolean>("!!document.querySelector('[data-unsaved-dialog]')")}`)
      await clickIn('[role=dialog]', labels.cancel ?? 'Cancel')
      await wait(300)

      // Home › Recent on two tabs, PDFs and Images (§83): a picture opened here lands on Images;
      // the tab chosen is kept in the settings.
      openFiles([join(out, '01-home.png')])
      await wait(2500)
      await js("document.querySelector('[data-home-button]')?.click()")
      await wait(400)
      await js("document.querySelector('[data-nav=recent]')?.click()")
      await wait(300)
      await js("document.querySelector('[data-recent-tab=pdf]')?.click()")
      await wait(500)
      await js("document.querySelector('[data-recent]')?.scrollIntoView({ block: 'start' })")
      await shot('36a-recent-pdfs')
      const rows = (): Promise<string> => js<string>("[...document.querySelectorAll('[data-recent] [data-recent-kind]')].map((b) => b.getAttribute('data-recent-kind')).join(',') || 'none'")
      steps.push(`recent: PDFs tab lists ${await rows()}`)
      await js("document.querySelector('[data-recent-tab=image]')?.click()")
      await wait(500)
      await js("document.querySelector('[data-recent]')?.scrollIntoView({ block: 'start' })")
      await shot('36b-recent-images')
      steps.push(`recent: Images tab lists ${await rows()}, selected ${await js<string>("document.querySelector('[data-recent-tab][aria-selected=true]')?.getAttribute('data-recent-tab') ?? 'none'")}, kept ${await js<string>('window.api.getSettings().then((s) => s.recentTab)')}`)
      // Clear empties only the tab shown; the PDFs stay.
      await js("document.querySelector('[data-recent] h2 + button')?.click()")
      await wait(500)
      await shot('36c-recent-images-empty')
      steps.push(`recent: after Clear on Images: empty ${await js<boolean>("!!document.querySelector('[data-recent-empty]')")}, PDFs left ${await js<number>("window.api.getSettings().then((s) => s.recent.filter((p) => p.toLowerCase().endsWith('.pdf')).length)")}`)
      await js("document.querySelector('[data-recent-tab=pdf]')?.click()")
      await wait(300)
    }
    steps.push(`visible text sample: ${(await text()).slice(0, 300).replace(/\s+/g, ' ')}`)
  } catch (error) {
    errors.push(`smoke script: ${(error as Error).stack ?? error}`)
  } finally {
    writeFileSync(join(out, 'report.json'), JSON.stringify({ version: app.getVersion(), steps, errors }, null, 2))
    app.exit(errors.some((e) => e.startsWith('error') || e.startsWith('smoke') || e.startsWith('renderer')) ? 1 : 0)
  }
}

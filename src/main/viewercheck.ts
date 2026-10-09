import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reader, the picture viewer and the two hubs (decisions §75), driven through the real window
 * by scripts/smoke.mjs. The app is started as Explorer starts it: the files are on its command line
 * (`HonoKit.exe file.pdf picture.jpg`, or with `--edit` for "Edit with HonoKit").
 *   open  a real PDF and a picture: the picture viewer (previous/next over pictures of many formats,
 *         Tools, Edit and back), the reader (Edit, Read), Home's hubs, then more real PDFs.
 *   edit  the same with --edit: the Photo editor and the PDF editor straight away.
 */
export async function runViewerCheck(window: BrowserWindow, out: string, steps: string[], openFiles: (paths: string[]) => void): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>
  const shot = async (name: string): Promise<void> => {
    await wait(450)
    const image = await window.webContents.capturePage()
    writeFileSync(join(out, `${name}.png`), image.toPNG())
    steps.push(`shot ${name}`)
  }
  const until = async (test: string, ms = 30_000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await js<boolean>(`!!(${test})`)) return true
      await wait(150)
    }
    return false
  }
  const has = (selector: string): Promise<boolean> => js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  const press = (selector: string): Promise<boolean> => js<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
  const key = (k: string, extra = ''): Promise<unknown> => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true${extra} }))`)
  const pictureLoaded = "(() => { const i = document.querySelector('[data-picture-image=full]'); return i && i.complete && i.naturalWidth > 0 })()"
  // The pages in view have drawn (pages further down load as they come into view), none broken.
  const pagesLoaded = "(() => { const imgs = [...document.querySelectorAll('img')].filter((i) => i.src.startsWith('pdfpage:')); return imgs.some((i) => i.complete && i.naturalWidth > 0) && !imgs.some((i) => i.complete && i.naturalWidth === 0) })()"
  const textOf = (selector: string): Promise<string> => js<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`)
  const rtl = await js<boolean>("document.documentElement.dir === 'rtl'")
  const mode = process.env.POWERPDF_VIEWER_MODE === 'edit' ? 'edit' : 'open'
  const morePdfs = JSON.parse(process.env.POWERPDF_VIEWER_PDFS ?? '[]') as string[]

  steps.push(`tabs opened from the command line: ${await until("document.querySelectorAll('[data-tab]').length >= 2")}`)

  if (mode === 'edit') {
    // "Edit with HonoKit": the picture in the Photo editor, the PDF in the editor.
    steps.push(`edit: photo editor shown: ${await until("document.querySelector('[data-photo-editor] canvas')")}`)
    await shot('e-01-photo-editor')
    await press('[data-photo-editor] [data-tool-close]')
    steps.push(`edit: closing comes back to the picture: ${await until(pictureLoaded)}`)
    await shot('e-02-back-to-picture')
    await press('[data-tab=pdf]')
    steps.push(`edit: PDF in the editor: ${await until("document.querySelector('[data-global-bar]') && !document.querySelector('[data-read-bar]')")}`)
    steps.push(`edit: tool panel shown: ${await has('[data-tool-panel]')}`)
    await until(pagesLoaded)
    await shot('e-03-pdf-editor')
    return
  }

  // 1. The picture viewer: the last file on the command line is in front.
  steps.push(`picture viewer shown: ${await until(pictureLoaded)}`)
  steps.push(`picture: ${await textOf('[data-picture-position]')} — ${await textOf('[data-picture-facts]')}`)
  await shot('v-01-picture-viewer')
  // Every picture in the folder, by the arrow key (mirrored in Arabic).
  const count = Number((await textOf('[data-picture-position]')).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).split(/\D+/).filter(Boolean).pop() ?? 1)
  for (let i = 1; i < count; i++) {
    const before = await textOf('[data-picture-position]')
    await key(rtl ? 'ArrowLeft' : 'ArrowRight')
    await until(`document.querySelector('[data-picture-position]')?.textContent?.trim() !== ${JSON.stringify(before)}`, 5000)
    const ok = await until(pictureLoaded, 60_000)
    const name = await js<string>("document.querySelector('[data-tab=picture]') && [...document.querySelectorAll('[data-tab=picture]')].map((b) => b.textContent.trim()).join(',')")
    steps.push(`picture ${name}: ${await textOf('[data-picture-facts]')} shown: ${ok}`)
    if (i === 1) await shot('v-02-picture-next')
  }
  // Zoom in around the middle, then actual size, then fit again.
  await key('+')
  await key('+')
  await wait(200)
  steps.push(`zoom after two steps: ${await textOf('[data-zoom-shown]')}`)
  await shot('v-03-picture-zoomed')
  await key('0')

  // 2. Tools: the picture goes to an image tool already added; Close comes back.
  await press('[data-picture-tools]')
  await wait(300)
  steps.push(`tools menu items: ${await js<number>("document.querySelectorAll('[data-picture-tools-menu] [role=menuitem]').length")}`)
  await shot('v-04-picture-tools-menu')
  await press('[data-picture-tools-menu] [role=menuitem]')
  steps.push(`tool opened with the picture: ${await until("document.querySelectorAll('[data-image-card] img').length === 1")}`)
  await shot('v-05-tool-with-picture')
  await press('[data-tool-close]')
  steps.push(`tool closed, back to the picture: ${await until(pictureLoaded)}`)

  // 3. Edit: the Photo editor with the picture; Close comes back.
  await press('[data-picture-bar] [data-edit-button]')
  steps.push(`photo editor with the picture: ${await until("document.querySelector('[data-photo-editor] canvas')")}`)
  await shot('v-06-photo-editor')
  await press('[data-photo-editor] [data-tool-close]')
  steps.push(`photo editor closed, back to the picture: ${await until(pictureLoaded)}`)

  // 4. The PDF opened in the reader: no tool tabs, panel or quick tools.
  await press('[data-tab=pdf]')
  steps.push(`reader shown: ${await until("document.querySelector('[data-read-bar] [data-edit-button]')")}`)
  steps.push(`reader pages loaded: ${await until(pagesLoaded)}`)
  steps.push(`reader has no tool tabs: ${!(await has('[data-global-bar]'))}, no tool panel: ${!(await has('[data-tool-panel]'))}, no quick tools: ${!(await has('[data-quick-tools]'))}, no rail: ${!(await has('[data-right-rail]'))}`)
  steps.push(`reader can select text: ${await has('[data-page="0"] [data-select-layer]')}`)
  await shot('v-07-pdf-reader')
  await press('[data-read-bar] button[aria-pressed]')
  await wait(500)
  steps.push(`reader thumbnails at the start: ${await has('[data-side-panel=thumbnails]')}`)
  await shot('v-08-reader-thumbnails')
  await press('[data-read-bar] button[aria-pressed=true]')

  // 5. Edit → the editor as before; Read → back.
  await press('[data-read-bar] [data-edit-button]')
  steps.push(`editor after Edit: ${await until("document.querySelector('[data-global-bar]') && document.querySelector('[data-tool-panel]') && document.querySelector('[data-quick-tools]')")}`)
  steps.push(`editor all tools in two sections: ${await js<number>("document.querySelectorAll('[data-all-tools-hub]').length")}`)
  await shot('v-09-pdf-editor')
  await press('[data-read-button]')
  steps.push(`back to the reader: ${await until("document.querySelector('[data-read-bar]') && !document.querySelector('[data-tool-panel]')")}`)

  // 6. Home: the two hubs, the recent PDFs and pictures, each hub's page.
  await press('[data-home-button]')
  steps.push(`home hubs: ${await until("document.querySelectorAll('[data-hub-card]').length === 2")}`)
  steps.push(`recent kinds: ${await js<string>("[...document.querySelectorAll('[data-recent-kind]')].map((b) => b.dataset.recentKind).join(',')")}`)
  await shot('v-10-home-hubs')
  await press('[data-hub-card=pdf]')
  steps.push(`pdf tools page: ${await until("document.querySelector('[data-hub=pdf]')")}, cards ${await js<number>("document.querySelectorAll('[data-hub=pdf] button.rounded-xl').length")}`)
  await shot('v-11-pdf-tools')
  await js(`(() => { const input = document.querySelector('[data-hub=pdf] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(rtl ? 'ضغط' : 'compress')}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await wait(300)
  steps.push(`pdf tools filter offers image tools too: ${await has('[data-hub-elsewhere]')}`)
  await shot('v-12-pdf-tools-filtered')
  await press('[data-nav=images]')
  steps.push(`image tools page: ${await until("document.querySelector('[data-hub=images]')")}, cards ${await js<number>("document.querySelectorAll('[data-hub=images] button.rounded-xl').length")}`)
  await shot('v-13-image-tools')

  // 7. More real PDFs, as a second launch hands them over: each opens in the reader.
  for (const [i, file] of morePdfs.entries()) {
    const tabs = await js<number>("document.querySelectorAll('[data-tab=pdf]').length")
    openFiles([file])
    const opened = await until(`document.querySelectorAll('[data-tab=pdf]').length > ${tabs}`, 30_000)
    const reader = opened && (await until("document.querySelector('[data-read-bar] [data-edit-button]')", 10_000))
    const pages = reader && (await until(pagesLoaded, 30_000))
    const name = file.split(/[\\/]/).pop()
    steps.push(`reader ${name}: opened ${opened}, reader ${reader}, pages loaded ${pages}, no tool tabs ${!(await has('[data-global-bar]'))}`)
    await shot(`v-14-pdf-${i + 1}`)
  }
}

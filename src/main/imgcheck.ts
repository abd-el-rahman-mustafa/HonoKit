import type { BrowserWindow } from 'electron'
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The image tools' check (scripts/imgcheck.mjs, decisions §69): drives each tool through the
 * real window as a person would — open it from All tools, add pictures, choose options, run,
 * look at the result, continue with another tool — with a screenshot of each step. The pictures
 * are made by the script in a temporary folder; results are written beside them.
 */
export async function runImageCheck(window: BrowserWindow, out: string, files: string[], steps: string[]): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>
  const shot = async (name: string): Promise<void> => {
    await wait(500)
    const image = await window.webContents.capturePage()
    writeFileSync(join(out, `${name}.png`), image.toPNG())
    steps.push(`shot ${name}`)
  }
  const click = (label: string, scope = 'body'): Promise<boolean> =>
    js<boolean>(`(() => {
      const want = ${JSON.stringify(label)}
      const root = document.querySelector(${JSON.stringify(scope)})
      const all = root ? [...root.querySelectorAll('button, [role=radio], [role=option]')] : []
      // A card's title is one of its spans: match the whole text first, then a title inside.
      const el = all.find((b) => b.title === want || b.getAttribute('aria-label') === want || b.textContent.trim() === want) ?? all.find((b) => [...b.querySelectorAll('span')].some((s) => s.textContent.trim() === want))
      if (!el) return false
      el.click()
      return true
    })()`)
  const until = async (test: string, ms = 60_000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await js<boolean>(`!!(${test})`)) return true
      await wait(200)
    }
    return false
  }
  const add = (paths: string[]): Promise<unknown> => js(`window.dispatchEvent(new CustomEvent('powerpdf:imgtool-add', { detail: ${JSON.stringify(paths)} }))`)
  const cardsReady = (count: number): Promise<boolean> => until(`document.querySelectorAll('[data-image-card] img').length >= ${count}`)
  const runAndWait = async (): Promise<boolean> => {
    await js(`document.querySelector('[data-imgtool-run]')?.click()`)
    return until(`document.querySelector('[data-imgtool-result]')`, 120_000)
  }
  const resultText = (): Promise<string> => js<string>(`document.querySelector('[data-imgtool-result]')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) ?? ''`)
  const labels = JSON.parse(process.env.POWERPDF_SMOKE_LABELS ?? '{}') as Record<string, string>
  const L = (key: string, fallback: string): string => labels[key] ?? fallback
  const openTool = async (name: string): Promise<boolean> => {
    await js("document.querySelector('[data-nav=images]')?.click()")
    await wait(300)
    const ok = await click(name, '[data-home=images]')
    await wait(500)
    // Without the tool open, every later step would only wait out its time.
    if (!ok) throw new Error(`tool not found on Home: ${name}`)
    return ok
  }

  const [photo, transparent, animation, ...rest] = files
  const all = files
  // Results are written beside the pictures: counting the folder's files shows "Try again" left no extra file (§77).
  const filesHere = (): number => readdirSync(dirname(photo!)).length
  const tryAgain = async (): Promise<boolean> => {
    await js(`document.querySelector('[data-imgtool-tryagain]')?.click()`)
    await wait(300)
    return until(`document.querySelector('[data-imgtool-result] [data-replaced]') && !document.querySelector('[data-imgtool-progress]')`, 120_000)
  }
  const tryAgainEnabled = (): Promise<boolean> => js<boolean>(`!!document.querySelector('[data-imgtool-tryagain]') && !document.querySelector('[data-imgtool-tryagain]').disabled`)

  // Home › Image tools: the image tools' own hub (§75).
  await js("document.querySelector('[data-nav=images]')?.click()")
  await wait(400)
  await shot('img-01-all-tools')
  steps.push(`images group shown: ${await js<boolean>(`document.body.innerText.toLowerCase().includes(${JSON.stringify(L("group.images", "Image tools").toLowerCase())})`)}`)

  // Convert image: every picture to WebP.
  steps.push(`convert opened: ${await openTool(L('tool.imgConvert', 'Convert image'))}`)
  await shot('img-02-convert-empty')
  await add(all)
  steps.push(`convert cards with previews: ${await cardsReady(all.length)}`)
  await shot('img-03-convert-board')
  await click('WEBP', '[data-format-picker]')
  await wait(300)
  await shot('img-04-convert-webp')
  steps.push(`convert done: ${await runAndWait()}`)
  await shot('img-05-convert-result')
  steps.push(`convert result: ${await resultText()}`)

  // Continue with Compress on the WebP results, strong.
  steps.push(`continue to compress: ${await click(L('tool.imgCompress', 'Compress image'), '[data-imgtool-result]')}`)
  steps.push(`compress cards: ${await cardsReady(Math.min(all.length, 2))}`)
  await click(L('img.level.strong', 'Strong'))
  await shot('img-06-compress-board')
  steps.push(`compress done: ${await runAndWait()}`)
  await wait(1200)
  await shot('img-07-compress-result')
  steps.push(`compress result: ${await resultText()}`)
  steps.push(`compress compare shown: ${await until(`document.querySelector('[data-compare-stage][data-compare-mode=slider] img')`, 20_000)}`)
  steps.push(`compress size change shown: ${await js<boolean>(`!!document.querySelector('[data-result-facts] [data-size-change]')`)}`)
  steps.push(`compress try again off before a change: ${!(await tryAgainEnabled())}`)
  // Try again with another setting: the results are replaced, no file is added.
  const beforeCompress = filesHere()
  await click(L('img.level.light', 'Light'), '[data-imgtool-adjust]')
  await wait(300)
  steps.push(`compress try again on after a change: ${await tryAgainEnabled()}`)
  await shot('img-07s-compress-adjust')
  steps.push(`compress tried again: ${await tryAgain()}`)
  await wait(800)
  steps.push(`compress try again left no extra file: ${filesHere() === beforeCompress}`)
  await shot('img-07t-compress-tried-again')
  // The compressed WebP pictures continue into Images to PDF, which now takes every format.
  steps.push(`continue to images to pdf: ${await click(L('tool.imagesToPdf', 'Images to PDF'), '[data-imgtool-result]')}`)
  steps.push(`images to pdf cards: ${await until(`document.querySelectorAll('[data-images-view] [data-image-card] img').length >= 3`, 30_000)}`)
  await shot('img-07b-images-to-pdf')
  await click(L('act.imagesToPdf', 'Convert to PDF'), '[data-images-view]')
  steps.push(`pdf of webp pictures opened: ${await until(`[...document.querySelectorAll('img')].some((i) => i.src.startsWith('pdfpage:') && i.naturalWidth > 0)`, 60_000)}`)
  await shot('img-07c-pdf-opened')
  // Back to Home for the next tools (the PDF stays open in its tab).
  await js(`document.querySelector('[aria-label=${JSON.stringify(L('home', 'Home'))}], [title=${JSON.stringify(L('home', 'Home'))}]')?.click()`)
  await wait(500)

  // Resize by percentage.
  steps.push(`resize opened: ${await openTool(L('tool.imgResize', 'Resize image'))}`)
  await add([photo!, transparent!])
  await cardsReady(2)
  await click(L('img.byPercent', 'Percentage'))
  await wait(300)
  await shot('img-08-resize-board')
  steps.push(`resize done: ${await runAndWait()}`)
  steps.push(`resize result: ${await resultText()}`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(200)
  await js(`document.querySelector('[data-imgtool-result]') && [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Crop: the stage with the box, 16:9.
  steps.push(`crop opened: ${await openTool(L('tool.imgCrop', 'Crop image'))}`)
  await add([photo!, ...rest])
  await cardsReady(1)
  await click('16:9', '[data-imgtool-options]')
  await wait(400)
  await shot('img-09-crop-stage')
  steps.push(`crop stage shown: ${await js<boolean>(`!!document.querySelector('[data-crop-stage]')`)}`)
  steps.push(`crop done: ${await runAndWait()}`)
  steps.push(`crop result: ${await resultText()}`)
  // The shape changed: a Before / After switch instead of the slider.
  steps.push(`crop compare is a switch: ${await until(`document.querySelector('[data-compare-stage][data-compare-mode=switch] img')`, 20_000)}`)
  await js(`document.querySelector('[data-compare-side=before]')?.click()`)
  await wait(1200)
  await shot('img-09b-crop-result-before')
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Rotate: a turn on one card, and the whole batch right.
  steps.push(`rotate opened: ${await openTool(L('tool.imgRotate', 'Rotate image'))}`)
  await add([photo!, transparent!])
  await cardsReady(2)
  await click(L('img.right', 'Right'), '[data-imgtool-options]')
  await wait(300)
  await shot('img-10-rotate-board')
  steps.push(`rotate done: ${await runAndWait()}`)
  steps.push(`rotate result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Watermark: an Arabic and English text mark, then the same as a repeated pattern.
  steps.push(`watermark opened: ${await openTool(L('tool.imgWatermark', 'Watermark image'))}`)
  await add([photo!, transparent!])
  await cardsReady(2)
  steps.push(`watermark add text: ${await click(L('mark.addText', 'Add text'), '[data-imgtool-options]')}`)
  await wait(600)
  await js(`(() => {
    const ta = document.querySelector('[data-mark-text]')
    if (!ta) return false
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'صوري © HonoKit')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await wait(800)
  steps.push(`watermark mark on stage: ${await js<boolean>(`document.querySelectorAll('[data-mark-layer] img').length > 0`)}`)
  await shot('img-15-watermark-stage')
  steps.push(`watermark done: ${await runAndWait()}`)
  steps.push(`watermark result: ${await resultText()}`)
  steps.push(`watermark compare shown: ${await until(`document.querySelector('[data-compare-stage] img')`, 20_000)}`)
  await wait(800)
  await shot('img-15b-watermark-result')
  // Its settings are on the pictures: "Adjust on the pictures", then run again — the results are replaced.
  steps.push(`watermark adjust on pictures: ${await js<boolean>(`!!document.querySelector('[data-adjust-on-pictures]')?.click() || true`)}`)
  await wait(400)
  steps.push(`watermark board says it replaces: ${await js<boolean>(`!!document.querySelector('[data-replaces-note]')`)}`)
  await js(`[...document.querySelectorAll('[data-imgtool-options] [role=option]')][0]?.click()`)
  await wait(200)
  await js(`[...document.querySelectorAll('[data-imgtool-options] label')].find((l) => l.textContent.includes(${JSON.stringify(L('mark.tile', 'Repeat across the picture'))}))?.querySelector('input')?.click()`)
  await wait(600)
  await shot('img-16-watermark-tiled')
  const beforeWatermark = filesHere()
  steps.push(`watermark run again: ${await runAndWait()}`)
  steps.push(`watermark replaced: ${await until(`document.querySelector('[data-imgtool-result] [data-replaced]')`, 10_000)}`)
  steps.push(`watermark run again left no extra file: ${filesHere() === beforeWatermark}`)
  await wait(800)
  await shot('img-16b-watermark-again')
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Meme: the two captions are there from the start.
  steps.push(`meme opened: ${await openTool(L('tool.imgMeme', 'Meme generator'))}`)
  await add([photo!])
  await cardsReady(1)
  await wait(800)
  steps.push(`meme captions: ${await js<number>(`document.querySelectorAll('[data-mark-layer]').length`)}`)
  await shot('img-17-meme-stage')
  await click(L('meme.outside', 'Above and below'))
  await wait(800)
  await shot('img-18-meme-outside')
  steps.push(`meme done: ${await runAndWait()}`)
  steps.push(`meme result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Offline AI: upscale the logo ×2 (and ×4 by "Try again"), switch tools keeping the picture, cut out
  // backgrounds, hide faces in a real picture.
  steps.push(`upscale opened: ${await openTool(L('tool.imgUpscale', 'Upscale image'))}`)
  await add([transparent!])
  await cardsReady(1)
  await shot('img-23-upscale-board')
  steps.push(`upscale done: ${await runAndWait()}`)
  steps.push(`upscale result: ${await resultText()}`)
  steps.push(`upscale says AI: ${await until(`document.querySelector('[data-imgtool-result] [data-method=ai-upscale]')`, 5_000)}`)
  steps.push(`upscale compare shown: ${await until(`document.querySelectorAll('[data-compare-stage][data-compare-mode=slider] img').length === 2`, 20_000)}`)
  await wait(800)
  await shot('img-23b-upscale-result')
  // Zoomed in, the AI's detail against the original enlarged plainly.
  await js(`document.querySelector('[data-compare-stage] button[aria-label=${JSON.stringify(L('img.zoomIn', 'Zoom in'))}]')?.click()`)
  await js(`document.querySelector('[data-compare-stage] button[aria-label=${JSON.stringify(L('img.zoomIn', 'Zoom in'))}]')?.click()`)
  await wait(600)
  await shot('img-23c-upscale-zoomed')
  const beforeUpscale = filesHere()
  await click('4×', '[data-imgtool-adjust]')
  await wait(300)
  steps.push(`upscale tried again at 4x: ${await tryAgain()}`)
  steps.push(`upscale 4x shown: ${await js<boolean>(`/[4٤]×/.test(document.querySelector('[data-result-facts]')?.textContent ?? '')`)}`)
  steps.push(`upscale try again left no extra file: ${filesHere() === beforeUpscale}`)
  await wait(800)
  await shot('img-23d-upscale-tried-again')
  // The title is a menu of the image tools: Remove background, taking the original picture along.
  await js(`document.querySelector('[data-tool-switcher]')?.click()`)
  await wait(400)
  steps.push(`switcher menu: ${await js<boolean>(`!!document.querySelector('[data-tool-switcher-menu] [data-switch-take=originals]')`)}`)
  await js(`document.querySelector('[data-switch-take=originals]')?.click()`)
  await wait(200)
  await shot('img-23e-tool-switcher')
  await js(`document.querySelector('[data-switch-to=imgRemoveBg]')?.click()`)
  steps.push(`switched to remove background with the picture: ${await until(`document.querySelector('[data-image-tool=imgRemoveBg]') && document.querySelectorAll('[data-image-card] img').length === 1`, 20_000)}`)
  await add([photo!])
  await cardsReady(2)
  steps.push(`remove background done: ${await runAndWait()}`)
  steps.push(`remove background says AI: ${await until(`document.querySelector('[data-imgtool-result] [data-method=ai-background]')`, 5_000)}`)
  steps.push(`remove background compare and strip: ${await until(`document.querySelectorAll('[data-compare-stage] img').length === 2 && document.querySelectorAll('[data-result-item]').length === 2`, 20_000)}`)
  // The photo's result, the handle moved towards the start with the keyboard.
  await js(`document.querySelectorAll('[data-result-item]')[1]?.click()`)
  await until(`document.querySelectorAll('[data-compare-stage] img').length === 2`, 20_000)
  await js(`(() => { const h = document.querySelector('[data-compare-handle]'); h?.focus(); for (let i = 0; i < 8; i++) h?.dispatchEvent(new KeyboardEvent('keydown', { key: document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft', bubbles: true })) })()`)
  await wait(1200)
  await shot('img-24-removebg-result')
  steps.push(`remove background result: ${await resultText()}`)
  // Close goes back to where the tool was opened: the Image tools hub.
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(400)
  steps.push(`close returned to the image tools hub: ${await js<boolean>(`!!document.querySelector('[data-home=images]')`)}`)

  steps.push(`blur opened: ${await openTool(L('tool.imgBlur', 'Blur faces'))}`)
  await add([rest[2] ?? photo!])
  await cardsReady(1)
  steps.push(`blur search finished: ${await until(`document.querySelector('[data-blur-stage]') && !document.querySelector('[data-blur-stage] .spin')`, 60_000)}`)
  await wait(500)
  steps.push(`blur areas found: ${await js<number>(`document.querySelectorAll('[data-blur-region]').length`)}`)
  await shot('img-25-blur-stage')
  steps.push(`blur done: ${await runAndWait()}`)
  await wait(1500)
  await shot('img-26-blur-result')
  steps.push(`blur result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Photo editor: a filter, a square crop, a text, a sticker, rounded corners, then save a copy.
  steps.push(`editor opened: ${await openTool(L('tool.imgEditor', 'Photo editor'))}`)
  await add([photo!])
  steps.push(`editor picture shown: ${await until(`document.querySelector('[data-editor-stage] canvas')?.width > 10`, 30_000)}`)
  const tab = (id: string): Promise<unknown> => js(`document.querySelector('[data-editor-tab=${id}]')?.click()`)
  const range = (label: string, value: number): Promise<unknown> =>
    js(`(() => {
      const input = document.querySelector('input[type=range][aria-label=${JSON.stringify(label)}]')
      if (!input) return false
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${value})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  await range(L('editor.adjust.brightness', 'Brightness'), 20)
  await range(L('editor.adjust.vignette', 'Vignette'), 60)
  await tab('filters')
  await click(L('editor.filter.vintage', 'Vintage'), '[data-editor-panel]')
  await wait(300)
  await shot('img-19-editor-filters')
  await tab('crop')
  await click('1:1', '[data-editor-panel]')
  await wait(300)
  await shot('img-20-editor-crop')
  await tab('text')
  await click(L('mark.addText', 'Add text'), '[data-editor-panel]')
  await wait(600)
  await tab('stickers')
  await js(`document.querySelector('[data-editor-panel] button[title]')?.click()`)
  await wait(600)
  await tab('frame')
  await range(L('editor.corners', 'Rounded corners'), 12)
  await range(L('editor.frame', 'Frame'), 3)
  await wait(400)
  await shot('img-21-editor-done')
  await js(`document.querySelector('[data-editor-save]')?.click()`)
  steps.push(`editor saved: ${await until(`document.body.innerText.includes(${JSON.stringify(L('editor.savedPrefix', 'Saved as'))})`, 60_000)}`)
  steps.push(`editor saved bar: ${await until(`document.querySelector('[data-editor-saved] img')`, 20_000)}`)
  await shot('img-22-editor-saved')
  // Saving again updates the same copy.
  const beforeResave = filesHere()
  await range(L('editor.adjust.brightness', 'Brightness'), -10)
  await js(`document.querySelector('[data-editor-save]')?.click()`)
  steps.push(`editor saved again: ${await until(`document.body.innerText.includes(${JSON.stringify(L('editor.updatedPrefix', 'Updated'))})`, 60_000)}`)
  steps.push(`editor save again left no extra file: ${filesHere() === beforeResave}`)
  await click(L('close', 'Close'), '[data-photo-editor]')
  await wait(300)

  // Make a GIF from three pictures.
  steps.push(`gif opened: ${await openTool(L('tool.imgGif', 'Make a GIF'))}`)
  await add([photo!, transparent!, ...rest.slice(0, 1)])
  await cardsReady(2)
  await shot('img-11-gif-board')
  steps.push(`gif done: ${await runAndWait()}`)
  await shot('img-12-gif-result')
  steps.push(`gif result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // GIF to pictures.
  steps.push(`frames opened: ${await openTool(L('tool.imgFrames', 'GIF to pictures'))}`)
  await add([animation!])
  await cardsReady(1)
  steps.push(`frames done: ${await runAndWait()}`)
  steps.push(`frames result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Icon maker.
  steps.push(`icon opened: ${await openTool(L('tool.imgIcon', 'Icon maker'))}`)
  await add([transparent!])
  await cardsReady(1)
  await shot('img-13-icon-board')
  steps.push(`icon done: ${await runAndWait()}`)
  steps.push(`icon result: ${await resultText()}`)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(L('img.startOver', 'Start over'))})?.click()`)
  await click(L('close', 'Close'), '[data-image-tool]')
  await wait(300)

  // Info & metadata: the photo carries a GPS position.
  steps.push(`info opened: ${await openTool(L('tool.imgInfo', 'Image info & metadata'))}`)
  await add([photo!])
  await cardsReady(1)
  steps.push(`gps warning: ${await until(`document.querySelector('[data-gps-warning]')`, 10_000)}`)
  await shot('img-14-info')
  steps.push(`info done: ${await runAndWait()}`)
  steps.push(`info result: ${await resultText()}`)
}

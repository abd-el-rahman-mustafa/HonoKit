// Draws SVG files to PNGs with Electron's renderer, offscreen and transparent.
// Usage: electron scripts/icon-render.cjs <in.svg> <out.png> <size> [<in.svg> <out.png> <size> …]
// Each SVG is drawn at its own size (not scaled down from a big one), so small icons stay crisp.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('icon-render.cjs')) + 1)
const jobs = []
for (let i = 0; i + 2 < args.length; i += 3) jobs.push({ input: args[i], output: args[i + 1], size: Number(args[i + 2]) })

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // One window big enough for the largest picture; a small one is drawn in its top-left corner.
  const box = Math.max(256, ...jobs.map((j) => j.size))
  const win = new BrowserWindow({ width: box, height: box, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  win.webContents.setFrameRate(1)
  for (const { input, output, size } of jobs) {
    const svg = readFileSync(input, 'utf8')
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 400))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    writeFileSync(output, image.resize({ width: size, height: size }).toPNG())
    console.log(`${output} ${size}×${size}`)
  }
  app.quit()
})

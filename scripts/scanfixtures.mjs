// Photos for checking the Scan tools (docs/decisions.md §61), made here: a real page lying tilted on a
// dark table, and the two sides of a sample ID card — as phones photograph them. Written to the
// folder given (never committed).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/** A picture lying on a dark table, turned `angle` degrees, rendered as a JPEG "photo". */
async function onTable(png, width, height, angle, tableW, tableH) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([tableW, tableH])
  page.drawRectangle({ x: 0, y: 0, width: tableW, height: tableH, color: rgb(0.22, 0.2, 0.19) })
  const image = await pdf.embedPng(png)
  page.drawImage(image, { x: (tableW - width) / 2 + 20, y: (tableH - height) / 2 - 10, width, height, rotate: degrees(angle) })
  const doc = mupdf.Document.openDocument(await pdf.save(), 'application/pdf')
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
  return pix.asJPEG(88)
}

async function card(side) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([428, 270])
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  const body = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawRectangle({ x: 0, y: 0, width: 428, height: 270, color: side === 'front' ? rgb(0.93, 0.95, 1) : rgb(0.96, 0.96, 0.93) })
  page.drawRectangle({ x: 0, y: 220, width: 428, height: 50, color: rgb(0.1, 0.35, 0.65) })
  page.drawText(side === 'front' ? 'IDENTITY CARD' : 'CARD HOLDER INFORMATION', { x: 18, y: 238, size: 18, font, color: rgb(1, 1, 1) })
  page.drawRectangle({ x: 18, y: 40, width: 110, height: 150, color: rgb(0.7, 0.74, 0.8) })
  const lines = side === 'front' ? ['Name: Layla Yousef', 'ID No: 784-1990-1234567-1', 'Nationality: UAE', 'Expiry: 2030-05-01'] : ['Card No: 123456789', 'Issue date: 2025-05-01', 'Employer: Example LLC', 'Signature: ____________']
  lines.forEach((l, i) => page.drawText(l, { x: 145, y: 170 - i * 32, size: 15, font: body, color: rgb(0.1, 0.1, 0.12) }))
  const doc = mupdf.Document.openDocument(await pdf.save(), 'application/pdf')
  return doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true).asPNG()
}

/** A page of a PDF as RGB pixels `height` tall. */
function pagePixels(doc, index, height) {
  const page = doc.loadPage(Math.min(index, doc.countPages() - 1))
  const [x0, y0, x1, y1] = page.getBounds()
  const s = height / (y1 - y0)
  const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true)
  // A copy: a view into MuPDF's memory goes stale when the next page is drawn (the memory grows).
  return { w: pix.getWidth(), h: pix.getHeight(), px: new Uint8Array(pix.getPixels()), stride: pix.getStride(), n: pix.getNumberOfComponents(), pix, ratio: (x1 - x0) / (y1 - y0) }
}

/**
 * An open book photographed from above (§62): two pages of the PDF side by side, curving down
 * toward the fold (their top edges and lines dip), the fold's shadow, the book tilted a little on a
 * dark table. Made by sampling the pages backwards from each photo pixel.
 */
function bookPhoto(doc, first, H, tilt, curve) {
  const a = pagePixels(doc, first, H)
  const b = pagePixels(doc, first + 1, H)
  const pw = Math.min(a.w, b.w)
  const W = 2 * pw
  const PW = W + 320
  const PH = H + 300
  const ox = 160
  const oy = 140
  const dip = (u) => curve * Math.max(0, 1 - Math.abs(u - pw) / pw) ** 2
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, PW, PH], false)
  const px = out.getPixels()
  const stride = out.getStride()
  const cos = Math.cos((tilt * Math.PI) / 180)
  const sin = Math.sin((tilt * Math.PI) / 180)
  const cx = PW / 2
  const cy = PH / 2
  for (let Y = 0; Y < PH; Y++)
    for (let X = 0; X < PW; X++) {
      // Undo the tilt: where this photo pixel lies on the untilted table.
      const x = cos * (X - cx) + sin * (Y - cy) + cx
      const y = -sin * (X - cx) + cos * (Y - cy) + cy
      const u = x - ox
      let rgb = [58 + ((X * 13 + Y * 7) % 9), 52 + ((X * 5 + Y * 11) % 7), 47]
      if (u >= 0 && u < W) {
        const top = oy + dip(u)
        const bottom = oy + H + dip(u) * 0.4
        if (y >= top && y < bottom) {
          const v = (y - top) / (bottom - top)
          const page = u < pw ? a : b
          const sx = Math.min(page.w - 1, Math.floor(u < pw ? u + (a.w - pw) : u - pw))
          const sy = Math.min(page.h - 1, Math.floor(v * page.h))
          const o = sy * page.stride + sx * page.n
          const shade = 1 - 0.5 * Math.exp(-(((u - pw) / (pw * 0.06)) ** 2))
          rgb = [page.px[o] * shade * 0.96, page.px[o + 1] * shade * 0.95, page.px[o + 2] * shade * 0.9]
        }
      }
      const o = Y * stride + X * 3
      px[o] = rgb[0]
      px[o + 1] = rgb[1]
      px[o + 2] = rgb[2]
    }
  const jpeg = out.asJPEG(88)
  for (const p of [a.pix, b.pix, out]) p.destroy()
  return jpeg
}

/** A PDF of flatbed scans of a book: each page one spread (two pages side by side, a shadow at the fold). */
async function bookScanPdf(doc, first, spreads) {
  const pdf = await PDFDocument.create()
  for (let s = 0; s < spreads; s++) {
    const a = pagePixels(doc, first + 2 * s, 1100)
    const b = pagePixels(doc, first + 2 * s + 1, 1100)
    const pw = Math.min(a.w, b.w)
    const W = 2 * pw
    const H = a.h
    const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false)
    const px = out.getPixels()
    const stride = out.getStride()
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const page = x < pw ? a : b
        const sx = Math.min(page.w - 1, x < pw ? x + (a.w - pw) : x - pw)
        const o = Math.min(page.h - 1, y) * page.stride + sx * page.n
        const shade = 1 - 0.45 * Math.exp(-(((x - pw) / (pw * 0.05)) ** 2))
        const d = y * stride + x * 3
        for (let c = 0; c < 3; c++) px[d + c] = page.px[o + c] * shade
      }
    const image = await pdf.embedJpg(out.asJPEG(85))
    const page = pdf.addPage([W * 0.5, H * 0.5])
    page.drawImage(image, { x: 0, y: 0, width: W * 0.5, height: H * 0.5 })
    for (const p of [a.pix, b.pix, out]) p.destroy()
  }
  return pdf.save()
}

export async function makeScanFixtures(folder, pdfPath, bookPath = pdfPath) {
  mkdirSync(folder, { recursive: true })
  const doc = mupdf.Document.openDocument(readFileSync(pdfPath), 'application/pdf')
  const page = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
  const pagePng = page.asPNG()
  const files = {
    page: join(folder, 'page-photo.jpg'),
    front: join(folder, 'card-front.jpg'),
    back: join(folder, 'card-back.jpg')
  }
  writeFileSync(files.page, await onTable(pagePng, 420, 543, 6, 620, 760))
  writeFileSync(files.front, await onTable(await card('front'), 300, 189, -4, 460, 340))
  writeFileSync(files.back, await onTable(await card('back'), 300, 189, 5, 460, 340))
  // A book: a photo of an open spread, and a PDF of two flatbed-scanned spreads.
  const book = mupdf.Document.openDocument(readFileSync(bookPath), 'application/pdf')
  files.book = join(folder, 'book-spread.jpg')
  writeFileSync(files.book, bookPhoto(book, 0, 1300, 3, 60))
  files.bookPdf = join(folder, 'book-scans.pdf')
  writeFileSync(files.bookPdf, await bookScanPdf(book, 0, 2))
  return files
}

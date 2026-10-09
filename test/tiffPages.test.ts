import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sessions } from '../src/worker/sessions'
import { makePng } from './fixtures'

let dir: string
let sessions: Sessions

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'powerpdf-tiff-'))
  sessions = new Sessions()
})
afterEach(() => {
  sessions.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

const COLOURS = ['#e11d48', '#16a34a', '#1473e6']

/** A three-page TIFF, 120 × 80 px per page, each page one flat colour (red, green, blue). */
async function threePageTiff(): Promise<string> {
  const pages = await Promise.all(COLOURS.map((c) => sharp({ create: { width: 120, height: 80, channels: 3, background: c } }).png().toBuffer()))
  const tiff = await sharp(pages, { join: { animated: true } }).tiff({ compression: 'lzw' }).toBuffer()
  expect((await sharp(tiff, { pages: -1 }).metadata()).pages).toBe(3)
  const path = join(dir, 'scan.tif')
  writeFileSync(path, tiff)
  return path
}

/** The strongest channel at the centre of a rendered page: 0 red, 1 green, 2 blue. */
async function centreChannel(png: string): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels
  const rgb = [data[at]!, data[at + 1]!, data[at + 2]!]
  return rgb.indexOf(Math.max(...rgb))
}

describe('Images to PDF with a multi-page TIFF', () => {
  it('makes one page per TIFF page, in order, and turns each by the picture rotation', async () => {
    const tiff = await threePageTiff()
    const png = join(dir, 'after.png')
    writeFileSync(png, await makePng(200, 100))
    const doc = await sessions.imagesToPdf([tiff, png], { paper: 'fit', margin: 0, autoOrientation: false, rotations: [90, 0] }, 'Pages.pdf')
    expect(doc.pages).toHaveLength(4)
    // The TIFF's rotation applies to all three of its pages (120 × 80 turned a quarter: taller than wide) …
    for (const p of doc.pages.slice(0, 3)) expect(p.height).toBeGreaterThan(p.width)
    // … and the picture after it keeps its own (none).
    expect(doc.pages[3]!.width).toBeGreaterThan(doc.pages[3]!.height)
    const rendered = await sessions.exportImages(doc.id, [0, 1, 2], 'png', 36, join(dir, 'out'))
    expect(await Promise.all(rendered.map(centreChannel))).toEqual([0, 1, 2])
  })
})

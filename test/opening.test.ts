import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EDIT_SWITCH, fileKind, openRequests, PICTURE_EXTENSIONS, sortPictures } from '@shared/opening'
import { free, openPdf } from '@engine/mupdf'
import { imageDecode } from '../src/worker/images'
import { corpusPdfPaths } from './corpusFiles'

/**
 * Opening files (decisions §75): what Explorer's "Open with" / "Edit with HonoKit", a second launch
 * and drag and drop hand over is sorted into PDFs for the reader and pictures for the picture viewer,
 * and every picture the viewer opens is decoded upright by the worker. On real PDFs in corpus/
 * (git-ignored; test/corpusFiles.ts) and pictures of many formats made here.
 */
const corpus = corpusPdfPaths()
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const folder = mkdtempSync(join(tmpdir(), 'honokit-opening-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

/** name → [width, height] the viewer must show (upright). */
const made: Record<string, [number, number]> = {}

beforeAll(async () => {
  const scene = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#6fb7ff"/><circle cx="450" cy="120" r="60" fill="#ffd23f"/><rect x="0" y="0" width="80" height="80" fill="#ff0000"/></svg>')).png().toBuffer()
  // A phone photo stored sideways (EXIF orientation 6): shown 400 × 600.
  await sharp(scene).rotate(-90).jpeg().withMetadata({ orientation: 6 }).toFile(join(folder, 'Photo 10.JPG'))
  made['Photo 10.JPG'] = [600, 400]
  await sharp(scene).jpeg().toFile(join(folder, 'photo 2.jfif'))
  made['photo 2.jfif'] = [600, 400]
  await sharp(scene).png().toFile(join(folder, 'a.png'))
  made['a.png'] = [600, 400]
  await sharp(scene).webp().toFile(join(folder, 'b.webp'))
  made['b.webp'] = [600, 400]
  await sharp(scene).avif({ quality: 40 }).toFile(join(folder, 'c.avif'))
  made['c.avif'] = [600, 400]
  await sharp(scene).resize(300).tiff().toFile(join(folder, 'd.tif'))
  made['d.tif'] = [300, 200]
  const frames = await Promise.all(['#e11d48', '#16a34a'].map((c) => sharp({ create: { width: 120, height: 80, channels: 4, background: c } }).png().toBuffer()))
  await sharp(frames, { join: { animated: true } }).gif({ delay: [300, 300] }).toFile(join(folder, 'e.gif'))
  made['e.gif'] = [120, 80]
  writeFileSync(join(folder, 'f.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#1473e6"/></svg>')
  made['f.svg'] = [320, 200]
  // A 24-bit BMP and an icon with one PNG entry, by hand: read by the WebAssembly engine.
  const bw = 90
  const bh = 60
  const row = Math.ceil((bw * 3) / 4) * 4
  const bmp = Buffer.alloc(54 + row * bh)
  bmp.write('BM', 0, 'latin1')
  bmp.writeUInt32LE(bmp.length, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(bw, 18)
  bmp.writeInt32LE(bh, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)
  bmp.writeUInt32LE(row * bh, 34)
  bmp.fill(0x80, 54)
  writeFileSync(join(folder, 'g.bmp'), bmp)
  made['g.bmp'] = [90, 60]
  const png = await sharp({ create: { width: 48, height: 48, channels: 4, background: '#16a34a' } }).png().toBuffer()
  const ico = Buffer.alloc(22)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(1, 4)
  ico[6] = 48
  ico[7] = 48
  ico.writeUInt16LE(1, 10)
  ico.writeUInt16LE(32, 12)
  ico.writeUInt32LE(png.length, 14)
  ico.writeUInt32LE(22, 18)
  writeFileSync(join(folder, 'h.ico'), Buffer.concat([ico, png]))
  made['h.ico'] = [48, 48]
  // Not pictures: skipped by the viewer's list.
  writeFileSync(join(folder, 'notes.txt'), 'hello')
  writeFileSync(join(folder, 'scan.pdf'), '%PDF-1.4\n')
})

describe('what a file is, by its name', () => {
  it('knows PDFs and every picture the image tools read', () => {
    expect(fileKind('C:\\a\\Report.PDF')).toBe('pdf')
    for (const name of ['x.jpg', 'x.JPEG', 'x.jfif', 'x.png', 'x.webp', 'x.gif', 'x.heic', 'x.HEIF', 'x.avif', 'x.tif', 'x.tiff', 'x.bmp', 'x.svg', 'x.ico', 'x.jxl', 'x.dng', 'x.psd']) expect(fileKind(name), name).toBe('image')
    for (const name of ['x.docx', 'x.txt', 'x', '.jpg', 'folder.d/x']) expect(fileKind(name), name).toBeNull()
    expect(PICTURE_EXTENSIONS).not.toContain('pdf')
  })
})

describe.skipIf(corpus.length === 0)('a command line with the owner\'s PDFs and pictures', () => {
  it('opens each PDF in the reader and each picture in the viewer, in order', () => {
    const picture = join(folder, 'a.png')
    const argv = [process.execPath, resolve('.'), corpus[0]!, picture, join(folder, 'missing.png'), join(folder, 'notes.txt'), ...corpus.slice(1)]
    const requests = openRequests(argv, isFile)
    expect(requests.map((r) => r.path)).toEqual([corpus[0], picture, ...corpus.slice(1)])
    expect(requests.map((r) => r.kind)).toEqual(['pdf', 'image', ...corpus.slice(1).map(() => 'pdf')])
    expect(requests.every((r) => !r.edit)).toBe(true)
  })

  it('"Edit with HonoKit" (--edit) asks for the editors, wherever Windows puts the switch', () => {
    for (const argv of [[EDIT_SWITCH, corpus[0]!], [corpus[0]!, EDIT_SWITCH], ['--allow-file-access-from-files', EDIT_SWITCH, join(folder, 'b.webp')]]) {
      const requests = openRequests(argv, isFile)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.edit).toBe(true)
    }
  })

  for (const file of corpus) {
    it(`${file.split(/[\\/]/).pop()} opens as a PDF`, () => {
      expect(fileKind(file)).toBe('pdf')
      const doc = openPdf(new Uint8Array(readFileSync(file)))
      expect(doc.countPages()).toBeGreaterThan(0)
      free(doc)
    })
  }
})

describe('the picture viewer', () => {
  it('lists the pictures of a folder in Explorer\'s order, nothing else', () => {
    expect(sortPictures(readdirSync(folder))).toEqual(['a.png', 'b.webp', 'c.avif', 'd.tif', 'e.gif', 'f.svg', 'g.bmp', 'h.ico', 'photo 2.jfif', 'Photo 10.JPG'])
  })

  it('decodes every format upright, as PNG', async () => {
    for (const [name, [width, height]] of Object.entries(made)) {
      const r = await imageDecode(join(folder, name))
      expect([r.width, r.height], name).toEqual([width, height])
      expect([...r.data.subarray(0, 4)], name).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
  })
})

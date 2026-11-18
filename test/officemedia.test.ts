import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { exportOffice } from '@engine/office'
import { makePng } from './fixtures'

const BASE = { removeTatweel: true, digits: 'keep' as const, pageBreaks: false, pictureFolder: 'pictures' }

/** Three pages, each with the same logo twice and a line of text. */
async function makeLetterhead(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const logo = await pdf.embedPng(makePng(60, 40, [20, 80, 160]))
  for (let p = 1; p <= 3; p++) {
    const page = pdf.addPage([595, 842])
    page.drawImage(logo, { x: 60, y: 720, width: 120, height: 80 })
    page.drawImage(logo, { x: 400, y: 60, width: 120, height: 80 })
    page.drawText(`Letter page ${p} with some words on it.`, { x: 60, y: 600, size: 12, font })
  }
  return new Uint8Array(await pdf.save())
}

const mediaIn = (zip: JSZip, folder: string): string[] => Object.keys(zip.files).filter((n) => n.startsWith(folder) && !n.endsWith('/'))

describe('PDF to Office: a picture used many times is stored once', () => {
  it('PowerPoint keeps one copy of the logo for all slides, each slide relating to it once', async () => {
    const r = await exportOffice(await makeLetterhead(), { ...BASE, format: 'pptx' })
    const zip = await JSZip.loadAsync(r.bytes)
    const media = mediaIn(zip, 'ppt/media/')
    expect(media).toHaveLength(1)
    for (let s = 1; s <= 3; s++) {
      const slide = await zip.file(`ppt/slides/slide${s}.xml`)!.async('string')
      expect(slide.match(/<p:pic>/g)).toHaveLength(2)
      const rels = await zip.file(`ppt/slides/_rels/slide${s}.xml.rels`)!.async('string')
      expect(rels.split('../media/').length - 1).toBe(1)
      // Both pictures point at the slide's one relationship, which exists.
      const ids = [...slide.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1])
      expect(new Set(ids).size).toBe(1)
      expect(rels).toContain(`Id="${ids[0]}"`)
    }
  })

  for (const layout of ['look', 'flow'] as const) {
    it(`Word (${layout}) keeps one copy of the logo`, async () => {
      const r = await exportOffice(await makeLetterhead(), { ...BASE, format: 'docx', ...(layout === 'flow' ? { layout: 'flow' as const } : {}) })
      const zip = await JSZip.loadAsync(r.bytes)
      expect(mediaIn(zip, 'word/media/')).toHaveLength(1)
      const xml = await zip.file('word/document.xml')!.async('string')
      const ids = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1])
      expect(ids.length).toBeGreaterThanOrEqual(2)
      expect(new Set(ids).size).toBe(1)
      const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
      expect(rels).toContain(`Id="${ids[0]}"`)
    })
  }
})

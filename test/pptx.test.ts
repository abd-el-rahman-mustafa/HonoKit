import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { describe, expect, it } from 'vitest'
import { embeddedFont } from '../src/main/pptx/fonts'
import { customGeometry, presetGeometry } from '../src/main/pptx/geometry'
import { pptxToHtml } from '../src/main/pptx'
import { color, parseXml, readTheme, DEFAULT_MAP } from '../src/main/pptx/ooxml'

/**
 * PowerPoint to PDF without Office (docs/decisions.md §63): the converter's HTML for decks made
 * here with pptxgenjs — Arabic right-to-left text, bullets, a table, charts, shapes, a picture,
 * a placeholder that takes its place from the master, a hidden slide.
 */

const PNG_1x1 = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function deck(): Promise<Uint8Array> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.defineSlideMaster({
    title: 'WITH_BODY',
    background: { color: 'FFFFFF' },
    objects: [{ placeholder: { options: { name: 'body', type: 'body', x: 1, y: 2, w: 8, h: 3 }, text: '' } }]
  })
  const ar = { rtlMode: true, lang: 'ar-SA' }
  let s = pptx.addSlide()
  s.addText('التقرير السنوي', { x: 0.5, y: 0.5, w: 12, h: 1, fontSize: 40, align: 'right', color: '0F3D5E', ...ar })
  s.addText(
    [
      { text: 'النقطة الأولى', options: { bullet: true, breakLine: true, ...ar } },
      { text: 'النقطة الثانية', options: { bullet: { type: 'number' }, breakLine: true, ...ar } }
    ],
    { x: 0.5, y: 2, w: 12, h: 3, fontSize: 24, align: 'right' }
  )
  s = pptx.addSlide()
  s.addTable(
    [
      [{ text: 'القطاع', options: { bold: true, fill: { color: '0F3D5E' }, color: 'FFFFFF' } }, { text: '2025' }],
      [{ text: 'الرقمي' }, { text: '78' }]
    ],
    { x: 1, y: 1, w: 6, colW: [4, 2], border: { type: 'solid', pt: 1, color: 'B0B7BF' } }
  )
  s.addChart(pptx.ChartType.bar, [{ name: 'S', labels: ['أ', 'ب', 'ج'], values: [3, 5, 8] }], { x: 7, y: 1, w: 5, h: 4, chartColors: ['1F77B4'] })
  s = pptx.addSlide()
  s.addShape(pptx.ShapeType.roundRect, { x: 1, y: 1, w: 4, h: 2, fill: { color: 'F2A900' }, rectRadius: 0.3 })
  s.addShape(pptx.ShapeType.line, { x: 1, y: 4, w: 4, h: 0, line: { color: 'C0392B', width: 2, endArrowType: 'triangle' } })
  s.addImage({ data: PNG_1x1, x: 6, y: 1, w: 2, h: 2 })
  s = pptx.addSlide({ masterName: 'WITH_BODY' })
  s.addText('From the master', { placeholder: 'body' })
  s = pptx.addSlide()
  s.addText('Hidden slide', { x: 1, y: 1, w: 5, h: 1 })
  const bytes = new Uint8Array((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
  // The last slide hidden, as PowerPoint marks it.
  const zip = await JSZip.loadAsync(bytes)
  const last = 'ppt/slides/slide5.xml'
  const xml = await zip.file(last)!.async('string')
  zip.file(last, xml.replace('<p:sld ', '<p:sld show="0" '))
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
}

const slideOf = (html: string, n: number): string => html.split('<section class="slide">')[n] ?? ''

describe('PowerPoint to PDF without Office (§63)', () => {
  it('lays out every shown slide, leaving the hidden one out', async () => {
    const r = await pptxToHtml(await deck(), { inline: true })
    expect(r.slides).toBe(4)
    expect(Math.round(r.width)).toBe(960)
    expect(Math.round(r.height)).toBe(540)
    expect(r.html).not.toContain('Hidden slide')
    expect(r.html).toContain('@page { size: 960pt 540pt')
  })

  it('keeps Arabic text right to left with its bullets and numbers', async () => {
    const r = await pptxToHtml(await deck(), { inline: true })
    const one = slideOf(r.html, 1)
    expect(one).toContain('التقرير السنوي')
    expect(one).toContain('النقطة الأولى')
    expect((one.match(/dir="rtl"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(one).toContain('text-align:right')
    // A bullet, then a number for the second item.
    expect(one).toMatch(/class="bu"[^>]*>•</)
    expect(one).toMatch(/class="bu"[^>]*>1\.</)
  })

  it('draws a table with its fills and borders, and a chart from its cached values', async () => {
    const r = await pptxToHtml(await deck(), { inline: true })
    const two = slideOf(r.html, 2)
    expect((two.match(/<td/g) ?? []).length).toBe(4)
    expect(two).toContain('background:rgb(15,61,94)')
    expect(two).toMatch(/border-left:1pt solid rgb\(176,183,191\)/)
    // Three bars in the series colour, the categories as labels.
    expect((two.match(/<rect [^>]*fill="rgb\(31,119,180\)"/g) ?? []).length).toBe(3)
    expect(two).toContain('ج')
  })

  it('draws shapes, arrowheads and pictures', async () => {
    const r = await pptxToHtml(await deck(), { inline: true })
    const three = slideOf(r.html, 3)
    expect(three).toContain('fill="rgb(242,169,0)"')
    expect(three).toContain('marker-end="url(#')
    expect(three).toContain('href="data:image/png;base64,')
    expect(r.media.size).toBe(1)
  })

  it('hands Windows metafile pictures (EMF/WMF) over to be drawn by Windows, as PNGs', async () => {
    // The deck's picture stored as an .emf part, as PowerPoint stores pasted logos and charts.
    const zip = await JSZip.loadAsync(await deck())
    const png = Object.keys(zip.files).find((n) => n.startsWith('ppt/media/') && !zip.files[n]!.dir)!
    const emf = png.replace(/\.\w+$/, '.emf')
    zip.file(emf, await zip.file(png)!.async('uint8array'))
    zip.remove(png)
    for (const rels of Object.keys(zip.files).filter((n) => n.endsWith('.rels'))) {
      const xml = await zip.file(rels)!.async('string')
      zip.file(rels, xml.split(png.replace('ppt/', '../')).join(emf.replace('ppt/', '../')))
    }
    const r = await pptxToHtml(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })))
    expect(r.metafiles.size).toBe(1)
    const [name, file] = [...r.metafiles][0]!
    expect(name).toMatch(/^m\d+\.png$/)
    expect(file.type).toBe('emf')
    expect(r.html).toContain(`href="media/${name}"`)
    expect(r.notes.join(' ')).not.toMatch(/metafile/i)
  })

  it('puts a placeholder where its master puts it', async () => {
    const r = await pptxToHtml(await deck(), { inline: true })
    const four = slideOf(r.html, 4)
    expect(four).toContain('From the master')
    // x 1in, y 2in on the master: 72pt, 144pt.
    expect(four).toMatch(/left:72pt;top:144pt;width:576pt;height:216pt/)
  })

  it('says plainly when a file is not a presentation', async () => {
    await expect(pptxToHtml(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PowerPoint/)
  })

  it('reads theme colours with their changes (lighter, darker, see-through)', () => {
    const theme = readTheme(
      parseXml(
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
      )
    )
    const ctx = { theme, map: DEFAULT_MAP }
    const fill = (inner: string) => parseXml(`<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${inner}</a:solidFill>`)
    expect(color(fill('<a:schemeClr val="accent1"/>'), ctx)).toEqual({ r: 68, g: 114, b: 196, a: 1 })
    // tx1 is dk1 through the colour map.
    expect(color(fill('<a:schemeClr val="tx1"/>'), ctx)).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    // 40% lighter: lumMod 60%, lumOff 40%.
    const light = color(fill('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>'), ctx)!
    expect(light.r).toBeGreaterThan(130)
    expect(light.b).toBeGreaterThan(210)
    expect(color(fill('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'), ctx)!.a).toBeCloseTo(0.5)
    expect(theme.minor.latin).toBe('Calibri')
  })

  it('reads an embedded font stored as Embedded OpenType, plain or XOR-obfuscated', () => {
    const ttf = new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf'))
    for (const xor of [false, true]) {
      // A minimal EOT header (version 0x00020001) with the font data last.
      const header = new Uint8Array(82)
      const v = new DataView(header.buffer)
      v.setUint32(0, header.length + ttf.length, true)
      v.setUint32(4, ttf.length, true)
      v.setUint32(8, 0x00020001, true)
      v.setUint32(12, xor ? 0x10000000 : 0, true)
      v.setUint16(34, 0x504c, true)
      const eot = new Uint8Array(header.length + ttf.length)
      eot.set(header)
      eot.set(xor ? ttf.map((b) => b ^ 0x50) : ttf, header.length)
      const out = embeddedFont(eot)!
      expect(out.length).toBe(ttf.length)
      expect(Buffer.from(out).equals(Buffer.from(ttf))).toBe(true)
    }
    expect(embeddedFont(new Uint8Array(100))).toBeNull()
  })

  // MicroType Express fonts come from real decks (not kept in the repository):
  //   POWERPDF_TEST_PPTX="a.pptx;b.pptx" npx vitest run test/pptx.test.ts
  const decks = (process.env.POWERPDF_TEST_PPTX ?? '').split(';').map((f) => f.trim()).filter(Boolean)
  it.skipIf(!decks.length)('decodes MicroType Express fonts embedded in real decks to working TrueType', async () => {
    for (const path of decks) {
      const zip = await JSZip.loadAsync(readFileSync(path))
      const parts = Object.keys(zip.files).filter((n) => n.startsWith('ppt/fonts/'))
      for (const part of parts) {
        const ttf = embeddedFont(new Uint8Array(await zip.file(part)!.async('uint8array')))
        expect(ttf, part).not.toBeNull()
        const font = fontkit.create(Buffer.from(ttf!)) as unknown as { numGlyphs: number; layout(s: string): { glyphs: Array<{ path: { commands: unknown[] }; advanceWidth: number }> } }
        expect(font.numGlyphs, part).toBeGreaterThan(50)
        // Letters have outlines and widths; a space has a width only.
        const run = font.layout('Ag ')
        expect(run.glyphs[0]!.path.commands.length, part).toBeGreaterThan(4)
        expect(run.glyphs[1]!.path.commands.length, part).toBeGreaterThan(4)
        expect(run.glyphs[2]!.path.commands.length, part).toBe(0)
        expect(run.glyphs[2]!.advanceWidth, part).toBeGreaterThan(0)
      }
    }
  })

  it('draws preset and custom geometry', () => {
    const geom = (xml: string) => parseXml(`<a:x xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</a:x>`).firstChild as unknown as Element
    const round = presetGeometry(geom('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>'), 100, 40)
    // Fully rounded: corners of radius 20 (half the 40pt height).
    expect(round.paths[0]!.d).toContain('A20,20')
    expect(presetGeometry(geom('<a:prstGeom prst="noSuchShape"/>'), 10, 10).unknown).toBe('noSuchShape')
    const custom = customGeometry(
      geom(
        '<a:custGeom><a:avLst/><a:gdLst><a:gd name="half" fmla="*/ w 1 2"/></a:gdLst><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/><a:close/></a:path></a:pathLst></a:custGeom>'
      ),
      200,
      100
    )
    // Path units scaled to the 200 × 100 box; the arc ends below its start.
    expect(custom.paths[0]!.d).toMatch(/^M0,0 L200,0 A100,50 0 0 1 100,50 Z$/)
  })
})

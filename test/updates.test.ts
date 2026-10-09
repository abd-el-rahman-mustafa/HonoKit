import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib'
import { diffWords, textWords } from '@engine/compare'
import { addMarkup, pageMarkups, removeMarkup } from '@engine/markup'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { insertPdfPages, keepPages, mergePdfs, splitByRanges } from '@engine/pages'
import { renderPage } from '@engine/render'
import { extractLines, selectText } from '@engine/text'
import { pageAddress, pageUrl } from '@shared/ipc'
import { commentThreads } from '@shared/threads'
import { PendingTyping } from '@shared/typing'
import { Sessions } from '../src/worker/sessions'
import { writeStaged } from '../src/worker/staging'
import { makeLatinPdf } from './fixtures'

/**
 * Fixes of 2026-10-08/09 (decisions §82): typing committed first, PDF/X kept, comments without an
 * appearance, reply threads, four-click selection, exact page pixels, smooth ink, staging files.
 */

const OPTIONS = { ignoreMarks: true, ignorePunctuation: true, sameDigits: true }

function withDoc<T>(bytes: Uint8Array, fn: (doc: mupdf.PDFDocument) => T): T {
  const doc = openPdf(bytes)
  try {
    return fn(doc)
  } finally {
    free(doc)
  }
}

// --- the text still being typed in a form field --------------------------------------------------

describe('text still being typed in a form field is committed first', () => {
  it('runs every pending commit of the document, once, before it is read', async () => {
    const typing = new PendingTyping()
    const done: string[] = []
    typing.set('doc', 'name', async () => void done.push('name'))
    typing.set('doc', 'city', async () => void done.push('city'))
    typing.set('other', 'x', async () => void done.push('other'))
    expect(typing.has('doc')).toBe(true)
    await typing.commit('doc')
    expect(done).toEqual(['name', 'city'])
    expect(typing.has('doc')).toBe(false)
    // Committed once: a second Save does not fill the field again.
    await typing.commit('doc')
    expect(done).toEqual(['name', 'city'])
    expect(typing.has('other')).toBe(true)
  })

  it('forgets a field whose typing was committed by leaving it, or abandoned with Escape', async () => {
    const typing = new PendingTyping()
    let runs = 0
    typing.set('doc', 'name', async () => void runs++)
    typing.set('doc', 'name', null)
    await typing.commit('doc')
    expect(runs).toBe(0)
  })

  it('a commit that fails still lets the others run, and is reported', async () => {
    const typing = new PendingTyping()
    let ran = false
    typing.set('doc', 'a', async () => {
      throw new Error('refused')
    })
    typing.set('doc', 'b', async () => void (ran = true))
    expect(await typing.commit('doc')).toBe(false)
    expect(ran).toBe(true)
  })
})

// --- PDF/X output intent and identification ------------------------------------------------------

const XMP_NS = 'xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"'

interface PrintStandard {
  condition?: string
  profile?: number[]
  version?: string
  /** XMP claims besides the PDF/X version. */
  claims?: string
  xmp?: boolean
  /** Tag page 1's text (a structure element on page 1 only). */
  taggedFirst?: boolean
}

/** pdf-lib keeps the Info dictionary private; test files set GTS_PDFXVersion and Trapped in it. */
const infoDict = (pdf: PDFDocument): { set(key: PDFName, value: unknown): void } => (pdf as unknown as { getInfoDict(): { set(key: PDFName, value: unknown): void } }).getInfoDict()

async function makePrintPdf(o: PrintStandard): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([400, 600])
  pdf.addPage([400, 600])
  const ctx = pdf.context
  if (o.condition) {
    const profile = ctx.register(ctx.stream(new Uint8Array(o.profile ?? [1, 2, 3, 4]), { N: 3 }))
    const intent = ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of(o.condition), DestOutputProfile: profile })
    pdf.catalog.set(PDFName.of('OutputIntents'), ctx.obj([intent]))
  }
  if (o.version) {
    infoDict(pdf).set(PDFName.of('GTS_PDFXVersion'), PDFString.of(o.version))
    infoDict(pdf).set(PDFName.of('Trapped'), PDFName.of('False'))
  }
  if (o.xmp !== false && (o.version || o.claims)) {
    const version = o.version ? ` pdfxid:GTS_PDFXVersion="${o.version}"` : ''
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ${XMP_NS}${version} ${o.claims ?? ''}/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
    pdf.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' })))
  }
  if (o.taggedFirst) {
    const elem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', Pg: first.ref, K: 0 }))
    const root = ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: [elem] }))
    pdf.catalog.set(PDFName.of('StructTreeRoot'), root)
    pdf.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }))
  }
  return new Uint8Array(await pdf.save())
}

interface Declared {
  intents: Array<{ s: string; condition: string; profile: string }>
  version: string
  trapped: string
  xmp: string
}

function declared(bytes: Uint8Array): Declared {
  return withDoc(bytes, (doc) => {
    const root = doc.getTrailer().get('Root')
    const info = doc.getTrailer().get('Info')
    const list = root.get('OutputIntents')
    const intents = Array.from({ length: list.isArray() ? list.length : 0 }, (_, i) => {
      const it = list.get(i)
      const profile = it.get('DestOutputProfile')
      return { s: it.get('S').asName(), condition: it.get('OutputConditionIdentifier').asString(), profile: profile.isStream() ? Buffer.from(profile.readStream().asUint8Array()).toString('hex') : '' }
    })
    const meta = root.get('Metadata')
    return {
      intents,
      version: info.isDictionary() && info.get('GTS_PDFXVersion').isString() ? info.get('GTS_PDFXVersion').asString() : '',
      trapped: info.isDictionary() && info.get('Trapped').isName() ? info.get('Trapped').asName() : '',
      xmp: meta.isStream() ? meta.readStream().asString() : ''
    }
  })
}

describe('Combine, extract and split keep the PDF/X output intent and identification', () => {
  it('Combine keeps them when every file declares the same print standard', async () => {
    const x4 = await makePrintPdf({ condition: 'FOGRA39', version: 'PDF/X-4', claims: 'pdfaid:part="2" pdfaid:conformance="B"' })
    const d = declared(mergePdfs([{ bytes: x4 }, { bytes: x4 }]))
    expect(d.intents).toEqual([{ s: 'GTS_PDFX', condition: 'FOGRA39', profile: '01020304' }])
    expect(d.version).toBe('PDF/X-4')
    expect(d.trapped).toBe('False')
    expect(d.xmp).toMatch(/pdfxid:GTS_PDFXVersion[^<]*PDF\/X-4|<pdfxid:GTS_PDFXVersion>PDF\/X-4</)
    // A new identification: the first file's PDF/A claim is not carried to a file made of others' pages.
    expect(d.xmp).not.toContain('pdfaid')
    expect(d.xmp).not.toContain('pdfuaid')
  })

  it('Combine claims nothing when the files disagree, or one is not PDF/X', async () => {
    const x4 = await makePrintPdf({ condition: 'FOGRA39', version: 'PDF/X-4' })
    const other = await makePrintPdf({ condition: 'GRACoL', version: 'PDF/X-4' })
    const sameNameOtherProfile = await makePrintPdf({ condition: 'FOGRA39', profile: [9, 9, 9], version: 'PDF/X-4' })
    const plain = await makeLatinPdf(1)
    for (const second of [other, sameNameOtherProfile, plain]) {
      const d = declared(mergePdfs([{ bytes: x4 }, { bytes: second }]))
      expect(d.intents).toEqual([])
      expect(d.version).toBe('')
      expect(d.xmp).not.toContain('pdfxid')
    }
  })

  it('a document without a print standard gains none', async () => {
    const plain = await makeLatinPdf(2)
    const d = declared(mergePdfs([{ bytes: plain }, { bytes: plain }]))
    expect(d).toEqual({ intents: [], version: '', trapped: '', xmp: '' })
  })

  it('takes the PDF/X version from the XMP when only the XMP has it', async () => {
    const xmpOnly = await makePrintPdf({ condition: 'FOGRA39', claims: 'pdfxid:GTS_PDFXVersion="PDF/X-4"' })
    const d = declared(mergePdfs([{ bytes: xmpOnly }, { bytes: xmpOnly }]))
    expect(d.version).toBe('PDF/X-4')
    expect(d.xmp).toContain('PDF/X-4')
  })

  it('extract and split keep the output intent and identification', async () => {
    const x4 = await makePrintPdf({ condition: 'FOGRA39', version: 'PDF/X-4' })
    for (const out of [keepPages(x4, [1]), ...splitByRanges(x4, [[0, 0], [1, 1]])]) {
      const d = declared(out)
      expect(d.intents).toEqual([{ s: 'GTS_PDFX', condition: 'FOGRA39', profile: '01020304' }])
      expect(d.version).toBe('PDF/X-4')
      expect(d.xmp).toContain('PDF/X-4')
    }
  })

  it('extracting pages without the tagged content drops the PDF/UA and PDF/A level A claims, not PDF/X', async () => {
    const tagged = await makePrintPdf({ condition: 'FOGRA39', version: 'PDF/X-4', claims: 'pdfaid:part="2" pdfaid:conformance="A" pdfuaid:part="1"', taggedFirst: true })
    const kept = declared(keepPages(tagged, [0, 1]))
    expect(kept.xmp).toContain('pdfuaid:part')
    expect(kept.xmp).toContain('pdfaid:conformance')
    const second = declared(keepPages(tagged, [1]))
    expect(second.xmp).toContain('PDF/X-4')
    expect(second.xmp).not.toContain('pdfuaid:part')
    expect(second.xmp).not.toContain('pdfaid:conformance')
    expect(second.xmp).not.toContain('pdfaid:part')
  })
})

// --- annotations without an appearance stream ----------------------------------------------------

describe('comments with no appearance stream are shown', () => {
  const BOXES: Record<string, [number, number, number, number]> = {
    Highlight: [50, 650, 250, 700],
    Square: [300, 650, 500, 700],
    Circle: [50, 520, 250, 600],
    Ink: [300, 520, 500, 600],
    FreeText: [50, 380, 250, 460],
    Text: [300, 420, 330, 445],
    Underline: [50, 250, 250, 300],
    StrikeOut: [300, 250, 500, 300],
    Line: [50, 100, 250, 200],
    Polygon: [300, 100, 500, 200]
  }

  async function bare(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([600, 800])
    const ctx = pdf.context
    const add = (d: Record<string, unknown>): void => page.node.addAnnot(ctx.register(ctx.obj(d as never)) as PDFRef)
    const quads = (b: number[]): unknown => ctx.obj([b[0]!, b[3]!, b[2]!, b[3]!, b[0]!, b[1]!, b[2]!, b[1]!])
    add({ Type: 'Annot', Subtype: 'Highlight', Rect: BOXES.Highlight, QuadPoints: quads(BOXES.Highlight!), C: [1, 1, 0] })
    add({ Type: 'Annot', Subtype: 'Square', Rect: BOXES.Square, C: [1, 0, 0], Border: [0, 0, 3] })
    add({ Type: 'Annot', Subtype: 'Circle', Rect: BOXES.Circle, C: [0, 0, 1] })
    add({ Type: 'Annot', Subtype: 'Ink', Rect: BOXES.Ink, C: [0, 0.5, 0], InkList: [[310, 530, 400, 590, 490, 530]], BS: { W: 3 } })
    add({ Type: 'Annot', Subtype: 'FreeText', Rect: BOXES.FreeText, DA: PDFString.of('0 0 1 rg /Helv 14 Tf'), Contents: PDFString.of('Hello free text') })
    add({ Type: 'Annot', Subtype: 'Text', Rect: [300, 420, 320, 440], C: [1, 0.8, 0], Contents: PDFString.of('A note') })
    add({ Type: 'Annot', Subtype: 'Underline', Rect: BOXES.Underline, QuadPoints: quads(BOXES.Underline!), C: [1, 0, 0] })
    add({ Type: 'Annot', Subtype: 'StrikeOut', Rect: BOXES.StrikeOut, QuadPoints: quads(BOXES.StrikeOut!), C: [1, 0, 0] })
    add({ Type: 'Annot', Subtype: 'Line', Rect: BOXES.Line, L: [60, 110, 240, 190], C: [1, 0, 1] })
    add({ Type: 'Annot', Subtype: 'Polygon', Rect: BOXES.Polygon, Vertices: [310, 110, 490, 110, 400, 190], C: [0, 1, 1] })
    return new Uint8Array(await pdf.save())
  }

  it('MuPDF draws every one of them, and the highlight in its own colour', async () => {
    const bytes = await bare()
    withDoc(bytes, (doc) => {
      const r = renderPage(doc, 0, { scale: 1, format: 'png' })
      const pix = new mupdf.Image(r.data).toPixmap()
      try {
        const w = pix.getWidth()
        const px = pix.getPixels()
        const n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0)
        const at = (x: number, y: number): number[] => Array.from(px.slice(((800 - y) * w + x) * n, ((800 - y) * w + x) * n + 3))
        for (const [type, b] of Object.entries(BOXES)) {
          let inked = 0
          for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) if (at(x, y).some((v) => v < 240)) inked++
          expect(inked, type).toBeGreaterThan(100)
        }
        const [r0, g0, b0] = at(150, 675)
        expect(r0).toBeGreaterThan(200)
        expect(g0).toBeGreaterThan(200)
        expect(b0).toBeLessThan(80)
      } finally {
        free(pix)
      }
    })
  })

  it('a comment with no date (/M) has none, not 1970', async () => {
    const list = marks(await bare(), 0)
    expect(list.length).toBe(10)
    for (const m of list) expect(m.modified).toBe(0)
  })

  it('the drawing is for display only: nothing is written into the file', async () => {
    const bytes = await bare()
    const saved = withDoc(bytes, (doc) => {
      renderPage(doc, 0, { scale: 1 })
      return saveBytes(doc)
    })
    withDoc(saved, (doc) => {
      const annots = doc.findPage(0).get('Annots')
      for (let i = 0; i < annots.length; i++) expect(annots.get(i).get('AP').isNull()).toBe(true)
    })
  })
})

// --- replies and review states keep their parent -------------------------------------------------

/** Page 1: a comment and an unrelated one. Page 2: a reply to the first, its review state, an unrelated note. */
function threaded(bytes: Uint8Array): Uint8Array {
  return withDoc(bytes, (doc) => {
    const one = doc.loadPage(0) as mupdf.PDFPage
    const two = doc.loadPage(1) as mupdf.PDFPage
    const note = (page: mupdf.PDFPage, text: string, at: number): mupdf.PDFAnnotation => {
      const a = page.createAnnotation('Text')
      a.setRect([at, 60, at + 20, 80])
      a.setContents(text)
      a.update()
      return a
    }
    const parent = note(one, 'Parent', 60)
    note(one, 'Alone', 200)
    const reply = note(two, 'Reply', 60)
    reply.getObject().put('IRT', parent.getObject())
    const state = note(two, 'Accepted set by Reviewer', 60)
    state.getObject().put('IRT', parent.getObject())
    state.getObject().put('State', doc.newString('Accepted'))
    state.getObject().put('StateModel', doc.newString('Review'))
    const replyToReply = note(two, 'Reply to reply', 60)
    replyToReply.getObject().put('IRT', reply.getObject())
    note(two, 'Other', 300)
    free(one, two)
    return saveBytes(doc)
  })
}

const marks = (bytes: Uint8Array, page: number) => withDoc(bytes, (doc) => pageMarkups(doc, page))

describe('replies and review states keep their parent', () => {
  it('lists each reply with the comment it answers, and a review state as a state', async () => {
    const src = threaded(await makeLatinPdf(2))
    const parent = marks(src, 0).find((m) => m.text === 'Parent')!
    expect(parent.id).toBeGreaterThan(0)
    const two = marks(src, 1)
    const reply = two.find((m) => m.text === 'Reply')!
    expect(reply.replyTo).toBe(parent.id)
    expect(two.find((m) => m.text === 'Reply to reply')!.replyTo).toBe(reply.id)
    const state = two.find((m) => m.text.startsWith('Accepted'))!
    expect(state.replyTo).toBe(parent.id)
    expect(state.state).toBe('Accepted')
    expect(two.find((m) => m.text === 'Other')!.replyTo).toBeUndefined()
  })

  it('deleting a comment removes its replies and state, also on another page', async () => {
    const src = threaded(await makeLatinPdf(2))
    const parent = marks(src, 0).find((m) => m.text === 'Parent')!
    const out = removeMarkup(src, 0, parent.index, parent.box)
    expect(marks(out, 0).map((m) => m.text)).toEqual(['Alone'])
    expect(marks(out, 1).map((m) => m.text)).toEqual(['Other'])
  })

  it('Combine and Insert keep a reply on another page attached to its comment', async () => {
    const src = threaded(await makeLatinPdf(2))
    for (const out of [mergePdfs([{ bytes: await makeLatinPdf(1) }, { bytes: src }]), insertPdfPages(await makeLatinPdf(1), 1, src)]) {
      const parent = marks(out, 1).find((m) => m.text === 'Parent')!
      const two = marks(out, 2)
      expect(two.find((m) => m.text === 'Reply')!.replyTo).toBe(parent.id)
      expect(two.find((m) => m.text.startsWith('Accepted'))!.replyTo).toBe(parent.id)
      expect(two.find((m) => m.text === 'Reply to reply')!.replyTo).toBe(two.find((m) => m.text === 'Reply')!.id)
    }
  })

  it('the Comments panel shows replies and states under their comment, from any page', async () => {
    const src = threaded(await makeLatinPdf(2))
    const items = [0, 1].flatMap((p) => marks(src, p).map((m) => ({ ...m, page: p })))
    const threads = commentThreads(items)
    expect(threads.top.map((m) => m.text)).toEqual(['Parent', 'Alone', 'Other'])
    const parent = threads.top[0]!
    expect(threads.repliesOf(parent).map((r) => [r.text, r.depth, r.page])).toEqual([
      ['Reply', 1, 1],
      ['Reply to reply', 2, 1]
    ])
    expect(threads.statesOf(parent).map((s) => s.state)).toEqual(['Accepted'])
    // A loop of replies with no comment at its head is shown, not lost.
    const loop = commentThreads([
      { id: 1, replyTo: 2, text: 'a' },
      { id: 2, replyTo: 1, text: 'b' }
    ])
    expect(loop.top.map((m) => m.text)).toEqual(['a', 'b'])
  })

  it('a review state whose comment was not brought along is left out; a reply becomes a comment of its own', async () => {
    const src = threaded(await makeLatinPdf(2))
    const out = insertPdfPages(await makeLatinPdf(1), 1, src, [1])
    const texts = marks(out, 1).map((m) => [m.text, m.replyTo ?? null])
    expect(texts.find(([t]) => t === 'Reply')).toEqual(['Reply', null])
    expect(texts.some(([t]) => String(t).startsWith('Accepted'))).toBe(false)
  })
})

// --- four clicks select the page's text ----------------------------------------------------------

describe('four clicks select the whole page', () => {
  it('selects every line of the page, wherever the click was', async () => {
    const lines = withDoc(await makeLatinPdf(1), (doc) => extractLines(doc, 0))
    for (const at of [[60, 60], [390, 590]] as Array<[number, number]>) {
      const s = selectText(lines, at, at, 'page')
      expect(s?.text).toContain('Page 1')
      expect(s?.text).toContain('Marker1')
      expect(s?.boxes.length).toBe(lines.filter((l) => l.glyphs.length).length)
    }
  })
})

// --- page pictures map pixel for pixel to the screen ---------------------------------------------

describe('page pictures at the exact size shown', () => {
  it('renders exactly the pixels asked for, upright and turned pages alike', async () => {
    for (const rotate of [0, 90] as const) {
      withDoc(await makeLatinPdf(1, { rotate }), (doc) => {
        for (const size of [
          [333, 501],
          [517, 777],
          [1001, 1499]
        ] as Array<[number, number]>) {
          const want: [number, number] = rotate ? [size[1], size[0]] : size
          const r = renderPage(doc, 0, { scale: 1, size: want })
          expect([r.width, r.height]).toEqual(want)
        }
      })
    }
  })

  it('the address names the exact size, so it never stands for two pictures', () => {
    const quantised = pageUrl('doc 1', 7, 2, 1.25)
    expect(pageAddress(new URL(quantised).pathname)).toEqual({ docId: 'doc 1', revision: 7, page: 2, scale: 1.25 })
    const exact = pageUrl('doc 1', 7, 2, 1.2345678, [333, 501])
    expect(exact).not.toBe(pageUrl('doc 1', 7, 2, 1.2345678, [334, 501]))
    expect(pageAddress(new URL(exact).pathname)).toEqual({ docId: 'doc 1', revision: 7, page: 2, scale: 1.235, size: [333, 501] })
  })
})

// --- pen strokes as smooth curves ----------------------------------------------------------------

/** The largest turn, in degrees, between consecutive segments of a stroke. */
function sharpestTurn(points: number[][]): number {
  let worst = 0
  for (let i = 1; i + 1 < points.length; i++) {
    const [ax, ay] = [points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!]
    const [bx, by] = [points[i + 1]![0]! - points[i]![0]!, points[i + 1]![1]! - points[i]![1]!]
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI)
  }
  return worst
}

describe('pen strokes are smooth curves through their points', () => {
  it('stores a curve through every point drawn, with no sharp corners', async () => {
    const zigzag: Array<[number, number]> = [
      [100, 100],
      [150, 60],
      [200, 100],
      [250, 140],
      [300, 100]
    ]
    expect(sharpestTurn(zigzag)).toBeGreaterThan(70)
    const { bytes } = addMarkup(await makeLatinPdf(1), 0, { kind: 'ink', strokes: [zigzag], colour: [1, 0, 0], width: 2 })
    const stored = withDoc(bytes, (doc) => {
      const page = doc.loadPage(0) as mupdf.PDFPage
      try {
        return page.getAnnotations()[0]!.getInkList()[0]!.map((p) => [p[0]!, p[1]!])
      } finally {
        free(page)
      }
    })
    expect(stored.length).toBeGreaterThan(zigzag.length * 4)
    for (const p of zigzag) expect(stored.some((q) => Math.hypot(q[0]! - p[0], q[1]! - p[1]) < 0.01)).toBe(true)
    expect(sharpestTurn(stored)).toBeLessThan(25)
  })

  it('leaves a straight two-point stroke and a dot as they are', async () => {
    const { bytes } = addMarkup(await makeLatinPdf(1), 0, {
      kind: 'ink',
      strokes: [
        [
          [50, 50],
          [150, 50]
        ],
        [[200, 200]]
      ],
      colour: [0, 0, 0],
      width: 2
    })
    const list = withDoc(bytes, (doc) => {
      const page = doc.loadPage(0) as mupdf.PDFPage
      try {
        return page.getAnnotations()[0]!.getInkList()
      } finally {
        free(page)
      }
    })
    expect(list[0]!.length).toBe(2)
    expect(list[1]!.length).toBe(2)
  })
})

// --- staging files are created exclusively -------------------------------------------------------

describe('temporary files never write through a planted file or link', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hono-staging-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('Save does not write through a file planted at the old temporary name', async () => {
    const path = join(dir, 'a.pdf')
    writeFileSync(path, await makeLatinPdf(2))
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched')
    // The name the save used to write first (predictable: the process id), as a hard link to another file.
    linkSync(victim, join(dir, `.a.pdf.${process.pid}.tmp`))
    const sessions = new Sessions()
    const doc = await sessions.openFile(path)
    await sessions.apply(doc.id, { op: 'watermark', text: 'SAVED', rotation: 0 })
    await sessions.save(doc.id)
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
    expect(readdirSync(dir).sort()).toEqual(['.a.pdf.' + process.pid + '.tmp', 'a.pdf', 'victim.txt'].sort())
  })

  it('takes another name when the staging name exists, and leaves nothing behind', async () => {
    const target = join(dir, 'out.pdf')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched')
    linkSync(victim, join(dir, '.out.pdf.first.tmp'))
    await writeStaged(target, new Uint8Array([1, 2, 3]), ['first', 'second'][Symbol.iterator]())
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
    expect(readdirSync(dir).sort()).toEqual(['.out.pdf.first.tmp', 'out.pdf', 'victim.txt'])
  })

  it('refuses when every name it tries is taken', async () => {
    writeFileSync(join(dir, '.out.pdf.x.tmp'), 'planted')
    await expect(writeStaged(join(dir, 'out.pdf'), new Uint8Array([1]), ['x', 'x'][Symbol.iterator]())).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['.out.pdf.x.tmp'])
  })

  it('replaces a link at the target instead of writing through it', async () => {
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'untouched')
    const target = join(dir, 'out.pdf')
    linkSync(victim, target)
    await writeStaged(target, new Uint8Array([7]))
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
    expect([...readFileSync(target)]).toEqual([7])
  })
})

// --- Compare: one rewritten sentence is one change ---------------------------------------------

describe('Compare: a short common word does not split a rewritten sentence', () => {
  it('shows a rewritten sentence as one change', () => {
    const a = textWords('Page 3, paragraph 5: the same words in both versions.')
    const b = textWords('This sentence was rewritten in the second version.')
    const changes = diffWords(a, b, OPTIONS)
    expect(changes).toEqual([{ kind: 'replace', a: [0, a.length], b: [0, b.length] }])
  })

  it('keeps two edits apart when more than two words, or a longer word, lie between', () => {
    const a = textWords('The red car and the blue bus went home')
    const b = textWords('The green car and the yellow bus went home')
    expect(diffWords(a, b, OPTIONS)).toHaveLength(2)
    const c = textWords('Invoice total 1,000 AED paid yesterday 1,037 AED')
    const d = textWords('Invoice total 1,200 AED paid yesterday 1,040 AED')
    expect(diffWords(c, d, OPTIONS)).toHaveLength(2)
  })

  it('still finds a single changed word', () => {
    const a = textWords('The quick brown fox jumps over the lazy dog')
    const b = textWords('The quick brown fox jumps over the lazy cat')
    expect(diffWords(a, b, OPTIONS)).toEqual([{ kind: 'replace', a: [8, 9], b: [8, 9] }])
  })
})

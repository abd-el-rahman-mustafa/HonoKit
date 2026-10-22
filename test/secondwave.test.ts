import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { dropXfa, formFields, xfaKind } from '@engine/forms'
import { free, mupdf, openPdf, type PdfDoc } from '@engine/mupdf'
import { documentOutline, pageLinks } from '@engine/navigation'
import { applyOperation } from '@ops/index'
import { makeFormWithBookmarks, makeLatinPdf } from './fixtures'

/**
 * Second wave of the 2026-10-08 fixes: Replace's reasons, hybrid and
 * dynamic XFA forms, Remove hidden information, bookmarks and links.
 */

/** Edits a PDF's objects directly with MuPDF (the fixture is ours, not a person's file). */
function withDoc(bytes: Uint8Array, edit: (doc: PdfDoc) => void): Uint8Array {
  const doc = new mupdf.PDFDocument(bytes)
  try {
    edit(doc)
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array())
  } finally {
    doc.destroy()
  }
}

const dict = (doc: PdfDoc, entries: Record<string, unknown>): mupdf.PDFObject => {
  const d = doc.newDictionary()
  for (const [k, v] of Object.entries(entries)) d.put(k, v as never)
  return d
}

// --- 1. Replace: the reason nothing was replaced ----------------------------------------------

async function paragraphs(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(new Uint8Array(readFileSync('resources/fonts/NotoSans-Regular.ttf')), { subset: true })
  const page = pdf.addPage([420, 320])
  const first = ['The report covers the quarter in detail and', 'the quarter results are good for the team', 'and the board thanks every member of staff']
  first.forEach((t, i) => page.drawText(t, { x: 40, y: 260 - i * 16, size: 12, font }))
  page.drawText('A separate note mentions the quarter once.', { x: 40, y: 160, size: 12, font })
  return new Uint8Array(await pdf.save())
}

describe('Replace all says why nothing was replaced', () => {
  it('a match across a line break: the "runs onto the next line" sentence', async () => {
    const src = await paragraphs()
    const failure = await applyOperation(src, { op: 'replaceAll', find: 'detail and the quarter', replace: 'detail', matchCase: false, wholeWords: false }).catch((e) => e)
    expect(failure).toMatchObject({ code: 'edit-unsafe', key: 'error.replaceWraps' })
    expect(String(failure.message)).toMatch(/onto the next/)
  })

  it('new words that do not fit: the "would not fit" sentence', async () => {
    const src = await paragraphs()
    const failure = await applyOperation(src, { op: 'replaceAll', find: 'once.', replace: 'once more, as the board of directors asked in its long letter.', matchCase: false, wholeWords: false }).catch((e) => e)
    expect(failure).toMatchObject({ code: 'edit-unsafe', key: 'error.replaceNoFit' })
    expect(String(failure.message)).toMatch(/would not fit/)
  })
})

// --- 2. XFA forms ------------------------------------------------------------------------------

async function hybridForm(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 400])
  pdf.getForm().createTextField('name').addToPage(page, { x: 40, y: 320, width: 300, height: 24 })
  return withDoc(new Uint8Array(await pdf.save()), (doc) => {
    const acro = doc.getTrailer().get('Root').get('AcroForm')
    const xfa = doc.newArray()
    xfa.push(doc.newString('template'))
    xfa.push(doc.addStream('<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"/>', {}))
    xfa.push(doc.newString('datasets'))
    xfa.push(doc.addStream('<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><name>Old</name></form></xfa:data></xfa:datasets>', {}))
    acro.put('XFA', xfa)
  })
}

async function dynamicForm(): Promise<Uint8Array> {
  return withDoc(await makeLatinPdf(1), (doc) => {
    const root = doc.getTrailer().get('Root')
    const xfa = doc.newArray()
    xfa.push(doc.newString('template'))
    xfa.push(doc.addStream('<template/>', {}))
    root.put('AcroForm', doc.addObject(dict(doc, { Fields: doc.newArray(), XFA: xfa })))
    root.put('NeedsRendering', true)
  })
}

const kindOf = (bytes: Uint8Array): ReturnType<typeof xfaKind> => {
  const doc = openPdf(bytes)
  try {
    return xfaKind(doc)
  } finally {
    free(doc)
  }
}

describe('XFA forms', () => {
  it('tells hybrid from dynamic forms', async () => {
    expect(kindOf(await hybridForm())).toBe('hybrid')
    expect(kindOf(await dynamicForm())).toBe('dynamic')
    expect(kindOf(await makeLatinPdf(1))).toBeNull()
  })

  it('filling a hybrid form drops its XFA, so Acrobat shows the filled value (as Acrobat saves it)', async () => {
    const src = await hybridForm()
    const r = await applyOperation(src, { op: 'fillForm', values: [{ page: 0, index: 0, value: 'Aisha' }] })
    expect(kindOf(r.bytes)).toBeNull()
    const doc = openPdf(r.bytes)
    try {
      expect(formFields(doc)[0]?.value).toBe('Aisha')
      expect(doc.getTrailer().get('Root').get('AcroForm').get('Fields').length).toBe(1)
    } finally {
      free(doc)
    }
  })

  it('adding or removing a field drops the XFA too', async () => {
    const added = await applyOperation(await hybridForm(), { op: 'addFields', fields: [{ page: 0, box: [40, 200, 200, 224], kind: 'text', name: 'city' }] })
    expect(kindOf(added.bytes)).toBeNull()
    const removed = await applyOperation(await hybridForm(), { op: 'removeField', page: 0, index: 0 })
    expect(kindOf(removed.bytes)).toBeNull()
  })

  it('refuses to fill a dynamic XFA form, with its own sentence', async () => {
    const failure = await applyOperation(await dynamicForm(), { op: 'fillForm', values: [{ page: 0, index: 0, value: 'x' }] }).catch((e) => e)
    expect(failure).toMatchObject({ code: 'unsupported', key: 'xfa.dynamic' })
  })

  it('dropXfa leaves a form without XFA alone', async () => {
    const doc = openPdf(await makeLatinPdf(1))
    try {
      expect(dropXfa(doc)).toBe(false)
    } finally {
      free(doc)
    }
  })
})

// --- 3. Remove hidden information ---------------------------------------------------------

async function hiddenInformation(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([400, 400])
  page.drawText('Secret words here', { x: 40, y: 300, size: 18, font })
  page.drawText('Public text', { x: 40, y: 100, size: 18, font })
  const field = pdf.getForm().createTextField('who')
  field.addToPage(page, { x: 200, y: 200, width: 150, height: 24 })
  return withDoc(new Uint8Array(await pdf.save()), (doc) => {
    const root = doc.getTrailer().get('Root')
    const pageObj = doc.findPage(0)
    const js = (code: string): mupdf.PDFObject => dict(doc, { S: doc.newName('JavaScript'), JS: doc.newString(code) })
    const file = doc.addObject(dict(doc, { Type: doc.newName('Filespec'), F: doc.newString('secret.txt') }))
    root.put('AF', doc.newArray())
    root.get('AF').push(file)
    root.put('PieceInfo', dict(doc, { Illustrator: dict(doc, { Private: doc.newString('data') }) }))
    pageObj.put('PieceInfo', dict(doc, { Illustrator: dict(doc, { Private: doc.newString('data') }) }))
    pageObj.put('Thumb', doc.addStream('thumb', {}))
    pageObj.put('AF', doc.newArray())
    const rect = (a: number[]): mupdf.PDFObject => {
      const r = doc.newArray()
      for (const v of a) r.push(v)
      return r
    }
    const annots = pageObj.get('Annots')
    const popup = doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Popup'), Rect: rect([300, 300, 380, 360]) }))
    const attachment = doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('FileAttachment'), Rect: rect([10, 10, 30, 30]), FS: file, Popup: popup }))
    const scriptLink = doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Link'), Rect: rect([40, 40, 120, 60]), A: js('app.alert(1)') }))
    const pageLink = doc.addObject(
      dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Link'), Rect: rect([40, 70, 120, 90]), A: dict(doc, { S: doc.newName('URI'), URI: doc.newString('https://example.com') }) })
    )
    annots.push(attachment)
    annots.push(popup)
    annots.push(scriptLink)
    annots.push(pageLink)
    // A script on the field, and one on the page.
    const widget = annots.get(0)
    widget.put('AA', dict(doc, { K: js('event.value = 1') }))
    pageObj.put('AA', dict(doc, { O: js('app.alert(2)') }))
    root.get('AcroForm').put('XFA', doc.newArray())
  })
}

describe('Remove hidden information (redaction with sanitize)', () => {
  it('removes attachments, associated files, private data, thumbnails, scripts, risky actions and XFA', async () => {
    const src = await hiddenInformation()
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [35, 75, 250, 105] }] })
    const r = await applyOperation(marked.bytes, { op: 'redactApply', fill: '#000000', sanitize: true })
    const doc = openPdf(r.bytes)
    try {
      const root = doc.getTrailer().get('Root')
      for (const key of ['AF', 'PieceInfo']) expect(root.get(key).isNull()).toBe(true)
      expect(root.get('AcroForm').get('XFA').isNull()).toBe(true)
      const pageObj = doc.findPage(0)
      for (const key of ['AF', 'PieceInfo', 'Thumb', 'AA']) expect(pageObj.get(key).isNull()).toBe(true)
      const annots = pageObj.get('Annots')
      const types: string[] = []
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i)
        types.push(a.get('Subtype').asName())
        expect(a.get('AA').isNull()).toBe(true)
        const action = a.get('A')
        if (!action.isNull()) expect(action.get('S').asName()).not.toBe('JavaScript')
      }
      expect(types).not.toContain('FileAttachment')
      expect(types).not.toContain('Popup')
      // The web link stays (and is followed by readers), the script link is disarmed.
      const links = pageLinks(doc, 0)
      expect(links.some((l) => l.uri === 'https://example.com')).toBe(true)
      // The field stays, without its script.
      expect(formFields(doc)).toHaveLength(1)
    } finally {
      free(doc)
    }
  })

  it('removes metadata, private data and associated files from images and forms, keeping resource names', async () => {
    const src = withDoc(await makeLatinPdf(1), (doc) => {
      const xmp = (): mupdf.PDFObject => doc.addStream('<x:xmpmeta><exif:GPSLatitude>25,12N</exif:GPSLatitude></x:xmpmeta>', dict(doc, { Type: doc.newName('Metadata'), Subtype: doc.newName('XML') }))
      const image = doc.addStream('\x80', dict(doc, { Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: doc.newName('DeviceGray'), Metadata: xmp() }))
      const bbox = doc.newArray()
      for (const v of [0, 0, 10, 10]) bbox.push(v)
      const files = doc.newArray()
      files.push(doc.addObject(dict(doc, { Type: doc.newName('Filespec'), F: doc.newString('source.psd') })))
      const form = doc.addStream('0 0 10 10 re f', dict(doc, { Type: doc.newName('XObject'), Subtype: doc.newName('Form'), BBox: bbox, Metadata: xmp(), AF: files, PieceInfo: dict(doc, { Illustrator: dict(doc, { Private: doc.newString('layers') }) }) }))
      const page = doc.findPage(0)
      page.get('Resources').put('XObject', dict(doc, { Im1: image, Fm1: form }))
      const contents = doc.addStream('q 10 0 0 10 300 40 cm /Im1 Do Q q 1 0 0 1 300 60 cm /Fm1 Do Q', {})
      const old = page.get('Contents')
      if (old.isArray()) old.push(contents)
      else {
        const all = doc.newArray()
        all.push(old)
        all.push(contents)
        page.put('Contents', all)
      }
      // A producer may call a resource Metadata or PieceInfo: those names are not hidden data.
      const look = doc.addStream('q 10 0 0 10 0 0 cm /Metadata Do Q q 10 0 0 10 10 0 cm /PieceInfo Do Q', dict(doc, { Type: doc.newName('XObject'), Subtype: doc.newName('Form'), BBox: bbox, Resources: dict(doc, { XObject: dict(doc, { Metadata: image, PieceInfo: image }) }) }))
      const rect = doc.newArray()
      for (const v of [300, 300, 320, 310]) rect.push(v)
      page.get('Annots').push(doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Stamp'), Rect: rect, AP: dict(doc, { N: look }) })))
    })
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [35, 75, 250, 105] }] })
    const r = await applyOperation(marked.bytes, { op: 'redactApply', fill: '#000000', sanitize: true })
    const doc = openPdf(r.bytes)
    try {
      const xobjects = doc.findPage(0).get('Resources').get('XObject')
      const kinds: string[] = []
      xobjects.forEach((value) => {
        kinds.push(value.get('Subtype').asName())
        for (const key of ['Metadata', 'AF', 'PieceInfo']) expect(value.get(key).isNull()).toBe(true)
      })
      expect(kinds).toEqual(expect.arrayContaining(['Image', 'Form']))
      const annots = doc.findPage(0).get('Annots')
      let stamp: mupdf.PDFObject | undefined
      for (let i = 0; i < annots.length; i++) if (annots.get(i).get('Subtype').asName() === 'Stamp') stamp = annots.get(i)
      const names = stamp!.get('AP').get('N').get('Resources').get('XObject')
      for (const name of ['Metadata', 'PieceInfo']) expect(names.get(name).isStream()).toBe(true)
      expect(Buffer.from(doc.saveToBuffer('decompress').asUint8Array()).toString('latin1')).not.toContain('GPSLatitude')
    } finally {
      free(doc)
    }
  })
})

// --- 4. Bookmarks ----------------------------------------------------------------------------

/** Three pages; bookmarks: Part 1 (page 1, with children at points on pages 2 and 3), a web address. */
async function nestedOutline(): Promise<Uint8Array> {
  return withDoc(await makeLatinPdf(3), (doc) => {
    const root = doc.getTrailer().get('Root')
    const xyz = (page: number, x: number, y: number): mupdf.PDFObject => {
      const d = doc.newArray()
      d.push(doc.findPage(page))
      d.push(doc.newName('XYZ'))
      d.push(x)
      d.push(y)
      d.push(0)
      return d
    }
    const outlines = doc.addObject(dict(doc, { Type: doc.newName('Outlines') }))
    const part = doc.addObject(dict(doc, { Title: doc.newString('Part 1'), Parent: outlines, Dest: xyz(0, 0, 792) }))
    const web = doc.addObject(dict(doc, { Title: doc.newString('موقعنا'), Parent: outlines, A: dict(doc, { S: doc.newName('URI'), URI: doc.newString('https://example.com/') }) }))
    const a = doc.addObject(dict(doc, { Title: doc.newString('Chapter A'), Parent: part, Dest: xyz(1, 72, 600) }))
    const b = doc.addObject(dict(doc, { Title: doc.newString('Chapter B'), Parent: part, Dest: xyz(2, 0, 400) }))
    a.put('Next', b)
    b.put('Prev', a)
    part.put('First', a)
    part.put('Last', b)
    part.put('Count', 2)
    part.put('Next', web)
    web.put('Prev', part)
    outlines.put('First', part)
    outlines.put('Last', web)
    outlines.put('Count', 4)
    root.put('Outlines', outlines)
  })
}

describe('bookmarks', () => {
  it('reads nested bookmarks with their pages and points, and keeps a web address unopened', async () => {
    const doc = openPdf(await nestedOutline())
    try {
      const height = doc.loadPage(1).getBounds()[3]
      const outline = documentOutline(doc)
      expect(outline.map((o) => o.title)).toEqual(['Part 1', 'موقعنا'])
      expect(outline[0]).toMatchObject({ page: 0, open: true })
      expect(outline[0]!.children.map((c) => [c.title, c.page])).toEqual([
        ['Chapter A', 1],
        ['Chapter B', 2]
      ])
      // Points come back as displayed: top-left origin.
      const point = outline[0]!.children[0]!.point!
      expect(point[0]).toBeCloseTo(72, 0)
      expect(point[1]).toBeCloseTo(height - 600, 0)
      expect(outline[1]).toMatchObject({ page: null, uri: 'https://example.com/' })
    } finally {
      free(doc)
    }
  })

  it('reads the bookmarks other programs make, and none when there are none', async () => {
    const doc = openPdf(await makeFormWithBookmarks(3))
    try {
      expect(documentOutline(doc).map((o) => [o.title, o.page])).toEqual([
        ['Chapter 1', 0],
        ['Chapter 2', 1],
        ['Chapter 3', 2]
      ])
    } finally {
      free(doc)
    }
    const plain = openPdf(await makeLatinPdf(2))
    try {
      expect(documentOutline(plain)).toEqual([])
    } finally {
      free(plain)
    }
  })
})

// --- 5. Links ---------------------------------------------------------------------------------

describe('links', () => {
  it('reads links to pages of the document (with the point) and to web addresses', async () => {
    const bytes = withDoc(await makeLatinPdf(2), (doc) => {
      const pageObj = doc.findPage(0)
      const rect = (a: number[]): mupdf.PDFObject => {
        const r = doc.newArray()
        for (const v of a) r.push(v)
        return r
      }
      const dest = doc.newArray()
      dest.push(doc.findPage(1))
      dest.push(doc.newName('XYZ'))
      dest.push(50)
      dest.push(500)
      dest.push(0)
      const annots = doc.newArray()
      annots.push(doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Link'), Rect: rect([40, 700, 200, 720]), Dest: dest })))
      annots.push(doc.addObject(dict(doc, { Type: doc.newName('Annot'), Subtype: doc.newName('Link'), Rect: rect([40, 650, 200, 670]), A: dict(doc, { S: doc.newName('URI'), URI: doc.newString('https://example.com/a') }) })))
      pageObj.put('Annots', annots)
    })
    const doc = openPdf(bytes)
    try {
      const height = doc.loadPage(0).getBounds()[3]
      const links = pageLinks(doc, 0)
      expect(links).toHaveLength(2)
      const internal = links.find((l) => l.page !== undefined)!
      expect(internal.page).toBe(1)
      expect(internal.point![1]).toBeCloseTo(doc.loadPage(1).getBounds()[3] - 500, 0)
      // Boxes are as displayed (top-left origin).
      expect(internal.box[1]).toBeCloseTo(height - 720, 0)
      const web = links.find((l) => l.uri)!
      expect(web.uri).toBe('https://example.com/a')
      expect(web.page).toBeUndefined()
      expect(pageLinks(doc, 1)).toEqual([])
      expect(pageLinks(doc, 9)).toEqual([])
    } finally {
      free(doc)
    }
  })
})

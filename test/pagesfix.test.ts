import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFNumber, PDFString, type PDFRef } from 'pdf-lib'
import { free, mupdf, openPdf, saveBytes, SAVE_FINAL, type PdfDoc } from '@engine/mupdf'
import { cropPages, duplicatePages, insertPdfPages, keepPages, mergePdfs, rotatePages, splitByRanges } from '@engine/pages'
import { renderPage } from '@engine/render'
import { contentOf } from '@engine/stamp'
import { extractText } from '@engine/text'
import { applyOperation } from '@ops/index'
import { parseRanges } from '@shared/pagelist'
import { makeImagePdf, makeLatinPdf } from './fixtures'

/**
 * Bugs fixed on 2026-10-08: duplicate shared page objects, merge/insert
 * dropped annotations, rearranging dropped the catalogue (labels, structure, language…), page
 * boxes, /UserUnit and odd /Rotate values, print usage, split ranges, and the q/Q wrapper.
 */

function withDoc<T>(bytes: Uint8Array, fn: (doc: PdfDoc) => T): T {
  const doc = openPdf(bytes)
  try {
    return fn(doc)
  } finally {
    free(doc)
  }
}

const textOf = (bytes: Uint8Array, page: number): string => withDoc(bytes, (d) => extractText(d, page))
const final = (bytes: Uint8Array): Uint8Array => withDoc(bytes, (d) => saveBytes(d, SAVE_FINAL))
const pageNums = (bytes: Uint8Array): number[] => withDoc(bytes, (d) => Array.from({ length: d.countPages() }, (_, i) => d.findPage(i).asIndirect()))
const labels = (bytes: Uint8Array): string[] =>
  withDoc(bytes, (d) =>
    Array.from({ length: d.countPages() }, (_, i) => {
      const p = d.loadPage(i)
      try {
        return p.getLabel()
      } finally {
        free(p)
      }
    })
  )

/** Every object of the file whose /Type is /Page: a copied page tree would show up here. */
function pageObjectCount(bytes: Uint8Array): number {
  return withDoc(bytes, (d) => {
    let n = 0
    for (let i = 1; i < d.countObjects(); i++) {
      const o = d.newIndirect(i).resolve()
      if (o.isDictionary() && o.get('Type').isName() && o.get('Type').asName() === 'Page') n++
    }
    return n
  })
}

/** Where `needle` is drawn on the page, as displayed (y down). */
function quadOf(bytes: Uint8Array, page: number, needle: string): [number, number, number, number] | null {
  return withDoc(bytes, (d) => {
    const p = d.loadPage(page)
    try {
      const hits = (p.search as (n: string) => unknown)(needle) as number[][][]
      const q = hits[0]?.[0]
      if (!q) return null
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!]
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!]
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    } finally {
      free(p)
    }
  })
}

const boundsOf = (bytes: Uint8Array, page: number): number[] =>
  withDoc(bytes, (d) => {
    const p = d.loadPage(page)
    try {
      return Array.from(p.getBounds())
    } finally {
      free(p)
    }
  })

const annotsOf = (doc: PdfDoc, page: number): mupdf.PDFObject[] => {
  const a = doc.findPage(page).get('Annots')
  return a.isArray() ? Array.from({ length: a.length }, (_, i) => a.get(i)) : []
}
const subtype = (o: mupdf.PDFObject): string => o.get('Subtype').asName()

/** Maximum q nesting reached by a page's content. */
function maxDepth(bytes: Uint8Array, page: number): number {
  return withDoc(bytes, (d) => {
    const s = new TextDecoder('latin1').decode(contentOf(d.findPage(page)))
    let depth = 0
    let max = 0
    for (const t of s.split(/[\s]+/)) {
      if (t === 'q') max = Math.max(max, ++depth)
      else if (t === 'Q') depth--
    }
    return max
  })
}

// --- fixtures ------------------------------------------------------------------------------

/** A page with a sticky note (and its popup) and a filled text field. */
async function annotatedPdf(pages = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await makeLatinPdf(pages))
  const ctx = pdf.context
  const page = pdf.getPage(0)
  const note = ctx.nextRef()
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [200, 400, 350, 500], Parent: note, P: page.ref }))
  ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 500, 320, 520], Contents: PDFString.of('Check this'), Popup: popup, P: page.ref }))
  page.node.set(PDFName.of('Annots'), ctx.obj([note, popup]))
  const field = pdf.getForm().createTextField('name')
  field.setText('Alice')
  field.addToPage(page, { x: 40, y: 300, width: 200, height: 24 })
  return new Uint8Array(await pdf.save())
}

/** Three pages; page 1 carries links to page 2 (explicit, named, GoTo) and to page 3, a URI link, a note and a field. */
async function donorPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await makeLatinPdf(3))
  const ctx = pdf.context
  const [p1, p2, p3] = pdf.getPages() as [ReturnType<typeof pdf.getPage>, ReturnType<typeof pdf.getPage>, ReturnType<typeof pdf.getPage>]
  const link = (rect: number[], extra: Record<string, unknown>): PDFRef => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, P: p1.ref, Border: [0, 0, 0], ...extra } as never))
  const note = ctx.nextRef()
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [200, 400, 350, 500], Parent: note, P: p1.ref }))
  ctx.assign(note, ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 500, 320, 520], Contents: PDFString.of('Donor note'), Popup: popup, P: p1.ref, StructParent: 7 }))
  const annots = [
    note,
    popup,
    link([10, 10, 50, 30], { Dest: [p2.ref, PDFName.of('Fit')] }),
    link([10, 40, 50, 60], { Dest: [p3.ref, PDFName.of('Fit')] }),
    link([10, 70, 50, 90], { Dest: PDFString.of('chapter2') }),
    link([10, 100, 50, 120], { A: { S: 'GoTo', D: [p2.ref, 'XYZ', 0, 500, 0] } }),
    link([10, 130, 50, 150], { A: { S: 'URI', URI: PDFString.of('https://example.com/') } })
  ]
  p1.node.set(PDFName.of('Annots'), ctx.obj(annots))
  pdf.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of('chapter2'), [p2.ref, 'Fit']] }) }))
  const field = pdf.getForm().createTextField('name')
  field.setText('Donor value')
  field.addToPage(p1, { x: 40, y: 200, width: 200, height: 24 })
  return new Uint8Array(await pdf.save())
}

/** Four pages labelled i, ii, A-5, A-6, with a language, viewer preferences, an open action and a tagged structure. */
async function catalogPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await makeLatinPdf(4))
  const ctx = pdf.context
  const pages = pdf.getPages()
  pdf.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D', P: PDFString.of('A-'), St: 5 }] }))
  pdf.catalog.set(PDFName.of('Lang'), PDFString.of('ar-AE'))
  pdf.catalog.set(PDFName.of('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }))
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseThumbs'))
  pdf.catalog.set(PDFName.of('OpenAction'), ctx.obj([pages[3]!.ref, 'Fit']))
  pdf.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }))
  const root = ctx.nextRef()
  const docElem = ctx.nextRef()
  const kids = pages.map((p, i) => ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: docElem, Pg: p.ref, K: 0, T: PDFString.of(`para${i + 1}`) })))
  ctx.assign(docElem, ctx.obj({ Type: 'StructElem', S: 'Document', P: root, K: kids }))
  const parentTree = ctx.obj({ Nums: kids.flatMap((k, i) => [i, [k]]) })
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: docElem, ParentTree: parentTree, ParentTreeNextKey: 4 }))
  pdf.catalog.set(PDFName.of('StructTreeRoot'), root)
  pages.forEach((p, i) => p.node.set(PDFName.of('StructParents'), PDFNumber.of(i)))
  return new Uint8Array(await pdf.save())
}

/** One 600×800 page per odd case: CropBox beyond the MediaBox, UserUnit 2, /Rotate 45. */
function oddBoxesPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const content = 'BT /F1 24 Tf 100 400 Td (Hello) Tj ET'
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  const res = doc.newDictionary()
  const fonts = doc.newDictionary()
  fonts.put('F1', font)
  res.put('Font', fonts)
  for (let i = 0; i < 3; i++) doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, res, content))
  const crop = doc.newArray()
  for (const v of [-50, -50, 700, 900]) crop.push(v)
  doc.findPage(0).put('CropBox', crop)
  doc.findPage(1).put('UserUnit', 2)
  doc.findPage(2).put('Rotate', 45)
  const out = new Uint8Array(doc.saveToBuffer('compress').asUint8Array())
  doc.destroy()
  return out
}

// --- 1. duplicate --------------------------------------------------------------------------

describe('duplicate gives each copy its own page', () => {
  it('uses a new page object for a repeated page', async () => {
    const pdf = await makeLatinPdf(2)
    const nums = pageNums(duplicatePages(pdf, [0]))
    expect(new Set(nums).size).toBe(3)
    expect(new Set(pageNums(keepPages(pdf, [1, 1, 0, 1]))).size).toBe(4)
  })

  it('rotating the copy leaves the original alone', async () => {
    const dup = duplicatePages(await makeLatinPdf(2), [0])
    const out = rotatePages(dup, [1], 90)
    withDoc(out, (d) => {
      expect(d.findPage(0).getInheritable('Rotate').asNumber() || 0).toBe(0)
      expect(d.findPage(1).getInheritable('Rotate').asNumber()).toBe(90)
    })
  })

  it('redacting the copy leaves the original, also after the final save', async () => {
    const dup = duplicatePages(await makeLatinPdf(2), [0])
    const q = quadOf(dup, 1, 'Marker1')!
    const marked = await applyOperation(dup, { op: 'redactMark', marks: [{ page: 1, box: [q[0] - 2, q[1] - 2, q[2] + 2, q[3] + 2] }] })
    const applied = await applyOperation(marked.bytes, { op: 'redactApply' })
    for (const bytes of [applied.bytes, final(applied.bytes)]) {
      expect(textOf(bytes, 0)).toContain('Marker1')
      expect(textOf(bytes, 1)).not.toContain('Marker1')
      expect(textOf(bytes, 2)).toContain('Marker2')
    }
  })

  it('redacting a picture on the copy leaves the original picture', async () => {
    const dup = duplicatePages(await makeImagePdf(400), [0])
    const marked = await applyOperation(dup, { op: 'redactMark', marks: [{ page: 1, box: [200, 200, 400, 400] }] })
    const applied = final((await applyOperation(marked.bytes, { op: 'redactApply' })).bytes)
    withDoc(applied, (d) => {
      const pixel = (page: number): [number, number, number] => {
        const r = renderPage(d, page, { scale: 0.25, format: 'png' })
        const pix = new mupdf.Image(r.data).toPixmap()
        const s = pix.getStride()
        const px = pix.getPixels()
        const at = 75 * s + 75 * pix.getNumberOfComponents()
        const out: [number, number, number] = [px[at]!, px[at + 1]!, px[at + 2]!]
        free(pix)
        return out
      }
      const [r, g, b] = pixel(0)
      expect(r + g + b).toBeGreaterThan(60) // the noise picture, not a black or white hole
      expect(pixel(1)).not.toEqual([r, g, b])
    })
  })

  it('markup on the copy stays on the copy', async () => {
    const dup = duplicatePages(await makeLatinPdf(2), [0])
    const { bytes } = await applyOperation(dup, { op: 'markup', page: 1, markup: { kind: 'rect', rect: [100, 100, 200, 160], colour: '#ff0000', width: 2 } })
    withDoc(final(bytes), (d) => {
      expect(annotsOf(d, 0)).toHaveLength(0)
      expect(annotsOf(d, 1)).toHaveLength(1)
    })
  })

  it('extracting a page twice in one selection gives each its own annotations', async () => {
    withDoc(final(keepPages(await annotatedPdf(), [0, 0])), (d) => {
      const first = annotsOf(d, 0)
      const second = annotsOf(d, 1)
      expect(second.length).toBe(first.length)
      const nums = new Set(first.map((a) => a.asIndirect()))
      for (const a of second) {
        expect(nums.has(a.asIndirect())).toBe(false)
        if (!a.get('P').isNull()) expect(a.get('P').asIndirect()).toBe(d.findPage(1).asIndirect())
      }
    })
  })

  it('copies the page’s annotations and widgets, pointing at the copy', async () => {
    const dup = duplicatePages(await annotatedPdf(), [0])
    withDoc(final(dup), (d) => {
      const original = annotsOf(d, 0)
      const copy = annotsOf(d, 1)
      expect(copy.map(subtype).sort()).toEqual(original.map(subtype).sort())
      const nums = new Set(original.map((a) => a.asIndirect()))
      for (const a of copy) {
        expect(nums.has(a.asIndirect())).toBe(false)
        expect(a.get('P').asIndirect()).toBe(d.findPage(1).asIndirect())
      }
      const note = copy.find((a) => subtype(a) === 'Text')!
      const popup = copy.find((a) => subtype(a) === 'Popup')!
      expect(note.get('Popup').asIndirect()).toBe(popup.asIndirect())
      expect(popup.get('Parent').asIndirect()).toBe(note.asIndirect())
      // The copied widget is another widget of the same field: one field, two widgets, one value.
      const fields = d.getTrailer().get('Root').get('AcroForm').get('Fields')
      expect(fields.length).toBe(1)
      expect(fields.get(0).get('Kids').length).toBe(2)
      expect(fields.get(0).get('V').asString()).toBe('Alice')
    })
  })

  it('splits a widget that is its own field into one field with two widgets', () => {
    const doc = new mupdf.PDFDocument()
    doc.insertPage(-1, doc.addPage([0, 0, 400, 600], 0, doc.newDictionary(), ''))
    const page = doc.findPage(0)
    const widget = doc.newDictionary()
    widget.put('Type', doc.newName('Annot'))
    widget.put('Subtype', doc.newName('Widget'))
    widget.put('FT', doc.newName('Tx'))
    widget.put('T', doc.newString('solo'))
    widget.put('V', doc.newString('kept'))
    const rect = doc.newArray()
    for (const v of [40, 40, 200, 64]) rect.push(v)
    widget.put('Rect', rect)
    widget.put('P', page)
    const ref = doc.addObject(widget)
    const annots = doc.newArray()
    annots.push(ref)
    page.put('Annots', annots)
    const form = doc.newDictionary()
    const fields = doc.newArray()
    fields.push(ref)
    form.put('Fields', fields)
    doc.getTrailer().get('Root').put('AcroForm', form)
    const pdf = new Uint8Array(doc.saveToBuffer('').asUint8Array())
    doc.destroy()
    withDoc(final(duplicatePages(pdf, [0])), (d) => {
      const list = d.getTrailer().get('Root').get('AcroForm').get('Fields')
      expect(list.length).toBe(1)
      const field = list.get(0)
      expect(field.get('T').asString()).toBe('solo')
      expect(field.get('V').asString()).toBe('kept')
      expect(field.get('Kids').length).toBe(2)
      for (const p of [0, 1]) {
        const [w] = annotsOf(d, p)
        expect(w!.get('Parent').asIndirect()).toBe(field.asIndirect())
        expect(w!.get('P').asIndirect()).toBe(d.findPage(p).asIndirect())
        expect(w!.get('T').isNull()).toBe(true)
      }
    })
  })
})

// --- 2. merge and insert keep annotations ---------------------------------------------------

describe('merge and insert keep annotations', () => {
  it('insert from a PDF keeps notes, popups, links and fields, rewired to the new pages', async () => {
    const base = await annotatedPdf(2)
    const out = final(insertPdfPages(base, 2, await donorPdf(), [0, 1]))
    expect(pageObjectCount(out)).toBe(4)
    withDoc(out, (d) => {
      const page = d.findPage(2)
      const target = d.findPage(3).asIndirect()
      const annots = annotsOf(d, 2)
      for (const a of annots) expect(a.get('P').asIndirect()).toBe(page.asIndirect())
      expect(annots.some((a) => a.get('StructParent').isNumber())).toBe(false)
      const note = annots.find((a) => subtype(a) === 'Text')!
      const popup = annots.find((a) => subtype(a) === 'Popup')!
      expect(note.get('Contents').asString()).toBe('Donor note')
      expect(popup.get('Parent').asIndirect()).toBe(note.asIndirect())
      const links = annots.filter((a) => subtype(a) === 'Link')
      // The link to donor page 3 (not inserted) is gone; the rest point at the inserted page 2.
      expect(links).toHaveLength(4)
      // (MuPDF's Null object cannot be asked for keys: check that /A is there first.)
      const internal = links.filter((l) => !(l.get('A').isDictionary() && l.get('A').get('URI').isString()))
      expect(internal).toHaveLength(3)
      for (const l of internal) {
        const dest = l.get('Dest').isArray() ? l.get('Dest') : l.get('A').get('D')
        expect(dest.isArray()).toBe(true)
        expect(dest.get(0).asIndirect()).toBe(target)
      }
      // The donor's field arrives as a field of its own, renamed because "name" is taken.
      const fields = d.getTrailer().get('Root').get('AcroForm').get('Fields')
      const names = Array.from({ length: fields.length }, (_, i) => fields.get(i).get('T').asString())
      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
      expect(names).toContain('name')
      const donorField = Array.from({ length: fields.length }, (_, i) => fields.get(i)).find((f) => f.get('T').asString() !== 'name')!
      expect(donorField.get('V').asString()).toBe('Donor value')
      expect(annots.some((a) => subtype(a) === 'Widget')).toBe(true)
    })
  })

  it('merge keeps every input’s annotations, links point inside their own part', async () => {
    const donor = await donorPdf()
    const out = final(mergePdfs([{ bytes: donor }, { bytes: donor }]))
    expect(pageObjectCount(out)).toBe(6)
    withDoc(out, (d) => {
      for (const [first, second] of [
        [0, 1],
        [3, 4]
      ] as const) {
        const links = annotsOf(d, first).filter((a) => subtype(a) === 'Link' && a.get('Dest').isArray())
        // To page 2 (explicit, and the named "chapter2" resolved to it) and to page 3 of its own part.
        expect(links.length).toBe(3)
        expect(links[0]!.get('Dest').get(0).asIndirect()).toBe(d.findPage(second).asIndirect())
        expect(annotsOf(d, first).find((a) => subtype(a) === 'Text')!.get('P').asIndirect()).toBe(d.findPage(first).asIndirect())
      }
      const fields = d.getTrailer().get('Root').get('AcroForm').get('Fields')
      expect(fields.length).toBe(2)
      expect(fields.get(0).get('T').asString()).not.toBe(fields.get(1).get('T').asString())
    })
  })

  it('inserting the same page twice gives two independent sets of annotations', async () => {
    const out = final(insertPdfPages(await makeLatinPdf(1), 1, await annotatedPdf(1), [0, 0]))
    withDoc(out, (d) => {
      const a = annotsOf(d, 1).map((x) => x.asIndirect())
      const b = annotsOf(d, 2).map((x) => x.asIndirect())
      expect(a.length).toBeGreaterThan(0)
      expect(b.length).toBe(a.length)
      expect(a.some((n) => b.includes(n))).toBe(false)
      for (const x of annotsOf(d, 2)) expect(x.get('P').asIndirect()).toBe(d.findPage(2).asIndirect())
    })
  })
})

// --- 3. rearranging keeps the catalogue --------------------------------------------------------

describe('rearranging keeps labels, structure and the rest of the catalogue', () => {
  it('keeps page labels with their pages', async () => {
    const pdf = await catalogPdf()
    expect(labels(pdf)).toEqual(['i', 'ii', 'A-5', 'A-6'])
    expect(labels(keepPages(pdf, [0, 2, 3]))).toEqual(['i', 'A-5', 'A-6'])
    expect(labels(keepPages(pdf, [3, 2, 1, 0]))).toEqual(['A-6', 'A-5', 'ii', 'i'])
    expect(labels(duplicatePages(pdf, [1]))).toEqual(['i', 'ii', 'ii', 'A-5', 'A-6'])
    expect(splitByRanges(pdf, [[2, 3]]).map(labels)).toEqual([['A-5', 'A-6']])
  })

  it('keeps language, viewer preferences and mark info; drops an open action to a deleted page', async () => {
    const pdf = await catalogPdf()
    const root = (bytes: Uint8Array): Record<string, string> =>
      withDoc(bytes, (d) => {
        const r = d.getTrailer().get('Root')
        const out: Record<string, string> = {}
        r.forEach((v, k) => (out[String(k)] = v.toString()))
        return out
      })
    const kept = root(keepPages(pdf, [3, 0]))
    expect(kept.Lang).toBe('(ar-AE)')
    expect(kept.ViewerPreferences).toContain('DisplayDocTitle')
    expect(kept.PageMode).toBe('/UseThumbs')
    expect(kept.MarkInfo).toContain('Marked')
    expect(kept.OpenAction).toBeDefined()
    expect(root(keepPages(pdf, [0, 1])).OpenAction).toBeUndefined()
  })

  it('keeps the structure tree on a reorder and prunes deleted pages from it', async () => {
    const pdf = await catalogPdf()
    const elements = (bytes: Uint8Array): string[] =>
      withDoc(bytes, (d) => {
        const str = d.getTrailer().get('Root').get('StructTreeRoot')
        if (!str.isDictionary()) return []
        const k = str.get('K').get('K')
        return Array.from({ length: k.length }, (_, i) => k.get(i).get('T').asString())
      })
    expect(elements(keepPages(pdf, [3, 2, 1, 0]))).toEqual(['para1', 'para2', 'para3', 'para4'])
    const pruned = final(keepPages(pdf, [0, 2]))
    expect(elements(pruned)).toEqual(['para1', 'para3'])
    // The deleted pages are really gone from the file, not kept alive by the structure.
    expect(pageObjectCount(pruned)).toBe(2)
    withDoc(pruned, (d) => {
      const nums = d.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree').get('Nums')
      for (let i = 1; i < nums.length; i += 2) {
        const v = nums.get(i)
        for (let j = 0; j < v.length; j++) if (!v.get(j).isNull()) expect(['para1', 'para3']).toContain(v.get(j).get('T').asString())
      }
    })
  })
})

// --- 4–6. boxes, UserUnit, odd rotation --------------------------------------------------------

describe('page boxes as MuPDF shows them', () => {
  it('crops a page whose CropBox reaches past its MediaBox', () => {
    const out = cropPages(oddBoxesPdf(), [0], { left: 10, top: 10, right: 10, bottom: 10 })
    expect(boundsOf(out, 0)).toEqual([0, 0, 580, 780])
  })

  it('crops a UserUnit 2 page by the displayed amount', () => {
    const pdf = oddBoxesPdf()
    expect(boundsOf(pdf, 1)).toEqual([0, 0, 1200, 1600])
    expect(boundsOf(cropPages(pdf, [1], { left: 10, top: 0, right: 30, bottom: 0 }), 1)).toEqual([0, 0, 1160, 1600])
  })

  it('treats /Rotate 45 as MuPDF does (90), for rotate and crop', () => {
    const pdf = oddBoxesPdf()
    expect(boundsOf(pdf, 2)).toEqual([0, 0, 800, 600])
    withDoc(rotatePages(pdf, [2], 90), (d) => expect(d.findPage(2).get('Rotate').asNumber()).toBe(180))
    // Displayed left edge of a page turned 90° is the bottom of its MediaBox.
    const cropped = cropPages(pdf, [2], { left: 40, top: 0, right: 0, bottom: 0 })
    expect(boundsOf(cropped, 2)).toEqual([0, 0, 760, 600])
    withDoc(cropped, (d) => expect(d.findPage(2).get('CropBox').get(1).asNumber()).toBe(40))
  })

  it.each([0, 1, 2])('places page numbers where they belong on odd page %i', async (page) => {
    const pdf = oddBoxesPdf()
    const { bytes } = await applyOperation(pdf, { op: 'pageNumbers', pages: [page], template: 'PN{n}', position: 'bottom-right', margin: 28, size: 12 })
    const b = boundsOf(bytes, page)
    // Numbered within the chosen pages, as Acrobat does (owner's decision N1): the one chosen page is 1.
    const q = quadOf(bytes, page, 'PN1')!
    expect(q).not.toBeNull()
    expect(Math.abs(q[2] - (b[2]! - 28))).toBeLessThan(3)
    expect(q[3]).toBeLessThan(b[3]! - 28 + 4)
    expect(q[3]).toBeGreaterThan(b[3]! - 28 - 6)
    expect(q[3] - q[1]).toBeLessThan(18) // 12 pt as displayed, not doubled by UserUnit
    expect(q[3] - q[1]).toBeGreaterThan(8)
  })
})

// --- 7. print usage ---------------------------------------------------------------------------

describe('printing draws annotations as printed, not as shown', () => {
  it('leaves out annotations without the Print flag and draws print-only ones', async () => {
    const doc = openPdf(await makeLatinPdf(1))
    try {
      const page = doc.loadPage(0)
      const square = (rect: [number, number, number, number], colour: [number, number, number], flags: number): void => {
        const a = page.createAnnotation('Square')
        a.setRect(rect)
        a.setColor(colour)
        a.setInteriorColor(colour)
        a.setFlags(flags)
        a.update()
      }
      square([20, 20, 120, 120], [1, 0, 0], 0) // screen only
      square([200, 20, 300, 120], [0, 0, 1], mupdf.PDFAnnotation.IS_PRINT | mupdf.PDFAnnotation.IS_NO_VIEW) // print only
      free(page)
      const bytes = saveBytes(doc)
      withDoc(bytes, (d) => {
        const colourAt = (annotations: boolean | 'print', x: number, y: number): number[] => {
          const r = renderPage(d, 0, { scale: 1, format: 'png', annotations })
          const pix = new mupdf.Image(r.data).toPixmap()
          const at = y * pix.getStride() + x * pix.getNumberOfComponents()
          const px = pix.getPixels()
          const out = [px[at]!, px[at + 1]!, px[at + 2]!]
          free(pix)
          return out
        }
        // (30, 100): inside the red square, clear of the fixture's "Page 1" and "Marker1" text.
        expect(colourAt(true, 30, 100)).toEqual([255, 0, 0])
        expect(colourAt('print', 30, 100)).toEqual([255, 255, 255])
        expect(colourAt('print', 250, 70)).toEqual([0, 0, 255])
        expect(colourAt(false, 30, 100)).toEqual([255, 255, 255])
      })
    } finally {
      free(doc)
    }
  })
})

// --- 8. split ranges ---------------------------------------------------------------------------

describe('split ranges', () => {
  it('splits ranges separated only by spaces, and still reads "1 - 3"', () => {
    expect(parseRanges('1-3 5-7', 10)).toEqual([
      [0, 2],
      [4, 6]
    ])
    expect(parseRanges('1 - 3', 10)).toEqual([[0, 2]])
    expect(parseRanges('1 - 3, 8-', 10)).toEqual([
      [0, 2],
      [7, 9]
    ])
  })
})

// --- placeOverlay: q/Q -------------------------------------------------------------------------

describe('stamps wrap the page once and survive unbalanced content', () => {
  it('thirty stamps on one page keep the nesting shallow', async () => {
    let bytes = await makeLatinPdf(1)
    for (let i = 0; i < 30; i++) bytes = (await applyOperation(bytes, { op: 'pageNumbers', template: `S${i}`, position: 'top-left' })).bytes
    expect(maxDepth(bytes, 0)).toBeLessThanOrEqual(3)
    expect(textOf(bytes, 0)).toContain('S29')
    expect(textOf(bytes, 0)).toContain('Marker1')
  })

  const rawPage = (content: string): Uint8Array => {
    const doc = new mupdf.PDFDocument()
    doc.insertPage(-1, doc.addPage([0, 0, 600, 800], 0, doc.newDictionary(), content))
    const out = new Uint8Array(doc.saveToBuffer('compress').asUint8Array())
    doc.destroy()
    return out
  }

  it.each([
    ['a scale left open', '0.5 0 0 0.5 0 0 cm q 1 0 0 RG 0 0 10 10 re S'],
    ['an extra Q', 'q Q Q 0.5 0 0 0.5 0 0 cm 0 0 10 10 re S'],
    ['an unclosed q', 'q 0.5 0 0 0.5 0 0 cm q 0 0 10 10 re S']
  ])('places the stamp at full size over %s', async (_, content) => {
    const { bytes } = await applyOperation(rawPage(content), { op: 'pageNumbers', template: 'PN{n}', position: 'bottom-right', margin: 28, size: 12 })
    const q = quadOf(bytes, 0, 'PN1')!
    expect(Math.abs(q[2] - 572)).toBeLessThan(3)
    expect(Math.abs(q[3] - 772)).toBeLessThan(6)
  })
})

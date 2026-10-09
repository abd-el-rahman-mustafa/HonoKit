import { PdfError } from './errors'
import { free, mupdf, newPdf, openPdf, saveBytes, type PdfDoc } from './mupdf'
import { carryPrintStandard, readPrintStandard, withdrawClaims, type PrintStandard } from './pdfx'

/**
 * Page-level operations: what moves, removes, rotates or trims whole pages.
 * Each takes PDF bytes and returns PDF bytes; none keeps a document open.
 */

function assertPages(doc: PdfDoc, pages: number[]): void {
  const count = doc.countPages()
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= count) throw new PdfError('bad-arguments', `Page ${p + 1} does not exist (the document has ${count}).`)
  }
}

export function pageCount(bytes: Uint8Array, password?: string): number {
  const doc = openPdf(bytes, password)
  try {
    return doc.countPages()
  } finally {
    free(doc)
  }
}

export function rotatePages(bytes: Uint8Array, pages: number[], angle: 90 | 180 | 270 | -90, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    assertPages(doc, pages)
    for (const index of new Set(pages)) {
      const page = doc.findPage(index)
      // From the turn readers show (MuPDF snaps /Rotate 45 to 90), not the raw number.
      page.put('Rotate', (((rotationOf(page) + angle) % 360) + 360) % 360)
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

export function deletePages(bytes: Uint8Array, pages: number[], password?: string): Uint8Array {
  const count = pageCount(bytes, password)
  assertPagesAgainst(count, pages)
  const gone = new Set(pages)
  if (gone.size >= count) throw new PdfError('bad-arguments', 'A document must keep at least one page.')
  return keepPages(
    bytes,
    Array.from({ length: count }, (_, i) => i).filter((i) => !gone.has(i)),
    password
  )
}

/**
 * Keeps the listed pages, in the listed order; a page may be listed twice. This is
 * extract, reorder, delete and duplicate in one operation.
 *
 * Done in place with MuPDF's rearrangePages rather than by copying pages into a
 * new document: a copy loses the document's bookmarks, form fields and everything
 * else that lives outside the pages (test/pages.test.ts checks both survive).
 */
export function keepPages(bytes: Uint8Array, pages: number[], password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    assertPages(doc, pages)
    const root = doc.getTrailer().get('Root')
    const acroForm = root.get('AcroForm')
    const catalog: Array<[string, mupdf.PDFObject]> = []
    root.forEach((value, key) => catalog.push([String(key), value]))
    const before = Array.from({ length: doc.countPages() }, (_, i) => doc.findPage(i).asIndirect())
    doc.rearrangePages(pages)
    separateRepeats(doc)
    restoreFormFields(doc, acroForm)
    restoreCatalog(doc, catalog, pages, before)
    // The output intent, Info and XMP stay (§82); a PDF/UA or PDF/A-a claim goes with the last tagged content.
    withdrawClaims(doc, { untagged: catalog.some(([k]) => k === 'StructTreeRoot') && doc.getTrailer().get('Root').get('StructTreeRoot').isNull() })
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

// --- One page object per page ------------------------------------------------------------------

/** A copy of a direct value (arrays and dictionaries are not shared); indirect objects stay shared. */
function clone(doc: PdfDoc, value: mupdf.PDFObject, depth = 0): mupdf.PDFObject {
  if (value.isIndirect() || depth > 32) return value
  if (value.isArray()) {
    const out = doc.newArray()
    for (let i = 0; i < value.length; i++) out.push(clone(doc, value.get(i), depth + 1))
    return out
  }
  if (value.isDictionary()) {
    const out = doc.newDictionary()
    value.forEach((v, k) => out.put(String(k), clone(doc, v, depth + 1)))
    return out
  }
  return value
}

/** A new stream object with the same (still encoded) data and a copy of the dictionary. */
function copyStream(doc: PdfDoc, stream: mupdf.PDFObject): mupdf.PDFObject {
  const dict = doc.newDictionary()
  stream.forEach((v, k) => {
    if (k !== 'Length') dict.put(String(k), clone(doc, v))
  })
  return doc.addRawStream(stream.readRawStream(), dict)
}

/** An annotation's appearances (/AP), with streams of their own, so redrawing one copy leaves the other. */
function copyAppearance(doc: PdfDoc, ap: mupdf.PDFObject): mupdf.PDFObject {
  if (!ap.isDictionary()) return ap
  const out = doc.newDictionary()
  ap.forEach((v, k) => {
    if (v.isStream()) out.put(String(k), copyStream(doc, v))
    else if (v.isDictionary()) {
      const states = doc.newDictionary()
      v.forEach((s, name) => states.put(String(name), s.isStream() ? copyStream(doc, s) : clone(doc, s)))
      out.put(String(k), states)
    } else out.put(String(k), clone(doc, v))
  })
  return out
}

const subtypeOf = (o: mupdf.PDFObject): string => {
  const s = o.get('Subtype')
  return s.isName() ? s.asName() : ''
}

/** The keys that belong to a form field rather than to its widget (PDF 32000 §12.7.3.1, §12.7.4). */
const FIELD_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'Opt', 'TI', 'I', 'MaxLen', 'Lock', 'SV', 'RV', 'DS'] as const

/** The array an object list in /Kids or /Annots is; created when missing. */
function arrayAt(doc: PdfDoc, owner: mupdf.PDFObject, key: string): mupdf.PDFObject {
  let list = owner.get(key)
  if (!list.isArray()) {
    list = doc.newArray()
    owner.put(key, list)
    list = owner.get(key)
  }
  return list
}

/**
 * Copies of a page's annotations for another page of the same document, as Acrobat's Duplicate
 * does: each copy is a new object pointing (/P) at the new page, a note's popup comes along, and a
 * widget becomes a second widget of the same field (same name, same value). A widget that is its
 * own field is split into a field with two widgets.
 */
function copyAnnotsWithin(doc: PdfDoc, annots: mupdf.PDFObject, page: mupdf.PDFObject): mupdf.PDFObject {
  const out = doc.newArray()
  if (!annots.isArray()) return out
  const map = new Map<number, mupdf.PDFObject>()
  const items: Array<[mupdf.PDFObject, mupdf.PDFObject]> = []
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i)
    if (!a.isDictionary()) continue
    const copy = doc.addObject(doc.newDictionary())
    if (a.isIndirect()) map.set(a.asIndirect(), copy)
    items.push([a, copy])
    out.push(copy)
  }
  const local = (v: mupdf.PDFObject): mupdf.PDFObject | undefined => (v.isIndirect() ? map.get(v.asIndirect()) : undefined)
  for (const [a, copy] of items) {
    const widget = subtypeOf(a) === 'Widget'
    a.forEach((v, key) => {
      const k = String(key)
      if (k === 'P' || k === 'StructParent') return
      if (k === 'Popup' || k === 'IRT' || (k === 'Parent' && !widget)) {
        const to = local(v)
        if (to) copy.put(k, to)
        else if (k === 'IRT') copy.put(k, v)
        return
      }
      if (widget && k === 'Parent') return
      if (k === 'AP') copy.put(k, copyAppearance(doc, v))
      else copy.put(k, clone(doc, v))
    })
    copy.put('P', page)
    if (!widget) continue
    let field = a.get('Parent')
    if (!field.isDictionary() && a.isIndirect() && (a.get('FT').isName() || a.get('T').isString())) {
      // A widget that is also its field: make the field a parent of both widgets.
      field = doc.addObject(doc.newDictionary())
      for (const k of FIELD_KEYS) {
        const v = a.get(k)
        if (v.isNull()) continue
        field.put(k, v)
        a.delete(k)
        copy.delete(k)
      }
      for (const k of ['DA', 'Q', 'DR'] as const) if (!a.get(k).isNull()) field.put(k, clone(doc, a.get(k)))
      a.put('Parent', field)
      arrayAt(doc, field, 'Kids').push(a)
    }
    if (field.isDictionary()) {
      copy.put('Parent', field)
      arrayAt(doc, field, 'Kids').push(copy)
    }
  }
  return out
}

/** Page keys inherited from the page tree (PDF 32000 §7.7.3.4): set on the copy itself. */
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const

/** A new page object showing the same page: own content streams, resources dictionary and annotations. */
function copyPage(doc: PdfDoc, page: mupdf.PDFObject): mupdf.PDFObject {
  const dict = doc.newDictionary()
  page.forEach((v, key) => {
    const k = String(key)
    // StructParents: the copy's content is not in the structure tree (it would point at the original's elements).
    if (k === 'Parent' || k === 'Annots' || k === 'StructParents' || k === 'Contents' || k === 'Resources') return
    dict.put(k, clone(doc, v))
  })
  for (const k of INHERITABLE) {
    if (k === 'Resources' || !dict.get(k).isNull()) continue
    const v = page.getInheritable(k)
    if (!v.isNull()) dict.put(k, clone(doc, v))
  }
  // Resources: a dictionary of its own (and of its own sub-dictionaries), so that a change that
  // swaps a picture or font on one page (redaction does) leaves the other. Fonts and pictures stay shared.
  const resources = page.getInheritable('Resources')
  const res = doc.newDictionary()
  if (resources.isDictionary()) {
    resources.forEach((v, k) => {
      if (v.isDictionary() && !v.isStream()) {
        const sub = doc.newDictionary()
        v.forEach((x, n) => sub.put(String(n), clone(doc, x)))
        res.put(String(k), sub)
      } else res.put(String(k), clone(doc, v))
    })
  }
  dict.put('Resources', res)
  const contents = page.get('Contents')
  if (contents.isArray()) {
    const list = doc.newArray()
    for (let i = 0; i < contents.length; i++) {
      const s = contents.get(i)
      list.push(s.isStream() ? copyStream(doc, s) : s)
    }
    dict.put('Contents', list)
  } else if (contents.isStream()) dict.put('Contents', copyStream(doc, contents))
  const copy = doc.addObject(dict)
  const annots = page.get('Annots')
  if (annots.isArray() && annots.length > 0) copy.put('Annots', copyAnnotsWithin(doc, annots, copy))
  return copy
}

/**
 * MuPDF's rearrangePages puts the same page object in the page tree once per listing, so a
 * duplicated page was one page shown twice: rotating, redacting or marking up the copy changed
 * the original too. Every repeat gets a page object of its own.
 */
function separateRepeats(doc: PdfDoc): void {
  const seen = new Set<number>()
  const count = doc.countPages()
  for (let i = 0; i < count; i++) {
    const page = doc.findPage(i)
    const num = page.asIndirect()
    if (!seen.has(num)) {
      seen.add(num)
      continue
    }
    const copy = copyPage(doc, page)
    doc.deletePage(i)
    doc.insertPage(i, copy)
  }
}

// --- The catalogue after rearranging ------------------------------------------------------------

/** The entries of a number tree (/Nums, /Kids), flattened and sorted by key. */
function numberTree(tree: mupdf.PDFObject): Array<[number, mupdf.PDFObject]> {
  const out: Array<[number, mupdf.PDFObject]> = []
  walkTree(tree, 'Nums', 0, new Set(), (key, value) => {
    if (key.isNumber()) out.push([key.asNumber(), value])
    return out.length
  })
  return out.sort((a, b) => a[0] - b[0])
}

/** The entries of a name tree (/Names, /Kids), flattened. */
function nameTree(tree: mupdf.PDFObject): Array<[mupdf.PDFObject, mupdf.PDFObject]> {
  const out: Array<[mupdf.PDFObject, mupdf.PDFObject]> = []
  walkTree(tree, 'Names', 0, new Set(), (key, value) => out.push([key, value]))
  return out
}

/** More entries than any real tree has; a hostile file stops here instead of filling memory. */
const TREE_ENTRIES = 100_000

/**
 * Visits a number or name tree's pairs. A node listed twice is read once and the pairs are
 * capped, so a tree that repeats one branch at every level cannot run for ever. `visit` returns
 * how many pairs are kept so far.
 */
function walkTree(tree: mupdf.PDFObject, key: 'Nums' | 'Names', depth: number, seen: Set<number>, visit: (key: mupdf.PDFObject, value: mupdf.PDFObject) => number, count = { n: 0 }): void {
  if (!tree.isDictionary() || depth > 16 || count.n >= TREE_ENTRIES) return
  if (tree.isIndirect()) {
    if (seen.has(tree.asIndirect())) return
    seen.add(tree.asIndirect())
  }
  const pairs = tree.get(key)
  if (pairs.isArray()) for (let i = 0; i + 1 < pairs.length && count.n < TREE_ENTRIES; i += 2) count.n = visit(pairs.get(i), pairs.get(i + 1))
  const kids = tree.get('Kids')
  if (kids.isArray()) for (let i = 0; i < kids.length && count.n < TREE_ENTRIES; i++) walkTree(kids.get(i), key, depth + 1, seen, visit, count)
}

/** The page a destination (explicit array, or a dictionary with /D) points at, as an object number. */
function destPage(dest: mupdf.PDFObject): number | null {
  const d = dest.isDictionary() ? dest.get('D') : dest
  if (!d.isArray() || d.length === 0) return null
  const page = d.get(0)
  return page.isIndirect() ? page.asIndirect() : null
}

/**
 * Page labels after rearranging: each page keeps the label it had ("ii" stays "ii" wherever
 * it goes); a new range starts wherever a page does not follow its old neighbour.
 */
function relabel(doc: PdfDoc, labels: mupdf.PDFObject, order: number[]): mupdf.PDFObject | null {
  const ranges = numberTree(labels)
  if (ranges.length === 0) return null
  // The last range starting at or before the page (the ranges are sorted).
  const rangeOf = (page: number): number => {
    let found = -1
    for (let lo = 0, hi = ranges.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1
      if (ranges[mid]![0] <= page) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }
  const nums = doc.newArray()
  order.forEach((page, j) => {
    const r = rangeOf(page)
    if (j > 0 && order[j - 1] === page - 1 && rangeOf(page - 1) === r) return
    const style = doc.newDictionary()
    let start = page + 1
    if (r >= 0) {
      const [first, dict] = ranges[r]!
      const d = dict.isDictionary() ? dict : doc.newDictionary()
      for (const k of ['S', 'P'] as const) if (!d.get(k).isNull()) style.put(k, d.get(k))
      start = (d.get('St').isNumber() ? d.get('St').asNumber() : 1) + (page - first)
    } else style.put('S', doc.newName('D'))
    if (start !== 1) style.put('St', start)
    nums.push(j)
    nums.push(style)
  })
  const tree = doc.newDictionary()
  tree.put('Nums', nums)
  return tree
}

/**
 * The structure tree (tagged PDF) after pages were removed: elements whose content lay only on
 * removed pages go, with their entries in the parent tree and the ID tree, so the removed pages are
 * not kept in the file through them. Returns false when nothing is left.
 */
function pruneStructure(doc: PdfDoc, tree: mupdf.PDFObject, gone: Set<number>): boolean {
  const kept = new Set<number>()
  const visited = new Set<number>()
  const onGone = (pg: number | null): boolean => pg !== null && gone.has(pg)
  const pageOf = (o: mupdf.PDFObject, inherited: number | null): number | null => {
    const pg = o.get('Pg')
    return pg.isIndirect() ? pg.asIndirect() : inherited
  }
  const typeOf = (o: mupdf.PDFObject): string => (o.get('Type').isName() ? o.get('Type').asName() : '')
  // Filters an element's (or the root's) /K; true when something is left.
  const filterKids = (owner: mupdf.PDFObject, pg: number | null, depth: number): boolean | null => {
    const k = owner.get('K')
    if (k.isNull()) return null
    const keepItem = (item: mupdf.PDFObject): boolean => {
      if (item.isNumber()) return !onGone(pg)
      if (!item.isDictionary()) return true
      const type = typeOf(item)
      if (type === 'MCR' || type === 'OBJR') return !onGone(pageOf(item, pg))
      return element(item, pg, depth + 1)
    }
    if (k.isArray()) {
      if (k.length === 0) return null
      const list = doc.newArray()
      for (let i = 0; i < k.length; i++) if (keepItem(k.get(i))) list.push(k.get(i))
      owner.put('K', list)
      return list.length > 0
    }
    if (keepItem(k)) return true
    owner.delete('K')
    return false
  }
  const element = (elem: mupdf.PDFObject, inherited: number | null, depth: number): boolean => {
    if (depth > 256) return true
    if (elem.isIndirect()) {
      if (visited.has(elem.asIndirect())) return kept.has(elem.asIndirect())
      visited.add(elem.asIndirect())
    }
    const pg = pageOf(elem, inherited)
    const left = filterKids(elem, pg, depth)
    const keep = left === null ? !onGone(pg) : left
    if (!keep) return false
    if (elem.get('Pg').isIndirect() && gone.has(elem.get('Pg').asIndirect())) elem.delete('Pg')
    if (elem.isIndirect()) kept.add(elem.asIndirect())
    return true
  }
  const any = filterKids(tree, null, 0)
  const isKept = (v: mupdf.PDFObject): boolean => !v.isIndirect() || kept.has(v.asIndirect())
  // Parent tree: entries for removed content become null; entries with nothing left go.
  const parents = numberTree(tree.get('ParentTree'))
  if (parents.length > 0) {
    const nums = doc.newArray()
    for (const [key, value] of parents) {
      if (value.isArray()) {
        const list = doc.newArray()
        let live = false
        for (let i = 0; i < value.length; i++) {
          const v = value.get(i)
          const ok = !v.isNull() && isKept(v)
          live ||= ok
          list.push(ok ? v : doc.newNull())
        }
        if (!live) continue
        nums.push(key)
        nums.push(list)
      } else if (isKept(value)) {
        nums.push(key)
        nums.push(value)
      }
    }
    const parentTree = doc.newDictionary()
    parentTree.put('Nums', nums)
    tree.put('ParentTree', parentTree)
  }
  const ids = nameTree(tree.get('IDTree'))
  if (ids.length > 0) {
    const names = doc.newArray()
    for (const [key, value] of ids) {
      if (!isKept(value)) continue
      names.push(key)
      names.push(value)
    }
    const idTree = doc.newDictionary()
    idTree.put('Names', names)
    tree.put('IDTree', idTree)
  }
  return any !== false
}

/**
 * MuPDF's rearrangePages rebuilds the catalogue with little more than the page tree: page labels,
 * the structure tree (tagged PDF), the document's language, viewer preferences, mark info, open
 * action and so on were lost on every keep, delete, reorder, extract, split or duplicate. Put
 * them back, adjusted to the new page order; what points at a removed page is dropped.
 */
function restoreCatalog(doc: PdfDoc, catalog: Array<[string, mupdf.PDFObject]>, order: number[], before: number[]): void {
  const root = doc.getTrailer().get('Root')
  const now = new Set(Array.from({ length: doc.countPages() }, (_, i) => doc.findPage(i).asIndirect()))
  const gone = new Set(before.filter((n) => !now.has(n)))
  // MuPDF keeps these itself (pruned to the pages left), or they are handled elsewhere.
  const handled = new Set(['Type', 'Pages', 'Outlines', 'AcroForm'])
  for (const [key, value] of catalog) {
    if (handled.has(key) || !root.get(key).isNull()) continue
    switch (key) {
      case 'PageLabels': {
        const labels = relabel(doc, value, order)
        if (labels) root.put(key, labels)
        break
      }
      case 'StructTreeRoot':
        if (gone.size === 0 || pruneStructure(doc, value, gone)) root.put(key, value)
        break
      case 'OpenAction':
        if (!onRemovedPage(value, gone)) root.put(key, value)
        break
      case 'Dests': {
        const dests = doc.newDictionary()
        if (value.isDictionary()) value.forEach((d, name) => !onRemovedPage(d, gone) && dests.put(String(name), d))
        root.put(key, dests)
        break
      }
      case 'Names': {
        const names = doc.newDictionary()
        if (value.isDictionary())
          value.forEach((tree, name) => {
            if (name !== 'Dests') return names.put(String(name), tree)
            const list = doc.newArray()
            for (const [k, d] of nameTree(tree)) {
              if (onRemovedPage(d, gone)) continue
              list.push(k)
              list.push(d)
            }
            const dests = doc.newDictionary()
            dests.put('Names', list)
            names.put('Dests', dests)
          })
        root.put(key, names)
        break
      }
      // Article threads run from page to page; kept only when no page went.
      case 'Threads':
        if (gone.size === 0) root.put(key, value)
        break
      default:
        root.put(key, value)
    }
  }
  // MuPDF kept /Names (its named destinations) but not the rest of it: embedded files, scripts…
  const old = catalog.find(([k]) => k === 'Names')?.[1]
  const names = root.get('Names')
  if (old && old.isDictionary() && names.isDictionary()) old.forEach((tree, name) => name !== 'Dests' && names.get(String(name)).isNull() && names.put(String(name), tree))
}

/** True when a destination or GoTo action leads to a page that was removed. */
function onRemovedPage(target: mupdf.PDFObject, gone: Set<number>): boolean {
  if (gone.size === 0 || !target.isDictionary() && !target.isArray()) return false
  const dest = target.isDictionary() && target.get('S').isName() ? (target.get('S').asName() === 'GoTo' ? target.get('D') : null) : target
  if (!dest) return false
  const page = destPage(dest)
  return page !== null && gone.has(page)
}

/**
 * MuPDF's rearrangePages empties the form's field list (/AcroForm /Fields) even
 * for an unchanged order, while the widgets stay on their pages: the form still
 * looks right but Acrobat no longer treats it as a form (test/review.test.ts).
 * Rebuild the list from the widgets that are left, and keep the form's own
 * dictionary (default fonts and appearance settings).
 */
function restoreFormFields(doc: PdfDoc, acroForm: mupdf.PDFObject): void {
  if (!acroForm.isDictionary()) return
  const root = doc.getTrailer().get('Root')
  if (!root.get('AcroForm').isDictionary()) root.put('AcroForm', acroForm)
  const form = root.get('AcroForm')
  const fields = doc.newArray()
  const seen = new Set<number>()
  const count = doc.countPages()
  for (let i = 0; i < count; i++) {
    const annots = doc.findPage(i).get('Annots')
    if (!annots.isArray()) continue
    for (let k = 0; k < annots.length; k++) {
      let field = annots.get(k)
      if (!field.isDictionary() || field.get('Subtype').asName() !== 'Widget') continue
      // A widget may be a kid of a field; the list holds top-level fields only.
      for (let depth = 0; depth < 32 && field.get('Parent').isDictionary(); depth++) field = field.get('Parent')
      if (!field.isIndirect()) continue
      const num = field.asIndirect()
      if (seen.has(num)) continue
      seen.add(num)
      fields.push(field)
    }
  }
  form.put('Fields', fields)
}

/** Inserts a copy of each listed page directly after itself. */
export function duplicatePages(bytes: Uint8Array, pages: number[], password?: string): Uint8Array {
  const count = pageCount(bytes, password)
  assertPagesAgainst(count, pages)
  const wanted = new Set(pages)
  const order: number[] = []
  for (let i = 0; i < count; i++) {
    order.push(i)
    if (wanted.has(i)) order.push(i)
  }
  return keepPages(bytes, order, password)
}

function assertPagesAgainst(count: number, pages: number[]): void {
  for (const p of pages) if (!Number.isInteger(p) || p < 0 || p >= count) throw new PdfError('bad-arguments', `Page ${p + 1} does not exist (the document has ${count}).`)
}

/** Inserts `count` blank pages at position `at` (0 = before the first page). */
export function insertBlankPages(bytes: Uint8Array, at: number, count: number, width?: number, height?: number, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    const total = doc.countPages()
    if (at < 0 || at > total) throw new PdfError('bad-arguments', `Cannot insert at page ${at + 1}.`)
    let w = width
    let h = height
    if (w === undefined || h === undefined) {
      const neighbour = doc.loadPage(Math.min(Math.max(at - 1, 0), total - 1))
      const b = neighbour.getBounds()
      w ??= b[2] - b[0]
      h ??= b[3] - b[1]
      free(neighbour)
    }
    for (let i = 0; i < count; i++) {
      const page = doc.addPage([0, 0, w, h], 0, {}, '')
      doc.insertPage(at + i, page)
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** A new document of `count` empty pages, `width` × `height` points (Create › Blank document). */
export function blankPdf(width: number, height: number, count: number): Uint8Array {
  if (!(width >= 72 && height >= 72 && width <= 14400 && height <= 14400)) throw new PdfError('bad-arguments', 'That page size is not possible.')
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new PdfError('bad-arguments', 'A new document has 1 to 500 pages.')
  const doc = newPdf()
  try {
    for (let i = 0; i < count; i++) doc.insertPage(-1, doc.addPage([0, 0, width, height], 0, {}, ''))
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

/** Inserts pages of another PDF (all of them when `pages` is omitted) at position `at`. */
export function insertPdfPages(bytes: Uint8Array, at: number, other: Uint8Array, pages?: number[], otherPassword?: string, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  const donor = openPdf(other, otherPassword)
  try {
    const total = doc.countPages()
    if (at < 0 || at > total) throw new PdfError('bad-arguments', `Cannot insert at page ${at + 1}.`)
    const list = pages ?? Array.from({ length: donor.countPages() }, (_, i) => i)
    assertPages(donor, list)
    importPages(doc, donor, list, at)
    return saveBytes(doc)
  } finally {
    free(doc, donor)
  }
}

// --- Pages from another document, with their annotations -----------------------------------------

/** True when `value` leads to a page or the page tree: grafting it would copy the other document's pages along. */
function refersToPage(value: mupdf.PDFObject, visited = new Set<number>(), depth = 0): boolean {
  if (depth > 8) return false
  if (value.isIndirect()) {
    const num = value.asIndirect()
    if (visited.has(num)) return false
    visited.add(num)
  }
  if (value.isDictionary()) {
    const type = value.get('Type')
    if (type.isName() && (type.asName() === 'Page' || type.asName() === 'Pages')) return true
    let found = false
    value.forEach((v) => {
      if (!found && (v.isIndirect() || v.isArray() || v.isDictionary())) found = refersToPage(v, visited, depth + 1)
    })
    return found
  }
  if (value.isArray()) {
    for (let i = 0; i < value.length; i++) if (refersToPage(value.get(i), visited, depth + 1)) return true
  }
  return false
}

/**
 * Copies pages `list` of `donor` into `doc` at `at`, as Acrobat's Insert and Combine do, with
 * their annotations. MuPDF's graftPage copies what a page shows
 * but none of its annotations, so notes, links and filled-in fields were lost. Here:
 *  - annotations are copied without /P and /StructParent (which would drag the other document's
 *    pages and structure along), then /P is set to the new page;
 *  - a link to a copied page points at the copy (named destinations are resolved first); a link to
 *    a page that was not copied is dropped, and a GoTo elsewhere is removed;
 *  - fields come along with their widgets and are added to /AcroForm /Fields; a field whose name
 *    is taken gets "_2", "_3"… so the two forms do not share values by accident;
 *  - the same page copied twice gets two independent sets of annotations.
 */
function importPages(doc: PdfDoc, donor: PdfDoc, list: number[], at: number): void {
  const map = doc.newGraftMap()
  try {
    const pageMap = new Map<number, mupdf.PDFObject>()
    const placed: mupdf.PDFObject[] = []
    list.forEach((p, k) => {
      map.graftPage(at + k, donor, p)
      const page = doc.findPage(at + k)
      page.delete('StructParents')
      placed.push(page)
      const num = donor.findPage(p).asIndirect()
      if (!pageMap.has(num)) pageMap.set(num, page)
    })

    const named = new Map<string, mupdf.PDFObject>()
    try {
      for (const [name, dest] of Object.entries(donor.loadNameTree('Dests'))) named.set(name, dest)
    } catch {
      /* no name tree */
    }
    const oldDests = donor.getTrailer().get('Root').get('Dests')
    if (oldDests.isDictionary()) oldDests.forEach((dest, name) => named.has(String(name)) || named.set(String(name), dest))

    const mapDest = (dest: mupdf.PDFObject, depth = 0): mupdf.PDFObject | null => {
      if (depth > 4) return null
      if (dest.isName()) return named.has(dest.asName()) ? mapDest(named.get(dest.asName())!, depth + 1) : null
      if (dest.isString()) return named.has(dest.asString()) ? mapDest(named.get(dest.asString())!, depth + 1) : null
      if (dest.isDictionary()) return mapDest(dest.get('D'), depth + 1)
      if (!dest.isArray() || dest.length === 0) return null
      const first = dest.get(0)
      const page = first.isIndirect() ? pageMap.get(first.asIndirect()) : undefined
      if (!page) return null
      const out = doc.newArray()
      out.push(page)
      for (let i = 1; i < dest.length; i++) out.push(map.graftObject(dest.get(i)))
      return out
    }
    const mapAction = (action: mupdf.PDFObject): mupdf.PDFObject | null => {
      if (!action.isDictionary()) return null
      if (action.get('S').isName() && action.get('S').asName() === 'GoTo') {
        const dest = mapDest(action.get('D'))
        if (!dest) return null
        const out = doc.newDictionary()
        out.put('S', doc.newName('GoTo'))
        out.put('D', dest)
        return out
      }
      // URI, Named, JavaScript…: copied as they are, unless they lead to the other document's pages.
      return refersToPage(action) ? null : map.graftObject(action)
    }
    const copyValue = (key: string, value: mupdf.PDFObject): mupdf.PDFObject | null => {
      if (key === 'Dest') return mapDest(value)
      if (key === 'A') return mapAction(value)
      if (key === 'AA') {
        if (!value.isDictionary()) return null
        const out = doc.newDictionary()
        let any = false
        value.forEach((action, trigger) => {
          const mapped = mapAction(action)
          if (mapped) {
            out.put(String(trigger), mapped)
            any = true
          }
        })
        return any ? out : null
      }
      return refersToPage(value) ? null : map.graftObject(value)
    }

    const fields = new Map<number, mupdf.PDFObject>()
    const top: mupdf.PDFObject[] = []
    const importField = (src: mupdf.PDFObject, depth = 0): mupdf.PDFObject => {
      const num = src.isIndirect() ? src.asIndirect() : -1
      const known = fields.get(num)
      if (known) return known
      const field = doc.addObject(doc.newDictionary())
      if (num >= 0) fields.set(num, field)
      src.forEach((v, key) => {
        const k = String(key)
        if (k === 'Kids' || k === 'Parent' || k === 'P') return
        const copied = copyValue(k, v)
        if (copied) field.put(k, copied)
      })
      field.put('Kids', doc.newArray())
      const parent = src.get('Parent')
      if (parent.isDictionary() && depth < 32) {
        const up = importField(parent, depth + 1)
        field.put('Parent', up)
        arrayAt(doc, up, 'Kids').push(field)
      } else top.push(field)
      return field
    }

    const copied = new Set<number>()
    /** Each donor annotation's first copy, whatever page it went to. */
    const anyPage = new Map<number, mupdf.PDFObject>()
    const replies: Array<{ copy: mupdf.PDFObject; parent: number; page: mupdf.PDFObject; state: boolean }> = []
    list.forEach((p, k) => {
      const source = donor.findPage(p)
      const annots = source.get('Annots')
      if (!annots.isArray() || annots.length === 0) return
      const again = copied.has(source.asIndirect())
      copied.add(source.asIndirect())
      const page = placed[k]!
      const local = new Map<number, mupdf.PDFObject>()
      const items: Array<[mupdf.PDFObject, mupdf.PDFObject]> = []
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i)
        if (!a.isDictionary()) continue
        // A link that leads to a page that was not copied leads nowhere: leave it out.
        if (subtypeOf(a) === 'Link' && ((!a.get('Dest').isNull() && !mapDest(a.get('Dest'))) || (!a.get('A').isNull() && !mapAction(a.get('A'))))) continue
        const copy = doc.addObject(doc.newDictionary())
        if (a.isIndirect()) {
          local.set(a.asIndirect(), copy)
          if (!anyPage.has(a.asIndirect())) anyPage.set(a.asIndirect(), copy)
        }
        items.push([a, copy])
      }
      const out = doc.newArray()
      for (const [a, copy] of items) {
        const widget = subtypeOf(a) === 'Widget'
        a.forEach((v, key) => {
          const k = String(key)
          if (k === 'P' || k === 'StructParent' || (widget && k === 'Parent')) return
          if (k === 'Popup' || k === 'IRT' || k === 'Parent') {
            const to = v.isIndirect() ? local.get(v.asIndirect()) : undefined
            if (to) copy.put(k, to)
            // A reply whose comment is on another page: settled once every page is in (§82).
            else if (k === 'IRT' && v.isIndirect()) replies.push({ copy, parent: v.asIndirect(), page, state: !a.get('State').isNull() })
            return
          }
          const value = copyValue(k, v)
          if (!value) return
          // The same page twice: the second set of annotations gets appearance streams of its own.
          copy.put(k, again && k === 'AP' ? copyAppearance(doc, value) : value)
        })
        copy.put('P', page)
        if (widget) {
          const parent = a.get('Parent')
          if (parent.isDictionary()) {
            const field = importField(parent)
            copy.put('Parent', field)
            arrayAt(doc, field, 'Kids').push(copy)
          } else if (a.get('T').isString() || a.get('FT').isName()) top.push(copy)
        }
        out.push(copy)
      }
      if (out.length > 0) page.put('Annots', out)
      else page.delete('Annots')
    })
    // Replies and review states on another page than their comment keep it (§82). A
    // review state whose comment was not brought along says nothing: it is left out, with its
    // pop-up. A reply without its comment stays, as a comment of its own.
    for (const r of replies) {
      const parent = anyPage.get(r.parent)
      if (parent) {
        r.copy.put('IRT', parent)
        continue
      }
      if (!r.state) continue
      const annots = r.page.get('Annots')
      if (!annots.isArray()) continue
      const drop = new Set([r.copy.asIndirect(), r.copy.get('Popup').isIndirect() ? r.copy.get('Popup').asIndirect() : -1])
      for (let i = annots.length - 1; i >= 0; i--) if (annots.get(i).isIndirect() && drop.has(annots.get(i).asIndirect())) annots.delete(i)
    }
    registerFields(doc, donor, top, map)
  } finally {
    free(map)
  }
}

/** Adds imported top-level fields to /AcroForm /Fields, renaming a field whose name is taken. */
function registerFields(doc: PdfDoc, donor: PdfDoc, top: mupdf.PDFObject[], map: mupdf.PDFGraftMap): void {
  if (top.length === 0) return
  const root = doc.getTrailer().get('Root')
  if (!root.get('AcroForm').isDictionary()) root.put('AcroForm', doc.addObject(doc.newDictionary()))
  const form = root.get('AcroForm')
  const list = arrayAt(doc, form, 'Fields')
  const names = new Set<string>()
  for (let i = 0; i < list.length; i++) {
    const t = list.get(i).get('T')
    if (t.isString()) names.add(t.asString())
  }
  for (const field of top) {
    const t = field.get('T')
    if (t.isString()) {
      let name = t.asString()
      if (names.has(name)) {
        let n = 2
        while (names.has(`${name}_${n}`)) n++
        name = `${name}_${n}`
        field.put('T', doc.newString(name))
      }
      names.add(name)
    }
    list.push(field)
  }
  // The other form's defaults (fonts for its fields' text, alignment), where this one has none.
  const theirs = donor.getTrailer().get('Root').get('AcroForm')
  if (!theirs.isDictionary()) return
  for (const key of ['DA', 'Q', 'NeedAppearances', 'SigFlags'] as const) {
    if (form.get(key).isNull() && !theirs.get(key).isNull()) form.put(key, map.graftObject(theirs.get(key)))
  }
  const dr = theirs.get('DR')
  if (!dr.isDictionary()) return
  if (!form.get('DR').isDictionary()) {
    form.put('DR', map.graftObject(dr))
    return
  }
  const ours = form.get('DR')
  dr.forEach((group, kind) => {
    if (!group.isDictionary()) return
    if (!ours.get(String(kind)).isDictionary()) return ours.put(String(kind), map.graftObject(group))
    const into = ours.get(String(kind))
    group.forEach((res, name) => into.get(String(name)).isNull() && into.put(String(name), map.graftObject(res)))
  })
}

/** What makes a page look as it does: replaced together, everything else of the page is kept. */
const PAGE_LOOK =['Contents', 'Resources', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'UserUnit', 'Group'] as const
const INHERITED = new Set<string>(['Resources', 'MediaBox', 'CropBox', 'Rotate'])

/**
 * Replace pages, as Acrobat's Replace Pages: page `targets[k]` of this document shows page
 * `from[k]` of `other` afterwards. Only what the page shows changes — its content, resources,
 * boxes and rotation, copied over by MuPDF (the same graft as inserting pages, §22). The page
 * itself stays, so bookmarks that point at it, its links and comments, and the form (§20) are kept.
 */
export function replacePages(bytes: Uint8Array, targets: number[], other: Uint8Array, from: number[], otherPassword?: string, password?: string): Uint8Array {
  if (targets.length === 0 || targets.length !== from.length) throw new PdfError('bad-arguments', 'Choose as many replacement pages as pages to replace.')
  if (new Set(targets).size !== targets.length) throw new PdfError('bad-arguments', 'A page can be replaced only once.')
  const doc = openPdf(bytes, password)
  const donor = openPdf(other, otherPassword)
  try {
    assertPages(doc, targets)
    assertPages(donor, from)
    const map = doc.newGraftMap()
    targets.forEach((target, k) => {
      const page = doc.findPage(target)
      const source = donor.findPage(from[k]!)
      for (const key of PAGE_LOOK) {
        const value = INHERITED.has(key) ? source.getInheritable(key) : source.get(key)
        if (!value.isNull()) page.put(key, map.graftObject(value))
        // Set explicitly where the page would otherwise inherit its old parent's value.
        else if (key === 'CropBox') page.put('CropBox', map.graftObject(source.getInheritable('MediaBox')))
        else if (key === 'Rotate') page.put('Rotate', 0)
        else if (key === 'Resources') page.put('Resources', doc.newDictionary())
        else page.delete(key)
      }
    })
    return saveBytes(doc)
  } finally {
    free(doc, donor)
  }
}

/**
 * Joins documents, in order, into one.
 *
 * Each page keeps its annotations, links and form fields (`importPages`; a field whose name
 * is taken is renamed). Known limit: the inputs' bookmarks are not carried over (docs/features.md).
 */
export function mergePdfs(inputs: Array<{ bytes: Uint8Array; password?: string }>): Uint8Array {
  if (inputs.length === 0) throw new PdfError('bad-arguments', 'Nothing to merge.')
  const out = newPdf()
  try {
    const standards: Array<PrintStandard | null> = []
    let first: PdfDoc | null = null
    try {
      for (const [i, input] of inputs.entries()) {
        const src = openPdf(input.bytes, input.password)
        try {
          importPages(out, src, Array.from({ length: src.countPages() }, (_, p) => p), out.countPages())
          if (i === 0) copyMetadata(src, out)
          standards.push(readPrintStandard(src))
        } finally {
          // The first file stays open: its output intents are copied from it once all agree.
          if (i === 0) first = src
          else free(src)
        }
      }
      // The PDF/X output intent and identification, when every file declares the same (§82).
      if (first) carryPrintStandard(out, standards)
    } finally {
      free(first)
    }
    return saveBytes(out)
  } finally {
    free(out)
  }
}

/** Splits into one document per range; a range is an inclusive [from, to] pair of zero-based pages. */
export function splitByRanges(bytes: Uint8Array, ranges: Array<[number, number]>, password?: string): Uint8Array[] {
  const src = openPdf(bytes, password)
  const total = src.countPages()
  free(src)
  return ranges.map(([from, to]) => {
    if (from < 0 || to >= total || from > to) throw new PdfError('bad-arguments', `Range ${from + 1}–${to + 1} is not valid (the document has ${total} pages).`)
    return keepPages(bytes, Array.from({ length: to - from + 1 }, (_, i) => from + i), password)
  })
}

/**
 * Cuts margins from the visible area of the listed pages. Margins are as the page is *displayed*,
 * in the units MuPDF shows (so /UserUnit and /Rotate are applied, and a CropBox reaching past
 * the MediaBox counts only where they overlap). The new CropBox is the cut displayed rectangle
 * taken back through the page's transform, so it always lies inside the MediaBox.
 */
export function cropPages(bytes: Uint8Array, pages: number[], margins: { left: number; top: number; right: number; bottom: number }, password?: string): Uint8Array {
  const doc = openPdf(bytes, password)
  try {
    assertPages(doc, pages)
    const { left: l, top: t, right: r, bottom: b } = margins
    for (const index of new Set(pages)) {
      const loaded = doc.loadPage(index)
      let rect: number[]
      try {
        const [x0, y0, x1, y1] = loaded.getBounds()
        if (x1! - r - (x0! + l) < 18 || y1! - b - (y0! + t) < 18) throw new PdfError('bad-arguments', `Cropping page ${index + 1} would leave almost nothing.`)
        rect = mupdf.Rect.transform([x0! + l, y0! + t, x1! - r, y1! - b], mupdf.Matrix.invert(loaded.getTransform()))
      } finally {
        free(loaded)
      }
      const page = doc.findPage(index)
      // Never past the MediaBox (a negative margin, say): readers clip to it anyway.
      const media = rectOf(page.getInheritable('MediaBox'))
      if (media) rect = [Math.max(rect[0]!, media[0]), Math.max(rect[1]!, media[1]), Math.min(rect[2]!, media[2]), Math.min(rect[3]!, media[3])]
      const arr = doc.newArray()
      for (const v of rect) arr.push(+v.toFixed(4))
      page.put('CropBox', arr)
    }
    return saveBytes(doc)
  } finally {
    free(doc)
  }
}

function rectOf(box: mupdf.PDFObject): [number, number, number, number] | null {
  if (!box.isArray() || box.length < 4) return null
  const v = [0, 1, 2, 3].map((i) => box.get(i).asNumber())
  if (v.some((n) => !Number.isFinite(n))) return null
  const r: [number, number, number, number] = [Math.min(v[0]!, v[2]!), Math.min(v[1]!, v[3]!), Math.max(v[0]!, v[2]!), Math.max(v[1]!, v[3]!)]
  return r[2] > r[0] && r[3] > r[1] ? r : null
}

/**
 * The page's visible box in its own coordinates (without /UserUnit), as MuPDF and readers take it:
 * the CropBox clipped to the MediaBox, the MediaBox when there is no CropBox (or they do not meet),
 * US Letter when there is not even a MediaBox.
 */
export function boxOf(page: mupdf.PDFObject): [number, number, number, number] {
  const media = rectOf(page.getInheritable('MediaBox')) ?? [0, 0, 612, 792]
  const crop = rectOf(page.getInheritable('CropBox'))
  if (!crop) return media
  const both: [number, number, number, number] = [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])]
  return both[2] > both[0] && both[3] > both[1] ? both : media
}

/** /Rotate as MuPDF applies it: a whole number, snapped to the nearest quarter turn (45 → 90). */
export function rotationOf(page: mupdf.PDFObject): 0 | 90 | 180 | 270 {
  const r = page.getInheritable('Rotate')
  let n = r.isNumber() ? Math.trunc(r.asNumber()) : 0
  if (!Number.isFinite(n)) n = 0
  if (n < 0) n = 360 - (-n % 360)
  if (n >= 360) n %= 360
  n = 90 * Math.floor((n + 45) / 90)
  return (n >= 360 ? 0 : n) as 0 | 90 | 180 | 270
}

function copyMetadata(from: PdfDoc, to: PdfDoc): void {
  for (const key of ['info:Title', 'info:Author', 'info:Subject', 'info:Keywords'] as const) {
    try {
      const value = from.getMetaData(key)
      if (value) to.setMetaData(key, value)
    } catch {
      /* metadata is a courtesy */
    }
  }
}

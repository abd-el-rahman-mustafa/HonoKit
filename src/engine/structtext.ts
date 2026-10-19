import type { mupdf, PdfDoc } from './mupdf'
import { nameTree, numberTree } from './pages'

/**
 * Redaction and the structure tree (tagged PDF). An element of the tree can spell out the content
 * it tags: /ActualText (what copy and screen readers read instead), /Alt (a description) and /E
 * (an abbreviation's expansion). MuPDF's redaction trims some of these and keeps others: an element
 * whose actual text is longer than the removed words, one that inherits its page from a parent,
 * and the parents around it kept the redacted words (measured on MuPDF 1.28.1). And an element
 * tagging a comment points at it (/OBJR), so a comment removed from its page was still written to
 * the file, its text included.
 *
 * The walk starts from the root's /K and also from the parent tree and the ID tree, which can name
 * elements the root does not reach. When the tree is too large to walk in full, every element in
 * the file is cleaned instead (the safe side).
 */
const KEYS = ['ActualText', 'Alt', 'E'] as const

/** The most references one walk visits; a real tree has far fewer. */
const LIMIT = 2_000_000
/** The most ancestors followed up /P. */
const MAX_PARENTS = 256

const typeOf = (o: mupdf.PDFObject): string => (o.get('Type').isName() ? o.get('Type').asName() : '')

function structRoot(doc: PdfDoc): mupdf.PDFObject | null {
  const root = doc.getTrailer().get('Root')
  const tree = root.isDictionary() ? root.get('StructTreeRoot') : null
  return tree?.isDictionary() ? tree : null
}

function kidsOf(o: mupdf.PDFObject): mupdf.PDFObject[] {
  const k = o.get('K')
  if (k.isArray()) return Array.from({ length: k.length }, (_, i) => k.get(i))
  return k.isNull() ? [] : [k]
}

/** The page an element inherits: the nearest /Pg up its /P chain; undefined when the lookup gives up. */
function inheritedPage(elem: mupdf.PDFObject): number | null | undefined {
  const seen = new Set<number>()
  let o = elem
  for (let i = 0; i < MAX_PARENTS; i++) {
    if (!o.isDictionary() || typeOf(o) === 'StructTreeRoot') return null
    if (o.isIndirect()) {
      if (seen.has(o.asIndirect())) return undefined
      seen.add(o.asIndirect())
    }
    const pg = o.get('Pg')
    if (pg.isIndirect()) return pg.asIndirect()
    o = o.get('P')
  }
  return undefined
}

/**
 * Visits every element of the tree once with the page it is on (its own /Pg or the one it
 * inherits). Returns false when the walk could not be finished: too many references, or an
 * element whose page could not be worked out.
 */
function walk(root: mupdf.PDFObject, visit: (elem: mupdf.PDFObject, page: number | null) => void): boolean {
  const visited = new Set<number>()
  let count = 0
  const queue: Array<[mupdf.PDFObject, number | null]> = []
  const run = (): boolean => {
    while (queue.length > 0) {
      const [elem, inherited] = queue.pop()!
      if (++count > LIMIT) return false
      if (!elem.isDictionary()) continue
      if (elem.isIndirect()) {
        if (visited.has(elem.asIndirect())) continue
        visited.add(elem.asIndirect())
      }
      const type = typeOf(elem)
      if (type === 'MCR' || type === 'OBJR' || type === 'StructTreeRoot') continue
      const pg = elem.get('Pg')
      const page = pg.isIndirect() ? pg.asIndirect() : inherited
      visit(elem, page)
      for (const kid of kidsOf(elem)) if (kid.isDictionary()) queue.push([kid, page])
    }
    return true
  }
  for (const kid of kidsOf(root)) if (kid.isDictionary()) queue.push([kid, null])
  if (!run()) return false
  // Elements only the parent tree or the ID tree name; their page is worked out from their parents.
  const more: mupdf.PDFObject[] = []
  for (const [, value] of numberTree(root.get('ParentTree'))) {
    if (value.isArray()) for (let i = 0; i < value.length; i++) more.push(value.get(i))
    else more.push(value)
  }
  for (const [, value] of nameTree(root.get('IDTree'))) more.push(value)
  for (const elem of more) {
    if (!elem.isDictionary() || (elem.isIndirect() && visited.has(elem.asIndirect()))) continue
    const page = inheritedPage(elem)
    if (page === undefined) return false
    queue.push([elem, page])
    if (!run()) return false
  }
  return true
}

/** Every structure element in the file, found by reading each object rather than through the tree. */
function everyElement(doc: PdfDoc, visit: (elem: mupdf.PDFObject) => void): void {
  const n = doc.countObjects()
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i)
    if (!o.isDictionary()) continue
    const type = typeOf(o)
    if (type === 'StructElem' || (type === '' && o.get('S').isName() && o.get('P').isDictionary() && !o.get('Subtype').isName())) visit(o)
  }
}

function clearKeys(elem: mupdf.PDFObject): void {
  for (const k of KEYS) if (!elem.get(k).isNull()) elem.delete(k)
}

/**
 * Clears /ActualText, /Alt and /E from the elements tagging `mcids` of the page (marked content a
 * redaction changed or removed) and from the elements around them, whose text spells out theirs.
 * Content tagged inside a form XObject (an MCR with /Stm) is not matched here.
 */
export function clearTagText(doc: PdfDoc, pageIndex: number, mcids: Set<number>): void {
  if (mcids.size === 0) return
  const root = structRoot(doc)
  if (!root) return
  const pageObj = doc.findPage(pageIndex)
  if (!pageObj.isIndirect()) return
  const pageNum = pageObj.asIndirect()
  const owners: mupdf.PDFObject[] = []
  const complete = walk(root, (elem, page) => {
    for (const kid of kidsOf(elem)) {
      let mcid: number | null = null
      let on = page
      if (kid.isNumber()) mcid = kid.asNumber()
      else if (kid.isDictionary() && typeOf(kid) === 'MCR' && kid.get('Stm').isNull() && kid.get('MCID').isNumber()) {
        mcid = kid.get('MCID').asNumber()
        if (kid.get('Pg').isIndirect()) on = kid.get('Pg').asIndirect()
      }
      if (mcid !== null && on === pageNum && mcids.has(mcid)) {
        owners.push(elem)
        break
      }
    }
  })
  if (!complete) {
    everyElement(doc, clearKeys)
    return
  }
  for (const owner of owners) {
    // The element and every element around it, up to the root.
    const seen = new Set<number>()
    let o = owner
    for (let i = 0; i < MAX_PARENTS && o.isDictionary() && typeOf(o) !== 'StructTreeRoot'; i++) {
      if (o.isIndirect()) {
        if (seen.has(o.asIndirect())) break
        seen.add(o.asIndirect())
      }
      clearKeys(o)
      o = o.get('P')
    }
  }
}

/**
 * Drops the tree's references (/OBJR) to annotations no page lists any more, so a comment or field
 * removed by redaction is not written to the file through its tag.
 */
export function dropRemovedAnnotRefs(doc: PdfDoc): void {
  const root = structRoot(doc)
  if (!root) return
  const live = new Set<number>()
  for (let p = 0; p < doc.countPages(); p++) {
    const annots = doc.findPage(p).get('Annots')
    if (annots.isArray()) for (let i = 0; i < annots.length; i++) if (annots.get(i).isIndirect()) live.add(annots.get(i).asIndirect())
  }
  const gone = (kid: mupdf.PDFObject): boolean => {
    if (!kid.isDictionary() || typeOf(kid) !== 'OBJR') return false
    const obj = kid.get('Obj')
    if (!obj.isIndirect() || !obj.isDictionary()) return false
    // Only annotations: an OBJR can also tag a picture or a form XObject, which stay.
    const annot = typeOf(obj) === 'Annot' || (obj.get('Subtype').isName() && obj.get('Rect').isArray() && !obj.get('Type').isName())
    return annot && !live.has(obj.asIndirect())
  }
  const clean = (elem: mupdf.PDFObject): void => {
    const k = elem.get('K')
    if (k.isArray()) {
      if (!Array.from({ length: k.length }, (_, i) => k.get(i)).some(gone)) return
      const list = doc.newArray()
      for (let i = 0; i < k.length; i++) if (!gone(k.get(i))) list.push(k.get(i))
      elem.put('K', list)
    } else if (gone(k)) elem.delete('K')
  }
  if (!walk(root, (elem) => clean(elem))) everyElement(doc, clean)
}

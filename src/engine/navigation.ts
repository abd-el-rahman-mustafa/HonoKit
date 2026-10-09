import { free, type PdfDoc } from './mupdf'
import type { mupdf } from './mupdf'

/**
 * Moving around a document: its bookmarks (the outline) and the links on its pages, read through
 * MuPDF. Read only: nothing here changes the file.
 */

export interface OutlineEntry {
  title: string
  /** The page it goes to (0-based), or null when it goes nowhere in this document. */
  page: number | null
  /** Where on that page, in points as displayed (top-left origin), when the bookmark says. */
  point?: [number, number]
  /** A web address or another file: shown, never opened. */
  uri?: string
  /** Open (expanded) in the file. */
  open: boolean
  children: OutlineEntry[]
}

export interface LinkEntry {
  /** Where the link is on its page, in points as displayed. */
  box: [number, number, number, number]
  /** A page of this document it goes to. */
  page?: number
  point?: [number, number]
  /** A web address or another file: shown as a tooltip only. */
  uri?: string
}

/** More than any real book has; a bound against looping or hostile outlines. */
const MAX_ENTRIES = 20000
const MAX_DEPTH = 64

const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n)

/** Where an internal address goes: page and, for XYZ/FitH/FitR destinations, a point. */
function destination(doc: PdfDoc, uri: string, count: number): { page: number; point?: [number, number] } | null {
  try {
    const d = doc.resolveLinkDestination(uri)
    if (!finite(d.page) || d.page < 0 || d.page >= count) return null
    // MuPDF gives the point on the page as displayed; a missing coordinate is NaN.
    const hasPoint = d.type === 'XYZ' || d.type === 'FitH' || d.type === 'FitBH' || d.type === 'FitR' || d.type === 'FitV' || d.type === 'FitBV'
    if (hasPoint && (finite(d.x) || finite(d.y))) return { page: d.page, point: [finite(d.x) ? d.x : 0, finite(d.y) ? d.y : 0] }
    return { page: d.page }
  } catch {
    return null
  }
}

const external = (uri: string): boolean => !uri.startsWith('#')

/** The document's bookmarks, nested; empty when it has none. */
export function documentOutline(doc: PdfDoc): OutlineEntry[] {
  let items: ReturnType<PdfDoc['loadOutline']>
  try {
    items = doc.loadOutline()
  } catch {
    return []
  }
  if (!items) return []
  const count = doc.countPages()
  let seen = 0
  const walk = (list: NonNullable<typeof items>, depth: number): OutlineEntry[] => {
    const out: OutlineEntry[] = []
    for (const item of list) {
      if (++seen > MAX_ENTRIES) break
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim()
      const entry: OutlineEntry = { title, page: null, open: !!item.open, children: [] }
      const uri = item.uri ?? ''
      if (uri && external(uri)) entry.uri = uri
      else if (uri) {
        const d = destination(doc, uri, count)
        if (d) {
          entry.page = d.page
          if (d.point) entry.point = d.point
        }
      } else if (typeof item.page === 'number' && item.page >= 0 && item.page < count) entry.page = item.page
      if (item.down?.length && depth < MAX_DEPTH) entry.children = walk(item.down, depth + 1)
      out.push(entry)
    }
    return out
  }
  return walk(items, 0)
}

/** The links on a page: to pages of this document, or to addresses outside it. */
export function pageLinks(doc: PdfDoc, pageIndex: number): LinkEntry[] {
  const count = doc.countPages()
  if (pageIndex < 0 || pageIndex >= count) return []
  const page = doc.loadPage(pageIndex)
  let links: mupdf.Link[] = []
  try {
    links = page.getLinks()
    const out: LinkEntry[] = []
    for (const link of links) {
      const b = link.getBounds()
      if (!(b[2] > b[0] && b[3] > b[1])) continue
      const box: [number, number, number, number] = [b[0], b[1], b[2], b[3]]
      let uri = ''
      try {
        uri = link.getURI() ?? ''
      } catch {
        continue
      }
      if (!uri) continue
      if (link.isExternal() || external(uri)) {
        out.push({ box, uri })
        continue
      }
      const d = destination(doc, uri, count)
      if (d) out.push({ box, page: d.page, ...(d.point ? { point: d.point } : {}) })
    }
    return out
  } finally {
    free(...links, page)
  }
}

import type { mupdf, PdfDoc } from './mupdf'
import { rewriteContents, tokens, type Token } from './contentfix'
import { namesIn, unlinkProperties } from './redactresources'
import { clearTagText } from './structtext'

/**
 * Marked content can carry its own text: /ActualText (what copy and search read instead of the
 * glyphs), /Alt (a description for screen readers), /E (an abbreviation's expansion) and /T (a
 * language-tagged title). MuPDF's redaction removes the glyphs and leaves the span and its
 * dictionary, so "/Span <</ActualText (Account 98765)>> BDC … EMC" kept the account number in the
 * file after the number itself was gone (measured on MuPDF 1.28.1). Only the page's own content is
 * read: spans inside a form XObject the page draws are not changed here.
 *
 * `clearReplacementText` runs a removal and then clears these four entries from every span the
 * removal changed: one whose text, pictures or shadings are no longer exactly what they were.
 * Spans the removal did not touch keep their accessibility text. A span is matched by its tag,
 * its properties and what it draws, so MuPDF rewriting the page's layout and numbers does not
 * count as a change; anything that does not match is treated as changed (the safe side).
 *
 * A span that names its properties in the page's /Properties is given its own dictionary (only its
 * MCID), and the named entry is removed from the page's resources, and from a dictionary the page
 * inherits or shares, once nothing drawing through them still names it.
 *
 * The structure tree's elements that tag a changed or removed span (by its MCID) lose theirs too
 * (structtext.ts).
 */
const KEYS = new Set(['/ActualText', '/Alt', '/E', '/T'])
const DRAWS = new Set(['Tj', 'TJ', "'", '"', 'Do', 'EI', 'sh'])

interface Span {
  tag: string
  /** Where the properties operand is in the stream: an inline dictionary or a resource name. */
  start: number
  end: number
  named: string | null
  props: string
  text: string[]
  objects: string[]
}

export function clearReplacementText<T>(doc: PdfDoc, pageIndex: number, removal: () => T): T {
  // Each span's key, with the MCIDs of the spans that have it (one entry per span).
  const before = new Map<string, Array<number | null>>()
  try {
    for (const span of spansOf(joinedContents(doc, pageIndex))) {
      const key = keyOf(span)
      const list = before.get(key) ?? []
      list.push(mcidOf(doc, pageIndex, span))
      before.set(key, list)
    }
  } catch {
    // An unreadable page: every span counts as changed below.
  }
  const result = removal()
  const retired = new Set<string>()
  const changed = new Set<number>()
  rewriteContents(doc, pageIndex, (source) => {
    const edits: Array<{ start: number; end: number; text: string }> = []
    for (const span of spansOf(source)) {
      if (span.start < 0) continue
      const key = keyOf(span)
      const left = before.get(key)
      if (left && left.length > 0) {
        left.shift()
        continue
      }
      const mcid = mcidOf(doc, pageIndex, span)
      if (mcid !== null) changed.add(mcid)
      if (span.named) {
        const dict = namedProperties(doc, pageIndex, span.named)
        if (!dict || ![...KEYS].some((k) => !dict.get(k.slice(1)).isNull())) continue
        // A shared resource is not changed: this span gets its own dictionary, keeping its MCID.
        retired.add(span.named.slice(1))
        const mcid = dict.get('MCID')
        edits.push({ start: span.start, end: span.end, text: mcid.isNumber() ? `<</MCID ${mcid.asNumber()}>>` : '<<>>' })
      } else {
        const stripped = withoutKeys(source.slice(span.start, span.end))
        if (stripped !== null) edits.push({ start: span.start, end: span.end, text: stripped })
      }
    }
    let text = source
    for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
    return { text, count: edits.length }
  })
  if (retired.size > 0) retire(doc, pageIndex, retired)
  // Spans the removal took away altogether.
  for (const list of before.values()) for (const mcid of list) if (mcid !== null) changed.add(mcid)
  clearTagText(doc, pageIndex, changed)
  return result
}

/** The span's marked-content ID, from its inline dictionary or the named one. */
function mcidOf(doc: PdfDoc, pageIndex: number, span: Span): number | null {
  if (span.named) {
    const id = namedProperties(doc, pageIndex, span.named)?.get('MCID')
    return id?.isNumber() ? id.asNumber() : null
  }
  const m = /\/MCID (\d+)/.exec(span.props)
  return m ? Number(m[1]) : null
}

/** Drops property lists this page no longer names from its own resources and the page tree's. */
function retire(doc: PdfDoc, pageIndex: number, names: Set<string>): void {
  const used = namesIn(joinedContents(doc, pageIndex))
  const gone = new Set([...names].filter((n) => !used.has(n)))
  if (gone.size === 0) return
  const page = doc.findPage(pageIndex)
  const res = page.get('Resources')
  const props = res.isDictionary() ? res.get('Properties') : null
  if (res.isDictionary() && props?.isDictionary()) {
    // New dictionaries for this page: its resources may be shared with other pages.
    const kept = doc.newDictionary()
    props.forEach((val, key) => {
      if (!gone.has(String(key))) kept.put(String(key), val)
    })
    const own = doc.newDictionary()
    res.forEach((val, key) => own.put(String(key), val))
    own.put('Properties', kept)
    page.put('Resources', own)
  }
  try {
    unlinkProperties(doc, gone)
  } catch {
    // A page tree that cannot be followed keeps its shared dictionaries; this page no longer uses them.
  }
}

/** The page's content streams as one, joined with a space as readers join them. */
function joinedContents(doc: PdfDoc, pageIndex: number): string {
  const contents = doc.findPage(pageIndex).get('Contents')
  const items: mupdf.PDFObject[] = []
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) items.push(contents.get(i))
  else if (contents.isStream()) items.push(contents)
  return items
    .filter((item) => item.isStream())
    .map((item) => {
      const buffer = item.readStream()
      const s = Buffer.from(buffer.asUint8Array()).toString('latin1')
      buffer.destroy()
      return s
    })
    .join(' ')
}

function namedProperties(doc: PdfDoc, pageIndex: number, name: string): mupdf.PDFObject | null {
  try {
    const d = doc.findPage(pageIndex).getInheritable('Resources').get('Properties').get(name.slice(1))
    return d.isDictionary() ? d : null
  } catch {
    return null
  }
}

function keyOf(span: Span): string {
  return JSON.stringify([span.tag, span.named ?? span.props, span.text.join(''), span.objects])
}

/** Every marked-content span of a stream, with what it draws (nested spans count for each parent). */
export function spansOf(s: string): Span[] {
  const ts = tokens(s)
  const out: Span[] = []
  const open: Span[] = []
  let operands: Token[] = []
  for (const t of ts) {
    if (t.kind !== 'op') {
      operands.push(t)
      continue
    }
    const v = t.value
    if (v === 'BDC' || v === 'BMC') {
      const span: Span = { tag: operands[0]?.value ?? '', start: -1, end: -1, named: null, props: '', text: [], objects: [] }
      const last = operands[operands.length - 1]
      if (v === 'BDC' && last && operands.length >= 2) {
        if (last.value === '>>') {
          let depth = 0
          let j = operands.length - 1
          for (; j >= 0; j--) {
            const x = operands[j]!.value
            if (x === '>>') depth++
            else if (x === '<<' && --depth === 0) break
          }
          if (j >= 0) {
            span.start = operands[j]!.start
            span.end = last.end
            span.props = canonical(s.slice(span.start, span.end))
          }
        } else if (last.value.startsWith('/')) {
          span.start = last.start
          span.end = last.end
          span.named = last.value
        }
      }
      out.push(span)
      open.push(span)
    } else if (v === 'EMC') {
      open.pop()
    } else if (DRAWS.has(v)) {
      const strings = operands.filter((o) => o.value === '()' || o.value === '<>').map((o) => decoded(s, o))
      const names = operands.filter((o) => o.value.startsWith('/')).map((o) => o.value)
      for (const span of open) {
        span.text.push(...strings)
        if (v === 'Do' || v === 'sh') span.objects.push(`${v}${names.join('')}`)
        else if (v === 'EI') span.objects.push('EI')
      }
    }
    operands = []
  }
  return out
}

/** A dictionary written the same way however it was spaced or its strings escaped. */
function canonical(text: string): string {
  return tokens(text)
    .map((t) => (t.value === '()' || t.value === '<>' ? `(${decoded(text, t)})` : t.value))
    .join(' ')
}

/** An inline properties dictionary without the four replacement-text entries, or null if it has none. */
export function withoutKeys(text: string): string | null {
  const ts = tokens(text)
  const cut: Array<[number, number]> = []
  let depth = 0
  let k = 0
  while (k < ts.length) {
    const t = ts[k]!
    if (t.value === '<<') depth++
    else if (t.value === '>>') depth--
    else if (depth === 1 && t.value.startsWith('/')) {
      let end = k + 1
      const first = ts[end]
      if (first && (first.value === '<<' || first.value === '[')) {
        let d = 0
        for (; end < ts.length; end++) {
          const x = ts[end]!.value
          if (x === '<<' || x === '[') d++
          else if ((x === '>>' || x === ']') && --d === 0) break
        }
      } else if (first?.kind === 'number' && ts[end + 2]?.value === 'R') end += 2
      end = Math.min(end, ts.length - 1)
      if (KEYS.has(t.value)) cut.push([t.start, ts[end]!.end])
      k = end + 1
      continue
    }
    k++
  }
  if (cut.length === 0) return null
  let out = text
  for (const [a, b] of cut.reverse()) out = `${out.slice(0, a)} ${out.slice(b)}`
  return out
}

/** The bytes of a literal or hex string token, as latin1 characters. */
function decoded(s: string, t: Token): string {
  const body = s.slice(t.start + 1, t.end - 1)
  if (t.value === '<>') {
    const hex = body.replace(/[^0-9a-fA-F]/g, '')
    let out = ''
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16))
    return out
  }
  const slash = String.fromCharCode(92)
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')' }
  escapes[slash] = slash
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== slash) {
      out += c
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (next in escapes) out += escapes[next]
    else if (/[0-7]/.test(next)) {
      let digits = next
      while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) digits += body[++i]
      out += String.fromCharCode(parseInt(digits, 8) & 255)
    } else if (next === '\r') {
      if (body[i + 1] === '\n') i++
    } else if (next !== '\n') out += next
  }
  return out
}

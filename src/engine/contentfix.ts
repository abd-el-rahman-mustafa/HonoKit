import type { mupdf, PdfDoc } from './mupdf'

/**
 * Repairs a MuPDF 1.28 redaction bug (docs/decisions.md §58). When the first line of a text block
 * (BT … ET) is removed and the following lines are placed with T* or ', MuPDF rewrites the block
 * starting with "x y TD" — an absolute position given with TD, which also sets the leading to −y.
 * Every following T* then jumps hundreds of points up, off the page (on a newspaper page,
 * removing one line threw away the five lines under it).
 *
 * A TD that moves up (y > 0) never occurs in real typesetting — it would set a negative leading —
 * so each one is turned into "x y Td" followed by the leading the block really uses: the one the
 * next TD in the same block sets. Returns how many were repaired; the caller checks the page.
 */
export function repairLeading(doc: PdfDoc, pageIndex: number): number {
  return rewriteContents(doc, pageIndex, (source) => fixStream(source))
}

/**
 * Rewrites one page's content streams with `fix` (called on each stream in order) and returns the
 * number of changes. A changed stream is written as a NEW stream object for this page only, and the
 * page gets its own /Contents: a stream (or a /Contents array) shared with other pages, or with a
 * form, is never changed in place, so those other pages keep drawing exactly what they drew.
 */
export function rewriteContents(doc: PdfDoc, pageIndex: number, fix: (source: string) => { text: string; count: number }): number {
  const page = doc.findPage(pageIndex)
  const contents = page.get('Contents')
  const items: mupdf.PDFObject[] = []
  if (contents.isArray()) for (let i = 0; i < contents.length; i++) items.push(contents.get(i))
  else if (contents.isStream()) items.push(contents)
  let changed = 0
  const out: mupdf.PDFObject[] = []
  for (const item of items) {
    if (!item.isStream()) {
      out.push(item)
      continue
    }
    const buffer = item.readStream()
    const source = Buffer.from(buffer.asUint8Array()).toString('latin1')
    buffer.destroy()
    const { text, count } = fix(source)
    if (count > 0) {
      out.push(doc.addStream(Buffer.from(text, 'latin1'), doc.newDictionary()))
      changed += count
    } else out.push(item)
  }
  if (changed > 0) {
    if (contents.isArray()) {
      const array = doc.newArray()
      for (const o of out) array.push(o)
      page.put('Contents', array)
    } else page.put('Contents', out[0]!)
  }
  return changed
}

/**
 * Rewrites a page's text positioning so nothing depends on the leading (TL), before MuPDF's
 * redaction reads it. MuPDF 1.28 confuses Td with TD both when reading and when writing a block:
 * after "195.59 266 Td", a following ' moved 266 pt up instead of 9.5 pt down — even a removal that
 * touched nothing moved six lines of a newspaper page 275.5 pt. With every move explicit there is nothing
 * for it to get wrong; the page draws exactly as before:
 *   T* → 0 −L Td    (s) ' → 0 −L Td (s) Tj    aw ac (s) " → aw Tw ac Tc 0 −L Td (s) Tj
 *   x y TD → x y Td −y TL    L TL → kept (L remembered)
 * The leading itself is still set as before (TL is kept, and a TD's leading is written as a TL):
 * a form XObject drawn later, or text MuPDF does not rewrite, may still use the leading the page set.
 * L is followed through the page's streams, saved and restored by q and Q as the graphics state is.
 * Changed streams are written as new objects for this page only (see rewriteContents).
 */
export function explicitLeading(doc: PdfDoc, pageIndex: number): number {
  const state = { leading: 0, stack: [] as number[] }
  return rewriteContents(doc, pageIndex, (source) => explicitStream(source, state))
}

export function explicitStream(s: string, state = { leading: 0, stack: [] as number[] }): { text: string; count: number } {
  const ts = tokens(s)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const num = (v: number): string => String(+v.toFixed(5))
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k]!
    if (t.kind !== 'op') continue
    const down = (): string => `0 ${num(-state.leading)} Td`
    switch (t.value) {
      case 'q':
        state.stack.push(state.leading)
        break
      case 'Q':
        state.leading = state.stack.pop() ?? state.leading
        break
      case 'TL':
        if (ts[k - 1]?.kind === 'number') state.leading = Number(ts[k - 1]!.value)
        break
      case 'TD':
        if (ts[k - 1]?.kind === 'number' && ts[k - 2]?.kind === 'number') {
          state.leading = -Number(ts[k - 1]!.value)
          edits.push({ start: t.start, end: t.end, text: `Td ${num(state.leading)} TL` })
        }
        break
      case 'T*':
        edits.push({ start: t.start, end: t.end, text: down() })
        break
      case "'": {
        const str = ts[k - 1]
        if (str && str.kind === 'other' && (str.value === '()' || str.value === '<>')) edits.push({ start: str.start, end: t.end, text: `${down()} ${s.slice(str.start, str.end)} Tj` })
        break
      }
      case '"': {
        const [aw, ac, str] = [ts[k - 3], ts[k - 2], ts[k - 1]]
        if (aw?.kind === 'number' && ac?.kind === 'number' && str && (str.value === '()' || str.value === '<>')) {
          edits.push({ start: aw.start, end: t.end, text: `${aw.value} Tw ${ac.value} Tc ${down()} ${s.slice(str.start, str.end)} Tj` })
        }
        break
      }
    }
  }
  if (edits.length === 0) return { text: s, count: 0 }
  let text = s
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  return { text, count: edits.length }
}

export interface Token {
  kind: 'number' | 'op' | 'other'
  value: string
  start: number
  end: number
}

/** The tokens of a content stream; strings, hex strings, arrays' brackets and dictionaries are skipped over as "other". */
export function tokens(s: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = s.length
  const delim = (c: string): boolean => /[\s()<>[\]{}/%]/.test(c)
  while (i < n) {
    const c = s[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++
    } else if (c === '(') {
      const start = i
      let depth = 0
      for (; i < n; i++) {
        const ch = s[i]
        if (ch === '\\') i++
        else if (ch === '(') depth++
        else if (ch === ')' && --depth === 0) {
          i++
          break
        }
      }
      out.push({ kind: 'other', value: '()', start, end: i })
    } else if (c === '<' && s[i + 1] === '<') {
      out.push({ kind: 'other', value: '<<', start: i, end: i + 2 })
      i += 2
    } else if (c === '>' && s[i + 1] === '>') {
      out.push({ kind: 'other', value: '>>', start: i, end: i + 2 })
      i += 2
    } else if (c === '<') {
      const start = i
      while (i < n && s[i] !== '>') i++
      i++
      out.push({ kind: 'other', value: '<>', start, end: i })
    } else if (c === '[' || c === ']' || c === '{' || c === '}' || c === '>') {
      out.push({ kind: 'other', value: c, start: i, end: i + 1 })
      i++
    } else if (c === '/') {
      const start = i++
      while (i < n && !delim(s[i]!)) i++
      out.push({ kind: 'other', value: s.slice(start, i), start, end: i })
    } else {
      const start = i
      while (i < n && !delim(s[i]!)) i++
      if (i === start) i++
      const value = s.slice(start, i)
      out.push({ kind: /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'op', value, start, end: i })
      // Inline images carry binary data: skip to the EI that ends it — whitespace before it (or
      // none, for empty data) and whitespace or a delimiter after. "EI" bytes inside the picture
      // itself are not followed that way, or not preceded by whitespace.
      if (value === 'ID') {
        const begin = i + 1
        let j = begin
        for (; j + 1 < n; j++) {
          if (s[j] !== 'E' || s[j + 1] !== 'I') continue
          if (j > begin && !/\s/.test(s[j - 1]!)) continue
          if (j + 2 < n && !delim(s[j + 2]!)) continue
          break
        }
        if (j + 1 >= n) {
          // No EI standing alone (a producer that writes none before it): the first one followed
          // by a delimiter, rather than skipping the rest of the stream.
          const loose = /EI(?=[\s()<>[\]{}/%]|$)/g
          loose.lastIndex = begin
          const m = loose.exec(s)
          j = m ? m.index : n
        }
        i = Math.min(j, n)
      }
    }
  }
  return out
}

export function fixStream(s: string): { text: string; count: number } {
  const ts = tokens(s)
  const edits: Array<{ start: number; end: number; text: string }> = []
  let blockStart = -1
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k]!
    if (t.kind !== 'op') continue
    if (t.value === 'BT') blockStart = k
    else if (t.value === 'ET') blockStart = -1
    else if (t.value === 'TD' && blockStart >= 0 && k >= 2 && ts[k - 1]!.kind === 'number' && ts[k - 2]!.kind === 'number') {
      const ty = Number(ts[k - 1]!.value)
      if (!(ty > 0)) continue
      // The leading the block uses: the next TD's (moving down), or an explicit TL after it.
      let leading: number | null = null
      for (let j = k + 1; j < ts.length; j++) {
        const u = ts[j]!
        if (u.kind === 'op' && u.value === 'ET') break
        if (u.kind === 'op' && u.value === 'TL' && ts[j - 1]?.kind === 'number') break // set again later anyway
        if (u.kind === 'op' && u.value === 'TD' && ts[j - 1]?.kind === 'number') {
          const next = Number(ts[j - 1]!.value)
          if (next < 0) leading = -next
          break
        }
      }
      if (leading === null) continue
      edits.push({ start: t.start, end: t.end, text: `Td ${+leading.toFixed(4)} TL` })
    }
  }
  if (edits.length === 0) return { text: s, count: 0 }
  let text = s
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  return { text, count: edits.length }
}

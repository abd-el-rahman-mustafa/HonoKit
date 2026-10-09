import type { mupdf, PdfDoc } from './mupdf'

/**
 * Some PDFs say the wrong letters for a ligature: the font draws one glyph named "f_t" (the
 * "ft" of "giftshop"), but the file's ToUnicode map says it is only "t". Every reader then
 * reads "gitshop", and an edit would retype it without the f. When a simple font names its
 * glyphs (an /Encoding with /Differences), that name is trusted over a map that gives only part
 * of it, and the map is rewritten (docs/decisions.md §57). Fonts without glyph names are left as
 * they are.
 */

/** The letters a glyph name stands for, if it is a ligature ("f_t" → "ft", "fi" → "fi"). */
export function ligatureLetters(glyphName: string): string | null {
  const name = glyphName.replace(/\..*$/, '')
  const part = (p: string): string | null => {
    if (/^[A-Za-z]$/.test(p)) return p
    const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(p)
    if (uni) return String.fromCodePoint(...uni[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16)))
    const u = /^u([0-9A-F]{4,6})$/.exec(p)
    if (u) return String.fromCodePoint(parseInt(u[1]!, 16))
    return null
  }
  if (name.includes('_')) {
    const parts = name.split('_').map(part)
    if (parts.length < 2 || parts.some((p) => p === null)) return null
    return parts.join('')
  }
  // The usual unnamed-part ligatures of Latin type.
  return /^(ff|fi|fl|ffi|ffl|ft|fj|fb|fh|fk|tt|st|ct|Th)$/.test(name) ? name : null
}

/** Codes one bfrange may cover: every two-byte code, no more (a broken map cannot run away). */
const MAX_RANGE = 0x10000

/** A ToUnicode CMap, read into code → text. */
export function readToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>()
  // UTF-16BE units; a destination written in one byte (<41>, as some producers do) is that unit.
  const text = (hex: string): string => {
    const padded = hex.length % 4 === 0 ? hex : hex.padStart(hex.length + 4 - (hex.length % 4), '0')
    const units = (padded.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))
    return String.fromCharCode(...units)
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) out.set(parseInt(m[1]!, 16), text(m[2]!))
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16)
      const hi = parseInt(m[2]!, 16)
      // Real producers write wide ranges (<0003> <0241> <0020>): stepped through code by code.
      if (hi < lo || hi - lo >= MAX_RANGE) continue
      if (m[3]!.startsWith('[')) {
        const items = [...m[3]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => text(x[1]!))
        items.forEach((t, i) => lo + i <= hi && out.set(lo + i, t))
      } else {
        const start = text(m[3]!.slice(1, -1))
        if (!start) continue
        // The last UTF-16 unit counts up through the range.
        const head = start.slice(0, -1)
        const last = start.charCodeAt(start.length - 1)
        for (let c = lo; c <= hi; c++) out.set(c, head + String.fromCharCode(last + (c - lo)))
      }
    }
  }
  return out
}

export function writeToUnicode(map: Map<number, string>): string {
  const hex = (s: string): string => [...s].flatMap((c) => {
    const cp = c.codePointAt(0)!
    if (cp < 0x10000) return [cp]
    const v = cp - 0x10000
    return [0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)]
  }).map((u) => u.toString(16).padStart(4, '0').toUpperCase()).join('')
  // A one-byte map (codespace <00> <FF>, the simple fonts repaired here): wider codes cannot be written in it.
  const entries = [...map].filter(([c, t]) => t.length > 0 && c >= 0 && c <= 0xff).sort((a, b) => a[0] - b[0])
  const blocks: string[] = []
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([c, t]) => `<${c.toString(16).padStart(2, '0').toUpperCase()}> <${hex(t)}>`).join('\n')}\nendbfchar`)
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`
}

/**
 * Every object handle the walk takes is kept here and released at the end. MuPDF.js frees a
 * handle only from a finalizer after JavaScript's garbage collection, which does not see WASM
 * memory: walking every page's fonts on each opening held about 1 MB per opening of a newspaper,
 * and a long run of edits ran MuPDF out of memory.
 */
type Take = <T extends mupdf.PDFObject | null | undefined>(o: T) => T

/** The glyph names of a simple font's /Differences, by code. */
function differences(font: mupdf.PDFObject, take: Take): Map<number, string> {
  const out = new Map<number, string>()
  const enc = take(font.get('Encoding'))
  const dict = enc && enc.isIndirect() ? take(enc.resolve()) : enc
  if (!dict || !dict.isDictionary()) return out
  const diff = take(dict.get('Differences'))
  const arr = diff && diff.isIndirect() ? take(diff.resolve()) : diff
  if (!arr || !arr.isArray()) return out
  let code = 0
  for (let i = 0; i < arr.length; i++) {
    const x = take(arr.get(i))
    if (x.isNumber()) code = x.asNumber()
    else if (x.isName()) out.set(code++, x.asName())
  }
  return out
}

/** Fixes one font's map; true when it changed. */
function repairFont(doc: PdfDoc, font: mupdf.PDFObject, take: Take): boolean {
  const subtype = take(font.get('Subtype'))
  if (!subtype.isName() || !['Type1', 'TrueType', 'MMType1'].includes(subtype.asName())) return false
  const names = differences(font, take)
  const fixes: Array<[number, string]> = []
  for (const [code, name] of names) {
    const letters = ligatureLetters(name)
    if (letters && letters.length > 1) fixes.push([code, letters])
  }
  if (fixes.length === 0) return false
  // A stream answers isStream() as the indirect reference, not once resolved.
  const tu = take(font.get('ToUnicode'))
  if (!tu || !tu.isStream()) return false // without a map, MuPDF reads the glyph names itself
  const buffer = tu.readStream()
  const map = readToUnicode(buffer.asString())
  buffer.destroy()
  let changed = false
  for (const [code, letters] of fixes) {
    const now = map.get(code) ?? ''
    // Only a map that gives part of the ligature (or nothing) is wrong; "ﬁ" or other text is left.
    if (now === letters || (now.length > 0 && !letters.includes(now))) continue
    map.set(code, letters)
    changed = true
  }
  if (!changed) return false
  font.put('ToUnicode', take(doc.addStream(writeToUnicode(map), take(doc.newDictionary()))))
  return true
}

/** Repairs the ligature maps of every font the pages use; the number of fonts fixed. */
export function repairLigatures(doc: PdfDoc): number {
  const taken: Array<{ destroy(): void }> = []
  const take: Take = (o) => {
    if (o) taken.push(o)
    return o
  }
  const seen = new Set<number>()
  let fixed = 0
  const deref = (o: mupdf.PDFObject | null): mupdf.PDFObject | null => (o && o.isIndirect() ? take(o.resolve()) : o)
  const visit = (fonts: mupdf.PDFObject | null): void => {
    const dict = deref(fonts)
    if (!dict || !dict.isDictionary()) return
    dict.forEach((value) => {
      take(value)
      if (!value) return
      const num = value.isIndirect() ? value.asIndirect() : 0
      if (num && seen.has(num)) return
      if (num) seen.add(num)
      const font = deref(value)
      if (font && font.isDictionary() && repairFont(doc, font, take)) fixed++
    })
  }
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const res = deref(take(take(doc.findPage(i)).getInheritable('Resources')))
      if (!res || !res.isDictionary()) continue
      visit(take(res.get('Font')))
      const xobjects = deref(take(res.get('XObject')))
      if (xobjects && xobjects.isDictionary()) {
        xobjects.forEach((x) => {
          take(x)
          const form = deref(x)
          const r = form && form.isDictionary() ? deref(take(form.get('Resources'))) : null
          if (r && r.isDictionary()) visit(take(r.get('Font')))
        })
      }
    }
  } finally {
    for (const o of taken) {
      try {
        o.destroy()
      } catch {
        // already released
      }
    }
  }
  return fixed
}

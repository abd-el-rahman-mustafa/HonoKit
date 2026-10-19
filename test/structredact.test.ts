import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { applyOperation } from '@ops/index'

/**
 * A one-page tagged PDF written by hand. Objects 1–5 are the catalog, pages, page, font and
 * content; `extra` are objects 6 onwards (the structure tree), `catalog` and `page` go into those
 * dictionaries as they are.
 */
function taggedPdf(content: string, extra: string[], catalog: string, page = ''): Uint8Array {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> ${catalog} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /StructParents 0 ${page} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...extra
  ]
  let out = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** Every object of the file, streams decoded, as text. */
function wholeFile(bytes: Uint8Array): string {
  const doc = openPdf(bytes)
  try {
    const out = doc.saveToBuffer('decompress=yes')
    try {
      return out.asString()
    } finally {
      out.destroy()
    }
  } finally {
    free(doc)
  }
}

const CONTENT = [
  '/P << /MCID 0 >> BDC BT /F1 12 Tf 50 300 Td (Account 98765) Tj ET EMC',
  '/P << /MCID 1 >> BDC BT /F1 12 Tf 50 150 Td (Public line) Tj ET EMC'
].join('\n')

// The first line sits at y 300 from the bottom: 100 from the top, about 12 points tall.
const MARK = { page: 0, box: [40, 84, 220, 106] as [number, number, number, number] }

async function redact(src: Uint8Array): Promise<Uint8Array> {
  const marked = await applyOperation(src, { op: 'redactMark', marks: [MARK] })
  return (await applyOperation(marked.bytes, { op: 'redactApply' })).bytes
}

describe('redaction and the structure tree', () => {
  it('the tag of removed text loses its actual and alternate text; other tags keep theirs', async () => {
    const src = taggedPdf(
      CONTENT,
      [
        '<< /Type /StructTreeRoot /K 7 0 R /ParentTree << /Nums [0 [8 0 R 9 0 R]] >> >>',
        '<< /Type /StructElem /S /Document /P 6 0 R /K [8 0 R 9 0 R] >>',
        '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 /ActualText (Account HIDDEN-98765) /Alt (Alt 98765) /E (Exp 98765) >>',
        '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 1 /ActualText (Kept description) >>'
      ],
      '/StructTreeRoot 6 0 R'
    )
    const out = await redact(src)
    const file = wholeFile(out)
    expect(file).not.toContain('98765')
    expect(file).toContain('Kept description')
    // The tree itself stays: the element and its MCID are there for the content left.
    expect(file).toContain('/StructTreeRoot')
  })

  it('an element reached only through the parent tree or the ID tree is cleaned too', async () => {
    // Element 8 is not under the root's /K: only the parent tree names it (9: only the ID tree).
    const content = [
      '/P << /MCID 0 >> BDC BT /F1 12 Tf 50 300 Td (Account 98765) Tj ET EMC',
      '/P << /MCID 1 >> BDC BT /F1 12 Tf 200 300 Td (Code 4242) Tj ET EMC'
    ].join('\n')
    const src = taggedPdf(
      content,
      [
        '<< /Type /StructTreeRoot /K 7 0 R /ParentTree << /Nums [0 [8 0 R 9 0 R]] >> /IDTree << /Names [(e9) 9 0 R] >> >>',
        '<< /Type /StructElem /S /Document /P 6 0 R /K [] >>',
        '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 /ActualText (Parent tree 98765) >>',
        '<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 1 /ID (e9) /Alt (ID tree 4242) >>'
      ],
      '/StructTreeRoot 6 0 R'
    )
    const marked = await applyOperation(src, { op: 'redactMark', marks: [{ page: 0, box: [40, 84, 300, 106] }] })
    const out = (await applyOperation(marked.bytes, { op: 'redactApply' })).bytes
    const file = wholeFile(out)
    expect(file).not.toContain('98765')
    expect(file).not.toContain('4242')
  })

  it('an element that inherits its page, and the elements around removed text, lose theirs', async () => {
    // The /Pg is on the parent; the /Span holding the MCID has none. The /Sect around it has
    // actual text that spells out its content, the removed words included.
    const src = taggedPdf(
      CONTENT,
      [
        '<< /Type /StructTreeRoot /K [7 0 R 9 0 R] /ParentTree << /Nums [0 [8 0 R 10 0 R]] >> >>',
        '<< /Type /StructElem /S /Sect /P 6 0 R /Pg 3 0 R /K [8 0 R 10 0 R] /ActualText (Section 98765) >>',
        '<< /Type /StructElem /S /Span /P 7 0 R /K << /Type /MCR /MCID 0 >> /Alt (Inherited 98765) >>',
        '<< /Type /StructElem /S /Figure /P 6 0 R /Pg 3 0 R /K [] /Alt (Unrelated figure) >>',
        '<< /Type /StructElem /S /P /P 7 0 R /K 1 /ActualText (Kept description) >>'
      ],
      '/StructTreeRoot 6 0 R'
    )
    const file = wholeFile(await redact(src))
    expect(file).not.toContain('98765')
    expect(file).toContain('Kept description')
    expect(file).toContain('Unrelated figure')
  })

  it('a comment removed with the text is not kept in the file by its tag', async () => {
    const src = taggedPdf(
      CONTENT,
      [
        '<< /Type /StructTreeRoot /K 7 0 R /ParentTree << /Nums [0 [8 0 R 9 0 R] 1 7 0 R] >> >>',
        '<< /Type /StructElem /S /Annot /P 6 0 R /Pg 3 0 R /K << /Type /OBJR /Obj 10 0 R >> >>',
        '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>',
        '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 1 >>',
        '<< /Type /Annot /Subtype /Text /Rect [60 290 80 310] /Contents (Secret note 31337) /P 3 0 R /StructParent 1 >>'
      ],
      '/StructTreeRoot 6 0 R',
      '/Annots [10 0 R]'
    )
    const file = wholeFile(await redact(src))
    expect(file).not.toContain('31337')
  })
})

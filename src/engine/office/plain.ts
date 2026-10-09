import type { DocModel, ParagraphBlock, PictureBlock, TableBlock, TableCell } from './model'

/**
 * The model as Markdown or plain text (research §4.4): blocks in reading order — headings,
 * paragraphs, list items, tables — and, for Markdown, pictures saved beside the file.
 * Markdown has no direction of its own; an Arabic paragraph can be wrapped in
 * <div dir="rtl"> for viewers that honour it (on by default for Arabic documents).
 */

/** Neighbouring runs with the same emphasis as one (small capitals come as runs of two sizes). */
function emphasisRuns(b: ParagraphBlock): Array<{ text: string; bold: boolean; italic: boolean }> {
  const out: Array<{ text: string; bold: boolean; italic: boolean }> = []
  for (const r of b.runs) {
    // A heading is bold by being a heading.
    const bold = b.heading ? false : r.bold
    const last = out[out.length - 1]
    if (last && last.bold === bold && last.italic === r.italic) last.text += r.text
    else out.push({ text: r.text, bold, italic: r.italic })
  }
  return out
}

const text = (b: ParagraphBlock, markdown: boolean): string => {
  const body = emphasisRuns(b)
    .map((r) => {
      if (!markdown || !r.text.trim()) return r.text
      // Emphasis around the words, not their spaces (Markdown needs it tight).
      const lead = r.text.match(/^\s*/)![0]
      const tail = r.text.match(/\s*$/)![0]
      const core = r.text.trim().replace(/([*_`\\[\]])/g, '\\$1')
      const mark = r.bold && r.italic ? '***' : r.bold ? '**' : r.italic ? '*' : ''
      return `${lead}${mark}${core}${mark}${tail}`
    })
    .join('')
    .trim()
  if (b.list === 'bullet') return `${markdown ? '- ' : '• '}${body}`
  if (b.list === 'number') return `${b.marker} ${body}`
  if (markdown && b.heading) return `${'#'.repeat(b.heading)} ${body}`
  return body
}

/** `picture`: saves a cell's picture (a line the file maps to nothing, §68) and gives its reference. */
function tableMarkdown(t: TableBlock, picture: (p: PictureBlock) => string): string {
  const cellText = (c: TableCell): string =>
    [...c.paragraphs, ...c.pictures]
      .sort((a, b) => a.box[1] - b.box[1])
      .map((p) => (p.kind === 'paragraph' ? text(p, false).replace(/\|/g, '\\|') : picture(p)))
      .join(' ')
  const width = t.columns.length
  const rows = t.rows.map((row) => {
    const cells: string[] = []
    for (const c of row) {
      cells.push(cellText(c))
      for (let k = 1; k < c.span; k++) cells.push('')
    }
    while (cells.length < width) cells.push('')
    return `| ${cells.join(' | ')} |`
  })
  return [rows[0], `|${' --- |'.repeat(width)}`, ...rows.slice(1)].join('\n')
}

function tablePlain(t: TableBlock): string {
  return t.rows.map((row) => row.map((c) => c.paragraphs.map((p) => text(p, false)).join(' ')).join('\t')).join('\n')
}

export function writeMarkdown(model: DocModel, pictureFolder: string, rtlDivs: boolean): { text: string; pictures: Array<{ name: string; bytes: Uint8Array }> } {
  const out: string[] = []
  const pictures: Array<{ name: string; bytes: Uint8Array }> = []
  model.pages.forEach((page, pi) => {
    let k = 0
    const picture = (p: PictureBlock): string => {
      const name = `page${pi + 1}-${++k}.png`
      pictures.push({ name, bytes: p.png })
      return `![](${encodeURI(`${pictureFolder}/${name}`)})`
    }
    for (const b of page.blocks) {
      if (b.kind === 'paragraph') {
        const t = text(b, true)
        if (!t) continue
        out.push(rtlDivs && b.rtl ? `<div dir="rtl">\n\n${t}\n\n</div>` : t)
      } else if (b.kind === 'table') out.push(tableMarkdown(b, picture))
      else out.push(picture(b))
    }
  })
  return { text: `${out.join('\n\n')}\n`, pictures }
}

export function writePlainText(model: DocModel): string {
  const out: string[] = []
  for (const page of model.pages)
    for (const b of page.blocks) {
      if (b.kind === 'paragraph') out.push(text(b, false))
      else if (b.kind === 'table') out.push(tablePlain(b))
    }
  return `${out.filter(Boolean).join('\n\n')}\n`
}

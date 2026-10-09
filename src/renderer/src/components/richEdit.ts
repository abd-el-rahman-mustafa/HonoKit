import type { TextSpan } from '@shared/ipc'
import type { TextStyle } from '../store'

/**
 * The text box's editing surface (docs/decisions.md §65): a contenteditable element where words
 * can be in their own style, as in Acrobat, Foxit and PDFelement. The browser edits it (typing,
 * Arabic and mixed direction, its own Undo, typing on in the style at the caret); what it holds is
 * read back from what is shown — each character's computed style against the box's — so the box's
 * text and its stretches in other styles go to the engine without a markup of our own.
 */

/** The selection's look, for the format bar's buttons. */
export interface SelectionStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  colour: string
  size: number
}

/** What the open editor offers the format bar (one text box is edited at a time). */
export interface RichEditorApi {
  /** Some text is selected in the box (or was, before a field of the bar took the focus). */
  hasSelection(): boolean
  /** A style change for the selected text only. */
  applyToSelection(patch: Partial<TextStyle>): void
}

let active: RichEditorApi | null = null
export const setActiveEditor = (api: RichEditorApi | null): void => {
  active = api
}
export const activeEditor = (): RichEditorApi | null => active

const hex = (rgb: string): string => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb)
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : '#000000'
}
const firstFamily = (f: string): string => f.split(',')[0]!.trim().replace(/^["']|["']$/g, '')

/** How one character shows, as read from the page. */
interface Look {
  bold: boolean
  italic: boolean
  underline: boolean
  colour: string
  size: number
  family: string
}

function lookOf(el: Element, root: HTMLElement, base: { size: number }, rootPx: number): Look {
  const cs = getComputedStyle(el)
  // Underline is drawn by an ancestor (text-decoration is not inherited by computed style).
  let underline = false
  for (let n: Element | null = el; n; n = n === root ? null : n.parentElement) {
    if (n.tagName === 'U' || getComputedStyle(n).textDecorationLine.includes('underline')) underline = true
  }
  return {
    bold: Number(cs.fontWeight) >= 600,
    italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
    underline,
    colour: hex(cs.color),
    size: Math.round(((parseFloat(cs.fontSize) / rootPx) * base.size) * 2) / 2,
    family: firstFamily(cs.fontFamily)
  }
}

/**
 * The text in the box and its stretches in another style than the box itself. Line breaks are
 * <br> (and a block the browser may have made); the browser's own last <br> is not a line.
 */
export function readEditor(root: HTMLElement, base: { size: number }): { text: string; spans: TextSpan[] } {
  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16
  const rootLook = lookOf(root, root, base, rootPx)
  let text = ''
  const looks: Array<Look | null> = []
  const walk = (node: Node, first: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/ /g, ' ')
      if (!t) return
      const look = lookOf(node.parentElement ?? root, root, base, rootPx)
      text += t
      for (let i = 0; i < t.length; i++) looks.push(look)
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === 'BR') {
      text += '\n'
      looks.push(looks[looks.length - 1] ?? null)
      return
    }
    const block = node !== root && /^(DIV|P)$/.test(node.tagName)
    if (block && !first && !text.endsWith('\n')) {
      text += '\n'
      looks.push(looks[looks.length - 1] ?? null)
    }
    node.childNodes.forEach((c, i) => walk(c, i === 0 && first))
  }
  root.childNodes.forEach((c, i) => walk(c, i === 0))
  // The browser keeps a last <br> so an empty last line can hold the caret.
  if (text.endsWith('\n')) {
    text = text.slice(0, -1)
    looks.pop()
  }
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length; i++) {
    const l = looks[i]
    if (!l || /\s/.test(text[i]!)) {
      // A space belongs to the stretch before it.
      const last = spans[spans.length - 1]
      if (last && last.end === i && /\s/.test(text[i]!)) last.end = i + 1
      continue
    }
    const style: TextSpan['style'] = {}
    if (l.bold !== rootLook.bold) style.bold = l.bold
    if (l.italic !== rootLook.italic) style.italic = l.italic
    if (l.underline !== rootLook.underline) style.underline = l.underline
    if (l.colour !== rootLook.colour) style.colour = l.colour
    if (Math.abs(l.size - rootLook.size) >= 0.5) style.size = l.size
    if (l.family !== rootLook.family) style.family = l.family
    if (!Object.keys(style).length) continue
    const last = spans[spans.length - 1]
    if (last && last.end === i && JSON.stringify(last.style) === JSON.stringify(style)) last.end = i + 1
    else spans.push({ start: i, end: i + 1, style })
  }
  // A trailing space taken into a stretch is the body's again.
  for (const s of spans) while (s.end > s.start && /\s/.test(text[s.end - 1]!)) s.end--
  return { text, spans: spans.filter((s) => s.end > s.start) }
}

/** The box's content from text and its stretches (sizes relative to the box, so zooming keeps them). */
export function fillEditor(root: HTMLElement, text: string, spans: TextSpan[], base: { size: number }): void {
  const cuts = new Set<number>([0, text.length])
  for (const s of spans) {
    cuts.add(Math.max(0, s.start))
    cuts.add(Math.min(text.length, s.end))
  }
  const points = [...cuts].sort((a, b) => a - b)
  const nodes: Node[] = []
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]!
    const b = points[k + 1]!
    const piece = text.slice(a, b)
    const style = spans.find((s) => s.start <= a && s.end >= b)?.style
    const parts: Node[] = []
    piece.split('\n').forEach((line, i) => {
      if (i > 0) parts.push(document.createElement('br'))
      if (line) parts.push(document.createTextNode(line))
    })
    if (!style || !Object.keys(style).length) {
      nodes.push(...parts)
      continue
    }
    const span = document.createElement('span')
    if (style.bold !== undefined) span.style.fontWeight = style.bold ? '700' : '400'
    if (style.italic !== undefined) span.style.fontStyle = style.italic ? 'italic' : 'normal'
    if (style.underline) span.style.textDecoration = 'underline'
    if (style.colour) span.style.color = style.colour
    if (style.size) span.style.fontSize = `${style.size / base.size}em`
    if (style.family) span.style.fontFamily = `'${style.family}'`
    span.append(...parts)
    nodes.push(span)
  }
  // A last line break needs a <br> after it to show.
  if (text.endsWith('\n')) nodes.push(document.createElement('br'))
  root.replaceChildren(...nodes)
}

/** The selection's look (its start), or null when nothing is selected in `root`. */
export function selectionStyle(root: HTMLElement, base: { size: number }): SelectionStyle | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const start = range.startContainer
  const el = start.nodeType === Node.TEXT_NODE ? start.parentElement! : (start as Element)
  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16
  const l = lookOf(el, root, base, rootPx)
  return { bold: l.bold, italic: l.italic, underline: l.underline, colour: l.colour, size: l.size }
}

/**
 * Applies a style to the selected text with the browser's own commands (so its Undo takes them
 * back); the size, which those commands cannot set freely, by wrapping the selection.
 */
export function styleSelection(root: HTMLElement, patch: Partial<TextStyle>, current: SelectionStyle | null, base: { size: number }): void {
  document.execCommand('styleWithCSS', false, 'true')
  if (patch.bold !== undefined && patch.bold !== current?.bold) document.execCommand('bold')
  if (patch.italic !== undefined && patch.italic !== current?.italic) document.execCommand('italic')
  if (patch.underline !== undefined && patch.underline !== current?.underline) document.execCommand('underline')
  if (patch.colour) document.execCommand('foreColor', false, patch.colour)
  if (patch.family) document.execCommand('fontName', false, patch.family)
  if (patch.size) {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    const span = document.createElement('span')
    span.style.fontSize = `${patch.size / base.size}em`
    const contents = range.extractContents()
    // Sizes inside the selection give way to the new one.
    contents.querySelectorAll?.('[style]').forEach((e) => ((e as HTMLElement).style.fontSize = ''))
    span.append(contents)
    range.insertNode(span)
    sel.removeAllRanges()
    const again = document.createRange()
    again.selectNodeContents(span)
    sel.addRange(again)
  }
}

/** Rewrites the box's letters in place (Arabic-Indic ⇄ Western digits), styles kept. */
export function mapText(root: HTMLElement, fn: (s: string) => string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) n.textContent = fn(n.textContent ?? '')
}

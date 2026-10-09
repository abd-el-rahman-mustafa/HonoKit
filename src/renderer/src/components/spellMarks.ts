/**
 * Misspelled words in the text box, underlined as in Word, Acrobat and Foxit (docs/decisions.md §67).
 * The words are checked in the main process; here they are marked with the CSS Custom Highlight
 * API — ranges over the box's text, so nothing is added to what is being edited and the browser's
 * own Undo is untouched.
 */

const NAME = 'hono-spell'
/** Words the person chose to ignore, for this run. */
const ignored = new Set<string>()
let marked: Range[] = []
let generation = 0

/** The box's text as the editor reads it (a <br> is a line break), with where each text node starts. */
function textOf(root: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number }> } {
  let text = ''
  const nodes: Array<{ node: Text; start: number }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n instanceof Text) {
      nodes.push({ node: n, start: text.length })
      text += n.data
    } else if ((n as Element).tagName === 'BR') text += '\n'
  }
  return { text, nodes }
}

function rangeOf(nodes: Array<{ node: Text; start: number }>, start: number, end: number): Range | null {
  const at = (offset: number, isEnd: boolean): [Text, number] | null => {
    for (const n of nodes) {
      const len = n.node.data.length
      if (offset > n.start + len || (offset === n.start + len && !isEnd)) continue
      if (offset >= n.start) return [n.node, offset - n.start]
    }
    return null
  }
  const a = at(start, false)
  const b = at(end, true)
  if (!a || !b) return null
  const r = document.createRange()
  r.setStart(a[0], a[1])
  r.setEnd(b[0], b[1])
  return r
}

/** Checks the box and underlines what is misspelled (a later call wins over an earlier one still running). */
export async function markSpelling(root: HTMLElement): Promise<void> {
  const mine = ++generation
  const { text, nodes } = textOf(root)
  let found: Array<[number, number]> = []
  try {
    found = await window.api.spellCheck(text)
  } catch {
    return
  }
  if (mine !== generation || !root.isConnected) return
  marked = found
    .filter(([a, b]) => !ignored.has(text.slice(a, b)))
    .map(([a, b]) => rangeOf(nodes, a, b))
    .filter((r): r is Range => r !== null)
  CSS.highlights.set(NAME, new Highlight(...marked))
}

export function clearSpelling(): void {
  generation++
  marked = []
  CSS.highlights.delete(NAME)
}

/** The underlined word at a point of the window, if any. */
export function misspelledAt(x: number, y: number): Range | null {
  const caret = document.caretPositionFromPoint?.(x, y)
  if (!caret) return null
  return marked.find((r) => r.startContainer.isConnected && r.isPointInRange(caret.offsetNode, caret.offset) && !r.collapsed) ?? null
}

export function ignoreWord(word: string): void {
  ignored.add(word)
}

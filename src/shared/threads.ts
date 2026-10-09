/**
 * Comment threads for the Comments panel (decisions §82): a reply (/IRT) and a review
 * state go under the comment they answer, wherever in the document they sit. A reply whose comment
 * is not in the list (or a loop of replies) is shown as a comment of its own.
 */

export interface ThreadItem {
  id: number
  replyTo?: number
  state?: string
}

export interface Threads<T extends ThreadItem> {
  /** The comments shown as cards, in the list's order. */
  top: T[]
  /** A comment's replies and their replies, depth first, in the list's order; depth 1 = a direct reply. Review states left out. */
  repliesOf(item: T): Array<T & { depth: number }>
  /** The review states set directly on a comment. */
  statesOf(item: T): T[]
}

export function commentThreads<T extends ThreadItem>(items: T[]): Threads<T> {
  const byId = new Map<number, T>()
  for (const m of items) if (m.id > 0 && !byId.has(m.id)) byId.set(m.id, m)
  // Where an item's chain of replies leads: null when it is a comment of its own.
  const parentOf = (m: T): T | null => {
    if (m.replyTo === undefined) return null
    const parent = byId.get(m.replyTo)
    if (!parent || parent === m) return null
    // A loop of replies (A answers B, B answers A) has no comment at its head: shown on its own.
    const seen = new Set<T>([m])
    for (let at: T | undefined = parent; at; at = at.replyTo === undefined ? undefined : byId.get(at.replyTo)) {
      if (seen.has(at)) return null
      seen.add(at)
      if (seen.size > 256) return null
    }
    return parent
  }
  const children = new Map<T, T[]>()
  const top: T[] = []
  for (const m of items) {
    const parent = parentOf(m)
    if (!parent) top.push(m)
    else children.set(parent, [...(children.get(parent) ?? []), m])
  }
  const repliesOf = (item: T): Array<T & { depth: number }> => {
    const out: Array<T & { depth: number }> = []
    const walk = (m: T, depth: number): void => {
      for (const c of children.get(m) ?? []) {
        if (c.state) continue
        out.push({ ...c, depth })
        walk(c, depth + 1)
      }
    }
    walk(item, 1)
    return out
  }
  return { top, repliesOf, statesOf: (item) => (children.get(item) ?? []).filter((c) => !!c.state) }
}

/**
 * Text still being typed in a form field (decisions §82). A field's editor keeps
 * what the person types until they leave the field; Save, Print, Export, Share and the tools that
 * read the document commit it first, so a Ctrl+S pressed while typing saves the typed text.
 *
 * Each field registers its commit while its text differs from the document's, and clears it when
 * the text is committed by leaving the field or abandoned with Escape.
 */
export class PendingTyping {
  private readonly pending = new Map<string, Map<string, () => Promise<unknown>>>()
  private readonly listeners = new Set<() => void>()

  /** Registers (or, with null, forgets) the commit of one field of a document. */
  set(docId: string, field: string, commit: (() => Promise<unknown>) | null): void {
    const before = this.has(docId)
    const fields = this.pending.get(docId) ?? new Map<string, () => Promise<unknown>>()
    if (commit) fields.set(field, commit)
    else fields.delete(field)
    if (fields.size) this.pending.set(docId, fields)
    else this.pending.delete(docId)
    if (before !== this.has(docId)) this.changed()
  }

  has(docId: string): boolean {
    return (this.pending.get(docId)?.size ?? 0) > 0
  }

  /**
   * Called whenever a document starts or stops having typing in it (not on every key), so the
   * window can count it as unsaved work when it is closed (§83).
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  /**
   * Runs every pending commit of the document, in the order they were registered, each once.
   * False when one of them failed (its field shows why; the caller should not go on).
   */
  async commit(docId: string): Promise<boolean> {
    const fields = this.pending.get(docId)
    if (!fields) return true
    this.pending.delete(docId)
    this.changed()
    let ok = true
    for (const commit of fields.values()) {
      try {
        const r = await commit()
        if (r === false) ok = false
      } catch {
        ok = false
      }
    }
    return ok
  }
}

/** The documents with work that closing would lose: changed ones, and ones with typing not yet committed. */
export function unsavedIds(ids: readonly string[], dirty: (id: string) => boolean, typing: Pick<PendingTyping, 'has'>): string[] {
  return ids.filter((id) => dirty(id) || typing.has(id))
}

/**
 * The window is being closed (its close button, Alt+F4, quitting) while some document has unsaved
 * work (§83). The typing in form fields is committed first, so it becomes a change the unsaved
 * dialog asks about and Save keeps. Gives the documents to ask about (none: the window may
 * close), or null when a field refused its text (the window stays; the field shows why).
 */
export async function beforeWindowCloses(ids: readonly string[], typing: PendingTyping, dirty: (id: string) => boolean): Promise<string[] | null> {
  let ok = true
  for (const id of ids) if (typing.has(id)) ok = (await typing.commit(id)) && ok
  if (!ok) return null
  return ids.filter((id) => dirty(id))
}

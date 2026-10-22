import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { extractText } from '@engine/text'
import { Sessions } from '../src/worker/sessions'
import { makeLatinPdf, makePng, makeRestrictedPdf } from './fixtures'

let dir: string
let sessions: Sessions

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'powerpdf-test-'))
  sessions = new Sessions()
})
afterEach(() => {
  sessions.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

async function file(name: string, bytes: Uint8Array | Promise<Uint8Array>): Promise<string> {
  const path = join(dir, name)
  writeFileSync(path, await bytes)
  return path
}

describe('sessions', () => {
  it('opens a file once, however often it is asked for', async () => {
    const path = await file('a.pdf', makeLatinPdf(3))
    const a = await sessions.openFile(path)
    const b = await sessions.openFile(path)
    expect(b.id).toBe(a.id)
    expect(a).toMatchObject({ name: 'a.pdf', dirty: false, canUndo: false })
    expect(a.pages).toHaveLength(3)
  })

  it('previews a page tool on one page without changing the document', async () => {
    const doc = await sessions.openFile(await file('a.pdf', makeLatinPdf(3)))
    const before = sessions.render(doc.id, doc.revision, 1, 0.5)
    const preview = await sessions.preview(doc.id, { op: 'watermark', text: 'DRAFT', opacity: 1, colour: '#ff0000' }, 1, 0.5)
    expect(preview.mime).toBe('image/jpeg')
    expect(preview.width).toBe(before.width)
    expect(Buffer.compare(Buffer.from(preview.data), Buffer.from(before.data))).not.toBe(0)
    const after = sessions.info(doc.id)
    expect(after).toMatchObject({ revision: doc.revision, dirty: false, canUndo: false })
  })

  it('makes a thumbnail of a file on disk without opening it, and says when it is locked', async () => {
    const plain = await sessions.fileThumbnail(await file('a.pdf', makeLatinPdf(3)), 150)
    expect(plain).toMatchObject({ pages: 3, locked: false })
    expect(plain.image?.width).toBe(150)
    const locked = await file('b.pdf', (async () => {
      const { mupdf } = await import('@engine/mupdf')
      const doc = new mupdf.PDFDocument(await makeLatinPdf(1))
      const out = new Uint8Array(doc.saveToBuffer('encrypt=aes-256,user-password=open,owner-password=owner').asUint8Array())
      doc.destroy()
      return out
    })())
    expect(await sessions.fileThumbnail(locked, 150)).toMatchObject({ locked: true, image: null })
  })

  it('tracks unsaved changes through undo and redo', async () => {
    const doc = await sessions.openFile(await file('a.pdf', makeLatinPdf(3)))
    const changed = (await sessions.apply(doc.id, { op: 'delete', pages: [0] })).doc
    expect(changed).toMatchObject({ dirty: true, canUndo: true })
    expect(changed.pages).toHaveLength(2)
    const back = sessions.undo(doc.id)
    expect(back).toMatchObject({ dirty: false, canUndo: false, canRedo: true })
    expect(back.pages).toHaveLength(3)
    expect(sessions.redo(doc.id).pages).toHaveLength(2)
  })

  it('never reuses a revision, and "undo then a different change" counts as unsaved', async () => {
    const doc = await sessions.openFile(await file('a.pdf', makeLatinPdf(3)))
    const r1 = (await sessions.apply(doc.id, { op: 'rotate', pages: [0], angle: 90 })).doc
    await sessions.save(doc.id)
    const r2 = (await sessions.apply(doc.id, { op: 'delete', pages: [2] })).doc
    const r3 = sessions.undo(doc.id)
    expect(r3.dirty).toBe(false) // back to exactly what was saved
    const r4 = (await sessions.apply(doc.id, { op: 'delete', pages: [1] })).doc
    expect(r4.dirty).toBe(true)
    const revisions = [doc, r1, r2, r3, r4].map((d) => d.revision)
    expect(new Set(revisions).size).toBe(revisions.length)
  })

  it('saves over the file safely and leaves no temporary file behind', async () => {
    const path = await file('a.pdf', makeLatinPdf(2))
    const doc = await sessions.openFile(path)
    await sessions.apply(doc.id, { op: 'watermark', text: 'SAVED', rotation: 0 })
    const saved = await sessions.save(doc.id)
    expect(saved.dirty).toBe(false)
    expect(readdirSync(dir)).toEqual(['a.pdf'])
    const reopened = openPdf(new Uint8Array(readFileSync(path)))
    try {
      expect(extractText(reopened, 0)).toContain('SAVED')
    } finally {
      free(reopened)
    }
  })

  it('renders pages, and refuses a revision that is gone', async () => {
    const doc = await sessions.openFile(await file('a.pdf', makeLatinPdf(2)))
    const picture = sessions.render(doc.id, doc.revision, 1, 1)
    expect(picture.width).toBe(400)
    const next = (await sessions.apply(doc.id, { op: 'rotate', pages: [1], angle: 90 })).doc
    expect(() => sessions.render(doc.id, doc.revision, 1, 1)).toThrow()
    expect(sessions.render(doc.id, next.revision, 1, 1).width).toBe(600)
  })

  it('keeps the permissions password for a restricted file once given', async () => {
    const doc = await sessions.openFile(await file('r.pdf', makeRestrictedPdf(2)))
    expect(doc.rights.full).toBe(false)
    await expect(sessions.apply(doc.id, { op: 'watermark', text: 'X' })).rejects.toMatchObject({ code: 'restricted' })
    expect(() => sessions.authorize(doc.id, 'wrong')).toThrow()
    expect(sessions.authorize(doc.id, 'owner-secret').rights.full).toBe(true)
    const { doc: after } = await sessions.apply(doc.id, { op: 'watermark', text: 'X' })
    expect(after.canUndo).toBe(true)
  })

  it('extracts, merges, splits and exports', async () => {
    const a = await sessions.openFile(await file('report.pdf', makeLatinPdf(4)))
    const part = sessions.extract(a.id, [3, 0])
    expect(part).toMatchObject({ name: 'report (2p).pdf', path: null, dirty: true })
    const merged = await sessions.merge([{ docId: a.id }, { path: await file('b.pdf', makeLatinPdf(2)) }], 'Merged.pdf')
    expect(merged.pages).toHaveLength(6)
    const files = await sessions.split(a.id, [[0, 1], [2, 3]], join(dir, 'split'))
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(['report - 1-2.pdf', 'report - 3-4.pdf'])
    const images = await sessions.exportImages(a.id, [0, 3], 'png', 36, join(dir, 'img'))
    expect(images.map((f) => f.split(/[\\/]/).pop())).toEqual(['report - 1.png', 'report - 4.png'])
  })

  it('turns pictures into a new document', async () => {
    const doc = await sessions.imagesToPdf([await file('x.png', makePng(200, 100)), await file('y.png', makePng(100, 200))], { paper: 'a4', margin: 20, autoOrientation: true }, 'Pictures.pdf')
    expect(doc.pages).toHaveLength(2)
    expect(doc.pages[0]!.width).toBeGreaterThan(doc.pages[0]!.height)
  })
})

describe('protecting inside a session', () => {
  it('keeps full control after Protect, saves a protected file, and undo returns the open version', async () => {
    const path = await file('p.pdf', makeLatinPdf(2))
    const doc = await sessions.openFile(path)
    const protectedDoc = (await sessions.apply(doc.id, { op: 'protect', userPassword: 'open-me', allowModify: false, allowCopy: false, allowPrint: true, allowAnnotate: false })).doc
    expect(protectedDoc).toMatchObject({ hasOpenPassword: true })
    expect(protectedDoc.rights.full).toBe(true) // the session keeps the permissions password it made up
    // Still editable in this session although the saved file forbids changes.
    const stamped = (await sessions.apply(doc.id, { op: 'watermark', text: 'DRAFT' })).doc
    expect(stamped.canUndo).toBe(true)
    await sessions.save(doc.id)
    const onDisk = new Uint8Array(readFileSync(path))
    expect(() => openPdf(onDisk)).toThrowError(expect.objectContaining({ code: 'password-required' }))
    const reopened = openPdf(onDisk, 'open-me')
    try {
      expect(reopened.hasPermission('edit')).toBe(false)
      expect(extractText(reopened, 0)).toContain('DRAFT')
    } finally {
      free(reopened)
    }
    sessions.undo(doc.id)
    const unprotected = sessions.undo(doc.id)
    expect(unprotected.hasOpenPassword).toBe(false)
    expect(sessions.redo(doc.id).hasOpenPassword).toBe(true)
  })

  it('unlocks a file opened with its password', async () => {
    const locked = (await (async () => {
      const s = new Sessions()
      const d = await s.openFile(await file('src.pdf', makeLatinPdf(1)))
      await s.apply(d.id, { op: 'protect', userPassword: 'pw', ownerPassword: 'owner' })
      await s.save(d.id, join(dir, 'locked.pdf'))
      s.closeAll()
      return join(dir, 'locked.pdf')
    })())
    const doc = await sessions.openFile(locked, 'owner')
    const open = (await sessions.apply(doc.id, { op: 'unlock' })).doc
    expect(open.hasOpenPassword).toBe(false)
    expect(open.rights.encrypted).toBe(false)
  })
})

/** docs/decisions.md §23: the author's "copy" right covers exporting the content, as in Acrobat. */
describe('a file whose author does not allow copying', () => {
  it('refuses to export its text or page pictures, but still prints', async () => {
    const doc = await sessions.openFile(await file('nocopy.pdf', makeRestrictedPdf(2, { copy: false })))
    expect(doc.rights.copy).toBe(false)
    await expect(sessions.exportOffice(doc.id, { format: 'txt', pages: null, pageBreaks: false, removeTatweel: false, digits: 'keep' }, join(dir, 'out.txt'))).rejects.toMatchObject({ code: 'restricted' })
    await expect(sessions.exportImages(doc.id, [0], 'png', 72, join(dir, 'png'))).rejects.toMatchObject({ code: 'restricted' })
    expect(readdirSync(dir)).not.toContain('out.txt')
    // Printing renders pages as pictures too; that is the print right, not copying.
    expect(await sessions.exportImages(doc.id, [0], 'jpeg', 72, join(dir, 'print'), undefined, 'print')).toHaveLength(1)
  })

  it('exports once the permissions password is given', async () => {
    const doc = await sessions.openFile(await file('nocopy.pdf', makeRestrictedPdf(1, { copy: false })))
    expect(sessions.authorize(doc.id, 'owner-secret').rights.copy).toBe(true)
    expect(await sessions.exportImages(doc.id, [0], 'png', 72, join(dir, 'png'))).toHaveLength(1)
  })

  it('still exports a file that allows copying', async () => {
    const doc = await sessions.openFile(await file('copy.pdf', makeRestrictedPdf(1)))
    expect(await sessions.exportImages(doc.id, [0], 'png', 72, join(dir, 'png'))).toHaveLength(1)
  })

  it('does not compare the text of a file whose author does not allow copying', async () => {
    const text = { kind: 'text', name: 'pasted', text: 'Page 1 Marker1' } as const
    const doc = await sessions.openFile(await file('nocopy.pdf', makeRestrictedPdf(1, { copy: false })))
    await expect(sessions.compare({ kind: 'doc', docId: doc.id }, text, {} as never)).rejects.toMatchObject({ code: 'restricted' })
    const other = await file('nocopy2.pdf', makeRestrictedPdf(1, { copy: false }))
    await expect(sessions.compare(text, { kind: 'file', path: other }, {} as never)).rejects.toMatchObject({ code: 'restricted' })
    // A file that allows copying still compares.
    const ok = await sessions.openFile(await file('copy.pdf', makeRestrictedPdf(1)))
    const r = await sessions.compare({ kind: 'doc', docId: ok.id }, text, {} as never)
    sessions.compareClose(r.token)
  })

  it('prints a file limited to low-resolution printing at no more than 150 dpi', async () => {
    const { mupdf } = await import('@engine/mupdf')
    const width = async (name: string, bytes: Promise<Uint8Array>): Promise<number> => {
      const doc = await sessions.openFile(await file(name, bytes))
      const [out] = await sessions.exportImages(doc.id, [0], 'jpeg', 300, join(dir, name + '-print'), undefined, 'print')
      const image = new mupdf.Image(readFileSync(out!))
      try {
        return image.getWidth()
      } finally {
        image.destroy()
      }
    }
    // The fixture's pages are 400 pt wide.
    expect(await width('hq.pdf', makeRestrictedPdf(1))).toBe(Math.round((400 * 300) / 72))
    expect(await width('lowres.pdf', makeRestrictedPdf(1, { printHq: false }))).toBeLessThanOrEqual(Math.ceil((400 * 150) / 72))
  })
})

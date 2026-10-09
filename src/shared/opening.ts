import { READABLE_EXTENSIONS } from './imageFormats'

/**
 * Files handed to the app to open (decisions §75): Explorer's "Open with" and "Edit with HonoKit",
 * a double-click, a second launch, macOS's open-file, drag and drop, Recent and Places. A PDF opens
 * in the reader, a picture in the picture viewer; `edit` (the `--edit` switch of the "Edit with
 * HonoKit" command) opens it straight in the editor or the Photo editor instead.
 */
export interface OpenRequest {
  path: string
  kind: 'pdf' | 'image'
  edit: boolean
}

/** The switch the "Edit with HonoKit" command line carries (build/installer.nsh). */
export const EDIT_SWITCH = '--edit'

/** Every picture extension the picture viewer opens: what the image tools read, PDF excepted. */
export const PICTURE_EXTENSIONS: readonly string[] = READABLE_EXTENSIONS.filter((e) => e !== 'pdf')
const pictures = new Set(PICTURE_EXTENSIONS)

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** What a file is by its name: a PDF, a picture, or neither. The bytes are checked when it is read. */
export function fileKind(path: string): OpenRequest['kind'] | null {
  const ext = extensionOf(path)
  if (ext === 'pdf') return 'pdf'
  return pictures.has(ext) ? 'image' : null
}

/**
 * The files in a command line, in order, and whether it asked to edit them. `isFile` says whether
 * an argument is an existing file (the main process checks it is absolute, too); switches and the
 * app's own path are skipped.
 */
export function openRequests(argv: readonly string[], isFile: (path: string) => boolean): OpenRequest[] {
  const edit = argv.includes(EDIT_SWITCH)
  const out: OpenRequest[] = []
  for (const arg of argv) {
    if (arg.startsWith('--')) continue
    const kind = fileKind(arg)
    if (kind && isFile(arg)) out.push({ path: arg, kind, edit })
  }
  return out
}

/** Pictures in a folder in Explorer's order (numbers compared as numbers): the viewer's previous and next. */
export function sortPictures(names: readonly string[]): string[] {
  return names.filter((n) => fileKind(n) === 'image').sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

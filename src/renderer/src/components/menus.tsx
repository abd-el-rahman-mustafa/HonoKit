import { Copy, Crop, FileDown, FileOutput, FilePlus2, Files, KeyRound, Minimize2, Maximize2, Printer, Repeat2, RotateCcw, RotateCw, RefreshCcw, Trash2 } from 'lucide-react'
import { apply, authorize, goToPage, openTool, replacePagesAsking, resizeThumbs, setDialog, t, tc, THUMB_SIZES, updateView, type DocView } from '../store'
import type { MenuEntry } from './ContextMenu'

/**
 * The page menu (decisions §76), the same wherever pages are right-clicked: Organize's grid, the
 * Page thumbnails panel, and the page itself. Acrobat's thumbnail menu — Insert, Extract, Replace,
 * Delete, Crop, Rotate, Print, Reduce / Enlarge Page Thumbnails — with our rotate, duplicate and
 * save. `pages` are what it acts on: the selection when the clicked page is part of it, otherwise
 * that page (pagelist.menuTargets); the labels count them ("Rotate 3 pages right").
 * `where` adds the thumbnail size items for the grid or the panel.
 */
export function pageEntries(view: DocView, pages: number[], where?: 'grid' | 'panel'): MenuEntry[] {
  const { info } = view
  const id = info.id
  const n = pages.length
  const count = info.pages.length
  const after = Math.max(...pages) + 1
  // The author's restrictions (§23): rearranging needs "assemble" or "edit"; crop changes what the page shows.
  const assemble = info.rights.assemble || info.rights.edit
  const edit = info.rights.edit
  const locked = { disabled: !assemble, hint: assemble ? undefined : t('pagesMenu.restricted') }
  const size = where === 'grid' ? view.gridSize : view.thumbSize
  const limits = where ? THUMB_SIZES[where] : null
  return [
    { id: 'rotateRight', label: tc('pagesMenu.rotateRight', n), icon: <RotateCw size={14} />, ...locked, onClick: () => void apply(id, { op: 'rotate', pages, angle: 90 }, t('rotateRight')) },
    { id: 'rotateLeft', label: tc('pagesMenu.rotateLeft', n), icon: <RotateCcw size={14} />, ...locked, onClick: () => void apply(id, { op: 'rotate', pages, angle: -90 }, t('rotateLeft')) },
    { id: 'rotate', label: tc('pagesMenu.rotate', n), icon: <RefreshCcw size={14} />, ...locked, onClick: () => setDialog({ kind: 'pages', action: 'rotate', docId: id, pages }) },
    'separator',
    { id: 'insertBlank', label: t('pagesMenu.insertBlankAfter', { n: after }), icon: <FilePlus2 size={14} />, ...locked, onClick: () => void apply(id, { op: 'insertBlank', at: after, count: 1 }, t('insertBlank')) },
    {
      id: 'insertPdf',
      label: t('pagesMenu.insertPdf'),
      icon: <Files size={14} />,
      ...locked,
      onClick: async () => {
        const [path] = await window.api.pickPdfs(false)
        if (path) await apply(id, { op: 'insertPdf', at: after, path }, t('insertPdf'))
      }
    },
    { id: 'duplicate', label: tc('pagesMenu.duplicate', n), icon: <Copy size={14} />, ...locked, onClick: () => void apply(id, { op: 'duplicate', pages }, t('duplicate')) },
    'separator',
    // Extracting only reads the document; deleting afterwards is checked in the dialog's apply.
    { id: 'extract', label: tc('pagesMenu.extract', n), icon: <FileOutput size={14} />, onClick: () => setDialog({ kind: 'pages', action: 'extract', docId: id, pages }) },
    { id: 'replace', label: tc('pagesMenu.replace', n), icon: <Repeat2 size={14} />, ...locked, onClick: () => void replacePagesAsking(id, pages) },
    {
      id: 'crop',
      label: tc('pagesMenu.crop', n),
      icon: <Crop size={14} />,
      disabled: !edit,
      hint: edit ? undefined : t('pagesMenu.restrictedEdit'),
      // The Crop tool, with these pages chosen ("Selected") and the first in view.
      onClick: () => {
        updateView(id, { selected: pages })
        goToPage(id, pages[0]!)
        openTool('crop')
      }
    },
    'separator',
    { id: 'savePdf', label: tc('pagesMenu.savePdf', n), icon: <FileDown size={14} />, onClick: () => setDialog({ kind: 'savePages', docId: id, pages }) },
    { id: 'print', label: tc('pagesMenu.print', n), icon: <Printer size={14} />, shortcut: 'Ctrl+P', disabled: !info.rights.print, hint: info.rights.print ? undefined : t('print.restricted'), onClick: () => setDialog({ kind: 'print', docId: id, pages }) },
    ...(where && limits
      ? ([
          'separator',
          { id: 'smaller', label: t('pagesMenu.smaller'), icon: <Minimize2 size={14} />, disabled: size <= limits.min, onClick: () => resizeThumbs(id, where, false) },
          { id: 'bigger', label: t('pagesMenu.bigger'), icon: <Maximize2 size={14} />, disabled: size >= limits.max, onClick: () => resizeThumbs(id, where, true) }
        ] satisfies MenuEntry[])
      : []),
    'separator',
    ...(!assemble ? ([{ id: 'unlock', label: t('pagesMenu.unlock'), icon: <KeyRound size={14} />, onClick: () => void authorize(id) }] satisfies MenuEntry[]) : []),
    {
      id: 'delete',
      label: tc('pagesMenu.delete', n),
      icon: <Trash2 size={14} />,
      danger: true,
      shortcut: 'Del',
      disabled: !assemble || n >= count,
      hint: !assemble ? t('pagesMenu.restricted') : n >= count ? t('pagesMenu.lastPage') : undefined,
      onClick: () => setDialog({ kind: 'pages', action: 'delete', docId: id, pages })
    }
  ]
}

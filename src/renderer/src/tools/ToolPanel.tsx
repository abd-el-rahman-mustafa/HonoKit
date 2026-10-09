import clsx from 'clsx'
import { ChevronLeft, X } from 'lucide-react'
import { isImageTool, openTool, openWithPicker, STANDALONE_TOOLS, togglePanel, updateView, useStore, useT, type DocView, type ToolId } from '../store'
import { HUB_LABEL, HUBS, TOOLS, toolEntry, type Hub } from './catalogue'
import { MetadataTool, ProtectTool, RepairTool, SplitTool, ToImagesTool, UnlockTool } from './FileTools'
import { RedactTool } from './RedactTool'
import { FormatTextTool } from './FormatTextTool'
import { ConvertTool } from './ConvertTool'
import { OcrTool } from './OcrTool'
import { PrepareFormTool } from './PrepareFormTool'
import { CommentPanel, EditPanel, OrganizePanel, SignPanel } from './ModePanels'
import { CompressTool, CropTool, HeaderFooterTool, PageNumbersTool, RotateTool, WatermarkTool } from './PageTools'
import { SCAN_TOOLS } from '../components/ScanView'

function Body({ tool, view }: { tool: ToolId; view: DocView | null }) {
  if (!view) return null
  switch (tool) {
    case 'edit':
      return <EditPanel view={view} />
    case 'comment':
      return <CommentPanel view={view} />
    case 'sign':
      return <SignPanel view={view} />
    case 'organize':
      return <OrganizePanel view={view} />
    case 'rotate':
      return <RotateTool view={view} />
    case 'watermark':
      return <WatermarkTool view={view} />
    case 'pageNumbers':
      return <PageNumbersTool view={view} />
    case 'headerFooter':
      return <HeaderFooterTool view={view} />
    case 'compress':
      return <CompressTool view={view} />
    case 'crop':
      return <CropTool view={view} />
    case 'protect':
      return <ProtectTool view={view} />
    case 'redact':
      return <RedactTool view={view} />
    case 'formatText':
      return <FormatTextTool view={view} />
    case 'convert':
      return <ConvertTool view={view} />
    case 'ocr':
      return <OcrTool view={view} />
    case 'prepareForm':
      return <PrepareFormTool view={view} />
    case 'toWord':
      return <ConvertTool key="docx" view={view} initial="docx" />
    case 'toExcel':
      return <ConvertTool key="xlsx" view={view} initial="xlsx" />
    case 'toPowerPoint':
      return <ConvertTool key="pptx" view={view} initial="pptx" />
    case 'toMarkdown':
      return <ConvertTool key="md" view={view} initial="md" />
    case 'toText':
      return <ConvertTool key="txt" view={view} initial="txt" />
    case 'unlock':
      return <UnlockTool view={view} />
    case 'metadata':
      return <MetadataTool view={view} />
    case 'repair':
      return <RepairTool view={view} />
    case 'split':
      return <SplitTool view={view} />
    case 'toImages':
      return <ToImagesTool view={view} />
  }
}

/**
 * Acrobat's All tools list: coloured icons in groups; a choice replaces the list with the tool.
 * PDF tools and image tools are two sections (decisions §75); an image tool fills the window.
 */
function AllTools({ view }: { view: DocView | null }) {
  const t = useT()
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line ps-4 pe-2">
        <h2 className="flex-1 text-[14px] font-semibold">{t('allTools')}</h2>
        <button type="button" title={t('closePanel')} aria-label={t('closePanel')} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => togglePanel(false)}>
          <X size={16} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3" data-all-tools="">
        {(['pdf', 'images'] as Hub[]).map((hub) => (
          <div key={hub} className={clsx('flex flex-col gap-4', hub === 'images' && 'mt-2 border-t border-line pt-4')} data-all-tools-hub={hub}>
            <h3 className="px-2 text-[13px] font-semibold">{t(HUB_LABEL[hub])}</h3>
            {HUBS[hub].map((group) => (
              <section key={group} className="flex flex-col gap-0.5">
                {HUBS[hub].length > 1 && <h4 className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{t(`group.${group}`)}</h4>}
                {TOOLS.filter((x) => x.group === group).map(({ id, icon: Icon, hue }) => {
                  const needsDoc = !STANDALONE_TOOLS.includes(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => (needsDoc && !view ? void openWithPicker(id) : openTool(id))}
                      className="flex h-9 shrink-0 items-center gap-3 rounded-lg px-2 text-start text-[13px] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                    >
                      <Icon size={19} style={{ color: `hsl(${hue} 68% 46%)` }} className="shrink-0" />
                      <span className="truncate">{t(`tool.${id}`)}</span>
                    </button>
                  )
                })}
              </section>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * The left panel, a navigation stack as in Acrobat: the All tools list, or one tool's panel
 * with a back arrow to the list, its title and ×. Keyed by tool and document, so switching
 * either starts the form afresh.
 */
export function ToolPanel() {
  const t = useT()
  const tool = useStore((s) => s.tool)
  const open = useStore((s) => s.panelOpen)
  const view = useStore((s) => (s.active ? (s.docs[s.active] ?? null) : null))
  // Combine files has a view of its own over the whole window, as in Acrobat.
  if (!open || tool === 'merge' || tool === 'imagesToPdf' || tool === 'compare' || tool === 'batch' || (tool && SCAN_TOOLS.includes(tool)) || isImageTool(tool)) return null
  if (!view && !(tool && STANDALONE_TOOLS.includes(tool))) return null
  // The reader has no tool panel (§75); Edit brings it.
  if (view?.reading) return null
  const wide = tool === 'watermark' || tool === 'pageNumbers' || tool === 'crop' || tool === 'headerFooter' || tool === 'redact' || tool === 'formatText'
  return (
    <aside className={clsx('flex shrink-0 flex-col border-e border-line bg-surface', wide ? 'w-[312px]' : 'w-[288px]')} data-tool-panel={tool ?? 'all'}>
      {tool ? (
        <>
          <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line ps-1 pe-2">
            <button
              type="button"
              title={t('allTools')}
              aria-label={t('allTools')}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
              onClick={() => {
                openTool(null)
                if (view?.mode === 'organize') updateView(view.info.id, { mode: 'view' })
              }}
            >
              <ChevronLeft size={18} className="rtl:rotate-180" />
            </button>
            <ToolIcon tool={tool} />
            <h2 className="flex-1 truncate text-[14px] font-semibold">{t(`tool.${tool}`)}</h2>
            <button type="button" title={t('closePanel')} aria-label={t('closePanel')} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => togglePanel(false)}>
              <X size={16} />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-4" key={`${tool}-${view?.info.id ?? ''}`}>
            <Body tool={tool} view={view} />
          </div>
        </>
      ) : (
        <AllTools view={view} />
      )}
    </aside>
  )
}

function ToolIcon({ tool }: { tool: ToolId }) {
  const { icon: Icon, hue } = toolEntry(tool)
  return <Icon size={17} style={{ color: `hsl(${hue} 68% 46%)` }} className="me-1 shrink-0" />
}

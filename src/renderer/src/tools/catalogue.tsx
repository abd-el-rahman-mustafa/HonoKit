import {
  BookOpen,
  CaseSensitive,
  Combine,
  CreditCard,
  Crop,
  FileArchive,
  FileCode2,
  FileImage,
  FileLock2,
  FileOutput,
  FilePlus2,
  FormInput,
  FileSpreadsheet,
  FilePenLine,
  FileText,
  Film,
  GalleryHorizontalEnd,
  ImageDown,
  Info,
  Minimize2,
  RefreshCcw,
  Scaling,
  Shapes,
  ImageUpscale,
  Eraser,
  ScanFace,
  Brush,
  Smile,
  FileType2,
  GitCompareArrows,
  Hash,
  Images,
  LayoutGrid,
  ListChecks,
  LockOpen,
  MessageSquareText,
  PanelTopBottomDashed,
  Presentation,
  RotateCw,
  ScanLine,
  ScanText,
  Scissors,
  Signature,
  SquareSlash,
  Stamp,
  Wrench,
  Type,
  type LucideIcon
} from 'lucide-react'
import type { ToolId } from '../store'

export interface ToolEntry {
  id: ToolId
  icon: LucideIcon
  /** Icon colour: a hue, so it works in both themes (Acrobat's tool list is multicoloured). */
  hue: number
  group: ToolGroup
}

export type ToolGroup = 'editSign' | 'pages' | 'convert' | 'images' | 'protect'

export const GROUPS: ToolGroup[] = ['editSign', 'pages', 'convert', 'images', 'protect']

/**
 * The two hubs (decisions §75): Home, the editor's All tools and Find show PDF tools and image
 * tools apart. Scan, Images to PDF and picture to text/Word/Excel stay with the PDF tools: they
 * make PDFs and documents.
 */
export type Hub = 'pdf' | 'images'
export const HUBS: Record<Hub, ToolGroup[]> = { pdf: ['editSign', 'pages', 'convert', 'protect'], images: ['images'] }
export const hubOf = (entry: ToolEntry): Hub => (entry.group === 'images' ? 'images' : 'pdf')
/** The hub's name: "PDF tools", "Image tools". */
export const HUB_LABEL: Record<Hub, 'hub.pdf' | 'group.images'> = { pdf: 'hub.pdf', images: 'group.images' }

/** Most used first within each group (Acrobat's and iLovePDF's usage order, roughly). */
export const TOOLS: ToolEntry[] = [
  { id: 'edit', icon: FilePenLine, hue: 330, group: 'editSign' },
  { id: 'comment', icon: MessageSquareText, hue: 45, group: 'editSign' },
  { id: 'sign', icon: Signature, hue: 265, group: 'editSign' },
  { id: 'organize', icon: LayoutGrid, hue: 145, group: 'editSign' },
  { id: 'formatText', icon: CaseSensitive, hue: 300, group: 'editSign' },
  { id: 'prepareForm', icon: FormInput, hue: 200, group: 'editSign' },
  { id: 'merge', icon: Combine, hue: 8, group: 'pages' },
  { id: 'split', icon: Scissors, hue: 25, group: 'pages' },
  { id: 'rotate', icon: RotateCw, hue: 210, group: 'pages' },
  { id: 'crop', icon: Crop, hue: 285, group: 'pages' },
  { id: 'watermark', icon: Stamp, hue: 330, group: 'pages' },
  { id: 'pageNumbers', icon: Hash, hue: 190, group: 'pages' },
  { id: 'headerFooter', icon: PanelTopBottomDashed, hue: 200, group: 'pages' },
  { id: 'compare', icon: GitCompareArrows, hue: 250, group: 'editSign' },
  { id: 'createPdf', icon: FilePlus2, hue: 350, group: 'convert' },
  { id: 'wordToPdf', icon: FileText, hue: 215, group: 'convert' },
  { id: 'excelToPdf', icon: FileSpreadsheet, hue: 145, group: 'convert' },
  { id: 'pptToPdf', icon: Presentation, hue: 18, group: 'convert' },
  { id: 'ocr', icon: ScanText, hue: 175, group: 'convert' },
  { id: 'toWord', icon: FileText, hue: 215, group: 'convert' },
  { id: 'toExcel', icon: FileSpreadsheet, hue: 145, group: 'convert' },
  { id: 'toPowerPoint', icon: Presentation, hue: 18, group: 'convert' },
  { id: 'toMarkdown', icon: FileCode2, hue: 260, group: 'convert' },
  { id: 'toText', icon: FileType2, hue: 200, group: 'convert' },
  { id: 'convert', icon: FileOutput, hue: 215, group: 'convert' },
  { id: 'toImages', icon: FileImage, hue: 45, group: 'convert' },
  { id: 'imagesToPdf', icon: Images, hue: 95, group: 'convert' },
  { id: 'scanDocuments', icon: ScanLine, hue: 30, group: 'convert' },
  { id: 'scanIdCard', icon: CreditCard, hue: 190, group: 'convert' },
  { id: 'scanBook', icon: BookOpen, hue: 28, group: 'convert' },
  { id: 'imageToText', icon: Type, hue: 160, group: 'convert' },
  { id: 'imageToWord', icon: FileText, hue: 222, group: 'convert' },
  { id: 'imageToExcel', icon: FileSpreadsheet, hue: 140, group: 'convert' },
  // Image tools (decisions §69), iLoveIMG's order: optimize, modify, convert, create.
  { id: 'imgCompress', icon: Minimize2, hue: 145, group: 'images' },
  { id: 'imgResize', icon: Scaling, hue: 200, group: 'images' },
  { id: 'imgCrop', icon: Crop, hue: 285, group: 'images' },
  { id: 'imgConvert', icon: RefreshCcw, hue: 215, group: 'images' },
  { id: 'imgToJpg', icon: ImageDown, hue: 45, group: 'images' },
  { id: 'imgRotate', icon: RotateCw, hue: 190, group: 'images' },
  { id: 'imgUpscale', icon: ImageUpscale, hue: 155, group: 'images' },
  { id: 'imgRemoveBg', icon: Eraser, hue: 95, group: 'images' },
  { id: 'imgBlur', icon: ScanFace, hue: 215, group: 'images' },
  { id: 'imgWatermark', icon: Stamp, hue: 330, group: 'images' },
  { id: 'imgMeme', icon: Smile, hue: 45, group: 'images' },
  { id: 'imgEditor', icon: Brush, hue: 270, group: 'images' },
  { id: 'imgGif', icon: Film, hue: 330, group: 'images' },
  { id: 'imgFrames', icon: GalleryHorizontalEnd, hue: 300, group: 'images' },
  { id: 'imgIcon', icon: Shapes, hue: 265, group: 'images' },
  { id: 'imgInfo', icon: Info, hue: 230, group: 'images' },
  { id: 'compress', icon: FileArchive, hue: 145, group: 'protect' },
  { id: 'batch', icon: ListChecks, hue: 230, group: 'protect' },
  { id: 'protect', icon: FileLock2, hue: 0, group: 'protect' },
  { id: 'redact', icon: SquareSlash, hue: 350, group: 'protect' },
  { id: 'unlock', icon: LockOpen, hue: 170, group: 'protect' },
  { id: 'metadata', icon: FileText, hue: 230, group: 'protect' },
  { id: 'repair', icon: Wrench, hue: 35, group: 'protect' }
]

export const toolEntry = (id: ToolId): ToolEntry => TOOLS.find((x) => x.id === id)!

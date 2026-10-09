/**
 * Every picture format the image tools know: what it is called, its file extensions (the first is
 * the one we write), and which engine reads and writes it (docs/research-image-formats.md, §69).
 *
 *   sharp   libvips, native and fast: the common formats.
 *   magick  ImageMagick compiled to WebAssembly: the long tail (HEIC, camera RAW, PSD, JPEG XL,
 *           JPEG 2000, EXR, DDS, TGA, ICO …), slower but complete.
 *   own     written here (ICNS; ICO and CUR with PNG entries).
 *   upng    UPNG.js: animated PNG (ImageMagick's APNG needs ffmpeg).
 *   mupdf   PDF pages, rendered by MuPDF.
 *
 * Reading never trusts the extension: the engine sniffs the first bytes (engine/img/sniff.ts), so a
 * JPEG called .jfif, a PNG called .jpg or a HEIC called .jpg (iPhones do this) all open.
 */

export type Engine = 'sharp' | 'magick' | 'own' | 'upng' | 'mupdf'

export type FormatGroup = 'popular' | 'modern' | 'pro' | 'raw' | 'icon' | 'other'

export interface ImageFormat {
  id: FormatId
  /** Short label for buttons and badges ("JPG"). */
  label: string
  /** What it is, in a few words (English; the interface translates by id where it matters). */
  name: string
  /** Lower-case, without the dot. The first is what a converted file is named with. */
  ext: readonly string[]
  mime: string
  read: Engine | null
  write: Engine | null
  /** ImageMagick's name for it, when ImageMagick handles it. */
  magick?: string
  /** Keeps transparency. */
  alpha: boolean
  /** Can hold an animation. */
  animation?: boolean
  /** Has a quality setting (lossy). */
  quality?: boolean
  /** Can hold several pages (TIFF, ICO sizes, PDF). */
  pages?: boolean
  group: FormatGroup
}

export const FORMATS = [
  // --- popular ---------------------------------------------------------------------------
  { id: 'jpg', label: 'JPG', name: 'JPEG photo', ext: ['jpg', 'jpeg', 'jfif', 'jpe', 'jif', 'jfi', 'pjpeg', 'pjp'], mime: 'image/jpeg', read: 'sharp', write: 'sharp', magick: 'JPEG', alpha: false, quality: true, group: 'popular' },
  { id: 'png', label: 'PNG', name: 'PNG image', ext: ['png'], mime: 'image/png', read: 'sharp', write: 'sharp', magick: 'PNG', alpha: true, group: 'popular' },
  { id: 'webp', label: 'WEBP', name: 'WebP image', ext: ['webp'], mime: 'image/webp', read: 'sharp', write: 'sharp', magick: 'WEBP', alpha: true, animation: true, quality: true, group: 'popular' },
  { id: 'gif', label: 'GIF', name: 'GIF (animated)', ext: ['gif'], mime: 'image/gif', read: 'sharp', write: 'sharp', magick: 'GIF', alpha: true, animation: true, group: 'popular' },
  { id: 'heic', label: 'HEIC', name: 'HEIC / HEIF (iPhone photo)', ext: ['heic', 'heif', 'hif', 'heics', 'heifs'], mime: 'image/heic', read: 'magick', write: null, magick: 'HEIC', alpha: true, group: 'popular' },
  { id: 'avif', label: 'AVIF', name: 'AVIF image', ext: ['avif', 'avifs'], mime: 'image/avif', read: 'sharp', write: 'sharp', magick: 'AVIF', alpha: true, quality: true, group: 'popular' },
  { id: 'tiff', label: 'TIFF', name: 'TIFF image', ext: ['tif', 'tiff'], mime: 'image/tiff', read: 'sharp', write: 'sharp', magick: 'TIFF', alpha: true, pages: true, group: 'popular' },
  { id: 'bmp', label: 'BMP', name: 'Windows bitmap', ext: ['bmp', 'dib', 'rle'], mime: 'image/bmp', read: 'magick', write: 'magick', magick: 'BMP', alpha: true, group: 'popular' },
  { id: 'svg', label: 'SVG', name: 'SVG vector drawing', ext: ['svg', 'svgz'], mime: 'image/svg+xml', read: 'sharp', write: null, magick: 'SVG', alpha: true, group: 'popular' },
  { id: 'pdf', label: 'PDF', name: 'PDF document', ext: ['pdf'], mime: 'application/pdf', read: 'mupdf', write: 'magick', magick: 'PDF', alpha: false, pages: true, group: 'popular' },

  // --- modern ----------------------------------------------------------------------------
  { id: 'jxl', label: 'JXL', name: 'JPEG XL', ext: ['jxl'], mime: 'image/jxl', read: 'magick', write: 'magick', magick: 'JXL', alpha: true, quality: true, group: 'modern' },
  { id: 'apng', label: 'APNG', name: 'Animated PNG', ext: ['apng'], mime: 'image/apng', read: 'upng', write: 'upng', alpha: true, animation: true, group: 'modern' },
  { id: 'jp2', label: 'JP2', name: 'JPEG 2000', ext: ['jp2', 'j2k', 'jpf', 'jpx', 'jpm', 'j2c', 'jpc'], mime: 'image/jp2', read: 'magick', write: 'magick', magick: 'JP2', alpha: true, quality: true, group: 'modern' },
  { id: 'qoi', label: 'QOI', name: 'Quite OK Image', ext: ['qoi'], mime: 'image/qoi', read: 'magick', write: 'magick', magick: 'QOI', alpha: true, group: 'modern' },

  // --- icons -----------------------------------------------------------------------------
  { id: 'ico', label: 'ICO', name: 'Windows icon (favicon)', ext: ['ico'], mime: 'image/x-icon', read: 'magick', write: 'own', magick: 'ICO', alpha: true, pages: true, group: 'icon' },
  { id: 'cur', label: 'CUR', name: 'Windows cursor', ext: ['cur'], mime: 'image/x-win-bitmap', read: 'magick', write: 'own', magick: 'CUR', alpha: true, group: 'icon' },
  { id: 'icns', label: 'ICNS', name: 'macOS icon', ext: ['icns'], mime: 'image/icns', read: null, write: 'own', alpha: true, group: 'icon' },

  // --- professional ----------------------------------------------------------------------
  { id: 'psd', label: 'PSD', name: 'Photoshop document', ext: ['psd', 'psb'], mime: 'image/vnd.adobe.photoshop', read: 'magick', write: 'magick', magick: 'PSD', alpha: true, group: 'pro' },
  { id: 'xcf', label: 'XCF', name: 'GIMP image', ext: ['xcf'], mime: 'image/x-xcf', read: 'magick', write: null, magick: 'XCF', alpha: true, group: 'pro' },
  { id: 'tga', label: 'TGA', name: 'Targa', ext: ['tga', 'icb', 'vda', 'vst'], mime: 'image/x-tga', read: 'magick', write: 'magick', magick: 'TGA', alpha: true, group: 'pro' },
  { id: 'exr', label: 'EXR', name: 'OpenEXR (HDR)', ext: ['exr'], mime: 'image/x-exr', read: 'magick', write: 'magick', magick: 'EXR', alpha: true, group: 'pro' },
  { id: 'hdr', label: 'HDR', name: 'Radiance HDR', ext: ['hdr', 'rgbe'], mime: 'image/vnd.radiance', read: 'magick', write: 'magick', magick: 'HDR', alpha: false, group: 'pro' },
  { id: 'dds', label: 'DDS', name: 'DirectDraw texture', ext: ['dds'], mime: 'image/vnd-ms.dds', read: 'magick', write: 'magick', magick: 'DDS', alpha: true, group: 'pro' },
  { id: 'dpx', label: 'DPX', name: 'Digital Picture Exchange', ext: ['dpx'], mime: 'image/x-dpx', read: 'magick', write: 'magick', magick: 'DPX', alpha: false, group: 'pro' },
  { id: 'eps', label: 'EPS', name: 'Encapsulated PostScript', ext: ['eps', 'epsf', 'epsi', 'ps'], mime: 'application/postscript', read: null, write: 'magick', magick: 'EPS', alpha: false, group: 'pro' },
  { id: 'fits', label: 'FITS', name: 'FITS (astronomy)', ext: ['fits', 'fit', 'fts'], mime: 'image/fits', read: 'magick', write: 'magick', magick: 'FITS', alpha: false, group: 'pro' },
  { id: 'dcm', label: 'DICOM', name: 'DICOM (medical)', ext: ['dcm', 'dicom'], mime: 'application/dicom', read: 'magick', write: null, magick: 'DCM', alpha: false, group: 'pro' },
  { id: 'mpo', label: 'MPO', name: 'Multi-picture (3D camera)', ext: ['mpo'], mime: 'image/mpo', read: 'magick', write: null, magick: 'MPO', alpha: false, group: 'pro' },

  // --- camera RAW (read only, through LibRaw) -------------------------------------------
  { id: 'dng', label: 'DNG', name: 'Adobe DNG raw', ext: ['dng'], mime: 'image/x-adobe-dng', read: 'magick', write: null, magick: 'DNG', alpha: false, group: 'raw' },
  { id: 'cr2', label: 'CR2', name: 'Canon raw', ext: ['cr2', 'cr3', 'crw'], mime: 'image/x-canon-cr2', read: 'magick', write: null, magick: 'CR2', alpha: false, group: 'raw' },
  { id: 'nef', label: 'NEF', name: 'Nikon raw', ext: ['nef', 'nrw'], mime: 'image/x-nikon-nef', read: 'magick', write: null, magick: 'NEF', alpha: false, group: 'raw' },
  { id: 'arw', label: 'ARW', name: 'Sony raw', ext: ['arw', 'srf', 'sr2'], mime: 'image/x-sony-arw', read: 'magick', write: null, magick: 'ARW', alpha: false, group: 'raw' },
  { id: 'orf', label: 'ORF', name: 'Olympus / OM raw', ext: ['orf'], mime: 'image/x-olympus-orf', read: 'magick', write: null, magick: 'ORF', alpha: false, group: 'raw' },
  { id: 'rw2', label: 'RW2', name: 'Panasonic raw', ext: ['rw2', 'raw'], mime: 'image/x-panasonic-rw2', read: 'magick', write: null, magick: 'RW2', alpha: false, group: 'raw' },
  { id: 'raf', label: 'RAF', name: 'Fujifilm raw', ext: ['raf'], mime: 'image/x-fuji-raf', read: 'magick', write: null, magick: 'RAF', alpha: false, group: 'raw' },
  { id: 'pef', label: 'PEF', name: 'Pentax raw', ext: ['pef'], mime: 'image/x-pentax-pef', read: 'magick', write: null, magick: 'PEF', alpha: false, group: 'raw' },
  { id: 'srw', label: 'SRW', name: 'Samsung raw', ext: ['srw'], mime: 'image/x-samsung-srw', read: 'magick', write: null, magick: 'SRW', alpha: false, group: 'raw' },
  { id: 'rawOther', label: 'RAW', name: 'Other camera raw', ext: ['3fr', 'erf', 'kdc', 'dcr', 'k25', 'mef', 'mos', 'mrw', 'iiq', 'rwl', 'x3f', 'fff'], mime: 'image/x-dcraw', read: 'magick', write: null, magick: 'DCRAW', alpha: false, group: 'raw' },

  // --- other -----------------------------------------------------------------------------
  { id: 'pcx', label: 'PCX', name: 'PC Paintbrush', ext: ['pcx', 'dcx'], mime: 'image/x-pcx', read: 'magick', write: 'magick', magick: 'PCX', alpha: false, group: 'other' },
  { id: 'ppm', label: 'PPM', name: 'Netpbm colour', ext: ['ppm', 'pnm'], mime: 'image/x-portable-pixmap', read: 'magick', write: 'magick', magick: 'PPM', alpha: false, group: 'other' },
  { id: 'pgm', label: 'PGM', name: 'Netpbm grey', ext: ['pgm'], mime: 'image/x-portable-graymap', read: 'magick', write: 'magick', magick: 'PGM', alpha: false, group: 'other' },
  { id: 'pbm', label: 'PBM', name: 'Netpbm black & white', ext: ['pbm'], mime: 'image/x-portable-bitmap', read: 'magick', write: 'magick', magick: 'PBM', alpha: false, group: 'other' },
  { id: 'pam', label: 'PAM', name: 'Netpbm with alpha', ext: ['pam'], mime: 'image/x-portable-arbitrarymap', read: 'magick', write: 'magick', magick: 'PAM', alpha: true, group: 'other' },
  { id: 'pfm', label: 'PFM', name: 'Portable float map', ext: ['pfm'], mime: 'image/x-portable-floatmap', read: 'magick', write: 'magick', magick: 'PFM', alpha: false, group: 'other' },
  { id: 'sgi', label: 'SGI', name: 'Silicon Graphics', ext: ['sgi', 'rgb', 'rgba', 'bw'], mime: 'image/sgi', read: 'magick', write: 'magick', magick: 'SGI', alpha: true, group: 'other' },
  { id: 'ras', label: 'RAS', name: 'Sun raster', ext: ['ras', 'sun'], mime: 'image/x-sun-raster', read: 'magick', write: 'magick', magick: 'SUN', alpha: false, group: 'other' },
  { id: 'xpm', label: 'XPM', name: 'X pixmap', ext: ['xpm'], mime: 'image/x-xpixmap', read: 'magick', write: 'magick', magick: 'XPM', alpha: true, group: 'other' },
  { id: 'xbm', label: 'XBM', name: 'X bitmap', ext: ['xbm'], mime: 'image/x-xbitmap', read: 'magick', write: 'magick', magick: 'XBM', alpha: false, group: 'other' },
  { id: 'wbmp', label: 'WBMP', name: 'Wireless bitmap', ext: ['wbmp'], mime: 'image/vnd.wap.wbmp', read: 'magick', write: 'magick', magick: 'WBMP', alpha: false, group: 'other' },
  { id: 'jng', label: 'JNG', name: 'JPEG Network Graphics', ext: ['jng', 'mng'], mime: 'image/x-jng', read: 'magick', write: 'magick', magick: 'JNG', alpha: true, group: 'other' },
  { id: 'pict', label: 'PICT', name: 'Apple PICT', ext: ['pct', 'pict', 'pic'], mime: 'image/x-pict', read: 'magick', write: 'magick', magick: 'PICT', alpha: false, group: 'other' },
  { id: 'cin', label: 'CIN', name: 'Cineon', ext: ['cin'], mime: 'image/cineon', read: 'magick', write: 'magick', magick: 'CIN', alpha: false, group: 'other' },
  { id: 'miff', label: 'MIFF', name: 'ImageMagick file', ext: ['miff'], mime: 'image/x-miff', read: 'magick', write: 'magick', magick: 'MIFF', alpha: true, group: 'other' },
  { id: 'vips', label: 'V', name: 'libvips image', ext: ['v', 'vips'], mime: 'image/x-vips', read: 'sharp', write: null, alpha: true, group: 'other' },
  { id: 'farbfeld', label: 'FF', name: 'farbfeld', ext: ['ff'], mime: 'image/x-farbfeld', read: 'magick', write: 'magick', magick: 'FARBFELD', alpha: true, group: 'other' },
  { id: 'otb', label: 'OTB', name: 'On-the-air bitmap', ext: ['otb'], mime: 'image/x-otb', read: 'magick', write: 'magick', magick: 'OTB', alpha: false, group: 'other' },
  { id: 'palm', label: 'PALM', name: 'Palm pixmap', ext: ['palm'], mime: 'image/x-palm', read: 'magick', write: 'magick', magick: 'PALM', alpha: false, group: 'other' },
  { id: 'viff', label: 'VIFF', name: 'Khoros VIFF', ext: ['viff', 'xv'], mime: 'image/x-viff', read: 'magick', write: 'magick', magick: 'VIFF', alpha: true, group: 'other' },
  { id: 'wpg', label: 'WPG', name: 'WordPerfect graphic', ext: ['wpg'], mime: 'image/x-wpg', read: 'magick', write: null, magick: 'WPG', alpha: false, group: 'other' },
  { id: 'sixel', label: 'SIXEL', name: 'DEC SIXEL', ext: ['six', 'sixel'], mime: 'image/x-sixel', read: 'magick', write: 'magick', magick: 'SIXEL', alpha: false, group: 'other' },
  { id: 'aseprite', label: 'ASE', name: 'Aseprite sprite', ext: ['aseprite', 'ase'], mime: 'image/x-aseprite', read: 'magick', write: null, magick: 'ASEPRITE', alpha: true, group: 'other' }
] as const satisfies ReadonlyArray<Omit<ImageFormat, 'id'> & { id: string }>

export type FormatId = (typeof FORMATS)[number]['id']

const byId = new Map<string, ImageFormat>(FORMATS.map((f) => [f.id, f as ImageFormat]))
const byExt = new Map<string, ImageFormat>()
for (const f of FORMATS) for (const e of f.ext) if (!byExt.has(e)) byExt.set(e, f as ImageFormat)

export const format = (id: FormatId): ImageFormat => byId.get(id)!

/** The format a file name says it is (not trusted for reading; see engine/img/sniff.ts). */
export function formatOfName(name: string): ImageFormat | null {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : (byExt.get(name.slice(dot + 1).toLowerCase()) ?? null)
}

/** Every extension the image tools open, for the file picker and drag-and-drop. */
export const READABLE_EXTENSIONS: readonly string[] = FORMATS.filter((f) => f.read).flatMap((f) => f.ext)

/** Formats a picture can be converted to, in the order the format picker shows them. */
export const WRITABLE: readonly ImageFormat[] = FORMATS.filter((f) => f.write) as ImageFormat[]

export const GROUP_ORDER: readonly FormatGroup[] = ['popular', 'modern', 'icon', 'pro', 'other', 'raw']

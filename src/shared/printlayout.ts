/**
 * How pages go onto printed sheets (docs/decisions.md §60), shared by the print job and the
 * dialog's preview so they always agree.
 */
export type PerSheet = 1 | 2 | 4 | 6

/**
 * Whether the sheet is turned sideways. Auto follows the pages; with 2 or 6 pages per sheet the
 * sheet turns across them, so two portrait pages sit side by side, as Acrobat does.
 */
export function sheetLandscape(sizes: Array<[number, number]>, orientation: 'auto' | 'portrait' | 'landscape', perSheet: PerSheet): boolean {
  if (orientation !== 'auto') return orientation === 'landscape'
  const wide = sizes.filter(([w, h]) => w > h).length > sizes.length / 2
  return perSheet === 2 || perSheet === 6 ? !wide : wide
}

/** Columns and rows of pages on one sheet. */
export function grid(perSheet: PerSheet, landscape: boolean): [number, number] {
  if (perSheet === 1) return [1, 1]
  if (perSheet === 4) return [2, 2]
  if (perSheet === 2) return landscape ? [2, 1] : [1, 2]
  return landscape ? [3, 2] : [2, 3]
}

/** The pages (indexes into the printed list) on each sheet. */
export function sheets(count: number, perSheet: PerSheet): number[][] {
  const out: number[][] = []
  for (let i = 0; i < count; i += perSheet) out.push(Array.from({ length: Math.min(perSheet, count - i) }, (_, k) => i + k))
  return out
}

/** Points to millimetres. */
export const mm = (pt: number): number => (pt * 25.4) / 72

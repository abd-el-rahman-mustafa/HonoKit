/**
 * Zapf Dingbats letters as the symbols they draw. An embedded Zapf Dingbats (ITC Zapf Dingbats,
 * as magazines set their separators) often has no map to Unicode, so readers get the code: the
 * red diamonds between "Email us … ◆ Tweet us …" came out as "u". The font's standard order is
 * Unicode's Dingbats block from U+2701, except where that block left a hole for a symbol Unicode
 * already had (a telephone, pointing hands, a star, circles, squares, triangles, a diamond), and
 * its upper half: ornaments, card suits, circled numbers, arrows. Built from code points (the
 * agent tools turn escapes into the characters themselves).
 */

const EXCEPTIONS: Record<number, number> = {
  0x25: 0x260e,
  0x2a: 0x261b,
  0x2b: 0x261e,
  0x48: 0x2605,
  0x6c: 0x25cf,
  0x6e: 0x25a0,
  0x73: 0x25b2,
  0x74: 0x25bc,
  0x75: 0x25c6,
  0x77: 0x25d7,
  0xa8: 0x2663,
  0xa9: 0x2666,
  0xaa: 0x2665,
  0xab: 0x2660,
  0xd5: 0x2192,
  0xd6: 0x2194,
  0xd7: 0x2195
}

function symbolOf(code: number): number | null {
  const exception = EXCEPTIONS[code]
  if (exception) return exception
  if (code >= 0x21 && code <= 0x7e) return 0x2700 + (code - 0x20)
  if (code >= 0xa1 && code <= 0xa7) return 0x2761 + (code - 0xa1)
  if (code >= 0xac && code <= 0xb5) return 0x2460 + (code - 0xac)
  if (code >= 0xb6 && code <= 0xd4) return 0x2776 + (code - 0xb6)
  if (code >= 0xd8 && code <= 0xef) return 0x2798 + (code - 0xd8)
  if (code >= 0xf1 && code <= 0xfe) return 0x27b1 + (code - 0xf1)
  return null
}

export const isDingbatsFont = (name: string): boolean => /dingbats/i.test(name)

/** The symbol a Zapf Dingbats letter draws; other characters (already mapped ones) unchanged. */
export function fromDingbats(c: string): string {
  const code = c.codePointAt(0)!
  if (c.length !== 1 || code > 0xff) return c
  const symbol = symbolOf(code)
  return symbol === null ? c : String.fromCodePoint(symbol)
}

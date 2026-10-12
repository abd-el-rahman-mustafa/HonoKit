import { existsSync, readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { free, openPdf } from '@engine/mupdf'
import { findToRedact } from '@engine/redact'
import { extractLines, matchUnits, searchLines } from '@engine/text'

const ARIAL = 'C:/Windows/Fonts/arial.ttf'

async function pdfWith(lines: string[], useArial = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = useArial ? await pdf.embedFont(readFileSync(ARIAL), { subset: false }) : await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([500, 400])
  lines.forEach((l, i) => page.drawText(l, { x: 30, y: 350 - i * 40, size: 14, font }))
  return new Uint8Array(await pdf.save())
}

function hitsOn(bytes: Uint8Array, query: string): number {
  const doc = openPdf(bytes)
  try {
    return searchLines(extractLines(doc, 0), query, 0).length
  } finally {
    free(doc)
  }
}

function redactHits(bytes: Uint8Array, words: string[]): string[] {
  const doc = openPdf(bytes)
  try {
    return findToRedact(doc, { words, patterns: [], wholeWords: true }).map((h) => h.text)
  } finally {
    free(doc)
  }
}

describe('Find folds Turkish dotted and dotless i', () => {
  const units = (s: string): string[] => [...s]
  it('finds İSTANBUL, IRMAK and KIŞ whichever i is typed', () => {
    expect(matchUnits(units('İSTANBUL'), 'istanbul')).toEqual([[0, 7]])
    expect(matchUnits(units('istanbul'), 'İSTANBUL')).toEqual([[0, 7]])
    expect(matchUnits(units('IRMAK'), 'ırmak')).toEqual([[0, 4]])
    expect(matchUnits(units('kış'), 'KIŞ')).toEqual([[0, 2]])
  })
  it('keeps them apart when case must match', () => {
    expect(matchUnits(units('İSTANBUL'), 'istanbul', { matchCase: true })).toEqual([])
    expect(matchUnits(units('İSTANBUL'), 'İSTANBUL', { matchCase: true })).toEqual([[0, 7]])
  })
  it.skipIf(!existsSync(ARIAL))('redacts a Turkish word typed in either case', async () => {
    const bytes = await pdfWith(['Toplantı İSTANBUL ofisinde, IRMAK kenarında'], true)
    expect(redactHits(bytes, ['istanbul'])).toEqual(['İSTANBUL'])
    expect(redactHits(bytes, ['ırmak'])).toEqual(['IRMAK'])
  })
})

describe('Find folds Greek final sigma', () => {
  const units = (s: string): string[] => [...s]
  it('finds ΛΟΓΟΣ, λογος and λογοσ whichever sigma is typed', () => {
    expect(matchUnits(units('λογος'), 'ΛΟΓΟΣ')).toEqual([[0, 4]])
    expect(matchUnits(units('ΛΟΓΟΣ'), 'λογος')).toEqual([[0, 4]])
    expect(matchUnits(units('λογος'), 'λογοσ')).toEqual([[0, 4]])
    expect(matchUnits(units('ο λογος μας'), 'λογος', { wholeWords: true })).toEqual([[2, 6]])
  })
  it('keeps them apart when case must match', () => {
    expect(matchUnits(units('λογος'), 'λογοσ', { matchCase: true })).toEqual([])
    expect(matchUnits(units('λογος'), 'λογος', { matchCase: true })).toEqual([[0, 4]])
  })
  it.skipIf(!existsSync(ARIAL))('redacts a Greek word typed in capitals', async () => {
    const bytes = await pdfWith(['Ο λογος της εταιρειας'], true)
    expect(redactHits(bytes, ['ΛΟΓΟΣ'])).toEqual(['λογος'])
  })
})

describe('Find matches a phrase across repeated spaces', () => {
  const units = (s: string): string[] => [...s]
  it('collapses runs of spaces and tabs on the page and in the query', () => {
    expect(matchUnits(units('annual  report'), 'annual report')).toEqual([[0, 13]])
    expect(matchUnits(units('annual\treport'), 'annual report')).toEqual([[0, 12]])
    expect(matchUnits(units('annual report'), 'annual   report')).toEqual([[0, 12]])
    expect(matchUnits(units('annual  report'), 'report')).toEqual([[8, 13]])
  })
  it('finds and redacts a phrase drawn with two spaces in a row', async () => {
    const bytes = await pdfWith(['The annual  report is due'])
    expect(hitsOn(bytes, 'annual report')).toBe(1)
    expect(redactHits(bytes, ['annual report'])).toEqual(['annual  report'])
  })
})

import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { free, mupdf, openPdf, saveBytes } from '@engine/mupdf'
import { renderPage } from '@engine/render'
import { formFields, fillForm } from '@engine/forms'
import { makeLatinPdf } from './fixtures'
it('create fields', async () => {
  const doc = openPdf(await makeLatinPdf(1))
  const page = doc.findPage(0)
  const root = doc.getTrailer().get('Root')
  const acro = doc.addObject(doc.newDictionary())
  root.put('AcroForm', acro)
  const fields = doc.newArray()
  acro.put('Fields', fields)
  acro.put('DA', doc.newString('/Helv 0 Tf 0 g'))
  const dr = doc.newDictionary(); const fonts = doc.newDictionary(); const helv = doc.newDictionary()
  helv.put('Type', doc.newName('Font')); helv.put('Subtype', doc.newName('Type1')); helv.put('BaseFont', doc.newName('Helvetica')); helv.put('Encoding', doc.newName('WinAnsiEncoding'))
  fonts.put('Helv', doc.addObject(helv)); dr.put('Font', fonts); acro.put('DR', dr)
  const annots = doc.newArray(); page.put('Annots', annots)
  const make = (ft: string, name: string, rect: number[], extra: (w: mupdf.PDFObject) => void) => {
    const w = doc.newDictionary()
    w.put('Type', doc.newName('Annot')); w.put('Subtype', doc.newName('Widget')); w.put('FT', doc.newName(ft)); w.put('T', doc.newString(name)); w.put('F', 4)
    const r = doc.newArray(); for (const v of rect) r.push(v); w.put('Rect', r); w.put('P', page)
    w.put('DA', doc.newString('/Helv 11 Tf 0 g'))
    const mk = doc.newDictionary(); const bc = doc.newArray(); bc.push(0.4); bc.push(0.4); bc.push(0.4); mk.put('BC', bc); w.put('MK', mk)
    extra(w)
    const ref = doc.addObject(w); annots.push(ref); fields.push(ref)
  }
  make('Tx', 'name', [40, 400, 300, 424], () => {})
  make('Btn', 'agree', [40, 360, 56, 376], (w) => { w.put('V', doc.newName('Off')); w.put('AS', doc.newName('Off')); const mk = w.get('MK'); mk.put('CA', doc.newString('4')) })
  make('Ch', 'city', [40, 320, 200, 344], (w) => { w.put('Ff', 131072); const opt = doc.newArray(); for (const o of ['Dubai', 'Sharjah']) opt.push(doc.newString(o)); w.put('Opt', opt) })
  const p = doc.loadPage(0) as mupdf.PDFPage
  for (const w of p.getWidgets()) { console.log('W', w.getFieldType(), w.getName()); w.update() }
  free(p)
  const bytes = saveBytes(doc); free(doc)
  const d2 = openPdf(bytes); console.log('FIELDS', JSON.stringify(formFields(d2).map((f) => [f.name, f.kind, f.options]))); free(d2)
  const list = (() => { const d = openPdf(bytes); const x = formFields(d); free(d); return x })()
  const filled = await fillForm(bytes, [{ page: 0, index: list.find((f) => f.name === 'agree')!.index, value: true }, { page: 0, index: list.find((f) => f.name === 'name')!.index, value: 'Ahmed أحمد' }, { page: 0, index: list.find((f) => f.name === 'city')!.index, value: 'Sharjah' }])
  const d3 = openPdf(filled); console.log('AFTER', JSON.stringify(formFields(d3).map((f) => [f.name, f.value, f.checked])))
  writeFileSync('smoke-out/fields-created.png', renderPage(d3, 0, { scale: 1.5, format: 'png' }).data); free(d3)
})

// Opens a real PDF in the built app, edits its first paragraph, checks the edit landed, and quits.
// The quick check of text editing on the owner's own files, instead of the full sample run:
//   npm run build && node scripts/editcheck.mjs "path/to/file.pdf" [more.pdf …]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { makeScanFixtures } from './scanfixtures.mjs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const printMode = process.argv.includes('--print')
const scanMode = process.argv.includes('--scan')
const replaceArg = process.argv.find((a) => a.startsWith('--replace='))
const files = process.argv.slice(2).filter((a) => a !== '--print' && a !== '--scan' && !a.startsWith('--replace='))
if (files.length === 0) {
  console.error('Name one or more PDFs to check.')
  process.exit(2)
}
const out = resolve('smoke-out', 'editcheck')
let failed = false
for (const file of files) {
  const folder = join(out, basename(file, '.pdf').replace(/[^\w.-]+/g, '_'))
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const result = spawnSync(require('electron'), [resolve('.')], {
    env: { ...process.env, POWERPDF_SMOKE: folder, POWERPDF_SMOKE_FILE: resolve(file), POWERPDF_SMOKE_ONLY: replaceArg ? 'replace' : scanMode ? 'scan' : printMode ? 'print' : 'edit', POWERPDF_REPLACE: replaceArg ? replaceArg.slice('--replace='.length) : '', POWERPDF_SCAN_FIXTURES: scanMode ? JSON.stringify(await makeScanFixtures(join(out, 'scan-fixtures'), resolve(file))) : '', POWERPDF_SMOKE_LANG: 'en', POWERPDF_SMOKE_THEME: 'light', POWERPDF_SMOKE_LABELS: '{}' },
    encoding: 'utf8',
    timeout: 120_000
  })
  let report = { steps: [], errors: [`no report (exit ${result.status})`] }
  try {
    report = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8'))
  } catch {
    /* keep the fallback */
  }
  if (replaceArg) {
    const steps = report.steps.filter((s) => s.startsWith('replace'))
    const toast = steps.find((s) => s.startsWith('replace: toast')) ?? ''
    const ok = result.status === 0 && steps.includes('replace: panel open: true') && /replaced in/.test(toast) && /No results|no results/i.test(steps.find((s) => s.startsWith('replace: old after')) ?? '') === false ? true : result.status === 0 && /replaced in/.test(toast)
    console.log(`${ok ? 'OK  ' : 'FAIL'} replace on ${basename(file)}`)
    for (const s of steps) console.log(`      ${s.slice(0, 240)}`)
    for (const er of report.errors) console.log(`      ERROR ${er.slice(0, 300)}`)
    if (!ok) failed = true
    continue
  }
  if (scanMode) {
    const txt = readdirSync(folder).filter((f) => f.endsWith('.txt'))
    const text = txt.length ? readFileSync(join(folder, txt[0]), 'utf8') : ''
    const ok = result.status === 0 && report.steps.some((s) => s.startsWith('scan: corners 4, result shown: true')) && report.steps.some((s) => s === 'idcard: cards 2') && report.steps.some((s) => s === 'idcard: document: page shown') && text.length > 40 && report.steps.some((s) => s.startsWith('book: cards 3, pages in each 2,2,2, fold line true')) && report.steps.some((s) => s === 'book: document pages 6')
    console.log(`${ok ? 'OK  ' : 'FAIL'} scan tools on ${basename(file)}`)
    for (const s of report.steps.filter((s) => /^(scan|idcard|text|book|convert|tabs)/.test(s))) console.log(`      ${s.slice(0, 200)}`)
    console.log(`      text file: ${txt[0] ?? 'none'} — ${JSON.stringify(text.slice(0, 160))}`)
    for (const er of report.errors) console.log(`      ERROR ${er.slice(0, 300)}`)
    if (!ok) failed = true
    continue
  }
  if (printMode) {
    const ok = result.status === 0 && report.steps.some((s) => s === 'print: dialog shown: true') && report.steps.some((s) => s === 'print: button enabled: true') && report.steps.some((s) => s === 'savePages: dialog shown: true') && report.steps.some((s) => s === 'savePages from menu: true')
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${basename(file)}`)
    for (const s of report.steps.filter((s) => s.startsWith('print') || s.startsWith('savePages') || s.startsWith('page menu'))) console.log(`      ${s.slice(0, 160)}`)
    for (const er of report.errors) console.log(`      ERROR ${er.slice(0, 300)}`)
    if (!ok) failed = true
    continue
  }
  const opened = report.steps.find((s) => s.startsWith('edit: opened a paragraph'))
  const found = report.steps.find((s) => s.startsWith('edit: new text found by search'))
  const ok = result.status === 0 && /true$/.test(opened ?? '') && !/: no$/.test(found ?? ': no')
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${basename(file)}\n      ${opened ?? 'paragraph not opened'}\n      ${found ?? 'edit not found'}`)
  for (const e of report.errors) console.log(`      ERROR ${e.slice(0, 300)}`)
  if (!ok) failed = true
}
process.exit(failed ? 1 : 0)

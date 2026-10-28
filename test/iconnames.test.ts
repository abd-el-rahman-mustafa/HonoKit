import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A control whose only content is an icon says nothing to a screen reader, and shows no tooltip
 * on hover, unless it is named. `IconButton` in ui.tsx names every one it makes; a plain
 * `<button>` with an icon in it has to carry `aria-label` and `title` itself. Every dialog's
 * close cross was unnamed this way: the icon is a picture, so the button announced only "button".
 */

const root = join(import.meta.dirname, '..', 'src', 'renderer', 'src')

const screens = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? screens(path) : entry.endsWith('.tsx') ? [path] : []
  })

/** The text a person reads on the button itself: plain words, a translated string, or a label passed in. */
const hasVisibleText = (body: string): boolean =>
  /\{\s*t(c)?\(/.test(body) ||
  /\{[^{}]*\b(label|children|name|text)\b[^{}]*\}/.test(body) ||
  body
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^{}]*\}/g, '')
    .trim().length > 0

describe('every icon-only control is named', () => {
  it('no <button> in a screen holds an icon and nothing a person or a screen reader can read', () => {
    const unnamed: string[] = []
    for (const file of screens(root)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<button\b[\s\S]{0,4000}?<\/button>/g)) {
        const button = match[0]
        if (/aria-label|\btitle=|aria-labelledby/.test(button)) continue
        const body = button.replace(/^<button\b[\s\S]*?>/, '').replace(/<\/button>$/, '')
        if (hasVisibleText(body)) continue
        const line = source.slice(0, match.index).split('\n').length
        unnamed.push(`${file.slice(root.length + 1)}:${line}  ${body.replace(/\s+/g, ' ').trim().slice(0, 80)}`)
      }
    }
    expect(unnamed).toEqual([])
  })
})

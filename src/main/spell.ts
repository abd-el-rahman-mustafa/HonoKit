import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Speller } from '@engine/spell'

/**
 * Spell check for the text editor (docs/decisions.md §67): one speller for the run, its
 * dictionaries read from the app's resources when first needed. Words the person adds go to
 * dictionary.txt in the app's data folder — on this PC only.
 */

let speller: Speller | null = null

const wordsFile = (): string => join(app.getPath('userData'), 'dictionary.txt')

function personalWords(): string[] {
  try {
    return existsSync(wordsFile())
      ? readFileSync(wordsFile(), 'utf8')
          .split(/\r?\n/)
          .map((w) => w.trim())
          .filter(Boolean)
      : []
  } catch {
    return []
  }
}

export function spellerFor(resources: string): Speller {
  speller ??= new Speller(join(resources, 'spell'), personalWords())
  return speller
}

export async function addPersonalWord(resources: string, word: string): Promise<void> {
  if (personalWords().includes(word)) return
  appendFileSync(wordsFile(), `${word}\n`, 'utf8')
  await spellerFor(resources).add(word)
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModule, type Hunspell } from 'hunspell-asm'

/**
 * Spell check while editing, English and Arabic, on this PC (docs/decisions.md §67). Electron's own
 * checker uses Windows' languages or downloads dictionaries from Google, and has none for Arabic;
 * here Hunspell (compiled to WebAssembly) reads dictionaries shipped with the app: SCOWL en_GB and
 * en_US (dictionary-en-gb, dictionary-en; a word is right when either has it — the owner's papers
 * write British English) with a list of the region's names, and Ayaspell ar (LibreOffice). Words
 * the person adds are kept in a list on this PC and given to all.
 */

export type SpellLang = 'en' | 'ar'

/** The dictionaries of each language (folders of resources/spell), and the extra words given to them. */
const DICTIONARIES: Record<SpellLang, { names: string[]; extra?: string }> = {
  en: { names: ['en-GB', 'en-US'], extra: 'names-en.txt' },
  ar: { names: ['ar'] }
}

export interface SpellWord {
  start: number
  end: number
  word: string
  lang: SpellLang
}

// An Arabic word (letters, marks, tatweel), or a Latin word with inner apostrophes ("don't").
// (Arabic script also holds digits and signs: only its letters count.)
const WORD = /((?:(?=\p{Script=Arabic})\p{L}|[\u0640\u064b-\u065f\u0670])+)|(\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['\u2019]\p{Script=Latin}+)*)/gu

/**
 * The words of a text worth checking: not single letters, acronyms (UAE), words with capitals
 * inside (iPhone), words joined to digits (COVID19), or parts of addresses (www.…, name@…).
 */
export function spellWords(text: string): SpellWord[] {
  const out: SpellWord[] = []
  for (const m of text.matchAll(WORD)) {
    const word = m[0]
    const start = m.index
    const end = start + word.length
    const lang: SpellLang = m[1] ? 'ar' : 'en'
    if ([...word.replace(/[\u0640\u064b-\u065f\u0670]/g, '')].length < 2) continue
    if (/\p{Nd}/u.test(text[start - 1] ?? '') || /\p{Nd}/u.test(text[end] ?? '')) continue
    const stem = word.replace(/['\u2019]s$/, '')
    if (lang === 'en' && (stem === stem.toUpperCase() || /\p{Ll}\p{Lu}/u.test(word))) continue
    let a = start
    let b = end
    while (a > 0 && !/\s/.test(text[a - 1]!)) a--
    while (b < text.length && !/\s/.test(text[b]!)) b++
    if (/@|:\/\/|^www\.|\.(com|org|net|ae|gov|edu)\b/i.test(text.slice(a, b))) continue
    out.push({ start, end, word, lang })
  }
  return out
}

/** The form Hunspell is asked about: the dictionary's apostrophe. */
const asked = (word: string): string => word.replace(/\u2019/g, "'")

const CURLY = String.fromCharCode(0x2019)

export class Speller {
  private module: ReturnType<typeof loadModule> | null = null
  private spellers = new Map<SpellLang, Promise<Hunspell[]>>()
  private known = new Map<string, boolean>()
  private added: string[]

  /** `dir` holds a folder per dictionary (en-GB/en-GB.aff, …); `words` are the person's own. */
  constructor(
    private dir: string,
    words: string[]
  ) {
    this.added = [...words]
  }

  private speller(lang: SpellLang): Promise<Hunspell[]> {
    let s = this.spellers.get(lang)
    if (!s) {
      s = (async () => {
        const { names, extra } = DICTIONARIES[lang]
        const extras = extra ? readList(join(this.dir, extra)) : []
        const out: Hunspell[] = []
        for (const name of names) {
          try {
            this.module ??= loadModule()
            const factory = await this.module
            const aff = factory.mountBuffer(readFileSync(join(this.dir, name, `${name}.aff`)), `${name}.aff`)
            const dic = factory.mountBuffer(readFileSync(join(this.dir, name, `${name}.dic`)), `${name}.dic`)
            const h = factory.create(aff, dic)
            for (const w of [...extras, ...this.added]) h.addWord(asked(w))
            out.push(h)
          } catch {
            // A dictionary that cannot be read: the others, or none (nothing is marked rather than everything).
          }
        }
        return out
      })()
      this.spellers.set(lang, s)
    }
    return s
  }

  private async right(lang: SpellLang, word: string): Promise<boolean> {
    const key = `${lang}|${word}`
    let ok = this.known.get(key)
    if (ok === undefined) {
      const hs = await this.speller(lang)
      ok = !hs.length || hs.some((h) => h.spell(asked(word)))
      this.known.set(key, ok)
    }
    return ok
  }

  /** The misspelled words of a text, as [start, end) in its UTF-16 offsets. */
  async check(text: string): Promise<Array<[number, number]>> {
    const out: Array<[number, number]> = []
    const words = spellWords(text)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      const next = words[i + 1]
      // A word broken at a line's end ("es- calation", or its hyphen lost: "neces sary"): right when whole.
      const between = next && next.lang === w.lang ? text.slice(w.end, next.start) : null
      const broken = between !== null && (/^[-\u00ad]\s*$/.test(between) || (/^\s+$/.test(between) && !(await this.right(w.lang, w.word)) && !(await this.right(w.lang, next!.word))))
      if (broken && (await this.right(w.lang, w.word + next!.word))) {
        i++
        continue
      }
      // Its first half, the rest in the next column ("neces-" at the end).
      if (!next && /^-\s*$/.test(text.slice(w.end))) continue
      if (!(await this.right(w.lang, w.word))) out.push([w.start, w.end])
    }
    return out
  }

  /** Corrections for a word, best first. */
  async suggest(word: string): Promise<string[]> {
    const w = spellWords(word)[0]
    if (!w || (await this.right(w.lang, w.word))) return []
    const curly = w.word !== asked(w.word)
    const seen = new Set<string>()
    for (const h of await this.speller(w.lang)) for (const s of h.suggest(asked(w.word))) seen.add(curly ? s.replace(/'/g, CURLY) : s)
    return [...seen].slice(0, 6)
  }

  /** A word the person says is right, for this run and (kept by the caller) the next ones. */
  async add(word: string): Promise<void> {
    this.added.push(word)
    for (const k of [...this.known.keys()]) if (k.endsWith(`|${word}`)) this.known.delete(k)
    for (const s of this.spellers.values()) for (const h of await s) h.addWord(asked(word))
  }
}

/** A word list: one word a line. */
function readList(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

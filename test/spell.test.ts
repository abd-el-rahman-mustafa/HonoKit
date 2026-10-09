import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Speller, spellWords } from '@engine/spell'

const words = (s: string): string[] => spellWords(s).map((w) => w.word)
const marked = async (sp: Speller, s: string): Promise<string[]> => (await sp.check(s)).map(([a, b]) => s.slice(a, b))

describe('spell check (§67)', () => {
  it('takes the words worth checking', () => {
    expect(words("The UAE's iPhone sales don’t fall, COVID19 aside — see www.news.example or a@b.com")).toEqual(['The', 'sales', 'don’t', 'fall', 'aside', 'see', 'or'])
    expect(words('وزارة التعليم في الإمارات ٢٠٢٦م')).toEqual(['وزارة', 'التعليم', 'في', 'الإمارات'])
    expect(spellWords('قال: الكتابُ')[1]).toMatchObject({ word: 'الكتابُ', lang: 'ar', start: 5, end: 12 })
  })

  it('marks misspelled English and Arabic words, with suggestions', async () => {
    const sp = new Speller(resolve('resources/spell'), [])
    // British and American spellings, the region's names, words broken at a line's end.
    expect(await marked(sp, 'We recieve the programme reports from Sharjah and Abu Dhabi every week, honour and honor.')).toEqual(['recieve'])
    expect(await marked(sp, 'a military es- calation, it is neces sary to Noboa')).toEqual(['Noboa'])
    expect(await marked(sp, 'وزارة التعليم تعلن نتائج الامتحانات في المدارسس الحكومية')).toEqual(['المدارسس'])
    // Marks and tatweel do not make a word wrong.
    expect(await marked(sp, 'الكِتابُ جمـيل')).toEqual([])
    expect(await sp.suggest('recieve')).toContain('receive')
    expect(await sp.suggest('المدارسس')).toContain('المدارس')
    expect(await sp.suggest('don’t')).toEqual([])
  })

  it('keeps words the person adds', async () => {
    const sp = new Speller(resolve('resources/spell'), ['Bedwawi'])
    expect(await marked(sp, 'Bedwawi and Taliah')).toEqual(['Taliah'])
    await sp.add('Taliah')
    expect(await marked(sp, 'Bedwawi and Taliah')).toEqual([])
    await sp.add('مصفوت')
    expect(await marked(sp, 'منطقة مصفوت')).toEqual([])
  })
})

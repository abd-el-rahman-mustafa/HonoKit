import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_MODELS, hasAiModels } from '@engine/img/ai'
import { OCR_MODELS, hasOcrModels } from '@engine/ocr/engine'

/**
 * The models' folder is found by looking for the files in it. Looking for only one of them took a
 * folder an interrupted install had half written, or an empty folder named by the environment over
 * a complete one beside it, and the tool then failed inside onnxruntime with a missing-file error
 * instead of saying the installation is incomplete.
 */
const made: string[] = []

function folder(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'honokit-models-'))
  mkdirSync(dir, { recursive: true })
  for (const f of files) writeFileSync(join(dir, f), 'not a real model')
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the models folder', () => {
  for (const [name, models, complete] of [
    ['text recognition', Object.values(OCR_MODELS), hasOcrModels],
    ['image AI', Object.values(AI_MODELS), hasAiModels]
  ] as [string, string[], (dir: string) => boolean][]) {
    it(`${name}: a folder is the models' folder only when every file is in it`, () => {
      expect(complete(folder([]))).toBe(false)
      expect(complete(folder(models))).toBe(true)
      // Each file missing on its own: none of them may be taken for the whole set.
      for (const left of models) expect(complete(folder(models.filter((m) => m !== left)))).toBe(false)
      // The first file alone was enough before, which is how a half-written folder was chosen.
      expect(complete(folder([models[0]!]))).toBe(false)
    })
  }
})

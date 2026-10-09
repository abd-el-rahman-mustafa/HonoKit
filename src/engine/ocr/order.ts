/**
 * An Arabic recogniser's text, from the order it saw into the order it is read.
 *
 * A recogniser reads a line left to right, as pixels, so an Arabic word comes
 * out reversed: «عقد (3/12000)» is seen as `(3/12000)دقع`. Digits and Latin
 * letters inside the line are the other way round — they run left to right in
 * the picture too, so they come out right already.
 *
 * This is PaddleOCR's own `pred_reverse`, kept character for character so our
 * output matches what the model's authors measured: runs of Latin letters,
 * digits and a few punctuation marks stay together in their order; every other
 * character stands alone; then the whole sequence is reversed.
 *
 * Brackets are *not* in that set, so they flip position without turning round:
 * the example above becomes `عقد)3/12000(`. Callers that look for a bracketed
 * value accept either orientation rather than "repair" it.
 */
const KEEPS_ORDER = /[a-zA-Z0-9 :*./%+-]/

export function visualToLogical(visual: string): string {
  const runs: string[] = []
  let run = ''
  for (const char of visual) {
    if (KEEPS_ORDER.test(char)) {
      run += char
    } else {
      if (run) runs.push(run)
      runs.push(char)
      run = ''
    }
  }
  if (run) runs.push(run)
  return runs.reverse().join('')
}

/**
 * Turning a recogniser's output into text.
 *
 * A PaddleOCR recogniser answers with a grid: one row per time step across the
 * line, one column per character it knows, each cell the probability that this
 * step shows that character. Class 0 is "blank" — nothing here. Reading it is
 * CTC greedy decoding: take the likeliest class at every step, merge a class
 * repeated on neighbouring steps into one character, and drop the blanks.
 *
 * **That merge is why lines are stretched before reading** (`LINE_STRETCH` in
 * `engine.ts`). A genuinely doubled digit — the «55» of 104555 — survives only
 * if a blank step falls between its two copies; squeeze the line and there is no
 * room for one, and 104555 reads 10455. It did, on 5 of 128 footers, until the
 * line was widened.
 */

export interface DecodedChar {
  char: string
  /** The probability of the step that produced it. */
  p: number
  /** The time step (column across the line) where it was read. */
  step: number
}

export interface CtcReading {
  text: string
  chars: DecodedChar[]
  /** The mean of `chars[].p`; 0 for an empty reading. */
  confidence: number
}

/**
 * A model's alphabet from its dictionary file: blank first, then one character
 * per line, then the space every PaddleOCR recogniser here is exported with.
 */
export function alphabetFrom(dictionary: string): string[] {
  return ['', ...dictionary.split(/\r?\n/).filter((line) => line !== ''), ' ']
}

export function decodeCtc(probabilities: ArrayLike<number>, steps: number, classes: number, alphabet: readonly string[]): CtcReading {
  if (classes !== alphabet.length) {
    // A dictionary that does not match its model shifts every character by one — fail, never guess.
    throw new Error(`recogniser has ${classes} classes but its dictionary gives ${alphabet.length}`)
  }
  const chars: DecodedChar[] = []
  let previous = -1
  for (let step = 0; step < steps; step++) {
    let best = -Infinity,
      index = 0
    const row = step * classes
    for (let c = 0; c < classes; c++) {
      const v = probabilities[row + c]!
      if (v > best) {
        best = v
        index = c
      }
    }
    if (index !== previous && index !== 0) chars.push({ char: alphabet[index]!, p: best, step })
    previous = index
  }
  const text = chars.map((c) => c.char).join('')
  const confidence = chars.length ? chars.reduce((sum, c) => sum + c.p, 0) / chars.length : 0
  return { text, chars, confidence }
}

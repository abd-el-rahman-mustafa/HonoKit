/**
 * How big the text in a form field is drawn when the field asks for no size of its own
 * (`0 Tf`, "Auto" in Acrobat's Properties). The engine draws the saved appearance with it and
 * the page's live fields type with it, so what is typed matches what the file keeps.
 *
 * One line fills the box's height, as Acrobat draws it: a 30 pt field shows tall text, not a
 * small line sitting low in it. Many lines keep a smaller limit, since their size follows how
 * many there are rather than the box. A /Rect reaching far past any page is bounded by the
 * largest page side the spec recommends (PDF 32000 Annex C), so a hostile file cannot ask for
 * an absurd size.
 */

/** The largest page side PDF 32000 Annex C recommends, in points. */
export const MAX_FIELD_HEIGHT = 14_400

/**
 * The size to draw a field's value at, given the height of its box in points. The height is
 * taken as 0 when the box gives none at all (a /Rect of nonsense numbers) and otherwise held
 * within [0, MAX_FIELD_HEIGHT], so every answer is a size something can be drawn at.
 */
export function autoFieldSize(height: number, multiline: boolean): number {
  const h = Number.isNaN(height) ? 0 : Math.min(Math.max(height, 0), MAX_FIELD_HEIGHT)
  return multiline ? Math.min(11, h / 2.6) : Math.max(6, h * 0.62)
}

/** What the gap control says, and what its menu has to publish.
 *
 * Kept out of the component because both answers are decisions rather than
 * drawing, and both were wrong in ways nothing could catch: a face that said
 * "Too big" about a sheet that was merely zoomed out, and an Apply that lit up
 * for settings belonging to a state the reader had just chosen to leave.
 */

/** The largest and smallest run a reader can ask for. A threshold is a count of
 * columns, so anything that is not one is one column. */
export const GAP_MIN_LIMIT = 100000
export const gapMinimum = value => Math.min(GAP_MIN_LIMIT, Math.max(1, Math.round(Number(value)) || 1))

/** The share of a cohort a column has to be a gap in, as a whole percentage.
 *
 * Read through this everywhere, so a workspace saved before the threshold
 * existed, a draft that has not been touched and a slider's own value all mean
 * the same thing: no value is a hundred per cent, which is the answer this
 * control gave for its whole life before there was anything to say. */
export const gapShare = value => Math.min(100, Math.max(1, Math.round(Number(value)) || 100))

/** The bottom of the slider's range. Below about a twentieth of a large cohort,
 * a threshold hides every column a single sequence has an insertion in, which
 * is most of the alignment and not a view of anything. */
export const GAP_MIN_SHARE = 5

/** How much of the track is behind the handle, as a percentage.
 *
 * The handle's own travel is the track less its width, so the fill is measured
 * against the range rather than against 100: at the bottom of the range nothing
 * is filled, and at the top all of it is.
 */
export const gapSliderFill = value =>
  Math.round(100 * (gapShare(value) - GAP_MIN_SHARE) / (100 - GAP_MIN_SHARE))

/** How many sequences a threshold asks for, of the ones a block holds.
 *
 * Rounded up and counted in whole sequences, the same arithmetic the store
 * does, so the menu can say what the slider means before anything is fetched:
 * half of five sequences is three, because one and a half of them is not a
 * thing a column can be. The server is still the authority - a block holding
 * fewer of the cohort than the sheet does needs fewer - and this is the figure
 * for the sheet as a whole.
 */
export const gapRowsNeeded = (rows, percent) =>
  rows > 0 ? Math.max(1, Math.ceil(rows * gapShare(percent) / 100)) : 0

/** What a threshold does, in the reader's terms.
 *
 * The distinction worth drawing is not between numbers but between two kinds of
 * answer: at 100% a hidden column holds no sequence at all, and at anything
 * less it holds bases that will stop being drawn. A reader who has only ever
 * seen the first must be told plainly when they have asked for the second.
 */
export const gapHidesBases = percent => gapShare(percent) < 100

/** The word on the face: what actually happened, not what was asked for.
 *
 * Saying "Hidden" while nothing had been hidden - because the sheet was too
 * large to ask about, because the panels on it stand for runs of blocks rather
 * than columns, or because every column has a base in somebody - left the
 * reader looking at obvious stretches of gap and concluding the feature was
 * broken. It was not; it had nothing to say and no way of saying it.
 */
export function gapValue(closed, status = {}) {
  if (!closed) return 'Shown'
  if (status.pending) return 'Working…'
  if (status.unavailable) return 'Zoom in'
  if (status.skipped) return 'Too big'
  return status.columns ? 'Hidden' : 'None here'
}

/** Whether the menu is holding an answer different from the applied one.
 *
 * The show/hide choice counts, which is the whole reason it is in the menu: a
 * reader who opened the menu to turn gaps off could only do it by pressing a
 * button they had no reason to read as a switch, and Apply sat dead while they
 * looked for one. The settings count only while hiding is the chosen answer -
 * they describe how gaps are hidden, so with "Show" chosen they are not part of
 * what Apply would publish and must not light it up.
 */
export function gapDirty(draft, applied) {
  if (!draft || !applied) return false
  if (!!draft.closed !== !!applied.closed) return true
  if (!draft.closed) return false
  return draft.marks !== applied.marks || gapMinimum(draft.min) !== applied.min
    || gapShare(draft.percent) !== gapShare(applied.percent)
}

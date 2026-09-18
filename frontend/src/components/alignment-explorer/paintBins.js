/** A span of binned coverage cut into the rectangles actually worth drawing.
 *
 * Separated from the painting for the same reason `uniformRuns` is: what to
 * draw here is arithmetic over counts, and arithmetic can be checked without a
 * canvas. The painter below reads a run and fills it; every decision about
 * what a run means is made in here.
 *
 * Two things were wrong with doing this inline, and both only showed up on
 * large alignments.
 *
 * The first is that the loop walked every bin the tile holds and threw away the
 * ones outside the span. That is free when a span is a whole tile and very
 * expensive when it is not - and a collapsed block hands this function one span
 * per kept run, so a block cut into four thousand runs walked a tile's bins
 * four thousand times to draw each of them once.
 *
 * The second is that a bin is not a unit of drawing. Coverage is resolved
 * finest-first, so zooming out keeps whatever detailed tiles are already in
 * hand rather than waiting for coarse ones, and a bin can end up a small
 * fraction of a pixel wide. Drawn one rectangle apiece those are thousands of
 * fills landing on the same few pixels, where the last one written wins and the
 * rest were work done to be overwritten. `minColumns` is how wide a rectangle
 * has to be to be worth its own fill; under it, neighbouring bins are summed
 * and drawn as one, which is both cheaper and a truer answer than whichever bin
 * happened to be painted last.
 */

const CANONICAL = ['A', 'C', 'G', 'T']

/** Merged bins over `[start,end)`, each with the counts of everything in it.
 *
 * `gap` is every column of the run being a gap in this row, which stays exactly
 * what it was for a single bin and is the only honest reading of a merged one:
 * a run holding one base is not an absence. `fraction` is divergence recomputed
 * over the run from its own totals rather than averaged from the bins', so a
 * run's colour is what it would have been had the tile been binned this coarsely
 * to begin with.
 */
export function binRuns(start, end, row, data, minColumns = 0) {
  const runs = []
  const bins = row?.bins
  if (!bins?.length || !data?.bin_size || end <= start) return runs
  const size = data.bin_size, origin = data.start
  const limit = data.end == null ? Infinity : data.end
  const divergence = row.divergence_bins
  // Found rather than scanned to. Everything before the span and everything
  // after it is bins this run of the loop is not being asked about.
  const first = Math.max(0, Math.floor((start - origin) / size))
  const last = Math.min(bins.length, Math.ceil((end - origin) / size))
  let open = null
  for (let i = first; i < last; i++) {
    const a = Math.max(start, origin + i * size)
    const z = Math.min(end, limit, origin + (i + 1) * size)
    if (z <= a) continue
    const bin = bins[i]
    let total = 0
    for (const key in bin) total += bin[key]
    let canonical = 0
    for (const base of CANONICAL) canonical += bin[base] || 0
    const stat = divergence?.[i]
    if (open && open.end === a) {
      open.end = z; open.total += total; open.canonical += canonical
      open.gaps += bin['-'] || 0
      open.comparable += stat?.comparable || 0; open.different += stat?.different || 0
    } else {
      runs.push(open = { start: a, end: z, total, canonical, gaps: bin['-'] || 0,
        comparable: stat?.comparable || 0, different: stat?.different || 0 })
    }
    // Closed as soon as it is wide enough to see. With no minimum - anywhere a
    // column is already a pixel or more - that is every bin, and this returns
    // the bins themselves, one run apiece, exactly as it always did.
    if (open.end - open.start >= minColumns) open = null
  }
  for (const run of runs) {
    run.gap = run.total > 0 && run.gaps === run.total
    run.fraction = run.comparable ? run.different / run.comparable : null
  }
  return runs
}

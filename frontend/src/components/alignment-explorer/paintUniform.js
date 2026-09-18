import { ROW_HEIGHT } from './layout.js'

/** The span cut into runs of sequence and runs of gap, each as long as it can
 * be. Separated from the painting because this is the only decision in the
 * shading, and it is one that can be checked without a canvas.
 *
 * At detail resolution a gap is this row's own `-`. Over bins it is a bin every
 * sequence was absent from: half a bin of bases is still sequence, and calling
 * that a gap would invent an absence. With neither - a span still loading - the
 * whole thing is sequence, which is what the membership already said.
 */
export function uniformRuns(start, end, row, data, detail) {
  const runs = []
  const add = (from, to, gap) => {
    if (to <= from) return
    const last = runs[runs.length - 1]
    if (last && last.gap === gap && last.end === from) last.end = to
    else runs.push({ start: from, end: to, gap })
  }
  if (detail && row?.sequence != null) {
    for (let column = start; column < end; column++) add(column, column + 1, row.sequence[column - data.start] === '-')
  } else if (row?.bins?.length && data?.bin_size) {
    const size = data.bin_size, origin = data.start
    // Only the bins the span reaches. Walking the whole tile and discarding
    // what fell outside was free while a span was a whole tile, and is anything
    // but once a collapsed block hands this one span per kept run: a block cut
    // into four thousand runs walked the tile's bins four thousand times over
    // to draw each of them once.
    const first = Math.max(0, Math.floor((start - origin) / size))
    const last = Math.min(row.bins.length, Math.ceil((end - origin) / size))
    for (let i = first; i < last; i++) {
      const bin = row.bins[i], binStart = origin + i * size
      let total = 0
      for (const key in bin) total += bin[key]
      add(Math.max(start, binStart), Math.min(end, data.end, binStart + size), bin['-'] === total)
    }
  } else {
    add(start, end, false)
  }
  return runs
}

/** Paint one row-span in a single colour.
 *
 * What uniform shading does where a column is too narrow to be a base. A
 * sibling of the bin branch, never a change to it: the optimised path is left
 * exactly as it was and this runs instead of it, and only there - close up the
 * detail branch below still paints the sequence itself.
 *
 * The cheapest branch by a distance, since a span with no gaps in it is one
 * rectangle. Gaps are the one thing still drawn, because without them a
 * sequence missing half a block would be indistinguishable from one running the
 * whole way through, and that shape is what this shading exists to show.
 */
export function paintUniformSpan(ctx, { start, end, row, data, colour, x, scale, fragmentStart, y,
  colors, counter }) {
  // Only ever the binned half: a row too thin for bins was already drawn as one
  // rect above, and a span at base resolution never reaches here at all.
  const top = y + 3, height = ROW_HEIGHT - 6
  const left = column => x + (column - fragmentStart) * scale
  const draw = (from, to, gap) => {
    const a = Math.round(left(from)), b = Math.round(left(to)), width = Math.max(.5, b - a)
    ctx.fillStyle = gap ? colors.background : colour
    ctx.fillRect(a, top, width, height)
    if (gap && width >= 2) {
      ctx.strokeStyle = colors.gap; ctx.lineWidth = .7
      ctx.strokeRect(a + .5, top + .5, Math.max(0, width - 1), height - 1); ctx.lineWidth = 1
    }
    if (counter) counter.fills++
  }
  // Equal neighbours merged, so a run of sequence is one rectangle however many
  // columns it spans and a gap costs one more.
  for (const run of uniformRuns(start, end, row, data, false)) draw(run.start, run.end, run.gap)
}

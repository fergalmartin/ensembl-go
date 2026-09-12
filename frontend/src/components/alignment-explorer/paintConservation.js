import { ROW_HEIGHT } from './layout.js'
import { conservationSpans } from './conservationCoverage.js'
import { conservationRuns, rampColour, rampHeight, GAP_RUN, NOT_COMPARABLE } from './conservation.js'
import { NUCLEOTIDE_LETTER_THRESHOLD } from '../../utils/nucleotideStyle'
import { monoFont } from '../../utils/typography'

/** Paint one row-span under a cohort scheme.
 *
 * Deliberately a sibling of the base and bin branches rather than a change to
 * them: the optimised path those two share is left exactly as it was, and this
 * runs instead of them, never alongside.
 *
 * Cheaper than either, because a colour here belongs to a column rather than to
 * a base. Neighbouring columns in the same bucket become one rectangle, so a
 * conserved stretch costs a handful of fills where painting it base by base
 * cost one per column.
 */
export function paintConservationSpan(ctx, { start, end, row, data, sources, cohort, ramp, index, contrast,
  x, scale, fragmentStart, y, colors, onScreen, light, flat, rowPad, counter }) {
  const detail = !!data?.detail && row?.sequence != null && !flat
  // A row too short to carry bins is not too short to carry this: a colour per
  // column still resolves where a gap or a base no longer does, and a sheet of
  // thin rows is exactly where scanning for conserved stretches pays.
  const top = flat ? y + rowPad : detail ? y + 1 : y + 3
  const height = flat ? ROW_HEIGHT - 2 * rowPad : detail ? 24 : ROW_HEIGHT - 6
  // A gap belongs to this row, not to the column, and has to survive a wash
  // that is otherwise about every sequence at once.
  const gapAt = detail ? column => row.sequence[column - data.start] === '-' : null
  const { spans, holes } = conservationSpans(sources, start, end)
  const left = column => x + (column - fragmentStart) * scale
  for (const span of spans) {
    for (const run of conservationRuns(span.data, span.start, span.end, cohort, gapAt, index, contrast)) {
      const a = Math.round(left(run.start)), b = Math.round(left(run.end))
      const width = Math.max(.5, b - a)
      if (run.index === GAP_RUN || run.index === NOT_COMPARABLE) {
        ctx.fillStyle = run.index === GAP_RUN ? colors.background : colors.void
        ctx.fillRect(a, top, width, height)
        if (width >= 2 && !flat) {
          // A gap is outlined in the gap colour; a span with no statistic yet is
          // not a gap, and keeps the neutral border that says so.
          ctx.strokeStyle = run.index === GAP_RUN ? colors.gap : colors.border; ctx.lineWidth = .7
          ctx.strokeRect(a + .5, top + .5, Math.max(0, width - 1), height - 1); ctx.lineWidth = 1
        }
      } else {
        // Colour is agreement; how much of the row it fills is how much of the
        // cohort is there to agree. Saturation was tried for this and failed:
        // with a large cohort most bins sit near a tenth of it, which washed
        // every colour out to the same grey and hid agreement entirely.
        const tall = Math.max(1, height * rampHeight(run.index))
        ctx.fillStyle = ramp[rampColour(run.index)]
        ctx.fillRect(a, top + (height - tall) / 2, width, tall)
      }
      if (counter) counter.fills++
    }
  }
  // Where the statistic has not arrived, say so in the same neutral the rest of
  // the view uses for that, rather than inventing a second waiting state.
  for (const [a, z] of holes) {
    const from = Math.round(left(a)), to = Math.round(left(z))
    ctx.fillStyle = light ? '#aab8c6' : '#415268'
    ctx.globalAlpha = .35; ctx.fillRect(from, top, Math.max(.5, to - from), height); ctx.globalAlpha = 1
    if (counter) counter.fills++
  }
  // The wash says what the column does; the letters still say what this row is.
  if (detail && onScreen >= NUCLEOTIDE_LETTER_THRESHOLD) {
    ctx.font = monoFont(12); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = light ? '#1d2b3c' : '#f2f6fb'
    for (let column = start; column < end; column++) {
      const base = row.sequence[column - data.start]
      if (base === '-') continue
      const a = Math.round(left(column)), b = Math.round(left(column + 1))
      ctx.fillText(base.toUpperCase(), a + Math.max(.5, b - a) / 2, top + height / 2)
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }
}

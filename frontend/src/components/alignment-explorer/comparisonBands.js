/**
 * Colour measured differences separately from bases and annotation.
 * Substitutions are warm; the two directional gap types use distinct cool
 * colours. Unknown and unavailable data are neutral. Prioritise differences
 * over absence so a small substitution remains visible within a larger bin.
 */
export const BAND_KINDS = [
  ['substitution', '#e0913a', 'Substituted'],
  ['target_gap', '#3f7fd0', 'Gap in this row'],
  ['reference_gap', '#8a63d2', 'Gap in the comparison row'],
  ['unknown', '#8f9fb3', 'Unknown bases'],
  ['unavailable', '#5b6b80', 'No coverage'],
]

/** One bin's band, as slices in proportion to what was counted.
 *
 * Every kind gets width in proportion to its share of the bin, so the ink is
 * the measurement rather than a summary of it. Matches are left as background:
 * agreement is the absence of a mark, which is what makes a difference visible
 * at a glance across forty rows.
 */
export function bandSlices(bin, width) {
  // Double gaps still occupy screen columns, although excluded from biological
  // counts. Use the full bin width so other differences do not fill that space.
  const total = bin.end > bin.start ? bin.end - bin.start : BAND_KINDS.reduce((sum, [kind]) => sum + (bin[kind] || 0), 0) + (bin.match || 0)
  if (!total || width <= 0) return []
  const slices = []
  let cursor = 0
  for (const [kind, colour] of BAND_KINDS) {
    const count = bin[kind] || 0
    if (!count) continue
    // A kind that is present at all gets at least a hairline, or a single
    // substituted column in a wide bin would round away to nothing.
    const size = (count / total) * width
    slices.push({ x: cursor, width: size, colour, kind, count })
    cursor += size
  }
  return slices
}

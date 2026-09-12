/** Compose conservation tiles the way sequence tiles are composed: finest
 * first, each filling only what better data left open. An arriving partial
 * tile must never erase a coarse one's coverage, or a pan would reshade behind
 * the reader. Spans do not overlap, so nothing double-blends. */
export function conservationSpans(sources, start, end) {
  const spans = []
  if (!sources?.length) return { spans, holes: [[start, end]] }
  const candidates = sources.filter(data => data.end > start && data.start < end && data.bins?.columns?.length)
    .sort((a, b) => a.bin_size - b.bin_size)
  let holes = [[start, end]]
  for (const data of candidates) {
    const next = []
    for (const [a, z] of holes) {
      const lo = Math.max(a, data.start), hi = Math.min(z, data.end)
      if (hi <= lo) { next.push([a, z]); continue }
      spans.push({ start: lo, end: hi, data })
      if (a < lo) next.push([a, lo])
      if (hi < z) next.push([hi, z])
    }
    holes = next
    if (!holes.length) break
  }
  return { spans: spans.sort((a, b) => a.start - b.start), holes }
}

/** One column's numbers, for a readout rather than a fill. */
export function sampleConservation(sources, column) {
  let best = null
  for (const data of sources || []) {
    if (column < data.start || column >= data.end || !data.bins?.columns?.length) continue
    if (!best || data.bin_size < best.bin_size) best = data
  }
  if (!best) return null
  const bin = Math.floor((column - best.start) / best.bin_size)
  if (bin < 0 || bin >= best.bins.columns.length) return null
  const at = name => best.bins[name][bin]
  return { bin_size: best.bin_size, cohort: best.cohort, majority: at('majority'), canonical: at('canonical'),
    comparable: at('comparable'), occupied: at('occupied'), columns: at('columns') }
}

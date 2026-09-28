/**
 * Exon coverage across a set of transcripts.
 *
 * Every active transcript's exons are laid over one another and each base is
 * scored by how many of those transcripts have it in an exon. The Feature
 * Explorer draws the result as a heatmap row above the transcripts; this module
 * is only the arithmetic, so it can be tested without a DOM.
 *
 * Coordinates are 1-based and inclusive, as they arrive from the annotation.
 */

/** How many slices the coverage profile chart cuts the span into, at most. */
export const EXON_COVERAGE_PROFILE_BINS = 80

function validIntervals(features) {
  return (Array.isArray(features) ? features : [])
    .map((feature) => ({ start: Math.round(Number(feature?.start)), end: Math.round(Number(feature?.end)) }))
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end >= iv.start)
}

/** Overlapping or abutting intervals merged, so one transcript counts a base once. */
export function mergeInclusiveIntervals(intervals) {
  const sorted = validIntervals(intervals).sort((a, b) => a.start - b.start)
  const merged = []
  for (const iv of sorted) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end + 1) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  return merged
}

function intervalLength(iv) {
  return (iv.end - iv.start) + 1
}

/**
 * @param transcripts the active transcripts
 * @param totalTranscriptCount every transcript of the gene, active or not
 * @returns `{ runs, stats }`. `runs` tile the span of the active transcripts
 *   end to end, each `{ start, end, count, fraction }`; a run with count 0 is a
 *   stretch no active transcript has in an exon.
 */
export function computeExonCoverage(transcripts, totalTranscriptCount = 0) {
  const txs = Array.isArray(transcripts) ? transcripts.filter(Boolean) : []
  const activeCount = txs.length
  const total = Math.max(activeCount, Number(totalTranscriptCount) || 0)

  let spanStart = Infinity
  let spanEnd = -Infinity
  const events = new Map()
  const bump = (pos, delta) => events.set(pos, (events.get(pos) || 0) + delta)
  const codingIntervals = []

  for (const tx of txs) {
    const exons = mergeInclusiveIntervals(tx?.exons)
    const bounds = validIntervals([{ start: Math.min(Number(tx?.start), Number(tx?.end)), end: Math.max(Number(tx?.start), Number(tx?.end)) }])
    for (const iv of [...bounds, ...exons]) {
      spanStart = Math.min(spanStart, iv.start)
      spanEnd = Math.max(spanEnd, iv.end)
    }
    for (const exon of exons) {
      bump(exon.start, 1)
      bump(exon.end + 1, -1)
    }
    codingIntervals.push(...validIntervals(tx?.cds_list))
  }

  const emptyStats = {
    activeCount,
    totalCount: total,
    spanStart: null,
    spanEnd: null,
    spanLength: 0,
    coveredBases: 0,
    uncoveredBases: 0,
    exonicBlocks: 0,
    maxCount: 0,
    meanCoverageFraction: 0,
    meanTranscriptsPerCoveredBase: 0,
    constitutiveBases: 0,
    uniqueBases: 0,
    codingBases: 0,
  }
  if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd) || activeCount === 0) {
    return { runs: [], stats: emptyStats }
  }

  const positions = [...new Set([spanStart, spanEnd + 1, ...events.keys()])]
    .filter((pos) => pos >= spanStart && pos <= spanEnd + 1)
    .sort((a, b) => a - b)

  const runs = []
  let depth = 0
  for (let i = 0; i < positions.length - 1; i += 1) {
    depth += events.get(positions[i]) || 0
    const start = positions[i]
    const end = positions[i + 1] - 1
    if (end < start) continue
    const last = runs[runs.length - 1]
    if (last && last.count === depth && last.end + 1 === start) {
      last.end = end
      continue
    }
    runs.push({ start, end, count: depth, fraction: depth / activeCount })
  }

  let coveredBases = 0
  let depthSum = 0
  let maxCount = 0
  let constitutiveBases = 0
  let uniqueBases = 0
  let exonicBlocks = 0
  let previousCovered = false
  for (const run of runs) {
    const len = intervalLength(run)
    const covered = run.count > 0
    if (covered) {
      coveredBases += len
      depthSum += run.count * len
      maxCount = Math.max(maxCount, run.count)
      if (run.count === activeCount) constitutiveBases += len
      if (run.count === 1) uniqueBases += len
      if (!previousCovered) exonicBlocks += 1
    }
    previousCovered = covered
  }

  const spanLength = (spanEnd - spanStart) + 1
  const codingBases = mergeInclusiveIntervals(codingIntervals).reduce((sum, iv) => sum + intervalLength(iv), 0)


  return {
    runs,
    stats: {
      ...emptyStats,
      spanStart,
      spanEnd,
      spanLength,
      coveredBases,
      uncoveredBases: spanLength - coveredBases,
      exonicBlocks,
      maxCount,
      meanCoverageFraction: coveredBases > 0 ? depthSum / (coveredBases * activeCount) : 0,
      meanTranscriptsPerCoveredBase: coveredBases > 0 ? depthSum / coveredBases : 0,
      constitutiveBases,
      uniqueBases,
      codingBases,
    },
  }
}

/**
 * The span cut into equal slices for a small chart of coverage along the gene.
 *
 * Each slice gives how many of its bases are exonic and the mean coverage of
 * those exonic bases (null where there are none), so a bar's height says how
 * shared the exons in that stretch are rather than how much exon it holds.
 * Ordered 5' to 3' along `strand`.
 */
export function exonCoverageProfile(coverage, strand = '+', binCount = EXON_COVERAGE_PROFILE_BINS) {
  const runs = Array.isArray(coverage?.runs) ? coverage.runs : []
  const stats = coverage?.stats || {}
  const activeCount = Number(stats.activeCount) || 0
  const spanStart = Number(stats.spanStart)
  const spanLength = Number(stats.spanLength) || 0
  if (!runs.length || !activeCount || !Number.isFinite(spanStart) || spanLength <= 0) return []
  const count = Math.max(1, Math.min(Math.floor(Number(binCount) || 1), spanLength))

  const bins = []
  let runIndex = 0
  for (let i = 0; i < count; i += 1) {
    const start = spanStart + Math.floor((i * spanLength) / count)
    const end = spanStart + Math.floor(((i + 1) * spanLength) / count) - 1
    while (runIndex < runs.length && runs[runIndex].end < start) runIndex += 1
    let exonicBases = 0
    let depth = 0
    for (let r = runIndex; r < runs.length && runs[r].start <= end; r += 1) {
      const run = runs[r]
      if (run.count <= 0) continue
      const overlap = Math.min(end, run.end) - Math.max(start, run.start) + 1
      if (overlap <= 0) continue
      exonicBases += overlap
      depth += overlap * run.count
    }
    bins.push({
      start,
      end,
      length: (end - start) + 1,
      exonicBases,
      meanCoverageFraction: exonicBases > 0 ? depth / (exonicBases * activeCount) : null,
    })
  }
  if (String(strand) === '-') bins.reverse()
  return bins
}

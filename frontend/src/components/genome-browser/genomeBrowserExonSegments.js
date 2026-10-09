/**
 * Split a transcript exon into coding / non-coding drawing segments.
 *
 * Annotation coordinates here are GFF-style, 1-based and inclusive on both ends,
 * so a single-base feature is `start === end`. Gene predictors emit those freely:
 * the Helixer human annotation, for example, has ~22.7k single-base exons (11% of
 * its exons are 3bp or shorter), typically as a 1bp 5' UTR opening a transcript.
 * Treating a single-base exon as empty makes the 5' end of such a gene disappear,
 * leaving only the bare intron line running to the transcript start.
 *
 * Segments are returned in the same inclusive convention as the input, so a
 * segment covers every base from `start` to `end` and a single-base segment has
 * `start === end`. Callers must therefore map them to pixels as the half-open
 * range [x(start), x(end + 1)) — `getGenomicIntervalPixelBounds` does this.
 *
 * Returns [] only when the exon is genuinely unusable (non-finite, or inverted).
 */
export function getTranscriptExonSegments({ exonStart, exonEnd, cdsList = [] }) {
  const start = Number(exonStart)
  const end = Number(exonEnd)
  // `end < start` is malformed; `end === start` is a legitimate single-base exon.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []

  const overlaps = (Array.isArray(cdsList) ? cdsList : [])
    .map((cds) => {
      const cdsStart = Number(cds?.start)
      const cdsEnd = Number(cds?.end)
      if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd)) return null
      const s = Math.max(start, cdsStart)
      const e = Math.min(end, cdsEnd)
      // `e === s` is a real one-base coding overlap, not an empty one.
      return e >= s ? { start: s, end: e } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)

  const segments = []
  let cursor = start
  for (const coding of overlaps) {
    if (coding.start > cursor) {
      segments.push({ start: cursor, end: coding.start - 1, coding: false })
    }
    segments.push({ start: coding.start, end: coding.end, coding: true })
    cursor = Math.max(cursor, coding.end + 1)
  }
  if (cursor <= end) {
    segments.push({ start: cursor, end, coding: false })
  }
  return segments
}

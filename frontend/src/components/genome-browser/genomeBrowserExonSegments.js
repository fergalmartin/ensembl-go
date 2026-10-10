/**
 * Split exons into coding and non-coding drawing segments.
 * Input and output use one-based inclusive coordinates, so start === end is a
 * valid single-base exon. Map segments to pixels as [x(start), x(end + 1)).
 * Return [] only for invalid or inverted coordinates.
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

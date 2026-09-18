/** Geometry for the genomic context tracks, in bases rather than columns.
 *
 * This is the other half of block context, and the half where an exon's real
 * length becomes visible: above, a short exon can occupy as many shared columns
 * as a long one, because columns are what the alignment made of them. Here it
 * is drawn at its own scale, on its own coordinates.
 *
 * Every interval is zero-based half-open, as the block-context endpoints are.
 */

/** One track's window: its selection, plus context either side.
 *
 * The scale is shared across the pair so the two are comparable, but each is
 * centred on its own selection - so two genomic spans of unequal length stay
 * visibly unequal, which is the fact worth seeing. */
export function trackWindow(selection, context, width, bpPerPx) {
  if (!selection) return null
  const span = Math.max(1, selection.end - selection.start)
  const centre = (selection.start + selection.end) / 2
  const visible = Math.max(1, Math.round(bpPerPx * width))
  const start=Math.max(0,Math.round(centre-visible/2))
  return { start, end:start+visible, span, centre }
}

/** Bases per pixel for a pair of selections, so both tracks are drawn to one
 * scale. The wider of the two decides it; neither is squeezed to match. */
export function pairScale(selections, context, width) {
  const spans = selections.filter(Boolean).map(s => Math.max(1, s.end - s.start) + 2 * context)
  if (!spans.length || width <= 0) return 1
  return Math.max(...spans) / width
}

/** Where a coordinate lands, following the alignment row's own direction.
 *
 * A row aligned on the reverse strand reads 5'->3' left to right in the
 * alignment above, so its genomic track is drawn the same way round and its
 * coordinates count down. Getting this from the row's strand - never the
 * transcript's - is what keeps the two halves of the view in register. */
export function coordinateToX(coordinate, window_, width, reverse) {
  const span = Math.max(1, window_.end - window_.start)
  const fraction = (coordinate - window_.start) / span
  return (reverse ? 1 - fraction : fraction) * width
}
export function xToCoordinate(x, window_, width, reverse) {
  const fraction = width > 0 ? x / width : 0
  const span = Math.max(1, window_.end - window_.start)
  return Math.round(window_.start + (reverse ? 1 - fraction : fraction) * span)
}

/** The parts of a window that the alignment block covers, and the parts it does
 * not. Sequence outside the block is real sequence with no alignment behind it,
 * and must never be shaded as though the alignment had something to say there. */
export function blockCoverage(window_, blockSpan) {
  if (!blockSpan) return { inside: null, before: { ...window_ }, after: null }
  const inside = { start: Math.max(window_.start, blockSpan.start), end: Math.min(window_.end, blockSpan.end) }
  return {
    inside: inside.end > inside.start ? inside : null,
    before: window_.start < blockSpan.start ? { start: window_.start, end: Math.min(window_.end, blockSpan.start) } : null,
    after: window_.end > blockSpan.end ? { start: Math.max(window_.start, blockSpan.end), end: window_.end } : null,
  }
}

/** A tick step that gives round numbers at this scale. */
export function rulerStep(bpPerPx, target = 90) {
  const raw = Math.max(1, bpPerPx * target)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map(x => x * magnitude).find(x => x >= raw) || magnitude * 10
}

/** Exon pieces split into coding and non-coding, the way the genome browser
 * draws them: coding filled, UTR hollow. Reuses that view's vocabulary rather
 * than inventing a second one. */
export function exonSegments(exonStart, exonEnd, cdsList) {
  const overlaps = (cdsList || [])
    .map(cds => ({ start: Math.max(exonStart, cds.start - 1), end: Math.min(exonEnd, cds.end) }))
    .filter(cds => cds.end > cds.start)
    .sort((a, b) => a.start - b.start)
  const segments = []
  let cursor = exonStart
  for (const coding of overlaps) {
    if (coding.start > cursor) segments.push({ start: cursor, end: coding.start, coding: false })
    segments.push({ start: coding.start, end: coding.end, coding: true })
    cursor = Math.max(cursor, coding.end)
  }
  if (cursor < exonEnd) segments.push({ start: cursor, end: exonEnd, coding: false })
  return segments
}

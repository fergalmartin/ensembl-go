export const SEQUENCE_TRACK_HEIGHT = 36
// Bare safety floor for a genome that has nothing to draw. Uniform multi-genome
// band height is negotiated from the tallest panel's real content instead of a
// fixed number, so this should almost never bind.
export const MIN_BROWSER_PANEL_HEIGHT = 200

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export function getGenomeBrowserPanelSizing(panelCount, adaptiveHeight) {
  const count = Math.max(0, Math.floor(Number(panelCount) || 0))
  const usesContentHeight = Boolean(adaptiveHeight)
  const fillsAvailableHeight = !usesContentHeight && count <= 1
  return {
    usesContentHeight,
    fillsAvailableHeight,
    // A floor, never a cap. Panels always grow to fit their tracks so the
    // page-level scroller stays the only vertical scrollbar.
    panelMinHeight: !usesContentHeight && !fillsAvailableHeight
      ? MIN_BROWSER_PANEL_HEIGHT
      : null,
  }
}

export function shouldRenderViewportTranscriptStructures({
  viewSpan,
  detailMaxSpan,
  geneIds = [],
  transcriptCache = {},
}) {
  const span = Number(viewSpan)
  const maxSpan = Number(detailMaxSpan)
  if (!Number.isFinite(span) || !Number.isFinite(maxSpan) || span > maxSpan) return false

  const ids = Array.from(new Set(
    (Array.isArray(geneIds) ? geneIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  ))
  if (ids.length === 0) return false

  const cache = transcriptCache && typeof transcriptCache === 'object'
    ? transcriptCache
    : {}
  return ids.every((id) => Object.prototype.hasOwnProperty.call(cache, id))
}

export function getFeatureRowAnchor({
  baseGeneY,
  pointerY,
  rowPitch,
  midOffset,
  transcriptIds = [],
  rowCount,
}) {
  const base = Number(baseGeneY)
  const pointer = Number(pointerY)
  const pitch = Number(rowPitch)
  const middle = Number(midOffset)
  if (![base, pointer, pitch, middle].every(Number.isFinite) || pitch <= 0) return null

  const ids = Array.isArray(transcriptIds) ? transcriptIds : []
  const count = Math.max(1, Math.floor(Number(rowCount) || ids.length || 1))
  const rowIndex = clamp(Math.round((pointer - base - middle) / pitch), 0, count - 1)
  const rowMidY = base + (rowIndex * pitch) + middle

  return {
    rowIndex,
    transcriptId: ids[rowIndex] == null ? null : String(ids[rowIndex]),
    rowOffset: clamp(pointer - rowMidY, -pitch / 2, pitch / 2),
  }
}

export function getFeatureRowTargetY({
  baseGeneY,
  rowPitch,
  midOffset,
  transcriptId,
  fallbackRowIndex = 0,
  rowOffset = 0,
  visibleTranscriptIds = [],
}) {
  const base = Number(baseGeneY)
  const pitch = Number(rowPitch)
  const middle = Number(midOffset)
  if (![base, pitch, middle].every(Number.isFinite) || pitch <= 0) return null

  const ids = Array.isArray(visibleTranscriptIds)
    ? visibleTranscriptIds.map((id) => String(id))
    : []
  let rowIndex = 0
  if (ids.length > 0) {
    const matchingIndex = transcriptId == null ? -1 : ids.indexOf(String(transcriptId))
    rowIndex = matchingIndex >= 0
      ? matchingIndex
      : clamp(Math.floor(Number(fallbackRowIndex) || 0), 0, ids.length - 1)
  }

  const safeOffset = clamp(Number(rowOffset) || 0, -pitch / 2, pitch / 2)
  return base + (rowIndex * pitch) + middle + safeOffset
}

export function getAnchoredContentPageScrollDelta({
  containerTop,
  contentY,
  clientY,
}) {
  const y = Number(contentY)
  if (!Number.isFinite(y)) return null
  const safeContainerTop = Number(containerTop)
  const safeClientY = Number(clientY)
  if (!Number.isFinite(safeContainerTop) || !Number.isFinite(safeClientY)) return null
  return safeContainerTop + y - safeClientY
}

/**
 * Re-frames a gene-focus range so the gene lands centred in the part of the
 * track a right-hand overlay leaves visible, rather than centred behind it.
 *
 * `start`/`end` is the range that would have been shown across the full track,
 * already padded around the gene. The gene keeps the same share of the *visible*
 * width that it had of the full width, so the zoom feels unchanged — only the
 * window slides across so the gene sits in the open space.
 *
 * With no inset this returns the range untouched.
 */
export function frameRangeWithRightInset({
  start,
  end,
  trackWidthPx,
  rightInsetPx = 0,
  flipped = false,
}) {
  const rangeStart = Number(start)
  const rangeEnd = Number(end)
  const trackWidth = Number(trackWidthPx)
  const inset = Number(rightInsetPx)
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
    return null
  }
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return { start: rangeStart, end: rangeEnd }
  if (!Number.isFinite(inset) || inset <= 0) return { start: rangeStart, end: rangeEnd }

  // An overlay wider than the track leaves nothing to centre in; keep a sliver
  // rather than dividing by zero or flinging the view off to one side.
  const visibleWidth = Math.max(trackWidth * 0.15, trackWidth - inset)

  const span = rangeEnd - rangeStart
  const centre = (rangeStart + rangeEnd) / 2
  const nextSpan = span * (trackWidth / visibleWidth)
  const bpPerPx = nextSpan / trackWidth
  const centreOffsetBp = (visibleWidth / 2) * bpPerPx

  if (flipped) {
    const nextEnd = centre + centreOffsetBp
    return { start: nextEnd - nextSpan, end: nextEnd }
  }
  const nextStart = centre - centreOffsetBp
  return { start: nextStart, end: nextStart + nextSpan }
}

/**
 * Snap a band to a bar it has to sit flush against.
 *
 * Both edges land on whole pixels, and the height is the distance between them.
 * Rounding the offset and the height independently lets two half pixels compound,
 * which leaves the band's bottom edge a pixel below the bar's — close enough to
 * look like a mistake rather than a rounding artefact.
 */
export function alignBandToBar({ barTop, barHeight, hostTop = 0 }) {
  const top = Number(barTop)
  const height = Number(barHeight)
  const host = Number(hostTop)
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(host)) return null

  const rawTop = top - host
  const snappedTop = Math.round(rawTop)
  return {
    top: snappedTop,
    height: Math.round(rawTop + height) - snappedTop,
  }
}

/**
 * Re-balances the current view when the right-hand overlay changes width.
 *
 * Unlike `frameRangeWithRightInset` this does not re-frame around the gene's
 * extent: it keeps whatever zoom the user is on and rescales it by the ratio of
 * visible widths, so the focus gene ends up occupying the same share of the
 * newly visible track that it did of the old one. Collapsing a 300px drawer on a
 * 1550px track is a ~21% change either way, whether the user is looking at
 * 100kb or at 10Mb — which is what stops a zoomed-out view being hauled back in
 * just to fill the space.
 *
 * Exactly reversible: the two ratios are reciprocals, so opening the drawer
 * again undoes the span change.
 */
export function rebalanceRangeForInsetChange({
  start,
  end,
  trackWidthPx,
  fromInsetPx = 0,
  toInsetPx = 0,
  focusCentre,
  flipped = false,
}) {
  const rangeStart = Number(start)
  const rangeEnd = Number(end)
  const trackWidth = Number(trackWidthPx)
  const centre = Number(focusCentre)
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return null
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return null
  if (!Number.isFinite(centre)) return null

  const from = Number(fromInsetPx)
  const to = Number(toInsetPx)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null

  // Same sliver guard as the framing helper, so an overlay wider than the track
  // rescales by a bounded amount instead of dividing by zero.
  const visibleFrom = Math.max(trackWidth * 0.15, trackWidth - Math.max(0, from))
  const visibleTo = Math.max(trackWidth * 0.15, trackWidth - Math.max(0, to))
  if (visibleFrom === visibleTo) return { start: rangeStart, end: rangeEnd }

  const nextSpan = (rangeEnd - rangeStart) * (visibleFrom / visibleTo)
  const centreOffsetBp = (visibleTo / 2) * (nextSpan / trackWidth)

  if (flipped) {
    const nextEnd = centre + centreOffsetBp
    return { start: nextEnd - nextSpan, end: nextEnd }
  }
  const nextStart = centre - centreOffsetBp
  return { start: nextStart, end: nextStart + nextSpan }
}

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

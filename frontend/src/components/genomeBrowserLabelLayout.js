const DEFAULT_EDGE_GUTTER_PX = 30
const DEFAULT_LABEL_PADDING_X = 4
const DEFAULT_LABEL_ASCENT_PX = 10
const DEFAULT_LABEL_DESCENT_PX = 4
const DEFAULT_COLLISION_GAP_X = 4
const DEFAULT_COLLISION_GAP_Y = 1
const DEFAULT_MIN_GENE_WIDTH_PX = 8
const DEFAULT_FOOTER_EDGE_GUTTER_PX = 6

export const GENE_FOOTER_LABEL_BASELINE_OFFSET = 14
export const GENE_FOOTER_CONTROL_TOP_OFFSET = 18
export const TRANSCRIPT_FOOTER_CONTROL_HEIGHT = 16
export const GENE_FOOTER_TRACK_OVERFLOW = 6

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function getGeneLabelText(gene) {
  return String(gene?.name || gene?.id || '').trim()
}

export function getVisibleTranscriptCount(gene, txs, getEffectiveTranscriptLimit) {
  if (!Array.isArray(txs) || txs.length === 0) return 1
  const requested = Number(getEffectiveTranscriptLimit?.(gene?.id, txs) ?? 1)
  const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1
  return Math.max(1, Math.min(txs.length, limit))
}

export function getGeneFooterGeometry({
  gene,
  txs,
  getEffectiveTranscriptLimit,
  genomicToScreen,
  baseGeneY,
  transcriptLayoutMetrics,
  lhsWidth = 0,
  viewWidth = Number.POSITIVE_INFINITY,
  edgeGutterPx = DEFAULT_FOOTER_EDGE_GUTTER_PX,
}) {
  if (!gene || typeof genomicToScreen !== 'function') return null
  const rawStartX = genomicToScreen(gene.start)
  const rawEndX = genomicToScreen(gene.end)
  if (!Number.isFinite(rawStartX) || !Number.isFinite(rawEndX)) return null

  const visibleTranscriptCount = getVisibleTranscriptCount(
    gene,
    txs,
    getEffectiveTranscriptLimit,
  )
  const rowPitch = Number(transcriptLayoutMetrics?.rowPitch || 0)
  const midOffset = Number(transcriptLayoutMetrics?.midOffset || 0)
  const lastTranscriptMidY = (
    Number(baseGeneY)
    + ((visibleTranscriptCount - 1) * rowPitch)
    + midOffset
  )
  if (!Number.isFinite(lastTranscriptMidY)) return null

  const rawLeft = Math.min(rawStartX, rawEndX)
  const minX = Number(lhsWidth) + edgeGutterPx
  const maxX = Number.isFinite(viewWidth)
    ? Math.max(minX, Number(viewWidth) - edgeGutterPx)
    : rawLeft

  return {
    x: clamp(rawLeft, minX, maxX),
    rawLeft,
    rawRight: Math.max(rawStartX, rawEndX),
    labelY: lastTranscriptMidY + GENE_FOOTER_LABEL_BASELINE_OFFSET,
    controlY: lastTranscriptMidY + GENE_FOOTER_CONTROL_TOP_OFFSET,
    lastTranscriptMidY,
    visibleTranscriptCount,
  }
}

export function getTranscriptFooterControlState(totalTranscripts, visibleTranscripts) {
  const total = Math.max(0, Math.floor(Number(totalTranscripts) || 0))
  const visible = Math.max(1, Math.floor(Number(visibleTranscripts) || 1))
  if (total <= 1) return null
  if (visible <= 1) {
    return {
      action: 'expandAll',
      label: `+${total - 1}`,
      title: `Show ${total - 1} additional transcript${total === 2 ? '' : 's'}`,
    }
  }
  return {
    action: 'collapse',
    label: 'X',
    title: 'Collapse transcript list',
  }
}

export function getTranscriptBoundaryTrails(gene, transcript, genomicToScreen, minGapPx = 1) {
  if (!gene || !transcript || typeof genomicToScreen !== 'function') return []
  const geneXs = [genomicToScreen(gene.start), genomicToScreen(gene.end)]
  const transcriptXs = [genomicToScreen(transcript.start), genomicToScreen(transcript.end)]
  if (![...geneXs, ...transcriptXs].every(Number.isFinite)) return []

  const geneLeft = Math.min(...geneXs)
  const geneRight = Math.max(...geneXs)
  const transcriptLeft = Math.min(...transcriptXs)
  const transcriptRight = Math.max(...transcriptXs)
  const trails = []

  if (transcriptLeft - geneLeft > minGapPx) {
    trails.push({ x1: geneLeft, x2: transcriptLeft, boundaryX: geneLeft })
  }
  if (geneRight - transcriptRight > minGapPx) {
    trails.push({ x1: transcriptRight, x2: geneRight, boundaryX: geneRight })
  }
  return trails
}

export function getGeneLabelCenterRange(gene, txs, getEffectiveTranscriptLimit) {
  let labelCenterStart = Number(gene?.start)
  let labelCenterEnd = Number(gene?.end)

  if (Array.isArray(txs) && txs.length > 0 && getEffectiveTranscriptLimit?.(gene?.id, txs) === 1) {
    const canonical = txs.find((tx) => tx?.is_canonical) || txs[0]
    const canonicalStart = Number(canonical?.start)
    const canonicalEnd = Number(canonical?.end)
    if (Number.isFinite(canonicalStart) && Number.isFinite(canonicalEnd)) {
      labelCenterStart = canonicalStart
      labelCenterEnd = canonicalEnd
    }
  }

  return {
    start: labelCenterStart,
    end: labelCenterEnd,
  }
}

export function buildGeneLabelCandidate({
  gene,
  trackId,
  trackOrder = 0,
  trackY,
  layout,
  transcriptLayoutMetrics,
  selectedGene,
  dimNonSelectedGenes = true,
  isLight,
  colors,
  geneLabelColor,
  genomicToScreen,
  viewWidth,
  txs,
  getEffectiveTranscriptLimit,
  measureTextWidth,
  lhsWidth,
  order = 0,
  minGeneWidthPx = DEFAULT_MIN_GENE_WIDTH_PX,
  edgeGutterPx = DEFAULT_EDGE_GUTTER_PX,
  labelPaddingX = DEFAULT_LABEL_PADDING_X,
  labelAscentPx = DEFAULT_LABEL_ASCENT_PX,
  labelDescentPx = DEFAULT_LABEL_DESCENT_PX,
  footerStyleEnabled = true,
}) {
  if (!gene || typeof genomicToScreen !== 'function' || typeof measureTextWidth !== 'function') return null

  const rawGx1 = genomicToScreen(gene.start)
  const rawGx2 = genomicToScreen(gene.end)
  if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2)) return null

  const gx1 = Math.min(rawGx1, rawGx2)
  const gx2 = Math.max(rawGx1, rawGx2)
  const geneWidth = Math.max(1, gx2 - gx1)
  if (gx2 < -50 || gx1 > viewWidth + 50 || geneWidth <= minGeneWidthPx) return null

  const text = getGeneLabelText(gene)
  if (!text) return null

  const isForward = gene.strand === '+'
  const trackPadding = isForward ? layout?.fwdPadding : layout?.revPadding
  const row = Math.max(0, Number(gene?._row || 0))
  const rowPitch = Number(transcriptLayoutMetrics?.rowPitch || 0)
  const baseGeneY = Number(trackY) + Number(trackPadding || 0) + (row * rowPitch)
  if (!Number.isFinite(baseGeneY)) return null

  const measuredWidth = Number(measureTextWidth(text))
  if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) return null

  let labelX
  let labelY
  let textAlign = 'center'
  if (footerStyleEnabled) {
    const footer = getGeneFooterGeometry({
      gene,
      txs,
      getEffectiveTranscriptLimit,
      genomicToScreen,
      baseGeneY,
      transcriptLayoutMetrics,
      lhsWidth,
      viewWidth,
    })
    if (!footer) return null
    const minX = Number(lhsWidth) + DEFAULT_FOOTER_EDGE_GUTTER_PX
    const maxX = Math.max(minX, viewWidth - measuredWidth - DEFAULT_FOOTER_EDGE_GUTTER_PX)
    labelX = clamp(footer.x, minX, maxX)
    labelY = footer.labelY
    textAlign = 'left'
  } else {
    const centerRange = getGeneLabelCenterRange(gene, txs, getEffectiveTranscriptLimit)
    const rawLabelX1 = genomicToScreen(centerRange.start)
    const rawLabelX2 = genomicToScreen(centerRange.end)
    if (!Number.isFinite(rawLabelX1) || !Number.isFinite(rawLabelX2)) return null
    const labelCenterX = (rawLabelX1 + rawLabelX2) / 2
    labelX = clamp(labelCenterX, Number(lhsWidth) + edgeGutterPx, viewWidth - edgeGutterPx)
    labelY = baseGeneY - 4
  }

  const isSelected = Boolean(selectedGene && selectedGene.id === gene.id)
  const shouldDim = dimNonSelectedGenes && !!selectedGene && !isSelected
  const fill = geneLabelColor || (shouldDim
    ? (isLight ? '#868e96' : '#8a8d93')
    : colors?.geneLabelText)

  return {
    gene,
    geneId: gene.id,
    text,
    x: labelX,
    y: labelY,
    left: textAlign === 'left'
      ? labelX - labelPaddingX
      : labelX - (measuredWidth / 2) - labelPaddingX,
    right: textAlign === 'left'
      ? labelX + measuredWidth + labelPaddingX
      : labelX + (measuredWidth / 2) + labelPaddingX,
    top: labelY - labelAscentPx,
    bottom: labelY + labelDescentPx,
    fill,
    trackId,
    trackOrder,
    row,
    order,
    priority: isSelected ? 1 : 0,
    textAlign,
  }
}

function labelBoxesOverlap(a, b, gapX, gapY) {
  return !(
    a.right + gapX <= b.left ||
    a.left >= b.right + gapX ||
    a.bottom + gapY <= b.top ||
    a.top >= b.bottom + gapY
  )
}

export function placeNonOverlappingGeneLabels(candidates, options = {}) {
  const gapX = Number(options.gapX ?? DEFAULT_COLLISION_GAP_X)
  const gapY = Number(options.gapY ?? DEFAULT_COLLISION_GAP_Y)
  const bandHeight = Math.max(4, Number(options.bandHeight ?? 16))
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => (
      candidate &&
      Number.isFinite(candidate.left) &&
      Number.isFinite(candidate.right) &&
      Number.isFinite(candidate.top) &&
      Number.isFinite(candidate.bottom)
    ))
    .sort((a, b) => (
      (Number(b.priority || 0) - Number(a.priority || 0)) ||
      (Number(a.trackOrder || 0) - Number(b.trackOrder || 0)) ||
      (Number(a.row || 0) - Number(b.row || 0)) ||
      (Number(a.x || 0) - Number(b.x || 0)) ||
      (Number(a.order || 0) - Number(b.order || 0))
    ))

  const placed = []
  const placedByBand = new Map()
  for (const candidate of ordered) {
    const startBand = Math.floor((candidate.top - gapY) / bandHeight)
    const endBand = Math.floor((candidate.bottom + gapY) / bandHeight)
    const nearby = new Set()
    for (let band = startBand; band <= endBand; band += 1) {
      const labels = placedByBand.get(band)
      if (!labels) continue
      for (const label of labels) nearby.add(label)
    }

    let collides = false
    for (const label of nearby) {
      if (labelBoxesOverlap(candidate, label, gapX, gapY)) {
        collides = true
        break
      }
    }
    if (collides) {
      continue
    }

    placed.push(candidate)
    for (let band = startBand; band <= endBand; band += 1) {
      const labels = placedByBand.get(band)
      if (labels) {
        labels.push(candidate)
      } else {
        placedByBand.set(band, [candidate])
      }
    }
  }

  return placed.sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
}

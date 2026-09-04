const DEFAULT_EDGE_GUTTER_PX = 30
const DEFAULT_LABEL_PADDING_X = 4
// The label's own box around its baseline, for 11px Lato. Exported because anything
// deciding whether a label collides with something — another label, or the ruler — needs
// the same two numbers this module places them with.
export const LABEL_ASCENT_PX = 10
export const LABEL_DESCENT_PX = 4
const DEFAULT_LABEL_ASCENT_PX = LABEL_ASCENT_PX
const DEFAULT_LABEL_DESCENT_PX = LABEL_DESCENT_PX
const DEFAULT_COLLISION_GAP_X = 4
const DEFAULT_COLLISION_GAP_Y = 1
const DEFAULT_MIN_GENE_WIDTH_PX = 8
const DEFAULT_FOOTER_EDGE_GUTTER_PX = 6

/**
 * Footer offsets are measured down from the mid-line of the last drawn
 * transcript row, so they have to clear the bottom of the exon block that sits
 * on that mid-line (EXON_HEIGHT / 2 = 6px).
 *
 * The label baseline is that 6px, plus a 2px gap, plus the cap height of the
 * 11px label (~8px) — anything less and the capitals of a gene symbol butt
 * straight up against the block, which is what 14 used to do.
 */
export const GENE_FOOTER_LABEL_BASELINE_OFFSET = 16
export const GENE_FOOTER_CONTROL_TOP_OFFSET = 20
export const TRANSCRIPT_FOOTER_CONTROL_HEIGHT = 16
/** How far below the last transcript's mid-line the footer row actually reaches: the
 *  deeper of its two forms, the collapsed `+N` control. */
export const GENE_FOOTER_ROW_BOTTOM_OFFSET = GENE_FOOTER_CONTROL_TOP_OFFSET + TRANSCRIPT_FOOTER_CONTROL_HEIGHT

/** The room a track has to keep below its last row for that footer to sit inside it.
 *
 *  Derived rather than a constant, because the offsets above are absolute pixels tuned for
 *  the ordinary 42px row pitch, and a flattened track's pitch is 18. A fixed reserve that
 *  is generous in one layout is six pixels short in the other — and when the panel is
 *  compact the ruler is placed flush against the last track, so those six pixels land on
 *  the ruler rather than in a margin. */
export function geneFooterTrackOverflow(transcriptLayoutMetrics, flattened = false) {
  const rowPitch = Number(transcriptLayoutMetrics?.rowPitch) || 0
  const midOffset = Number(transcriptLayoutMetrics?.midOffset) || 0
  // The flattened branch sizes its tracks from the row *gap*, one row-gap tighter than the
  // pitch the offsets below are measured against, so that has to be given back.
  const rowGap = flattened ? (Number(transcriptLayoutMetrics?.rowGap) || 0) : 0
  return Math.max(0, Math.round(midOffset + GENE_FOOTER_ROW_BOTTOM_OFFSET - rowPitch + rowGap))
}
export const GENE_FOOTER_VIEWPORT_BOTTOM_GAP = 12

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
  // Actual drawn row count, when the caller already knows it. The transcript
  // limit alone can't tell: hidden transcripts and hover ghosts move the last
  // row, and the footer has to sit under whatever was really drawn.
  visibleTranscriptCount: visibleTranscriptCountOverride,
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

  const overrideCount = Math.floor(Number(visibleTranscriptCountOverride))
  const visibleTranscriptCount = Number.isFinite(overrideCount) && overrideCount > 0
    ? overrideCount
    : getVisibleTranscriptCount(gene, txs, getEffectiveTranscriptLimit)
  const rowPitch = Number(transcriptLayoutMetrics?.rowPitch || 0)
  const midOffset = Number(transcriptLayoutMetrics?.midOffset || 0)
  const exonHeight = Number(transcriptLayoutMetrics?.exonHeight || 0)
  // The same arithmetic as the last row's mid-line, evaluated at row 0. Anything
  // marking the head of a gene — the note bubble does — needs it, and deriving it
  // here is what stops a second copy of the row maths drifting from this one.
  const firstTranscriptMidY = Number(baseGeneY) + midOffset
  const lastTranscriptMidY = (
    Number(baseGeneY)
    + ((visibleTranscriptCount - 1) * rowPitch)
    + midOffset
  )
  if (!Number.isFinite(lastTranscriptMidY) || !Number.isFinite(firstTranscriptMidY)) return null

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
    firstTranscriptMidY,
    // Top of the first row's exon block: where the gene starts, as far as
    // anything drawn above it is concerned. Independent of how many rows the
    // gene shows, unlike everything else here.
    topY: firstTranscriptMidY - (exonHeight / 2),
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

/**
 * Keep an expanded gene footer reachable while its natural position is
 * still below the visible part of the canvas. The footer moves down with the
 * viewport until the final transcript catches up, then resumes its normal
 * content position beneath that transcript.
 */
export function placeGeneFooterWithinViewport(
  footer,
  viewport,
  {
    controlHeight = TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
    bottomGap = GENE_FOOTER_VIEWPORT_BOTTOM_GAP,
  } = {},
) {
  if (!footer) return null

  const viewportTop = Number(viewport?.top)
  const viewportBottom = Number(viewport?.bottom)
  if (
    !Number.isFinite(viewportTop)
    || !Number.isFinite(viewportBottom)
    || viewportBottom <= viewportTop
    || !Number.isFinite(Number(footer.topY))
    || !Number.isFinite(Number(footer.controlY))
    || !Number.isFinite(Number(footer.labelY))
  ) {
    return footer
  }

  // Do not advertise a gene which has not entered the viewport yet. Once its
  // first row has appeared, the footer remains reachable until its natural
  // position itself reaches the visible bottom.
  if (Number(footer.topY) >= viewportBottom) return footer

  const safeHeight = Math.max(0, Number(controlHeight) || 0)
  const safeGap = Math.max(0, Number(bottomGap) || 0)
  const maxControlY = viewportBottom - safeGap - safeHeight
  if (Number(footer.controlY) <= maxControlY) return footer

  const shiftY = maxControlY - Number(footer.controlY)
  return {
    ...footer,
    labelY: Number(footer.labelY) + shiftY,
    controlY: maxControlY,
    naturalLabelY: Number(footer.labelY),
    naturalControlY: Number(footer.controlY),
    isViewportPinned: true,
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
  visibleTranscriptCount,
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
      visibleTranscriptCount,
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
/**
 * Whether something belonging to a track would be drawn into the ruler.
 *
 * The ruler is its own band, and a gene label or footer control that reaches into it is
 * unreadable over the ticks and makes the ticks unreadable too. It happens where the two
 * are flush: a compact panel puts the ruler immediately after the last track, so anything
 * that overflows its track by even a few pixels lands on it rather than in a margin.
 *
 * A backstop, not the fix — a track that reserves the room its footer needs never reaches
 * here. It is worth having because the arithmetic has several inputs (row pitch, mid
 * offset, gap, which layout is on) and being wrong about one of them should cost a hidden
 * label rather than a ruler drawn through a gene symbol.
 */
export function intersectsRuler(top, bottom, rulerY, rulerHeight) {
  const height = Number(rulerHeight) || 0
  if (height <= 0) return false
  const y = Number(rulerY)
  if (!Number.isFinite(y)) return false
  return Number(bottom) > y && Number(top) < y + height
}

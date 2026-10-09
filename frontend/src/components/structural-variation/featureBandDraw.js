// Drawing the structural-variation feature bands: lane layout constants, alignment
// coverage and gap annotations for the sequence lane, row packing, and the canvas
// painters for the band, ruler, transcript, sequence and hidden lanes.
import { drawPowerGlyph } from '../../utils/powerGlyph.js'
import { monoFont, sansFont } from '../../utils/typography.js'

export const PLOT_PAD_X = 2

export const BAND_HEIGHT = 30

export const TRACK_LABEL_WIDTH = 50   // wide enough for 2-char label + toggle circle

export const LANE_PADDING_Y = 6

export const ROW_PITCH = 24

export const EXON_HEIGHT = 8

export const RULER_TICK_COUNT = 6

export const DETAILED_LAYOUT_MAX_SPAN = 200_000

export const LABEL_MIN_WIDTH_PX = 54

export const SIMPLE_ARROW_MIN_WIDTH = 15

export const LABEL_ROW_HEIGHT = 10

export const ROW_CONTENT_Y = LABEL_ROW_HEIGHT + 6 + (EXON_HEIGHT / 2)

export const LAYOUT_GAP_BP = 1000

export const MAX_DISPLAYED_ROWS = 10

export const CHEVRON_SPACING_PX = 18

export const SEQ_TRACK_HEIGHT = 36

export const TOGGLE_RADIUS = 11 // hit radius; the glyph drawn inside it is smaller

export const TOGGLE_ICON_SIZE = 16

export const SEQ_FETCH_THRESHOLD = 1000

export const PLACEHOLDER_H = 22

export const SEQUENCE_ANNOTATION_FETCH_THRESHOLD = 2000

export const SEQUENCE_ANNOTATION_DEBOUNCE_MS = 120

// ── Helpers ───────────────────────────────────────────────────────────────────

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

export function formatCoord(v) { return Number(v || 0).toLocaleString() }

export function getLaneColors(isLight) {
  return {
    rulerTick:      isLight ? '#7ea2c9' : '#4a79aa',
    rulerText:      isLight ? '#4a6a8a' : '#64748b',
    forwardLaneBg:  isLight ? '#f0f7ff' : '#0d1520',
    reverseLaneBg:  isLight ? '#f8f9fa' : '#212226',
    sequenceBg:     isLight ? '#f0f7ff' : '#0d1520',
    laneLabelBg:    isLight ? 'rgba(226,236,250,0.95)' : 'rgba(12,23,44,0.96)',
    laneLabelText:  isLight ? '#53759a' : '#9eb8d6',
    intron:         isLight ? '#868e96' : '#5c5f66',
    chevron:        isLight ? '#868e96' : '#5c5f66',
    label:          isLight ? '#212529' : '#c1c2c5',
    baseSep:        isLight ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.20)',
    sequenceMatch:  'rgba(73, 184, 255, 0.28)',
    sequenceInversion: 'rgba(248, 192, 65, 0.52)',
    sequenceDeletion: '#ff595c',
    sequenceInsertion: '#5f73e6',
    sequenceSnv: '#f472b6',
    sequenceGapStroke: isLight ? '#cbd5e1' : '#64748b',
    sequenceGapText: isLight ? '#64748b' : '#94a3b8',
    sequenceFilledText: '#ffffff',
  }
}

export function buildViewportParam(window) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return ''
  return `${window.chrom}:${window.start}-${window.end}`
}

export function expandViewportWindow(window, minPad = 0) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return null
  const span = Math.max(1, Number(window.end) - Number(window.start))
  const pad = Math.max(minPad, span)
  return {
    chrom: window.chrom,
    start: Math.max(1, Number(window.start) - pad),
    end: Number(window.end) + pad,
  }
}

export function normalizeSequenceAnnotationType(type) {
  switch (String(type || '')) {
    case 'match':
    case 'inverted_match':
    case 'snv':
      return String(type)
    case 'deletion':
    case 'deletion_or_loss':
      return 'deletion_or_loss'
    case 'insertion':
    case 'gain_or_insertion':
      return 'gain_or_insertion'
    default:
      return 'no_match'
  }
}

export function mergeAnnotationIntervals(intervals = []) {
  const sorted = [...intervals]
    .filter((interval) =>
      Number.isFinite(interval?.start) &&
      Number.isFinite(interval?.end) &&
      interval.end > interval.start &&
      interval.type
    )
    .sort((a, b) => {
      if (a.type !== b.type) return String(a.type).localeCompare(String(b.type))
      if (a.start !== b.start) return a.start - b.start
      return a.end - b.end
    })

  const merged = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.type === interval.type && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

export function buildAlignmentCoverageAnnotations(alignments, side) {
  const safeAlignments = Array.isArray(alignments) ? alignments : []
  const sorted = [...safeAlignments].sort((a, b) => {
    const aStart = Number(a?.reference?.start ?? 0)
    const bStart = Number(b?.reference?.start ?? 0)
    if (aStart !== bStart) return aStart - bStart
    return Number(a?.alt?.start ?? 0) - Number(b?.alt?.start ?? 0)
  })

  const intervals = []
  for (const alignment of sorted) {
    const refStart = Number(alignment?.reference?.start ?? 0)
    const refLen = Math.max(1, Number(alignment?.reference?.length ?? 0))
    const altStart = Number(alignment?.alt?.start ?? 0)
    const altLen = Math.max(1, Number(alignment?.alt?.length ?? 0))
    const isInversion = String(alignment?.alt?.strand || 'forward') === 'reverse'
    const alignmentType = normalizeSequenceAnnotationType(alignment?.type)
    const start = side === 'reference' ? refStart : altStart
    const end = start + (side === 'reference' ? refLen : altLen)
    intervals.push({
      start,
      end,
      type: alignmentType !== 'no_match'
        ? alignmentType
        : (isInversion ? 'inverted_match' : 'match'),
    })
  }

  return intervals
}

export function buildDerivedGapAnnotations(alignments, side) {
  const safeAlignments = Array.isArray(alignments) ? alignments : []
  const sorted = [...safeAlignments].sort((a, b) => {
    const aStart = Number(a?.reference?.start ?? 0)
    const bStart = Number(b?.reference?.start ?? 0)
    if (aStart !== bStart) return aStart - bStart
    return Number(a?.alt?.start ?? 0) - Number(b?.alt?.start ?? 0)
  })

  const intervals = []

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const previous = sorted[i]
    const current = sorted[i + 1]

    const prevRefStart = Number(previous?.reference?.start ?? 0)
    const prevRefEnd = prevRefStart + Math.max(1, Number(previous?.reference?.length ?? 0))
    const currRefStart = Number(current?.reference?.start ?? 0)
    const refGap = Math.max(0, currRefStart - prevRefEnd)

    const prevAltStart = Number(previous?.alt?.start ?? 0)
    const prevAltEnd = prevAltStart + Math.max(1, Number(previous?.alt?.length ?? 0))
    const currAltStart = Number(current?.alt?.start ?? 0)
    const currAltEnd = currAltStart + Math.max(1, Number(current?.alt?.length ?? 0))
    const prevReverse = String(previous?.alt?.strand || 'forward') === 'reverse'
    const currReverse = String(current?.alt?.strand || 'forward') === 'reverse'

    if (prevReverse !== currReverse) continue

    const altGap = prevReverse
      ? Math.max(0, prevAltStart - currAltEnd)
      : Math.max(0, currAltStart - prevAltEnd)

    let type = ''
    if (refGap === 1 && altGap === 1) {
      type = 'snv'
    } else if ((altGap - refGap) >= 1) {
      type = 'insertion'
    } else if ((altGap - refGap) <= -1) {
      type = 'deletion'
    } else {
      continue
    }

    const normalizedType = normalizeSequenceAnnotationType(type)

    if (side === 'reference') {
      if (normalizedType === 'gain_or_insertion') {
        continue
      }
      if (refGap > 0) {
        intervals.push({ start: prevRefEnd, end: currRefStart, type: normalizedType })
      } else if (normalizedType === 'snv') {
        intervals.push({ start: prevRefEnd, end: prevRefEnd + 1, type: normalizedType })
      }
    } else {
      if (normalizedType === 'deletion_or_loss') {
        continue
      }
      if (altGap > 0) {
        if (prevReverse) {
          intervals.push({ start: currAltEnd, end: prevAltStart, type: normalizedType })
        } else {
          intervals.push({ start: prevAltEnd, end: currAltStart, type: normalizedType })
        }
      } else if (normalizedType === 'snv') {
        const anchor = prevReverse ? prevAltStart : prevAltEnd
        intervals.push({ start: anchor, end: anchor + 1, type: normalizedType })
      }
    }
  }

  return intervals
}

export function buildSequenceAnnotationIntervalsFromAlignments(fetchedAlignmentsRaw, fallbackAnnotationAlignments, side) {
  const fetchedAlignments = Array.isArray(fetchedAlignmentsRaw) ? fetchedAlignmentsRaw : []
  const fallbackAlignments = Array.isArray(fallbackAnnotationAlignments) ? fallbackAnnotationAlignments : []
  const usingFallbackAlignments = !fetchedAlignments.length && fallbackAlignments.length
  const alignments = fetchedAlignments.length ? fetchedAlignments : fallbackAlignments

  const coverageIntervals = buildAlignmentCoverageAnnotations(alignments, side)
  const variantIntervals = usingFallbackAlignments
    ? []
    : buildDerivedGapAnnotations(alignments, side)

  return mergeAnnotationIntervals([
    ...coverageIntervals,
    ...variantIntervals,
  ])
}

export function getSequenceBoxStyle(type, colors) {
  switch (type) {
    case 'match':
      return { fill: colors.sequenceMatch, stroke: colors.sequenceMatch, filled: true }
    case 'inverted_match':
      return { fill: colors.sequenceInversion, stroke: colors.sequenceInversion, filled: true }
    case 'deletion_or_loss':
      return { fill: colors.sequenceDeletion, stroke: colors.sequenceDeletion, filled: true }
    case 'gain_or_insertion':
      return { fill: colors.sequenceInsertion, stroke: colors.sequenceInsertion, filled: true }
    case 'snv':
      return { fill: colors.sequenceSnv, stroke: colors.sequenceSnv, filled: true }
    default:
      return { fill: 'transparent', stroke: colors.sequenceGapStroke, filled: false }
  }
}

export function pickSequenceAnnotationType(bp, annotationIntervals, annotationPriority) {
  let bestType = 'no_match'
  let bestPriority = annotationPriority.no_match
  for (const interval of annotationIntervals || []) {
    if (bp < interval.start || bp >= interval.end) continue
    const nextPriority = annotationPriority[interval.type] ?? 0
    if (nextPriority >= bestPriority) {
      bestPriority = nextPriority
      bestType = interval.type
    }
  }
  return bestType
}

export function fillSequenceTriangle(ctx, bxL, seqBoxT, bxW, seqBoxH, style, half) {
  if (!style?.filled) return
  const bxR = bxL + bxW
  const yB = seqBoxT + seqBoxH
  ctx.fillStyle = style.fill
  ctx.beginPath()
  if (half === 'top') {
    ctx.moveTo(bxL, seqBoxT)
    ctx.lineTo(bxR, seqBoxT)
    ctx.lineTo(bxL, yB)
  } else {
    ctx.moveTo(bxL, yB)
    ctx.lineTo(bxR, seqBoxT)
    ctx.lineTo(bxR, yB)
  }
  ctx.closePath()
  ctx.fill()
}

// ── Layout helpers ────────────────────────────────────────────────────────────

export function packEntriesIntoRows(entries, minGapBp) {
  if (!entries?.length) return { laidOutEntries: [], rowCount: 0 }
  const sorted = [...entries].sort((a, b) => {
    const as = Number(a?.transcript?.start ?? a?.gene?.start ?? 0)
    const bs = Number(b?.transcript?.start ?? b?.gene?.start ?? 0)
    if (as !== bs) return as - bs
    return Number(a?.transcript?.end ?? a?.gene?.end ?? 0) - Number(b?.transcript?.end ?? b?.gene?.end ?? 0)
  })
  const rowEnds = []
  const laidOutEntries = []
  for (const entry of sorted) {
    const start = Number(entry?.transcript?.start ?? entry?.gene?.start ?? 0)
    const end = Number(entry?.transcript?.end ?? entry?.gene?.end ?? start)
    let row = 0
    while (row < rowEnds.length && start < rowEnds[row] + minGapBp) row++
    rowEnds[row] = Math.max(rowEnds[row] || 0, end)
    laidOutEntries.push({ entry, row })
  }
  return { laidOutEntries, rowCount: Math.max(1, rowEnds.length || (entries.length ? 1 : 0)) }
}

export function buildSingleRowLayout(entries) {
  const laidOutEntries = (Array.isArray(entries) ? entries : []).map(entry => ({ entry, row: 0 }))
  return { laidOutEntries, rowCount: entries?.length ? 1 : 0 }
}

// ── Canvas draw helpers ───────────────────────────────────────────────────────

export function drawBand(ctx, y, h, pillText, resolvedGenomeColor, win, scaleX, colors, plotLeft, plotRight) {
  const pw = Math.max(92, String(pillText).length * 7.2 + 24)
  const px = plotLeft + 8
  const py = y + 6

  drawRuler(ctx, y + 4, h - 6, win, scaleX, colors, px + pw + 10, plotRight)

  ctx.fillStyle = resolvedGenomeColor
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(px, py, pw, 18, 9)
  } else {
    ctx.rect(px, py, pw, 18)
  }
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = sansFont(10, 600)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(pillText, plotLeft + 20, y + 18.5)
}

export function drawRuler(ctx, y, h, win, scaleX, colors, clipLeft, plotRight) {
  if (!win) return
  const rulerLeft = Math.max(clipLeft, PLOT_PAD_X)
  const rulerWidth = Math.max(0, plotRight - rulerLeft)
  if (rulerWidth < 4) return

  const span = Math.max(1, win.end - win.start)
  const rawStep = span / RULER_TICK_COUNT
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const step = Math.ceil(rawStep / mag) * mag
  const firstTick = Math.ceil(win.start / step) * step

  ctx.save()
  ctx.beginPath()
  ctx.rect(rulerLeft, y, rulerWidth, h)
  ctx.clip()

  ctx.strokeStyle = colors.rulerTick
  ctx.lineWidth = 1
  ctx.fillStyle = colors.rulerText
  ctx.font = sansFont(10)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  for (let pos = firstTick; pos <= win.end; pos += step) {
    const x = clamp(scaleX(pos), PLOT_PAD_X + 1, plotRight - 1)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y + 5)
    ctx.stroke()
    ctx.fillText(formatCoord(pos), x, y + h - 2)
  }
  ctx.restore()
}

export function drawTranscriptLane(ctx, opts) {
  const {
    laidOutEntries, segmentsMap, laneY, laneHeight, laneLabel,
    scaleX, colors, detailedMode, allowLabels,
    laneBackground, genomeColor, plotLeft, plotRight, contentLeft,
    rowPitch = ROW_PITCH,
    lanePaddingY = LANE_PADDING_Y,
    maxDisplayedRows = MAX_DISPLAYED_ROWS,
    rowContentY = ROW_CONTENT_Y,
  } = opts

  ctx.fillStyle = laneBackground
  ctx.fillRect(plotLeft, laneY, plotRight - plotLeft, laneHeight)
  ctx.fillStyle = colors.laneLabelBg
  ctx.fillRect(plotLeft, laneY, TRACK_LABEL_WIDTH, laneHeight)
  ctx.fillStyle = colors.laneLabelText
  ctx.font = sansFont(10, 600)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(laneLabel, plotLeft + 4, laneY + laneHeight / 2)

  ctx.save()
  ctx.beginPath()
  ctx.rect(contentLeft, laneY, Math.max(0, plotRight - contentLeft), laneHeight)
  ctx.clip()

  const displayEntries = []
  for (const { entry, row } of laidOutEntries) {
    if (row >= maxDisplayedRows) continue
    const tx = entry.transcript || {}
    // Coordinates are inclusive: the last base runs to the next position.
    const x1 = scaleX(tx.start)
    const x2 = scaleX(Number(tx.end) + 1)
    const txLeft = Math.min(x1, x2)
    const txRight = Math.max(x1, x2)
    if (txRight < contentLeft || txLeft > plotRight) continue
    const gene = entry.gene || {}
    const rowTop = laneY + lanePaddingY + row * rowPitch
    const midY = rowTop + (allowLabels ? rowContentY : 5)
    const halfH = EXON_HEIGHT / 2

    let codingRects = null
    let allSegRects = null
    let exonMaskRects = null
    if (detailedMode) {
      const segs = segmentsMap.get(entry) || []
      codingRects = []
      allSegRects = []
      for (const seg of segs) {
        const s1 = Math.min(scaleX(seg.start), scaleX(seg.end))
        const s2 = Math.max(scaleX(seg.start), scaleX(seg.end))
        if (s2 < contentLeft || s1 > plotRight) continue
        const sLeft = Math.max(contentLeft, s1)
        const sW = Math.max(0, Math.min(s2, plotRight) - sLeft)
        if (sW <= 0) continue
        allSegRects.push(sLeft, midY - halfH, sW)
        if (seg.coding) codingRects.push(sLeft, midY - halfH, sW)
      }
      if (Array.isArray(tx.exons)) {
        exonMaskRects = []
        for (const exon of tx.exons) {
          const ex1 = Math.min(scaleX(exon.start), scaleX(Number(exon.end) + 1))
          const ex2 = Math.max(scaleX(exon.start), scaleX(Number(exon.end) + 1))
          if (ex2 < contentLeft || ex1 > plotRight) continue
          const exLeft = Math.max(contentLeft, ex1)
          const exW = Math.max(0, Math.min(ex2, plotRight) - exLeft)
          if (exW > 0) exonMaskRects.push(exLeft, midY - halfH, exW)
        }
      }
    }

    displayEntries.push({
      tx, gene, row, rowTop, midY, txLeft, txRight,
      transcriptWidth: Math.max(1, txRight - txLeft),
      codingRects, allSegRects, exonMaskRects,
      labelText: gene.name || gene.id || tx.id || '',
    })
  }

  if (detailedMode) {
    ctx.strokeStyle = colors.intron
    ctx.lineWidth = 1.25
    ctx.beginPath()
    for (const { txLeft, txRight, midY } of displayEntries) {
      const iL = Math.max(contentLeft, txLeft)
      const iR = Math.min(plotRight + 1, txRight)
      if (iR > iL) { ctx.moveTo(iL, midY); ctx.lineTo(iR, midY) }
    }
    ctx.stroke()

    const sz = 3.6
    ctx.lineWidth = 1
    ctx.lineCap = 'round'
    ctx.strokeStyle = colors.chevron
    for (const fwd of [true, false]) {
      ctx.beginPath()
      for (const { tx, txLeft, txRight, midY } of displayEntries) {
        if ((String(tx.strand || '+') !== '-') !== fwd) continue
        const cL = Math.max(contentLeft, txLeft)
        const cR = Math.min(plotRight, txRight)
        if (cR <= cL + CHEVRON_SPACING_PX) continue
        const d = fwd ? sz : -sz
        for (let cx = cL + CHEVRON_SPACING_PX; cx < cR - 4; cx += CHEVRON_SPACING_PX) {
          ctx.moveTo(cx - d, midY - sz); ctx.lineTo(cx, midY); ctx.lineTo(cx - d, midY + sz)
        }
      }
      ctx.stroke()
    }
    ctx.lineCap = 'butt'

    ctx.fillStyle = laneBackground
    ctx.beginPath()
    for (const { exonMaskRects } of displayEntries) {
      if (!exonMaskRects) continue
      for (let i = 0; i < exonMaskRects.length; i += 3)
        ctx.rect(exonMaskRects[i], exonMaskRects[i + 1], exonMaskRects[i + 2], EXON_HEIGHT)
    }
    ctx.fill()

    ctx.globalAlpha = 0.95
    ctx.fillStyle = genomeColor
    ctx.beginPath()
    for (const { codingRects } of displayEntries) {
      if (!codingRects) continue
      for (let i = 0; i < codingRects.length; i += 3)
        ctx.rect(codingRects[i], codingRects[i + 1], codingRects[i + 2], EXON_HEIGHT)
    }
    ctx.fill()
    ctx.globalAlpha = 1

    ctx.strokeStyle = genomeColor
    ctx.lineWidth = 1.1
    ctx.beginPath()
    for (const { allSegRects } of displayEntries) {
      if (!allSegRects) continue
      for (let i = 0; i < allSegRects.length; i += 3)
        ctx.rect(allSegRects[i], allSegRects[i + 1], allSegRects[i + 2], EXON_HEIGHT)
    }
    ctx.stroke()

  } else {
    ctx.fillStyle = genomeColor
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    for (const { tx, midY, txLeft, txRight, transcriptWidth } of displayEntries) {
      const cL = Math.max(contentLeft, txLeft)
      const cR = Math.min(plotRight, txRight)
      if (transcriptWidth > SIMPLE_ARROW_MIN_WIDTH) {
        const rev = String(tx.strand || '+') === '-'
        if (rev) {
          ctx.moveTo(cL + 4, midY - 4); ctx.lineTo(cR, midY - 4)
          ctx.lineTo(cR, midY + 4); ctx.lineTo(cL + 4, midY + 4); ctx.lineTo(cL, midY)
        } else {
          ctx.moveTo(cL, midY - 4); ctx.lineTo(cR - 4, midY - 4)
          ctx.lineTo(cR, midY); ctx.lineTo(cR - 4, midY + 4); ctx.lineTo(cL, midY + 4)
        }
        ctx.closePath()
      } else {
        ctx.rect(cL, midY - 4, Math.max(1, cR - cL), 8)
      }
    }
    ctx.fill()
    ctx.globalAlpha = 1
  }

  if (allowLabels) {
    ctx.font = sansFont(9)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = colors.label
    const placedByRow = new Map()
    for (const de of displayEntries) {
      if (!de.labelText || de.transcriptWidth < LABEL_MIN_WIDTH_PX) continue
      const tw = ctx.measureText(de.labelText).width + 8
      const minCX = contentLeft + tw / 2 + 4
      const maxCX = plotRight - tw / 2 - 4
      if (maxCX <= minCX) continue
      const cx = clamp((de.txLeft + de.txRight) / 2, minCX, maxCX)
      const lL = cx - tw / 2; const lR = cx + tw / 2
      const rowIvs = placedByRow.get(de.row) || []
      if (rowIvs.some(iv => lL < iv.r && lR > iv.l)) continue
      rowIvs.push({ l: lL, r: lR })
      placedByRow.set(de.row, rowIvs)
      ctx.fillText(de.labelText, cx, de.rowTop + LABEL_ROW_HEIGHT)
    }
  }

  ctx.restore()
}

export function drawSequenceLane(ctx, { laneY, laneHeight, laneLabel, scaleX, colors, plotLeft, plotRight, contentLeft, sequence, seqRange, viewStart, viewEnd, plotWidth, annotationIntervals = [], comparisonAnnotationIntervals = [] }) {
  ctx.fillStyle = colors.sequenceBg
  ctx.fillRect(plotLeft, laneY, plotRight - plotLeft, laneHeight)
  ctx.fillStyle = colors.laneLabelBg
  ctx.fillRect(plotLeft, laneY, TRACK_LABEL_WIDTH, laneHeight)
  ctx.fillStyle = colors.laneLabelText
  ctx.font = sansFont(10, 600)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(laneLabel, plotLeft + 4, laneY + laneHeight / 2)

  if (!sequence || !seqRange || !plotWidth) return
  const span = Math.max(1, viewEnd - viewStart)
  const pxPerBp = plotWidth / span
  if (pxPerBp < 2) return

  const seqBoxT = Math.round(laneY + (laneHeight - 24) / 2)
  const seqBoxH = 24
  const annotationPriority = {
    no_match: 0,
    match: 1,
    inverted_match: 2,
    deletion_or_loss: 3,
    gain_or_insertion: 4,
    snv: 5,
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(contentLeft, laneY, Math.max(0, plotRight - contentLeft), laneHeight)
  ctx.clip()

  for (let i = 0; i < sequence.length; i++) {
    const base = sequence[i]
    if (!base) continue
    const bp = seqRange.start + i
    const bxL = scaleX(bp)
    const bxR = scaleX(bp + 1)
    const bxW = Math.max(1, bxR - bxL)
    if (bxR < contentLeft || bxL > plotRight) continue

    const bestType = pickSequenceAnnotationType(bp, annotationIntervals, annotationPriority)
    const comparisonType = comparisonAnnotationIntervals?.length
      ? pickSequenceAnnotationType(bp, comparisonAnnotationIntervals, annotationPriority)
      : bestType

    const boxStyle = getSequenceBoxStyle(bestType, colors)
    const comparisonBoxStyle = getSequenceBoxStyle(comparisonType, colors)
    const isSplit = comparisonAnnotationIntervals?.length && comparisonType !== bestType
    if (isSplit) {
      fillSequenceTriangle(ctx, bxL, seqBoxT, bxW, seqBoxH, boxStyle, 'top')
      fillSequenceTriangle(ctx, bxL, seqBoxT, bxW, seqBoxH, comparisonBoxStyle, 'bottom')
      if (!boxStyle.filled || !comparisonBoxStyle.filled) {
        ctx.strokeStyle = colors.sequenceGapStroke
        ctx.lineWidth = 1
        ctx.strokeRect(bxL + 0.5, seqBoxT + 0.5, Math.max(0, bxW - 1), seqBoxH - 1)
      }
      ctx.strokeStyle = colors.baseSep
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(bxL + 0.5, seqBoxT + seqBoxH - 0.5)
      ctx.lineTo(bxL + bxW - 0.5, seqBoxT + 0.5)
      ctx.stroke()
    } else if (boxStyle.filled) {
      ctx.fillStyle = boxStyle.fill
      ctx.fillRect(bxL, seqBoxT, bxW, seqBoxH)
    } else {
      ctx.strokeStyle = boxStyle.stroke
      ctx.lineWidth = 1
      ctx.strokeRect(bxL + 0.5, seqBoxT + 0.5, Math.max(0, bxW - 1), seqBoxH - 1)
    }

    if (pxPerBp >= 6 && bxW >= 2) {
      ctx.strokeStyle = colors.baseSep
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(bxR - 0.5, seqBoxT + 0.5)
      ctx.lineTo(bxR - 0.5, seqBoxT + seqBoxH - 0.5)
      ctx.stroke()
    }

    if (pxPerBp >= 10) {
      ctx.fillStyle = (boxStyle.filled || comparisonBoxStyle.filled) ? colors.sequenceFilledText : colors.sequenceGapText
      ctx.font = pxPerBp >= 14 ? monoFont(12) : monoFont(9)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(base.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
    }
  }

  ctx.restore()
}

// Matches the genome browser's sidebar toggles: a bare stroked glyph that takes
// the genome's colour when the track is on, rather than a filled disc.
export function drawToggleButton(ctx, x, y, isHidden, activeColor, isLight) {
  const active = !isHidden
  const iconColor = active ? activeColor : (isLight ? '#94a3b8' : '#6b7280')
  if (drawPowerGlyph(ctx, x, y, { size: TOGGLE_ICON_SIZE, color: iconColor })) return

  // Fallback where Path2D is unavailable.
  ctx.strokeStyle = iconColor
  ctx.lineWidth = 1.8
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(x, y + 1.2, (TOGGLE_ICON_SIZE / 2) - 1.7, -Math.PI * 0.34, Math.PI * 1.34)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x, y - 7.4)
  ctx.lineTo(x, y - 1.3)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

export function drawHiddenLane(ctx, { laneY, laneHeight, laneLabel, laneBackground, colors, plotLeft, plotRight }) {
  ctx.fillStyle = laneBackground
  ctx.fillRect(plotLeft, laneY, plotRight - plotLeft, laneHeight)
  ctx.fillStyle = colors.laneLabelBg
  ctx.fillRect(plotLeft, laneY, TRACK_LABEL_WIDTH, laneHeight)
  ctx.fillStyle = colors.laneLabelText
  ctx.font = sansFont(10, 600)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(laneLabel, plotLeft + 4, laneY + laneHeight / 2)
}

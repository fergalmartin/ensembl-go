import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { buildTranscriptSegments } from './featureExplorerTranscriptGeometry'
import { API_BASE } from '../backendRuntime'
import iconPowerRaw from '../assets/icons/icon_power.svg?raw'

const PLOT_PAD_X = 2
const BAND_HEIGHT = 30
const TRACK_LABEL_WIDTH = 50   // wide enough for 2-char label + toggle circle
const LANE_PADDING_Y = 6
const ROW_PITCH = 24
const EXON_HEIGHT = 8
const RULER_TICK_COUNT = 6
const DETAILED_LAYOUT_MAX_SPAN = 200_000
const LABEL_MIN_WIDTH_PX = 54
const SIMPLE_ARROW_MIN_WIDTH = 15
const LABEL_ROW_HEIGHT = 10
const ROW_CONTENT_Y = LABEL_ROW_HEIGHT + 6 + (EXON_HEIGHT / 2)
const LAYOUT_GAP_BP = 1000
const MAX_DISPLAYED_ROWS = 10
const CHEVRON_SPACING_PX = 18
const SEQ_TRACK_HEIGHT = 36
const TOGGLE_RADIUS = 11
const SEQ_FETCH_THRESHOLD = 1000
const PLACEHOLDER_H = 22
const SEQUENCE_ANNOTATION_FETCH_THRESHOLD = 2000
const SEQUENCE_ANNOTATION_DEBOUNCE_MS = 120

// ── Power icon (shared Path2D) ────────────────────────────────────────────────

const _extractPathData = (svgRaw) => {
  if (typeof svgRaw !== 'string') return ''
  const m = svgRaw.match(/<path[^>]*\sd=(['"])(.*?)\1/i)
  return m?.[2] || ''
}
const POWER_ICON_PATH_D = _extractPathData(iconPowerRaw)
let _powerIconPath = null
function getPowerIconPath() {
  if (!_powerIconPath && POWER_ICON_PATH_D) _powerIconPath = new Path2D(POWER_ICON_PATH_D)
  return _powerIconPath
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function formatCoord(v) { return Number(v || 0).toLocaleString() }

function getLaneColors(isLight) {
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

function buildViewportParam(window) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return ''
  return `${window.chrom}:${window.start}-${window.end}`
}

function expandViewportWindow(window, minPad = 0) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return null
  const span = Math.max(1, Number(window.end) - Number(window.start))
  const pad = Math.max(minPad, span)
  return {
    chrom: window.chrom,
    start: Math.max(1, Number(window.start) - pad),
    end: Number(window.end) + pad,
  }
}

function normalizeSequenceAnnotationType(type) {
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

function mergeAnnotationIntervals(intervals = []) {
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

function buildAlignmentCoverageAnnotations(alignments, side) {
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

function buildDerivedGapAnnotations(alignments, side) {
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

function buildSequenceAnnotationIntervalsFromAlignments(fetchedAlignmentsRaw, fallbackAnnotationAlignments, side) {
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

function getSequenceBoxStyle(type, colors) {
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

function pickSequenceAnnotationType(bp, annotationIntervals, annotationPriority) {
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

function fillSequenceTriangle(ctx, bxL, seqBoxT, bxW, seqBoxH, style, half) {
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

function packEntriesIntoRows(entries, minGapBp) {
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

function buildSingleRowLayout(entries) {
  const laidOutEntries = (Array.isArray(entries) ? entries : []).map(entry => ({ entry, row: 0 }))
  return { laidOutEntries, rowCount: entries?.length ? 1 : 0 }
}

// ── Canvas draw helpers ───────────────────────────────────────────────────────

function drawBand(ctx, y, h, pillText, resolvedGenomeColor, win, scaleX, colors, plotLeft, plotRight) {
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
  ctx.font = '600 10px system-ui,sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(pillText, plotLeft + 20, y + 18.5)
}

function drawRuler(ctx, y, h, win, scaleX, colors, clipLeft, plotRight) {
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
  ctx.font = '10px system-ui,sans-serif'
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

function drawTranscriptLane(ctx, opts) {
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
  ctx.font = '600 10px system-ui,sans-serif'
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
    const x1 = scaleX(tx.start)
    const x2 = scaleX(tx.end)
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
          const ex1 = Math.min(scaleX(exon.start), scaleX(exon.end))
          const ex2 = Math.max(scaleX(exon.start), scaleX(exon.end))
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
    ctx.font = '9px system-ui,sans-serif'
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

function drawSequenceLane(ctx, { laneY, laneHeight, laneLabel, scaleX, colors, plotLeft, plotRight, contentLeft, sequence, seqRange, viewStart, viewEnd, plotWidth, annotationIntervals = [], comparisonAnnotationIntervals = [] }) {
  ctx.fillStyle = colors.sequenceBg
  ctx.fillRect(plotLeft, laneY, plotRight - plotLeft, laneHeight)
  ctx.fillStyle = colors.laneLabelBg
  ctx.fillRect(plotLeft, laneY, TRACK_LABEL_WIDTH, laneHeight)
  ctx.fillStyle = colors.laneLabelText
  ctx.font = '600 10px system-ui,sans-serif'
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
      ctx.font = pxPerBp >= 14 ? '12px monospace' : '9px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(base.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
    }
  }

  ctx.restore()
}

function drawToggleButton(ctx, x, y, isHidden, activeColor, isLight) {
  const active = !isHidden
  const iconColor = active ? '#ffffff' : (isLight ? '#475569' : '#e2e8f0')
  ctx.fillStyle = active ? activeColor : (isLight ? '#cbd5e1' : '#334155')
  ctx.beginPath()
  ctx.arc(x, y, TOGGLE_RADIUS, 0, 2 * Math.PI)
  ctx.fill()

  const powerPath = getPowerIconPath()
  if (powerPath) {
    const iconSize = 18
    ctx.save()
    ctx.translate(Math.round(x - iconSize / 2), Math.round(y - iconSize / 2))
    ctx.scale(iconSize / 32, iconSize / 32)
    ctx.fillStyle = iconColor
    ctx.fill(powerPath)
    ctx.restore()
    return
  }
  // Fallback ring+stem
  ctx.strokeStyle = iconColor
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(x, y + 0.6, 5.8, Math.PI * 0.2, Math.PI * 1.8)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x, y - 7.4)
  ctx.lineTo(x, y - 1.3)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

function drawHiddenLane(ctx, { laneY, laneHeight, laneLabel, laneBackground, colors, plotLeft, plotRight }) {
  ctx.fillStyle = laneBackground
  ctx.fillRect(plotLeft, laneY, plotRight - plotLeft, laneHeight)
  ctx.fillStyle = colors.laneLabelBg
  ctx.fillRect(plotLeft, laneY, TRACK_LABEL_WIDTH, laneHeight)
  ctx.fillStyle = colors.laneLabelText
  ctx.font = '600 10px system-ui,sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(laneLabel, plotLeft + 4, laneY + laneHeight / 2)
}

// ── Component ─────────────────────────────────────────────────────────────────

function StructuralVariationFeatureBand({
  theme = 'dark',
  position = 'top',
  width = 760,
  label = '',
  pillLabel = '',
  pillColor = '',
  window = null,
  entries = [],
  loading = false,
  genomeId = '',
  sequenceGenomeId = '',
  hideInactiveTracks = false,
  sequenceSide = 'reference',
  referenceWindow = null,
  altWindow = null,
  referenceGenomeId = '',
  altGenomeId = '',
  referenceBrowseGenomeId = 'reference',
  altBrowseGenomeId = 'target',
  annotationAlignments = null,
  comparisonAltWindow = null,
  comparisonAltGenomeId = '',
  comparisonAnnotationAlignments = null,
  compact = false,
}) {
  const canvasRef = useRef(null)
  const toggleHitAreasRef = useRef([])
  const suppressClickRef = useRef(false)
  const seqBufferRef = useRef({ genomeId: '', chrom: '', start: 0, end: 0, sequence: '' })
  const [transcriptSegmentsCache] = useState(() => new WeakMap())
  const unavailableSequenceRef = useRef(new Set())
  const sequenceAnnotationAbortRef = useRef(null)
  const sequenceAnnotationTimerRef = useRef(null)
  const sequenceAnnotationCacheRef = useRef({ key: '', intervals: [] })
  const comparisonAnnotationAbortRef = useRef(null)
  const comparisonAnnotationTimerRef = useRef(null)
  const comparisonAnnotationCacheRef = useRef({ key: '', intervals: [] })

  const [hiddenTracks, setHiddenTracks] = useState({ gf: false, gr: false, sl: false })
  const [sequence, setSequence] = useState(null)
  const [seqRange, setSeqRange] = useState(null)
  const [sequenceAnnotationIntervals, setSequenceAnnotationIntervals] = useState([])
  const [comparisonAnnotationIntervals, setComparisonAnnotationIntervals] = useState([])

  const isLight = theme === 'light'
  const safeWidth = Math.max(760, Math.round(width || 0))
  const resolvedGenomeColor = pillColor || (isLight ? '#3366cc' : '#5b8def')
  const resolvedSequenceGenomeId = String(sequenceGenomeId || genomeId || '').trim()
  const viewSpan = Math.max(1, Number(window?.end || 0) - Number(window?.start || 0))
  const detailedMode = viewSpan <= DETAILED_LAYOUT_MAX_SPAN
  const density = compact
    ? {
        maxRows: 3,
        rowPitch: 17,
        lanePaddingY: 3,
        minLaneHeight: 18,
        sequenceTrackHeight: 28,
        placeholderHeight: 16,
        rowContentY: 14,
        allowLabels: false,
      }
    : {
        maxRows: MAX_DISPLAYED_ROWS,
        rowPitch: ROW_PITCH,
        lanePaddingY: LANE_PADDING_Y,
        minLaneHeight: 22,
        sequenceTrackHeight: SEQ_TRACK_HEIGHT,
        placeholderHeight: PLACEHOLDER_H,
        rowContentY: ROW_CONTENT_Y,
        allowLabels: detailedMode,
      }

  const entryWindowIndex = useMemo(() => {
    const indexed = (Array.isArray(entries) ? entries : []).map((entry, originalIndex) => {
      const start = Number(entry?.transcript?.start ?? entry?.gene?.start ?? 0)
      const end = Number(entry?.transcript?.end ?? entry?.gene?.end ?? start)
      return { entry, originalIndex, start, end }
    }).sort((a, b) => (a.start - b.start) || (a.end - b.end) || (a.originalIndex - b.originalIndex))
    const prefixMaxEnds = new Float64Array(indexed.length)
    let maxEnd = -Infinity
    for (let index = 0; index < indexed.length; index += 1) {
      maxEnd = Math.max(maxEnd, indexed[index].end)
      prefixMaxEnds[index] = maxEnd
    }
    return { indexed, prefixMaxEnds }
  }, [entries])

  const layout = useMemo(() => {
    const safe = Array.isArray(entries) ? entries : []
    const wStart = Number(window?.start ?? 0)
    const wEnd = Number(window?.end ?? 0)
    const span = Math.max(1, wEnd - wStart)
    const filterStart = wStart - span
    const filterEnd = wEnd + span
    let relevant = safe
    if (!(wStart === 0 && wEnd === 0) && entryWindowIndex.indexed.length) {
      let lower = 0
      let upper = entryWindowIndex.indexed.length
      while (lower < upper) {
        const mid = Math.floor((lower + upper) / 2)
        if (entryWindowIndex.prefixMaxEnds[mid] < filterStart) lower = mid + 1
        else upper = mid
      }
      const firstCandidate = lower
      lower = 0
      upper = entryWindowIndex.indexed.length
      while (lower < upper) {
        const mid = Math.floor((lower + upper) / 2)
        if (entryWindowIndex.indexed[mid].start <= filterEnd) lower = mid + 1
        else upper = mid
      }
      relevant = entryWindowIndex.indexed
        .slice(firstCandidate, lower)
        .filter(item => item.end >= filterStart)
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map(item => item.entry)
    }
    const fwdEntries = relevant.filter(e => String(e?.transcript?.strand || '+') === '+')
    const revEntries = relevant.filter(e => String(e?.transcript?.strand || '+') === '-')
    const fwdLayout = detailedMode ? packEntriesIntoRows(fwdEntries, LAYOUT_GAP_BP) : buildSingleRowLayout(fwdEntries)
    const revLayout = detailedMode ? packEntriesIntoRows(revEntries, LAYOUT_GAP_BP) : buildSingleRowLayout(revEntries)
    return { fwdLayout, revLayout, relevant }
  }, [entries, entryWindowIndex, detailedMode, window])

  const segmentsMap = useMemo(() => {
    const map = new WeakMap()
    for (const entry of layout.relevant) {
      if (!detailedMode) {
        map.set(entry, [])
        continue
      }
      let segments = transcriptSegmentsCache.get(entry)
      if (!segments) {
        segments = buildTranscriptSegments(entry.transcript || {})
        transcriptSegmentsCache.set(entry, segments)
      }
      map.set(entry, segments)
    }
    return map
  }, [layout.relevant, detailedMode, transcriptSegmentsCache])

  const fwdLaneH = Math.max(
    density.minLaneHeight,
    density.lanePaddingY * 2 + Math.min(density.maxRows, Math.max(1, layout.fwdLayout.rowCount)) * density.rowPitch,
  )
  const revLaneH = Math.max(
    density.minLaneHeight,
    density.lanePaddingY * 2 + Math.min(density.maxRows, Math.max(1, layout.revLayout.rowCount)) * density.rowPitch,
  )
  const slLaneH = density.sequenceTrackHeight

  const effectiveFwdH = hiddenTracks.gf ? (hideInactiveTracks ? 0 : density.placeholderHeight) : fwdLaneH
  const effectiveRevH = hiddenTracks.gr ? (hideInactiveTracks ? 0 : density.placeholderHeight) : revLaneH
  const effectiveSlH  = slLaneH > 0
    ? (hiddenTracks.sl ? (hideInactiveTracks ? 0 : density.placeholderHeight) : slLaneH)
    : 0

  const totalHeight = effectiveFwdH + effectiveRevH + effectiveSlH + BAND_HEIGHT

  // ── Sequence fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!window?.chrom || !resolvedSequenceGenomeId || viewSpan > SEQ_FETCH_THRESHOLD) {
      setSequence(null)
      setSeqRange(null)
      return
    }
    const unavailableGenomeKey = `${resolvedSequenceGenomeId}|*`
    const unavailableKey = `${resolvedSequenceGenomeId}|${window.chrom}`
    if (unavailableSequenceRef.current.has(unavailableGenomeKey) || unavailableSequenceRef.current.has(unavailableKey)) {
      setSequence(null)
      setSeqRange(null)
      return
    }
    const viewStart = window.start
    const viewEnd   = window.end
    const buf = seqBufferRef.current
    if (buf.genomeId === resolvedSequenceGenomeId && buf.chrom === window.chrom && buf.start <= viewStart && buf.end >= viewEnd && buf.sequence) {
      const offset = viewStart - buf.start
      const len    = viewEnd - viewStart + 1
      setSequence(buf.sequence.slice(offset, offset + len))
      setSeqRange((prev) => (
        prev?.start === viewStart && prev?.end === viewEnd ? prev : { start: viewStart, end: viewEnd }
      ))
      return
    }
    const pad        = Math.max(500, viewSpan)
    const fetchStart = Math.max(1, viewStart - pad)
    const fetchEnd   = viewEnd + pad
    let cancelled    = false
    fetch(`${API_BASE}/api/browse/sequence?genome=${encodeURIComponent(resolvedSequenceGenomeId)}&chrom=${encodeURIComponent(window.chrom)}&start=${fetchStart}&end=${fetchEnd}`)
      .then(async r => {
        if (r.ok) return r.json()
        let detail = ''
        try {
          const errorPayload = await r.json()
          detail = String(errorPayload?.detail || '')
        } catch {
          detail = ''
        }
        if (r.status === 404) {
          unavailableSequenceRef.current.add(unavailableKey)
          if (/FASTA/i.test(detail)) {
            unavailableSequenceRef.current.add(unavailableGenomeKey)
          }
        }
        return null
      })
      .then(data => {
        if (cancelled || !data?.sequence) return
        seqBufferRef.current = { genomeId: resolvedSequenceGenomeId, chrom: window.chrom, start: fetchStart, end: fetchEnd, sequence: data.sequence }
        const offset = viewStart - fetchStart
        const len    = viewEnd - viewStart + 1
        setSequence(data.sequence.slice(offset, offset + len))
        setSeqRange((prev) => (
          prev?.start === viewStart && prev?.end === viewEnd ? prev : { start: viewStart, end: viewEnd }
        ))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [window?.chrom, window?.start, window?.end, resolvedSequenceGenomeId, viewSpan])

  useEffect(() => {
    const sideWindow = sequenceSide === 'target'
      ? (altWindow || window)
      : (referenceWindow || window)
    const expandedSideWindow = expandViewportWindow(sideWindow, 200)
    const expandedReferenceWindow = expandViewportWindow(referenceWindow, 200)
    const expandedAltWindow = expandViewportWindow(altWindow, 200)

    if (
      !window?.chrom ||
      !expandedSideWindow?.chrom ||
      !referenceGenomeId ||
      !altGenomeId ||
      viewSpan > SEQUENCE_ANNOTATION_FETCH_THRESHOLD
    ) {
      setSequenceAnnotationIntervals((prev) => (prev.length ? [] : prev))
      if (sequenceAnnotationTimerRef.current) {
        clearTimeout(sequenceAnnotationTimerRef.current)
        sequenceAnnotationTimerRef.current = null
      }
      sequenceAnnotationAbortRef.current?.abort?.()
      sequenceAnnotationAbortRef.current = null
      return
    }

    const fallbackAnnotationAlignments = Array.isArray(annotationAlignments) ? annotationAlignments : []

    const params = new URLSearchParams({
      reference_genome_id: referenceGenomeId,
      alt_genome_id: altGenomeId,
      query_side: sequenceSide === 'target' ? 'alt' : 'reference',
    })

    if (sequenceSide === 'target') {
      params.set('alt_viewport', buildViewportParam(expandedSideWindow))
      if (expandedReferenceWindow?.chrom) {
        params.set('reference_viewport', buildViewportParam(expandedReferenceWindow))
      }
    } else {
      params.set('reference_viewport', buildViewportParam(expandedSideWindow))
      if (expandedAltWindow?.chrom) {
        params.set('alt_viewport', buildViewportParam(expandedAltWindow))
      }
    }

    const annotationKey = `${sequenceSide}|${params.toString()}`
    const cachedAnnotation = sequenceAnnotationCacheRef.current
    if (cachedAnnotation?.key === annotationKey) {
      setSequenceAnnotationIntervals(cachedAnnotation.intervals)
      return
    }

    if (sequenceAnnotationTimerRef.current) {
      clearTimeout(sequenceAnnotationTimerRef.current)
      sequenceAnnotationTimerRef.current = null
    }
    sequenceAnnotationAbortRef.current?.abort?.()

    sequenceAnnotationTimerRef.current = setTimeout(() => {
      sequenceAnnotationTimerRef.current = null
      const abortController = new AbortController()
      sequenceAnnotationAbortRef.current = abortController

      fetch(`${API_BASE}/api/sv/alignments?${params.toString()}`, {
        signal: abortController.signal,
      })
      .then((response) => response.ok ? response.json() : [])
      .then((fetchedAlignmentsRaw) => {
        if (abortController.signal.aborted) return

        const intervals = buildSequenceAnnotationIntervalsFromAlignments(
          fetchedAlignmentsRaw,
          fallbackAnnotationAlignments,
          sequenceSide === 'target' ? 'target' : 'reference',
        )
        sequenceAnnotationCacheRef.current = { key: annotationKey, intervals }
        setSequenceAnnotationIntervals(intervals)
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setSequenceAnnotationIntervals((prev) => (prev.length ? [] : prev))
      })
      .finally(() => {
        if (sequenceAnnotationAbortRef.current === abortController) {
          sequenceAnnotationAbortRef.current = null
        }
      })
    }, SEQUENCE_ANNOTATION_DEBOUNCE_MS)

    return () => {
      if (sequenceAnnotationTimerRef.current) {
        clearTimeout(sequenceAnnotationTimerRef.current)
        sequenceAnnotationTimerRef.current = null
      }
      sequenceAnnotationAbortRef.current?.abort?.()
      sequenceAnnotationAbortRef.current = null
    }
  }, [
    window?.chrom,
    window?.start,
    window?.end,
    referenceGenomeId,
    altGenomeId,
    referenceBrowseGenomeId,
    altBrowseGenomeId,
    sequenceSide,
    viewSpan,
    referenceWindow?.chrom,
    referenceWindow?.start,
    referenceWindow?.end,
    altWindow?.chrom,
    altWindow?.start,
    altWindow?.end,
    annotationAlignments,
  ])

  useEffect(() => {
    const sideWindow = referenceWindow || window
    const expandedSideWindow = expandViewportWindow(sideWindow, 200)
    const expandedComparisonAltWindow = expandViewportWindow(comparisonAltWindow, 200)

    if (
      sequenceSide !== 'reference' ||
      !window?.chrom ||
      !expandedSideWindow?.chrom ||
      !referenceGenomeId ||
      !comparisonAltGenomeId ||
      !expandedComparisonAltWindow?.chrom ||
      viewSpan > SEQUENCE_ANNOTATION_FETCH_THRESHOLD
    ) {
      setComparisonAnnotationIntervals((prev) => (prev.length ? [] : prev))
      if (comparisonAnnotationTimerRef.current) {
        clearTimeout(comparisonAnnotationTimerRef.current)
        comparisonAnnotationTimerRef.current = null
      }
      comparisonAnnotationAbortRef.current?.abort?.()
      comparisonAnnotationAbortRef.current = null
      return
    }

    const fallbackComparisonAlignments = Array.isArray(comparisonAnnotationAlignments)
      ? comparisonAnnotationAlignments
      : []
    const params = new URLSearchParams({
      reference_genome_id: referenceGenomeId,
      alt_genome_id: comparisonAltGenomeId,
      query_side: 'reference',
    })
    params.set('reference_viewport', buildViewportParam(expandedSideWindow))
    params.set('alt_viewport', buildViewportParam(expandedComparisonAltWindow))

    const annotationKey = `comparison|reference|${params.toString()}`
    const cachedAnnotation = comparisonAnnotationCacheRef.current
    if (cachedAnnotation?.key === annotationKey) {
      setComparisonAnnotationIntervals(cachedAnnotation.intervals)
      return
    }

    if (comparisonAnnotationTimerRef.current) {
      clearTimeout(comparisonAnnotationTimerRef.current)
      comparisonAnnotationTimerRef.current = null
    }
    comparisonAnnotationAbortRef.current?.abort?.()

    comparisonAnnotationTimerRef.current = setTimeout(() => {
      comparisonAnnotationTimerRef.current = null
      const abortController = new AbortController()
      comparisonAnnotationAbortRef.current = abortController

      fetch(`${API_BASE}/api/sv/alignments?${params.toString()}`, {
        signal: abortController.signal,
      })
      .then((response) => response.ok ? response.json() : [])
      .then((fetchedAlignmentsRaw) => {
        if (abortController.signal.aborted) return
        const intervals = buildSequenceAnnotationIntervalsFromAlignments(
          fetchedAlignmentsRaw,
          fallbackComparisonAlignments,
          'reference',
        )
        comparisonAnnotationCacheRef.current = { key: annotationKey, intervals }
        setComparisonAnnotationIntervals(intervals)
      })
      .catch(() => {
        if (abortController.signal.aborted) return
        setComparisonAnnotationIntervals((prev) => (prev.length ? [] : prev))
      })
      .finally(() => {
        if (comparisonAnnotationAbortRef.current === abortController) {
          comparisonAnnotationAbortRef.current = null
        }
      })
    }, SEQUENCE_ANNOTATION_DEBOUNCE_MS)

    return () => {
      if (comparisonAnnotationTimerRef.current) {
        clearTimeout(comparisonAnnotationTimerRef.current)
        comparisonAnnotationTimerRef.current = null
      }
      comparisonAnnotationAbortRef.current?.abort?.()
      comparisonAnnotationAbortRef.current = null
    }
  }, [
    window?.chrom,
    window?.start,
    window?.end,
    referenceGenomeId,
    comparisonAltGenomeId,
    sequenceSide,
    viewSpan,
    referenceWindow?.chrom,
    referenceWindow?.start,
    referenceWindow?.end,
    comparisonAltWindow?.chrom,
    comparisonAltWindow?.start,
    comparisonAltWindow?.end,
    comparisonAnnotationAlignments,
  ])

  const getToggleHit = useCallback((event) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = safeWidth / Math.max(1, rect.width)
    const x = (event.clientX - rect.left) * scaleX
    const y = event.clientY - rect.top
    for (const hit of toggleHitAreasRef.current) {
      const dx = x - hit.x
      const dy = y - hit.y
      if (dx * dx + dy * dy <= hit.r * hit.r) return hit
    }
    return null
  }, [safeWidth])

  const handleCanvasPointerDown = useCallback((event) => {
    const hit = getToggleHit(event)
    if (!hit) return
    suppressClickRef.current = true
    event.preventDefault()
    event.stopPropagation()
    setHiddenTracks(prev => ({ ...prev, [hit.key]: !prev[hit.key] }))
  }, [getToggleHit])

  // ── Toggle click handler ───────────────────────────────────────────────────
  const handleCanvasClick = useCallback((event) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const hit = getToggleHit(event)
    if (hit) {
      setHiddenTracks(prev => ({ ...prev, [hit.key]: !prev[hit.key] }))
      return
    }
  }, [getToggleHit])

  // ── Canvas draw ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr   = globalThis.devicePixelRatio || 1
    const physW = Math.round(safeWidth * dpr)
    const physH = Math.round(totalHeight * dpr)
    if (canvas.width !== physW || canvas.height !== physH) {
      canvas.width  = physW
      canvas.height = physH
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, safeWidth, totalHeight)

    const plotLeft   = PLOT_PAD_X
    const plotRight  = Math.max(plotLeft + 400, safeWidth - PLOT_PAD_X)
    const plotWidth  = Math.max(1, plotRight - plotLeft)
    const contentLeft = plotLeft + TRACK_LABEL_WIDTH + 2
    const colors     = getLaneColors(isLight)
    const toggleX    = plotLeft + TRACK_LABEL_WIDTH - TOGGLE_RADIUS - 2

    if (!window) return

    const span   = Math.max(1, window.end - window.start)
    const scaleX = (pos) => plotLeft + ((pos - window.start) / span) * plotWidth

    const sections = position === 'bottom'
      ? [
          { type: 'gf',    height: effectiveFwdH  },
          { type: 'gr',    height: effectiveRevH  },
          { type: 'sl',    height: effectiveSlH   },
          { type: 'band',  height: BAND_HEIGHT    },
        ]
      : [
          { type: 'band',  height: BAND_HEIGHT    },
          { type: 'gf',    height: effectiveFwdH  },
          { type: 'gr',    height: effectiveRevH  },
          { type: 'sl',    height: effectiveSlH   },
        ]

    const togglePositions = []
    let cursorY = 0

    for (const section of sections) {
      const y = cursorY
      cursorY += section.height
      if (section.height === 0) continue

      if (section.type === 'band') {
        drawBand(ctx, y, section.height, pillLabel || label, resolvedGenomeColor, window, scaleX, colors, plotLeft, plotRight)

      } else if (section.type === 'gf') {
        if (hiddenTracks.gf) {
          drawHiddenLane(ctx, {
            laneY: y,
            laneHeight: section.height,
            laneLabel: 'GF',
            laneBackground: colors.forwardLaneBg,
            colors,
            plotLeft,
            plotRight,
          })
        } else {
          drawTranscriptLane(ctx, {
            laidOutEntries: layout.fwdLayout.laidOutEntries,
            segmentsMap,
            laneY: y, laneHeight: section.height, laneLabel: 'GF',
            scaleX, colors, detailedMode, allowLabels: density.allowLabels,
            laneBackground: colors.forwardLaneBg, genomeColor: resolvedGenomeColor,
            plotLeft, plotRight, contentLeft,
            rowPitch: density.rowPitch,
            lanePaddingY: density.lanePaddingY,
            maxDisplayedRows: density.maxRows,
            rowContentY: density.rowContentY,
          })
        }
        togglePositions.push({ key: 'gf', x: toggleX, y: y + section.height / 2, r: TOGGLE_RADIUS })

      } else if (section.type === 'gr') {
        if (hiddenTracks.gr) {
          drawHiddenLane(ctx, {
            laneY: y,
            laneHeight: section.height,
            laneLabel: 'GR',
            laneBackground: colors.reverseLaneBg,
            colors,
            plotLeft,
            plotRight,
          })
        } else {
          drawTranscriptLane(ctx, {
            laidOutEntries: layout.revLayout.laidOutEntries,
            segmentsMap,
            laneY: y, laneHeight: section.height, laneLabel: 'GR',
            scaleX, colors, detailedMode, allowLabels: density.allowLabels,
            laneBackground: colors.reverseLaneBg, genomeColor: resolvedGenomeColor,
            plotLeft, plotRight, contentLeft,
            rowPitch: density.rowPitch,
            lanePaddingY: density.lanePaddingY,
            maxDisplayedRows: density.maxRows,
            rowContentY: density.rowContentY,
          })
        }
        togglePositions.push({ key: 'gr', x: toggleX, y: y + section.height / 2, r: TOGGLE_RADIUS })

      } else if (section.type === 'sl') {
        if (hiddenTracks.sl) {
          drawHiddenLane(ctx, {
            laneY: y,
            laneHeight: section.height,
            laneLabel: 'SL',
            laneBackground: colors.sequenceBg,
            colors,
            plotLeft,
            plotRight,
          })
        } else {
          drawSequenceLane(ctx, {
            laneY: y, laneHeight: section.height, laneLabel: 'SL',
            scaleX, colors, plotLeft, plotRight, contentLeft,
            sequence, seqRange,
            viewStart: window.start, viewEnd: window.end, plotWidth,
            annotationIntervals: sequenceAnnotationIntervals,
            comparisonAnnotationIntervals,
          })
        }
        togglePositions.push({ key: 'sl', x: toggleX, y: y + section.height / 2, r: TOGGLE_RADIUS })
      }
    }

    // Draw toggle buttons on top of all lane label areas
    for (const { key, x, y } of togglePositions) {
      drawToggleButton(ctx, x, y, hiddenTracks[key], resolvedGenomeColor, isLight)
    }
    toggleHitAreasRef.current = togglePositions

  }, [window, layout, segmentsMap, isLight, safeWidth, totalHeight, pillLabel, pillColor, label,
      position, resolvedGenomeColor, detailedMode, hiddenTracks, sequence, seqRange, sequenceAnnotationIntervals, comparisonAnnotationIntervals,
      effectiveFwdH, effectiveRevH, effectiveSlH, density])

  return (
    <div
      className="relative w-full"
      data-sv-feature-band={position}
      data-sv-feature-genome={genomeId}
      data-sv-sequence-genome={resolvedSequenceGenomeId}
      data-sv-feature-chrom={window?.chrom || ''}
      data-sv-feature-start={window?.start ?? ''}
      data-sv-feature-end={window?.end ?? ''}
      data-sv-feature-loading={Boolean(loading)}
      data-sv-feature-count={layout.relevant.length}
      data-sv-gf-count={layout.fwdLayout.laidOutEntries.length}
      data-sv-gr-count={layout.revLayout.laidOutEntries.length}
      data-sv-sequence-loaded={Boolean(sequence)}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: totalHeight }}
        onPointerDown={handleCanvasPointerDown}
        onClick={handleCanvasClick}
      />
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
            <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
            <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Loading genes…</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default StructuralVariationFeatureBand

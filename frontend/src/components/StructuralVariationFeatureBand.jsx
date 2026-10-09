import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { buildTranscriptSegments } from './featureExplorerTranscriptGeometry'
import { API_BASE } from '../backendRuntime'
import {
  BAND_HEIGHT,
  DETAILED_LAYOUT_MAX_SPAN,
  LANE_PADDING_Y,
  LAYOUT_GAP_BP,
  MAX_DISPLAYED_ROWS,
  PLACEHOLDER_H,
  PLOT_PAD_X,
  ROW_CONTENT_Y,
  ROW_PITCH,
  SEQUENCE_ANNOTATION_DEBOUNCE_MS,
  SEQUENCE_ANNOTATION_FETCH_THRESHOLD,
  SEQ_FETCH_THRESHOLD,
  SEQ_TRACK_HEIGHT,
  TOGGLE_RADIUS,
  TRACK_LABEL_WIDTH,
  buildSequenceAnnotationIntervalsFromAlignments,
  buildSingleRowLayout,
  buildViewportParam,
  drawBand,
  drawHiddenLane,
  drawSequenceLane,
  drawToggleButton,
  drawTranscriptLane,
  expandViewportWindow,
  getLaneColors,
  packEntriesIntoRows,
} from './structural-variation/featureBandDraw.js'

// ── Power icon (shared Path2D) ────────────────────────────────────────────────

const _extractPathData = (svgRaw) => {
  if (typeof svgRaw !== 'string') return ''
  const m = svgRaw.match(/<path[^>]*\sd=(['"])(.*?)\1/i)
  return m?.[2] || ''
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEATURE_COLORS } from './FeatureLegend'
import {
  buildTranscriptSegments,
  orderedExonsFivePrimeToThreePrime,
} from './featureExplorerTranscriptGeometry'
import { parseExonStateKey } from './featureExplorerExonUtils'

import { API_BASE } from '../backendRuntime'
const BASE_CELL_WIDTH = 14
const BASE_BUFFER = 220
const MIN_BASES_PER_WINDOW = 40
const MAX_BASES_PER_WINDOW = 260
const ROW_HEIGHT_PX = 42
const MENU_EXPANDED_WIDTH = 280
const MENU_COLLAPSED_WIDTH = 36

const GENOMIC_BASE_TEXT = '#60a5fa'
const GENOMIC_BASE_OUTLINE = 'rgba(96, 165, 250, 0.88)'

const FEATURE_PRIORITY = [
  'start_codon',
  'stop_codon',
  'donor',
  'acceptor',
  'utr5',
  'utr3',
  'cds',
  'exon',
  'intron',
]

const FEATURE_GROUPS = [
  { key: 'genomic', label: 'Genomic', types: [], color: FEATURE_COLORS.genomic?.bg || '#60a5fa', readOnly: true, outlineOnly: true },
  { key: 'exon', label: 'Exon', types: ['exon'], color: FEATURE_COLORS.exon.bg },
  { key: 'cds', label: 'CDS', types: ['cds'], color: FEATURE_COLORS.cds.bg, gradient: 'linear-gradient(90deg, #60a5fa 50%, #bfdbfe 50%)' },
  { key: 'utr', label: 'UTR', types: ['utr5', 'utr3', 'utr'], color: FEATURE_COLORS.utr.bg },
  { key: 'intron', label: 'Intronic', types: ['intron'], color: FEATURE_COLORS.intron.bg },
  { key: 'splice', label: 'Splice site', types: ['donor', 'acceptor', 'splice'], color: FEATURE_COLORS.splice.bg },
  { key: 'start_codon', label: 'Start (ATG)', types: ['start_codon'], color: FEATURE_COLORS.start_codon.bg },
  { key: 'stop_codon', label: 'Stop', types: ['stop_codon'], color: FEATURE_COLORS.stop_codon.bg },
]

const FEATURE_TYPE_TO_COLOR = {
  exon: FEATURE_COLORS.exon.bg,
  cds: FEATURE_COLORS.cds.bg,
  cds0: '#60a5fa',  // even codons (exon blue)
  cds1: '#bfdbfe',  // odd codons (blue-200, clearly lighter)
  utr: FEATURE_COLORS.utr.bg,
  utr5: FEATURE_COLORS.utr.bg,
  utr3: FEATURE_COLORS.utr.bg,
  intron: FEATURE_COLORS.intron.bg,
  donor: FEATURE_COLORS.splice.bg,
  acceptor: FEATURE_COLORS.splice.bg,
  splice: FEATURE_COLORS.splice.bg,
  start_codon: FEATURE_COLORS.start_codon.bg,
  stop_codon: FEATURE_COLORS.stop_codon.bg,
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function transcriptDisplayId(rawId) {
  const text = String(rawId || '')
  if (text.length <= 26) return text
  return `${text.slice(0, 23)}...`
}

function normalizeBase(base) {
  const up = String(base || '').toUpperCase()
  if (up === 'A' || up === 'C' || up === 'G' || up === 'T') return up
  return 'N'
}

function parsePhaseValue(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '' || rawValue === '.') return null
  const n = Number(rawValue)
  if (!Number.isFinite(n)) return null
  const phase = Math.trunc(n)
  if (phase < 0 || phase > 2) return null
  return phase
}

function hexLuminance(hexColor) {
  const hex = String(hexColor || '').replace('#', '')
  if (hex.length !== 6) return 0
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function isFeatureEnabledForType(featureType, featureEnabled) {
  if (featureType === 'utr' || featureType === 'utr5' || featureType === 'utr3') return Boolean(featureEnabled.utr)
  if (featureType === 'donor' || featureType === 'acceptor' || featureType === 'splice') return Boolean(featureEnabled.splice)
  if (featureType === 'intron') return Boolean(featureEnabled.intron)
  if (featureType === 'exon') return Boolean(featureEnabled.exon)
  if (featureType === 'cds') return Boolean(featureEnabled.cds)
  if (featureType === 'start_codon') return Boolean(featureEnabled.start_codon)
  if (featureType === 'stop_codon') return Boolean(featureEnabled.stop_codon)
  return false
}

function buildTopFeatureByPosition(
  length,
  slices,
  featureEnabled,
  windowStart = 1,
  sequenceType = 'genomic',
  strand = '+',
  cdsCoordForDisplayIndex = null,
  cdsFrameOffset = 0,
) {
  const out = new Array(length).fill('')
  if (!Array.isArray(slices) || slices.length === 0 || length <= 0) return out

  for (const type of FEATURE_PRIORITY) {
    if (!isFeatureEnabledForType(type, featureEnabled)) continue
    for (const slice of slices) {
      const sliceType = String(slice?.type || '')
      if (sliceType !== type) continue
      const start = Math.max(1, Number(slice?.start || 1))
      const end = Math.min(length, Number(slice?.end || 0))
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
      for (let idx = start - 1; idx <= end - 1; idx += 1) {
        if (!out[idx]) {
          if (sliceType === 'cds') {
            // Alternating codon colours: use slice.coordStart (absolute mode coord) for
            // reading-frame-correct phasing. Falls back to windowStart + idx if unavailable.
            const localOffset = idx - (start - 1)
            let baseCoord
            const mappedCdsCoord = typeof cdsCoordForDisplayIndex === 'function'
              ? cdsCoordForDisplayIndex(idx)
              : null
            if (Number.isFinite(mappedCdsCoord)) {
              baseCoord = Number(mappedCdsCoord)
            } else if (slice.coordStart != null && slice.coordEnd != null) {
              if (sequenceType === 'genomic' && strand === '-') {
                baseCoord = Number(slice.coordEnd) - localOffset
              } else {
                baseCoord = Number(slice.coordStart) + localOffset
              }
            } else {
              baseCoord = windowStart + idx
            }
            const codonPhase = Math.floor((baseCoord - 1 + cdsFrameOffset) / 3) % 2
            out[idx] = codonPhase === 0 ? 'cds0' : 'cds1'
          } else {
            out[idx] = sliceType
          }
        }
      }
    }
  }
  return out
}

function coordToDisplayIndex(sequenceType, strand, windowStart, windowEnd, coord) {
  const value = Number(coord)
  if (!Number.isFinite(value)) return null
  const start = Number(windowStart)
  const end = Number(windowEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  if (sequenceType === 'genomic' && strand === '-') {
    return (end - value) + 1
  }
  return (value - start) + 1
}

function mapCoordRangeToDisplayRange(sequenceType, strand, windowStart, windowEnd, coordStart, coordEnd, length) {
  const i1 = coordToDisplayIndex(sequenceType, strand, windowStart, windowEnd, coordStart)
  const i2 = coordToDisplayIndex(sequenceType, strand, windowStart, windowEnd, coordEnd)
  if (!Number.isFinite(i1) || !Number.isFinite(i2)) return null
  const start = clamp(Math.min(i1, i2), 1, length)
  const end = clamp(Math.max(i1, i2), 1, length)
  if (end < start) return null
  return { start, end }
}

function projectGenomicIntervalToDisplayRanges({
  tx,
  sequenceType,
  strand,
  windowStart,
  windowEnd,
  length,
  genomicStart,
  genomicEnd,
}) {
  const gStart = Math.min(Number(genomicStart), Number(genomicEnd))
  const gEnd = Math.max(Number(genomicStart), Number(genomicEnd))
  if (!Number.isFinite(gStart) || !Number.isFinite(gEnd) || gEnd < gStart) return []

  if (sequenceType === 'genomic') {
    const range = mapCoordRangeToDisplayRange(
      sequenceType,
      strand,
      windowStart,
      windowEnd,
      gStart,
      gEnd,
      length,
    )
    return range ? [range] : []
  }

  const segs = buildModeSegmentsForTx(tx, sequenceType)
  const out = []
  for (const seg of segs) {
    const segStart = Math.min(Number(seg?.genomicStart), Number(seg?.genomicEnd))
    const segEnd = Math.max(Number(seg?.genomicStart), Number(seg?.genomicEnd))
    if (!Number.isFinite(segStart) || !Number.isFinite(segEnd)) continue
    const ovStart = Math.max(gStart, segStart)
    const ovEnd = Math.min(gEnd, segEnd)
    if (ovEnd < ovStart) continue

    let coordStart
    let coordEnd
    if (strand === '-') {
      coordStart = Number(seg.coordStart) + (segEnd - ovEnd)
      coordEnd = Number(seg.coordStart) + (segEnd - ovStart)
    } else {
      coordStart = Number(seg.coordStart) + (ovStart - segStart)
      coordEnd = Number(seg.coordStart) + (ovEnd - segStart)
    }
    const range = mapCoordRangeToDisplayRange(
      sequenceType,
      strand,
      windowStart,
      windowEnd,
      coordStart,
      coordEnd,
      length,
    )
    if (range) out.push(range)
  }
  return out
}

function orderedFiveToThree(intervals, strand) {
  const ordered = [...(Array.isArray(intervals) ? intervals : [])]
    .filter((item) => Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end)))
    .map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
  if (strand === '-') ordered.reverse()
  return ordered
}

function buildModeSegmentsForTx(tx, sequenceType) {
  if (!tx) return []
  const strand = String(tx?.strand || '+')
  const source = sequenceType === 'cds'
    ? (Array.isArray(tx?.cds_list) ? tx.cds_list : [])
    : (Array.isArray(tx?.exons) ? tx.exons : [])
  const ordered = orderedFiveToThree(source, strand)
  const segments = []
  let cursor = 1
  for (const seg of ordered) {
    const gStart = Math.min(Number(seg.start), Number(seg.end))
    const gEnd = Math.max(Number(seg.start), Number(seg.end))
    const len = (gEnd - gStart) + 1
    if (!Number.isFinite(len) || len <= 0) continue
    const entry = {
      coordStart: cursor,
      coordEnd: cursor + len - 1,
      genomicStart: gStart,
      genomicEnd: gEnd,
    }
    if (sequenceType === 'cds') {
      const phase = parsePhaseValue(seg?.phase)
      if (phase !== null) entry.phase = phase
    }
    segments.push(entry)
    cursor += len
  }
  return segments
}

function buildCoordToGenomicMapper(tx, sequenceType) {
  const strand = String(tx?.strand || '+')
  const segments = buildModeSegmentsForTx(tx, sequenceType)
  if (!Array.isArray(segments) || segments.length === 0) return null
  return (coordValue) => {
    const coord = Number(coordValue)
    if (!Number.isFinite(coord)) return null
    for (const seg of segments) {
      const cStart = Number(seg?.coordStart)
      const cEnd = Number(seg?.coordEnd)
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd)) continue
      if (coord < cStart || coord > cEnd) continue
      const gStart = Number(seg?.genomicStart)
      const gEnd = Number(seg?.genomicEnd)
      if (!Number.isFinite(gStart) || !Number.isFinite(gEnd)) return null
      if (strand === '-') {
        return gEnd - (coord - cStart)
      }
      return gStart + (coord - cStart)
    }
    return null
  }
}

function buildGenomicToCdsCoordMapper(tx) {
  const strand = String(tx?.strand || '+')
  const cdsSegments = buildModeSegmentsForTx(tx, 'cds')
  if (!Array.isArray(cdsSegments) || cdsSegments.length === 0) return null
  return (genomicCoord) => {
    const g = Number(genomicCoord)
    if (!Number.isFinite(g)) return null
    for (const seg of cdsSegments) {
      const gStart = Number(seg?.genomicStart)
      const gEnd = Number(seg?.genomicEnd)
      if (!Number.isFinite(gStart) || !Number.isFinite(gEnd)) continue
      if (g < gStart || g > gEnd) continue
      if (strand === '-') {
        return Number(seg.coordStart) + (gEnd - g)
      }
      return Number(seg.coordStart) + (g - gStart)
    }
    return null
  }
}

function getCdsFrameOffset(tx) {
  const strand = String(tx?.strand || '+')
  const orderedCds = orderedFiveToThree(Array.isArray(tx?.cds_list) ? tx.cds_list : [], strand)
  if (!Array.isArray(orderedCds) || orderedCds.length === 0) return 0
  const firstPhase = parsePhaseValue(orderedCds[0]?.phase)
  return firstPhase !== null ? firstPhase : 0
}

function projectWindowToGenomicIntervals(tx, sequenceType, windowStart, windowEnd) {
  const strand = String(tx?.strand || '+')
  const wStart = Math.round(Number(windowStart || 1))
  const wEnd = Math.round(Number(windowEnd || wStart))
  if (wEnd < wStart) return []

  if (sequenceType === 'genomic') {
    const gMin = Math.min(Number(tx?.start || 1), Number(tx?.end || 1))
    const gMax = Math.max(Number(tx?.start || 1), Number(tx?.end || 1))
    const ovStart = Math.max(gMin, wStart)
    const ovEnd = Math.min(gMax, wEnd)
    return ovEnd >= ovStart ? [{ start: ovStart, end: ovEnd }] : []
  }

  const segments = buildModeSegmentsForTx(tx, sequenceType)
  const out = []
  for (const seg of segments) {
    const ovStart = Math.max(wStart, seg.coordStart)
    const ovEnd = Math.min(wEnd, seg.coordEnd)
    if (ovEnd < ovStart) continue
    if (strand === '+') {
      const gStart = seg.genomicStart + (ovStart - seg.coordStart)
      const gEnd = seg.genomicStart + (ovEnd - seg.coordStart)
      out.push({ start: Math.min(gStart, gEnd), end: Math.max(gStart, gEnd) })
    } else {
      const gStart = seg.genomicEnd - (ovStart - seg.coordStart)
      const gEnd = seg.genomicEnd - (ovEnd - seg.coordStart)
      out.push({ start: Math.min(gStart, gEnd), end: Math.max(gStart, gEnd) })
    }
  }
  return out
}

function buildExonStartMapByMode(tx, sequenceType) {
  const map = new Map()
  const strand = String(tx?.strand || '+')
  const exons = orderedFiveToThree(Array.isArray(tx?.exons) ? tx.exons : [], strand)
  if (sequenceType === 'genomic') {
    for (const exon of exons) {
      const key = `${Math.min(exon.start, exon.end)}:${Math.max(exon.start, exon.end)}`
      const startCoord = strand === '-' ? Math.max(exon.start, exon.end) : Math.min(exon.start, exon.end)
      map.set(key, startCoord)
    }
    return map
  }
  const segments = buildModeSegmentsForTx(tx, sequenceType)
  for (const seg of segments) {
    const key = `${seg.genomicStart}:${seg.genomicEnd}`
    map.set(key, seg.coordStart)
  }
  return map
}

function computeCoordBoundsFromTranscript(tx, sequenceType) {
  if (!tx) return { min: 1, max: 1 }
  if (sequenceType === 'genomic') {
    const start = Number(tx?.start || 0)
    const end = Number(tx?.end || 0)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { min: 1, max: 1 }
    return { min: Math.max(1, Math.min(start, end)), max: Math.max(1, Math.max(start, end)) }
  }
  if (sequenceType === 'transcript') {
    const exons = Array.isArray(tx?.exons) ? tx.exons : []
    let total = 0
    for (const exon of exons) {
      const start = Number(exon?.start || 0)
      const end = Number(exon?.end || 0)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      total += Math.max(0, Math.abs(Math.round(end) - Math.round(start)) + 1)
    }
    return { min: 1, max: Math.max(1, total) }
  }
  const cdsList = Array.isArray(tx?.cds_list) ? tx.cds_list : []
  let total = 0
  for (const cds of cdsList) {
    const start = Number(cds?.start || 0)
    const end = Number(cds?.end || 0)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    total += Math.max(0, Math.abs(Math.round(end) - Math.round(start)) + 1)
  }
  return { min: 1, max: Math.max(1, total) }
}

export default function FeatureExplorerSequencesPanel({
  theme = 'dark',
  resolvedGene = null,
  sequenceGenome = 'reference',
  orderedTranscripts = [],
  displayOrderIds = [],
  visibleDisplayIds = [],
  activeTranscriptIds = new Set(),
  transcriptById = new Map(),
  transcriptTagInfoById = {},
  allActive = false,
  activeActionButtonClass = '',
  setAllVisible,
  collapseInactiveRows = true,
  setCollapseInactiveRows,
  restoreDefaultOrdering,
  toggleTranscript,
  dragSourceId = '',
  insertTargetId = '',
  insertPosition = 'before',
  mouseDownId = '',
  onTranscriptMouseDown,
  onTranscriptMouseUp,
  onTranscriptDragStart,
  onTranscriptDragOver,
  onTranscriptDrop,
  onTranscriptDragEnd,
  selectedExonStateKey = '',
}) {
  const isLight = theme === 'light'
  const [collapsed, setCollapsed] = useState(false)
  const [sequenceType, setSequenceType] = useState('transcript')
  const [lockPanAcrossRows, setLockPanAcrossRows] = useState(false)
  const [alignByGenomicCoords, setAlignByGenomicCoords] = useState(false)
  const [menuCollapsed, setMenuCollapsed] = useState(false)
  const [featureOverlayCollapsed, setFeatureOverlayCollapsed] = useState(false)
  const [featureEnabled, setFeatureEnabled] = useState({
    exon: true,
    cds: true,
    utr: true,
    intron: true,
    splice: true,
    start_codon: true,
    stop_codon: true,
  })
  const [basesPerWindow, setBasesPerWindow] = useState(120)
  const [modePanState, setModePanState] = useState({
    genomic: { globalStart: null, rowStarts: {} },
    transcript: { globalStart: null, rowStarts: {} },
    cds: { globalStart: null, rowStarts: {} },
  })
  const [fetchError, setFetchError] = useState('')
  const [loadingRowIds, setLoadingRowIds] = useState(new Set())
  const [cacheVersion, setCacheVersion] = useState(0)
  const [hoveredMinimapExon, setHoveredMinimapExon] = useState({ txId: '', exonIndex: -1 })
  const [minimapAnimProgress, setMinimapAnimProgress] = useState(0)
  const [boundaryTooltip, setBoundaryTooltip] = useState(null) // { label, x, y } in viewport coords
  // { txId, markerType: 'boundary'|'start'|'stop', idx: number }
  const [minimapMarkerHover, setMinimapMarkerHover] = useState(null)
  const [copyToast, setCopyToast] = useState('')

  const measureRef = useRef(null)
  const cacheRef = useRef(new Map())
  const fetchTokenRef = useRef(0)
  const minimapAnimProgressRef = useRef(0)
  const minimapAnimFrameRef = useRef(null)
  const wheelAccumulatorRef = useRef(0)
  const hoveredRowRef = useRef(null)

  const activeCount = useMemo(() => {
    let count = 0
    for (const tx of orderedTranscripts) {
      if (activeTranscriptIds.has(tx.id)) count += 1
    }
    return count
  }, [orderedTranscripts, activeTranscriptIds])
  const inactiveCount = Math.max(0, orderedTranscripts.length - activeCount)
  const anyFeatureEnabled = useMemo(() => Object.values(featureEnabled).some(Boolean), [featureEnabled])

  const activeDisplayIds = useMemo(() => (
    displayOrderIds.filter((id) => activeTranscriptIds.has(id) && transcriptById.has(id))
  ), [displayOrderIds, activeTranscriptIds, transcriptById])

  const selectedExon = useMemo(() => parseExonStateKey(selectedExonStateKey), [selectedExonStateKey])
  const getDefaultStartForTx = useCallback((tx) => {
    if (!tx) return 1
    if (sequenceType !== 'genomic') return 1
    const gStart = Number(resolvedGene?.start)
    const gEnd = Number(resolvedGene?.end)
    const txStart = Number(tx?.start || 0)
    const txEnd = Number(tx?.end || 0)
    const spanMin = Number.isFinite(gStart) && Number.isFinite(gEnd)
      ? Math.min(gStart, gEnd)
      : (Number.isFinite(txStart) && Number.isFinite(txEnd) ? Math.min(txStart, txEnd) : 1)
    const spanMax = Number.isFinite(gStart) && Number.isFinite(gEnd)
      ? Math.max(gStart, gEnd)
      : (Number.isFinite(txStart) && Number.isFinite(txEnd) ? Math.max(txStart, txEnd) : spanMin)
    const strand = String(tx?.strand || '+')
    if (strand === '-') {
      return Math.max(1, spanMax - basesPerWindow + 1)
    }
    return Math.max(1, spanMin || 1)
  }, [sequenceType, basesPerWindow, resolvedGene?.start, resolvedGene?.end])

  const getCoordBoundsForTx = useCallback((txId, forDisplay = true) => {
    const tx = transcriptById.get(txId)
    if (!tx) return { min: 1, max: 1 }
    if (sequenceType === 'genomic') {
      const txStart = Number(tx?.start || 0)
      const txEnd = Number(tx?.end || 0)
      const txMin = Number.isFinite(txStart) && Number.isFinite(txEnd) ? Math.min(txStart, txEnd) : 1
      const txMax = Number.isFinite(txStart) && Number.isFinite(txEnd) ? Math.max(txStart, txEnd) : txMin
      if (!forDisplay) return { min: Math.max(1, txMin), max: Math.max(1, txMax) }
      const gStart = Number(resolvedGene?.start)
      const gEnd = Number(resolvedGene?.end)
      if (Number.isFinite(gStart) && Number.isFinite(gEnd)) {
        return {
          min: Math.max(1, Math.min(gStart, gEnd)),
          max: Math.max(1, Math.max(gStart, gEnd)),
        }
      }
      return { min: Math.max(1, txMin), max: Math.max(1, txMax) }
    }
    return computeCoordBoundsFromTranscript(tx, sequenceType)
  }, [transcriptById, sequenceType, resolvedGene?.start, resolvedGene?.end])

  const clampStartForTx = useCallback((txId, startRaw, forDisplay = true) => {
    const bounds = getCoordBoundsForTx(txId, forDisplay)
    const minStart = Math.max(1, Number(bounds?.min || 1))
    const maxStart = Math.max(minStart, Number(bounds?.max || minStart) - basesPerWindow + 1)
    return clamp(Math.max(1, Math.round(Number(startRaw || minStart))), minStart, maxStart)
  }, [getCoordBoundsForTx, basesPerWindow])

  useEffect(() => {
    cacheRef.current.clear()
    setFetchError('')
    setLoadingRowIds(new Set())
    setCacheVersion((v) => v + 1)
    setModePanState({
      genomic: { globalStart: null, rowStarts: {} },
      transcript: { globalStart: null, rowStarts: {} },
      cds: { globalStart: null, rowStarts: {} },
    })
  }, [resolvedGene?.id])

  useEffect(() => {
    const el = measureRef.current
    if (!el) return undefined
    const update = () => {
      const width = Math.max(320, el.clientWidth || 0)
      const value = clamp(Math.floor((width - 18 - 32) / BASE_CELL_WIDTH), MIN_BASES_PER_WINDOW, MAX_BASES_PER_WINDOW)
      setBasesPerWindow(value)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (sequenceType !== 'genomic' && alignByGenomicCoords) {
      setAlignByGenomicCoords(false)
    }
  }, [sequenceType, alignByGenomicCoords])

  useEffect(() => {
    if (!alignByGenomicCoords || activeDisplayIds.length === 0) return
    setModePanState((prev) => {
      const curr = prev[sequenceType] || { globalStart: null, rowStarts: {} }
      if (Number.isFinite(curr.globalStart) && Number(curr.globalStart) > 0) return prev
      const firstTx = transcriptById.get(activeDisplayIds[0])
      const start = getDefaultStartForTx(firstTx)
      return {
        ...prev,
        [sequenceType]: {
          ...curr,
          globalStart: Math.max(1, start),
        },
      }
    })
  }, [sequenceType, alignByGenomicCoords, activeDisplayIds, transcriptById, getDefaultStartForTx])

  const rowWindowById = useMemo(() => {
    const out = {}
    const curr = modePanState[sequenceType] || { globalStart: null, rowStarts: {} }
    const useGlobal = alignByGenomicCoords
    for (const txId of activeDisplayIds) {
      const tx = transcriptById.get(txId)
      if (!tx) continue
      const unclampedStart = useGlobal
        ? (Number(curr.globalStart) > 0 ? Number(curr.globalStart) : getDefaultStartForTx(tx))
        : (Number(curr.rowStarts?.[txId]) > 0 ? Number(curr.rowStarts?.[txId]) : getDefaultStartForTx(tx))
      const start = clampStartForTx(txId, unclampedStart, true)
      out[txId] = {
        start: Math.max(1, Math.round(start)),
        end: Math.max(1, Math.round(start)) + basesPerWindow - 1,
      }
    }
    return out
  }, [modePanState, sequenceType, lockPanAcrossRows, alignByGenomicCoords, activeDisplayIds, transcriptById, getDefaultStartForTx, clampStartForTx, basesPerWindow])

  const rowWindowSignature = useMemo(
    () => activeDisplayIds.map((txId) => {
      const win = rowWindowById[txId]
      return `${txId}:${win?.start || 0}-${win?.end || 0}`
    }).join('|'),
    [activeDisplayIds, rowWindowById]
  )

  const setModeStart = useCallback((txId, nextStartRaw) => {
    const useGlobal = alignByGenomicCoords
    setModePanState((prev) => {
      const curr = prev[sequenceType] || { globalStart: null, rowStarts: {} }
      if (useGlobal) {
        const anchorId = activeDisplayIds[0] || txId
        const nextStart = clampStartForTx(anchorId, nextStartRaw, true)
        return {
          ...prev,
          [sequenceType]: {
            ...curr,
            globalStart: nextStart,
          },
        }
      }
      const nextStart = clampStartForTx(txId, nextStartRaw, true)
      return {
        ...prev,
        [sequenceType]: {
          ...curr,
          rowStarts: {
            ...(curr.rowStarts || {}),
            [txId]: nextStart,
          },
        },
      }
    })
  }, [sequenceType, alignByGenomicCoords, activeDisplayIds, clampStartForTx])

  // Pans every visible row by `deltaBases` simultaneously (used by wheel gesture handler and slider in lock-pan mode).
  const setModeStartAll = useCallback((deltaBases) => {
    setModePanState((prev) => {
      const curr = prev[sequenceType] || { globalStart: null, rowStarts: {} }
      if (alignByGenomicCoords) {
        const anchorTx = transcriptById.get(activeDisplayIds[0])
        const currentStart = Number(curr.globalStart) > 0
          ? Number(curr.globalStart)
          : getDefaultStartForTx(anchorTx)
        const anchorId = activeDisplayIds[0] || ''
        const nextStart = anchorId
          ? clampStartForTx(anchorId, currentStart + deltaBases, true)
          : Math.max(1, currentStart + deltaBases)
        return {
          ...prev,
          [sequenceType]: { ...curr, globalStart: nextStart },
        }
      }
      const newRowStarts = {}
      for (const txId of activeDisplayIds) {
        const tx = transcriptById.get(txId)
        const currentStart = Number(curr.rowStarts?.[txId]) > 0
          ? Number(curr.rowStarts?.[txId])
          : getDefaultStartForTx(tx)
        newRowStarts[txId] = clampStartForTx(txId, currentStart + deltaBases, true)
      }
      return {
        ...prev,
        [sequenceType]: { ...curr, rowStarts: { ...curr.rowStarts, ...newRowStarts } },
      }
    })
  }, [sequenceType, alignByGenomicCoords, activeDisplayIds, transcriptById, getDefaultStartForTx, clampStartForTx])

  useEffect(() => {
    const el = measureRef.current
    if (!el) return undefined
    const handleWheel = (e) => {
      // Only intercept predominantly horizontal gestures; let vertical scroll pass through.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      // Minus-strand genomic displays right-to-left, so invert the panning direction.
      const anchorTx = transcriptById.get(activeDisplayIds[0])
      const strand = String(anchorTx?.strand || '+')
      const isReversed = sequenceType === 'genomic' && strand === '-'
      const sign = isReversed ? -1 : 1
      wheelAccumulatorRef.current += sign * e.deltaX
      const deltaBases = Math.trunc(wheelAccumulatorRef.current / BASE_CELL_WIDTH)
      if (deltaBases === 0) return
      wheelAccumulatorRef.current -= deltaBases * BASE_CELL_WIDTH
      const useGlobal = lockPanAcrossRows || alignByGenomicCoords
      const hoveredId = hoveredRowRef.current
      if (!useGlobal && hoveredId) {
        const currentStart = rowWindowById[hoveredId]?.start || 1
        setModeStart(hoveredId, currentStart + deltaBases)
      } else {
        setModeStartAll(deltaBases)
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
      wheelAccumulatorRef.current = 0
    }
  }, [sequenceType, activeDisplayIds, transcriptById, lockPanAcrossRows, alignByGenomicCoords, rowWindowById, setModeStart, setModeStartAll])

  const coordBoundsById = useMemo(() => {
    const out = {}
    let globalGenomicMin = Number.POSITIVE_INFINITY
    let globalGenomicMax = Number.NEGATIVE_INFINITY
    if (sequenceType === 'genomic') {
      const geneStart = Number(resolvedGene?.start)
      const geneEnd = Number(resolvedGene?.end)
      const hasGeneBounds = Number.isFinite(geneStart) && Number.isFinite(geneEnd)
      if (Number.isFinite(geneStart) && Number.isFinite(geneEnd)) {
        globalGenomicMin = Math.min(geneStart, geneEnd)
        globalGenomicMax = Math.max(geneStart, geneEnd)
      }
      for (const txId of activeDisplayIds) {
        const tx = transcriptById.get(txId)
        if (!tx) continue
        if (hasGeneBounds) continue
        const txMin = Math.min(Number(tx?.start || 1), Number(tx?.end || 1))
        const txMax = Math.max(Number(tx?.start || 1), Number(tx?.end || 1))
        if (!Number.isFinite(globalGenomicMin)) globalGenomicMin = txMin
        else globalGenomicMin = Math.min(globalGenomicMin, txMin)
        if (!Number.isFinite(globalGenomicMax)) globalGenomicMax = txMax
        else globalGenomicMax = Math.max(globalGenomicMax, txMax)
      }
      if (!Number.isFinite(globalGenomicMin) || !Number.isFinite(globalGenomicMax)) {
        globalGenomicMin = Number(resolvedGene?.start || 1)
        globalGenomicMax = Number(resolvedGene?.end || globalGenomicMin)
      }
      if (globalGenomicMax < globalGenomicMin) {
        const tmp = globalGenomicMin
        globalGenomicMin = globalGenomicMax
        globalGenomicMax = tmp
      }
    }
    for (const txId of activeDisplayIds) {
      const tx = transcriptById.get(txId)
      const fallback = computeCoordBoundsFromTranscript(tx, sequenceType)
      if (
        sequenceType === 'genomic'
        && Number.isFinite(globalGenomicMin)
        && Number.isFinite(globalGenomicMax)
        && globalGenomicMax >= globalGenomicMin
      ) {
        out[txId] = {
          min: Math.max(1, Math.round(globalGenomicMin)),
          max: Math.max(1, Math.round(globalGenomicMax)),
        }
        continue
      }
      const cacheKey = `${resolvedGene?.id || ''}|${sequenceType}|${txId}`
      const cached = cacheRef.current.get(cacheKey)
      const coordMin = Number(cached?.coordMin)
      const coordMax = Number(cached?.coordMax)
      if (Number.isFinite(coordMin) && Number.isFinite(coordMax) && coordMax >= coordMin) {
        out[txId] = { min: Math.max(1, Math.round(coordMin)), max: Math.max(1, Math.round(coordMax)) }
      } else {
        out[txId] = fallback
      }
    }
    return out
  }, [activeDisplayIds, transcriptById, sequenceType, resolvedGene?.id, resolvedGene?.start, resolvedGene?.end, cacheVersion])

  const panScrollModel = useMemo(() => {
    const anchorId = activeDisplayIds[0] || ''
    if (!anchorId) {
      return { anchorId: '', minStart: 1, maxStart: 1, currentStart: 1, disabled: true }
    }
    const anchorWindow = rowWindowById[anchorId]
    const bounds = coordBoundsById[anchorId] || { min: 1, max: 1 }
    const minStart = Math.max(1, Number(bounds.min || 1))
    const maxStart = Math.max(minStart, Number(bounds.max || minStart) - basesPerWindow + 1)
    const currentStart = clamp(Number(anchorWindow?.start || minStart), minStart, maxStart)
    return {
      anchorId,
      minStart,
      maxStart,
      currentStart,
      disabled: maxStart <= minStart,
    }
  }, [activeDisplayIds, rowWindowById, coordBoundsById, basesPerWindow])

  const isReverseGenomicPan = useMemo(() => {
    if (sequenceType !== 'genomic') return false
    const anchorId = panScrollModel.anchorId
    if (!anchorId) return false
    const tx = transcriptById.get(anchorId)
    return String(tx?.strand || '+') === '-'
  }, [sequenceType, panScrollModel.anchorId, transcriptById])

  const sliderValueFromStart = useCallback((startCoord) => {
    const min = Number(panScrollModel.minStart || 1)
    const max = Number(panScrollModel.maxStart || min)
    const start = clamp(Number(startCoord || min), min, max)
    if (!isReverseGenomicPan) return start
    return max - (start - min)
  }, [panScrollModel.minStart, panScrollModel.maxStart, isReverseGenomicPan])

  const startFromSliderValue = useCallback((sliderValue) => {
    const min = Number(panScrollModel.minStart || 1)
    const max = Number(panScrollModel.maxStart || min)
    const value = clamp(Number(sliderValue || min), min, max)
    if (!isReverseGenomicPan) return value
    return max - (value - min)
  }, [panScrollModel.minStart, panScrollModel.maxStart, isReverseGenomicPan])

  const handleBottomScrollbarPan = useCallback((nextStartRaw) => {
    const anchorId = panScrollModel.anchorId
    if (!anchorId) return
    const nextStart = Math.max(1, Math.round(startFromSliderValue(nextStartRaw)))
    const currentAnchorStart = Number(rowWindowById?.[anchorId]?.start || panScrollModel.minStart)
    const delta = nextStart - currentAnchorStart
    setModePanState((prev) => {
      const curr = prev[sequenceType] || { globalStart: null, rowStarts: {} }
      if (alignByGenomicCoords) {
        return {
          ...prev,
          [sequenceType]: {
            ...curr,
            globalStart: nextStart,
          },
        }
      }
      const nextRows = { ...(curr.rowStarts || {}) }
      for (const txId of activeDisplayIds) {
        const bounds = coordBoundsById[txId] || { min: 1, max: 1 }
        const minStart = Math.max(1, Number(bounds.min || 1))
        const maxStart = Math.max(minStart, Number(bounds.max || minStart) - basesPerWindow + 1)
        const currentStart = Number(rowWindowById?.[txId]?.start || minStart)
        nextRows[txId] = clamp(currentStart + delta, minStart, maxStart)
      }
      return {
        ...prev,
        [sequenceType]: {
          ...curr,
          rowStarts: nextRows,
        },
      }
    })
  }, [
    panScrollModel.anchorId,
    panScrollModel.minStart,
    alignByGenomicCoords,
    rowWindowById,
    sequenceType,
    activeDisplayIds,
    coordBoundsById,
    basesPerWindow,
    startFromSliderValue,
  ])

  const minimapReverseOrientation = useMemo(() => {
    const strand = String(resolvedGene?.strand || transcriptById.get(activeDisplayIds[0] || '')?.strand || '+')
    return strand === '-'
  }, [resolvedGene?.strand, transcriptById, activeDisplayIds])

  useEffect(() => {
    const target = sequenceType === 'genomic' ? 0 : 1
    if (minimapAnimFrameRef.current) cancelAnimationFrame(minimapAnimFrameRef.current)
    const startProgress = minimapAnimProgressRef.current
    const startTime = performance.now()
    const DURATION = 450
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / DURATION)
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      const progress = startProgress + (target - startProgress) * eased
      minimapAnimProgressRef.current = progress
      setMinimapAnimProgress(progress)
      if (t < 1) minimapAnimFrameRef.current = requestAnimationFrame(step)
    }
    minimapAnimFrameRef.current = requestAnimationFrame(step)
    return () => { if (minimapAnimFrameRef.current) cancelAnimationFrame(minimapAnimFrameRef.current) }
  }, [sequenceType])

  const minimapRange = useMemo(() => {
    if (activeDisplayIds.length === 0) return { min: 1, max: 2 }
    let minCoord = Number.POSITIVE_INFINITY
    let maxCoord = Number.NEGATIVE_INFINITY
    for (const txId of activeDisplayIds) {
      const tx = transcriptById.get(txId)
      if (!tx) continue
      const txMin = Math.min(Number(tx?.start || 1), Number(tx?.end || 1))
      const txMax = Math.max(Number(tx?.start || 1), Number(tx?.end || 1))
      minCoord = Math.min(minCoord, txMin)
      maxCoord = Math.max(maxCoord, txMax)
    }
    if (!Number.isFinite(minCoord) || !Number.isFinite(maxCoord)) return { min: 1, max: 2 }
    if (maxCoord <= minCoord) return { min: minCoord, max: minCoord + 1 }
    return { min: minCoord, max: maxCoord }
  }, [activeDisplayIds, transcriptById])

  const mapGenomicCoordToMinimap = useCallback((coord, width = 996) => {
    const value = Number(coord)
    if (!Number.isFinite(value)) return 2
    const minCoord = Number(minimapRange.min || 1)
    const maxCoord = Number(minimapRange.max || 2)
    const span = Math.max(1, maxCoord - minCoord)
    let fraction = (value - minCoord) / span
    if (minimapReverseOrientation) fraction = 1 - fraction
    return 2 + (clamp(fraction, 0, 1) * width)
  }, [minimapRange.min, minimapRange.max, minimapReverseOrientation])

  // Maps a 0-based compressed coordinate to SVG x, scaled so the longest transcript fills the full width.
  const mapCompressedToMinimap = useCallback((zeroBasedCoord, maxLen) => {
    return 2 + (zeroBasedCoord / Math.max(1, maxLen)) * 996
  }, [])

  const minimapDataByTxId = useMemo(() => {
    const out = {}
    for (const txId of activeDisplayIds) {
      const tx = transcriptById.get(txId)
      if (!tx) continue
      const strand = String(tx?.strand || '+')
      const txMin = Math.min(Number(tx?.start || 1), Number(tx?.end || 1))
      const txMax = Math.max(Number(tx?.start || 1), Number(tx?.end || 1))
      const orderedExons = orderedExonsFivePrimeToThreePrime(tx)
      const segments = buildTranscriptSegments(tx)
      const window = rowWindowById[txId]
      const overlayIntervals = window
        ? projectWindowToGenomicIntervals(tx, sequenceType, window.start, window.end)
        : []
      // modeSegs provides per-exon (transcript) or per-CDS-block (cds) segments with both
      // genomic and compressed coordinates. Used for the animated minimap transition.
      const modeSegs = buildModeSegmentsForTx(tx, sequenceType === 'genomic' ? 'transcript' : sequenceType)
      const totalLength = modeSegs.length > 0 ? modeSegs[modeSegs.length - 1].coordEnd : 1

      // Compute start/stop codon positions in mode + genomic coords for minimap markers.
      let codonMarkers = null
      if (sequenceType !== 'genomic') {
        const cdsSegs = buildModeSegmentsForTx(tx, 'cds')
        if (cdsSegs.length > 0) {
          const firstCds = cdsSegs[0]
          const lastCds = cdsSegs[cdsSegs.length - 1]
          // Genomic coordinate of the 5' CDS base and the 3' CDS base.
          const startGenomic = strand === '-' ? firstCds.genomicEnd : firstCds.genomicStart
          const stopGenomic = strand === '-' ? lastCds.genomicStart : lastCds.genomicEnd
          if (sequenceType === 'cds') {
            codonMarkers = { startGenomic, stopGenomic, startCoord: 1, stopCoord: lastCds.coordEnd }
          } else {
            // transcript mode: map CDS genomic bounds into transcript (exon) coordinates.
            let startCoord = null
            let stopCoord = null
            for (const seg of modeSegs) {
              if (startCoord === null && startGenomic >= seg.genomicStart && startGenomic <= seg.genomicEnd) {
                const off = strand === '-' ? (seg.genomicEnd - startGenomic) : (startGenomic - seg.genomicStart)
                startCoord = seg.coordStart + off
              }
              if (stopCoord === null && stopGenomic >= seg.genomicStart && stopGenomic <= seg.genomicEnd) {
                const off = strand === '-' ? (seg.genomicEnd - stopGenomic) : (stopGenomic - seg.genomicStart)
                stopCoord = seg.coordStart + off
              }
            }
            codonMarkers = { startGenomic, stopGenomic, startCoord, stopCoord }
          }
        }
      }

      out[txId] = { tx, strand, txMin, txMax, orderedExons, segments, overlayIntervals, modeSegs, totalLength, codonMarkers }
    }
    return out
  }, [activeDisplayIds, transcriptById, rowWindowById, sequenceType])

  const maxCompressedLength = useMemo(() => {
    let max = 1
    for (const txId of activeDisplayIds) {
      const model = minimapDataByTxId[txId]
      if (model) max = Math.max(max, model.totalLength)
    }
    return max
  }, [minimapDataByTxId, activeDisplayIds])

  const scrollToMinimapCoord = useCallback((txId, genomicCoord) => {
    const tx = transcriptById.get(txId)
    if (!tx) return
    const strand = String(tx?.strand || '+')
    const bounds = coordBoundsById[txId] || { min: 1, max: 1 }
    const maxWindowStart = Math.max(bounds.min, bounds.max - basesPerWindow + 1)

    if (sequenceType === 'genomic') {
      const windowStart = clamp(
        Math.round(genomicCoord - Math.floor(basesPerWindow / 2)),
        bounds.min,
        maxWindowStart
      )
      setModeStart(txId, windowStart)
      return
    }

    const segments = buildModeSegmentsForTx(tx, sequenceType)
    if (segments.length === 0) return

    // Find the segment containing the clicked genomic coord and interpolate within it.
    // For introns/intergenic, snap to the nearest exon/CDS boundary.
    let targetCoord = null
    for (const seg of segments) {
      if (genomicCoord >= seg.genomicStart && genomicCoord <= seg.genomicEnd) {
        const offset = strand === '-'
          ? (seg.genomicEnd - genomicCoord)
          : (genomicCoord - seg.genomicStart)
        targetCoord = seg.coordStart + Math.round(offset)
        break
      }
    }

    if (targetCoord === null) {
      let bestDist = Infinity
      for (const seg of segments) {
        const distToStart = Math.abs(genomicCoord - seg.genomicStart)
        const distToEnd = Math.abs(genomicCoord - seg.genomicEnd)
        if (distToStart < bestDist) {
          bestDist = distToStart
          targetCoord = strand === '-' ? seg.coordEnd : seg.coordStart
        }
        if (distToEnd < bestDist) {
          bestDist = distToEnd
          targetCoord = strand === '-' ? seg.coordStart : seg.coordEnd
        }
      }
    }

    if (targetCoord === null) return
    const windowStart = clamp(
      Math.round(targetCoord - Math.floor(basesPerWindow / 2)),
      bounds.min,
      maxWindowStart
    )
    setModeStart(txId, windowStart)
  }, [sequenceType, setModeStart, basesPerWindow, transcriptById, coordBoundsById])

  const handleMinimapClick = useCallback((event, txId) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const clientFraction = clamp((event.clientX - rect.left) / rect.width, 0, 1)

    if (sequenceType === 'genomic') {
      // Genomic mode: minimap uses genomic coords and is reversed for minus-strand genes.
      const adjustedFraction = minimapReverseOrientation ? (1 - clientFraction) : clientFraction
      const span = Math.max(1, minimapRange.max - minimapRange.min)
      const genomicCoord = Math.round(minimapRange.min + adjustedFraction * span)
      scrollToMinimapCoord(txId, genomicCoord)
      return
    }

    // Transcript/CDS mode: minimap is in compressed mode-coordinate space via
    // mapCompressedToMinimap, which always maps coord 1 → left, last coord → right,
    // with NO strand reversal. Use clientFraction directly (no minimapReverseOrientation).
    // Invert mapCompressedToMinimap: fraction → 0-based position → 1-based mode coord.
    const modeCoord = clamp(
      Math.floor(clientFraction * maxCompressedLength) + 1,
      1,
      maxCompressedLength,
    )
    const bounds = coordBoundsById[txId] || { min: 1, max: 1 }
    const maxWindowStart = Math.max(bounds.min, bounds.max - basesPerWindow + 1)
    const windowStart = clamp(
      Math.round(modeCoord - Math.floor(basesPerWindow / 2)),
      bounds.min,
      maxWindowStart,
    )
    setModeStart(txId, windowStart)
  }, [sequenceType, minimapRange, minimapReverseOrientation, maxCompressedLength, coordBoundsById, basesPerWindow, setModeStart, scrollToMinimapCoord])

  // Centers the sequence view on a specific mode coordinate (used by minimap marker clicks).
  const handleMinimapMarkerClick = useCallback((e, txId, modeCoord) => {
    e.stopPropagation()
    const bounds = coordBoundsById[txId] || { min: 1, max: 1 }
    const maxWindowStart = Math.max(bounds.min, bounds.max - basesPerWindow + 1)
    const windowStart = clamp(
      Math.round(modeCoord - Math.floor(basesPerWindow / 2)),
      bounds.min,
      maxWindowStart,
    )
    setModeStart(txId, windowStart)
  }, [coordBoundsById, basesPerWindow, setModeStart])

  useEffect(() => {
    if (!resolvedGene?.id || activeDisplayIds.length === 0) return
    const neededRows = []
    const loadingIds = []
    for (const txId of activeDisplayIds) {
      const win = rowWindowById[txId]
      if (!win) continue
      const cacheKey = `${resolvedGene.id}|${sequenceType}|${txId}`
      const cached = cacheRef.current.get(cacheKey)
      if (cached && cached.bufferStart <= win.start && cached.bufferEnd >= win.end) continue
      const bufferStart = Math.max(1, win.start - BASE_BUFFER)
      const bufferEnd = win.end + BASE_BUFFER
      neededRows.push({
        transcript_id: txId,
        window_start: bufferStart,
        window_end: bufferEnd,
      })
      loadingIds.push(txId)
    }
    if (neededRows.length === 0) return

    setFetchError('')
    setLoadingRowIds((prev) => {
      const next = new Set(prev)
      for (const id of loadingIds) next.add(id)
      return next
    })
    const token = ++fetchTokenRef.current

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/feature_explorer/sequences`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: sequenceGenome || 'reference',
            sequence_type: sequenceType,
            include_features: true,
            rows: neededRows,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (token !== fetchTokenRef.current) return
        if (!res.ok) throw new Error(data?.detail || 'Failed to fetch feature-explorer sequences.')
        const rows = Array.isArray(data?.rows) ? data.rows : []
        for (const row of rows) {
          const txId = String(row?.transcript_id || '').trim()
          if (!txId) continue
          const cacheKey = `${resolvedGene.id}|${sequenceType}|${txId}`
          cacheRef.current.set(cacheKey, {
            status: String(row?.status || 'error'),
            message: String(row?.message || ''),
            chrom: String(row?.chrom || ''),
            strand: String(row?.strand || '+'),
            coordMin: Number(row?.coord_min || 1),
            coordMax: Number(row?.coord_max || 1),
            bufferStart: Number(row?.window_start || 1),
            bufferEnd: Number(row?.window_end || 0),
            sequence: String(row?.sequence || ''),
            features: Array.isArray(row?.features) ? row.features : [],
          })
        }
        setCacheVersion((v) => v + 1)
      } catch (e) {
        if (token !== fetchTokenRef.current) return
        setFetchError(e?.message || 'Failed to fetch sequence rows.')
      } finally {
        if (token !== fetchTokenRef.current) return
        setLoadingRowIds((prev) => {
          const next = new Set(prev)
          for (const id of loadingIds) next.delete(id)
          return next
        })
      }
    }
    run()
  }, [resolvedGene?.id, sequenceType, sequenceGenome, activeDisplayIds, rowWindowSignature, rowWindowById])

  const rowRenderData = useMemo(() => {
    const out = {}
    if (!resolvedGene?.id) return out
    for (const txId of activeDisplayIds) {
      const win = rowWindowById[txId]
      if (!win) continue
      const tx = transcriptById.get(txId)
      const strand = String(tx?.strand || '+')
      const cacheKey = `${resolvedGene.id}|${sequenceType}|${txId}`
      const cached = cacheRef.current.get(cacheKey)
      if (!cached || cached.bufferStart > win.start || cached.bufferEnd < win.end) {
        out[txId] = { status: 'loading', sequence: '', features: [], coordMin: 1, coordMax: 1, message: '', strand }
        continue
      }
      const rawSequence = String(cached.sequence || '')
      const sliceOffset = (sequenceType === 'genomic' && strand === '-')
        ? (cached.bufferEnd - win.end)
        : (win.start - cached.bufferStart)
      const safeSliceOffset = Math.max(0, Math.round(sliceOffset))
      const seqRaw = rawSequence.slice(safeSliceOffset, safeSliceOffset + basesPerWindow)
      const sequence = (seqRaw + '-'.repeat(Math.max(0, basesPerWindow - seqRaw.length))).slice(0, basesPerWindow)

      const featureSlices = []
      for (const feat of (Array.isArray(cached.features) ? cached.features : [])) {
        const fType = String(feat?.type || '').trim()
        if (!fType) continue

        let coordStart = Number(feat?.coord_start)
        let coordEnd = Number(feat?.coord_end)

        // Backward-compatible fallback for caches created before absolute feature coords existed.
        if (!Number.isFinite(coordStart) || !Number.isFinite(coordEnd)) {
          const fStartRel = Number(feat?.start || 0)
          const fEndRel = Number(feat?.end || 0)
          if (!Number.isFinite(fStartRel) || !Number.isFinite(fEndRel)) continue
          const relLo = Math.min(fStartRel, fEndRel)
          const relHi = Math.max(fStartRel, fEndRel)
          if (sequenceType === 'genomic' && strand === '-') {
            coordStart = cached.bufferEnd - relHi + 1
            coordEnd = cached.bufferEnd - relLo + 1
          } else {
            coordStart = cached.bufferStart + relLo - 1
            coordEnd = cached.bufferStart + relHi - 1
          }
        }

        const absStart = Math.min(coordStart, coordEnd)
        const absEnd = Math.max(coordStart, coordEnd)
        const ovStart = Math.max(absStart, win.start)
        const ovEnd = Math.min(absEnd, win.end)
        if (ovEnd < ovStart) continue
        const displayRange = mapCoordRangeToDisplayRange(
          sequenceType,
          strand,
          win.start,
          win.end,
          ovStart,
          ovEnd,
          basesPerWindow
        )
        if (!displayRange) continue
        featureSlices.push({
          type: fType,
          start: displayRange.start,
          end: displayRange.end,
          coordStart: ovStart,
          coordEnd: ovEnd,
        })
      }

      out[txId] = {
        status: String(cached.status || 'error'),
        sequence,
        features: featureSlices,
        coordMin: Number(cached.coordMin || 1),
        coordMax: Number(cached.coordMax || 1),
        message: String(cached.message || ''),
        strand,
      }
    }
    return out
  }, [resolvedGene?.id, activeDisplayIds, rowWindowById, sequenceType, basesPerWindow, cacheVersion, transcriptById])

  const rowModels = useMemo(() => (
    visibleDisplayIds
      .map((txId) => {
        const tx = transcriptById.get(txId)
        if (!tx) return null
        const isActive = activeTranscriptIds.has(txId)
        const rowData = rowRenderData[txId] || {
          status: isActive ? 'loading' : 'inactive',
          sequence: '',
          features: [],
          message: '',
          strand: String(tx?.strand || '+'),
        }
        const loading = isActive && (loadingRowIds.has(txId) || rowData.status === 'loading')
        return {
          txId,
          tx,
          isActive,
          rowData,
          loading,
          height: ROW_HEIGHT_PX,
        }
      })
      .filter(Boolean)
  ), [visibleDisplayIds, transcriptById, activeTranscriptIds, rowRenderData, loadingRowIds])

  const handleTypeChange = (nextType) => {
    setSequenceType(nextType)
    if (nextType !== 'genomic') {
      setAlignByGenomicCoords(false)
    }
  }

  const handleRowPanMouseDown = useCallback((event, txId) => {
    if (event.button !== 0) return
    const win = rowWindowById[txId]
    if (!win) return
    const tx = transcriptById.get(txId)
    const strand = String(tx?.strand || '+')
    event.preventDefault()
    const startX = event.clientX
    const startCoord = win.start

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX
      const deltaBases = (sequenceType === 'genomic' && strand === '-')
        ? Math.round(dx / BASE_CELL_WIDTH)
        : Math.round((-dx) / BASE_CELL_WIDTH)
      setModeStart(txId, startCoord + deltaBases)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rowWindowById, setModeStart, sequenceType, transcriptById])

  const rowInsertLineColor = isLight ? 'rgba(59, 130, 246, 0.75)' : 'rgba(125, 211, 252, 0.8)'

  useEffect(() => {
    if (!copyToast) return undefined
    const timer = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(timer)
  }, [copyToast])

  const copyToClipboard = useCallback(async (text, label) => {
    const payload = String(text || '').trim()
    if (!payload) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload)
        setCopyToast(`Copied ${label}`)
      } else {
        setCopyToast('Clipboard unavailable')
      }
    } catch {
      setCopyToast('Copy failed')
    }
  }, [])

  const fetchFullModeSequenceForTx = useCallback(async (txId) => {
    const bounds = getCoordBoundsForTx(txId, false)
    const coordMin = Math.max(1, Math.round(Number(bounds?.min || 1)))
    const coordMax = Math.max(coordMin, Math.round(Number(bounds?.max || coordMin)))
    const chunks = []
    const CHUNK_SIZE = 50000
    for (let start = coordMin; start <= coordMax; start += CHUNK_SIZE) {
      const end = Math.min(coordMax, start + CHUNK_SIZE - 1)
      const res = await fetch(`${API_BASE}/api/feature_explorer/sequences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genome: sequenceGenome || 'reference',
          sequence_type: sequenceType,
          include_features: false,
          rows: [{ transcript_id: txId, window_start: start, window_end: end }],
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { status: 'error', message: data?.detail || 'Failed to fetch full sequence', sequence: '' }
      }
      const row = Array.isArray(data?.rows) ? data.rows[0] : null
      const status = String(row?.status || 'error')
      if (status === 'no_cds') {
        return { status: 'no_cds', message: 'No CDS is defined for this transcript', sequence: '' }
      }
      if (status !== 'ok') {
        return { status: status || 'error', message: String(row?.message || 'Sequence unavailable'), sequence: '' }
      }
      chunks.push(String(row?.sequence || ''))
    }
    return { status: 'ok', message: '', sequence: chunks.join('') }
  }, [getCoordBoundsForTx, sequenceGenome, sequenceType])

  const copyFullSequenceForTx = useCallback(async (txId) => {
    setCopyToast('Copying sequence...')
    const result = await fetchFullModeSequenceForTx(txId)
    if (result.status === 'no_cds') {
      setCopyToast('No CDS to copy')
      return
    }
    if (result.status !== 'ok') {
      setCopyToast(result.message || 'Copy failed')
      return
    }
    await copyToClipboard(result.sequence, `${sequenceType} sequence (${txId})`)
  }, [fetchFullModeSequenceForTx, copyToClipboard, sequenceType])

  const togglePanelCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  return (
    <div className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={togglePanelCollapsed}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            togglePanelCollapsed()
          }
        }}
        className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
      >
        <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>Transcript sequences</div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            togglePanelCollapsed()
          }}
          className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
            ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
            : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
            }`}
          title={collapsed ? 'Expand transcript sequences panel' : 'Collapse transcript sequences panel'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {collapsed
              ? <polyline points="6 9 12 15 18 9" />
              : <polyline points="18 15 12 9 6 15" />}
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div
          className="grid min-h-[220px] transition-[grid-template-columns] duration-300 ease-out"
          style={{ gridTemplateColumns: `minmax(0,1fr) ${menuCollapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH}px` }}
        >
          {/* Left header: control buttons */}
          <div className={`px-3 py-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <div className={`inline-flex items-center rounded-md border overflow-hidden ${isLight ? 'border-gray-300' : 'border-gray-600'}`}>
                {['transcript', 'cds', 'genomic'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleTypeChange(mode)}
                    className={`px-2.5 py-1 text-[11px] font-semibold border-r last:border-r-0 ${sequenceType === mode
                      ? (isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/80 text-white border-sky-400/80')
                      : (isLight ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50' : 'bg-gray-800 text-gray-300 border-gray-600 hover:bg-gray-700')
                      }`}
                  >
                    {mode === 'genomic' ? 'Genomic' : mode === 'transcript' ? 'Transcript' : 'CDS'}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setLockPanAcrossRows((prev) => !prev)}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${lockPanAcrossRows
                  ? (isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80')
                  : (isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                  }`}
                title="Lock panning across all active sequence rows"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Pan
              </button>

              <button
                type="button"
                onClick={() => {
                  if (sequenceType !== 'genomic') return
                  setAlignByGenomicCoords((prev) => {
                    const next = !prev
                    setLockPanAcrossRows(next)
                    return next
                  })
                }}
                disabled={sequenceType !== 'genomic'}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${sequenceType !== 'genomic'
                  ? (isLight ? 'bg-gray-100 text-gray-400 border-gray-300' : 'bg-gray-800 text-gray-500 border-gray-700')
                  : alignByGenomicCoords
                    ? (isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80')
                    : (isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                  }`}
                title={sequenceType !== 'genomic' ? 'Available only in Genomic mode' : 'Align positions by genomic coordinates (auto-lock pan)'}
              >
                Align coordinates
              </button>

              <button
                type="button"
                onClick={() => {
                  setFeatureEnabled((prev) => {
                    const enabled = Object.values(prev).some(Boolean)
                    const nextValue = !enabled
                    return {
                      exon: nextValue,
                      cds: nextValue,
                      utr: nextValue,
                      intron: nextValue,
                      splice: nextValue,
                      start_codon: nextValue,
                      stop_codon: nextValue,
                    }
                  })
                }}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${anyFeatureEnabled
                  ? (isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80')
                  : (isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                  }`}
                title="Toggle feature-based coloring on sequence rows"
              >
                Features
              </button>
            </div>
            {fetchError && (
              <div className={`mt-2 text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                {fetchError}
              </div>
            )}
          </div>

          {/* Right header: Transcript activity */}
          <div className={`px-2 py-3 border-b border-l ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            <div className={`flex items-start justify-between gap-1 ${menuCollapsed ? 'h-full' : ''}`}>
              {!menuCollapsed && (
                <div>
                  <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                    Transcript activity
                  </div>
                  <div className={`text-[11px] mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    Active: {activeCount} | Inactive: {inactiveCount}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => setMenuCollapsed((prev) => !prev)}
                className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                  ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                  : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                  } ${menuCollapsed ? 'mx-auto mt-1' : ''}`}
                title={menuCollapsed ? 'Expand transcript list' : 'Collapse transcript list'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  {menuCollapsed
                    ? <polyline points="15 6 9 12 15 18" />
                    : <polyline points="9 6 15 12 9 18" />}
                </svg>
              </button>
            </div>
            {!menuCollapsed && (
              <div className="flex items-center gap-2 pt-2 pb-2">
                <button
                  type="button"
                  onClick={setAllVisible}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${activeActionButtonClass}`}
                  title={allActive ? 'Deactivate every transcript in the list' : 'Activate every transcript in the list'}
                >
                  {allActive ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  type="button"
                  onClick={() => setCollapseInactiveRows((prev) => !prev)}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${isLight
                    ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                    }`}
                  title={collapseInactiveRows ? 'Show the full list of inactive transcripts' : 'Hide inactive transcripts from this view'}
                >
                  {collapseInactiveRows ? 'Show inactive' : 'Hide inactive'}
                </button>
                <button
                  type="button"
                  onClick={restoreDefaultOrdering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${isLight
                    ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                    }`}
                  title="Restore default transcript order and default active set"
                >
                  Default
                </button>
              </div>
            )}
          </div>

          {/* Left content: sequence rows + slider + minimap + feature overlay */}
          <div ref={measureRef}>
            {rowModels.length === 0 ? (
              <div className={`h-[220px] flex items-center justify-center text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Activate at least one transcript to render sequence rows.
              </div>
            ) : (
              rowModels.map((model) => {
                const { txId, tx, isActive, rowData, loading, height } = model

                let topFeatures = new Array(basesPerWindow).fill('')
                if (anyFeatureEnabled && rowData.status === 'ok') {
                  const windowStart = rowWindowById[txId]?.start || 1
                  const windowEnd = rowWindowById[txId]?.end || (windowStart + basesPerWindow - 1)
                  const cdsFrameOffset = getCdsFrameOffset(tx)
                  let cdsCoordForDisplayIndex = null
                  const mapGenomicToCdsCoord = buildGenomicToCdsCoordMapper(tx)
                  if (mapGenomicToCdsCoord) {
                    const rowStrand = rowData.strand || '+'
                    if (sequenceType === 'genomic') {
                      cdsCoordForDisplayIndex = (displayIndexZeroBased) => {
                        const offset = Number(displayIndexZeroBased)
                        if (!Number.isFinite(offset)) return null
                        const genomicCoord = rowStrand === '-'
                          ? (windowEnd - offset)
                          : (windowStart + offset)
                        return mapGenomicToCdsCoord(genomicCoord)
                      }
                    } else if (sequenceType === 'transcript') {
                      const mapTranscriptCoordToGenomic = buildCoordToGenomicMapper(tx, 'transcript')
                      if (mapTranscriptCoordToGenomic) {
                        cdsCoordForDisplayIndex = (displayIndexZeroBased) => {
                          const offset = Number(displayIndexZeroBased)
                          if (!Number.isFinite(offset)) return null
                          const transcriptCoord = windowStart + offset
                          const genomicCoord = mapTranscriptCoordToGenomic(transcriptCoord)
                          if (!Number.isFinite(genomicCoord)) return null
                          return mapGenomicToCdsCoord(genomicCoord)
                        }
                      }
                    } else if (sequenceType === 'cds') {
                      cdsCoordForDisplayIndex = (displayIndexZeroBased) => {
                        const offset = Number(displayIndexZeroBased)
                        if (!Number.isFinite(offset)) return null
                        return windowStart + offset
                      }
                    }
                  }
                  topFeatures = buildTopFeatureByPosition(
                    basesPerWindow,
                    Array.isArray(rowData.features) ? rowData.features : [],
                    featureEnabled,
                    windowStart,
                    sequenceType,
                    rowData.strand || '+',
                    cdsCoordForDisplayIndex,
                    cdsFrameOffset,
                  )
                }

                return (
                  <div
                    key={`seq-row-${txId}`}
                    className={`px-2 border-b select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                    onMouseEnter={() => { hoveredRowRef.current = txId }}
                    onMouseLeave={() => { hoveredRowRef.current = null }}
                    onMouseDown={(event) => {
                      if (!isActive || loading || rowData.status !== 'ok') return
                      handleRowPanMouseDown(event, txId)
                    }}
                    style={{ height: `${height}px`, cursor: (isActive && !loading && rowData.status === 'ok') ? 'grab' : 'default' }}
                  >
                    {!isActive ? (
                      <div className={`h-full flex items-center text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                        Inactive
                      </div>
                    ) : loading ? (
                      <div className={`h-full flex items-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Loading sequence...
                      </div>
                    ) : rowData.status === 'no_cds' ? (
                      <div className={`h-full flex items-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        No CDS
                      </div>
                    ) : rowData.status !== 'ok' ? (
                      <div className={`h-full flex items-center text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                        {rowData.message || 'Sequence unavailable'}
                      </div>
                    ) : (() => {
                      // Build the set of display indices (0-based) whose right border is an exon junction.
                      const winStart = rowWindowById[txId]?.start || 1
                      const winEnd = rowWindowById[txId]?.end || (winStart + basesPerWindow - 1)
                      const exonBoundarySet = new Set()
                      const selectedExonMask = new Set()
                      if (sequenceType !== 'genomic') {
                        const minimapModel = minimapDataByTxId[txId]
                        if (minimapModel) {
                          const { modeSegs: segs } = minimapModel
                          for (let si = 0; si < segs.length - 1; si++) {
                            const di = segs[si].coordEnd - winStart // 0-based display index
                            if (di >= 0 && di < basesPerWindow) exonBoundarySet.add(di)
                          }
                        }
                      }
                      if (selectedExon?.exonStateKey && selectedExon.chrom) {
                        const selectedRanges = projectGenomicIntervalToDisplayRanges({
                          tx,
                          sequenceType,
                          strand: rowData.strand || '+',
                          windowStart: winStart,
                          windowEnd: winEnd,
                          length: basesPerWindow,
                          genomicStart: selectedExon.start,
                          genomicEnd: selectedExon.end,
                        })
                        for (const range of selectedRanges) {
                          for (let i = range.start - 1; i <= range.end - 1; i += 1) {
                            if (i >= 0 && i < basesPerWindow) selectedExonMask.add(i)
                          }
                        }
                      }
                      return (
                        <div className="h-full flex items-center gap-1.5 overflow-hidden">
                          <button
                            type="button"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              copyFullSequenceForTx(txId)
                            }}
                            className={`w-6 h-6 shrink-0 rounded border flex items-center justify-center transition-colors ${isLight
                              ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                              : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                              }`}
                            title={`Copy full ${sequenceType} sequence`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="5" y="5" width="14" height="16" rx="2.2" />
                              <path d="M9 3h6v4H9z" />
                            </svg>
                          </button>
                          <div className="h-full flex items-center overflow-hidden w-full">
                          {Array.from(rowData.sequence || '').map((rawBase, idx) => {
                            const normalized = normalizeBase(rawBase)
                            const featureType = topFeatures[idx]
                            const hasFeatureOverlay = Boolean(anyFeatureEnabled && featureType && FEATURE_TYPE_TO_COLOR[featureType])
                            const bg = hasFeatureOverlay
                              ? FEATURE_TYPE_TO_COLOR[featureType]
                              : 'transparent'
                            const textColor = hasFeatureOverlay
                              ? (hexLuminance(bg) > 0.64 ? '#0f172a' : '#ffffff')
                              : GENOMIC_BASE_TEXT
                            const isBoundary = exonBoundarySet.has(idx)
                            const isSelectedExonBase = selectedExonMask.has(idx)
                            return (
                              <div
                                key={`base-${txId}-${idx}`}
                                className={`h-[26px] flex items-center justify-center text-[10px] font-mono ${isBoundary ? '' : (isLight ? 'border-r border-white/55' : 'border-r border-black/15')}`}
                                style={{
                                  width: `${BASE_CELL_WIDTH}px`,
                                  backgroundColor: bg,
                                  color: textColor,
                                  ...(!hasFeatureOverlay ? { boxShadow: `inset 0 0 0 1px ${GENOMIC_BASE_OUTLINE}` } : {}),
                                  ...(isBoundary ? { borderRight: '2.5px solid #f59e0b' } : {}),
                                  ...(isSelectedExonBase ? {
                                    boxShadow: isLight
                                      ? 'inset 0 0 0 1.2px rgba(2, 132, 199, 0.95)'
                                      : 'inset 0 0 0 1.2px rgba(125, 211, 252, 0.95)',
                                  } : {}),
                                }}
                                onMouseEnter={isBoundary ? (e) => {
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setBoundaryTooltip({ label: 'Exon boundary', x: rect.left + rect.width / 2, y: rect.top })
                                } : undefined}
                                onMouseLeave={isBoundary ? () => setBoundaryTooltip(null) : undefined}
                                title={`Pos ${idx + 1}: ${normalized}${featureType ? ` (${featureType})` : ''}${isBoundary ? ' | Exon boundary' : ''}`}
                              >
                                {normalized}
                              </div>
                            )
                          })}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })
            )}
            {activeDisplayIds.length > 0 && (
              <div className={`px-2 py-1.5 border-t space-y-2 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <div>
                  <input
                    type="range"
                    min={panScrollModel.minStart}
                    max={panScrollModel.maxStart}
                    step={1}
                    value={sliderValueFromStart(panScrollModel.currentStart)}
                    disabled={panScrollModel.disabled}
                    onChange={(event) => handleBottomScrollbarPan(event.target.value)}
                    className="w-full h-2 cursor-pointer"
                    title="Scroll sequence window"
                  />
                </div>

                <div className={`rounded border px-2 py-1 ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-900/40 border-gray-700'}`}>
                  {activeDisplayIds.map((txId) => {
                    const model = minimapDataByTxId[txId]
                    if (!model) return null
                    const { txMin, txMax, overlayIntervals, modeSegs, totalLength, codonMarkers } = model
                    const hovered = hoveredMinimapExon.txId === txId ? hoveredMinimapExon.exonIndex : -1
                    const txStartX = mapGenomicCoordToMinimap(txMin)
                    const txEndX = mapGenomicCoordToMinimap(txMax)
                    const lineColor = isLight ? '#94a3b8' : '#475569'
                    const exonStrokeColor = isLight ? '#2563eb' : '#93c5fd'
                    const codingFill = isLight ? '#60a5fa' : '#3b82f6'
                    const altCodingFill = isLight ? '#a78bfa' : '#818cf8'

                    // Backbone line: animated from genomic span → compressed span
                    const genoLineX1 = Math.min(txStartX, txEndX)
                    const genoLineX2 = Math.max(txStartX, txEndX)
                    const compLineX2 = mapCompressedToMinimap(totalLength, maxCompressedLength)
                    const lineX1 = genoLineX1 + (2 - genoLineX1) * minimapAnimProgress
                    const lineX2 = genoLineX2 + (compLineX2 - genoLineX2) * minimapAnimProgress

                    // Overlay rect: animated from genomic overlay span → compressed window span
                    const win = rowWindowById[txId]
                    const genoOvX1 = overlayIntervals.length > 0
                      ? Math.min(...overlayIntervals.map((o) => Math.min(mapGenomicCoordToMinimap(o.start), mapGenomicCoordToMinimap(o.end))))
                      : lineX1
                    const genoOvX2 = overlayIntervals.length > 0
                      ? Math.max(...overlayIntervals.map((o) => Math.max(mapGenomicCoordToMinimap(o.start), mapGenomicCoordToMinimap(o.end))))
                      : lineX1
                    const compOvX1 = win ? mapCompressedToMinimap(win.start - 1, maxCompressedLength) : genoOvX1
                    const compOvX2 = win ? mapCompressedToMinimap(win.end, maxCompressedLength) : genoOvX2
                    const ovX1 = genoOvX1 + (compOvX1 - genoOvX1) * minimapAnimProgress
                    const ovX2 = genoOvX2 + (compOvX2 - genoOvX2) * minimapAnimProgress

                    return (
                      <div key={`minimap-${txId}`} className="h-6 relative">
                        <svg viewBox="0 0 1000 24" className="w-full h-6" preserveAspectRatio="none" style={{ cursor: 'pointer' }} onClick={(event) => handleMinimapClick(event, txId)}>
                          <line
                            x1={lineX1}
                            y1="12"
                            x2={lineX2}
                            y2="12"
                            stroke={lineColor}
                            strokeWidth="1.2"
                            strokeLinecap="round"
                          />
                          {overlayIntervals.length > 0 && (
                            <rect
                              x={Math.min(ovX1, ovX2)}
                              y="2.5"
                              width={Math.max(2, Math.abs(ovX2 - ovX1))}
                              height="19"
                              fill={isLight ? 'rgba(14,165,233,0.18)' : 'rgba(125,211,252,0.22)'}
                              stroke={isLight ? 'rgba(2,132,199,0.72)' : 'rgba(56,189,248,0.82)'}
                              strokeWidth="0.8"
                            />
                          )}
                          {/* Exon fill rects — no hover highlight; SVG title gives name tooltip */}
                          {modeSegs.map((seg, segIndex) => {
                            const gx1 = Math.min(mapGenomicCoordToMinimap(seg.genomicStart), mapGenomicCoordToMinimap(seg.genomicEnd))
                            const gx2 = Math.max(mapGenomicCoordToMinimap(seg.genomicStart), mapGenomicCoordToMinimap(seg.genomicEnd))
                            const cx1 = mapCompressedToMinimap(seg.coordStart - 1, maxCompressedLength)
                            const cx2 = mapCompressedToMinimap(seg.coordEnd, maxCompressedLength)
                            const x = gx1 + (cx1 - gx1) * minimapAnimProgress
                            const x2 = gx2 + (cx2 - gx2) * minimapAnimProgress
                            const w = Math.max(1, x2 - x)
                            const exonLabel = sequenceType === 'cds' ? `CDS Exon ${segIndex + 1}` : `Exon ${segIndex + 1}`
                            return (
                              <rect key={`mseg-${txId}-${segIndex}`} x={x} y="7" width={w} height="10"
                                fill={codingFill} fillOpacity={0.78} stroke="none">
                                <title>{exonLabel}</title>
                              </rect>
                            )
                          })}
                          {/* Exon boundary lines — tall, amber, highlight + click on hover */}
                          {sequenceType !== 'genomic' && modeSegs.slice(0, -1).map((seg, segIndex) => {
                            const cgx = mapGenomicCoordToMinimap(seg.genomicEnd)
                            const ccx = mapCompressedToMinimap(seg.coordEnd, maxCompressedLength)
                            const bx = cgx + (ccx - cgx) * minimapAnimProgress
                            const isHov = minimapMarkerHover?.txId === txId && minimapMarkerHover?.markerType === 'boundary' && minimapMarkerHover?.idx === segIndex
                            return (
                              <g key={`boundary-${txId}-${segIndex}`}>
                                <line x1={bx} y1="2" x2={bx} y2="22" stroke={isHov ? '#fbbf24' : '#f59e0b'} strokeWidth={isHov ? '2.5' : '1.5'} strokeLinecap="round" />
                                {/* Wide transparent hit-target for easy hover/click */}
                                <rect x={bx - 5} y="0" width="10" height="24" fill="transparent" style={{ cursor: 'pointer' }}
                                  onMouseEnter={(e) => { e.stopPropagation(); setMinimapMarkerHover({ txId, markerType: 'boundary', idx: segIndex }) }}
                                  onMouseLeave={() => setMinimapMarkerHover(null)}
                                  onClick={(e) => handleMinimapMarkerClick(e, txId, seg.coordEnd)}
                                />
                              </g>
                            )
                          })}
                          {/* Start codon marker — teal, highlight + click */}
                          {sequenceType !== 'genomic' && codonMarkers?.startCoord != null && (() => {
                            const cx = mapCompressedToMinimap(codonMarkers.startCoord - 1, maxCompressedLength)
                            const gx = mapGenomicCoordToMinimap(codonMarkers.startGenomic)
                            const x = gx + (cx - gx) * minimapAnimProgress
                            const isHov = minimapMarkerHover?.txId === txId && minimapMarkerHover?.markerType === 'start'
                            return (
                              <g key="start-codon-marker">
                                <line x1={x} y1="2" x2={x} y2="22" stroke={isHov ? '#14b8a6' : '#0d9488'} strokeWidth={isHov ? '3' : '2.5'} strokeLinecap="round" />
                                <rect x={x - 5} y="0" width="10" height="24" fill="transparent" style={{ cursor: 'pointer' }}
                                  onMouseEnter={(e) => { e.stopPropagation(); setMinimapMarkerHover({ txId, markerType: 'start', idx: 0 }) }}
                                  onMouseLeave={() => setMinimapMarkerHover(null)}
                                  onClick={(e) => handleMinimapMarkerClick(e, txId, codonMarkers.startCoord)}
                                />
                              </g>
                            )
                          })()}
                          {/* Stop codon marker — fuchsia, highlight + click */}
                          {sequenceType !== 'genomic' && codonMarkers?.stopCoord != null && (() => {
                            const cx = mapCompressedToMinimap(codonMarkers.stopCoord, maxCompressedLength)
                            const gx = mapGenomicCoordToMinimap(codonMarkers.stopGenomic)
                            const x = gx + (cx - gx) * minimapAnimProgress
                            const isHov = minimapMarkerHover?.txId === txId && minimapMarkerHover?.markerType === 'stop'
                            return (
                              <g key="stop-codon-marker">
                                <line x1={x} y1="2" x2={x} y2="22" stroke={isHov ? '#d946ef' : '#c026d3'} strokeWidth={isHov ? '3' : '2.5'} strokeLinecap="round" />
                                <rect x={x - 5} y="0" width="10" height="24" fill="transparent" style={{ cursor: 'pointer' }}
                                  onMouseEnter={(e) => { e.stopPropagation(); setMinimapMarkerHover({ txId, markerType: 'stop', idx: 0 }) }}
                                  onMouseLeave={() => setMinimapMarkerHover(null)}
                                  onClick={(e) => handleMinimapMarkerClick(e, txId, codonMarkers.stopCoord)}
                                />
                              </g>
                            )
                          })()}
                        </svg>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Feature overlay - below minimap */}
            <div className={`px-2 py-1.5 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <div className={`rounded border overflow-hidden ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <button
                  type="button"
                  onClick={() => setFeatureOverlayCollapsed((prev) => !prev)}
                  className={`w-full px-2.5 py-1.5 text-[11px] font-semibold border-b flex items-center justify-between ${isLight
                    ? 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                    : 'bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700'
                    }`}
                >
                  <span>Feature overlay</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    {featureOverlayCollapsed
                      ? <polyline points="6 9 12 15 18 9" />
                      : <polyline points="18 15 12 9 6 15" />}
                  </svg>
                </button>
                {!featureOverlayCollapsed && (
                  <div className="p-1.5 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-1.5">
                    {FEATURE_GROUPS.map((group) => {
                      if (group.readOnly) {
                        return (
                          <div
                            key={group.key}
                            className={`px-2 py-1 rounded text-[11px] border flex items-center gap-1.5 ${isLight
                              ? 'bg-gray-50 text-gray-700 border-gray-300'
                              : 'bg-gray-800 text-gray-300 border-gray-600'
                              }`}
                            title="Underlying sequence style when no feature overlay is present"
                          >
                            <span
                              className={`inline-block w-2.5 h-2.5 rounded shrink-0 ${isLight ? 'ring-1 ring-black/20' : 'ring-1 ring-white/35'}`}
                              style={{
                                background: 'transparent',
                                border: `1px solid ${group.color}`,
                              }}
                            />
                            <span className="truncate">{group.label}</span>
                          </div>
                        )
                      }
                      const enabled = Boolean(featureEnabled[group.key])
                      return (
                        <button
                          key={group.key}
                          type="button"
                          onClick={() => {
                            setFeatureEnabled((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                          }}
                          className={`px-2 py-1 rounded text-[11px] border flex items-center gap-1.5 ${enabled
                            ? (isLight ? 'bg-white text-gray-800 border-gray-300' : 'bg-gray-700 text-gray-100 border-gray-500')
                            : (isLight ? 'bg-gray-50 text-gray-500 border-gray-300' : 'bg-gray-800 text-gray-400 border-gray-600')
                            }`}
                          title={`Toggle ${group.label} coloring`}
                        >
                          <span
                            className={`inline-block w-2.5 h-2.5 rounded shrink-0 ${isLight ? 'ring-1 ring-black/20' : 'ring-1 ring-white/35'}`}
                            style={{ background: enabled ? (group.gradient ?? group.color) : (isLight ? '#9ca3af' : '#6b7280') }}
                          />
                          <span className="truncate">{group.label}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right content: ID buttons */}
          <div className={`border-l ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            {!menuCollapsed && rowModels.map((model) => {
              const { txId, tx, isActive, height } = model
              const tagInfo = transcriptTagInfoById[txId] || { hasCanonical: false, hasManeSelect: false }
              const showCanonicalLabel = Boolean(tagInfo.hasCanonical)
              const showManeSelectLabel = Boolean(tagInfo.hasManeSelect)
              const isDragSource = dragSourceId === txId || mouseDownId === txId
              const isInsertTarget = insertTargetId === txId && dragSourceId !== txId

              return (
                <div
                  key={`seq-menu-${txId}`}
                  className={`px-2 border-b flex items-center ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                  draggable
                  onMouseDown={() => onTranscriptMouseDown?.(txId)}
                  onMouseUp={onTranscriptMouseUp}
                  onMouseLeave={onTranscriptMouseUp}
                  onDragStart={(event) => onTranscriptDragStart?.(event, txId)}
                  onDragOver={(event) => onTranscriptDragOver?.(event, txId)}
                  onDragEnter={(event) => onTranscriptDragOver?.(event, txId)}
                  onDrop={(event) => onTranscriptDrop?.(event, txId)}
                  onDragEnd={onTranscriptDragEnd}
                  style={{
                    boxShadow: isInsertTarget
                      ? (insertPosition === 'before'
                        ? `inset 0 2px 0 ${rowInsertLineColor}`
                        : `inset 0 -2px 0 ${rowInsertLineColor}`)
                      : 'none',
                    height: `${height}px`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleTranscript?.(txId)}
                    className={`w-full h-[34px] rounded px-2 text-left text-xs border transition-colors ${isActive
                      ? (isLight
                        ? 'bg-[#63acd8]/12 text-[#3f7696] border-[#559dc8] hover:bg-[#63acd8]/20'
                        : 'bg-sky-400/14 text-sky-100 border-sky-300/60 hover:bg-sky-400/22')
                      : (isLight
                        ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                        : 'bg-gray-900/50 text-gray-300 border-gray-600 hover:bg-gray-700')
                      }`}
                    style={{
                      boxShadow: isDragSource
                        ? (isLight ? '0 0 0 2px rgba(59,130,246,0.8) inset' : '0 0 0 2px rgba(125,211,252,0.8) inset')
                        : 'none',
                    }}
                    title={tx.id}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono truncate">{transcriptDisplayId(tx.id)}</span>
                      {(showCanonicalLabel || showManeSelectLabel) && (
                        <span className="shrink-0 inline-flex flex-col items-start gap-0.5">
                          {showCanonicalLabel && (
                            <span className={`text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                              canonical
                            </span>
                          )}
                          {showManeSelectLabel && (
                            <span className={`text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/30 text-emerald-400'}`}>
                              MANE select
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {boundaryTooltip && (
        <div
          className="fixed z-[9999] pointer-events-none px-2 py-1 rounded text-[11px] font-semibold whitespace-nowrap shadow-lg"
          style={{
            left: boundaryTooltip.x,
            top: boundaryTooltip.y - 6,
            transform: 'translate(-50%, -100%)',
            background: isLight ? '#1e293b' : '#f1f5f9',
            color: isLight ? '#f1f5f9' : '#1e293b',
            border: `1px solid ${isLight ? '#f59e0b' : '#f59e0b'}`,
          }}
        >
          Exon boundary
        </div>
      )}
      {copyToast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[150] rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-xl ${isLight
          ? 'bg-white border-sky-300 text-sky-800'
          : 'bg-gray-800 border-sky-500/70 text-sky-200'
          }`}>
          {copyToast}
        </div>
      )}
    </div>
  )
}

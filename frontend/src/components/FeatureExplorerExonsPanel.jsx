import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseExonStateKey } from './featureExplorerExonUtils'
import { FEATURE_COLORS } from './FeatureLegend'

import { API_BASE } from '../backendRuntime'

const STATE_META = {
  coding: {
    label: 'coding',
    bgLight: 'rgba(59, 130, 246, 0.18)',
    bgDark: 'rgba(59, 130, 246, 0.24)',
    borderLight: 'rgba(37, 99, 235, 0.8)',
    borderDark: 'rgba(125, 211, 252, 0.85)',
  },
  partial_coding: {
    label: 'partial',
    bgLight: 'rgba(245, 158, 11, 0.2)',
    bgDark: 'rgba(251, 191, 36, 0.24)',
    borderLight: 'rgba(217, 119, 6, 0.84)',
    borderDark: 'rgba(252, 211, 77, 0.86)',
  },
  non_coding: {
    label: 'non-coding',
    bgLight: 'transparent',
    bgDark: 'transparent',
    borderLight: 'rgba(148, 163, 184, 0.78)',
    borderDark: 'rgba(148, 163, 184, 0.86)',
  },
  absent: {
    label: 'absent',
    bgLight: 'rgba(148, 163, 184, 0.1)',
    bgDark: 'rgba(51, 65, 85, 0.55)',
    borderLight: 'rgba(148, 163, 184, 0.44)',
    borderDark: 'rgba(71, 85, 105, 0.72)',
  },
}

function transcriptDisplayId(rawId) {
  const text = String(rawId || '')
  if (text.length <= 20) return text
  return `${text.slice(0, 17)}...`
}

function formatCoord(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

function formatPercent(value, digits = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0.0%'
  return `${(n * 100).toFixed(digits)}%`
}

function roundTo(value, digits = 2) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(digits))
}

function orientedBoundaryPair(start, end, strand) {
  const lo = Math.min(Number(start || 0), Number(end || 0))
  const hi = Math.max(Number(start || 0), Number(end || 0))
  if (String(strand || '+') === '-') {
    return { fivePrime: hi, threePrime: lo }
  }
  return { fivePrime: lo, threePrime: hi }
}

function median(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  if (nums.length === 0) return 0
  const mid = Math.floor(nums.length / 2)
  if (nums.length % 2 === 1) return nums[mid]
  return (nums[mid - 1] + nums[mid]) / 2
}

function useAbortableFetch() {
  const controllerRef = useRef(null)

  const abortCurrent = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      controllerRef.current = null
    }
  }, [])

  const makeController = useCallback(() => {
    abortCurrent()
    const controller = new AbortController()
    controllerRef.current = controller
    return controller
  }, [abortCurrent])

  useEffect(() => () => abortCurrent(), [abortCurrent])

  return { makeController, abortCurrent }
}

const EXON_DETAIL_BASE_COLORS = {
  A: '#0b3c8a',
  C: '#1f5fbf',
  G: '#4d87d9',
  T: '#9ec5f8',
  N: '#6b7280',
}
const EXON_DETAIL_GENOMIC_TEXT = '#60a5fa'
const EXON_DETAIL_GENOMIC_OUTLINE = 'rgba(96, 165, 250, 0.88)'
const EXON_DETAIL_CDS_STRIPE_COLORS = ['#60a5fa', '#bfdbfe']

const EXON_DETAIL_FEATURE_PRIORITY = [
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

const EXON_DETAIL_FEATURE_TYPE_TO_COLOR = {
  exon: FEATURE_COLORS.exon.bg,
  cds: FEATURE_COLORS.cds.bg,
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

const EXON_DETAIL_FEATURE_LEGEND = [
  { key: 'genomic', label: 'Genomic', bg: FEATURE_COLORS.genomic?.bg || '#60a5fa', outlineOnly: true },
  { key: 'exon', label: 'Exon', bg: FEATURE_COLORS.exon.bg },
  { key: 'cds', label: 'CDS', bg: FEATURE_COLORS.cds.bg, gradient: 'linear-gradient(90deg, #60a5fa 50%, #bfdbfe 50%)' },
  { key: 'utr', label: 'UTR', bg: FEATURE_COLORS.utr.bg },
  { key: 'intron', label: 'Intronic', bg: FEATURE_COLORS.intron.bg },
  { key: 'splice', label: 'Splice site', bg: FEATURE_COLORS.splice.bg },
  { key: 'start_codon', label: 'Start (ATG)', bg: FEATURE_COLORS.start_codon.bg },
  { key: 'stop_codon', label: 'Stop', bg: FEATURE_COLORS.stop_codon.bg },
]

function normalizeBase(base) {
  const up = String(base || '').toUpperCase()
  if (up === 'A' || up === 'C' || up === 'G' || up === 'T') return up
  return 'N'
}

function hexLuminance(hexColor) {
  const hex = String(hexColor || '').replace('#', '')
  if (hex.length !== 6) return 0
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
}

function buildTopFeatureByPosition(length, slices) {
  const out = new Array(Math.max(0, Number(length) || 0)).fill('')
  if (!Array.isArray(slices) || slices.length === 0 || out.length === 0) return out
  for (const type of EXON_DETAIL_FEATURE_PRIORITY) {
    for (const slice of slices) {
      const sliceType = String(slice?.type || '')
      if (sliceType !== type) continue
      const start = Math.max(1, Number(slice?.start || 1))
      const end = Math.min(out.length, Number(slice?.end || 0))
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
      for (let idx = start - 1; idx <= end - 1; idx += 1) {
        if (!out[idx]) out[idx] = sliceType
      }
    }
  }
  return out
}

function buildCdsStripeMapForExonDetail(seq, slices) {
  const list = Array.isArray(slices) ? slices : []
  const cdsRanges = list
    .filter((slice) => String(slice?.type || '') === 'cds')
    .map((slice) => {
      const s = Number(slice?.start)
      const e = Number(slice?.end)
      if (!Number.isFinite(s) || !Number.isFinite(e)) return null
      return { start: Math.min(s, e), end: Math.max(s, e) }
    })
    .filter(Boolean)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
  if (cdsRanges.length === 0) return null

  const starts = list
    .filter((slice) => String(slice?.type || '') === 'start_codon')
    .map((slice) => {
      const s = Number(slice?.start)
      const e = Number(slice?.end)
      if (!Number.isFinite(s) || !Number.isFinite(e)) return null
      return { start: Math.min(s, e), end: Math.max(s, e) }
    })
    .filter(Boolean)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))

  let anchor = null
  for (const sc of starts) {
    const codon = String(seq?.substring(sc.start - 1, sc.end) || '').toUpperCase()
    if (codon !== 'ATG') continue
    const inside = cdsRanges.some((r) => sc.start >= r.start && sc.end <= r.end)
    if (inside) {
      anchor = sc.start
      break
    }
  }
  if (anchor == null) anchor = cdsRanges[0].start

  const stripeMap = new Map()
  let cdsBaseIndex = 0
  let started = false
  for (const range of cdsRanges) {
    for (let pos = range.start; pos <= range.end; pos += 1) {
      if (!started) {
        if (pos < anchor) continue
        started = true
      }
      const codonPhase = Math.floor(cdsBaseIndex / 3) % 2
      stripeMap.set(pos, EXON_DETAIL_CDS_STRIPE_COLORS[codonPhase])
      cdsBaseIndex += 1
    }
  }
  return stripeMap
}

function sequencePreview(sequenceInfo, isLight) {
  const seq = String(sequenceInfo?.sequence || '').toUpperCase()
  const start = Math.max(1, Number(sequenceInfo?.exon_start_index || 1))
  const end = Math.max(start, Number(sequenceInfo?.exon_end_index || start))
  const features = Array.isArray(sequenceInfo?.features) ? sequenceInfo.features : []
  const topFeatures = buildTopFeatureByPosition(seq.length, features)
  const cdsStripeMap = buildCdsStripeMapForExonDetail(seq, features)

  return (
    <div className={`rounded border px-2 py-2 ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-900/45 border-gray-700'}`}>
      <div className="flex flex-wrap items-center">
        {Array.from(seq).map((rawBase, idx) => {
          const normalized = normalizeBase(rawBase)
          const featureType = topFeatures[idx]
          const cdsStripe = featureType === 'cds' && cdsStripeMap?.has(idx + 1)
            ? cdsStripeMap.get(idx + 1)
            : null
          const bg = featureType
            ? (cdsStripe || EXON_DETAIL_FEATURE_TYPE_TO_COLOR[featureType] || EXON_DETAIL_BASE_COLORS[normalized] || EXON_DETAIL_BASE_COLORS.N)
            : 'transparent'
          const textColor = featureType
            ? (hexLuminance(bg) > 0.64 ? '#0f172a' : '#ffffff')
            : EXON_DETAIL_GENOMIC_TEXT
          const inSelectedExon = (idx + 1) >= start && (idx + 1) <= end
          return (
            <div
              key={`exon-detail-base-${idx}`}
              className={`h-[24px] min-w-[12px] px-[1px] flex items-center justify-center text-[10px] font-mono ${isLight ? 'border-r border-white/55' : 'border-r border-black/15'}`}
              style={{
                backgroundColor: bg,
                color: textColor,
                ...(featureType ? {} : {
                  boxShadow: `inset 0 0 0 1px ${EXON_DETAIL_GENOMIC_OUTLINE}`,
                }),
                ...(inSelectedExon ? {
                  boxShadow: isLight
                    ? 'inset 0 0 0 1.2px rgba(2, 132, 199, 0.95)'
                    : 'inset 0 0 0 1.2px rgba(125, 211, 252, 0.95)',
                } : {}),
              }}
              title={`Pos ${idx + 1}: ${normalized}${featureType ? ` (${featureType})` : ''}`}
            >
              {normalized}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {EXON_DETAIL_FEATURE_LEGEND.map((item) => (
          <div key={`exon-detail-legend-${item.key}`} className="inline-flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-sm border"
              style={{
                background: item.outlineOnly ? 'transparent' : (item.gradient || item.bg),
                borderColor: item.outlineOnly ? item.bg : (isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(226, 232, 240, 0.25)'),
              }}
            />
            <span className={`text-[10px] ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>{item.label}</span>
          </div>
        ))}
      </div>
      {sequenceInfo?.feature_transcript_id && (
        <div className={`mt-1 text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
          Overlay transcript: <span className="font-mono">{sequenceInfo.feature_transcript_id}</span>
        </div>
      )}
    </div>
  )
}

function stateBadge(stateClass, isLight) {
  const key = String(stateClass || 'non_coding')
  const meta = STATE_META[key] || STATE_META.non_coding
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{
        color: isLight ? '#1f2937' : '#e5e7eb',
        border: `1px solid ${isLight ? meta.borderLight : meta.borderDark}`,
        background: isLight ? meta.bgLight : meta.bgDark,
      }}
    >
      {meta.label}
    </span>
  )
}

function StatCard({ label, value, isLight, onMouseEnter, onMouseMove, onMouseLeave }) {
  return (
    <div
      className={`rounded border px-2 py-1 ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-900/40 border-gray-700'}`}
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <div className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{label}</div>
      <div className={`text-xs font-semibold whitespace-nowrap ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>{value}</div>
    </div>
  )
}

export default function FeatureExplorerExonsPanel({
  theme = 'dark',
  resolvedGene = null,
  sequenceGenome = 'reference',
  orderedTranscripts = [],
  displayOrderIds = [],
  activeTranscriptIds = new Set(),
  transcriptById = new Map(),
  selectedExonStateKey = '',
  onSelectedExonStateKeyChange,
  atlasScreenshotRef = null,
  detailScreenshotRef = null,
}) {
  const isLight = theme === 'light'
  const [collapsed, setCollapsed] = useState(false)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [stateFilter, setStateFilter] = useState('all')
  const [constitutiveFilter, setConstitutiveFilter] = useState('all')
  const [minLengthFilter, setMinLengthFilter] = useState(0)
  const [summaryData, setSummaryData] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [detailData, setDetailData] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailCollapsed, setDetailCollapsed] = useState(false)
  const [copyToast, setCopyToast] = useState('')
  const [hoveredExonStateKey, setHoveredExonStateKey] = useState('')
  const [metricTooltip, setMetricTooltip] = useState({
    visible: false,
    text: '',
    x: 0,
    y: 0,
  })

  const summaryCacheRef = useRef(new Map())
  const detailCacheRef = useRef(new Map())
  const detailSectionRef = useRef(null)
  const metricTooltipTimerRef = useRef(null)
  const { makeController: makeSummaryController } = useAbortableFetch()
  const { makeController: makeDetailController } = useAbortableFetch()

  const activeTranscriptIdsForSummary = useMemo(() => {
    const orderedIds = (Array.isArray(displayOrderIds) && displayOrderIds.length > 0
      ? displayOrderIds
      : orderedTranscripts.map((tx) => tx.id)
    ).filter((txId) => transcriptById.has(txId))
    const activeOnly = orderedIds.filter((txId) => activeTranscriptIds.has(txId))
    return activeOnly.length > 0 ? activeOnly : orderedIds
  }, [displayOrderIds, orderedTranscripts, transcriptById, activeTranscriptIds])

  const transcriptIdsForDetail = useMemo(() => {
    const orderedIds = (Array.isArray(displayOrderIds) && displayOrderIds.length > 0
      ? displayOrderIds
      : orderedTranscripts.map((tx) => tx.id)
    ).filter((txId) => transcriptById.has(txId))
    if (includeInactive) return orderedIds
    const activeOnly = orderedIds.filter((txId) => activeTranscriptIds.has(txId))
    return activeOnly.length > 0 ? activeOnly : orderedIds
  }, [displayOrderIds, orderedTranscripts, transcriptById, includeInactive, activeTranscriptIds])

  const transcriptIdSignature = useMemo(() => transcriptIdsForDetail.join('|'), [transcriptIdsForDetail])

  const summaryTranscriptSignature = useMemo(
    () => activeTranscriptIdsForSummary.join('|'),
    [activeTranscriptIdsForSummary]
  )

  const summaryCacheKey = useMemo(() => (
    `${sequenceGenome}|${resolvedGene?.id || ''}|summary-all|${summaryTranscriptSignature}`
  ), [sequenceGenome, resolvedGene?.id, summaryTranscriptSignature])

  useEffect(() => {
    const geneId = String(resolvedGene?.id || '').trim()
    if (!geneId) {
      setSummaryData(null)
      setDetailData(null)
      setSummaryError('')
      setDetailError('')
      return
    }

    const cached = summaryCacheRef.current.get(summaryCacheKey)
    if (cached) {
      setSummaryData(cached)
      setSummaryError('')
      return
    }

    const controller = makeSummaryController()
    setSummaryLoading(true)
    setSummaryError('')

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/feature_explorer/exons/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            genome: sequenceGenome || 'reference',
            gene_id: geneId,
            transcript_ids: activeTranscriptIdsForSummary,
            include_inactive: true,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to fetch exon summary.')
        summaryCacheRef.current.set(summaryCacheKey, data)
        setSummaryData(data)
      } catch (error) {
        if (error?.name === 'AbortError') return
        setSummaryData(null)
        setSummaryError(error?.message || 'Failed to fetch exon summary.')
      } finally {
        setSummaryLoading(false)
      }
    }
    run()
  }, [resolvedGene?.id, sequenceGenome, activeTranscriptIdsForSummary, summaryCacheKey, makeSummaryController])

  const allTranscriptColumns = useMemo(() => {
    const fromSummary = Array.isArray(summaryData?.transcripts) ? summaryData.transcripts : []
    if (fromSummary.length > 0) return fromSummary
    const fallbackIds = (Array.isArray(displayOrderIds) && displayOrderIds.length > 0
      ? displayOrderIds
      : orderedTranscripts.map((tx) => tx.id)
    ).filter((txId) => transcriptById.has(txId))
    return fallbackIds.map((txId) => {
      const tx = transcriptById.get(txId)
      return {
        transcript_id: txId,
        biotype: String(tx?.biotype || ''),
        is_canonical: Boolean(tx?.is_canonical),
        is_active: activeTranscriptIds.has(txId),
      }
    })
  }, [summaryData?.transcripts, displayOrderIds, orderedTranscripts, transcriptById, activeTranscriptIds])

  const transcriptColumns = useMemo(() => {
    if (includeInactive) return allTranscriptColumns
    const activeOnly = allTranscriptColumns.filter((tx) => Boolean(tx?.is_active))
    return activeOnly.length > 0 ? activeOnly : allTranscriptColumns
  }, [allTranscriptColumns, includeInactive])

  const visibleTranscriptIds = useMemo(
    () => transcriptColumns.map((tx) => String(tx?.transcript_id || '')).filter(Boolean),
    [transcriptColumns]
  )

  const visibleExons = useMemo(() => {
    const exons = Array.isArray(summaryData?.exons) ? summaryData.exons : []
    const visibleIdSet = new Set(visibleTranscriptIds)
    const base = exons.map((exon) => {
      const transcriptStates = exon?.transcript_states || {}
      const includedTranscriptIds = visibleTranscriptIds.filter((txId) => Object.prototype.hasOwnProperty.call(transcriptStates, txId))
      const inclusionCount = includedTranscriptIds.length
      const inclusionFraction = visibleTranscriptIds.length > 0 ? (inclusionCount / visibleTranscriptIds.length) : 0
      return {
        ...exon,
        transcript_ids: includedTranscriptIds,
        inclusion_count: inclusionCount,
        inclusion_fraction: inclusionFraction,
        is_constitutive: visibleTranscriptIds.length > 0 && inclusionCount === visibleTranscriptIds.length,
        _visible: includeInactive || inclusionCount > 0,
      }
    }).filter((exon) => exon._visible)

    const fiveToThree = new Map()
    const threeToFive = new Map()
    for (const exon of base) {
      const { fivePrime, threePrime } = orientedBoundaryPair(exon?.start, exon?.end, exon?.strand)
      if (!fiveToThree.has(fivePrime)) fiveToThree.set(fivePrime, new Set())
      if (!threeToFive.has(threePrime)) threeToFive.set(threePrime, new Set())
      fiveToThree.get(fivePrime).add(threePrime)
      threeToFive.get(threePrime).add(fivePrime)
    }

    return base.map((exon) => {
      const { fivePrime, threePrime } = orientedBoundaryPair(exon?.start, exon?.end, exon?.strand)
      return {
        ...exon,
        alt_five_prime: (threeToFive.get(threePrime)?.size || 0) > 1,
        alt_three_prime: (fiveToThree.get(fivePrime)?.size || 0) > 1,
      }
    })
  }, [summaryData?.exons, visibleTranscriptIds, includeInactive])

  const filteredExons = useMemo(() => {
    const exons = visibleExons
    return exons.filter((exon) => {
      const stateClass = String(exon?.state_class || '')
      if (stateFilter !== 'all' && stateClass !== stateFilter) return false

      const isConstitutive = Boolean(exon?.is_constitutive)
      if (constitutiveFilter === 'constitutive' && !isConstitutive) return false
      if (constitutiveFilter === 'alternative' && isConstitutive) return false

      const length = Number(exon?.length || 0)
      if (Number.isFinite(minLengthFilter) && minLengthFilter > 0 && length < minLengthFilter) return false
      return true
    })
  }, [visibleExons, stateFilter, constitutiveFilter, minLengthFilter])

  useEffect(() => {
    if (typeof onSelectedExonStateKeyChange !== 'function') return
    const currentKey = String(selectedExonStateKey || '').trim()
    if (!currentKey) return
    const stillVisible = filteredExons.some((exon) => String(exon?.exon_state_key || '') === currentKey)
    if (!stillVisible) {
      onSelectedExonStateKeyChange('')
    }
  }, [filteredExons, onSelectedExonStateKeyChange, selectedExonStateKey])

  useEffect(() => {
    const key = String(selectedExonStateKey || '').trim()
    if (!key) {
      setDetailData(null)
      setDetailError('')
      return
    }
    const geneId = String(resolvedGene?.id || '').trim()
    if (!geneId) return

    const detailKey = `${sequenceGenome}|${geneId}|${key}|${transcriptIdSignature}`
    const cached = detailCacheRef.current.get(detailKey)
    if (cached) {
      setDetailData(cached)
      setDetailError('')
      return
    }

    const controller = makeDetailController()
    setDetailLoading(true)
    setDetailError('')

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/feature_explorer/exons/detail`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            genome: sequenceGenome || 'reference',
            gene_id: geneId,
            exon_state_key: key,
            transcript_ids: transcriptIdsForDetail,
            flank_bp: 20,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to fetch exon detail.')
        detailCacheRef.current.set(detailKey, data)
        setDetailData(data)
      } catch (error) {
        if (error?.name === 'AbortError') return
        setDetailData(null)
        setDetailError(error?.message || 'Failed to fetch exon detail.')
      } finally {
        setDetailLoading(false)
      }
    }
    run()
  }, [selectedExonStateKey, resolvedGene?.id, sequenceGenome, transcriptIdSignature, transcriptIdsForDetail, makeDetailController])

  const selectedExonFromSummary = useMemo(() => {
    const key = String(selectedExonStateKey || '').trim()
    if (!key) return null
    const exons = Array.isArray(summaryData?.exons) ? summaryData.exons : []
    return exons.find((exon) => String(exon?.exon_state_key || '') === key) || null
  }, [selectedExonStateKey, summaryData?.exons])

  const detailSelectedExon = detailData?.selected_exon || selectedExonFromSummary || parseExonStateKey(selectedExonStateKey)

  const handleSelectExon = useCallback((exonStateKey) => {
    if (typeof onSelectedExonStateKeyChange !== 'function') return
    const next = String(exonStateKey || '').trim()
    const current = String(selectedExonStateKey || '').trim()
    if (next && next !== current) {
      setDetailCollapsed(false)
      window.requestAnimationFrame(() => {
        detailSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      })
    }
    onSelectedExonStateKeyChange(next === current ? '' : next)
  }, [onSelectedExonStateKeyChange, selectedExonStateKey])

  const summaryStats = useMemo(() => {
    const lengths = filteredExons.map((exon) => Number(exon?.length || 0)).filter((value) => Number.isFinite(value))
    const boundaryCount = new Set(filteredExons.map((exon) => String(exon?.boundary_key || '')).filter(Boolean)).size
    const constitutiveCount = filteredExons.filter((exon) => Boolean(exon?.is_constitutive)).length
    return {
      total_unique_boundaries: boundaryCount,
      total_unique_exon_states: filteredExons.length,
      constitutive_exon_states: constitutiveCount,
      alternative_exon_states: Math.max(0, filteredExons.length - constitutiveCount),
      coding_exon_states: filteredExons.filter((exon) => String(exon?.state_class || '') === 'coding').length,
      partial_exon_states: filteredExons.filter((exon) => String(exon?.state_class || '') === 'partial_coding').length,
      non_coding_exon_states: filteredExons.filter((exon) => String(exon?.state_class || '') === 'non_coding').length,
      microexon_count: filteredExons.filter((exon) => Number(exon?.length || 0) < 27).length,
      mean_exon_length: lengths.length > 0 ? roundTo((lengths.reduce((sum, value) => sum + value, 0) / lengths.length), 2) : 0,
      median_exon_length: roundTo(median(lengths), 2),
    }
  }, [filteredExons])
  const toCellWidth = useCallback((charCount, min, max, pad = 20) => {
    const chars = Number.isFinite(charCount) ? charCount : 0
    return Math.max(min, Math.min(max, (chars * 7) + pad))
  }, [])

  const atlasColumnWidths = useMemo(() => {
    const exons = Array.isArray(summaryData?.exons) ? summaryData.exons : []
    const maxExonLabelChars = Math.max('Exon'.length, ...exons.map((exon) => String(exon?.exon_label || '').length))
    const maxLengthChars = Math.max('Length'.length, ...exons.map((exon) => formatCoord(exon?.length).length))
    const maxIncludedChars = Math.max(
      'Included'.length,
      ...exons.map((exon) => `${formatCoord(exon?.inclusion_count)} (${formatPercent(exon?.inclusion_fraction)})`.length),
    )
    const maxTranscriptChars = Math.max(
      'canonical'.length,
      ...transcriptColumns.map((tx) => transcriptDisplayId(tx?.transcript_id).length),
    )
    return {
      exon: toCellWidth(maxExonLabelChars, 88, 154, 16),
      state: 96,
      length: toCellWidth(maxLengthChars, 76, 114, 18),
      included: toCellWidth(maxIncludedChars, 110, 176, 18),
      altFive: 70,
      altThree: 70,
      transcript: toCellWidth(maxTranscriptChars, 114, 170, 24),
    }
  }, [summaryData?.exons, transcriptColumns, toCellWidth])

  const transcriptColumnWidth = atlasColumnWidths.transcript
  const fixedLeadColumnsWidth = atlasColumnWidths.exon
    + atlasColumnWidths.state
    + atlasColumnWidths.length
    + atlasColumnWidths.included
    + atlasColumnWidths.altFive
    + atlasColumnWidths.altThree
  const atlasTableWidth = fixedLeadColumnsWidth + (Math.max(0, transcriptColumns.length) * transcriptColumnWidth)

  const summaryCards = [
    {
      label: 'Unique boundaries',
      value: formatCoord(summaryStats.total_unique_boundaries),
      tooltip: 'Count of distinct exon genomic boundaries (chrom:start-end:strand), regardless of coding state.',
    },
    {
      label: 'Unique exon states',
      value: formatCoord(summaryStats.total_unique_exon_states),
      tooltip: 'Distinct boundary + state entries, where state splits coding, partial-coding, and non-coding forms.',
    },
    {
      label: 'Constitutive',
      value: formatCoord(summaryStats.constitutive_exon_states),
      tooltip: 'Exon-state entries present in all currently included transcript columns.',
    },
    {
      label: 'Alternative',
      value: formatCoord(summaryStats.alternative_exon_states),
      tooltip: 'Exon-state entries absent from at least one currently included transcript column.',
    },
    {
      label: 'Coding/Partial/NC',
      value: `${formatCoord(summaryStats.coding_exon_states)}/${formatCoord(summaryStats.partial_exon_states)}/${formatCoord(summaryStats.non_coding_exon_states)}`,
      tooltip: 'Counts of exon-state entries by coding class: coding, partial-coding, and non-coding.',
    },
    {
      label: 'Microexons (<27bp)',
      value: formatCoord(summaryStats.microexon_count),
      tooltip: 'Number of exon-state entries with exon length below 27 bp.',
    },
    {
      label: 'Mean length',
      value: `${formatCoord(summaryStats.mean_exon_length)} bp`,
      tooltip: 'Average exon length across exon-state entries in the current atlas scope.',
    },
    {
      label: 'Median length',
      value: `${formatCoord(summaryStats.median_exon_length)} bp`,
      tooltip: 'Median exon length across exon-state entries in the current atlas scope.',
    },
  ]

  const clearMetricTooltipTimer = useCallback(() => {
    if (metricTooltipTimerRef.current) {
      clearTimeout(metricTooltipTimerRef.current)
      metricTooltipTimerRef.current = null
    }
  }, [])

  const clampTooltipPosition = useCallback((clientX, clientY) => {
    const tooltipWidth = 280
    const tooltipHeight = 72
    const pad = 12
    const vw = window.innerWidth || 1200
    const vh = window.innerHeight || 800
    let x = clientX + 14
    let y = clientY + 16
    if (x + tooltipWidth + pad > vw) {
      x = Math.max(pad, vw - tooltipWidth - pad)
    }
    if (y + tooltipHeight + pad > vh) {
      y = Math.max(pad, clientY - tooltipHeight - 14)
    }
    return { x, y }
  }, [])

  const handleMetricEnter = useCallback((tooltip, event) => {
    clearMetricTooltipTimer()
    const text = String(tooltip || '').trim()
    if (!text) return
    const { x, y } = clampTooltipPosition(event.clientX, event.clientY)
    metricTooltipTimerRef.current = setTimeout(() => {
      setMetricTooltip({
        visible: true,
        text,
        x,
        y,
      })
    }, 1000)
  }, [clearMetricTooltipTimer, clampTooltipPosition])

  const handleMetricMove = useCallback((event) => {
    setMetricTooltip((prev) => {
      if (!prev.visible) return prev
      const { x, y } = clampTooltipPosition(event.clientX, event.clientY)
      if (x === prev.x && y === prev.y) return prev
      return { ...prev, x, y }
    })
  }, [clampTooltipPosition])

  const hideMetricTooltip = useCallback(() => {
    clearMetricTooltipTimer()
    setMetricTooltip((prev) => (prev.visible
      ? { visible: false, text: '', x: 0, y: 0 }
      : prev))
  }, [clearMetricTooltipTimer])

  useEffect(() => () => clearMetricTooltipTimer(), [clearMetricTooltipTimer])

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

  const copySelectedExonSequence = useCallback(() => {
    const seq = String(detailData?.sequence?.sequence || '')
    const s = Math.max(1, Number(detailData?.sequence?.exon_start_index || 1))
    const e = Math.max(s, Number(detailData?.sequence?.exon_end_index || s))
    const exonSeq = seq.slice(s - 1, e).toUpperCase()
    if (!exonSeq) return
    copyToClipboard(exonSeq, 'exon sequence')
  }, [detailData?.sequence, copyToClipboard])

  const togglePanelCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const toggleDetailCollapsed = useCallback(() => {
    setDetailCollapsed((prev) => !prev)
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
        <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>Exons</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setIncludeInactive((prev) => !prev)
            }}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${includeInactive
              ? (isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80')
              : (isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
              }`}
            title={includeInactive ? 'Return to active transcripts only' : 'Include inactive transcripts in the exon atlas'}
          >
            {includeInactive ? 'Active only' : 'Show all'}
          </button>
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
            title={collapsed ? 'Expand exons panel' : 'Collapse exons panel'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              {collapsed
                ? <polyline points="6 9 12 15 18 9" />
                : <polyline points="18 15 12 9 6 15" />}
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 py-3 space-y-3">
          {summaryLoading && (
            <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Loading exon atlas...</div>
          )}
          {summaryError && (
            <div className={`text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>{summaryError}</div>
          )}

          {!summaryLoading && !summaryError && summaryData && (
            <div ref={atlasScreenshotRef} className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
                {summaryCards.map((card) => (
                  <StatCard
                    key={`exon-stat-${card.label}`}
                    label={card.label}
                    value={card.value}
                    isLight={isLight}
                    onMouseEnter={(event) => handleMetricEnter(card.tooltip, event)}
                    onMouseMove={handleMetricMove}
                    onMouseLeave={hideMetricTooltip}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                  State
                  <select
                    value={stateFilter}
                    onChange={(event) => setStateFilter(event.target.value)}
                    className={`ml-2 rounded border px-2 py-1 text-xs ${isLight ? 'bg-white border-gray-300 text-gray-700' : 'bg-gray-900 border-gray-600 text-gray-200'}`}
                  >
                    <option value="all">All</option>
                    <option value="coding">Coding</option>
                    <option value="partial_coding">Partial coding</option>
                    <option value="non_coding">Non-coding</option>
                  </select>
                </label>
                <label className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                  Class
                  <select
                    value={constitutiveFilter}
                    onChange={(event) => setConstitutiveFilter(event.target.value)}
                    className={`ml-2 rounded border px-2 py-1 text-xs ${isLight ? 'bg-white border-gray-300 text-gray-700' : 'bg-gray-900 border-gray-600 text-gray-200'}`}
                  >
                    <option value="all">All</option>
                    <option value="constitutive">Constitutive</option>
                    <option value="alternative">Alternative</option>
                  </select>
                </label>
                <label className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                  Min length
                  <input
                    type="number"
                    min={0}
                    value={minLengthFilter}
                    onChange={(event) => setMinLengthFilter(Math.max(0, Number(event.target.value || 0)))}
                    className={`ml-2 w-20 rounded border px-2 py-1 text-xs ${isLight ? 'bg-white border-gray-300 text-gray-700' : 'bg-gray-900 border-gray-600 text-gray-200'}`}
                  />
                </label>
              </div>

              <div className={`rounded-lg border overflow-auto ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <table className="table-fixed text-[11px] whitespace-nowrap" style={{ width: `${atlasTableWidth}px`, minWidth: `${atlasTableWidth}px` }}>
                  <colgroup>
                    <col style={{ width: `${atlasColumnWidths.exon}px` }} />
                    <col style={{ width: `${atlasColumnWidths.state}px` }} />
                    <col style={{ width: `${atlasColumnWidths.length}px` }} />
                    <col style={{ width: `${atlasColumnWidths.included}px` }} />
                    <col style={{ width: `${atlasColumnWidths.altFive}px` }} />
                    <col style={{ width: `${atlasColumnWidths.altThree}px` }} />
                    {transcriptColumns.map((tx) => (
                      <col key={`atlas-col-${tx.transcript_id}`} style={{ width: `${transcriptColumnWidth}px` }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className={isLight ? 'bg-gray-50 border-b border-gray-200' : 'bg-gray-900/40 border-b border-gray-700'}>
                      <th className="text-left px-2 py-1.5 font-semibold whitespace-nowrap">Exon</th>
                      <th className="text-left px-2 py-1.5 font-semibold whitespace-nowrap">State</th>
                      <th className="text-right px-2 py-1.5 font-semibold whitespace-nowrap">Length</th>
                      <th className="text-right px-2 py-1.5 font-semibold whitespace-nowrap">Included</th>
                      <th className="text-center px-2 py-1.5 font-semibold whitespace-nowrap">5&apos; alt</th>
                      <th className="text-center px-2 py-1.5 font-semibold whitespace-nowrap">3&apos; alt</th>
                      {transcriptColumns.map((tx) => (
                        <th key={`atlas-head-${tx.transcript_id}`} className="px-1 py-1.5 text-center font-semibold whitespace-nowrap" title={tx.transcript_id}>
                          <div className="flex flex-col items-center justify-start">
                            <span className="font-mono text-[10px] whitespace-nowrap">{transcriptDisplayId(tx.transcript_id)}</span>
                            <span
                              className={`mt-0.5 text-[9px] px-1 rounded-full whitespace-nowrap h-[14px] inline-flex items-center ${tx.is_canonical
                                ? (isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400')
                                : 'opacity-0'
                                }`}
                              aria-hidden={!tx.is_canonical}
                            >
                              canonical
                            </span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExons.map((exon) => {
                      const exonStateKey = String(exon?.exon_state_key || '')
                      const selected = exonStateKey === String(selectedExonStateKey || '')
                      const hovered = exonStateKey === hoveredExonStateKey
                      const rowBg = selected
                        ? (isLight ? 'bg-sky-50' : 'bg-sky-500/10')
                        : hovered
                          ? (isLight ? 'bg-gray-50' : 'bg-gray-900/35')
                          : ''
                      return (
                        <tr
                          key={exonStateKey}
                          className={`border-b cursor-pointer transition-colors ${isLight ? 'border-gray-200' : 'border-gray-700'} ${rowBg}`}
                          onMouseEnter={() => setHoveredExonStateKey(exonStateKey)}
                          onMouseLeave={() => setHoveredExonStateKey((prev) => (prev === exonStateKey ? '' : prev))}
                          onClick={() => handleSelectExon(exonStateKey)}
                        >
                          <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{exon.exon_label}</td>
                          <td className="px-2 py-1.5">{stateBadge(exon.state_class, isLight)}</td>
                          <td className="px-2 py-1.5 text-right">{formatCoord(exon.length)}</td>
                          <td className="px-2 py-1.5 text-right">
                            {formatCoord(exon.inclusion_count)} ({formatPercent(exon.inclusion_fraction)})
                          </td>
                          <td className="px-2 py-1.5 text-center">{exon.alt_five_prime ? 'Yes' : '—'}</td>
                          <td className="px-2 py-1.5 text-center">{exon.alt_three_prime ? 'Yes' : '—'}</td>
                          {transcriptColumns.map((tx) => {
                            const txId = String(tx.transcript_id || '')
                            const stateClass = String(exon?.transcript_states?.[txId] || 'absent')
                            const meta = STATE_META[stateClass] || STATE_META.absent
                            const borderColor = isLight ? meta.borderLight : meta.borderDark
                            const background = isLight ? meta.bgLight : meta.bgDark
                            return (
                              <td key={`${exonStateKey}-${txId}`} className="px-1 py-1.5">
                                <div
                                  className="h-4 rounded border"
                                  style={{
                                    borderColor,
                                    background,
                                  }}
                                  title={`${txId}: ${STATE_META[stateClass]?.label || 'absent'}`}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                    {filteredExons.length === 0 && (
                      <tr>
                        <td className={`px-2 py-3 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`} colSpan={6 + transcriptColumns.length}>
                          No exons match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div
            ref={(node) => {
              detailSectionRef.current = node
              if (detailScreenshotRef && typeof detailScreenshotRef === 'object') {
                detailScreenshotRef.current = node
              }
            }}
            className={`rounded-lg border ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/35'}`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={toggleDetailCollapsed}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleDetailCollapsed()
                }
              }}
              className={`px-3 py-2 border-b flex items-center justify-between cursor-pointer select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
            >
              <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Exon detail</div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleDetailCollapsed()
                }}
                className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
                  ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                  : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                  }`}
                title={detailCollapsed ? 'Expand exon detail' : 'Collapse exon detail'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  {detailCollapsed
                    ? <polyline points="6 9 12 15 18 9" />
                    : <polyline points="18 15 12 9 6 15" />}
                </svg>
              </button>
            </div>
            {!detailCollapsed && (
              <div className="px-3 py-3 space-y-3">
              {!selectedExonStateKey && (
                <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                  Select an exon in the atlas, transcript tracks, or splice graph to view details.
                </div>
              )}
              {selectedExonStateKey && detailLoading && (
                <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Loading exon detail...</div>
              )}
              {selectedExonStateKey && detailError && (
                <div className={`text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>{detailError}</div>
              )}
              {selectedExonStateKey && detailSelectedExon && !detailLoading && !detailError && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Exon:</span> {detailSelectedExon.exon_label || '—'}</div>
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>State:</span> {stateBadge(detailSelectedExon.state_class, isLight)}</div>
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Location:</span> {detailSelectedExon.chrom}:{formatCoord(detailSelectedExon.start)}-{formatCoord(detailSelectedExon.end)}</div>
                    <div className="flex items-center justify-between gap-2">
                      <span><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Length:</span> {formatCoord(detailSelectedExon.length)} bp</span>
                      <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={copySelectedExonSequence}
                        className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                          ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                          : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                          }`}
                        title="Copy selected exon sequence"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="5" y="5" width="14" height="16" rx="2.2" />
                          <path d="M9 3h6v4H9z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {detailData?.sequence && sequencePreview(detailData.sequence, isLight)}

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Donor:</span> {detailData?.junctions?.donor_motif || '—'} ({detailData?.junctions?.donor_canonical_count || 0}/{detailData?.junctions?.donor_total || 0})</div>
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Acceptor:</span> {detailData?.junctions?.acceptor_motif || '—'} ({detailData?.junctions?.acceptor_canonical_count || 0}/{detailData?.junctions?.acceptor_total || 0})</div>
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Start codon overlap:</span> {formatCoord(detailData?.junctions?.start_codon_inclusion_count || 0)}</div>
                    <div><span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Stop codon overlap:</span> {formatCoord(detailData?.junctions?.stop_codon_inclusion_count || 0)}</div>
                  </div>

                  <div className={`rounded border overflow-auto ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <table className="w-full min-w-[860px] text-[11px]">
                      <thead>
                        <tr className={isLight ? 'bg-white border-b border-gray-200' : 'bg-gray-800 border-b border-gray-700'}>
                          <th className="text-left px-2 py-1.5">Transcript</th>
                          <th className="text-right px-2 py-1.5">Rank</th>
                          <th className="text-left px-2 py-1.5">State</th>
                          <th className="text-right px-2 py-1.5">CDS overlap</th>
                          <th className="text-right px-2 py-1.5">CDS coords</th>
                          <th className="text-right px-2 py-1.5">AA span</th>
                          <th className="text-right px-2 py-1.5">Phase</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(Array.isArray(detailData?.instances) ? detailData.instances : []).map((instance) => (
                          <tr key={`${instance.transcript_id}-${instance.exon_rank}`} className={`border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <td className="px-2 py-1.5 font-mono">{instance.transcript_id}</td>
                            <td className="px-2 py-1.5 text-right">{formatCoord(instance.exon_rank)} / {formatCoord(instance.total_exons)}</td>
                            <td className="px-2 py-1.5">{stateBadge(instance.state_class, isLight)}</td>
                            <td className="px-2 py-1.5 text-right">{formatCoord(instance.cds_overlap_length)}</td>
                            <td className="px-2 py-1.5 text-right">
                              {instance.cds_coord_start && instance.cds_coord_end
                                ? `${formatCoord(instance.cds_coord_start)}-${formatCoord(instance.cds_coord_end)}`
                                : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {instance.protein_aa_start && instance.protein_aa_end
                                ? `${formatCoord(instance.protein_aa_start)}-${formatCoord(instance.protein_aa_end)}`
                                : '—'}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {instance.cds_phase_5p != null && instance.cds_phase_3p != null
                                ? `${instance.cds_phase_5p}/${instance.cds_phase_3p}`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                        {(!Array.isArray(detailData?.instances) || detailData.instances.length === 0) && (
                          <tr>
                            <td colSpan={7} className={`px-2 py-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                              No transcript instances available for this exon-state.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              </div>
            )}
          </div>
        </div>
      )}
      {metricTooltip.visible && (
        <div
          role="tooltip"
          className={`fixed z-[140] w-[280px] rounded-md border px-2 py-1.5 text-[10px] leading-4 shadow-xl pointer-events-none ${isLight
            ? 'border-gray-300 bg-white text-gray-700'
            : 'border-gray-600 bg-gray-900 text-gray-200'
            }`}
          style={{ left: `${metricTooltip.x}px`, top: `${metricTooltip.y}px` }}
        >
          {metricTooltip.text}
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

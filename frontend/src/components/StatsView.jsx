import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { trackAchievement } from '../achievements/tracker.js'
import { API_BASE } from '../backendRuntime'
import GenomeAnalysisOverview from './GenomeAnalysisOverview'
import {
  getGenomeKey,
  normalizeGenomeProvider,
  normalizeGenomeRecord,
  normalizeGenomeSourceDatabase,
} from '../utils/genomeIdentity'


const MAJOR_CLASS_ORDER = ['coding', 'lnoncoding', 'snoncoding', 'pseudogene']
const MAJOR_CLASS_COLORS = {
  coding: '#2563eb',
  lnoncoding: '#0891b2',
  snoncoding: '#7c3aed',
  pseudogene: '#ea580c',
}
const MAJOR_CLASS_LABELS = {
  coding: 'coding',
  lnoncoding: 'long non-coding',
  snoncoding: 'small non-coding',
  pseudogene: 'pseudogene',
}

const STRUCTURAL_METRICS = [
  { key: 'avg_exon_count', label: 'Avg exon count', format: 'float' },
  { key: 'median_exon_count', label: 'Median exon count', format: 'float' },
  { key: 'avg_exon_size', label: 'Avg exon size', format: 'float' },
  { key: 'median_exon_size', label: 'Median exon size', format: 'float' },
  { key: 'avg_intron_size', label: 'Avg intron size', format: 'float' },
  { key: 'median_intron_size', label: 'Median intron size', format: 'float' },
  { key: 'avg_cds_length', label: 'Avg CDS length', format: 'float' },
  { key: 'median_cds_length', label: 'Median CDS length', format: 'float' },
  { key: 'avg_cds_exon_count', label: 'Avg CDS exons', format: 'float' },
  { key: 'avg_utr5_length', label: "Avg 5' UTR length", format: 'float' },
  { key: 'avg_utr3_length', label: "Avg 3' UTR length", format: 'float' },
  { key: 'regular_cds_fraction', countKey: 'regular_cds_count', label: 'Regular CDS', format: 'percent', sequenceBased: true },
  { key: 'small_intron_gap_fraction', countKey: 'small_intron_gap_count', label: 'Small introns/gaps', format: 'percent' },
  { key: 'non_canonical_splice_fraction', countKey: 'non_canonical_splice_count', label: 'Non-canonical splicing', format: 'percent', sequenceBased: true },
]
const STRUCTURAL_PLOT_METRICS = [
  ...STRUCTURAL_METRICS.filter((metric) => metric.format !== 'int'),
]
const STRUCTURAL_PLOT_COLOR_SCALE = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#17becf',
  '#bcbd22',
  '#393b79',
  '#637939',
  '#8c6d31',
]

const SUMMARY_CORE_SECTIONS = ['annotation', 'structural', 'homology']
const STRUCTURAL_SELECTABLE_STATUSES = new Set(['missing', 'stale', 'error'])
const STRUCTURAL_PENDING_STATUSES = new Set(['missing', 'stale', 'error', 'computing'])

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function rectsOverlap(a, b) {
  if (!a || !b) return false
  return (
    a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y
  )
}

function formatInt(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

function formatFloat(value, digits = 2) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

function formatPercent(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function structuralMetricValue(record, key) {
  const structural = record?.structural || {}
  if (Object.prototype.hasOwnProperty.call(structural, key)) {
    return structural[key]
  }
  // Backward-compatible fallback for old cached key.
  if (key === 'regular_cds_fraction' && Object.prototype.hasOwnProperty.call(structural, 'valid_cds_fraction')) {
    return structural.valid_cds_fraction
  }
  return (structural.metrics || {})[key]
}

function truncateText(value, maxLen = 22) {
  const text = String(value || '')
  if (text.length <= maxLen) return text
  if (maxLen < 4) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 3)}...`
}

function structuralDisplayStatus(status) {
  if (status === 'computing') return 'Generating'
  if (status === 'ready') return 'Ready'
  return 'Select to generate'
}

function ZoomOutButton({ active, onClick, isLight, title = 'Zoom out', className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!active}
      title={title}
      className={`rounded-md border transition-colors w-8 h-8 flex items-center justify-center ${active
        ? (isLight
          ? 'bg-[#0099ff] text-white border-[#0088ee] hover:bg-[#0088ee] shadow-sm shadow-blue-200'
          : 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500 shadow-sm shadow-blue-950/50')
        : (isLight
          ? 'bg-gray-100 text-gray-400 border-gray-300'
          : 'bg-gray-800 text-gray-500 border-gray-700')
        } ${className}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="7.7" y1="11" x2="14.3" y2="11" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
    </button>
  )
}

function normalizeGenomeInput(raw) {
  const normalized = normalizeGenomeRecord(raw)
  const files = normalized?.files || {}
  return {
    selection_key: normalized?.selection_key || '',
    assembly_key: normalized?.assembly_key || '',
    species_key: normalized?.species_key || '',
    assembly: normalized?.assembly || '',
    assembly_name: normalized?.assembly_name || normalized?.assembly || '',
    scientific_name: normalized?.scientific_name || '',
    common_name: normalized?.common_name || '',
    provider: normalizeGenomeProvider(normalized),
    source_database: normalizeGenomeSourceDatabase(normalized),
    gca: normalized?.gca || normalized?.assembly || '',
    dataset_release_key: normalized?.dataset_release_key || '',
    dataset_release_source: normalized?.dataset_release_source || '',
    dataset_release_date: normalized?.dataset_release_date || '',
    dataset_release_label: normalized?.dataset_release_label || '',
    dataset_release_short_label: normalized?.dataset_release_short_label || '',
    files: {
      gff3: files?.gff3 || '',
      index: files?.index || '',
      fasta: files?.fasta || '',
      homology: files?.homology || '',
      metadata: files?.metadata || '',
    },
  }
}

function genomeKeyFromInput(raw) {
  return getGenomeKey(raw)
}

function buildPlaceholderRecord(genome) {
  const genomeKey = genomeKeyFromInput(genome)
  return {
    genome_key: genomeKey,
    species_key: genome?.species_key || '',
    assembly: genome?.assembly || '',
    assembly_name: genome?.assembly_name || genome?.assembly || '',
    scientific_name: genome?.scientific_name || '',
    common_name: genome?.common_name || '',
    provider: genome?.provider || '',
    source_database: genome?.source_database || '',
    gca: genome?.gca || '',
    files: genome?.files || {},
    statuses: {
      annotation: 'computing',
      structural: 'computing',
      homology: 'computing',
      assembly: 'computing',
    },
    annotation: null,
    structural: null,
    homology: null,
    assembly_info: null,
  }
}

function buildErrorRecord(genome, message) {
  const record = buildPlaceholderRecord(genome)
  record.statuses = {
    annotation: 'error',
    structural: 'error',
    homology: 'error',
    assembly: 'error',
  }
  record.error = String(message || 'Failed to load stats for genome.')
  return record
}

function makeTicks(minValue, maxValue, count = 5) {
  const min = Number(minValue)
  const max = Number(maxValue)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const out = []
  for (let i = 0; i < count; i += 1) {
    const f = i / (count - 1)
    out.push(min + ((max - min) * f))
  }
  return out
}

function genomeLabel(record) {
  const common = (record?.common_name || '').trim()
  const sci = (record?.scientific_name || '').trim()
  const asm = (record?.assembly_name || record?.assembly || '').trim()
  const base = common || sci || record?.species_key || 'Genome'
  return asm ? `${base} - ${asm}` : base
}

function useHorizontalDragScroll(ignoreSelector = '') {
  const scrollRef = useRef(null)
  const dragRef = useRef({ dragging: false, moved: false, startX: 0, scrollLeft: 0 })
  const suppressClickRef = useRef(false)

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    if (ignoreSelector && e.target?.closest?.(ignoreSelector)) return
    const el = scrollRef.current
    if (!el) return
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: e.pageX - el.offsetLeft,
      scrollLeft: el.scrollLeft,
    }
    suppressClickRef.current = false
    el.style.cursor = 'grabbing'
  }, [ignoreSelector])

  const onMouseMove = useCallback((e) => {
    const d = dragRef.current
    if (!d.dragging) return
    const el = scrollRef.current
    if (!el) return
    const x = e.pageX - el.offsetLeft
    const delta = x - d.startX
    if (Math.abs(delta) > 4) {
      d.moved = true
      suppressClickRef.current = true
    }
    if (!d.moved) return
    e.preventDefault()
    el.scrollLeft = d.scrollLeft - delta
  }, [])

  const onMouseUp = useCallback(() => {
    const wasMoved = dragRef.current.moved
    dragRef.current.dragging = false
    dragRef.current.moved = false
    const el = scrollRef.current
    if (el) el.style.cursor = 'grab'
    if (wasMoved) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
  }, [])

  const onClickCapture = useCallback((e) => {
    if (!suppressClickRef.current) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  return {
    scrollRef,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave: onMouseUp,
    onClickCapture,
  }
}

function classifyBiotypeClass(rawBiotype, mappedClass = '') {
  const mapped = String(mappedClass || '').trim().toLowerCase()
  if (MAJOR_CLASS_ORDER.includes(mapped)) return mapped
  const biotype = String(rawBiotype || '').trim().toLowerCase()
  if (biotype === 'protein_coding' || biotype.startsWith('protein_coding')) return 'coding'
  if (biotype.includes('pseudogene')) return 'pseudogene'
  if (biotype.startsWith('ig_') || biotype.startsWith('tr_')) return 'coding'
  if (
    biotype.startsWith('mirna')
    || biotype.startsWith('snorna')
    || biotype.startsWith('snrna')
    || biotype.startsWith('rrna')
    || biotype.startsWith('trna')
    || biotype.startsWith('misc_rna')
    || biotype.startsWith('ribozyme')
    || biotype.startsWith('scarna')
    || biotype.startsWith('pirna')
    || biotype.startsWith('sirna')
    || biotype.startsWith('mt_trna')
    || biotype.startsWith('mt_rrna')
  ) return 'snoncoding'
  if (
    biotype.startsWith('lnc')
    || biotype.startsWith('ncrna')
    || biotype.includes('rna')
    || biotype.endsWith('_gene')
  ) return 'lnoncoding'
  return 'lnoncoding'
}

function majorClassCountsForAnnotation(annotation, basis) {
  const out = {}
  for (const cls of MAJOR_CLASS_ORDER) out[cls] = 0

  const ann = annotation || {}
  const biotypeCounts = basis === 'genes'
    ? (ann.gene_biotype_counts || {})
    : (ann.transcript_biotype_counts || {})
  const biotypeMajorClassMap = basis === 'genes'
    ? (ann.gene_biotype_major_class_map || {})
    : (ann.transcript_biotype_major_class_map || {})

  let usedBiotypeCounts = false
  for (const [biotypeName, rawValue] of Object.entries(biotypeCounts || {})) {
    const value = toNumber(rawValue, 0)
    if (value <= 0) continue
    usedBiotypeCounts = true
    const mapped = biotypeMajorClassMap[biotypeName] || biotypeMajorClassMap[String(biotypeName || '').toLowerCase()] || ''
    const cls = classifyBiotypeClass(biotypeName, mapped)
    out[cls] = toNumber(out[cls], 0) + value
  }
  if (usedBiotypeCounts) return out

  const majorCounts = basis === 'genes'
    ? (ann.major_class_gene_counts || {})
    : (ann.major_class_transcript_counts || {})
  const aliasToMajorClass = {
    coding: 'coding',
    protein_coding: 'coding',
    immune_receptor: 'coding',
    lnoncoding: 'lnoncoding',
    noncoding: 'lnoncoding',
    non_coding: 'lnoncoding',
    snoncoding: 'snoncoding',
    mnoncoding: 'snoncoding',
    pseudogene: 'pseudogene',
    other: 'lnoncoding',
  }
  for (const [rawKey, rawValue] of Object.entries(majorCounts || {})) {
    const key = String(rawKey || '').trim().toLowerCase()
    const mapped = aliasToMajorClass[key]
    if (!mapped) continue
    out[mapped] = toNumber(out[mapped], 0) + toNumber(rawValue, 0)
  }
  return out
}

function AnnotationChart({ records, basis, isLight, yZoom, onYZoom }) {
  const [dragBand, setDragBand] = useState(null)
  const svgRef = useRef(null)

  const toLocal = useCallback((evt, target = null) => {
    const element = target || svgRef.current || evt.currentTarget
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    }
  }, [])

  const recordCount = Math.max(1, records.length)
  const chartWidth = Math.max(620, records.length * 145)
  const chartHeight = 320
  const margin = { top: 14, right: 20, bottom: 96, left: 52 }
  const innerW = chartWidth - margin.left - margin.right
  const innerH = chartHeight - margin.top - margin.bottom
  const barW = Math.min(66, Math.max(42, (innerW / recordCount) * 0.62))
  const topBuffer = 18
  const dragTop = margin.top - topBuffer

  const values = records.map((record) => {
    const ready = (record?.statuses || {}).annotation === 'ready' && record?.annotation
    const ann = record.annotation || {}
    const classes = ready
      ? majorClassCountsForAnnotation(ann, basis)
      : {}
    const total = ready ? MAJOR_CLASS_ORDER.reduce((sum, key) => sum + toNumber(classes[key], 0), 0) : 0
    return { record, ready, classes, total }
  })

  const maxTotal = Math.max(1, ...values.filter((v) => v.ready).map((v) => v.total), 1)
  const domainMin = Math.max(0, toNumber(yZoom?.min, 0))
  const domainMax = Math.max(domainMin + 1, toNumber(yZoom?.max, maxTotal))

  const yForValue = (value) => {
    const v = clamp(value, domainMin, domainMax)
    const frac = (v - domainMin) / (domainMax - domainMin)
    return margin.top + innerH - (innerH * frac)
  }

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toLocal(evt)
    const y = clamp(point.y - dragTop, 0, innerH + topBuffer)
    setDragBand({ startY: y, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragBand) return undefined
    const element = svgRef.current
    if (!element) return undefined

    const toSelectionY = (e) => {
      const rect = element.getBoundingClientRect()
      const svgY = e.clientY - rect.top
      return clamp(svgY - dragTop, 0, innerH + topBuffer)
    }

    const onMove = (e) => {
      const y = toSelectionY(e)
      setDragBand((prev) => (prev ? { ...prev, currentY: y } : prev))
    }

    const onUp = (e) => {
      const endY = toSelectionY(e)
      setDragBand((prev) => {
        if (!prev) return prev
        const top = Math.min(prev.startY, endY)
        const bottom = Math.max(prev.startY, endY)
        if ((bottom - top) < 8) return null

        const topPlotY = clamp(top - topBuffer, 0, innerH)
        const bottomPlotY = clamp(bottom - topBuffer, 0, innerH)
        const yToValue = (localY) => domainMin + (((innerH - localY) / innerH) * (domainMax - domainMin))
        const selectedMax = yToValue(topPlotY)
        const selectedMin = yToValue(bottomPlotY)
        if (selectedMax > selectedMin) {
          onYZoom({ min: Math.max(0, selectedMin), max: Math.max(selectedMin + 1, selectedMax) })
        }
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragBand, domainMin, domainMax, innerH, topBuffer, dragTop, onYZoom])

  if (!records.length) {
    return <div className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No genomes selected.</div>
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg ref={svgRef} width={chartWidth} height={chartHeight}>
          <line
            x1={margin.left}
            y1={margin.top + innerH}
            x2={margin.left + innerW}
            y2={margin.top + innerH}
            stroke={isLight ? '#94a3b8' : '#475569'}
          />
          <line
            x1={margin.left}
            y1={margin.top}
            x2={margin.left}
            y2={margin.top + innerH}
            stroke={isLight ? '#94a3b8' : '#475569'}
          />

          {makeTicks(domainMin, domainMax, 5).map((tick) => {
            const y = yForValue(tick)
            return (
              <g key={`tick-${tick}`}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + innerW}
                  y2={y}
                  stroke={isLight ? '#e2e8f0' : '#334155'}
                  strokeDasharray="3 3"
                />
                <text
                  x={margin.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill={isLight ? '#475569' : '#94a3b8'}
                >
                  {formatInt(tick)}
                </text>
              </g>
            )
          })}

          {values.map((item, idx) => {
            const xCenter = margin.left + ((idx + 0.5) * (innerW / values.length))
            const x = xCenter - (barW / 2)

            if (!item.ready) {
              const status = (item.record?.statuses || {}).annotation || 'computing'
              return (
                <g key={item.record.genome_key}>
                  <rect
                    x={x}
                    y={margin.top}
                    width={barW}
                    height={innerH}
                    fill={isLight ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.08)'}
                    stroke={isLight ? '#94a3b8' : '#64748b'}
                    strokeDasharray="4 3"
                  />
                  <text
                    x={xCenter}
                    y={margin.top + (innerH / 2)}
                    textAnchor="middle"
                    fontSize="9"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {status === 'computing' ? 'calculating' : status}
                  </text>
                  <text
                    x={xCenter}
                    y={margin.top + innerH + 32}
                    textAnchor="middle"
                    fontSize="10"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {item.record.assembly_name || item.record.assembly}
                  </text>
                  <text
                    x={xCenter}
                    y={margin.top + innerH + 47}
                    textAnchor="middle"
                    fontSize="9"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {(item.record.common_name || item.record.scientific_name || item.record.species_key || '').slice(0, 24)}
                  </text>
                </g>
              )
            }

            let cumulative = 0
            return (
              <g key={item.record.genome_key}>
                {MAJOR_CLASS_ORDER.map((key) => {
                  const val = toNumber(item.classes[key], 0)
                  const start = cumulative
                  const end = cumulative + val
                  cumulative = end
                  const visibleStart = Math.max(start, domainMin)
                  const visibleEnd = Math.min(end, domainMax)
                  if (visibleEnd <= visibleStart) return null
                  const yTop = yForValue(visibleEnd)
                  const yBottom = yForValue(visibleStart)
                  return (
                    <rect
                      key={`${item.record.genome_key}-${key}`}
                      x={x}
                      y={yTop}
                      width={barW}
                      height={Math.max(1, yBottom - yTop)}
                      fill={MAJOR_CLASS_COLORS[key]}
                      opacity={0.92}
                    />
                  )
                })}
                <text
                  x={xCenter}
                  y={margin.top + innerH + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isLight ? '#334155' : '#cbd5e1'}
                >
                  {formatInt(item.total)}
                </text>
                <text
                  x={xCenter}
                  y={margin.top + innerH + 32}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isLight ? '#64748b' : '#94a3b8'}
                >
                  {item.record.assembly_name || item.record.assembly}
                </text>
                <text
                  x={xCenter}
                  y={margin.top + innerH + 47}
                  textAnchor="middle"
                  fontSize="9"
                  fill={isLight ? '#64748b' : '#94a3b8'}
                >
                  {(item.record.common_name || item.record.scientific_name || item.record.species_key || '').slice(0, 24)}
                </text>
              </g>
            )
          })}

          <rect
            x={margin.left}
            y={dragTop}
            width={innerW}
            height={innerH + topBuffer}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseDown={beginDrag}
            onDoubleClick={() => onYZoom(null)}
          />

          {dragBand && (
            <rect
              x={margin.left}
              y={dragTop + Math.min(dragBand.startY, dragBand.currentY)}
              width={innerW}
              height={Math.abs(dragBand.currentY - dragBand.startY)}
              fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
              stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
              strokeDasharray="4 2"
            />
          )}
        </svg>
      </div>

      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Drag a vertical selection to zoom Y. Double-click to reset.
      </div>

      <div className="flex flex-wrap gap-3">
        {MAJOR_CLASS_ORDER.map((key) => (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: MAJOR_CLASS_COLORS[key] }} />
            <span className={isLight ? 'text-gray-600' : 'text-gray-300'}>{MAJOR_CLASS_LABELS[key] || key.replace('_', ' ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function biotypeSubtypePriority(name) {
  const key = String(name || '').trim().toLowerCase()
  if (key === 'lncrna' || key === 'lnc_rna' || key.includes('lncrna') || key.includes('lnc_rna') || key.includes('long_noncoding_rna')) {
    return -1
  }
  return 0
}

function AnnotationSankeyForRecord({ record, basis, isLight }) {
  const [dragRect, setDragRect] = useState(null)
  const [focusSelection, setFocusSelection] = useState(null)
  const [flowAnimTick, setFlowAnimTick] = useState(0)
  const [hoveredNodeId, setHoveredNodeId] = useState('')
  const svgRef = useRef(null)

  const ann = record?.annotation || {}
  const majorCounts = majorClassCountsForAnnotation(ann, basis)
  const biotypeCounts = basis === 'genes'
    ? (ann.gene_biotype_counts || {})
    : (ann.transcript_biotype_counts || {})
  const biotypeMajorClassMap = basis === 'genes'
    ? (ann.gene_biotype_major_class_map || {})
    : (ann.transcript_biotype_major_class_map || {})

  const classBiotypes = {}
  for (const cls of MAJOR_CLASS_ORDER) classBiotypes[cls] = []

  for (const [biotypeName, rawValue] of Object.entries(biotypeCounts || {})) {
    const value = toNumber(rawValue, 0)
    if (value <= 0) continue
    const cls = classifyBiotypeClass(
      biotypeName,
      biotypeMajorClassMap[biotypeName] || biotypeMajorClassMap[String(biotypeName || '').toLowerCase()] || ''
    )
    classBiotypes[cls].push({ name: biotypeName, value })
  }

  const biotypeNodesAll = []
  const maxPerClass = 6
  for (const cls of MAJOR_CLASS_ORDER) {
    const entries = classBiotypes[cls]
      .slice()
      .sort((a, b) => {
        const p = biotypeSubtypePriority(a.name) - biotypeSubtypePriority(b.name)
        if (p !== 0) return p
        if (b.value !== a.value) return b.value - a.value
        return a.name.localeCompare(b.name)
      })
    const top = entries.slice(0, maxPerClass)
    let shown = 0
    for (const entry of top) {
      shown += entry.value
      biotypeNodesAll.push({
        id: `biotype:${cls}:${entry.name}`,
        cls,
        label: entry.name,
        value: entry.value,
        fromMajor: `major:${cls}`,
      })
    }
    const majorValue = toNumber(majorCounts[cls], 0)
    const remainder = Math.max(0, majorValue - shown)
    if (remainder > 0) {
      biotypeNodesAll.push({
        id: `biotype:${cls}:__other__`,
        cls,
        label: 'other biotypes',
        value: remainder,
        fromMajor: `major:${cls}`,
      })
    }
  }
  const hasBiotypeFlowData = biotypeNodesAll.length > 0

  const focusAllClasses = new Set(focusSelection?.allClasses || [])
  const focusBiotypes = new Set(focusSelection?.biotypes || [])
  let biotypeNodes = focusSelection
    ? biotypeNodesAll.filter((node) => focusAllClasses.has(node.cls) || focusBiotypes.has(node.id))
    : biotypeNodesAll
  if (focusSelection && !biotypeNodes.length) {
    biotypeNodes = biotypeNodesAll
  }

  const majorValueByClass = {}
  for (const cls of MAJOR_CLASS_ORDER) majorValueByClass[cls] = 0
  for (const node of biotypeNodes) {
    majorValueByClass[node.cls] += toNumber(node.value, 0)
  }
  const majorNodes = MAJOR_CLASS_ORDER
    .map((cls) => ({
      id: `major:${cls}`,
      cls,
      label: MAJOR_CLASS_LABELS[cls] || cls.replace('_', ' '),
      value: toNumber(majorValueByClass[cls], 0),
    }))
    .filter((node) => node.value > 0)
  const hasMajorFlowData = majorNodes.length > 0

  const rootTotal = Math.max(1, majorNodes.reduce((sum, node) => sum + node.value, 0))

  const width = 920
  const baseHeight = 360
  const margin = { top: 16, right: 220, bottom: 16, left: 18 }
  const baseInnerH = baseHeight - margin.top - margin.bottom
  const labelMinSpacing = 13
  const labelCountMax = Math.max(1, biotypeNodes.length, majorNodes.length, 1)
  const innerH = Math.max(baseInnerH, ((labelCountMax - 1) * labelMinSpacing) + 28)
  const height = margin.top + innerH + margin.bottom
  const dragTop = 0
  const dragBottom = height
  const nodeWidth = 15
  const sourceX = 50
  const majorX = 324
  const biotypeX = 604
  const nodeGap = 2
  const classGap = 6

  const sourceNode = {
    id: 'source',
    label: basis === 'genes' ? 'Genes' : 'Transcripts',
    value: rootTotal,
    cls: 'protein_coding',
  }

  const biotypeGapCount = Math.max(0, biotypeNodes.length - 1)
  const biotypeClassGapCount = Math.max(0, MAJOR_CLASS_ORDER.filter((cls) => biotypeNodes.some((n) => n.cls === cls)).length - 1)
  const biotypeGapPixels = (biotypeGapCount * nodeGap) + (biotypeClassGapCount * classGap)
  const scale = rootTotal > 0 ? Math.max(1e-6, (innerH - biotypeGapPixels) / rootTotal) : 1e-6

  const toSvgPoint = useCallback((evt) => {
    const element = svgRef.current
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    const xFrac = rect.width > 0 ? (evt.clientX - rect.left) / rect.width : 0
    const yFrac = rect.height > 0 ? (evt.clientY - rect.top) / rect.height : 0
    return {
      x: clamp(xFrac, 0, 1) * width,
      y: clamp(yFrac, 0, 1) * height,
    }
  }, [width, height])

  useEffect(() => {
    setFlowAnimTick((prev) => prev + 1)
  }, [focusSelection, basis, record?.genome_key])

  const positions = new Map()
  positions.set(sourceNode.id, { x: sourceX, y: margin.top, h: Math.max(2, sourceNode.value * scale), cls: sourceNode.cls })

  let majorY = margin.top
  for (const node of majorNodes) {
    const h = Math.max(2, node.value * scale)
    positions.set(node.id, { x: majorX, y: majorY, h, cls: node.cls })
    majorY += h + nodeGap
  }

  let biotypeY = margin.top
  for (let i = 0; i < MAJOR_CLASS_ORDER.length; i += 1) {
    const cls = MAJOR_CLASS_ORDER[i]
    const classNodes = biotypeNodes.filter((node) => node.cls === cls)
    for (const node of classNodes) {
      const h = Math.max(2, node.value * scale)
      positions.set(node.id, { x: biotypeX, y: biotypeY, h, cls: node.cls })
      biotypeY += h + nodeGap
    }
    if (classNodes.length > 0 && i < MAJOR_CLASS_ORDER.length - 1) {
      const hasLater = MAJOR_CLASS_ORDER.slice(i + 1).some((laterCls) => biotypeNodes.some((node) => node.cls === laterCls))
      if (hasLater) biotypeY += classGap
    }
  }

  const labelYByNodeId = new Map()
  const assignLabelY = (nodeIds) => {
    const entries = nodeIds
      .map((id) => {
        const pos = positions.get(id)
        if (!pos) return null
        return { id, preferred: pos.y + (pos.h / 2) + 4 }
      })
      .filter(Boolean)
      .sort((a, b) => a.preferred - b.preferred)
    if (!entries.length) return

    const top = margin.top + 10
    const bottom = margin.top + innerH - 6
    const ys = []
    for (let i = 0; i < entries.length; i += 1) {
      const minY = top + (i * labelMinSpacing)
      ys[i] = Math.max(entries[i].preferred, minY, (i > 0 ? ys[i - 1] + labelMinSpacing : minY))
    }
    const overflow = ys[ys.length - 1] - bottom
    if (overflow > 0) {
      for (let i = 0; i < ys.length; i += 1) {
        ys[i] -= overflow
      }
      for (let i = 0; i < ys.length; i += 1) {
        const minY = top + (i * labelMinSpacing)
        if (ys[i] < minY) ys[i] = minY
      }
    }
    for (let i = 0; i < entries.length; i += 1) {
      labelYByNodeId.set(entries[i].id, ys[i])
    }
  }

  assignLabelY([sourceNode.id])
  assignLabelY(majorNodes.map((n) => n.id))
  assignLabelY(biotypeNodes.map((n) => n.id))

  const links = []
  for (const major of majorNodes) {
    links.push({ from: sourceNode.id, to: major.id, value: major.value, cls: major.cls })
  }
  for (const cls of MAJOR_CLASS_ORDER) {
    for (const node of biotypeNodes.filter((item) => item.cls === cls)) {
      links.push({ from: node.fromMajor, to: node.id, value: node.value, cls: node.cls })
    }
  }

  const outOffsets = {}
  const inOffsets = {}
  const getOutY = (id, value) => {
    const pos = positions.get(id)
    if (!pos) return 0
    const current = outOffsets[id] || 0
    const y = pos.y + current + ((value * scale) / 2)
    outOffsets[id] = current + (value * scale)
    return y
  }
  const getInY = (id, value) => {
    const pos = positions.get(id)
    if (!pos) return 0
    const current = inOffsets[id] || 0
    const y = pos.y + current + ((value * scale) / 2)
    inOffsets[id] = current + (value * scale)
    return y
  }

  const linkDrawData = links.map((link, idx) => {
    const fromPos = positions.get(link.from)
    const toPos = positions.get(link.to)
    if (!fromPos || !toPos) return null
    const x1 = fromPos.x + nodeWidth
    const x2 = toPos.x
    const y1 = getOutY(link.from, link.value)
    const y2 = getInY(link.to, link.value)
    const c1 = x1 + ((x2 - x1) * 0.4)
    const c2 = x1 + ((x2 - x1) * 0.6)
    const strokeWidth = Math.max(1, link.value * scale)
    return {
      id: `link-${record.genome_key}-${idx}`,
      ...link,
      x1,
      x2,
      y1,
      y2,
      c1,
      c2,
      strokeWidth,
      hitRect: {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2) - (strokeWidth / 2) - 1,
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1) + strokeWidth + 2,
      },
    }
  }).filter(Boolean)

  const allNodes = [sourceNode, ...majorNodes, ...biotypeNodes]
  const nodeHitRects = allNodes.map((node) => {
    const pos = positions.get(node.id)
    if (!pos) return null
    return {
      id: node.id,
      cls: node.cls,
      x: pos.x,
      y: pos.y,
      width: nodeWidth,
      height: pos.h,
    }
  }).filter(Boolean)

  const applyFlowSelection = useCallback((selection) => {
    const selectedClassAll = new Set()
    const selectedBiotypeIds = new Set()

    for (const nodeRect of nodeHitRects) {
      if (!rectsOverlap(selection, nodeRect)) continue
      if (nodeRect.id === 'source') {
        setFocusSelection(null)
        return
      }
      if (nodeRect.id.startsWith('major:')) {
        selectedClassAll.add(nodeRect.cls)
      } else if (nodeRect.id.startsWith('biotype:')) {
        selectedBiotypeIds.add(nodeRect.id)
      }
    }

    for (const link of linkDrawData) {
      if (!rectsOverlap(selection, link.hitRect)) continue
      if (link.from === 'source' && String(link.to || '').startsWith('major:')) {
        selectedClassAll.add(link.cls)
      } else if (String(link.to || '').startsWith('biotype:')) {
        selectedBiotypeIds.add(link.to)
      }
    }

    if (selectedClassAll.size === 0 && selectedBiotypeIds.size === 0) return
    setFocusSelection({
      allClasses: Array.from(selectedClassAll),
      biotypes: Array.from(selectedBiotypeIds),
    })
  }, [linkDrawData, nodeHitRects])

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toSvgPoint(evt)
    const x = clamp(point.x, 0, width)
    const y = clamp(point.y, dragTop, dragBottom)
    setDragRect({ startX: x, startY: y, currentX: x, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragRect) return undefined

    const onMove = (e) => {
      const point = toSvgPoint(e)
      const x = clamp(point.x, 0, width)
      const y = clamp(point.y, dragTop, dragBottom)
      setDragRect((prev) => (prev ? { ...prev, currentX: x, currentY: y } : prev))
    }

    const onUp = (e) => {
      const point = toSvgPoint(e)
      const x = clamp(point.x, 0, width)
      const y = clamp(point.y, dragTop, dragBottom)
      setDragRect((prev) => {
        if (!prev) return prev
        const left = Math.min(prev.startX, x)
        const right = Math.max(prev.startX, x)
        const top = Math.min(prev.startY, y)
        const bottom = Math.max(prev.startY, y)
        if ((right - left) >= 8 && (bottom - top) >= 8) {
          applyFlowSelection({
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          })
        }
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragRect, toSvgPoint, width, dragTop, dragBottom, applyFlowSelection])

  if (!hasBiotypeFlowData || !hasMajorFlowData) return null

  return (
    <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
          {genomeLabel(record)}
        </div>
        <ZoomOutButton
          active={Boolean(focusSelection)}
          onClick={() => setFocusSelection(null)}
          isLight={isLight}
          title="Reset to full flow"
        />
      </div>
      <div className="overflow-x-auto">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          style={{ cursor: 'crosshair' }}
          onMouseDown={beginDrag}
          onDoubleClick={() => setFocusSelection(null)}
        >
          <g key={`flow-refresh-${flowAnimTick}`} className="stats-sankey-refresh">
            {linkDrawData.map((link) => {
              return (
                <path
                  key={link.id}
                  d={`M ${link.x1} ${link.y1} C ${link.c1} ${link.y1}, ${link.c2} ${link.y2}, ${link.x2} ${link.y2}`}
                  fill="none"
                  stroke={MAJOR_CLASS_COLORS[link.cls] || (isLight ? '#94a3b8' : '#64748b')}
                  strokeOpacity={0.35}
                  strokeWidth={link.strokeWidth}
                />
              )
            })}

            {allNodes.map((node) => {
              const pos = positions.get(node.id)
              if (!pos) return null
              const isHoveredNode = hoveredNodeId === node.id
              const color = node.id === 'source'
                ? (isLight ? '#2563eb' : '#3b82f6')
                : (MAJOR_CLASS_COLORS[node.cls] || (isLight ? '#94a3b8' : '#64748b'))
              const defaultLabelY = pos.y + (pos.h / 2) + 4
              const labelY = labelYByNodeId.get(node.id) || defaultLabelY
              return (
                <g key={`node-${record.genome_key}-${node.id}`}>
                  <rect
                    x={pos.x}
                    y={pos.y}
                    width={nodeWidth}
                    height={pos.h}
                    fill={color}
                    opacity={isHoveredNode ? 1 : 0.88}
                    stroke={isHoveredNode ? (isLight ? '#0f172a' : '#e2e8f0') : 'none'}
                    strokeWidth={isHoveredNode ? 1.5 : 0}
                    rx={3}
                  />
                  {Math.abs(labelY - defaultLabelY) > 1.5 && (
                    <line
                      x1={pos.x + nodeWidth + 1}
                      y1={defaultLabelY - 4}
                      x2={pos.x + nodeWidth + 5}
                      y2={labelY - 4}
                      stroke={isLight ? '#94a3b8' : '#64748b'}
                      strokeWidth="1"
                      strokeOpacity="0.8"
                    />
                  )}
                  <text
                    x={pos.x + nodeWidth + 6}
                    y={labelY}
                    fontSize="10"
                    fontWeight={isHoveredNode ? 700 : 500}
                    fill={isLight ? '#334155' : '#cbd5e1'}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId('')}
                  >
                    {`${node.label} (${formatInt(node.value)})`}
                  </text>
                </g>
              )
            })}
          </g>

          {dragRect && (
            <rect
              x={Math.min(dragRect.startX, dragRect.currentX)}
              y={Math.min(dragRect.startY, dragRect.currentY)}
              width={Math.abs(dragRect.currentX - dragRect.startX)}
              height={Math.abs(dragRect.currentY - dragRect.startY)}
              fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
              stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
              strokeDasharray="4 2"
            />
          )}
        </svg>
      </div>
      <div className={`text-[11px] mt-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Drag a rectangle to focus selected flows. Zoom-out restores the full flow.
      </div>
    </div>
  )
}

function AnnotationSankey({ records, basis, isLight }) {
  const ready = records.filter((r) => (r?.statuses || {}).annotation === 'ready' && r?.annotation)
  if (!ready.length) return null

  return (
    <div className="space-y-3">
      <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
        {basis === 'genes' ? 'Gene' : 'Transcript'} biotype flow by genome
      </div>
      {ready.map((record) => (
        <AnnotationSankeyForRecord
          key={`sankey-${record.genome_key}-${basis}`}
          record={record}
          basis={basis}
          isLight={isLight}
        />
      ))}
    </div>
  )
}

function AnnotationDetails({ records, isLight }) {
  const ready = records.filter((r) => (r?.statuses || {}).annotation === 'ready' && r?.annotation)
  if (!ready.length) return null

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {ready.map((record) => {
        const ann = record.annotation || {}
        const biotypes = Object.entries(ann.gene_biotype_counts || {}).slice(0, 4)
        return (
          <div
            key={`ann-${record.genome_key}`}
            className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}
          >
            <div className={`text-xs font-semibold mb-2 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>{genomeLabel(record)}</div>
            <div className={`grid grid-cols-3 gap-2 text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Genes</div>
                <div className="font-semibold">{formatInt(ann.gene_total)}</div>
              </div>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Transcripts</div>
                <div className="font-semibold">{formatInt(ann.transcript_total)}</div>
              </div>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Single exon genes</div>
                <div className="font-semibold">{formatInt(ann.single_exon_genes)}</div>
              </div>
            </div>
            <div className={`mt-3 text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Top gene biotypes</div>
            <div className="mt-1 space-y-0.5">
              {biotypes.length === 0 && <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No biotype detail</div>}
              {biotypes.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className={isLight ? 'text-gray-600' : 'text-gray-300'}>{name}</span>
                  <span className={isLight ? 'text-gray-700' : 'text-gray-200'}>{formatInt(count)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StructuralHeatmap({ records, isLight, structuralRuntimeStatusByKey, onToggleGenerateForKey }) {
  const [hoveredColumnKey, setHoveredColumnKey] = useState('')
  const [referenceColumnKey, setReferenceColumnKey] = useState('')
  const [columnOrder, setColumnOrder] = useState([])
  const [dragColumnKey, setDragColumnKey] = useState('')
  const [dropColumnKey, setDropColumnKey] = useState('')
  const headerDragRef = useRef({ startX: 0, startY: 0, moved: false, suppressClick: false })
  const displayRecords = records || []
  const tableDrag = useHorizontalDragScroll()
  const structuralStatus = (record) => (record?.statuses || {}).structural || 'missing'
  const hasStructuralData = (record) => Boolean(record?.structural)
  const isReadyRecord = (record) => (
    hasStructuralData(record)
    && ['ready', 'computing'].includes(structuralStatus(record))
  )
  const runtimeStatusForKey = (genomeKey) => structuralRuntimeStatusByKey?.get(genomeKey) || ''
  const readyKeys = new Set(
    displayRecords
      .filter((r) => isReadyRecord(r))
      .map((r) => r.genome_key)
  )

  useEffect(() => {
    const keys = new Set(displayRecords.map((r) => r.genome_key))
    if (referenceColumnKey && !keys.has(referenceColumnKey)) {
      setReferenceColumnKey('')
    }
    if (hoveredColumnKey && !keys.has(hoveredColumnKey)) {
      setHoveredColumnKey('')
    }
    if (dragColumnKey && !keys.has(dragColumnKey)) {
      setDragColumnKey('')
      setDropColumnKey('')
    }
  }, [displayRecords, referenceColumnKey, hoveredColumnKey, dragColumnKey])

  useEffect(() => {
    const incoming = displayRecords.map((record) => record.genome_key)
    setColumnOrder((prev) => {
      const next = prev.filter((key) => incoming.includes(key))
      for (const key of incoming) {
        if (!next.includes(key)) next.push(key)
      }
      const unchanged = next.length === prev.length && next.every((key, idx) => key === prev[idx])
      return unchanged ? prev : next
    })
  }, [displayRecords])

  useEffect(() => {
    if (!dragColumnKey) return undefined
    const onMove = (e) => {
      const drag = headerDragRef.current
      if (!drag.moved) {
        const movedX = Math.abs(e.clientX - drag.startX)
        const movedY = Math.abs(e.clientY - drag.startY)
        if (movedX >= 4 || movedY >= 4) drag.moved = true
      }
      if (!drag.moved) return
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const col = target?.closest?.('[data-struct-col-key]')
      const key = col?.getAttribute?.('data-struct-col-key') || ''
      if (key && key !== dragColumnKey) setDropColumnKey(key)
      else setDropColumnKey('')
    }

    const finishDrag = (e) => {
      const drag = headerDragRef.current
      let finalDropKey = dropColumnKey
      if (drag.moved && e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        const target = document.elementFromPoint(e.clientX, e.clientY)
        const col = target?.closest?.('[data-struct-col-key]')
        const key = col?.getAttribute?.('data-struct-col-key') || ''
        if (key) finalDropKey = key
      }
      if (drag.moved && finalDropKey && finalDropKey !== dragColumnKey) {
        setColumnOrder((prev) => {
          const src = prev.indexOf(dragColumnKey)
          const dst = prev.indexOf(finalDropKey)
          if (src < 0 || dst < 0 || src === dst) return prev
          const next = [...prev]
          const temp = next[src]
          next[src] = next[dst]
          next[dst] = temp
          return next
        })
      }
      if (drag.moved) {
        drag.suppressClick = true
        window.setTimeout(() => {
          headerDragRef.current.suppressClick = false
        }, 0)
      }
      drag.moved = false
      setDragColumnKey('')
      setDropColumnKey('')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', finishDrag)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', finishDrag)
    }
  }, [dragColumnKey, dropColumnKey])

  if (!displayRecords.length) return null

  const recordsByKey = new Map(displayRecords.map((record) => [record.genome_key, record]))
  const orderedRecords = columnOrder.map((key) => recordsByKey.get(key)).filter(Boolean)

  const referenceRecord = referenceColumnKey
    ? (orderedRecords.find((r) => r.genome_key === referenceColumnKey) || null)
    : null
  const isReferenceReady = referenceRecord && readyKeys.has(referenceRecord.genome_key)
  const usableReferenceRecord = isReferenceReady ? referenceRecord : null

  const columnShadeClass = (idx) => {
    if (idx % 2 === 0) return isLight ? 'bg-slate-50/75' : 'bg-slate-800/35'
    return isLight ? 'bg-slate-100/75' : 'bg-slate-700/35'
  }
  const columnInteractiveClass = (idx, key) => {
    const base = columnShadeClass(idx)
    const hover = hoveredColumnKey === key
      ? (isLight ? ' !bg-blue-100/80' : ' !bg-blue-900/45')
      : ''
    const selected = referenceColumnKey === key
      ? (isLight ? ' !bg-blue-200/85' : ' !bg-blue-800/50')
      : ''
    const dragSource = dragColumnKey === key
      ? (isLight ? ' !bg-blue-300/90' : ' !bg-blue-700/60')
      : ''
    const dragTarget = dropColumnKey === key
      ? (isLight ? ' !bg-blue-200/70' : ' !bg-blue-800/40')
      : ''
    return `${base}${hover}${selected}${dragSource}${dragTarget}`
  }
  const formatMetricValue = (metric, value, countValue = null) => {
    if (metric.countKey) {
      const countText = formatInt(countValue)
      const percentText = formatPercent(value)
      if (countText === '—' && percentText === '—') return '—'
      if (countText === '—') return `— (${percentText})`
      if (percentText === '—') return `${countText} (—)`
      return `${countText} (${percentText})`
    }
    if (metric.format === 'percent') return formatPercent(value)
    if (metric.format === 'int') return formatInt(value)
    return formatFloat(value, 2)
  }
  const formatMetricDelta = (metric, delta) => {
    if (!Number.isFinite(delta)) return null
    const normalizedDelta = Math.abs(delta) < 1e-12 ? 0 : delta
    if (metric.format === 'percent') {
      const pct = normalizedDelta * 100
      const sign = pct >= 0 ? '+' : ''
      return `${sign}${pct.toFixed(2)}%`
    }
    const sign = normalizedDelta >= 0 ? '+' : ''
    return `${sign}${normalizedDelta.toFixed(2)}`
  }
  const renderMetricCell = (metric, value, baselineValue, isReference, countValue = null) => {
    const n = Number(value)
    const b = Number(baselineValue)
    const hasDelta = (
      referenceColumnKey
      && !isReference
      && Number.isFinite(n)
      && Number.isFinite(b)
    )

    if (!hasDelta) {
      return formatMetricValue(metric, value, countValue)
    }

    const delta = n - b
    const normalizedDelta = Math.abs(delta) < 1e-12 ? 0 : delta
    const deltaText = formatMetricDelta(metric, delta)
    const deltaClass = normalizedDelta < 0
      ? (isLight ? 'text-rose-700' : 'text-rose-300')
      : (isLight ? 'text-blue-700' : 'text-sky-300')

    return (
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className={`font-semibold ${deltaClass}`}>({deltaText})</span>
        <span>{formatMetricValue(metric, value, countValue)}</span>
      </div>
    )
  }
  const headerLabel = (record) => truncateText(record.assembly_name || record.assembly || 'Genome', 18)
  const headerTitle = (record) => {
    const speciesName = record.common_name || record.scientific_name || record.species_key || 'Genome'
    const assemblyName = record.assembly_name || record.assembly || '—'
    const gca = record.gca || record.assembly || '—'
    return `${speciesName} - ${assemblyName} - ${gca}`
  }
  const isMetricPending = (record, metric) => {
    if (!record?.structural) return false
    const pending = new Set(record.structural?.pending_metrics || [])
    if (pending.has(metric.key)) return true
    if (metric.sequenceBased && record.structural?.sequence_metrics_status === 'computing') return true
    return false
  }
  const isGeneratingRecord = (record) => runtimeStatusForKey(record.genome_key) === 'running'
  const isQueuedRecord = (record) => runtimeStatusForKey(record.genome_key) === 'queued'
  const canGenerateRecord = (record) => (
    STRUCTURAL_SELECTABLE_STATUSES.has(structuralStatus(record))
    && !isGeneratingRecord(record)
    && !isQueuedRecord(record)
    && typeof onToggleGenerateForKey === 'function'
  )
  const placeholderLabel = (record) => {
    if (isGeneratingRecord(record)) return 'Generating'
    if (isQueuedRecord(record)) return 'Queued'
    if (canGenerateRecord(record)) return 'Click to generate'
    return structuralDisplayStatus(structuralStatus(record))
  }
  const metricColWidth = 190
  const genomeColWidth = 188
  const tableWidth = metricColWidth + (orderedRecords.length * genomeColWidth)

  return (
    <div className="space-y-2">
      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Hover columns to highlight. Click a ready column to set reference deltas. Click non-ready columns to generate.
      </div>
      <div
        ref={tableDrag.scrollRef}
        className="hide-scrollbar overflow-x-auto cursor-grab select-none"
        onMouseDown={tableDrag.onMouseDown}
        onMouseMove={tableDrag.onMouseMove}
        onMouseUp={tableDrag.onMouseUp}
        onMouseLeave={tableDrag.onMouseLeave}
        onClickCapture={tableDrag.onClickCapture}
      >
        <table
          className="table-fixed text-xs border-collapse"
          style={{ width: `${tableWidth}px`, minWidth: `${tableWidth}px` }}
          onMouseLeave={() => setHoveredColumnKey('')}
        >
          <colgroup>
            <col style={{ width: `${metricColWidth}px` }} />
            {orderedRecords.map((record) => (
              <col key={`col-${record.genome_key}`} style={{ width: `${genomeColWidth}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={`text-left px-2 py-2 border-b ${isLight ? 'border-gray-200 text-gray-600' : 'border-gray-700 text-gray-300'}`}>Metric</th>
              {orderedRecords.map((record, colIdx) => {
                const ready = isReadyRecord(record)
                const runtime = runtimeStatusForKey(record.genome_key)
                const showRuntimeControl = runtime === 'running' || runtime === 'queued'
                return (
                  <th
                    key={`head-${record.genome_key}`}
                    data-struct-col-key={record.genome_key}
                    title={headerTitle(record)}
                    onMouseEnter={() => {
                      setHoveredColumnKey(record.genome_key)
                      if (dragColumnKey && dragColumnKey !== record.genome_key) {
                        setDropColumnKey(record.genome_key)
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      headerDragRef.current = {
                        startX: e.clientX,
                        startY: e.clientY,
                        moved: false,
                        suppressClick: false,
                      }
                      setDragColumnKey(record.genome_key)
                      setDropColumnKey('')
                    }}
                    onClick={() => {
                      if (headerDragRef.current.suppressClick) return
                      if (ready) {
                        setReferenceColumnKey((prev) => (prev === record.genome_key ? '' : record.genome_key))
                      }
                    }}
                    className={`text-left px-2 py-2 border-b select-none ${isLight ? 'border-gray-200 text-gray-600' : 'border-gray-700 text-gray-300'} ${columnInteractiveClass(colIdx, record.genome_key)} ${ready ? 'cursor-pointer' : 'cursor-grab'}`}
                  >
                    <span className="block truncate">
                      {headerLabel(record)}
                      {referenceColumnKey === record.genome_key ? ' *' : ''}
                    </span>
                    {(showRuntimeControl || !ready) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (showRuntimeControl || canGenerateRecord(record)) {
                            onToggleGenerateForKey(record.genome_key)
                          }
                        }}
                        disabled={!(showRuntimeControl || canGenerateRecord(record))}
                        className={`mt-1 rounded px-1.5 py-0.5 text-[10px] uppercase border ${(showRuntimeControl || canGenerateRecord(record))
                          ? (isLight
                            ? 'bg-[#0099ff] text-white border-[#0088ee] hover:bg-[#0088ee]'
                            : 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500')
                          : (isLight
                            ? 'bg-gray-100 text-gray-500 border-gray-300'
                            : 'bg-gray-800 text-gray-400 border-gray-700')
                          }`}
                      >
                        {showRuntimeControl ? (runtime === 'running' ? 'Generating' : 'Queued') : placeholderLabel(record)}
                      </button>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {STRUCTURAL_METRICS.map((metric, metricIdx) => (
              <tr key={metric.key}>
                <td className={`px-2 py-1.5 border-b ${isLight ? 'border-gray-200 text-gray-700' : 'border-gray-700 text-gray-200'}`}>
                  {metric.label}
                </td>
                {orderedRecords.map((record, colIdx) => {
                  const ready = isReadyRecord(record)
                  const generating = isGeneratingRecord(record)
                  const canGenerate = canGenerateRecord(record)
                  if (ready) {
                    const value = structuralMetricValue(record, metric.key)
                    const countValue = metric.countKey ? structuralMetricValue(record, metric.countKey) : null
                    const pendingMetric = isMetricPending(record, metric)
                    const baseline = usableReferenceRecord
                      ? Number(structuralMetricValue(usableReferenceRecord, metric.key))
                      : null
                    return (
                      <td
                        key={`${record.genome_key}-${metric.key}`}
                        onMouseEnter={() => setHoveredColumnKey(record.genome_key)}
                        onClick={() => setReferenceColumnKey((prev) => (prev === record.genome_key ? '' : record.genome_key))}
                        className={`px-2 py-1.5 border-b cursor-pointer select-none ${isLight ? 'border-gray-200 text-gray-800' : 'border-gray-700 text-gray-100'} ${columnInteractiveClass(colIdx, record.genome_key)}`}
                      >
                        {Number.isFinite(Number(value))
                          ? renderMetricCell(metric, value, baseline, referenceColumnKey === record.genome_key, countValue)
                          : (pendingMetric
                            ? <span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Calculating</span>
                            : <span className={isLight ? 'text-gray-400' : 'text-gray-500'}>—</span>)}
                      </td>
                    )
                  }
                  return (
                    <td
                      key={`${record.genome_key}-${metric.key}`}
                      onMouseEnter={() => setHoveredColumnKey(record.genome_key)}
                      className={`px-2 py-1.5 border-b align-middle ${isLight ? 'border-gray-200 text-gray-500' : 'border-gray-700 text-gray-400'} ${columnInteractiveClass(colIdx, record.genome_key)}`}
                    >
                      <span className={isLight ? 'text-gray-400' : 'text-gray-500'}> </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StructuralClusterPlot({ records, isLight }) {
  const ready = (records || []).filter((r) => (r?.statuses || {}).structural === 'ready' && r?.structural)
  const [enabledMetricKeys, setEnabledMetricKeys] = useState(() => new Set(STRUCTURAL_PLOT_METRICS.map((m) => m.key)))
  const [zoomRange, setZoomRange] = useState(null)
  const [dragRect, setDragRect] = useState(null)
  const [hoveredPointKey, setHoveredPointKey] = useState('')
  const [hoverDetailPointKey, setHoverDetailPointKey] = useState('')
  const svgRef = useRef(null)
  const hoverTimerRef = useRef(null)
  const togglesDrag = useHorizontalDragScroll()
  const plotDrag = useHorizontalDragScroll('svg')

  useEffect(() => {
    const validKeys = new Set(STRUCTURAL_PLOT_METRICS.map((m) => m.key))
    setEnabledMetricKeys((prev) => {
      const next = new Set()
      for (const key of prev) {
        if (validKeys.has(key)) next.add(key)
      }
      return next
    })
  }, [])

  useEffect(() => () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const toggleMetric = (key) => {
    setEnabledMetricKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleAllMetrics = () => {
    setEnabledMetricKeys((prev) => {
      if (prev.size === STRUCTURAL_PLOT_METRICS.length) return new Set()
      return new Set(STRUCTURAL_PLOT_METRICS.map((metric) => metric.key))
    })
  }

  const colorByMetricKey = useMemo(() => {
    const out = new Map()
    STRUCTURAL_PLOT_METRICS.forEach((metric, idx) => {
      out.set(metric.key, STRUCTURAL_PLOT_COLOR_SCALE[idx % STRUCTURAL_PLOT_COLOR_SCALE.length])
    })
    return out
  }, [])

  const enabledMetrics = useMemo(
    () => STRUCTURAL_PLOT_METRICS.filter((metric) => enabledMetricKeys.has(metric.key)),
    [enabledMetricKeys]
  )

  const allPoints = useMemo(() => {
    if (!ready.length) return []

    const metricStats = new Map()
    for (const metric of STRUCTURAL_PLOT_METRICS) {
      const values = []
      for (const record of ready) {
        const raw = structuralMetricValue(record, metric.key)
        const n = Number(raw)
        if (Number.isFinite(n)) values.push(n)
      }
      if (!values.length) continue
      const mean = values.reduce((acc, v) => acc + v, 0) / values.length
      const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / Math.max(1, values.length - 1)
      metricStats.set(metric.key, { mean, sd: Math.sqrt(Math.max(variance, 0)) })
    }

    const speciesStats = new Map()
    for (const record of ready) {
      const values = []
      for (const metric of STRUCTURAL_PLOT_METRICS) {
        const raw = structuralMetricValue(record, metric.key)
        const n = Number(raw)
        if (Number.isFinite(n)) values.push(n)
      }
      if (!values.length) continue
      const mean = values.reduce((acc, v) => acc + v, 0) / values.length
      const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / Math.max(1, values.length - 1)
      speciesStats.set(record.genome_key, { mean, sd: Math.sqrt(Math.max(variance, 0)) })
    }

    const out = []
    for (let metricIdx = 0; metricIdx < STRUCTURAL_PLOT_METRICS.length; metricIdx += 1) {
      const metric = STRUCTURAL_PLOT_METRICS[metricIdx]
      const mStats = metricStats.get(metric.key)
      if (!mStats) continue

      for (let speciesIdx = 0; speciesIdx < ready.length; speciesIdx += 1) {
        const record = ready[speciesIdx]
        const raw = structuralMetricValue(record, metric.key)
        const value = Number(raw)
        const sStats = speciesStats.get(record.genome_key)
        if (!Number.isFinite(value) || !sStats) continue

        const x = (value - mStats.mean) / (mStats.sd > 0 ? mStats.sd : 1)
        const y = (value - sStats.mean) / (sStats.sd > 0 ? sStats.sd : 1)
        const jitterX = ((speciesIdx % 5) - 2) * 0.03
        const jitterY = ((metricIdx % 5) - 2) * 0.03
        out.push({
          key: `${record.genome_key}:${metric.key}`,
          metricKey: metric.key,
          metricLabel: metric.label,
          metricIndex: metricIdx,
          speciesIndex: speciesIdx,
          speciesName: record.common_name || record.scientific_name || record.species_key || 'Genome',
          speciesLabel: genomeLabel(record),
          assemblyLabel: record.assembly_name || record.assembly || record.species_key || 'Genome',
          value,
          x: x + jitterX,
          y: y + jitterY,
        })
      }
    }

    return out
  }, [ready])

  const points = useMemo(() => {
    if (!enabledMetrics.length) return []
    const enabled = new Set(enabledMetrics.map((metric) => metric.key))
    return allPoints.filter((point) => enabled.has(point.metricKey))
  }, [allPoints, enabledMetrics])

  const plotBounds = useMemo(() => {
    if (!allPoints.length) return null
    const xs = allPoints.map((point) => point.x)
    const ys = allPoints.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const xPad = Math.max(0.35, (maxX - minX) * 0.12)
    const yPad = Math.max(0.35, (maxY - minY) * 0.12)
    const xLo = minX - xPad
    const xHi = maxX + xPad
    const yLo = minY - yPad
    const yHi = maxY + yPad
    return {
      xMin: xLo,
      xMax: xHi > xLo ? xHi : (xLo + 1),
      yMin: yLo,
      yMax: yHi > yLo ? yHi : (yLo + 1),
    }
  }, [allPoints])

  const tableMetricColWidth = 190
  const tableGenomeColWidth = 188
  const width = Math.max(780, tableMetricColWidth + (Math.max(1, (records || []).length) * tableGenomeColWidth))
  const height = Math.max(360, Math.min(560, Math.round(width * 0.42)))
  const metricGridColumns = Math.max(2, Math.min(5, Math.floor(width / 235)))
  const allMetricsEnabled = enabledMetricKeys.size === STRUCTURAL_PLOT_METRICS.length
  const margin = { top: 20, right: 24, bottom: 56, left: 60 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const fullXMin = plotBounds?.xMin ?? -1
  const fullXMax = plotBounds?.xMax ?? 1
  const fullYMin = plotBounds?.yMin ?? -1
  const fullYMax = plotBounds?.yMax ?? 1

  useEffect(() => {
    if (!zoomRange || !plotBounds) return
    const next = {
      xMin: clamp(zoomRange.xMin, fullXMin, fullXMax - 0.01),
      xMax: clamp(zoomRange.xMax, fullXMin + 0.01, fullXMax),
      yMin: clamp(zoomRange.yMin, fullYMin, fullYMax - 0.01),
      yMax: clamp(zoomRange.yMax, fullYMin + 0.01, fullYMax),
    }
    if (next.xMax <= next.xMin || next.yMax <= next.yMin) {
      setZoomRange(null)
      return
    }
    const same = (
      Math.abs(next.xMin - zoomRange.xMin) < 1e-9
      && Math.abs(next.xMax - zoomRange.xMax) < 1e-9
      && Math.abs(next.yMin - zoomRange.yMin) < 1e-9
      && Math.abs(next.yMax - zoomRange.yMax) < 1e-9
    )
    if (!same) setZoomRange(next)
  }, [zoomRange, plotBounds, fullXMin, fullXMax, fullYMin, fullYMax])

  const xMin = zoomRange ? zoomRange.xMin : fullXMin
  const xMax = zoomRange ? zoomRange.xMax : fullXMax
  const yMin = zoomRange ? zoomRange.yMin : fullYMin
  const yMax = zoomRange ? zoomRange.yMax : fullYMax
  const xPos = (x) => margin.left + (((x - xMin) / (xMax - xMin)) * innerW)
  const yPos = (y) => margin.top + innerH - (((y - yMin) / (yMax - yMin)) * innerH)
  const xToValue = (localX) => xMin + ((localX / innerW) * (xMax - xMin))
  const yToValue = (localY) => yMin + (((innerH - localY) / innerH) * (yMax - yMin))

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const element = svgRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const x = clamp((evt.clientX - rect.left) - margin.left, 0, innerW)
    const y = clamp((evt.clientY - rect.top) - margin.top, 0, innerH)
    setDragRect({ startX: x, startY: y, currentX: x, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragRect) return undefined
    const element = svgRef.current
    if (!element) return undefined

    const toSelection = (e) => {
      const rect = element.getBoundingClientRect()
      return {
        x: clamp((e.clientX - rect.left) - margin.left, 0, innerW),
        y: clamp((e.clientY - rect.top) - margin.top, 0, innerH),
      }
    }

    const onMove = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => (prev ? { ...prev, currentX: pos.x, currentY: pos.y } : prev))
    }

    const onUp = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => {
        if (!prev) return prev
        const left = Math.min(prev.startX, pos.x)
        const right = Math.max(prev.startX, pos.x)
        const top = Math.min(prev.startY, pos.y)
        const bottom = Math.max(prev.startY, pos.y)
        if ((right - left) < 8 || (bottom - top) < 8) return null
        setZoomRange({
          xMin: clamp(xToValue(left), fullXMin, fullXMax - 0.001),
          xMax: clamp(xToValue(right), fullXMin + 0.001, fullXMax),
          yMin: clamp(yToValue(bottom), fullYMin, fullYMax - 0.001),
          yMax: clamp(yToValue(top), fullYMin + 0.001, fullYMax),
        })
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragRect, innerW, innerH, margin.left, margin.top, xMin, xMax, yMin, yMax, fullXMin, fullXMax, fullYMin, fullYMax])

  const visiblePoints = useMemo(() => {
    return points.filter((point) => (
      point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax
    ))
  }, [points, xMin, xMax, yMin, yMax])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const handlePointEnter = useCallback((pointKey) => {
    clearHoverTimer()
    setHoveredPointKey(pointKey)
    setHoverDetailPointKey('')
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverDetailPointKey(pointKey)
    }, 1000)
  }, [clearHoverTimer])

  const handlePointLeave = useCallback((pointKey) => {
    clearHoverTimer()
    setHoveredPointKey((prev) => (prev === pointKey ? '' : prev))
    setHoverDetailPointKey((prev) => (prev === pointKey ? '' : prev))
  }, [clearHoverTimer])

  const fullXRange = fullXMax - fullXMin
  const fullYRange = fullYMax - fullYMin
  const currentXRange = xMax - xMin
  const currentYRange = yMax - yMin
  const isZoomed = (
    (currentXRange < (fullXRange * 0.85))
    || (currentYRange < (fullYRange * 0.85))
  )

  const labelDrawData = useMemo(() => {
    if (!isZoomed || !visiblePoints.length) return []
    const candidates = visiblePoints.slice(0, 140).map((point) => {
      const cx = xPos(point.x)
      const cy = yPos(point.y)
      const labelX = Math.min(margin.left + innerW - 6, cx + 10)
      return {
        pointKey: point.key,
        text: truncateText(point.assemblyLabel, 24),
        cx,
        cy,
        labelX,
        preferredY: cy,
      }
    }).sort((a, b) => a.preferredY - b.preferredY)

    if (!candidates.length) return []
    const top = margin.top + 8
    const bottom = margin.top + innerH - 8
    const spacing = 12
    const ys = []
    for (let i = 0; i < candidates.length; i += 1) {
      const minY = top + (i * spacing)
      ys[i] = Math.max(candidates[i].preferredY, minY, (i > 0 ? ys[i - 1] + spacing : minY))
    }
    const overflow = ys[ys.length - 1] - bottom
    if (overflow > 0) {
      for (let i = 0; i < ys.length; i += 1) ys[i] -= overflow
      for (let i = 0; i < ys.length; i += 1) {
        const minY = top + (i * spacing)
        if (ys[i] < minY) ys[i] = minY
      }
    }
    return candidates.map((entry, idx) => ({
      ...entry,
      labelY: ys[idx],
    }))
  }, [isZoomed, visiblePoints, margin.left, margin.top, innerW, innerH, xMin, xMax, yMin, yMax])

  const hoverDetailPoint = useMemo(
    () => visiblePoints.find((point) => point.key === hoverDetailPointKey) || null,
    [visiblePoints, hoverDetailPointKey]
  )

  if (!ready.length) {
    return (
      <div className={`rounded-lg border p-3 text-sm ${isLight ? 'border-gray-200 bg-white text-gray-500' : 'border-gray-700 bg-gray-900/40 text-gray-400'}`}>
        Structural cluster plot appears once one or more genomes have structural stats.
      </div>
    )
  }

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Structural feature cluster plot</div>
        <ZoomOutButton
          active={Boolean(zoomRange)}
          onClick={() => setZoomRange(null)}
          isLight={isLight}
          title="Zoom out to full range"
        />
      </div>
      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Toggle structural features and inspect clustering. Drag a rectangle to zoom both axes; double-click to reset.
      </div>

      <div
        ref={togglesDrag.scrollRef}
        className="hide-scrollbar overflow-x-auto cursor-grab select-none"
        onMouseDown={togglesDrag.onMouseDown}
        onMouseMove={togglesDrag.onMouseMove}
        onMouseUp={togglesDrag.onMouseUp}
        onMouseLeave={togglesDrag.onMouseLeave}
        onClickCapture={togglesDrag.onClickCapture}
      >
        <div
          className={`rounded-lg border p-2.5 ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-800/45'}`}
          style={{ width: `${width}px`, minWidth: `${width}px` }}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className={`text-[11px] font-semibold ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>Feature toggles</div>
            <button
              type="button"
              onClick={toggleAllMetrics}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${allMetricsEnabled
                ? (isLight
                  ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
                  : 'bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700')
                : (isLight
                  ? 'bg-[#0099ff] border-[#0088ee] text-white hover:bg-[#0088ee]'
                  : 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500')
                }`}
            >
              {allMetricsEnabled ? 'Deactivate all' : 'Activate all'}
            </button>
          </div>

          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${metricGridColumns}, minmax(0, 1fr))` }}
          >
            {STRUCTURAL_PLOT_METRICS.map((metric) => {
              const enabled = enabledMetricKeys.has(metric.key)
              const color = colorByMetricKey.get(metric.key) || '#3b82f6'
              return (
                <button
                  key={`metric-toggle-${metric.key}`}
                  type="button"
                  onClick={() => toggleMetric(metric.key)}
                  className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] transition-colors border border-transparent ${isLight
                    ? 'hover:bg-white/90'
                    : 'hover:bg-gray-700/45'
                    }`}
                  title={`${enabled ? 'Disable' : 'Enable'} ${metric.label}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: enabled ? color : (isLight ? '#cbd5e1' : '#475569') }}
                    />
                    <span className={enabled
                      ? (isLight ? 'text-gray-800' : 'text-gray-100')
                      : (isLight ? 'text-gray-400' : 'text-gray-500')}
                    >
                      {metric.label}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {points.length > 0 ? (
        <div
          ref={plotDrag.scrollRef}
          className="hide-scrollbar overflow-x-auto cursor-grab select-none"
          onMouseDown={plotDrag.onMouseDown}
          onMouseMove={plotDrag.onMouseMove}
          onMouseUp={plotDrag.onMouseUp}
          onMouseLeave={plotDrag.onMouseLeave}
          onClickCapture={plotDrag.onClickCapture}
        >
          <svg
            ref={svgRef}
            width={width}
            height={height}
            onMouseLeave={() => {
              setHoveredPointKey('')
              setHoverDetailPointKey('')
              clearHoverTimer()
            }}
          >
            {makeTicks(xMin, xMax, 6).map((tick) => {
              const x = xPos(tick)
              return (
                <g key={`sx-${tick}`}>
                  <line
                    x1={x}
                    y1={margin.top}
                    x2={x}
                    y2={margin.top + innerH}
                    stroke={isLight ? '#e2e8f0' : '#334155'}
                    strokeDasharray="3 3"
                  />
                  <text x={x} y={margin.top + innerH + 16} textAnchor="middle" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                    {tick.toFixed(1)}
                  </text>
                </g>
              )
            })}
            {makeTicks(yMin, yMax, 6).map((tick) => {
              const y = yPos(tick)
              return (
                <g key={`sy-${tick}`}>
                  <line
                    x1={margin.left}
                    y1={y}
                    x2={margin.left + innerW}
                    y2={y}
                    stroke={isLight ? '#e2e8f0' : '#334155'}
                    strokeDasharray="3 3"
                  />
                  <text x={margin.left - 8} y={y + 3} textAnchor="end" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                    {tick.toFixed(1)}
                  </text>
                </g>
              )
            })}

            <line
              x1={margin.left}
              y1={margin.top + innerH}
              x2={margin.left + innerW}
              y2={margin.top + innerH}
              stroke={isLight ? '#94a3b8' : '#64748b'}
            />
            <line
              x1={margin.left}
              y1={margin.top}
              x2={margin.left}
              y2={margin.top + innerH}
              stroke={isLight ? '#94a3b8' : '#64748b'}
            />

            <rect
              x={margin.left}
              y={margin.top}
              width={innerW}
              height={innerH}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseDown={beginDrag}
              onDoubleClick={() => setZoomRange(null)}
            />

            {points.map((point) => {
              const cx = xPos(point.x)
              const cy = yPos(point.y)
              const color = colorByMetricKey.get(point.metricKey) || '#3b82f6'
              const isHovered = hoveredPointKey === point.key
              return (
                <circle
                  key={point.key}
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 5.8 : 4.2}
                  fill={color}
                  stroke={isHovered ? (isLight ? '#0f172a' : '#e2e8f0') : (isLight ? '#ffffff' : '#0f172a')}
                  strokeWidth={isHovered ? '2.1' : '1.2'}
                  opacity={isHovered ? 1 : 0.92}
                  onMouseEnter={() => handlePointEnter(point.key)}
                  onMouseLeave={() => handlePointLeave(point.key)}
                />
              )
            })}

            {labelDrawData.map((label) => {
              const isHovered = hoveredPointKey === label.pointKey
              const yOffset = Math.abs(label.labelY - label.cy)
              return (
                <g key={`label-${label.pointKey}`}>
                  {yOffset > 1.5 && (
                    <line
                      x1={label.cx + 5}
                      y1={label.cy}
                      x2={label.labelX - 2}
                      y2={label.labelY - 3}
                      stroke={isHovered ? (isLight ? '#1d4ed8' : '#38bdf8') : (isLight ? '#94a3b8' : '#64748b')}
                      strokeWidth={isHovered ? '1.2' : '0.9'}
                      strokeDasharray="2 2"
                      opacity={0.75}
                    />
                  )}
                  <text
                    x={label.labelX}
                    y={label.labelY}
                    fontSize="10"
                    fill={isHovered ? (isLight ? '#0f172a' : '#f1f5f9') : (isLight ? '#334155' : '#cbd5e1')}
                    fontWeight={isHovered ? '700' : '500'}
                  >
                    {label.text}
                  </text>
                </g>
              )
            })}

            {dragRect && (
              <rect
                x={margin.left + Math.min(dragRect.startX, dragRect.currentX)}
                y={margin.top + Math.min(dragRect.startY, dragRect.currentY)}
                width={Math.abs(dragRect.currentX - dragRect.startX)}
                height={Math.abs(dragRect.currentY - dragRect.startY)}
                fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
                stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
                strokeDasharray="4 2"
              />
            )}

            {hoverDetailPoint && (() => {
              const cx = xPos(hoverDetailPoint.x)
              const cy = yPos(hoverDetailPoint.y)
              const detailMetric = STRUCTURAL_PLOT_METRICS.find((m) => m.key === hoverDetailPoint.metricKey)
              const featureValue = formatFloat(
                hoverDetailPoint.value,
                detailMetric?.format === 'percent' ? 4 : 2
              )
              const text = `${hoverDetailPoint.speciesName} - ${hoverDetailPoint.assemblyLabel} - ${hoverDetailPoint.metricLabel}: ${featureValue}`
              const w = Math.max(56, Math.min(420, Math.round((text.length * 5.7) + 12)))
              let tx = cx + 12
              let ty = cy - 10
              const xMaxTip = margin.left + innerW - w - 6
              if (tx > xMaxTip) tx = Math.max(margin.left + 6, xMaxTip)
              if (ty < margin.top + 14) ty = margin.top + 14
              return (
                <g>
                  <rect
                    x={tx}
                    y={ty - 12}
                    width={w}
                    height={18}
                    rx={4}
                    fill="#0f172a"
                    stroke={isLight ? '#1e293b' : '#334155'}
                    strokeWidth="0.8"
                    opacity="0.93"
                  />
                  <text
                    x={tx + 7}
                    y={ty}
                    fontSize="10"
                    fill="#f8fafc"
                  >
                    {text}
                  </text>
                </g>
              )
            })()}

            <text x={margin.left + innerW / 2} y={height - 8} textAnchor="middle" fontSize="11" fill={isLight ? '#475569' : '#94a3b8'}>
              Metric-centered z-score across species
            </text>
            <text
              x={14}
              y={margin.top + innerH / 2}
              textAnchor="middle"
              fontSize="11"
              fill={isLight ? '#475569' : '#94a3b8'}
              transform={`rotate(-90 14 ${margin.top + innerH / 2})`}
            >
              Species-centered z-score across all structural features
            </text>
          </svg>
        </div>
      ) : (
        <div className={`rounded border px-3 py-2 text-xs ${isLight ? 'border-gray-200 text-gray-500 bg-gray-50' : 'border-gray-700 text-gray-400 bg-gray-800/50'}`}>
          No plottable points with the current metric selection.
        </div>
      )}
    </div>
  )
}

function HomologyScatter({ records, isLight, zoomRange, onZoomRange }) {
  const [dragRect, setDragRect] = useState(null)
  const svgRef = useRef(null)

  const toLocal = useCallback((evt, target = null) => {
    const element = target || svgRef.current || evt.currentTarget
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    }
  }, [])

  const ready = records.filter((r) => (r?.statuses || {}).homology === 'ready' && r?.homology)
  const points = ready
    .map((r) => {
      const hom = r.homology || {}
      const x = Number((hom.coverage || {}).mean)
      const y = Number((hom.identity || {}).mean)
      const rowCount = Number(hom.row_count || 0)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return {
        genome_key: r.genome_key,
        label: genomeLabel(r),
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
        rowCount,
        summary: hom,
      }
    })
    .filter(Boolean)

  const xMin = Math.max(0, toNumber(zoomRange?.xMin, 0))
  const xMax = Math.min(100, Math.max(xMin + 1, toNumber(zoomRange?.xMax, 100)))
  const yMin = Math.max(0, toNumber(zoomRange?.yMin, 0))
  const yMax = Math.min(100, Math.max(yMin + 1, toNumber(zoomRange?.yMax, 100)))

  const width = 560
  const height = 330
  const margin = { top: 14, right: 18, bottom: 44, left: 52 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const maxRows = Math.max(1, ...points.map((p) => p.rowCount))

  const xPos = (x) => {
    const frac = (clamp(x, xMin, xMax) - xMin) / (xMax - xMin)
    return margin.left + (frac * innerW)
  }
  const yPos = (y) => {
    const frac = (clamp(y, yMin, yMax) - yMin) / (yMax - yMin)
    return margin.top + innerH - (frac * innerH)
  }

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toLocal(evt, evt.currentTarget)
    const x = clamp(point.x, 0, innerW)
    const y = clamp(point.y, 0, innerH)
    setDragRect({ startX: x, startY: y, currentX: x, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragRect) return undefined
    const element = svgRef.current
    if (!element) return undefined

    const toSelection = (e) => {
      const rect = element.getBoundingClientRect()
      return {
        x: clamp((e.clientX - rect.left) - margin.left, 0, innerW),
        y: clamp((e.clientY - rect.top) - margin.top, 0, innerH),
      }
    }

    const onMove = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => (prev ? { ...prev, currentX: pos.x, currentY: pos.y } : prev))
    }

    const onUp = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => {
        if (!prev) return prev
        const left = Math.min(prev.startX, pos.x)
        const right = Math.max(prev.startX, pos.x)
        const top = Math.min(prev.startY, pos.y)
        const bottom = Math.max(prev.startY, pos.y)
        if ((right - left) < 8 || (bottom - top) < 8) return null

        const xToValue = (plotX) => xMin + ((plotX / innerW) * (xMax - xMin))
        const yToValue = (plotY) => yMin + (((innerH - plotY) / innerH) * (yMax - yMin))
        const selectedXMin = xToValue(left)
        const selectedXMax = xToValue(right)
        const selectedYMin = yToValue(bottom)
        const selectedYMax = yToValue(top)
        if (selectedXMax > selectedXMin && selectedYMax > selectedYMin) {
          onZoomRange({
            xMin: Math.max(0, selectedXMin),
            xMax: Math.min(100, selectedXMax),
            yMin: Math.max(0, selectedYMin),
            yMax: Math.min(100, selectedYMax),
          })
        }
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragRect, innerW, innerH, xMin, xMax, yMin, yMax, onZoomRange, margin.left, margin.top])

  if (!points.length) {
    return <div className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No homology stats available for selected genomes.</div>
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[580px,1fr] gap-3">
      <div className="overflow-x-auto">
        <svg ref={svgRef} width={width} height={height}>
          <line x1={margin.left} y1={margin.top + innerH} x2={margin.left + innerW} y2={margin.top + innerH} stroke={isLight ? '#94a3b8' : '#475569'} />
          <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerH} stroke={isLight ? '#94a3b8' : '#475569'} />

          {makeTicks(xMin, xMax, 5).map((tick) => (
            <g key={`grid-${tick}`}>
              <line x1={xPos(tick)} y1={margin.top} x2={xPos(tick)} y2={margin.top + innerH} stroke={isLight ? '#e2e8f0' : '#334155'} strokeDasharray="3 3" />
              <text x={xPos(tick)} y={margin.top + innerH + 14} textAnchor="middle" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                {formatFloat(tick, 1)}
              </text>
            </g>
          ))}

          {makeTicks(yMin, yMax, 5).map((tick) => (
            <g key={`y-grid-${tick}`}>
              <line x1={margin.left} y1={yPos(tick)} x2={margin.left + innerW} y2={yPos(tick)} stroke={isLight ? '#e2e8f0' : '#334155'} strokeDasharray="3 3" />
              <text x={margin.left - 8} y={yPos(tick) + 4} textAnchor="end" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>{formatFloat(tick, 1)}</text>
            </g>
          ))}

          {points.filter((p) => p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax).map((point) => {
            const radius = 4 + (10 * Math.sqrt(point.rowCount / maxRows))
            return (
              <g key={`point-${point.genome_key}`}>
                <circle
                  cx={xPos(point.x)}
                  cy={yPos(point.y)}
                  r={radius}
                  fill={isLight ? 'rgba(37,99,235,0.52)' : 'rgba(56,189,248,0.52)'}
                  stroke={isLight ? '#1e3a8a' : '#0369a1'}
                />
                <text
                  x={xPos(point.x)}
                  y={yPos(point.y) - (radius + 3)}
                  textAnchor="middle"
                  fontSize="9"
                  fill={isLight ? '#334155' : '#cbd5e1'}
                >
                  {(point.label || '').slice(0, 24)}
                </text>
              </g>
            )
          })}

          <rect
            x={margin.left}
            y={margin.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseDown={beginDrag}
            onDoubleClick={() => onZoomRange(null)}
          />

          {dragRect && (
            <rect
              x={margin.left + Math.min(dragRect.startX, dragRect.currentX)}
              y={margin.top + Math.min(dragRect.startY, dragRect.currentY)}
              width={Math.abs(dragRect.currentX - dragRect.startX)}
              height={Math.abs(dragRect.currentY - dragRect.startY)}
              fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
              stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
              strokeDasharray="4 2"
            />
          )}

          <text x={margin.left + innerW / 2} y={height - 6} textAnchor="middle" fontSize="11" fill={isLight ? '#475569' : '#94a3b8'}>
            Mean coverage (%)
          </text>
          <text
            x={14}
            y={margin.top + innerH / 2}
            textAnchor="middle"
            fontSize="11"
            fill={isLight ? '#475569' : '#94a3b8'}
            transform={`rotate(-90 14 ${margin.top + innerH / 2})`}
          >
            Mean identity (%)
          </text>
        </svg>
      </div>

      <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
        <div className={`text-xs font-semibold mb-2 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Homology summary</div>
        <div className={`text-[11px] mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
          Drag a rectangle over a cluster to zoom both coverage and identity. Double-click to reset.
        </div>
        <div className="space-y-2">
          {points.map((point) => (
            <div key={`summary-${point.genome_key}`} className={`text-xs pb-2 border-b last:border-b-0 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <div className={`${isLight ? 'text-gray-700' : 'text-gray-200'}`}>{point.label}</div>
              <div className={`grid grid-cols-2 gap-1 mt-1 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                <div>Rows: {formatInt(point.summary.row_count)}</div>
                <div>Identity median: {formatFloat((point.summary.identity || {}).median, 2)}</div>
                <div>Coverage median: {formatFloat((point.summary.coverage || {}).median, 2)}</div>
                <div>P90 identity: {formatFloat((point.summary.identity || {}).p90, 2)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function StatsView({
  theme = 'dark',
  config,
  onConfigChange = null,
  // The genomes the top bar is showing, and which of them this view has switched
  // on. Defaulted so the view still stands up on its own.
  listedGenomes = null,
  activeGenomeKeys = null,
}) {
  const isLight = theme === 'light'
  const panelClass = isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800 border border-gray-700'
  const subtleClass = isLight ? 'bg-gray-50 border border-gray-200' : 'bg-gray-900/40 border border-gray-700'

  const [mode, setMode] = useState('overview')
  const [annotationBasis, setAnnotationBasis] = useState('genes')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState({ records: [], aggregates: {} })
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 })
  const [selectedStructuralKeys, setSelectedStructuralKeys] = useState(new Set())
  const [structuralTaskId, setStructuralTaskId] = useState('')
  const [structuralRunningGenomeKey, setStructuralRunningGenomeKey] = useState('')
  const [structuralQueue, setStructuralQueue] = useState([])
  const [taskState, setTaskState] = useState(null)
  const [annotationZoom, setAnnotationZoom] = useState(null)
  const [homologyZoom, setHomologyZoom] = useState(null)
  const requestSeqRef = useRef(0)
  // Assembly metadata is read by the overview, per genome; the summary here only
  // ever needs the sections the remaining tabs plot.
  const summarySections = SUMMARY_CORE_SECTIONS

  const genomes = useMemo(() => {
    return (config?.active_species || []).map((item) => normalizeGenomeInput(item))
  }, [config?.active_species])

  const genomeOrder = useMemo(() => genomes.map((g) => genomeKeyFromInput(g)), [genomes])
  const placeholdersByKey = useMemo(() => {
    const m = new Map()
    for (const genome of genomes) {
      const placeholder = buildPlaceholderRecord(genome)
      m.set(placeholder.genome_key, placeholder)
    }
    return m
  }, [genomes])

  const fetchSummary = useCallback(async (silent = false) => {
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq

    if (!genomes.length) {
      setSummary({ records: [], aggregates: {} })
      setError('')
      setLoading(false)
      setLoadProgress({ done: 0, total: 0 })
      return
    }

    setError('')
    if (!silent) {
      setLoading(true)
      setLoadProgress({ done: 0, total: 1 })
      setSummary({
        sections: summarySections,
        structural_profile: 'canonical_coding',
        records: genomes.map((g) => buildPlaceholderRecord(g)),
        aggregates: { annotation: {}, structural: {}, homology: {}, assembly: {} },
      })
    }

    try {
      const res = await fetch(`${API_BASE}/api/stats/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genomes,
          sections: summarySections,
          structural_profile: 'canonical_coding',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.detail || 'Failed to load stats summary.')
      }
      if (requestSeqRef.current !== requestSeq) return
      if (Array.isArray(data?.records) && data.records.length) trackAchievement('stats.summary')

      const recordsByKey = new Map(
        (Array.isArray(data?.records) ? data.records : [])
          .filter((record) => record && record.genome_key)
          .map((record) => [record.genome_key, record])
      )
      const mergedRecords = genomeOrder.map((key) => (
        recordsByKey.get(key)
        || placeholdersByKey.get(key)
        || buildErrorRecord(genomes.find((genome) => genomeKeyFromInput(genome) === key) || {}, 'Missing stats record.')
      ))

      setSummary({
        sections: summarySections,
        structural_profile: 'canonical_coding',
        records: mergedRecords,
        aggregates: data?.aggregates || { annotation: {}, structural: {}, homology: {}, assembly: {} },
      })
      setLoadProgress({ done: 1, total: 1 })
    } catch (e) {
      if (requestSeqRef.current !== requestSeq) return
      setSummary({
        sections: summarySections,
        structural_profile: 'canonical_coding',
        records: genomes.map((genome) => buildErrorRecord(genome, e?.message || 'Failed to load stats for genome.')),
        aggregates: { annotation: {}, structural: {}, homology: {}, assembly: {} },
      })
      setError(e?.message || 'Failed to load stats summary.')
      setLoadProgress({ done: 1, total: 1 })
    } finally {
      if (requestSeqRef.current !== requestSeq) return
      setLoading(false)
    }
  }, [genomes, genomeOrder, placeholdersByKey, summarySections])

  useEffect(() => {
    fetchSummary(false)
  }, [fetchSummary])

  const records = summary?.records || []

  useEffect(() => {
    const structuralTargets = records
      .filter((r) => STRUCTURAL_SELECTABLE_STATUSES.has((r?.statuses || {}).structural))
      .map((r) => r.genome_key)
    setSelectedStructuralKeys((prev) => {
      if (prev.size === 0) return new Set(structuralTargets)
      const next = new Set()
      for (const key of prev) {
        if (structuralTargets.includes(key)) next.add(key)
      }
      return next.size ? next : new Set(structuralTargets)
    })
  }, [records])

  useEffect(() => {
    if (!structuralTaskId) return undefined
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stats/tasks/${encodeURIComponent(structuralTaskId)}`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) throw new Error(data?.detail || 'Failed to fetch stats task status.')
        setTaskState(data)
        const runResult = structuralRunningGenomeKey
          ? ((data?.results || {})[structuralRunningGenomeKey] || null)
          : null
        const runStatus = String(runResult?.status || '')
        const runDone = ['ready', 'failed', 'missing', 'canceled'].includes(runStatus)
        if (runStatus === 'ready') trackAchievement('stats.analysed')
        if (runDone || data?.status === 'completed' || data?.status === 'failed') {
          await fetchSummary(true)
          setStructuralTaskId('')
          setStructuralRunningGenomeKey('')
        }
      } catch {
        if (!cancelled) {
          setStructuralTaskId('')
          setStructuralRunningGenomeKey('')
        }
      }
    }

    poll()
    const interval = window.setInterval(poll, 1200)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [structuralTaskId, structuralRunningGenomeKey, fetchSummary])

  const startStructuralTaskForKey = useCallback(async (genomeKey) => {
    if (!genomeKey || structuralTaskId || structuralRunningGenomeKey) return false
    // Set the running key synchronously before the first await so React batches it
    // with any concurrent setStructuralQueue calls from the queue effect. This
    // prevents the queue effect from firing again (with a non-empty queue) before
    // we've had a chance to signal that a task is already starting.
    setStructuralRunningGenomeKey(genomeKey)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/stats/structural/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genomes,
          genome_keys: [genomeKey],
          force: false,
          structural_profile: 'canonical_coding',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Failed to queue structural stats generation.')
      setStructuralTaskId(data.task_id || '')
      setTaskState({ status: 'queued', progress: 0, message: 'Queued structural stats generation.' })
      fetchSummary(true)
      return true
    } catch (e) {
      setError(e?.message || 'Failed to queue structural stats generation.')
      setStructuralRunningGenomeKey('')
      setStructuralTaskId('')
      return false
    }
  }, [genomes, structuralTaskId, structuralRunningGenomeKey, fetchSummary])

  useEffect(() => {
    if (structuralTaskId || structuralRunningGenomeKey) return
    if (!structuralQueue.length) return
    const [nextKey, ...rest] = structuralQueue
    setStructuralQueue(rest)
    startStructuralTaskForKey(nextKey)
  }, [structuralQueue, structuralTaskId, structuralRunningGenomeKey, startStructuralTaskForKey])

  const structuralCandidates = records.filter((r) => STRUCTURAL_PENDING_STATUSES.has((r?.statuses || {}).structural))
  const structuralRuntimeStatusByKey = useMemo(() => {
    const out = new Map()
    if (structuralRunningGenomeKey) out.set(structuralRunningGenomeKey, 'running')
    for (const key of structuralQueue) {
      if (!out.has(key)) out.set(key, 'queued')
    }
    return out
  }, [structuralRunningGenomeKey, structuralQueue])
  const isGenerating = Boolean(structuralRunningGenomeKey || structuralTaskId)

  const handleToggleStructuralKey = (key) => {
    setSelectedStructuralKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const enqueueStructuralKeys = useCallback((keys) => {
    if (!Array.isArray(keys) || keys.length === 0) return
    setStructuralQueue((prev) => {
      const next = [...prev]
      for (const key of keys) {
        if (!key) continue
        if (key === structuralRunningGenomeKey) continue
        if (next.includes(key)) continue
        next.push(key)
      }
      return next
    })
  }, [structuralRunningGenomeKey])

  const cancelStructuralForKey = useCallback(async (key) => {
    if (!key) return
    setStructuralQueue((prev) => prev.filter((queuedKey) => queuedKey !== key))
    if (key === structuralRunningGenomeKey && structuralTaskId) {
      try {
        const res = await fetch(`${API_BASE}/api/stats/structural/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: structuralTaskId,
            genome_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to cancel structural generation.')
        setTaskState((prev) => ({
          ...(prev || {}),
          message: `Cancel requested for ${key}.`,
        }))
      } catch (e) {
        setError(e?.message || 'Failed to cancel structural generation.')
      }
    }
  }, [structuralRunningGenomeKey, structuralTaskId])

  const handleGenerateStructural = async (explicitGenomeKeys = null) => {
    const selectableKeys = new Set(
      records
        .filter((r) => STRUCTURAL_SELECTABLE_STATUSES.has((r?.statuses || {}).structural))
        .map((r) => r.genome_key)
    )
    const requested = Array.isArray(explicitGenomeKeys) && explicitGenomeKeys.length
      ? explicitGenomeKeys
      : Array.from(selectedStructuralKeys)
    const genomeKeys = requested.filter((key) => (
      selectableKeys.has(key)
      && key !== structuralRunningGenomeKey
      && !structuralQueue.includes(key)
    ))
    if (!genomeKeys.length) return
    enqueueStructuralKeys(genomeKeys)
  }
  const handleGenerateStructuralForKey = (key) => {
    if (!key) return
    const runtimeStatus = structuralRuntimeStatusByKey.get(key) || ''
    if (runtimeStatus === 'running' || runtimeStatus === 'queued') {
      cancelStructuralForKey(key)
      return
    }
    const record = records.find((r) => r.genome_key === key)
    const status = (record?.statuses || {}).structural || 'missing'
    if (!STRUCTURAL_SELECTABLE_STATUSES.has(status)) return
    enqueueStructuralKeys([key])
  }

  // Analyses are stored in the same place the genome selector stores them, so a
  // report produced in either view is already there for the other.
  const handleAnalysisStored = useCallback((updater) => {
    trackAchievement('stats.analysed')
    if (!onConfigChange) return
    onConfigChange((prev) => ({
      ...prev,
      genome_analysis_reports: updater(prev?.genome_analysis_reports || {}),
    }))
  }, [onConfigChange])

  const modeButton = (id, label) => {
    const active = mode === id
    return (
      <button
        type="button"
        key={id}
        onClick={() => setMode(id)}
        className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${active
          ? (isLight ? 'bg-[#0099ff] text-white border-[#0099ff]' : 'bg-blue-600 text-white border-blue-500')
          : (isLight ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
          }`}
      >
        {label}
      </button>
    )
  }

  if (!genomes.length) {
    return (
      <div className="h-full overflow-y-auto pr-1">
        <div className={`${panelClass} rounded-xl p-5`}>
          <div className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
            Activate one or more genomes to analyse them and to view annotation, structural,
            homology, and assembly statistics.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className={`${panelClass} rounded-xl p-4 space-y-4`}>
        {error && (
          <div className={`rounded-lg border px-3 py-2 text-sm ${isLight ? 'bg-red-50 text-red-700 border-red-200' : 'bg-red-900/20 text-red-300 border-red-700/40'}`}>
            {error}
          </div>
        )}

        {loading && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${isLight ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-blue-900/20 text-blue-300 border-blue-700/40'}`}>
            <span className="font-semibold mr-2">Stats summary:</span>
            Loading selected genomes ({loadProgress.done}/{loadProgress.total})
          </div>
        )}

        {(isGenerating || structuralQueue.length > 0) && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${isLight ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-blue-900/20 text-blue-300 border-blue-700/40'}`}>
            <span className="font-semibold mr-2">Structural stats:</span>
            {structuralRunningGenomeKey
              ? `${taskState?.message || 'Generating...'} [${structuralRunningGenomeKey}]`
              : 'Waiting to start queued genomes...'}
            {structuralRunningGenomeKey && (
              <span className="ml-2">({Math.round((Number(taskState?.progress) || 0) * 100)}%)</span>
            )}
            {structuralQueue.length > 0 && (
              <span className="ml-2">Queue: {structuralQueue.length}</span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {modeButton('overview', 'Overview')}
          {modeButton('annotation', 'Annotation')}
          {modeButton('structural', 'Structural')}
          {modeButton('homology', 'Homology')}
        </div>

        <div className={`${subtleClass} rounded-xl p-3`}>
          {loading && records.length === 0 && mode !== 'overview' && (
            <div className="flex items-center justify-center py-16">
              <div className={`w-8 h-8 border-4 border-t-transparent rounded-full animate-spin mr-3 ${isLight ? 'border-[#0099ff]' : 'border-blue-500'}`} />
              <span className={isLight ? 'text-gray-600' : 'text-gray-300'}>Loading stats summary...</span>
            </div>
          )}

          {/* The overview reads the stored analysis reports rather than the
              stats summary, so it renders straight away and does not wait on
              the section fetch the other tabs need. */}
          {mode === 'overview' && (
            <GenomeAnalysisOverview
              genomes={listedGenomes || config?.active_species || []}
              theme={theme}
              activeGenomeKeys={activeGenomeKeys}
              config={config}
              analysisReports={config?.genome_analysis_reports || {}}
              fileOverrides={config?.genome_file_overrides || {}}
              onAnalysisStored={handleAnalysisStored}
            />
          )}

          {records.length > 0 && mode === 'annotation' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>Counts:</span>
                <button
                  type="button"
                  onClick={() => setAnnotationBasis('genes')}
                  className={`px-2.5 py-1 rounded text-xs border ${annotationBasis === 'genes'
                    ? (isLight ? 'bg-[#0099ff] text-white border-[#0099ff]' : 'bg-blue-600 text-white border-blue-500')
                    : (isLight ? 'bg-white text-gray-700 border-gray-300' : 'bg-gray-700 text-gray-200 border-gray-600')
                    }`}
                >
                  Genes
                </button>
                <button
                  type="button"
                  onClick={() => setAnnotationBasis('transcripts')}
                  className={`px-2.5 py-1 rounded text-xs border ${annotationBasis === 'transcripts'
                    ? (isLight ? 'bg-[#0099ff] text-white border-[#0099ff]' : 'bg-blue-600 text-white border-blue-500')
                    : (isLight ? 'bg-white text-gray-700 border-gray-300' : 'bg-gray-700 text-gray-200 border-gray-600')
                    }`}
                >
                  Transcripts
                </button>
                <ZoomOutButton
                  active={Boolean(annotationZoom)}
                  onClick={() => setAnnotationZoom(null)}
                  isLight={isLight}
                  title="Zoom out to full Y range"
                  className="ml-1"
                />
              </div>
              <AnnotationChart
                records={records}
                basis={annotationBasis}
                isLight={isLight}
                yZoom={annotationZoom}
                onYZoom={setAnnotationZoom}
              />
              <AnnotationSankey records={records} basis={annotationBasis} isLight={isLight} />
              <AnnotationDetails records={records} isLight={isLight} />
            </div>
          )}

          {records.length > 0 && mode === 'structural' && (
            <div className="space-y-3">
              <StructuralHeatmap
                records={records}
                isLight={isLight}
                structuralRuntimeStatusByKey={structuralRuntimeStatusByKey}
                onToggleGenerateForKey={handleGenerateStructuralForKey}
              />
              <StructuralClusterPlot records={records} isLight={isLight} />

              {structuralCandidates.length > 0 && (
                <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
                  <div className={`text-xs font-semibold mb-2 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                    Generate structural stats (canonical protein-coding profile)
                  </div>
                  <div className="space-y-1.5 mb-3">
                    {structuralCandidates.map((record) => (
                      <label key={`struct-${record.genome_key}`} className={`flex items-center justify-between text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedStructuralKeys.has(record.genome_key)}
                            disabled={(record.statuses || {}).structural === 'computing'}
                            onChange={() => handleToggleStructuralKey(record.genome_key)}
                          />
                          {genomeLabel(record)}
                        </span>
                        <span className={`uppercase ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                          {(() => {
                            const runtime = structuralRuntimeStatusByKey.get(record.genome_key) || ''
                            if (runtime === 'running') return 'Generating'
                            if (runtime === 'queued') return 'Queued'
                            return structuralDisplayStatus((record.statuses || {}).structural)
                          })()}
                        </span>
                      </label>
                    ))}
                  </div>
                  {structuralQueue.length > 0 && (
                    <div className={`text-[11px] mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                      Queued: {structuralQueue.length}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleGenerateStructural}
                    disabled={selectedStructuralKeys.size === 0}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold border ${selectedStructuralKeys.size === 0
                      ? (isLight ? 'bg-gray-100 text-gray-400 border-gray-200' : 'bg-gray-800 text-gray-500 border-gray-700')
                      : (isLight ? 'bg-[#0099ff] text-white border-[#0099ff] hover:bg-[#0088ee]' : 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500')
                      }`}
                  >
                    Add selected to queue
                  </button>
                </div>
              )}
            </div>
          )}

          {records.length > 0 && mode === 'homology' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <ZoomOutButton
                  active={Boolean(homologyZoom)}
                  onClick={() => setHomologyZoom(null)}
                  isLight={isLight}
                  title="Zoom out to full plot range"
                />
              </div>
              <HomologyScatter
                records={records}
                isLight={isLight}
                zoomRange={homologyZoom}
                onZoomRange={setHomologyZoom}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { memo, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react'
import { trackAchievement } from '../achievements/tracker.js'
import { LOCKED_ICON_PATH } from '../utils/lockIcons'
import { FONT_MONO } from '../utils/typography'
import TranscriptSplicingHeatmapBase, { heatColorFromFraction } from './TranscriptSplicingHeatmap'
import { computeExonCoverage, exonCoverageProfile } from '../utils/exonCoverage'
import FeatureExplorerExonsPanelBase from './FeatureExplorerExonsPanel'
import FeatureExplorerSequencesPanelBase from './FeatureExplorerSequencesPanel'
import FeatureExplorerProteinsPanelBase from './FeatureExplorerProteinsPanel'
import FeatureExplorerStructurePanelBase from './FeatureExplorerStructurePanel'
import ExportSequencesPanelBase from './ExportSequencesPanel'
import GenomeTool from './sequence-view/GenomeTool'
import './sequence-view/controls.css'
import { genomePillLabels } from './GenomePill'
import { genomeColorResolver } from '../genomeColorSchemes'
import { getGenomeKey } from '../utils/genomeIdentity'
import ScreenshotExportModal from './ScreenshotExportModal'
import BrowserScrollRail from './BrowserScrollRail'
import { SCROLL_RAIL_WIDTH } from '../utils/browserScrollRail'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'
import {
  buildTranscriptSegments,
  intronFlankRanges,
  orderedExonsFivePrimeToThreePrime,
  orientedBoundaries,
} from './featureExplorerTranscriptGeometry'
import { buildTranscriptExonMap } from './featureExplorerExonUtils'

import {
  beginWheelGesture,
  markWheelHandled,
  readWheelEvent,
  resolveBrowsingControls,
  resolveWheelAction,
} from '../utils/browsingControls'
import { API_BASE } from '../backendRuntime'
import { computeTranscriptMetadata } from '../utils/transcriptSequenceFeatures'
import useScreenshotTargets from '../hooks/useScreenshotTargets'
import {
  buildDefaultScreenshotName,
  buildForeignObjectMarkup,
  buildSvgDocument,
  rasterizeSvgMarkup,
} from '../utils/screenshotExport'
// The panels below the transcript tracks do not depend on the tracks' zoom or
// hover state, so they are memoised: a redraw of the tracks (every committed
// zoom, every exon hover) does not re-render thousands of elements they own.
// Their callback props come from useStableCallback for the same reason.
const TranscriptSplicingHeatmap = memo(TranscriptSplicingHeatmapBase)
const FeatureExplorerExonsPanel = memo(FeatureExplorerExonsPanelBase)
const FeatureExplorerSequencesPanel = memo(FeatureExplorerSequencesPanelBase)
const FeatureExplorerProteinsPanel = memo(FeatureExplorerProteinsPanelBase)
const FeatureExplorerStructurePanel = memo(FeatureExplorerStructurePanelBase)
const ExportSequencesPanel = memo(ExportSequencesPanelBase)

/** A function whose identity never changes but which always calls the latest `fn`. */
function useStableCallback(fn) {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args) => ref.current?.(...args), [])
}

const BROWSER_COLORS = {
  light: {
    // Same greys as the genome browser ruler, sampled from www.ensembl.org.
    rulerLine: '#787878',
    rulerText: '#787878',
    tickMajor: '#787878',
    exonProteinCoding: '#3366cc',
    intronLine: '#868e96',
  },
  dark: {
    rulerLine: '#8b8b8b',
    rulerText: '#8b8b8b',
    tickMajor: '#8b8b8b',
    exonProteinCoding: '#5b8def',
    intronLine: '#5c5f66',
  },
}
const TRANSCRIPT_TRACK_ROW_HEIGHT = 42
const TRANSCRIPT_TRACK_MIN_VIEW_SPAN_BP = 24
// How long a zoom or pan has to pause before the rows are redrawn at the new
// view. Until then the drawn rows are moved with a transform (see
// applyTranscriptViewPreview), so a gesture costs no React renders at all.
const TRANSCRIPT_VIEW_COMMIT_IDLE_MS = 110
// Wheel zoom draws the point it started on towards the middle of the track.
// Per step the point's distance from the centre is multiplied by
// exp(-PULL * |ln(zoom factor)|), so the pull depends on how far the view has
// zoomed, not on how many wheel events that took: zooming 2x brings the point
// about 65% of the way to the centre, 4x about 88%.
const TRANSCRIPT_ZOOM_CENTRE_PULL = 1.5
// The point being zoomed on is kept while the pointer stays put. Otherwise each
// step would pick up whatever had just slid under the pointer, and zooming at
// the edge of the track would turn into a steady pan.
const TRANSCRIPT_ZOOM_ANCHOR_MOVE_PX = 4
const TRANSCRIPT_ZOOM_ANCHOR_IDLE_MS = 800

/**
 * The transcript track spans one gene, not a chromosome, so the genome
 * browser's rate would cross its whole zoom range in a couple of notches. These
 * are the rates this view has always used; only the formula is now shared.
 */
const TRANSCRIPT_TRACK_BROWSING_TUNING = Object.freeze({
  zoomSensitivity: 0.00195,
  pinchSensitivity: 0.00195,
  panAmplification: 1,
  // Zooming out past the whole gene should stop, not start scrolling the page.
  // A scroll that began outside the panel still passes through (see the
  // window-capture listener on the track viewport).
  zoomAtExtentHandoff: false,
})
const TRANSCRIPT_TRACK_BASEBLOCK_MIN_PX_PER_BP = 1.1
const TRANSCRIPT_TRACK_BASEBLOCK_MAX_SPAN_BP = 2200
const TRANSCRIPT_TRACK_BASEBLOCK_MAX_COUNT = 1800
const TRANSCRIPT_TRACK_BASETEXT_MIN_PX_PER_BP = 8
const TRANSCRIPT_TRACK_BASETEXT_MAX_COUNT = 420
// Intron bases shown either side of each exon–intron boundary once individual
// bases are drawn, so the splice sites can be read.
const TRANSCRIPT_TRACK_INTRON_FLANK_BP = 10
// What one sequence request may cover (the backend's limit is 100 kb), and how
// far past the gene's ends to fetch so the intron flanks at its ends are there.
const TRANSCRIPT_SEQUENCE_MAX_FETCH_BP = 99000
const TRANSCRIPT_SEQUENCE_FLANK_BP = 200
const FEATURE_SECTION_JUMPS = [
  { key: 'genes', label: 'Genes' },
  { key: 'transcript', label: 'Transcripts' },
  { key: 'exons', label: 'Exons' },
  { key: 'proteins', label: 'Proteins' },
  { key: 'structure', label: 'Structure' },
  { key: 'export', label: 'Export' },
]

const SPLICE_LOCK_ICON_SIZE = 21
const SPLICE_LOCK_GUTTER_WIDTH = 28
// The exon coverage heatmap row pinned above the transcripts. It shares the
// transcript rows' expand/collapse set under this id, which no transcript has.
const EXON_COVERAGE_ROW_ID = '__exon_coverage__'
const EXON_COVERAGE_ROW_LABEL = 'Exon coverage heatmap'
const EXON_COVERAGE_LEGEND_GRADIENT = 'linear-gradient(90deg, #3b82f6 0%, #8b5cf6 33%, #f59e0b 66%, #ef4444 100%)'
const BASE_COMPLEMENT_MAP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }

/** `top` laid over `bottom` at `alpha`, as one opaque `#rrggbb`. */
function blendHexColor(top, bottom, alpha) {
  const a = clamp(Number(alpha) || 0, 0, 1)
  const t = parseInt(String(top || '').replace('#', ''), 16)
  const b = parseInt(String(bottom || '').replace('#', ''), 16)
  if (!Number.isFinite(t) || !Number.isFinite(b)) return top
  const mix = (shift) => Math.round((((t >> shift) & 255) * a) + (((b >> shift) & 255) * (1 - a)))
  return `#${[16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, '0')).join('')}`
}

/** Near-black or near-white, whichever reads better on a `#rrggbb` fill. */
function readableTextOn(hex) {
  const n = parseInt(String(hex || '').replace('#', ''), 16)
  if (!Number.isFinite(n)) return '#111827'
  const channel = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = (0.2126 * channel((n >> 16) & 255)) + (0.7152 * channel((n >> 8) & 255)) + (0.0722 * channel(n & 255))
  return luminance > 0.33 ? '#111827' : '#ffffff'
}

/** Which of `positions` fall in any of the inclusive `ranges`, within [from, to]. */
function positionsInRanges(ranges, from, to) {
  const out = new Set()
  for (const range of ranges) {
    const start = Math.max(from, range.start)
    const end = Math.min(to, range.end)
    for (let pos = start; pos <= end; pos += 1) out.add(pos)
  }
  return out
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function lerp(a, b, t) {
  return a + ((b - a) * t)
}

function easeOutCubic(t) {
  const v = clamp(Number(t) || 0, 0, 1)
  return 1 - ((1 - v) ** 3)
}

function reverseComplementSequence(sequence) {
  return String(sequence || '')
    .toUpperCase()
    .split('')
    .reverse()
    .map((base) => BASE_COMPLEMENT_MAP[base] || base)
    .join('')
}

function formatCoord(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

function transcriptLength(tx) {
  const start = Number(tx?.start)
  const end = Number(tx?.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, (Math.round(end) - Math.round(start)) + 1)
}

function sortTranscripts(rawTranscripts) {
  return [...(rawTranscripts || [])].sort((a, b) => {
    const canonicalDelta = Number(Boolean(b?.is_canonical)) - Number(Boolean(a?.is_canonical))
    if (canonicalDelta !== 0) return canonicalDelta
    const startDelta = Number(a?.start || 0) - Number(b?.start || 0)
    if (startDelta !== 0) return startDelta
    return String(a?.id || '').localeCompare(String(b?.id || ''))
  })
}

function defaultActiveTranscriptIds(orderedTranscripts) {
  const canonical = orderedTranscripts.filter((tx) => Boolean(tx?.is_canonical))
  const nonCanonical = orderedTranscripts.filter((tx) => !tx?.is_canonical)
  const selected = []

  if (canonical.length > 0) {
    selected.push(canonical[0].id)
    for (const tx of nonCanonical.slice(0, 4)) {
      selected.push(tx.id)
    }
  } else {
    for (const tx of orderedTranscripts.slice(0, 5)) {
      selected.push(tx.id)
    }
  }
  return selected
}

function defaultExpandedTranscriptIds(orderedTranscripts) {
  const canonicalId = orderedTranscripts.find((tx) => Boolean(tx?.is_canonical))?.id
  return canonicalId ? [canonicalId] : []
}

function transcriptDisplayId(rawId) {
  const text = String(rawId || '')
  if (text.length <= 26) return text
  return `${text.slice(0, 23)}...`
}

function formatStrand(strand) {
  const s = String(strand || '')
  if (s === '+') return 'Forward'
  if (s === '-') return 'Reverse'
  return '—'
}

function normalizeTagToken(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
}

function displayTagLabel(normalizedTag) {
  const tag = String(normalizedTag || '')
  if (!tag) return ''
  if (tag === 'mane_select') return 'MANE select'
  if (tag === 'ensembl_canonical') return 'Ensembl canonical'
  return tag.replace(/_/g, ' ')
}

function extractTagTokensFromString(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value) return []
  const out = []
  const hasAssignment = value.includes('=')
  if (hasAssignment) {
    const parts = value.split(';')
    for (const part of parts) {
      const segment = String(part || '').trim()
      if (!segment) continue
      const eqIndex = segment.indexOf('=')
      if (eqIndex >= 0) {
        const key = segment.slice(0, eqIndex).trim().toLowerCase()
        const rhs = segment.slice(eqIndex + 1).trim()
        if ((key === 'tag' || key === 'tags') && rhs) {
          rhs
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .forEach((entry) => out.push(entry))
        }
      }
    }
    return out
  }
  return value
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function collectTranscriptTagTokens(value, collector, mode = 'generic') {
  if (!value) return
  if (Array.isArray(value)) {
    value.forEach((item) => collectTranscriptTagTokens(item, collector, mode))
    return
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = String(key || '').toLowerCase()
      if (normalizedKey === 'tag' || normalizedKey === 'tags') {
        extractTagTokensFromString(nested).forEach((token) => collector(token))
      } else if (typeof nested === 'string' && nested.includes('tag=')) {
        extractTagTokensFromString(nested).forEach((token) => collector(token))
      } else if (
        typeof nested === 'string' &&
        (nested.toLowerCase().includes('mane_select') || nested.toLowerCase().includes('ensembl_canonical'))
      ) {
        nested
          .split(/[;,|]/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          .forEach((token) => collector(token))
      } else {
        collectTranscriptTagTokens(nested, collector, mode)
      }
    }
    return
  }
  const text = String(value || '')
  if (!text.trim()) return
  if (mode === 'attributes') {
    if (text.includes('tag=')) {
      extractTagTokensFromString(text).forEach((token) => collector(token))
      return
    }
    if (text.toLowerCase().includes('mane_select') || text.toLowerCase().includes('ensembl_canonical')) {
      text
        .split(/[;,|]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((token) => collector(token))
    }
    return
  }
  extractTagTokensFromString(text).forEach((token) => collector(token))
}

function getTranscriptTagInfo(tx) {
  const labels = []
  const normalizedSet = new Set()
  const addToken = (token) => {
    const normalized = normalizeTagToken(token)
    if (!normalized) return
    if (!normalizedSet.has(normalized)) {
      normalizedSet.add(normalized)
      labels.push(displayTagLabel(normalized))
    }
  }

  if (tx?.mane_select === true || tx?.is_mane_select === true) addToken('MANE_Select')
  if (String(tx?.mane_status || '').toLowerCase().includes('select')) addToken('MANE_Select')
  if (tx?.is_canonical) addToken('canonical')

  collectTranscriptTagTokens(tx?.tag, addToken, 'generic')
  collectTranscriptTagTokens(tx?.tags, addToken, 'generic')
  collectTranscriptTagTokens(tx?.attributes, addToken, 'attributes')

  return {
    labels,
    normalizedSet,
    hasManeSelect: normalizedSet.has('mane_select'),
    hasCanonical: normalizedSet.has('canonical') || normalizedSet.has('ensembl_canonical') || Boolean(tx?.is_canonical),
  }
}

function moveId(order, sourceId, targetId, position = 'before') {
  const sourceIndex = order.indexOf(sourceId)
  const targetIndex = order.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return order
  if (sourceIndex === targetIndex) return order

  const next = [...order]
  next.splice(sourceIndex, 1)
  const adjustedTargetIndex = next.indexOf(targetId)
  if (adjustedTargetIndex < 0) return order
  const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
  next.splice(insertIndex, 0, sourceId)
  return next
}

function reverseComplement(seq) {
  const map = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }
  return String(seq || '')
    .toUpperCase()
    .split('')
    .reverse()
    .map((base) => map[base] || 'N')
    .join('')
}

function getCodonIntervals(tx) {
  const cdsList = Array.isArray(tx?.cds_list) ? tx.cds_list : []
  if (cdsList.length === 0) return null
  const starts = cdsList.map((cds) => Number(cds?.start)).filter(Number.isFinite)
  const ends = cdsList.map((cds) => Number(cds?.end)).filter(Number.isFinite)
  if (starts.length === 0 || ends.length === 0) return null
  const cdsStart = Math.min(...starts)
  const cdsEnd = Math.max(...ends)
  const strand = String(tx?.strand || '+')

  if (strand === '-') {
    return {
      start: { start: Math.max(1, cdsEnd - 2), end: cdsEnd },
      stop: { start: cdsStart, end: cdsStart + 2 },
      strand,
    }
  }
  return {
    start: { start: cdsStart, end: cdsStart + 2 },
    stop: { start: Math.max(1, cdsEnd - 2), end: cdsEnd },
    strand,
  }
}

function transcriptInfoRowCount(metadata, codonStatus) {
  if (!metadata) return 0
  let rows = 2 // ID/biotype + length/exons
  if (metadata.isProteinCoding && metadata.hasCds) {
    rows += 3 // CDS/trans + CDS exons/5'UTR + 3'UTR/...
    if (!codonStatus || codonStatus.loading || codonStatus.error) rows += 1
    else rows += 2
  }
  return rows
}

function formatPercent(fraction) {
  const value = Number(fraction)
  if (!Number.isFinite(value)) return '—'
  const pct = value * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`
}

function formatBasesWithShare(bases, whole) {
  const b = Number(bases) || 0
  const w = Number(whole) || 0
  return `${formatCoord(b)} bp${w > 0 ? ` (${formatPercent(b / w)})` : ''}`
}

const EXON_COVERAGE_TEXT_ROW_PX = 20
const EXON_COVERAGE_CHART_ROW_PX = 84

/**
 * The exon coverage row's info panel, as grid rows of one or two cells. Built
 * once and used both to draw the panel and to size the row, so the two cannot
 * disagree about how tall it is. Each cell's `hint` is its hover explanation:
 * one or two short sentences on what the number is, not how to read the gene.
 */
function exonCoverageInfoRows(stats, chrom, profile = []) {
  const s = stats || {}
  const n = Number(s.activeCount) || 0
  const rows = [[{
    key: 'basis',
    label: 'Based on',
    value: `${formatCoord(n)} active transcript${n === 1 ? '' : 's'} of ${formatCoord(s.totalCount)} total`,
    hint: 'Every figure here uses only the transcripts switched on in the list. Switch transcripts on or off to change them.',
  }]]
  if (n === 0 || !s.spanLength) {
    rows.push([{ key: 'empty', label: '', value: 'Activate a transcript to see its exon coverage.' }])
    return rows
  }
  const chromLabel = String(chrom || '').trim()
  const covered = Number(s.coveredBases) || 0
  rows.push([
    {
      key: 'span',
      label: 'Span',
      value: `${chromLabel ? `${chromLabel}:` : ''}${formatCoord(s.spanStart)}–${formatCoord(s.spanEnd)}`,
      hint: 'From the first base to the last base of any active transcript.',
    },
    { key: 'span-length', label: 'Span length', value: `${formatCoord(s.spanLength)} bp`, hint: 'Number of bases in the span, introns included.' },
  ])
  rows.push([
    {
      key: 'covered',
      label: 'Exonic bases',
      value: formatBasesWithShare(covered, s.spanLength),
      hint: 'Bases in an exon of at least one active transcript, as a share of the span.',
    },
    {
      key: 'uncovered',
      label: 'Non-exonic bases',
      value: formatBasesWithShare(s.uncoveredBases, s.spanLength),
      hint: 'Bases in the span that are intronic in every active transcript, as a share of the span.',
    },
  ])
  rows.push([
    {
      key: 'mean',
      label: 'Mean coverage',
      value: `${formatPercent(s.meanCoverageFraction)} of active transcripts`,
      hint: 'On average, the share of active transcripts that include an exonic base. 100% means every exonic base is in every active transcript.',
    },
    {
      key: 'depth',
      label: 'Mean depth',
      value: `${(Number(s.meanTranscriptsPerCoveredBase) || 0).toFixed(2)} transcripts per exonic base`,
      hint: 'The same average as a count: how many active transcripts include a typical exonic base.',
    },
  ])
  rows.push([
    {
      key: 'blocks',
      label: 'Exonic blocks',
      value: formatCoord(s.exonicBlocks),
      hint: 'Separate stretches of exon once the exons of all active transcripts are overlaid.',
    },
    {
      key: 'peak',
      label: 'Peak depth',
      value: `${formatCoord(s.maxCount)} of ${formatCoord(n)}`,
      hint: 'The most active transcripts that share any one base.',
    },
  ])
  const shared = [{
    key: 'constitutive',
    label: 'In every active transcript',
    value: formatBasesWithShare(s.constitutiveBases, covered),
    hint: 'Exonic bases present in all active transcripts, as a share of exonic bases.',
  }]
  if (n > 1) {
    shared.push({
      key: 'unique',
      label: 'In only one transcript',
      value: formatBasesWithShare(s.uniqueBases, covered),
      hint: 'Exonic bases found in just one active transcript, as a share of exonic bases.',
    })
  }
  rows.push(shared)
  rows.push([{
    key: 'coding',
    label: 'Coding in any transcript',
    value: formatBasesWithShare(s.codingBases, covered),
    hint: 'Exonic bases inside the coding sequence of at least one active transcript, as a share of exonic bases.',
  }])
  if (Array.isArray(profile) && profile.length > 0) {
    rows.push([{
      key: 'profile',
      type: 'chart',
      height: EXON_COVERAGE_CHART_ROW_PX,
      label: 'Coverage along the gene',
      hint: `The span cut into ${formatCoord(profile.length)} equal slices from 5′ to 3′. `
        + 'Bar height is the average coverage of the exonic bases in each slice; a gap means no exon there.',
      bins: profile,
    }])
  }
  return rows
}

function exonCoverageInfoPanelHeight(rows) {
  return rows.reduce((sum, row) => sum + (row[0]?.height || EXON_COVERAGE_TEXT_ROW_PX), 0) + 14
}

function transcriptInfoPanelHeight(metadata, codonStatus) {
  const rows = transcriptInfoRowCount(metadata, codonStatus)
  if (rows <= 0) return 0
  return (rows * 20) + 14
}

function getFeatureBoundaryCoords(segment, featureType) {
  if (featureType === 'cds') {
    // Segment ends are half-open (see buildTranscriptSegments); boundaries are
    // inclusive, like the exon's own, so the two kinds compare alike.
    return { featureStart: Number(segment.start), featureEnd: Number(segment.end) - 1 }
  }
  return { featureStart: Number(segment.exonStart), featureEnd: Number(segment.exonEnd) }
}

/**
 * Where an inclusive boundary base meets its neighbour, as a coordinate to draw
 * at. A feature's genomic-left base is drawn from its own start; its
 * genomic-right base runs to the next position, so that last base is inside the
 * line rather than beyond it. Which of 5' and 3' is on the right depends on the
 * strand.
 */
function boundaryEdgeCoord(coord, isFivePrime, strand) {
  const value = Number(coord)
  const onRight = strand === '-' ? isFivePrime : !isFivePrime
  return onRight ? value + 1 : value
}

function exonKeyFromBounds(fivePrime, threePrime) {
  return `${Number(fivePrime)}:${Number(threePrime)}`
}

function intronKeyFromBounds(threePrimeBoundary, nextFivePrimeBoundary) {
  const a = Number(threePrimeBoundary)
  const b = Number(nextFivePrimeBoundary)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  return `${Math.min(a, b)}:${Math.max(a, b)}`
}

function segmentBoundaryMatch(segment, transcriptId, hoveredBoundaryFeature, strand) {
  if (!hoveredBoundaryFeature) {
    return { isFeatureHover: false, matchFivePrime: false, matchThreePrime: false, fivePrime: null, threePrime: null }
  }

  const hoveredType = hoveredBoundaryFeature.type
  if (hoveredType === 'cds' && !segment.coding) {
    return { isFeatureHover: false, matchFivePrime: false, matchThreePrime: false, fivePrime: null, threePrime: null }
  }

  const { featureStart, featureEnd } = getFeatureBoundaryCoords(segment, hoveredType)
  const boundaries = orientedBoundaries(featureStart, featureEnd, strand)

  const matchFivePrime = Number(boundaries.fivePrime) === Number(hoveredBoundaryFeature.fivePrime)
  const matchThreePrime = Number(boundaries.threePrime) === Number(hoveredBoundaryFeature.threePrime)
  const isFeatureHover = (
    transcriptId === hoveredBoundaryFeature.transcriptId &&
    matchFivePrime &&
    matchThreePrime
  )
  return {
    isFeatureHover,
    matchFivePrime,
    matchThreePrime,
    fivePrime: boundaries.fivePrime,
    threePrime: boundaries.threePrime,
  }
}

/**
 * A small bar chart of exon coverage along the gene, 5' on the left as the
 * transcript rows draw it. Each bar is one slice of the span; its height is
 * the mean coverage of that slice's exonic bases, in the heatmap's colours.
 */
function ExonCoverageProfileChart({ cell, stats, strand, chrom, isLight }) {
  const bins = Array.isArray(cell?.bins) ? cell.bins : []
  const chartHeight = 40
  const muted = isLight ? 'text-gray-500' : 'text-gray-400'
  const guide = isLight ? '#d1d5db' : '#4b5563'
  const chromLabel = String(chrom || '').trim()
  const fivePrime = strand === '-' ? stats?.spanEnd : stats?.spanStart
  const threePrime = strand === '-' ? stats?.spanStart : stats?.spanEnd
  return (
    <div className="col-span-2 flex flex-col" style={{ height: `${cell.height}px` }}>
      <div className="h-5 truncate" title={cell.hint}>{cell.label}</div>
      <div className="flex items-stretch gap-1.5">
        <div className={`w-8 shrink-0 flex flex-col justify-between text-right text-[9px] leading-none ${muted}`} style={{ height: `${chartHeight + 4}px` }}>
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          className="flex-1 min-w-0"
          style={{ height: `${chartHeight + 4}px` }}
          viewBox={`0 -2 ${bins.length} ${chartHeight + 4}`}
          preserveAspectRatio="none"
        >
          {[0, chartHeight / 2].map((y) => (
            <line key={`guide-${y}`} x1={0} x2={bins.length} y1={y} y2={y} stroke={guide} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={bins.length} y1={chartHeight} y2={chartHeight} stroke={guide} vectorEffect="non-scaling-stroke" />
          {bins.map((bin, index) => {
            const hasExon = bin.meanCoverageFraction !== null && bin.meanCoverageFraction !== undefined
            const barHeight = hasExon ? Math.max(1.5, bin.meanCoverageFraction * chartHeight) : 0
            const range = `${chromLabel ? `${chromLabel}:` : ''}${formatCoord(Math.min(bin.start, bin.end))}–${formatCoord(Math.max(bin.start, bin.end))}`
            return (
              <g key={`profile-${bin.start}`}>
                {hasExon && (
                  <rect
                    x={index + 0.1}
                    y={chartHeight - barHeight}
                    width={0.8}
                    height={barHeight}
                    fill={heatColorFromFraction(bin.meanCoverageFraction)}
                    pointerEvents="none"
                  />
                )}
                <rect x={index} y={-2} width={1} height={chartHeight + 4} fill="transparent">
                  <title>
                    {hasExon
                      ? `${range} · ${formatCoord(bin.exonicBases)} of ${formatCoord(bin.length)} bp exonic · ${formatPercent(bin.meanCoverageFraction)} avg coverage`
                      : `${range} · no exonic bases`}
                  </title>
                </rect>
              </g>
            )
          })}
        </svg>
      </div>
      <div className={`flex justify-between pl-[38px] text-[9px] leading-4 ${muted}`}>
        <span>5′ · {formatCoord(fivePrime)}</span>
        <span>{formatCoord(threePrime)} · 3′</span>
      </div>
    </div>
  )
}

function TranscriptRuler({
  longestTranscript,
  isLight,
  viewBoxWidth,
  palette,
  leftMargin,
  rightMargin,
  reverseOrientation,
}) {
  if (!longestTranscript) {
    return (
      <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        No active transcript available for ruler coordinates.
      </div>
    )
  }

  const axisLeft = leftMargin
  const axisRight = viewBoxWidth - rightMargin
  const axisWidth = Math.max(1, axisRight - axisLeft)
  const start = Number(longestTranscript.start)
  const end = Number(longestTranscript.end)
  const length = transcriptLength(longestTranscript)
  const fractions = [0, 0.25, 0.5, 0.75, 1]
  const axisY = 34

  const xForFraction = (fraction) => axisLeft + (axisWidth * fraction)
  const topCoordForFraction = (fraction) => (
    reverseOrientation
      ? Math.round(end - ((end - start) * fraction))
      : Math.round(start + ((end - start) * fraction))
  )
  const offsetForFraction = (fraction) => Math.max(1, Math.round(1 + ((length - 1) * fraction)))

  return (
    <svg className="w-full h-[74px]" viewBox={`0 0 ${viewBoxWidth} 74`} preserveAspectRatio="xMinYMid meet">
      <line
        x1={axisLeft}
        y1={axisY}
        x2={axisRight}
        y2={axisY}
        stroke={palette.rulerLine}
        strokeWidth="1"
      />

      {fractions.map((fraction) => {
        const x = xForFraction(fraction)
        return (
          <g key={`marker-${fraction}`}>
            <line
              x1={x}
              y1={axisY}
              x2={x}
              y2={axisY - 9}
              stroke={palette.tickMajor}
              strokeWidth="1"
            />
            <line
              x1={x}
              y1={axisY}
              x2={x}
              y2={axisY + 9}
              stroke={palette.tickMajor}
              strokeWidth="1"
            />
            <text
              x={x}
              y={14}
              textAnchor="middle"
              fontSize="12"
              fontFamily={FONT_MONO}
              fill={palette.rulerText}
            >
              {formatCoord(topCoordForFraction(fraction))}
            </text>
            <text
              x={x}
              y={66}
              textAnchor="middle"
              fontSize="12"
              fontFamily={FONT_MONO}
              fill={palette.rulerText}
            >
              {formatCoord(offsetForFraction(fraction))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function FeatureExplorerView({
  theme = 'dark',
  config,
  genomeKey = '',
  selectedGenome = null,
  focusGene = null,
  seedQuery = '',
  onFocusGene = null,
  genomes = [],
  focusGeneByGenome = {},
  onSelectGenome = null,
  screenshotMode = false,
  onScreenshotModeChange = null,
  onScreenshotAvailabilityChange = null,
  screenshotToggleButtonRef = null,
}) {
  const isLight = theme === 'light'
  const palette = BROWSER_COLORS[isLight ? 'light' : 'dark']
  const activeGenomeKey = String(genomeKey || '').trim()
  const hasGenome = Boolean(activeGenomeKey && selectedGenome?.files?.gff3)
  // The genome pill and the list behind it, built the way the sequence view
  // builds its own so the two views wear and switch genomes identically. What
  // each genome would open on is its focused gene.
  const resolveGenomeColour = useMemo(() => genomeColorResolver(config), [config])
  const genomeOptions = useMemo(
    () => (Array.isArray(genomes) ? genomes : []).map((item) => {
      const key = getGenomeKey(item)
      const name = item?.display_name || item?.species || key
      const gene = focusGeneByGenome?.[key] || null
      return {
        key,
        label: name,
        species: item,
        pill: {
          name,
          assembly: item?.assembly_name || item?.assembly || '',
          colour: resolveGenomeColour(item),
          tooltip: genomePillLabels(item).pillTooltip,
        },
        at: String(gene?.name || gene?.id || '').trim(),
      }
    }).filter((item) => item.key),
    [genomes, focusGeneByGenome, resolveGenomeColour],
  )
  const handleGenomeOptionChange = useCallback((key) => {
    const option = genomeOptions.find((item) => item.key === key)
    if (option) onSelectGenome?.(option.species)
  }, [genomeOptions, onSelectGenome])
  const externalFocusGeneId = String(focusGene?.id || '').trim()
  const externalFocusGeneName = String(focusGene?.name || '').trim()
  const externalFocusQuery = (externalFocusGeneName || externalFocusGeneId).trim()

  const [query, setQuery] = useState('')
  const [resolved, setResolved] = useState(null)
  const [activeTranscriptIds, setActiveTranscriptIds] = useState(new Set())
  const [manualOrderIds, setManualOrderIds] = useState([])
  const [expandedTranscriptIds, setExpandedTranscriptIds] = useState(new Set())
  const [collapseInactiveRows, setCollapseInactiveRows] = useState(true)
  const [exonCoverageRowActive, setExonCoverageRowActive] = useState(true)
  const [exonCoverageRowHovered, setExonCoverageRowHovered] = useState(false)
  const [geneSectionCollapsed, setGeneSectionCollapsed] = useState(false)
  const [transcriptsSectionCollapsed, setTranscriptsSectionCollapsed] = useState(false)
  const [transcriptListCollapsed, setTranscriptListCollapsed] = useState(false)
  const [isTranscriptBoxSelectMode, setIsTranscriptBoxSelectMode] = useState(false)
  const [transcriptSelectionRect, setTranscriptSelectionRect] = useState(null)
  const [transcriptViewRange, setTranscriptViewRange] = useState(null)
  const [transcriptDetailMode, setTranscriptDetailMode] = useState('segment')
  const transcriptDetailModeRef = useRef('segment')
  transcriptDetailModeRef.current = transcriptDetailMode
  const [transcriptVisibleSequence, setTranscriptVisibleSequence] = useState({
    key: '',
    start: 0,
    end: 0,
    sequence: '',
    loading: false,
  })
  const [codonStatusById, setCodonStatusById] = useState({})
  const [splicePathSelection, setSplicePathSelection] = useState({
    hasSelection: false,
    selectedNodeId: '',
    selectedTranscriptIds: [],
    byTranscript: {},
  })
  const [spliceFocusedTranscriptId, setSpliceFocusedTranscriptId] = useState('')
  const [spliceHoveredTranscriptId, setSpliceHoveredTranscriptId] = useState('')
  const [spliceSelectionClearSignal, setSpliceSelectionClearSignal] = useState(0)
  const [hoveredBoundaryFeature, setHoveredBoundaryFeature] = useState(null)
  const [hoveredInactiveTranscriptId, setHoveredInactiveTranscriptId] = useState('')
  const [selectedExonStateKey, setSelectedExonStateKey] = useState('')
  const [clickedExonInfo, setClickedExonInfo] = useState(null)
  const [exportSeedSequence, setExportSeedSequence] = useState(null)
  const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dragSourceId, setDragSourceId] = useState('')
  const [insertTargetId, setInsertTargetId] = useState('')
  const [insertPosition, setInsertPosition] = useState('before')
  const [mouseDownId, setMouseDownId] = useState('')
  const externalFocusSeenRef = useRef('')
  const seededOnceRef = useRef(false)
  const suppressClickAfterDragRef = useRef(false)
  const transcriptTrackViewportRef = useRef(null)
  const transcriptSelectionDragRef = useRef(null)
  const transcriptZoomAnimationRef = useRef(0)
  const liveTranscriptViewStartRef = useRef(null)
  const liveTranscriptViewEndRef = useRef(null)
  const pendingViewRangeRafRef = useRef(0)
  // The view the rows were last rendered at, the pending commit of the live
  // view to state, and whether the live view is the whole gene.
  const committedTranscriptViewRef = useRef({ start: null, end: null })
  const transcriptViewCommitTimerRef = useRef(0)
  const liveTranscriptViewIsFullRef = useRef(true)
  const transcriptWheelHandlerRef = useRef(null)
  const transcriptZoomAnchorRef = useRef(null)
  const transcriptWheelGestureRef = useRef({ lastTs: 0, kind: '', direction: 0, source: '', mode: '' })
  const browsingSchemeId = config?.browsing_control_scheme
  const browsingControls = useMemo(
    () => resolveBrowsingControls({ browsing_control_scheme: browsingSchemeId }, TRANSCRIPT_TRACK_BROWSING_TUNING),
    [browsingSchemeId]
  )
  const transcriptSelectionRectRef = useRef(null)
  const transcriptSequenceRequestKeyRef = useRef('')
  const transcriptVisibleSequenceReqRef = useRef(0)
  const featureExplorerRootRef = useRef(null)
  // Menus are portalled into the root so they inherit its tokens. Held as state
  // so the render after mount already has it.
  const [genomeMenuRoot, setGenomeMenuRoot] = useState(null)
  const setFeatureExplorerRoot = useCallback((node) => {
    featureExplorerRootRef.current = node
    setGenomeMenuRoot(node)
  }, [])
  const contentScrollRef = useRef(null)
  const screenshotContentRef = useRef(null)
  const geneSectionRef = useRef(null)
  const transcriptsSectionRef = useRef(null)
  const transcriptPanelScreenshotRef = useRef(null)
  const spliceGraphScreenshotRef = useRef(null)
  const sequencePanelScreenshotRef = useRef(null)
  const exonsSectionRef = useRef(null)
  const exonAtlasScreenshotRef = useRef(null)
  const exonDetailScreenshotRef = useRef(null)
  const proteinsSectionRef = useRef(null)
  const proteinsScreenshotRef = useRef(null)
  const structureSectionRef = useRef(null)
  const structureScreenshotRef = useRef(null)
  // The structure panel supplies its own raster snapshot; see below.
  const structureSnapshotRef = useRef(null)
  const exportSectionRef = useRef(null)
  // "A long way down": the first time the Export section scrolls into view. One
  // observer, attached with the section and dropped as soon as it has fired.
  const exportSectionObserverRef = useRef(null)
  const attachExportSection = useCallback((node) => {
    exportSectionRef.current = node
    exportSectionObserverRef.current?.disconnect()
    exportSectionObserverRef.current = null
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      trackAchievement('fe.exportReached')
      observer.disconnect()
    }, { threshold: 0.2 })
    observer.observe(node)
    exportSectionObserverRef.current = observer
  }, [])
  const exonInfoPopupRef = useRef(null)
  const {
    targets: screenshotTargets,
    upsertTarget: upsertScreenshotTarget,
    removeTarget: removeScreenshotTarget,
  } = useScreenshotTargets()

  const orderedTranscripts = useMemo(
    () => sortTranscripts(resolved?.transcripts || []),
    [resolved?.transcripts]
  )

  const applyDefaultTranscriptActivity = useCallback((transcripts) => {
    const defaults = defaultActiveTranscriptIds(transcripts)
    setActiveTranscriptIds(new Set(defaults))
    setManualOrderIds(transcripts.map((tx) => tx.id))
    setExpandedTranscriptIds(new Set(defaultExpandedTranscriptIds(transcripts)))
    setCodonStatusById({})
    setCollapseInactiveRows(true)
    setExonCoverageRowActive(true)
  }, [])

  const resolveGene = useCallback(async (rawQuery, options = {}) => {
    const q = String(rawQuery || '').trim()
    const propagate = options.propagate !== false
    if (!q || !hasGenome) return null

    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/resolve_id?genome=${encodeURIComponent(activeGenomeKey)}&query=${encodeURIComponent(q)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Failed to resolve gene in selected genome.')

      const sortedTranscripts = sortTranscripts(data?.transcripts || [])
      const nextResolved = {
        ...data,
        transcripts: sortedTranscripts,
      }
      setResolved(nextResolved)
      applyDefaultTranscriptActivity(sortedTranscripts)

      if (propagate && typeof onFocusGene === 'function' && nextResolved?.gene) {
        onFocusGene(nextResolved.gene)
      }
      return nextResolved
    } catch (e) {
      setResolved(null)
      setActiveTranscriptIds(new Set())
      setManualOrderIds([])
      setExpandedTranscriptIds(new Set())
      setCodonStatusById({})
      setError(e?.message || 'Failed to resolve gene.')
      return null
    } finally {
      setLoading(false)
    }
  }, [activeGenomeKey, applyDefaultTranscriptActivity, hasGenome, onFocusGene])

  useEffect(() => {
    if (!hasGenome) return
    const focusGeneId = String(focusGene?.id || '').trim()
    const focusGeneName = String(focusGene?.name || '').trim()
    const externalQuery = focusGeneName || focusGeneId
    if (!externalQuery) return
    const normalized = externalQuery.toLowerCase()
    if (externalFocusSeenRef.current === normalized) return
    externalFocusSeenRef.current = normalized
    const currentQuery = String(query || '').trim()
    const currentMatchesId = currentQuery && focusGeneId && currentQuery.toLowerCase() === focusGeneId.toLowerCase()
    const currentMatchesName = currentQuery && focusGeneName && currentQuery.toLowerCase() === focusGeneName.toLowerCase()
    if (!currentMatchesId && !currentMatchesName) {
      setQuery(externalQuery)
    }
    resolveGene(externalQuery, { propagate: false })
  }, [focusGene?.id, focusGene?.name, hasGenome, query, resolveGene])

  useEffect(() => {
    if (!hasGenome) return
    if (seededOnceRef.current) return
    const initialSeed = String(seedQuery || '').trim()
    if (!initialSeed) return
    if (resolved?.gene?.id) return
    seededOnceRef.current = true
    setQuery(initialSeed)
    resolveGene(initialSeed, { propagate: false })
  }, [hasGenome, resolved?.gene?.id, resolveGene, seedQuery])

  useEffect(() => {
    setSelectedExonStateKey('')
    setClickedExonInfo(null)
    setExportSeedSequence(null)
  }, [resolved?.gene?.id])

  useEffect(() => {
    if (!clickedExonInfo) return undefined
    if (screenshotMode) return undefined
    const handlePointerDown = (event) => {
      const target = event?.target
      const insideExonFeature = Boolean(target?.closest?.('[data-feature-exon-candidate="true"]'))
      if (!insideExonFeature) {
        setClickedExonInfo(null)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [clickedExonInfo, screenshotMode])

  const defaultScreenshotDir = useMemo(() => {
    const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
    return base ? `${base}/screenshots` : ''
  }, [config?.output_dir])

  const screenshotAvailable = Boolean(resolved?.gene) && screenshotTargets.length > 0
  const isResolvingFocusedGene = Boolean(
    hasGenome &&
    !resolved?.gene &&
    loading &&
    externalFocusQuery
  )

  useEffect(() => {
    onScreenshotAvailabilityChange?.('feature_explorer', screenshotAvailable)
    return () => onScreenshotAvailabilityChange?.('feature_explorer', false)
  }, [onScreenshotAvailabilityChange, screenshotAvailable])

  useEffect(() => {
    if (!screenshotAvailable) {
      onScreenshotModeChange?.(false)
      setSelectedScreenshotTarget(null)
    }
  }, [onScreenshotModeChange, screenshotAvailable])

  const buildFeatureScreenshotSnapshot = useCallback((node, options = {}) => {
    if (!node) throw new Error('Screenshot target is no longer available.')

    const backgroundColor = isLight ? '#ffffff' : '#1f2937'
    const popupNode = options.popupNode || null
    const nodeRect = node.getBoundingClientRect()
    const nodeWidth = Math.max(1, Math.round(node.scrollWidth || node.clientWidth || nodeRect.width || 1))
    const nodeHeight = Math.max(1, Math.round(node.scrollHeight || node.clientHeight || nodeRect.height || 1))

    const layers = [
      {
        node,
        rect: nodeRect,
        width: nodeWidth,
        height: nodeHeight,
      },
    ]

    if (popupNode) {
      const popupRect = popupNode.getBoundingClientRect()
      const popupWidth = Math.max(1, Math.round(popupNode.scrollWidth || popupNode.clientWidth || popupRect.width || 1))
      const popupHeight = Math.max(1, Math.round(popupNode.scrollHeight || popupNode.clientHeight || popupRect.height || 1))
      layers.push({
        node: popupNode,
        rect: popupRect,
        width: popupWidth,
        height: popupHeight,
      })
    }

    const minLeft = Math.min(...layers.map((layer) => layer.rect.left))
    const minTop = Math.min(...layers.map((layer) => layer.rect.top))
    const maxRight = Math.max(...layers.map((layer) => layer.rect.left + layer.width))
    const maxBottom = Math.max(...layers.map((layer) => layer.rect.top + layer.height))
    const width = Math.max(1, Math.round(maxRight - minLeft))
    const height = Math.max(1, Math.round(maxBottom - minTop))

    const body = layers.map((layer) => {
      const x = Math.round(layer.rect.left - minLeft)
      const y = Math.round(layer.rect.top - minTop)
      const markup = buildForeignObjectMarkup(layer.node, { width: layer.width, height: layer.height })
      return `<foreignObject x="${x}" y="${y}" width="${layer.width}" height="${layer.height}">${markup}</foreignObject>`
    }).join('')

    return {
      width,
      height,
      backgroundColor,
      svgMarkup: buildSvgDocument({
        width,
        height,
        body,
        backgroundColor,
      }),
    }
  }, [isLight])

  // The structure panel renders through WebGL inside an iframe, and neither
  // survives DOM serialisation: foreignObject rasterises a canvas as a blank
  // rectangle and cannot reach into another document at all. The viewer hands
  // back a PNG of what it drew, which is composited over the iframe's footprint.
  const buildStructureScreenshotSnapshot = useCallback(async () => {
    const root = structureScreenshotRef.current
    if (!root) throw new Error('Screenshot target is no longer available.')

    const base = buildFeatureScreenshotSnapshot(root)
    const frame = root.querySelector('iframe')
    const capture = structureSnapshotRef.current
    if (!frame || typeof capture !== 'function') return base

    let dataUri = ''
    try {
      dataUri = String((await capture(root))?.canvasDataUri || '')
    } catch {
      dataUri = ''
    }
    if (!dataUri.startsWith('data:image/')) return base

    const rootRect = root.getBoundingClientRect()
    const frameRect = frame.getBoundingClientRect()
    const image = [
      '<image',
      `x="${Math.round(frameRect.left - rootRect.left)}"`,
      `y="${Math.round(frameRect.top - rootRect.top)}"`,
      `width="${Math.round(frameRect.width)}"`,
      `height="${Math.round(frameRect.height)}"`,
      'preserveAspectRatio="xMidYMid meet"',
      `xlink:href="${dataUri}" />`,
    ].join(' ')

    return { ...base, svgMarkup: base.svgMarkup.replace('</svg>', `${image}</svg>`) }
  }, [buildFeatureScreenshotSnapshot])

  const buildSpliceGraphScreenshotSnapshot = useCallback(() => {
    const root = spliceGraphScreenshotRef.current
    if (!root) throw new Error('Screenshot target is no longer available.')

    const viewport = root.querySelector('[data-splice-heatmap-viewport="true"]')
    const scrollRegion = root.querySelector('[data-splice-heatmap-scroll="true"]')
    const graphic = root.querySelector('[data-splice-heatmap-graphic="true"]')
    const footer = root.querySelector('[data-splice-heatmap-footer="true"]')
    if (!viewport || !scrollRegion || !graphic || !footer) {
      return buildFeatureScreenshotSnapshot(root)
    }

    const rootComputed = window.getComputedStyle(root)
    const graphicWidth = Math.max(
      1,
      Math.round(Number(graphic.getAttribute('width')) || graphic.viewBox?.baseVal?.width || graphic.getBoundingClientRect().width || 1),
    )
    const graphicHeight = Math.max(
      1,
      Math.round(Number(graphic.getAttribute('height')) || graphic.viewBox?.baseVal?.height || graphic.getBoundingClientRect().height || 1),
    )
    const footerWidth = Math.max(
      1,
      Math.round(footer.scrollWidth || footer.clientWidth || footer.getBoundingClientRect().width || 1),
    )
    const footerHeight = Math.max(
      1,
      Math.round(footer.scrollHeight || footer.clientHeight || footer.getBoundingClientRect().height || 1),
    )
    const rootWidth = Math.max(
      1,
      Math.round(root.scrollWidth || root.clientWidth || root.getBoundingClientRect().width || 1),
    )
    const rootHeight = Math.max(
      1,
      Math.round(root.scrollHeight || root.clientHeight || root.getBoundingClientRect().height || 1),
    )

    const backgroundColor = rootComputed.backgroundColor || (isLight ? '#ffffff' : '#1f2937')
    const exportWidth = Math.max(
      rootWidth,
      graphicWidth + 24,
      footerWidth + 24,
    )
    const exportHeight = Math.max(
      rootHeight + 20,
      graphicHeight + footerHeight + 64,
    )
    const contentWidth = Math.max(1, exportWidth - 24)
    const markup = buildForeignObjectMarkup(root, {
      width: exportWidth,
      height: exportHeight,
      mutateClone: (clone) => {
        if (!clone || typeof clone.querySelector !== 'function') return
        const appendStyle = (node, styleText) => {
          if (!node || typeof node.getAttribute !== 'function' || typeof node.setAttribute !== 'function') return
          const existing = node.getAttribute('style') || ''
          node.setAttribute('style', `${existing}${existing.endsWith(';') || !existing ? '' : ';'}${styleText}`)
        }

        appendStyle(clone, `width:${exportWidth}px;height:${exportHeight}px;box-sizing:border-box;overflow:visible;max-width:none;`)

        const viewportClone = clone.querySelector('[data-splice-heatmap-viewport="true"]')
        const scrollClone = clone.querySelector('[data-splice-heatmap-scroll="true"]')
        const graphicClone = clone.querySelector('[data-splice-heatmap-graphic="true"]')
        const footerClone = clone.querySelector('[data-splice-heatmap-footer="true"]')
        const graphSectionClone = viewportClone?.parentElement || null
        const footerLegendClone = footerClone?.firstElementChild || null
        const footerActionsClone = footerClone?.lastElementChild || null

        appendStyle(graphSectionClone, `width:${contentWidth}px;max-width:none;overflow:visible;`)
        appendStyle(viewportClone, `width:${graphicWidth}px;max-width:none;min-width:${graphicWidth}px;overflow:visible;`)
        appendStyle(scrollClone, `width:${graphicWidth}px;max-width:none;min-width:${graphicWidth}px;overflow:visible;`)
        appendStyle(footerClone, `width:${contentWidth}px;max-width:none;align-items:flex-start;justify-content:space-between;gap:12px;padding-top:10px;padding-bottom:10px;overflow:visible;`)
        appendStyle(footerLegendClone, `flex:1 1 auto;min-width:0;max-width:${Math.max(240, contentWidth - 132)}px;align-items:flex-start;line-height:1.45;row-gap:6px;column-gap:16px;overflow:visible;`)
        appendStyle(footerActionsClone, 'flex:0 0 auto;align-self:flex-start;')

        if (graphicClone && typeof graphicClone.setAttribute === 'function') {
          graphicClone.setAttribute('width', String(graphicWidth))
          graphicClone.setAttribute('height', String(graphicHeight))
          appendStyle(graphicClone, `display:block;width:${graphicWidth}px;height:${graphicHeight}px;max-width:none;overflow:visible;`)
        }
      },
    })

    const body = `<foreignObject x="0" y="0" width="${exportWidth}" height="${exportHeight}">${markup}</foreignObject>`

    return {
      width: exportWidth,
      height: exportHeight,
      backgroundColor,
      svgMarkup: buildSvgDocument({
        width: exportWidth,
        height: exportHeight,
        body,
        backgroundColor,
      }),
    }
  }, [buildFeatureScreenshotSnapshot, isLight])

  const getScreenshotTargetAtPoint = useCallback((clientX, clientY) => {
    let bestTarget = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const target of Array.isArray(screenshotTargets) ? screenshotTargets : []) {
      if (typeof target?.getVisibleRect !== 'function') continue
      const rect = target.getVisibleRect()
      if (!rect) continue
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
      const area = Math.max(1, rect.width * rect.height)
      if (area < bestArea) {
        bestArea = area
        bestTarget = target
      }
    }
    return bestTarget
  }, [screenshotTargets])

  useEffect(() => {
    if (!(screenshotMode && screenshotTargets.length > 0)) return undefined
    const previousBodyCursor = document.body.style.cursor
    const previousRootCursor = document.documentElement.style.cursor
    document.body.style.cursor = 'crosshair'
    document.documentElement.style.cursor = 'crosshair'
    return () => {
      document.body.style.cursor = previousBodyCursor
      document.documentElement.style.cursor = previousRootCursor
    }
  }, [screenshotMode, screenshotTargets.length])

  useEffect(() => {
    if (!(screenshotMode && screenshotTargets.length > 0)) return undefined
    const handlePointerDown = (event) => {
      if (event.target?.closest?.('[data-screenshot-selection-overlay="true"]')) return
      const screenshotButton = screenshotToggleButtonRef?.current
      if (screenshotButton && screenshotButton.contains(event.target)) return
      if (getScreenshotTargetAtPoint(event.clientX, event.clientY)) return
      onScreenshotModeChange?.(false)
      setSelectedScreenshotTarget(null)
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [getScreenshotTargetAtPoint, onScreenshotModeChange, screenshotMode, screenshotTargets.length, screenshotToggleButtonRef])

  const syncScreenshotTarget = useCallback((targetId, descriptor) => {
    const key = String(targetId || '').trim()
    if (!key) return
    if (!descriptor) {
      removeScreenshotTarget(key)
      return
    }
    const nextTarget = { ...descriptor, id: key }
    upsertScreenshotTarget(nextTarget)
    setSelectedScreenshotTarget((prev) => (prev?.id === key ? nextTarget : prev))
  }, [removeScreenshotTarget, upsertScreenshotTarget])

  const handleScreenshotSave = useCallback(async ({ filename, directory, format, scale, quality, target }) => {
    if (!target?.buildExportSnapshot) {
      return { ok: false, error: 'Screenshot target is no longer available.' }
    }

    try {
      const snapshot = await target.buildExportSnapshot()
      if (!snapshot?.svgMarkup) {
        return { ok: false, error: 'Failed to build screenshot export.' }
      }

      let payload
      if (format === 'svg') {
        payload = {
          directory,
          filename,
          format,
          mime_type: 'image/svg+xml',
          encoding: 'utf8',
          data: snapshot.svgMarkup,
        }
      } else {
        const raster = await rasterizeSvgMarkup({
          svgMarkup: snapshot.svgMarkup,
          width: snapshot.width,
          height: snapshot.height,
          format,
          scale,
          quality: format === 'jpeg' ? Math.max(0.7, Math.min(1, quality / 100)) : undefined,
          backgroundColor: snapshot.backgroundColor || (isLight ? '#ffffff' : '#1f2937'),
        })
        payload = {
          directory,
          filename,
          format,
          mime_type: raster.mimeType,
          encoding: 'base64',
          data: raster.base64,
        }
      }

      const response = await fetch(`${API_BASE}/api/exports/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        return { ok: false, error: data?.detail || 'Failed to save screenshot.' }
      }
      return { ok: true, path: data?.path || '' }
    } catch (error) {
      return { ok: false, error: error?.message || 'Failed to export screenshot.' }
    }
  }, [isLight])

  const handleScreenshotModalClose = useCallback(() => {
    setSelectedScreenshotTarget(null)
  }, [])

  useEffect(() => {
    if (!orderedTranscripts.length) {
      setActiveTranscriptIds(new Set())
      setManualOrderIds([])
      setExpandedTranscriptIds(new Set())
      setCodonStatusById({})
      setHoveredInactiveTranscriptId('')
      return
    }
    const validIds = new Set(orderedTranscripts.map((tx) => tx.id))
    setActiveTranscriptIds((prev) => {
      const next = new Set()
      for (const id of prev) {
        if (validIds.has(id)) next.add(id)
      }
      if (next.size === 0) {
        for (const id of defaultActiveTranscriptIds(orderedTranscripts)) {
          next.add(id)
        }
      }
      return next
    })
    setManualOrderIds((prev) => {
      const filtered = prev.filter((id) => validIds.has(id))
      const missing = orderedTranscripts
        .map((tx) => tx.id)
        .filter((id) => !filtered.includes(id))
      return [...filtered, ...missing]
    })
    setExpandedTranscriptIds((prev) => {
      const next = new Set()
      for (const id of prev) {
        if (validIds.has(id)) next.add(id)
      }
      return next
    })
    setCodonStatusById((prev) => {
      const next = {}
      for (const [id, value] of Object.entries(prev || {})) {
        if (validIds.has(id)) next[id] = value
      }
      return next
    })
  }, [orderedTranscripts])

  const transcriptById = useMemo(
    () => new Map(orderedTranscripts.map((tx) => [tx.id, tx])),
    [orderedTranscripts]
  )

  useEffect(() => {
    if (!hoveredInactiveTranscriptId) return
    if (!transcriptById.has(hoveredInactiveTranscriptId) || activeTranscriptIds.has(hoveredInactiveTranscriptId)) {
      setHoveredInactiveTranscriptId('')
    }
  }, [hoveredInactiveTranscriptId, transcriptById, activeTranscriptIds])

  const genePanelData = useMemo(() => {
    const gene = resolved?.gene
    if (!gene) return null

    const geneId = String(gene?.id || '').trim()
    const symbolRaw = String(gene?.name || '').trim()
    const symbol = symbolRaw || '—'

    const geneStart = Number(gene?.start)
    const geneEnd = Number(gene?.end)
    const hasCoords = Number.isFinite(geneStart) && Number.isFinite(geneEnd)
    const geneChrom = String(gene?.chrom || '').trim()
    const location = (hasCoords && geneChrom)
      ? `${geneChrom}:${formatCoord(geneStart)}-${formatCoord(geneEnd)}`
      : '—'
    const spanBp = hasCoords
      ? formatCoord(Math.max(0, Math.round(geneEnd) - Math.round(geneStart) + 1))
      : '—'

    const totalTranscripts = orderedTranscripts.length
    let codingTranscriptCount = 0
    let totalExonInstances = 0
    const uniqueExonKeys = new Set()
    const uniqueCdsKeys = new Set()
    const distinctTranscriptBiotypes = new Set()
    for (const tx of orderedTranscripts) {
      const cds = Array.isArray(tx?.cds_list) ? tx.cds_list : []
      if (cds.length > 0) {
        codingTranscriptCount += 1
        const txStrand = String(tx?.strand || gene?.strand || '+')
        const cdsSegments = cds
          .map((feature) => ({
            start: Number(feature?.start),
            end: Number(feature?.end),
          }))
          .filter((feature) => Number.isFinite(feature.start) && Number.isFinite(feature.end))
          .sort((a, b) => (a.start - b.start) || (a.end - b.end))
          .map((feature) => `${Math.round(feature.start)}-${Math.round(feature.end)}`)
        if (cdsSegments.length > 0) {
          uniqueCdsKeys.add(`${txStrand}|${cdsSegments.join(',')}`)
        }
      }
      const exons = Array.isArray(tx?.exons) ? tx.exons : []
      totalExonInstances += exons.length
      const txStrand = String(tx?.strand || gene?.strand || '+')
      for (const exon of exons) {
        const exonStart = Number(exon?.start)
        const exonEnd = Number(exon?.end)
        if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd)) continue
        uniqueExonKeys.add(`${Math.round(exonStart)}:${Math.round(exonEnd)}:${txStrand}`)
      }
      const txBiotype = String(tx?.biotype || '').trim()
      if (txBiotype) distinctTranscriptBiotypes.add(txBiotype)
    }
    const nonCodingTranscriptCount = Math.max(0, totalTranscripts - codingTranscriptCount)
    const canonicalTranscriptId = orderedTranscripts.find((tx) => Boolean(tx?.is_canonical))?.id || '—'
    const description = String(gene?.description || '').trim() || '—'

    return {
      symbol,
      stableId: geneId || '—',
      version: String(gene?.version || '').trim() || null,
      location,
      spanBp,
      strand: formatStrand(gene?.strand),
      biotype: String(gene?.biotype || '').trim() || '—',
      totalTranscripts: formatCoord(totalTranscripts),
      codingTranscriptCount: formatCoord(codingTranscriptCount),
      nonCodingTranscriptCount: formatCoord(nonCodingTranscriptCount),
      uniqueExonCount: formatCoord(uniqueExonKeys.size),
      uniqueCdsSeqCount: formatCoord(uniqueCdsKeys.size),
      canonicalTranscriptId,
      totalExonInstances: formatCoord(totalExonInstances),
      distinctTranscriptBiotypeCount: formatCoord(distinctTranscriptBiotypes.size),
      description,
    }
  }, [orderedTranscripts, resolved?.gene])

  const genePanelStatColumns = useMemo(() => {
    if (!genePanelData) return [[], [], []]
    const isNcbi = String(selectedGenome?.provider || '').toLowerCase() === 'ncbi'
    const items = [
      { label: isNcbi ? 'Name' : 'Symbol', value: genePanelData.symbol },
      { label: 'Gene ID', value: <span className="font-mono">{genePanelData.stableId}</span> },
      { label: 'Version', value: genePanelData.version ?? '—' },
      { label: 'Location', value: genePanelData.location },
      { label: 'Span', value: genePanelData.spanBp === '—' ? '—' : `${genePanelData.spanBp} bp` },
      { label: 'Strand', value: genePanelData.strand },
      { label: 'Total transcripts', value: genePanelData.totalTranscripts },
      { label: 'Coding transcripts', value: genePanelData.codingTranscriptCount },
      { label: 'Non-coding transcripts', value: genePanelData.nonCodingTranscriptCount },
      { label: 'Biotype', value: genePanelData.biotype },
      { label: 'Unique exons', value: genePanelData.uniqueExonCount },
      { label: 'Unique CDS seqs', value: genePanelData.uniqueCdsSeqCount },
      { label: 'Canonical transcript', value: <span className="font-mono">{genePanelData.canonicalTranscriptId}</span> },
      { label: 'Total exon instances', value: genePanelData.totalExonInstances },
      { label: 'Distinct transcript biotypes', value: genePanelData.distinctTranscriptBiotypeCount },
    ]
    const columnCount = 3
    const perColumn = Math.ceil(items.length / columnCount)
    return Array.from({ length: columnCount }, (_, index) => (
      items.slice(index * perColumn, (index + 1) * perColumn)
    ))
  }, [genePanelData, selectedGenome?.provider])

  const activeTranscripts = useMemo(() => {
    const out = []
    orderedTranscripts.forEach((tx) => {
      if (activeTranscriptIds.has(tx.id)) out.push(tx)
    })
    return out
  }, [orderedTranscripts, activeTranscriptIds])

  const longestTranscript = useMemo(() => {
    const pickFrom = activeTranscripts.length > 0 ? activeTranscripts : orderedTranscripts
    if (!pickFrom.length) return null
    return pickFrom.reduce((best, tx) => (transcriptLength(tx) > transcriptLength(best) ? tx : best), pickFrom[0])
  }, [activeTranscripts, orderedTranscripts])

  const rulerViewBoxWidth = 1120
  const trackMarginLeft = 54
  const trackMarginRight = 18
  const trackInnerWidth = Math.max(1, rulerViewBoxWidth - trackMarginLeft - trackMarginRight)
  const displayedTranscripts = activeTranscripts.length > 0 ? activeTranscripts : orderedTranscripts
  const fullTranscriptViewStart = displayedTranscripts.reduce((acc, tx) => {
    const s = Number(tx?.start)
    const e = Number(tx?.end)
    return Number.isFinite(s) && Number.isFinite(e) ? Math.min(acc, s, e) : acc
  }, Number(longestTranscript?.start || 0))
  const fullTranscriptViewEnd = displayedTranscripts.reduce((acc, tx) => {
    const s = Number(tx?.start)
    const e = Number(tx?.end)
    return Number.isFinite(s) && Number.isFinite(e) ? Math.max(acc, s, e) : acc
  }, Number(longestTranscript?.end || 0)) + 1 // past the last base, so it is drawn whole
  const transcriptViewStart = Number.isFinite(transcriptViewRange?.start)
    ? Number(transcriptViewRange.start)
    : fullTranscriptViewStart
  const transcriptViewEnd = Number.isFinite(transcriptViewRange?.end)
    ? Number(transcriptViewRange.end)
    : fullTranscriptViewEnd

  const currentTranscriptSpan = Math.max(1, Math.abs(transcriptViewEnd - transcriptViewStart))
  const transcriptPxPerBp = trackInnerWidth / Math.max(1, currentTranscriptSpan)
  const transcriptBaseRenderMargin = Math.ceil(currentTranscriptSpan)
  const longestLength = Math.max(1, transcriptLength(longestTranscript))
  const reverseOrientation = String(longestTranscript?.strand || resolved?.gene?.strand || '+') === '-'
  const hasTranscriptZoom = (
    Number.isFinite(transcriptViewRange?.start) &&
    Number.isFinite(transcriptViewRange?.end) &&
    (Math.abs(Number(transcriptViewRange.end) - Number(fullTranscriptViewEnd)) > 1 || Math.abs(Number(transcriptViewRange.start) - Number(fullTranscriptViewStart)) > 1)
  )

  useEffect(() => {
    const enableBaseMode = transcriptPxPerBp >= 1.3 && currentTranscriptSpan <= 2200
    const disableBaseMode = transcriptPxPerBp <= 0.95 || currentTranscriptSpan >= 2800
    setTranscriptDetailMode((prev) => {
      if (prev === 'base') return disableBaseMode ? 'segment' : prev
      return enableBaseMode ? 'base' : prev
    })
  }, [transcriptPxPerBp, currentTranscriptSpan])

  useLayoutEffect(() => {
    // Mid-gesture the live view is ahead of state; state catching up to an
    // older view must not drag it back.
    if (pendingViewRangeRafRef.current || transcriptViewCommitTimerRef.current || transcriptZoomAnimationRef.current) return
    liveTranscriptViewStartRef.current = transcriptViewStart
    liveTranscriptViewEndRef.current = transcriptViewEnd
    liveTranscriptViewIsFullRef.current = !transcriptViewRange
  }, [transcriptViewStart, transcriptViewEnd, transcriptViewRange])

  /**
   * Moves the drawn rows from the view they were rendered at to the live view,
   * without rendering.
   *
   * Every row's geometry is drawn by mapCoordToTrack, which is linear in the
   * genomic coordinate, so going from one view to another is the same affine
   * map for every element: x' = a·x + b. It is written straight onto each row's
   * zoom layer, which is how a gesture over dozens of transcripts stays at frame
   * rate. Base letters would be stretched by it, so they are hidden until the
   * view is committed and the rows redrawn exactly.
   */
  const applyTranscriptViewPreview = useCallback(() => {
    const viewport = transcriptTrackViewportRef.current
    if (!viewport) return
    const committed = committedTranscriptViewRef.current
    const liveStart = liveTranscriptViewStartRef.current
    const liveEnd = liveTranscriptViewEndRef.current
    let transform = ''
    let scale = 1
    let offset = 0
    if (
      Number.isFinite(committed.start) && Number.isFinite(committed.end) &&
      Number.isFinite(liveStart) && Number.isFinite(liveEnd) &&
      (Math.abs(liveStart - committed.start) > 1e-9 || Math.abs(liveEnd - committed.end) > 1e-9)
    ) {
      const span = Math.max(1e-9, Math.abs(committed.end - committed.start))
      const nextSpan = Math.max(1e-9, Math.abs(liveEnd - liveStart))
      scale = span / nextSpan
      const shift = trackInnerWidth * (committed.start - liveStart) / nextSpan
      offset = reverseOrientation
        ? (trackMarginLeft + trackInnerWidth) - shift - (scale * (trackMarginLeft + trackInnerWidth))
        : trackMarginLeft + shift - (scale * trackMarginLeft)
      transform = `matrix(${scale} 0 0 1 ${offset} 0)`
    }
    for (const layer of viewport.querySelectorAll('[data-transcript-zoom-layer="true"]')) {
      if (transform) layer.setAttribute('transform', transform)
      else layer.removeAttribute('transform')
    }
    // A pure pan only shifts the rows, so base letters can stay; a zoom would
    // stretch them.
    const isPan = Math.abs(scale - 1) < 1e-9
    if (transform) viewport.setAttribute('data-transcript-previewing', isPan ? 'pan' : 'zoom')
    else viewport.removeAttribute('data-transcript-previewing')
    return { isPan, offset }
  }, [reverseOrientation, trackInnerWidth])

  // After every render: the rows now show the committed view, so the preview is
  // measured from there. Rows added by the render get the transform too.
  useLayoutEffect(() => {
    committedTranscriptViewRef.current = { start: transcriptViewStart, end: transcriptViewEnd }
    applyTranscriptViewPreview()
  })

  const commitLiveTranscriptView = useCallback(() => {
    if (transcriptViewCommitTimerRef.current) {
      clearTimeout(transcriptViewCommitTimerRef.current)
      transcriptViewCommitTimerRef.current = 0
    }
    const start = liveTranscriptViewStartRef.current
    const end = liveTranscriptViewEndRef.current
    if (liveTranscriptViewIsFullRef.current || !Number.isFinite(start) || !Number.isFinite(end)) {
      setTranscriptViewRange(null)
    } else {
      setTranscriptViewRange({ start, end })
    }
  }, [])

  const previewLiveTranscriptView = useCallback(() => {
    if (!pendingViewRangeRafRef.current) {
      pendingViewRangeRafRef.current = requestAnimationFrame(() => {
        pendingViewRangeRafRef.current = 0
        const preview = applyTranscriptViewPreview()
        // At base level the bases are only drawn a screen's width beyond the
        // view. A pan that gets most of the way there is redrawn straight away
        // rather than scrolling into blank track while the gesture goes on.
        if (
          transcriptDetailModeRef.current === 'base' &&
          preview?.isPan &&
          Math.abs(preview.offset) > trackInnerWidth * 0.6
        ) {
          commitLiveTranscriptView()
        }
      })
    }
    if (transcriptViewCommitTimerRef.current) clearTimeout(transcriptViewCommitTimerRef.current)
    transcriptViewCommitTimerRef.current = setTimeout(() => {
      transcriptViewCommitTimerRef.current = 0
      commitLiveTranscriptView()
    }, TRANSCRIPT_VIEW_COMMIT_IDLE_MS)
  }, [applyTranscriptViewPreview, commitLiveTranscriptView, trackInnerWidth])

  const stopTranscriptZoomAnimation = useCallback(() => {
    if (!transcriptZoomAnimationRef.current) return
    cancelAnimationFrame(transcriptZoomAnimationRef.current)
    transcriptZoomAnimationRef.current = 0
  }, [])

  const animateTranscriptViewTo = useCallback((nextStart, nextEnd, durationMs = 220) => {
    if (!Number.isFinite(fullTranscriptViewStart) || !Number.isFinite(fullTranscriptViewEnd)) {
      setTranscriptViewRange(null)
      return
    }
    const clampedTargetStart = clamp(
      Math.min(Number(nextStart), Number(nextEnd)),
      fullTranscriptViewStart,
      fullTranscriptViewEnd,
    )
    const clampedTargetEnd = clamp(
      Math.max(Number(nextStart), Number(nextEnd)),
      fullTranscriptViewStart,
      fullTranscriptViewEnd,
    )
    const fromStart = liveTranscriptViewStartRef.current ?? fullTranscriptViewStart
    const fromEnd = liveTranscriptViewEndRef.current ?? fullTranscriptViewEnd
    stopTranscriptZoomAnimation()
    if (transcriptViewCommitTimerRef.current) {
      clearTimeout(transcriptViewCommitTimerRef.current)
      transcriptViewCommitTimerRef.current = 0
    }

    const targetMatchesFull = (
      Math.abs(clampedTargetStart - fullTranscriptViewStart) < 1e-6 &&
      Math.abs(clampedTargetEnd - fullTranscriptViewEnd) < 1e-6
    )
    const startTime = performance.now()
    const step = (now) => {
      const tRaw = durationMs <= 0 ? 1 : clamp((now - startTime) / durationMs, 0, 1)
      const t = easeOutCubic(tRaw)
      const start = lerp(fromStart, clampedTargetStart, t)
      const end = lerp(fromEnd, clampedTargetEnd, t)
      liveTranscriptViewStartRef.current = start
      liveTranscriptViewEndRef.current = end
      liveTranscriptViewIsFullRef.current = false
      if (tRaw >= 1) {
        transcriptZoomAnimationRef.current = 0
        liveTranscriptViewStartRef.current = clampedTargetStart
        liveTranscriptViewEndRef.current = clampedTargetEnd
        liveTranscriptViewIsFullRef.current = targetMatchesFull
        commitLiveTranscriptView()
        return
      }
      applyTranscriptViewPreview()
      transcriptZoomAnimationRef.current = requestAnimationFrame(step)
    }
    transcriptZoomAnimationRef.current = requestAnimationFrame(step)
  }, [fullTranscriptViewStart, fullTranscriptViewEnd, stopTranscriptZoomAnimation, applyTranscriptViewPreview, commitLiveTranscriptView])

  const resetTranscriptZoom = useCallback((animated = true) => {
    if (!hasTranscriptZoom && !transcriptViewRange && liveTranscriptViewIsFullRef.current) return
    if (animated) {
      animateTranscriptViewTo(fullTranscriptViewStart, fullTranscriptViewEnd, 200)
    } else {
      stopTranscriptZoomAnimation()
      liveTranscriptViewIsFullRef.current = true
      liveTranscriptViewStartRef.current = fullTranscriptViewStart
      liveTranscriptViewEndRef.current = fullTranscriptViewEnd
      commitLiveTranscriptView()
    }
  }, [hasTranscriptZoom, transcriptViewRange, animateTranscriptViewTo, fullTranscriptViewStart, fullTranscriptViewEnd, stopTranscriptZoomAnimation, commitLiveTranscriptView])

  const setTranscriptViewRangeImmediate = useCallback((nextStart, nextEnd) => {
    if (!Number.isFinite(fullTranscriptViewStart) || !Number.isFinite(fullTranscriptViewEnd)) {
      liveTranscriptViewStartRef.current = null
      liveTranscriptViewEndRef.current = null
      setTranscriptViewRange(null)
      return
    }
    const fullSpan = Math.max(1, fullTranscriptViewEnd - fullTranscriptViewStart)
    const minSpan = Math.min(fullSpan, Math.max(2, TRANSCRIPT_TRACK_MIN_VIEW_SPAN_BP))
    let start = Number.isFinite(nextStart) ? Number(nextStart) : fullTranscriptViewStart
    let end = Number.isFinite(nextEnd) ? Number(nextEnd) : fullTranscriptViewEnd
    if (end < start) [start, end] = [end, start]
    let span = clamp(end - start, minSpan, fullSpan)
    if (!Number.isFinite(span) || span <= 0) span = minSpan
    if (span >= fullSpan - 1e-6) {
      liveTranscriptViewStartRef.current = fullTranscriptViewStart
      liveTranscriptViewEndRef.current = fullTranscriptViewEnd
      liveTranscriptViewIsFullRef.current = true
      previewLiveTranscriptView()
      return
    }
    let clampedStart = clamp(start, fullTranscriptViewStart, fullTranscriptViewEnd - span)
    let clampedEnd = clampedStart + span
    if (clampedEnd > fullTranscriptViewEnd) {
      clampedEnd = fullTranscriptViewEnd
      clampedStart = clampedEnd - span
    }
    // Update live refs immediately so subsequent wheel events read the correct position
    liveTranscriptViewStartRef.current = clampedStart
    liveTranscriptViewEndRef.current = clampedEnd
    liveTranscriptViewIsFullRef.current = false
    previewLiveTranscriptView()
  }, [fullTranscriptViewStart, fullTranscriptViewEnd, previewLiveTranscriptView])

  const mapCoordToTrack = useCallback((coord) => {
    const value = Number(coord)
    if (!Number.isFinite(value)) return trackMarginLeft
    if (longestLength <= 1) return trackMarginLeft
    let fraction = (value - transcriptViewStart) / currentTranscriptSpan
    if (reverseOrientation) fraction = 1 - fraction
    return trackMarginLeft + (trackInnerWidth * fraction)
  }, [longestLength, transcriptViewStart, currentTranscriptSpan, reverseOrientation, trackInnerWidth])

  // The base at a genomic position as the track shows it: complemented on a
  // reverse-strand gene, and '' where the fetched sequence does not reach.
  const trackBaseAt = useCallback((pos) => {
    const sequence = String(transcriptVisibleSequence.sequence || '')
    const index = pos - Number(transcriptVisibleSequence.start || 0)
    if (index < 0 || index >= sequence.length) return ''
    const base = String(sequence[index] || '').toUpperCase()
    return reverseOrientation ? (BASE_COMPLEMENT_MAP[base] || base) : base
  }, [transcriptVisibleSequence.sequence, transcriptVisibleSequence.start, reverseOrientation])

  const trackBaseLettersReady = useCallback((from, to) => (
    transcriptDetailMode === 'base' &&
    transcriptPxPerBp >= TRANSCRIPT_TRACK_BASETEXT_MIN_PX_PER_BP &&
    to >= from &&
    ((to - from) + 1) <= TRANSCRIPT_TRACK_BASETEXT_MAX_COUNT &&
    transcriptVisibleSequence.start <= from &&
    transcriptVisibleSequence.end >= to &&
    String(transcriptVisibleSequence.sequence || '').length > 0
  ), [transcriptDetailMode, transcriptPxPerBp, transcriptVisibleSequence.start, transcriptVisibleSequence.end, transcriptVisibleSequence.sequence])

  const resolveTranscriptTrackSurfaceRect = useCallback((sourceNode = null) => {
    const viewport = transcriptTrackViewportRef.current
    if (!viewport) return null
    const sourceElement = sourceNode instanceof Element ? sourceNode : null
    const surface = sourceElement?.closest?.('[data-feature-transcript-track-surface="true"]')
      || viewport.querySelector?.('[data-feature-transcript-track-surface="true"]')
    return surface?.getBoundingClientRect?.() || viewport.getBoundingClientRect()
  }, [])

  const trackClientXToGenomicCoord = useCallback((clientX, sourceNode = null) => {
    const rect = resolveTranscriptTrackSurfaceRect(sourceNode)
    if (!rect.width) return null
    const px = clamp((Number(clientX) - rect.left) / rect.width, 0, 1)
    const viewBoxX = px * rulerViewBoxWidth
    let fraction = (viewBoxX - trackMarginLeft) / trackInnerWidth
    fraction = clamp(fraction, 0, 1)
    if (reverseOrientation) fraction = 1 - fraction
    // Use live refs so the zoom anchor is always accurate even before state has updated
    const liveStart = liveTranscriptViewStartRef.current ?? transcriptViewStart
    const liveEnd = liveTranscriptViewEndRef.current ?? transcriptViewEnd
    const liveSpan = Math.max(1, Math.abs(liveEnd - liveStart))
    return liveStart + (fraction * liveSpan)
  }, [resolveTranscriptTrackSurfaceRect, reverseOrientation, trackInnerWidth, transcriptViewStart, transcriptViewEnd])

  const handleTranscriptTrackPointerDown = useCallback((event) => {
    if (!isTranscriptBoxSelectMode) return
    if (event.button !== 0) return
    const rect = resolveTranscriptTrackSurfaceRect(event.target)
    if (!rect) return
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    transcriptSelectionDragRef.current = {
      pointerId: event.pointerId,
      x1: x,
      rect,
    }
    setTranscriptSelectionRect({
      x1: x,
      x2: x,
      y1: 0,
      y2: rect.height,
    })
  }, [isTranscriptBoxSelectMode])

  const handleTranscriptTrackWheel = useCallback((event) => {
    if (!longestTranscript) return
    if (isTranscriptBoxSelectMode || transcriptSelectionDragRef.current) return

    const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
    const previousGesture = transcriptWheelGestureRef.current
    const gesture = beginWheelGesture(previousGesture, wheel, wheel.ts || performance.now())
    // The window-capture listener below tags where each gesture began. An
    // inertial fling that started outside the panel must not be stolen by it
    // once the pointer drifts over the track.
    const source = (gesture.continues ? previousGesture?.source : '') || 'panel'
    if (source === 'outside') {
      transcriptWheelGestureRef.current = { ...gesture, source }
      return
    }

    // Read live refs — always current even before state has updated this frame
    const liveStart = liveTranscriptViewStartRef.current
    const liveEnd = liveTranscriptViewEndRef.current
    const liveSpan = Math.max(1, Math.abs((liveEnd ?? fullTranscriptViewEnd) - (liveStart ?? fullTranscriptViewStart)))
    const fullSpan = Math.max(1, fullTranscriptViewEnd - fullTranscriptViewStart)
    const minSpan = Math.min(fullSpan, Math.max(2, TRANSCRIPT_TRACK_MIN_VIEW_SPAN_BP))
    const isZoomed = (
      liveStart !== null &&
      (Math.abs(liveStart - fullTranscriptViewStart) > 1 || Math.abs((liveEnd ?? fullTranscriptViewEnd) - fullTranscriptViewEnd) > 1)
    )
    const atFullExtent = !isZoomed || liveSpan >= (fullSpan - 1e-6)

    const intent = resolveWheelAction(wheel, browsingControls, {
      atMaxZoom: atFullExtent,
      canScrollPage: true,
      gesture,
    })
    markWheelHandled(event)
    transcriptWheelGestureRef.current = {
      ...gesture,
      mode: intent.nextGestureMode || gesture.mode,
      source,
    }
    if (intent.preventDefault) event.preventDefault()
    if (intent.stopPropagation) event.stopPropagation()

    if (intent.type === 'zoom') {
      const effectiveStart = liveStart ?? fullTranscriptViewStart
      const zoomSpan = clamp(liveSpan, minSpan, fullSpan)
      let anchor
      if (intent.anchor === 'center') {
        anchor = effectiveStart + (zoomSpan / 2)
      } else {
        const now = wheel.ts || performance.now()
        const held = transcriptZoomAnchorRef.current
        const pointerStill = held
          && Math.abs(event.clientX - held.clientX) <= TRANSCRIPT_ZOOM_ANCHOR_MOVE_PX
          && Math.abs(event.clientY - held.clientY) <= TRANSCRIPT_ZOOM_ANCHOR_MOVE_PX
          && (now - held.ts) <= TRANSCRIPT_ZOOM_ANCHOR_IDLE_MS
        anchor = pointerStill ? held.coord : trackClientXToGenomicCoord(event.clientX, event.target)
        if (Number.isFinite(anchor)) {
          transcriptZoomAnchorRef.current = {
            coord: anchor,
            clientX: pointerStill ? held.clientX : event.clientX,
            clientY: pointerStill ? held.clientY : event.clientY,
            ts: now,
          }
        }
      }
      if (!Number.isFinite(anchor)) return
      stopTranscriptZoomAnimation()
      let nextSpan = clamp(zoomSpan * intent.factor, minSpan, fullSpan)
      if (!Number.isFinite(nextSpan) || nextSpan <= 0) nextSpan = zoomSpan
      if (Math.abs(nextSpan - zoomSpan) < 1e-6) return
      // Where the anchor sits across the view, drawn towards the middle in
      // proportion to how much this step zoomed. A centred anchor keeps the
      // old zoom-about-a-point behaviour.
      const currentRatio = clamp((anchor - effectiveStart) / zoomSpan, 0, 1)
      const pull = intent.anchor === 'center'
        ? 0
        : 1 - Math.exp(-TRANSCRIPT_ZOOM_CENTRE_PULL * Math.abs(Math.log(nextSpan / zoomSpan)))
      const anchorRatio = currentRatio + ((0.5 - currentRatio) * pull)
      let nextStart = anchor - (anchorRatio * nextSpan)
      let nextEnd = nextStart + nextSpan
      if (nextStart < fullTranscriptViewStart) {
        nextStart = fullTranscriptViewStart
        nextEnd = nextStart + nextSpan
      }
      if (nextEnd > fullTranscriptViewEnd) {
        nextEnd = fullTranscriptViewEnd
        nextStart = nextEnd - nextSpan
      }
      setTranscriptViewRangeImmediate(nextStart, nextEnd)
      return
    }

    if (intent.type === 'pan') {
      // Nothing to pan to while the whole gene is in view.
      if (!isZoomed) return
      stopTranscriptZoomAnimation()
      const bpPerPx = liveSpan / Math.max(1, trackInnerWidth)
      // Negate for reverse-strand genes so panning direction matches visual orientation
      const strandFactor = reverseOrientation ? -1 : 1
      const shiftBp = strandFactor * intent.dxPx * bpPerPx
      const effectiveStart = liveStart ?? fullTranscriptViewStart
      const effectiveEnd = liveEnd ?? fullTranscriptViewEnd
      setTranscriptViewRangeImmediate(effectiveStart + shiftBp, effectiveEnd + shiftBp)
    }
  }, [
    longestTranscript,
    isTranscriptBoxSelectMode,
    trackClientXToGenomicCoord,
    stopTranscriptZoomAnimation,
    fullTranscriptViewEnd,
    fullTranscriptViewStart,
    reverseOrientation,
    trackInnerWidth,
    setTranscriptViewRangeImmediate,
    browsingControls,
  ])

  // Keep the ref pointing at the latest handler so the listener never needs re-registration
  transcriptWheelHandlerRef.current = handleTranscriptTrackWheel

  useEffect(() => {
    const viewport = transcriptTrackViewportRef.current
    if (!viewport) return undefined
    const onWheel = (event) => transcriptWheelHandlerRef.current?.(event)
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  // handleTranscriptTrackWheel is now stable during interaction (no transcriptViewRange in deps),
  // so this only re-registers when the gene changes (longestTranscript changes) — not on every pan/zoom.
  }, [handleTranscriptTrackWheel])

  useEffect(() => {
    const onWindowWheelCapture = (event) => {
      const viewport = transcriptTrackViewportRef.current
      if (!viewport) return
      const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
      const previousGesture = transcriptWheelGestureRef.current
      const gesture = beginWheelGesture(previousGesture, wheel, wheel.ts || performance.now())
      if (gesture.continues) {
        transcriptWheelGestureRef.current = { ...previousGesture, ...gesture }
        return
      }
      transcriptWheelGestureRef.current = {
        ...gesture,
        // An info box sits inside the track area but is reading matter, not
        // track: a gesture that starts there scrolls the page, and keeps
        // scrolling if the pointer then drifts onto a track.
        source: viewport.contains(event.target) && !event.target?.closest?.('[data-transcript-info-panel="true"]')
          ? 'panel'
          : 'outside',
      }
    }
    window.addEventListener('wheel', onWindowWheelCapture, { passive: true, capture: true })
    return () => window.removeEventListener('wheel', onWindowWheelCapture, { capture: true })
  }, [])

  // Sequence for the base letters. Fetched as soon as the track reaches
  // base-level detail rather than when letters first fit, and kept when the
  // view zooms back out. The whole gene is fetched when one request can hold it
  // (the backend serves up to 100 kb at a time, in a few milliseconds), so
  // panning and zooming at base level never wait on the network. A longer gene
  // gets a window around the view, refilled before the view nears its edge.
  useEffect(() => {
    const chrom = String(resolved?.gene?.chrom || '').trim()
    if (transcriptDetailMode !== 'base' || !chrom) return
    const viewStart = Math.floor(Math.min(transcriptViewStart, transcriptViewEnd))
    const viewEnd = Math.ceil(Math.max(transcriptViewStart, transcriptViewEnd))
    const reach = Math.ceil(currentTranscriptSpan) * 2
    const needStart = Math.max(1, viewStart - reach)
    const needEnd = viewEnd + reach
    const buffer = transcriptVisibleSequence
    if (
      buffer.sequence &&
      String(buffer.key || '').startsWith(`${chrom}:`) &&
      buffer.start <= needStart &&
      buffer.end >= needEnd
    ) return

    const geneStart = Math.max(1, Math.floor(fullTranscriptViewStart) - TRANSCRIPT_SEQUENCE_FLANK_BP)
    const geneEnd = Math.ceil(fullTranscriptViewEnd) + TRANSCRIPT_SEQUENCE_FLANK_BP
    let fetchStart = geneStart
    let fetchEnd = geneEnd
    if ((geneEnd - geneStart) + 1 > TRANSCRIPT_SEQUENCE_MAX_FETCH_BP) {
      const centre = Math.round((viewStart + viewEnd) / 2)
      fetchStart = Math.max(1, centre - Math.floor(TRANSCRIPT_SEQUENCE_MAX_FETCH_BP / 2))
      fetchEnd = fetchStart + TRANSCRIPT_SEQUENCE_MAX_FETCH_BP - 1
    }
    const fetchKey = `${chrom}:${fetchStart}:${fetchEnd}`
    // Already on its way, or already failed: do not ask again for the same range.
    if (transcriptSequenceRequestKeyRef.current === fetchKey) return
    transcriptSequenceRequestKeyRef.current = fetchKey

    const reqId = transcriptVisibleSequenceReqRef.current + 1
    transcriptVisibleSequenceReqRef.current = reqId
    const start0 = Math.max(0, fetchStart - 1)
    const end0 = Math.max(start0 + 1, fetchEnd)
    const url = `${API_BASE}/api/browse/sequence?genome=${encodeURIComponent(activeGenomeKey || 'reference')}&chrom=${encodeURIComponent(chrom)}&start=${start0}&end=${end0}`
    fetch(url)
      .then((res) => res.json().catch(() => ({})).then((payload) => ({ ok: res.ok, payload })))
      .then(({ ok, payload }) => {
        if (transcriptVisibleSequenceReqRef.current !== reqId) return
        if (!ok) throw new Error(payload?.detail || 'Failed to fetch transcript zoom sequence')
        setTranscriptVisibleSequence({
          key: fetchKey,
          start: fetchStart,
          end: fetchEnd,
          sequence: String(payload?.sequence || '').toUpperCase(),
          loading: false,
        })
      })
      .catch(() => {
        if (transcriptVisibleSequenceReqRef.current !== reqId) return
        // Keep whatever was already held; the request key stays set so the
        // same failing range is not retried on every render.
      })
  }, [
    activeGenomeKey,
    resolved?.gene?.chrom,
    currentTranscriptSpan,
    transcriptViewStart,
    transcriptViewEnd,
    transcriptDetailMode,
    fullTranscriptViewStart,
    fullTranscriptViewEnd,
    transcriptVisibleSequence,
  ])

  useEffect(() => {
    transcriptSelectionRectRef.current = transcriptSelectionRect
  }, [transcriptSelectionRect])

  useEffect(() => {
    const handlePointerMove = (event) => {
      const drag = transcriptSelectionDragRef.current
      if (!drag) return
      if (drag.pointerId != null && event.pointerId !== drag.pointerId) return
      const viewport = transcriptTrackViewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()
      const x = clamp(event.clientX - rect.left, 0, rect.width)
      setTranscriptSelectionRect((prev) => (
        prev
          ? { ...prev, x2: x, y1: 0, y2: rect.height }
          : { x1: x, y1: 0, x2: x, y2: rect.height }
      ))
    }
    const finishSelection = (event, cancelled = false) => {
      const drag = transcriptSelectionDragRef.current
      if (!drag) return
      if (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId) return
      const rect = transcriptSelectionRectRef.current
      transcriptSelectionDragRef.current = null
      if (!rect || cancelled) {
        setTranscriptSelectionRect(null)
        return
      }
      const minDx = Math.abs(Number(rect.x2) - Number(rect.x1))
      if (minDx < 8) {
        setTranscriptSelectionRect(null)
        return
      }
      const c1 = trackClientXToGenomicCoord(drag.rect.left + Math.min(rect.x1, rect.x2))
      const c2 = trackClientXToGenomicCoord(drag.rect.left + Math.max(rect.x1, rect.x2))
      setTranscriptSelectionRect(null)
      if (!Number.isFinite(c1) || !Number.isFinite(c2)) return
      const targetStart = Math.min(c1, c2)
      const targetEnd = Math.max(c1, c2)
      if ((targetEnd - targetStart) < 2) return
      animateTranscriptViewTo(targetStart, targetEnd, 230)
      setIsTranscriptBoxSelectMode(false)
    }
    const handlePointerCancel = (event) => finishSelection(event, true)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [trackClientXToGenomicCoord, animateTranscriptViewTo])

  useEffect(() => {
    if (transcriptViewCommitTimerRef.current) {
      clearTimeout(transcriptViewCommitTimerRef.current)
      transcriptViewCommitTimerRef.current = 0
    }
    liveTranscriptViewIsFullRef.current = true
    liveTranscriptViewStartRef.current = null
    liveTranscriptViewEndRef.current = null
    setTranscriptViewRange(null)
    setTranscriptSelectionRect(null)
    setIsTranscriptBoxSelectMode(false)
    setTranscriptDetailMode('segment')
    setTranscriptVisibleSequence({ key: '', start: 0, end: 0, sequence: '', loading: false })
    transcriptSelectionDragRef.current = null
    transcriptSequenceRequestKeyRef.current = ''
    transcriptVisibleSequenceReqRef.current += 1
  }, [resolved?.gene?.id])

  useEffect(() => () => {
    stopTranscriptZoomAnimation()
    if (transcriptViewCommitTimerRef.current) clearTimeout(transcriptViewCommitTimerRef.current)
    if (pendingViewRangeRafRef.current) cancelAnimationFrame(pendingViewRangeRafRef.current)
  }, [stopTranscriptZoomAnimation])

  const toggleTranscript = (transcriptId) => {
    if (suppressClickAfterDragRef.current) {
      suppressClickAfterDragRef.current = false
      return
    }
    if (!activeTranscriptIds.has(transcriptId)) trackAchievement('fe.activateInactive')
    setActiveTranscriptIds((prev) => {
      const next = new Set(prev)
      if (next.has(transcriptId)) next.delete(transcriptId)
      else next.add(transcriptId)
      return next
    })
  }

  const onSubmit = async (event) => {
    event?.preventDefault?.()
    const q = String(query || '').trim()
    if (!q) return
    externalFocusSeenRef.current = q.toLowerCase()
    await resolveGene(q, { propagate: true })
  }

  const getFeatureSectionNode = useCallback((sectionKey) => {
    if (sectionKey === 'genes') return geneSectionRef.current
    if (sectionKey === 'transcript') return transcriptsSectionRef.current
    if (sectionKey === 'exons') return exonsSectionRef.current
    if (sectionKey === 'proteins') return proteinsSectionRef.current
    if (sectionKey === 'structure') return structureSectionRef.current
    if (sectionKey === 'export') return exportSectionRef.current
    return null
  }, [])

  const getFeatureSectionScrollTop = useCallback((sectionKey) => {
    const container = contentScrollRef.current
    const target = getFeatureSectionNode(sectionKey)
    if (!container || !target) return null
    const cRect = container.getBoundingClientRect()
    const tRect = target.getBoundingClientRect()
    return Math.max(0, container.scrollTop + (tRect.top - cRect.top) - 8)
  }, [getFeatureSectionNode])

  // The genome browser's scroll rail, down the left of the sections: one dot per
  // section, placed where that section's jump button scrolls to (8px below the
  // top), and pressing a dot is that same jump.
  const sectionRailStops = useMemo(() => FEATURE_SECTION_JUMPS.map((item) => ({
    key: item.key,
    label: item.label,
    tourId: item.key,
    color: isLight ? '#7b8da6' : '#8da2c7',
  })), [isLight])
  const resolveSectionRailAnchor = useCallback((_host, sectionKey) => getFeatureSectionNode(sectionKey), [getFeatureSectionNode])
  // The sections scroll inside their own panel, so the rail is placed in the
  // app's page padding to the left of it -- where the browser's rail sits --
  // rather than over the panel's edge.
  const resolveSectionRailLeft = useCallback((scroller) => {
    let node = scroller?.parentElement || null
    while (node && node !== document.body) {
      if (parseFloat(window.getComputedStyle(node).paddingLeft) >= SCROLL_RAIL_WIDTH) {
        return node.getBoundingClientRect().left + 1
      }
      node = node.parentElement
    }
    return null
  }, [])

  const scrollToFeatureSection = useCallback((sectionKey) => {
    const container = contentScrollRef.current
    if (!container) return
    const nextTop = getFeatureSectionScrollTop(sectionKey)
    if (!Number.isFinite(nextTop)) return
    container.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' })
  }, [getFeatureSectionScrollTop])

  const transcriptRowHeight = TRANSCRIPT_TRACK_ROW_HEIGHT
  const transcriptControlsMeasureRef = useRef(null)
  const [transcriptControlsMeasuredWidth, setTranscriptControlsMeasuredWidth] = useState(0)
  const transcriptListPanelWidth = useMemo(() => {
    const measured = transcriptControlsMeasuredWidth > 0 ? transcriptControlsMeasuredWidth + 24 : 0
    return Math.max(286, measured)
  }, [transcriptControlsMeasuredWidth])
  const activeCount = activeTranscripts.length
  const inactiveCount = Math.max(0, orderedTranscripts.length - activeCount)
  const allActive = orderedTranscripts.length > 0 && activeTranscriptIds.size === orderedTranscripts.length
  const setAllVisible = () => {
    if (allActive) {
      setActiveTranscriptIds(new Set())
      return
    }
    if (inactiveCount > 0) trackAchievement('fe.activateInactive')
    setActiveTranscriptIds(new Set(orderedTranscripts.map((tx) => tx.id)))
    setCollapseInactiveRows(false)
  }

  const restoreDefaultOrdering = () => {
    const defaultIds = defaultActiveTranscriptIds(orderedTranscripts)
    setManualOrderIds(orderedTranscripts.map((tx) => tx.id))
    setActiveTranscriptIds(new Set(defaultIds))
    setExpandedTranscriptIds(new Set(defaultExpandedTranscriptIds(orderedTranscripts)))
    setCollapseInactiveRows(true)
    setExonCoverageRowActive(true)
  }

  useLayoutEffect(() => {
    const el = transcriptControlsMeasureRef.current
    if (!el) return undefined
    const measure = () => setTranscriptControlsMeasuredWidth(Math.ceil(el.scrollWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggleTranscriptExpanded = useCallback((transcriptId) => {
    setExpandedTranscriptIds((prev) => {
      const next = new Set(prev)
      if (next.has(transcriptId)) next.delete(transcriptId)
      else next.add(transcriptId)
      return next
    })
  }, [])

  const activeExpandedCount = useMemo(() => {
    let count = 0
    for (const id of activeTranscriptIds) {
      if (expandedTranscriptIds.has(id)) count += 1
    }
    return count
  }, [activeTranscriptIds, expandedTranscriptIds])

  const allActiveExpanded = activeTranscriptIds.size > 0 && activeExpandedCount === activeTranscriptIds.size

  const isWithinSpliceHoverPreviewZone = useCallback((event) => {
    const target = event?.currentTarget
    if (!target?.closest) return true
    const row = target.closest('[data-feature-transcript-row="true"]')
    if (!row) return true
    const y = Number(event?.clientY)
    if (!Number.isFinite(y)) return true
    const rect = row.getBoundingClientRect()
    const zoneTop = rect.top + (TRANSCRIPT_TRACK_ROW_HEIGHT * 0.2)
    const zoneBottom = rect.top + (TRANSCRIPT_TRACK_ROW_HEIGHT * 0.8)
    return y >= zoneTop && y <= zoneBottom
  }, [])

  const toggleAllActiveExpanded = useCallback(() => {
    if (allActiveExpanded) {
      setExpandedTranscriptIds((prev) => {
        const next = new Set(prev)
        for (const id of activeTranscriptIds) {
          next.delete(id)
        }
        return next
      })
      return
    }
    setExpandedTranscriptIds((prev) => {
      const next = new Set(prev)
      for (const id of activeTranscriptIds) {
        next.add(id)
      }
      return next
    })
  }, [allActiveExpanded, activeTranscriptIds])

  const displayOrderIds = useMemo(() => {
    const fallback = orderedTranscripts.map((tx) => tx.id)
    const orderSource = manualOrderIds.length > 0 ? manualOrderIds : fallback
    return orderSource.filter((id) => transcriptById.has(id))
  }, [orderedTranscripts, manualOrderIds, transcriptById])

  const visibleDisplayIds = useMemo(() => {
    if (!collapseInactiveRows) return displayOrderIds
    return displayOrderIds.filter((id) => activeTranscriptIds.has(id))
  }, [collapseInactiveRows, displayOrderIds, activeTranscriptIds])

  const activeTranscriptsInDisplayOrder = useMemo(() => (
    displayOrderIds
      .map((id) => transcriptById.get(id))
      .filter((tx) => Boolean(tx) && activeTranscriptIds.has(tx.id))
  ), [displayOrderIds, transcriptById, activeTranscriptIds])

  const spliceLayoutSessionKey = useMemo(() => {
    const geneStableId = String(resolved?.gene?.id || '').trim() || 'no-gene'
    const orientationToken = reverseOrientation ? 'reverse' : 'forward'
    const activeTranscriptSignature = activeTranscriptsInDisplayOrder
      .map((tx) => String(tx?.id || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join('|')
    return `${geneStableId}::${orientationToken}::${activeTranscriptSignature}`
  }, [resolved?.gene?.id, reverseOrientation, activeTranscriptsInDisplayOrder])

  const splicePathSetsByTranscript = useMemo(() => {
    const byTranscript = splicePathSelection?.byTranscript || {}
    const out = {}
    for (const [txId, value] of Object.entries(byTranscript)) {
      out[txId] = {
        highlightedExonKeys: new Set(Array.isArray(value?.highlightedExonKeys) ? value.highlightedExonKeys : []),
        prePathExonKeys: new Set(Array.isArray(value?.prePathExonKeys) ? value.prePathExonKeys : []),
        highlightedIntronKeys: new Set(Array.isArray(value?.highlightedIntronKeys) ? value.highlightedIntronKeys : []),
      }
    }
    return out
  }, [splicePathSelection])

  const effectiveSpliceFocusedTranscriptId = useMemo(() => {
    const focused = String(spliceFocusedTranscriptId || '').trim()
    if (focused && splicePathSetsByTranscript[focused]) return focused
    const hovered = String(spliceHoveredTranscriptId || '').trim()
    if (hovered && splicePathSetsByTranscript[hovered]) return hovered
    return ''
  }, [spliceHoveredTranscriptId, spliceFocusedTranscriptId, splicePathSetsByTranscript])

  const canHoverPreviewSplicePath = useMemo(() => {
    if (!splicePathSelection?.hasSelection) return false
    const focused = String(spliceFocusedTranscriptId || '').trim()
    if (!focused) return true
    return !Boolean(splicePathSetsByTranscript[focused])
  }, [splicePathSelection?.hasSelection, spliceFocusedTranscriptId, splicePathSetsByTranscript])

  const transcriptMetaById = useMemo(() => {
    const out = {}
    for (const tx of orderedTranscripts) {
      out[tx.id] = computeTranscriptMetadata(tx)
    }
    return out
  }, [orderedTranscripts])

  const transcriptTagInfoById = useMemo(() => {
    const out = {}
    for (const tx of orderedTranscripts) {
      out[tx.id] = getTranscriptTagInfo(tx)
    }
    return out
  }, [orderedTranscripts])

  const transcriptExonStateMapById = useMemo(() => {
    const out = {}
    const geneChrom = String(resolved?.gene?.chrom || '')
    for (const tx of orderedTranscripts) {
      out[tx.id] = buildTranscriptExonMap(tx, geneChrom || tx?.chrom || '')
    }
    return out
  }, [orderedTranscripts, resolved?.gene?.chrom])

  const clickedExonTranscriptCounts = useMemo(() => {
    if (!clickedExonInfo?.exonState) return { sameBoundary: 0, sameState: 0, total: orderedTranscripts.length }
    const { boundaryKey, exonStateKey } = clickedExonInfo.exonState
    let sameBoundary = 0
    let sameState = 0
    for (const tx of orderedTranscripts) {
      const entry = transcriptExonStateMapById?.[tx.id]?.get(boundaryKey)
      if (entry) {
        sameBoundary += 1
        if (entry.exonStateKey === exonStateKey) sameState += 1
      }
    }
    return { sameBoundary, sameState, total: orderedTranscripts.length }
  }, [clickedExonInfo, orderedTranscripts, transcriptExonStateMapById])

  const exonCoverage = useMemo(
    () => computeExonCoverage(activeTranscripts, orderedTranscripts.length),
    [activeTranscripts, orderedTranscripts.length]
  )
  const exonCoverageStrand = String(resolved?.gene?.strand || activeTranscripts[0]?.strand || '+')
  const exonCoverageInfo = useMemo(
    () => exonCoverageInfoRows(
      exonCoverage.stats,
      resolved?.gene?.chrom,
      exonCoverageProfile(exonCoverage, exonCoverageStrand),
    ),
    [exonCoverage, exonCoverageStrand, resolved?.gene?.chrom]
  )
  const showExonCoverageRow = orderedTranscripts.length > 0 && (exonCoverageRowActive || !collapseInactiveRows)

  const expandedInfoHeightFor = useCallback((transcriptId) => {
    if (!expandedTranscriptIds.has(transcriptId)) return 0
    if (transcriptId === EXON_COVERAGE_ROW_ID) {
      return exonCoverageInfoPanelHeight(exonCoverageInfo) + 6
    }
    const metadata = transcriptMetaById[transcriptId]
    const codonStatus = codonStatusById[transcriptId]
    return transcriptInfoPanelHeight(metadata, codonStatus) + 6
  }, [expandedTranscriptIds, transcriptMetaById, codonStatusById, exonCoverageInfo])

  const transcriptRowHeightFor = useCallback((transcriptId) => (
    transcriptRowHeight + expandedInfoHeightFor(transcriptId)
  ), [transcriptRowHeight, expandedInfoHeightFor])

  const fetchCodonSequence = useCallback(async (chrom, startInclusive, endInclusive) => {
    const start = Math.max(0, Number(startInclusive) - 1)
    const end = Math.max(start + 1, Number(endInclusive))
    const url = `${API_BASE}/api/browse/sequence?genome=${encodeURIComponent(activeGenomeKey || 'reference')}&chrom=${encodeURIComponent(chrom)}&start=${start}&end=${end}`
    const res = await fetch(url)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.detail || 'Failed to fetch sequence')
    }
    return String(data?.sequence || '').toUpperCase()
  }, [])

  const fetchCodonStatus = useCallback(async (tx) => {
    const txId = String(tx?.id || '')
    if (!txId) return
    const intervals = getCodonIntervals(tx)
    if (!intervals) {
      setCodonStatusById((prev) => ({
        ...prev,
        [txId]: { loading: false, startPresent: false, stopPresent: false, startCodon: '', stopCodon: '' },
      }))
      return
    }

    setCodonStatusById((prev) => ({
      ...prev,
      [txId]: { ...(prev?.[txId] || {}), loading: true, error: '' },
    }))

    try {
      const [startSeqRaw, stopSeqRaw] = await Promise.all([
        fetchCodonSequence(tx.chrom, intervals.start.start, intervals.start.end),
        fetchCodonSequence(tx.chrom, intervals.stop.start, intervals.stop.end),
      ])
      const startCodon = intervals.strand === '-' ? reverseComplement(startSeqRaw) : startSeqRaw
      const stopCodon = intervals.strand === '-' ? reverseComplement(stopSeqRaw) : stopSeqRaw
      const startPresent = startCodon === 'ATG'
      const stopPresent = ['TAA', 'TAG', 'TGA'].includes(stopCodon)
      setCodonStatusById((prev) => ({
        ...prev,
        [txId]: { loading: false, startPresent, stopPresent, startCodon, stopCodon, error: '' },
      }))
    } catch (err) {
      setCodonStatusById((prev) => ({
        ...prev,
        [txId]: {
          loading: false,
          startPresent: null,
          stopPresent: null,
          startCodon: '',
          stopCodon: '',
          error: err?.message || 'Unable to check codons',
        },
      }))
    }
  }, [fetchCodonSequence])

  useEffect(() => {
    for (const id of expandedTranscriptIds) {
      const tx = transcriptById.get(id)
      const meta = tx ? transcriptMetaById[id] : null
      if (!tx || !meta || !meta.isProteinCoding) continue
      if (codonStatusById[id]) continue
      fetchCodonStatus(tx)
    }
  }, [expandedTranscriptIds, transcriptById, transcriptMetaById, codonStatusById, fetchCodonStatus])

  const onTranscriptDragStart = useCallback((event, transcriptId) => {
    setDragSourceId(transcriptId)
    setInsertTargetId('')
    setInsertPosition('before')
    suppressClickAfterDragRef.current = true
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', transcriptId)
  }, [])

  const onTranscriptDragOver = useCallback((event, transcriptId) => {
    const sourceId = dragSourceId || event.dataTransfer.getData('text/plain')
    if (!sourceId || sourceId === transcriptId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const boundary = rect.top + (rect.height / 2)
    const position = event.clientY < boundary ? 'before' : 'after'
    setInsertTargetId(transcriptId)
    setInsertPosition(position)
  }, [dragSourceId])

  const onTranscriptDrop = useCallback((event, transcriptId) => {
    event.preventDefault()
    const sourceId = dragSourceId || event.dataTransfer.getData('text/plain')
    if (!sourceId || sourceId === transcriptId) return
    const position = insertTargetId === transcriptId ? insertPosition : 'before'
    setManualOrderIds((prev) => {
      const fallback = orderedTranscripts.map((tx) => tx.id)
      const sourceOrder = prev.length > 0 ? prev : fallback
      return moveId(sourceOrder, sourceId, transcriptId, position)
    })
    setDragSourceId('')
    setInsertTargetId('')
    setInsertPosition('before')
    setMouseDownId('')
  }, [dragSourceId, insertTargetId, insertPosition, orderedTranscripts])

  const onTranscriptDragEnd = useCallback(() => {
    setDragSourceId('')
    setInsertTargetId('')
    setInsertPosition('before')
    setMouseDownId('')
    window.setTimeout(() => {
      suppressClickAfterDragRef.current = false
    }, 0)
  }, [])

  const onTranscriptMouseDown = useCallback((transcriptId) => {
    setMouseDownId(transcriptId)
  }, [])

  const onTranscriptMouseUp = useCallback(() => {
    setMouseDownId('')
  }, [])

  const clearSplicePathSelection = useCallback(() => {
    setSplicePathSelection({
      hasSelection: false,
      selectedNodeId: '',
      selectedTranscriptIds: [],
      byTranscript: {},
    })
    setSpliceFocusedTranscriptId('')
    setSpliceHoveredTranscriptId('')
    setSpliceSelectionClearSignal((value) => value + 1)
  }, [])

  const clearLockedSpliceTranscript = useCallback(() => {
    setSpliceFocusedTranscriptId('')
    setSpliceHoveredTranscriptId('')
  }, [])

  const lockSpliceTranscript = useCallback((transcriptId) => {
    const nextId = String(transcriptId || '').trim()
    if (!nextId) return
    setSpliceFocusedTranscriptId(nextId)
    setSpliceHoveredTranscriptId('')
  }, [])

  const handleSpliceSelectionChange = useCallback((selection) => {
    const next = selection && typeof selection === 'object'
      ? selection
      : { hasSelection: false, selectedNodeId: '', selectedTranscriptIds: [], byTranscript: {} }
    setSplicePathSelection(next)
    if (!next?.hasSelection) {
      setSpliceFocusedTranscriptId('')
      setSpliceHoveredTranscriptId('')
      return
    }
    setClickedExonInfo(null)
    const selectedIds = Array.isArray(next.selectedTranscriptIds) ? next.selectedTranscriptIds : []
    setSpliceFocusedTranscriptId((prev) => (prev && selectedIds.includes(prev) ? prev : ''))
    setSpliceHoveredTranscriptId((prev) => (prev && selectedIds.includes(prev) ? prev : ''))
  }, [])

  useEffect(() => {
    if (!spliceHoveredTranscriptId) return
    if (!splicePathSelection?.hasSelection) {
      setSpliceHoveredTranscriptId('')
      return
    }
    if (!splicePathSetsByTranscript[spliceHoveredTranscriptId]) {
      setSpliceHoveredTranscriptId('')
    }
  }, [spliceHoveredTranscriptId, splicePathSelection?.hasSelection, splicePathSetsByTranscript])

  const toggleTranscriptStable = useStableCallback(toggleTranscript)
  const setAllVisibleStable = useStableCallback(setAllVisible)
  const restoreDefaultOrderingStable = useStableCallback(restoreDefaultOrdering)
  const handleSpliceGraphPointerDown = useStableCallback(() => resetTranscriptZoom(true))
  // Ensembl and RefSeq (NCBI) annotation: open the structure panel and look the
  // structure up straight away. A genome with no recorded provider is Ensembl,
  // as the backend reads it; custom ('manual') and demo annotation start closed.
  const structurePanelDefaultOpen = ['ensembl', 'ncbi'].includes(
    String(selectedGenome?.provider || 'ensembl').trim().toLowerCase()
  )
  const registerStructureScreenshot = useCallback((builder) => { structureSnapshotRef.current = builder }, [])
  const clearExportSeedSequence = useCallback(() => setExportSeedSequence(null), [])

  const activeActionButtonClass = isLight
    ? 'bg-[#0099ff] text-white border-transparent hover:bg-[#0099ff]'
    : 'bg-[#0077cc] text-white border-transparent hover:bg-[#0077cc]'

  useEffect(() => {
    if (!resolved?.gene) {
      onScreenshotModeChange?.(false)
      setSelectedScreenshotTarget(null)
      for (const targetId of [
        'feature-gene-panel',
        'feature-transcript-panel',
        'feature-splice-graph',
        'feature-sequences-panel',
        'feature-exon-atlas',
        'feature-exon-detail',
        'feature-protein-panel',
        'feature-structure-panel',
      ]) {
        removeScreenshotTarget(targetId)
      }
      return
    }

    const makeDescriptor = (id, label, ref, options = {}) => {
      const node = ref?.current
      if (!node) {
        syncScreenshotTarget(id, null)
        return
      }
      syncScreenshotTarget(id, {
        label,
        getVisibleRect: () => node.getBoundingClientRect(),
        buildDefaultFilename: () => buildDefaultScreenshotName(options.prefix || 'ens_screenshot'),
        buildExportSnapshot: options.buildExportSnapshot
          ? async () => options.buildExportSnapshot(node)
          : async () => buildFeatureScreenshotSnapshot(node, {
            popupNode: typeof options.popupNode === 'function' ? options.popupNode() : options.popupNode,
          }),
      })
    }

    makeDescriptor('feature-gene-panel', 'gene panel', geneSectionRef, { prefix: 'ens_feature_gene_panel' })
    makeDescriptor('feature-transcript-panel', 'transcript panel', transcriptPanelScreenshotRef, {
      prefix: 'ens_feature_transcript_panel',
      popupNode: () => clickedExonInfo ? exonInfoPopupRef.current : null,
    })
    makeDescriptor('feature-splice-graph', 'transcript splice graph', spliceGraphScreenshotRef, {
      prefix: 'ens_feature_splice_graph',
      buildExportSnapshot: () => buildSpliceGraphScreenshotSnapshot(),
    })
    makeDescriptor('feature-sequences-panel', 'transcript sequences panel', sequencePanelScreenshotRef, {
      prefix: 'ens_feature_sequences_panel',
    })
    makeDescriptor('feature-exon-atlas', 'exon atlas', exonAtlasScreenshotRef, {
      prefix: 'ens_feature_exon_atlas',
    })
    makeDescriptor('feature-exon-detail', 'exon detail panel', exonDetailScreenshotRef, {
      prefix: 'ens_feature_exon_detail',
    })
    makeDescriptor('feature-protein-panel', 'protein panel', proteinsScreenshotRef, {
      prefix: 'ens_feature_protein_panel',
    })
    makeDescriptor('feature-structure-panel', 'structure panel', structureScreenshotRef, {
      prefix: 'ens_feature_structure_panel',
      buildExportSnapshot: () => buildStructureScreenshotSnapshot(),
    })
  }, [
    buildFeatureScreenshotSnapshot,
    buildSpliceGraphScreenshotSnapshot,
    buildStructureScreenshotSnapshot,
    clickedExonInfo,
    onScreenshotModeChange,
    removeScreenshotTarget,
    resolved?.gene,
    sequencePanelScreenshotRef,
    spliceGraphScreenshotRef,
    syncScreenshotTarget,
  ])

  return (
    <>
    <div ref={setFeatureExplorerRoot} className={`relative h-full flex flex-col gap-3 sv-controls ${isLight ? 'light' : ''}`}>
      <BrowserScrollRail
        panels={sectionRailStops}
        hostRef={screenshotContentRef}
        onJump={scrollToFeatureSection}
        isActive={Boolean(resolved?.gene) && !screenshotMode}
        isLight={isLight}
        resolveAnchor={resolveSectionRailAnchor}
        anchorGap={8}
        resolveRailLeft={resolveSectionRailLeft}
        ariaLabel="Feature Explorer position"
        tourId="feature-scroll-rail"
        stopTourPrefix="feature-scroll-rail-section-"
      />
      <div className={`rounded-xl border px-4 py-3 ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-0">
            {genomeOptions.length > 0 ? (
              <div className="sv-genome-host flex-shrink-0">
                <GenomeTool
                  options={genomeOptions}
                  genomeKey={activeGenomeKey}
                  isLight={isLight}
                  root={genomeMenuRoot}
                  onChange={handleGenomeOptionChange}
                />
              </div>
            ) : (
              <div
                className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-full border font-medium min-w-[110px] ${isLight ? 'bg-gray-100 text-gray-400 border-gray-300' : 'bg-gray-800 text-gray-500 border-gray-700'}`}
              >
                Genome
              </div>
            )}
            <form onSubmit={onSubmit} className="flex items-center gap-2 min-w-[220px] flex-1 max-w-[480px]">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter gene symbol or stable ID"
                className={`w-full px-3 py-2 rounded-lg text-sm border ${isLight
                  ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                  : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                  }`}
                disabled={!hasGenome || loading}
              />
              <button
                type="submit"
                disabled={!hasGenome || loading || !String(query || '').trim()}
                className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${(!hasGenome || loading || !String(query || '').trim())
                  ? (isLight ? 'bg-gray-100 text-gray-400 border-gray-300' : 'bg-gray-800 text-gray-500 border-gray-700')
                  : activeActionButtonClass
                  }`}
              >
                {loading ? 'Loading...' : 'Go'}
              </button>
            </form>
            <div className={`self-stretch w-px ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`} />
            <div className="flex flex-wrap items-center gap-1.5">
              {FEATURE_SECTION_JUMPS.map((item) => {
                return (
                <button
                  key={`feature-jump-${item.key}`}
                  type="button"
                  onClick={() => scrollToFeatureSection(item.key)}
                  disabled={!resolved?.gene}
                  className={`px-3.5 py-2 rounded-lg text-sm font-semibold border transition-colors ${!resolved?.gene
                    ? (isLight
                      ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                      : 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed')
                    : activeActionButtonClass
                    }`}
                  title={`Jump to ${item.label}`}
                >
                  {item.label}
                </button>
                )
              })}
            </div>
          </div>
        </div>
        {error && (
          <div className={`mt-2 text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
            {error}
          </div>
        )}
      </div>

      {!hasGenome ? (
        <div className={`rounded-xl border p-4 text-sm ${isLight ? 'bg-white border-gray-200 text-gray-600' : 'bg-gray-800 border-gray-700 text-gray-300'}`}>
          Select an active genome with annotation data to use Feature Explorer.
        </div>
      ) : (
        <div
          ref={contentScrollRef}
          className={`relative flex-1 min-h-0 rounded-xl border overflow-auto ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}
        >
          {!resolved?.gene ? (
            isResolvingFocusedGene ? (
              <div className="h-full flex items-center justify-center px-6">
                <div className={`rounded-xl border px-5 py-4 shadow-sm flex items-center gap-3 ${isLight ? 'bg-white border-gray-200 text-gray-700' : 'bg-gray-900/55 border-gray-700 text-gray-200'}`}>
                  <div
                    className={`h-6 w-6 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>
                      Loading Feature Explorer
                    </div>
                    <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                      Resolving {externalFocusQuery} for the selected genome...
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className={`h-full flex items-center justify-center text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Enter a gene symbol or ID to load transcripts for the selected genome.
              </div>
            )
          ) : (
            <div ref={screenshotContentRef} className="relative min-w-[940px] p-3 space-y-3">
              <div ref={geneSectionRef} className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setGeneSectionCollapsed((prev) => !prev)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setGeneSectionCollapsed((prev) => !prev)
                    }
                  }}
                  className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                >
                  <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>
                    {genePanelData
                      ? `Gene: ${genePanelData.symbol !== '—' ? `${genePanelData.symbol}, ` : ''}${genePanelData.stableId}, ${genePanelData.location}`
                      : 'Gene'}
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setGeneSectionCollapsed((prev) => !prev)
                    }}
                    className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
                      ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                      : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                      }`}
                    title={geneSectionCollapsed ? 'Expand gene metadata' : 'Collapse gene metadata'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      {geneSectionCollapsed
                        ? <polyline points="6 9 12 15 18 9" />
                        : <polyline points="18 15 12 9 6 15" />}
                    </svg>
                  </button>
                </div>
                {!geneSectionCollapsed && genePanelData && (
                  <div className="px-4 py-3">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 text-sm">
                      {genePanelStatColumns.map((column, columnIndex) => (
                        <div key={`gene-col-${columnIndex}`} className="space-y-2">
                          {column.map((item) => (
                            <div key={item.label} className={isLight ? 'text-gray-700' : 'text-gray-200'}>
                              <span className={isLight ? 'text-gray-500' : 'text-gray-400'}>{item.label}:</span> {item.value}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className={`mt-3 text-sm ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                      <span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Description:</span> {genePanelData.description}
                    </div>
                  </div>
                )}
              </div>

              <div ref={transcriptsSectionRef} className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setTranscriptsSectionCollapsed((prev) => !prev)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setTranscriptsSectionCollapsed((prev) => !prev)
                    }
                  }}
                  className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                >
                  <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>Transcripts</div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setTranscriptsSectionCollapsed((prev) => !prev)
                    }}
                    className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
                      ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                      : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                      }`}
                    title={transcriptsSectionCollapsed ? 'Expand transcripts panel' : 'Collapse transcripts panel'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      {transcriptsSectionCollapsed
                        ? <polyline points="6 9 12 15 18 9" />
                        : <polyline points="18 15 12 9 6 15" />}
                    </svg>
                  </button>
                </div>
                {!transcriptsSectionCollapsed && (
                  <div
                    onMouseDownCapture={(event) => {
                      const insideHeatmap = Boolean(event?.target?.closest?.('[data-splice-heatmap-root="true"]'))
                      const insideSpliceFocus = Boolean(event?.target?.closest?.('[data-splice-path-focus-candidate="true"]'))
                      const insideExonFeature = Boolean(event?.target?.closest?.('[data-feature-exon-candidate="true"]'))
                      const insideTranscriptTrack = Boolean(event?.target?.closest?.('[data-feature-transcript-track="true"]'))

                      if (splicePathSelection?.hasSelection && !insideHeatmap && !insideSpliceFocus) {
                        if (insideTranscriptTrack) {
                          clearLockedSpliceTranscript()
                        } else {
                          clearSplicePathSelection()
                        }
                      }
                      if (selectedExonStateKey && !insideHeatmap && !insideExonFeature) {
                        setSelectedExonStateKey('')
                      }
                      if (clickedExonInfo && !insideExonFeature) {
                        setClickedExonInfo(null)
                      }
                    }}
                  >
                    <div ref={transcriptPanelScreenshotRef}>
                      <div className="absolute pointer-events-none invisible whitespace-nowrap">
                        <div ref={transcriptControlsMeasureRef} className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap">Deactivate</span>
                          <span className="px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap">Show inactive</span>
                          <span className="px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap">Default</span>
                        </div>
                      </div>
                      <div
                        className={`grid border-b transition-[grid-template-columns] duration-300 ease-out ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                        style={{ gridTemplateColumns: `32px minmax(0,1fr) ${transcriptListCollapsed ? 36 : transcriptListPanelWidth}px` }}
                      >
                <div className={`relative ${isLight ? 'border-r border-gray-200' : 'border-r border-gray-700'}`}>
                  <div className="absolute inset-x-0 bottom-0 h-[42px] flex items-start justify-center px-1">
                    <button
                      type="button"
                      onClick={toggleAllActiveExpanded}
                      disabled={activeTranscriptIds.size === 0}
                      className={`mt-2 w-6 h-6 rounded border flex items-center justify-center transition-colors ${activeTranscriptIds.size === 0
                        ? (isLight ? 'bg-gray-100 text-gray-400 border-gray-300' : 'bg-gray-800 text-gray-500 border-gray-700')
                        : (isLight ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                        }`}
                      title={allActiveExpanded ? 'Collapse all active transcript info' : 'Expand all active transcript info'}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        {allActiveExpanded
                          ? <polyline points="18 15 12 9 6 15" />
                          : <polyline points="6 9 12 15 18 9" />}
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="px-3 py-2">
                  <TranscriptRuler
                    longestTranscript={longestTranscript}
                    isLight={isLight}
                    viewBoxWidth={rulerViewBoxWidth}
                    palette={palette}
                    leftMargin={trackMarginLeft}
                    rightMargin={trackMarginRight}
                    reverseOrientation={reverseOrientation}
                  />
                </div>
                <div className={`${transcriptListCollapsed ? 'px-1 py-2' : 'px-3 py-3'} flex flex-col justify-center gap-2 ${isLight ? 'border-l border-gray-200' : 'border-l border-gray-700'}`}>
                  <div className={`flex items-start justify-between gap-1 ${transcriptListCollapsed ? 'h-full' : ''}`}>
                    {!transcriptListCollapsed && (
                      <div>
                        <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                          Transcript activity
                        </div>
                        <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                          Active: {activeCount} | Inactive: {inactiveCount}
                        </div>
                      </div>
                    )}
                    <div className={`flex items-center gap-1 ${transcriptListCollapsed ? 'mx-auto mt-1' : ''}`}>
                      {!transcriptListCollapsed && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsTranscriptBoxSelectMode((prev) => !prev)
                            setTranscriptSelectionRect(null)
                            transcriptSelectionDragRef.current = null
                          }}
                          className={`w-6 h-6 rounded border transition-colors flex items-center justify-center ${isTranscriptBoxSelectMode
                            ? activeActionButtonClass
                            : (isLight
                              ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                              : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                            }`}
                          title={isTranscriptBoxSelectMode ? 'Selection zoom active: drag to zoom transcripts' : 'Activate selection zoom mode for transcripts'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
                            <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
                          </svg>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setTranscriptListCollapsed((prev) => !prev)}
                        className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                          ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                          : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                          }`}
                        title={transcriptListCollapsed ? 'Expand transcript list' : 'Collapse transcript list'}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          {transcriptListCollapsed
                            ? <polyline points="15 6 9 12 15 18" />
                            : <polyline points="9 6 15 12 9 18" />}
                        </svg>
                      </button>
                    </div>
                  </div>
                  {!transcriptListCollapsed && (
                    <div className="flex items-center gap-2 flex-nowrap">
                      <button
                        type="button"
                        onClick={setAllVisible}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap ${activeActionButtonClass}`}
                        title={allActive ? 'Deactivate every transcript in the list' : 'Activate every transcript in the list'}
                      >
                        {allActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCollapseInactiveRows((prev) => !prev)}
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap ${isLight
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
                        className={`px-2.5 py-1 rounded text-[11px] font-semibold border whitespace-nowrap ${isLight
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
                      </div>

                      <div
                        className="grid transition-[grid-template-columns] duration-300 ease-out"
                        style={{ gridTemplateColumns: `32px minmax(0,1fr) ${transcriptListCollapsed ? 36 : transcriptListPanelWidth}px` }}
                      >
                <div className={isLight ? 'border-r border-gray-200' : 'border-r border-gray-700'}>
                  {showExonCoverageRow && (
                    <div
                      className={`px-1 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-start justify-center`}
                      style={{ height: `${transcriptRowHeightFor(EXON_COVERAGE_ROW_ID)}px` }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleTranscriptExpanded(EXON_COVERAGE_ROW_ID)}
                        className={`mt-2 w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                          ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                          : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                          }`}
                        title={expandedTranscriptIds.has(EXON_COVERAGE_ROW_ID) ? 'Collapse exon coverage info' : 'Expand exon coverage info'}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          {expandedTranscriptIds.has(EXON_COVERAGE_ROW_ID)
                            ? <polyline points="18 15 12 9 6 15" />
                            : <polyline points="6 9 12 15 18 9" />}
                        </svg>
                      </button>
                    </div>
                  )}
                  {visibleDisplayIds.map((id) => {
                    const tx = transcriptById.get(id)
                    if (!tx) return null
                    const isExpanded = expandedTranscriptIds.has(tx.id)
                    return (
                      <div
                        key={`expand-${tx.id}`}
                        className={`px-1 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-start justify-center`}
                        style={{ height: `${transcriptRowHeightFor(tx.id)}px` }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleTranscriptExpanded(tx.id)}
                          className={`mt-2 w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                            ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                            : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                            }`}
                          title={isExpanded ? 'Collapse transcript info' : 'Expand transcript info'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            {isExpanded
                              ? <polyline points="18 15 12 9 6 15" />
                              : <polyline points="6 9 12 15 18 9" />}
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>

                <div
                  ref={transcriptTrackViewportRef}
                  className="relative"
                  data-feature-transcript-track="true"
                  onPointerDown={handleTranscriptTrackPointerDown}
                  onDoubleClick={() => resetTranscriptZoom(true)}
                  onClick={() => {
                    setClickedExonInfo(null)
                    clearLockedSpliceTranscript()
                  }}
                  style={{ cursor: isTranscriptBoxSelectMode ? 'crosshair' : 'default' }}
                >
                  {showExonCoverageRow && (() => {
                    const coverageDrawn = exonCoverageRowActive || exonCoverageRowHovered
                    const { runs, stats } = exonCoverage
                    // Bases, as the transcript rows draw them: over each exonic
                    // base in a colour that reads on its heat, and lower-case in
                    // grey for the intron bases at each exon–intron boundary.
                    const coverageLetters = []
                    const letterFrom = Math.max(Number(stats.spanStart), Math.floor(Math.min(transcriptViewStart, transcriptViewEnd)))
                    const letterTo = Math.min(Number(stats.spanEnd), Math.ceil(Math.max(transcriptViewStart, transcriptViewEnd)))
                    if (coverageDrawn && runs.length > 0 && trackBaseLettersReady(letterFrom, letterTo)) {
                      const drawFrom = Math.max(Number(stats.spanStart), letterFrom - transcriptBaseRenderMargin)
                      const drawTo = Math.min(Number(stats.spanEnd), letterTo + transcriptBaseRenderMargin)
                      const coveredBlocks = runs.filter((run) => run.count > 0)
                      const flanks = positionsInRanges(intronFlankRanges(coveredBlocks, TRANSCRIPT_TRACK_INTRON_FLANK_BP), drawFrom, drawTo)
                      const letterY = 3 + (18 * 0.72)
                      for (const run of runs) {
                        const from = Math.max(drawFrom, run.start)
                        const to = Math.min(drawTo, run.end)
                        const textColour = run.count > 0 ? readableTextOn(heatColorFromFraction(run.fraction)) : null
                        for (let pos = from; pos <= to; pos += 1) {
                          if (!textColour && !flanks.has(pos)) continue
                          const base = trackBaseAt(pos)
                          if (!base) continue
                          const bx1 = mapCoordToTrack(pos)
                          const bx2 = mapCoordToTrack(pos + 1)
                          const bx = Math.min(bx1, bx2)
                          const bw = Math.max(0.72, Math.abs(bx2 - bx1) - 0.08)
                          if (!textColour) {
                            coverageLetters.push(
                              <rect key={`coverage-flank-mask-${pos}`} x={bx} y={6} width={bw} height={12} fill={isLight ? '#ffffff' : '#1f2937'} />
                            )
                          }
                          coverageLetters.push(
                            <text
                              key={`coverage-base-${pos}`}
                              x={bx + (bw / 2)}
                              y={letterY}
                              fontSize={Math.max(8.4, Math.min(12.4, bw * 0.78))}
                              fill={textColour || (isLight ? '#6b7280' : '#9ca3af')}
                              textAnchor="middle"
                              fontFamily={FONT_MONO}
                              pointerEvents="none"
                            >
                              {textColour ? base : base.toLowerCase()}
                            </text>
                          )
                        }
                      }
                    }
                    return (
                      <div
                        data-feature-exon-coverage-row="true"
                        className={`px-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                        style={{ height: `${transcriptRowHeightFor(EXON_COVERAGE_ROW_ID)}px` }}
                      >
                        <div className="h-full flex flex-col">
                          <div className="h-[42px] flex items-center">
                            <div className="flex-1 min-w-0" data-feature-transcript-track-surface="true">
                              <svg className="w-full h-7" viewBox={`0 0 ${rulerViewBoxWidth} 24`} preserveAspectRatio="xMinYMid meet">
                                <defs>
                                  <clipPath id="tclip-exon-coverage">
                                    <rect x={trackMarginLeft} y={0} width={trackInnerWidth} height={24} />
                                  </clipPath>
                                </defs>
                                {(coverageDrawn && runs.length > 0) ? (
                                  <g clipPath="url(#tclip-exon-coverage)">
                                  <g data-transcript-zoom-layer="true">
                                    <line
                                      x1={mapCoordToTrack(stats.spanStart)}
                                      y1="12"
                                      x2={mapCoordToTrack(stats.spanEnd + 1)}
                                      y2="12"
                                      stroke={palette.intronLine}
                                      strokeWidth={1.5}
                                      strokeLinecap="round"
                                    />
                                    {runs.map((run) => {
                                      if (run.count <= 0) return null
                                      // Inclusive coordinates: a run covers its
                                      // last base too, so it is drawn to end + 1.
                                      const x1 = mapCoordToTrack(run.start)
                                      const x2 = mapCoordToTrack(run.end + 1)
                                      const colour = heatColorFromFraction(run.fraction)
                                      return (
                                        <rect
                                          key={`coverage-${run.start}`}
                                          x={Math.min(x1, x2)}
                                          y={3}
                                          width={Math.abs(x2 - x1)}
                                          height={18}
                                          fill={colour}
                                          fillOpacity={0.92}
                                          stroke={colour}
                                          strokeWidth={0.6}
                                        />
                                      )
                                    })}
                                    <g data-transcript-base-letters="true">{coverageLetters}</g>
                                  </g>
                                  </g>
                                ) : (
                                  <line
                                    x1={trackMarginLeft}
                                    y1="12"
                                    x2={rulerViewBoxWidth - trackMarginRight}
                                    y2="12"
                                    stroke={isLight ? '#cbd5e1' : '#334155'}
                                    strokeWidth="1"
                                    strokeDasharray="3 3"
                                  />
                                )}
                              </svg>
                            </div>
                            <div className="shrink-0" style={{ width: `${SPLICE_LOCK_GUTTER_WIDTH}px` }} />
                          </div>
                          {expandedTranscriptIds.has(EXON_COVERAGE_ROW_ID) && (
                            <div
                              data-transcript-info-panel="true"
                              className={`mx-1 mb-1 rounded border px-2 py-1 text-[11px] leading-5 ${isLight
                                ? 'bg-gray-50 border-gray-200 text-gray-700'
                                : 'bg-gray-900/45 border-gray-700 text-gray-300'
                                }`}
                            >
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                {exonCoverageInfo.flatMap((row) => row.map((cell) => (cell.type === 'chart' ? (
                                  <ExonCoverageProfileChart
                                    key={cell.key}
                                    cell={cell}
                                    stats={exonCoverage.stats}
                                    strand={exonCoverageStrand}
                                    chrom={resolved?.gene?.chrom}
                                    isLight={isLight}
                                  />
                                ) : (
                                  <div
                                    key={cell.key}
                                    className={`${row.length === 1 ? 'col-span-2' : ''} truncate`}
                                    title={cell.hint || undefined}
                                  >
                                    {cell.swatch && (
                                      <span
                                        className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]"
                                        style={{ backgroundColor: cell.swatch }}
                                      />
                                    )}
                                    {cell.label ? `${cell.label}: ` : ''}{cell.value}
                                  </div>
                                ))))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })()}
                  {visibleDisplayIds.map((id) => {
                    const tx = transcriptById.get(id)
                    if (!tx) return null
                    const isActive = activeTranscriptIds.has(tx.id)
                    const isPreviewTrack = !isActive && hoveredInactiveTranscriptId === tx.id
                    const isCanonical = Boolean(tx?.is_canonical)
                    const hasSpliceSelection = Boolean(splicePathSelection?.hasSelection)
                    const spliceTxSelection = splicePathSetsByTranscript[tx.id] || null
                    const transcriptOnSplicePath = hasSpliceSelection && Boolean(spliceTxSelection)
                    const hasFocusedSpliceTranscript = hasSpliceSelection && Boolean(splicePathSelection?.byTranscript?.[effectiveSpliceFocusedTranscriptId])
                    const isFocusedSpliceTranscript = hasFocusedSpliceTranscript && effectiveSpliceFocusedTranscriptId === tx.id
                    const isLockedSpliceTranscript = hasSpliceSelection
                      && Boolean(splicePathSelection?.byTranscript?.[spliceFocusedTranscriptId])
                      && spliceFocusedTranscriptId === tx.id
                    const dimWholeTranscriptBySplice = hasSpliceSelection && (hasFocusedSpliceTranscript
                      ? !isFocusedSpliceTranscript
                      : !transcriptOnSplicePath)
                    const isExpanded = expandedTranscriptIds.has(tx.id)
                    const metadata = transcriptMetaById[tx.id] || null
                    const tagInfo = transcriptTagInfoById[tx.id] || { labels: [], hasManeSelect: false, hasCanonical: false }
                    const codonStatus = codonStatusById[tx.id] || null
                    const txStart = mapCoordToTrack(tx.start)
                    const txEnd = mapCoordToTrack(Number(tx.end) + 1)
                    const segments = buildTranscriptSegments(tx)
                    const orderedExons = orderedExonsFivePrimeToThreePrime(tx)
                    const orderedExonKeys = orderedExons.map((exon) => {
                      const b = orientedBoundaries(exon.start, exon.end, tx.strand)
                      return exonKeyFromBounds(b.fivePrime, b.threePrime)
                    })
                    const firstHighlightedExonIndex = transcriptOnSplicePath
                      ? orderedExonKeys.findIndex((key) => spliceTxSelection?.highlightedExonKeys?.has(key))
                      : -1
                    const orderedPrePathExonKeySet = new Set(
                      firstHighlightedExonIndex > 0
                        ? orderedExonKeys.slice(0, firstHighlightedExonIndex)
                        : []
                    )
                    const lineColor = palette.intronLine
                    const exonStrokeColor = palette.exonProteinCoding
                    const exonCodingFillColor = palette.exonProteinCoding
                    const exonMaskColor = isLight ? '#ffffff' : '#1f2937'
                    const boundaryHighlightColor = isLight ? '#0ea5e9' : '#7dd3fc'
                    const exonStrokeWidth = 1.2
                    const exonY = 3
                    const exonHeight = 18
                    const showPerBaseBlocks = (
                      transcriptDetailMode === 'base' &&
                      transcriptPxPerBp >= TRANSCRIPT_TRACK_BASEBLOCK_MIN_PX_PER_BP &&
                      currentTranscriptSpan <= TRANSCRIPT_TRACK_BASEBLOCK_MAX_SPAN_BP
                    )
                    const txMin = Math.min(Number(tx.start), Number(tx.end))
                    const txMax = Math.max(Number(tx.start), Number(tx.end))
                    const visibleStart = Math.max(txMin, Math.floor(Math.min(transcriptViewStart, transcriptViewEnd)))
                    const visibleEnd = Math.min(txMax, Math.ceil(Math.max(transcriptViewStart, transcriptViewEnd)))
                    const visibleBaseCount = Math.max(0, (visibleEnd - visibleStart) + 1)
                    // Bases are drawn a screen's width beyond each side of the view,
                    // so a pan (previewed as a plain shift) has them to show.
                    const renderStart = Math.max(txMin, visibleStart - transcriptBaseRenderMargin)
                    const renderEnd = Math.min(txMax, visibleEnd + transcriptBaseRenderMargin)
                    const renderBaseCount = Math.max(0, (renderEnd - renderStart) + 1)
                    const canRenderPerBaseBlocks = (
                      showPerBaseBlocks &&
                      visibleBaseCount > 0 &&
                      visibleBaseCount <= TRANSCRIPT_TRACK_BASEBLOCK_MAX_COUNT
                    )
                    const perBaseExonFill = exonMaskColor
                    const perBaseCodingFill = isLight ? palette.exonProteinCoding : '#6ba1ff'
                    const perBaseOpacity = dimWholeTranscriptBySplice ? 0.2 : 0.95
                    const canRenderBaseLetters = (
                      canRenderPerBaseBlocks &&
                      transcriptPxPerBp >= TRANSCRIPT_TRACK_BASETEXT_MIN_PX_PER_BP &&
                      visibleBaseCount <= TRANSCRIPT_TRACK_BASETEXT_MAX_COUNT &&
                      transcriptVisibleSequence.start <= visibleStart &&
                      transcriptVisibleSequence.end >= visibleEnd &&
                      String(transcriptVisibleSequence.sequence || '').length > 0
                    )
                    const exonicPositions = new Set()
                    const codingPositions = new Set()
                    if (canRenderPerBaseBlocks) {
                      for (const segment of segments) {
                        const segStart = Math.max(renderStart, Math.min(Number(segment?.start), Number(segment?.end)))
                        const segEnd = Math.min(renderEnd + 1, Math.max(Number(segment?.start), Number(segment?.end)))
                        for (let pos = segStart; pos < segEnd; pos++) {
                          exonicPositions.add(pos)
                          if (segment?.coding) codingPositions.add(pos)
                        }
                      }
                    }
                    const intronFlankPositions = canRenderBaseLetters
                      ? positionsInRanges(intronFlankRanges(tx.exons, TRANSCRIPT_TRACK_INTRON_FLANK_BP), renderStart, renderEnd)
                      : new Set()
                    let baseExonPathD = ''
                    let baseCodingPathD = ''
                    let baseFlankPathD = ''
                    const baseLabelElements = []
                    if (canRenderPerBaseBlocks) {
                      for (let baseIndex = 0; baseIndex < renderBaseCount; baseIndex++) {
                        const basePos = renderStart + baseIndex
                        const isCoding = codingPositions.has(basePos)
                        const isExonic = exonicPositions.has(basePos)
                        const bx1 = mapCoordToTrack(basePos)
                        const bx2 = mapCoordToTrack(basePos + 1)
                        const bx = Math.min(bx1, bx2)
                        const bw = Math.max(0.72, Math.abs(bx2 - bx1) - 0.08)
                        if (!isCoding && !isExonic) {
                          if (!intronFlankPositions.has(basePos)) continue
                          const flankBase = trackBaseAt(basePos)
                          if (!flankBase) continue
                          baseFlankPathD += `M${bx},${exonY + 3}h${bw}v${exonHeight - 6}h${-bw}Z `
                          baseLabelElements.push(
                            <text
                              key={`flank-${tx.id}-${basePos}`}
                              x={bx + (bw / 2)}
                              y={exonY + (exonHeight * 0.72)}
                              fontSize={Math.max(8.4, Math.min(12.4, bw * 0.78))}
                              fill={isLight ? '#6b7280' : '#9ca3af'}
                              fillOpacity={dimWholeTranscriptBySplice ? 0.3 : 1}
                              textAnchor="middle"
                              fontFamily={FONT_MONO}
                              pointerEvents="none"
                            >
                              {flankBase.toLowerCase()}
                            </text>
                          )
                          continue
                        }
                        if (isCoding) {
                          baseCodingPathD += `M${bx},${exonY}h${bw}v${exonHeight}h${-bw}Z `
                        } else {
                          baseExonPathD += `M${bx},${exonY}h${bw}v${exonHeight}h${-bw}Z `
                        }
                        if (canRenderBaseLetters) {
                          const sequenceIndex = basePos - Number(transcriptVisibleSequence.start || 0)
                          let baseLabel = ''
                          if (sequenceIndex >= 0 && sequenceIndex < transcriptVisibleSequence.sequence.length) {
                            baseLabel = transcriptVisibleSequence.sequence[sequenceIndex] || ''
                            if (reverseOrientation) {
                              baseLabel = BASE_COMPLEMENT_MAP[String(baseLabel).toUpperCase()] || String(baseLabel).toUpperCase()
                            }
                          }
                          if (baseLabel) {
                            baseLabelElements.push(
                              <text
                                key={`base-${tx.id}-${basePos}`}
                                x={bx + (bw / 2)}
                                y={exonY + (exonHeight * 0.72)}
                                fontSize={Math.max(8.4, Math.min(12.4, bw * 0.78))}
                                fill={isLight ? '#111827' : '#f3f4f6'}
                                textAnchor="middle"
                                fontFamily={FONT_MONO}
                                pointerEvents="none"
                              >
                                {baseLabel}
                              </text>
                            )
                          }
                        }
                      }
                    }

                    return (
                      <div
                        key={`track-${tx.id}`}
                        data-feature-transcript-row="true"
                        className={`px-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                        style={{ height: `${transcriptRowHeightFor(tx.id)}px` }}
                        onMouseLeave={() => {
                          setHoveredBoundaryFeature(null)
                          setSpliceHoveredTranscriptId((prev) => (prev === tx.id ? '' : prev))
                        }}
                      >
                        <div className="h-full flex flex-col">
                          <div className="h-[42px] flex items-center">
                              <div className="flex-1 min-w-0" data-feature-transcript-track-surface="true">
                              <svg className="w-full h-7" viewBox={`0 0 ${rulerViewBoxWidth} 24`} preserveAspectRatio="xMinYMid meet">
                              <defs>
                                <clipPath id={`tclip-${tx.id}`}>
                                  <rect x={trackMarginLeft} y={0} width={trackInnerWidth} height={24} />
                                </clipPath>
                              </defs>
                              {(isActive || isPreviewTrack) ? (
                                <>
                                <g clipPath={`url(#tclip-${tx.id})`}>
                                <g data-transcript-zoom-layer="true">
                                  <line
                                    x1={txStart}
                                    y1="12"
                                    x2={txEnd}
                                    y2="12"
                                    stroke={lineColor}
                                    strokeWidth={isCanonical ? 1.8 : 1.5}
                                    strokeLinecap="round"
                                    strokeOpacity={dimWholeTranscriptBySplice ? 0.2 : 1}
                                  />
                                {baseFlankPathD && (
                                  <path d={baseFlankPathD} fill={exonMaskColor} />
                                )}
                                {baseExonPathD && (
                                  <path
                                    d={baseExonPathD}
                                    fill={perBaseExonFill}
                                    stroke={exonStrokeColor}
                                    strokeWidth={0.42}
                                    strokeOpacity={0.5}
                                  />
                                )}
                                {baseCodingPathD && (
                                  <path
                                    d={baseCodingPathD}
                                    fill={perBaseCodingFill}
                                    fillOpacity={perBaseOpacity}
                                    stroke={exonStrokeColor}
                                    strokeWidth={0.5}
                                    strokeOpacity={0.6}
                                  />
                                )}
                                {orderedExons.map((exon, exonIndex) => {
                                  if (!transcriptOnSplicePath) return null
                                  if (exonIndex >= orderedExons.length - 1) return null
                                  const nextExon = orderedExons[exonIndex + 1]
                                  if (!nextExon) return null
                                  const exonBounds = orientedBoundaries(exon.start, exon.end, tx.strand)
                                  const nextBounds = orientedBoundaries(nextExon.start, nextExon.end, tx.strand)
                                  const key = intronKeyFromBounds(exonBounds.threePrime, nextBounds.fivePrime)
                                  if (!spliceTxSelection?.highlightedIntronKeys?.has(key)) return null
                                  const x1 = mapCoordToTrack(boundaryEdgeCoord(exonBounds.threePrime, false, tx.strand))
                                  const x2 = mapCoordToTrack(boundaryEdgeCoord(nextBounds.fivePrime, true, tx.strand))
                                  return (
                                    <g key={`splice-intron-${tx.id}-${key}`}>
                                      <line
                                        x1={x1}
                                        y1="12"
                                        x2={x2}
                                        y2="12"
                                        stroke={boundaryHighlightColor}
                                        strokeWidth={2.4}
                                        strokeLinecap="round"
                                        opacity={dimWholeTranscriptBySplice ? 0.2 : 0.95}
                                      />
                                      <line
                                        x1={x1}
                                        y1="12"
                                        x2={x2}
                                        y2="12"
                                        stroke="transparent"
                                        strokeWidth={10}
                                        strokeLinecap="round"
                                        data-splice-path-focus-candidate="true"
                                        style={{ cursor: 'pointer' }}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          if (!hasSpliceSelection || !transcriptOnSplicePath) return
                                          lockSpliceTranscript(tx.id)
                                        }}
                                        onMouseEnter={(event) => {
                                          if (!canHoverPreviewSplicePath || !hasSpliceSelection || !transcriptOnSplicePath) return
                                          if (!isWithinSpliceHoverPreviewZone(event)) return
                                          setSpliceHoveredTranscriptId(tx.id)
                                        }}
                                        onMouseLeave={() => {
                                          if (!canHoverPreviewSplicePath) return
                                          setSpliceHoveredTranscriptId((prev) => (prev === tx.id ? '' : prev))
                                        }}
                                      />
                                    </g>
                                  )
                                })}
                                {segments.map((segment) => {
                                  const x1 = mapCoordToTrack(segment.start)
                                  const x2 = mapCoordToTrack(segment.end)
                                  const segX = Math.min(x1, x2)
                                  const segW = Math.abs(x2 - x1)
                                  const hovered = segmentBoundaryMatch(segment, tx.id, hoveredBoundaryFeature, tx.strand)
                                  const segmentBounds = orientedBoundaries(segment.exonStart, segment.exonEnd, tx.strand)
                                  const segmentExonKey = exonKeyFromBounds(segmentBounds.fivePrime, segmentBounds.threePrime)
                                  const segmentBoundaryKey = `${String(resolved?.gene?.chrom || tx?.chrom || '')}:${Math.min(Number(segment.exonStart), Number(segment.exonEnd))}:${Math.max(Number(segment.exonStart), Number(segment.exonEnd))}:${String(tx?.strand || '+')}`
                                  const segmentExonState = transcriptExonStateMapById?.[tx.id]?.get?.(segmentBoundaryKey) || null
                                  const isSelectedExonState = Boolean(
                                    segmentExonState?.exonStateKey &&
                                    String(segmentExonState.exonStateKey) === String(selectedExonStateKey || '')
                                  )
                                  const isSplicePathExon = transcriptOnSplicePath && spliceTxSelection?.highlightedExonKeys?.has(segmentExonKey)
                                  const isPrePathExon = transcriptOnSplicePath &&
                                    !isSplicePathExon &&
                                    (
                                      orderedPrePathExonKeySet.has(segmentExonKey) ||
                                      spliceTxSelection?.prePathExonKeys?.has(segmentExonKey)
                                    )
                                  const allowFeatureHoverHighlight = !dimWholeTranscriptBySplice
                                  const showBoundaryEdges = (isActive || isPreviewTrack) && allowFeatureHoverHighlight && (hovered.matchFivePrime || hovered.matchThreePrime)
                                  const showWholeFeatureHighlight = (isActive || isPreviewTrack) && allowFeatureHoverHighlight && (
                                    hovered.isFeatureHover ||
                                    (hovered.matchFivePrime && hovered.matchThreePrime) ||
                                    isSplicePathExon ||
                                    isSelectedExonState
                                  )
                                  const segmentStrokeColor = showWholeFeatureHighlight ? boundaryHighlightColor : exonStrokeColor
                                  const segmentStrokeWidth = showWholeFeatureHighlight
                                    ? (isSelectedExonState ? (exonStrokeWidth + 1.05) : (exonStrokeWidth + 0.8))
                                    : exonStrokeWidth
                                  let segmentFillOpacity = showWholeFeatureHighlight ? 0.95 : (isCanonical ? 0.9 : 0.75)
                                  let segmentOpacity = 1
                                  if (dimWholeTranscriptBySplice) {
                                    segmentOpacity = 0.2
                                  } else if (isPrePathExon) {
                                    segmentOpacity = 0.26
                                  }
                                  if (isSplicePathExon) {
                                    segmentFillOpacity = Math.max(segmentFillOpacity, 0.95)
                                  }
                                  // One rectangle per piece: the fill (coding colour already
                                  // blended over the mask, so the intron line is hidden) and
                                  // the outline, with the handlers on the same element. The
                                  // outline is centred on the piece's true edges and nothing
                                  // is inset or padded by a fixed amount, so the rows can be
                                  // moved by a transform mid-gesture without any of it
                                  // drifting (see applyTranscriptViewPreview).
                                  const baseFill = segment.coding
                                    ? blendHexColor(exonCodingFillColor, exonMaskColor, segmentFillOpacity)
                                    : exonMaskColor
                                  const highlightAlpha = isSplicePathExon ? 0.2 : 0.14
                                  const segmentFill = canRenderPerBaseBlocks
                                    ? 'transparent'
                                    : (showWholeFeatureHighlight ? blendHexColor(boundaryHighlightColor, baseFill, highlightAlpha) : baseFill)
                                  // Most pieces are the one rect. A highlight overlay or hover
                                  // edge lines, when there are any, share a group with it.
                                  const hasPieceExtras = showBoundaryEdges || (showWholeFeatureHighlight && canRenderPerBaseBlocks)
                                  const pieceRect = (
                                    <rect
                                      key={`segment-${tx.id}-${segment.key}`}
                                      opacity={!hasPieceExtras && segmentOpacity < 1 ? segmentOpacity : undefined}
                                      x={segX}
                                      y={exonY}
                                      width={segW}
                                      height={exonHeight}
                                      fill={segmentFill}
                                      stroke={segmentStrokeColor}
                                      strokeWidth={segmentStrokeWidth}
                                      data-feature-exon-candidate="true"
                                      data-splice-path-focus-candidate={isSplicePathExon ? 'true' : undefined}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        const txHasCDS = Array.isArray(tx?.cds_list) && tx.cds_list.length > 0
                                        const typeLabel = !segmentExonState ? 'Unknown'
                                          : segmentExonState.stateClass === 'coding' ? 'Coding'
                                          : segmentExonState.stateClass === 'partial_coding' ? 'Partial coding'
                                          : txHasCDS ? 'UTR'
                                          : 'Non-coding'
                                        const targetRect = event.currentTarget?.getBoundingClientRect?.()
                                        const arrowTargetX = targetRect ? (targetRect.left + (targetRect.width / 2)) : event.clientX
                                        const arrowTargetY = targetRect ? (targetRect.top + (targetRect.height / 2)) : event.clientY
                                        const isSameExon = clickedExonInfo?.exonState?.exonStateKey != null
                                          && clickedExonInfo.exonState.exonStateKey === segmentExonState?.exonStateKey
                                        setClickedExonInfo(isSameExon ? null : (segmentExonState
                                          ? { exonState: segmentExonState, typeLabel, arrowTargetX, arrowTargetY }
                                          : null))
                                        if (hasSpliceSelection && transcriptOnSplicePath && isSplicePathExon) {
                                          lockSpliceTranscript(tx.id)
                                        } else {
                                          clearLockedSpliceTranscript()
                                        }
                                      }}
                                      onMouseEnter={(event) => {
                                        const featureType = segment.coding ? 'cds' : 'exon'
                                        const { featureStart, featureEnd } = getFeatureBoundaryCoords(segment, featureType)
                                        const boundaries = orientedBoundaries(featureStart, featureEnd, tx.strand)
                                        setHoveredBoundaryFeature({
                                          transcriptId: tx.id,
                                          type: featureType,
                                          strand: tx.strand,
                                          fivePrime: boundaries.fivePrime,
                                          threePrime: boundaries.threePrime,
                                        })
                                        if (canHoverPreviewSplicePath && hasSpliceSelection && transcriptOnSplicePath && isSplicePathExon) {
                                          if (!isWithinSpliceHoverPreviewZone(event)) return
                                          setSpliceHoveredTranscriptId(tx.id)
                                        } else if (canHoverPreviewSplicePath && hasSpliceSelection) {
                                          setSpliceHoveredTranscriptId('')
                                        }
                                      }}
                                      onMouseLeave={() => {
                                        setHoveredBoundaryFeature(null)
                                        if (canHoverPreviewSplicePath && isSplicePathExon) {
                                          setSpliceHoveredTranscriptId((prev) => (prev === tx.id ? '' : prev))
                                        }
                                      }}
                                    />
                                  )
                                  if (!hasPieceExtras) return pieceRect
                                  return (
                                    <g key={`segment-${tx.id}-${segment.key}`} opacity={segmentOpacity < 1 ? segmentOpacity : undefined}>
                                      {showWholeFeatureHighlight && canRenderPerBaseBlocks && (
                                        <rect
                                          x={segX}
                                          y={exonY}
                                          width={segW}
                                          height={exonHeight}
                                          fill={boundaryHighlightColor}
                                          fillOpacity={highlightAlpha}
                                          pointerEvents="none"
                                        />
                                      )}
                                      {pieceRect}
                                      {showBoundaryEdges && hovered.matchFivePrime && (
                                        <line
                                          x1={mapCoordToTrack(boundaryEdgeCoord(hovered.fivePrime, true, tx.strand))}
                                          y1={exonY - 1}
                                          x2={mapCoordToTrack(boundaryEdgeCoord(hovered.fivePrime, true, tx.strand))}
                                          y2={exonY + exonHeight + 1}
                                          stroke={boundaryHighlightColor}
                                          strokeWidth="1.4"
                                          opacity="0.85"
                                        />
                                      )}
                                      {showBoundaryEdges && hovered.matchThreePrime && (
                                        <line
                                          x1={mapCoordToTrack(boundaryEdgeCoord(hovered.threePrime, false, tx.strand))}
                                          y1={exonY - 1}
                                          x2={mapCoordToTrack(boundaryEdgeCoord(hovered.threePrime, false, tx.strand))}
                                          y2={exonY + exonHeight + 1}
                                          stroke={boundaryHighlightColor}
                                          strokeWidth="1.4"
                                          opacity="0.85"
                                        />
                                      )}
                                    </g>
                                  )
                                })}
                                <g data-transcript-base-letters="true">{baseLabelElements}</g>
                                </g>
                                </g>
                                </>
                              ) : (
                                <line
                                  x1={trackMarginLeft}
                                  y1="12"
                                  x2={rulerViewBoxWidth - trackMarginRight}
                                  y2="12"
                                  stroke={isLight ? '#cbd5e1' : '#334155'}
                                  strokeWidth="1"
                                  strokeDasharray="3 3"
                                  strokeOpacity={dimWholeTranscriptBySplice ? 0.24 : 1}
                                />
                              )}
                              </svg>
                            </div>
                            <div
                              className="shrink-0 flex items-center justify-center"
                              style={{ width: `${SPLICE_LOCK_GUTTER_WIDTH}px` }}
                            >
                              {isLockedSpliceTranscript && (
                                <button
                                  type="button"
                                  data-splice-path-focus-candidate="true"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    clearLockedSpliceTranscript()
                                  }}
                                  className="p-0 border-0 bg-transparent"
                                  style={{
                                    width: `${SPLICE_LOCK_ICON_SIZE}px`,
                                    height: `${SPLICE_LOCK_ICON_SIZE}px`,
                                    color: isLight ? '#0099ff' : '#60a5fa',
                                  }}
                                  title="Unlock transcript path focus"
                                >
                                  <svg
                                    width={SPLICE_LOCK_ICON_SIZE}
                                    height={SPLICE_LOCK_ICON_SIZE}
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    aria-hidden="true"
                                  >
                                    <path d={LOCKED_ICON_PATH} />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                          {isExpanded && metadata && (
                            <div
                              data-transcript-info-panel="true"
                              className={`mx-1 mb-1 rounded border px-2 py-1 text-[11px] leading-5 ${isLight
                                ? 'bg-gray-50 border-gray-200 text-gray-700'
                                : 'bg-gray-900/45 border-gray-700 text-gray-300'
                                }`}
                            >
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                <div>Transcript ID: <span className="font-mono">{metadata.id}</span></div>
                                <div>Biotype: {metadata.biotype || '—'} | Strand: {formatStrand(tx.strand)}</div>
                                <div>Version: {metadata.version || '—'}</div>
                                <div>Length: {formatCoord(metadata.transcriptLength)}</div>
                                <div>Exons: {formatCoord(metadata.exonCount)}</div>
                                {metadata.isProteinCoding && metadata.hasCds && (
                                  <>
                                    <div>CDS length: {formatCoord(metadata.cdsLength)}</div>
                                    <div>Translation length: {formatCoord(metadata.translationLength)}</div>
                                    <div>CDS exons: {formatCoord(metadata.cdsExonCount)}</div>
                                    <div>5&apos; UTR length: {formatCoord(metadata.fivePrimeUtrLength)}</div>
                                    <div>3&apos; UTR length: {formatCoord(metadata.threePrimeUtrLength)}</div>
                                    {(!codonStatus || codonStatus?.loading) ? (
                                      <div className="col-span-2">Start/stop codon: Calculating...</div>
                                    ) : codonStatus?.error ? (
                                      <div className="col-span-2">Start/stop codon: Unavailable</div>
                                    ) : (
                                      <>
                                        <div>Start codon: {codonStatus?.startPresent === true ? `Yes (${codonStatus?.startCodon || 'ATG'})` : `No (${codonStatus?.startCodon || '---'})`}</div>
                                        <div>Stop codon: {codonStatus?.stopPresent === true ? `Yes (${codonStatus?.stopCodon || '---'})` : `No (${codonStatus?.stopCodon || '---'})`}</div>
                                      </>
                                    )}
                                  </>
                                )}
                                {tagInfo.labels.length > 0 && (
                                  <div className="col-span-2 flex flex-wrap items-center gap-1 pt-0.5">
                                    <span>Labels:</span>
                                    {tagInfo.labels.map((label) => (
                                      <span
                                        key={`${tx.id}-${label}`}
                                        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none border ${isLight
                                          ? 'bg-gray-100 text-gray-700 border-gray-300'
                                          : 'bg-gray-800 text-gray-200 border-gray-600'
                                          }`}
                                      >
                                        {label}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {transcriptSelectionRect && (
                    <div
                      className="absolute rounded-sm pointer-events-none"
                      style={{
                        left: `${Math.min(transcriptSelectionRect.x1, transcriptSelectionRect.x2)}px`,
                        top: '0px',
                        width: `${Math.max(1, Math.abs(transcriptSelectionRect.x2 - transcriptSelectionRect.x1))}px`,
                        height: '100%',
                        border: `1.5px dashed ${palette.exonProteinCoding}`,
                        backgroundColor: isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)',
                      }}
                    />
                  )}
                </div>

                <div className={isLight ? 'border-l border-gray-200' : 'border-l border-gray-700'}>
                  {!transcriptListCollapsed && showExonCoverageRow && (() => {
                    const expandedHeight = expandedInfoHeightFor(EXON_COVERAGE_ROW_ID)
                    return (
                      <div
                        className={`px-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                        style={{ height: `${transcriptRowHeightFor(EXON_COVERAGE_ROW_ID)}px` }}
                      >
                        <button
                          type="button"
                          onClick={() => setExonCoverageRowActive((prev) => !prev)}
                          onMouseEnter={() => {
                            if (!exonCoverageRowActive) setExonCoverageRowHovered(true)
                          }}
                          onMouseLeave={() => setExonCoverageRowHovered(false)}
                          className={`w-full h-[34px] mt-1 rounded px-2 text-left text-xs border transition-colors ${exonCoverageRowActive
                            ? (isLight
                              ? 'bg-[#63acd8]/12 text-[#3f7696] border-[#559dc8] hover:bg-[#63acd8]/20'
                              : 'bg-sky-400/14 text-sky-100 border-sky-300/60 hover:bg-sky-400/22')
                            : (isLight
                              ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                              : 'bg-gray-900/50 text-gray-300 border-gray-600 hover:bg-gray-700')
                            }`}
                          title={`${EXON_COVERAGE_ROW_LABEL}: how many of the active transcripts have each base in an exon. Click to turn ${exonCoverageRowActive ? 'off' : 'on'}.`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-semibold">{EXON_COVERAGE_ROW_LABEL}</span>
                            <span className="shrink-0 inline-flex items-center gap-1 text-[9px] leading-none">
                              <span>0</span>
                              <span
                                className="inline-block h-2 w-10 rounded-full"
                                style={{ background: EXON_COVERAGE_LEGEND_GRADIENT }}
                              />
                              <span>{formatCoord(exonCoverage.stats.activeCount)}</span>
                            </span>
                          </div>
                        </button>
                        {expandedHeight > 0 && (
                          <div
                            className={`mt-1 w-full rounded border ${isLight
                              ? 'bg-gray-50 border-gray-200'
                              : 'bg-gray-900/45 border-gray-700'
                              }`}
                            style={{ height: `${Math.max(0, expandedHeight - 6)}px` }}
                          />
                        )}
                      </div>
                    )
                  })()}
                  {!transcriptListCollapsed && visibleDisplayIds.map((id) => {
                    const tx = transcriptById.get(id)
                    if (!tx) return null
                    const isActive = activeTranscriptIds.has(tx.id)
                    const tagInfo = transcriptTagInfoById[tx.id] || { labels: [], hasManeSelect: false, hasCanonical: false }
                    const showCanonicalLabel = tagInfo.hasCanonical
                    const showManeSelectLabel = tagInfo.hasManeSelect
                    const isExpanded = expandedTranscriptIds.has(tx.id)
                    const expandedHeight = expandedInfoHeightFor(tx.id)
                    const isDragSource = dragSourceId === tx.id || mouseDownId === tx.id
                    const isInsertTarget = insertTargetId === tx.id && dragSourceId !== tx.id
                    const insertLineColor = isLight ? 'rgba(59, 130, 246, 0.75)' : 'rgba(125, 211, 252, 0.8)'
                    return (
                      <div
                        key={`list-${tx.id}`}
                        className={`px-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                        draggable
                        onMouseDown={() => onTranscriptMouseDown(tx.id)}
                        onMouseUp={onTranscriptMouseUp}
                        onMouseLeave={onTranscriptMouseUp}
                        onDragStart={(event) => onTranscriptDragStart(event, tx.id)}
                        onDragOver={(event) => onTranscriptDragOver(event, tx.id)}
                        onDragEnter={(event) => onTranscriptDragOver(event, tx.id)}
                        onDrop={(event) => onTranscriptDrop(event, tx.id)}
                        onDragEnd={onTranscriptDragEnd}
                        style={{
                          height: `${transcriptRowHeightFor(tx.id)}px`,
                          boxShadow: isInsertTarget
                            ? (insertPosition === 'before'
                              ? `inset 0 2px 0 ${insertLineColor}`
                              : `inset 0 -2px 0 ${insertLineColor}`)
                            : 'none',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleTranscript(tx.id)}
                          onMouseEnter={() => {
                            if (!isActive) setHoveredInactiveTranscriptId(tx.id)
                          }}
                          onMouseLeave={() => {
                            setHoveredInactiveTranscriptId((prev) => (prev === tx.id ? '' : prev))
                          }}
                          className={`w-full h-[34px] mt-1 rounded px-2 text-left text-xs border transition-colors ${isActive
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
                        {isExpanded && expandedHeight > 0 && (
                          <div
                            className={`mt-1 w-full rounded border ${isLight
                              ? 'bg-gray-50 border-gray-200'
                              : 'bg-gray-900/45 border-gray-700'
                              }`}
                            style={{ height: `${Math.max(0, expandedHeight - 6)}px` }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
                      </div>
                    </div>

              <div ref={spliceGraphScreenshotRef}>
                <TranscriptSplicingHeatmap
                  activeTranscripts={activeTranscriptsInDisplayOrder}
                  reverseOrientation={reverseOrientation}
                  theme={theme}
                  onSelectionChange={handleSpliceSelectionChange}
                  onGraphPointerDown={handleSpliceGraphPointerDown}
                  clearSelectionSignal={spliceSelectionClearSignal}
                  focusedTranscriptId={effectiveSpliceFocusedTranscriptId}
                  layoutSessionKey={spliceLayoutSessionKey}
                  geneChrom={resolved?.gene?.chrom || ''}
                  geneStrand={resolved?.gene?.strand || '+'}
                  onSelectedExonStateKeyChange={setSelectedExonStateKey}
                />
              </div>

              <div ref={sequencePanelScreenshotRef}>
                <FeatureExplorerSequencesPanel
                  theme={theme}
                  resolvedGene={resolved?.gene || null}
                  sequenceGenome={activeGenomeKey || 'reference'}
                  orderedTranscripts={orderedTranscripts}
                  displayOrderIds={displayOrderIds}
                  visibleDisplayIds={visibleDisplayIds}
                  activeTranscriptIds={activeTranscriptIds}
                  transcriptById={transcriptById}
                  transcriptTagInfoById={transcriptTagInfoById}
                  allActive={allActive}
                  activeActionButtonClass={activeActionButtonClass}
                  setAllVisible={setAllVisibleStable}
                  collapseInactiveRows={collapseInactiveRows}
                  setCollapseInactiveRows={setCollapseInactiveRows}
                  restoreDefaultOrdering={restoreDefaultOrderingStable}
                  toggleTranscript={toggleTranscriptStable}
                  dragSourceId={dragSourceId}
                  insertTargetId={insertTargetId}
                  insertPosition={insertPosition}
                  mouseDownId={mouseDownId}
                  onTranscriptMouseDown={onTranscriptMouseDown}
                  onTranscriptMouseUp={onTranscriptMouseUp}
                  onTranscriptDragStart={onTranscriptDragStart}
                  onTranscriptDragOver={onTranscriptDragOver}
                  onTranscriptDrop={onTranscriptDrop}
                  onTranscriptDragEnd={onTranscriptDragEnd}
                  selectedExonStateKey={selectedExonStateKey}
                />
              </div>
                </div>
                )}
              </div>

              <div ref={exonsSectionRef}>
                <FeatureExplorerExonsPanel
                  theme={theme}
                  resolvedGene={resolved?.gene || null}
                  sequenceGenome={activeGenomeKey || 'reference'}
                  orderedTranscripts={orderedTranscripts}
                  displayOrderIds={displayOrderIds}
                  activeTranscriptIds={activeTranscriptIds}
                  transcriptById={transcriptById}
                  selectedExonStateKey={selectedExonStateKey}
                  onSelectedExonStateKeyChange={setSelectedExonStateKey}
                  atlasScreenshotRef={exonAtlasScreenshotRef}
                  detailScreenshotRef={exonDetailScreenshotRef}
                />
              </div>

              <div ref={proteinsSectionRef}>
                <div ref={proteinsScreenshotRef}>
                <FeatureExplorerProteinsPanel
                  theme={theme}
                  resolvedGene={resolved?.gene || null}
                  sequenceGenome={activeGenomeKey || 'reference'}
                  orderedTranscripts={orderedTranscripts}
                  displayOrderIds={displayOrderIds}
                  visibleDisplayIds={visibleDisplayIds}
                  activeTranscriptIds={activeTranscriptIds}
                  transcriptById={transcriptById}
                  transcriptTagInfoById={transcriptTagInfoById}
                  allActive={allActive}
                  activeActionButtonClass={activeActionButtonClass}
                  setAllVisible={setAllVisibleStable}
                  collapseInactiveRows={collapseInactiveRows}
                  setCollapseInactiveRows={setCollapseInactiveRows}
                  restoreDefaultOrdering={restoreDefaultOrderingStable}
                  toggleTranscript={toggleTranscriptStable}
                  dragSourceId={dragSourceId}
                  insertTargetId={insertTargetId}
                  insertPosition={insertPosition}
                  mouseDownId={mouseDownId}
                  onTranscriptMouseDown={onTranscriptMouseDown}
                  onTranscriptMouseUp={onTranscriptMouseUp}
                  onTranscriptDragStart={onTranscriptDragStart}
                  onTranscriptDragOver={onTranscriptDragOver}
                  onTranscriptDrop={onTranscriptDrop}
                  onTranscriptDragEnd={onTranscriptDragEnd}
                />
                </div>
              </div>

              <div ref={structureSectionRef}>
                <FeatureExplorerStructurePanel
                  theme={theme}
                  resolvedGene={resolved?.gene || null}
                  sequenceGenome={activeGenomeKey || 'reference'}
                  displayOrderIds={displayOrderIds}
                  activeTranscriptIds={activeTranscriptIds}
                  transcriptById={transcriptById}
                  containerRef={structureScreenshotRef}
                  onRegisterScreenshot={registerStructureScreenshot}
                  defaultOpen={structurePanelDefaultOpen}
                />
              </div>

              <div ref={attachExportSection}>
                <ExportSequencesPanel
                  theme={theme}
                  sequenceGenome={activeGenomeKey || 'reference'}
                  resolvedGene={resolved?.gene || null}
                  orderedTranscripts={orderedTranscripts}
                  activeTranscriptIds={activeTranscriptIds}
                  config={config}
                  externalSeedSequence={exportSeedSequence}
                  onClearExternalSeedSequence={clearExportSeedSequence}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
    <ScreenshotSelectionOverlay
      active={screenshotMode && screenshotTargets.length > 0}
      theme={theme}
      containerRef={featureExplorerRootRef}
      scrollContainerRef={contentScrollRef}
      exemptRefs={[screenshotToggleButtonRef]}
      useViewport={true}
      targets={screenshotTargets}
      instructions="Click on the highlighted area to export"
      onSelect={(target) => {
        setSelectedScreenshotTarget(target)
        onScreenshotModeChange?.(false)
      }}
      onCancel={() => {
        onScreenshotModeChange?.(false)
      }}
    />
    <ScreenshotExportModal
      open={Boolean(selectedScreenshotTarget)}
      theme={theme}
      target={selectedScreenshotTarget}
      outputDir={defaultScreenshotDir}
      onSave={handleScreenshotSave}
      onClose={handleScreenshotModalClose}
    />
    {clickedExonInfo && (
      <ExonInfoPopup
        popupRef={exonInfoPopupRef}
        exonInfo={clickedExonInfo}
        counts={clickedExonTranscriptCounts}
        resolvedGene={resolved?.gene || null}
      />
    )}
    </>
  )
}

function ExonInfoPopup({ exonInfo, counts, resolvedGene, popupRef = null }) {
  const { exonState, typeLabel, arrowTargetX, arrowTargetY } = exonInfo
  const { sameBoundary, sameState, total } = counts
  const popupW = 260
  const arrowSize = 8
  const gap = 4
  const safeArrowX = Number.isFinite(Number(arrowTargetX)) ? Number(arrowTargetX) : 24
  const safeArrowY = Number.isFinite(Number(arrowTargetY)) ? Number(arrowTargetY) : 24
  const spaceLeft = safeArrowX - arrowSize - gap
  const goLeft = spaceLeft >= popupW
  const left = goLeft
    ? safeArrowX - popupW - arrowSize - gap
    : safeArrowX + arrowSize + gap
  const chrom = String(resolvedGene?.chrom || exonState.chrom || '')
  const coordLabel = chrom
    ? `${chrom}:${Math.min(exonState.start, exonState.end).toLocaleString()}–${Math.max(exonState.start, exonState.end).toLocaleString()}`
    : `${Math.min(exonState.start, exonState.end).toLocaleString()}–${Math.max(exonState.start, exonState.end).toLocaleString()}`

  return (
    <div
      ref={popupRef}
      className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
      style={{
        left,
        top: safeArrowY,
        transform: 'translateY(-50%)',
        width: popupW,
        backgroundColor: 'rgba(17, 24, 39, 0.97)',
        color: '#f1f5f9',
        padding: '10px 14px',
        border: '1px solid rgba(255,255,255,0.1)',
        pointerEvents: 'none',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        zIndex: 60,
      }}
    >
      <div style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        [goLeft ? 'right' : 'left']: -arrowSize,
        width: 0,
        height: 0,
        borderTop: `${arrowSize}px solid transparent`,
        borderBottom: `${arrowSize}px solid transparent`,
        [goLeft ? 'borderLeft' : 'borderRight']: `${arrowSize}px solid rgba(17,24,39,0.97)`,
      }}>
      </div>
      <div>Exon <span style={{ fontWeight: 700 }}>{coordLabel}</span></div>
      <div>Type <span style={{ fontWeight: 700 }}>{typeLabel}</span></div>
      <div>Length <span style={{ fontWeight: 700 }}>{(exonState.length ?? Math.abs(exonState.end - exonState.start)).toLocaleString()} bp</span></div>
      <div>
        Transcripts <span style={{ fontWeight: 700 }}>{sameBoundary} of {total}</span>
        {sameState !== sameBoundary ? <span> ({sameState} same state)</span> : null}
      </div>
    </div>
  )
}

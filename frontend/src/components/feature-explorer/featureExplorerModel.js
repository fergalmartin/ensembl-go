// The Feature Explorer's model: layout and browsing constants, transcript ordering
// and default selection, transcript tags, codon intervals, exon coverage info rows,
// segment boundary matching, and colour helpers. Pure functions.
import { orientedBoundaries } from '../featureExplorerTranscriptGeometry.js'

export const BROWSER_COLORS = {
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

export const TRANSCRIPT_TRACK_ROW_HEIGHT = 42

export const TRANSCRIPT_TRACK_MIN_VIEW_SPAN_BP = 24

// How long a zoom or pan has to pause before the rows are redrawn at the new
// view. Until then the drawn rows are moved with a transform (see
// applyTranscriptViewPreview), so a gesture costs no React renders at all.
export const TRANSCRIPT_VIEW_COMMIT_IDLE_MS = 110

// Wheel zoom holds the point under the pointer where it is, the way the genome
// browser does: an exon being zoomed on stays under the cursor. (It used to be
// drawn towards the middle of the track as the view zoomed, which read as the
// exon sliding away from the pointer.)
//
// The point being zoomed on is kept while the pointer stays put, so rounding in
// each step's coordinate lookup cannot creep it along.
export const TRANSCRIPT_ZOOM_ANCHOR_MOVE_PX = 4

export const TRANSCRIPT_ZOOM_ANCHOR_IDLE_MS = 800

/**
 * The transcript track spans one gene, not a chromosome, so the genome
 * browser's rate would cross its whole zoom range in a couple of notches. These
 * are the rates this view has always used; only the formula is now shared.
 */
export const TRANSCRIPT_TRACK_BROWSING_TUNING = Object.freeze({
  zoomSensitivity: 0.00195,
  pinchSensitivity: 0.00195,
  panAmplification: 1,
  // Zooming out past the whole gene should stop, not start scrolling the page.
  // A scroll that began outside the panel still passes through (see the
  // window-capture listener on the track viewport).
  zoomAtExtentHandoff: false,
})

export const TRANSCRIPT_TRACK_BASEBLOCK_MIN_PX_PER_BP = 1.1

export const TRANSCRIPT_TRACK_BASEBLOCK_MAX_SPAN_BP = 2200

export const TRANSCRIPT_TRACK_BASEBLOCK_MAX_COUNT = 1800

export const TRANSCRIPT_TRACK_BASETEXT_MIN_PX_PER_BP = 8

export const TRANSCRIPT_TRACK_BASETEXT_MAX_COUNT = 420

// Intron bases shown either side of each exon–intron boundary once individual
// bases are drawn, so the splice sites can be read.
export const TRANSCRIPT_TRACK_INTRON_FLANK_BP = 10

// What one sequence request may cover (the backend's limit is 100 kb), and how
// far past the gene's ends to fetch so the intron flanks at its ends are there.
export const TRANSCRIPT_SEQUENCE_MAX_FETCH_BP = 99000

export const TRANSCRIPT_SEQUENCE_FLANK_BP = 200

export const FEATURE_SECTION_JUMPS = [
  { key: 'genes', label: 'Genes' },
  { key: 'transcript', label: 'Transcripts' },
  { key: 'exons', label: 'Exons' },
  { key: 'proteins', label: 'Proteins' },
  { key: 'structure', label: 'Structure' },
  { key: 'export', label: 'Export' },
]

export const SPLICE_LOCK_ICON_SIZE = 21

export const SPLICE_LOCK_GUTTER_WIDTH = 28

// The exon coverage heatmap row pinned above the transcripts. It shares the
// transcript rows' expand/collapse set under this id, which no transcript has.
export const EXON_COVERAGE_ROW_ID = '__exon_coverage__'

export const EXON_COVERAGE_ROW_LABEL = 'Exon coverage heatmap'

export const EXON_COVERAGE_LEGEND_GRADIENT = 'linear-gradient(90deg, #3b82f6 0%, #8b5cf6 33%, #f59e0b 66%, #ef4444 100%)'

export const BASE_COMPLEMENT_MAP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }

/** `top` laid over `bottom` at `alpha`, as one opaque `#rrggbb`. */
export function blendHexColor(top, bottom, alpha) {
  const a = clamp(Number(alpha) || 0, 0, 1)
  const t = parseInt(String(top || '').replace('#', ''), 16)
  const b = parseInt(String(bottom || '').replace('#', ''), 16)
  if (!Number.isFinite(t) || !Number.isFinite(b)) return top
  const mix = (shift) => Math.round((((t >> shift) & 255) * a) + (((b >> shift) & 255) * (1 - a)))
  return `#${[16, 8, 0].map((shift) => mix(shift).toString(16).padStart(2, '0')).join('')}`
}

/** Near-black or near-white, whichever reads better on a `#rrggbb` fill. */
export function readableTextOn(hex) {
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
export function positionsInRanges(ranges, from, to) {
  const out = new Set()
  for (const range of ranges) {
    const start = Math.max(from, range.start)
    const end = Math.min(to, range.end)
    for (let pos = start; pos <= end; pos += 1) out.add(pos)
  }
  return out
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function lerp(a, b, t) {
  return a + ((b - a) * t)
}

export function easeOutCubic(t) {
  const v = clamp(Number(t) || 0, 0, 1)
  return 1 - ((1 - v) ** 3)
}

export function reverseComplementSequence(sequence) {
  return String(sequence || '')
    .toUpperCase()
    .split('')
    .reverse()
    .map((base) => BASE_COMPLEMENT_MAP[base] || base)
    .join('')
}

export function formatCoord(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

export function transcriptLength(tx) {
  const start = Number(tx?.start)
  const end = Number(tx?.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, (Math.round(end) - Math.round(start)) + 1)
}

export function sortTranscripts(rawTranscripts) {
  return [...(rawTranscripts || [])].sort((a, b) => {
    const canonicalDelta = Number(Boolean(b?.is_canonical)) - Number(Boolean(a?.is_canonical))
    if (canonicalDelta !== 0) return canonicalDelta
    const startDelta = Number(a?.start || 0) - Number(b?.start || 0)
    if (startDelta !== 0) return startDelta
    return String(a?.id || '').localeCompare(String(b?.id || ''))
  })
}

export function defaultActiveTranscriptIds(orderedTranscripts) {
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

export function defaultExpandedTranscriptIds(orderedTranscripts) {
  const canonicalId = orderedTranscripts.find((tx) => Boolean(tx?.is_canonical))?.id
  return canonicalId ? [canonicalId] : []
}

export function transcriptDisplayId(rawId) {
  const text = String(rawId || '')
  if (text.length <= 26) return text
  return `${text.slice(0, 23)}...`
}

export function formatStrand(strand) {
  const s = String(strand || '')
  if (s === '+') return 'Forward'
  if (s === '-') return 'Reverse'
  return '—'
}

export function normalizeTagToken(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
}

export function displayTagLabel(normalizedTag) {
  const tag = String(normalizedTag || '')
  if (!tag) return ''
  if (tag === 'mane_select') return 'MANE select'
  if (tag === 'ensembl_canonical') return 'Ensembl canonical'
  return tag.replace(/_/g, ' ')
}

export function extractTagTokensFromString(rawValue) {
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

export function collectTranscriptTagTokens(value, collector, mode = 'generic') {
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

export function getTranscriptTagInfo(tx) {
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

export function moveId(order, sourceId, targetId, position = 'before') {
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

export function reverseComplement(seq) {
  const map = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }
  return String(seq || '')
    .toUpperCase()
    .split('')
    .reverse()
    .map((base) => map[base] || 'N')
    .join('')
}

export function getCodonIntervals(tx) {
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

export function transcriptInfoRowCount(metadata, codonStatus) {
  if (!metadata) return 0
  let rows = 2 // ID/biotype + length/exons
  if (metadata.isProteinCoding && metadata.hasCds) {
    rows += 3 // CDS/trans + CDS exons/5'UTR + 3'UTR/...
    if (!codonStatus || codonStatus.loading || codonStatus.error) rows += 1
    else rows += 2
  }
  return rows
}

export function formatPercent(fraction) {
  const value = Number(fraction)
  if (!Number.isFinite(value)) return '—'
  const pct = value * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`
}

export function formatBasesWithShare(bases, whole) {
  const b = Number(bases) || 0
  const w = Number(whole) || 0
  return `${formatCoord(b)} bp${w > 0 ? ` (${formatPercent(b / w)})` : ''}`
}

export const EXON_COVERAGE_TEXT_ROW_PX = 20

export const EXON_COVERAGE_CHART_ROW_PX = 84

/**
 * The exon coverage row's info panel, as grid rows of one or two cells. Built
 * once and used both to draw the panel and to size the row, so the two cannot
 * disagree about how tall it is. Each cell's `hint` is its hover explanation:
 * one or two short sentences on what the number is, not how to read the gene.
 */
export function exonCoverageInfoRows(stats, chrom, profile = []) {
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

export function exonCoverageInfoPanelHeight(rows) {
  return rows.reduce((sum, row) => sum + (row[0]?.height || EXON_COVERAGE_TEXT_ROW_PX), 0) + 14
}

export function transcriptInfoPanelHeight(metadata, codonStatus) {
  const rows = transcriptInfoRowCount(metadata, codonStatus)
  if (rows <= 0) return 0
  return (rows * 20) + 14
}

export function getFeatureBoundaryCoords(segment, featureType) {
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
export function boundaryEdgeCoord(coord, isFivePrime, strand) {
  const value = Number(coord)
  const onRight = strand === '-' ? isFivePrime : !isFivePrime
  return onRight ? value + 1 : value
}

export function exonKeyFromBounds(fivePrime, threePrime) {
  return `${Number(fivePrime)}:${Number(threePrime)}`
}

export function intronKeyFromBounds(threePrimeBoundary, nextFivePrimeBoundary) {
  const a = Number(threePrimeBoundary)
  const b = Number(nextFivePrimeBoundary)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  return `${Math.min(a, b)}:${Math.max(a, b)}`
}

export function segmentBoundaryMatch(segment, transcriptId, hoveredBoundaryFeature, strand) {
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

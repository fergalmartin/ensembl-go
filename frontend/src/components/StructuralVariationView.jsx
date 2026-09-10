import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'
import { resolveGenomeColor } from '../genomeColorSchemes'
import { getGenomeKey } from '../utils/genomeIdentity'
import {
  beginWheelGesture,
  findNearestScrollable,
  markWheelHandled,
  readWheelEvent,
  resolveBrowsingControls,
  resolveDragAxis,
  resolveWheelAction,
} from '../utils/browsingControls'
import {
  buildSvAuxTrackRenderWindow,
  getSvAuxTrackGeometryWidth,
  getSvAuxTrackMatrix,
  getSvAuxTrackTransform,
} from '../utils/svAuxTrackTransform'
import { resolveSvFeatureTrackGenomeIds, resolveSvFeatureWindowChrom } from '../utils/svFeatureTrackIdentity'
import {
  RULER_FONT_SIZE,
  RULER_LABEL_GAP,
  formatRulerCoord,
  rulerGeometry,
  rulerTicks,
} from './genomeBrowserRuler'
import { FONT_MONO } from '../utils/typography'
import useDelayedFlag from '../hooks/useDelayedFlag'
import {
  buildBrowserGeneSeedKey,
  buildBrowserViewportSeedKey,
  resolveAnchorRegionSeed,
  shouldSeedFromBrowser,
  shouldSeedFromBrowserViewport,
} from './svViewportSeeding'
import {
  buildAvailableSvAlignmentRows,
  buildSvGenomeOptions,
  catalogGenomeMatchesSpecies,
  formatSvGenomeOptionLabel,
  getOutgoingSvAlignments,
  getSvAlignmentsForPair,
  getSvGenomeDisplayName,
  speciesGenomeKey,
} from '../utils/svCatalog'
import {
  createSvRequestError,
  isRetryableSvRequestError,
  shouldStartSvRequest,
} from '../utils/svRequestRetry'
import FileBrowserModal from './FileBrowserModal'
import StructuralVariationFeatureBand from './StructuralVariationFeatureBand'

// Register the Beta web component (ens-sv-alignments + ens-sv-alignments-image)
import '../lib/ensembl-sv/alignments/variant-alignments.js'

// ── Layout constants ──────────────────────────────────────────────────────────
// Keep the same band + gene-track geometry as before so the genome bands
// look identical to the rest of the app.
const PLOT_PAD_X    = 2
const PLOT_PAD_Y    = 8
const REF_BAND_Y    = 6
const BAND_HEIGHT   = 30
const RULER_HEIGHT  = 18
const GENE_TRACK_HEIGHT = 14
const SEQUENCE_STRIP_HEIGHT = 16

const MIN_VIEW_SPAN = 50
const MAX_VIEW_SPAN = 50_000_000
const BUFFER_PAD_MIN    = 120_000
const BUFFER_PAD_RATIO  = 1.5
const BUFFER_MARGIN_RATIO = 0.16
const PREFETCH_DEBOUNCE_MS = 120
const WHEEL_COMMIT_DEBOUNCE_MS = 180

/**
 * Feel parameters for every pan/zoom surface in this view — the alignment
 * panel, the workspace, the gene bands, and the <ens-sv-alignments> web
 * component, which used to have its own (4x faster) zoom rate.
 */
const SV_BROWSING_TUNING = Object.freeze({
  zoomSensitivity: 0.0012,
  pinchSensitivity: 0.0016,
  panAmplification: 1.6,
  zoomAtExtentHandoff: false,
})

/**
 * Depends on the scheme id alone, never on `config` — that object gets a fresh
 * identity on every 250ms autosave, and a new controls object would re-register
 * the wheel listeners mid-gesture.
 */
function useBrowsingControls(config) {
  const schemeId = config?.browsing_control_scheme
  return useMemo(
    () => resolveBrowsingControls({ browsing_control_scheme: schemeId }, SV_BROWSING_TUNING),
    [schemeId]
  )
}
const SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS = 400
const ALIGNMENT_PANEL_HEIGHT = 168
const ALIGNMENT_PANEL_COMPACT_HEIGHT = 132
const SV_DATA_TRACK_HEIGHT = 24
const SV_DATA_TRACK_GAP = 2
const SV_DATA_TRACK_FETCH_DEBOUNCE_MS = 50
const SV_BIGBED_DETAIL_VIEWSPAN_BP = 500_000
const SV_BIGBED_DETAIL_ENTER_BP_PER_PX = 18
const SV_BIGBED_FEATURE_TILE_SPAN = 120_000
const SV_BIGBED_DETAIL_PREFETCH_RATIO = 1.25
const SV_BIGBED_DETAIL_PREFETCH_MIN_TILES = 4
const SV_BIGBED_DETAIL_FETCH_BATCH_SIZE = 24
const SV_BIGBED_DETAIL_FETCH_PER_TRACK = 12
const SV_BIGBED_BLOCK_MERGE_GAP_PX = 2
const SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE = 3000
const SV_BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD = 2500
const SV_BIGBED_MAX_FEATURE_CACHE_TILES = 3000
const SV_RIBBON_INTERVAL_MAX_VIEW_SPAN = 1_500_000
const SV_RIBBON_INTERVAL_MAX_FEATURES = 4000
const SV_RIBBON_INTERVAL_MAX_MARKS = 900
const SV_RIBBON_MAX_CACHE_TILES = 800
const SV_RIBBON_MAX_CACHE_FEATURES = 120_000
const SV_SIGNAL_TRACK_HEIGHT = 38
const SV_SIGNAL_TRACK_GAP = 2
const SV_SIGNAL_CONTROL_WIDTH = 50
const SV_SIGNAL_TOGGLE_RADIUS = 11
const SV_SIGNAL_TARGET_FETCH_BATCH_SIZE = 10
const SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE = 6
const SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE = 4
const SV_AUX_TRACK_RENDER_HALO_WINDOWS = 2
const SV_AUX_TRACK_RENDER_HALO_MAX_BP = 1_000_000
const SV_SIGNAL_RENDER_MAX_BINS = 8000
const SV_AUX_TRACK_CACHE_VERSION = 'sv-aux-20260630-1'
const SV_TRANSIENT_RETRY_LIMIT = 6
const SV_TRANSIENT_RETRY_BASE_MS = 250
const SV_SIGNAL_LOD_LEVELS = [
  { id: 'L0', minBpPerPx: 1000, bpPerBin: 10000, binsPerTile: 500 },
  { id: 'L1', minBpPerPx: 100, bpPerBin: 1000, binsPerTile: 512 },
  { id: 'L2', minBpPerPx: 10, bpPerBin: 100, binsPerTile: 512 },
  { id: 'L3', minBpPerPx: 2, bpPerBin: 10, binsPerTile: 512 },
  { id: 'L4', minBpPerPx: 0, bpPerBin: 1, binsPerTile: 1024 },
]
const SV_BIGBED_BLOCK_LEVELS = [
  { id: 'L0', minBpPerPx: 1500, tileSpanBp: 4_000_000, blockBp: 40_000 },
  { id: 'L1', minBpPerPx: 320, tileSpanBp: 800_000, blockBp: 8_000 },
  { id: 'L2', minBpPerPx: 60, tileSpanBp: 200_000, blockBp: 2_000 },
  { id: 'L3', minBpPerPx: SV_BIGBED_DETAIL_ENTER_BP_PER_PX, tileSpanBp: 80_000, blockBp: 500 },
]
const DEFAULT_SV_LOADING_MODE = 'eager'
const SV_LOADING_MODE_STORAGE_KEY = 'svLoadingMode'
let svReferenceRegionsPromise = null

const IconUpDown = ({ open, size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getSvTransientRetryDelay(attempt) {
  return Math.min(4000, SV_TRANSIENT_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)))
}

function formatCoord(value) {
  return Number(value || 0).toLocaleString()
}

function formatBp(span) {
  const n = Number(span || 0)
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mb`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kb`
  return `${Math.round(n)} bp`
}

function isLikelySequenceMetadataValue(value) {
  const text = String(value || '').trim()
  if (text.length < 28 || /\s/.test(text)) return false
  const sequenceChars = text.match(/[ACGTURYKMSWBDHVN.-]/gi)?.length || 0
  return sequenceChars / Math.max(1, text.length) >= 0.88
}

function abbreviateMetadataValue(value) {
  const text = String(value || '').trim()
  if (!text) return { display: '', full: '', abbreviated: false }
  const shouldAbbreviate = isLikelySequenceMetadataValue(text) || (text.length > 96 && !/\s/.test(text))
  if (!shouldAbbreviate) return { display: text, full: text, abbreviated: false }
  const edgeLength = text.length > 80 ? 8 : 5
  return {
    display: `${text.slice(0, edgeLength)}...${text.slice(-edgeLength)}`,
    full: text,
    abbreviated: true,
  }
}

function formatSvFeatureLocation(chrom, start, end) {
  const safeChrom = String(chrom || '').trim()
  const s = Number(start)
  const e = Number(end)
  if (!safeChrom || !Number.isFinite(s) || !Number.isFinite(e)) return ''
  const displayStart = Math.max(1, Math.floor(s) + 1)
  const displayEnd = Math.max(displayStart, Math.floor(e))
  return displayStart === displayEnd
    ? `${safeChrom}:${formatCoord(displayStart)}`
    : `${safeChrom}:${formatCoord(displayStart)}-${formatCoord(displayEnd)}`
}

function formatSvStrand(value) {
  const text = String(value || '').trim()
  if (text === '+') return '+ (forward)'
  if (text === '-') return '- (reverse)'
  if (/^(forward|reverse)$/i.test(text)) return text.toLowerCase()
  return 'Unknown'
}

function formatSvVariantType(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function formatSvBoolean(value) {
  const text = String(value || '').trim()
  if (/^(true|yes|1)$/i.test(text)) return 'Yes'
  if (/^(false|no|0)$/i.test(text)) return 'No'
  return text
}

function getSvChangedAlleleSegment(refAllele, altAllele, variantType) {
  const ref = String(refAllele || '')
  const alt = String(altAllele || '')
  const type = String(variantType || '').trim().toLowerCase()
  if (!ref || !alt) return { label: '', value: '' }

  let prefix = 0
  while (
    prefix < ref.length &&
    prefix < alt.length &&
    ref[prefix].toUpperCase() === alt[prefix].toUpperCase()
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < ref.length - prefix &&
    suffix < alt.length - prefix &&
    ref[ref.length - 1 - suffix].toUpperCase() === alt[alt.length - 1 - suffix].toUpperCase()
  ) {
    suffix += 1
  }

  const refChanged = ref.slice(prefix, ref.length - suffix)
  const altChanged = alt.slice(prefix, alt.length - suffix)
  if (type.includes('deletion') && refChanged) {
    return { label: 'Deleted sequence', value: refChanged.toUpperCase() }
  }
  if (type.includes('insertion') && altChanged) {
    return { label: 'Inserted sequence', value: altChanged.toUpperCase() }
  }
  return { label: '', value: '' }
}

function formatSvAlleleValue(value) {
  return String(value || '').trim().toUpperCase()
}

function getSvFeatureExtraMap(feature) {
  return feature?.extra_fields_map && typeof feature.extra_fields_map === 'object'
    ? feature.extra_fields_map
    : {}
}

function getSvFeatureExtraValue(extraMap, name) {
  const wanted = String(name || '').trim().toLowerCase()
  for (const [key, value] of Object.entries(extraMap || {})) {
    if (String(key || '').trim().toLowerCase() === wanted) {
      return String(value ?? '').trim()
    }
  }
  return ''
}

function isGenericBigBedFieldName(name) {
  return /^field\d+$/i.test(String(name || '').trim()) || /^extra[_\s-]?\d+$/i.test(String(name || '').trim())
}

function formatBigBedFieldLabel(name) {
  const text = String(name || '').trim()
  if (!text || isGenericBigBedFieldName(text)) return ''
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function buildCuratedSvIntervalRows(feature, context = {}) {
  const f = feature || {}
  const extrasMap = getSvFeatureExtraMap(f)
  const field5 = getSvFeatureExtraValue(extrasMap, 'field5')
  const field6 = getSvFeatureExtraValue(extrasMap, 'field6')
  const field7 = getSvFeatureExtraValue(extrasMap, 'field7')
  const field8 = getSvFeatureExtraValue(extrasMap, 'field8')
  const field10 = getSvFeatureExtraValue(extrasMap, 'field10')
  const field11 = getSvFeatureExtraValue(extrasMap, 'field11')
  const field12 = getSvFeatureExtraValue(extrasMap, 'field12')
  const looksLikeSvInterval = Boolean(field5 || field6 || field7 || field8 || field10 || field11)

  const location = formatSvFeatureLocation(context.chrom || f.chrom, f.start, f.end)
  const rows = [
    ['Track', context.trackLabel || ''],
    ['Side', context.side || ''],
    ['Location', location],
    ['Strand', formatSvStrand(f.strand)],
  ]

  if (f.has_name && String(f.name || '').trim()) {
    rows.push(['Name', String(f.name).trim()])
  }
  if (f.has_score && String(f.score ?? '').trim()) {
    rows.push(['Score', String(f.score).trim()])
  }

  if (looksLikeSvInterval) {
    const changedAllele = getSvChangedAlleleSegment(field7, field8, field6)
    rows.push(
      ['Variant key', field5],
      ['Variant type', formatSvVariantType(field6)],
      ['Reference allele', formatSvAlleleValue(field7)],
      ['Alternate allele', formatSvAlleleValue(field8)],
      [changedAllele.label, changedAllele.value],
      ['Consequence', formatSvVariantType(field10)],
      ['Length', field11],
      ['Present', formatSvBoolean(field12)],
    )
  } else {
    for (const [name, value] of Object.entries(extrasMap)) {
      const label = formatBigBedFieldLabel(name)
      const text = String(value ?? '').trim()
      if (label && text) rows.push([label, text])
    }
  }

  return rows.filter(([, value]) => String(value ?? '').trim())
}

function CopyGlyph({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="14" height="16" rx="2.2" />
      <path d="M9 3h6v4H9z" />
    </svg>
  )
}

function buildSvRuntimeEndpoint(path, alignmentId = '', outputDir = '') {
  const params = new URLSearchParams()
  if (alignmentId) params.set('alignment_id', alignmentId)
  if (outputDir) params.set('output_dir', outputDir)
  const query = params.toString()
  return query ? `${API_BASE}${path}?${query}` : `${API_BASE}${path}`
}

function sameArrayItems(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

function updateObjectSlot(prev, key, value) {
  const current = prev?.[key]
  if (current === value || sameArrayItems(current, value)) return prev
  return { ...prev, [key]: value }
}

function composeSvGenomeLabel(name, assembly) {
  const safeName = String(name || '').trim() || 'Genome'
  const safeAssembly = String(assembly || '').trim()
  if (!safeAssembly || normalizeAssemblyLabel(safeAssembly) === normalizeAssemblyLabel(safeName)) return safeName
  return `${safeName} - ${safeAssembly}`
}

function getSpeciesDisplayName(species) {
  const name = String(
    species?.display_name
    || species?.common_name
    || species?.scientific_name
    || species?.name
    || 'Genome',
  ).trim()
  const assembly = species?.assembly_name || species?.assembly || species?.gca || species?.accession || ''
  return composeSvGenomeLabel(name, assembly)
}

function getSvCatalogGenomeDisplayName(genome) {
  const name = String(
    genome?.display_name
    || genome?.common_name
    || genome?.scientific_name
    || genome?.name
    || getSvGenomeDisplayName(genome),
  ).trim()
  const assembly = genome?.assembly_name || genome?.assembly || genome?.gca || genome?.accession || ''
  return composeSvGenomeLabel(name, assembly)
}

function getSvGenomeAccessionLabel(genomeOrSpecies) {
  return String(
    genomeOrSpecies?.gca
    || genomeOrSpecies?.accession
    || genomeOrSpecies?.assembly
    || '',
  ).trim()
}

function getSvOptionTooltip(option) {
  if (!option) return ''
  const genome = option.species || option.genome || {}
  const label = option.label || getSpeciesDisplayName(option.species) || getSvCatalogGenomeDisplayName(option.genome)
  const accession = getSvGenomeAccessionLabel(genome)
  const aliases = Array.isArray(option.genome?.aliases) ? option.genome.aliases : []
  return [label, accession, ...aliases.slice(0, 4)].filter(Boolean).join(' | ')
}

function getSvRegionKey(region) {
  return String(region?.id || region?.chrom || region?.label || '').trim()
}

function compareSvRegionLabels(left, right) {
  const a = String(left || '').trim()
  const b = String(right || '').trim()
  const normalize = (value) => value.toLowerCase().replace(/^chr/, '')
  const aa = normalize(a)
  const bb = normalize(b)
  const special = { x: 23, y: 24, m: 25, mt: 25 }
  const an = /^\d+$/.test(aa) ? Number(aa) : special[aa]
  const bn = /^\d+$/.test(bb) ? Number(bb) : special[bb]
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  if (Number.isFinite(an)) return -1
  if (Number.isFinite(bn)) return 1
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** The alignment a slot should use: the one the user picked, else the first.
 *
 * A preference is dropped rather than honoured when the pair changes underneath it,
 * so switching genomes cannot leave a slot pointing at an alignment belonging to a
 * different pair.
 */
function pickPreferredSvAlignment(choices, preferredId) {
  const list = Array.isArray(choices) ? choices : []
  const preferred = String(preferredId || '')
  if (preferred) {
    const match = list.find((alignment) => String(alignment?.id || '') === preferred)
    if (match) return match
  }
  return list[0] || null
}

function alignmentSupportsAnchorRegion(alignment, regionId) {
  const wanted = String(regionId || '').trim()
  if (!wanted) return true
  return (alignment?.reference_regions || []).some((region) => getSvRegionKey(region) === wanted)
}

function svRegionsMatch(left, right) {
  const a = normalizeSvChromToken(left)
  const b = normalizeSvChromToken(right)
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

function buildSvAnchorRegionOptions(outgoingAlignments) {
  const byKey = new Map()
  for (const alignment of outgoingAlignments || []) {
    if (!alignment?.supported) continue
    for (const region of alignment.reference_regions || []) {
      const key = getSvRegionKey(region)
      if (!key) continue
      const existing = byKey.get(key) || {
        ...region,
        id: key,
        chrom: region?.chrom || key,
        label: region?.label || region?.chrom || key,
        alignmentIds: [],
      }
      existing.alignmentIds = Array.from(new Set([...(existing.alignmentIds || []), alignment.id]))
      byKey.set(key, existing)
    }
  }
  return Array.from(byKey.values()).sort((a, b) => compareSvRegionLabels(a.label || a.chrom, b.label || b.chrom))
}

function getSvRegionLength(region) {
  const indexed = Number(region?.indexed_length)
  if (Number.isFinite(indexed) && indexed > 0) return indexed
  const length = Number(region?.length || region?.end)
  if (Number.isFinite(length) && length > 0) return length
  const start = Number(region?.start)
  const end = Number(region?.end)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start
  return 0
}

function alignmentRegionForOption(alignment, option) {
  const key = getSvRegionKey(option)
  return (alignment?.reference_regions || []).find((region) => getSvRegionKey(region) === key) || null
}

function formatSvRegionAvailabilityLabel(region, outgoingAlignments) {
  const supportingAlignments = (outgoingAlignments || []).filter((alignment) => (
    alignment?.supported && alignmentRegionForOption(alignment, region)
  ))
  const targetGenomes = []
  for (const alignment of supportingAlignments) {
    const genome = alignment?.target_genome
    if (!genome) continue
    if (targetGenomes.some((existing) => catalogGenomeMatchesSpecies(existing, genome))) continue
    targetGenomes.push(genome)
  }
  const alignmentCount = supportingAlignments.length
  const genomeCount = targetGenomes.length
  const alignmentLabel = alignmentCount === 1 ? 'alignment' : 'alignments'
  const genomeLabel = genomeCount === 1 ? 'genome' : 'genomes'
  return `${alignmentCount} ${alignmentLabel}, ${genomeCount} ${genomeLabel}`
}

async function buildWindowForAnchorRegion(region, chromSizes, currentWindow, currentChromSize) {
  const rawChrom = String(region?.chrom || region?.label || region?.id || '').trim()
  if (!rawChrom) return null
  const chrom = getResolvedChromName(chromSizes || {}, rawChrom) || rawChrom
  const chromSize = getResolvedChromSize(chromSizes || {}, chrom)
    || getSvRegionLength(region)
    || (chrom === currentWindow?.chrom ? currentChromSize : null)
  const start = Number(region?.start)
  const end = Number(region?.end)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return constrainWindowToZoomLimits({ chrom, start, end }, chromSize || currentChromSize)
  }
  let next = buildRegionIdentifierWindow(chrom, chromSize)
  if (!next) {
    next = await buildRegionIdentifierWindowFromBrowseRegions(rawChrom)
  }
  return next ? constrainWindowToZoomLimits(next, chromSize || currentChromSize) : null
}

function getSvRuntimeAssembly(species) {
  return species?.assembly_name || species?.assembly || species?.gca || species?.accession || species?.key || ''
}

function buildSvGenomePayload(species, fallbackGenome = null) {
  const fallback = fallbackGenome || {}
  return {
    provider: species?.provider || fallback.provider || '',
    species_key: species?.species_key || fallback.species_key || '',
    assembly: species?.assembly || species?.gca || species?.accession || fallback.assembly || fallback.gca || fallback.accession || '',
    gca: species?.gca || fallback.gca || '',
    accession: species?.accession || species?.assembly || species?.gca || fallback.accession || fallback.assembly || fallback.gca || '',
    assembly_name: species?.assembly_name || fallback.assembly_name || fallback.display_name || '',
    scientific_name: species?.scientific_name || fallback.scientific_name || '',
    common_name: species?.common_name || fallback.common_name || '',
    display_name: species?.display_name || fallback.display_name || getSpeciesDisplayName(species) || getSvGenomeDisplayName(fallback),
    genome_key: speciesGenomeKey(species) || fallback.genome_key || fallback.id || '',
    aliases: [
      speciesGenomeKey(species),
      species?.assembly,
      species?.gca,
      species?.accession,
      species?.assembly_name,
      species?.display_name,
      ...(species?.equivalent_accessions || []),
      ...(fallback.aliases || []),
    ].filter(Boolean),
  }
}

function formatVariantTypeLabel(type) {
  if (type === 'deletion') return 'deletion'
  if (type === 'insertion') return 'insertion'
  if (type === 'snv') return 'SNV'
  return String(type || 'variant')
}

function formatVariantLocation(location, type) {
  if (!location?.region_name || !Number.isFinite(location?.start)) return ''
  const start = Number(location.start)
  const end = Number.isFinite(location?.end) ? Number(location.end) : start
  if (type === 'snv' || end <= start) {
    return `${location.region_name}:${formatCoord(start)}`
  }
  return `${location.region_name}:${formatCoord(start)}-${formatCoord(end)}`
}

function formatVariantLengthLabel(variant) {
  if (!variant) return ''
  if (variant.type === 'deletion') {
    const refLength = Math.max(1, Number(variant.ref_length) || 0)
    return `Reference length ${formatCoord(refLength)}bp`
  }
  if (variant.type === 'insertion') {
    const altLength = Math.max(1, Number(variant.alt_length) || 0)
    return `Alt allele length ${formatCoord(altLength)}bp`
  }
  return ''
}

function CenterAlignmentIcon({ className = '' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <path d="M1.6 1.6h12.8" />
      <path d="M1.6 3.7h12.8" />
      <path d="M1.6 5.8h12.8" />
      <path d="M1.6 8h12.8" />
      <path d="M1.6 10.2h12.8" />
      <path d="M1.6 12.3h12.8" />
      <path d="M1.6 14.4h12.8" />
    </svg>
  )
}

function SelectionZoomIcon({ className = '' }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
      <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
    </svg>
  )
}

function normalizeAlignmentBlock(alignment) {
  const refStart = Number(alignment?.reference?.start)
  const refLength = Number(alignment?.reference?.length)
  const altStart = Number(alignment?.alt?.start)
  const altLength = Number(alignment?.alt?.length)
  if (!Number.isFinite(refStart) || !Number.isFinite(refLength) || refLength <= 0) return null
  if (!Number.isFinite(altStart) || !Number.isFinite(altLength) || altLength <= 0) return null
  return {
    refStart,
    refEnd: refStart + refLength - 1,
    refLength,
    altStart,
    altEnd: altStart + altLength - 1,
    altLength,
    isInversion: String(alignment?.reference?.strand || '+') !== String(alignment?.alt?.strand || '+'),
  }
}

function svBlocksToFeatureBandAlignments(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .map((block) => {
      const refStart = Number(block?.ref_start ?? NaN)
      const refEnd = Number(block?.ref_end ?? NaN)
      const altStart = Number(block?.tgt_start ?? NaN)
      const altEnd = Number(block?.tgt_end ?? NaN)
      if (
        !Number.isFinite(refStart) ||
        !Number.isFinite(refEnd) ||
        !Number.isFinite(altStart) ||
        !Number.isFinite(altEnd)
      ) {
        return null
      }
      const refLo = Math.min(refStart, refEnd)
      const refHi = Math.max(refStart, refEnd)
      const altLo = Math.min(altStart, altEnd)
      const altHi = Math.max(altStart, altEnd)
      return {
        id: String(block?.chain_id || `${refLo}:${altLo}`),
        type: block?.type || 'match',
        reference: {
          start: refLo,
          length: Math.max(1, refHi - refLo),
          strand: 'forward',
        },
        alt: {
          start: altLo,
          length: Math.max(1, altHi - altLo),
          strand: String(block?.strand || '+') === '-' ? 'reverse' : 'forward',
        },
      }
    })
    .filter(Boolean)
}

function inferLargestInversionRegion(alignments) {
  const blocks = alignments
    .map(normalizeAlignmentBlock)
    .filter(Boolean)
    .sort((a, b) => a.refStart - b.refStart || a.refEnd - b.refEnd)

  if (!blocks.some((block) => block.isInversion)) return null

  const clusters = []

  let current = null
  for (const block of blocks) {
    if (block.isInversion && !current) {
      current = {
        refStart: block.refStart,
        refEnd: block.refEnd,
        totalInversionSpan: block.refLength,
        maxBlockSpan: block.refLength,
        barrierMatchSpan: 0,
      }
      continue
    }

    if (!current) {
      continue
    }

    if (!block.isInversion) {
      current.barrierMatchSpan = Math.max(current.barrierMatchSpan, block.refLength)
      continue
    }

    const clusterSpan = Math.max(1, current.refEnd - current.refStart + 1)
    const gap = Math.max(0, block.refStart - current.refEnd - 1)
    const mergeGapLimit = Math.max(60_000, Math.round(Math.max(clusterSpan, block.refLength, current.maxBlockSpan) * 0.35))
    const significantMatchSpan = Math.max(25_000, Math.round(Math.max(clusterSpan, block.refLength, current.maxBlockSpan) * 0.18))

    if (gap <= mergeGapLimit && current.barrierMatchSpan < significantMatchSpan) {
      current.refStart = Math.min(current.refStart, block.refStart)
      current.refEnd = Math.max(current.refEnd, block.refEnd)
      current.totalInversionSpan += block.refLength
      current.maxBlockSpan = Math.max(current.maxBlockSpan, block.refLength)
      current.barrierMatchSpan = 0
      continue
    }

    current.barrierMatchSpan = 0
    clusters.push(current)
    current = {
      refStart: block.refStart,
      refEnd: block.refEnd,
      totalInversionSpan: block.refLength,
      maxBlockSpan: block.refLength,
      barrierMatchSpan: 0,
    }
  }

  if (current) {
    clusters.push(current)
  }

  return clusters.sort((a, b) => {
    const spanDiff = (b.refEnd - b.refStart) - (a.refEnd - a.refStart)
    if (spanDiff !== 0) return spanDiff
    return b.totalInversionSpan - a.totalInversionSpan
  })[0] || null
}

function buildCenteredTargetWindow(refWindow, currentTgtWindow, alignments, tgtChromSize = null) {
  if (!refWindow?.chrom || !currentTgtWindow?.chrom || !alignments?.length) return null

  const refCenter = refWindow.start + ((refWindow.end - refWindow.start) / 2)
  const tgtCenter = currentTgtWindow.start + ((currentTgtWindow.end - currentTgtWindow.start) / 2)

  let bestMatchAlignment = null
  let bestMatchScore = Infinity
  let bestAlignment = null
  let bestScore = Infinity

  for (const alignment of alignments) {
    const block = normalizeAlignmentBlock(alignment)
    if (!block) continue

    const refDistance = refCenter < block.refStart
      ? block.refStart - refCenter
      : refCenter > block.refEnd
        ? refCenter - block.refEnd
        : 0
    const altMidpoint = (block.altStart + block.altEnd) / 2
    const tieBreaker = Math.abs(altMidpoint - tgtCenter) / 1_000_000
    const score = refDistance + tieBreaker

    if (score < bestScore) {
      bestScore = score
      bestAlignment = block
    }

    if (!block.isInversion && score < bestMatchScore) {
      bestMatchScore = score
      bestMatchAlignment = block
    }
  }

  const anchorAlignment = bestMatchAlignment || bestAlignment
  if (!anchorAlignment) return null

  const refAnchor = clamp(refCenter, anchorAlignment.refStart, anchorAlignment.refEnd)
  const fraction = anchorAlignment.refEnd > anchorAlignment.refStart
    ? (refAnchor - anchorAlignment.refStart) / (anchorAlignment.refEnd - anchorAlignment.refStart)
    : 0.5
  const altAnchor = anchorAlignment.isInversion
    ? anchorAlignment.altEnd - (fraction * (anchorAlignment.altEnd - anchorAlignment.altStart))
    : anchorAlignment.altStart + (fraction * (anchorAlignment.altEnd - anchorAlignment.altStart))

  return centerWindowOnRange(
    currentTgtWindow.chrom,
    altAnchor,
    Math.max(1, refWindow.end - refWindow.start),
    tgtChromSize,
    1,
  )
}

function getVariantFromEvent(event) {
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : []
  const node = path.find((entry) => entry?.dataset?.featureType === 'variant')
  if (!node?.dataset) return null
  const dataset = node.dataset
  return {
    name: dataset.name || '',
    type: dataset.variantType || 'variant',
    location: {
      region_name: dataset.variantRegionName || '',
      start: Number(dataset.variantStart) || 0,
      end: Number(dataset.variantEnd) || 0,
    },
    ref_length: Number(dataset.variantRefLength) || 0,
    alt_length: Number(dataset.variantAltLength) || 0,
  }
}

function normalizeAssemblyLabel(value) {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const SUPPORTED_SV_REF_GRCH38_ALIASES = [
  'grch38',
  'grch38p14',
  'gca00000140529',
  'gcf00000140540',
]

const SUPPORTED_SV_REF_CHM13_ALIASES = [
  'chm13',
  't2tchm13',
  't2tchm13v2',
  't2tchm13v20',
  'gca0099147554',
  'gcf0099147551',
]

const SUPPORTED_SV_TGT_HG00438_ALIASES = [
  'hg00438',
  'hg00438pathprcf2',
  'gca0184725952',
]

const SUPPORTED_SV_TGT_HG00733_ALIASES = [
  'hg007332',
  'hg00733mat',
  'hg00733mathprcf2',
  'gca0185069752',
  'gca0185069753',
  '0fb76cdf6c6b4c20beef7f7d4151651b',
]

const SUPPORTED_SV_TRIO_REF_CHROMS = new Set([
  '2',
  '5',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '16',
  '17',
  '18',
  '19',
  '20',
  'X',
])
const SV_TRIO_DEFAULT_REF_WINDOW = {
  chrom: '11',
  start: 49_490_090,
  end: 49_945_992,
}

function normalizeSvChromToken(value) {
  return String(value || '').replace(/^chr/i, '')
}

function isSupportedSvTrioRefChrom(chrom) {
  return SUPPORTED_SV_TRIO_REF_CHROMS.has(normalizeSvChromToken(chrom))
}

function transformOuterWindowFromReferenceChange(currentRefWindow, nextRefWindow, currentOuterWindow, outerChromSize) {
  if (!currentRefWindow || !nextRefWindow || !currentOuterWindow) return currentOuterWindow
  const currentRefSpan = Math.max(1, Number(currentRefWindow.end) - Number(currentRefWindow.start))
  const nextRefSpan = Math.max(1, Number(nextRefWindow.end) - Number(nextRefWindow.start))
  const currentOuterSpan = Math.max(1, Number(currentOuterWindow.end) - Number(currentOuterWindow.start))
  const spanRatio = nextRefSpan / currentRefSpan

  if (!Number.isFinite(spanRatio) || spanRatio <= 0) return currentOuterWindow

  if (Math.abs(spanRatio - 1) < 0.0001) {
    const shift = Number(nextRefWindow.start) - Number(currentRefWindow.start)
    return constrainWindowToZoomLimits({
      chrom: currentOuterWindow.chrom,
      start: Math.round(Number(currentOuterWindow.start) + shift),
      end: Math.round(Number(currentOuterWindow.end) + shift),
    }, outerChromSize)
  }

  const denominator = currentRefSpan - nextRefSpan
  const anchorFraction = denominator
    ? clamp((Number(nextRefWindow.start) - Number(currentRefWindow.start)) / denominator, 0, 1)
    : 0.5
  const nextOuterSpan = Math.max(MIN_VIEW_SPAN, Math.round(currentOuterSpan * spanRatio))
  const outerAnchor = Number(currentOuterWindow.start) + (currentOuterSpan * anchorFraction)
  const nextOuterStart = Math.round(outerAnchor - (nextOuterSpan * anchorFraction))
  return constrainWindowToZoomLimits({
    chrom: currentOuterWindow.chrom,
    start: nextOuterStart,
    end: nextOuterStart + nextOuterSpan,
  }, outerChromSize)
}

function collectSvGenomeTokens(species) {
  if (!species) return []
  const rawValues = [
    species?.assembly_name,
    species?.assembly,
    species?.gca,
    species?.accession,
    species?.name,
    species?.key,
  ]
  const tokens = []
  for (const value of rawValues) {
    const normalized = normalizeAssemblyLabel(value)
    if (!normalized || tokens.includes(normalized)) continue
    tokens.push(normalized)
  }
  return tokens
}

function supportsSvAlias(tokens, aliases) {
  return aliases.some((alias) => tokens.some((token) => token.includes(alias)))
}

function isSupportedSvPairSpecies(refSpecies, tgtSpecies) {
  const refTokens = collectSvGenomeTokens(refSpecies)
  const tgtTokens = collectSvGenomeTokens(tgtSpecies)
  const isGrch38 = supportsSvAlias(refTokens, SUPPORTED_SV_REF_GRCH38_ALIASES)
  const isChm13 = supportsSvAlias(refTokens, SUPPORTED_SV_REF_CHM13_ALIASES)
  const isHg00438 = supportsSvAlias(tgtTokens, SUPPORTED_SV_TGT_HG00438_ALIASES)
  const isHg00733 = supportsSvAlias(tgtTokens, SUPPORTED_SV_TGT_HG00733_ALIASES)
  return (isGrch38 && (isHg00438 || isHg00733)) || (isChm13 && isHg00438)
}

function isSupportedSvTrioSpecies(refSpecies, tgtSpecies, thirdSpecies) {
  if (!refSpecies || !tgtSpecies || !thirdSpecies) return false
  const refTokens = collectSvGenomeTokens(refSpecies)
  const topTokens = collectSvGenomeTokens(tgtSpecies)
  const bottomTokens = collectSvGenomeTokens(thirdSpecies)
  return supportsSvAlias(refTokens, SUPPORTED_SV_REF_GRCH38_ALIASES)
    && supportsSvAlias(topTokens, SUPPORTED_SV_TGT_HG00438_ALIASES)
    && supportsSvAlias(bottomTokens, SUPPORTED_SV_TGT_HG00733_ALIASES)
}

function quantizeFloor(value, step) {
  const s = Math.max(1, Math.round(step))
  return Math.floor(value / s) * s
}

function quantizeCeil(value, step) {
  const s = Math.max(1, Math.round(step))
  return Math.ceil(value / s) * s
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aEnd >= bStart && aStart <= bEnd
}

function parseRegionInput(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const cleaned = raw.replace(/\s+/g, '')
  const match = cleaned.match(/^([^:]+):([\d,]+)-([\d,]+)$/)
  if (!match) return cleaned ? { chrom: cleaned, bareChrom: true } : null
  const chrom = String(match[1] || '').trim()
  const start = Number(String(match[2] || '').replace(/,/g, ''))
  const end = Number(String(match[3] || '').replace(/,/g, ''))
  if (!chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { chrom, start, end }
}

function isFetchNetworkError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('failed to fetch') || message.includes('networkerror')
}

function buildRegionIdentifierWindow(chrom, chromSize, maxSpan = 1_000_000) {
  const resolvedChrom = String(chrom || '').trim()
  const length = Math.floor(Number(chromSize) || 0)
  if (!resolvedChrom || length <= 0) return null
  if (length <= maxSpan) {
    return { chrom: resolvedChrom, start: 1, end: Math.max(2, length) }
  }
  const span = Math.min(maxSpan, length)
  const center = Math.max(1 + span / 2, Math.min(length - span / 2, length / 3))
  const start = Math.max(1, Math.round(center - span / 2))
  const end = Math.min(length, start + span)
  return { chrom: resolvedChrom, start, end: Math.max(start + 1, end) }
}

function shiftWindow(window, deltaBp, minStart = 1) {
  if (!window) return null
  const span = Math.max(1, (window.end || 0) - (window.start || 0))
  let start = Math.round((window.start || 0) + (deltaBp || 0))
  if (start < minStart) start = minStart
  return { ...window, start, end: start + span }
}

function getMaxAllowedSpan(chromSize = null, minStart = 1) {
  if (Number.isFinite(chromSize) && chromSize > minStart) {
    return Math.min(MAX_VIEW_SPAN, Math.max(MIN_VIEW_SPAN, Math.round(chromSize) - minStart))
  }
  return MAX_VIEW_SPAN
}

function zoomWindowAround(window, factor, anchorFraction = 0.5, minStart = 1, chromSize = null) {
  if (!window) return null
  const span = Math.max(1, (window.end || 0) - (window.start || 0))
  const frac = clamp(anchorFraction, 0, 1)
  const maxSpan = getMaxAllowedSpan(chromSize, minStart)
  const nextSpan = Math.round(clamp(span * factor, MIN_VIEW_SPAN, maxSpan))
  const anchorBp = (window.start || 0) + (span * frac)
  let start = Math.round(anchorBp - (nextSpan * frac))
  if (start < minStart) start = minStart
  let end = start + nextSpan
  if (Number.isFinite(chromSize) && chromSize > minStart && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - nextSpan)
  }
  return { ...window, start, end }
}

function panWindowByPixels(window, deltaPx, viewportWidth, minStart = 1, chromSize = null) {
  if (!window || !Number.isFinite(deltaPx)) return window
  const width = Math.max(1, Math.round(viewportWidth || 0))
  const span = Math.max(1, (window.end || 0) - (window.start || 0))
  const bpPerPx = span / width
  let start = Math.round((window.start || 0) + (deltaPx * bpPerPx))
  if (start < minStart) start = minStart
  let end = start + span
  if (Number.isFinite(chromSize) && chromSize > minStart && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - span)
  }
  return { ...window, start, end }
}

function centerWindowOnRange(chrom, center, span, chromSize = null, minStart = 1) {
  if (!chrom || !Number.isFinite(center) || !Number.isFinite(span) || span <= 0) return null
  const windowSpan = Math.round(clamp(span, MIN_VIEW_SPAN, getMaxAllowedSpan(chromSize, minStart)))
  let start = Math.round(center - (windowSpan / 2))
  if (start < minStart) start = minStart
  let end = start + windowSpan
  if (Number.isFinite(chromSize) && chromSize > 0 && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - windowSpan)
  }
  return { chrom, start, end }
}

function withWindowChrom(window, fallbackChrom = '') {
  if (!window) return null
  const minStart = 1
  const normalizedStart = Math.max(minStart, Number(window.start) || minStart)
  const normalizedEnd = Math.max(normalizedStart + 1, Number(window.end) || (normalizedStart + 1))
  if (window.chrom) {
    return {
      ...window,
      start: normalizedStart,
      end: normalizedEnd,
    }
  }
  return {
    ...window,
    chrom: fallbackChrom || '',
    start: normalizedStart,
    end: normalizedEnd,
  }
}

function getResolvedChromSize(chromSizes, chrom) {
  if (!chromSizes || !chrom) return null
  if (chromSizes[chrom]) return Number(chromSizes[chrom]) || null

  const raw = String(chrom).trim()
  if (!raw) return null
  const canonical = raw.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`

  for (const [key, value] of Object.entries(chromSizes)) {
    const resolved = String(key || '').trim().toLowerCase()
    if (!resolved) continue
    const resolvedStrip = resolved.startsWith('chr') ? resolved.slice(3) : resolved
    if (resolved === canonical || resolved === stripChr || resolved === addChr || resolvedStrip === stripChr) {
      return Number(value) || null
    }
  }

  return null
}

function getResolvedChromName(chromSizes, chrom) {
  if (!chromSizes || !chrom) return ''
  if (Object.prototype.hasOwnProperty.call(chromSizes, chrom)) return chrom

  const raw = String(chrom).trim()
  if (!raw) return ''
  const canonical = raw.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`

  for (const key of Object.keys(chromSizes)) {
    const resolved = String(key || '').trim().toLowerCase()
    if (!resolved) continue
    const resolvedStrip = resolved.startsWith('chr') ? resolved.slice(3) : resolved
    if (resolved === canonical || resolved === stripChr || resolved === addChr || resolvedStrip === stripChr) {
      return String(key)
    }
  }

  return raw
}

function tokenVariants(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return new Set()
  const out = new Set([text])
  if (text.startsWith('chr') && text.length > 3) out.add(text.slice(3))
  else out.add(`chr${text}`)
  if (['m', 'mt', 'chrm', 'chrmt'].includes(text)) {
    out.add('m')
    out.add('mt')
    out.add('chrm')
    out.add('chrmt')
  }
  return out
}

function intersectsTokenSet(left, right) {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function resolveRegionFromBrowseRegions(regions, rawChrom) {
  const token = String(rawChrom || '').trim()
  if (!token || !Array.isArray(regions)) return null
  const canonical = token.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`
  let region = regions.find((r) => r.chrom === token)
  if (region) return region

  region = regions.find((r) => {
    const rc = String(r.chrom || '').toLowerCase()
    if (rc === canonical || rc === stripChr || rc === addChr) return true
    const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
    return rcStrip === stripChr
  })
  if (region) return region

  const queryTokens = tokenVariants(token)
  const synonymCandidates = regions.filter((r) => {
    const regionTokens = tokenVariants(r.chrom)
    if (intersectsTokenSet(queryTokens, regionTokens)) return true
    const synonyms = Array.isArray(r.synonyms) ? r.synonyms : []
    return synonyms.some((synonym) => intersectsTokenSet(queryTokens, tokenVariants(synonym)))
  })
  if (synonymCandidates.length === 1) return synonymCandidates[0]

  if (['m', 'mt', 'chrm', 'chrmt'].includes(canonical)) {
    return regions.find((r) => {
      const rc = String(r.chrom || '').toLowerCase()
      const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
      return rc === 'mt' || rc === 'm' || rc === 'chrm' || rc === 'chrmt' || rcStrip === 'mt' || rcStrip === 'm'
    }) || null
  }

  return null
}

async function fetchSvReferenceRegions() {
  if (!svReferenceRegionsPromise) {
    svReferenceRegionsPromise = fetch(`${API_BASE}/api/browse/regions?genome=reference`)
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => [])
  }
  return svReferenceRegionsPromise
}

async function buildRegionIdentifierWindowFromBrowseRegions(chrom) {
  const regions = await fetchSvReferenceRegions()
  const region = resolveRegionFromBrowseRegions(regions, chrom)
  return buildRegionIdentifierWindow(region?.chrom, region?.end)
}

function getWindowKey(window) {
  if (!window?.chrom) return ''
  return `${window.chrom}:${window.start}-${window.end}`
}

function getSvDataTrackKey(track) {
  return String(track?.id || `${track?.side || ''}:${track?.type || ''}:${track?.path || ''}`).trim()
}

function getSvDataTrackLabel(track) {
  const label = String(track?.label || '').trim()
  if (label) return label
  return 'SV intervals'
}

function getSvDataTracksForSide(bufferData, side) {
  const tracks = bufferData?.tracks?.[side]
  if (!Array.isArray(tracks)) return []
  return tracks.filter((track) => {
    const type = String(track?.type || '').toLowerCase()
    return track?.path && type === 'bigbed'
  })
}

function getSvSignalTracksForSide(bufferData, side) {
  const tracks = bufferData?.tracks?.[side]
  if (!Array.isArray(tracks)) return []
  return tracks.filter((track) => {
    const type = String(track?.type || '').toLowerCase()
    return track?.path && type === 'bigwig'
  })
}

function svBigBedTrackColor(span, isLight) {
  const hint = String(span?.color_hint || span?.itemRgb || span?.color || '').trim()
  if (/^\d+,\d+,\d+$/.test(hint)) return `rgb(${hint})`
  return isLight ? 'rgba(5, 150, 105, 0.74)' : 'rgba(52, 211, 153, 0.68)'
}

function svBigBedFeatureKey(feature) {
  const start = Number(feature?.start) || 0
  const end = Number(feature?.end) || 0
  const name = String(feature?.name || '')
  const strand = String(feature?.strand || '.')
  const score = String(feature?.score ?? '')
  const color = String(feature?.itemRgb || feature?.color || '')
  const blockCount = String(feature?.block_count ?? '')
  const blockSizes = String(feature?.block_sizes || '')
  const blockStarts = String(feature?.block_starts || '')
  const renderKind = String(feature?.render_kind || feature?._render_kind || '')
  return `${start}|${end}|${name}|${strand}|${score}|${color}|${blockCount}|${blockSizes}|${blockStarts}|${renderKind}`
}

function svNormalizeBigBedFeature(feature) {
  if (!feature || typeof feature !== 'object') return null
  const start = Number(feature?.start)
  const end = Number(feature?.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  const exonBlocks = Array.isArray(feature?.exon_blocks) ? feature.exon_blocks : []
  const cdsBlocks = Array.isArray(feature?.cds_blocks) ? feature.cds_blocks : []
  const renderKind = String(feature?.render_kind || '').trim().toLowerCase() || 'interval'
  return {
    ...feature,
    start,
    end,
    _key: svBigBedFeatureKey(feature),
    _render_kind: renderKind,
    _structure_valid: feature?.structure_valid === true,
    _exon_blocks: exonBlocks,
    _cds_blocks: cdsBlocks,
  }
}

function svBigBedBlockTileKey(trackId, chrom, levelId, tileStart, tileEnd) {
  return `${SV_AUX_TRACK_CACHE_VERSION}:svbbblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
}

function svBigBedFeatureTileKey(trackId, chrom, tileStart, tileEnd) {
  return `${SV_AUX_TRACK_CACHE_VERSION}:svbbft:${trackId}|${chrom}|${tileStart}|${tileEnd}`
}

function getSvBigBedBlockLevel(bpPerPx) {
  for (let i = 0; i < SV_BIGBED_BLOCK_LEVELS.length; i += 1) {
    if (bpPerPx >= SV_BIGBED_BLOCK_LEVELS[i].minBpPerPx) return SV_BIGBED_BLOCK_LEVELS[i]
  }
  return SV_BIGBED_BLOCK_LEVELS[SV_BIGBED_BLOCK_LEVELS.length - 1]
}

function getSvBigBedLodMode(trackId, bpPerPx, detailEntryBpPerPx, lodStateRef) {
  const prev = lodStateRef.current[trackId]
  const entry = Number.isFinite(detailEntryBpPerPx) && detailEntryBpPerPx > 0
    ? detailEntryBpPerPx
    : SV_BIGBED_DETAIL_ENTER_BP_PER_PX
  let next = bpPerPx <= entry ? 'detail' : 'blocks'
  if (prev === 'detail') {
    next = bpPerPx <= (entry * 1.2) ? 'detail' : 'blocks'
  } else if (prev === 'blocks') {
    next = bpPerPx < (entry * 0.9) ? 'detail' : 'blocks'
  }
  lodStateRef.current[trackId] = next
  return next
}

function projectSvBigBedBlockTiles(cache, trackId, chrom, level, visStart, visEnd, innerWidthPx) {
  const tileSpan = level.tileSpanBp
  const firstTile = Math.floor(visStart / tileSpan) * tileSpan
  const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
  const spans = []
  let expectedTiles = 0
  let fetchedTiles = 0
  let bestError = ''

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tileEnd = tileStart + tileSpan
    expectedTiles += 1
    const tile = cache.get(svBigBedBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd))
    if (!tile) continue
    fetchedTiles += 1
    if (tile?.error && !bestError) bestError = String(tile.error)
    const rows = Array.isArray(tile?.block_spans) ? tile.block_spans : []
    for (const row of rows) {
      const s = Number(row?.start)
      const e = Number(row?.end)
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
      if (e <= visStart || s >= visEnd) continue
      spans.push({
        start: Math.max(visStart, s),
        end: Math.min(visEnd, e),
        feature_count: Math.max(0, Number(row?.feature_count || 0)),
        max_score: Math.max(0, Number(row?.max_score || 0)),
        color_hint: String(row?.color_hint || ''),
      })
    }
  }

  spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
  const merged = []
  const viewSpan = Math.max(1, visEnd - visStart)
  const gapBp = SV_BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx))
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= (last.end + gapBp)) {
      last.end = Math.max(last.end, span.end)
      last.feature_count = Math.max(last.feature_count, span.feature_count)
      if (span.max_score >= last.max_score) {
        last.max_score = span.max_score
        if (span.color_hint) last.color_hint = span.color_hint
      }
    } else {
      merged.push({ ...span })
    }
  }

  let coveredBp = 0
  for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
  const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
  return {
    mode: 'bigbed_blocks',
    level: level.id,
    start: visStart,
    end: visEnd,
    block_spans: merged,
    has_data: merged.length > 0,
    coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
    tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
    error: bestError,
  }
}

function projectSvBigBedFeatureTiles(cache, layoutStateRef, trackId, chrom, visStart, visEnd, innerWidthPx) {
  const tileSpan = SV_BIGBED_FEATURE_TILE_SPAN
  const viewSpan = Math.max(1, visEnd - visStart)
  const layoutBuffer = clamp(viewSpan * 0.5, 80_000, 500_000)
  const bucketStep = Math.max(25_000, Math.floor(viewSpan * 0.25))
  const center = (visStart + visEnd) / 2
  const centerBucket = Math.floor(center / bucketStep)
  const spanBucket = Math.max(1, Math.round(Math.log2(Math.max(1, viewSpan)) * 8))
  const priorLayout = layoutStateRef.current[trackId]
  let layoutStart
  let layoutEnd
  if (
    priorLayout
    && priorLayout.chrom === chrom
    && priorLayout.centerBucket === centerBucket
    && priorLayout.spanBucket === spanBucket
  ) {
    layoutStart = Number(priorLayout.layoutStart)
    layoutEnd = Number(priorLayout.layoutEnd)
  } else {
    const bucketCenter = centerBucket * bucketStep + (bucketStep / 2)
    const half = (viewSpan / 2) + layoutBuffer
    layoutStart = Math.max(0, Math.floor(bucketCenter - half))
    layoutEnd = Math.max(layoutStart + 1, Math.ceil(bucketCenter + half))
    layoutStateRef.current[trackId] = { chrom, centerBucket, spanBucket, layoutStart, layoutEnd }
  }

  const firstTile = Math.floor(layoutStart / tileSpan) * tileSpan
  const lastTile = Math.floor((layoutEnd - 1) / tileSpan) * tileSpan
  const dedup = new Map()
  let expectedTiles = 0
  let fetchedTiles = 0
  let bestError = ''
  const coverageSpans = []

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tileEnd = tileStart + tileSpan
    expectedTiles += 1
    const tile = cache.get(svBigBedFeatureTileKey(trackId, chrom, tileStart, tileEnd))
    if (!tile) continue
    fetchedTiles += 1
    if (tile?.error && !bestError) bestError = String(tile.error)
    const tStart = Number(tile?.start)
    const tEnd = Number(tile?.end)
    if (Number.isFinite(tStart) && Number.isFinite(tEnd) && tEnd > tStart) {
      coverageSpans.push([Math.max(visStart, tStart), Math.min(visEnd, tEnd)])
    }
    const rows = Array.isArray(tile?.features) ? tile.features : []
    for (const row of rows) {
      const normalized = svNormalizeBigBedFeature(row)
      if (!normalized) continue
      if (normalized.end <= layoutStart || normalized.start >= layoutEnd) continue
      const key = normalized._key || svBigBedFeatureKey(normalized)
      if (dedup.has(key)) continue
      dedup.set(key, { ...normalized, _key: key })
    }
  }

  const features = Array.from(dedup.values()).sort((a, b) => (
    (a.start - b.start)
    || (a.end - b.end)
    || String(a?.name || '').localeCompare(String(b?.name || ''))
    || String(a?._key || '').localeCompare(String(b?._key || ''))
  ))
  const visibleSource = features.filter((feature) => feature.end > visStart && feature.start < visEnd)
  const transcriptFeatureCount = features.reduce((acc, feature) => {
    const isTranscript = feature?._render_kind === 'transcript'
      && feature?._structure_valid === true
      && Array.isArray(feature?._exon_blocks)
      && feature._exon_blocks.length > 0
    return acc + (isTranscript ? 1 : 0)
  }, 0)
  const shouldDenseFallback = (
    visibleSource.length > SV_BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD
    && transcriptFeatureCount === 0
    && viewSpan > 100_000
  )
  if (shouldDenseFallback) {
    const denseSpans = visibleSource.map((feature) => ({
      start: Math.max(visStart, Number(feature?.start) || 0),
      end: Math.min(visEnd, Number(feature?.end) || 0),
      feature_count: 1,
      max_score: Math.max(0, Number(feature?.score || 0)),
      color_hint: String(feature?.itemRgb || feature?.color || ''),
    })).filter((span) => span.end > span.start)
    denseSpans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
    const merged = []
    const gapBp = SV_BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx || 1))
    for (const span of denseSpans) {
      const last = merged[merged.length - 1]
      if (last && span.start <= (last.end + gapBp)) {
        last.end = Math.max(last.end, span.end)
        last.feature_count += 1
        if (span.max_score >= last.max_score) {
          last.max_score = span.max_score
          if (span.color_hint) last.color_hint = span.color_hint
        }
      } else {
        merged.push({ ...span })
      }
    }
    let coveredBp = 0
    for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
    const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
    return {
      mode: 'bigbed_blocks',
      level: 'dense_fallback',
      start: visStart,
      end: visEnd,
      block_spans: merged,
      has_data: merged.length > 0,
      coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
      tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
      error: bestError,
      dense_fallback: true,
    }
  }

  coverageSpans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  let coveredBp = 0
  if (coverageSpans.length > 0) {
    let [curS, curE] = coverageSpans[0]
    for (let i = 1; i < coverageSpans.length; i += 1) {
      const [s, e] = coverageSpans[i]
      if (s <= curE) curE = Math.max(curE, e)
      else {
        coveredBp += Math.max(0, curE - curS)
        curS = s
        curE = e
      }
    }
    coveredBp += Math.max(0, curE - curS)
  }

  const visibleFeatures = visibleSource
  const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
  return {
    mode: 'bigbed_detail',
    start: visStart,
    end: visEnd,
    features: visibleFeatures,
    has_data: visibleFeatures.length > 0,
    coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
    tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
    error: bestError,
  }
}

function shouldKeepPreviousSvBigBedData(previous, projected) {
  if (!previous || !projected) return false
  if (projected.mode === 'bigbed_blocks') {
    const previousSpans = Array.isArray(previous?.block_spans) ? previous.block_spans : []
    const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
    return previousSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)
  }
  if (projected.mode === 'bigbed_detail') {
    const previousCount = Array.isArray(previous?.features) ? previous.features.length : 0
    const nextCount = Array.isArray(projected?.features) ? projected.features.length : 0
    return previousCount > 0 && nextCount === 0 && Number(projected?.tile_coverage || 0) < 0.4
  }
  return false
}

function mergeSvProjectedTrackData(previousData, projectedData) {
  const nextData = { ...(previousData || {}) }
  for (const [trackKey, projected] of Object.entries(projectedData || {})) {
    if (shouldKeepPreviousSvBigBedData(previousData?.[trackKey], projected)) continue
    nextData[trackKey] = projected
  }
  return nextData
}

function selectSvFetchPlansFairly(plans, maxTotal, maxPerGroup = maxTotal) {
  if (!Array.isArray(plans) || plans.length === 0 || maxTotal <= 0) return []
  const queues = new Map()
  for (const plan of plans) {
    const groupKey = String(plan?.trackKey || plan?.tileKey || '')
    if (!queues.has(groupKey)) queues.set(groupKey, [])
    queues.get(groupKey).push(plan)
  }

  const selected = []
  const selectedPerGroup = new Map()
  let madeProgress = true
  while (selected.length < maxTotal && madeProgress) {
    madeProgress = false
    for (const [groupKey, queue] of queues.entries()) {
      if (selected.length >= maxTotal) break
      const groupCount = selectedPerGroup.get(groupKey) || 0
      if (groupCount >= maxPerGroup || queue.length === 0) continue
      selected.push(queue.shift())
      selectedPerGroup.set(groupKey, groupCount + 1)
      madeProgress = true
    }
  }
  return selected
}

function getSvSignalLevel(bpPerPx) {
  for (const level of SV_SIGNAL_LOD_LEVELS) {
    if (bpPerPx >= level.minBpPerPx) return level
  }
  return SV_SIGNAL_LOD_LEVELS[SV_SIGNAL_LOD_LEVELS.length - 1]
}

function svSignalTileKey(trackId, chrom, levelId, tileStart) {
  return `${SV_AUX_TRACK_CACHE_VERSION}:svsig:${trackId}|${chrom}|${levelId}|${tileStart}`
}

function projectSvSignalTiles(cache, trackId, chrom, level, visStart, visEnd, outBins) {
  const empty = { bins: Array(outBins).fill(null), populated: new Uint8Array(outBins), has_data: false, min: null, max: null, coverage: 0, error: '' }
  if (!chrom || visEnd <= visStart || outBins <= 0) return empty
  const visSpan = Math.max(1, visEnd - visStart)
  const tileSpan = level.bpPerBin * level.binsPerTile
  const firstTile = Math.floor(visStart / tileSpan) * tileSpan
  const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
  const out = Array(outBins).fill(null)
  const populated = new Uint8Array(outBins)
  let hasData = false
  let bestError = ''

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tile = cache.get(svSignalTileKey(trackId, chrom, level.id, tileStart))
    if (!tile) continue
    if (tile?.error && !bestError) bestError = String(tile.error)
    const bins = Array.isArray(tile?.bins) ? tile.bins : []
    const bpPerBin = Math.max(1, Number(tile?.bpPerBin || level.bpPerBin))
    for (let i = 0; i < bins.length; i += 1) {
      const gStart = Number(tile.start || tileStart) + i * bpPerBin
      const gEnd = gStart + bpPerBin
      if (gEnd < visStart || gStart > visEnd) continue
      let x1 = Math.floor(((gStart - visStart) / visSpan) * outBins)
      let x2 = Math.ceil(((gEnd - visStart) / visSpan) * outBins)
      x1 = Math.max(0, Math.min(outBins - 1, x1))
      x2 = Math.max(x1 + 1, Math.min(outBins, x2))
      for (let x = x1; x < x2; x += 1) populated[x] = 1
      const value = Number(bins[i])
      if (!Number.isFinite(value)) continue
      hasData = true
      for (let x = x1; x < x2; x += 1) {
        out[x] = out[x] === null ? value : Math.max(out[x], value)
      }
    }
  }

  let populatedCount = 0
  for (let i = 0; i < outBins; i += 1) if (populated[i]) populatedCount += 1
  const observed = out.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return {
    bins: out,
    populated,
    has_data: hasData,
    min: observed.length ? Math.min(...observed) : null,
    max: observed.length ? Math.max(...observed) : null,
    coverage: populatedCount / Math.max(1, outBins),
    error: bestError,
  }
}

function projectSvSignalTilesCascade(cache, trackId, chrom, targetLevel, visStart, visEnd, outBins) {
  const targetIndex = Math.max(0, SV_SIGNAL_LOD_LEVELS.findIndex((level) => level.id === targetLevel.id))
  const fine = projectSvSignalTiles(cache, trackId, chrom, targetLevel, visStart, visEnd, outBins)
  if (fine.coverage >= 0.99 || targetIndex <= 0) return fine
  const mergedBins = [...fine.bins]
  const mergedPopulated = new Uint8Array(outBins)
  let popCount = 0
  for (let i = 0; i < outBins; i += 1) {
    mergedPopulated[i] = fine.populated[i] ? 1 : 0
    if (mergedPopulated[i]) popCount += 1
  }
  let bestError = fine.error
  for (let levelIndex = targetIndex - 1; levelIndex >= 0 && popCount < outBins; levelIndex -= 1) {
    const coarse = projectSvSignalTiles(cache, trackId, chrom, SV_SIGNAL_LOD_LEVELS[levelIndex], visStart, visEnd, outBins)
    if (!bestError && coarse.error) bestError = coarse.error
    for (let i = 0; i < outBins; i += 1) {
      if (mergedPopulated[i] || !coarse.populated[i]) continue
      mergedBins[i] = coarse.bins[i]
      mergedPopulated[i] = 1
      popCount += 1
    }
  }
  const observed = mergedBins.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return {
    bins: mergedBins,
    populated: mergedPopulated,
    has_data: observed.length > 0,
    min: observed.length ? Math.min(...observed) : null,
    max: observed.length ? Math.max(...observed) : null,
    coverage: popCount / Math.max(1, outBins),
    error: bestError,
  }
}

function selectSvOrderStatistic(values, targetIndex) {
  let left = 0
  let right = values.length - 1
  const target = Math.max(0, Math.min(right, targetIndex))
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)]
    let low = left
    let high = right
    while (low <= high) {
      while (values[low] < pivot) low += 1
      while (values[high] > pivot) high -= 1
      if (low <= high) {
        const tmp = values[low]
        values[low] = values[high]
        values[high] = tmp
        low += 1
        high -= 1
      }
    }
    if (target <= high) right = high
    else if (target >= low) left = low
    else return values[target]
  }
  return values[target]
}

function buildSvSignalPath(bins, width, height) {
  const values = (Array.isArray(bins) ? bins : []).filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!values.length || width <= 0 || height <= 0) return ''
  const working = [...values]
  const lo = Math.min(0, selectSvOrderStatistic(working, Math.floor(working.length * 0.02)) ?? values[0])
  let hi = selectSvOrderStatistic(working, Math.floor(working.length * 0.98)) ?? values[values.length - 1]
  if (!Number.isFinite(hi) || hi <= lo) hi = Math.max(...values) + 1
  const scale = Math.max(1e-9, hi - lo)
  const gamma = 0.55
  const baseY = height - 5
  let path = `M 0 ${baseY}`
  const binCount = Math.max(1, bins.length)
  bins.forEach((value, index) => {
    const x0 = (index / binCount) * width
    const x1 = ((index + 1) / binCount) * width
    const numeric = Number(value)
    const normalized = Number.isFinite(numeric) ? clamp((numeric - lo) / scale, 0, 1) : 0
    const boosted = Math.pow(normalized, gamma)
    const y = baseY - boosted * Math.max(6, height - 12)
    path += ` L ${x0.toFixed(2)} ${y.toFixed(2)} L ${x1.toFixed(2)} ${y.toFixed(2)}`
  })
  path += ` L ${width} ${baseY} Z`
  return path
}

function projectSvRibbonFeatureTiles(cache, trackKey, chrom, visStart, visEnd) {
  const tileSpan = SV_BIGBED_FEATURE_TILE_SPAN
  const firstTile = Math.floor(visStart / tileSpan) * tileSpan
  const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
  const dedup = new Map()
  let expectedTiles = 0
  let fetchedTiles = 0

  for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
    const tileEnd = tileStart + tileSpan
    expectedTiles += 1
    const tile = cache.get(svBigBedFeatureTileKey(trackKey, chrom, tileStart, tileEnd))
    if (!tile) continue
    fetchedTiles += 1
    const rows = Array.isArray(tile?.features) ? tile.features : []
    for (const row of rows) {
      const normalized = row?._key ? row : svNormalizeBigBedFeature(row)
      if (!normalized) continue
      if (normalized.end <= visStart || normalized.start >= visEnd) continue
      const key = normalized._key || svBigBedFeatureKey(normalized)
      if (dedup.has(key)) continue
      dedup.set(key, normalized)
    }
  }

  const features = Array.from(dedup.values()).sort((a, b) => (
    (a.start - b.start)
    || (a.end - b.end)
    || String(a?.name || '').localeCompare(String(b?.name || ''))
    || String(a?._key || '').localeCompare(String(b?._key || ''))
  ))
  return {
    mode: 'features',
    features: features.slice(0, SV_RIBBON_INTERVAL_MAX_FEATURES),
    tile_coverage: expectedTiles > 0 ? fetchedTiles / expectedTiles : 0,
    truncated: features.length > SV_RIBBON_INTERVAL_MAX_FEATURES,
  }
}

function trimSvRibbonFeatureCache(cache) {
  if (!(cache instanceof Map) || !cache.size) return
  let featureCount = 0
  for (const tile of cache.values()) {
    featureCount += Array.isArray(tile?.features) ? tile.features.length : 0
  }
  while (cache.size > SV_RIBBON_MAX_CACHE_TILES || featureCount > SV_RIBBON_MAX_CACHE_FEATURES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    const oldestTile = cache.get(oldestKey)
    featureCount -= Array.isArray(oldestTile?.features) ? oldestTile.features.length : 0
    cache.delete(oldestKey)
  }
}

function getSvRibbonIntervalMinWidth(viewSpan, plotWidth) {
  if (viewSpan <= 1000) return 1
  const sequenceFloorWidth = Math.max(1, plotWidth / 1000)
  const maxBoost = Math.max(sequenceFloorWidth, 6)
  const t = clamp((viewSpan - 1000) / Math.max(1, SV_RIBBON_INTERVAL_MAX_VIEW_SPAN - 1000), 0, 1)
  return 1 + (maxBoost - 1) * t
}

function buildSvRibbonIntervalMarks(features, win, plotWidth, lodSpan = null) {
  const safeFeatures = Array.isArray(features) ? features : []
  if (!win?.chrom || !safeFeatures.length) return []
  const viewStart = Number(win.start)
  const viewEnd = Number(win.end)
  const span = Math.max(1, viewEnd - viewStart)
  const effectiveLodSpan = Number.isFinite(lodSpan) && lodSpan > 0 ? lodSpan : span
  const minWidth = getSvRibbonIntervalMinWidth(effectiveLodSpan, plotWidth * (effectiveLodSpan / span))
  const useActualWidth = effectiveLodSpan <= 1000
  const mergeGapPx = effectiveLodSpan > 500_000 ? 1.5 : effectiveLodSpan > 250_000 ? 0.75 : 0

  const items = []
  for (const feature of safeFeatures) {
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    if (end <= viewStart || start >= viewEnd) continue
    const x0 = ((start - viewStart) / span) * plotWidth
    const x1 = ((end - viewStart) / span) * plotWidth
    const actualX = clamp(x0, 0, plotWidth)
    const actualW = Math.max(1, clamp(x1, 0, plotWidth) - actualX)
    const drawW = useActualWidth ? actualW : Math.max(actualW, minWidth)
    const drawX = clamp(actualX - ((drawW - actualW) / 2), 0, Math.max(0, plotWidth - drawW))
    items.push({
      x: drawX,
      w: Math.min(drawW, plotWidth),
      actualX,
      actualW,
      start,
      end,
      features: [feature],
    })
  }

  if (mergeGapPx <= 0) return items.slice(0, SV_RIBBON_INTERVAL_MAX_MARKS)

  const merged = []
  for (const item of items) {
    const last = merged[merged.length - 1]
    if (last && item.x <= (last.x + last.w + mergeGapPx)) {
      const right = Math.max(last.x + last.w, item.x + item.w)
      last.x = Math.min(last.x, item.x)
      last.w = right - last.x
      last.start = Math.min(last.start, item.start)
      last.end = Math.max(last.end, item.end)
      last.features.push(...item.features)
    } else {
      merged.push({ ...item, features: [...item.features] })
    }
  }
  return merged.slice(0, SV_RIBBON_INTERVAL_MAX_MARKS)
}

function constrainWindowToZoomLimits(window, chromSize = null, minStart = 1) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return window
  const center = (Number(window.start) + Number(window.end)) / 2
  const span = Math.max(1, Number(window.end) - Number(window.start))
  return centerWindowOnRange(window.chrom, center, span, chromSize, minStart)
}

function buildChromWindow(chrom, chromSize, minStart = 1) {
  if (!chrom || !Number.isFinite(chromSize) || chromSize <= minStart) return null
  return {
    chrom,
    start: minStart,
    end: Math.max(minStart + 1, Math.round(chromSize)),
  }
}

function getSvLoadingMode() {
  if (typeof window === 'undefined') return DEFAULT_SV_LOADING_MODE
  const raw = String(window.localStorage?.getItem(SV_LOADING_MODE_STORAGE_KEY) || '').trim().toLowerCase()
  return raw === 'windowed' ? 'windowed' : DEFAULT_SV_LOADING_MODE
}

function svBufferMatchesRefWindow(bufferData, refWindow) {
  if (!bufferData?.ref_chrom || !refWindow?.chrom) return false
  return normalizeSvChromToken(bufferData.ref_chrom) === normalizeSvChromToken(refWindow.chrom)
}

function svBufferMatchesAlignment(bufferData, alignmentId = '') {
  const wanted = String(alignmentId || '').trim()
  if (!wanted) return true
  return String(bufferData?.alignment_id || '').trim() === wanted
}

function deriveAutoTargetWindowFromBuffer(bufferData, refWindow, fallbackWindow = null) {
  if (!refWindow || !bufferData) return fallbackWindow
  if (!svBufferMatchesRefWindow(bufferData, refWindow)) return null
  const segments = Array.isArray(bufferData?.segments) && bufferData.segments.length
    ? bufferData.segments
    : Array.isArray(bufferData?.blocks)
      ? bufferData.blocks
      : []
  if (!segments.length) return fallbackWindow

  let minT = Infinity
  let maxT = -Infinity
  for (const seg of segments) {
    if (!overlaps(seg.ref_start, seg.ref_end, refWindow.start, refWindow.end)) continue
    const lo = Math.min(seg.tgt_start, seg.tgt_end)
    const hi = Math.max(seg.tgt_start, seg.tgt_end)
    if (lo < minT) minT = lo
    if (hi > maxT) maxT = hi
  }

  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) {
    return fallbackWindow
  }

  const refSpan = Math.max(1, refWindow.end - refWindow.start)
  const targetCenter = (minT + maxT) / 2
  const targetChromSize = getResolvedChromSize(bufferData?.tgt_chrom_sizes, bufferData?.tgt_chrom)
  return centerWindowOnRange(bufferData.tgt_chrom, targetCenter, refSpan, targetChromSize, 1)
}

function StructuralVariationSignalTracks({
  theme = 'dark',
  width = 760,
  window: viewWindow,
  displayWindow = null,
  genomeId = 'target',
  tracks = [],
  genomeColor = '',
}) {
  const isLight = theme === 'light'
  const [hiddenTracks, setHiddenTracks] = useState({})
  const [fetchRevision, setFetchRevision] = useState(0)
  const [cache] = useState(() => new Map())
  const [fetchSet] = useState(() => new Set())
  const retryRef = useRef({ context: '', attempt: 0, timer: null })
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
    }
  }, [])

  const activeTracks = useMemo(
    () => (tracks || []).filter((track) => {
      const type = String(track?.type || '').toLowerCase()
      return track?.path && type === 'bigwig'
    }),
    [tracks],
  )
  const plotWidth = Math.max(1, Math.round(width || 760))
  const renderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(viewWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [viewWindow],
  )
  const geometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(viewWindow, renderWindow, plotWidth),
    [viewWindow, renderWindow, plotWidth],
  )
  const displayBins = Math.max(200, Math.min(SV_SIGNAL_RENDER_MAX_BINS, Math.floor(geometryWidth)))
  const trackHeight = SV_SIGNAL_TRACK_HEIGHT
  const totalHeight = activeTracks.length
    ? (activeTracks.length * trackHeight) + ((activeTracks.length - 1) * SV_SIGNAL_TRACK_GAP)
    : 0

  const { trackData, plans: signalFetchPlans, chrom: signalChrom } = useMemo(() => {
    void fetchRevision
    if (!activeTracks.length || !renderWindow?.chrom || !Number.isFinite(renderWindow?.start) || !Number.isFinite(renderWindow?.end)) {
      return { trackData: {}, plans: [], chrom: '' }
    }

    const chrom = String(renderWindow.chrom || '')
    const visStart = Math.max(0, Math.floor(Number(renderWindow.start) || 0))
    const visEnd = Math.max(visStart + 1, Math.ceil(Number(renderWindow.end) || (visStart + 1)))
    const span = Math.max(1, visEnd - visStart)
    const bpPerPx = span / Math.max(1, geometryWidth)
    const targetLevel = getSvSignalLevel(bpPerPx)
    const projected = {}
    const plans = []
    const center = (visStart + visEnd) / 2
    const committedSpan = Math.max(1, Number(viewWindow?.end) - Number(viewWindow?.start))
    const bufferSpan = committedSpan * 0.75
    const bufferStart = Math.max(0, visStart - bufferSpan)
    const bufferEnd = visEnd + bufferSpan

    for (const track of activeTracks) {
      const dataKey = getSvDataTrackKey(track)
      const trackKey = `${SV_AUX_TRACK_CACHE_VERSION}:${dataKey}:${track.path}`
      projected[dataKey] = projectSvSignalTilesCascade(cache, trackKey, chrom, targetLevel, visStart, visEnd, displayBins)
      const targetIndex = SV_SIGNAL_LOD_LEVELS.findIndex((level) => level.id === targetLevel.id)
      const levelsToFetch = [{ level: targetLevel, role: 'target' }]
      if (targetIndex > 0) {
        levelsToFetch.push({ level: SV_SIGNAL_LOD_LEVELS[targetIndex - 1], role: 'fallback' })
      }
      if (targetIndex > 1) {
        levelsToFetch.push({ level: SV_SIGNAL_LOD_LEVELS[0], role: 'overview' })
      }
      for (const { level, role } of levelsToFetch) {
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
          const tileKey = svSignalTileKey(trackKey, chrom, level.id, tileStart)
          if (cache.has(tileKey)) continue
          const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
          const visibleRank = tileStart < visEnd && (tileStart + tileSpan) > visStart ? 0 : 1
          plans.push({ track, trackKey, level, role, tileStart, tileEnd: tileStart + tileSpan, tileKey, visibleRank, priority: distFromCenter })
        }
      }
    }

    plans.sort((a, b) => (a.visibleRank - b.visibleRank) || (a.priority - b.priority))
    const targetPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'target'),
      targetLevel.id === SV_SIGNAL_LOD_LEVELS[0].id
        ? SV_SIGNAL_TARGET_FETCH_BATCH_SIZE + SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE + SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE
        : SV_SIGNAL_TARGET_FETCH_BATCH_SIZE,
    )
    const fallbackPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'fallback'),
      SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE,
    )
    const overviewPlans = selectSvFetchPlansFairly(
      plans.filter((plan) => plan.role === 'overview'),
      SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE,
    )
    return { trackData: projected, plans: [...targetPlans, ...fallbackPlans, ...overviewPlans], chrom }
  }, [
    activeTracks,
    cache,
    renderWindow,
    viewWindow,
    geometryWidth,
    displayBins,
    fetchRevision,
  ])
  // Debounced like the alignment and gene overlays: a bigwig refetch on every
  // pan is usually too quick to be worth announcing.
  const loading = useDelayedFlag(signalFetchPlans.length > 0)
  const viewportTransform = useMemo(
    () => getSvAuxTrackTransform(renderWindow, displayWindow || viewWindow, plotWidth, geometryWidth),
    [renderWindow, displayWindow, viewWindow, plotWidth, geometryWidth],
  )

  useEffect(() => {
    if (!signalFetchPlans.length || !signalChrom) {
      return undefined
    }

    const retryContext = `${signalChrom}|${genomeId}|${activeTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`
    if (retryRef.current.context !== retryContext) {
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
      retryRef.current = { context: retryContext, attempt: 0, timer: null }
    }
    const resetRetry = () => {
      retryRef.current.attempt = 0
      if (retryRef.current.timer) {
        clearTimeout(retryRef.current.timer)
        retryRef.current.timer = null
      }
    }
    const scheduleRetry = () => {
      if (!mountedRef.current || retryRef.current.timer || retryRef.current.attempt >= SV_TRANSIENT_RETRY_LIMIT) return
      retryRef.current.attempt += 1
      const delay = getSvTransientRetryDelay(retryRef.current.attempt)
      retryRef.current.timer = setTimeout(() => {
        retryRef.current.timer = null
        if (mountedRef.current) setFetchRevision((value) => value + 1)
      }, delay)
    }
    const timer = setTimeout(() => {
      const groups = new Map()
      let cacheSatisfiedPlan = false
      for (const plan of signalFetchPlans) {
        if (cache.has(plan.tileKey)) {
          cacheSatisfiedPlan = true
          continue
        }
        if (fetchSet.has(plan.tileKey)) continue
        fetchSet.add(plan.tileKey)
        const groupKey = `${plan.trackKey}|${plan.track.path}`
        if (!groups.has(groupKey)) groups.set(groupKey, { track: plan.track, plans: [] })
        groups.get(groupKey).plans.push(plan)
      }

      if (!groups.size) {
        if (mountedRef.current && cacheSatisfiedPlan) setFetchRevision((value) => value + 1)
        return
      }

      const requests = []
      for (const group of groups.values()) {
        const request = fetch(`${API_BASE}/api/browse/bigwig_batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: genomeId,
            path: group.track.path,
            chrom: signalChrom,
            tiles: group.plans.map((plan) => ({
              start: Math.max(0, Math.floor(plan.tileStart)),
              end: Math.ceil(plan.tileEnd),
              bins: plan.level.binsPerTile,
            })),
          }),
        })
          .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
          .then((payload) => {
            const tiles = Array.isArray(payload?.tiles) ? payload.tiles : []
            group.plans.forEach((plan, index) => {
              const tile = tiles[index] || {}
              cache.set(plan.tileKey, {
                start: tile?.start ?? plan.tileStart,
                end: tile?.end ?? plan.tileEnd,
                levelId: plan.level.id,
                bpPerBin: plan.level.bpPerBin,
                bins: Array.isArray(tile?.bins) ? tile.bins : [],
                has_data: !!tile?.has_data,
                error: String(tile?.error || ''),
              })
            })
            resetRetry()
            return true
          })
          .catch(() => {
            scheduleRetry()
            return false
          })
          .finally(() => {
            for (const plan of group.plans) fetchSet.delete(plan.tileKey)
          })
        requests.push(request)
      }
      Promise.all(requests).then((results) => {
        if (cache.size > 2000) {
          const toDelete = cache.size - 1600
          let removed = 0
          const detailedKeys = []
          const overviewKeys = []
          for (const [cacheKey, tile] of cache.entries()) {
            if (tile?.levelId === SV_SIGNAL_LOD_LEVELS[0].id) overviewKeys.push(cacheKey)
            else detailedKeys.push(cacheKey)
          }
          for (const cacheKey of [...detailedKeys, ...overviewKeys]) {
            if (removed >= toDelete) break
            cache.delete(cacheKey)
            removed += 1
          }
        }
        if (mountedRef.current) {
          if (results.some(Boolean)) setFetchRevision((value) => value + 1)
        }
      })
    }, SV_DATA_TRACK_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [signalFetchPlans, signalChrom, genomeId, activeTracks, cache, fetchSet])

  const signalPaths = useMemo(() => {
    const paths = {}
    for (const track of activeTracks) {
      const key = getSvDataTrackKey(track)
      paths[key] = hiddenTracks[key]
        ? ''
        : buildSvSignalPath(trackData[key]?.bins || [], geometryWidth, trackHeight)
    }
    return paths
  }, [activeTracks, hiddenTracks, trackData, geometryWidth, trackHeight])

  if (!activeTracks.length || !viewWindow) return null

  const muted = isLight ? '#5f738a' : '#8ba0b8'
  const fill = isLight ? 'rgba(37, 99, 235, 0.52)' : 'rgba(96, 165, 250, 0.58)'
  const stroke = isLight ? 'rgba(29, 78, 216, 0.9)' : 'rgba(147, 197, 253, 0.95)'
  const trackBg = isLight ? '#f8f9fa' : '#212226'
  const activeControlColor = String(genomeColor || '').trim() || (isLight ? '#2563eb' : '#3b82f6')
  const toggleX = PLOT_PAD_X + SV_SIGNAL_CONTROL_WIDTH - SV_SIGNAL_TOGGLE_RADIUS - 2

  return (
    <div
      className="w-full flex-none"
      style={{
        height: totalHeight,
        background: 'transparent',
        position: 'relative',
      }}
    >
      <svg width={plotWidth} height={totalHeight} style={{ display: 'block' }}>
        {activeTracks.map((track, index) => {
          const y = index * (trackHeight + SV_SIGNAL_TRACK_GAP)
          const key = getSvDataTrackKey(track)
          const hidden = Boolean(hiddenTracks[key])
          const path = signalPaths[key] || ''
          const controlBg = isLight ? '#e2ecfa' : '#0c172c'
          const controlText = isLight ? '#53759a' : '#9eb8d6'
          const offControl = isLight ? '#cbd5e1' : '#334155'
          return (
            <g key={key}>
              <rect x="0" y={y} width={plotWidth} height={trackHeight} fill={trackBg} />
              <line x1="0" x2={plotWidth} y1={y + trackHeight - 5} y2={y + trackHeight - 5} stroke={isLight ? 'rgba(96,125,159,0.35)' : 'rgba(139,160,184,0.24)'} strokeWidth="1" />
              {path && viewportTransform.canTransform && (
                <path
                  d={path}
                  transform={getSvAuxTrackMatrix(viewportTransform, y)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {!path && !hidden && (
                <text x={plotWidth / 2} y={y + trackHeight / 2 + 3} textAnchor="middle" fontSize="10" fill={muted}>
                  {loading ? 'Loading...' : 'No BW data'}
                </text>
              )}
              <rect x="0" y={y} width={PLOT_PAD_X + SV_SIGNAL_CONTROL_WIDTH} height={trackHeight} fill={controlBg} />
              <text x={PLOT_PAD_X + 4} y={y + trackHeight / 2} dominantBaseline="middle" fontSize="10" fontWeight="600" fill={controlText}>BW</text>
              <g
                role="button"
                tabIndex="0"
                style={{ cursor: 'pointer' }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setHiddenTracks((prev) => ({ ...prev, [key]: !prev[key] }))
                }}
              >
                <circle cx={toggleX} cy={y + trackHeight / 2} r={SV_SIGNAL_TOGGLE_RADIUS} fill={hidden ? offControl : activeControlColor} />
                <path
                  d="M 0 -7 L 0 -1 M -4.7 -3.6 A 6.2 6.2 0 1 0 4.7 -3.6"
                  transform={`translate(${toggleX} ${y + trackHeight / 2})`}
                  fill="none"
                  stroke={hidden ? (isLight ? '#475569' : '#e2e8f0') : '#ffffff'}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </g>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function StructuralVariationRibbonOverlay({
  theme = 'dark',
  width = 760,
  height = ALIGNMENT_PANEL_HEIGHT,
  referenceWindow = null,
  targetWindow = null,
  displayReferenceWindow = null,
  displayTargetWindow = null,
  referenceTracks = [],
  targetTracks = [],
  referenceGenomeId = 'reference',
  targetGenomeId = 'target',
  displayOrder = 'reference-top',
}) {
  const isLight = theme === 'light'
  const [clickedFeature, setClickedFeature] = useState(null)
  const [copyToast, setCopyToast] = useState('')
  const [fetchRevision, setFetchRevision] = useState(0)
  const [cache] = useState(() => new Map())
  const [fetchSet] = useState(() => new Set())
  const popupCloseTimerRef = useRef(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refTracks = useMemo(
    () => (referenceTracks || []).filter((track) => String(track?.type || '').toLowerCase() === 'bigbed' && track?.path),
    [referenceTracks],
  )
  const tgtTracks = useMemo(
    () => (targetTracks || []).filter((track) => String(track?.type || '').toLowerCase() === 'bigbed' && track?.path),
    [targetTracks],
  )
  const refSignature = useMemo(() => `${SV_AUX_TRACK_CACHE_VERSION}|${refTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`, [refTracks])
  const tgtSignature = useMemo(() => `${SV_AUX_TRACK_CACHE_VERSION}|${tgtTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`, [tgtTracks])
  const plotWidth = Math.max(1, Math.round(width || 760))
  const safeHeight = Math.max(72, Math.round(height || ALIGNMENT_PANEL_HEIGHT))
  const referenceRenderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(referenceWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [referenceWindow],
  )
  const targetRenderWindow = useMemo(
    () => buildSvAuxTrackRenderWindow(targetWindow, {
      haloWindows: SV_AUX_TRACK_RENDER_HALO_WINDOWS,
      maxHaloBp: SV_AUX_TRACK_RENDER_HALO_MAX_BP,
    }),
    [targetWindow],
  )
  const referenceGeometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(referenceWindow, referenceRenderWindow, plotWidth),
    [referenceWindow, referenceRenderWindow, plotWidth],
  )
  const targetGeometryWidth = useMemo(
    () => getSvAuxTrackGeometryWidth(targetWindow, targetRenderWindow, plotWidth),
    [targetWindow, targetRenderWindow, plotWidth],
  )

  const { trackData, plans: ribbonFetchPlans } = useMemo(() => {
    void fetchRevision
    const sides = [
      { side: 'reference', genomeId: referenceGenomeId, window: referenceRenderWindow, viewWindow: referenceWindow, tracks: refTracks },
      { side: 'target', genomeId: targetGenomeId, window: targetRenderWindow, viewWindow: targetWindow, tracks: tgtTracks },
    ]
    const projected = {}
    const plans = []

    for (const sideInfo of sides) {
      const win = sideInfo.window
      if (!win?.chrom || !Number.isFinite(win?.start) || !Number.isFinite(win?.end)) continue
      const visStart = Math.max(0, Math.floor(Number(win.start) || 0))
      const visEnd = Math.max(visStart + 1, Math.ceil(Number(win.end) || (visStart + 1)))
      const viewSpan = Math.max(1, Number(sideInfo.viewWindow?.end) - Number(sideInfo.viewWindow?.start))
      if (viewSpan > SV_RIBBON_INTERVAL_MAX_VIEW_SPAN) continue
      const chrom = String(win.chrom || '')
      const center = (visStart + visEnd) / 2
      const bufferSpan = Math.max(
        viewSpan * SV_BIGBED_DETAIL_PREFETCH_RATIO,
        SV_BIGBED_FEATURE_TILE_SPAN * SV_BIGBED_DETAIL_PREFETCH_MIN_TILES,
      )
      const bufferStart = Math.max(0, visStart - bufferSpan)
      const bufferEnd = visEnd + bufferSpan

      for (const track of sideInfo.tracks) {
        const trackKey = `${SV_AUX_TRACK_CACHE_VERSION}:${sideInfo.side}:${getSvDataTrackKey(track)}:${track.path}`
        projected[trackKey] = {
          ...projectSvRibbonFeatureTiles(cache, trackKey, chrom, visStart, visEnd),
          side: sideInfo.side,
          track,
          chrom,
        }
        const firstTile = Math.floor(bufferStart / SV_BIGBED_FEATURE_TILE_SPAN) * SV_BIGBED_FEATURE_TILE_SPAN
        const lastTile = Math.floor((bufferEnd - 1) / SV_BIGBED_FEATURE_TILE_SPAN) * SV_BIGBED_FEATURE_TILE_SPAN
        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += SV_BIGBED_FEATURE_TILE_SPAN) {
          const tileEnd = tileStart + SV_BIGBED_FEATURE_TILE_SPAN
          const tileKey = svBigBedFeatureTileKey(trackKey, chrom, tileStart, tileEnd)
          if (cache.has(tileKey)) continue
          const distFromCenter = Math.abs((tileStart + SV_BIGBED_FEATURE_TILE_SPAN / 2) - center)
          plans.push({ ...sideInfo, track, trackKey, chrom, tileStart, tileEnd, tileKey, priority: distFromCenter })
        }
      }
    }

    plans.sort((a, b) => a.priority - b.priority)
    return {
      trackData: projected,
      plans: selectSvFetchPlansFairly(
        plans,
        SV_BIGBED_DETAIL_FETCH_BATCH_SIZE,
        SV_BIGBED_DETAIL_FETCH_PER_TRACK,
      ),
    }
  }, [
    refTracks,
    tgtTracks,
    cache,
    referenceWindow,
    targetWindow,
    referenceRenderWindow,
    targetRenderWindow,
    referenceGenomeId,
    targetGenomeId,
    fetchRevision,
  ])

  useEffect(() => {
    setClickedFeature(null)
  }, [
    referenceWindow?.chrom,
    referenceWindow?.start,
    referenceWindow?.end,
    targetWindow?.chrom,
    targetWindow?.start,
    targetWindow?.end,
    displayReferenceWindow?.chrom,
    displayReferenceWindow?.start,
    displayReferenceWindow?.end,
    displayTargetWindow?.chrom,
    displayTargetWindow?.start,
    displayTargetWindow?.end,
    refSignature,
    tgtSignature,
  ])

  useEffect(() => {
    if (!ribbonFetchPlans.length) return undefined
    const timer = setTimeout(() => {
      const groups = new Map()
      let cacheSatisfiedPlan = false
      for (const plan of ribbonFetchPlans) {
        if (cache.has(plan.tileKey)) {
          cacheSatisfiedPlan = true
          continue
        }
        if (fetchSet.has(plan.tileKey)) continue
        fetchSet.add(plan.tileKey)
        const groupKey = `${plan.trackKey}|${plan.chrom}`
        if (!groups.has(groupKey)) groups.set(groupKey, { plan, keys: [], tiles: [] })
        const group = groups.get(groupKey)
        group.keys.push(plan.tileKey)
        group.tiles.push({
          start: Math.max(0, Math.floor(plan.tileStart)),
          end: Math.ceil(plan.tileEnd),
          level_id: 'detail',
          max_features: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
        })
      }

      if (!groups.size) {
        if (mountedRef.current && cacheSatisfiedPlan) setFetchRevision((value) => value + 1)
        return
      }

      const requests = []
      for (const { plan, keys, tiles } of groups.values()) {
        const request = fetch(`${API_BASE}/api/browse/bigbed/feature_tiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: plan.genomeId,
            path: plan.track.path,
            chrom: plan.chrom,
            max_features_per_tile: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
            tiles,
          }),
        })
          .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
          .then((payload) => {
            const returnedChrom = payload?.chrom || plan.chrom
            const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
            for (const tile of returned) {
              const tileStart = Math.max(0, Math.floor(Number(tile?.start) || 0))
              const tileEnd = Math.max(tileStart + 1, Math.ceil(Number(tile?.end) || 1))
              const cachedTile = {
                ...(tile || {}),
                mode: 'bigbed_detail',
                start: tileStart,
                end: tileEnd,
                features: Array.isArray(tile?.features) ? tile.features.map(svNormalizeBigBedFeature).filter(Boolean) : [],
                has_data: tile?.has_data !== false,
                error: '',
              }
              cache.set(svBigBedFeatureTileKey(plan.trackKey, plan.chrom, tileStart, tileEnd), cachedTile)
              if (returnedChrom !== plan.chrom) {
                cache.set(svBigBedFeatureTileKey(plan.trackKey, returnedChrom, tileStart, tileEnd), cachedTile)
              }
            }
            return true
          })
          .catch(() => false)
          .finally(() => {
            for (const key of keys) fetchSet.delete(key)
          })
        requests.push(request)
      }
      if (requests.length) {
        Promise.all(requests).then((results) => {
          trimSvRibbonFeatureCache(cache)
          if (mountedRef.current && results.some(Boolean)) {
            setFetchRevision((value) => value + 1)
          }
        })
      }
    }, SV_DATA_TRACK_FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ribbonFetchPlans, cache, fetchSet])

  const clearPopupCloseTimer = useCallback(() => {
    if (popupCloseTimerRef.current) {
      clearTimeout(popupCloseTimerRef.current)
      popupCloseTimerRef.current = null
    }
  }, [])

  const schedulePopupClose = useCallback((delay = 140) => {
    clearPopupCloseTimer()
    popupCloseTimerRef.current = setTimeout(() => {
      popupCloseTimerRef.current = null
      setClickedFeature(null)
    }, delay)
  }, [clearPopupCloseTimer])

  useEffect(() => {
    if (!clickedFeature) {
      clearPopupCloseTimer()
      return undefined
    }
    const clearIfAway = (event) => {
      const target = event.target
      if (target?.closest?.('[data-sv-ribbon-interval="true"]') || target?.closest?.('[data-sv-metadata-popup="true"]')) {
        clearPopupCloseTimer()
        return
      }
      if (event.type === 'pointerdown') {
        clearPopupCloseTimer()
        setClickedFeature(null)
        return
      }
      schedulePopupClose()
    }
    window.addEventListener('pointerdown', clearIfAway, true)
    window.addEventListener('mousemove', clearIfAway, true)
    return () => {
      window.removeEventListener('pointerdown', clearIfAway, true)
      window.removeEventListener('mousemove', clearIfAway, true)
      clearPopupCloseTimer()
    }
  }, [clickedFeature, clearPopupCloseTimer, schedulePopupClose])

  useEffect(() => {
    if (!copyToast) return undefined
    const timer = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(timer)
  }, [copyToast])

  const copyToClipboard = useCallback(async (text, label = 'value') => {
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

  const topSide = displayOrder === 'alt-top' ? 'target' : 'reference'
  const markerHeight = Math.max(4, Math.min(6, Math.round(safeHeight * 6 / 159)))
  const rulerHeight = Math.max(10, Math.min(12, Math.round(safeHeight * 12 / 159)))
  const topY = rulerHeight + markerHeight + 2
  const bottomY = safeHeight - rulerHeight - (markerHeight * 2) - 2
  const referenceFill = isLight ? 'rgba(20, 184, 166, 0.78)' : 'rgba(45, 212, 191, 0.74)'
  const targetFill = isLight ? 'rgba(16, 185, 129, 0.76)' : 'rgba(52, 211, 153, 0.72)'
  const referenceStroke = isLight ? 'rgba(15, 118, 110, 0.95)' : 'rgba(153, 246, 228, 0.95)'
  const targetStroke = isLight ? 'rgba(4, 120, 87, 0.95)' : 'rgba(167, 243, 208, 0.95)'

  const renderSide = useCallback((side, win, geometryWidth, lodSpan) => {
    if (!win?.chrom) return []
    if (lodSpan > SV_RIBBON_INTERVAL_MAX_VIEW_SPAN) return []
    const y = side === topSide ? topY : bottomY
    const fill = side === 'reference' ? referenceFill : targetFill
    const stroke = side === 'reference' ? referenceStroke : targetStroke
    const rects = []
    for (const [trackKey, data] of Object.entries(trackData)) {
      if (data?.side !== side || !Array.isArray(data?.features)) continue
      const marks = buildSvRibbonIntervalMarks(data.features, win, geometryWidth, lodSpan)
      const mergedPath = []
      const clickableRects = []
      for (const [index, mark] of marks.entries()) {
        const feature = mark.features.length === 1 ? mark.features[0] : null
        const start = Number(feature?.start ?? mark.start)
        const end = Number(feature?.end ?? mark.end)
        const featureKey = `${trackKey}|${start}|${end}|${index}|${mark.features.length}`
        if (!feature) {
          const markWidth = Math.max(1, mark.w)
          mergedPath.push(`M ${mark.x} ${y} h ${markWidth} v ${markerHeight} h ${-markWidth} Z`)
          continue
        }
        clickableRects.push(
          <rect
            key={featureKey}
            data-sv-ribbon-interval="true"
            x={mark.x}
            y={y}
            width={Math.max(1, mark.w)}
            height={markerHeight}
            rx="1"
            fill={fill}
            stroke={stroke}
            strokeWidth="0.75"
            opacity="0.9"
            style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setClickedFeature({
                trackLabel: getSvDataTrackLabel(data.track),
                side,
                chrom: win.chrom,
                feature,
                popupX: event.clientX,
                popupY: event.clientY,
              })
            }}
          />,
        )
      }
      if (mergedPath.length) {
        rects.push(
          <path
            key={`${trackKey}|merged`}
            d={mergedPath.join(' ')}
            fill={fill}
            stroke={stroke}
            strokeWidth="0.75"
            opacity="0.62"
            style={{ pointerEvents: 'none' }}
          />,
        )
      }
      rects.push(...clickableRects)
    }
    return rects
  }, [bottomY, markerHeight, referenceFill, referenceStroke, targetFill, targetStroke, topSide, topY, trackData])

  const referenceIntervalRects = useMemo(
    () => renderSide(
      'reference',
      referenceRenderWindow,
      referenceGeometryWidth,
      Math.max(1, Number(referenceWindow?.end) - Number(referenceWindow?.start)),
    ),
    [referenceWindow, referenceRenderWindow, referenceGeometryWidth, renderSide],
  )
  const targetIntervalRects = useMemo(
    () => renderSide(
      'target',
      targetRenderWindow,
      targetGeometryWidth,
      Math.max(1, Number(targetWindow?.end) - Number(targetWindow?.start)),
    ),
    [targetWindow, targetRenderWindow, targetGeometryWidth, renderSide],
  )
  const referenceTransform = useMemo(
    () => getSvAuxTrackTransform(referenceRenderWindow, displayReferenceWindow || referenceWindow, plotWidth, referenceGeometryWidth),
    [referenceRenderWindow, displayReferenceWindow, referenceWindow, plotWidth, referenceGeometryWidth],
  )
  const targetTransform = useMemo(
    () => getSvAuxTrackTransform(targetRenderWindow, displayTargetWindow || targetWindow, plotWidth, targetGeometryWidth),
    [targetRenderWindow, displayTargetWindow, targetWindow, plotWidth, targetGeometryWidth],
  )
  if (!referenceIntervalRects.length && !targetIntervalRects.length && !clickedFeature) return null

  return (
    <>
      <svg
        width={plotWidth}
        height={safeHeight}
        className="absolute inset-0 z-10"
        style={{ display: 'block', pointerEvents: 'none' }}
      >
        {referenceTransform.canTransform && (
          <g transform={getSvAuxTrackMatrix(referenceTransform)}>{referenceIntervalRects}</g>
        )}
        {targetTransform.canTransform && (
          <g transform={getSvAuxTrackMatrix(targetTransform)}>{targetIntervalRects}</g>
        )}
      </svg>
      {clickedFeature && (() => {
        const f = clickedFeature.feature || {}
        const popupW = 280
        const arrowSize = 8
        const gap = 4
        const popupX = clamp(clickedFeature.popupX || 0, popupW / 2 + 8, (typeof window !== 'undefined' ? window.innerWidth : popupW + 16) - popupW / 2 - 8)
        const popupY = Math.max(8, (clickedFeature.popupY || 0) - arrowSize - gap)
        const rows = buildCuratedSvIntervalRows(f, {
          trackLabel: clickedFeature.trackLabel,
          side: clickedFeature.side,
          chrom: clickedFeature.chrom,
        })
          .map(([name, value]) => [name, abbreviateMetadataValue(value)])
        return (
          <div
            data-sv-metadata-popup="true"
            className="fixed z-50 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
              left: popupX,
              top: popupY,
              transform: 'translate(-50%, -100%)',
              width: popupW,
              backgroundColor: 'rgba(17, 24, 39, 0.97)',
              color: '#f1f5f9',
              padding: '10px 14px',
              border: '1px solid rgba(255,255,255,0.1)',
              pointerEvents: 'auto',
              overflowWrap: 'break-word',
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={clearPopupCloseTimer}
            onMouseMove={(event) => {
              event.stopPropagation()
              clearPopupCloseTimer()
            }}
            onMouseLeave={() => {
              clearPopupCloseTimer()
              setClickedFeature(null)
            }}
          >
            <div
              style={{
                position: 'absolute',
                bottom: -arrowSize,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                borderLeft: `${arrowSize}px solid transparent`,
                borderRight: `${arrowSize}px solid transparent`,
              }}
            />
            {rows.map(([name, value]) => (
              <div key={name} className="flex min-w-0 items-start gap-1.5">
                <span className="shrink-0" style={{ color: '#93c5fd', fontWeight: 700 }}>{name}: </span>
                <span className="min-w-0 flex-1 break-all">{value.display}</span>
                {value.abbreviated && (
                  <button
                    type="button"
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-500/70 text-slate-100 hover:bg-slate-700"
                    title={`Copy full ${String(name || 'value').toLowerCase()}`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      copyToClipboard(value.full, String(name || 'value').toLowerCase())
                    }}
                  >
                    <CopyGlyph />
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })()}
      {copyToast && (
        <div className="fixed bottom-6 left-1/2 z-[150] -translate-x-1/2 rounded-lg border border-sky-500/70 bg-gray-800 px-3 py-1.5 text-xs font-semibold text-sky-200 shadow-xl">
          {copyToast}
        </div>
      )}
    </>
  )
}

function StructuralVariationDataTracks({
  theme = 'dark',
  width = 760,
  window: viewWindow,
  genomeId = 'target',
  tracks = [],
}) {
  const isLight = theme === 'light'
  const [trackData, setTrackData] = useState({})
  const [clickedFeature, setClickedFeature] = useState(null)
  const [copyToast, setCopyToast] = useState('')
  const [loading, setLoading] = useState(false)
  const showLoading = useDelayedFlag(loading)
  const [fetchRevision, setFetchRevision] = useState(0)
  const cacheRef = useRef(new Map())
  const fetchSetRef = useRef(new Set())
  const lodStateRef = useRef({})
  const layoutStateRef = useRef({})
  const fetchEpochRef = useRef(0)
  const retryRef = useRef({ context: '', attempt: 0, timer: null })

  useEffect(() => () => {
    if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
  }, [])

  const activeTracks = useMemo(
    () => (tracks || []).filter((track) => {
      const type = String(track?.type || '').toLowerCase()
      return track?.path && type === 'bigbed'
    }),
    [tracks],
  )
  const trackSignature = useMemo(
    () => `${SV_AUX_TRACK_CACHE_VERSION}|${activeTracks.map((track) => `${getSvDataTrackKey(track)}:${track.path}`).join('|')}`,
    [activeTracks],
  )
  const plotWidth = Math.max(1, Math.round(width || 760))
  const detailEntryBpPerPx = SV_BIGBED_DETAIL_VIEWSPAN_BP / Math.max(1, plotWidth)
  const trackHeight = SV_DATA_TRACK_HEIGHT
  const totalHeight = activeTracks.length
    ? (activeTracks.length * trackHeight) + ((activeTracks.length - 1) * SV_DATA_TRACK_GAP)
    : 0

  useEffect(() => {
    setClickedFeature(null)
  }, [trackSignature, viewWindow?.chrom, viewWindow?.start, viewWindow?.end])

  useEffect(() => {
    if (!copyToast) return undefined
    const timer = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(timer)
  }, [copyToast])

  const copyToClipboard = useCallback(async (text, label = 'value') => {
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

  useEffect(() => {
    if (!activeTracks.length || !viewWindow?.chrom || !Number.isFinite(viewWindow?.start) || !Number.isFinite(viewWindow?.end)) {
      setTrackData({})
      setLoading(false)
      return undefined
    }

    const epoch = ++fetchEpochRef.current
    const chrom = String(viewWindow.chrom || '')
    const visStart = Math.max(0, Math.floor(Number(viewWindow.start) || 0))
    const visEnd = Math.max(visStart + 1, Math.ceil(Number(viewWindow.end) || (visStart + 1)))
    const span = Math.max(1, Number(viewWindow.end) - Number(viewWindow.start))
    const bpPerPx = span / Math.max(1, plotWidth)
    const bufferSpan = span * 2
    const bufferStart = Math.max(0, visStart - bufferSpan)
    const bufferEnd = visEnd + bufferSpan
    const projectedData = {}
    const fetchPlans = []
    const retryContext = `${trackSignature}|${genomeId}|${chrom}`
    if (retryRef.current.context !== retryContext) {
      if (retryRef.current.timer) clearTimeout(retryRef.current.timer)
      retryRef.current = { context: retryContext, attempt: 0, timer: null }
    }
    const resetRetry = () => {
      retryRef.current.attempt = 0
      if (retryRef.current.timer) {
        clearTimeout(retryRef.current.timer)
        retryRef.current.timer = null
      }
    }
    const scheduleRetry = () => {
      if (retryRef.current.timer || retryRef.current.attempt >= SV_TRANSIENT_RETRY_LIMIT) return
      retryRef.current.attempt += 1
      const delay = getSvTransientRetryDelay(retryRef.current.attempt)
      retryRef.current.timer = setTimeout(() => {
        retryRef.current.timer = null
        if (fetchEpochRef.current === epoch) setFetchRevision((value) => value + 1)
      }, delay)
    }

    for (const track of activeTracks) {
      const key = getSvDataTrackKey(track)
      const mode = getSvBigBedLodMode(key, bpPerPx, detailEntryBpPerPx, lodStateRef)
      if (mode === 'detail') {
        const projected = projectSvBigBedFeatureTiles(cacheRef.current, layoutStateRef, key, chrom, visStart, visEnd, plotWidth)
        projectedData[key] = projected
        const tileSpan = SV_BIGBED_FEATURE_TILE_SPAN
        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
        const center = (visStart + visEnd) / 2
        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
          const tileEnd = tileStart + tileSpan
          const tileKey = svBigBedFeatureTileKey(key, chrom, tileStart, tileEnd)
          if (cacheRef.current.has(tileKey) || fetchSetRef.current.has(tileKey)) continue
          const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
          fetchPlans.push({ type: 'feature', key: tileKey, trackKey: key, track, tileStart, tileEnd, priority: distFromCenter })
        }
      } else {
        const targetLevel = getSvBigBedBlockLevel(bpPerPx)
        const targetIndex = SV_BIGBED_BLOCK_LEVELS.findIndex((level) => level.id === targetLevel.id)
        const levelsToFetch = [targetLevel]
        if (targetIndex > 0) levelsToFetch.push(SV_BIGBED_BLOCK_LEVELS[targetIndex - 1])
        projectedData[key] = projectSvBigBedBlockTiles(cacheRef.current, key, chrom, targetLevel, visStart, visEnd, plotWidth)
        const center = (visStart + visEnd) / 2
        for (const level of levelsToFetch) {
          const firstTile = Math.floor(bufferStart / level.tileSpanBp) * level.tileSpanBp
          const lastTile = Math.floor((bufferEnd - 1) / level.tileSpanBp) * level.tileSpanBp
          for (let tileStart = firstTile; tileStart <= lastTile; tileStart += level.tileSpanBp) {
            const tileEnd = tileStart + level.tileSpanBp
            const tileKey = svBigBedBlockTileKey(key, chrom, level.id, tileStart, tileEnd)
            if (cacheRef.current.has(tileKey) || fetchSetRef.current.has(tileKey)) continue
            const distFromCenter = Math.abs((tileStart + level.tileSpanBp / 2) - center)
            const levelBonus = level.id === targetLevel.id ? 0 : 9000
            fetchPlans.push({ type: 'block', key: tileKey, trackKey: key, track, level, tileStart, tileEnd, priority: distFromCenter + levelBonus })
          }
        }
      }
    }

    setTrackData((prev) => mergeSvProjectedTrackData(prev, projectedData))
    setLoading(fetchPlans.length > 0)

    if (fetchPlans.length === 0) {
      setLoading(false)
      return undefined
    }

    fetchPlans.sort((a, b) => a.priority - b.priority)
    const blockPlans = fetchPlans.filter((plan) => plan.type === 'block').slice(0, 12)
    const featurePlans = fetchPlans.filter((plan) => plan.type === 'feature').slice(0, 14)

    const timer = setTimeout(() => {
      const blockGroups = new Map()
      for (const plan of blockPlans) {
        if (cacheRef.current.has(plan.key) || fetchSetRef.current.has(plan.key)) continue
        fetchSetRef.current.add(plan.key)
        if (!blockGroups.has(plan.trackKey)) blockGroups.set(plan.trackKey, { track: plan.track, keys: [], tiles: [] })
        const group = blockGroups.get(plan.trackKey)
        group.keys.push(plan.key)
        group.tiles.push({
          start: Math.max(0, Math.floor(plan.tileStart)),
          end: Math.ceil(plan.tileEnd),
          level_id: plan.level.id,
          block_bp: plan.level.blockBp,
        })
      }

      const featureGroups = new Map()
      for (const plan of featurePlans) {
        if (cacheRef.current.has(plan.key) || fetchSetRef.current.has(plan.key)) continue
        fetchSetRef.current.add(plan.key)
        if (!featureGroups.has(plan.trackKey)) featureGroups.set(plan.trackKey, { track: plan.track, keys: [], tiles: [] })
        const group = featureGroups.get(plan.trackKey)
        group.keys.push(plan.key)
        group.tiles.push({
          start: Math.max(0, Math.floor(plan.tileStart)),
          end: Math.ceil(plan.tileEnd),
          level_id: 'detail',
          max_features: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
        })
      }

      const pendingFetches = []
      const completeFetch = () => {
        setFetchRevision((value) => value + 1)
      }

      for (const [key, { track, keys, tiles }] of blockGroups.entries()) {
        pendingFetches.push(
          fetch(`${API_BASE}/api/browse/bigbed/block_tiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ genome: genomeId, path: track.path, chrom, tiles }),
          })
            .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
            .then((payload) => {
              const returnedChrom = payload?.chrom || chrom
              const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
              for (const tile of returned) {
                const tileStart = Math.max(0, Math.floor(Number(tile?.start) || 0))
                const tileEnd = Math.max(tileStart + 1, Math.ceil(Number(tile?.end) || 1))
                const levelId = String(tile?.level_id || 'L0')
                const cachedTile = {
                  ...(tile || {}),
                  mode: 'bigbed_blocks',
                  start: tileStart,
                  end: tileEnd,
                  block_spans: Array.isArray(tile?.block_spans) ? tile.block_spans : [],
                  has_data: tile?.has_data !== false,
                  error: '',
                }
                cacheRef.current.set(svBigBedBlockTileKey(key, chrom, levelId, tileStart, tileEnd), cachedTile)
                if (returnedChrom !== chrom) {
                  cacheRef.current.set(svBigBedBlockTileKey(key, returnedChrom, levelId, tileStart, tileEnd), cachedTile)
                }
              }
              resetRetry()
              completeFetch()
            })
            .catch((error) => {
              const message = error?.message || 'BigBed request failed'
              if (fetchEpochRef.current === epoch) {
                setTrackData((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), mode: 'bigbed_blocks', has_data: false, error: message } }))
                scheduleRetry()
              }
            })
            .finally(() => {
              for (const tileKey of keys) fetchSetRef.current.delete(tileKey)
            }),
        )
      }

      for (const [key, { track, keys, tiles }] of featureGroups.entries()) {
        pendingFetches.push(
          fetch(`${API_BASE}/api/browse/bigbed/feature_tiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              genome: genomeId,
              path: track.path,
              chrom,
              max_features_per_tile: SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
              tiles,
            }),
          })
            .then((res) => res.ok ? res.json() : res.json().then((payload) => { throw new Error(payload?.detail || `HTTP ${res.status}`) }))
            .then((payload) => {
              const returnedChrom = payload?.chrom || chrom
              const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
              for (const tile of returned) {
                const tileStart = Math.max(0, Math.floor(Number(tile?.start) || 0))
                const tileEnd = Math.max(tileStart + 1, Math.ceil(Number(tile?.end) || 1))
                const cachedTile = {
                  ...(tile || {}),
                  mode: 'bigbed_detail',
                  start: tileStart,
                  end: tileEnd,
                  features: Array.isArray(tile?.features) ? tile.features.map(svNormalizeBigBedFeature).filter(Boolean) : [],
                  has_data: tile?.has_data !== false,
                  error: '',
                }
                cacheRef.current.set(svBigBedFeatureTileKey(key, chrom, tileStart, tileEnd), cachedTile)
                if (returnedChrom !== chrom) {
                  cacheRef.current.set(svBigBedFeatureTileKey(key, returnedChrom, tileStart, tileEnd), cachedTile)
                }
              }
              resetRetry()
              completeFetch()
            })
            .catch((error) => {
              const message = error?.message || 'BigBed request failed'
              if (fetchEpochRef.current === epoch) {
                setTrackData((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), mode: 'bigbed_detail', has_data: false, error: message } }))
                scheduleRetry()
              }
            })
            .finally(() => {
              for (const tileKey of keys) fetchSetRef.current.delete(tileKey)
            }),
        )
      }

      if (!pendingFetches.length) {
        setLoading(false)
        return
      }

      Promise.allSettled(pendingFetches).finally(() => {
        if (fetchEpochRef.current === epoch) setLoading(false)
        if (cacheRef.current.size > SV_BIGBED_MAX_FEATURE_CACHE_TILES * 1.25) {
          const toDelete = Math.floor(cacheRef.current.size - SV_BIGBED_MAX_FEATURE_CACHE_TILES)
          let removed = 0
          for (const cacheKey of cacheRef.current.keys()) {
            if (removed >= toDelete) break
            cacheRef.current.delete(cacheKey)
            removed += 1
          }
        }
      })
    }, SV_DATA_TRACK_FETCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [
    activeTracks,
    trackSignature,
    viewWindow?.chrom,
    viewWindow?.start,
    viewWindow?.end,
    genomeId,
    plotWidth,
    detailEntryBpPerPx,
    fetchRevision,
  ])

  if (!activeTracks.length || !viewWindow) return null

  const span = Math.max(1, Number(viewWindow.end) - Number(viewWindow.start))
  const toX = (pos) => clamp(((Number(pos) - Number(viewWindow.start)) / span) * plotWidth, 0, plotWidth)
  const bg = isLight ? '#f8fbff' : '#101b2d'
  const border = isLight ? '#d7e2ee' : '#263a54'
  const muted = isLight ? '#5f738a' : '#8ba0b8'
  const axis = isLight ? 'rgba(96, 125, 159, 0.4)' : 'rgba(139, 160, 184, 0.3)'

  return (
    <div
      className="w-full flex-none"
      style={{
        height: totalHeight,
        background: bg,
        borderTop: `1px solid ${border}`,
        borderBottom: `1px solid ${border}`,
        position: 'relative',
      }}
    >
      <svg
        width={plotWidth}
        height={totalHeight}
        style={{ display: 'block' }}
        onClick={() => setClickedFeature(null)}
      >
        {activeTracks.map((track, index) => {
          const y = index * (trackHeight + SV_DATA_TRACK_GAP)
          const key = getSvDataTrackKey(track)
          const data = trackData[key]
          const label = getSvDataTrackLabel(track)
          const labelBg = isLight ? 'rgba(248,251,255,0.92)' : 'rgba(16,27,45,0.9)'
          const labelWidth = Math.min(170, Math.max(72, label.length * 6 + 18))
          const children = []
          children.push(<line key="axis" x1="0" x2={plotWidth} y1={y + trackHeight - 4} y2={y + trackHeight - 4} stroke={axis} strokeWidth="1" />)

          if (data?.mode === 'bigbed_blocks' && Array.isArray(data.block_spans)) {
            for (const [spanIndex, spanItem] of data.block_spans.entries()) {
              const x0 = toX(spanItem.start)
              const x1 = toX(spanItem.end)
              const w = Math.max(1.5, x1 - x0)
              children.push(
                <rect
                  key={`bb-${spanIndex}`}
                  x={x0}
                  y={y + 5}
                  width={w}
                  height={8}
                  rx={1}
                  fill={svBigBedTrackColor(spanItem, isLight)}
                />,
              )
            }
          } else if (data?.mode === 'bigbed_detail' && Array.isArray(data.features)) {
            for (const feature of data.features) {
              const x0 = toX(feature.start)
              const x1 = toX(feature.end)
              const w = Math.max(1.5, x1 - x0)
              const featureKey = feature._key || svBigBedFeatureKey(feature)
              const selected = clickedFeature?.trackKey === key && clickedFeature?.featureKey === featureKey
              children.push(
                <rect
                  key={`feature-${featureKey}`}
                  x={x0}
                  y={y + 5}
                  width={w}
                  height={10}
                  rx={1}
                  fill={selected ? (isLight ? 'rgba(14,116,144,0.92)' : 'rgba(125,211,252,0.9)') : svBigBedTrackColor(feature, isLight)}
                  stroke={selected ? (isLight ? '#0f172a' : '#e0f2fe') : 'transparent'}
                  strokeWidth={selected ? 1 : 0}
                  style={{ cursor: 'pointer' }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setClickedFeature({
                      trackKey: key,
                      featureKey,
                      trackLabel: label,
                      feature,
                      popupX: event.clientX,
                      popupY: event.clientY,
                    })
                  }}
                />,
              )
            }
          }

          return (
            <g key={key}>
              {children}
              <rect x="3" y={y + 2} width={labelWidth} height={trackHeight - 4} rx="2" fill={labelBg} />
              <text x="8" y={y + 12.5} fontSize="10" fontWeight="600" fill={muted}>
                {label}
              </text>
            </g>
          )
        })}
      </svg>
      {clickedFeature && (() => {
        const f = clickedFeature.feature || {}
        const popupW = 320
        const popupX = clamp(clickedFeature.popupX || 0, popupW / 2 + 8, (typeof window !== 'undefined' ? window.innerWidth : popupW + 16) - popupW / 2 - 8)
        const popupY = Math.max(8, (clickedFeature.popupY || 0) - 12)
        const rows = buildCuratedSvIntervalRows(f, {
          trackLabel: clickedFeature.trackLabel,
          chrom: viewWindow.chrom,
        })
          .map(([name, value]) => [name, abbreviateMetadataValue(value)])
        return (
          <div
            data-sv-metadata-popup="true"
            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
              left: popupX,
              top: popupY,
              transform: 'translate(-50%, -100%)',
              width: popupW,
              backgroundColor: 'rgba(17, 24, 39, 0.97)',
              color: '#f1f5f9',
              padding: '10px 14px',
              border: '1px solid rgba(255,255,255,0.1)',
              pointerEvents: 'auto',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div
              style={{
                position: 'absolute',
                bottom: -8,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderTop: '8px solid rgba(17,24,39,0.97)',
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
              }}
            />
            {rows.map(([name, value]) => (
              <div key={name} className="flex min-w-0 items-start gap-1.5">
                <span className="shrink-0">{name}</span>
                <span className="min-w-0 flex-1 break-all" style={{ fontWeight: 700 }}>{value.display}</span>
                {value.abbreviated && (
                  <button
                    type="button"
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-500/70 text-slate-100 hover:bg-slate-700"
                    title={`Copy full ${String(name || 'value').toLowerCase()}`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      copyToClipboard(value.full, String(name || 'value').toLowerCase())
                    }}
                  >
                    <CopyGlyph />
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })()}
      {copyToast && (
        <div className={`fixed bottom-6 left-1/2 z-[150] -translate-x-1/2 rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-xl ${isLight
          ? 'border-sky-300 bg-white text-sky-800'
          : 'border-sky-500/70 bg-gray-800 text-sky-200'
        }`}>
          {copyToast}
        </div>
      )}
      {showLoading && (
        <div
          className="pointer-events-none absolute right-2 top-1 text-[10px] font-semibold"
          style={{ color: muted }}
        >
          Loading
        </div>
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────
function StructuralVariationPairView({
  theme = 'dark',
  config,
  refSpecies,
  tgtSpecies,
  thirdSpecies = null,
  thirdGenomeId = '',
  refPillLabel = '',
  tgtPillLabel = '',
  thirdPillLabel = '',
  onRefPillClick = null,
  onTgtPillClick = null,
  onThirdPillClick = null,
  browserRefGene = null,
  browserRefViewport = null,
  selectedAlignmentId = '',
  selectedAnchorRegion = null,
  outputDir = '',
}) {
  const isLight = theme === 'light'

  // Refs
  const bandSvgRef     = useRef(null)   // top + bottom band SVG
  const interactiveAreaRef = useRef(null)
  const alignmentsRef  = useRef(null)   // <ens-sv-alignments> element
  const alignmentPanelRef = useRef(null)
  const topFeatureBandRef = useRef(null)
  const bottomFeatureBandRef = useRef(null)
  const prefetchTimerRef  = useRef(null)
  const wheelCommitTimerRef = useRef(null)
  const previewFrameRef = useRef(null)
  const pendingPreviewRef = useRef({ ref: null, tgt: null, syncAlignment: false })
  const alignmentWheelSessionRef = useRef({ gesture: null, target: 'both' })
  const featureWheelSessionRef = useRef({ gesture: null, side: null })
  const browsingControls = useBrowsingControls(config)
  const browsingControlsRef = useRef(browsingControls)
  useEffect(() => { browsingControlsRef.current = browsingControls }, [browsingControls])
  const featureBandDragRef = useRef(null)
  const displayRefWindowRef = useRef(null)
  const displayTgtWindowRef = useRef(null)
  const refChromSizeRef = useRef(null)
  const tgtChromSizeRef = useRef(null)
  const autoCenteredViewKeyRef = useRef('')
  const pendingDefaultCenterKeyRef = useRef('')
  const seededAnchorRegionKeyRef = useRef('')
  const selectionDragRef = useRef(null)
  const seedReasonRef = useRef('')
  const seededGeneRef     = useRef('')
  const seededViewportRef = useRef('')
  const bufferDataRef     = useRef(null)
  const fetchTokenRef     = useRef(0)
  const inFlightFetchKeyRef = useRef('')
  const bufferDataAbortRef = useRef(null)
  const lastFetchKeyRef   = useRef('')
  const bufferRetryRef = useRef({ key: '', attempt: 0, timer: null })
  const featureTrackCacheRef = useRef({ reference: null, target: null })
  const featureTrackTokenRef = useRef({ reference: 0, target: 0 })
  const featureTrackAbortRef = useRef({ reference: null, target: null })
  const featureTrackRetryRef = useRef({
    reference: { key: '', attempt: 0, timer: null },
    target: { key: '', attempt: 0, timer: null },
  })

  // State
  const [panelWidth,  setPanelWidth]  = useState(0)
  const [bufferData,  setBufferData]  = useState(null)   // structural context from /api/sv/view
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [statusText,  setStatusText]  = useState('')
  const [viewRefWindow, setViewRefWindow] = useState(null)
  const [viewTgtWindow, setViewTgtWindow] = useState(null)
  const [previewRefWindow, setPreviewRefWindow] = useState(null)
  const [previewTgtWindow, setPreviewTgtWindow] = useState(null)
  const [clickedVariant, setClickedVariant] = useState(null)
  const [featureTrackData, setFeatureTrackData] = useState({ reference: [], target: [] })
  const [featureTrackLoading, setFeatureTrackLoading] = useState({ reference: false, target: false })
  const [alignmentTrackLoading, setAlignmentTrackLoading] = useState(false)
  const [defaultStartPhase, setDefaultStartPhase] = useState('idle')
  const [isBoxSelectMode, setIsBoxSelectMode] = useState(false)
  const [isSelectingRect, setIsSelectingRect] = useState(false)
  const [selectionRect, setSelectionRect] = useState(null)
  const [hideInactiveFeatureTracks, setHideInactiveFeatureTracks] = useState(Boolean(config?.sv_hide_inactive_tracks))
  const [compactTracks, setCompactTracks] = useState(false)
  const [showBigWigTracks, setShowBigWigTracks] = useState(false)
  const [showBigBedTracks, setShowBigBedTracks] = useState(false)
  const alignmentPanelHeight = compactTracks ? ALIGNMENT_PANEL_COMPACT_HEIGHT : ALIGNMENT_PANEL_HEIGHT
  // Keep ref in sync for stale-closure safety
  useEffect(() => { bufferDataRef.current = bufferData }, [bufferData])
  useEffect(() => {
    setHideInactiveFeatureTracks(Boolean(config?.sv_hide_inactive_tracks))
  }, [config?.sv_hide_inactive_tracks])

  const refAssembly = getSvRuntimeAssembly(refSpecies)
  const tgtAssembly = getSvRuntimeAssembly(tgtSpecies)
  const featureTrackGenomeIds = useMemo(() => resolveSvFeatureTrackGenomeIds({
    referenceSpecies: refSpecies,
    topSpecies: tgtSpecies,
  }), [refSpecies, tgtSpecies])
  const referenceBrowseGenomeId = featureTrackGenomeIds.reference
  const targetBrowseGenomeId = featureTrackGenomeIds.top
  const runtimeOutputDir = outputDir || config?.output_dir || ''
  const alignmentsComponentKey = `${selectedAlignmentId}|${refAssembly}|${tgtAssembly}|${viewRefWindow?.chrom || ''}`
  const svLoadingMode = useMemo(() => getSvLoadingMode(), [])
  const endpointsRef = useRef({
    alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedAlignmentId, runtimeOutputDir),
    variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedAlignmentId, runtimeOutputDir),
    genomeBrowser: '',
  })
  const endpointsKeyRef = useRef(`${selectedAlignmentId}|${runtimeOutputDir}`)
  const getPairRuntimeEndpoints = useCallback(() => {
    const nextKey = `${selectedAlignmentId}|${runtimeOutputDir}`
    if (endpointsKeyRef.current !== nextKey) {
      endpointsKeyRef.current = nextKey
      endpointsRef.current = {
        alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedAlignmentId, runtimeOutputDir),
        variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedAlignmentId, runtimeOutputDir),
        genomeBrowser: '',
      }
    }
    return endpointsRef.current
  }, [selectedAlignmentId, runtimeOutputDir])
  useEffect(() => {
    getPairRuntimeEndpoints()
  }, [getPairRuntimeEndpoints])

  const hasTwoGenomes = Boolean(refSpecies && tgtSpecies)
  const looksLikeSvPair = useMemo(() => {
    return Boolean(selectedAlignmentId)
  }, [selectedAlignmentId])

  const themeClasses = {
    panel: isLight ? 'bg-white border border-gray-200 text-gray-900' : 'bg-[#1E2938] border border-gray-700 text-gray-100',
    muted: isLight ? 'text-gray-600' : 'text-gray-400',
  }
  // Each side of the comparison is drawn in its own genome's colour rather than
  // in "the first colour" and "the second colour", so a genome looks the same
  // here as it does in the browser whichever side it happens to be on.
  const referenceGenomeColor = useMemo(() => resolveGenomeColor(config, refSpecies), [config, refSpecies])
  const targetGenomeColor = useMemo(() => resolveGenomeColor(config, tgtSpecies), [config, tgtSpecies])

  // ── Fetch gene/chrom info from /api/sv/view (NOT used for ribbons) ──────────
  const requestBufferData = useCallback(async (refWindow, tgtWindow, reason = 'view') => {
    if (!hasTwoGenomes || !looksLikeSvPair || !refWindow) return

    const refSpan = Math.max(1, refWindow.end - refWindow.start)
    const refPad  = Math.max(BUFFER_PAD_MIN, Math.round(refSpan * BUFFER_PAD_RATIO))
    const refStep = Math.max(20_000, Math.round(refSpan * 0.12))
    const reqRefStart = Math.max(1, quantizeFloor(refWindow.start - refPad, refStep))
    const reqRefEnd   = quantizeCeil(refWindow.end + refPad, refStep)

    const params = new URLSearchParams({
      ref_assembly: refAssembly,
      tgt_assembly: tgtAssembly,
      ref_chrom:    refWindow.chrom,
      ref_start:    String(reqRefStart),
      ref_end:      String(reqRefEnd),
      ref_browse_genome: referenceBrowseGenomeId,
      tgt_browse_genome: targetBrowseGenomeId,
      max_blocks:   '200',
    })
    if (selectedAlignmentId) params.set('alignment_id', selectedAlignmentId)
    if (outputDir || config?.output_dir) params.set('output_dir', outputDir || config?.output_dir || '')

    const fetchKey = params.toString()
    if (fetchKey === lastFetchKeyRef.current || fetchKey === inFlightFetchKeyRef.current) return
    if (bufferRetryRef.current.key !== fetchKey) {
      if (bufferRetryRef.current.timer) clearTimeout(bufferRetryRef.current.timer)
      bufferRetryRef.current = { key: fetchKey, attempt: 0, timer: null }
    }

    const token = ++fetchTokenRef.current
    inFlightFetchKeyRef.current = fetchKey
    bufferDataAbortRef.current?.abort?.()
    const abortController = new AbortController()
    bufferDataAbortRef.current = abortController
    if (!bufferDataRef.current) setLoading(true)

    try {
      setError(null)
      const res  = await fetch(`${API_BASE}/api/sv/view?${fetchKey}`, { signal: abortController.signal })
      const data = await res.json().catch(() => null)
      if (token !== fetchTokenRef.current) return

      if (!res.ok) {
        throw new Error(data?.detail || `SV request failed (${res.status})`)
      }
      if (!data?.supported) {
        setStatusText(data?.detail || 'SV dataset not available for this genome pair.')
        return
      }

      setBufferData(data)
      lastFetchKeyRef.current = fetchKey
      bufferRetryRef.current.attempt = 0
      if (bufferRetryRef.current.timer) {
        clearTimeout(bufferRetryRef.current.timer)
        bufferRetryRef.current.timer = null
      }
      setStatusText('')
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== fetchTokenRef.current) return
      if (isFetchNetworkError(e)) {
        setStatusText(bufferDataRef.current
          ? 'Backend temporarily unavailable; keeping the last loaded SV region.'
          : 'Backend unavailable. Start or restart the backend to load structural variation data.')
        setError(null)
        if (!bufferRetryRef.current.timer && bufferRetryRef.current.attempt < SV_TRANSIENT_RETRY_LIMIT) {
          bufferRetryRef.current.attempt += 1
          const delay = getSvTransientRetryDelay(bufferRetryRef.current.attempt)
          bufferRetryRef.current.timer = setTimeout(() => {
            bufferRetryRef.current.timer = null
            if (bufferRetryRef.current.key === fetchKey) {
              requestBufferData(refWindow, tgtWindow, reason)
            }
          }, delay)
        }
        return
      }
      setError(e?.message || 'Failed to load structural variation data.')
    } finally {
      if (inFlightFetchKeyRef.current === fetchKey) inFlightFetchKeyRef.current = ''
      if (bufferDataAbortRef.current === abortController) {
        bufferDataAbortRef.current = null
      }
      if (token === fetchTokenRef.current) {
        setLoading(false)
      }
    }
  }, [hasTwoGenomes, looksLikeSvPair, refAssembly, tgtAssembly, referenceBrowseGenomeId, targetBrowseGenomeId, selectedAlignmentId, outputDir, config?.output_dir])

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
    if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    pendingPreviewRef.current = { ref: null, tgt: null, syncAlignment: false }
    bufferDataAbortRef.current?.abort?.()
    if (bufferRetryRef.current.timer) clearTimeout(bufferRetryRef.current.timer)
    featureTrackAbortRef.current.reference?.abort?.()
    featureTrackAbortRef.current.target?.abort?.()
    if (featureTrackRetryRef.current.reference.timer) clearTimeout(featureTrackRetryRef.current.reference.timer)
    if (featureTrackRetryRef.current.target.timer) clearTimeout(featureTrackRetryRef.current.target.timer)
  }, [svLoadingMode])

  // ── Panel resize observer ──────────────────────────────────────────────────
  useEffect(() => {
    const node = bandSvgRef.current
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      const nextWidth = Math.max(760, Math.round(rect.width))
      setPanelWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // ── Default locus seed ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasTwoGenomes || viewRefWindow || selectedAnchorRegion?.chrom) return
    let cancelled = false
    const loadDefault = async () => {
      try {
        const res  = await fetch(`${API_BASE}/api/browse/default_locus?genome=reference`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        seedReasonRef.current = 'default'
        pendingDefaultCenterKeyRef.current = ''
        setDefaultStartPhase('selecting')
        setStatusText('')
        setViewRefWindow(constrainWindowToZoomLimits({ chrom: data.chrom, start: data.start, end: data.end }))
      } catch (e) {
        if (!cancelled && isFetchNetworkError(e)) {
          setStatusText('Backend unavailable. Start or restart the backend to load structural variation data.')
          setError(null)
        }
      }
    }
    loadDefault()
    return () => { cancelled = true }
  }, [hasTwoGenomes, viewRefWindow, selectedAnchorRegion?.chrom])

  useEffect(() => {
    if (!hasTwoGenomes || !selectedAnchorRegion?.chrom) return
    const regionKey = `${selectedAlignmentId}|${getSvRegionKey(selectedAnchorRegion)}|${selectedAnchorRegion?.start || ''}-${selectedAnchorRegion?.end || ''}`
    if (seededAnchorRegionKeyRef.current === regionKey) return
    let cancelled = false
    const applyAnchorRegion = async () => {
      const next = await buildWindowForAnchorRegion(
        selectedAnchorRegion,
        bufferData?.ref_chrom_sizes || {},
        viewRefWindow,
        refChromSizeRef.current,
      )
      if (cancelled || !next) return
      seededAnchorRegionKeyRef.current = regionKey
      seedReasonRef.current = 'anchor-region'
      pendingDefaultCenterKeyRef.current = ''
      setDefaultStartPhase('idle')
      setStatusText('')
      setClickedVariant(null)
      setPreviewRefWindow(null)
      setPreviewTgtWindow(null)
      setViewRefWindow(next)
      autoCenteredViewKeyRef.current = ''
      setViewTgtWindow(null)
      requestBufferData(next, null, 'anchor-region')
    }
    applyAnchorRegion()
    return () => { cancelled = true }
  }, [
    hasTwoGenomes,
    selectedAlignmentId,
    selectedAnchorRegion,
    selectedAnchorRegion?.chrom,
    bufferData?.ref_chrom_sizes,
    viewRefWindow,
    requestBufferData,
  ])

  // ── Seed from focused gene ─────────────────────────────────────────────────
  useEffect(() => {
    if (!hasTwoGenomes || !browserRefGene?.chrom) return
    const key = `${browserRefGene.id || ''}|${browserRefGene.chrom}|${browserRefGene.start}|${browserRefGene.end}`
    if (key === seededGeneRef.current) return
    seededGeneRef.current = key
    seededViewportRef.current = ''
    const geneSpan = Math.max(1, (browserRefGene.end || 0) - (browserRefGene.start || 0))
    const span   = clamp(Math.round(geneSpan * 8), 120_000, 5_000_000)
    const center = Math.round(((browserRefGene.start || 0) + (browserRefGene.end || 0)) / 2)
    const next = centerWindowOnRange(browserRefGene.chrom, center, span, refChromSizeRef.current, 1)
    seedReasonRef.current = 'gene'
    pendingDefaultCenterKeyRef.current = ''
    setDefaultStartPhase('idle')
    setViewRefWindow(next)
    autoCenteredViewKeyRef.current = ''
    setViewTgtWindow(null)
    requestBufferData(next, null, 'gene')
  }, [hasTwoGenomes, browserRefGene, requestBufferData])

  // ── Seed from browser viewport ─────────────────────────────────────────────
  useEffect(() => {
    if (!hasTwoGenomes || browserRefGene?.chrom) return
    if (!browserRefViewport?.chrom || !Number.isFinite(browserRefViewport.start) || !Number.isFinite(browserRefViewport.end)) return
    if (browserRefViewport.end <= browserRefViewport.start) return
    const key = `${browserRefViewport.chrom}|${Math.round(browserRefViewport.start)}|${Math.round(browserRefViewport.end)}`
    if (key === seededViewportRef.current) return
    seededViewportRef.current = key
    const next = constrainWindowToZoomLimits({
      chrom: browserRefViewport.chrom,
      start: Math.max(1, Math.round(browserRefViewport.start)),
      end: Math.max(Math.max(1, Math.round(browserRefViewport.start)) + 1, Math.round(browserRefViewport.end)),
    }, refChromSizeRef.current)
    seedReasonRef.current = 'viewport'
    pendingDefaultCenterKeyRef.current = ''
    setDefaultStartPhase('idle')
    setViewRefWindow(next)
    autoCenteredViewKeyRef.current = ''
    setViewTgtWindow(null)
    requestBufferData(next, null, 'viewport')
  }, [hasTwoGenomes, browserRefGene, browserRefViewport, requestBufferData])

  // ── Prefetch buffer data when approaching the edge ─────────────────────────
  useEffect(() => {
    if (!hasTwoGenomes || !looksLikeSvPair || !viewRefWindow) return
    if (!bufferData) {
      requestBufferData(viewRefWindow, viewTgtWindow, 'initial')
      return
    }
    const bufferRef = { chrom: bufferData.ref_chrom, start: bufferData.ref_start, end: bufferData.ref_end }
    let needFetch = false
    if (!svBufferMatchesAlignment(bufferData, selectedAlignmentId)) {
      needFetch = true
    } else if (!bufferRef || bufferRef.chrom !== viewRefWindow.chrom) {
      needFetch = true
    } else {
      const margin = Math.max(25_000, Math.round((bufferRef.end - bufferRef.start) * BUFFER_MARGIN_RATIO))
      if (viewRefWindow.start < (bufferRef.start + margin) || viewRefWindow.end > (bufferRef.end - margin)) {
        needFetch = true
      }
    }
    if (needFetch) {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
      prefetchTimerRef.current = setTimeout(() => {
        requestBufferData(viewRefWindow, viewTgtWindow, 'prefetch')
      }, PREFETCH_DEBOUNCE_MS)
      return () => {
        if (prefetchTimerRef.current) {
          clearTimeout(prefetchTimerRef.current)
          prefetchTimerRef.current = null
        }
      }
    }
    return undefined
  }, [hasTwoGenomes, looksLikeSvPair, viewRefWindow, viewTgtWindow, bufferData, requestBufferData])

  // ── Auto-derive tight target window from visible segments ──────────────────
  const segmentsRaw = useMemo(
    () => (bufferData?.segments?.length ? bufferData.segments : (bufferData?.blocks || [])),
    [bufferData],
  )
  const pairAnnotationAlignments = useMemo(
    () => svBlocksToFeatureBandAlignments(bufferData?.blocks || []),
    [bufferData],
  )
  const referenceDataTracks = useMemo(
    () => getSvDataTracksForSide(bufferData, 'reference'),
    [bufferData],
  )
  const targetDataTracks = useMemo(
    () => getSvDataTracksForSide(bufferData, 'target'),
    [bufferData],
  )
  const referenceSignalTracks = useMemo(
    () => getSvSignalTracksForSide(bufferData, 'reference'),
    [bufferData],
  )
  const targetSignalTracks = useMemo(
    () => getSvSignalTracksForSide(bufferData, 'target'),
    [bufferData],
  )
  const fallbackTgtWindow = useMemo(
    () => (bufferData ? { chrom: bufferData.tgt_chrom, start: bufferData.tgt_start, end: bufferData.tgt_end } : null),
    [bufferData],
  )
  const autoTgtWindow = useMemo(() => {
    if (!viewRefWindow || !segmentsRaw.length || !bufferData) return null
    let minT = Infinity
    let maxT = -Infinity
    for (const seg of segmentsRaw) {
      if (!overlaps(seg.ref_start, seg.ref_end, viewRefWindow.start, viewRefWindow.end)) continue
      const lo = Math.min(seg.tgt_start, seg.tgt_end)
      const hi = Math.max(seg.tgt_start, seg.tgt_end)
      if (lo < minT) minT = lo
      if (hi > maxT) maxT = hi
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) return fallbackTgtWindow
    const refSpan = Math.max(1, viewRefWindow.end - viewRefWindow.start)
    const targetCenter = (minT + maxT) / 2
    const targetChromSize = getResolvedChromSize(bufferData?.tgt_chrom_sizes, bufferData?.tgt_chrom)
    return centerWindowOnRange(bufferData.tgt_chrom, targetCenter, refSpan, targetChromSize, 1)
  }, [viewRefWindow, segmentsRaw, bufferData, fallbackTgtWindow])

  const resolvedTargetChrom = useMemo(
    () => bufferData?.tgt_chrom || viewTgtWindow?.chrom || autoTgtWindow?.chrom || fallbackTgtWindow?.chrom || '',
    [bufferData?.tgt_chrom, viewTgtWindow?.chrom, autoTgtWindow?.chrom, fallbackTgtWindow?.chrom],
  )
  const normalizedViewTgtWindow = useMemo(
    () => withWindowChrom(viewTgtWindow, resolvedTargetChrom),
    [viewTgtWindow, resolvedTargetChrom],
  )
  const normalizedPreviewTgtWindow = useMemo(
    () => withWindowChrom(previewTgtWindow, resolvedTargetChrom),
    [previewTgtWindow, resolvedTargetChrom],
  )
  const normalizedAutoTgtWindow = useMemo(
    () => withWindowChrom(autoTgtWindow, resolvedTargetChrom),
    [autoTgtWindow, resolvedTargetChrom],
  )
  const normalizedFallbackTgtWindow = useMemo(
    () => withWindowChrom(fallbackTgtWindow, resolvedTargetChrom),
    [fallbackTgtWindow, resolvedTargetChrom],
  )

  const baseTgtWindow = normalizedViewTgtWindow || normalizedAutoTgtWindow || normalizedFallbackTgtWindow
  const displayRefWindow = previewRefWindow || viewRefWindow
  const displayTgtWindow = normalizedPreviewTgtWindow || baseTgtWindow
  const alignmentRegionLength = useMemo(() => {
    return getResolvedChromSize(bufferData?.ref_chrom_sizes, viewRefWindow?.chrom)
      || 500_000_000
  }, [viewRefWindow?.chrom, bufferData])
  const altRegionLength = useMemo(() => {
    return getResolvedChromSize(bufferData?.tgt_chrom_sizes, baseTgtWindow?.chrom)
      || 500_000_000
  }, [baseTgtWindow?.chrom, bufferData])
  const refChromSize = useMemo(() => {
    return getResolvedChromSize(bufferData?.ref_chrom_sizes, viewRefWindow?.chrom)
  }, [viewRefWindow?.chrom, bufferData])
  const tgtChromSize = useMemo(() => {
    return getResolvedChromSize(bufferData?.tgt_chrom_sizes, baseTgtWindow?.chrom)
  }, [baseTgtWindow?.chrom, bufferData])

  useEffect(() => {
    displayRefWindowRef.current = displayRefWindow
  }, [displayRefWindow])

  useEffect(() => {
    displayTgtWindowRef.current = displayTgtWindow
  }, [displayTgtWindow])

  useEffect(() => {
    refChromSizeRef.current = refChromSize
  }, [refChromSize])

  useEffect(() => {
    tgtChromSizeRef.current = tgtChromSize
  }, [tgtChromSize])

  useEffect(() => {
    if (!resolvedTargetChrom) return
    setViewTgtWindow((prev) => {
      if (!prev || prev.chrom) return prev
      return { ...prev, chrom: resolvedTargetChrom }
    })
    setPreviewTgtWindow((prev) => {
      if (!prev || prev.chrom) return prev
      return { ...prev, chrom: resolvedTargetChrom }
    })
  }, [resolvedTargetChrom])

  const requestCanonicalTrackData = useCallback(async (genomeKey, window) => {
    if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) {
      setFeatureTrackData((prev) => updateObjectSlot(prev, genomeKey, []))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, genomeKey, false))
      return
    }

    const requestGenomeId = genomeKey === 'reference' ? referenceBrowseGenomeId : targetBrowseGenomeId
    const genomeIdentity = genomeKey === 'reference'
      ? (refAssembly || requestGenomeId)
      : (tgtAssembly || requestGenomeId)
    const chromSize = genomeKey === 'reference' ? refChromSizeRef.current : tgtChromSizeRef.current
    const effectiveChromSize = chromSize || 500_000_000
    const requestWindow = svLoadingMode === 'eager'
      ? (buildChromWindow(window.chrom, effectiveChromSize, 1) || window)
      : window
    const cacheKey = `${SV_AUX_TRACK_CACHE_VERSION}:${svLoadingMode}:${genomeKey}:${genomeIdentity}:${requestGenomeId}:${getWindowKey(requestWindow)}`
    const retryState = featureTrackRetryRef.current[genomeKey]
    if (retryState.key !== cacheKey) {
      if (retryState.timer) clearTimeout(retryState.timer)
      Object.assign(retryState, { key: cacheKey, attempt: 0, timer: null })
    }
    const cached = featureTrackCacheRef.current[genomeKey]
    if (cached?.key === cacheKey) {
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, genomeKey, cached.entries))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, genomeKey, false))
      return
    }

    featureTrackTokenRef.current[genomeKey] = (featureTrackTokenRef.current[genomeKey] || 0) + 1
    const token = featureTrackTokenRef.current[genomeKey]
    featureTrackAbortRef.current[genomeKey]?.abort?.()
    const abortController = new AbortController()
    featureTrackAbortRef.current[genomeKey] = abortController
    setFeatureTrackLoading((prev) => updateObjectSlot(prev, genomeKey, true))

    try {
      const params = new URLSearchParams({
        genome: requestGenomeId,
        chrom: requestWindow.chrom,
        start: String(requestWindow.start),
        end: String(requestWindow.end),
      })
      const res = await fetch(`${API_BASE}/api/browse/canonical_transcripts?${params.toString()}`, {
        signal: abortController.signal,
      })
      if (!res.ok) {
        throw new Error(`Canonical transcript request failed (${res.status})`)
      }
      const data = await res.json()
      if (token !== featureTrackTokenRef.current[genomeKey]) return
      featureTrackCacheRef.current[genomeKey] = {
        key: cacheKey,
        entries: Array.isArray(data) ? data : [],
      }
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, genomeKey, Array.isArray(data) ? data : []))
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== featureTrackTokenRef.current[genomeKey]) return
      console.warn(`Failed to load ${requestGenomeId} canonical transcripts`, e)
      if (!retryState.timer && retryState.attempt < SV_TRANSIENT_RETRY_LIMIT) {
        retryState.attempt += 1
        retryState.timer = setTimeout(() => {
          retryState.timer = null
          if (retryState.key === cacheKey) requestCanonicalTrackData(genomeKey, window)
        }, getSvTransientRetryDelay(retryState.attempt))
      }
    } finally {
      if (featureTrackAbortRef.current[genomeKey] === abortController && token === featureTrackTokenRef.current[genomeKey]) {
        featureTrackAbortRef.current[genomeKey] = null
      }
      if (token === featureTrackTokenRef.current[genomeKey] && !retryState.timer) {
        setFeatureTrackLoading((prev) => updateObjectSlot(prev, genomeKey, false))
      }
    }
  }, [referenceBrowseGenomeId, targetBrowseGenomeId, refAssembly, tgtAssembly, svLoadingMode])

  useEffect(() => {
    if (!viewRefWindow && !baseTgtWindow) return

    if (viewRefWindow) {
      requestCanonicalTrackData('reference', viewRefWindow)
    }
    if (baseTgtWindow) {
      requestCanonicalTrackData('target', baseTgtWindow)
    } else if (viewRefWindow) {
      setFeatureTrackData((prev) => updateObjectSlot(prev, 'target', []))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, 'target', true))
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    baseTgtWindow?.chrom,
    baseTgtWindow?.start,
    baseTgtWindow?.end,
    tgtChromSize,
    requestCanonicalTrackData,
  ])

  const syncAlignmentViewport = useCallback((refWindow, tgtWindow) => {
    const el = alignmentsRef.current
    if (!el || !refWindow) return
    el.endpoints = getPairRuntimeEndpoints()
    el.referenceGenomeId = refAssembly
    el.altGenomeId = tgtAssembly
    el.imageHeight = alignmentPanelHeight
    el.loadingStrategy = svLoadingMode
    // The web component has no access to React config, so the resolved scheme
    // is handed to it as a property.
    el.browsingControls = browsingControls
    el.regionName = refWindow.chrom
    el.altRegionName = tgtWindow?.chrom || ''
    el.regionLength = alignmentRegionLength
    el.start = refWindow.start
    el.end = refWindow.end
    el.altRegionLength = altRegionLength
    if (tgtWindow) {
      el.altStart = tgtWindow.start
      el.altEnd = tgtWindow.end
    } else {
      el.altStart = 0
      el.altEnd = 0
    }
  }, [getPairRuntimeEndpoints, refAssembly, tgtAssembly, alignmentPanelHeight, svLoadingMode, alignmentRegionLength, altRegionLength, browsingControls])

  const clearPendingViewportCommit = useCallback(() => {
    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current)
      wheelCommitTimerRef.current = null
    }
  }, [])

  const pushPreviewViewport = useCallback((nextRefWindow, nextTgtWindow, options = {}) => {
    const { syncAlignment = true } = options
    displayRefWindowRef.current = nextRefWindow
    displayTgtWindowRef.current = nextTgtWindow
    setClickedVariant(null)

    pendingPreviewRef.current = {
      ref: nextRefWindow,
      tgt: nextTgtWindow,
      syncAlignment,
    }

    if (!previewFrameRef.current) {
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null
        const pending = pendingPreviewRef.current
        pendingPreviewRef.current = { ref: null, tgt: null, syncAlignment: false }
        if (pending.ref) setPreviewRefWindow(pending.ref)
        if (pending.tgt) setPreviewTgtWindow(pending.tgt)
        if (pending.syncAlignment) {
          syncAlignmentViewport(pending.ref, pending.tgt)
        }
      })
    }
  }, [syncAlignmentViewport])

  const commitViewportChange = useCallback((nextRefWindow, nextTgtWindow) => {
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    pendingPreviewRef.current = { ref: null, tgt: null, syncAlignment: false }
    setPreviewRefWindow(null)
    setPreviewTgtWindow(null)
    if (nextRefWindow) {
      setViewRefWindow(nextRefWindow)
    }
    if (nextTgtWindow) {
      setViewTgtWindow(nextTgtWindow)
    }
  }, [])

  const scheduleViewportCommit = useCallback((nextRefWindow, nextTgtWindow) => {
    clearPendingViewportCommit()
    wheelCommitTimerRef.current = setTimeout(() => {
      wheelCommitTimerRef.current = null
      commitViewportChange(nextRefWindow, nextTgtWindow)
    }, WHEEL_COMMIT_DEBOUNCE_MS)
  }, [clearPendingViewportCommit, commitViewportChange])

  // ── Sync React state → web component props ────────────────────────────────
  // Push all props imperatively so the custom element sees a consistent set
  // of endpoints, genome ids, and coordinates in the same update cycle.
  useEffect(() => {
    const el = alignmentsRef.current
    if (!el || !viewRefWindow) return
    const nextEndpoints = getPairRuntimeEndpoints()
    const applyProps = () => {
      const current = alignmentsRef.current
      if (!current) return
      current.endpoints = nextEndpoints
      current.referenceGenomeId = refAssembly
      current.altGenomeId = tgtAssembly
      current.loadingStrategy = svLoadingMode
      current.regionName = viewRefWindow.chrom
      current.altRegionName = baseTgtWindow?.chrom || ''
      current.regionLength = alignmentRegionLength
      current.start = viewRefWindow.start
      current.end = viewRefWindow.end
      current.altRegionLength = altRegionLength
      current.altStart = baseTgtWindow?.start ?? 0
      current.altEnd = baseTgtWindow?.end ?? 0
    }
    applyProps()
    const frame = requestAnimationFrame(applyProps)
    return () => cancelAnimationFrame(frame)
  }, [
    refAssembly,
    tgtAssembly,
    viewRefWindow,
    baseTgtWindow,
    alignmentRegionLength,
    altRegionLength,
    svLoadingMode,
    selectedAlignmentId,
    runtimeOutputDir,
    getPairRuntimeEndpoints,
  ])

  useEffect(() => {
    const panel = alignmentPanelRef.current
    if (!panel) return

    const handleWheel = (e) => {
      if (isBoxSelectMode || isSelectingRect) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation?.()
        return
      }
      const currentRefWindow = displayRefWindowRef.current
      const currentTgtWindow = displayTgtWindowRef.current
      if (!currentRefWindow) return

      const wheel = readWheelEvent(e, { pageHeight: window.innerHeight })
      const session = alignmentWheelSessionRef.current
      const gesture = beginWheelGesture(session.gesture, wheel, wheel.ts || performance.now())
      if (!gesture.continues) session.target = 'both'

      const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
        canScrollPage: Boolean(findNearestScrollable(e.target || panel)),
        gesture,
      })
      markWheelHandled(e)
      session.gesture = { ...gesture, mode: intent.nextGestureMode || gesture.mode }
      if (intent.preventDefault) e.preventDefault()
      if (intent.stopPropagation) {
        e.stopPropagation()
        e.stopImmediatePropagation?.()
      }
      if (intent.type !== 'zoom' && intent.type !== 'pan') return

      const rect = panel.getBoundingClientRect()
      if (rect.width <= 0) return

      const anchorFraction = intent.anchor === 'center'
        ? 0.5
        : clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const offsetY = e.clientY - rect.top
      if (intent.type === 'pan' && session.target === 'both') {
        // A pan that starts over one of the two rulers moves only that genome.
        session.target = offsetY <= RULER_HEIGHT
          ? 'reference'
          : rect.height - offsetY <= RULER_HEIGHT
            ? 'alt'
            : 'both'
      }
      const gestureTarget = intent.type === 'pan' ? session.target : 'both'

      let nextRefWindow = currentRefWindow
      let nextTgtWindow = currentTgtWindow

      if (intent.type === 'zoom') {
        if (currentRefWindow) {
          nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
        }
        if (currentTgtWindow) {
          nextTgtWindow = zoomWindowAround(currentTgtWindow, intent.factor, anchorFraction, 1, tgtChromSizeRef.current)
        }
      } else {
        if (gestureTarget !== 'alt') {
          nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
        }
        if (gestureTarget !== 'reference' && currentTgtWindow) {
          nextTgtWindow = panWindowByPixels(currentTgtWindow, intent.dxPx, rect.width, 1, tgtChromSizeRef.current)
        }
      }

      pushPreviewViewport(nextRefWindow, nextTgtWindow)
      scheduleViewportCommit(nextRefWindow, nextTgtWindow)
    }

    panel.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => {
      panel.removeEventListener('wheel', handleWheel, true)
    }
  }, [pushPreviewViewport, scheduleViewportCommit, isBoxSelectMode, isSelectingRect])

  useEffect(() => {
    const interactiveArea = interactiveAreaRef.current
    if (!interactiveArea) return

    const handleWorkspaceWheel = (event) => {
      if (isBoxSelectMode || isSelectingRect) {
        event.preventDefault()
        return
      }
      const currentRefWindow = displayRefWindowRef.current
      const currentTgtWindow = displayTgtWindowRef.current
      if (!currentRefWindow) return

      const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
      const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
        canScrollPage: Boolean(findNearestScrollable(event.target || interactiveArea)),
      })
      markWheelHandled(event)
      if (intent.preventDefault) event.preventDefault()
      if (intent.stopPropagation) {
        event.stopPropagation()
        event.stopImmediatePropagation?.()
      }
      if (intent.type !== 'zoom' && intent.type !== 'pan') return

      const rect = interactiveArea.getBoundingClientRect()
      if (rect.width <= 0) return
      const anchorFraction = intent.anchor === 'center'
        ? 0.5
        : clamp((event.clientX - rect.left) / rect.width, 0, 1)

      let nextRefWindow = currentRefWindow
      let nextTgtWindow = currentTgtWindow
      if (intent.type === 'zoom') {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
        if (currentTgtWindow) {
          nextTgtWindow = zoomWindowAround(currentTgtWindow, intent.factor, anchorFraction, 1, tgtChromSizeRef.current)
        }
      } else {
        nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
        if (currentTgtWindow) {
          nextTgtWindow = panWindowByPixels(currentTgtWindow, intent.dxPx, rect.width, 1, tgtChromSizeRef.current)
        }
      }

      pushPreviewViewport(nextRefWindow, nextTgtWindow)
      scheduleViewportCommit(nextRefWindow, nextTgtWindow)
    }

    interactiveArea.addEventListener('wheel', handleWorkspaceWheel, { passive: false, capture: true })
    return () => {
      interactiveArea.removeEventListener('wheel', handleWorkspaceWheel, true)
    }
  }, [isBoxSelectMode, isSelectingRect, pushPreviewViewport, scheduleViewportCommit, viewRefWindow])

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return

      const deltaX = event.clientX - dragState.startX
      if (!deltaX) return

      dragState.dragging = true
      event.preventDefault()

      let nextRefWindow = dragState.startRefWindow
      let nextTgtWindow = dragState.startTgtWindow
      if (dragState.side === 'reference' && dragState.startRefWindow) {
        nextRefWindow = panWindowByPixels(dragState.startRefWindow, -deltaX, dragState.width, 1, refChromSizeRef.current)
      } else if (dragState.side === 'target' && dragState.startTgtWindow) {
        nextTgtWindow = panWindowByPixels(dragState.startTgtWindow, -deltaX, dragState.width, 1, tgtChromSizeRef.current)
      }

      dragState.currentRefWindow = nextRefWindow
      dragState.currentTgtWindow = nextTgtWindow
      pushPreviewViewport(nextRefWindow, nextTgtWindow)
    }

    const finishDrag = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return

      if (dragState.dragging) {
        commitViewportChange(dragState.currentRefWindow, dragState.currentTgtWindow)
      }

      if (dragState.element && dragState.pointerId != null) {
        try {
          dragState.element.releasePointerCapture?.(dragState.pointerId)
        } catch {
          // ignored
        }
      }

      featureBandDragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [commitViewportChange, pushPreviewViewport])

  const handleFeatureBandPointerDown = useCallback((side, event) => {
    if (isBoxSelectMode || isSelectingRect) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.button !== 0) return

    const startRefWindow = displayRefWindowRef.current
    const startTgtWindow = displayTgtWindowRef.current
    if (side === 'reference' && !startRefWindow) return
    if (side === 'target' && !startTgtWindow) return

    clearPendingViewportCommit()
    setClickedVariant(null)

    const rect = event.currentTarget.getBoundingClientRect()
    featureBandDragRef.current = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      width: Math.max(1, rect.width),
      startRefWindow,
      startTgtWindow,
      currentRefWindow: startRefWindow,
      currentTgtWindow: startTgtWindow,
      dragging: false,
      element: event.currentTarget,
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [clearPendingViewportCommit, isBoxSelectMode, isSelectingRect])

  const handleFeatureBandWheel = useCallback((side, event, element = null) => {
    if (isBoxSelectMode || isSelectingRect) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      return
    }
    const currentRefWindow = displayRefWindowRef.current
    const currentTgtWindow = displayTgtWindowRef.current
    if (side === 'reference' && !currentRefWindow) return
    if (side === 'target' && !currentTgtWindow) return

    const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
    const session = featureWheelSessionRef.current
    // Moving to the other band restarts the gesture, so a fling cannot carry a
    // locked mode across from the band it started on.
    const previous = session.side === side ? session.gesture : null
    const gesture = beginWheelGesture(previous, wheel, wheel.ts || performance.now())
    session.side = side

    const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
      canScrollPage: Boolean(findNearestScrollable(event.target || element)),
      gesture,
    })
    markWheelHandled(event)
    session.gesture = { ...gesture, mode: intent.nextGestureMode || gesture.mode }
    if (intent.preventDefault) event.preventDefault()
    if (intent.stopPropagation) {
      event.stopPropagation()
      event.stopImmediatePropagation?.()
    }
    if (intent.type !== 'zoom' && intent.type !== 'pan') return

    const targetElement = element || event.currentTarget || event.target
    if (!targetElement?.getBoundingClientRect) return
    const rect = targetElement.getBoundingClientRect()
    const anchorFraction = intent.anchor === 'center'
      ? 0.5
      : clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    let nextRefWindow = currentRefWindow
    let nextTgtWindow = currentTgtWindow

    if (intent.type === 'zoom') {
      if (currentRefWindow) {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
      }
      if (currentTgtWindow) {
        nextTgtWindow = zoomWindowAround(currentTgtWindow, intent.factor, anchorFraction, 1, tgtChromSizeRef.current)
      }
    } else if (side === 'reference' && currentRefWindow) {
      nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
    } else if (side === 'target' && currentTgtWindow) {
      nextTgtWindow = panWindowByPixels(currentTgtWindow, intent.dxPx, rect.width, 1, tgtChromSizeRef.current)
    }

    pushPreviewViewport(nextRefWindow, nextTgtWindow)
    scheduleViewportCommit(nextRefWindow, nextTgtWindow)
  }, [pushPreviewViewport, scheduleViewportCommit, isBoxSelectMode, isSelectingRect])

  // Native non-passive wheel listeners for gene track bands.
  // React's wheel events are passive in React 18+, so event.preventDefault() is a no-op there.
  // These native listeners guarantee the outer scroll is suppressed.
  useEffect(() => {
    const topEl = topFeatureBandRef.current
    const bottomEl = bottomFeatureBandRef.current
    if (!topEl && !bottomEl) return
    const handleTop = (e) => handleFeatureBandWheel('target', e, topEl)
    const handleBottom = (e) => handleFeatureBandWheel('reference', e, bottomEl)
    if (topEl) topEl.addEventListener('wheel', handleTop, { passive: false })
    if (bottomEl) bottomEl.addEventListener('wheel', handleBottom, { passive: false })
    return () => {
      if (topEl) topEl.removeEventListener('wheel', handleTop)
      if (bottomEl) bottomEl.removeEventListener('wheel', handleBottom)
    }
  }, [handleFeatureBandWheel, viewRefWindow])

  useEffect(() => {
    const updateSelectionRectFromEvent = (event) => {
      const drag = selectionDragRef.current
      const area = interactiveAreaRef.current
      if (!drag || !area || event.pointerId !== drag.pointerId) return
      const rect = area.getBoundingClientRect()
      const x = clamp(event.clientX - rect.left, 0, rect.width)
      const y = clamp(event.clientY - rect.top, 0, rect.height)
      setSelectionRect((prev) => (prev ? { ...prev, x2: x, y2: y } : prev))
    }

    const finishSelection = (event) => {
      const drag = selectionDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return

      const finalRect = selectionRect
      selectionDragRef.current = null
      setIsSelectingRect(false)
      setIsBoxSelectMode(false)

      if (drag.element && drag.pointerId != null) {
        try {
          drag.element.releasePointerCapture?.(drag.pointerId)
        } catch {
          // ignored
        }
      }

      if (!finalRect || !displayRefWindowRef.current) {
        setSelectionRect(null)
        return
      }

      const currentPlotLeft = PLOT_PAD_X
      const currentPlotRight = Math.max(currentPlotLeft + 400, panelWidth - PLOT_PAD_X)
      const currentPlotWidth = Math.max(1, currentPlotRight - currentPlotLeft)
      const minX = clamp(Math.min(finalRect.x1, finalRect.x2), currentPlotLeft, currentPlotRight)
      const maxX = clamp(Math.max(finalRect.x1, finalRect.x2), currentPlotLeft, currentPlotRight)
      setSelectionRect(null)

      if ((maxX - minX) <= 2) return

      const currentRefWindow = displayRefWindowRef.current
      const currentTgtWindow = displayTgtWindowRef.current || baseTgtWindow || fallbackTgtWindow
      const alignments = alignmentsRef.current?.data?.alignments || []
      if (!currentRefWindow || !currentTgtWindow) return

      const currentRefSpan = Math.max(1, currentRefWindow.end - currentRefWindow.start)
      const nextRefStart = currentRefWindow.start + ((minX - currentPlotLeft) / currentPlotWidth) * currentRefSpan
      const nextRefEnd = currentRefWindow.start + ((maxX - currentPlotLeft) / currentPlotWidth) * currentRefSpan
      const nextRefWindow = constrainWindowToZoomLimits({
        chrom: currentRefWindow.chrom,
        start: Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))),
        end: Math.max(
          Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))) + 1,
          Math.round(Math.max(nextRefStart, nextRefEnd)),
        ),
      }, refChromSizeRef.current)

      const nextTgtWindow = buildCenteredTargetWindow(
        nextRefWindow,
        currentTgtWindow,
        alignments,
        tgtChromSizeRef.current,
      )

      clearPendingViewportCommit()
      setClickedVariant(null)
      setPreviewRefWindow(null)
      setPreviewTgtWindow(null)
      setViewRefWindow(nextRefWindow)
      if (nextTgtWindow) {
        setViewTgtWindow(nextTgtWindow)
      }
      requestBufferData(nextRefWindow, null, 'box-select')
    }

    window.addEventListener('pointermove', updateSelectionRectFromEvent, { passive: false })
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', finishSelection)
    return () => {
      window.removeEventListener('pointermove', updateSelectionRectFromEvent)
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', finishSelection)
    }
  }, [
    selectionRect,
    clearPendingViewportCommit,
    panelWidth,
    baseTgtWindow,
    fallbackTgtWindow,
    requestBufferData,
    isBoxSelectMode,
  ])

  const handleSelectionOverlayPointerDown = useCallback((event) => {
    if (!isBoxSelectMode || event.button !== 0) return
    const area = interactiveAreaRef.current
    if (!area) return

    const rect = area.getBoundingClientRect()
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)

    clearPendingViewportCommit()
    setClickedVariant(null)
    setIsSelectingRect(true)
    setSelectionRect({ x1: x, y1: y, x2: x, y2: y })
    selectionDragRef.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [isBoxSelectMode, clearPendingViewportCommit])

  // ── Handle viewport-change-end from web component ─────────────────────────
  useEffect(() => {
    const el = alignmentsRef.current
    if (!el) return

    const handleVariantClick = (detail, clientX, clientY) => {
      setClickedVariant((prev) => {
        const prevKey = prev
          ? `${prev.variant?.name || ''}|${prev.variant?.type || ''}|${prev.variant?.location?.start || ''}|${prev.variant?.location?.end || ''}`
          : ''
        const nextKey = `${detail?.name || ''}|${detail?.type || ''}|${detail?.location?.start || ''}|${detail?.location?.end || ''}`
        if (prevKey && prevKey === nextKey) {
          return null
        }
        return {
          variant: {
            name: detail?.name || '',
            type: detail?.type || 'variant',
            location: detail?.location || null,
            ref_length: Number(detail?.ref_length) || 0,
            alt_length: Number(detail?.alt_length) || 0,
          },
          popupX: clientX,
          popupY: clientY,
        }
      })
    }

    const handlePreview = (e) => {
      const { reference, alt } = e.detail ?? {}
      setClickedVariant(null)
      let nextRefWindow = null
      let nextTgtWindow = null
      if (reference && Number.isFinite(reference.start) && Number.isFinite(reference.end)) {
        nextRefWindow = {
          chrom: viewRefWindow?.chrom || displayRefWindow?.chrom || '',
          start: reference.start,
          end: reference.end,
        }
      }
      if (alt && Number.isFinite(alt.start) && Number.isFinite(alt.end)) {
        const resolvedAltChrom = alt.regionName || displayTgtWindowRef.current?.chrom || baseTgtWindow?.chrom || bufferData?.tgt_chrom || ''
        nextTgtWindow = {
          chrom: resolvedAltChrom,
          start: alt.start,
          end: alt.end,
        }
      }
      pushPreviewViewport(nextRefWindow, nextTgtWindow, { syncAlignment: false })
    }

    const handler = (e) => {
      const { reference, alt } = e.detail ?? {}
      setClickedVariant(null)
      const nextRefWindow = reference && Number.isFinite(reference.start) && Number.isFinite(reference.end)
        ? {
          chrom: reference.regionName || viewRefWindow?.chrom || '',
          start: reference.start,
          end: reference.end,
        }
        : null
      const nextTgtWindow = alt && Number.isFinite(alt.start) && Number.isFinite(alt.end)
        ? {
          chrom: alt.regionName || displayTgtWindowRef.current?.chrom || baseTgtWindow?.chrom || bufferData?.tgt_chrom || '',
          start: alt.start,
          end: alt.end,
        }
        : null
      commitViewportChange(nextRefWindow, nextTgtWindow)
    }

    const handleCustomVariantClick = (e) => {
      const detail = e.detail ?? {}
      const rect = el.getBoundingClientRect()
      handleVariantClick(detail, rect.left + (Number(detail.x) || 0), rect.top + (Number(detail.y) || 0))
    }

    const handleNativePanelClick = (e) => {
      const variant = getVariantFromEvent(e)
      if (!variant) {
        setClickedVariant(null)
        return
      }
      handleVariantClick(variant, e.clientX, e.clientY)
    }
    const handlePanelMouseLeave = () => {
      setClickedVariant(null)
    }

    el.addEventListener('variant-click', handleCustomVariantClick)
    el.addEventListener('click', handleNativePanelClick, true)
    el.addEventListener('mouseleave', handlePanelMouseLeave)
    el.addEventListener('viewport-change', handlePreview)
    el.addEventListener('viewport-change-end', handler)
    return () => {
      el.removeEventListener('variant-click', handleCustomVariantClick)
      el.removeEventListener('click', handleNativePanelClick, true)
      el.removeEventListener('mouseleave', handlePanelMouseLeave)
      el.removeEventListener('viewport-change', handlePreview)
      el.removeEventListener('viewport-change-end', handler)
    }
  }, [alignmentsComponentKey, viewRefWindow?.chrom, displayRefWindow?.chrom, baseTgtWindow?.chrom, displayTgtWindow?.chrom, bufferData?.tgt_chrom, pushPreviewViewport, commitViewportChange])

  // ── Zoom / reset controls ──────────────────────────────────────────────────
  const applyZoom = (factor) => {
    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current)
      wheelCommitTimerRef.current = null
    }
    setClickedVariant(null)
    setPreviewRefWindow(null)
    setPreviewTgtWindow(null)
    setViewRefWindow((prev) => zoomWindowAround(prev, factor, 0.5, 1, refChromSizeRef.current))
    setViewTgtWindow((prev) => zoomWindowAround(prev || baseTgtWindow, factor, 0.5, 1, tgtChromSizeRef.current))
  }

  const centerAlignment = useCallback(() => {
    const currentRefWindow = displayRefWindowRef.current
    const currentTgtWindow = displayTgtWindowRef.current
    const alignments = alignmentsRef.current?.data?.alignments || []

    if (!currentRefWindow || !currentTgtWindow || !alignments.length) return

    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current)
      wheelCommitTimerRef.current = null
    }

    const nextTgtWindow = buildCenteredTargetWindow(
      currentRefWindow,
      currentTgtWindow,
      alignments,
      tgtChromSizeRef.current,
    )

    setClickedVariant(null)
    setPreviewRefWindow(null)
    setPreviewTgtWindow(null)
    if (nextTgtWindow) {
      setViewTgtWindow(nextTgtWindow)
    }
  }, [])

  useEffect(() => {
    if (seedReasonRef.current !== 'default') return
    if (defaultStartPhase !== 'selecting') return
    if (!viewRefWindow || alignmentTrackLoading) return

    const alignments = alignmentsRef.current?.data?.alignments || []
    if (!alignments.length) return

    const largestInversionRegion = inferLargestInversionRegion(alignments)
    const currentViewKey = `${viewRefWindow.chrom}|${viewRefWindow.start}|${viewRefWindow.end}`

    if (!largestInversionRegion) {
      pendingDefaultCenterKeyRef.current = currentViewKey
      setDefaultStartPhase('centering')
      return
    }

    const regionSpan = Math.max(1, largestInversionRegion.refEnd - largestInversionRegion.refStart + 1)
    const inversionMidpoint = largestInversionRegion.refStart + (regionSpan / 2)
    const desiredSpan = Math.round(Math.max(regionSpan, MIN_VIEW_SPAN) / 0.7)
    const nextRefWindow = centerWindowOnRange(
      viewRefWindow.chrom,
      inversionMidpoint,
      desiredSpan,
      refChromSizeRef.current,
      1,
    )
    const nextViewKey = `${nextRefWindow.chrom}|${nextRefWindow.start}|${nextRefWindow.end}`

    pendingDefaultCenterKeyRef.current = nextViewKey
    autoCenteredViewKeyRef.current = ''
    setPreviewRefWindow(null)
    setPreviewTgtWindow(null)
    setDefaultStartPhase('centering')

    if (nextViewKey !== currentViewKey) {
      setViewRefWindow(nextRefWindow)
      setViewTgtWindow(null)
      requestBufferData(nextRefWindow, null, 'default-inversion')
    }
  }, [viewRefWindow, alignmentTrackLoading, requestBufferData, defaultStartPhase])

  useEffect(() => {
    if (seedReasonRef.current !== 'default') return
    if (defaultStartPhase !== 'centering') return
    if (!viewRefWindow || alignmentTrackLoading) return

    const currentViewKey = `${viewRefWindow.chrom}|${viewRefWindow.start}|${viewRefWindow.end}`
    if (pendingDefaultCenterKeyRef.current && pendingDefaultCenterKeyRef.current !== currentViewKey) return

    const alignments = alignmentsRef.current?.data?.alignments || []
    if (!alignments.length) return

    const currentTgtWindow = displayTgtWindowRef.current || baseTgtWindow || fallbackTgtWindow
    const nextTgtWindow = buildCenteredTargetWindow(
      viewRefWindow,
      currentTgtWindow,
      alignments,
      tgtChromSizeRef.current,
    )
    if (!nextTgtWindow) return

    seedReasonRef.current = ''
    pendingDefaultCenterKeyRef.current = ''
    autoCenteredViewKeyRef.current = currentViewKey
    setDefaultStartPhase('idle')
    setPreviewRefWindow(null)
    setPreviewTgtWindow(null)
    setViewTgtWindow(nextTgtWindow)
  }, [viewRefWindow, alignmentTrackLoading, defaultStartPhase, baseTgtWindow, fallbackTgtWindow])

  useEffect(() => {
    if (seedReasonRef.current === 'default') return
    if (!viewRefWindow || viewTgtWindow || alignmentTrackLoading) return

    const alignments = alignmentsRef.current?.data?.alignments || []
    if (!alignments.length) return

    const viewKey = `${viewRefWindow.chrom}|${viewRefWindow.start}|${viewRefWindow.end}`
    if (autoCenteredViewKeyRef.current === viewKey) return

    autoCenteredViewKeyRef.current = viewKey
    centerAlignment()
  }, [viewRefWindow, viewTgtWindow, alignmentTrackLoading, centerAlignment])

  // ── SVG geometry for bands ─────────────────────────────────────────────────
  const plotLeft  = PLOT_PAD_X
  const plotRight = Math.max(plotLeft + 400, panelWidth - PLOT_PAD_X)
  const plotWidth = Math.max(1, plotRight - plotLeft)

  const refSpan = Math.max(1, (displayRefWindow?.end || 0) - (displayRefWindow?.start || 0))
  const tgtSpan = Math.max(1, (displayTgtWindow?.end   || 0) - (displayTgtWindow?.start || 0))

  const toRefX = useCallback((pos) => {
    if (!displayRefWindow) return plotLeft
    return plotLeft + ((pos - displayRefWindow.start) / refSpan) * plotWidth
  }, [displayRefWindow, refSpan, plotLeft, plotWidth])

  const toTgtX = useCallback((pos) => {
    if (!displayTgtWindow) return plotLeft
    return plotLeft + ((pos - displayTgtWindow.start) / tgtSpan) * plotWidth
  }, [displayTgtWindow, tgtSpan, plotLeft, plotWidth])

  // ── Band SVG rendering helpers ─────────────────────────────────────────────
  // Same treatment as the genome browser's ruler (see genomeBrowserRuler.js):
  // a 1px tick per round coordinate with the coordinate set beside it in mono,
  // rather than a centred label straddling a tick.
  const renderRuler = (window, bandY, isRef) => {
    if (!window) return null
    const toX = isRef ? toRefX : toTgtX
    const rulerTop = bandY + BAND_HEIGHT
    const geometry = rulerGeometry({ top: rulerTop, height: RULER_HEIGHT, position: 'bottom' })
    const { ticks: tickCoords } = rulerTicks({
      start: window.start,
      end: window.end,
      widthPx: Math.max(1, plotRight - plotLeft),
      fontSize: RULER_FONT_SIZE,
    })
    const stroke = isLight ? '#787878' : '#8b8b8b'
    return tickCoords.map((pos) => {
      const x = toX(pos)
      if (x < plotLeft || x > plotRight) return null
      return (
        <g key={`tick-${isRef ? 'r' : 't'}-${pos}`}>
          <line
            x1={x} y1={geometry.tickStart}
            x2={x} y2={geometry.tickEnd}
            stroke={stroke}
            strokeWidth="1"
          />
          <text
            x={x + RULER_LABEL_GAP}
            y={geometry.labelBaseline}
            textAnchor="start"
            fontSize={RULER_FONT_SIZE}
            fontFamily={FONT_MONO}
            fill={stroke}
          >
            {formatRulerCoord(pos)}
          </text>
        </g>
      )
    })
  }

  const renderGeneTracks = (genes, window, trackY, isRef) => {
    if (!genes || !genes.length || !window) return null
    const toX    = isRef ? toRefX : toTgtX
    const visible = genes.filter(g => overlaps(g.start, g.end, window.start, window.end))
    if (!visible.length) return null
    const H = GENE_TRACK_HEIGHT - 3
    return visible.map((gene, i) => {
      const x0 = clamp(toX(gene.start), plotLeft, plotRight)
      const x1 = clamp(toX(gene.end),   plotLeft, plotRight)
      const w  = Math.max(1.5, x1 - x0)
      const isCoding = (gene.biotype || '').includes('protein_coding')
      return (
        <rect
          key={`gene-${isRef ? 'r' : 't'}-${i}`}
          x={x0}
          y={trackY + (isCoding ? 2 : 4)}
          width={w}
          height={isCoding ? H : H - 4}
          rx={1}
          fill={isLight ? 'rgba(0,100,180,0.5)' : 'rgba(96,180,255,0.45)'}
        />
      )
    })
  }

  // ── Band SVG heights ───────────────────────────────────────────────────────
  const REF_BAND_SVG_H = REF_BAND_Y + BAND_HEIGHT + RULER_HEIGHT + GENE_TRACK_HEIGHT + PLOT_PAD_Y
  const TGT_BAND_SVG_H = GENE_TRACK_HEIGHT + BAND_HEIGHT + RULER_HEIGHT + PLOT_PAD_Y
  const TGT_GENE_TRACK_Y = 0
  const TGT_BAND_Y_LOCAL = TGT_GENE_TRACK_Y + GENE_TRACK_HEIGHT

  // ── Guard states ───────────────────────────────────────────────────────────
  const isUnsupported = hasTwoGenomes && !looksLikeSvPair

  const canRenderSvCanvas = Boolean(hasTwoGenomes && !isUnsupported && !error && viewRefWindow)
  const initialAutoCenterPending = defaultStartPhase !== 'idle'
  const legendSectionClass = isLight ? 'border-gray-200 bg-gray-50/90 text-gray-700' : 'border-gray-700 bg-[#152033] text-gray-300'
  const legendTitleClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const legendItems = [
    {
      title: 'Alignment type',
      items: [
        { label: 'Match', swatch: 'rgba(73, 184, 255, 0.28)', border: 'rgba(73, 184, 255, 0.55)' },
        { label: 'No match', swatch: null, border: isLight ? '#cbd5e1' : '#64748b' },
        { label: 'Inverted match', swatch: 'rgba(248, 192, 65, 0.52)', border: 'rgba(248, 192, 65, 0.72)' },
      ],
    },
    {
      title: 'Haplotype variant type',
      items: [
        { label: 'Deletion or loss', swatch: '#ff595c' },
        { label: 'Gain or insertion', swatch: '#5f73e6' },
        { label: 'SNV', swatch: '#f472b6' },
      ],
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className={`rounded-xl ${themeClasses.panel} overflow-visible flex flex-col`}
      style={{
        minHeight: hasTwoGenomes && !isUnsupported && viewRefWindow ? 'calc(100vh - 180px)' : undefined,
      }}
    >

      {/* ── Header bar ── */}
      <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center gap-2`}>
        <div className={`w-[300px] max-w-[34vw] shrink-0 truncate text-xs ${themeClasses.muted}`}>
          {viewRefWindow
            ? `${displayRefWindow?.chrom || viewRefWindow.chrom}:${formatCoord(displayRefWindow?.start || viewRefWindow.start)}-${formatCoord(displayRefWindow?.end || viewRefWindow.end)} (${formatBp(refSpan)})`
            : 'Set a region to begin'}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => applyZoom(1.12)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom out"
          >-</button>
          <button
            type="button"
            onClick={() => applyZoom(0.89)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom in"
          >+</button>
          <button
            type="button"
            onClick={centerAlignment}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Center alignment between tracks"
            aria-label="Center alignment between tracks"
          >
            <span className="inline-flex h-3.5 w-3 items-center justify-center align-middle leading-none">
              <CenterAlignmentIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsBoxSelectMode((prev) => !prev)
              setIsSelectingRect(false)
              setSelectionRect(null)
              selectionDragRef.current = null
            }}
            className={`px-2 py-1 rounded text-xs border flex items-center justify-center ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100'}`}
            style={{
              boxShadow: isBoxSelectMode ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
            }}
            title={isBoxSelectMode ? 'Selection mode active: drag to zoom' : 'Activate selection zoom mode'}
            aria-label="Activate selection zoom mode"
          >
            <span className="inline-flex items-center justify-center align-middle leading-none" style={{ width: '18px', height: '18px' }}>
              <SelectionZoomIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCompactTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              compactTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
          >
            {compactTracks ? 'Expand' : 'Compress'}
          </button>
          <button
            type="button"
            onClick={() => setHideInactiveFeatureTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              hideInactiveFeatureTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={hideInactiveFeatureTracks ? 'Show hidden GF/GR/SL lanes' : 'Hide inactive GF/GR/SL lanes'}
          >
            {hideInactiveFeatureTracks ? 'Show inactive' : 'Hide inactive'}
          </button>
          <button
            type="button"
            onClick={() => setShowBigWigTracks((prev) => !prev)}
            aria-pressed={showBigWigTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigWigTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigWigTracks ? 'Hide BigWig signal tracks' : 'Load and show BigWig signal tracks'}
          >
            BigWig
          </button>
          <button
            type="button"
            onClick={() => setShowBigBedTracks((prev) => !prev)}
            aria-pressed={showBigBedTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigBedTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigBedTracks ? 'Hide BigBed interval tracks' : 'Load and show BigBed interval tracks'}
          >
            BigBed
          </button>
        </div>
      </div>

      {/* ── Main body ── */}
      <div ref={bandSvgRef} className="flex-none overflow-visible flex flex-col pb-5">

        {!hasTwoGenomes ? (
          <div className="flex-1 flex items-center justify-center text-sm opacity-75">
            Activate primary and secondary genomes to open structural variation view.
          </div>
        ) : isUnsupported ? (
          <div className="flex-1 flex items-center justify-center text-sm text-amber-400">
            No registered SV alignment is available for this genome pair.
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-400">Error: {error}</div>
        ) : statusText && !bufferData ? (
          <div className={`flex-1 flex items-center justify-center text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>{statusText}</div>
        ) : !viewRefWindow ? (
          <div className="flex-1 flex items-center justify-center text-sm opacity-70">Loading…</div>
        ) : (
          <div ref={interactiveAreaRef} className="relative">
            <div style={{ visibility: initialAutoCenterPending ? 'hidden' : 'visible' }}>
            <div
              ref={topFeatureBandRef}
              className="w-full flex-none touch-none"
              onPointerDown={(event) => handleFeatureBandPointerDown('target', event)}
            >
              <StructuralVariationFeatureBand
                theme={theme}
                position="top"
                width={Math.max(760, panelWidth)}
                label="Secondary"
                pillLabel={tgtPillLabel || 'Secondary genome'}
                pillColor={targetGenomeColor}
                window={displayTgtWindow}
                entries={featureTrackData.target}
                loading={featureTrackLoading.target}
                genomeId={targetBrowseGenomeId}
                sequenceGenomeId={targetBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="target"
                referenceWindow={displayRefWindow}
                altWindow={displayTgtWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={tgtAssembly}
                altBrowseGenomeId={targetBrowseGenomeId}
                annotationAlignments={pairAnnotationAlignments}
                compact={compactTracks}
              />
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={baseTgtWindow}
                displayWindow={displayTgtWindow}
                genomeId={targetBrowseGenomeId}
                tracks={targetSignalTracks}
                genomeColor={targetGenomeColor}
              />
            )}

            {/* ── Beta alignment ribbon web component ── */}
            <div
              ref={alignmentPanelRef}
              className="flex-none overflow-hidden"
              style={{
                background: isLight ? '#edf5ff' : '#0d1830',
                height: `${alignmentPanelHeight}px`,
                position: 'relative',
              }}
            >
              {canRenderSvCanvas && (
                <ens-sv-alignments
                  key={alignmentsComponentKey}
                  ref={alignmentsRef}
                  style={{ display: 'block', width: '100%', height: '100%' }}
                  // Drive the custom element via imperative properties so it
                  // initializes with endpoints and coordinates in one batch.
                />
              )}
              {showBigBedTracks && (
                <StructuralVariationRibbonOverlay
                  theme={theme}
                  width={Math.max(760, panelWidth)}
                  height={alignmentPanelHeight}
                  referenceWindow={viewRefWindow}
                  targetWindow={baseTgtWindow}
                  displayReferenceWindow={displayRefWindow}
                  displayTargetWindow={displayTgtWindow}
                  referenceTracks={referenceDataTracks}
                  targetTracks={targetDataTracks}
                  referenceGenomeId={referenceBrowseGenomeId}
                  targetGenomeId={targetBrowseGenomeId}
                  displayOrder="reference-top"
                />
              )}
              {alignmentTrackLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
                    <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                      {svLoadingMode === 'eager' ? 'Loading full alignment region…' : 'Loading alignments…'}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={viewRefWindow}
                displayWindow={displayRefWindow}
                genomeId={referenceBrowseGenomeId}
                tracks={referenceSignalTracks}
                genomeColor={referenceGenomeColor}
              />
            )}

            {clickedVariant && (() => {
              const { variant, popupX, popupY } = clickedVariant
              const popupW = 280
              const arrowSize = 8
              const gap = 4
              const viewportW = typeof window !== 'undefined' ? window.innerWidth : 0
              const spaceLeft = popupX - arrowSize - gap
              const goLeft = spaceLeft >= popupW || (viewportW > 0 && popupX > viewportW * 0.55)
              const popupLeft = goLeft
                ? popupX - popupW - arrowSize - gap
                : popupX + arrowSize + gap
              const typeLabel = formatVariantTypeLabel(variant.type)
              const lengthLabel = formatVariantLengthLabel(variant)
              const locationLabel = formatVariantLocation(variant.location, variant.type)
              return (
                <div
                  className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                  style={{
                    left: popupLeft,
                    top: popupY,
                    transform: 'translateY(-50%)',
                    width: popupW,
                    backgroundColor: 'rgba(17, 24, 39, 0.97)',
                    color: '#f1f5f9',
                    padding: '10px 14px',
                    border: '1px solid rgba(255,255,255,0.1)',
                    pointerEvents: 'none',
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
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
                  }} />
                  <div>Variant type: <span style={{ fontWeight: 700 }}>{typeLabel}</span></div>
                  {lengthLabel && <div>{lengthLabel}</div>}
                  {locationLabel && <div style={{ fontWeight: 700 }}>{locationLabel}</div>}
                </div>
              )
            })()}

            <div
              ref={bottomFeatureBandRef}
              className="w-full flex-none touch-none mb-4"
              onPointerDown={(event) => handleFeatureBandPointerDown('reference', event)}
            >
              <StructuralVariationFeatureBand
                theme={theme}
                position="bottom"
                width={Math.max(760, panelWidth)}
                label="Primary"
                pillLabel={refPillLabel || 'Primary genome'}
                pillColor={referenceGenomeColor}
                window={displayRefWindow}
                entries={featureTrackData.reference}
                loading={featureTrackLoading.reference}
                genomeId={referenceBrowseGenomeId}
                sequenceGenomeId={referenceBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="reference"
                referenceWindow={displayRefWindow}
                altWindow={displayTgtWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={tgtAssembly}
                altBrowseGenomeId={targetBrowseGenomeId}
                annotationAlignments={pairAnnotationAlignments}
                compact={compactTracks}
              />
            </div>
            </div>
            {initialAutoCenterPending && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.86)' }}>
                  <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                  <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                    Aligning initial view…
                  </div>
                </div>
              </div>
            )}
            {!initialAutoCenterPending && (isBoxSelectMode || isSelectingRect) && (
              <div
                className="absolute inset-0 z-20"
                style={{ cursor: 'crosshair' }}
                onPointerDown={handleSelectionOverlayPointerDown}
                onWheel={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
              >
                {selectionRect && (
                  <div
                    className="absolute"
                    style={{
                      left: Math.min(selectionRect.x1, selectionRect.x2),
                      top: Math.min(selectionRect.y1, selectionRect.y2),
                      width: Math.max(1, Math.abs(selectionRect.x2 - selectionRect.x1)),
                      height: Math.max(1, Math.abs(selectionRect.y2 - selectionRect.y1)),
                      border: `1.5px dashed ${referenceGenomeColor}`,
                      backgroundColor: isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {hasTwoGenomes && !isUnsupported && (
        <div className={`px-3 py-2 border-t ${legendSectionClass}`}>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-xs">
            {legendItems.map((section) => (
              <div key={section.title} className="flex flex-col gap-1.5">
                <div className={`text-[11px] font-semibold ${legendTitleClass}`}>{section.title}</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {section.items.map((item) => (
                    <div key={item.label} className="flex items-center gap-2">
                      <span
                        className="inline-block h-3.5 w-3.5 shrink-0"
                        style={{
                          backgroundColor: item.swatch || 'transparent',
                          border: item.border ? `1px solid ${item.border}` : 'none',
                        }}
                      />
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Footer status bar ── */}
      <div className={`px-3 py-1.5 border-t ${isLight ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-gray-700 bg-[#152033] text-gray-300'} text-xs flex items-center gap-3`}>
        {loading && <span>Buffering structural variation context…</span>}
        {!loading && statusText && <span>{statusText}</span>}
        {!loading && bufferData && (
          <span className="opacity-70">{bufferData.dataset_label || 'Structural variation'}</span>
        )}
      </div>
    </div>
  )
}

function StructuralVariationThreeGenomeView({
  theme = 'dark',
  config,
  refSpecies,
  tgtSpecies,
  thirdSpecies,
  thirdGenomeId = '',
  refPillLabel = '',
  tgtPillLabel = '',
  thirdPillLabel = '',
  browserRefGene = null,
  browserRefViewport = null,
  selectedTopAlignmentId = '',
  selectedBottomAlignmentId = '',
  selectedAnchorRegion = null,
  outputDir = '',
  savedViewportRef = null,
}) {
  const isLight = theme === 'light'
  const svLoadingMode = useMemo(() => getSvLoadingMode(), [])

  // Restore saved viewport if assemblies still match (handles view-switch persistence; mismatched
  // assemblies mean a genome changed, in which case we fall back to normal seeding behaviour)
  const restoredViewport = (() => {
    const saved = savedViewportRef?.current
    if (!saved?.refWindow) return null
    if (getSvRuntimeAssembly(refSpecies) !== saved.refAssembly) return null
    if (getSvRuntimeAssembly(tgtSpecies) !== saved.topAssembly) return null
    return {
      refWindow: saved.refWindow,
      topWindow: saved.topWindow || null,
      bottomWindow: getSvRuntimeAssembly(thirdSpecies) === saved.bottomAssembly ? (saved.bottomWindow || null) : null,
      seededRegionKey: saved.seededRegionKey || '',
      seededBrowserKey: saved.seededBrowserKey || '',
      regionSeedBrowserKey: saved.regionSeedBrowserKey || '',
    }
  })()

  const bandSvgRef = useRef(null)
  const interactiveAreaRef = useRef(null)
  const upperAlignmentsRef = useRef(null)
  const lowerAlignmentsRef = useRef(null)
  const upperPanelRef = useRef(null)
  const lowerPanelRef = useRef(null)
  const topFeatureBandRef = useRef(null)
  const middleFeatureBandRef = useRef(null)
  const bottomFeatureBandRef = useRef(null)
  const wheelCommitTimerRef = useRef(null)
  const featureBandDragRef = useRef(null)
  const selectionDragRef = useRef(null)
  const upperFetchTokenRef = useRef(0)
  const lowerFetchTokenRef = useRef(0)
  const upperBufferDataRef = useRef(null)
  const lowerBufferDataRef = useRef(null)
  const upperAbortRef = useRef(null)
  const lowerAbortRef = useRef(null)
  const upperLastFetchKeyRef = useRef('')
  const lowerLastFetchKeyRef = useRef('')
  const upperInFlightFetchKeyRef = useRef('')
  const lowerInFlightFetchKeyRef = useRef('')
  const bufferRetryRef = useRef({
    top: { key: '', attempt: 0, timer: null },
    bottom: { key: '', attempt: 0, timer: null },
  })
  const seededAnchorRegionKeyRef = useRef(restoredViewport?.seededRegionKey || '')
  // What the genome browser last seeded this view with. Restored alongside the
  // viewport so a remount does not re-seed from an unchanged browser position.
  const seededBrowserKeyRef = useRef(restoredViewport?.seededBrowserKey || '')
  // The browser seed that was in force when the anchor region was last applied,
  // so the two can be told apart when they disagree.
  const regionSeedBrowserKeyRef = useRef(restoredViewport?.regionSeedBrowserKey || '')
  // Caps drift recovery at one attempt per region, so a chromosome name that
  // never compares equal cannot re-apply the region forever.
  const driftRecoveredRegionKeyRef = useRef('')
  // Whether this mount restored a viewport. Latched for the lifetime of the
  // mount: the browser's viewport must never override what the user was last
  // looking at here, however long they spent in the genome browser in between.
  const hadRestoredViewportRef = useRef(Boolean(restoredViewport?.refWindow))
  const featureTrackCacheRef = useRef({ reference: null, top: null, bottom: null })
  const featureTrackTokenRef = useRef({ reference: 0, top: 0, bottom: 0 })
  const featureTrackAbortRef = useRef({ reference: null, top: null, bottom: null })
  const featureTrackRetryRef = useRef({
    reference: { key: '', attempt: 0, timer: null },
    top: { key: '', attempt: 0, timer: null },
    bottom: { key: '', attempt: 0, timer: null },
  })
  const displayRefWindowRef = useRef(null)
  const displayTopWindowRef = useRef(null)
  const displayBottomWindowRef = useRef(null)
  const refChromSizeRef = useRef(null)
  const topChromSizeRef = useRef(null)
  const bottomChromSizeRef = useRef(null)
  const wheelSessionRef = useRef({ gesture: null })
  const browsingControls = useBrowsingControls(config)
  const browsingControlsRef = useRef(browsingControls)
  useEffect(() => { browsingControlsRef.current = browsingControls }, [browsingControls])
  const prevBottomAlignmentIdRef = useRef('')
  const previewFrameRef = useRef(null)
  const pendingPreviewRef = useRef({ ref: null, top: null, bottom: null })
  const externalViewportInteractionRef = useRef({ dragging: false, activeUntil: 0 })

  const [panelWidth, setPanelWidth] = useState(0)
  const [upperBufferData, setUpperBufferData] = useState(null)
  const [lowerBufferData, setLowerBufferData] = useState(null)
  const [upperBufferLoading, setUpperBufferLoading] = useState(false)
  const [lowerBufferLoading, setLowerBufferLoading] = useState(false)
  const [error, setError] = useState(null)
  const [statusText, setStatusText] = useState('')
  const [viewRefWindow, setViewRefWindow] = useState(restoredViewport?.refWindow || null)
  const [viewTopWindow, setViewTopWindow] = useState(restoredViewport?.topWindow || null)
  const [viewBottomWindow, setViewBottomWindow] = useState(restoredViewport?.bottomWindow || null)
  const [previewRefWindow, setPreviewRefWindow] = useState(null)
  const [previewTopWindow, setPreviewTopWindow] = useState(null)
  const [previewBottomWindow, setPreviewBottomWindow] = useState(null)
  const [featureTrackData, setFeatureTrackData] = useState({ reference: [], top: [], bottom: [] })
  const [featureTrackLoading, setFeatureTrackLoading] = useState({ reference: false, top: false, bottom: false })
  const [alignmentTrackLoading, setAlignmentTrackLoading] = useState({ top: false, bottom: false })
  // Panning and zooming refetch constantly, and most of those land in a few tens
  // of milliseconds — often for data outside the current window. Debounced so a
  // spinner only appears for work slow enough to be worth reporting.
  const showUpperAlignmentLoading = useDelayedFlag(upperBufferLoading || alignmentTrackLoading.top)
  const showLowerAlignmentLoading = useDelayedFlag(lowerBufferLoading || alignmentTrackLoading.bottom)
  const showTopGenesLoading = useDelayedFlag(featureTrackLoading.top)
  const showReferenceGenesLoading = useDelayedFlag(featureTrackLoading.reference)
  const showBottomGenesLoading = useDelayedFlag(featureTrackLoading.bottom)
  const [hideInactiveFeatureTracks, setHideInactiveFeatureTracks] = useState(Boolean(config?.sv_hide_inactive_tracks))
  const [compactTracks, setCompactTracks] = useState(false)
  const [showBigWigTracks, setShowBigWigTracks] = useState(false)
  const [showBigBedTracks, setShowBigBedTracks] = useState(false)
  const alignmentPanelHeight = compactTracks ? ALIGNMENT_PANEL_COMPACT_HEIGHT : ALIGNMENT_PANEL_HEIGHT
  const [isBoxSelectMode, setIsBoxSelectMode] = useState(false)
  const [isSelectingRect, setIsSelectingRect] = useState(false)
  const [selectionRect, setSelectionRect] = useState(null)

  useEffect(() => { upperBufferDataRef.current = upperBufferData }, [upperBufferData])
  useEffect(() => { lowerBufferDataRef.current = lowerBufferData }, [lowerBufferData])
  useEffect(() => () => {
    if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current)
    if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current)
    upperAbortRef.current?.abort?.()
    lowerAbortRef.current?.abort?.()
    if (bufferRetryRef.current.top.timer) clearTimeout(bufferRetryRef.current.top.timer)
    if (bufferRetryRef.current.bottom.timer) clearTimeout(bufferRetryRef.current.bottom.timer)
    featureTrackAbortRef.current.reference?.abort?.()
    featureTrackAbortRef.current.top?.abort?.()
    featureTrackAbortRef.current.bottom?.abort?.()
    if (featureTrackRetryRef.current.reference.timer) clearTimeout(featureTrackRetryRef.current.reference.timer)
    if (featureTrackRetryRef.current.top.timer) clearTimeout(featureTrackRetryRef.current.top.timer)
    if (featureTrackRetryRef.current.bottom.timer) clearTimeout(featureTrackRetryRef.current.bottom.timer)
    externalViewportInteractionRef.current = { dragging: false, activeUntil: 0 }
  }, [])

  const refAssembly = getSvRuntimeAssembly(refSpecies)
  const topAssembly = getSvRuntimeAssembly(tgtSpecies)
  const bottomAssembly = getSvRuntimeAssembly(thirdSpecies)
  const featureTrackGenomeIds = useMemo(() => resolveSvFeatureTrackGenomeIds({
    referenceSpecies: refSpecies,
    topSpecies: tgtSpecies,
    bottomSpecies: thirdSpecies,
    bottomGenomeId: thirdGenomeId,
  }), [refSpecies, tgtSpecies, thirdSpecies, thirdGenomeId])
  const referenceBrowseGenomeId = featureTrackGenomeIds.reference
  const topBrowseGenomeId = featureTrackGenomeIds.top
  const bottomBrowseGenomeId = featureTrackGenomeIds.bottom

  const themeClasses = {
    panel: isLight ? 'bg-white border border-gray-200 text-gray-900' : 'bg-[#1E2938] border border-gray-700 text-gray-100',
    muted: isLight ? 'text-gray-600' : 'text-gray-400',
  }

  // As in the pair view: colour follows the genome, not the row it sits in.
  const referenceGenomeColor = useMemo(() => resolveGenomeColor(config, refSpecies), [config, refSpecies])
  const topGenomeColor = useMemo(() => resolveGenomeColor(config, tgtSpecies), [config, tgtSpecies])
  const bottomGenomeColor = useMemo(() => resolveGenomeColor(config, thirdSpecies), [config, thirdSpecies])

  const runtimeOutputDir = outputDir || config?.output_dir || ''
  const upperEndpointsRef = useRef({
    alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedTopAlignmentId, runtimeOutputDir),
    variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedTopAlignmentId, runtimeOutputDir),
    genomeBrowser: '',
  })
  const upperEndpointsKeyRef = useRef(`${selectedTopAlignmentId}|${runtimeOutputDir}`)
  const lowerEndpointsRef = useRef({
    alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedBottomAlignmentId, runtimeOutputDir),
    variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedBottomAlignmentId, runtimeOutputDir),
    genomeBrowser: '',
  })
  const lowerEndpointsKeyRef = useRef(`${selectedBottomAlignmentId}|${runtimeOutputDir}`)
  const getUpperRuntimeEndpoints = useCallback(() => {
    const nextKey = `${selectedTopAlignmentId}|${runtimeOutputDir}`
    if (upperEndpointsKeyRef.current !== nextKey) {
      upperEndpointsKeyRef.current = nextKey
      upperEndpointsRef.current = {
        alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedTopAlignmentId, runtimeOutputDir),
        variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedTopAlignmentId, runtimeOutputDir),
        genomeBrowser: '',
      }
    }
    return upperEndpointsRef.current
  }, [selectedTopAlignmentId, runtimeOutputDir])
  const getLowerRuntimeEndpoints = useCallback(() => {
    const nextKey = `${selectedBottomAlignmentId}|${runtimeOutputDir}`
    if (lowerEndpointsKeyRef.current !== nextKey) {
      lowerEndpointsKeyRef.current = nextKey
      lowerEndpointsRef.current = {
        alignments: buildSvRuntimeEndpoint('/api/sv/alignments', selectedBottomAlignmentId, runtimeOutputDir),
        variants: buildSvRuntimeEndpoint('/api/sv/variants', selectedBottomAlignmentId, runtimeOutputDir),
        genomeBrowser: '',
      }
    }
    return lowerEndpointsRef.current
  }, [selectedBottomAlignmentId, runtimeOutputDir])
  useEffect(() => {
    getUpperRuntimeEndpoints()
  }, [getUpperRuntimeEndpoints])
  useEffect(() => {
    getLowerRuntimeEndpoints()
  }, [getLowerRuntimeEndpoints])

  useEffect(() => {
    setHideInactiveFeatureTracks(Boolean(config?.sv_hide_inactive_tracks))
  }, [config?.sv_hide_inactive_tracks])

  useEffect(() => {
    const node = bandSvgRef.current
    if (!node) return
    const update = () => {
      const rect = node.getBoundingClientRect()
      const nextWidth = Math.max(760, Math.round(rect.width))
      setPanelWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (selectedAnchorRegion?.chrom) return
    if (viewRefWindow) return
    setStatusText('')
    setViewRefWindow(constrainWindowToZoomLimits(SV_TRIO_DEFAULT_REF_WINDOW))
  }, [viewRefWindow, selectedAnchorRegion?.chrom])

  useEffect(() => {
    if (!selectedAnchorRegion?.chrom) return
    const regionKey = `${selectedTopAlignmentId}|${getSvRegionKey(selectedAnchorRegion)}|${selectedAnchorRegion?.start || ''}-${selectedAnchorRegion?.end || ''}`

    // Normally this only runs when the selected region changes. It also re-runs
    // when the view has drifted onto a different chromosome from the one the
    // region selector is showing, which is otherwise an inescapable state: the
    // region is already "applied", so re-picking it does nothing, and the view
    // keeps reporting an error about a chromosome the user never chose.
    //
    // Deliberately NOT applied when the genome browser seeded the view after
    // the region was applied — navigating the browser to another locus and then
    // opening this view is meant to follow the browser.
    const seedReason = resolveAnchorRegionSeed({
      regionKey,
      seededRegionKey: seededAnchorRegionKeyRef.current,
      regionChrom: normalizeSvChromToken(selectedAnchorRegion.chrom),
      windowChrom: normalizeSvChromToken(viewRefWindow?.chrom),
      seededBrowserKey: seededBrowserKeyRef.current,
      regionSeedBrowserKey: regionSeedBrowserKeyRef.current,
      driftRecoveredKey: driftRecoveredRegionKeyRef.current,
    })
    if (!seedReason) return
    if (seedReason === 'drift') driftRecoveredRegionKeyRef.current = regionKey

    let cancelled = false
    const applyAnchorRegion = async () => {
      const next = await buildWindowForAnchorRegion(
        selectedAnchorRegion,
        upperBufferData?.ref_chrom_sizes || lowerBufferData?.ref_chrom_sizes || {},
        viewRefWindow,
        refChromSizeRef.current,
      )
      if (cancelled || !next) return
      seededAnchorRegionKeyRef.current = regionKey
      regionSeedBrowserKeyRef.current = seededBrowserKeyRef.current
      setStatusText('')
      if (wheelCommitTimerRef.current) {
        clearTimeout(wheelCommitTimerRef.current)
        wheelCommitTimerRef.current = null
      }
      setViewRefWindow(next)
      setViewTopWindow(null)
      setViewBottomWindow(null)
      setPreviewRefWindow(null)
      setPreviewTopWindow(null)
      setPreviewBottomWindow(null)
    }
    applyAnchorRegion()
    return () => { cancelled = true }
  }, [
    selectedTopAlignmentId,
    selectedAnchorRegion,
    selectedAnchorRegion?.chrom,
    upperBufferData?.ref_chrom_sizes,
    lowerBufferData?.ref_chrom_sizes,
    viewRefWindow,
  ])

  // Seed from the genome browser's focused gene.
  //
  // Guarded by a key that SURVIVES REMOUNTS via savedViewportRef. Without that,
  // navigating away and back re-ran this effect and silently replaced the
  // restored region with wherever the genome browser happened to be — usually
  // chromosome 1 — while the region selector still displayed the old region.
  // The third genome then failed with "reference chromosome '1' is not aligned"
  // and never recovered, because the anchor-region seeder below considers the
  // region already applied.
  useEffect(() => {
    if (!browserRefGene?.chrom) return
    const key = buildBrowserGeneSeedKey(browserRefGene)
    if (!shouldSeedFromBrowser({ seededKey: seededBrowserKeyRef.current, candidateKey: key })) return
    seededBrowserKeyRef.current = key
    const geneSpan = Math.max(1, (browserRefGene.end || 0) - (browserRefGene.start || 0))
    const span = clamp(Math.round(geneSpan * 8), 120_000, 5_000_000)
    const center = Math.round(((browserRefGene.start || 0) + (browserRefGene.end || 0)) / 2)
    const next = centerWindowOnRange(browserRefGene.chrom, center, span, refChromSizeRef.current, 1)
    setViewRefWindow(next)
    setViewTopWindow(null)
    setViewBottomWindow(null)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [browserRefGene])

  // Seed from the genome browser's viewport. Same remount-surviving guard.
  useEffect(() => {
    if (browserRefGene?.chrom) return
    if (!browserRefViewport?.chrom || !Number.isFinite(browserRefViewport.start) || !Number.isFinite(browserRefViewport.end)) return
    if (browserRefViewport.end <= browserRefViewport.start) return
    const key = buildBrowserViewportSeedKey(browserRefViewport)
    if (!shouldSeedFromBrowserViewport({
      seededKey: seededBrowserKeyRef.current,
      candidateKey: key,
      hasRestoredViewport: hadRestoredViewportRef.current,
    })) return
    seededBrowserKeyRef.current = key
    const next = constrainWindowToZoomLimits({
      chrom: browserRefViewport.chrom,
      start: Math.max(1, Math.round(browserRefViewport.start)),
      end: Math.max(Math.max(1, Math.round(browserRefViewport.start)) + 1, Math.round(browserRefViewport.end)),
    }, refChromSizeRef.current)
    setViewRefWindow(next)
    setViewTopWindow(null)
    setViewBottomWindow(null)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [browserRefGene, browserRefViewport])

  const fetchPairBufferData = useCallback(async (slot, tgtAssemblyValue, refWindow, targetBrowseGenome = 'target', alignmentId = '') => {
    if (!refWindow?.chrom) return

    const refSpan = Math.max(1, refWindow.end - refWindow.start)
    const refPad = Math.max(BUFFER_PAD_MIN, Math.round(refSpan * BUFFER_PAD_RATIO))
    const refStep = Math.max(20_000, Math.round(refSpan * 0.12))
    const reqRefStart = Math.max(1, quantizeFloor(refWindow.start - refPad, refStep))
    const reqRefEnd = quantizeCeil(refWindow.end + refPad, refStep)

    const params = new URLSearchParams({
      ref_assembly: refAssembly,
      tgt_assembly: tgtAssemblyValue,
      ref_chrom: refWindow.chrom,
      ref_start: String(reqRefStart),
      ref_end: String(reqRefEnd),
      ref_browse_genome: referenceBrowseGenomeId,
      tgt_browse_genome: targetBrowseGenome || 'target',
      max_blocks: '200',
    })
    if (alignmentId) params.set('alignment_id', alignmentId)
    if (runtimeOutputDir) params.set('output_dir', runtimeOutputDir)

    const fetchKey = params.toString()
    const tokenRef = slot === 'top' ? upperFetchTokenRef : lowerFetchTokenRef
    const abortRef = slot === 'top' ? upperAbortRef : lowerAbortRef
    const lastFetchKeyRef = slot === 'top' ? upperLastFetchKeyRef : lowerLastFetchKeyRef
    const inFlightFetchKeyRef = slot === 'top' ? upperInFlightFetchKeyRef : lowerInFlightFetchKeyRef
    const retryState = bufferRetryRef.current[slot]
    const setLoadingState = slot === 'top' ? setUpperBufferLoading : setLowerBufferLoading
    const setDataState = slot === 'top' ? setUpperBufferData : setLowerBufferData

    if (retryState.key !== fetchKey) {
      if (retryState.timer) clearTimeout(retryState.timer)
      retryState.key = fetchKey
      retryState.attempt = 0
      retryState.timer = null
    }
    if (!shouldStartSvRequest({
      fetchKey,
      lastFetchKey: lastFetchKeyRef.current,
      inFlightFetchKey: inFlightFetchKeyRef.current,
      retryScheduled: Boolean(retryState.timer),
    })) return

    const token = ++tokenRef.current
    inFlightFetchKeyRef.current = fetchKey
    abortRef.current?.abort?.()
    const abortController = new AbortController()
    abortRef.current = abortController
    setLoadingState(true)

    try {
      const res = await fetch(`${API_BASE}/api/sv/view?${fetchKey}`, { signal: abortController.signal })
      const data = await res.json().catch(() => null)
      if (token !== tokenRef.current) return
      if (!res.ok) {
        throw createSvRequestError(data?.detail || `SV request failed (${res.status})`, {
          status: res.status,
        })
      }
      if (!data?.supported) {
        // The selected alignment came from the supported catalogue. A temporary
        // unsupported response can therefore be caused by startup/config refresh
        // timing and is worth retrying before declaring this ribbon unavailable.
        throw createSvRequestError(
          data?.detail || 'SV dataset not available for this genome pair.',
          { retryable: true },
        )
      }
      setDataState(data)
      lastFetchKeyRef.current = fetchKey
      retryState.attempt = 0
      if (retryState.timer) {
        clearTimeout(retryState.timer)
        retryState.timer = null
      }
      setError(null)
      const otherSlot = slot === 'top' ? 'bottom' : 'top'
      if (!bufferRetryRef.current[otherSlot].timer) setStatusText('')
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== tokenRef.current) return
      const currentDataRef = slot === 'top' ? upperBufferDataRef : lowerBufferDataRef
      if (isRetryableSvRequestError(e) && retryState.attempt < SV_TRANSIENT_RETRY_LIMIT) {
        const label = slot === 'bottom' ? 'third genome alignment' : 'second genome alignment'
        setStatusText(currentDataRef.current
          ? `The ${label} is temporarily unavailable; keeping the last loaded region and retrying.`
          : `The ${label} is taking longer than expected; retrying automatically.`)
        setError(null)
        if (!retryState.timer) {
          retryState.attempt += 1
          const delay = getSvTransientRetryDelay(retryState.attempt)
          retryState.timer = setTimeout(() => {
            retryState.timer = null
            if (retryState.key === fetchKey) {
              fetchPairBufferData(slot, tgtAssemblyValue, refWindow, targetBrowseGenome, alignmentId)
            }
          }, delay)
        }
        return
      }
      if (slot === 'bottom') {
        setDataState(null)
        lastFetchKeyRef.current = ''
        setStatusText(`The third genome alignment could not be loaded: ${e?.message || 'unknown error'}`)
        setError(null)
        return
      }
      setError(e?.message || 'Failed to load structural variation data.')
    } finally {
      if (inFlightFetchKeyRef.current === fetchKey) {
        inFlightFetchKeyRef.current = ''
      }
      if (abortRef.current === abortController) {
        abortRef.current = null
      }
      if (token === tokenRef.current) {
        setLoadingState(false)
      }
    }
  }, [refAssembly, runtimeOutputDir, referenceBrowseGenomeId])

  const bufferNeedsFetch = useCallback((data, refWindow, alignmentId = '') => {
    if (!refWindow?.chrom) return false
    if (!data) return true
    if (!svBufferMatchesAlignment(data, alignmentId)) return true
    if (!svBufferMatchesRefWindow(data, refWindow)) return true
    const bufferStart = Number(data.ref_start ?? NaN)
    const bufferEnd = Number(data.ref_end ?? NaN)
    if (!Number.isFinite(bufferStart) || !Number.isFinite(bufferEnd) || bufferEnd <= bufferStart) return true
    const margin = Math.max(25_000, Math.round((bufferEnd - bufferStart) * BUFFER_MARGIN_RATIO))
    return refWindow.start < (bufferStart + margin) || refWindow.end > (bufferEnd - margin)
  }, [])

  useEffect(() => {
    if (!viewRefWindow) return
    if (selectedTopAlignmentId && bufferNeedsFetch(upperBufferData, viewRefWindow, selectedTopAlignmentId)) {
      fetchPairBufferData('top', topAssembly, viewRefWindow, topBrowseGenomeId, selectedTopAlignmentId)
    }
    if (bottomBrowseGenomeId && selectedBottomAlignmentId && bufferNeedsFetch(lowerBufferData, viewRefWindow, selectedBottomAlignmentId)) {
      fetchPairBufferData('bottom', bottomAssembly, viewRefWindow, bottomBrowseGenomeId, selectedBottomAlignmentId)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    topAssembly,
    bottomAssembly,
    topBrowseGenomeId,
    bottomBrowseGenomeId,
    selectedTopAlignmentId,
    selectedBottomAlignmentId,
    upperBufferData,
    lowerBufferData,
    fetchPairBufferData,
    bufferNeedsFetch,
  ])

  const fallbackTopWindow = useMemo(
    () => svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
      ? { chrom: upperBufferData.tgt_chrom, start: upperBufferData.tgt_start, end: upperBufferData.tgt_end }
      : null,
    [upperBufferData, viewRefWindow],
  )
  const fallbackBottomWindow = useMemo(
    () => svBufferMatchesRefWindow(lowerBufferData, viewRefWindow)
      ? { chrom: lowerBufferData.tgt_chrom, start: lowerBufferData.tgt_start, end: lowerBufferData.tgt_end }
      : null,
    [lowerBufferData, viewRefWindow],
  )
  const autoTopWindow = useMemo(
    () => deriveAutoTargetWindowFromBuffer(upperBufferData, viewRefWindow, fallbackTopWindow),
    [upperBufferData, viewRefWindow, fallbackTopWindow],
  )
  const autoBottomWindow = useMemo(
    () => deriveAutoTargetWindowFromBuffer(lowerBufferData, viewRefWindow, fallbackBottomWindow),
    [lowerBufferData, viewRefWindow, fallbackBottomWindow],
  )
  const upperAnnotationAlignments = useMemo(
    () => svBlocksToFeatureBandAlignments(svBufferMatchesRefWindow(upperBufferData, viewRefWindow) ? (upperBufferData?.blocks || []) : []),
    [upperBufferData, viewRefWindow],
  )
  const lowerAnnotationAlignments = useMemo(
    () => svBlocksToFeatureBandAlignments(svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? (lowerBufferData?.blocks || []) : []),
    [lowerBufferData, viewRefWindow],
  )
  const referenceDataTracks = useMemo(
    () => getSvDataTracksForSide(
      svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
        ? upperBufferData
        : (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData : null),
      'reference',
    ),
    [upperBufferData, lowerBufferData, viewRefWindow],
  )
  const topDataTracks = useMemo(
    () => getSvDataTracksForSide(upperBufferData, 'target'),
    [upperBufferData],
  )
  const bottomDataTracks = useMemo(
    () => getSvDataTracksForSide(lowerBufferData, 'target'),
    [lowerBufferData],
  )
  const referenceSignalTracks = useMemo(
    () => getSvSignalTracksForSide(
      svBufferMatchesRefWindow(upperBufferData, viewRefWindow)
        ? upperBufferData
        : (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData : null),
      'reference',
    ),
    [upperBufferData, lowerBufferData, viewRefWindow],
  )
  const topSignalTracks = useMemo(
    () => getSvSignalTracksForSide(upperBufferData, 'target'),
    [upperBufferData],
  )
  const bottomSignalTracks = useMemo(
    () => getSvSignalTracksForSide(lowerBufferData, 'target'),
    [lowerBufferData],
  )

  // The alignment web component can emit an initial alt viewport before its
  // region name is known. Never let that temporary chrom-less window mask the
  // chromosome resolved by the completed SV buffer response.
  const resolvedTopChrom = useMemo(
    () => resolveSvFeatureWindowChrom(upperBufferData?.tgt_chrom, viewTopWindow, autoTopWindow, fallbackTopWindow),
    [upperBufferData?.tgt_chrom, viewTopWindow?.chrom, autoTopWindow?.chrom, fallbackTopWindow?.chrom],
  )
  const resolvedBottomChrom = useMemo(
    () => resolveSvFeatureWindowChrom(lowerBufferData?.tgt_chrom, viewBottomWindow, autoBottomWindow, fallbackBottomWindow),
    [lowerBufferData?.tgt_chrom, viewBottomWindow?.chrom, autoBottomWindow?.chrom, fallbackBottomWindow?.chrom],
  )
  const normalizedViewTopWindow = useMemo(
    () => withWindowChrom(viewTopWindow, resolvedTopChrom),
    [viewTopWindow, resolvedTopChrom],
  )
  const normalizedViewBottomWindow = useMemo(
    () => withWindowChrom(viewBottomWindow, resolvedBottomChrom),
    [viewBottomWindow, resolvedBottomChrom],
  )
  const normalizedAutoTopWindow = useMemo(
    () => withWindowChrom(autoTopWindow, resolvedTopChrom),
    [autoTopWindow, resolvedTopChrom],
  )
  const normalizedAutoBottomWindow = useMemo(
    () => withWindowChrom(autoBottomWindow, resolvedBottomChrom),
    [autoBottomWindow, resolvedBottomChrom],
  )
  const normalizedFallbackTopWindow = useMemo(
    () => withWindowChrom(fallbackTopWindow, resolvedTopChrom),
    [fallbackTopWindow, resolvedTopChrom],
  )
  const normalizedFallbackBottomWindow = useMemo(
    () => withWindowChrom(fallbackBottomWindow, resolvedBottomChrom),
    [fallbackBottomWindow, resolvedBottomChrom],
  )

  useEffect(() => {
    if (!resolvedTopChrom) return
    setViewTopWindow((prev) => (prev && !prev.chrom ? { ...prev, chrom: resolvedTopChrom } : prev))
  }, [resolvedTopChrom])

  useEffect(() => {
    if (!resolvedBottomChrom) return
    setViewBottomWindow((prev) => (prev && !prev.chrom ? { ...prev, chrom: resolvedBottomChrom } : prev))
  }, [resolvedBottomChrom])

  const displayRefWindow = previewRefWindow || viewRefWindow
  const baseTopWindow = normalizedViewTopWindow || normalizedAutoTopWindow || normalizedFallbackTopWindow
  const baseBottomWindow = normalizedViewBottomWindow || normalizedAutoBottomWindow || normalizedFallbackBottomWindow
  const displayTopWindow = previewTopWindow || baseTopWindow
  const displayBottomWindow = previewBottomWindow || baseBottomWindow

  const refChromSize = useMemo(
    () => getResolvedChromSize(
      (svBufferMatchesRefWindow(upperBufferData, viewRefWindow) ? upperBufferData?.ref_chrom_sizes : null)
        || (svBufferMatchesRefWindow(lowerBufferData, viewRefWindow) ? lowerBufferData?.ref_chrom_sizes : null),
      viewRefWindow?.chrom,
    ),
    [upperBufferData, lowerBufferData, viewRefWindow?.chrom],
  )
  const topChromSize = useMemo(
    () => getResolvedChromSize(upperBufferData?.tgt_chrom_sizes, baseTopWindow?.chrom),
    [upperBufferData, baseTopWindow?.chrom],
  )
  const bottomChromSize = useMemo(
    () => getResolvedChromSize(lowerBufferData?.tgt_chrom_sizes, baseBottomWindow?.chrom),
    [lowerBufferData, baseBottomWindow?.chrom],
  )
  const alignmentRegionLength = useMemo(
    () => refChromSize || 500_000_000,
    [refChromSize],
  )
  const topRegionLength = useMemo(
    () => topChromSize || 500_000_000,
    [topChromSize],
  )
  const bottomRegionLength = useMemo(
    () => bottomChromSize || 500_000_000,
    [bottomChromSize],
  )

  useEffect(() => { displayRefWindowRef.current = displayRefWindow }, [displayRefWindow])
  useEffect(() => { displayTopWindowRef.current = displayTopWindow }, [displayTopWindow])
  useEffect(() => { displayBottomWindowRef.current = displayBottomWindow }, [displayBottomWindow])
  useEffect(() => { refChromSizeRef.current = refChromSize }, [refChromSize])
  useEffect(() => { topChromSizeRef.current = topChromSize }, [topChromSize])
  useEffect(() => { bottomChromSizeRef.current = bottomChromSize }, [bottomChromSize])

  useEffect(() => {
    if (!savedViewportRef || !viewRefWindow) return
    savedViewportRef.current = {
      refWindow: viewRefWindow,
      topWindow: viewTopWindow,
      bottomWindow: viewBottomWindow,
      refAssembly,
      topAssembly,
      bottomAssembly,
      seededRegionKey: seededAnchorRegionKeyRef.current,
      seededBrowserKey: seededBrowserKeyRef.current,
      regionSeedBrowserKey: regionSeedBrowserKeyRef.current,
    }
  }, [viewRefWindow, viewTopWindow, viewBottomWindow, refAssembly, topAssembly, bottomAssembly]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prevBottomAlignmentId = prevBottomAlignmentIdRef.current
    prevBottomAlignmentIdRef.current = selectedBottomAlignmentId
    // Detect: third genome became the second (its alignment is now the top alignment)
    if (prevBottomAlignmentId && !selectedBottomAlignmentId && selectedTopAlignmentId === prevBottomAlignmentId) {
      setViewTopWindow(displayBottomWindowRef.current || null)
      setPreviewTopWindow(null)
      setViewBottomWindow(null)
      setPreviewBottomWindow(null)
      setFeatureTrackData((prev) => ({ reference: prev.reference, top: prev.bottom, bottom: [] }))
      setFeatureTrackLoading((prev) => ({ reference: prev.reference, top: false, bottom: false }))
      setUpperBufferData(lowerBufferDataRef.current)
      setLowerBufferData(null)
      featureTrackCacheRef.current = { reference: featureTrackCacheRef.current.reference, top: featureTrackCacheRef.current.bottom, bottom: null }
    }
  }, [selectedBottomAlignmentId, selectedTopAlignmentId])

  const requestCanonicalTrackData = useCallback(async (slotKey, genomeId, window) => {
    if (!window?.chrom || !genomeId || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) {
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, []))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      return
    }

    const genomeIdentity = slotKey === 'reference'
      ? (refAssembly || genomeId)
      : slotKey === 'top'
        ? (topAssembly || genomeId)
        : (bottomAssembly || genomeId)
    const chromSize = slotKey === 'reference'
      ? refChromSizeRef.current
      : slotKey === 'top'
        ? topChromSizeRef.current
        : bottomChromSizeRef.current
    const effectiveChromSize = chromSize || 500_000_000
    const requestWindow = svLoadingMode === 'eager'
      ? (buildChromWindow(window.chrom, effectiveChromSize, 1) || window)
      : window
    const cacheKey = `${SV_AUX_TRACK_CACHE_VERSION}:${svLoadingMode}:${slotKey}:${genomeIdentity}:${genomeId}:${getWindowKey(requestWindow)}`
    const retryState = featureTrackRetryRef.current[slotKey]
    if (retryState.key !== cacheKey) {
      if (retryState.timer) clearTimeout(retryState.timer)
      Object.assign(retryState, { key: cacheKey, attempt: 0, timer: null })
    }
    const cached = featureTrackCacheRef.current[slotKey]
    if (cached?.key === cacheKey) {
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, cached.entries))
      setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      return
    }

    featureTrackTokenRef.current[slotKey] = (featureTrackTokenRef.current[slotKey] || 0) + 1
    const token = featureTrackTokenRef.current[slotKey]
    featureTrackAbortRef.current[slotKey]?.abort?.()
    const abortController = new AbortController()
    featureTrackAbortRef.current[slotKey] = abortController
    setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, true))

    try {
      const params = new URLSearchParams({
        genome: genomeId,
        chrom: requestWindow.chrom,
        start: String(requestWindow.start),
        end: String(requestWindow.end),
      })
      const res = await fetch(`${API_BASE}/api/browse/canonical_transcripts?${params.toString()}`, {
        signal: abortController.signal,
      })
      if (!res.ok) {
        throw new Error(`Canonical transcript request failed (${res.status})`)
      }
      const data = await res.json()
      if (token !== featureTrackTokenRef.current[slotKey]) return
      featureTrackCacheRef.current[slotKey] = {
        key: cacheKey,
        entries: Array.isArray(data) ? data : [],
      }
      retryState.attempt = 0
      setFeatureTrackData((prev) => updateObjectSlot(prev, slotKey, Array.isArray(data) ? data : []))
    } catch (e) {
      if (e?.name === 'AbortError') return
      if (token !== featureTrackTokenRef.current[slotKey]) return
      console.warn(`Failed to load ${genomeId} canonical transcripts`, e)
      if (!retryState.timer && retryState.attempt < SV_TRANSIENT_RETRY_LIMIT) {
        retryState.attempt += 1
        retryState.timer = setTimeout(() => {
          retryState.timer = null
          if (retryState.key === cacheKey) requestCanonicalTrackData(slotKey, genomeId, window)
        }, getSvTransientRetryDelay(retryState.attempt))
      }
    } finally {
      if (featureTrackAbortRef.current[slotKey] === abortController) {
        featureTrackAbortRef.current[slotKey] = null
      }
      if (token === featureTrackTokenRef.current[slotKey] && !retryState.timer) {
        setFeatureTrackLoading((prev) => updateObjectSlot(prev, slotKey, false))
      }
    }
  }, [svLoadingMode, refAssembly, topAssembly, bottomAssembly])

  useEffect(() => {
    if (viewRefWindow) {
      requestCanonicalTrackData('reference', referenceBrowseGenomeId, viewRefWindow)
    }
    if (baseTopWindow) {
      requestCanonicalTrackData('top', topBrowseGenomeId, baseTopWindow)
    }
    if (baseBottomWindow && bottomBrowseGenomeId) {
      requestCanonicalTrackData('bottom', bottomBrowseGenomeId, baseBottomWindow)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    baseTopWindow?.chrom,
    baseTopWindow?.start,
    baseTopWindow?.end,
    baseBottomWindow?.chrom,
    baseBottomWindow?.start,
    baseBottomWindow?.end,
    referenceBrowseGenomeId,
    topBrowseGenomeId,
    bottomBrowseGenomeId,
    topChromSize,
    bottomChromSize,
    requestCanonicalTrackData,
  ])

  const getCenteredOuterWindows = useCallback((nextRefWindow, topBaseWindow = null, bottomBaseWindow = null) => {
    if (!nextRefWindow) {
      return { top: topBaseWindow, bottom: bottomBaseWindow }
    }
    const currentTopBase = topBaseWindow || displayTopWindowRef.current || autoTopWindow || fallbackTopWindow
    const currentBottomBase = bottomBaseWindow || displayBottomWindowRef.current || autoBottomWindow || fallbackBottomWindow
    const upperAlignments = upperAlignmentsRef.current?.data?.alignments || []
    const lowerAlignments = lowerAlignmentsRef.current?.data?.alignments || []

    const nextTop = buildCenteredTargetWindow(
      nextRefWindow,
      currentTopBase,
      upperAlignments,
      topChromSizeRef.current,
    ) || currentTopBase
    const nextBottom = buildCenteredTargetWindow(
      nextRefWindow,
      currentBottomBase,
      lowerAlignments,
      bottomChromSizeRef.current,
    ) || currentBottomBase

    return { top: nextTop, bottom: nextBottom }
  }, [autoTopWindow, fallbackTopWindow, autoBottomWindow, fallbackBottomWindow])

  const syncUpperAlignmentViewport = useCallback((refWindow, topWindow) => {
    const el = upperAlignmentsRef.current
    if (!el || !refWindow) return
    el.endpoints = getUpperRuntimeEndpoints()
    el.referenceGenomeId = refAssembly
    el.altGenomeId = topAssembly
    el.imageHeight = alignmentPanelHeight
    el.loadingStrategy = svLoadingMode
    // The web component has no access to React config, so the resolved scheme
    // is handed to it as a property.
    el.browsingControls = browsingControls
    el.displayOrder = 'alt-top'
    el.linkedViewports = true
    el.regionName = refWindow.chrom
    el.altRegionName = topWindow?.chrom || ''
    el.regionLength = alignmentRegionLength
    el.start = refWindow.start
    el.end = refWindow.end
    el.altRegionLength = topRegionLength
    el.altStart = topWindow?.start ?? 0
    el.altEnd = topWindow?.end ?? 0
  }, [refAssembly, topAssembly, alignmentPanelHeight, svLoadingMode, alignmentRegionLength, topRegionLength, getUpperRuntimeEndpoints, browsingControls])

  const syncLowerAlignmentViewport = useCallback((refWindow, bottomWindow) => {
    const el = lowerAlignmentsRef.current
    if (!el || !refWindow) return
    el.endpoints = getLowerRuntimeEndpoints()
    el.referenceGenomeId = refAssembly
    el.altGenomeId = bottomAssembly
    el.imageHeight = alignmentPanelHeight
    el.loadingStrategy = svLoadingMode
    // The web component has no access to React config, so the resolved scheme
    // is handed to it as a property.
    el.browsingControls = browsingControls
    el.displayOrder = 'reference-top'
    el.linkedViewports = true
    el.regionName = refWindow.chrom
    el.altRegionName = bottomWindow?.chrom || ''
    el.regionLength = alignmentRegionLength
    el.start = refWindow.start
    el.end = refWindow.end
    el.altRegionLength = bottomRegionLength
    el.altStart = bottomWindow?.start ?? 0
    el.altEnd = bottomWindow?.end ?? 0
  }, [refAssembly, bottomAssembly, alignmentPanelHeight, svLoadingMode, alignmentRegionLength, bottomRegionLength, getLowerRuntimeEndpoints, browsingControls])

  useEffect(() => {
    syncUpperAlignmentViewport(viewRefWindow, baseTopWindow)
    const frame = requestAnimationFrame(() => syncUpperAlignmentViewport(viewRefWindow, baseTopWindow))
    return () => cancelAnimationFrame(frame)
  }, [syncUpperAlignmentViewport, viewRefWindow, baseTopWindow])

  useEffect(() => {
    syncLowerAlignmentViewport(viewRefWindow, baseBottomWindow)
    const frame = requestAnimationFrame(() => syncLowerAlignmentViewport(viewRefWindow, baseBottomWindow))
    return () => cancelAnimationFrame(frame)
  }, [syncLowerAlignmentViewport, viewRefWindow, baseBottomWindow])

  const clearPendingViewportCommit = useCallback(() => {
    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current)
      wheelCommitTimerRef.current = null
    }
  }, [])

  const pushPreviewViewport = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    displayRefWindowRef.current = nextRefWindow
    displayTopWindowRef.current = nextTopWindow
    displayBottomWindowRef.current = nextBottomWindow
    pendingPreviewRef.current = {
      ref: nextRefWindow,
      top: nextTopWindow,
      bottom: nextBottomWindow,
    }
    if (!previewFrameRef.current) {
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null
        const pending = pendingPreviewRef.current
        pendingPreviewRef.current = { ref: null, top: null, bottom: null }
        if (pending.ref) setPreviewRefWindow(pending.ref)
        if (pending.top) setPreviewTopWindow(pending.top)
        if (pending.bottom) setPreviewBottomWindow(pending.bottom)
        syncUpperAlignmentViewport(pending.ref, pending.top)
        syncLowerAlignmentViewport(pending.ref, pending.bottom)
      })
    }
  }, [syncUpperAlignmentViewport, syncLowerAlignmentViewport])

  const commitViewportChange = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    if (previewFrameRef.current) {
      cancelAnimationFrame(previewFrameRef.current)
      previewFrameRef.current = null
    }
    pendingPreviewRef.current = { ref: null, top: null, bottom: null }
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
    if (nextRefWindow) setViewRefWindow(nextRefWindow)
    if (nextTopWindow) setViewTopWindow(nextTopWindow)
    if (nextBottomWindow) setViewBottomWindow(nextBottomWindow)
  }, [])

  const scheduleViewportCommit = useCallback((nextRefWindow, nextTopWindow, nextBottomWindow) => {
    clearPendingViewportCommit()
    wheelCommitTimerRef.current = setTimeout(() => {
      wheelCommitTimerRef.current = null
      commitViewportChange(nextRefWindow, nextTopWindow, nextBottomWindow)
    }, WHEEL_COMMIT_DEBOUNCE_MS)
  }, [clearPendingViewportCommit, commitViewportChange])

  useEffect(() => {
    if (!viewRefWindow) return
    const topBase = displayTopWindowRef.current || autoTopWindow || fallbackTopWindow
    const bottomBase = displayBottomWindowRef.current || autoBottomWindow || fallbackBottomWindow
    if (!topBase || !bottomBase) return
    const next = getCenteredOuterWindows(viewRefWindow, topBase, bottomBase)
    if (!viewTopWindow && next.top) {
      setViewTopWindow(next.top)
    }
    if (!viewBottomWindow && next.bottom) {
      setViewBottomWindow(next.bottom)
    }
  }, [
    viewRefWindow?.chrom,
    viewRefWindow?.start,
    viewRefWindow?.end,
    upperBufferData,
    lowerBufferData,
    alignmentTrackLoading.top,
    alignmentTrackLoading.bottom,
    autoTopWindow,
    fallbackTopWindow,
    autoBottomWindow,
    fallbackBottomWindow,
    getCenteredOuterWindows,
    viewTopWindow,
    viewBottomWindow,
  ])

  const handleFeatureBandWheel = useCallback((side, event, element = null) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    if (isBoxSelectMode || isSelectingRect) return

    const currentRefWindow = displayRefWindowRef.current
    const currentTopWindow = displayTopWindowRef.current
    const currentBottomWindow = displayBottomWindowRef.current
    if (side === 'reference' && !currentRefWindow) return
    if (side === 'top' && !currentTopWindow) return
    if (side === 'bottom' && !currentBottomWindow) return

    const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
    const session = wheelSessionRef.current
    const gesture = beginWheelGesture(session.gesture, wheel, wheel.ts || performance.now())
    const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
      canScrollPage: Boolean(findNearestScrollable(event.target || element)),
      gesture,
    })
    markWheelHandled(event)
    session.gesture = { ...gesture, mode: intent.nextGestureMode || gesture.mode }
    if (intent.preventDefault) event.preventDefault()
    if (intent.stopPropagation) {
      event.stopPropagation()
      event.stopImmediatePropagation?.()
    }
    if (intent.type !== 'zoom' && intent.type !== 'pan') return

    const targetElement = element || event.currentTarget || event.target
    if (!targetElement?.getBoundingClientRect) return
    const rect = targetElement.getBoundingClientRect()
    const anchorFraction = intent.anchor === 'center'
      ? 0.5
      : clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1)

    let nextRefWindow = currentRefWindow
    let nextTopWindow = currentTopWindow
    let nextBottomWindow = currentBottomWindow
    if (intent.type === 'zoom') {
      if (currentRefWindow) {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
      }
      if (currentTopWindow) {
        nextTopWindow = zoomWindowAround(currentTopWindow, intent.factor, anchorFraction, 1, topChromSizeRef.current)
      }
      if (currentBottomWindow) {
        nextBottomWindow = zoomWindowAround(currentBottomWindow, intent.factor, anchorFraction, 1, bottomChromSizeRef.current)
      }
    } else {
      if (side === 'reference' && currentRefWindow) {
        nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
      } else if (side === 'top' && currentTopWindow) {
        nextTopWindow = panWindowByPixels(currentTopWindow, intent.dxPx, rect.width, 1, topChromSizeRef.current)
      } else if (side === 'bottom' && currentBottomWindow) {
        nextBottomWindow = panWindowByPixels(currentBottomWindow, intent.dxPx, rect.width, 1, bottomChromSizeRef.current)
      }
    }

    externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
    pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
    scheduleViewportCommit(nextRefWindow, nextTopWindow, nextBottomWindow)
  }, [pushPreviewViewport, scheduleViewportCommit, isBoxSelectMode, isSelectingRect])

  useEffect(() => {
    const interactiveArea = interactiveAreaRef.current
    if (!interactiveArea) return

    const handleWorkspaceWheel = (event) => {
      if (isBoxSelectMode || isSelectingRect) {
        event.preventDefault()
        return
      }
      const currentRefWindow = displayRefWindowRef.current
      const currentTopWindow = displayTopWindowRef.current
      const currentBottomWindow = displayBottomWindowRef.current
      if (!currentRefWindow) return

      const wheel = readWheelEvent(event, { pageHeight: window.innerHeight })
      const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
        canScrollPage: Boolean(findNearestScrollable(event.target || interactiveArea)),
      })
      markWheelHandled(event)
      if (intent.preventDefault) event.preventDefault()
      if (intent.stopPropagation) {
        event.stopPropagation()
        event.stopImmediatePropagation?.()
      }
      if (intent.type !== 'zoom' && intent.type !== 'pan') return

      const rect = interactiveArea.getBoundingClientRect()
      if (rect.width <= 0) return
      const anchorFraction = intent.anchor === 'center'
        ? 0.5
        : clamp((event.clientX - rect.left) / rect.width, 0, 1)

      let nextRefWindow = currentRefWindow
      let nextTopWindow = currentTopWindow
      let nextBottomWindow = currentBottomWindow
      if (intent.type === 'zoom') {
        nextRefWindow = zoomWindowAround(currentRefWindow, intent.factor, anchorFraction, 1, refChromSizeRef.current)
        if (currentTopWindow) {
          nextTopWindow = zoomWindowAround(currentTopWindow, intent.factor, anchorFraction, 1, topChromSizeRef.current)
        }
        if (currentBottomWindow) {
          nextBottomWindow = zoomWindowAround(currentBottomWindow, intent.factor, anchorFraction, 1, bottomChromSizeRef.current)
        }
      } else {
        nextRefWindow = panWindowByPixels(currentRefWindow, intent.dxPx, rect.width, 1, refChromSizeRef.current)
        if (currentTopWindow) {
          nextTopWindow = panWindowByPixels(currentTopWindow, intent.dxPx, rect.width, 1, topChromSizeRef.current)
        }
        if (currentBottomWindow) {
          nextBottomWindow = panWindowByPixels(currentBottomWindow, intent.dxPx, rect.width, 1, bottomChromSizeRef.current)
        }
      }

      externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
      pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
      scheduleViewportCommit(nextRefWindow, nextTopWindow, nextBottomWindow)
    }

    interactiveArea.addEventListener('wheel', handleWorkspaceWheel, { passive: false, capture: true })
    return () => {
      interactiveArea.removeEventListener('wheel', handleWorkspaceWheel, true)
    }
  }, [isBoxSelectMode, isSelectingRect, pushPreviewViewport, scheduleViewportCommit, viewRefWindow])

  useEffect(() => {
    const topEl = topFeatureBandRef.current
    const midEl = middleFeatureBandRef.current
    const bottomEl = bottomFeatureBandRef.current
    const handleTop = (e) => handleFeatureBandWheel('top', e, topEl)
    const handleMid = (e) => handleFeatureBandWheel('reference', e, midEl)
    const handleBottom = (e) => handleFeatureBandWheel('bottom', e, bottomEl)
    if (topEl) topEl.addEventListener('wheel', handleTop, { passive: false })
    if (midEl) midEl.addEventListener('wheel', handleMid, { passive: false })
    if (bottomEl) bottomEl.addEventListener('wheel', handleBottom, { passive: false })
    return () => {
      if (topEl) topEl.removeEventListener('wheel', handleTop)
      if (midEl) midEl.removeEventListener('wheel', handleMid)
      if (bottomEl) bottomEl.removeEventListener('wheel', handleBottom)
    }
  }, [handleFeatureBandWheel, viewRefWindow])

  useEffect(() => {
    const handlePointerMove = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      const deltaX = event.clientX - dragState.startX
      const deltaY = event.clientY - dragState.startY

      // Axis-locked, exactly as in the Genome Browser: sideways pans the tracks,
      // up/down scrolls the page. Same 5px threshold and vertical bias, so the
      // two views feel identical under the hand.
      if (!dragState.axis) {
        const axis = resolveDragAxis({
          dx: deltaX,
          dy: deltaY,
          canScrollPage: Boolean(dragState.scroller),
          currentAxis: null,
        })
        if (!axis) return
        dragState.axis = axis
      }

      if (dragState.axis === 'y') {
        if (!dragState.scroller) return
        dragState.dragging = true
        event.preventDefault()
        // 1:1 grab-and-drag: the content follows the cursor, so dragging down
        // reveals what is above.
        dragState.scroller.scrollTop = dragState.startScrollTop - deltaY
        return
      }

      if (!deltaX) return
      dragState.dragging = true
      event.preventDefault()
      let nextRefWindow = dragState.startRefWindow
      let nextTopWindow = dragState.startTopWindow
      let nextBottomWindow = dragState.startBottomWindow
      if (dragState.side === 'reference' && dragState.startRefWindow) {
        nextRefWindow = panWindowByPixels(dragState.startRefWindow, -deltaX, dragState.width, 1, refChromSizeRef.current)
      } else if (dragState.side === 'top' && dragState.startTopWindow) {
        nextTopWindow = panWindowByPixels(dragState.startTopWindow, -deltaX, dragState.width, 1, topChromSizeRef.current)
      } else if (dragState.side === 'bottom' && dragState.startBottomWindow) {
        nextBottomWindow = panWindowByPixels(dragState.startBottomWindow, -deltaX, dragState.width, 1, bottomChromSizeRef.current)
      }
      dragState.currentRefWindow = nextRefWindow
      dragState.currentTopWindow = nextTopWindow
      dragState.currentBottomWindow = nextBottomWindow
      externalViewportInteractionRef.current.dragging = true
      pushPreviewViewport(nextRefWindow, nextTopWindow, nextBottomWindow)
    }

    const finishDrag = (event) => {
      const dragState = featureBandDragRef.current
      if (!dragState || event.pointerId !== dragState.pointerId) return
      // A vertical drag only scrolled the page — there is no viewport change to
      // commit, and committing one would broadcast a spurious external event.
      if (dragState.dragging && dragState.axis !== 'y') {
        commitViewportChange(dragState.currentRefWindow, dragState.currentTopWindow, dragState.currentBottomWindow)
      }
      externalViewportInteractionRef.current.dragging = false
      externalViewportInteractionRef.current.activeUntil = performance.now() + SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS
      if (dragState.element && dragState.pointerId != null) {
        try {
          dragState.element.releasePointerCapture?.(dragState.pointerId)
        } catch {
          // ignored
        }
      }
      featureBandDragRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', finishDrag)
    window.addEventListener('pointercancel', finishDrag)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
    }
  }, [commitViewportChange, pushPreviewViewport])

  const handleFeatureBandPointerDown = useCallback((side, event) => {
    if (isBoxSelectMode || isSelectingRect) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.button !== 0) return
    const startRefWindow = displayRefWindowRef.current
    const startTopWindow = displayTopWindowRef.current
    const startBottomWindow = displayBottomWindowRef.current
    if (side === 'reference' && !startRefWindow) return
    if (side === 'top' && !startTopWindow) return
    if (side === 'bottom' && !startBottomWindow) return

    clearPendingViewportCommit()
    externalViewportInteractionRef.current.dragging = true
    const rect = event.currentTarget.getBoundingClientRect()
    const scroller = findNearestScrollable(event.currentTarget)
    featureBandDragRef.current = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      scroller,
      startScrollTop: scroller ? scroller.scrollTop : 0,
      width: Math.max(1, rect.width),
      startRefWindow,
      startTopWindow,
      startBottomWindow,
      currentRefWindow: startRefWindow,
      currentTopWindow: startTopWindow,
      currentBottomWindow: startBottomWindow,
      dragging: false,
      element: event.currentTarget,
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [clearPendingViewportCommit, isBoxSelectMode, isSelectingRect])

  useEffect(() => {
    const registerRibbon = (element, slot) => {
      if (!element) return () => {}
      const label = slot === 'top' ? 'second genome' : 'third genome'

      const windowsFromRibbonEvent = (detail) => {
        const { reference, alt } = detail ?? {}
        const currentRefWindow = displayRefWindowRef.current
        const nextRefWindow = reference && Number.isFinite(reference.start) && Number.isFinite(reference.end)
          ? {
            chrom: reference.regionName || currentRefWindow?.chrom || viewRefWindow?.chrom || '',
            start: reference.start,
            end: reference.end,
          }
          : currentRefWindow
        const currentAltWindow = slot === 'top'
          ? displayTopWindowRef.current
          : displayBottomWindowRef.current
        const nextAltWindow = alt && Number.isFinite(alt.start) && Number.isFinite(alt.end)
          ? {
            chrom: alt.regionName || currentAltWindow?.chrom || '',
            start: alt.start,
            end: alt.end,
          }
          : currentAltWindow

        if (slot === 'top') {
          const currentBottomWindow = displayBottomWindowRef.current
          const nextBottomWindow = transformOuterWindowFromReferenceChange(
            currentRefWindow,
            nextRefWindow,
            currentBottomWindow,
            bottomChromSizeRef.current,
          )
          return { ref: nextRefWindow, top: nextAltWindow, bottom: nextBottomWindow }
        }

        const currentTopWindow = displayTopWindowRef.current
        const nextTopWindow = transformOuterWindowFromReferenceChange(
          currentRefWindow,
          nextRefWindow,
          currentTopWindow,
          topChromSizeRef.current,
        )
        return { ref: nextRefWindow, top: nextTopWindow, bottom: nextAltWindow }
      }

      const handlePreview = (e) => {
        const externalInteraction = externalViewportInteractionRef.current
        if (externalInteraction.dragging || performance.now() < externalInteraction.activeUntil) return
        const next = windowsFromRibbonEvent(e.detail)
        pushPreviewViewport(next.ref, next.top, next.bottom)
      }

      const handleCommit = (e) => {
        const externalInteraction = externalViewportInteractionRef.current
        if (externalInteraction.dragging || performance.now() < externalInteraction.activeUntil) return
        const next = windowsFromRibbonEvent(e.detail)
        commitViewportChange(next.ref, next.top, next.bottom)
      }

      const handleLoadingChange = (event) => {
        setAlignmentTrackLoading((prev) => updateObjectSlot(prev, slot, Boolean(event.detail?.loading)))
      }

      const handleLoadingError = (event) => {
        setAlignmentTrackLoading((prev) => updateObjectSlot(prev, slot, false))
        setStatusText(`The ${label} alignment ribbon could not be loaded: ${event.detail?.message || 'unknown error'}`)
      }

      element.addEventListener('viewport-change', handlePreview)
      element.addEventListener('viewport-change-end', handleCommit)
      element.addEventListener('loading-change', handleLoadingChange)
      element.addEventListener('loading-error', handleLoadingError)
      return () => {
        element.removeEventListener('viewport-change', handlePreview)
        element.removeEventListener('viewport-change-end', handleCommit)
        element.removeEventListener('loading-change', handleLoadingChange)
        element.removeEventListener('loading-error', handleLoadingError)
      }
    }

    const cleanupUpper = registerRibbon(upperAlignmentsRef.current, 'top')
    const cleanupLower = registerRibbon(lowerAlignmentsRef.current, 'bottom')
    return () => {
      cleanupUpper()
      cleanupLower()
    }
  }, [
    pushPreviewViewport,
    commitViewportChange,
    viewRefWindow?.chrom,
    selectedTopAlignmentId,
    selectedBottomAlignmentId,
    baseTopWindow?.chrom,
    baseBottomWindow?.chrom,
  ])

  useEffect(() => {
    const updateSelectionRectFromEvent = (event) => {
      const drag = selectionDragRef.current
      const area = interactiveAreaRef.current
      if (!drag || !area || event.pointerId !== drag.pointerId) return
      const rect = area.getBoundingClientRect()
      const x = clamp(event.clientX - rect.left, 0, rect.width)
      const y = clamp(event.clientY - rect.top, 0, rect.height)
      setSelectionRect((prev) => (prev ? { ...prev, x2: x, y2: y } : prev))
    }

    const finishSelection = (event) => {
      const drag = selectionDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const finalRect = selectionRect
      selectionDragRef.current = null
      setIsSelectingRect(false)
      setIsBoxSelectMode(false)

      if (drag.element && drag.pointerId != null) {
        try {
          drag.element.releasePointerCapture?.(drag.pointerId)
        } catch {
          // ignored
        }
      }

      if (!finalRect || !displayRefWindowRef.current) {
        setSelectionRect(null)
        return
      }

      const plotLeft = PLOT_PAD_X
      const plotRight = Math.max(plotLeft + 400, panelWidth - PLOT_PAD_X)
      const plotWidth = Math.max(1, plotRight - plotLeft)
      const minX = clamp(Math.min(finalRect.x1, finalRect.x2), plotLeft, plotRight)
      const maxX = clamp(Math.max(finalRect.x1, finalRect.x2), plotLeft, plotRight)
      setSelectionRect(null)
      if ((maxX - minX) <= 2) return

      const currentRefWindow = displayRefWindowRef.current
      const currentRefSpan = Math.max(1, currentRefWindow.end - currentRefWindow.start)
      const nextRefStart = currentRefWindow.start + ((minX - plotLeft) / plotWidth) * currentRefSpan
      const nextRefEnd = currentRefWindow.start + ((maxX - plotLeft) / plotWidth) * currentRefSpan
      const nextRefWindow = constrainWindowToZoomLimits({
        chrom: currentRefWindow.chrom,
        start: Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))),
        end: Math.max(Math.max(1, Math.round(Math.min(nextRefStart, nextRefEnd))) + 1, Math.round(Math.max(nextRefStart, nextRefEnd))),
      }, refChromSizeRef.current)
      const next = getCenteredOuterWindows(nextRefWindow)
      clearPendingViewportCommit()
      setPreviewRefWindow(null)
      setPreviewTopWindow(null)
      setPreviewBottomWindow(null)
      setViewRefWindow(nextRefWindow)
      if (next.top) setViewTopWindow(next.top)
      if (next.bottom) setViewBottomWindow(next.bottom)
    }

    window.addEventListener('pointermove', updateSelectionRectFromEvent, { passive: false })
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', finishSelection)
    return () => {
      window.removeEventListener('pointermove', updateSelectionRectFromEvent)
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', finishSelection)
    }
  }, [selectionRect, panelWidth, getCenteredOuterWindows, clearPendingViewportCommit])

  const handleSelectionOverlayPointerDown = useCallback((event) => {
    if (!isBoxSelectMode || event.button !== 0) return
    const area = interactiveAreaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    const x = clamp(event.clientX - rect.left, 0, rect.width)
    const y = clamp(event.clientY - rect.top, 0, rect.height)
    clearPendingViewportCommit()
    setIsSelectingRect(true)
    setSelectionRect({ x1: x, y1: y, x2: x, y2: y })
    selectionDragRef.current = { pointerId: event.pointerId, element: event.currentTarget }
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [isBoxSelectMode, clearPendingViewportCommit])

  const applyZoom = useCallback((factor) => {
    const currentRefWindow = displayRefWindowRef.current
    if (!currentRefWindow) return
    clearPendingViewportCommit()
    const nextRefWindow = zoomWindowAround(currentRefWindow, factor, 0.5, 1, refChromSizeRef.current)
    const next = getCenteredOuterWindows(nextRefWindow)
    setPreviewRefWindow(null)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
    setViewRefWindow(nextRefWindow)
    if (next.top) setViewTopWindow(next.top)
    if (next.bottom) setViewBottomWindow(next.bottom)
  }, [clearPendingViewportCommit, getCenteredOuterWindows])

  const centerAlignment = useCallback(() => {
    const currentRefWindow = displayRefWindowRef.current
    if (!currentRefWindow) return
    const next = getCenteredOuterWindows(currentRefWindow)
    if (next.top) setViewTopWindow(next.top)
    if (next.bottom) setViewBottomWindow(next.bottom)
    setPreviewTopWindow(null)
    setPreviewBottomWindow(null)
  }, [getCenteredOuterWindows])

  const upperAlignmentKey = `${selectedTopAlignmentId}|${refAssembly}|${topAssembly}|${viewRefWindow?.chrom || ''}|upper`
  const lowerAlignmentKey = `${selectedBottomAlignmentId}|${refAssembly}|${bottomAssembly}|${viewRefWindow?.chrom || ''}|lower`

  // Wait for the target window before mounting a ribbon. Mounting it earlier
  // starts a reference-only full-chromosome request which is immediately replaced
  // when /api/sv/view supplies the target window.
  const canRenderUpperRibbon = Boolean(
    refSpecies
    && tgtSpecies
    && selectedTopAlignmentId
    && viewRefWindow
    && baseTopWindow?.chrom
  )
  const hasLowerSection = Boolean(selectedBottomAlignmentId)
  const canRenderLowerRibbon = Boolean(
    canRenderUpperRibbon
    && thirdSpecies
    && selectedBottomAlignmentId
    && baseBottomWindow?.chrom
  )
  const legendSectionClass = isLight ? 'border-gray-200 bg-gray-50/90 text-gray-700' : 'border-gray-700 bg-[#152033] text-gray-300'
  const legendTitleClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const legendItems = [
    {
      title: 'Alignment type',
      items: [
        { label: 'Match', swatch: 'rgba(73, 184, 255, 0.28)', border: 'rgba(73, 184, 255, 0.55)' },
        { label: 'No match', swatch: null, border: isLight ? '#cbd5e1' : '#64748b' },
        { label: 'Inverted match', swatch: 'rgba(248, 192, 65, 0.52)', border: 'rgba(248, 192, 65, 0.72)' },
      ],
    },
    {
      title: 'Haplotype variant type',
      items: [
        { label: 'Deletion or loss', swatch: '#ff595c' },
        { label: 'Gain or insertion', swatch: '#5f73e6' },
        { label: 'SNV', swatch: '#f472b6' },
      ],
    },
  ]

  return (
    <div
      className={`rounded-xl ${themeClasses.panel} overflow-visible flex flex-col`}
      style={{
        minHeight: refSpecies && tgtSpecies && thirdSpecies && viewRefWindow ? 'calc(100vh - 180px)' : undefined,
      }}
    >
      <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center gap-2`}>
        <div className={`w-[300px] max-w-[34vw] shrink-0 truncate text-xs ${themeClasses.muted}`}>
          {viewRefWindow
            ? `${displayRefWindow?.chrom || viewRefWindow.chrom}:${formatCoord(displayRefWindow?.start || viewRefWindow.start)}-${formatCoord(displayRefWindow?.end || viewRefWindow.end)} (${formatBp(Math.max(1, (displayRefWindow?.end || viewRefWindow.end) - (displayRefWindow?.start || viewRefWindow.start)))})`
            : 'Set a region to begin'}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => applyZoom(1.12)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom out"
          >-</button>
          <button
            type="button"
            onClick={() => applyZoom(0.89)}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Zoom in"
          >+</button>
          <button
            type="button"
            onClick={centerAlignment}
            className={`px-2 py-1 rounded text-xs border ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 hover:bg-slate-700'}`}
            title="Center alignment between tracks"
            aria-label="Center alignment between tracks"
          >
            <span className="inline-flex h-3.5 w-3 items-center justify-center align-middle leading-none">
              <CenterAlignmentIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsBoxSelectMode((prev) => !prev)
              setIsSelectingRect(false)
              setSelectionRect(null)
              selectionDragRef.current = null
            }}
            className={`px-2 py-1 rounded text-xs border flex items-center justify-center ${isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100'}`}
            style={{
              boxShadow: isBoxSelectMode ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
            }}
            title={isBoxSelectMode ? 'Selection mode active: drag to zoom' : 'Activate selection zoom mode'}
            aria-label="Activate selection zoom mode"
          >
            <span className="inline-flex items-center justify-center align-middle leading-none" style={{ width: '18px', height: '18px' }}>
              <SelectionZoomIcon />
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCompactTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              compactTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
          >
            {compactTracks ? 'Expand' : 'Compress'}
          </button>
          <button
            type="button"
            onClick={() => setHideInactiveFeatureTracks((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              hideInactiveFeatureTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
          >
            {hideInactiveFeatureTracks ? 'Show inactive' : 'Hide inactive'}
          </button>
          <button
            type="button"
            onClick={() => setShowBigWigTracks((prev) => !prev)}
            aria-pressed={showBigWigTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigWigTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigWigTracks ? 'Hide BigWig signal tracks' : 'Load and show BigWig signal tracks'}
          >
            BigWig
          </button>
          <button
            type="button"
            onClick={() => setShowBigBedTracks((prev) => !prev)}
            aria-pressed={showBigBedTracks}
            className={`px-2.5 py-1 rounded text-xs border transition-colors ${
              showBigBedTracks
                ? (isLight ? 'border-sky-500 bg-sky-500 text-white hover:bg-sky-600' : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
                : (isLight ? 'border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700' : 'border-gray-600 bg-slate-800 hover:bg-slate-700 text-gray-100')
            }`}
            title={showBigBedTracks ? 'Hide BigBed interval tracks' : 'Load and show BigBed interval tracks'}
          >
            BigBed
          </button>
        </div>
      </div>
      {statusText && (upperBufferData || lowerBufferData) && (
        <div className={`border-b px-3 py-1.5 text-xs ${
          isLight ? 'border-gray-200 bg-amber-50 text-amber-800' : 'border-gray-700 bg-amber-950/30 text-amber-200'
        }`}>
          {statusText}
        </div>
      )}

      <div ref={bandSvgRef} className="flex-none overflow-visible flex flex-col pb-5">
        {error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-400">Error: {error}</div>
        ) : statusText && !upperBufferData && !lowerBufferData ? (
          <div className={`flex-1 flex items-center justify-center text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>{statusText}</div>
        ) : !viewRefWindow ? (
          <div className="flex-1 flex items-center justify-center text-sm opacity-70">Loading…</div>
        ) : (
          <div ref={interactiveAreaRef} className="relative">
            <div ref={topFeatureBandRef} className="w-full flex-none touch-none" onPointerDown={(event) => handleFeatureBandPointerDown('top', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="top"
                width={Math.max(760, panelWidth)}
                label="Secondary"
                pillLabel={tgtPillLabel || 'Secondary genome'}
                pillColor={topGenomeColor}
                window={displayTopWindow}
                entries={featureTrackData.top}
                loading={showTopGenesLoading}
                genomeId={topBrowseGenomeId}
                sequenceGenomeId={topBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="target"
                referenceWindow={displayRefWindow}
                altWindow={displayTopWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={topAssembly}
                altBrowseGenomeId={topBrowseGenomeId}
                annotationAlignments={upperAnnotationAlignments}
                compact={compactTracks}
              />
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={baseTopWindow}
                displayWindow={displayTopWindow}
                genomeId={topBrowseGenomeId}
                tracks={topSignalTracks}
                genomeColor={topGenomeColor}
              />
            )}

            <div ref={upperPanelRef} className="flex-none overflow-hidden" style={{ background: isLight ? '#edf5ff' : '#0d1830', height: `${alignmentPanelHeight}px`, position: 'relative' }}>
              {canRenderUpperRibbon && (
                <ens-sv-alignments
                  key={upperAlignmentKey}
                  ref={upperAlignmentsRef}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
              {showBigBedTracks && (
                <StructuralVariationRibbonOverlay
                  theme={theme}
                  width={Math.max(760, panelWidth)}
                  height={alignmentPanelHeight}
                  referenceWindow={viewRefWindow}
                  targetWindow={baseTopWindow}
                  displayReferenceWindow={displayRefWindow}
                  displayTargetWindow={displayTopWindow}
                  referenceTracks={referenceDataTracks}
                  targetTracks={topDataTracks}
                  referenceGenomeId={referenceBrowseGenomeId}
                  targetGenomeId={topBrowseGenomeId}
                  displayOrder="alt-top"
                />
              )}
              {showUpperAlignmentLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
                    <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Loading upper alignment…</div>
                  </div>
                </div>
              )}
            </div>

            {showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={viewRefWindow}
                displayWindow={displayRefWindow}
                genomeId={referenceBrowseGenomeId}
                tracks={referenceSignalTracks}
                genomeColor={referenceGenomeColor}
              />
            )}

            <div ref={middleFeatureBandRef} className="w-full flex-none touch-none" onPointerDown={(event) => handleFeatureBandPointerDown('reference', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="top"
                width={Math.max(760, panelWidth)}
                label="Primary"
                pillLabel={refPillLabel || 'Primary genome'}
                pillColor={referenceGenomeColor}
                window={displayRefWindow}
                entries={featureTrackData.reference}
                loading={showReferenceGenesLoading}
                genomeId={referenceBrowseGenomeId}
                sequenceGenomeId={referenceBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="reference"
                referenceWindow={displayRefWindow}
                altWindow={displayTopWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={topAssembly}
                altBrowseGenomeId={topBrowseGenomeId}
                annotationAlignments={upperAnnotationAlignments}
                comparisonAltWindow={displayBottomWindow}
                comparisonAltGenomeId={bottomAssembly}
                comparisonAnnotationAlignments={lowerAnnotationAlignments}
                compact={compactTracks}
              />
            </div>

            {hasLowerSection && (
            <div ref={lowerPanelRef} className="flex-none overflow-hidden" style={{ background: isLight ? '#edf5ff' : '#0d1830', height: `${alignmentPanelHeight}px`, position: 'relative' }}>
              {canRenderLowerRibbon && (
                <ens-sv-alignments
                  key={lowerAlignmentKey}
                  ref={lowerAlignmentsRef}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                  }}
                />
              )}
              {showBigBedTracks && (
                <StructuralVariationRibbonOverlay
                  theme={theme}
                  width={Math.max(760, panelWidth)}
                  height={alignmentPanelHeight}
                  referenceWindow={viewRefWindow}
                  targetWindow={baseBottomWindow}
                  displayReferenceWindow={displayRefWindow}
                  displayTargetWindow={displayBottomWindow}
                  referenceTracks={referenceDataTracks}
                  targetTracks={bottomDataTracks}
                  referenceGenomeId={referenceBrowseGenomeId}
                  targetGenomeId={bottomBrowseGenomeId}
                  displayOrder="reference-top"
                />
              )}
              {showLowerAlignmentLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-3 rounded-lg px-4 py-2" style={{ backgroundColor: isLight ? 'rgba(255,255,255,0.88)' : 'rgba(15,23,42,0.82)' }}>
                    <div className={`h-5 w-5 animate-spin rounded-full border-[3px] border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`} />
                    <div className={`text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Loading lower alignment…</div>
                  </div>
                </div>
              )}
            </div>
            )}

            {hasLowerSection && showBigWigTracks && (
              <StructuralVariationSignalTracks
                theme={theme}
                width={Math.max(760, panelWidth)}
                window={baseBottomWindow}
                displayWindow={displayBottomWindow}
                genomeId={bottomBrowseGenomeId}
                tracks={bottomSignalTracks}
                genomeColor={bottomGenomeColor}
              />
            )}

            {hasLowerSection && (
            <div ref={bottomFeatureBandRef} className="w-full flex-none touch-none mb-4" onPointerDown={(event) => handleFeatureBandPointerDown('bottom', event)}>
              <StructuralVariationFeatureBand
                theme={theme}
                position="bottom"
                width={Math.max(760, panelWidth)}
                label="Third"
                pillLabel={thirdPillLabel || 'Third genome'}
                pillColor={bottomGenomeColor}
                window={displayBottomWindow}
                entries={featureTrackData.bottom}
                loading={showBottomGenesLoading}
                genomeId={bottomBrowseGenomeId}
                sequenceGenomeId={bottomBrowseGenomeId}
                hideInactiveTracks={hideInactiveFeatureTracks}
                sequenceSide="target"
                referenceWindow={displayRefWindow}
                altWindow={displayBottomWindow}
                referenceGenomeId={refAssembly}
                altGenomeId={bottomAssembly}
                altBrowseGenomeId={bottomBrowseGenomeId}
                annotationAlignments={lowerAnnotationAlignments}
                compact={compactTracks}
              />
            </div>
            )}

            {(isBoxSelectMode || isSelectingRect) && (
              <div
                className="absolute inset-0 z-20"
                style={{ cursor: 'crosshair' }}
                onPointerDown={handleSelectionOverlayPointerDown}
                onWheel={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
              >
                {selectionRect && (
                  <div
                    className="absolute"
                    style={{
                      left: Math.min(selectionRect.x1, selectionRect.x2),
                      top: Math.min(selectionRect.y1, selectionRect.y2),
                      width: Math.max(1, Math.abs(selectionRect.x2 - selectionRect.x1)),
                      height: Math.max(1, Math.abs(selectionRect.y2 - selectionRect.y1)),
                      border: `1.5px dashed ${referenceGenomeColor}`,
                      backgroundColor: isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`px-3 py-2 border-t ${legendSectionClass}`}>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-xs">
          {legendItems.map((section) => (
            <div key={section.title} className="flex flex-col gap-1.5">
              <div className={`text-[11px] font-semibold ${legendTitleClass}`}>{section.title}</div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {section.items.map((item) => (
                  <div key={item.label} className="flex items-center gap-2">
                    <span
                      className="inline-block h-3.5 w-3.5 shrink-0"
                      style={{
                        backgroundColor: item.swatch || 'transparent',
                        border: item.border ? `1px solid ${item.border}` : 'none',
                      }}
                    />
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`px-3 py-1.5 border-t ${isLight ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-gray-700 bg-[#152033] text-gray-300'} text-xs flex items-center gap-3`}>
        {(upperBufferLoading || lowerBufferLoading) && <span>Buffering structural variation context…</span>}
        {!upperBufferLoading && !lowerBufferLoading && statusText && <span>{statusText}</span>}
        {!upperBufferLoading && !lowerBufferLoading && <span className="opacity-70">Structural variation (three-genome test mode)</span>}
      </div>
    </div>
  )
}

function dedupeSvSpeciesList(speciesList) {
  const out = []
  const seen = new Set()
  for (const species of speciesList || []) {
    const key = speciesGenomeKey(species)
    if (!species || !key || seen.has(key)) continue
    seen.add(key)
    out.push(species)
  }
  return out
}

function svSpeciesSelectionKey(species) {
  return getGenomeKey(species) || speciesGenomeKey(species)
}

// The key and label conventions this view uses, handed to the shared option
// builder so it does not have to guess at either.
const svGenomeOptionNaming = {
  keyForSpecies: svSpeciesSelectionKey,
  labelForSpecies: getSpeciesDisplayName,
  labelForGenome: getSvCatalogGenomeDisplayName,
}

const SV_GENOME_GROUP_LABELS = {
  selected: 'Selected genomes',
  add: 'Available locally',
  missing: 'No local data',
}

/** Render genome options grouped by whether they can be used.
 *
 * Genomes with no local data are listed rather than hidden, so a config naming a
 * genome that has not been downloaded explains itself instead of quietly producing
 * a shorter list than the file suggests.
 */
function renderSvGenomeOptionGroups(options, slot) {
  return ['selected', 'add', 'missing'].map((state) => {
    const group = (options || []).filter((option) => option.state === state)
    if (!group.length) return null
    return (
      <optgroup key={`${slot}-${state}`} label={SV_GENOME_GROUP_LABELS[state]}>
        {group.map((option) => (
          <option
            key={`${slot}-${option.value}`}
            value={option.value}
            disabled={option.disabled}
            title={getSvOptionTooltip(option)}
          >
            {formatSvGenomeOptionLabel(option)}
          </option>
        ))}
      </optgroup>
    )
  })
}

function StructuralVariationChooser({
  theme,
  catalog,
  catalogLoading,
  catalogError,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  selectedSecondAlignment,
  selectedThirdAlignment,
  secondAlignmentChoices = [],
  thirdAlignmentChoices = [],
  onPreferredAlignmentChange = null,
  anchorRegionOptions = [],
  selectedAnchorRegionId = '',
  regionExplicitlySelected = false,
  onAnchorRegionChange = null,
  onAnchorRegionSearch = null,
  onGenomeOrderChange,
  onOpenGenomeSelector,
  onRegisteredAlignment,
  onRemoveAlignment,
  outputDir,
}) {
  const isLight = theme === 'light'
  const [locationInput, setLocationInput] = useState('')
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])

  const activeKeys = useMemo(() => new Set(activeSpecies.map((species) => svSpeciesSelectionKey(species))), [activeSpecies])
  const selectedKeys = useMemo(() => new Set(
    dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies]).map((species) => svSpeciesSelectionKey(species)),
  ), [activeSpecies, inactiveSpecies])
  const anchorOptions = useMemo(() => {
    // Every genome that anchors at least one usable alignment, whether or not it is
    // in the top bar. Restricting this to the top bar meant loading a config
    // appeared to do nothing: its genomes were known but could not be chosen.
    const seen = new Set()
    const anchorGenomes = []
    for (const alignment of catalog?.alignments || []) {
      if (!alignment?.supported) continue
      const genome = alignment.reference_genome
      const id = String(genome?.id || '')
      if (!genome || (id && seen.has(id))) continue
      if (id) seen.add(id)
      anchorGenomes.push(genome)
    }
    return buildSvGenomeOptions(anchorGenomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming)
  }, [catalog, knownSpecies, selectedKeys, activeKeys])

  const outgoingAlignments = useMemo(() => getOutgoingSvAlignments(catalog, anchorSpecies), [catalog, anchorSpecies])
  const hasSelectedAnchorRegion = Boolean(selectedAnchorRegionId && regionExplicitlySelected)
  const selectedAnchorRegionOption = useMemo(() => {
    return (anchorRegionOptions || []).find((region) => getSvRegionKey(region) === selectedAnchorRegionId) || null
  }, [anchorRegionOptions, selectedAnchorRegionId])
  const targetOptions = useMemo(() => {
    if (!hasSelectedAnchorRegion) return []
    const seen = new Set()
    const genomes = []
    const alignmentByGenomeId = new Map()
    for (const alignment of outgoingAlignments) {
      const genome = alignment?.target_genome
      if (!genome?.id || seen.has(genome.id)) continue
      // A genome that is not downloaded has no sequence names to intersect, so its
      // alignments list no regions and the region filter would drop it silently.
      // Keep it: the option is disabled anyway, and a config's genome explaining
      // why it cannot be used beats it simply not being there.
      const regionUnknowable = !genome.local
      if (selectedAnchorRegionId && !regionUnknowable && !alignmentSupportsAnchorRegion(alignment, selectedAnchorRegionId)) continue
      seen.add(genome.id)
      genomes.push(genome)
      alignmentByGenomeId.set(genome.id, alignment)
    }
    return buildSvGenomeOptions(genomes, knownSpecies, selectedKeys, activeKeys, svGenomeOptionNaming).map((option) => {
      const alignment = alignmentByGenomeId.get(String(option.genome?.id || '')) || null
      const supported = Boolean(alignment?.supported)
      return {
        ...option,
        alignment,
        supported,
        disabled: option.disabled || !supported,
      }
    })
  }, [outgoingAlignments, knownSpecies, activeKeys, selectedKeys, selectedAnchorRegionId, hasSelectedAnchorRegion])

  const optionByValue = useMemo(() => {
    const map = new Map()
    for (const option of [...anchorOptions, ...targetOptions]) {
      map.set(option.value, option)
    }
    return map
  }, [anchorOptions, targetOptions])

  const selectedAnchorValue = anchorSpecies ? `species:${svSpeciesSelectionKey(anchorSpecies)}` : ''
  const selectedSecondValue = secondSpecies ? `species:${svSpeciesSelectionKey(secondSpecies)}` : ''
  const selectedThirdValue = thirdSpecies ? `species:${svSpeciesSelectionKey(thirdSpecies)}` : ''
  const selectedAnchorOption = optionByValue.get(selectedAnchorValue)
  const selectedSecondOption = optionByValue.get(selectedSecondValue)
  const selectedThirdOption = optionByValue.get(selectedThirdValue)

  const promoteOrder = useCallback((nextAnchor, nextSecond, nextThird, options = {}) => {
    const ordered = dedupeSvSpeciesList([nextAnchor, nextSecond, nextThird])
    const slotOptions = {
      anchorKey: nextAnchor ? svSpeciesSelectionKey(nextAnchor) : '',
      secondKey: nextSecond ? svSpeciesSelectionKey(nextSecond) : '',
      thirdKey: nextThird ? svSpeciesSelectionKey(nextThird) : '',
      regionId: selectedAnchorRegionId,
      regionExplicitlySelected: hasSelectedAnchorRegion,
      ...options,
    }
    onGenomeOrderChange?.(ordered, slotOptions)
  }, [hasSelectedAnchorRegion, onGenomeOrderChange, selectedAnchorRegionId])

  const handleAnchorChange = useCallback((value) => {
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    const nextAnchor = option.species
    promoteOrder(nextAnchor, null, null, {
      deactivateSpecies: anchorSpecies ? [anchorSpecies] : [],
      anchorKey: svSpeciesSelectionKey(nextAnchor),
      secondKey: '',
      thirdKey: '',
      clearRegion: true,
    })
  }, [anchorSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleTargetChange = useCallback((slot, value) => {
    if (!value) {
      if (slot === 'second') {
        const promotedThird = thirdSpecies || null
        promoteOrder(
          anchorSpecies,
          promotedThird,
          null,
          {
            deactivateSpecies: secondSpecies ? [secondSpecies] : [],
            secondKey: promotedThird ? svSpeciesSelectionKey(promotedThird) : '',
            thirdKey: '',
          },
        )
      } else {
        promoteOrder(
          anchorSpecies,
          secondSpecies,
          null,
          {
            deactivateSpecies: thirdSpecies ? [thirdSpecies] : [],
            thirdKey: '',
          },
        )
      }
      return
    }
    const option = optionByValue.get(value)
    if (!option?.species) {
      if (option?.genome?.downloadable) onOpenGenomeSelector?.()
      return
    }
    if (slot === 'second') {
      const nextThird = thirdSpecies && svSpeciesSelectionKey(thirdSpecies) !== svSpeciesSelectionKey(option.species) ? thirdSpecies : null
      promoteOrder(anchorSpecies, option.species, nextThird)
    } else {
      promoteOrder(anchorSpecies, secondSpecies, option.species)
    }
  }, [anchorSpecies, secondSpecies, thirdSpecies, optionByValue, promoteOrder, onOpenGenomeSelector])

  const handleAvailableAlignmentAction = useCallback((row, action) => {
    if (!row) return
    if (action === 'download_reference' || action === 'download_target') {
      onOpenGenomeSelector?.()
      return
    }
    if (action === 'remove') {
      onRemoveAlignment?.(row)
      return
    }
    if (action === 'add_reference_inactive' || action === 'add_target_inactive') {
      const species = action === 'add_reference_inactive'
        ? row.reference?.species
        : row.target?.species
      if (!species) return
      promoteOrder(null, null, null, {
        allowEmpty: true,
        deactivateSpecies: [species],
        anchorKey: anchorSpecies ? svSpeciesSelectionKey(anchorSpecies) : '',
        secondKey: secondSpecies ? svSpeciesSelectionKey(secondSpecies) : '',
        thirdKey: thirdSpecies ? svSpeciesSelectionKey(thirdSpecies) : '',
        regionId: selectedAnchorRegionId,
        regionExplicitlySelected: hasSelectedAnchorRegion,
      })
      return
    }

    const referenceSpecies = row.reference?.species || null
    const targetSpecies = row.target?.species || null
    if (!referenceSpecies || !targetSpecies || action !== 'use') return
    const regions = Array.isArray(row.alignment?.reference_regions) ? row.alignment.reference_regions : []
    const largestRegion = regions.reduce((best, region) => {
      if (!best) return region
      return getSvRegionLength(region) > getSvRegionLength(best) ? region : best
    }, null)
    const largestRegionId = getSvRegionKey(largestRegion)

    promoteOrder(referenceSpecies, targetSpecies || null, null, {
      anchorKey: svSpeciesSelectionKey(referenceSpecies),
      secondKey: targetSpecies ? svSpeciesSelectionKey(targetSpecies) : '',
      thirdKey: '',
      regionId: largestRegionId || selectedAnchorRegionId,
      regionExplicitlySelected: Boolean(largestRegionId) || hasSelectedAnchorRegion,
    })
  }, [anchorSpecies, hasSelectedAnchorRegion, onOpenGenomeSelector, onRemoveAlignment, promoteOrder, secondSpecies, selectedAnchorRegionId, thirdSpecies])

  useEffect(() => {
    if (catalogLoading || !anchorSpecies) return
    if (!hasSelectedAnchorRegion) {
      if (secondSpecies || thirdSpecies) {
        promoteOrder(anchorSpecies, null, null, { secondKey: '', thirdKey: '' })
      }
      return
    }
    const activeOrder = new Map((activeSpecies || []).map((species, index) => [svSpeciesSelectionKey(species), index]))
    const validTargetOptions = targetOptions
      .filter((option) => option.species && option.isSelected && !option.disabled)
      .sort((a, b) => {
        const aOrder = activeOrder.has(svSpeciesSelectionKey(a.species)) ? activeOrder.get(svSpeciesSelectionKey(a.species)) : 999
        const bOrder = activeOrder.has(svSpeciesSelectionKey(b.species)) ? activeOrder.get(svSpeciesSelectionKey(b.species)) : 999
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.label.localeCompare(b.label)
      })
    const secondIsValid = secondSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, secondSpecies))
    const thirdIsValid = thirdSpecies && validTargetOptions.some((option) => catalogGenomeMatchesSpecies(option.genome, thirdSpecies))
    let nextSecond = secondIsValid ? secondSpecies : null
    let nextThird = thirdIsValid ? thirdSpecies : null
    if (!nextSecond && nextThird) {
      nextSecond = nextThird
      nextThird = null
    }
    if (nextSecond && nextThird && svSpeciesSelectionKey(nextSecond) === svSpeciesSelectionKey(nextThird)) {
      nextThird = null
    }
    const nextSecondKey = svSpeciesSelectionKey(nextSecond)
    const nextThirdKey = svSpeciesSelectionKey(nextThird)
    if (svSpeciesSelectionKey(secondSpecies) === nextSecondKey && svSpeciesSelectionKey(thirdSpecies) === nextThirdKey) return
    promoteOrder(anchorSpecies, nextSecond, nextThird)
  }, [
    anchorSpecies,
    secondSpecies,
    thirdSpecies,
    selectedAnchorRegionId,
    hasSelectedAnchorRegion,
    targetOptions,
    activeSpecies,
    promoteOrder,
    catalogLoading,
  ])

  const handleLocationSubmit = useCallback((event) => {
    event?.preventDefault?.()
    const query = String(locationInput || '').trim()
    if (!query) return
    const ok = onAnchorRegionSearch?.(query)
    if (ok === false) {
      setLocationInput('')
    }
  }, [locationInput, onAnchorRegionSearch])

  const unavailableSelected = [
    selectedSecondAlignment && !selectedSecondAlignment.supported ? selectedSecondAlignment : null,
    selectedThirdAlignment && !selectedThirdAlignment.supported ? selectedThirdAlignment : null,
  ].filter(Boolean)
  const missingCatalogRows = (catalog?.alignments || []).filter((alignment) => !alignment?.supported)
  const bandClass = isLight ? 'border-gray-200 bg-gray-50 text-gray-900' : 'border-gray-700 bg-[#152033] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = `h-4 text-xs font-semibold leading-4 ${mutedClass}`
  const controlBaseClass = 'h-8 min-w-[220px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded border py-0 pl-2 pr-8 text-sm leading-tight'
  const selectClass = `${controlBaseClass} ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const disabledSelectClass = `${controlBaseClass} opacity-65 cursor-not-allowed ${
    isLight ? 'border-gray-200 bg-gray-100 text-gray-500' : 'border-gray-700 bg-slate-800 text-gray-500'
  }`
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const thirdTargetOptions = targetOptions.filter((option) => option.value !== selectedSecondValue)
  const secondSelectDisabled = !anchorSpecies || !hasSelectedAnchorRegion
  const thirdSelectDisabled = secondSelectDisabled || !selectedSecondValue || (!selectedThirdValue && !thirdTargetOptions.some((option) => !option.disabled))

  return (
    <div className={`border ${bandClass} px-3 py-2`}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(220px,260px)_minmax(220px,260px)_minmax(260px,360px)_minmax(300px,1fr)] md:items-end">
        <label className={`${fieldClass} md:col-start-1 md:row-start-1`}>
          <span className={fieldLabelClass}>Anchor</span>
          <select className={selectClass} value={selectedAnchorValue} title={getSvOptionTooltip(selectedAnchorOption)} onChange={(event) => handleAnchorChange(event.target.value)}>
            {!selectedAnchorValue && <option value="">Select anchor</option>}
            {renderSvGenomeOptionGroups(anchorOptions, 'anchor')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-1`}>
          <span className={fieldLabelClass}>Region</span>
          <select
            className={selectClass}
            value={hasSelectedAnchorRegion ? selectedAnchorRegionId : ''}
            title={selectedAnchorRegionOption ? `Anchor region ${selectedAnchorRegionOption.label || selectedAnchorRegionOption.chrom}` : ''}
            onChange={(event) => onAnchorRegionChange?.(event.target.value)}
            disabled={!anchorRegionOptions.length}
          >
            {anchorRegionOptions.length > 0 && <option value="">Select</option>}
            {!anchorRegionOptions.length && <option value="">No aligned regions</option>}
            {hasSelectedAnchorRegion && selectedAnchorRegionId && !selectedAnchorRegionOption && (
              <option value={selectedAnchorRegionId}>{selectedAnchorRegionId}</option>
            )}
            {anchorRegionOptions.map((region) => {
              const key = getSvRegionKey(region)
              const availabilityLabel = formatSvRegionAvailabilityLabel(region, outgoingAlignments)
              return (
                <option key={key} value={key}>
                  {region.label || region.chrom || key}{availabilityLabel ? ` (${availabilityLabel})` : ''}
                </option>
              )
            })}
          </select>
        </label>

        <form className={`${fieldClass} md:col-start-3 md:row-start-1`} onSubmit={handleLocationSubmit}>
          <span className={fieldLabelClass}>Location</span>
          <div className="flex h-8 gap-2">
            <input
              className={`h-8 min-w-0 flex-1 rounded border px-2 text-sm leading-tight ${
                isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
              }`}
              value={locationInput}
              placeholder=""
              onChange={(event) => setLocationInput(event.target.value)}
            />
            <button type="submit" className={buttonClass}>
              Go
            </button>
          </div>
        </form>

        <label className={`${fieldClass} md:col-start-1 md:row-start-2`}>
          <span className={fieldLabelClass}>Second</span>
          <select className={secondSelectDisabled ? disabledSelectClass : selectClass} value={selectedSecondValue} title={getSvOptionTooltip(selectedSecondOption)} onChange={(event) => handleTargetChange('second', event.target.value)} disabled={secondSelectDisabled}>
            <option value="">{selectedSecondValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(targetOptions, 'second')}
          </select>
        </label>

        <label className={`${fieldClass} md:col-start-2 md:row-start-2`}>
          <span className={fieldLabelClass}>Third</span>
          <select className={thirdSelectDisabled ? disabledSelectClass : selectClass} value={selectedThirdValue} title={getSvOptionTooltip(selectedThirdOption)} onChange={(event) => handleTargetChange('third', event.target.value)} disabled={thirdSelectDisabled}>
            <option value="">{selectedThirdValue ? 'None' : 'Select'}</option>
            {renderSvGenomeOptionGroups(thirdTargetOptions, 'third')}
          </select>
        </label>

        {/* Only shown when there is actually a choice to make. A pair usually has
            one alignment, and an inert dropdown on every pair would be noise. */}
        {secondAlignmentChoices.length > 1 && (
          <label className={`${fieldClass} md:col-start-1 md:row-start-3`}>
            <span className={fieldLabelClass}>Second alignment</span>
            <select
              className={selectClass}
              value={selectedSecondAlignment?.id || ''}
              title={selectedSecondAlignment?.description || selectedSecondAlignment?.label || ''}
              onChange={(event) => onPreferredAlignmentChange?.('second', event.target.value)}
            >
              {secondAlignmentChoices.map((alignment) => (
                <option key={alignment.id} value={alignment.id} title={alignment.description || ''}>
                  {alignment.label || alignment.id}
                </option>
              ))}
            </select>
          </label>
        )}

        {thirdAlignmentChoices.length > 1 && (
          <label className={`${fieldClass} md:col-start-2 md:row-start-3`}>
            <span className={fieldLabelClass}>Third alignment</span>
            <select
              className={selectClass}
              value={selectedThirdAlignment?.id || ''}
              title={selectedThirdAlignment?.description || selectedThirdAlignment?.label || ''}
              onChange={(event) => onPreferredAlignmentChange?.('third', event.target.value)}
            >
              {thirdAlignmentChoices.map((alignment) => (
                <option key={alignment.id} value={alignment.id} title={alignment.description || ''}>
                  {alignment.label || alignment.id}
                </option>
              ))}
            </select>
          </label>
        )}

        <StructuralVariationRegistrationForm
          className="md:col-start-3 md:col-span-2 md:row-start-2"
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={hasSelectedAnchorRegion}
          outputDir={outputDir}
          onRegistered={onRegisteredAlignment}
          onAvailableAlignmentAction={handleAvailableAlignmentAction}
          onOpenGenomeSelector={onOpenGenomeSelector}
        />
      </div>

      {catalogError && (
        <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${mutedClass}`}>
          <span className={isLight ? 'text-red-600' : 'text-red-300'}>{catalogError}</span>
        </div>
      )}

      {targetOptions.some((option) => !option.species && option.genome?.downloadable) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {targetOptions.filter((option) => !option.species && option.genome?.downloadable).map((option) => (
            <button key={`download-${option.value}`} type="button" className={buttonClass} onClick={() => onOpenGenomeSelector?.()}>
              Download {option.label}
            </button>
          ))}
        </div>
      )}

      {(unavailableSelected.length > 0 || missingCatalogRows.length > 0) && (
        <div className={`mt-2 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
          {unavailableSelected.length > 0
            ? unavailableSelected.map((alignment) => `${alignment.label || alignment.id}: ${(alignment.missing_files || []).join(', ')}`).join(' | ')
            : `${missingCatalogRows.length} alignment${missingCatalogRows.length === 1 ? '' : 's'} have missing BigChain or mapping files.`}
        </div>
      )}
    </div>
  )
}

function AvailableSvAlignmentsPanel({
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  onAction,
}) {
  const isLight = theme === 'light'
  const [expandedRows, setExpandedRows] = useState({})
  const rows = useMemo(
    () => buildAvailableSvAlignmentRows(catalog, activeSpecies, inactiveSpecies),
    [catalog, activeSpecies, inactiveSpecies],
  )
  const fullyActiveKeys = useMemo(() => {
    const keys = []
    if (anchorSpecies) keys.push(svSpeciesSelectionKey(anchorSpecies))
    if (regionExplicitlySelected && secondSpecies) keys.push(svSpeciesSelectionKey(secondSpecies))
    if (regionExplicitlySelected && thirdSpecies) keys.push(svSpeciesSelectionKey(thirdSpecies))
    return new Set(keys.filter(Boolean))
  }, [anchorSpecies, regionExplicitlySelected, secondSpecies, thirdSpecies])

  const panelClass = isLight
    ? 'border-gray-200 bg-white text-gray-900'
    : 'border-gray-700 bg-[#111827] text-gray-100'
  const tableGridClass = 'md:grid-cols-[28px_minmax(360px,3fr)_minmax(220px,1.6fr)_88px_110px_150px]'
  const rowClass = `grid gap-2 border-b px-3 py-2 text-xs transition-colors ${tableGridClass} md:items-center ${
    isLight
      ? 'border-gray-100 hover:bg-gray-50'
      : 'border-gray-700/70 hover:bg-slate-800/70'
  }`
  const detailClass = isLight ? 'border-gray-100 bg-gray-50 text-gray-700' : 'border-gray-700 bg-slate-900/70 text-gray-300'
  const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const strongClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const buttonClass = `inline-flex h-7 items-center justify-center rounded border px-2 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:bg-gray-100 disabled:text-gray-400' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700 disabled:bg-slate-800 disabled:text-gray-500'
  }`
  const statusClass = (status) => {
    if (status === 'usable') return isLight ? 'text-emerald-700' : 'text-emerald-300'
    if (status === 'downloadable') return isLight ? 'text-blue-700' : 'text-blue-300'
    if (status === 'missing_files') return isLight ? 'text-amber-700' : 'text-amber-300'
    return isLight ? 'text-gray-500' : 'text-gray-400'
  }
  const formatGenome = (state) => state.species
    ? getSpeciesDisplayName(state.species)
    : getSvCatalogGenomeDisplayName(state.genome)
  const formatGenomeTooltip = (state) => {
    const genome = state.genome || state.species || {}
    const label = formatGenome(state)
    const accession = getSvGenomeAccessionLabel(genome)
    const aliases = Array.isArray(genome.aliases) ? genome.aliases : []
    return [label, accession, ...aliases.slice(0, 6)].filter(Boolean).join(' | ')
  }
  const getMiniPillStyle = (state) => {
    const isFullyActive = Boolean(state.speciesKey && fullyActiveKeys.has(state.speciesKey))
    if (isFullyActive) {
      return {
        backgroundColor: isLight ? '#0099ff' : '#0077cc',
        color: '#ffffff',
        borderColor: 'transparent',
        borderStyle: 'solid',
      }
    }
    if (state.isActive) {
      return {
        backgroundColor: isLight ? '#ffffff' : 'transparent',
        color: isLight ? '#1d4ed8' : '#93c5fd',
        borderColor: isLight ? '#60a5fa' : '#3b82f6',
        borderStyle: 'solid',
      }
    }
    if (state.isSelected) {
      return {
        backgroundColor: isLight ? '#ffffff' : '#1E2938',
        color: isLight ? '#4b5563' : '#9ca3af',
        borderColor: isLight ? '#d1d5db' : '#4b5563',
        borderStyle: 'solid',
      }
    }
    return {
      backgroundColor: isLight ? '#ffffff' : 'transparent',
      color: isLight ? '#6b7280' : '#9ca3af',
      borderColor: isLight ? '#d1d5db' : '#4b5563',
      borderStyle: 'dashed',
    }
  }
  const renderMiniGenomePill = (row, side) => {
    const state = side === 'reference' ? row.reference : row.target
    const canAddInactive = Boolean(state.isLocal && !state.isSelected)
    const action = side === 'reference' ? 'add_reference_inactive' : 'add_target_inactive'
    return (
      <span className="group/align-pill relative min-w-0 max-w-[48%]">
        <span
          className="inline-flex max-w-full min-w-[92px] items-center rounded-full border px-2.5 py-1 text-[11px] font-medium"
          style={getMiniPillStyle(state)}
          title={formatGenomeTooltip(state)}
        >
          <span className="truncate">{formatGenome(state)}</span>
        </span>
        {canAddInactive && (
          <button
            type="button"
            className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border opacity-0 transition-opacity group-hover/align-pill:opacity-100 ${
              isLight
                ? 'border-gray-300 bg-white text-gray-500 hover:border-blue-400 hover:text-blue-600'
                : 'border-gray-500 bg-gray-800 text-gray-300 hover:border-blue-400 hover:text-blue-300'
            }`}
            title="Add genome to list"
            aria-label="Add genome to list"
            onClick={(event) => {
              event.stopPropagation()
              onAction?.(row, action)
            }}
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <line x1="5" y1="2" x2="5" y2="8" />
              <line x1="2" y1="5" x2="8" y2="5" />
            </svg>
          </button>
        )}
      </span>
    )
  }
  const formatStatus = (row) => {
    if (row.status === 'usable') return 'Usable'
    if (row.status === 'downloadable') return 'Downloadable'
    if (row.status === 'missing_files') return 'Missing files'
    return 'Unavailable'
  }
  const renderActionButtons = (row) => {
    const buttons = []
    if (row.supported && row.canUse) {
      buttons.push(
        <button key="use" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'use') }}>
          Use alignment
        </button>,
      )
    }
    if (row.supported && row.canDownloadReference) {
      buttons.push(
        <button key="download-ref" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_reference') }}>
          Download reference
        </button>,
      )
    }
    if (row.supported && row.canDownloadTarget) {
      buttons.push(
        <button key="download-target" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'download_target') }}>
          Download target
        </button>,
      )
    }
    // Offered whatever the state: an entry with missing files is exactly the one
    // most likely to need its paths corrected or to be removed outright.
    buttons.push(
      <button key="remove" type="button" className={buttonClass} onClick={(event) => { event.stopPropagation(); onAction?.(row, 'remove') }}>
        Remove
      </button>,
    )
    return <div className="flex flex-wrap items-center gap-1.5">{buttons}</div>
  }
  const renderFileDetail = (label, file) => {
    const path = String(file?.path || '').trim()
    const ok = Boolean(file?.exists)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{label}</div>
        <div className={`truncate font-mono text-[11px] ${path ? mutedClass : statusClass('missing_files')}`} title={path}>
          {path || 'Not set'}{path ? (ok ? ' (found)' : ' (missing)') : ''}
        </div>
      </div>
    )
  }
  const renderGenomeDetail = (title, state, aliases) => {
    const genome = state.genome || {}
    const accession = getSvGenomeAccessionLabel(genome)
    const aliasList = Array.from(new Set([...(aliases || []), ...(genome.aliases || [])])).filter(Boolean)
    return (
      <div className="min-w-0">
        <div className={`font-semibold ${strongClass}`}>{title}</div>
        <div className="truncate" title={formatGenome(state)}>{formatGenome(state)}</div>
        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={accession}>{accession || 'No accession'}</div>
        <div className={`truncate text-[11px] ${mutedClass}`} title={aliasList.join(', ')}>
          {aliasList.length ? `Aliases: ${aliasList.slice(0, 8).join(', ')}${aliasList.length > 8 ? '...' : ''}` : 'No aliases'}
        </div>
      </div>
    )
  }

  return (
    <div className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex items-center justify-between border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Available alignments</span>
        <span className={mutedClass}>{rows.length} registered</span>
      </div>
      {rows.length === 0 ? (
        <div className={`px-3 py-3 text-sm ${mutedClass}`}>No SV alignments are registered.</div>
      ) : (
        <div>
          <div className={`hidden border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide md:grid ${tableGridClass} md:gap-2 ${isLight ? 'border-gray-100 text-gray-500' : 'border-gray-700 text-gray-400'}`}>
            <span />
            <span>Direction</span>
            <span>Label</span>
            <span>Regions</span>
            <span>Status</span>
            <span>Action</span>
          </div>
          {rows.map((row) => {
            const expanded = Boolean(expandedRows[row.id])
            const alignment = row.alignment || {}
            const sourceLabel = alignment.label || row.id
            const regions = Array.isArray(alignment.reference_regions) ? alignment.reference_regions : []
            return (
              <div key={row.id}>
                <div className={`w-full text-left ${rowClass}`}>
                  <span className="flex items-center">
                    <button
                      type="button"
                      className={`inline-flex h-6 w-6 items-center justify-center rounded border ${isLight ? 'border-gray-300 bg-white text-gray-500 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-300 hover:bg-slate-700'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpandedRows((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
                      }}
                      title={expanded ? 'Collapse alignment details' : 'Expand alignment details'}
                    >
                      <IconUpDown open={expanded} size={13} />
                    </button>
                  </span>
                  <span
                    className="flex min-w-0 items-center gap-2"
                    title={`${formatGenomeTooltip(row.reference)} -> ${formatGenomeTooltip(row.target)}`}
                  >
                    {renderMiniGenomePill(row, 'reference')}
                    <span className={`shrink-0 text-xs font-semibold ${mutedClass}`}>-&gt;</span>
                    {renderMiniGenomePill(row, 'target')}
                  </span>
                  <span className="truncate" title={sourceLabel}>{sourceLabel}</span>
                  <span>{row.regionCount} {row.regionCount === 1 ? 'region' : 'regions'}</span>
                  <span className={statusClass(row.status)}>{formatStatus(row)}</span>
                  <span>{renderActionButtons(row)}</span>
                </div>
                {expanded && (
                  <div className={`border-b px-3 py-3 text-xs ${detailClass}`}>
                    {alignment.description && (
                      <div className={`mb-3 ${mutedClass}`}>{alignment.description}</div>
                    )}
                    <div className="grid gap-3 md:grid-cols-3">
                      {renderFileDetail('BigChain', alignment.files?.bigchain)}
                      <div>
                        <div className={`font-semibold ${strongClass}`}>Indexed side</div>
                        <div>{alignment.indexed_side || 'target'}</div>
                      </div>
                      <div className="min-w-0">
                        <div className={`font-semibold ${strongClass}`}>Defined in</div>
                        <div className={`truncate font-mono text-[11px] ${mutedClass}`} title={alignment.config_path || ''}>
                          {alignment.config_path || (alignment.source === 'scanned' ? 'Scanned bundle' : 'This installation')}
                        </div>
                      </div>
                      {/* Only shown for records migrated from before sequence names
                          were derived from the assemblies. */}
                      {alignment.files?.reference_mapping?.path && renderFileDetail('Reference mapping TSV (legacy)', alignment.files.reference_mapping)}
                      {alignment.files?.target_mapping?.path && renderFileDetail('Target mapping TSV (legacy)', alignment.files.target_mapping)}
                      {renderGenomeDetail('Reference genome', row.reference, alignment.ref_aliases)}
                      {renderGenomeDetail('Target genome', row.target, alignment.tgt_aliases)}
                    </div>
                    {row.missingFiles.length > 0 && (
                      <div className={`mt-3 ${statusClass('missing_files')}`}>
                        Missing: {row.missingFiles.join(', ')}
                      </div>
                    )}
                    <div className="mt-3">
                      <div className={`font-semibold ${strongClass}`}>Reference regions</div>
                      <div className={`mt-1 flex flex-wrap gap-1 ${mutedClass}`}>
                        {regions.length === 0 ? (
                          <span>No regions listed</span>
                        ) : (
                          <>
                            {regions.slice(0, 20).map((region) => {
                              const key = getSvRegionKey(region)
                              return (
                                <span key={key} className={`rounded border px-1.5 py-0.5 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-slate-950'}`}>
                                  {region.label || region.chrom || key}
                                </span>
                              )
                            })}
                            {regions.length > 20 && <span>+{regions.length - 20} more</span>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Edit an SV configuration as text.
 *
 * A structured form is the right tool for building one record; it is the wrong tool
 * for fixing a wrong path in three of them, or for pasting in a config a colleague
 * sent. The file is small and readable by design, so editing it directly is a
 * reasonable thing to offer.
 *
 * Nothing is written until it parses. Validate reports what is wrong and where;
 * Save writes only after the same check passes on the backend.
 */
function StructuralVariationConfigPanel({ theme, catalog, outputDir, onChanged }) {
  const isLight = theme === 'light'
  const [selectedPath, setSelectedPath] = useState('')
  const [text, setText] = useState('')
  const [loadedText, setLoadedText] = useState('')
  const [diagnostics, setDiagnostics] = useState([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [browserMode, setBrowserMode] = useState('')
  const textareaRef = useRef(null)

  const configs = useMemo(() => (Array.isArray(catalog?.configs) ? catalog.configs : []), [catalog])
  const registryPath = String(catalog?.registry_path || '')
  const isDirty = text !== loadedText

  const panelClass = isLight ? 'border-gray-200 bg-white text-gray-900' : 'border-gray-700 bg-[#0f172a] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const selectClass = `h-8 min-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap rounded border py-0 pl-2 pr-8 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`

  const load = useCallback(async (path) => {
    setBusy(true)
    setStatus('')
    try {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (outputDir) params.set('output_dir', outputDir)
      const res = await fetch(`${API_BASE}/api/sv/config?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Could not read the configuration (${res.status})`)
      setText(data?.text || '')
      setLoadedText(data?.text || '')
      setDiagnostics(data?.diagnostics || [])
      setSelectedPath(String(data?.path || path || ''))
    } catch (error) {
      setStatus(error?.message || 'Could not read the configuration.')
    } finally {
      setBusy(false)
    }
  }, [outputDir])

  useEffect(() => { load('') }, [load])

  const validate = useCallback(async () => {
    setBusy(true)
    setStatus('')
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, base_dir: selectedPath ? selectedPath.replace(/[^/\\]+$/, '') : '' }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Validation failed (${res.status})`)
      setDiagnostics(data?.diagnostics || [])
      const missing = data?.missing_files || []
      if (!data?.ok) setStatus('The configuration has errors. Nothing has been saved.')
      else if (missing.length) setStatus(`Valid, but ${missing.length} referenced file(s) are not on disk.`)
      else setStatus(`Valid. ${data?.alignment_count || 0} alignment(s).`)
      return Boolean(data?.ok)
    } catch (error) {
      setStatus(error?.message || 'Validation failed.')
      return false
    } finally {
      setBusy(false)
    }
  }, [text, selectedPath])

  const save = useCallback(async (path, attach) => {
    const destination = String(path || selectedPath || '')
    if (!destination) {
      setStatus('Choose where to save first.')
      return
    }
    setBusy(true)
    setStatus('')
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destination, text, mode: 'replace', attach: Boolean(attach) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Save failed (${res.status})`)
      if (!data?.ok) {
        setDiagnostics(data?.diagnostics || [])
        setStatus('The configuration has errors, so nothing was written.')
        return
      }
      setText(data?.text || text)
      setLoadedText(data?.text || text)
      setSelectedPath(String(data?.path || destination))
      setDiagnostics([])
      setStatus(`Saved to ${data?.path || destination}.`)
      onChanged?.()
    } catch (error) {
      setStatus(error?.message || 'Save failed.')
    } finally {
      setBusy(false)
    }
  }, [text, selectedPath, onChanged])

  const attach = useCallback(async (path) => {
    setBusy(true)
    setStatus('')
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Could not load the configuration (${res.status})`)
      if (!data?.ok) {
        setDiagnostics(data?.diagnostics || [])
        setStatus('That configuration has errors, so it was not loaded.')
        return
      }
      setStatus(`Loaded ${path}.`)
      onChanged?.()
      await load(path)
    } catch (error) {
      setStatus(error?.message || 'Could not load the configuration.')
    } finally {
      setBusy(false)
    }
  }, [load, onChanged])

  const detach = useCallback(async (path) => {
    setBusy(true)
    try {
      await fetch(`${API_BASE}/api/sv/config/detach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      setStatus(`Stopped using ${path}. The file itself is untouched.`)
      onChanged?.()
      if (selectedPath === path) await load('')
    } finally {
      setBusy(false)
    }
  }, [load, onChanged, selectedPath])

  // Put the caret on the line a diagnostic names, so a reported error is one click
  // from the text that caused it.
  const focusLine = useCallback((line) => {
    const element = textareaRef.current
    if (!element || !line) return
    const lines = text.split('\n')
    const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0)
    element.focus()
    element.setSelectionRange(offset, offset + (lines[line - 1] || '').length)
    const lineHeight = element.scrollHeight / Math.max(1, lines.length)
    element.scrollTop = Math.max(0, (line - 3) * lineHeight)
  }, [text])

  const errorCount = diagnostics.filter((item) => item.severity === 'error').length

  return (
    <div className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Configuration</span>
        <select
          className={selectClass}
          value={selectedPath}
          onChange={(event) => load(event.target.value)}
          disabled={busy}
        >
          <option value={registryPath}>This installation{registryPath ? '' : ' (no output directory)'}</option>
          {configs.map((item) => (
            <option key={item.path} value={item.path}>
              {item.label || item.path}{item.exists ? '' : ' (file missing)'}
            </option>
          ))}
        </select>
        <button type="button" className={buttonClass} onClick={() => setBrowserMode('load')} disabled={busy}>
          Load file
        </button>
        {selectedPath && selectedPath !== registryPath && (
          <button type="button" className={buttonClass} onClick={() => detach(selectedPath)} disabled={busy}>
            Stop using
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className={buttonClass} onClick={validate} disabled={busy}>
            Validate
          </button>
          <button type="button" className={buttonClass} onClick={() => save(selectedPath, false)} disabled={busy || !isDirty}>
            {isDirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" className={buttonClass} onClick={() => setBrowserMode('save')} disabled={busy}>
            Save as
          </button>
        </span>
      </div>

      <textarea
        ref={textareaRef}
        className={`h-80 w-full resize-y px-3 py-2 font-mono text-[12px] leading-5 outline-none ${
          isLight ? 'bg-white text-gray-900' : 'bg-[#0b1220] text-gray-100'
        }`}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      {(status || diagnostics.length > 0) && (
        <div className={`border-t px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
          {status && (
            <div className={errorCount > 0 ? (isLight ? 'text-red-600' : 'text-red-300') : mutedClass}>{status}</div>
          )}
          {diagnostics.map((item, index) => (
            <button
              key={`${item.pointer}-${index}`}
              type="button"
              className={`mt-1 block w-full text-left ${
                item.severity === 'error'
                  ? (isLight ? 'text-red-600' : 'text-red-300')
                  : (isLight ? 'text-amber-700' : 'text-amber-300')
              }`}
              onClick={() => focusLine(item.line)}
              title={item.pointer ? `at ${item.pointer}` : ''}
            >
              {item.line ? `Line ${item.line}: ` : ''}{item.message}
            </button>
          ))}
        </div>
      )}

      <FileBrowserModal
        isOpen={Boolean(browserMode)}
        onClose={() => setBrowserMode('')}
        onSelect={(path) => {
          const mode = browserMode
          setBrowserMode('')
          if (mode === 'load') attach(path)
          else save(path, true)
        }}
        initialPath={outputDir || ''}
        mode="file"
        theme={theme}
        extensions={['.json', '.cfg']}
      />
    </div>
  )
}

function StructuralVariationRegistrationForm({
  className = '',
  theme,
  catalog,
  activeSpecies,
  inactiveSpecies,
  anchorSpecies,
  secondSpecies,
  thirdSpecies,
  regionExplicitlySelected,
  outputDir,
  onRegistered,
  onAvailableAlignmentAction,
  onOpenGenomeSelector,
}) {
  const isLight = theme === 'light'
  const [activeTool, setActiveTool] = useState('')
  const [browserField, setBrowserField] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const isRegistrationOpen = activeTool === 'register'
  const isAvailableOpen = activeTool === 'available'
  const isConfigOpen = activeTool === 'config'
  const knownSpecies = useMemo(() => {
    const catalogLocalSpecies = []
    for (const genome of catalog?.genomes || []) {
      if (genome?.local_species) catalogLocalSpecies.push(genome.local_species)
    }
    return dedupeSvSpeciesList([...activeSpecies, ...inactiveSpecies, ...catalogLocalSpecies])
  }, [activeSpecies, inactiveSpecies, catalog])
  const [form, setForm] = useState({
    label: '',
    description: '',
    chain_path: '',
    reference_bigwig_path: '',
    reference_bigbed_path: '',
    target_bigwig_path: '',
    target_bigbed_path: '',
    // Empty means "work it out from the file name"; getting this wrong is the
    // usual cause of an alignment that saves but draws nothing.
    indexed_side: '',
    reference_key: '',
    target_key: '',
    save_to: 'registry',
    config_path: '',
  })
  const speciesByKey = useMemo(() => new Map(knownSpecies.map((species) => [speciesGenomeKey(species), species])), [knownSpecies])

  // Start from whatever the view is already showing. The genomes were passed in
  // all along but the form ignored them, so every registration meant re-picking
  // the pair that was on screen.
  useEffect(() => {
    if (!isRegistrationOpen) return
    setForm((prev) => {
      if (prev.reference_key || prev.target_key) return prev
      const anchorKey = anchorSpecies ? speciesGenomeKey(anchorSpecies) : ''
      const secondKey = secondSpecies ? speciesGenomeKey(secondSpecies) : ''
      if (!anchorKey && !secondKey) return prev
      return { ...prev, reference_key: anchorKey, target_key: secondKey }
    })
  }, [isRegistrationOpen, anchorSpecies, secondSpecies])
  const fieldClass = 'flex min-w-0 flex-col gap-1'
  const fieldLabelClass = isLight
    ? 'h-4 text-xs font-semibold leading-4 text-gray-600'
    : 'h-4 text-xs font-semibold leading-4 text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const chooserButtonBaseClass = 'inline-flex h-8 items-center justify-center rounded border px-3 text-xs leading-none transition-colors whitespace-nowrap'
  const chooserButtonClass = (active) => `${chooserButtonBaseClass} ${active
    ? (isLight
      ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'
      : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700')
    : (isLight
      ? 'border-sky-600 bg-sky-600 text-white hover:bg-sky-700'
      : 'border-sky-600 bg-sky-600 text-white hover:bg-sky-500')
  }`
  const inputClass = `h-8 w-full rounded border px-2 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const labelTextClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const hintClass = `mt-0.5 block text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault()
    if (form.reference_key && form.reference_key === form.target_key) {
      setMessage('The reference and target must be different genomes.')
      return
    }
    if (form.save_to !== 'registry' && !form.config_path.trim()) {
      setMessage('Choose a configuration file to save into.')
      return
    }
    setSubmitting(true)
    setMessage('')
    try {
      const referenceSpecies = speciesByKey.get(form.reference_key) || null
      const targetSpecies = speciesByKey.get(form.target_key) || null
      const payload = {
        output_dir: outputDir || '',
        label: form.label,
        description: form.description,
        chain_path: form.chain_path,
        reference_bigwig_path: form.reference_bigwig_path,
        reference_bigbed_path: form.reference_bigbed_path,
        target_bigwig_path: form.target_bigwig_path,
        target_bigbed_path: form.target_bigbed_path,
        indexed_side: form.indexed_side,
        reference_genome: buildSvGenomePayload(referenceSpecies),
        target_genome: buildSvGenomePayload(targetSpecies),
        target: form.save_to === 'registry'
          ? { kind: 'registry' }
          : { kind: 'config', path: form.config_path.trim(), mode: 'merge' },
      }
      const res = await fetch(`${API_BASE}/api/sv/alignments/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Registration failed (${res.status})`)

      // A config the user saved into is only useful once the view reads from it.
      if (form.save_to !== 'registry' && data?.config_path) {
        await fetch(`${API_BASE}/api/sv/config/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: data.config_path }),
        }).catch(() => null)
      }
      setMessage(form.save_to === 'registry'
        ? 'Alignment registered.'
        : `Alignment saved to ${data?.config_path || form.config_path}.`)
      setActiveTool('')
      onRegistered?.()
    } catch (error) {
      setMessage(error?.message || 'Failed to register alignment.')
    } finally {
      setSubmitting(false)
    }
  }, [form, outputDir, speciesByKey, onRegistered])

  return (
    <>
      <div className={`${fieldClass} ${className}`}>
        <span className={fieldLabelClass}>Alignments</span>
        <div className="flex h-8 flex-nowrap items-center gap-2">
          <button type="button" className={chooserButtonClass(isRegistrationOpen)} onClick={() => setActiveTool((prev) => (prev === 'register' ? '' : 'register'))}>
            {isRegistrationOpen ? 'Close registration' : 'Register alignment'}
          </button>
          <button type="button" className={chooserButtonClass(isAvailableOpen)} onClick={() => setActiveTool((prev) => (prev === 'available' ? '' : 'available'))}>
            {isAvailableOpen ? 'Close alignments' : 'Available alignments'}
          </button>
          <button type="button" className={chooserButtonClass(isConfigOpen)} onClick={() => setActiveTool((prev) => (prev === 'config' ? '' : 'config'))}>
            {isConfigOpen ? 'Close configuration' : 'Configuration'}
          </button>
        </div>
      </div>
      {message && (
        <div className={`md:col-span-full text-xs ${message.includes('failed') || message.includes('Failed') ? (isLight ? 'text-red-600' : 'text-red-300') : (isLight ? 'text-gray-600' : 'text-gray-300')}`}>
          {message}
        </div>
      )}

      {isAvailableOpen && (
        <AvailableSvAlignmentsPanel
          theme={theme}
          catalog={catalog}
          activeSpecies={activeSpecies}
          inactiveSpecies={inactiveSpecies}
          anchorSpecies={anchorSpecies}
          secondSpecies={secondSpecies}
          thirdSpecies={thirdSpecies}
          regionExplicitlySelected={regionExplicitlySelected}
          onAction={onAvailableAlignmentAction}
        />
      )}

      {isConfigOpen && (
        <StructuralVariationConfigPanel
          theme={theme}
          catalog={catalog}
          outputDir={outputDir}
          onChanged={onRegistered}
        />
      )}

      {isRegistrationOpen && (
        <form className="mt-1 grid gap-2 md:col-span-full md:grid-cols-2" onSubmit={handleSubmit}>
          <label className="text-xs">
            <span className={labelTextClass}>Label</span>
            <input
              className={inputClass}
              value={form.label}
              placeholder="GRCh38 to HG00438.pat"
              onChange={(event) => updateField('label', event.target.value)}
              required
            />
            <span className={hintClass}>Identifies this alignment. Must be unique.</span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Description (optional)</span>
            <input
              className={inputClass}
              value={form.description}
              placeholder="Cactus chain, HPRC year 1"
              onChange={(event) => updateField('description', event.target.value)}
            />
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Reference genome</span>
            <select className={inputClass} value={form.reference_key} onChange={(event) => updateField('reference_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`ref-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Target genome</span>
            <select className={inputClass} value={form.target_key} onChange={(event) => updateField('target_key', event.target.value)} required>
              <option value="">Select genome</option>
              {knownSpecies.map((species) => (
                <option key={`tgt-${speciesGenomeKey(species)}`} value={speciesGenomeKey(species)}>
                  {getSpeciesDisplayName(species)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs md:col-span-2">
            <span className={labelTextClass}>BigChain file</span>
            <div className="flex gap-2">
              <input className={inputClass} value={form.chain_path} onChange={(event) => updateField('chain_path', event.target.value)} required />
              <button type="button" className={buttonClass} onClick={() => setBrowserField('chain_path')}>
                Browse
              </button>
            </div>
            <span className={hintClass}>
              Indexed BigBed chain file, conventionally *.bigChain.bb. Sequence names come from
              the assemblies, so no mapping files are needed.
            </span>
          </label>
          <label className="text-xs">
            <span className={labelTextClass}>Indexed side</span>
            <select className={inputClass} value={form.indexed_side} onChange={(event) => updateField('indexed_side', event.target.value)}>
              <option value="">Detect from file name</option>
              <option value="target">Target</option>
              <option value="reference">Reference</option>
            </select>
            <span className={hintClass}>Which genome the chain file is indexed on.</span>
          </label>
          <div className="text-xs">
            <span className={labelTextClass}>Save to</span>
            <select className={inputClass} value={form.save_to} onChange={(event) => updateField('save_to', event.target.value)}>
              <option value="registry">This installation</option>
              <option value="config">A configuration file</option>
            </select>
            {form.save_to === 'config' && (
              <div className="mt-1 flex gap-2">
                <input
                  className={inputClass}
                  value={form.config_path}
                  placeholder="alignments.json"
                  onChange={(event) => updateField('config_path', event.target.value)}
                />
                <button type="button" className={buttonClass} onClick={() => setBrowserField('config_path')}>
                  Browse
                </button>
              </div>
            )}
          </div>
          {[
            ['reference_bigwig_path', 'Reference BigWig (optional)'],
            ['reference_bigbed_path', 'Reference BigBed (optional)'],
            ['target_bigwig_path', 'Target BigWig (optional)'],
            ['target_bigbed_path', 'Target BigBed (optional)'],
          ].map(([field, label]) => (
            <label key={field} className="text-xs">
              <span className={labelTextClass}>{label}</span>
              <div className="flex gap-2">
                <input className={inputClass} value={form[field]} onChange={(event) => updateField(field, event.target.value)} />
                <button type="button" className={buttonClass} onClick={() => setBrowserField(field)}>
                  Browse
                </button>
              </div>
            </label>
          ))}
          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <button type="submit" className={buttonClass} disabled={submitting}>
              {submitting ? 'Saving...' : 'Save alignment'}
            </button>
          </div>
        </form>
      )}

      <FileBrowserModal
        isOpen={Boolean(browserField)}
        onClose={() => setBrowserField('')}
        onSelect={(path) => {
          updateField(browserField, path)
          setBrowserField('')
        }}
        initialPath={outputDir || ''}
        mode="file"
        theme={theme}
        extensions={SV_FILE_BROWSER_EXTENSIONS[browserField] || []}
      />
    </>
  )
}

const SV_FILE_BROWSER_EXTENSIONS = {
  chain_path: ['.bigChain.bb', '.bb'],
  reference_bigwig_path: ['.bw', '.bigwig'],
  target_bigwig_path: ['.bw', '.bigwig'],
  reference_bigbed_path: ['.bb', '.bigbed'],
  target_bigbed_path: ['.bb', '.bigbed'],
  config_path: ['.json', '.cfg'],
}

function StructuralVariationView(props) {
  const {
    theme = 'dark',
    config,
    refSpecies,
    tgtSpecies,
    thirdSpecies,
    activeSpecies = config?.active_species || [],
    inactiveSpecies = [],
    onGenomeOrderChange = null,
    onAlignmentAvailabilityChange = null,
    selectedAnchorRegionId: controlledSelectedAnchorRegionId = null,
    regionExplicitlySelected = false,
    onSelectedAnchorRegionIdChange = null,
    onOpenGenomeSelector = null,
  } = props
  const outputDir = config?.output_dir || ''
  const [catalog, setCatalog] = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState('')
  const [localSelectedAnchorRegionId, setLocalSelectedAnchorRegionId] = useState('')
  const [anchorLocationRegion, setAnchorLocationRegion] = useState(null)
  const selectedAnchorRegionId = controlledSelectedAnchorRegionId ?? localSelectedAnchorRegionId
  const setSelectedAnchorRegionId = useCallback((nextRegionId, options = {}) => {
    const next = String(nextRegionId || '')
    if (controlledSelectedAnchorRegionId === null) {
      setLocalSelectedAnchorRegionId(next)
    }
    onSelectedAnchorRegionIdChange?.(next, options)
  }, [controlledSelectedAnchorRegionId, onSelectedAnchorRegionIdChange])
  const handleAnchorRegionChange = useCallback((nextRegionId) => {
    setAnchorLocationRegion(null)
    setSelectedAnchorRegionId(nextRegionId, { explicit: Boolean(nextRegionId) })
  }, [setSelectedAnchorRegionId])

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const params = new URLSearchParams()
      if (outputDir) params.set('output_dir', outputDir)
      const res = await fetch(`${API_BASE}/api/sv/catalog?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Catalog request failed (${res.status})`)
      setCatalog(data || { alignments: [], genomes: [], edges: [] })
    } catch (error) {
      setCatalogError(error?.message || 'Failed to load SV alignment catalog.')
      setCatalog({ alignments: [], genomes: [], edges: [] })
    } finally {
      setCatalogLoading(false)
    }
  }, [outputDir])

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  const handleRemoveAlignment = useCallback(async (row) => {
    const alignment = row?.alignment || {}
    const id = String(alignment.id || row?.id || '')
    if (!id) return
    const label = alignment.label || id
    // Removal edits a file on disk, and for an attached config that file may be
    // shared, so it is worth one confirmation.
    if (!window.confirm(`Remove "${label}" from the configuration? The alignment files themselves are not deleted.`)) {
      return
    }
    try {
      const res = await fetch(`${API_BASE}/api/sv/alignments/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output_dir: outputDir || '', config_path: alignment.config_path || '' }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.detail || `Could not remove the alignment (${res.status})`)
      await loadCatalog()
    } catch (error) {
      setCatalogError(error?.message || 'Could not remove the alignment.')
    }
  }, [loadCatalog, outputDir])

  const effectiveSelectedAnchorRegionId = anchorLocationRegion ? getSvRegionKey(anchorLocationRegion) : selectedAnchorRegionId
  const hasExplicitAnchorRegion = Boolean(effectiveSelectedAnchorRegionId && regionExplicitlySelected)

  // A genome pair can carry more than one alignment -- the other direction, or an
  // alternative chain for the same one. Which of them is in use is a user choice,
  // remembered per slot until the pair changes.
  const [preferredAlignmentIds, setPreferredAlignmentIds] = useState({ second: '', third: '' })
  const handlePreferredAlignmentChange = useCallback((slot, alignmentId) => {
    setPreferredAlignmentIds((prev) => ({ ...prev, [slot]: String(alignmentId || '') }))
  }, [])

  const secondAlignmentChoices = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, tgtSpecies)
        .filter((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId))
      : []),
    [catalog, refSpecies, tgtSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
  )
  const thirdAlignmentChoices = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, thirdSpecies)
        .filter((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId))
      : []),
    [catalog, refSpecies, thirdSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
  )

  const selectedSecondAlignment = useMemo(
    () => pickPreferredSvAlignment(secondAlignmentChoices, preferredAlignmentIds.second),
    [secondAlignmentChoices, preferredAlignmentIds.second],
  )
  const selectedThirdAlignment = useMemo(
    () => pickPreferredSvAlignment(thirdAlignmentChoices, preferredAlignmentIds.third),
    [thirdAlignmentChoices, preferredAlignmentIds.third],
  )
  const outgoingAlignments = useMemo(() => getOutgoingSvAlignments(catalog, refSpecies), [catalog, refSpecies])
  const anchorRegionOptions = useMemo(
    () => buildSvAnchorRegionOptions(outgoingAlignments),
    [outgoingAlignments],
  )
  const selectedAnchorRegion = useMemo(() => {
    if (anchorLocationRegion) return anchorLocationRegion
    return anchorRegionOptions.find((region) => getSvRegionKey(region) === selectedAnchorRegionId) || null
  }, [anchorLocationRegion, anchorRegionOptions, selectedAnchorRegionId])

  const handleAnchorRegionSearch = useCallback((query) => {
    const parsed = parseRegionInput(query)
    if (!parsed?.chrom) return false
    const matchingRegion = anchorRegionOptions.find((region) => (
      svRegionsMatch(getSvRegionKey(region), parsed.chrom)
      || svRegionsMatch(region?.chrom, parsed.chrom)
      || svRegionsMatch(region?.label, parsed.chrom)
    ))
    const key = matchingRegion ? getSvRegionKey(matchingRegion) : parsed.chrom
    setAnchorLocationRegion({
      ...(matchingRegion || {}),
      id: key,
      chrom: matchingRegion?.chrom || parsed.chrom,
      label: String(query || '').trim() || matchingRegion?.label || parsed.chrom,
      start: Number.isFinite(parsed.start) ? parsed.start : undefined,
      end: Number.isFinite(parsed.end) ? parsed.end : undefined,
    })
    setSelectedAnchorRegionId(key, { explicit: true })
    return true
  }, [anchorRegionOptions, setSelectedAnchorRegionId])

  const pairAlignmentId = selectedSecondAlignment?.supported ? selectedSecondAlignment.id : ''
  const thirdAlignmentId = selectedThirdAlignment?.supported ? selectedThirdAlignment.id : ''
  const readyForPairRender = Boolean(refSpecies && tgtSpecies && pairAlignmentId && selectedAnchorRegion)
  const chooserPlaceholder = !refSpecies
    ? 'Select an anchor genome to browse structural variation alignments.'
    : (!hasExplicitAnchorRegion
      ? 'Select a region or enter a location to choose aligned genomes.'
      : (!tgtSpecies
        ? 'Select a second genome to load an alignment.'
        : (!pairAlignmentId ? 'No registered alignment is available for the current anchor, region, and second genome.' : '')))

  useEffect(() => {
    if (!onAlignmentAvailabilityChange || catalogLoading) return
    const availableSpeciesKeys = []
    if (refSpecies) availableSpeciesKeys.push(svSpeciesSelectionKey(refSpecies))
    if (hasExplicitAnchorRegion && tgtSpecies && selectedSecondAlignment?.supported) {
      availableSpeciesKeys.push(svSpeciesSelectionKey(tgtSpecies))
    }
    if (hasExplicitAnchorRegion && thirdSpecies && selectedThirdAlignment?.supported) {
      availableSpeciesKeys.push(svSpeciesSelectionKey(thirdSpecies))
    }
    onAlignmentAvailabilityChange(availableSpeciesKeys)
  }, [
    catalogLoading,
    onAlignmentAvailabilityChange,
    refSpecies,
    tgtSpecies,
    thirdSpecies,
    selectedSecondAlignment?.supported,
    selectedThirdAlignment?.supported,
    hasExplicitAnchorRegion,
  ])

  return (
    <div className="flex flex-col gap-0">
      <StructuralVariationChooser
        theme={theme}
        catalog={catalog}
        catalogLoading={catalogLoading}
        catalogError={catalogError}
        activeSpecies={activeSpecies}
        inactiveSpecies={inactiveSpecies}
        anchorSpecies={refSpecies}
        secondSpecies={tgtSpecies}
        thirdSpecies={thirdSpecies}
        selectedSecondAlignment={selectedSecondAlignment}
        selectedThirdAlignment={selectedThirdAlignment}
        secondAlignmentChoices={secondAlignmentChoices}
        thirdAlignmentChoices={thirdAlignmentChoices}
        onPreferredAlignmentChange={handlePreferredAlignmentChange}
        anchorRegionOptions={anchorRegionOptions}
        selectedAnchorRegionId={effectiveSelectedAnchorRegionId}
        regionExplicitlySelected={hasExplicitAnchorRegion}
        onAnchorRegionChange={handleAnchorRegionChange}
        onAnchorRegionSearch={handleAnchorRegionSearch}
        onGenomeOrderChange={onGenomeOrderChange}
        onOpenGenomeSelector={onOpenGenomeSelector}
        onRegisteredAlignment={loadCatalog}
        onRemoveAlignment={handleRemoveAlignment}
        outputDir={outputDir}
      />
      {!readyForPairRender ? (
        <div className={`border border-t-0 px-4 py-10 text-sm ${
          theme === 'light'
            ? 'border-gray-200 bg-white text-gray-600'
            : 'border-gray-700 bg-[#111827] text-gray-300'
        }`}>
          {chooserPlaceholder}
        </div>
      ) : (
        <StructuralVariationThreeGenomeView
          key={`javascript|${pairAlignmentId}|${getSvRegionKey(selectedAnchorRegion)}`}
          {...props}
          selectedTopAlignmentId={pairAlignmentId}
          selectedBottomAlignmentId={thirdAlignmentId}
          selectedAnchorRegion={selectedAnchorRegion}
          outputDir={outputDir}
        />
      )}
    </div>
  )
}

export default StructuralVariationView

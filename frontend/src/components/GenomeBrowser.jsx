import { NUCLEOTIDE_COLORS, getBaseColor } from '../utils/nucleotideStyle'
import { browserControlKey } from '../achievements/browserControls.js'
import { trackAchievement } from '../achievements/tracker.js'
import { Fragment, useRef, useEffect, useId, useLayoutEffect, useState, useCallback, useMemo } from 'react'
import iconResetRaw from '../assets/icons/icon_reset.svg?raw'
import iconAnchorRaw from '../assets/icons/icon_anchor.svg?raw'
import {
    buildGeneLabelCandidate,
    geneFooterTrackOverflow,
    intersectsRuler,
    LABEL_ASCENT_PX,
    LABEL_DESCENT_PX,
    getGeneFooterGeometry,
    getTranscriptBoundaryTrails,
    getTranscriptFooterControlState,
    placeGeneFooterWithinViewport,
    placeNonOverlappingGeneLabels,
    TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
} from './genomeBrowserLabelLayout'
import {
    localVcfType,
    getVcfAltAlleleCount,
    getVcfDetailVariantLayout,
    shouldRenderActiveAnchorBase,
} from '../utils/vcfDetailGeometry'
// Pure data: which file each of the tutorial's demo tracks is, so a `browserTracks`
// arrival can name them without carrying registry ids it cannot know.
import { TRACK_FILENAMES } from '../utils/tutorialModel'
import {
    VCF_BLOCK_LEVELS,
    buildVcfOverviewWarmupKey,
    buildVcfOverviewWarmupTiles,
    getVcfBlockLevel as selectVcfBlockLevel,
    getVcfViewportIntent,
} from '../utils/vcfTileStrategy'
import {
    buildDefaultScreenshotName,
    buildForeignObjectMarkup,
    buildSvgDocument,
    escapeXml,
} from '../utils/screenshotExport'
import {
    buildGeneIntervalIndex,
    queryGeneIntervalIndex,
    sameGeneRange,
} from '../utils/geneIntervalIndex'
import InfoGlyph from './InfoGlyph'
import { registerBrowserViewport } from '../utils/browserTutorialControls'
import useTutorial from '../hooks/useTutorial'
import { getTranscriptExonSegments } from './genomeBrowserExonSegments'
import { orderTranscripts, resolveGeneTranscriptView } from './genomeBrowserTranscriptView'
import { shouldResetStickyGeneRows } from './genomeBrowserTranscriptLayout'
import {
    DEFAULT_BROWSING_CONTROLS,
    beginWheelGesture,
    describeBrowsingControls,
    isTextEntryTarget,
    markWheelHandled,
    readKeyEvent,
    readWheelEvent,
    resolveDragAxis,
    resolveKeyAction,
    resolveWheelAction,
    isWheelGestureFromChrome,
} from '../utils/browsingControls'
import { classifyBiotype } from '../utils/geneBiotypes'
import {
    BOX_SELECT_FILL_FRACTION,
    FOCUS_RANGE_FILL_FRACTION,
    SEQUENCE_TRACK_HEIGHT,
    getAnchoredContentPageScrollDelta,
    getFocusLocationRange,
    isSameChromToken,
    getFeatureRowAnchor,
    getFeatureRowTargetY,
    frameRangeWithRightInset,
    rebalanceRangeForInsetChange,
    shouldRenderViewportTranscriptStructures,
} from './genomeBrowserViewportLayout'
import {
    RULER_FONT_SIZE,
    RULER_HEIGHT,
    RULER_LABEL_GAP,
    formatRulerCoord,
    rulerGeometry,
    rulerTicks,
} from './genomeBrowserRuler'
import { FONT_MONO, monoFont, sansFont } from '../utils/typography'
import { drawPowerGlyph, powerGlyphPaths, powerGlyphSvgMarkup } from '../utils/powerGlyph'
import { noteBubbleGlyphSvgMarkup } from '../utils/noteBubbleGlyph'
import NoteGlyph from './NoteGlyph'

// ============ Constants ============
import { API_BASE } from '../backendRuntime'
import GeneIndexProgressOverlay from './GeneIndexProgressOverlay'
import {
    GENE_INDEX_TRACK_HEIGHT,
    geneIndexOverlayBand,
    shouldHoldGeneTrackHeight,
} from '../utils/geneIndexOverlay'
import { INDEX_BUILDING_STATUS } from '../utils/browserReadiness'
const TRACK_HEIGHT = 40
// How often the panel asks how the gene index behind it is getting on.
// Fast enough that the meter reads as live, slow enough that a build
// running for minutes is not polled thousands of times.
const GENE_INDEX_POLL_INTERVAL_MS = 1200
const TRACK_GAP = 8
const EXON_HEIGHT = 12
const INTRON_HEIGHT = 2
const LABEL_FONT = sansFont(11)
const COORD_FONT = monoFont(RULER_FONT_SIZE)
const PILL_FONT = sansFont(10)
const LHS_WIDTH = 48
// How long a move the tutorial makes takes. Long enough to read as travelling rather
// than jumping, and in the same range as the browser's own Home/End (400ms) and
// whole-chromosome reset (500ms). The tutorial scales it by the chosen autoplay speed.
const TUTORIAL_MOVE_MS = 700

/** A box over one track's switch in the gutter, for a tutorial to spotlight.
 *
 *  The gutter is painted on the canvas and hit-tested by geometry, so there is no element
 *  to anchor on; these markers are `pointer-events-none` and exist only to be measured. */
function gutterMarkerStyle(trackY, trackHeight) {
    return {
        left: 0,
        top: Math.max(0, trackY + (trackHeight / 2) - SIDEBAR_TOGGLE_HIT_RADIUS - 2),
        width: LHS_WIDTH,
        height: (SIDEBAR_TOGGLE_HIT_RADIUS + 2) * 2,
    }
}
// Measured up from the label's baseline to the top of the expanded footer row, so the
// label and the control beside it share one top edge. Six rather than ten: ten put that
// edge at the mid-line plus six, which is exactly the bottom of the last exon block, and
// the row sat flush against the transcript it belongs to.
const EXPANDED_FOOTER_LABEL_TOP_OFFSET = 6
const EXPANDED_FOOTER_INLINE_GAP = 6

let expandedFooterTextMeasureContext = null
function measureExpandedFooterLabelWidth(text) {
    const fallbackWidth = String(text || '').length * 6
    if (typeof document === 'undefined') return fallbackWidth + 4
    if (!expandedFooterTextMeasureContext) {
        expandedFooterTextMeasureContext = document.createElement('canvas').getContext('2d')
    }
    if (!expandedFooterTextMeasureContext) return fallbackWidth + 4
    expandedFooterTextMeasureContext.font = LABEL_FONT
    return Math.ceil(expandedFooterTextMeasureContext.measureText(String(text || '')).width) + 4
}
// Sidebar power toggles are drawn as a bare glyph, like the chevron and close
// controls on the focus drawer: the genome's own colour when the track is on,
// muted grey when it is off. A filled disc read as far louder than the thing it
// was toggling. The hit radius stays generous so the smaller glyph is no harder
// to click than the disc was.
const SIDEBAR_TOGGLE_ICON_SIZE = 16
const SIDEBAR_TOGGLE_HIT_RADIUS = 12
const SIDEBAR_TOGGLE_LABEL_GAP = 6
const CUSTOM_TRACK_HEIGHT_STANDARD = 54
const CUSTOM_TRACK_HEIGHT_ZONED = 81
const CUSTOM_TRACK_HEIGHT_ENSEMBL_VCF = 100
const CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF = 108
const CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF_COMPACT = 64
const COMPRESSED_TRANSCRIPT_ROW_PITCH = 8
const COMPRESSED_TRANSCRIPT_ROW_GAP = 1
const COMPRESSED_TRANSCRIPT_EXON_HEIGHT = 6
const COMPRESSED_TRANSCRIPT_TRACK_PADDING = 12
const COMPRESSED_TRANSCRIPT_MID_OFFSET = 4
const COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT = 24
const FLATTENED_TRANSCRIPT_ROW_PITCH = 18
const FLATTENED_TRANSCRIPT_ROW_GAP = 2
const FLATTENED_TRANSCRIPT_TRACK_PADDING = 2
const FLATTENED_TRANSCRIPT_MID_OFFSET = 8
const FLATTENED_TRANSCRIPT_MIN_TRACK_HEIGHT = 36
const FLATTENED_COMPRESSED_TRANSCRIPT_TRACK_PADDING = 1
const FLATTENED_COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT = 36

const extractPathData = (svgRaw) => {
    if (typeof svgRaw !== 'string') return ''
    const m = svgRaw.match(/<path[^>]*\sd=(['"])(.*?)\1/i)
    return m?.[2] || ''
}
const extractSvgBody = (svgRaw) => {
    if (typeof svgRaw !== 'string') return ''
    return svgRaw
        .replace(/^[\s\S]*?<svg[^>]*>/i, '')
        .replace(/<\/svg>[\s\S]*$/i, '')
        .trim()
}
const RESET_ICON_PATH_D = extractPathData(iconResetRaw)
const ANCHOR_ICON_BODY = extractSvgBody(iconAnchorRaw)

// The same stroked glyph the canvas toggles draw, for the DOM buttons that
// toggle a track from the track picker. Takes its colour from the button.
function PowerGlyph({ size = SIDEBAR_TOGGLE_ICON_SIZE }) {
    const paths = powerGlyphPaths(size)
    if (!paths) return null
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={paths.stroke}
            strokeLinecap="round"
            aria-hidden="true"
        >
            <path d={paths.ring} />
            <path d={paths.stem} />
        </svg>
    )
}

// 5-level LOD pyramid for custom tracks
// binsPerTile × bpPerBin = tile size in bp
// Buffer = 2× viewport each side = 5× viewport total covered
const TRACK_LOD_LEVELS = [
    { id: 'L0', minBpPerPx: 1000, bpPerBin: 10000, binsPerTile: 500 }, // 5Mb tiles — whole-chrom overview
    { id: 'L1', minBpPerPx: 100, bpPerBin: 1000, binsPerTile: 512 }, // 512kb tiles — regional
    { id: 'L2', minBpPerPx: 10, bpPerBin: 100, binsPerTile: 512 }, // 51.2kb tiles — gene level
    { id: 'L3', minBpPerPx: 2, bpPerBin: 10, binsPerTile: 512 }, // 5.12kb tiles — exon level
    { id: 'L4', minBpPerPx: 0, bpPerBin: 1, binsPerTile: 1024 }, // 1kb tiles — base level
]
// Keep backward-compat alias for any legacy path still referencing BIGWIG_LOD_LEVELS
const BIGWIG_LOD_LEVELS = TRACK_LOD_LEVELS

const VCF_LOD_LEVELS = [
    { id: 'L0', minBpPerPx: 1200, bpPerBin: 25000, binsPerTile: 400, mode: 'summary' },
    { id: 'L1', minBpPerPx: 240, bpPerBin: 2500, binsPerTile: 512, mode: 'summary' },
    { id: 'L2', minBpPerPx: 48, bpPerBin: 500, binsPerTile: 512, mode: 'summary' },
    { id: 'L3', minBpPerPx: 8, bpPerBin: 60, binsPerTile: 512, mode: 'summary' },
    { id: 'L4', minBpPerPx: 0, bpPerBin: 3, binsPerTile: 1024, mode: 'detail' },
]

const VCF_SETTINGS_DEFAULTS = {
    genic_color: '#00b692',
    intergenic_color: '#96d0c9',
}

const SPLICE_FINE_BP_PER_PX = 140
const SPLICE_TILE_SPAN_FINE = 120_000
const SPLICE_TILE_SPAN_COARSE = 500_000
const SPLICE_TRANSCRIPT_BP_PER_PX = 40
const TRANSCRIPT_DETAIL_VIEWSPAN_BP = 500_000

// A gene carrying notes gets a speech bubble at its head. Smaller than the
// transcript-count pill because it says one thing rather than reading as a
// control, and it has to sit in the 16px of track padding above row zero.
const NOTE_BUBBLE_SIZE = 14
// Much looser than the footer pill's 60px: a bubble is a fixed mark, not a
// label that has to fit inside the gene. Below this the gene is a tick and the
// bubble would be describing something the reader cannot see.
const NOTE_BUBBLE_MIN_GENE_WIDTH = 24
const NOTE_BUBBLE_GAP = 2
const SPLICE_BLOCK_TRACK_HEIGHT = 56
const SPLICE_BLOCK_MERGE_GAP_PX = 2
const SPLICE_BLOCK_LEVELS = [
    { id: 'L0', minBpPerPx: 1600, tileSpanBp: 2_000_000, blockBp: 40_000 },
    { id: 'L1', minBpPerPx: 800, tileSpanBp: 1_000_000, blockBp: 20_000 },
    { id: 'L2', minBpPerPx: 320, tileSpanBp: 500_000, blockBp: 10_000 },
    { id: 'L3', minBpPerPx: SPLICE_FINE_BP_PER_PX, tileSpanBp: 250_000, blockBp: 5_000 },
]
const BIGBED_DETAIL_ENTER_BP_PER_PX = 18
const BIGBED_DETAIL_EXIT_BP_PER_PX = 26
const BIGBED_FEATURE_TILE_SPAN = 120_000
const BIGBED_BLOCK_MERGE_GAP_PX = 2
const BIGBED_DETAIL_EXON_HEIGHT = EXON_HEIGHT
const BIGBED_DETAIL_LANE_PITCH = EXON_HEIGHT + 4
const BIGBED_DETAIL_LANE_TOP_PAD = 4
const BIGBED_DETAIL_LANE_BOTTOM_PAD = 4
const BIGBED_DETAIL_TRACK_BASE_HEIGHT = 34
const BIGBED_DETAIL_TRACK_MAX_HEIGHT = 240
const BIGBED_DETAIL_MAX_FEATURES_PER_TILE = 3000
const BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD = 2500
const BIGBED_BLOCK_LEVELS = [
    { id: 'L0', minBpPerPx: 1500, tileSpanBp: 4_000_000, blockBp: 40_000 },
    { id: 'L1', minBpPerPx: 320, tileSpanBp: 800_000, blockBp: 8_000 },
    { id: 'L2', minBpPerPx: 60, tileSpanBp: 200_000, blockBp: 2_000 },
    { id: 'L3', minBpPerPx: BIGBED_DETAIL_ENTER_BP_PER_PX, tileSpanBp: 80_000, blockBp: 500 },
]
const SPLICE_HEIGHT_BASE = 52
const SPLICE_HEIGHT_STEP = 12
const SPLICE_HEIGHT_MIN = 56
const SPLICE_HEIGHT_MAX = 180
const GENE_LAYOUT_BUFFER_MIN = 100_000
const GENE_LAYOUT_BUFFER_MAX = 500_000
const GENE_LAYOUT_BUCKET_MIN_STEP = 50_000
const GENE_SUBTRACK_ENABLE_BP = 1_450_000
const GENE_SUBTRACK_DISABLE_BP = 1_650_000
const GENE_CHROM_CACHE_ENTER_SPAN = 2_000_000
const GENE_LAYOUT_COVERAGE_SHRINK_THRESHOLD = 0.85
const MAX_GENE_TILE_CACHE_TILES = 640
const MAX_TRANSCRIPT_CACHE_GENES = 180
const MAX_TRANSCRIPT_PREFETCH_GENES = 96
const MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP = 12
const SPLICE_HEAT_STOPS_LIGHT = [
    [51, 102, 204],   // transcript blue (cold)
    [139, 92, 246],   // purple (mid)
    [239, 68, 68],    // red (hot)
]
const SPLICE_HEAT_STOPS_DARK = [
    [91, 141, 239],   // transcript blue (cold)
    [167, 139, 250],  // purple (mid)
    [248, 113, 113],  // red (hot)
]
const DEFAULT_SPLICE_TRACK_SETTINGS = {
    min_support: 1,
    canonical_mode: 'all',
    annotated_mode: 'all',
    show_arrows: true,
    max_junctions: 5000,
    weak_max_support: 2,
    low_max_support: 4,
    medium_max_support: 9,
}
const BIGWIG_DATA_TYPE_DEFAULTS = {
    rna_seq: {
        display_mode: 'zoned_heatmap',
        plot_color: '#3b82f6',
        zoned_colors: ['#f7cd61', '#f4a940', '#ea7a2d', '#cc2f1f'],
    },
    atac_seq: {
        display_mode: 'signal_plot',
        plot_color: '#b52aa1',
        zoned_colors: ['#86efac', '#4ade80', '#22c55e', '#15803d'],
    },
    chip_seq: {
        display_mode: 'signal_plot',
        plot_color: '#8b5cf6',
        zoned_colors: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#6d28d9'],
    },
    custom: {
        display_mode: 'signal_plot',
        plot_color: '#14b8a6',
        zoned_colors: ['#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8'],
    },
}


const VCF_EFFECT_COLORS = {
    light: {
        protein_altering: '#d946ef', // magenta/rose
        splicing: '#f59e0b',         // amber
        transcript: '#2563eb',       // blue
        regulatory: '#0f766e',       // teal-cyan
        intergenic: '#7dd3fc',       // pale cyan
        other: '#64748b',            // slate
        occupancy: '#69b8b0',
    },
    dark: {
        protein_altering: '#e879f9',
        splicing: '#fbbf24',
        transcript: '#60a5fa',
        regulatory: '#2dd4bf',
        intergenic: '#a5f3fc',
        other: '#94a3b8',
        occupancy: '#7ecbc3',
    },
}
const DEFAULT_CUSTOM_TRACK_RENDER_MODE = 'zoned_heatmap'
const CUSTOM_TRACK_TOOLTIP_DWELL_MS = 1000
const CUSTOM_TRACK_TOOLTIP_MOVE_TOL_PX = 4
const ZONED_TRACK_MAX_VALUE = 100000
const ZONED_THRESHOLDS = [100, 1000, 10000, ZONED_TRACK_MAX_VALUE]
const ZONED_ZONE_HEIGHTS = [0.4, 0.2, 0.2, 0.2]
const ZONED_ZONE_SOLID_COLORS = {
    light: ['#f7cd61', '#f4a940', '#ea7a2d', '#cc2f1f'],
    dark: ['#f5c04c', '#ef9a30', '#e36823', '#d03a2a'],
}

// Ensembl-inspired color palette
const COLORS = {
    light: {
        bg: '#ffffff',
        // The ruler is unfilled on www.ensembl.org, and its rule, ticks and
        // labels are all the same mid grey — sampled from the live site at 1x.
        rulerBg: '#ffffff',
        rulerLine: '#787878',
        rulerText: '#787878',
        tickMajor: '#787878',
        tickMinor: '#787878',
        gutterLine: '#dee2e6',
        exonProteinCoding: '#3366cc',     // Ensembl blue
        exonNonCoding: '#33a02c',
        utr: '#a6cee3',
        intronLine: '#868e96',
        focusLine: '#e53e3e',
        geneLabelText: '#212529',
        strandChevron: '#868e96',
        selectedGene: '#dbe4ff', // pleasant soft indigo highlight
        pillBg: '#3366cc',
        pillText: '#ffffff',
        forwardStrandBg: '#ffffff',
        reverseStrandBg: '#f8f9fa',
        trackLabel: '#868e96',
        infoBg: '#f1f3f5',
        infoText: '#343a40',
        sequenceBg: '#f8f9fa',
        ...NUCLEOTIDE_COLORS.light,
    },
    dark: {
        bg: '#1a1b1e',
        // Ensembl has no dark theme to copy; these are the light greys inverted
        // to keep the same weight against the dark canvas.
        rulerBg: '#1a1b1e',
        rulerLine: '#8b8b8b',
        rulerText: '#8b8b8b',
        tickMajor: '#8b8b8b',
        tickMinor: '#8b8b8b',
        gutterLine: '#373a40',
        exonProteinCoding: '#5b8def',
        exonNonCoding: '#51cf66',
        utr: '#74c0fc',
        intronLine: '#5c5f66',
        focusLine: '#fc8181',
        geneLabelText: '#c1c2c5',
        strandChevron: '#5c5f66',
        selectedGene: '#2b3a55', // soft deep indigo
        pillBg: '#5b8def',
        pillText: '#ffffff',
        forwardStrandBg: '#1a1b1e',
        reverseStrandBg: '#212226',
        trackLabel: '#5c5f66',
        infoBg: '#1E2938',
        infoText: '#c1c2c5',
        sequenceBg: '#212226',
        ...NUCLEOTIDE_COLORS.dark,
    }
}

// ============ Helper Functions ============

function formatCoord(n) {
    const value = Number(n)
    if (!Number.isFinite(value)) return '—'
    return Math.round(value).toLocaleString()
}

function formatBp(n) {
    const value = Number(n)
    if (!Number.isFinite(value)) return '—'
    const abs = Math.abs(value)
    const sign = value < 0 ? '-' : ''
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}Mb`
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}kb`
    return `${sign}${abs}bp`
}

function hasGeneCoords(gene) {
    return Boolean(gene) && Number.isFinite(Number(gene.start)) && Number.isFinite(Number(gene.end))
}

function normalizeGeneCoord(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function getGeneCoordRange(gene) {
    if (!hasGeneCoords(gene)) return null
    return {
        start: normalizeGeneCoord(gene.start),
        end: normalizeGeneCoord(gene.end),
    }
}

function formatGeneStrand(strand) {
    if (strand === '+') return 'Forward strand'
    if (strand === '-') return 'Reverse strand'
    return 'Unknown strand'
}

function versionedStableId(id, version) {
    const stableId = String(id || '').trim()
    const stableVersion = String(version || '').trim()
    if (!stableId) return '—'
    if (!stableVersion || /\.\d+$/.test(stableId)) return stableId
    return `${stableId}.${stableVersion}`
}

function intervalListLength(intervals) {
    return (Array.isArray(intervals) ? intervals : []).reduce((sum, interval) => {
        const start = Number(interval?.start)
        const end = Number(interval?.end)
        if (!Number.isFinite(start) || !Number.isFinite(end)) return sum
        return sum + Math.max(0, Math.abs(Math.round(end) - Math.round(start)) + 1)
    }, 0)
}

function genomicSpanLength(start, end) {
    const s = Number(start)
    const e = Number(end)
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0
    return Math.max(0, Math.abs(Math.round(e) - Math.round(s)) + 1)
}

function countCdsExons(exons, cdsList) {
    const safeExons = Array.isArray(exons) ? exons : []
    const safeCdsList = Array.isArray(cdsList) ? cdsList : []
    return safeExons.filter((exon) => {
        const exonStart = Number(exon?.start)
        const exonEnd = Number(exon?.end)
        if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd)) return false
        return safeCdsList.some((cds) => {
            const cdsStart = Number(cds?.start)
            const cdsEnd = Number(cds?.end)
            if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd)) return false
            return Math.max(exonStart, cdsStart) <= Math.min(exonEnd, cdsEnd)
        })
    }).length
}

function getTranscriptPopupMetadata(transcript) {
    const tx = transcript || {}
    const exons = Array.isArray(tx?.exons) ? tx.exons : []
    const cdsList = Array.isArray(tx?.cds_list) ? tx.cds_list : []
    return {
        stableId: versionedStableId(tx?.id, tx?.version),
        biotype: String(tx?.biotype || '').trim() || '—',
        genomicSpanBp: genomicSpanLength(tx?.start, tx?.end),
        transcriptLength: exons.length > 0 ? intervalListLength(exons) : genomicSpanLength(tx?.start, tx?.end),
        exonCount: exons.length,
        hasCds: cdsList.length > 0,
        cdsExonCount: countCdsExons(exons, cdsList),
        cdsLength: intervalListLength(cdsList),
    }
}

function formatSignalDisplayValue(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return null
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return numeric
}

function formatSignalValueForTooltip(value) {
    const numeric = formatSignalDisplayValue(value)
    if (numeric === null) return 'NA'
    if (Number.isInteger(numeric)) return numeric.toLocaleString()
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function formatSignalValueForTrack(value) {
    const numeric = formatSignalDisplayValue(value)
    if (numeric === null) return 'NA'
    const abs = Math.abs(numeric)
    if (abs >= 1000) return numeric.toFixed(0)
    if (abs >= 10) return numeric.toFixed(1)
    return numeric.toFixed(2)
}

function getSelectedGeneCoordsForView(gene, isAligned, alignData, genomicToOverlay, options = {}) {
    const range = getGeneCoordRange(gene)
    if (!range) return null

    let start = range.start
    let end = range.end

    if (isAligned && alignData) {
        const o1 = genomicToOverlay(start)
        const o2 = genomicToOverlay(end)
        start = Math.min(o1, o2)
        end = Math.max(o1, o2)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (end <= start) end = start + 1

    const targetFillFractionRaw = Number(options?.targetFillFraction)
    const targetFillFraction = Number.isFinite(targetFillFractionRaw) && targetFillFractionRaw > 0 && targetFillFractionRaw < 1
        ? targetFillFractionRaw
        : 0.8
    const span = Math.max(1, end - start)
    const paddedSpan = span / targetFillFraction
    const flank = Math.max(0, (paddedSpan - span) / 2)

    start -= flank
    end += flank
    return { start, end }
}

function getTranscriptDisplayList(transcripts, limit) {
    return resolveGeneTranscriptView({
        transcripts,
        limit: Math.max(1, Math.floor(Number(limit) || 1)),
    }).transcripts
}

function getTranscriptIntrons(transcript) {
    const exons = (Array.isArray(transcript?.exons) ? transcript.exons : [])
        .map((exon) => ({
            start: Number(exon?.start),
            end: Number(exon?.end),
        }))
        .filter((exon) => Number.isFinite(exon.start) && Number.isFinite(exon.end) && exon.end > exon.start)
        .sort((a, b) => a.start - b.start)

    if (exons.length < 2) return []

    const introns = []
    for (let i = 0; i < exons.length - 1; i += 1) {
        const start = exons[i].end
        const end = exons[i + 1].start
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            introns.push({ start, end })
        }
    }
    return introns
}

function getDefaultChevronPositions(start, end, spacing) {
    const usableStart = Number(start)
    const usableEnd = Number(end)
    const safeSpacing = Math.max(1, Number(spacing) || 1)
    if (!Number.isFinite(usableStart) || !Number.isFinite(usableEnd) || usableEnd <= usableStart) {
        return []
    }

    const usableLength = usableEnd - usableStart
    if (usableLength <= safeSpacing * 0.7) {
        return [(usableStart + usableEnd) / 2]
    }

    const count = Math.max(1, Math.floor(usableLength / safeSpacing))
    const step = usableLength / (count + 1)
    return Array.from({ length: count }, (_, idx) => usableStart + ((idx + 1) * step))
}

function mergeChevronPositions(alignedPositions, defaultPositions, spacing) {
    const minGap = Math.max(4, (Number(spacing) || 1) * 0.55)
    const merged = []

    const addPosition = (position) => {
        if (!Number.isFinite(position)) return
        const alreadyPresent = merged.some((existing) => Math.abs(existing - position) < 0.5)
        if (alreadyPresent) return
        const tooClose = merged.some((existing) => Math.abs(existing - position) < minGap)
        if (tooClose) return
        merged.push(position)
    }

    ;[...(alignedPositions || []), ...(defaultPositions || [])]
        .sort((a, b) => a - b)
        .forEach(addPosition)

    return merged.sort((a, b) => a - b)
}

function buildAlignedIntronChevronLayout(displayTxs, spacingPx, edgePaddingPx, genomicToScreen) {
    const safeSpacing = Math.max(1, Number(spacingPx) || 1)
    const safeEdgePadding = Math.max(0, Number(edgePaddingPx) || 0)
    const projectToScreen = typeof genomicToScreen === 'function' ? genomicToScreen : null
    if (!projectToScreen) return []
    const priorIntrons = []

    return (Array.isArray(displayTxs) ? displayTxs : []).map((tx) => {
        const txPositions = []
        const introns = getTranscriptIntrons(tx)

        for (const intron of introns) {
            const rawStart = projectToScreen(intron.start)
            const rawEnd = projectToScreen(intron.end)
            const usableStart = Math.min(rawStart, rawEnd) + safeEdgePadding
            const usableEnd = Math.max(rawStart, rawEnd) - safeEdgePadding
            if (!(usableEnd > usableStart)) continue

            const overlappingPriorIntrons = priorIntrons.filter((prior) => prior.end > usableStart && prior.start < usableEnd)
            const alignedPositions = overlappingPriorIntrons.flatMap((prior) =>
                prior.positions.filter((position) => position >= usableStart && position <= usableEnd)
            )
            if (alignedPositions.length === 0) {
                for (const prior of overlappingPriorIntrons) {
                    const overlapStart = Math.max(prior.start, usableStart)
                    const overlapEnd = Math.min(prior.end, usableEnd)
                    if (overlapEnd <= overlapStart) continue
                    alignedPositions.push((overlapStart + overlapEnd) / 2)
                }
            }
            const defaultPositions = getDefaultChevronPositions(usableStart, usableEnd, safeSpacing)
            const mergedPositions = mergeChevronPositions(alignedPositions, defaultPositions, safeSpacing)

            txPositions.push(...mergedPositions)
            priorIntrons.push({
                start: usableStart,
                end: usableEnd,
                positions: mergedPositions,
            })
        }

        return txPositions.sort((a, b) => a - b)
    })
}

function getFeatureCoordsForView(start, end, isAligned, alignData, genomicToOverlay) {
    let normalizedStart = Number(start)
    let normalizedEnd = Number(end)
    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null

    if (isAligned && alignData) {
        const o1 = genomicToOverlay(normalizedStart)
        const o2 = genomicToOverlay(normalizedEnd)
        normalizedStart = Math.min(o1, o2)
        normalizedEnd = Math.max(o1, o2)
    } else if (normalizedEnd < normalizedStart) {
        const swap = normalizedStart
        normalizedStart = normalizedEnd
        normalizedEnd = swap
    }

    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null
    if (normalizedEnd <= normalizedStart) normalizedEnd = normalizedStart + 1
    return { start: normalizedStart, end: normalizedEnd }
}

function getTranscriptLayoutMetrics(isCompressed, isFlattened = false) {
    if (isCompressed) {
        return {
            rowPitch: COMPRESSED_TRANSCRIPT_ROW_PITCH,
            rowGap: COMPRESSED_TRANSCRIPT_ROW_GAP,
            exonHeight: COMPRESSED_TRANSCRIPT_EXON_HEIGHT,
            trackPadding: isFlattened ? FLATTENED_COMPRESSED_TRANSCRIPT_TRACK_PADDING : COMPRESSED_TRANSCRIPT_TRACK_PADDING,
            midOffset: COMPRESSED_TRANSCRIPT_MID_OFFSET,
            minTrackHeight: isFlattened ? FLATTENED_COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT : COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT,
            flattened: isFlattened,
        }
    }

    if (isFlattened) {
        return {
            rowPitch: FLATTENED_TRANSCRIPT_ROW_PITCH,
            rowGap: FLATTENED_TRANSCRIPT_ROW_GAP,
            exonHeight: EXON_HEIGHT,
            trackPadding: FLATTENED_TRANSCRIPT_TRACK_PADDING,
            midOffset: FLATTENED_TRANSCRIPT_MID_OFFSET,
            minTrackHeight: FLATTENED_TRANSCRIPT_MIN_TRACK_HEIGHT,
            flattened: true,
        }
    }

    return {
        rowPitch: TRACK_HEIGHT + 2,
        rowGap: 2,
        exonHeight: EXON_HEIGHT,
        trackPadding: 16,
        midOffset: (TRACK_HEIGHT - 14) / 2,
        minTrackHeight: 36,
        flattened: false,
    }
}

function TranscriptInfoPopup({
    popup,
    selectedChrom,
    onMouseEnter,
    onMouseLeave,
}) {
    const [copyFeedback, setCopyFeedback] = useState('')

    useEffect(() => {
        if (!copyFeedback) return undefined
        const timer = setTimeout(() => setCopyFeedback(''), 1400)
        return () => clearTimeout(timer)
    }, [copyFeedback])

    if (!popup?.transcript) return null

    const { transcript, arrowTargetX, arrowTargetY } = popup
    const metadata = getTranscriptPopupMetadata(transcript)
    const popupW = 318
    const arrowSize = 8
    const gap = 4
    const spaceLeft = arrowTargetX - arrowSize - gap
    const goLeft = spaceLeft >= popupW
    const popupLeft = goLeft
        ? arrowTargetX - popupW - arrowSize - gap
        : arrowTargetX + arrowSize + gap
    const handleCopyId = async (event) => {
        event.preventDefault()
        event.stopPropagation()
        const payload = String(metadata.stableId || '').trim()
        if (!payload || payload === '—') return
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload)
                setCopyFeedback('Copied')
            } else {
                setCopyFeedback('Clipboard unavailable')
            }
        } catch {
            setCopyFeedback('Copy failed')
        }
    }

    return (
        <div
            data-transcript-popup="true"
            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
            style={{
                left: popupLeft,
                top: arrowTargetY,
                transform: 'translateY(-50%)',
                width: popupW,
                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                color: '#f1f5f9',
                padding: '10px 14px',
                border: '1px solid rgba(255,255,255,0.1)',
                pointerEvents: 'auto',
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
            }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Transcript</div>
                {copyFeedback ? <div style={{ fontSize: 11, color: '#93c5fd' }}>{copyFeedback}</div> : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginBottom: 4 }}>
                <span style={{ opacity: 0.74 }}>Stable ID:</span>
                <span style={{ fontWeight: 700, fontFamily: FONT_MONO, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {metadata.stableId}
                </span>
                <button
                    type="button"
                    title="Copy transcript ID"
                    onClick={handleCopyId}
                    style={{
                        marginLeft: 'auto',
                        flex: '0 0 auto',
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(37, 99, 235, 0.22)',
                        color: '#dbeafe',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="5" y="5" width="14" height="16" rx="2.2" />
                        <path d="M9 3h6v4H9z" />
                    </svg>
                </button>
            </div>
            <div>Biotype: <span style={{ fontWeight: 700 }}>{metadata.biotype}</span></div>
            <div>Genomic span: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.genomicSpanBp)} bp</span></div>
            <div>Transcript length: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.transcriptLength)} bp</span></div>
            <div>Exons: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.exonCount)}</span></div>
            {metadata.hasCds && (
                <>
                    <div>CDS exons: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.cdsExonCount)}</span></div>
                    <div>CDS length: <span style={{ fontWeight: 700 }}>{formatCoord(metadata.cdsLength)} bp</span></div>
                </>
            )}
        </div>
    )
}

function formatRegionCoord(chrom, start, end) {
    if (!chrom) return '—'
    const formattedStart = formatCoord(start)
    const formattedEnd = formatCoord(end)
    if (formattedStart === '—' || formattedEnd === '—') return chrom
    return `${chrom}:${formattedStart}-${formattedEnd}`
}


function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

function quantileFromSorted(sortedValues, q) {
    const arr = Array.isArray(sortedValues) ? sortedValues : []
    if (arr.length === 0) return 0
    const qNorm = clamp(Number(q), 0, 1)
    const idx = (arr.length - 1) * qNorm
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    if (lo === hi) return Number(arr[lo]) || 0
    const loVal = Number(arr[lo]) || 0
    const hiVal = Number(arr[hi]) || 0
    const t = idx - lo
    return loVal + (hiVal - loVal) * t
}

function normalizeVcfDensityForHotspots(densityBins) {
    const values = Array.isArray(densityBins) ? densityBins : []
    if (values.length === 0) return []
    const finite = values
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    if (finite.length === 0) {
        return values.map(() => 0)
    }
    const sorted = [...finite].sort((a, b) => a - b)
    const median = Math.max(1e-6, quantileFromSorted(sorted, 0.5))
    const p95 = quantileFromSorted(sorted, 0.95)
    // Legacy occupancy payloads are typically in [0,1]; newer payloads are
    // enrichment-like where baseline is around 1 and hotspots are >1.
    const isLegacyOccupancy = p95 <= 1.05

    return values.map((v) => {
        const raw = Number(v)
        if (!Number.isFinite(raw) || raw <= 0) return 0
        const ratio = isLegacyOccupancy
            ? (raw / median)
            : raw
        const positive = Math.max(0, Math.log2(Math.max(1e-6, ratio)))
        const hotspot = Math.pow(clamp(positive / 3.0, 0, 1), 0.72)
        const baseline = ratio < 1
            ? (clamp(ratio, 0, 1) * 0.06)
            : 0.06
        return baseline + ((1 - baseline) * hotspot)
    })
}

function smoothVcfDensityBins(values, populated, radius = 1) {
    const src = Array.isArray(values) ? values : []
    const n = src.length
    if (n === 0 || radius <= 0) return src.slice()
    const pop = populated instanceof Uint8Array ? populated : null
    const out = src.slice()
    for (let i = 0; i < n; i++) {
        if (pop && !pop[i]) continue
        let sum = 0
        let wsum = 0
        const lo = Math.max(0, i - radius)
        const hi = Math.min(n - 1, i + radius)
        for (let j = lo; j <= hi; j++) {
            if (pop && !pop[j]) continue
            const v = Number(src[j])
            if (!Number.isFinite(v)) continue
            const w = radius + 1 - Math.abs(j - i)
            sum += v * w
            wsum += w
        }
        if (wsum > 0) out[i] = sum / wsum
    }
    return out
}

function smoothVcfDensityClasses(classes, populated, radius = 1) {
    const src = Array.isArray(classes) ? classes : []
    const n = src.length
    if (n === 0 || radius <= 0) return src.slice()
    const pop = populated instanceof Uint8Array ? populated : null
    const out = src.slice()
    for (let i = 0; i < n; i++) {
        if (pop && !pop[i]) continue
        let g = 0
        let inter = 0
        const lo = Math.max(0, i - radius)
        const hi = Math.min(n - 1, i + radius)
        for (let j = lo; j <= hi; j++) {
            if (pop && !pop[j]) continue
            const w = radius + 1 - Math.abs(j - i)
            if (src[j] === 'genic') g += w
            else inter += w
        }
        out[i] = g >= inter ? 'genic' : 'intergenic'
    }
    return out
}

function getFetchErrorMessage(error) {
    if (!error) return 'Request failed'
    if (typeof error === 'string') return error
    const message = String(error?.message || error?.detail || error)
    return message || 'Request failed'
}

function isTransientFetchErrorMessage(message) {
    const token = String(message || '').trim().toLowerCase()
    if (!token) return false
    return (
        token.includes('failed to fetch')
        || token.includes('fetch failed')
        || token.includes('networkerror')
        || token.includes('network error')
        || token.includes('load failed')
        || token.includes('connection was lost')
        || token.includes('aborterror')
        || token.includes('aborted')
        || token.includes('signal is aborted')
    )
}

function isTransientFetchError(error) {
    return isTransientFetchErrorMessage(getFetchErrorMessage(error))
}

function parseItemRgb(value) {
    const token = String(value || '').trim()
    if (!token) return null
    const parts = token.split(',')
    if (parts.length !== 3) return null
    const rgb = parts.map((part) => Number.parseInt(part.trim(), 10))
    if (rgb.some((v) => !Number.isFinite(v))) return null
    return [
        clamp(rgb[0], 0, 255),
        clamp(rgb[1], 0, 255),
        clamp(rgb[2], 0, 255),
    ]
}

function bigBedFeatureKey(feature) {
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

function bigBedFeatureColor(feature, isLight) {
    const rgb = parseItemRgb(feature?.itemRgb || feature?.color)
    if (rgb) {
        const [r, g, b] = rgb
        return {
            fill: `rgba(${r},${g},${b},${isLight ? 0.58 : 0.72})`,
            stroke: `rgba(${r},${g},${b},${isLight ? 0.92 : 0.98})`,
        }
    }
    const fallback = {
        fill: hexToRgba(VCF_SETTINGS_DEFAULTS.genic_color, isLight ? 0.34 : 0.46),
        stroke: hexToRgba(VCF_SETTINGS_DEFAULTS.genic_color, isLight ? 0.94 : 0.98),
    }
    return fallback
}

function bigBedBlockColor(span, isLight) {
    // Summary blocks intentionally use a stable generic color so large low-LOD spans
    // do not flicker as different underlying features stream in/out during pan/zoom.
    return isLight ? 'rgba(5,150,105,0.44)' : 'rgba(52,211,153,0.50)'
}

function getBigBedLaneCapacity(plotHeight) {
    const available = Math.max(
        BIGBED_DETAIL_EXON_HEIGHT,
        Number(plotHeight || 0) - BIGBED_DETAIL_LANE_TOP_PAD - BIGBED_DETAIL_LANE_BOTTOM_PAD,
    )
    return Math.max(1, Math.floor((available - BIGBED_DETAIL_EXON_HEIGHT) / BIGBED_DETAIL_LANE_PITCH) + 1)
}

function getBigBedTrackHeightForLanes(laneCount) {
    const lanes = Math.max(1, Number.isFinite(Number(laneCount)) ? Math.round(Number(laneCount)) : 1)
    return clamp(
        Math.max(
            CUSTOM_TRACK_HEIGHT_STANDARD,
            Math.round(BIGBED_DETAIL_TRACK_BASE_HEIGHT + lanes * BIGBED_DETAIL_LANE_PITCH),
        ),
        CUSTOM_TRACK_HEIGHT_STANDARD,
        BIGBED_DETAIL_TRACK_MAX_HEIGHT,
    )
}

function normalizeBigBedBlockSegments(rawBlocks, fallbackStart, fallbackEnd) {
    if (!Array.isArray(rawBlocks)) return []
    const out = []
    for (const block of rawBlocks) {
        const s = Number(block?.start)
        const e = Number(block?.end)
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
        const start = Math.max(Number(fallbackStart) || 0, s)
        const end = Math.min(Number(fallbackEnd) || Number.MAX_SAFE_INTEGER, e)
        if (end <= start) continue
        out.push({ start, end })
    }
    out.sort((a, b) => (a.start - b.start) || (a.end - b.end))
    return out
}

function parseBigBedBlockCsvInts(value) {
    const token = String(value || '').trim().replace(/,+$/, '')
    if (!token) return []
    const out = []
    for (const part of token.split(',')) {
        const v = Number.parseInt(String(part).trim(), 10)
        if (!Number.isFinite(v)) return []
        out.push(v)
    }
    return out
}

function deriveBigBedExonBlocksFromBedColumns(rowStart, rowEnd, blockCountRaw, blockSizesRaw, blockStartsRaw) {
    const start = Number(rowStart)
    const end = Number(rowEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    const blockCount = Number.parseInt(String(blockCountRaw ?? ''), 10)
    const blockSizes = parseBigBedBlockCsvInts(blockSizesRaw)
    const blockStarts = parseBigBedBlockCsvInts(blockStartsRaw)
    const expected = Number.isFinite(blockCount) && blockCount > 0 ? blockCount : blockSizes.length
    if (expected <= 0 || blockSizes.length !== expected || blockStarts.length !== expected) return []
    const out = []
    for (let i = 0; i < expected; i += 1) {
        const size = Number(blockSizes[i])
        const relStart = Number(blockStarts[i])
        if (!Number.isFinite(size) || !Number.isFinite(relStart) || size <= 0) return []
        const exonStart = start + relStart
        const exonEnd = exonStart + size
        const clippedStart = Math.max(start, exonStart)
        const clippedEnd = Math.min(end, exonEnd)
        if (clippedEnd > clippedStart) out.push({ start: clippedStart, end: clippedEnd })
    }
    out.sort((a, b) => (a.start - b.start) || (a.end - b.end))
    return out
}

function normalizeBigBedFeatureForRender(feature) {
    if (!feature || typeof feature !== 'object') return null
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null

    const explicitExons = normalizeBigBedBlockSegments(feature?.exon_blocks, start, end)
    const fallbackExons = explicitExons.length > 0
        ? explicitExons
        : deriveBigBedExonBlocksFromBedColumns(start, end, feature?.block_count, feature?.block_sizes, feature?.block_starts)
    const structureValidRaw = feature?.structure_valid === true
    const structureValid = (structureValidRaw && explicitExons.length > 0) || fallbackExons.length > 0
    const requestedRenderKind = String(feature?.render_kind || '').trim().toLowerCase()
    const renderKind = (structureValid && requestedRenderKind === 'transcript') || (structureValid && !requestedRenderKind)
        ? 'transcript'
        : 'interval'

    let cdsBlocks = normalizeBigBedBlockSegments(feature?.cds_blocks, start, end)
    if (cdsBlocks.length === 0 && structureValid) {
        const thickStart = Number(feature?.thick_start)
        const thickEnd = Number(feature?.thick_end)
        if (Number.isFinite(thickStart) && Number.isFinite(thickEnd) && thickEnd > thickStart) {
            cdsBlocks = fallbackExons
                .map((exon) => ({
                    start: Math.max(exon.start, thickStart),
                    end: Math.min(exon.end, thickEnd),
                }))
                .filter((block) => block.end > block.start)
        }
    }

    return {
        ...feature,
        start,
        end,
        _structure_valid: structureValid,
        _render_kind: renderKind,
        _exon_blocks: structureValid ? fallbackExons : [],
        _cds_blocks: structureValid ? cdsBlocks : [],
    }
}

function normalizeBigWigDataType(value, fallback = 'rna_seq') {
    const token = String(value || '').trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(BIGWIG_DATA_TYPE_DEFAULTS, token) ? token : fallback
}

function normalizeBigWigDisplayMode(mode, dataType = 'rna_seq') {
    const token = String(mode || '').trim().toLowerCase()
    if (token === 'line_plot' || token === 'bar_chart') return 'signal_plot'
    if (token === 'signal_plot' || token === 'zoned_heatmap') return token
    const normalizedType = normalizeBigWigDataType(dataType)
    return BIGWIG_DATA_TYPE_DEFAULTS[normalizedType].display_mode
}

function normalizeVcfDisplayMode(mode) {
    let token = String(mode || '').trim().toLowerCase()
    if (token === 'block_lollipop' || token === 'block-lollipop') token = 'adaptive'
    if (token === 'ensembl' || token === 'lollipop' || token === 'density') token = 'density_lollipop'
    return token === 'adaptive' || token === 'density_lollipop' ? token : 'density_lollipop'
}

function isVcfAdaptiveLikeMode(mode) {
    const normalized = normalizeVcfDisplayMode(mode)
    return normalized === 'adaptive' || normalized === 'density_lollipop'
}

function normalizeVcfHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

function normalizeVcfSettings(raw = null, previous = null) {
    const prev = previous && typeof previous === 'object' ? previous : {}
    const base = {
        genic_color: normalizeVcfHexColor(prev.genic_color, VCF_SETTINGS_DEFAULTS.genic_color),
        intergenic_color: normalizeVcfHexColor(prev.intergenic_color, VCF_SETTINGS_DEFAULTS.intergenic_color),
    }
    const source = raw && typeof raw === 'object' ? raw : {}
    return {
        genic_color: normalizeVcfHexColor(source.genic_color, base.genic_color),
        intergenic_color: normalizeVcfHexColor(source.intergenic_color, base.intergenic_color),
    }
}

function normalizeBigWigHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

function normalizeBigWigZonedColors(rawColors, fallbackColors) {
    const fallback = Array.isArray(fallbackColors) && fallbackColors.length >= 4
        ? fallbackColors.slice(0, 4)
        : BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.zoned_colors.slice(0, 4)
    const source = Array.isArray(rawColors) ? rawColors : []
    return [0, 1, 2, 3].map((idx) => normalizeBigWigHexColor(source[idx], fallback[idx]))
}

function normalizeBigWigSettings(raw = null, previous = null) {
    const prevType = normalizeBigWigDataType(previous?.data_type, 'rna_seq')
    const prevDefaults = BIGWIG_DATA_TYPE_DEFAULTS[prevType]
    const prev = {
        data_type: prevType,
        plot_color: normalizeBigWigHexColor(previous?.plot_color, prevDefaults.plot_color),
        zoned_colors: normalizeBigWigZonedColors(previous?.zoned_colors, prevDefaults.zoned_colors),
        use_default_plot_color: previous?.use_default_plot_color !== false,
        use_default_zoned_colors: previous?.use_default_zoned_colors !== false,
    }

    const source = raw && typeof raw === 'object' ? raw : {}
    const data_type = normalizeBigWigDataType(source.data_type, prev.data_type)
    const defaults = BIGWIG_DATA_TYPE_DEFAULTS[data_type]
    const use_default_plot_color = source.use_default_plot_color !== undefined
        ? source.use_default_plot_color !== false
        : prev.use_default_plot_color
    const use_default_zoned_colors = source.use_default_zoned_colors !== undefined
        ? source.use_default_zoned_colors !== false
        : prev.use_default_zoned_colors

    return {
        data_type,
        plot_color: use_default_plot_color
            ? defaults.plot_color
            : normalizeBigWigHexColor(source.plot_color, prev.plot_color),
        zoned_colors: use_default_zoned_colors
            ? defaults.zoned_colors.slice(0, 4)
            : normalizeBigWigZonedColors(source.zoned_colors, prev.zoned_colors),
        use_default_plot_color,
        use_default_zoned_colors,
    }
}

function hexToRgba(hex, alpha = 1) {
    const token = String(hex || '').trim()
    const match = token.match(/^#([0-9a-fA-F]{6})$/)
    if (!match) {
        return `rgba(59,130,246,${clamp(alpha, 0, 1)})`
    }
    const value = match[1]
    const r = Number.parseInt(value.slice(0, 2), 16)
    const g = Number.parseInt(value.slice(2, 4), 16)
    const b = Number.parseInt(value.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`
}

function normalizeSpliceTrackSettings(raw = null) {
    const merged = { ...DEFAULT_SPLICE_TRACK_SETTINGS, ...(raw || {}) }
    const minSupport = Number.parseInt(merged.min_support, 10)
    const maxJunctions = Number.parseInt(merged.max_junctions, 10)
    const weakMax = Number.parseInt(merged.weak_max_support, 10)
    const lowMax = Number.parseInt(merged.low_max_support, 10)
    const mediumMax = Number.parseInt(merged.medium_max_support, 10)
    const canonicalMode = ['all', 'canonical', 'non_canonical'].includes(String(merged.canonical_mode))
        ? String(merged.canonical_mode)
        : 'all'
    const annotatedMode = ['all', 'annotated', 'novel'].includes(String(merged.annotated_mode))
        ? String(merged.annotated_mode)
        : 'all'
    const min_support = Number.isFinite(minSupport) ? Math.max(1, minSupport) : 1
    const weak_max_support = Number.isFinite(weakMax) ? Math.max(min_support, weakMax) : Math.max(min_support, DEFAULT_SPLICE_TRACK_SETTINGS.weak_max_support)
    const low_max_support = Number.isFinite(lowMax) ? Math.max(weak_max_support + 1, lowMax) : Math.max(weak_max_support + 1, DEFAULT_SPLICE_TRACK_SETTINGS.low_max_support)
    const medium_max_support = Number.isFinite(mediumMax) ? Math.max(low_max_support + 1, mediumMax) : Math.max(low_max_support + 1, DEFAULT_SPLICE_TRACK_SETTINGS.medium_max_support)
    return {
        min_support,
        canonical_mode: canonicalMode,
        annotated_mode: annotatedMode,
        show_arrows: merged.show_arrows !== false,
        max_junctions: Number.isFinite(maxJunctions) ? Math.max(100, maxJunctions) : 5000,
        weak_max_support,
        low_max_support,
        medium_max_support,
    }
}

function spliceJunctionKey(junction) {
    const s = Number(junction?.start)
    const e = Number(junction?.end)
    const strand = String(junction?.strand || '.')
    return `${s}|${e}|${strand}`
}

function mixRgb(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ]
}

function spliceSupportColor(weight, isLight) {
    const stops = isLight ? SPLICE_HEAT_STOPS_LIGHT : SPLICE_HEAT_STOPS_DARK
    const w = clamp(Number.isFinite(weight) ? weight : 0, 0, 1)
    if (w <= 0) return stops[0]
    if (w >= 1) return stops[stops.length - 1]
    const scaled = w * (stops.length - 1)
    const idx = Math.floor(scaled)
    const frac = scaled - idx
    return mixRgb(stops[idx], stops[Math.min(stops.length - 1, idx + 1)], frac)
}

function spliceSupportBandForValue(support, spliceSettings) {
    const count = Math.max(0, Number(support) || 0)
    const settings = spliceSettings || DEFAULT_SPLICE_TRACK_SETTINGS
    if (count <= settings.weak_max_support) return 'weak'
    if (count <= settings.low_max_support) return 'low'
    if (count <= settings.medium_max_support) return 'medium'
    return 'high'
}

function spliceSupportBandWeight(support, spliceSettings) {
    const band = spliceSupportBandForValue(support, spliceSettings)
    if (band === 'weak') return 0.14
    if (band === 'low') return 0.4
    if (band === 'medium') return 0.68
    return 0.94
}

function reverseComplementDinucleotide(token) {
    const seq = String(token || '').toUpperCase()
    const map = { A: 'T', C: 'G', G: 'C', T: 'A' }
    return seq
        .split('')
        .reverse()
        .map((base) => map[base] || 'N')
        .join('')
}

function formatSpliceMotifForDisplay(motif, strand) {
    const text = String(motif || '').trim()
    const m = text.match(/^([ACGT]{2})\s*(?:\/|-)\s*([ACGT]{2})$/i)
    if (!m) return text || 'unknown'
    const donor = m[1].toUpperCase()
    const acceptor = m[2].toUpperCase()
    if (String(strand || '.').trim() === '-') {
        // Reverse strand: present motif in transcript-forward orientation.
        return `${reverseComplementDinucleotide(acceptor)}/${reverseComplementDinucleotide(donor)}`
    }
    return `${donor}/${acceptor}`
}

function getSpliceArcLift(widthPx, lodMode) {
    const w = Math.max(1, Number(widthPx) || 1)
    const maxLift = lodMode === 'detail' ? 84 : 63
    const sqrtTerm = Math.sqrt(w) * (lodMode === 'detail' ? 1.55 : 1.25)
    const longIntronBoost = Math.log2(1 + w) * (lodMode === 'detail' ? 1.35 : 1.05)
    return Math.min(maxLift, 5 + sqrtTerm + longIntronBoost)
}

function getSpliceBezierControls(x1, x2, peakY) {
    const dx = x2 - x1
    const dir = dx >= 0 ? 1 : -1
    const span = Math.abs(dx)
    const shoulder = Math.max(6, Math.min(44, span * 0.22))
    return {
        c1x: x1 + dir * shoulder,
        c1y: peakY,
        c2x: x2 - dir * shoulder,
        c2y: peakY,
    }
}

function annotateSpliceSimilarityLift(arcs, lodMode) {
    const list = Array.isArray(arcs) ? arcs : []
    if (list.length <= 1) return list
    const bucketPx = lodMode === 'detail' ? 2 : 3
    const liftStep = lodMode === 'detail' ? 3 : 2
    const groups = new Map()
    for (const arc of list) {
        const minX = Math.min(Number(arc?.x1) || 0, Number(arc?.x2) || 0)
        const maxX = Math.max(Number(arc?.x1) || 0, Number(arc?.x2) || 0)
        const b1 = Math.round(minX / bucketPx)
        const b2 = Math.round(maxX / bucketPx)
        const key = `${b1}|${b2}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(arc)
    }
    const out = []
    for (const group of groups.values()) {
        group.sort((a, b) =>
            (Number(a?.lane || 0) - Number(b?.lane || 0))
            || ((Number(b?.n_total || 0)) - (Number(a?.n_total || 0)))
            || ((Number(a?.end || 0) - Number(a?.start || 0)) - (Number(b?.end || 0) - Number(b?.start || 0)))
            || ((Number(a?.start || 0)) - (Number(b?.start || 0)))
            || ((Number(a?.end || 0)) - (Number(b?.end || 0)))
        )
        group.forEach((arc, idx) => {
            out.push({ ...arc, similarity_lift: idx * liftStep })
        })
    }
    return out
}

function computeSplicePeakY({
    baselineY,
    minTopY,
    lane,
    lanePitch,
    widthPx,
    lodMode,
    extraLift = 0,
}) {
    const laneN = Math.max(0, Number(lane || 0))
    const laneLift = (laneN + 1) * lanePitch
    const laneTopSeparation = Math.min(14, laneN * (lodMode === 'detail' ? 1.8 : 1.4))
    const topLimit = minTopY + laneTopSeparation
    const maxTotalLift = Math.max(2, baselineY - topLimit)

    const baseSpanLift = getSpliceArcLift(widthPx, lodMode)
    // Use most available arc headroom while keeping a small top margin.
    const boostedSpanLift = Math.min(maxTotalLift * 0.96, baseSpanLift * 1.3)

    const w = Math.max(1, Number(widthPx) || 1)
    const dragScale = 1 + Math.min(0.65, Math.log2(1 + w) / 14)
    const dragInput = clamp(Number(extraLift) || 0, -120, 240)
    const effectiveDragLift = dragInput * dragScale

    const desiredLift = laneLift + boostedSpanLift + effectiveDragLift
    const totalLift = clamp(desiredLift, 2, maxTotalLift)
    return baselineY - totalLift
}

function cubicPointAt(p0, p1, p2, p3, t) {
    const omt = 1 - t
    return (omt * omt * omt * p0)
        + (3 * omt * omt * t * p1)
        + (3 * omt * t * t * p2)
        + (t * t * t * p3)
}

function cubicDerivativeAt(p0, p1, p2, p3, t) {
    const omt = 1 - t
    return 3 * (
        (p1 - p0) * omt * omt
        + 2 * (p2 - p1) * omt * t
        + (p3 - p2) * t * t
    )
}

function getZonedValueFraction(value) {
    const v = clamp(Number.isFinite(value) ? value : 0, 0, ZONED_TRACK_MAX_VALUE)
    let acc = 0
    let zoneStart = 0
    for (let i = 0; i < ZONED_THRESHOLDS.length; i++) {
        const zoneEnd = ZONED_THRESHOLDS[i]
        const zoneHeight = ZONED_ZONE_HEIGHTS[i] || 0
        const zoneSpan = Math.max(1, zoneEnd - zoneStart)
        if (v <= zoneEnd || i === ZONED_THRESHOLDS.length - 1) {
            const local = clamp((v - zoneStart) / zoneSpan, 0, 1)
            return clamp(acc + local * zoneHeight, 0, 1)
        }
        acc += zoneHeight
        zoneStart = zoneEnd
    }
    return 1
}

const REV_COMP = {
    'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C', 'N': 'N',
    'a': 't', 't': 'a', 'c': 'g', 'g': 'c', 'n': 'n',
    '-': '-'
}

// ============ Tile Cache Constants (module-level to avoid stale closures) ============
const TILE_SIZE = 1_000_000
const getTileKey = (chrom, tileStart) => `${chrom}:${tileStart}`
const getChromGeneCacheKey = (genome, chrom) => `${genome || ''}:${String(chrom || '').trim().toLowerCase()}`
const snapToTile = (pos) => Math.floor(pos / TILE_SIZE) * TILE_SIZE

function collectGenesFromList(genes, start, end) {
    return queryGeneIntervalIndex(genes, start, end)
}

// ============ Page-level vertical scrolling ============
// Browser panels never scroll internally, so bringing a track feature into view
// means moving whichever ancestor owns the page scroll (falling back to the
// window when the app is not inside its own scroll container).

function getScrollerMetrics(scroller) {
    const isWindowScroller = !scroller
        || scroller === document.documentElement
        || scroller === document.body
    if (isWindowScroller) {
        const doc = document.documentElement
        const viewportHeight = window.innerHeight || doc?.clientHeight || 0
        return {
            isWindowScroller: true,
            top: 0,
            bottom: viewportHeight,
            scrollTop: window.scrollY || doc?.scrollTop || 0,
            maxScrollTop: Math.max(0, (doc?.scrollHeight || 0) - viewportHeight),
        }
    }
    const rect = scroller.getBoundingClientRect()
    return {
        isWindowScroller: false,
        top: rect.top,
        bottom: rect.bottom,
        scrollTop: scroller.scrollTop,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    }
}

function scrollScrollerTo(scroller, metrics, top, behavior = 'smooth') {
    if (metrics.isWindowScroller) window.scrollTo({ top, behavior })
    else scroller.scrollTo({ top, behavior })
}

// ============ GenomeBrowser Component ============

export default function GenomeBrowser({
    isActive = true,
    genome = 'reference',
    tutorialRecipeId = '',
    tutorialActive = false,   // a tutorial is running, whatever this panel's genome came from
    onTutorialHideInactive = null,  // Hide lives in the bar above, so the request is passed up
    alignmentRole = '',
    reloadEpoch = 0,
    theme = 'dark',
    alignmentOverlay = null,
    onPositionChange,
    onViewState,
    externalPosition,
    lockPan = false,
    lockZoom = false,
    onTrackVisibilityChange,
    forceTracksVisibility,
    label = 'Primary',
    genomePillLabel = '',
    genomeColor = '',
    onGenomePillClick = null,
    // Whether the assembly drawer the pill toggles is currently out. The pill
    // deliberately looks the same either way — this is for assistive tech only.
    genomePillExpanded = false,
    toolbarPosition = 'top',
    rulerPosition = 'top',
    focusBarPosition = 'top',
    trackAlign = 'top',
    showSequenceTrack = false,
    sequenceTrackPosition = 'bottom',
    sequenceTrackLabel = 'SR',
    sequenceTrackTooltip = 'Base level view of the reference',
    customTrackBrowsePath = '.',
    availableTracks = [],  // all registered tracks from Track Manager API
    refreshAvailableTracks = null,  // callback to re-fetch registered tracks
    tutorialTracksRequest = null,  // a tutorial's `browserTracks` arrival, reconciled below
    dimNonSelectedGenes = true,
    hideInactiveTracks = false,
    compressTranscripts = false,
    flattenTracks = false,
    adaptiveHeight = false,
    hiddenBiotypeClasses = [],
    onGeneSelect,
    // Genes the location drawer has hidden from the track. Scoped to the
    // location of focus by the view, which drops the set when that focus goes —
    // so nothing here has to remember to put them back.
    hiddenGeneIds = null,
    // The location of focus, reported upward the way the gene of focus is. There
    // is no drawer behind it — the view only needs to know a panel holds one, so
    // the Unfocus control can offer to clear it.
    onLocationSelect = null,
    // Focus-gene drawer: the parent owns the view model (ordering, hidden
    // transcripts, expand state, hover/ghost) and this panel renders it.
    focusTranscriptView = null,
    // geneId -> { order, hidden } for every gene the user has customised in this
    // panel, focused or not, so their choices survive unfocusing the gene.
    geneTranscriptViews = null,
    onFocusTranscriptsChange = null,
    onFocusTranscriptViewChange = null,
    // Where the pinned transcript's row sits inside this panel, in container-local
    // pixels. Reported rather than resolved here because only the view knows the
    // drawer row it has to meet.
    onFocusRowGeometryChange = null,
    // Edits addressed at a gene by id, so the canvas controls can act on genes
    // that are not the one currently in focus.
    onGeneTranscriptViewChange = null,
    // Width of the focus drawer overlaying this panel's right edge, so gene
    // framing centres on the track left visible rather than behind the drawer.
    // Two values because focusing a gene also opens the drawer: at click time
    // the overlay is not there yet, so framing has to anticipate it.
    focusDrawerInset = 0,
    focusDrawerInsetOnFocus = 0,
    navigateToGene,
    // A region asked for from outside the browser — a location note offering to
    // take the reader back. Focused on arrival, the way a typed region is.
    navigateToLocation = null,
    onManualNavigate,
    clearFocusEpoch = 0,
    screenshotTargetId = '',
    onScreenshotTargetChange = null,
    onViewSync = null,
    // Shared band height for multi-genome layouts: the parent raises every panel
    // to the tallest genome's natural height so the rows stay aligned.
    minCanvasHeight = 0,
    onContentHeightChange = null,
    // Resolved gesture map from the user's "Genome Browser Controls" setting.
    browsingControls = DEFAULT_BROWSING_CONTROLS,
    onBrowsingTargetChange = null,
    // { [geneId]: count } for this panel's genome. Counts only — the bubble
    // needs to know a gene has notes, never what they say.
    geneNoteCounts = null,
    onOpenGeneNotes = null,
}) {
    // Refs
    const rootRef = useRef(null)
    const canvasRef = useRef(null)
    const overlayRef = useRef(null)
    const containerRef = useRef(null)
    const toolbarRef = useRef(null)
    const animationRef = useRef(null)
    const velocityRef = useRef(0)
    const lastPosRef = useRef(0)
    const lastTimeRef = useRef(0)
    const adaptiveScrollAnchorRef = useRef(null)
    const adaptiveScrollAnchorFrameRef = useRef(null)
    const verticalZoomTrackAnchorRef = useRef(null)

    // State
    const [viewWidth, setViewWidth] = useState(800)
    const [viewHeight, setViewHeight] = useState(160)
    const [viewStart, setViewStart] = useState(0)        // Genomic coordinate of left edge
    const [viewEnd, setViewEnd] = useState(100000)        // Genomic coordinate of right edge
    const [expandedFooterViewport, setExpandedFooterViewport] = useState(null)
    // `isDragging` state only drives the cursor and listener wiring. The move
    // handler reads the refs instead, so the first mousemove after mousedown pans
    // immediately rather than being dropped while React commits the state.
    const [isDragging, setIsDragging] = useState(false)
    const isDraggingRef = useRef(false)
    const dragStartXRef = useRef(0)
    const dragViewStartRef = useRef(0)
    // 'all', or 'zoom-only' while a tutorial step asks for it. A ref because it is read
    // inside gesture handlers and must not make the panel re-render to take effect.
    const interactionModeRef = useRef('all')

    // Reached through the context, the way GenomeBrowserView does it: the tutorial
    // provider sits above App, so a view can report to it without anything in between
    // having to pass it along.
    const { emitSignal: emitTutorialSignal } = useTutorial()

    // Data state
    const [regions, setRegions] = useState([])
    const [selectedChrom, setSelectedChrom] = useState('')
    const [chromLength, setChromLength] = useState(0)
    const [expandedGenes, setExpandedGenes] = useState({})
    const [isViewportTranscriptExpandMode, setIsViewportTranscriptExpandMode] = useState(false)
    const [transcriptCache, setTranscriptCache] = useState({})  // gene_id -> transcripts[]
    const [selectedGene, setSelectedGene] = useState(null)
    // The location of focus: the same idea as the gene of focus, for a plain
    // stretch of the genome. { chrom, start, end } in 1-based genomic
    // coordinates. No drawer hangs off it — it is a focus bar, two boundary
    // lines and a re-centre target, nothing more.
    const [selectedLocation, setSelectedLocation] = useState(null)
    const [hiddenStrands, setHiddenStrands] = useState({ forward: false, reverse: false, sequence: false })
    const [sidebarTooltip, setSidebarTooltip] = useState(null)
    const [sequence, setSequence] = useState(null)
    const [seqRange, setSeqRange] = useState(null)          // {start, end} of fetched sequence
    const [isFlipped, setIsFlipped] = useState(false) // Standalone flip state
    const [isVerticalLayoutFlipped, setIsVerticalLayoutFlipped] = useState(false)
    const [isRulerCollapsed, setIsRulerCollapsed] = useState(false)
    const [isBoxSelectMode, setIsBoxSelectMode] = useState(false)
    const [isSelectingRect, setIsSelectingRect] = useState(false)
    const [selectionRect, setSelectionRect] = useState(null) // {x1,y1,x2,y2} in canvas CSS px
    const suppressNextClickRef = useRef(false)
    const [customTracks, setCustomTracks] = useState([]) // [{id, path, label, visible, renderMode, type}]
    const [customTrackData, setCustomTrackData] = useState({}) // id -> rendered data for current viewport
    const [customTrackLoading, setCustomTrackLoading] = useState({}) // id -> bool
    const [isCustomTrackBrowserOpen, setIsCustomTrackBrowserOpen] = useState(false)
    const [isCustomTrackLabelModalOpen, setIsCustomTrackLabelModalOpen] = useState(false)
    const [isTrackPickerOpen, setIsTrackPickerOpen] = useState(false) // new Track Picker Modal
    const [selectedTrackPickerIds, setSelectedTrackPickerIds] = useState([])
    const [pendingCustomTrackPath, setPendingCustomTrackPath] = useState('')
    const [customTrackLabelInput, setCustomTrackLabelInput] = useState('Custom track')
    const [customTrackRenderModeInput, setCustomTrackRenderModeInput] = useState(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
    const [customTrackHoverTooltip, setCustomTrackHoverTooltip] = useState(null)
    const customTrackTooltipTimerRef = useRef(null)
    const customTrackTooltipPendingRef = useRef(null)
    const [hoveredVcfBlock, setHoveredVcfBlock] = useState(null) // { trackId, start, end } | null
    const hoveredVcfBlockRef = useRef(null) // shadow ref to avoid stale closure comparisons
    const [hoveredBigBedFeature, setHoveredBigBedFeature] = useState(null) // { trackId, key, feature, anchorCanvasX, anchorCanvasY } | null
    const hoveredBigBedRef = useRef(null)
    const [hoveredSpliceJunction, setHoveredSpliceJunction] = useState(null) // { trackId, key, junction } | null
    const hoveredSpliceRef = useRef(null)
    const [clickedVcfVariant, setClickedVcfVariant] = useState(null) // { variant, chrom, clientX, clientY } | null
    const [clickedBigBedFeature, setClickedBigBedFeature] = useState(null) // { trackId, feature, popupX, popupY } | null
    const [clickedSpliceJunction, setClickedSpliceJunction] = useState(null) // { trackId, junction, popupX, popupY } | null
    const [spliceArcLiftOffsets, setSpliceArcLiftOffsets] = useState({}) // `${trackId}|${junctionKey}` -> px
    const spliceArcDragRef = useRef(null) // { trackId, key, startClientY, initialLift }
    const [hoveredSeqBase, setHoveredSeqBase] = useState(null) // { bp, base, bxL, bxR, seqBoxT, seqBoxH } | null
    const hoveredSeqBaseRef = useRef(null)
    const [clickedSeqBase, setClickedSeqBase] = useState(null) // { bp, base, bxL, bxR, seqBoxT, seqBoxH, popupX, popupY } | null
    const [clickedGeneTranscript, setClickedGeneTranscript] = useState(null) // { geneId, transcriptId, transcript, arrowTargetX, arrowTargetY }
    const transcriptPopupHoverRef = useRef(false)
    const transcriptPopupDismissTimerRef = useRef(null)
    const focusBarRef = useRef(null)
    const [focusBarHeight, setFocusBarHeight] = useState(0)
    const pendingVerticalCenterGeneIdRef = useRef(null)
    const pendingTranscriptPillFocusRef = useRef(null)
    const anchorIconImgRef = useRef(null)
    const [anchorIconReady, setAnchorIconReady] = useState(false)
    const selectedChromRef = useRef(selectedChrom)
    const viewWidthRef = useRef(viewWidth)
    const onTrackVisibilityChangeRef = useRef(onTrackVisibilityChange)
    const onGeneSelectRef = useRef(onGeneSelect)
    const onFocusTranscriptsChangeRef = useRef(onFocusTranscriptsChange)
    const onFocusTranscriptViewChangeRef = useRef(onFocusTranscriptViewChange)
    const onGeneTranscriptViewChangeRef = useRef(onGeneTranscriptViewChange)
    const onFocusRowGeometryChangeRef = useRef(onFocusRowGeometryChange)
    const onScreenshotTargetChangeRef = useRef(onScreenshotTargetChange)
    const onViewSyncRef = useRef(onViewSync)
    const onViewStateRef = useRef(onViewState)
    const onContentHeightChangeRef = useRef(onContentHeightChange)
    onContentHeightChangeRef.current = onContentHeightChange
    // Mirrored into a ref and deliberately kept OUT of the wheel effect's
    // dependency list, so changing the scheme never re-registers the listener
    // (which mid-gesture would drop the rest of a trackpad fling).
    const browsingControlsRef = useRef(browsingControls)
    browsingControlsRef.current = browsingControls
    const wheelGestureRef = useRef(null)
    const onBrowsingTargetChangeRef = useRef(onBrowsingTargetChange)
    onBrowsingTargetChangeRef.current = onBrowsingTargetChange
    selectedChromRef.current = selectedChrom
    viewWidthRef.current = viewWidth
    onTrackVisibilityChangeRef.current = onTrackVisibilityChange
    onGeneSelectRef.current = onGeneSelect
    onFocusTranscriptsChangeRef.current = onFocusTranscriptsChange
    onFocusTranscriptViewChangeRef.current = onFocusTranscriptViewChange
    onGeneTranscriptViewChangeRef.current = onGeneTranscriptViewChange
    onFocusRowGeometryChangeRef.current = onFocusRowGeometryChange
    const onOpenGeneNotesRef = useRef(onOpenGeneNotes)
    onOpenGeneNotesRef.current = onOpenGeneNotes
    onScreenshotTargetChangeRef.current = onScreenshotTargetChange
    onViewSyncRef.current = onViewSync
    onViewStateRef.current = onViewState

    useEffect(() => {
        if (!iconAnchorRaw) {
            anchorIconImgRef.current = null
            setAnchorIconReady(false)
            return undefined
        }

        // Load the anchor icon from an in-memory data URL so drawing it never taints the browser canvas.
        const img = new Image()
        img.decoding = 'async'
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconAnchorRaw)}`
        const onLoad = () => {
            anchorIconImgRef.current = img
            setAnchorIconReady(true)
        }
        const onError = () => {
            anchorIconImgRef.current = null
            setAnchorIconReady(false)
        }
        if (img.complete && img.naturalWidth > 0) onLoad()
        else {
            img.addEventListener('load', onLoad)
            img.addEventListener('error', onError)
        }
        return () => {
            img.removeEventListener('load', onLoad)
            img.removeEventListener('error', onError)
        }
    }, [])

    const clearCustomTrackTooltipDelay = useCallback(() => {
        if (customTrackTooltipTimerRef.current) {
            clearTimeout(customTrackTooltipTimerRef.current)
            customTrackTooltipTimerRef.current = null
        }
    }, [])

    const dismissCustomTrackTooltip = useCallback(() => {
        clearCustomTrackTooltipDelay()
        customTrackTooltipPendingRef.current = null
        setCustomTrackHoverTooltip(null)
    }, [clearCustomTrackTooltipDelay])

    const queueCustomTrackTooltip = useCallback((payload, mouseX, mouseY, clientX, clientY) => {
        if (!payload?.text) {
            dismissCustomTrackTooltip()
            return
        }
        const hoverKey = String(payload.hoverKey || payload.text || '')
        const pending = customTrackTooltipPendingRef.current
        const distance = pending ? Math.hypot(mouseX - pending.mouseX, mouseY - pending.mouseY) : Infinity
        const sameTarget = !!pending && pending.hoverKey === hoverKey && distance <= CUSTOM_TRACK_TOOLTIP_MOVE_TOL_PX
        if (!sameTarget) {
            clearCustomTrackTooltipDelay()
            setCustomTrackHoverTooltip(null)
            customTrackTooltipPendingRef.current = {
                hoverKey,
                text: payload.text,
                mouseX,
                mouseY,
                clientX,
                clientY,
            }
            customTrackTooltipTimerRef.current = setTimeout(() => {
                const current = customTrackTooltipPendingRef.current
                if (!current || current.hoverKey !== hoverKey) return
                setCustomTrackHoverTooltip({
                    text: current.text,
                    x: current.clientX,
                    y: current.clientY,
                })
                customTrackTooltipTimerRef.current = null
            }, CUSTOM_TRACK_TOOLTIP_DWELL_MS)
            return
        }
        customTrackTooltipPendingRef.current = {
            ...pending,
            text: payload.text,
            mouseX,
            mouseY,
            clientX,
            clientY,
        }
    }, [clearCustomTrackTooltipDelay, dismissCustomTrackTooltip])

    useEffect(() => () => {
        clearCustomTrackTooltipDelay()
    }, [clearCustomTrackTooltipDelay])

    useEffect(() => {
        setClickedSpliceJunction(null)
    }, [selectedChrom])

    // Alignment Overlay Computations
    const isAligned = !!alignmentOverlay
    const isPrimary = alignmentRole ? alignmentRole === 'reference' : genome === 'reference'
    const alignData = isPrimary ? alignmentOverlay?.reference : alignmentOverlay?.target

    const alignmentCoords = useMemo(() => {
        if (!isAligned || !alignData) return null
        const genomicToAlign = new Map() // genomic pos -> align pos
        const alignToGenomic = [] // align pos -> genomic pos

        let genomicPos = alignData.strand === '+' ? alignData.genomic_start : alignData.genomic_end
        const step = alignData.strand === '+' ? 1 : -1

        for (let alignPos = 0; alignPos < alignData.sequence.length; alignPos++) {
            const char = alignData.sequence[alignPos]
            alignToGenomic.push(genomicPos)
            if (char !== '-') {
                genomicToAlign.set(genomicPos, alignPos)
                genomicPos += step
            }
        }

        return {
            genomicToAlign,
            alignToGenomic,
            length: alignData.sequence.length,
            strand: alignData.strand
        }
    }, [isAligned, alignData])

    // Overlay coordinate (alignment columns, with virtual extension outside bounds) -> genomic
    const overlayToGenomic = useCallback((overlayPos) => {
        if (!isAligned || !alignmentCoords || !alignData) return overlayPos
        const length = alignmentCoords.length
        if (length <= 0) return overlayPos
        const step = alignmentCoords.strand === '+' ? 1 : -1
        const leftG = alignmentCoords.alignToGenomic[0] ?? alignData.genomic_start
        const rightG = alignmentCoords.alignToGenomic[length - 1] ?? alignData.genomic_end

        if (overlayPos < 0) {
            return leftG + overlayPos * step
        }
        if (overlayPos > (length - 1)) {
            return rightG + (overlayPos - (length - 1)) * step
        }

        const idx = Math.max(0, Math.min(length - 1, Math.round(overlayPos)))
        const mapped = alignmentCoords.alignToGenomic[idx]
        if (mapped !== undefined) return mapped

        // Fallback interpolation for rare unmapped holes
        return leftG + overlayPos * step
    }, [isAligned, alignmentCoords, alignData])

    // Genomic -> overlay coordinate, including linear extension beyond alignment edges
    const genomicToOverlay = useCallback((genomicPos) => {
        if (!isAligned || !alignmentCoords || !alignData) return genomicPos
        const length = alignmentCoords.length
        if (length <= 0) return genomicPos
        const step = alignmentCoords.strand === '+' ? 1 : -1
        const leftG = alignmentCoords.alignToGenomic[0] ?? alignData.genomic_start
        const rightG = alignmentCoords.alignToGenomic[length - 1] ?? alignData.genomic_end

        const rounded = Math.round(genomicPos)
        const exact = alignmentCoords.genomicToAlign.get(rounded)
        if (exact !== undefined) return exact

        // Convert positions outside alignment bounds
        const fromLeft = (genomicPos - leftG) / step
        if (fromLeft < 0) return fromLeft
        const fromRight = ((genomicPos - rightG) / step) + (length - 1)
        if (fromRight > (length - 1)) return fromRight

        // Inside alignment but fell on a gap-only projection: search nearest mapped genomic base
        for (let dist = 1; dist < 2000; dist++) {
            const left = alignmentCoords.genomicToAlign.get(rounded - dist)
            if (left !== undefined) return left
            const right = alignmentCoords.genomicToAlign.get(rounded + dist)
            if (right !== undefined) return right
        }

        return fromLeft
    }, [isAligned, alignmentCoords, alignData])

    // Effect to snap view into alignment bounds when entering overlay
    useEffect(() => {
        if (isAligned && alignData) {
            const newStart = 0
            const newEnd = alignData.sequence.length
            setViewStart(newStart)
            setViewEnd(newEnd)
            if (onPositionChange) {
                onPositionChange(selectedChrom, newStart, newEnd)
            }
        } else if (!isAligned && alignmentCoords) {
            // Restore to normal genomic bounds when exiting
            // But we don't know exactly what to restore to unless we cached it...
            // the parent likely triggers a reload anyway or we just stay at the genomic pos
            setViewStart(Math.min(...Array.from(alignmentCoords.genomicToAlign.keys())))
            setViewEnd(Math.max(...Array.from(alignmentCoords.genomicToAlign.keys())))
        }
    }, [isAligned]) // Only trigger on enter/exit

    // Override hiddenStrands when aligned so we only see the relevant strand
    const effectiveHiddenStrands = useMemo(() => {
        if (!isAligned || !alignData) return hiddenStrands;
        return {
            ...hiddenStrands,
            forward: hiddenStrands.forward || alignData.strand !== '+',
            reverse: hiddenStrands.reverse || alignData.strand !== '-'
        }
    }, [isAligned, alignData, hiddenStrands])

    // Genomic view range for backend fetching
    const genomicViewRange = useMemo(() => {
        if (isAligned && alignmentCoords && alignData) {
            const g1 = overlayToGenomic(Math.floor(viewStart))
            const g2 = overlayToGenomic(Math.ceil(viewEnd))
            return {
                start: Math.min(g1, g2),
                end: Math.max(g1, g2)
            }
        }
        return { start: viewStart, end: viewEnd }
    }, [viewStart, viewEnd, isAligned, alignmentCoords, alignData, overlayToGenomic])
    const genomicViewRangeRef = useRef(genomicViewRange)
    genomicViewRangeRef.current = genomicViewRange

    // Sync hiddenStrands when the global force tracks command changes
    useEffect(() => {
        if (forceTracksVisibility === 'off') {
            setHiddenStrands({ forward: true, reverse: true, sequence: true })
        } else if (forceTracksVisibility === 'on') {
            setHiddenStrands({ forward: false, reverse: false, sequence: false })
        }
    }, [forceTracksVisibility])

    // Report effective visibility to parent
    useEffect(() => {
        if (onTrackVisibilityChangeRef.current) {
            onTrackVisibilityChangeRef.current(effectiveHiddenStrands, {
                customInactive: customTracks.some((track) => track?.visible === false),
                customTotal: customTracks.length,
            })
        }
    }, [effectiveHiddenStrands, customTracks])

    const swapVerticalPlacement = useCallback((value) => {
        if (value === 'top') return 'bottom'
        if (value === 'bottom') return 'top'
        return value
    }, [])

    const effectiveToolbarPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(toolbarPosition) : toolbarPosition
    const effectiveRulerPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(rulerPosition) : rulerPosition
    const effectiveFocusBarPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(focusBarPosition) : focusBarPosition
    const effectiveTrackAlign = isVerticalLayoutFlipped ? swapVerticalPlacement(trackAlign) : trackAlign
    const effectiveRulerHeight = isRulerCollapsed ? 0 : RULER_HEIGHT
    const effectiveSequenceTrackPosition = isVerticalLayoutFlipped ? swapVerticalPlacement(sequenceTrackPosition) : sequenceTrackPosition
    // Panels never scroll internally: the page-level scroller in GenomeBrowserView
    // owns all vertical movement, so tracks always lay out at their natural height
    // and grow the page rather than a nested scrollbar. "Adaptive"/"Flatten"
    // therefore no longer affect scrolling — they only decide whether a panel may
    // shrink below the uniform multi-genome band height, and how much trailing
    // padding is drawn under the last track.
    const compactPanelHeight = flattenTracks || adaptiveHeight

    // Drag-and-drop reordering
    const composeTrackOrder = useCallback((seqPosition, customIds) => {
        const orderedCustom = Array.isArray(customIds) ? customIds : []
        if (seqPosition === 'top') {
            return ['sequence', ...orderedCustom, 'forward', 'reverse']
        }
        return ['forward', 'reverse', ...orderedCustom, 'sequence']
    }, [])

    const [trackOrder, setTrackOrder] = useState(() => composeTrackOrder(sequenceTrackPosition, []))
    const [draggingTrack, setDraggingTrack] = useState(null)
    const [hoveredTrack, setHoveredTrack] = useState(null)
    const isCustomTrackId = useCallback((trackId) => trackId.startsWith('ct_'), [])

    // Keep track order in sync with current custom tracks.
    useEffect(() => {
        const customIds = new Set(customTracks.map((track) => track.id))
        setTrackOrder((prev) => {
            const existingCustomOrder = prev.filter((trackId) => isCustomTrackId(trackId) && customIds.has(trackId))
            const existingCustomSet = new Set(existingCustomOrder)
            const newCustomIds = customTracks
                .map((track) => track.id)
                .filter((trackId) => !existingCustomSet.has(trackId))
            const nextCustomOrder = [...existingCustomOrder, ...newCustomIds]
            const nextOrder = composeTrackOrder(effectiveSequenceTrackPosition, nextCustomOrder)
            if (nextOrder.length === prev.length && nextOrder.every((trackId, idx) => trackId === prev[idx])) {
                return prev
            }
            return nextOrder
        })
    }, [customTracks, effectiveSequenceTrackPosition, isCustomTrackId, composeTrackOrder])

    // Region filter
    const [showFeatureless, setShowFeatureless] = useState(false)
    const [searchInput, setSearchInput] = useState('')

    // Loading states
    const [loadingRegions, setLoadingRegions] = useState(false)
    const [loadingGenes, setLoadingGenes] = useState(false)
    const [hasInitialViewportData, setHasInitialViewportData] = useState(false)
    const transcriptCacheRef = useRef(transcriptCache)
    const transcriptCacheUsageRef = useRef(new Map())
    const transcriptCacheTouchCounterRef = useRef(0)
    const protectedTranscriptCacheIdsRef = useRef(new Set())
    const fetchingTranscriptIdsRef = useRef(new Map())
    const transcriptRequestGenerationRef = useRef(0)
    const identityRequestControllersRef = useRef(new Set())

    // Tile cache: Map of `chrom:tileStart` -> gene[] (stored in ref to avoid re-renders)
    const tileCacheRef = useRef(new Map())
    // Track in-flight tile fetches to avoid duplicate requests
    const fetchingTilesRef = useRef(new Map())
    const activeGeneRequestGenerationRef = useRef(0)
    // Resident simplified genes for each chromosome. These are kept for the
    // component session so zoomed-out panning does not cycle gene windows.
    const chromGeneCacheRef = useRef(new Map())
    const fetchingChromGenesRef = useRef(new Map())
    const chromGeneGenerationRef = useRef(0)
    // Derived visible genes from cache (state so canvas re-renders)
    const [genes, setGenes] = useState([])
    const geneSubtrackStateRef = useRef((viewEnd - viewStart) <= GENE_SUBTRACK_ENABLE_BP)
    const geneRowStickyRef = useRef({ forward: 1, reverse: 1 })
    const geneRowShrinkBucketRef = useRef({ forward: null, reverse: null })
    const geneLayoutPackCacheRef = useRef({
        forward: { key: '', rowMap: new Map(), requiredRows: 1 },
        reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
    })
    const previousStickyLayoutModeRef = useRef({
        expanded: isViewportTranscriptExpandMode,
        flatten: flattenTracks,
    })
    const [stickyLayoutResetEpoch, setStickyLayoutResetEpoch] = useState(0)
    const colors = COLORS[theme] || COLORS.dark
    const isLight = theme === 'light'

    useEffect(() => {
        geneSubtrackStateRef.current = true
        geneRowStickyRef.current = { forward: 1, reverse: 1 }
        geneRowShrinkBucketRef.current = { forward: null, reverse: null }
        geneLayoutPackCacheRef.current = {
            forward: { key: '', rowMap: new Map(), requiredRows: 1 },
            reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
        }
    }, [genome, selectedChrom])

    // Expanded transcript views deliberately make the canvas very tall, and Flatten
    // deliberately removes that height. The ordinary panning stabiliser must not carry
    // either temporary shape back into the plain layout: after collapsing the transcripts
    // it used to leave two thousand pixels of blank track below them. Reset synchronously
    // and invalidate the layout memo before the next frame is painted.
    useLayoutEffect(() => {
        const next = { expanded: isViewportTranscriptExpandMode, flatten: flattenTracks }
        const previous = previousStickyLayoutModeRef.current
        previousStickyLayoutModeRef.current = next
        if (!shouldResetStickyGeneRows(previous, next)) return
        geneRowStickyRef.current = { forward: 1, reverse: 1 }
        geneRowShrinkBucketRef.current = { forward: null, reverse: null }
        geneLayoutPackCacheRef.current = {
            forward: { key: '', rowMap: new Map(), requiredRows: 1 },
            reverse: { key: '', rowMap: new Map(), requiredRows: 1 },
        }
        setStickyLayoutResetEpoch((epoch) => epoch + 1)
    }, [isViewportTranscriptExpandMode, flattenTracks])

    // ============ Gene index readiness ============

    // The assembly is browsable long before the genes are. Regions, the ruler
    // and the sequence track all come from the FASTA, which is ready at once,
    // while indexing a large annotation takes minutes — and indexing is serial,
    // so a second genome waits for the first. Rather than hold the panel behind
    // a spinner for all of that, the browser opens on the assembly and watches
    // this endpoint to fill the gene track in when the index lands.
    const [geneIndexStatus, setGeneIndexStatus] = useState(null)
    const [geneIndexEpoch, setGeneIndexEpoch] = useState(0)
    const geneIndexReadyRef = useRef(false)
    const sawPendingRef = useRef(false)

    useEffect(() => {
        geneIndexReadyRef.current = false
        sawPendingRef.current = false
        setGeneIndexStatus(null)
    }, [genome, reloadEpoch])

    useEffect(() => {
        if (!isActive) return undefined
        let cancelled = false
        let timer = null
        const controller = new AbortController()

        const poll = async () => {
            try {
                const res = await fetch(
                    `${API_BASE}/api/browse/index-status?genome=${encodeURIComponent(genome)}`,
                    { signal: controller.signal },
                )
                if (!res.ok) {
                    // A genome this backend does not recognise will never start
                    // recognising it. Only a server-side fault is worth waiting
                    // out — that is a restart, and it comes back.
                    if (res.status >= 400 && res.status < 500) return
                    throw new Error(`index status ${res.status}`)
                }
                const data = await res.json()
                if (cancelled) return
                setGeneIndexStatus(data)

                if (data?.state === 'ready') {
                    // Genes that were not there when the panel opened are there
                    // now. Bumping the epoch drops the empty tiles the browser
                    // cached while it waited and asks for them again. Only worth
                    // doing if we actually waited: an index that was ready all
                    // along would otherwise throw away a good cache on mount.
                    if (sawPendingRef.current && !geneIndexReadyRef.current) {
                        geneIndexReadyRef.current = true
                        setGeneIndexEpoch((epoch) => epoch + 1)
                    }
                    return
                }
                sawPendingRef.current = true
                // 'none' means the genome has no annotation at all. There is
                // nothing to wait for, so stop asking.
                if (data?.state === 'none' || data?.state === 'failed') return
            } catch (error) {
                if (error?.name === 'AbortError' || cancelled) return
                // Backend restarting, most likely. Keep watching.
            }
            if (!cancelled) {
                timer = window.setTimeout(poll, GENE_INDEX_POLL_INTERVAL_MS)
            }
        }

        poll()
        return () => {
            cancelled = true
            controller.abort()
            if (timer) window.clearTimeout(timer)
        }
    }, [genome, isActive, reloadEpoch, geneIndexEpoch])

    const retryGeneIndex = useCallback(async () => {
        try {
            await fetch(`${API_BASE}/api/browse/index-retry`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ genome }),
            })
        } catch (error) {
            console.error(`[GenomeBrowser:${genome}] Failed to restart the index build:`, error)
        }
        setGeneIndexStatus((prev) => ({ ...(prev || {}), state: 'queued' }))
        setGeneIndexEpoch((epoch) => epoch + 1)
    }, [genome])

    const holdGeneTrackHeight = shouldHoldGeneTrackHeight(geneIndexStatus)
    // No gene tiles are coming: the index is being built, or the build failed.
    // A genome that simply has no annotation is not this — its gene endpoints
    // answer normally with nothing in them, which the browser already handles.
    const geneTilesBlocked = holdGeneTrackHeight

    // Read from the fetch paths, which must not be rebuilt every time the meter
    // moves. Asking for genes while the index is being built only produces a
    // stream of "not yet" replies — one per tile, per pan, for the whole build.
    const geneTilesBlockedRef = useRef(false)
    useEffect(() => {
        geneTilesBlockedRef.current = geneTilesBlocked
    }, [geneTilesBlocked])

    // Everything that was keyed on the reload epoch is keyed on this instead, so
    // an index that lands after the panel opened clears the same caches a manual
    // reload would.
    const dataEpoch = reloadEpoch + geneIndexEpoch

    useEffect(() => {
        setHasInitialViewportData(false)
        setGenes([])
        tileCacheRef.current.clear()
        fetchingTilesRef.current.clear()
        chromGeneGenerationRef.current += 1
        chromGeneCacheRef.current.clear()
        fetchingChromGenesRef.current.clear()
    }, [genome, dataEpoch])

    useEffect(() => {
        activeGeneRequestGenerationRef.current += 1
        return () => {
            for (const controller of identityRequestControllersRef.current) controller.abort()
            identityRequestControllersRef.current.clear()
            fetchingTilesRef.current.clear()
            fetchingChromGenesRef.current.clear()
            fetchingTranscriptIdsRef.current.clear()
        }
    }, [genome, dataEpoch, selectedChrom])

    // Whether this panel should carry the tutorial's invisible gutter buttons. Either the
    // panel's genome came from an embedded recipe, or a tutorial is simply running on it.
    const tutorialAnchorsActive = Boolean(tutorialRecipeId) || Boolean(tutorialActive)

    const customTracksById = useMemo(() => {
        const map = new Map()
        for (const t of customTracks) map.set(t.id, t)
        return map
    }, [customTracks])

    // Keep browser track config synced with Track Manager registry updates.
    // This avoids stale renderMode/settings when users edit a registered track.
    useEffect(() => {
        if (!Array.isArray(availableTracks) || availableTracks.length === 0 || !Array.isArray(customTracks) || customTracks.length === 0) return
        const byRegistryId = new Map()
        const byPath = new Map()
        for (const registered of availableTracks) {
            if (!registered) continue
            if (registered.id !== undefined && registered.id !== null) {
                byRegistryId.set(String(registered.id), registered)
            }
            if (registered.path) byPath.set(String(registered.path), registered)
        }

        const fullRefreshIds = new Set()
        let localChanged = false
        const nextCustomTracks = customTracks.map((track) => {
            const registryId = track?.registryTrackId ? String(track.registryTrackId) : ''
            let registered = null
            if (registryId && byRegistryId.has(registryId)) {
                registered = byRegistryId.get(registryId)
            } else if (track?.path && byPath.has(String(track.path))) {
                registered = byPath.get(String(track.path))
            }
            if (!registered) return track

            const registeredType = registered.type || track.type || 'bigwig'
            const synced = {
                ...track,
                registryTrackId: registered.id,
                type: registeredType,
                label: registered.label || track.label,
                path: registered.path || track.path,
            }

            if (registeredType === 'bigwig') {
                const mergedSettings = normalizeBigWigSettings(
                    registered.bigwig_settings,
                    track?.bigwigSettings || track?.bigwig_settings,
                )
                synced.bigwigSettings = mergedSettings
                synced.renderMode = normalizeBigWigDisplayMode(registered.display_mode, mergedSettings.data_type)
            } else if (registeredType === 'vcf') {
                synced.vcfSettings = normalizeVcfSettings(
                    registered.vcf_settings,
                    track?.vcfSettings || track?.vcf_settings,
                )
                synced.renderMode = normalizeVcfDisplayMode(registered.display_mode)
            } else if (registeredType === 'splice_junctions') {
                synced.spliceSettings = normalizeSpliceTrackSettings(registered.splice_settings)
                synced.renderMode = 'arcs'
            } else if (registered.display_mode) {
                synced.renderMode = registered.display_mode
            }

            const prevBigwig = track?.bigwigSettings || track?.bigwig_settings
            const nextBigwig = synced?.bigwigSettings || synced?.bigwig_settings
            const settingsChanged = JSON.stringify(prevBigwig || null) !== JSON.stringify(nextBigwig || null)
            const vcfSettingsChanged = JSON.stringify(track?.vcfSettings || track?.vcf_settings || null) !== JSON.stringify(synced?.vcfSettings || synced?.vcf_settings || null)
            const spliceChanged = JSON.stringify(track?.spliceSettings || track?.splice_settings || null) !== JSON.stringify(synced?.spliceSettings || synced?.splice_settings || null)
            const requiresFullRefresh = (
                String(synced.path || '') !== String(track.path || '')
                || String(synced.renderMode || '') !== String(track.renderMode || '')
                || String(synced.type || '') !== String(track.type || '')
            )
            if (requiresFullRefresh && track?.id) {
                fullRefreshIds.add(String(track.id))
            }
            if (
                synced.renderMode !== track.renderMode
                || synced.label !== track.label
                || synced.type !== track.type
                || synced.path !== track.path
                || String(synced.registryTrackId || '') !== String(track.registryTrackId || '')
                || settingsChanged
                || vcfSettingsChanged
                || spliceChanged
            ) {
                localChanged = true
            }
            return synced
        })

        if (localChanged) {
            setCustomTracks(nextCustomTracks)
        }
        if (!localChanged || fullRefreshIds.size === 0) return

        const shouldDropTrack = (rawKey) => {
            const normalized = String(rawKey || '').replace(/^(sjblk:|sj:|vcfblk:|adpdet:|bbblk:|bbft:)/, '')
            const trackId = normalized.split('|', 1)[0]
            return fullRefreshIds.has(trackId)
        }

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackFeatureFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfBlockTileFetchSetRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = String(key).split('|', 1)[0]
            if (fullRefreshIds.has(trackId)) delete trackChromScaleRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) delete next[trackId]
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) next[trackId] = true
            return next
        })
    }, [availableTracks, customTracks])

    useEffect(() => {
        if (!clickedSpliceJunction) return
        if (!customTracksById.has(clickedSpliceJunction.trackId)) {
            setClickedSpliceJunction(null)
        }
    }, [clickedSpliceJunction, customTracksById])
    useEffect(() => {
        if (!clickedBigBedFeature) return
        if (!customTracksById.has(clickedBigBedFeature.trackId)) {
            setClickedBigBedFeature(null)
        }
    }, [clickedBigBedFeature, customTracksById])
    useEffect(() => {
        if (clickedSpliceJunction) {
            const data = customTrackData?.[clickedSpliceJunction.trackId]
            if (data?.mode === 'splice_blocks') {
                setClickedSpliceJunction(null)
            }
        }
        if (hoveredSpliceJunction) {
            const data = customTrackData?.[hoveredSpliceJunction.trackId]
            if (data?.mode === 'splice_blocks') {
                hoveredSpliceRef.current = null
                setHoveredSpliceJunction(null)
            }
        }
        if (clickedBigBedFeature) {
            const data = customTrackData?.[clickedBigBedFeature.trackId]
            if (data?.mode !== 'bigbed_detail') {
                setClickedBigBedFeature(null)
            }
        }
        if (hoveredBigBedFeature) {
            const data = customTrackData?.[hoveredBigBedFeature.trackId]
            if (data?.mode !== 'bigbed_detail') {
                hoveredBigBedRef.current = null
                setHoveredBigBedFeature(null)
            }
        }
    }, [clickedSpliceJunction, hoveredSpliceJunction, clickedBigBedFeature, hoveredBigBedFeature, customTrackData])

    const isGeneHiddenByBiotype = useCallback((gene) => {
        if (!gene || hiddenBiotypeClasses.length === 0) return false
        const cls = classifyBiotype(gene.biotype)
        return Boolean(cls && hiddenBiotypeClasses.includes(cls))
    }, [hiddenBiotypeClasses])

    /* What the track leaves out: classes the reader filtered, and genes they hid
     * one at a time from the location drawer. Every path that draws, labels,
     * hit-tests or counts a gene goes through this, so a hidden gene is hidden
     * from the canvas rather than merely invisible. */
    const hiddenGeneIdSet = useMemo(
        () => new Set((Array.isArray(hiddenGeneIds) ? hiddenGeneIds : []).map(String)),
        [hiddenGeneIds]
    )
    const isGeneHiddenFromTracks = useCallback((gene) => {
        if (!gene) return false
        if (hiddenGeneIdSet.size > 0 && hiddenGeneIdSet.has(String(gene.id))) return true
        return isGeneHiddenByBiotype(gene)
    }, [hiddenGeneIdSet, isGeneHiddenByBiotype])

    const selectedGeneForVisibility = useMemo(() => {
        if (!selectedGene) return null
        if (selectedGene.biotype) return selectedGene
        return genes.find((gene) => gene?.id === selectedGene.id) || selectedGene
    }, [genes, selectedGene])

    const selectedGeneHiddenByBiotype = selectedGeneForVisibility
        ? isGeneHiddenByBiotype(selectedGeneForVisibility)
        : false

    const isSelectedHidden = selectedGene && (
        (selectedGene.strand === '+' && hiddenStrands.forward) ||
        (selectedGene.strand === '-' && hiddenStrands.reverse) ||
        selectedGeneHiddenByBiotype
    )

    const focusLocationRange = useMemo(() => getFocusLocationRange(selectedLocation), [selectedLocation])

    // A location only means anything on its own chromosome: switching region
    // leaves the focus in place but stops drawing it, the same way a hidden
    // strand stops drawing the gene of focus.
    const isLocationFocusVisible = Boolean(
        focusLocationRange && isSameChromToken(focusLocationRange.chrom, selectedChrom)
    )

    /* A panel focuses one thing at a time. Gene and location are separate states
     * because they carry different information and will be joined by other focus
     * kinds, so each new focus clears the others here rather than at every call
     * site that sets one. */
    const focusLocation = useCallback((location) => {
        const range = getFocusLocationRange(location)
        if (!range) {
            setSelectedLocation(null)
            return
        }
        setSelectedGene(null)
        setSelectedLocation(range)
    }, [])

    useEffect(() => {
        if (selectedGene) setSelectedLocation(null)
    }, [selectedGene])
    // ── Unified track tile cache (all signal tracks: BigWig, BAM coverage, etc.) ──────────────
    // Key: `${trackId}|${chrom}|${levelId}|${tileStart}`
    // Value: { start, end, bpPerBin, bins, has_data, error, min, max }
    const trackTileCacheRef = useRef(new Map())
    const trackTileFetchSetRef = useRef(new Set())

    // Per-track chromosome-wide scale: `${trackId}|${chrom}` -> {min, max}
    // Populated from L0 overview fetch on track activation — stable, no EMA drift
    const trackChromScaleRef = useRef({})

    // Discrete feature caches (VCF, BED-fine, splice junctions, long reads)
    // Key: `${trackId}|${chrom}|${lodLevel}|${tileStart}`
    const trackFeatureCacheRef = useRef(new Map())
    const trackFeatureFetchSetRef = useRef(new Set())
    const vcfTileCacheRef = useRef(new Map()) // key -> VCF summary/detail tile (non-adaptive)
    const vcfTileFetchSetRef = useRef(new Set())
    const vcfLevelStateRef = useRef({}) // trackId -> last selected LOD id (for hysteresis)
    const spliceLodStateRef = useRef({}) // trackId -> detail | mid | blocks
    const bigBedLodStateRef = useRef({}) // trackId -> detail | blocks
    const bigBedLayoutStateRef = useRef({}) // trackId -> stable buffered lane layout key/range
    const vcfBlockTileCacheRef = useRef(new Map()) // key -> VCF block tile (adaptive mode)
    const vcfBlockTileFetchSetRef = useRef(new Set())
    const vcfOverviewWarmupDoneRef = useRef(new Set())
    const vcfOverviewWarmupActiveRef = useRef(new Set())
    const [customTrackFetchRevision, setCustomTrackFetchRevision] = useState(0)

    // ── Helper: select best LOD level for current bp/px ──────────────────────────────────────
    const getBigWigLevel = useCallback((bpPerPx) => {
        for (const level of TRACK_LOD_LEVELS) {
            if (bpPerPx >= level.minBpPerPx) return level
        }
        return TRACK_LOD_LEVELS[TRACK_LOD_LEVELS.length - 1]
    }, [])

    const makeBigWigTileKey = useCallback((trackId, chrom, levelId, tileStart) => {
        return `${trackId}|${chrom}|${levelId}|${tileStart}`
    }, [])

    const getVcfLevelByBpPerPx = useCallback((bpPerPx, trackId, lodLevels = VCF_LOD_LEVELS) => {
        let idx = lodLevels.length - 1
        for (let i = 0; i < lodLevels.length; i++) {
            if (bpPerPx >= lodLevels[i].minBpPerPx) {
                idx = i
                break
            }
        }
        const raw = lodLevels[idx]
        if (!trackId) return raw

        const prevId = vcfLevelStateRef.current[trackId]
        if (!prevId) {
            vcfLevelStateRef.current[trackId] = raw.id
            return raw
        }
        const prevIdx = Math.max(0, lodLevels.findIndex((l) => l.id === prevId))
        if (Math.abs(prevIdx - idx) > 1) {
            vcfLevelStateRef.current[trackId] = raw.id
            return raw
        }
        if (prevIdx === idx) {
            return raw
        }

        // Hysteresis around adjacent level boundaries to reduce render flicker.
        const threshold = lodLevels[Math.max(prevIdx, idx)].minBpPerPx
        const lower = threshold * 0.85
        const upper = threshold * 1.15
        if (bpPerPx >= lower && bpPerPx <= upper) {
            return lodLevels[prevIdx]
        }

        vcfLevelStateRef.current[trackId] = raw.id
        return raw
    }, [])

    const makeVcfTileKey = useCallback((trackId, chrom, levelId, mode, tileStart, tileEnd, blockWindowBp = 0, blockStrideBp = 0, blockCoverageThreshold = 0.5, blockMode = '') => {
        return `${trackId}|${chrom}|${levelId}|${mode}|${tileStart}|${tileEnd}|w${blockWindowBp}|s${blockStrideBp}|c${blockCoverageThreshold}|bm${blockMode}`
    }, [])

    // ── Block-tile helpers (adaptive VCF mode) ────────────────────────────────────────────────

    const makeVcfBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `vcfblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeVcfAdpDetailKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `adpdet:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const getVcfBlockLevel = useCallback((bpPerPx) => selectVcfBlockLevel(bpPerPx), [])

    const makeSpliceTileKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `sj:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const makeSpliceBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `sjblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeBigBedBlockTileKey = useCallback((trackId, chrom, levelId, tileStart, tileEnd) => {
        return `bbblk:${trackId}|${chrom}|${levelId}|${tileStart}|${tileEnd}`
    }, [])

    const makeBigBedFeatureTileKey = useCallback((trackId, chrom, tileStart, tileEnd) => {
        return `bbft:${trackId}|${chrom}|${tileStart}|${tileEnd}`
    }, [])

    const getSpliceTileSpan = useCallback((bpPerPx) => {
        if (bpPerPx > SPLICE_FINE_BP_PER_PX) return SPLICE_TILE_SPAN_COARSE
        if (bpPerPx > 30) return 250_000
        return SPLICE_TILE_SPAN_FINE
    }, [])

    const getSpliceBlockLevel = useCallback((bpPerPx) => {
        for (let i = 0; i < SPLICE_BLOCK_LEVELS.length; i++) {
            if (bpPerPx >= SPLICE_BLOCK_LEVELS[i].minBpPerPx) return SPLICE_BLOCK_LEVELS[i]
        }
        return SPLICE_BLOCK_LEVELS[SPLICE_BLOCK_LEVELS.length - 1]
    }, [])

    const getBigBedBlockLevel = useCallback((bpPerPx) => {
        for (let i = 0; i < BIGBED_BLOCK_LEVELS.length; i++) {
            if (bpPerPx >= BIGBED_BLOCK_LEVELS[i].minBpPerPx) return BIGBED_BLOCK_LEVELS[i]
        }
        return BIGBED_BLOCK_LEVELS[BIGBED_BLOCK_LEVELS.length - 1]
    }, [])

    const bigBedDetailEntryBpPerPx = useMemo(
        () => TRANSCRIPT_DETAIL_VIEWSPAN_BP / Math.max(1, viewWidth - LHS_WIDTH),
        [viewWidth]
    )

    const getBigBedLodMode = useCallback((trackId, bpPerPx) => {
        const prev = bigBedLodStateRef.current[trackId]
        let next = bpPerPx <= bigBedDetailEntryBpPerPx ? 'detail' : 'blocks'
        if (prev === 'detail') {
            next = bpPerPx <= (bigBedDetailEntryBpPerPx * 1.2) ? 'detail' : 'blocks'
        } else if (prev === 'blocks') {
            next = bpPerPx < (bigBedDetailEntryBpPerPx * 0.9) ? 'detail' : 'blocks'
        }
        bigBedLodStateRef.current[trackId] = next
        return next
    }, [bigBedDetailEntryBpPerPx])

    const spliceArcEntryBpPerPx = useMemo(
        () => TRANSCRIPT_DETAIL_VIEWSPAN_BP / Math.max(1, viewWidth - LHS_WIDTH),
        [viewWidth]
    )

    const getSpliceLodMode = useCallback((trackId, bpPerPx, renderMode) => {
        if (renderMode === 'density') {
            spliceLodStateRef.current[trackId] = 'blocks'
            return 'blocks'
        }
        const prev = spliceLodStateRef.current[trackId]
        let next = 'mid'
        if (bpPerPx >= spliceArcEntryBpPerPx) next = 'blocks'
        else if (bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX) next = 'detail'
        if (prev === 'detail' && bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX * 1.2) next = 'detail'
        if (prev === 'blocks' && bpPerPx >= spliceArcEntryBpPerPx * 0.85) next = 'blocks'
        if (prev === 'mid') {
            if (bpPerPx <= SPLICE_TRANSCRIPT_BP_PER_PX * 0.85) next = 'detail'
            else if (bpPerPx >= spliceArcEntryBpPerPx * 1.15) next = 'blocks'
        }
        spliceLodStateRef.current[trackId] = next
        return next
    }, [spliceArcEntryBpPerPx])

    // Project cached block tiles into the current view, with coarse-level fallback.
    const projectVcfBlockTilesToView = useCallback((trackId, chrom, level, visStart, visEnd, outBins = 800) => {
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        const densityValues = Array(Math.max(1, outBins)).fill(0)
        const densityValueSums = Array(Math.max(1, outBins)).fill(0)
        const densityValueWeights = Array(Math.max(1, outBins)).fill(0)
        const densityGenicVotes = Array(Math.max(1, outBins)).fill(0.0)
        const densityIntergenicVotes = Array(Math.max(1, outBins)).fill(0.0)
        const densityPopulated = new Uint8Array(Math.max(1, outBins))
        let expectedTiles = 0
        let fetchedTiles = 0
        let coveredBp = 0

        const viewSpan = Math.max(1, visEnd - visStart)
        const densityBinBp = viewSpan / Math.max(1, densityValues.length)

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeVcfBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
            const tile = vcfBlockTileCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1

            const tileBlockSpans = Array.isArray(tile?.block_spans) ? tile.block_spans : []
            for (const spanItem of tileBlockSpans) {
                const s = Number(spanItem?.start)
                const e = Number(spanItem?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= visStart || s >= visEnd) continue
                const cs = Math.max(visStart, s)
                const ce = Math.min(visEnd, e)
                if (ce <= cs) continue
                coveredBp += (ce - cs)
                spans.push({ start: cs, end: ce, class_name: spanItem?.class_name || 'intergenic' })
            }

            const tileDensity = Array.isArray(tile?.density_bins) ? tile.density_bins : []
            const tileClasses = Array.isArray(tile?.density_classes) ? tile.density_classes : []
            const densityCount = Math.min(tileDensity.length, tileClasses.length)
            if (densityCount <= 0) continue
            const strideBp = Math.max(1, Number(tile?.density_stride_bp || level?.blockBp || 100))
            const tileBaseStart = Number.isFinite(Number(tile?.start)) ? Number(tile.start) : tileStart
            const tileBaseEnd = Number.isFinite(Number(tile?.end)) ? Number(tile.end) : tileEnd

            for (let i = 0; i < densityCount; i++) {
                const rawVal = Number(tileDensity[i])
                if (!Number.isFinite(rawVal)) continue
                const cls = tileClasses[i] === 'genic' ? 'genic' : 'intergenic'
                const segmentStart = tileBaseStart + i * strideBp
                const segmentEnd = Math.min(tileBaseEnd, segmentStart + strideBp)
                if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) continue
                if (segmentEnd <= visStart || segmentStart >= visEnd) continue

                const cs = Math.max(visStart, segmentStart)
                const ce = Math.min(visEnd, segmentEnd)
                if (ce <= cs) continue

                let x1 = Math.floor(((cs - visStart) / viewSpan) * densityValues.length)
                let x2 = Math.ceil(((ce - visStart) / viewSpan) * densityValues.length)
                x1 = Math.max(0, Math.min(densityValues.length - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(densityValues.length, x2))

                const normalized = Math.max(0, rawVal)
                for (let x = x1; x < x2; x++) {
                    const binStart = visStart + x * densityBinBp
                    const binEnd = binStart + densityBinBp
                    const ovBp = Math.max(0, Math.min(ce, binEnd) - Math.max(cs, binStart))
                    if (ovBp <= 0) continue
                    densityPopulated[x] = 1
                    densityValueSums[x] += normalized * ovBp
                    densityValueWeights[x] += ovBp
                    if (cls === 'genic') densityGenicVotes[x] += ovBp
                    else densityIntergenicVotes[x] += ovBp
                }
            }
        }

        for (let i = 0; i < densityValues.length; i++) {
            const w = Number(densityValueWeights[i] || 0)
            densityValues[i] = w > 0 ? (Number(densityValueSums[i] || 0) / w) : 0
        }
        const smoothingRadius = level?.id === 'L1' ? 2 : level?.id === 'L2' ? 1 : 0
        const smoothedDensityValues = smoothingRadius > 0
            ? smoothVcfDensityBins(densityValues, densityPopulated, smoothingRadius)
            : densityValues

        // Merge adjacent spans of the same class
        spans.sort((a, b) => a.start - b.start)
        const merged = []
        for (const s of spans) {
            const last = merged[merged.length - 1]
            if (last && s.start <= last.end && s.class_name === last.class_name) {
                last.end = Math.max(last.end, s.end)
            } else {
                merged.push({ ...s })
            }
        }

        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        const rawDensityClasses = smoothedDensityValues.map((_, i) =>
            densityGenicVotes[i] >= densityIntergenicVotes[i] ? 'genic' : 'intergenic'
        )
        const classSmoothingRadius = level?.id === 'L1' ? 2 : level?.id === 'L2' ? 1 : 0
        const densityClasses = classSmoothingRadius > 0
            ? smoothVcfDensityClasses(rawDensityClasses, densityPopulated, classSmoothingRadius)
            : rawDensityClasses
        const densityPopulatedCount = densityPopulated.reduce((acc, v) => acc + (v ? 1 : 0), 0)
        const densityCoverage = densityPopulatedCount / Math.max(1, smoothedDensityValues.length)
        const hasDensity = smoothedDensityValues.some((v) => Number(v) > 0)

        return {
            mode: 'block',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            density_bins: smoothedDensityValues,
            density_classes: densityClasses,
            density_populated: densityPopulated,
            density_stride_bp: Number(level?.blockBp || 100),
            has_data: merged.length > 0 || hasDensity,
            coverage: Math.max(0, Math.min(1, Math.max(coveredBp / viewSpan, densityCoverage))),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
        }
    }, [makeVcfBlockTileKey])

    const projectVcfBlockTilesCascadeToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins = 800) => {
        const targetIdx = Math.max(0, VCF_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id))
        const fine = projectVcfBlockTilesToView(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (Number(fine?.tile_coverage || 0) >= 0.92 || targetIdx <= 0) {
            return fine
        }

        let mergedBins = Array.isArray(fine?.density_bins) ? [...fine.density_bins] : Array(Math.max(1, outBins)).fill(0)
        let mergedClasses = Array.isArray(fine?.density_classes)
            ? [...fine.density_classes]
            : Array(mergedBins.length).fill('intergenic')
        let mergedPop = fine?.density_populated instanceof Uint8Array
            ? new Uint8Array(fine.density_populated)
            : new Uint8Array(mergedBins.length)
        let mergedCoverage = Number(fine?.coverage || 0)
        let coarseUsed = false

        for (let i = targetIdx - 1; i >= 0; i--) {
            const coarse = projectVcfBlockTilesToView(trackId, chrom, VCF_BLOCK_LEVELS[i], visStart, visEnd, outBins)
            if (!coarse?.has_data) continue
            const coarseBins = Array.isArray(coarse?.density_bins) ? coarse.density_bins : []
            const coarseClasses = Array.isArray(coarse?.density_classes) ? coarse.density_classes : []
            const coarsePop = coarse?.density_populated instanceof Uint8Array
                ? coarse.density_populated
                : new Uint8Array(mergedBins.length)
            const limit = Math.min(mergedBins.length, coarseBins.length, coarseClasses.length, coarsePop.length)
            if (limit <= 0) continue
            coarseUsed = true
            for (let x = 0; x < limit; x++) {
                if (mergedPop[x]) continue
                if (!coarsePop[x]) continue
                mergedPop[x] = 1
                mergedBins[x] = Number.isFinite(Number(coarseBins[x])) ? Number(coarseBins[x]) : 0
                mergedClasses[x] = coarseClasses[x] === 'genic' ? 'genic' : 'intergenic'
            }
            let popCount = 0
            for (let x = 0; x < mergedPop.length; x++) {
                if (mergedPop[x]) popCount += 1
            }
            mergedCoverage = Math.max(mergedCoverage, popCount / Math.max(1, mergedPop.length))
            if (mergedCoverage >= 0.95) break
        }

        if (!coarseUsed) return fine

        const hasDensity = mergedBins.some((v) => Number(v) > 0)
        return {
            ...fine,
            density_bins: mergedBins,
            density_classes: mergedClasses,
            density_populated: mergedPop,
            has_data: fine.has_data || hasDensity,
            coverage: Math.max(Number(fine?.coverage || 0), mergedCoverage),
            detail: Number(fine?.tile_coverage || 0) < 0.95 ? 'Loading higher-resolution density…' : '',
        }
    }, [projectVcfBlockTilesToView])

    // Project L4 detail tiles (individual variant positions) into the current view.
    const projectVcfAdaptiveDetailLevel = useCallback((trackId, chrom, level, visStart, visEnd) => {
        const tileSpan = level.tileSpanBp
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const variants = []
        let expectedTiles = 0
        let fetchedTiles = 0

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeVcfAdpDetailKey(trackId, chrom, tileStart, tileEnd)
            const tile = vcfBlockTileCacheRef.current.get(key)
            if (!tile) continue
            fetchedTiles += 1
            if (!Array.isArray(tile.variants)) continue
            for (const v of tile.variants) {
                const pos = Number(v?.pos)
                if (!Number.isFinite(pos)) continue
                if (pos > visEnd || (Number(v?.end) < visStart)) continue
                variants.push(v)
            }
        }

        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'adp_detail',
            level: level.id,
            start: visStart,
            end: visEnd,
            variants,
            has_data: variants.length > 0,
            tile_coverage: tileCoverage,
        }
    }, [makeVcfAdpDetailKey])

    const projectVcfSummaryLevel = useCallback((trackId, chrom, level, visStart, visEnd, outBins) => {
        const outCounts = Array(outBins).fill(0)
        const outOccupancy = Array(outBins).fill(0)
        const outDominant = Array(outBins).fill('other')
        const outTypeCounts = Array.from({ length: outBins }, () => ({ snv: 0, ins: 0, del: 0, other: 0 }))
        const populated = new Uint8Array(outBins)

        const visSpan = Math.max(1, visEnd - visStart)
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        let anyTile = false
        let truncated = false

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            const key = makeVcfTileKey(
                trackId,
                chrom,
                level.id,
                level.mode,
                tileStart,
                tileEnd,
                level.blockWindowBp || 0,
                level.blockStrideBp || 0,
                level.blockCoverageThreshold ?? 0.5,
                level.blockMode || '',
            )
            const tile = vcfTileCacheRef.current.get(key)
            if (!tile || tile.mode !== 'summary' || !Array.isArray(tile.bins) || tile.bins.length === 0) continue
            anyTile = true
            truncated = truncated || !!tile.truncated
            const sourceBins = tile.bins.length
            const sourceBpPerBin = Math.max(1, (tile.end - tile.start) / Math.max(1, sourceBins))

            for (let i = 0; i < sourceBins; i++) {
                const count = Number(tile.bins[i]) || 0
                const occupied = Number(tile.occupancy?.[i] || 0) > 0 || count > 0
                const srcStart = tile.start + i * sourceBpPerBin
                const srcEnd = srcStart + sourceBpPerBin
                if (srcEnd < visStart || srcStart > visEnd) continue

                let x1 = Math.floor(((srcStart - visStart) / visSpan) * outBins)
                let x2 = Math.ceil(((srcEnd - visStart) / visSpan) * outBins)
                x1 = Math.max(0, Math.min(outBins - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(outBins, x2))

                for (let x = x1; x < x2; x++) {
                    populated[x] = 1
                    if (count >= outCounts[x]) {
                        outCounts[x] = count
                        outDominant[x] = tile.dominant_effect_bins?.[i] || 'other'
                    }
                    if (occupied) outOccupancy[x] = 1

                    const t = tile.type_counts_bins?.[i]
                    if (t) {
                        outTypeCounts[x].snv = Math.max(outTypeCounts[x].snv, Number(t.snv) || 0)
                        outTypeCounts[x].ins = Math.max(outTypeCounts[x].ins, Number(t.ins) || 0)
                        outTypeCounts[x].del = Math.max(outTypeCounts[x].del, Number(t.del) || 0)
                        outTypeCounts[x].other = Math.max(outTypeCounts[x].other, Number(t.other) || 0)
                    }
                }
            }
        }

        let popCount = 0
        for (let i = 0; i < outBins; i++) {
            if (populated[i]) popCount++
        }
        const maxCount = outCounts.length ? Math.max(...outCounts) : 0
        return {
            mode: 'summary',
            level: level.id,
            bins: outCounts,
            occupancy: outOccupancy,
            dominant_effect_bins: outDominant,
            type_counts_bins: outTypeCounts,
            max_count: maxCount,
            has_data: anyTile && maxCount > 0,
            coverage: popCount / Math.max(1, outBins),
            truncated,
        }
    }, [makeVcfTileKey])

    const projectVcfBlockSpansToView = useCallback((trackId, chrom, level, visStart, visEnd) => {
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const spans = []
        let coveredBp = 0
        let truncated = false
        let expectedTiles = 0
        let fetchedTiles = 0

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            expectedTiles += 1
            const key = makeVcfTileKey(
                trackId,
                chrom,
                level.id,
                level.mode,
                tileStart,
                tileEnd,
                level.blockWindowBp || 0,
                level.blockStrideBp || 0,
                level.blockCoverageThreshold ?? 0.5,
                level.blockMode || '',
            )
            const tile = vcfTileCacheRef.current.get(key)
            if (!tile || tile.mode !== 'summary') continue
            fetchedTiles += 1
            truncated = truncated || !!tile.truncated
            if (!Array.isArray(tile.block_spans)) continue
            for (const spanItem of tile.block_spans) {
                const s = Number(spanItem?.start)
                const e = Number(spanItem?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= visStart || s >= visEnd) continue
                const cs = Math.max(visStart, s)
                const ce = Math.min(visEnd, e)
                if (ce <= cs) continue
                coveredBp += (ce - cs)
                spans.push({
                    start: cs,
                    end: ce,
                    class_name: spanItem?.class_name === 'transcript' ? 'transcript' : 'intergenic',
                    coverage_fraction: Number(spanItem?.coverage_fraction) || 0,
                })
            }
        }

        spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const merged = []
        for (const s of spans) {
            const last = merged[merged.length - 1]
            if (!last) {
                merged.push({ ...s })
                continue
            }
            if (s.start <= last.end && s.class_name === last.class_name) {
                const prevLen = Math.max(1, last.end - last.start)
                const curLen = Math.max(1, s.end - s.start)
                last.end = Math.max(last.end, s.end)
                last.coverage_fraction = ((last.coverage_fraction * prevLen) + (s.coverage_fraction * curLen)) / (prevLen + curLen)
            } else {
                merged.push({ ...s })
            }
        }
        const viewSpan = Math.max(1, visEnd - visStart)
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'summary',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            has_data: merged.length > 0,
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            truncated,
            detail: merged.length === 0 ? 'Loading block spans…' : '',
            block_window_bp: level.blockWindowBp || 0,
            block_stride_bp: level.blockStrideBp || 0,
            block_coverage_threshold: level.blockCoverageThreshold ?? 0.5,
        }
    }, [makeVcfTileKey])

    const projectVcfDetailLevel = useCallback((trackId, chrom, level, visStart, visEnd) => {
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        const variants = []
        const seen = new Set()
        let anyTile = false
        let truncated = false

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const tileEnd = tileStart + tileSpan
            const key = makeVcfTileKey(
                trackId,
                chrom,
                level.id,
                level.mode,
                tileStart,
                tileEnd,
                level.blockWindowBp || 0,
                level.blockStrideBp || 0,
                level.blockCoverageThreshold ?? 0.5,
                level.blockMode || '',
            )
            const tile = vcfTileCacheRef.current.get(key)
            if (!tile || tile.mode !== 'detail' || !Array.isArray(tile.variants)) continue
            anyTile = true
            truncated = truncated || !!tile.truncated
            for (const v of tile.variants) {
                const pos = Number(v.pos)
                if (!Number.isFinite(pos) || pos < visStart || pos > visEnd) continue
                const uniq = `${pos}|${v.ref || ''}|${v.alt || ''}|${v.id || ''}|${v.type || ''}`
                if (seen.has(uniq)) continue
                seen.add(uniq)
                variants.push(v)
            }
        }
        variants.sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0))
        return {
            mode: 'detail',
            level: level.id,
            variants,
            has_data: anyTile && variants.length > 0,
            coverage: anyTile ? 1 : 0,
            truncated,
        }
    }, [makeVcfTileKey])

    const projectVcfTilesToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins) => {
        const targetIdx = Math.max(0, VCF_LOD_LEVELS.findIndex((l) => l.id === targetLevel.id))
        if (targetLevel.mode === 'detail') {
            const detail = projectVcfDetailLevel(trackId, chrom, targetLevel, visStart, visEnd)
            let summary = null
            for (let i = targetIdx - 1; i >= 0; i--) {
                const candidate = projectVcfSummaryLevel(trackId, chrom, VCF_LOD_LEVELS[i], visStart, visEnd, outBins)
                if (candidate.coverage > 0) {
                    summary = candidate
                    if (candidate.coverage >= 0.85) break
                }
            }
            const showSummaryBackdrop = detail.coverage < 0.95
            return {
                ...detail,
                start: visStart,
                end: visEnd,
                bins: showSummaryBackdrop ? (summary?.bins || []) : [],
                occupancy: showSummaryBackdrop ? (summary?.occupancy || []) : [],
                dominant_effect_bins: showSummaryBackdrop ? (summary?.dominant_effect_bins || []) : [],
                type_counts_bins: showSummaryBackdrop ? (summary?.type_counts_bins || []) : [],
                max_count: showSummaryBackdrop ? (summary?.max_count || 0) : 0,
                coverage: detail.coverage > 0 ? detail.coverage : (summary ? summary.coverage : 0),
                detail_coverage: detail.coverage,
                has_data: detail.has_data || !!summary?.has_data,
                detail: detail.coverage < 0.95
                    ? ((summary && summary.coverage < 0.75) ? 'Loading VCF summary tiles…' : 'Loading VCF detail tiles…')
                    : '',
                truncated: detail.truncated || !!summary?.truncated,
            }
        }

        let best = projectVcfSummaryLevel(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (best.coverage >= 0.9) {
            return { ...best, start: visStart, end: visEnd, detail: '' }
        }
        for (let i = targetIdx - 1; i >= 0; i--) {
            const coarse = projectVcfSummaryLevel(trackId, chrom, VCF_LOD_LEVELS[i], visStart, visEnd, outBins)
            if (!coarse.has_data) continue
            const mergedBins = best.bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.bins[idx]))
            const mergedOcc = best.occupancy.map((v, idx) => (v ? 1 : (coarse.occupancy[idx] ? 1 : 0)))
            const mergedDom = best.dominant_effect_bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.dominant_effect_bins[idx]))
            const mergedType = best.type_counts_bins.map((v, idx) => (best.occupancy[idx] ? v : coarse.type_counts_bins[idx]))
            const mergedMax = mergedBins.length ? Math.max(...mergedBins) : 0
            const mergedCoverage = mergedOcc.reduce((acc, v) => acc + (v ? 1 : 0), 0) / Math.max(1, outBins)
            best = {
                ...best,
                bins: mergedBins,
                occupancy: mergedOcc,
                dominant_effect_bins: mergedDom,
                type_counts_bins: mergedType,
                max_count: mergedMax,
                has_data: mergedMax > 0,
                coverage: mergedCoverage,
                truncated: best.truncated || coarse.truncated,
            }
            if (best.coverage >= 0.9) break
        }
        return {
            ...best,
            start: visStart,
            end: visEnd,
            detail: best.coverage < 0.75 ? 'Loading higher resolution VCF tiles…' : '',
        }
    }, [projectVcfBlockSpansToView, projectVcfDetailLevel, projectVcfSummaryLevel])

    // ── Project tiles at a single level → screen bins ────────────────────────────────────────
    const projectLevelToView = useCallback((trackId, chrom, level, visStart, visEnd, outBins) => {
        const empty = { bins: Array(outBins).fill(null), populated: new Uint8Array(outBins), has_data: false, min: null, max: null, coverage: 0, error: '' }
        if (visEnd <= visStart || outBins <= 0) return empty

        const visSpan = visEnd - visStart
        const out = Array(outBins).fill(null)
        // Track which screen bins were actually mapped from a cached tile (even if value is 0)
        const populated = new Uint8Array(outBins)
        const tileSpan = level.bpPerBin * level.binsPerTile
        const firstTile = Math.floor(visStart / tileSpan) * tileSpan
        const lastTile = Math.floor((visEnd - 1) / tileSpan) * tileSpan
        let anySourceData = false
        let bestError = ''

        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
            const key = makeBigWigTileKey(trackId, chrom, level.id, tileStart)
            const tile = trackTileCacheRef.current.get(key)
            if (!tile) continue
            if (tile.error) bestError = tile.error

            const bins = tile.bins || []
            for (let i = 0; i < bins.length; i++) {
                const gStart = tile.start + i * level.bpPerBin
                const gEnd = gStart + level.bpPerBin
                if (gEnd < visStart || gStart > visEnd) continue

                let x1 = Math.floor(((gStart - visStart) / visSpan) * outBins)
                let x2 = Math.ceil(((gEnd - visStart) / visSpan) * outBins)
                x1 = Math.max(0, Math.min(outBins - 1, x1))
                x2 = Math.max(x1 + 1, Math.min(outBins, x2))
                for (let x = x1; x < x2; x++) {
                    populated[x] = 1
                }

                const v = bins[i]
                if (typeof v !== 'number' || !Number.isFinite(v)) continue
                anySourceData = true
                for (let x = x1; x < x2; x++) {
                    out[x] = out[x] === null ? v : Math.max(out[x], v)
                }
            }
        }

        // Coverage = fraction of screen bins that mapped to actual tile data
        let populatedCount = 0
        for (let i = 0; i < outBins; i++) if (populated[i]) populatedCount++
        const observed = out.filter(v => typeof v === 'number')
        return {
            bins: out,
            populated,
            has_data: anySourceData,
            min: observed.length ? Math.min(...observed) : null,
            max: observed.length ? Math.max(...observed) : null,
            coverage: populatedCount / Math.max(1, outBins),
            error: bestError,
        }
    }, [makeBigWigTileKey])

    // ── Coarse-to-fine projection: draw best available cached level ───────────────────────────
    // Always renders something — never shows blank while waiting for finer tiles
    const projectBigWigTilesToView = useCallback((trackId, chrom, targetLevel, visStart, visEnd, outBins) => {
        const empty = { bins: Array(outBins).fill(null), has_data: false, min: null, max: null, coverage: 0, detail: '', error: '' }

        // Try from target level upward (finer → coarser) for best coverage
        const targetIdx = TRACK_LOD_LEVELS.indexOf(targetLevel)

        // First pass: try target level
        const fine = projectLevelToView(trackId, chrom, targetLevel, visStart, visEnd, outBins)
        if (fine.coverage >= 0.9) {
            // Nearly full coverage from target level — use it, apply stable chrom scale
            const scaleKey = `${trackId}|${chrom}`
            const chromScale = trackChromScaleRef.current[scaleKey]
            const safeMin = chromScale?.min ?? fine.min ?? 0
            const safeMax = chromScale?.max ?? fine.max ?? (safeMin + 1e-6)
            return { ...fine, min: safeMin, max: safeMax, detail: '', coverage: fine.coverage }
        }

        // Fallback: overlay only the immediately coarser level under fine data.
        // Allowing detailed views to fall back all the way to L0/L1 can create
        // long flat phantom blocks from stale overview tiles as screen-bin
        // alignment shifts during pan/zoom.
        let bestResult = fine
        const fallbackLevels = targetIdx > 0
            ? [TRACK_LOD_LEVELS[targetIdx - 1]]
            : []
        for (const coarseLevel of fallbackLevels) {
            const coarse = projectLevelToView(trackId, chrom, coarseLevel, visStart, visEnd, outBins)
            if (!coarse.has_data) continue
            // Merge: use fine where it actually has tile coverage (populated), else coarse
            const merged = fine.bins.map((v, idx) =>
                fine.populated[idx] ? v : coarse.bins[idx]
            )
            const mergedPopulated = new Uint8Array(outBins)
            let mergedPopCount = 0
            for (let idx = 0; idx < outBins; idx++) {
                mergedPopulated[idx] = fine.populated[idx] || coarse.populated[idx] ? 1 : 0
                if (mergedPopulated[idx]) mergedPopCount++
            }
            const mergedObserved = merged.filter(v => typeof v === 'number')
            bestResult = {
                bins: merged,
                populated: mergedPopulated,
                has_data: mergedObserved.length > 0,
                min: mergedObserved.length ? Math.min(...mergedObserved) : null,
                max: mergedObserved.length ? Math.max(...mergedObserved) : null,
                coverage: mergedPopCount / Math.max(1, outBins),
                detail: fine.coverage < 0.5 ? '↓ Loading higher resolution…' : '',
                error: fine.error || coarse.error,
            }
        }

        // Apply stable chromosome-wide scale
        const scaleKey = `${trackId}|${chrom}`
        const chromScale = trackChromScaleRef.current[scaleKey]
        if (chromScale) {
            bestResult = { ...bestResult, min: chromScale.min, max: chromScale.max }
        }
        return bestResult
    }, [projectLevelToView])

    const projectBigWigTrackToCurrentViewport = useCallback((trackId) => {
        const currentChrom = String(selectedChromRef.current || '').trim()
        if (!trackId || !currentChrom) {
            return { bins: [], has_data: false, min: null, max: null, coverage: 0, detail: '', error: '' }
        }
        const currentRange = genomicViewRangeRef.current || {}
        const curStart = Math.max(0, Math.floor(Number(currentRange.start) || 0))
        const curEnd = Math.max(curStart + 1, Math.ceil(Number(currentRange.end) || (curStart + 1)))
        const currentWidth = Math.max(1, Number(viewWidthRef.current) || 1)
        const curBpPerPx = (curEnd - curStart) / Math.max(1, currentWidth - LHS_WIDTH)
        const curLevel = getBigWigLevel(curBpPerPx)
        const curBins = Math.max(80, Math.min(1400, Math.floor(currentWidth - LHS_WIDTH - 44)))
        return projectBigWigTilesToView(trackId, currentChrom, curLevel, curStart, curEnd, curBins)
    }, [getBigWigLevel, projectBigWigTilesToView])

    const projectSpliceTilesToView = useCallback((trackId, chrom, visStart, visEnd) => {
        const prefix = `sj:${trackId}|${chrom}|`
        const dedup = new Map() // `${start}|${end}|${strand}` -> junction
        const coverageSpans = []
        let bestError = ''

        for (const [key, tile] of trackFeatureCacheRef.current.entries()) {
            if (!key.startsWith(prefix)) continue
            const tStart = Number(tile?.start)
            const tEnd = Number(tile?.end)
            if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) continue
            if (tEnd <= visStart || tStart >= visEnd) continue
            coverageSpans.push([Math.max(visStart, tStart), Math.min(visEnd, tEnd)])
            if (tile?.error && !bestError) bestError = String(tile.error)

            const rows = Array.isArray(tile?.junctions) ? tile.junctions : []
            for (const raw of rows) {
                const s = Number(raw?.start)
                const e = Number(raw?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e < visStart || s > visEnd) continue
                const strand = String(raw?.strand || '.')
                const keyId = `${s}|${e}|${strand}`
                const count = Number(raw?.n_total ?? raw?.reads ?? 0)
                const normalized = Number.isFinite(count) ? count : 0
                const prev = dedup.get(keyId)
                if (!prev || normalized > Number(prev?.n_total ?? prev?.reads ?? 0)) {
                    dedup.set(keyId, {
                        ...raw,
                        start: s,
                        end: e,
                        strand,
                        n_total: normalized,
                        reads: normalized,
                        canonical: raw?.canonical === true,
                        key: keyId,
                    })
                }
            }
        }

        coverageSpans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
        let coveredBp = 0
        if (coverageSpans.length > 0) {
            let [curS, curE] = coverageSpans[0]
            for (let i = 1; i < coverageSpans.length; i++) {
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
        const viewSpan = Math.max(1, visEnd - visStart)
        const coverage = Math.max(0, Math.min(1, coveredBp / viewSpan))
        const sortedByCoord = Array.from(dedup.values()).sort((a, b) => {
            const as = Number(a?.start) || 0
            const bs = Number(b?.start) || 0
            if (as !== bs) return as - bs
            const ae = Number(a?.end) || 0
            const be = Number(b?.end) || 0
            if (ae !== be) return ae - be
            const ac = Number(a?.n_total ?? a?.reads ?? 0)
            const bc = Number(b?.n_total ?? b?.reads ?? 0)
            if (ac !== bc) return bc - ac
            return String(a?.strand || '.').localeCompare(String(b?.strand || '.'))
        })
        const laneEnds = []
        const laneByKey = new Map()
        for (const j of sortedByCoord) {
            const s = Number(j?.start) || 0
            const e = Number(j?.end) || 0
            let lane = 0
            while (lane < laneEnds.length && s <= laneEnds[lane]) lane += 1
            if (lane >= laneEnds.length) laneEnds.push(e)
            else laneEnds[lane] = e
            laneByKey.set(j.key || spliceJunctionKey(j), lane)
        }
        const laneCount = Math.max(1, laneEnds.length)
        const recommendedHeight = clamp(
            SPLICE_HEIGHT_BASE + laneCount * SPLICE_HEIGHT_STEP,
            SPLICE_HEIGHT_MIN,
            SPLICE_HEIGHT_MAX
        )
        const maxVisibleLanes = Math.max(1, Math.floor((recommendedHeight - SPLICE_HEIGHT_BASE) / SPLICE_HEIGHT_STEP))
        const junctions = sortedByCoord.map((j) => {
            const key = j.key || spliceJunctionKey(j)
            return { ...j, key, lane: laneByKey.get(key) || 0 }
        })
        const overflowCount = junctions.reduce((acc, j) => acc + (Number(j?.lane || 0) >= maxVisibleLanes ? 1 : 0), 0)

        return {
            mode: 'splice_arcs',
            start: visStart,
            end: visEnd,
            junctions,
            has_data: junctions.length > 0,
            coverage,
            error: bestError,
            layout: {
                lane_count: laneCount,
                max_visible_lanes: maxVisibleLanes,
                overflow_count: overflowCount,
                recommended_height: recommendedHeight,
            },
        }
    }, [])

    const projectSpliceBlockTilesToView = useCallback((trackId, chrom, level, visStart, visEnd, innerWidthPx) => {
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
            const key = makeSpliceBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
            const tile = trackFeatureCacheRef.current.get(key)
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
                    max_support: Math.max(0, Number(row?.max_support || 0)),
                })
            }
        }

        spans.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const merged = []
        const viewSpan = Math.max(1, visEnd - visStart)
        const gapBp = SPLICE_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx))
        for (const span of spans) {
            const last = merged[merged.length - 1]
            if (last && span.start <= (last.end + gapBp)) {
                last.end = Math.max(last.end, span.end)
                last.max_support = Math.max(last.max_support, span.max_support)
            } else {
                merged.push({ ...span })
            }
        }

        let coveredBp = 0
        for (const span of merged) coveredBp += Math.max(0, span.end - span.start)
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'splice_blocks',
            level: level.id,
            start: visStart,
            end: visEnd,
            block_spans: merged,
            has_data: merged.length > 0,
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            error: bestError,
        }
    }, [makeSpliceBlockTileKey])

    const projectBigBedBlockTilesToView = useCallback((trackId, chrom, level, visStart, visEnd, innerWidthPx) => {
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
            const key = makeBigBedBlockTileKey(trackId, chrom, level.id, tileStart, tileEnd)
            const tile = trackFeatureCacheRef.current.get(key)
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
        const gapBp = BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx))
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
    }, [makeBigBedBlockTileKey])

    const projectBigBedFeatureTilesToView = useCallback((trackId, chrom, visStart, visEnd, innerWidthPx) => {
        const tileSpan = BIGBED_FEATURE_TILE_SPAN
        const viewSpan = Math.max(1, visEnd - visStart)
        const layoutBuffer = clamp(viewSpan * 0.5, 80_000, 500_000)
        const bucketStep = Math.max(25_000, Math.floor(viewSpan * 0.25))
        const center = (visStart + visEnd) / 2
        const centerBucket = Math.floor(center / bucketStep)
        const spanBucket = Math.max(1, Math.round(Math.log2(Math.max(1, viewSpan)) * 8))
        const priorLayout = bigBedLayoutStateRef.current[trackId]
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
            bigBedLayoutStateRef.current[trackId] = {
                chrom,
                centerBucket,
                spanBucket,
                layoutStart,
                layoutEnd,
            }
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
            const key = makeBigBedFeatureTileKey(trackId, chrom, tileStart, tileEnd)
            const tile = trackFeatureCacheRef.current.get(key)
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
                const normalizedRow = row?._render_kind ? row : normalizeBigBedFeatureForRender(row)
                if (!normalizedRow) continue
                const s = Number(normalizedRow?.start)
                const e = Number(normalizedRow?.end)
                if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                if (e <= layoutStart || s >= layoutEnd) continue
                const keyId = bigBedFeatureKey(normalizedRow)
                if (dedup.has(keyId)) continue
                dedup.set(keyId, {
                    ...normalizedRow,
                    start: s,
                    end: e,
                    _key: keyId,
                })
            }
        }

        const features = Array.from(dedup.values()).sort((a, b) => {
            if (a.start !== b.start) return a.start - b.start
            if (a.end !== b.end) return a.end - b.end
            const aName = String(a?.name || '')
            const bName = String(b?.name || '')
            if (aName !== bName) return aName.localeCompare(bName)
            return String(a?._key || '').localeCompare(String(b?._key || ''))
        })
        const visibleSource = features.filter((feature) => feature.end > visStart && feature.start < visEnd)
        const transcriptFeatureCount = features.reduce((acc, feature) => {
            const isTranscript = feature?._render_kind === 'transcript'
                && feature?._structure_valid === true
                && Array.isArray(feature?._exon_blocks)
                && feature._exon_blocks.length > 0
            return acc + (isTranscript ? 1 : 0)
        }, 0)
        const shouldDenseFallback = (
            visibleSource.length > BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD
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
            const gapBp = BIGBED_BLOCK_MERGE_GAP_PX * (viewSpan / Math.max(1, innerWidthPx || 1))
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

        const laneEnds = []
        const visibleFeatures = []
        for (const feature of features) {
            let lane = 0
            while (lane < laneEnds.length && feature.start <= laneEnds[lane]) lane += 1
            if (lane >= laneEnds.length) laneEnds.push(feature.end)
            else laneEnds[lane] = feature.end
            feature._lane = lane
            if (feature.end > visStart && feature.start < visEnd) visibleFeatures.push(feature)
        }

        coverageSpans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
        let coveredBp = 0
        if (coverageSpans.length > 0) {
            let [curS, curE] = coverageSpans[0]
            for (let i = 1; i < coverageSpans.length; i++) {
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
        const tileCoverage = expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 0
        return {
            mode: 'bigbed_detail',
            start: visStart,
            end: visEnd,
            features: visibleFeatures,
            has_data: visibleFeatures.length > 0,
            lane_count: Math.max(1, laneEnds.length),
            coverage: Math.max(0, Math.min(1, coveredBp / viewSpan)),
            tile_coverage: Math.max(0, Math.min(1, tileCoverage)),
            error: bestError,
        }
    }, [makeBigBedFeatureTileKey])

    // ── LRU eviction — keep ≤2000 tiles per track in memory ──────────────────────────────────
    const evictOldTilesIfNeeded = useCallback(() => {
        const MAX_TILES = 2000
        const cache = trackTileCacheRef.current
        if (cache.size > MAX_TILES * 1.3) {
            // Delete oldest 30% (Maps maintain insertion order)
            const toDelete = Math.floor(cache.size - MAX_TILES)
            let removed = 0
            for (const key of cache.keys()) {
                if (removed >= toDelete) break
                cache.delete(key)
                removed++
            }
        }

        const MAX_VCF_TILES = 2800
        const vcfCache = vcfTileCacheRef.current
        if (vcfCache.size > MAX_VCF_TILES * 1.25) {
            const toDelete = Math.floor(vcfCache.size - MAX_VCF_TILES)
            let removed = 0
            for (const key of vcfCache.keys()) {
                if (removed >= toDelete) break
                vcfCache.delete(key)
                removed++
            }
        }

        const MAX_FEATURE_TILES = 3000
        const featureCache = trackFeatureCacheRef.current
        if (featureCache.size > MAX_FEATURE_TILES * 1.25) {
            const toDelete = Math.floor(featureCache.size - MAX_FEATURE_TILES)
            let removed = 0
            for (const key of featureCache.keys()) {
                if (removed >= toDelete) break
                featureCache.delete(key)
                removed++
            }
        }

        const MAX_VCF_BLOCK_TILES = 2400
        const vcfBlockCache = vcfBlockTileCacheRef.current
        if (vcfBlockCache.size > MAX_VCF_BLOCK_TILES * 1.25) {
            const toDelete = Math.floor(vcfBlockCache.size - MAX_VCF_BLOCK_TILES)
            let removed = 0
            for (const key of vcfBlockCache.keys()) {
                if (removed >= toDelete) break
                vcfBlockCache.delete(key)
                removed++
            }
        }
    }, [])

    // ── Clean up caches when tracks are removed ───────────────────────────────────────────────
    useEffect(() => {
        const keepIds = new Set(customTracks.map((track) => track.id))
        const visibleIds = new Set(customTracks.filter((track) => track.visible !== false).map((track) => track.id))

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            const withoutPrefix = key
                .replace(/^sjblk:/, '')
                .replace(/^sj:/, '')
                .replace(/^bbblk:/, '')
                .replace(/^bbft:/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            // keys are "vcfblk:${trackId}|..." or "adpdet:${trackId}|..."
            const withoutPrefix = key.replace(/^(vcfblk|adpdet):/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) delete trackChromScaleRef.current[key]
        }
        for (const key of Object.keys(vcfLevelStateRef.current)) {
            if (!keepIds.has(key)) delete vcfLevelStateRef.current[key]
        }
        for (const key of Object.keys(spliceLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete spliceLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLayoutStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLayoutStateRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
    }, [customTracks])

    useEffect(() => {
        bigBedLayoutStateRef.current = {}
    }, [selectedChrom])


    const formatSignalValue = useCallback((value) => {
        return formatSignalValueForTrack(value)
    }, [])

    const formatSignalValueExact = useCallback((value) => {
        return formatSignalValueForTooltip(value)
    }, [])

    useEffect(() => {
        transcriptCacheRef.current = transcriptCache
    }, [transcriptCache])

    const touchTranscriptCacheEntry = useCallback((geneId) => {
        const key = String(geneId || '').trim()
        if (!key) return
        transcriptCacheTouchCounterRef.current += 1
        transcriptCacheUsageRef.current.set(key, transcriptCacheTouchCounterRef.current)
    }, [])

    const pruneTranscriptCacheIfNeeded = useCallback((nextCache) => {
        const keys = Object.keys(nextCache || {})
        if (keys.length <= MAX_TRANSCRIPT_CACHE_GENES) return nextCache

        const protectedIds = protectedTranscriptCacheIdsRef.current || new Set()
        const evictionCandidates = keys
            .filter((key) => !protectedIds.has(key))
            .sort((a, b) => {
                const aTouch = Number(transcriptCacheUsageRef.current.get(a) || 0)
                const bTouch = Number(transcriptCacheUsageRef.current.get(b) || 0)
                return aTouch - bTouch
            })

        const overflow = Math.max(0, keys.length - MAX_TRANSCRIPT_CACHE_GENES)
        if (overflow <= 0 || evictionCandidates.length === 0) return nextCache

        const pruned = { ...nextCache }
        for (const geneId of evictionCandidates.slice(0, overflow)) {
            delete pruned[geneId]
            transcriptCacheUsageRef.current.delete(geneId)
        }
        return pruned
    }, [])

    useEffect(() => {
        transcriptRequestGenerationRef.current += 1
        transcriptCacheRef.current = {}
        transcriptCacheUsageRef.current.clear()
        fetchingTranscriptIdsRef.current.clear()
        setTranscriptCache({})
    }, [genome, dataEpoch, selectedChrom])

    useEffect(() => {
        return () => {
            if (transcriptPopupDismissTimerRef.current) {
                clearTimeout(transcriptPopupDismissTimerRef.current)
                transcriptPopupDismissTimerRef.current = null
            }
        }
    }, [])

    // ============ Tile Cache Helpers ============

    const preloadChromGenes = useCallback((chrom) => {
        const chromName = String(chrom || '').trim()
        if (!isActive || !chromName) return null
        if (geneTilesBlockedRef.current) return null

        const cacheKey = getChromGeneCacheKey(genome, chromName)
        const cached = chromGeneCacheRef.current.get(cacheKey)
        if (Array.isArray(cached)) return cached
        if (fetchingChromGenesRef.current.has(cacheKey)) return null

        const generation = chromGeneGenerationRef.current
        const requestGeneration = activeGeneRequestGenerationRef.current
        const requestToken = Symbol(cacheKey)
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingChromGenesRef.current.set(cacheKey, requestToken)
        const params = new URLSearchParams({
            genome,
            chrom: chromName,
        })

        fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, { signal: controller.signal })
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!Array.isArray(data)) return
                if (generation !== chromGeneGenerationRef.current) return
                if (requestGeneration !== activeGeneRequestGenerationRef.current) return
                buildGeneIntervalIndex(data)
                chromGeneCacheRef.current.set(cacheKey, data)
                const tilePrefix = `${chromName}:`
                for (const tileKey of tileCacheRef.current.keys()) {
                    if (tileKey.startsWith(tilePrefix)) tileCacheRef.current.delete(tileKey)
                }
                if (getChromGeneCacheKey(genome, selectedChromRef.current) !== cacheKey) return
                const range = genomicViewRangeRef.current || {}
                const visible = collectGenesFromList(data, range.start, range.end)
                setGenes((prev) => sameGeneRange(prev, visible) ? prev : visible)
                setHasInitialViewportData(true)
            })
            .catch((e) => {
                if (e?.name !== 'AbortError') {
                    console.warn(`[GenomeBrowser:${genome}] Failed to preload genes for ${chromName}`, e)
                }
            })
            .finally(() => {
                identityRequestControllersRef.current.delete(controller)
                if (fetchingChromGenesRef.current.get(cacheKey) === requestToken) {
                    fetchingChromGenesRef.current.delete(cacheKey)
                }
            })

        return null
    }, [genome, isActive])

    // Collect genes from cache over a genomic range, with optional tile padding.
    const collectCachedGenesInRange = useCallback((chrom, start, end, tilePad = 1) => {
        if (!chrom) {
            return { genes: [], coverage: 0, expectedTiles: 0, fetchedTiles: 0 }
        }
        const chromGenes = chromGeneCacheRef.current.get(getChromGeneCacheKey(genome, chrom))
        if (Array.isArray(chromGenes)) {
            return {
                genes: collectGenesFromList(chromGenes, start, end),
                coverage: 1,
                expectedTiles: 1,
                fetchedTiles: 1,
                source: 'chrom',
            }
        }

        const cache = tileCacheRef.current
        const rangeStart = Math.max(0, Math.floor(start))
        const rangeEnd = Math.max(rangeStart + 1, Math.ceil(end))
        const coreFirstTile = snapToTile(rangeStart)
        const coreLastTile = snapToTile(Math.max(rangeStart, rangeEnd - 1))
        let expectedTiles = 0
        let fetchedTiles = 0
        for (let t = coreFirstTile; t <= coreLastTile; t += TILE_SIZE) {
            expectedTiles += 1
            if (cache.has(getTileKey(chrom, t))) fetchedTiles += 1
        }

        const firstTile = snapToTile(Math.max(0, rangeStart - tilePad * TILE_SIZE))
        const lastTile = snapToTile(rangeEnd + tilePad * TILE_SIZE)
        const collected = []
        const seen = new Set()
        for (let t = firstTile; t <= lastTile; t += TILE_SIZE) {
            const key = getTileKey(chrom, t)
            const tileGenes = cache.get(key)
            if (!tileGenes) continue
            for (const g of tileGenes) {
                if (!seen.has(g.id) && g.end >= rangeStart && g.start <= rangeEnd) {
                    seen.add(g.id)
                    collected.push(g)
                }
            }
        }

        return {
            genes: collected,
            coverage: expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 1,
            expectedTiles,
            fetchedTiles,
            source: 'tiles',
        }
    }, [genome])

    const evictOldGeneTilesIfNeeded = useCallback(() => {
        const cache = tileCacheRef.current
        if (cache.size <= MAX_GENE_TILE_CACHE_TILES) return
        const overflow = cache.size - MAX_GENE_TILE_CACHE_TILES
        let removed = 0
        for (const key of cache.keys()) {
            if (removed >= overflow) break
            cache.delete(key)
            removed += 1
        }
    }, [])

    // Collect all genes from cache that overlap the current view
    const updateVisibleGenes = useCallback((chrom, start, end) => {
        const { genes: visible, fetchedTiles } = collectCachedGenesInRange(chrom, start, end, 1)
        setGenes((prev) => {
            if (!(fetchedTiles > 0 || visible.length > 0 || prev.length === 0)) return prev
            return sameGeneRange(prev, visible) ? prev : visible
        })
        if (fetchedTiles > 0) {
            setHasInitialViewportData(true)
        }
    }, [collectCachedGenesInRange])

    // Fetch a single tile and store in cache
    const fetchTile = useCallback(async (chrom, tileStart, currentChrom, currentStart, currentEnd) => {
        if (!isActive) return
        if (geneTilesBlockedRef.current) return
        const key = getTileKey(chrom, tileStart)
        if (tileCacheRef.current.has(key) || fetchingTilesRef.current.has(key)) return
        const requestToken = Symbol(key)
        const requestGeneration = activeGeneRequestGenerationRef.current
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingTilesRef.current.set(key, requestToken)
        const tileEnd = tileStart + TILE_SIZE
        try {
            const params = new URLSearchParams({
                genome,
                chrom,
                start: String(tileStart),
                end: String(tileEnd),
            })
            const res = await fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, { signal: controller.signal })
            if (res.ok) {
                const data = await res.json()
                if (requestGeneration !== activeGeneRequestGenerationRef.current) return
                if (chromGeneCacheRef.current.has(getChromGeneCacheKey(genome, chrom))) return
                tileCacheRef.current.set(key, data)
                evictOldGeneTilesIfNeeded()
                if (chrom === currentChrom && chrom === selectedChromRef.current) {
                    updateVisibleGenes(chrom, currentStart, currentEnd)
                }
            } else {
                console.error(`[GenomeBrowser:${genome}] Tile ${key} fetch failed: ${res.status}`)
            }
        } catch (e) {
            if (e?.name !== 'AbortError') {
                console.error(`[GenomeBrowser:${genome}] Failed to fetch tile:`, e)
            }
        } finally {
            identityRequestControllersRef.current.delete(controller)
            if (fetchingTilesRef.current.get(key) === requestToken) {
                fetchingTilesRef.current.delete(key)
            }
        }
    }, [evictOldGeneTilesIfNeeded, genome, isActive, updateVisibleGenes])

    // ============ Data Fetching ============

    const regionsRetryTimerRef = useRef(null)

    // Fetch available regions on mount
    useEffect(() => {
        if (!isActive) return
        const controller = new AbortController()
        const fetchRegions = async () => {
            const shouldShowLoading = regions.length === 0 || !selectedChrom
            if (shouldShowLoading) setLoadingRegions(true)
            try {
                const params = new URLSearchParams({ genome })
                const res = await fetch(`${API_BASE}/api/browse/regions?${params.toString()}`, { signal: controller.signal })
                if (res.ok) {
                    const data = await res.json()
                    if (controller.signal.aborted) return
                    setRegions(data)
                    // The whole assembly's size, for the two size achievements. Only
                    // when every region came from the FASTA (and so starts at 1):
                    // without one the extents are the genes', which would make any
                    // genome look small.
                    if (Array.isArray(data) && data.length && data.every((region) => Number(region?.start) === 1)) {
                        const totalBp = data.reduce((sum, region) => sum + Math.max(0, Number(region?.end) || 0), 0)
                        if (totalBp > 0 && totalBp < 5e6) trackAchievement('browser.tinyGenome')
                        else if (totalBp > 5e9) trackAchievement('browser.hugeGenome')
                    }
                    // Auto-select informative default locus for initial view —
                    // unless the panel was opened on a region someone asked for,
                    // which is about to frame itself and must not be overruled.
                    if (data.length > 0 && !selectedChrom && !pendingLocationNavigateRef.current) {
                        let initialized = false

                        try {
                            const prefRes = await fetch(`${API_BASE}/api/browse/default_locus?${params.toString()}`, { signal: controller.signal })
                            if (prefRes.ok) {
                                const pref = await prefRes.json()
                                if (controller.signal.aborted) return
                                if (pref?.chrom) {
                                    setSelectedChrom(pref.chrom)
                                    setChromLength(pref.chrom_length || pref.end || 0)
                                    setViewStart(pref.start)
                                    setViewEnd(pref.end)
                                    initialized = true
                                }
                            }
                        } catch (e) {
                            if (e?.name !== 'AbortError') {
                                console.warn(`[GenomeBrowser:${genome}] Default locus fetch failed, using fallback.`, e)
                            }
                        }

                        if (!initialized) {
                            const candidates = data.filter((r) => r.gene_count > 0)
                            const best = (candidates.length ? candidates : data)
                                .slice()
                                .sort((a, b) => (b.length - a.length) || (b.gene_count - a.gene_count))[0]
                            const span = Math.min(500000, Math.max(200000, best.length || 500000))
                            const center = (best.start + best.end) / 2
                            const start = Math.max(best.start, Math.floor(center - span / 2))
                            const end = Math.min(best.end, Math.ceil(center + span / 2))
                            setSelectedChrom(best.chrom)
                            setChromLength(best.end)
                            setViewStart(start)
                            setViewEnd(Math.max(start + 1, end))
                        }
                    }
                } else if (res.status === INDEX_BUILDING_STATUS) {
                    // Only reachable for a genome with no FASTA to draw regions
                    // from — everything else is served off the assembly while its
                    // index builds. Retry rather than settling on an empty view.
                    if (!controller.signal.aborted) {
                        regionsRetryTimerRef.current = window.setTimeout(fetchRegions, 2000)
                    }
                } else {
                    console.error(`[GenomeBrowser:${genome}] Regions fetch failed: ${res.status}`)
                }
            } catch (e) {
                if (e?.name !== 'AbortError') {
                    console.error(`[GenomeBrowser:${genome}] Failed to fetch regions:`, e)
                }
            }
            if (shouldShowLoading && !controller.signal.aborted) setLoadingRegions(false)
        }
        fetchRegions()
        return () => {
            controller.abort()
            if (regionsRetryTimerRef.current) {
                window.clearTimeout(regionsRetryTimerRef.current)
                regionsRetryTimerRef.current = null
            }
        }
    }, [genome, isActive, dataEpoch])

    // Tile management: fetch tiles for current view + prefetch neighbours
    useEffect(() => {
        if (!isActive) return
        if (!selectedChrom) {
            return
        }

        const chrom = selectedChrom
        const { start: gStart, end: gEnd } = genomicViewRange
        const viewGeneSpan = Math.max(1, gEnd - gStart)
        const chromGeneCacheKey = getChromGeneCacheKey(genome, chrom)
        const cachedChromGenes = preloadChromGenes(chrom)

        // Update visible genes from cache immediately (instant if already cached)
        updateVisibleGenes(chrom, gStart, gEnd)
        if (Array.isArray(cachedChromGenes)) {
            return
        }
        if (viewGeneSpan >= GENE_CHROM_CACHE_ENTER_SPAN && fetchingChromGenesRef.current.has(chromGeneCacheKey)) {
            return
        }

        // Fetch buffered layout tiles so row packing can stay stable while panning.
        const layoutBuffer = clamp(viewGeneSpan * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const bufferedStart = Math.max(0, gStart - layoutBuffer)
        const bufferedEnd = gEnd + layoutBuffer
        const coreFirstTile = snapToTile(gStart)
        const coreLastTile = snapToTile(Math.max(gStart, gEnd - 1))
        const firstTile = snapToTile(bufferedStart)
        const lastTile = snapToTile(Math.max(bufferedStart, bufferedEnd - 1))
        const viewCenter = (gStart + gEnd) / 2
        const coreTiles = []
        const bufferTiles = []
        for (let t = firstTile; t <= lastTile; t += TILE_SIZE) {
            if (t >= coreFirstTile && t <= coreLastTile) coreTiles.push(t)
            else bufferTiles.push(t)
        }
        coreTiles.sort((a, b) => Math.abs((a + TILE_SIZE / 2) - viewCenter) - Math.abs((b + TILE_SIZE / 2) - viewCenter))
        for (const t of [...coreTiles, ...bufferTiles]) {
            fetchTile(chrom, t, chrom, gStart, gEnd)
        }

    }, [isActive, genome, selectedChrom, genomicViewRange, dataEpoch, fetchTile, updateVisibleGenes, preloadChromGenes])

    // Sequence buffer: fetch a wider region and serve pans from cache
    const seqBufferRef = useRef({ chrom: '', start: 0, end: 0, sequence: '' })
    const fetchingSeqRef = useRef(false)
    const pendingSeqTargetRef = useRef(null) // { genome, chrom, visStart, visEnd }
    const seqFetchEpochRef = useRef(0)

    const serveSequenceFromBuffer = useCallback((chrom, visStart, visEnd) => {
        const buf = seqBufferRef.current
        if (!(buf.chrom === chrom && buf.start <= visStart - 1 && buf.end >= visEnd && buf.sequence)) {
            return false
        }
        const offset = visStart - 1 - buf.start
        const len = Math.max(1, visEnd - visStart)
        setSequence(buf.sequence.slice(offset, offset + len))
        setSeqRange({ start: visStart, end: visEnd })
        return true
    }, [])

    useEffect(() => {
        if (!isActive) return
        const epoch = ++seqFetchEpochRef.current
        const viewSpan = viewEnd - viewStart
        if (viewSpan > 1000 || !selectedChrom) {
            pendingSeqTargetRef.current = null
            setSequence(null)
            setSeqRange(null)
            return
        }

        const { start: gStart, end: gEnd } = genomicViewRange
        const visStart = Math.max(0, Math.floor(gStart))
        const visEnd = Math.ceil(gEnd)
        pendingSeqTargetRef.current = { genome, chrom: selectedChrom, visStart, visEnd }

        // Fast path: already covered by buffer.
        if (serveSequenceFromBuffer(selectedChrom, visStart, visEnd)) {
            return
        }

        // Buffer miss — chase the latest viewport target. If panning continues while
        // a request is in-flight, we fetch the newest target immediately afterwards.
        const fetchSeq = async () => {
            if (fetchingSeqRef.current) return
            fetchingSeqRef.current = true
            try {
                while (true) {
                    if (epoch !== seqFetchEpochRef.current) return
                    const target = pendingSeqTargetRef.current
                    if (!target) return

                    if (serveSequenceFromBuffer(target.chrom, target.visStart, target.visEnd)) {
                        const latest = pendingSeqTargetRef.current
                        if (
                            latest
                            && latest.genome === target.genome
                            && latest.chrom === target.chrom
                            && latest.visStart === target.visStart
                            && latest.visEnd === target.visEnd
                        ) {
                            pendingSeqTargetRef.current = null
                        }
                        continue
                    }

                    const gSpan = Math.max(1, target.visEnd - target.visStart)
                    const bufferSize = Math.min(Math.max(gSpan * 10, 2000), 50000)
                    const center = (target.visStart + target.visEnd) / 2
                    const fetchStart = Math.max(0, Math.floor(center - bufferSize / 2))
                    const fetchEnd = Math.ceil(center + bufferSize / 2)
                    const res = await fetch(
                        `${API_BASE}/api/browse/sequence?genome=${target.genome}&chrom=${target.chrom}&start=${fetchStart}&end=${fetchEnd}`
                    )
                    if (!res.ok) return
                    const data = await res.json()
                    seqBufferRef.current = {
                        chrom: target.chrom,
                        start: data.start,
                        end: data.end,
                        sequence: data.sequence,
                    }
                }
            } catch (e) {
                console.error('Failed to fetch sequence:', e)
            } finally {
                fetchingSeqRef.current = false
            }
        }

        const timer = setTimeout(fetchSeq, 10)
        return () => clearTimeout(timer)
    }, [genome, isActive, selectedChrom, viewEnd, viewStart, genomicViewRange, serveSequenceFromBuffer])

    useEffect(() => {
        if (!isActive || !selectedChrom || !Number(chromLength || 0)) return
        const l0 = VCF_BLOCK_LEVELS[0]
        const chromEnd = Number(chromLength || 0)
        const vcfTracks = customTracks.filter((track) => (
            track?.path
            && track.visible
            && (track.type || 'bigwig') === 'vcf'
            && isVcfAdaptiveLikeMode(normalizeVcfDisplayMode(track.renderMode))
        ))
        if (vcfTracks.length === 0) return

        let cancelled = false
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const hasForegroundVcfFetch = () => {
            for (const key of vcfBlockTileFetchSetRef.current.values()) {
                const token = String(key || '')
                if (token.startsWith('adpdet:')) return true
                if (token.startsWith('vcfblk:') && !token.includes('|L0|')) return true
            }
            return false
        }

        const warmTrack = async (track) => {
            const warmupKey = buildVcfOverviewWarmupKey({
                trackId: track.id,
                path: track.path,
                chrom: selectedChrom,
                chromLength: chromEnd,
                level: l0,
            })
            if (vcfOverviewWarmupDoneRef.current.has(warmupKey)) return
            if (vcfOverviewWarmupActiveRef.current.has(warmupKey)) return
            vcfOverviewWarmupActiveRef.current.add(warmupKey)
            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))

            try {
                const tiles = buildVcfOverviewWarmupTiles({ chromLength: chromEnd, level: l0 })
                    .map((tileSpec) => {
                        const tileStart = tileSpec.tileStart
                        const tileEnd = tileSpec.tileEnd
                        const key = makeVcfBlockTileKey(track.id, selectedChrom, l0.id, tileStart, tileEnd)
                        return { ...tileSpec, key }
                    })
                    .filter((tile) => !vcfBlockTileCacheRef.current.has(tile.key))

                if (tiles.length === 0) {
                    vcfOverviewWarmupDoneRef.current.add(warmupKey)
                    return
                }

                for (const tile of tiles) {
                    if (cancelled) return
                    while (!cancelled && hasForegroundVcfFetch()) {
                        await delay(80)
                    }
                    if (cancelled) return
                    if (vcfBlockTileCacheRef.current.has(tile.key)) continue
                    if (vcfBlockTileFetchSetRef.current.has(tile.key)) continue

                    vcfBlockTileFetchSetRef.current.add(tile.key)
                    try {
                        const response = await fetch(`${API_BASE}/api/browse/vcf/block_tiles`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                path: track.path,
                                chrom: selectedChrom,
                                genome,
                                coverage_threshold: 0.25,
                                tiles: [{
                                    start: tile.start,
                                    end: tile.end,
                                    level_id: tile.level_id,
                                    block_bp: tile.block_bp,
                                    window_bp: tile.window_bp,
                                }],
                            }),
                        })
                        const payload = response.ok
                            ? await response.json()
                            : await response.json().then((e) => { throw new Error(e?.detail || `HTTP ${response.status}`) })
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const returnedTile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(returnedTile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(returnedTile.end) || 1))
                            const levelId = String(returnedTile.level_id || l0.id)
                            const selectedKey = makeVcfBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, returnedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, returnedTile)
                            }
                        }
                        setCustomTrackFetchRevision((v) => v + 1)
                    } catch (e) {
                        const errorMessage = getFetchErrorMessage(e)
                        if (!isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackData((prev) => ({
                                ...prev,
                                [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                            }))
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                            return
                        }
                    } finally {
                        vcfBlockTileFetchSetRef.current.delete(tile.key)
                    }
                    await delay(20)
                }

                vcfOverviewWarmupDoneRef.current.add(warmupKey)
                setCustomTrackFetchRevision((v) => v + 1)
            } finally {
                vcfOverviewWarmupActiveRef.current.delete(warmupKey)
            }
        }

        for (const track of vcfTracks) {
            warmTrack(track)
        }

        return () => {
            cancelled = true
        }
    }, [
        chromLength,
        customTracks,
        genome,
        isActive,
        makeVcfBlockTileKey,
        selectedChrom,
    ])

    // ── Unified custom track LOD fetch engine ─────────────────────────────────────────────────
    // Runs on every viewport change. Immediately projects from cache (no debounce on rendering),
    // then issues new fetch requests with a 50ms debounce to avoid request storms during panning.
    // IMPORTANT: In-flight responses are NEVER cancelled — tiles are viewport-independent.
    //            Only the debounce timer is cancelled on viewport changes.
    const fetchEpochRef = useRef(0)
    const vcfViewportIntentRef = useRef({ center: 0, span: 0, changedAt: 0, intent: 'settled' })
    useEffect(() => {
        if (!isActive) return
        if (!selectedChrom || customTracks.length === 0) return

        const epoch = ++fetchEpochRef.current
        const displayBins = Math.max(80, Math.min(1400, Math.floor(viewWidth - LHS_WIDTH - 44)))
        const visStart = Math.max(0, Math.floor(genomicViewRange.start))
        const visEnd = Math.max(visStart + 1, Math.ceil(genomicViewRange.end))
        const visSpan = visEnd - visStart
        const bpPerPx = visSpan / Math.max(1, viewWidth - LHS_WIDTH)
        const targetLevel = getBigWigLevel(bpPerPx)
        const center = (visStart + visEnd) / 2
        const nowMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
        const nextVcfViewportIntent = getVcfViewportIntent({
            previous: vcfViewportIntentRef.current,
            center,
            span: visSpan,
            nowMs,
        })
        vcfViewportIntentRef.current = nextVcfViewportIntent
        const vcfViewportIntent = nextVcfViewportIntent.intent
        // Buffer: 2× viewport on each side = 5× total covered
        const bufferSpan = visSpan * 2
        const bufferStart = Math.max(0, visStart - bufferSpan)
        const bufferEnd = visEnd + bufferSpan

        // ── Step 1: Immediately project from cache and update displayed data ──────────────────
        for (const track of customTracks) {
            if (!track?.path || !track.visible) continue
            const trackType = track.type || 'bigwig'

            if (trackType === 'vcf') {
                const vcfMode = normalizeVcfDisplayMode(track.renderMode)
                let projected
                if (isVcfAdaptiveLikeMode(vcfMode)) {
                    const vcfLevel = getVcfBlockLevel(bpPerPx)
                    if (vcfLevel.mode === 'detail') {
                        projected = projectVcfAdaptiveDetailLevel(track.id, selectedChrom, vcfLevel, visStart, visEnd)
                    } else {
                        projected = projectVcfBlockTilesCascadeToView(track.id, selectedChrom, vcfLevel, visStart, visEnd, displayBins)
                    }
                    const l0 = VCF_BLOCK_LEVELS[0]
                    const overviewWarmupKey = buildVcfOverviewWarmupKey({
                        trackId: track.id,
                        path: track.path,
                        chrom: selectedChrom,
                        chromLength,
                        level: l0,
                    })
                    const overviewWarmupPending = !!overviewWarmupKey && !vcfOverviewWarmupDoneRef.current.has(overviewWarmupKey)
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        // Don't clear a populated detail view with an empty one while tiles arrive
                        if (projected.mode === 'adp_detail') {
                            if (Array.isArray(prevData?.variants) && prevData.variants.length > 0 &&
                                projected.variants.length === 0 && Number(projected.tile_coverage) < 0.4) {
                                return prev
                            }
                        } else if (vcfMode === 'adaptive') {
                            const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                            const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                            if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                                return prev
                            }
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    const isLoading = Number(projected?.tile_coverage || 0) < 0.85 || (vcfLevel.id === 'L0' && overviewWarmupPending)
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: isLoading }))
                } else {
                    const vcfLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                    projected = projectVcfTilesToView(track.id, selectedChrom, vcfLevel, visStart, visEnd, displayBins)
                    setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                    const waitingForDetail = vcfLevel.mode === 'detail' && Number(projected?.detail_coverage || 0) < 0.95
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: projected.coverage < 0.85 || waitingForDetail }))
                }
            } else if (trackType === 'splice_junctions') {
                const spliceMode = getSpliceLodMode(track.id, bpPerPx, track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                if (spliceMode === 'blocks') {
                    const blockLevel = getSpliceBlockLevel(bpPerPx)
                    const projected = projectSpliceBlockTilesToView(
                        track.id,
                        selectedChrom,
                        blockLevel,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                        const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                        if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                } else {
                    const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevCount = Array.isArray(prevData?.junctions) ? prevData.junctions.length : 0
                        const nextCount = Array.isArray(projected?.junctions) ? projected.junctions.length : 0
                        const nextCoverage = Number(projected?.coverage || 0)
                        if (prevCount > 0 && nextCount === 0 && nextCoverage < 0.45) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    // Keep loading visible until cached coverage is reasonably complete.
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.coverage || 0) < 0.75 }))
                }
            } else if (trackType === 'bigbed') {
                const bigBedMode = getBigBedLodMode(track.id, bpPerPx)
                if (bigBedMode === 'blocks') {
                    const blockLevel = getBigBedBlockLevel(bpPerPx)
                    const projected = projectBigBedBlockTilesToView(
                        track.id,
                        selectedChrom,
                        blockLevel,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevSpans = Array.isArray(prevData?.block_spans) ? prevData.block_spans : []
                        const nextSpans = Array.isArray(projected?.block_spans) ? projected.block_spans : []
                        if (prevSpans.length > 0 && (nextSpans.length === 0 || Number(projected?.tile_coverage || 0) < 0.4)) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                } else {
                    const projected = projectBigBedFeatureTilesToView(
                        track.id,
                        selectedChrom,
                        visStart,
                        visEnd,
                        Math.max(1, viewWidth - LHS_WIDTH),
                    )
                    setCustomTrackData((prev) => {
                        const prevData = prev[track.id]
                        const prevCount = Array.isArray(prevData?.features) ? prevData.features.length : 0
                        const nextCount = Array.isArray(projected?.features) ? projected.features.length : 0
                        if (prevCount > 0 && nextCount === 0 && Number(projected?.tile_coverage || 0) < 0.4) {
                            return prev
                        }
                        return { ...prev, [track.id]: projected }
                    })
                    setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                }
            } else if (['bigwig', 'bam'].includes(trackType)) {
                // Signal tracks: always project from cache (uses coarse-to-fine fallback)
                const projected = projectBigWigTilesToView(track.id, selectedChrom, targetLevel, visStart, visEnd, displayBins)
                setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                // Only mark as loading if we have very little data
                setCustomTrackLoading((prev) => ({ ...prev, [track.id]: projected.coverage < 0.3 }))
            } else {
                // Discrete tracks: pull from feature cache if available
                const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                const cached = trackFeatureCacheRef.current.get(featureKey)
                if (cached) {
                    setCustomTrackData((prev) => ({ ...prev, [track.id]: cached }))
                }
            }
        }

        // ── Step 2: Determine what tiles need fetching ────────────────────────────────────────
        const fetchPlans = [] // { track, level, tileStart, tileEnd, priority }

        for (const track of customTracks) {
            if (!track?.path || !track.visible) continue
            const trackType = track.type || 'bigwig'
            const isSignalTrack = ['bigwig', 'bam', 'long_reads'].includes(trackType)

            if (trackType === 'vcf') {
                const vcfMode = normalizeVcfDisplayMode(track.renderMode)
                if (isVcfAdaptiveLikeMode(vcfMode)) {
                    // ── Adaptive mode: use new VCF_BLOCK_LEVELS + /api/browse/vcf/block_tiles ──
                    const targetLevel = getVcfBlockLevel(bpPerPx)
                    const targetIdx = VCF_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const isDetailLevel = targetLevel.mode === 'detail'
                    const isCoarseOverview = !isDetailLevel && bpPerPx >= 250
                    const isZoomingVcf = vcfViewportIntent === 'zooming'
                    const isPanningVcf = vcfViewportIntent === 'panning'
                    const vcfBufferFactor = isDetailLevel
                        ? (isZoomingVcf ? 0.35 : isPanningVcf ? 1.15 : 2.25)
                        : (isCoarseOverview ? 0.35 : isZoomingVcf ? 0.4 : isPanningVcf ? 1.1 : 1.8)
                    const vcfBufferSpan = visSpan * vcfBufferFactor
                    const vcfBufferStart = Math.max(0, visStart - vcfBufferSpan)
                    const vcfBufferEnd = visEnd + vcfBufferSpan
                    const levelsToFetch = [targetLevel]
                    if (!isDetailLevel && !isCoarseOverview && targetIdx > 0 && !isZoomingVcf) {
                        levelsToFetch.push(VCF_BLOCK_LEVELS[targetIdx - 1])
                    }
                    const plannedVcfKeys = new Set()
                    const addVcfPlan = (level, tileStart, isBackground, isOverviewWarmup = false) => {
                        const tileSpan = level.tileSpanBp
                        const isDetail = level.mode === 'detail'
                        const normalizedStart = Math.max(0, Math.floor(tileStart))
                        const tileEnd = normalizedStart + tileSpan
                        const key = isDetail
                            ? makeVcfAdpDetailKey(track.id, selectedChrom, normalizedStart, tileEnd)
                            : makeVcfBlockTileKey(track.id, selectedChrom, level.id, normalizedStart, tileEnd)
                        if (plannedVcfKeys.has(key)) return
                        plannedVcfKeys.add(key)
                        if (vcfBlockTileCacheRef.current.has(key)) return
                        if (vcfBlockTileFetchSetRef.current.has(key)) return
                        const distFromCenter = Math.abs((normalizedStart + tileSpan / 2) - center)
                        const levelBonus = level.id === targetLevel.id ? 0 : (visSpan * 4)
                        const backgroundBonus = isBackground ? (isOverviewWarmup ? (visSpan * 1.5) : (visSpan * 7)) : 0
                        fetchPlans.push({
                            track,
                            isVcfBlock: !isDetail,
                            isVcfAdpDetail: isDetail,
                            isBackground: !!isBackground,
                            isOverviewWarmup: !!isOverviewWarmup,
                            vcfBlockLevel: level,
                            tileStart: normalizedStart,
                            tileEnd,
                            key,
                            priority: distFromCenter + levelBonus + backgroundBonus,
                        })
                    }

                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const foregroundPad = level.mode === 'detail'
                            ? (isZoomingVcf ? 0 : visSpan * 0.2)
                            : (isZoomingVcf ? 0 : visSpan * 0.1)
                        const fgStart = Math.max(0, visStart - foregroundPad)
                        const fgEnd = visEnd + foregroundPad
                        const fgFirstTile = Math.floor(fgStart / tileSpan) * tileSpan
                        const fgLastTile = Math.floor((fgEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = fgFirstTile; tileStart <= fgLastTile; tileStart += tileSpan) {
                            addVcfPlan(level, tileStart, false)
                        }

                        const isFullChromOverview = false
                        const bgStart = vcfBufferStart
                        const bgEnd = vcfBufferEnd
                        const bgFirstTile = Math.floor(Math.max(0, bgStart) / tileSpan) * tileSpan
                        const bgLastTile = Math.floor((Math.max(bgFirstTile + 1, bgEnd) - 1) / tileSpan) * tileSpan
                        for (let tileStart = bgFirstTile; tileStart <= bgLastTile; tileStart += tileSpan) {
                            addVcfPlan(level, tileStart, true, isFullChromOverview)
                        }
                    }
                } else {
                    // ── Non-adaptive mode: original /api/browse/vcf/tiles flow ──────────────
                    const vcfTargetLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                    const vcfTargetIdx = Math.max(0, VCF_LOD_LEVELS.findIndex((l) => l.id === vcfTargetLevel.id))
                    const levelsToFetch = [vcfTargetLevel]
                    if (vcfTargetIdx > 0) levelsToFetch.push(VCF_LOD_LEVELS[vcfTargetIdx - 1])
                    if (vcfTargetIdx > 1) levelsToFetch.push(VCF_LOD_LEVELS[vcfTargetIdx - 2])

                    for (const level of levelsToFetch) {
                        const tileSpan = level.bpPerBin * level.binsPerTile
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeVcfTileKey(
                                track.id, selectedChrom, level.id, level.mode,
                                tileStart, tileEnd, 0, 0, 0.5, '',
                            )
                            if (vcfTileCacheRef.current.has(key)) continue
                            if (vcfTileFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === vcfTargetLevel.id ? 0 : 12000
                            fetchPlans.push({
                                track,
                                isVcf: true,
                                vcfLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                }
                continue
            }

            if (trackType === 'splice_junctions') {
                const spliceMode = getSpliceLodMode(track.id, bpPerPx, track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                if (spliceMode === 'blocks') {
                    const targetLevel = getSpliceBlockLevel(bpPerPx)
                    const targetIdx = SPLICE_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const levelsToFetch = [targetLevel]
                    if (targetIdx > 0) levelsToFetch.push(SPLICE_BLOCK_LEVELS[targetIdx - 1])

                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeSpliceBlockTileKey(track.id, selectedChrom, level.id, tileStart, tileEnd)
                            if (trackFeatureCacheRef.current.has(key)) continue
                            if (trackFeatureFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === targetLevel.id ? 0 : 9000
                            fetchPlans.push({
                                track,
                                isSpliceBlock: true,
                                spliceBlockLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                } else {
                    const tileSpan = getSpliceTileSpan(bpPerPx)
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const tileEnd = tileStart + tileSpan
                        const key = makeSpliceTileKey(track.id, selectedChrom, tileStart, tileEnd)
                        if (trackFeatureCacheRef.current.has(key)) continue
                        if (trackFeatureFetchSetRef.current.has(key)) continue
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        fetchPlans.push({
                            track,
                            isSplice: true,
                            tileStart,
                            tileEnd,
                            key,
                            priority: distFromCenter,
                        })
                    }
                }
                continue
            }

            if (trackType === 'bigbed') {
                const bigBedMode = getBigBedLodMode(track.id, bpPerPx)
                if (bigBedMode === 'blocks') {
                    const targetLevel = getBigBedBlockLevel(bpPerPx)
                    const targetIdx = BIGBED_BLOCK_LEVELS.findIndex((l) => l.id === targetLevel.id)
                    const levelsToFetch = [targetLevel]
                    if (targetIdx > 0) levelsToFetch.push(BIGBED_BLOCK_LEVELS[targetIdx - 1])
                    for (const level of levelsToFetch) {
                        const tileSpan = level.tileSpanBp
                        const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                        const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                        for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                            const tileEnd = tileStart + tileSpan
                            const key = makeBigBedBlockTileKey(track.id, selectedChrom, level.id, tileStart, tileEnd)
                            if (trackFeatureCacheRef.current.has(key)) continue
                            if (trackFeatureFetchSetRef.current.has(key)) continue
                            const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                            const levelBonus = level.id === targetLevel.id ? 0 : 9000
                            fetchPlans.push({
                                track,
                                isBigBedBlock: true,
                                bigBedBlockLevel: level,
                                tileStart,
                                tileEnd,
                                key,
                                priority: distFromCenter + levelBonus,
                            })
                        }
                    }
                } else {
                    const tileSpan = BIGBED_FEATURE_TILE_SPAN
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan
                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const tileEnd = tileStart + tileSpan
                        const key = makeBigBedFeatureTileKey(track.id, selectedChrom, tileStart, tileEnd)
                        if (trackFeatureCacheRef.current.has(key)) continue
                        if (trackFeatureFetchSetRef.current.has(key)) continue
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        fetchPlans.push({
                            track,
                            isBigBedFeature: true,
                            tileStart,
                            tileEnd,
                            key,
                            priority: distFromCenter,
                        })
                    }
                }
                continue
            }

            // Pre-fetch L0 (overview) for stable chrom-wide scale if not already cached
            if (isSignalTrack) {
                const scaleKey = `${track.id}|${selectedChrom}`
                if (!trackChromScaleRef.current[scaleKey]) {
                    const l0 = TRACK_LOD_LEVELS[0] // L0 = 10000 bp/bin
                    const l0TileSpan = l0.bpPerBin * l0.binsPerTile
                    // Fetch 3 overview tiles centred on viewport
                    const l0Tiles = [-1, 0, 1].map(offset =>
                        Math.floor(center / l0TileSpan + offset) * l0TileSpan
                    )
                    for (const tileStart of l0Tiles) {
                        const key = makeBigWigTileKey(track.id, selectedChrom, l0.id, tileStart)
                        if (!trackTileCacheRef.current.has(key) && !trackTileFetchSetRef.current.has(key)) {
                            fetchPlans.push({ track, level: l0, tileStart, tileEnd: tileStart + l0TileSpan, priority: 100 })
                        }
                    }
                }
            }

            if (isSignalTrack) {
                // For signal tracks: fetch target level + one level up (fallback)
                const levelsToFetch = [targetLevel]
                const targetIdx = TRACK_LOD_LEVELS.indexOf(targetLevel)
                if (targetIdx > 0) levelsToFetch.push(TRACK_LOD_LEVELS[targetIdx - 1])

                for (const level of levelsToFetch) {
                    const tileSpan = level.bpPerBin * level.binsPerTile
                    const firstTile = Math.floor(bufferStart / tileSpan) * tileSpan
                    const lastTile = Math.floor((bufferEnd - 1) / tileSpan) * tileSpan

                    for (let tileStart = firstTile; tileStart <= lastTile; tileStart += tileSpan) {
                        const key = makeBigWigTileKey(track.id, selectedChrom, level.id, tileStart)
                        if (trackTileCacheRef.current.has(key)) continue
                        if (trackTileFetchSetRef.current.has(key)) continue
                        // Priority: target level > coarser levels; closer to centre = higher priority
                        const distFromCenter = Math.abs((tileStart + tileSpan / 2) - center)
                        const levelBonus = level.id === targetLevel.id ? 0 : 10000
                        fetchPlans.push({ track, level, tileStart, tileEnd: tileStart + tileSpan, priority: distFromCenter + levelBonus })
                    }
                }
            } else {
                // Discrete tracks (VCF, BED, splice_junctions, long_reads by transcript):
                // Use a simpler region-based fetch covering the buffer zone
                const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                if (!trackFeatureCacheRef.current.has(featureKey) && !trackFeatureFetchSetRef.current.has(featureKey)) {
                    fetchPlans.push({ track, level: targetLevel, tileStart: bufferStart, tileEnd: bufferEnd, priority: 0, isDiscrete: true })
                }
            }
        }

        if (fetchPlans.length === 0) return

        // Sort by priority (lower = higher priority)
        fetchPlans.sort((a, b) => a.priority - b.priority)
        // Cap to prevent request storms
        const signalPlans = fetchPlans.filter((p) => !p.isDiscrete && !p.isVcf && !p.isVcfBlock && !p.isVcfAdpDetail && !p.isSplice && !p.isSpliceBlock && !p.isBigBedBlock && !p.isBigBedFeature).slice(0, 12)
        const discretePlans = fetchPlans.filter(p => p.isDiscrete)
        const splicePlans = fetchPlans.filter((p) => p.isSplice).slice(0, 14)
        const spliceBlockPlans = fetchPlans.filter((p) => p.isSpliceBlock).slice(0, 14)
        const bigBedBlockPlans = fetchPlans.filter((p) => p.isBigBedBlock).slice(0, 12)
        const bigBedFeaturePlans = fetchPlans.filter((p) => p.isBigBedFeature).slice(0, 14)
        const vcfPlans = fetchPlans.filter((p) => p.isVcf).slice(0, 10)
        const vcfBlockLevelForCap = getVcfBlockLevel(bpPerPx)
        const vcfBlockTileSpanForCap = Number(vcfBlockLevelForCap?.mode === 'detail'
            ? VCF_BLOCK_LEVELS[Math.max(0, VCF_BLOCK_LEVELS.findIndex((l) => l.id === vcfBlockLevelForCap.id) - 1)]?.tileSpanBp
            : vcfBlockLevelForCap?.tileSpanBp) || 5_000_000
        const vcfViewportTiles = Math.max(
            1,
            Math.floor((visEnd - 1) / vcfBlockTileSpanForCap) - Math.floor(visStart / vcfBlockTileSpanForCap) + 1,
        )
        const allVcfBlockPlans = fetchPlans.filter((p) => p.isVcfBlock)
        const vcfBlockForegroundPlans = allVcfBlockPlans.filter((p) => !p.isBackground)
        const vcfBlockBackgroundPlans = allVcfBlockPlans.filter((p) => p.isBackground)
        const vcfOverviewWarmupPlans = vcfBlockBackgroundPlans.filter((p) => p.isOverviewWarmup)
        const vcfOtherBlockBackgroundPlans = vcfBlockBackgroundPlans.filter((p) => !p.isOverviewWarmup)
        const vcfOverviewWarmupCap = vcfBlockLevelForCap?.id === 'L0' && vcfViewportIntent !== 'zooming'
            ? 18
            : (vcfViewportIntent === 'zooming' ? 1 : 3)
        const vcfBlockBackgroundCap = vcfViewportIntent === 'zooming' ? 1 : vcfViewportIntent === 'panning' ? 3 : 5
        const vcfBlockForegroundCap = Math.max(vcfViewportTiles, Math.min(18, vcfViewportTiles + 2))
        const vcfBlockPlans = [
            ...vcfBlockForegroundPlans.slice(0, vcfBlockForegroundCap),
            ...vcfOverviewWarmupPlans.slice(0, vcfOverviewWarmupCap),
            ...vcfOtherBlockBackgroundPlans.slice(0, vcfBlockBackgroundCap),
        ]

        const allVcfAdpDetailPlans = fetchPlans.filter((p) => p.isVcfAdpDetail)
        const vcfAdpDetailForegroundPlans = allVcfAdpDetailPlans.filter((p) => !p.isBackground)
        const vcfAdpDetailBackgroundPlans = allVcfAdpDetailPlans.filter((p) => p.isBackground)
        const vcfAdpDetailPlans = [
            ...vcfAdpDetailForegroundPlans.slice(0, 12),
            ...vcfAdpDetailBackgroundPlans.slice(0, vcfViewportIntent === 'zooming' ? 0 : 6),
        ]
        const hasMoreVcfBlockPlans = allVcfBlockPlans.length > vcfBlockPlans.length
        const hasMoreVcfAdpDetailPlans = allVcfAdpDetailPlans.length > vcfAdpDetailPlans.length
        const toFetch = [...signalPlans, ...discretePlans, ...splicePlans]

        // ── Step 3: Issue fetches after 50ms debounce ─────────────────────────────────────────
        // IMPORTANT: Only the timer is cancelled on cleanup — in-flight responses ALWAYS cache
        // their data because tiles are keyed by genomic coordinates, not screen position.
        const timer = setTimeout(() => {
            if (fetchEpochRef.current !== epoch) return  // viewport moved; skip dispatch but don't cancel existing fetches
            evictOldTilesIfNeeded()

            // ── Adaptive VCF block tiles → /api/browse/vcf/block_tiles ───────────────────────
            const vcfBlockGroups = new Map()
            for (const plan of vcfBlockPlans) {
                const { track, vcfBlockLevel, tileStart, tileEnd, key } = plan
                if (vcfBlockTileCacheRef.current.has(key) || vcfBlockTileFetchSetRef.current.has(key)) continue
                vcfBlockTileFetchSetRef.current.add(key)
                if (!vcfBlockGroups.has(track.id)) {
                    vcfBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: vcfBlockLevel.id,
                    block_bp: vcfBlockLevel.blockBp,
                    window_bp: vcfBlockLevel.windowBp,
                })
            }

            for (const { track, keys, tiles } of vcfBlockGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        coverage_threshold: 0.25,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L3')
                            const selectedKey = makeVcfBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfBlockLevel(bpPerPx)
                        const projected = projectVcfBlockTilesCascadeToView(track.id, selectedChrom, freshLevel, visStart, visEnd, displayBins)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const stillLoading = Number(projected?.tile_coverage || 0) < 0.85
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading || hasMoreVcfBlockPlans) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfBlockTileFetchSetRef.current.delete(k)
                    })
            }

            // ── Splice block tiles → /api/browse/splice_junctions/block_tiles ────────────────
            const spliceBlockGroups = new Map()
            for (const plan of spliceBlockPlans) {
                const { track, spliceBlockLevel, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!spliceBlockGroups.has(track.id)) {
                    spliceBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = spliceBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: spliceBlockLevel.id,
                    block_bp: spliceBlockLevel.blockBp,
                })
            }

            for (const { track, keys, tiles } of spliceBlockGroups.values()) {
                const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                const payload = {
                    path: track.path,
                    chrom: selectedChrom,
                    genome,
                    min_reads: 1,
                    min_support: spliceSettings.min_support,
                    canonical_mode: spliceSettings.canonical_mode,
                    annotated_mode: spliceSettings.annotated_mode,
                    max_junctions: spliceSettings.max_junctions,
                    tiles,
                }
                if (track?.registryTrackId) payload.track_id = String(track.registryTrackId)

                fetch(`${API_BASE}/api/browse/splice_junctions/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L0')
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'splice_blocks',
                                start: tStart,
                                end: tEnd,
                                block_spans: Array.isArray(tile?.block_spans) ? tile.block_spans : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            // Cache under requested chrom key (used by projection) and resolved key (for alias continuity).
                            const selectedKey = makeSpliceBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeSpliceBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getSpliceBlockLevel(bpPerPx)
                        const projected = projectSpliceBlockTilesToView(
                            track.id,
                            selectedChrom,
                            freshLevel,
                            visStart,
                            visEnd,
                            Math.max(1, viewWidth - LHS_WIDTH),
                        )
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'splice_blocks', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── BigBed summary block tiles → /api/browse/bigbed/block_tiles ──────────────────
            const bigBedBlockGroups = new Map()
            for (const plan of bigBedBlockPlans) {
                const { track, bigBedBlockLevel, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!bigBedBlockGroups.has(track.id)) {
                    bigBedBlockGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = bigBedBlockGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: bigBedBlockLevel.id,
                    block_bp: bigBedBlockLevel.blockBp,
                })
            }

            for (const { track, keys, tiles } of bigBedBlockGroups.values()) {
                fetch(`${API_BASE}/api/browse/bigbed/block_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const levelId = String(tile.level_id || 'L0')
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'bigbed_blocks',
                                start: tStart,
                                end: tEnd,
                                block_spans: Array.isArray(tile?.block_spans) ? tile.block_spans : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            const selectedKey = makeBigBedBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeBigBedBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getBigBedBlockLevel(bpPerPx)
                        const projected = projectBigBedBlockTilesToView(
                            track.id,
                            selectedChrom,
                            freshLevel,
                            visStart,
                            visEnd,
                            Math.max(1, viewWidth - LHS_WIDTH),
                        )
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'bigbed_blocks', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── BigBed detail feature tiles → /api/browse/bigbed/feature_tiles ───────────────
            const bigBedFeatureGroups = new Map()
            for (const plan of bigBedFeaturePlans) {
                const { track, tileStart, tileEnd, key } = plan
                if (trackFeatureCacheRef.current.has(key) || trackFeatureFetchSetRef.current.has(key)) continue
                trackFeatureFetchSetRef.current.add(key)
                if (!bigBedFeatureGroups.has(track.id)) {
                    bigBedFeatureGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = bigBedFeatureGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    level_id: 'detail',
                    max_features: BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
                })
            }

            for (const { track, keys, tiles } of bigBedFeatureGroups.values()) {
                fetch(`${API_BASE}/api/browse/bigbed/feature_tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        max_features_per_tile: BIGBED_DETAIL_MAX_FEATURES_PER_TILE,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((response) => {
                        const returnedChrom = response?.chrom || selectedChrom
                        const returned = Array.isArray(response?.tiles) ? response.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const cachedTile = {
                                ...(tile || {}),
                                mode: 'bigbed_detail',
                                start: tStart,
                                end: tEnd,
                                features: Array.isArray(tile?.features)
                                    ? tile.features.map((row) => normalizeBigBedFeatureForRender(row)).filter(Boolean)
                                    : [],
                                has_data: tile?.has_data !== false,
                                error: '',
                            }
                            const selectedKey = makeBigBedFeatureTileKey(track.id, selectedChrom, tStart, tEnd)
                            trackFeatureCacheRef.current.set(selectedKey, cachedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeBigBedFeatureTileKey(track.id, returnedChrom, tStart, tEnd)
                                trackFeatureCacheRef.current.set(resolvedKey, cachedTile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const projected = projectBigBedFeatureTilesToView(
                            track.id,
                            selectedChrom,
                            visStart,
                            visEnd,
                            Math.max(1, viewWidth - LHS_WIDTH),
                        )
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: Number(projected?.tile_coverage || 0) < 0.85 }))
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), mode: 'bigbed_detail', has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) trackFeatureFetchSetRef.current.delete(k)
                    })
            }

            // ── Adaptive VCF L4 detail tiles → /api/browse/vcf/tiles (individual variants) ──────
            const vcfAdpDetailGroups = new Map()
            for (const plan of vcfAdpDetailPlans) {
                const { track, tileStart, tileEnd, key } = plan
                if (vcfBlockTileCacheRef.current.has(key) || vcfBlockTileFetchSetRef.current.has(key)) continue
                vcfBlockTileFetchSetRef.current.add(key)
                if (!vcfAdpDetailGroups.has(track.id)) {
                    vcfAdpDetailGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfAdpDetailGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    lod: 'L4',
                    mode: 'detail',
                    bins: 1024,
                    max_variants: 5000,
                    block_mode: 'legacy',
                })
            }

            for (const { track, keys, tiles } of vcfAdpDetailGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        include_effects: true,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const selectedKey = makeVcfAdpDetailKey(track.id, selectedChrom, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfAdpDetailKey(track.id, returnedChrom, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfBlockLevel(bpPerPx)
                        if (freshLevel.mode !== 'detail') return
                        const projected = projectVcfAdaptiveDetailLevel(track.id, selectedChrom, freshLevel, visStart, visEnd)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const stillLoading = Number(projected?.tile_coverage || 0) < 0.85
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading || hasMoreVcfAdpDetailPlans) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfBlockTileFetchSetRef.current.delete(k)
                    })
            }

            // ── Non-adaptive VCF summary/detail tiles → /api/browse/vcf/tiles ────────────────
            const vcfGroups = new Map()
            for (const plan of vcfPlans) {
                const { track, vcfLevel, tileStart, tileEnd, key } = plan
                if (vcfTileCacheRef.current.has(key) || vcfTileFetchSetRef.current.has(key)) continue
                vcfTileFetchSetRef.current.add(key)
                if (!vcfGroups.has(track.id)) {
                    vcfGroups.set(track.id, { track, keys: [], tiles: [] })
                }
                const group = vcfGroups.get(track.id)
                group.keys.push(key)
                group.tiles.push({
                    start: Math.max(0, Math.floor(tileStart)),
                    end: Math.ceil(tileEnd),
                    lod: vcfLevel.id,
                    mode: vcfLevel.mode,
                    bins: vcfLevel.binsPerTile,
                    max_variants: vcfLevel.mode === 'detail' ? 5000 : 250000,
                    block_mode: 'legacy',
                })
            }

            for (const { track, keys, tiles } of vcfGroups.values()) {
                fetch(`${API_BASE}/api/browse/vcf/tiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: track.path,
                        chrom: selectedChrom,
                        genome,
                        include_effects: true,
                        tiles,
                    }),
                })
                    .then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                    .then((payload) => {
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const tile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(tile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(tile.end) || 1))
                            const lodId = String(tile.lod || 'L2')
                            const mode = String(tile.mode || 'summary')
                            const selectedKey = makeVcfTileKey(
                                track.id, selectedChrom,
                                lodId, mode,
                                tStart, tEnd, 0, 0, 0.5, '',
                            )
                            vcfTileCacheRef.current.set(selectedKey, tile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfTileKey(
                                    track.id, returnedChrom,
                                    lodId, mode,
                                    tStart, tEnd, 0, 0, 0.5, '',
                                )
                                vcfTileCacheRef.current.set(resolvedKey, tile)
                            }
                        }
                        if (fetchEpochRef.current !== epoch) return
                        const freshLevel = getVcfLevelByBpPerPx(bpPerPx, track.id, VCF_LOD_LEVELS)
                        const projected = projectVcfTilesToView(track.id, selectedChrom, freshLevel, visStart, visEnd, displayBins)
                        setCustomTrackData((prev) => ({ ...prev, [track.id]: projected }))
                        const waitingForDetail = freshLevel.mode === 'detail' && Number(projected?.detail_coverage || 0) < 0.95
                        const stillLoading = projected.coverage < 0.85 || waitingForDetail
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: stillLoading }))
                        if (stillLoading) setCustomTrackFetchRevision((v) => v + 1)
                    })
                    .catch((e) => {
                        const errorMessage = getFetchErrorMessage(e)
                        if (isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))
                            return
                        }
                        setCustomTrackData((prev) => ({
                            ...prev,
                            [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                        }))
                        setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                    })
                    .finally(() => {
                        for (const k of keys) vcfTileFetchSetRef.current.delete(k)
                    })
            }

            for (const plan of toFetch) {
                const { track, level, tileStart, tileEnd, isDiscrete, isSplice, key } = plan

                if (isSplice) {
                    if (!key || trackFeatureFetchSetRef.current.has(key)) continue
                    trackFeatureFetchSetRef.current.add(key)
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)

                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, Math.floor(tileStart))),
                        end: String(Math.ceil(tileEnd)),
                        level: 'fine',
                        min_reads: '1',
                        min_support: String(spliceSettings.min_support),
                        canonical_mode: String(spliceSettings.canonical_mode),
                        annotated_mode: String(spliceSettings.annotated_mode),
                        max_junctions: String(spliceSettings.max_junctions),
                        bins: String(displayBins),
                    })
                    if (track?.registryTrackId) params.set('track_id', String(track.registryTrackId))

                    fetch(`${API_BASE}/api/browse/splice_junctions?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(data => {
                            const payload = {
                                ...(data || {}),
                                mode: 'splice_arcs',
                                start: Math.max(0, Math.floor(tileStart)),
                                end: Math.ceil(tileEnd),
                                junctions: Array.isArray(data?.junctions) ? data.junctions : [],
                                has_data: true,
                                error: '',
                            }
                            trackFeatureCacheRef.current.set(key, payload)
                            if (fetchEpochRef.current !== epoch) return
                            const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: projected }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: Number(projected?.coverage || 0) < 0.75 }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            const errorMessage = getFetchErrorMessage(e)
                            if (isTransientFetchErrorMessage(errorMessage)) {
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            trackFeatureCacheRef.current.set(key, {
                                mode: 'splice_arcs',
                                start: Math.max(0, Math.floor(tileStart)),
                                end: Math.ceil(tileEnd),
                                junctions: [],
                                has_data: false,
                                error: errorMessage,
                            })
                            const projected = projectSpliceTilesToView(track.id, selectedChrom, visStart, visEnd)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...projected, error: errorMessage || projected.error } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackFeatureFetchSetRef.current.delete(key) })
                    continue
                }

                if (isDiscrete) {
                    // ── Discrete feature fetch ────────────────────────────────────────────────
                    const trackType = track.type
                    const featureKey = `${track.id}|${selectedChrom}|view|${visStart}`
                    if (trackFeatureFetchSetRef.current.has(featureKey)) continue
                    trackFeatureFetchSetRef.current.add(featureKey)

                    const fetchLod = bpPerPx > 100 ? 'region' : bpPerPx > 10 ? 'gene' : 'fine'
                    let endpoint = ''
                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, tileStart)),
                        end: String(tileEnd),
                        level: fetchLod,
                        bins: String(displayBins),
                    })

                    if (trackType === 'vcf') endpoint = 'vcf'
                    else if (trackType === 'bed' || trackType === 'bigbed') endpoint = 'bed'
                    else if (trackType === 'splice_junctions') endpoint = 'splice_junctions'
                    else if (trackType === 'long_reads') { endpoint = 'long_reads'; params.set('collapse', 'true'); params.set('max_reads', '500') }
                    else continue

                    fetch(`${API_BASE}/api/browse/${endpoint}?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(data => {
                            // Always cache the result — tiles are valid regardless of viewport changes
                            trackFeatureCacheRef.current.set(featureKey, { ...data, has_data: true, error: '' })
                            if (fetchEpochRef.current !== epoch) return
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...data, has_data: true, error: '' } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            if (isTransientFetchError(e)) {
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            const errorMessage = getFetchErrorMessage(e)
                            trackFeatureCacheRef.current.set(featureKey, { has_data: false, error: errorMessage })
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { has_data: false, error: errorMessage } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackFeatureFetchSetRef.current.delete(featureKey) })

                } else {
                    // ── Signal tile fetch (BigWig / BAM coverage) ─────────────────────────────
                    const tileKey = makeBigWigTileKey(track.id, selectedChrom, level.id, tileStart)
                    if (trackTileFetchSetRef.current.has(tileKey)) continue
                    trackTileFetchSetRef.current.add(tileKey)

                    const isL0Prefetch = level.id === 'L0'
                    const params = new URLSearchParams({
                        genome,
                        path: track.path,
                        chrom: selectedChrom,
                        start: String(Math.max(0, tileStart)),
                        end: String(tileEnd),
                        bins: String(level.binsPerTile),
                    })

                    fetch(`${API_BASE}/api/browse/bigwig?${params.toString()}`)
                        .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.detail || `HTTP ${r.status}`) }))
                        .then(payload => {
                            // Always cache — tiles are keyed by genomic coords, always valid
                            trackTileCacheRef.current.set(tileKey, {
                                start: payload?.start ?? tileStart,
                                end: payload?.end ?? tileEnd,
                                bpPerBin: level.bpPerBin,
                                bins: Array.isArray(payload?.bins) ? payload.bins : [],
                                has_data: !!payload?.has_data,
                                error: '',
                            })
                            if (fetchEpochRef.current !== epoch) return
                            // Use L0 result to set stable chrom-wide scale
                            if (isL0Prefetch && payload?.has_data) {
                                const scaleKey = `${track.id}|${selectedChrom}`
                                const validBins = (payload.bins || []).filter(v => typeof v === 'number' && Number.isFinite(v))
                                if (validBins.length > 0) {
                                    const existing = trackChromScaleRef.current[scaleKey]
                                    const newMax = Math.max(...validBins)
                                    trackChromScaleRef.current[scaleKey] = {
                                        min: 0,
                                        max: existing ? Math.max(existing.max, newMax) : newMax,
                                    }
                                }
                            }
                            // Re-project using the latest viewport refs so a late tile
                            // response from an older zoom/pan state cannot overwrite the
                            // current view with stale block geometry.
                            const projected = projectBigWigTrackToCurrentViewport(track.id)
                            setCustomTrackData(prev => ({ ...prev, [track.id]: projected }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: projected.coverage < 0.3 }))
                        })
                        .catch(e => {
                            if (fetchEpochRef.current !== epoch) return
                            if (isTransientFetchError(e)) {
                                // Leave current cache/view intact and retry on the next viewport update.
                                trackTileCacheRef.current.delete(tileKey)
                                setCustomTrackLoading(prev => ({ ...prev, [track.id]: true }))
                                return
                            }
                            const errorMessage = getFetchErrorMessage(e)
                            trackTileCacheRef.current.set(tileKey, { start: tileStart, end: tileEnd, bpPerBin: level.bpPerBin, bins: [], has_data: false, error: errorMessage })
                            setCustomTrackData(prev => ({ ...prev, [track.id]: { ...prev[track.id], error: errorMessage } }))
                            setCustomTrackLoading(prev => ({ ...prev, [track.id]: false }))
                        })
                        .finally(() => { trackTileFetchSetRef.current.delete(tileKey) })
                }
            }
        }, 50) // 50ms debounce — only delays network requests, not rendering

        return () => {
            // Only cancel the debounce timer — do NOT cancel in-flight responses!
            clearTimeout(timer)
        }
    }, [
        customTracks,
        customTrackFetchRevision,
        chromLength,
        isActive,
        selectedChrom,
        genome,
        genomicViewRange,
        viewWidth,
        getBigWigLevel,
        getVcfLevelByBpPerPx,
        getVcfBlockLevel,
        getSpliceBlockLevel,
        getSpliceLodMode,
        getSpliceTileSpan,
        getBigBedBlockLevel,
        getBigBedLodMode,
        makeBigWigTileKey,
        makeVcfTileKey,
        makeVcfBlockTileKey,
        makeVcfAdpDetailKey,
        makeSpliceTileKey,
        makeSpliceBlockTileKey,
        makeBigBedBlockTileKey,
        makeBigBedFeatureTileKey,
        projectBigWigTilesToView,
        projectBigWigTrackToCurrentViewport,
        projectSpliceTilesToView,
        projectSpliceBlockTilesToView,
        projectBigBedBlockTilesToView,
        projectBigBedFeatureTilesToView,
        projectVcfTilesToView,
        projectVcfBlockTilesCascadeToView,
        projectVcfAdaptiveDetailLevel,
        evictOldTilesIfNeeded,
    ])


    const handleCustomTrackFilePicked = useCallback((path) => {
        setPendingCustomTrackPath(path)
        setCustomTrackLabelInput('Custom track')
        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
        setIsCustomTrackLabelModalOpen(true)
    }, [])

    const handleConfirmAddCustomTrack = useCallback(() => {
        if (!pendingCustomTrackPath) return
        const trimmedLabel = customTrackLabelInput.trim()
        if (!trimmedLabel) return
        const bigWigSettings = normalizeBigWigSettings({ data_type: 'rna_seq' })
        const id = `ct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        setCustomTracks((prev) => [...prev, {
            id,
            path: pendingCustomTrackPath,
            label: trimmedLabel,
            visible: true,
            type: 'bigwig',
            renderMode: normalizeBigWigDisplayMode(customTrackRenderModeInput, bigWigSettings.data_type),
            bigwigSettings: bigWigSettings,
        }])
        setIsCustomTrackLabelModalOpen(false)
        setPendingCustomTrackPath('')
        setCustomTrackLabelInput('Custom track')
        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
    }, [pendingCustomTrackPath, customTrackLabelInput, customTrackRenderModeInput])

    // Fetch transcripts for expanded genes
    const fetchTranscripts = useCallback(async (geneId) => {
        if (transcriptCacheRef.current[geneId]) {
            touchTranscriptCacheEntry(geneId)
            return
        }
        if (fetchingTranscriptIdsRef.current.has(geneId)) return
        const requestToken = Symbol(String(geneId))
        const requestGeneration = transcriptRequestGenerationRef.current
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingTranscriptIdsRef.current.set(geneId, requestToken)
        try {
            const params = new URLSearchParams({ genome, gene_id: String(geneId) })
            const res = await fetch(`${API_BASE}/api/browse/transcripts?${params.toString()}`, { signal: controller.signal })
            if (res.ok) {
                const data = await res.json()
                if (requestGeneration !== transcriptRequestGenerationRef.current) return
                setTranscriptCache(prev => {
                    if (prev[geneId]) {
                        touchTranscriptCacheEntry(geneId)
                        return prev
                    }
                    touchTranscriptCacheEntry(geneId)
                    const next = pruneTranscriptCacheIfNeeded({ ...prev, [geneId]: data })
                    transcriptCacheRef.current = next
                    return next
                })
            }
        } catch (e) {
            if (e?.name !== 'AbortError') console.error('Failed to fetch transcripts:', e)
        } finally {
            identityRequestControllersRef.current.delete(controller)
            if (fetchingTranscriptIdsRef.current.get(geneId) === requestToken) {
                fetchingTranscriptIdsRef.current.delete(geneId)
            }
        }
    }, [genome, pruneTranscriptCacheIfNeeded, touchTranscriptCacheEntry])

    const requestTranscriptPillFocus = useCallback((geneId, options = {}) => {
        if (!geneId) return
        pendingTranscriptPillFocusRef.current = {
            geneId,
            waitForTranscripts: Boolean(options.waitForTranscripts),
            limit: Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : null,
            preferBottomVisible: Boolean(options.preferBottomVisible),
            preserveHorizontalViewport: Boolean(options.preserveHorizontalViewport),
            skipVerticalAlign: Boolean(options.skipVerticalAlign),
            animated: false,
        }
    }, [])



    // Notify parent when the location of focus changes
    const onLocationSelectRef = useRef(onLocationSelect)
    onLocationSelectRef.current = onLocationSelect
    useEffect(() => {
        onLocationSelectRef.current?.(focusLocationRange)
    }, [focusLocationRange])

    // Notify parent when selected gene changes
    const lastSelectedGeneSignatureRef = useRef('')
    useEffect(() => {
        if (!onGeneSelectRef.current) return
        const signature = selectedGene ? [
            String(selectedGene.id || '').trim(),
            String(selectedGene.name || '').trim(),
            String(selectedGene.chrom || '').trim(),
            Number.isFinite(Number(selectedGene.start)) ? Number(selectedGene.start) : '',
            Number.isFinite(Number(selectedGene.end)) ? Number(selectedGene.end) : '',
            String(selectedGene.strand || '').trim(),
        ].join('|') : ''
        if (signature === lastSelectedGeneSignatureRef.current) return
        lastSelectedGeneSignatureRef.current = signature
        onGeneSelectRef.current(selectedGene)
    }, [selectedGene])

    // The drawer needs the focused gene's transcripts whatever the zoom level,
    // but the viewport prefetch below only runs once transcript detail is in
    // range. Ask for them directly so focusing from a wide view still fills it.
    //
    // Keyed on the cache as well as the gene, so this heals itself. The cache is
    // emptied wholesale whenever the genome, chromosome or reload epoch changes;
    // watching the gene id alone meant a wipe that left the same gene focused
    // never re-fetched, and the drawer listed no transcripts from then on.
    useEffect(() => {
        if (!selectedGene?.id) return
        if (transcriptCache[selectedGene.id]) return
        fetchTranscripts(selectedGene.id)
    }, [selectedGene?.id, transcriptCache, fetchTranscripts])

    // Navigate to a gene from external trigger
    const lastNavigateRef = useRef(null)
    useEffect(() => {
        if (!navigateToGene || navigateToGene === lastNavigateRef.current) return
        lastNavigateRef.current = navigateToGene
        const {
            chrom,
            start,
            end,
            strand,
            name,
            id,
            windowStart,
            windowEnd,
            centerVertically,
        } = navigateToGene
        const chromName = String(chrom || '').trim()
        const numericStart = Number(start)
        const numericEnd = Number(end)
        if (!chromName || !Number.isFinite(numericStart) || !Number.isFinite(numericEnd)) {
            // Ignore partial focus payloads (e.g. id/symbol only) until resolved coordinates are available.
            return
        }
        const geneStart = Math.min(numericStart, numericEnd)
        const geneEnd = Math.max(numericStart, numericEnd)

        const regionForChrom = regions.find((r) => r.chrom === chromName) || null
        // Switch region if needed
        if (chromName !== selectedChrom) {
            setSelectedChrom(chromName)
            if (regionForChrom) setChromLength(regionForChrom.end)
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
        }

        let nextStart
        let nextEnd
        if (Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowEnd > windowStart) {
            nextStart = windowStart
            nextEnd = windowEnd
        } else {
            const padding = Math.max(100, (geneEnd - geneStart) * 0.5)
            nextStart = geneStart - padding
            nextEnd = geneEnd + padding
        }

        // Navigating here focuses the gene, which slides the drawer over this
        // panel's right edge — so aim for the middle of what stays visible.
        const framedNav = frameRangeWithRightInset({
            start: nextStart,
            end: nextEnd,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            rightInsetPx: focusDrawerInsetOnFocus,
            flipped: isFlipped,
        })
        if (framedNav) {
            nextStart = framedNav.start
            nextEnd = framedNav.end
        }

        if (!isAligned) {
            const maxEnd = Math.max(2, regionForChrom?.end || chromLength || 1e9)
            const minStart = 1
            let span = Math.max(1, nextEnd - nextStart)
            if (span >= (maxEnd - minStart)) {
                nextStart = minStart
                nextEnd = maxEnd
            } else {
                nextStart = Math.max(minStart, nextStart)
                nextEnd = nextStart + span
                if (nextEnd > maxEnd) {
                    nextEnd = maxEnd
                    nextStart = Math.max(minStart, nextEnd - span)
                }
            }
        }

        pendingVerticalCenterGeneIdRef.current = centerVertically ? id : null
        setViewStart(nextStart)
        setViewEnd(nextEnd)
        setSelectedGene({ chrom: chromName, start: geneStart, end: geneEnd, strand, name, id })
    }, [navigateToGene, selectedChrom, regions, isAligned, chromLength, focusDrawerInsetOnFocus, isFlipped])

    /* An outside request to go to a region and focus it.
     *
     * Compared by identity rather than by coordinates, so asking for the same
     * region twice still moves the browser — the caller mints a new object each
     * time, exactly as the gene path above does. */
    const lastNavigateLocationRef = useRef(null)
    // Read by the regions fetch below, which otherwise drops the panel on this
    // genome's default locus the moment it lands — after this effect has already
    // framed the region the reader asked for.
    const pendingLocationNavigateRef = useRef(false)
    pendingLocationNavigateRef.current = Boolean(
        navigateToLocation && navigateToLocation !== lastNavigateLocationRef.current
    )
    useEffect(() => {
        if (!navigateToLocation || navigateToLocation === lastNavigateLocationRef.current) return
        // Held, not dropped: without the region list there is no chromosome to
        // resolve against or clamp to, so this runs again when the regions land.
        if (regions.length === 0) return
        lastNavigateLocationRef.current = navigateToLocation
        pendingLocationNavigateRef.current = false
        const range = getFocusLocationRange(navigateToLocation)
        if (!range) return

        if (!isSameChromToken(range.chrom, selectedChrom)) {
            const regionForChrom = regions.find((region) => isSameChromToken(region.chrom, range.chrom)) || null
            setSelectedChrom(regionForChrom?.chrom || range.chrom)
            if (regionForChrom) setChromLength(regionForChrom.end)
            setGenes([])
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
        }

        // Framed like every other focus, so the boundary lines land inside the
        // view. Clamped against the region the way the gene path above does,
        // rather than through clampView, which is not declared until later.
        const span = Math.max(1, range.end - range.start)
        const flank = Math.max(1, (span / FOCUS_RANGE_FILL_FRACTION - span) / 2)
        const region = regions.find((candidate) => isSameChromToken(candidate.chrom, range.chrom)) || null
        const maxEnd = Math.max(2, region?.end || chromLength || range.end + flank)
        const unframedStart = range.start - flank
        const unframedEnd = range.end + flank
        // External location requests can arrive before the drawer exists, so
        // focusDrawerInset is still zero. Anticipate the primary drawer exactly
        // as gene focus does; the secondary detail/notes panes deliberately do
        // not contribute to this inset.
        const framed = frameRangeWithRightInset({
            start: unframedStart,
            end: unframedEnd,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            // If a primary drawer is already present, frame for its current
            // open/rail state and let the inset-change effect handle any toggle.
            // With no drawer yet, anticipate the one this focus will open.
            rightInsetPx: focusDrawerInset || focusDrawerInsetOnFocus,
            flipped: isFlipped,
        })
        const nextStart = Math.max(1, framed?.start ?? unframedStart)
        let nextEnd = Math.min(maxEnd, framed?.end ?? unframedEnd)
        if (nextEnd <= nextStart) nextEnd = nextStart + 1
        setViewStart(nextStart)
        setViewEnd(nextEnd)
        focusLocation(range)
        if (onManualNavigate) onManualNavigate()
    }, [navigateToLocation, selectedChrom, regions, chromLength, focusLocation, onManualNavigate, focusDrawerInset, focusDrawerInsetOnFocus, isFlipped])

    useEffect(() => {
        if (clearFocusEpoch <= 0) return
        setSelectedGene(null)
        setSelectedLocation(null)
    }, [clearFocusEpoch])

    // ============ Coordinate Helpers ============

    const viewSpan = viewEnd - viewStart
    const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)
    const bpPerPx = viewSpan / trackWidth
    const isTranscriptDetailZoomActive = viewSpan <= TRANSCRIPT_DETAIL_VIEWSPAN_BP
    const visibleTranscriptGeneIds = useMemo(() => {
        const ids = []
        const seen = new Set()
        for (const gene of genes) {
            if (!gene?.id || isGeneHiddenFromTracks(gene)) continue
            if (gene.strand === '+' && effectiveHiddenStrands.forward) continue
            if (gene.strand === '-' && effectiveHiddenStrands.reverse) continue
            const id = String(gene.id)
            if (seen.has(id)) continue
            seen.add(id)
            ids.push(id)
        }
        return ids
    }, [genes, isGeneHiddenFromTracks, effectiveHiddenStrands])
    const shouldRenderTranscriptStructures = useMemo(() => (
        shouldRenderViewportTranscriptStructures({
            viewSpan,
            detailMaxSpan: TRANSCRIPT_DETAIL_VIEWSPAN_BP,
            geneIds: visibleTranscriptGeneIds,
            transcriptCache,
        })
    ), [viewSpan, visibleTranscriptGeneIds, transcriptCache])
    const isTranscriptCompressionActive = compressTranscripts && isTranscriptDetailZoomActive
    const shouldForceGeneBlockView = !shouldRenderTranscriptStructures
    const isCompressedLayoutActive = compressTranscripts
    const transcriptLayoutMetrics = useMemo(
        () => getTranscriptLayoutMetrics(isCompressedLayoutActive, flattenTracks),
        [isCompressedLayoutActive, flattenTracks]
    )

    const bufferedTranscriptExpandGenes = useMemo(() => {
        if (!isViewportTranscriptExpandMode || !selectedChrom) {
            return []
        }
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const result = collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
        const candidatesById = new Map()
        for (const gene of [...(Array.isArray(result?.genes) ? result.genes : []), ...genes]) {
            const geneId = String(gene?.id || '').trim()
            if (geneId && !candidatesById.has(geneId)) candidatesById.set(geneId, gene)
        }
        const candidates = Array.from(candidatesById.values())
        if (candidates.length <= MAX_TRANSCRIPT_PREFETCH_GENES) {
            return candidates
        }
        const viewCenter = (viewGStart + viewGEnd) / 2
        return candidates
            .slice()
            .sort((a, b) => {
                const aCenter = (Number(a?.start || 0) + Number(a?.end || 0)) / 2
                const bCenter = (Number(b?.start || 0) + Number(b?.end || 0)) / 2
                return Math.abs(aCenter - viewCenter) - Math.abs(bCenter - viewCenter)
            })
            .slice(0, MAX_TRANSCRIPT_PREFETCH_GENES)
    }, [isViewportTranscriptExpandMode, selectedChrom, genomicViewRange, collectCachedGenesInRange, genes])

    const bufferedTranscriptExpandGeneIds = useMemo(() => {
        const ids = new Set()
        for (const gene of bufferedTranscriptExpandGenes) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) ids.add(geneId)
        }
        return ids
    }, [bufferedTranscriptExpandGenes])

    // Ordering and hidden transcripts belong to the gene, not to the act of
    // focusing it: what the user set up stays on screen after they unfocus. Only
    // the transient bits — the hover highlight and its ghost — are focus-only.
    const focusViewGeneId = String(focusTranscriptView?.geneId || '').trim()
    const getGeneTranscriptView = useCallback((geneId) => {
        const id = String(geneId || '').trim()
        if (!id) return null
        const stored = geneTranscriptViews?.[id] || null
        if (id !== focusViewGeneId) return stored
        return { ...(stored || {}), ...(focusTranscriptView || {}) }
    }, [geneTranscriptViews, focusTranscriptView, focusViewGeneId])

    const getFocusViewForGene = useCallback((geneId) => {
        if (!focusViewGeneId) return null
        return String(geneId || '').trim() === focusViewGeneId ? focusTranscriptView : null
    }, [focusTranscriptView, focusViewGeneId])

    const getEffectiveTranscriptLimit = useCallback((geneId, txs) => {
        if (!txs || txs.length === 0) return 1
        if (isTranscriptCompressionActive) return txs.length
        if (shouldForceGeneBlockView) return 1
        // `expanded: null` means the drawer has not taken a view yet — a gene the
        // user expanded from the canvas keeps that expansion when it gains focus.
        const focusView = getFocusViewForGene(geneId)
        if (focusView && focusView.expanded != null) return focusView.expanded ? txs.length : 1
        if (isViewportTranscriptExpandMode && bufferedTranscriptExpandGeneIds.has(String(geneId))) {
            return txs.length
        }
        return expandedGenes[geneId] || 1
    }, [expandedGenes, isTranscriptCompressionActive, shouldForceGeneBlockView, isViewportTranscriptExpandMode, bufferedTranscriptExpandGeneIds, getFocusViewForGene])

    // The single seam every visual consumer shares: row packing, drawing,
    // hit-testing and footer geometry all read their rows from here, so they
    // cannot disagree about how many rows a gene occupies or what is in them.
    const getDisplayTranscriptRows = useCallback((gene) => {
        const txs = transcriptCache[gene.id]
        if (shouldForceGeneBlockView || !txs || txs.length === 0) {
            return []
        }
        const geneView = getGeneTranscriptView(gene.id)
        return resolveGeneTranscriptView({
            transcripts: txs,
            limit: getEffectiveTranscriptLimit(gene.id, txs),
            order: geneView?.order,
            hidden: geneView?.hidden,
            ghostId: geneView?.ghostId,
        }).rows
    }, [transcriptCache, shouldForceGeneBlockView, getEffectiveTranscriptLimit, getGeneTranscriptView])

    // Ghost rows are a hover preview, not content: anything that reasons about
    // what the gene actually shows (viewport fitting, chevron alignment) uses
    // this instead.
    const getDisplayTranscriptsForGene = useCallback((gene) => (
        getDisplayTranscriptRows(gene).filter((row) => !row.ghost).map((row) => row.transcript)
    ), [getDisplayTranscriptRows])

    const getGeneRowCountForWidth = useCallback((gene) => (
        Math.max(1, getDisplayTranscriptRows(gene).length || 1)
    ), [getDisplayTranscriptRows])

    // Feed the focus drawer: the gene plus whatever transcripts we have for it.
    useEffect(() => {
        if (!onFocusTranscriptsChangeRef.current) return
        if (!selectedGene?.id) {
            onFocusTranscriptsChangeRef.current(null)
            return
        }
        const cached = transcriptCache[selectedGene.id]
        onFocusTranscriptsChangeRef.current({
            gene: selectedGeneForVisibility || selectedGene,
            transcripts: Array.isArray(cached) ? cached : [],
            loading: !cached,
            // What the panel is actually showing, so a drawer that has not taken
            // a view of this gene yet renders the expansion already on screen.
            expanded: Boolean(cached) && getEffectiveTranscriptLimit(selectedGene.id, cached) > 1,
        })
    }, [selectedGene, selectedGeneForVisibility, transcriptCache, getEffectiveTranscriptLimit])

    // Once the drawer takes an explicit view, mirror it into the panel's own
    // expand map so unfocusing the gene leaves it as the user last had it.
    const lastDrawerExpandRef = useRef(null)
    useEffect(() => {
        const geneId = focusViewGeneId
        const expanded = focusTranscriptView?.expanded
        if (!geneId || expanded == null) {
            lastDrawerExpandRef.current = null
            return
        }
        const txs = transcriptCacheRef.current[geneId]
        const limit = expanded ? Math.max(1, txs?.length || 1) : 1
        setExpandedGenes((prev) => (prev[geneId] === limit ? prev : { ...prev, [geneId]: limit }))

        // Expanding from the drawer should bring the gene into view exactly as
        // the canvas pill does, rather than leaving the new rows off-screen.
        const signature = `${geneId}:${expanded}`
        if (lastDrawerExpandRef.current === signature) return
        const isFirstSight = lastDrawerExpandRef.current === null
        lastDrawerExpandRef.current = signature
        if (isFirstSight || !expanded) return
        requestTranscriptPillFocus(geneId, {
            limit: Math.max(1, txs?.length || 1),
            waitForTranscripts: !txs,
            preferBottomVisible: false,
            preserveHorizontalViewport: true,
        })
    }, [focusViewGeneId, focusTranscriptView?.expanded, transcriptCache, requestTranscriptPillFocus])

    const getGeneTotalHeight = useCallback((rowCount) => {
        const footerOverflow = isCompressedLayoutActive
            ? 0
            : geneFooterTrackOverflow(transcriptLayoutMetrics, flattenTracks)
        return (
            rowCount * transcriptLayoutMetrics.rowPitch
            - transcriptLayoutMetrics.rowGap
            + footerOverflow
        )
    }, [transcriptLayoutMetrics, isCompressedLayoutActive, flattenTracks])

    const clearTranscriptPopupDismissTimer = useCallback(() => {
        if (transcriptPopupDismissTimerRef.current) {
            clearTimeout(transcriptPopupDismissTimerRef.current)
            transcriptPopupDismissTimerRef.current = null
        }
    }, [])

    const dismissClickedGeneTranscript = useCallback(() => {
        clearTranscriptPopupDismissTimer()
        transcriptPopupHoverRef.current = false
        setClickedGeneTranscript(null)
    }, [clearTranscriptPopupDismissTimer])

    const scheduleTranscriptPopupDismiss = useCallback((delayMs = 140) => {
        clearTranscriptPopupDismissTimer()
        transcriptPopupDismissTimerRef.current = setTimeout(() => {
            transcriptPopupDismissTimerRef.current = null
            if (!transcriptPopupHoverRef.current) {
                setClickedGeneTranscript(null)
            }
        }, delayMs)
    }, [clearTranscriptPopupDismissTimer])

    useEffect(() => {
        if (!selectedGene || !selectedGeneHiddenByBiotype) return
        dismissClickedGeneTranscript()
        setSelectedGene(null)
    }, [selectedGene, selectedGeneHiddenByBiotype, dismissClickedGeneTranscript])

    useEffect(() => {
        if (!selectedGene?.id) {
            dismissClickedGeneTranscript()
            return
        }
        setClickedGeneTranscript((prev) => {
            if (!prev) return prev
            return prev.geneId === selectedGene.id ? prev : null
        })
    }, [selectedGene, dismissClickedGeneTranscript])

    const genomicToScreen = useCallback((genomicPos) => {
        const overlayPos = genomicToOverlay(genomicPos)

        if (isFlipped) {
            return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
        }
        return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
    }, [viewStart, viewEnd, bpPerPx, genomicToOverlay, isFlipped])

    const screenToGenomic = useCallback((screenX) => {
        const overlayPos = isFlipped
            ? viewEnd - (screenX - LHS_WIDTH) * bpPerPx
            : viewStart + (screenX - LHS_WIDTH) * bpPerPx

        return overlayToGenomic(overlayPos)
    }, [viewStart, viewEnd, bpPerPx, isFlipped, overlayToGenomic])

    const overlayToScreen = useCallback((overlayPos) => {
        if (isFlipped) {
            return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
        }
        return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
    }, [viewEnd, viewStart, bpPerPx, isFlipped])

    const selectedGeneLayoutEntry = useMemo(() => {
        if (!selectedGene?.id || selectedGeneHiddenByBiotype) return null
        return genes.find((gene) => gene?.id === selectedGene.id) || null
    }, [genes, selectedGene, selectedGeneHiddenByBiotype])

    // Compute shared, rounded base-cell boundaries so adjacent bases always
    // share edges exactly (prevents tiny scrolling gaps from float drift).
    const getBasePixelBounds = useCallback((overlayBaseStart, pxPerBpValue) => {
        const rawPx = Number.isFinite(pxPerBpValue) && pxPerBpValue > 0 ? pxPerBpValue : (1 / Math.max(1e-9, bpPerPx))
        // At base-level zoom, snap px to the nearest integer so every panel places bases
        // at identical pixel offsets (LHS_WIDTH + n*px) regardless of tiny viewWidth or
        // span differences — gives a hard grid for cross-panel alignment and no drift.
        const px = rawPx >= 4 ? Math.round(rawPx) : rawPx
        let x1
        let x2
        if (isFlipped) {
            x1 = LHS_WIDTH + (viewEnd - (overlayBaseStart + 1)) * px
            x2 = LHS_WIDTH + (viewEnd - overlayBaseStart) * px
        } else {
            x1 = LHS_WIDTH + (overlayBaseStart - viewStart) * px
            x2 = LHS_WIDTH + ((overlayBaseStart + 1) - viewStart) * px
        }
        const bxL = Math.round(Math.min(x1, x2))
        const bxR = Math.round(Math.max(x1, x2))
        return { bxL, bxR, bxW: Math.max(1, bxR - bxL) }
    }, [bpPerPx, isFlipped, viewEnd, viewStart])

    const getGenomicIntervalPixelBounds = useCallback((genomicStart, genomicEnd, pxPerBpValue, snapToBaseGrid = false) => {
        const start = Math.round(Number(genomicStart))
        const end = Math.round(Number(genomicEnd))
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null
        const lo = Math.min(start, end)
        const hi = Math.max(start, end)
        if (hi < lo) return null

        if (snapToBaseGrid) {
            const startBounds = getBasePixelBounds(genomicToOverlay(lo), pxPerBpValue)
            const endBounds = getBasePixelBounds(genomicToOverlay(hi), pxPerBpValue)
            const x1 = Math.min(startBounds.bxL, endBounds.bxL)
            const x2 = Math.max(startBounds.bxR, endBounds.bxR)
            return { x1, x2, width: Math.max(1, x2 - x1) }
        }

        const overlayStart = genomicToOverlay(lo)
        const overlayEndExclusive = genomicToOverlay(hi) + 1
        const x1 = overlayToScreen(overlayStart)
        const x2 = overlayToScreen(overlayEndExclusive)
        const left = Math.min(x1, x2)
        const right = Math.max(x1, x2)
        return { x1: left, x2: right, width: Math.max(0, right - left) }
    }, [getBasePixelBounds, genomicToOverlay, overlayToScreen])

    // ============ Resize Observer ============

    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setViewWidth(entry.contentRect.width)
                setViewHeight(Math.max(160, entry.contentRect.height))
            }
        })
        ro.observe(container)
        return () => ro.disconnect()
    }, [])

    // ============ Zoom & Pan Handlers ============

    const MIN_VIEW_SPAN = 50      // Minimum bp visible (max zoom in)
    const MAX_VIEW_SPAN = 50000000 // Maximum bp visible (max zoom out)

    // Momentum is a short flick, not a glide: at 0.95 the view kept travelling for
    // roughly a second after release, which reads as the tracks lagging the cursor.
    const MOMENTUM_FRICTION = 0.86
    const MIN_VELOCITY = 0.5
    // Ignore stale velocity: releasing after the cursor has settled must not fling.
    const MOMENTUM_MAX_IDLE_MS = 60

    // Use refs to avoid stale closures
    const viewStartRef = useRef(viewStart)
    const viewEndRef = useRef(viewEnd)
    const pendingInteractiveViewportRef = useRef(null)
    const interactiveViewportFrameRef = useRef(null)
    viewStartRef.current = pendingInteractiveViewportRef.current?.start ?? viewStart
    viewEndRef.current = pendingInteractiveViewportRef.current?.end ?? viewEnd

    // What the genome says is worth looking at on this region, if it says anything.
    const browsableRange = useMemo(() => {
        const region = regions.find((candidate) => candidate.chrom === selectedChrom)
        const start = Number(region?.browsable_start)
        const end = Number(region?.browsable_end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
        return { start, end }
    }, [regions, selectedChrom])

    const clampView = useCallback((start, end) => {
        let span = end - start

        if (isAligned && alignData) {
            span = Math.max(1, span);
            // In alignment mode, allow panning beyond the aligned block to inspect
            // surrounding genomic context. Coordinates are mapped via overlay helpers.
            return [start, start + span]
        }

        // Clamp to chromosome bounds — or, where the genome declares one, to the part of
        // the region worth looking at. Only the tutorial's chromosome-1 slice does: it is
        // a real chromosome coordinate space holding a small window of real sequence, and
        // without this you can pan and zoom out into a hundred megabases of padding,
        // which reads as the browser being broken rather than as the edge of a slice.
        const minStart = Math.max(1, browsableRange?.start || 1);
        const maxEnd = Math.max(minStart + 1, browsableRange?.end || chromLength || 1e9);
        span = Math.max(1, span);

        if (span >= (maxEnd - minStart)) return [minStart, maxEnd];

        start = Math.max(minStart, start);
        end = start + span;
        if (end > maxEnd) {
            end = maxEnd;
            start = end - span;
        }
        return [Math.max(minStart, start), Math.min(maxEnd, end)]
    }, [browsableRange, chromLength, isAligned, alignData])

    const scheduleInteractiveViewport = useCallback((start, end, targetTrack = undefined, anchorRatio = undefined) => {
        // Update refs immediately so multiple input events in one frame accumulate
        // from the latest viewport rather than the last committed React render.
        viewStartRef.current = start
        viewEndRef.current = end
        pendingInteractiveViewportRef.current = { start, end, targetTrack, anchorRatio }
        if (interactiveViewportFrameRef.current !== null) return
        interactiveViewportFrameRef.current = requestAnimationFrame(() => {
            interactiveViewportFrameRef.current = null
            const pending = pendingInteractiveViewportRef.current
            pendingInteractiveViewportRef.current = null
            if (!pending) return
            setViewStart(pending.start)
            setViewEnd(pending.end)
            if (onPositionChange) {
                onPositionChange(
                    selectedChrom,
                    pending.start,
                    pending.end,
                    pending.targetTrack,
                    pending.anchorRatio,
                )
            }
        })
    }, [onPositionChange, selectedChrom])

    useEffect(() => () => {
        if (interactiveViewportFrameRef.current !== null) {
            cancelAnimationFrame(interactiveViewportFrameRef.current)
            interactiveViewportFrameRef.current = null
        }
        pendingInteractiveViewportRef.current = null
    }, [])

    const getGeneDisplayBounds = useCallback((gene, options = {}) => {
        if (!gene) return null
        const fallbackRange = getGeneCoordRange(gene)
        const txs = transcriptCacheRef.current[gene.id]
        const effectiveLimit = getEffectiveTranscriptLimit(gene.id, txs)
        const limit = Math.max(1, Number(options.limit ?? effectiveLimit ?? 1))
        const geneView = getGeneTranscriptView(gene.id)
        // No ghost here: the viewport must never fit itself to a hover preview.
        const displayTxs = resolveGeneTranscriptView({
            transcripts: txs,
            limit,
            order: geneView?.order,
            hidden: geneView?.hidden,
        }).transcripts

        if (displayTxs.length === 0) {
            if (!fallbackRange) return null
            return { ...fallbackRange, displayTxs: [], limit }
        }

        let minStart = Number.POSITIVE_INFINITY
        let maxEnd = Number.NEGATIVE_INFINITY
        for (const tx of displayTxs) {
            const txStart = Number(tx?.start)
            const txEnd = Number(tx?.end)
            if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) continue
            minStart = Math.min(minStart, txStart, txEnd)
            maxEnd = Math.max(maxEnd, txStart, txEnd)
        }

        if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
            if (!fallbackRange) return null
            return { ...fallbackRange, displayTxs, limit }
        }

        return { start: minStart, end: maxEnd, displayTxs, limit }
    }, [getEffectiveTranscriptLimit, getGeneTranscriptView])

    // Every "put this gene on screen" path runs through here, so the drawer only
    // has to be accounted for once.
    const frameFocusRange = useCallback((start, end, options = {}) => {
        const framed = frameRangeWithRightInset({
            start,
            end,
            trackWidthPx: Math.max(1, viewWidth - LHS_WIDTH),
            rightInsetPx: options.gainingFocus ? focusDrawerInsetOnFocus : focusDrawerInset,
            flipped: isFlipped,
        })
        return framed || { start, end }
    }, [viewWidth, focusDrawerInset, focusDrawerInsetOnFocus, isFlipped])

    const getGeneFocusViewport = useCallback((gene, options = {}) => {
        const bounds = getGeneDisplayBounds(gene, options)
        if (!bounds) return null

        const coordsForView = getFeatureCoordsForView(bounds.start, bounds.end, isAligned, alignData, genomicToOverlay)
        if (!coordsForView) return null

        const featureSpan = Math.max(1, coordsForView.end - coordsForView.start)
        const paddedSpan = Math.max(1, featureSpan / 0.8)
        const midpoint = (coordsForView.start + coordsForView.end) / 2
        const framed = frameFocusRange(midpoint - paddedSpan / 2, midpoint + paddedSpan / 2)
        return { start: framed.start, end: framed.end, bounds }
    }, [getGeneDisplayBounds, isAligned, alignData, genomicToOverlay, frameFocusRange])

    // Pan by pixel delta
    const panByPx = useCallback((dx) => {
        // A tutorial step can hold the view still while leaving zooming alone. Guarded
        // here rather than at each gesture because dragging, the wheel, the arrow keys and
        // the momentum fling all arrive through this one function — and `animateToView`
        // deliberately does not, so a step can still put the view where it wants it.
        if (interactionModeRef.current === 'zoom-only') return
        if (onManualNavigate) onManualNavigate()
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const currentSpan = currentEnd - currentStart
        const currentTrackWidth = Math.max(1, viewWidth - LHS_WIDTH)
        const currentPerPx = currentSpan / currentTrackWidth
        const dBp = isFlipped ? -dx * currentPerPx : dx * currentPerPx
        let [newStart, newEnd] = clampView(currentStart + dBp, currentEnd + dBp)

        // At base-level zoom, snap to integer positions so bases align between tracks
        const span = newEnd - newStart
        if (span <= 1000) {
            const snappedStart = Math.round(newStart)
            newEnd = snappedStart + span
            newStart = snappedStart
                ;[newStart, newEnd] = clampView(newStart, newEnd)
        }

        scheduleInteractiveViewport(newStart, newEnd)
    }, [viewWidth, clampView, isFlipped, onManualNavigate, scheduleInteractiveViewport])

    // Momentum animation
    const startMomentum = useCallback(() => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current)
        const idleMs = performance.now() - lastTimeRef.current
        let vel = idleMs > MOMENTUM_MAX_IDLE_MS ? 0 : velocityRef.current
        velocityRef.current = 0

        const animate = () => {
            if (Math.abs(vel) < MIN_VELOCITY) {
                animationRef.current = null
                return
            }
            panByPx(vel)
            vel *= MOMENTUM_FRICTION
            animationRef.current = requestAnimationFrame(animate)
        }

        if (Math.abs(vel) > MIN_VELOCITY) {
            animationRef.current = requestAnimationFrame(animate)
        }
    }, [panByPx])

    // Smoothly transition the viewport to a target range in fixed time.
    const animateToView = useCallback((targetStart, targetEnd, durationMs = 1000) => {
        const [finalStart, finalEnd] = clampView(targetStart, targetEnd)
        const initialStart = viewStartRef.current
        const initialEnd = viewEndRef.current

        if (Math.abs(finalStart - initialStart) < 1e-6 && Math.abs(finalEnd - initialEnd) < 1e-6) {
            return
        }

        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }
        velocityRef.current = 0

        const startTime = performance.now()
        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

        const tick = (now) => {
            const rawT = Math.min(1, (now - startTime) / durationMs)
            const t = easeOutCubic(rawT)

            let nextStart = initialStart + (finalStart - initialStart) * t
            let nextEnd = initialEnd + (finalEnd - initialEnd) * t
                ;[nextStart, nextEnd] = clampView(nextStart, nextEnd)

            viewStartRef.current = nextStart
            viewEndRef.current = nextEnd
            setViewStart(nextStart)
            setViewEnd(nextEnd)

            if (onPositionChange) {
                onPositionChange(selectedChrom, nextStart, nextEnd)
            }

            if (rawT < 1) {
                animationRef.current = requestAnimationFrame(tick)
            } else {
                animationRef.current = null
            }
        }

        animationRef.current = requestAnimationFrame(tick)
    }, [clampView, onPositionChange, selectedChrom])

    const screenToViewCoord = useCallback((screenX) => {
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const currentSpan = currentEnd - currentStart
        const trackW = Math.max(1, viewWidth - LHS_WIDTH)
        const clampedX = Math.max(LHS_WIDTH, Math.min(viewWidth, screenX))
        const ratio = Math.max(0, Math.min(1, (clampedX - LHS_WIDTH) / trackW))
        return isFlipped
            ? currentEnd - ratio * currentSpan
            : currentStart + ratio * currentSpan
    }, [viewWidth, isFlipped])

    // ============ Layout computation ============
    const layout = useMemo(() => {
        const trackWidthPx = Math.max(1, viewWidth - LHS_WIDTH)
        const pxToBp = viewSpan / trackWidthPx
        const minGapBp = 0 // Fixed to 0 to prevent vertical jumping of tracks during zoom
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const bucketStep = Math.max(GENE_LAYOUT_BUCKET_MIN_STEP, viewSpan * 0.25)
        const layoutCenter = (layoutStart + layoutEnd) / 2
        const layoutBucket = Math.floor(layoutCenter / bucketStep)
        const zoomBucket = Math.round(Math.log2(Math.max(1e-9, pxToBp)) * 16) / 16

        let enableSubtracks = geneSubtrackStateRef.current
        if (flattenTracks) {
            enableSubtracks = true
        } else if (enableSubtracks) {
            if (viewSpan >= GENE_SUBTRACK_DISABLE_BP) enableSubtracks = false
        } else if (viewSpan <= GENE_SUBTRACK_ENABLE_BP) {
            enableSubtracks = true
        }
        geneSubtrackStateRef.current = enableSubtracks

        // Skipped outright when nothing is hidden: this runs over every gene in
        // the layout window on every frame of a zoom.
        const anythingHidden = hiddenBiotypeClasses.length > 0 || hiddenGeneIdSet.size > 0
        const biotypeFilter = anythingHidden
            ? (g) => !isGeneHiddenFromTracks(g)
            : () => true

        const geneOverlapsCurrentWindow = (gene) => {
            const start = Number(gene?.start)
            const end = Number(gene?.end)
            if (!Number.isFinite(start) || !Number.isFinite(end)) return false
            return Math.max(start, end) >= viewGStart && Math.min(start, end) <= viewGEnd
        }
        const displayGeneSource = flattenTracks
            ? genes.filter(geneOverlapsCurrentWindow)
            : genes

        const forwardGenes = effectiveHiddenStrands.forward
            ? []
            : displayGeneSource.filter(g => g.strand === '+').filter(biotypeFilter)
        const reverseGenes = effectiveHiddenStrands.reverse
            ? []
            : displayGeneSource.filter(g => g.strand === '-').filter(biotypeFilter)

        const layoutGenesResult = flattenTracks
            ? { genes: displayGeneSource, coverage: 1 }
            : (selectedChrom
                ? collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
                : { genes, coverage: 1 })
        const layoutCoverage = Number(layoutGenesResult?.coverage || 0)
        const layoutGenesAll = Array.isArray(layoutGenesResult?.genes) ? layoutGenesResult.genes : genes
        const forwardLayoutGenes = effectiveHiddenStrands.forward
            ? []
            : layoutGenesAll.filter(g => g.strand === '+').filter(biotypeFilter)
        const reverseLayoutGenes = effectiveHiddenStrands.reverse
            ? []
            : layoutGenesAll.filter(g => g.strand === '-').filter(biotypeFilter)

        // Rows are whatever gets drawn, including the hover ghost — that is what
        // makes previewing a hidden transcript push the rows below it down.
        // A gene with everything hidden still claims one row for its block glyph.
        const getGeneRowSpan = (gene) => Math.max(1, getDisplayTranscriptRows(gene).length || 1)

        const stabilizeRowCount = (strandKey, requiredRows) => {
            const safeRequired = Math.max(1, requiredRows)
            const prevSticky = Math.max(1, Number(geneRowStickyRef.current[strandKey] || 1))
            let nextSticky = safeRequired
            if (safeRequired > prevSticky) {
                nextSticky = safeRequired
                geneRowShrinkBucketRef.current[strandKey] = layoutBucket
            } else if (safeRequired < prevSticky) {
                if (layoutCoverage >= GENE_LAYOUT_COVERAGE_SHRINK_THRESHOLD) {
                    const lastShrinkBucket = geneRowShrinkBucketRef.current[strandKey]
                    if (lastShrinkBucket !== layoutBucket) {
                        nextSticky = Math.max(safeRequired, prevSticky - 1)
                        geneRowShrinkBucketRef.current[strandKey] = layoutBucket
                    } else {
                        nextSticky = prevSticky
                    }
                } else {
                    nextSticky = prevSticky
                }
            } else {
                nextSticky = prevSticky
            }
            geneRowStickyRef.current[strandKey] = nextSticky
            return nextSticky
        }

        const calculateRows = (strandKey, visibleStrandGenes, layoutStrandGenes) => {
            if (!enableSubtracks) {
                let maxRows = 1
                visibleStrandGenes.forEach(gene => {
                    gene._row = 0
                    maxRows = Math.max(maxRows, getGeneRowSpan(gene))
                })
                geneRowStickyRef.current[strandKey] = Math.max(1, maxRows)
                geneRowShrinkBucketRef.current[strandKey] = layoutBucket
                return maxRows
            }

            const sorted = [...layoutStrandGenes].sort((a, b) => {
                if (a.start !== b.start) return a.start - b.start
                if (a.end !== b.end) return a.end - b.end
                return String(a.id).localeCompare(String(b.id))
            })
            const filterHash = hiddenBiotypeClasses.slice().sort().join(',')
            // Row span is the packer's only transcript-derived input, so keying on
            // it is exact: expanding, hiding a transcript, or hovering a ghost all
            // move it and invalidate the cache, and nothing else needs to.
            const signature = sorted.map((gene) => {
                const txCount = transcriptCache[gene.id]?.length || 0
                return `${gene.id}:${gene.start}:${gene.end}:tx${txCount}:rows${getGeneRowSpan(gene)}`
            }).join('|')
            const packingKey = [
                selectedChrom || '',
                strandKey,
                String(layoutBucket),
                String(zoomBucket),
                enableSubtracks ? '1' : '0',
                isTranscriptCompressionActive ? 'compressed' : 'normal',
                flattenTracks ? 'flattened' : 'standard',
                filterHash,
                signature,
            ].join('|')

            const packedCache = geneLayoutPackCacheRef.current[strandKey]
            let rowMap
            let requiredRows
            if (packedCache && packedCache.key === packingKey) {
                rowMap = packedCache.rowMap
                requiredRows = packedCache.requiredRows
            } else {
                const rows = []
                rowMap = new Map()
                sorted.forEach(gene => {
                    const rowCount = getGeneRowSpan(gene)
                    let targetRow = 0
                    while (true) {
                        let allFree = true
                        for (let r = targetRow; r < targetRow + rowCount; r++) {
                            if (rows[r] !== undefined && gene.start < rows[r] + minGapBp) {
                                allFree = false
                                break
                            }
                        }
                        if (allFree) break
                        targetRow++
                    }

                    rowMap.set(gene.id, targetRow)
                    for (let r = targetRow; r < targetRow + rowCount; r++) {
                        rows[r] = Math.max(rows[r] || 0, gene.end)
                    }
                })
                requiredRows = Math.max(1, rows.length || 1)
                geneLayoutPackCacheRef.current[strandKey] = {
                    key: packingKey,
                    rowMap,
                    requiredRows,
                }
            }

            visibleStrandGenes.forEach((gene) => {
                gene._row = rowMap.get(gene.id) ?? 0
            })
            if (flattenTracks) {
                return requiredRows
            }
            return stabilizeRowCount(strandKey, requiredRows)
        }

        const maxRowForward = effectiveHiddenStrands.forward ? 0 : calculateRows('forward', forwardGenes, forwardLayoutGenes)
        const maxRowReverse = effectiveHiddenStrands.reverse ? 0 : calculateRows('reverse', reverseGenes, reverseLayoutGenes)

        const fwdPadding = effectiveHiddenStrands.forward ? 0 : transcriptLayoutMetrics.trackPadding
        const revPadding = effectiveHiddenStrands.reverse ? 0 : transcriptLayoutMetrics.trackPadding
        const forwardGeneHeight = maxRowForward * transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
        const reverseGeneHeight = maxRowReverse * transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
        // Flatten removes *unused* height, and the gene's label and its expand/collapse
        // control are not unused height — they are the only thing naming the gene once the
        // canvas label moves under it. Reserving their room here is what keeps them on
        // screen when the track shrinks to its content. Compressed layouts still drop it:
        // they have one or two pixels of padding to work with and no footer to place.
        const geneFooterOverflow = isCompressedLayoutActive
            ? 0
            : geneFooterTrackOverflow(transcriptLayoutMetrics, flattenTracks)

        // With no genes to lay out the tracks collapse to their minimum, which is
        // a sliver — too little to put a message in, and every track below would
        // jump down the moment the first genes arrived. While the index is being
        // built they hold a fixed height instead, so the panel the user pans and
        // zooms around is the same shape it will be when the genes land.
        const geneTrackFloor = holdGeneTrackHeight
            ? GENE_INDEX_TRACK_HEIGHT
            : transcriptLayoutMetrics.minTrackHeight

        const forwardBgHeight = effectiveHiddenStrands.forward
            ? (hideInactiveTracks ? 0 : 36)
            : Math.max(
                geneTrackFloor,
                fwdPadding
                    + (flattenTracks ? forwardGeneHeight : maxRowForward * transcriptLayoutMetrics.rowPitch)
                    + geneFooterOverflow
            )
        const reverseBgHeight = effectiveHiddenStrands.reverse
            ? (hideInactiveTracks ? 0 : 36)
            : Math.max(
                geneTrackFloor,
                revPadding
                    + (flattenTracks ? reverseGeneHeight : maxRowReverse * transcriptLayoutMetrics.rowPitch)
                    + geneFooterOverflow
            )
        const seqBgHeight = SEQUENCE_TRACK_HEIGHT

        const getTrackHeight = (trackId) => {
            if (trackId === 'forward') return forwardBgHeight
            if (trackId === 'reverse') return reverseBgHeight
            if (trackId === 'sequence') {
                if (!showSequenceTrack) return 0
                if (hideInactiveTracks && effectiveHiddenStrands.sequence) return 0
                return seqBgHeight
            }
            if (isCustomTrackId(trackId) && customTracksById.has(trackId)) {
                const t = customTracksById.get(trackId)
                if (t?.visible === false) return hideInactiveTracks ? 0 : 36
                const rawMode = t?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
                const mode = t?.type === 'bigwig'
                    ? normalizeBigWigDisplayMode(rawMode, normalizeBigWigSettings(t?.bigwigSettings || t?.bigwig_settings).data_type)
                    : t?.type === 'vcf'
                        ? normalizeVcfDisplayMode(rawMode)
                        : rawMode
                if (t?.type === 'splice_junctions') {
                    const data = customTrackData?.[trackId]
                    if (data?.mode === 'splice_blocks') {
                        return SPLICE_BLOCK_TRACK_HEIGHT
                    }
                    const suggested = Number(data?.layout?.recommended_height)
                    if (!Number.isFinite(suggested)) return SPLICE_HEIGHT_BASE
                    // Keep prior stable size while tile coverage is still sparse.
                    if (customTrackLoading?.[trackId] && Number(data?.coverage || 0) < 0.55) {
                        return SPLICE_HEIGHT_BASE
                    }
                    return Math.round(clamp(suggested, SPLICE_HEIGHT_MIN, SPLICE_HEIGHT_MAX))
                }
                if (t?.type === 'bigbed') {
                    const data = customTrackData?.[trackId]
                    if (data?.mode === 'bigbed_detail') {
                        const laneCount = Math.max(1, Number(data?.lane_count || 1))
                        // Keep compact baseline while detail tiles are still sparse.
                        if (customTrackLoading?.[trackId] && Number(data?.tile_coverage || 0) < 0.6) {
                            return CUSTOM_TRACK_HEIGHT_STANDARD
                        }
                        return getBigBedTrackHeightForLanes(laneCount)
                    }
                }
                if (mode === 'zoned_heatmap') return CUSTOM_TRACK_HEIGHT_ZONED
                if ((mode === 'ensembl' || isVcfAdaptiveLikeMode(mode)) && t?.type === 'vcf') {
                    if (isVcfAdaptiveLikeMode(mode)) {
                        const vcfData = customTrackData?.[trackId]
                        const vcfLevel = getVcfBlockLevel(bpPerPx)
                        const isDetailMode = vcfData?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
                        if (!isDetailMode) return CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF_COMPACT
                    }
                    return bpPerPx <= 0.5 ? 200 : CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF
                }
                return CUSTOM_TRACK_HEIGHT_STANDARD
            }
            return 0
        }

        const activeTrackOrder = trackOrder.filter((trackId) => getTrackHeight(trackId) > 0)
        const totalTrackHeight = activeTrackOrder.reduce((sum, trackId) => sum + getTrackHeight(trackId), 0)

        // In bottom-aligned mode, selected-gene focus bar appears outside the canvas container
        // and shrinks container height; compensate so selecting/deselecting a gene does not
        // vertically shift all tracks.
        const selectedGeneHiddenForLayout = selectedGene && (
            (selectedGene.strand === '+' && hiddenStrands.forward) ||
            (selectedGene.strand === '-' && hiddenStrands.reverse) ||
            selectedGeneHiddenByBiotype
        )
        const visibleFocusBarHeight = (selectedGene && !selectedGeneHiddenForLayout) || isLocationFocusVisible
            ? (focusBarHeight || 30)
            : 0
        const alignTracksToBottom = effectiveTrackAlign === 'bottom' && !compactPanelHeight
        const focusBarCompensation = alignTracksToBottom ? visibleFocusBarHeight : 0
        const availableSpace = Math.max(160, viewHeight + focusBarCompensation)
        let RULER_Y = 0

        let startY = 0
        if (effectiveRulerPosition === 'top') {
            startY = effectiveRulerHeight
            if (alignTracksToBottom) {
                const bottomAlignedY = Math.max(effectiveRulerHeight, availableSpace - totalTrackHeight)
                startY = Math.min(bottomAlignedY, effectiveRulerHeight + MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP)
            }
        } else if (alignTracksToBottom) {
            const bottomAlignedY = Math.max(0, availableSpace - effectiveRulerHeight - totalTrackHeight)
            startY = Math.min(bottomAlignedY, MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP)
        }

        let FORWARD_Y = 0
        let REVERSE_Y = 0
        let SEQUENCE_Y = -999
        let currentY = startY
        const customTrackLayouts = {}
        const orderedTracks = []

        for (const trackId of activeTrackOrder) {
            const h = getTrackHeight(trackId)
            if (h <= 0) continue

            if (trackId === 'forward') FORWARD_Y = currentY
            else if (trackId === 'reverse') REVERSE_Y = currentY
            else if (trackId === 'sequence') SEQUENCE_Y = currentY
            else if (isCustomTrackId(trackId)) customTrackLayouts[trackId] = { y: currentY, height: h }

            orderedTracks.push({ id: trackId, y: currentY, height: h })
            currentY += h
        }

        const lastTrackY = orderedTracks.length
            ? Math.max(...orderedTracks.map((track) => track.y + track.height))
            : startY

        if (effectiveRulerPosition === 'bottom') {
            RULER_Y = compactPanelHeight
                ? lastTrackY
                : Math.max(lastTrackY, viewHeight - effectiveRulerHeight)
        }

        return {
            forwardGenes,
            reverseGenes,
            forwardBgHeight,
            reverseBgHeight,
            seqBgHeight,
            FORWARD_Y,
            REVERSE_Y,
            SEQUENCE_Y,
            RULER_Y,
            fwdPadding,
            revPadding,
            customTrackLayouts,
            orderedTracks,
        }
    }, [genes, viewSpan, viewWidth, viewHeight, transcriptCache, effectiveHiddenStrands, trackOrder, effectiveRulerPosition, effectiveTrackAlign, showSequenceTrack, customTracksById, customTrackData, customTrackLoading, isCustomTrackId, selectedGene, isLocationFocusVisible, hiddenStrands, selectedGeneHiddenByBiotype, isGeneHiddenFromTracks, hiddenGeneIdSet, focusBarHeight, hideInactiveTracks, hiddenBiotypeClasses, selectedChrom, genomicViewRange, collectCachedGenesInRange, getVcfBlockLevel, bpPerPx, isTranscriptCompressionActive, isCompressedLayoutActive, transcriptLayoutMetrics, getDisplayTranscriptRows, flattenTracks, compactPanelHeight, effectiveRulerHeight, stickyLayoutResetEpoch, holdGeneTrackHeight])

    // Where the note about the gene index goes: the forward and reverse tracks
    // taken together, minus whichever of them the user has hidden. Null when
    // both are off — there is nothing on screen for the message to be about.
    const geneIndexOverlayGeometry = useMemo(() => {
        if (!holdGeneTrackHeight) return null
        return geneIndexOverlayBand({
            forwardY: layout.FORWARD_Y,
            forwardHeight: layout.forwardBgHeight,
            reverseY: layout.REVERSE_Y,
            reverseHeight: layout.reverseBgHeight,
        })
    }, [holdGeneTrackHeight, layout.FORWARD_Y, layout.forwardBgHeight, layout.REVERSE_Y, layout.reverseBgHeight])

    const getSelectedGeneTranscriptHit = useCallback((mouseX, mouseY) => {
        if (!selectedGeneLayoutEntry || shouldForceGeneBlockView) return null

        const gene = selectedGeneLayoutEntry
        const txs = transcriptCache[gene.id]
        const displayRows = getDisplayTranscriptRows(gene)
        if (!txs || txs.length === 0 || displayRows.length === 0) return null

        const isForward = gene.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
        const lineHitPadding = isTranscriptCompressionActive ? 4 : 5
        const exonHitPadding = isTranscriptCompressionActive ? 2.5 : 3

        // The row band is painted across the whole gene, so it has to be live
        // across the whole gene too. Keying the row hit off each transcript's own
        // span instead left the short ones with a hit area narrower than the
        // highlight the user could plainly see.
        const rawGeneX1 = genomicToScreen(gene.start)
        const rawGeneX2 = genomicToScreen(gene.end)
        const geneLeft = Math.min(rawGeneX1, rawGeneX2)
        const geneRight = Math.max(rawGeneX1, rawGeneX2)

        let best = null
        let bestRank = Infinity
        let bestDist = Infinity

        for (let txIdx = 0; txIdx < displayRows.length; txIdx += 1) {
            // Ghosts still occupy their row so the ones below stay correctly
            // offset, but they are a preview and must not be clickable.
            if (displayRows[txIdx].ghost) continue
            const tx = displayRows[txIdx].transcript
            const txY = baseGeneY + txIdx * transcriptLayoutMetrics.rowPitch
            const midY = txY + transcriptLayoutMetrics.midOffset
            const rawTxX1 = genomicToScreen(tx.start)
            const rawTxX2 = genomicToScreen(tx.end)
            const txLeft = Math.min(rawTxX1, rawTxX2)
            const txRight = Math.max(rawTxX1, rawTxX2)

            let candidate = null
            const exons = Array.isArray(tx?.exons) ? tx.exons : []
            const exonBandTop = midY - (transcriptLayoutMetrics.exonHeight / 2) - exonHitPadding
            const exonBandBottom = midY + (transcriptLayoutMetrics.exonHeight / 2) + exonHitPadding
            if (mouseY >= exonBandTop && mouseY <= exonBandBottom) {
                for (const exon of exons) {
                    const rawEx1 = genomicToScreen(exon.start)
                    const rawEx2 = genomicToScreen(exon.end)
                    const exonLeft = Math.min(rawEx1, rawEx2)
                    const exonRight = Math.max(rawEx1, rawEx2)
                    if (mouseX < exonLeft - 2 || mouseX > exonRight + 2) continue
                    const centerX = (exonLeft + exonRight) / 2
                    candidate = {
                        rank: 0,
                        dist: Math.abs(mouseX - centerX),
                        anchorCanvasX: centerX,
                        anchorCanvasY: midY,
                        transcript: tx,
                    }
                    break
                }
            }

            if (!candidate && mouseY >= midY - lineHitPadding && mouseY <= midY + lineHitPadding && mouseX >= txLeft - 2 && mouseX <= txRight + 2) {
                candidate = {
                    rank: 1,
                    dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                    anchorCanvasX: clamp(mouseX, txLeft, txRight),
                    anchorCanvasY: midY,
                    transcript: tx,
                }
            }

            // Anywhere in the row counts, not just the drawn structure. The band
            // is the one the highlight paints, so what lights up under the cursor
            // is exactly what responds to it. Ranked last, so an exon or the
            // intron line still wins where the bands overlap and the popup keeps
            // anchoring to the feature rather than to empty row.
            if (!candidate && mouseX >= geneLeft - 2 && mouseX <= geneRight + 2) {
                const rowTop = txY
                const rowBottom = txY + transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap
                if (mouseY >= rowTop && mouseY <= rowBottom) {
                    candidate = {
                        rank: 2,
                        dist: Math.abs(mouseX - ((geneLeft + geneRight) / 2)),
                        // Anchor the popup on the transcript even when the pointer
                        // is out past its end, so the arrow never points at nothing.
                        anchorCanvasX: clamp(mouseX, txLeft, txRight),
                        anchorCanvasY: midY,
                        transcript: tx,
                    }
                }
            }

            if (!candidate) continue
            if (candidate.rank < bestRank || (candidate.rank === bestRank && candidate.dist < bestDist)) {
                bestRank = candidate.rank
                bestDist = candidate.dist
                best = {
                    gene,
                    transcript: candidate.transcript,
                    anchorCanvasX: candidate.anchorCanvasX,
                    anchorCanvasY: candidate.anchorCanvasY,
                }
            }
        }

        return best
    }, [
        selectedGeneLayoutEntry,
        shouldForceGeneBlockView,
        genomicToScreen,
        transcriptCache,
        getDisplayTranscriptRows,
        layout,
        transcriptLayoutMetrics,
        isTranscriptCompressionActive,
    ])

    const alignGeneToTop = useCallback((geneForFocus, marginPx = 18, options = {}) => {
        if (!geneForFocus || !containerRef.current) return false

        const isForward = geneForFocus.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(geneForFocus.start)
        const rawGx2 = genomicToScreen(geneForFocus.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const rowCount = getGeneRowCountForWidth(geneForFocus, geneWidth)
        const totalGeneHeight = getGeneTotalHeight(rowCount)
        const baseGeneY = trackY + trackPadding + ((geneForFocus._row || 0) * transcriptLayoutMetrics.rowPitch)

        const container = containerRef.current
        const containerRect = container.getBoundingClientRect()
        const scroller = findNearestScrollable(rootRef.current)
        const scrollerMetrics = getScrollerMetrics(scroller)

        const topMarginPx = Math.max(0, Number(options.topMarginPx ?? marginPx))
        const bottomMarginPx = Math.max(0, Number(options.bottomMarginPx ?? marginPx))

        // The gene's position in client space. The panel itself never scrolls, so
        // this only moves when the surrounding page scroller moves.
        const geneTopClientY = containerRect.top + baseGeneY
        const geneBottomClientY = geneTopClientY + totalGeneHeight

        // Park the gene just under whichever edge is lower: the panel's own top or
        // the visible top of the scroll viewport.
        const topAlignDelta = geneTopClientY - (Math.max(containerRect.top, scrollerMetrics.top) + topMarginPx)
        const bottomFitDelta = Math.max(
            0,
            geneBottomClientY + bottomMarginPx - Math.min(containerRect.bottom, scrollerMetrics.bottom)
        )
        const rawScrollTop = scrollerMetrics.scrollTop
            + (Boolean(options.preferBottomVisible) ? bottomFitDelta : topAlignDelta)

        // Layout may still be growing (transcripts expanding); let the caller retry.
        const needsMoreScrollableHeight = Boolean(options.preferBottomVisible)
            && (rawScrollTop > (scrollerMetrics.maxScrollTop + 1))
        if (needsMoreScrollableHeight) {
            return false
        }

        scrollScrollerTo(scroller, scrollerMetrics, clamp(rawScrollTop, 0, scrollerMetrics.maxScrollTop))
        return true
    }, [layout, transcriptLayoutMetrics, genomicToScreen, getGeneRowCountForWidth, getGeneTotalHeight])

    useEffect(() => {
        if (!focusBarRef.current) return
        const node = focusBarRef.current
        const updateHeight = () => {
            const h = Math.ceil(node.getBoundingClientRect().height)
            if (h > 0) setFocusBarHeight(h)
        }
        updateHeight()
        const ro = new ResizeObserver(updateHeight)
        ro.observe(node)
        return () => ro.disconnect()
    }, [selectedGene, isSelectedHidden, isLocationFocusVisible, effectiveFocusBarPosition, theme])

    const getCustomTrackToggleY = useCallback((trackLayout) => {
        return trackLayout.y + Math.max(18, (trackLayout.height * 0.45))
    }, [])

    const getTrackAtY = useCallback((y) => {
        for (const track of layout.orderedTracks) {
            if (y >= track.y && y <= track.y + track.height) {
                return track.id
            }
        }
        return null
    }, [layout])

    const getGeneFeatureVerticalAnchor = useCallback((mouseX, mouseY, trackId) => {
        const trackGenes = trackId === 'forward'
            ? layout.forwardGenes
            : trackId === 'reverse'
                ? layout.reverseGenes
                : []
        if (trackGenes.length === 0) return null

        const trackY = trackId === 'forward' ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = trackId === 'forward' ? layout.fwdPadding : layout.revPadding
        let best = null

        for (const gene of trackGenes) {
            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)
            if (mouseX < gx1 - 4 || mouseX > gx2 + 4) continue

            const geneWidth = Math.max(1, gx2 - gx1)
            const displayTxs = getDisplayTranscriptsForGene(gene, geneWidth)
            const rowCount = Math.max(1, displayTxs.length || 1)
            const baseGeneY = trackY
                + trackPadding
                + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const totalGeneHeight = getGeneTotalHeight(rowCount)
            if (mouseY < baseGeneY || mouseY > baseGeneY + totalGeneHeight) continue

            const rowAnchor = getFeatureRowAnchor({
                baseGeneY,
                pointerY: mouseY,
                rowPitch: transcriptLayoutMetrics.rowPitch,
                midOffset: transcriptLayoutMetrics.midOffset,
                rowCount,
                transcriptIds: displayTxs.map((tx) => tx?.id),
            })
            if (!rowAnchor) continue

            const rowMidY = baseGeneY
                + (rowAnchor.rowIndex * transcriptLayoutMetrics.rowPitch)
                + transcriptLayoutMetrics.midOffset
            const distance = Math.abs(mouseY - rowMidY)
            if (!best || distance < best.distance) {
                best = {
                    trackId,
                    geneId: String(gene.id),
                    transcriptId: rowAnchor.transcriptId,
                    fallbackRowIndex: rowAnchor.rowIndex,
                    rowOffset: rowAnchor.rowOffset,
                    distance,
                }
            }
        }

        if (!best) return null
        return {
            trackId: best.trackId,
            geneId: best.geneId,
            transcriptId: best.transcriptId,
            fallbackRowIndex: best.fallbackRowIndex,
            rowOffset: best.rowOffset,
        }
    }, [
        layout,
        genomicToScreen,
        getDisplayTranscriptsForGene,
        getGeneTotalHeight,
        transcriptLayoutMetrics,
    ])

    const getGeneFeatureVerticalTargetY = useCallback((anchor) => {
        if (!anchor?.geneId) return null
        const trackGenes = anchor.trackId === 'forward'
            ? layout.forwardGenes
            : anchor.trackId === 'reverse'
                ? layout.reverseGenes
                : []
        const gene = trackGenes.find((candidate) => String(candidate?.id) === String(anchor.geneId))
        if (!gene) return null

        const trackY = anchor.trackId === 'forward' ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = anchor.trackId === 'forward' ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(gene.start)
        const rawGx2 = genomicToScreen(gene.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const displayTxs = getDisplayTranscriptsForGene(gene, geneWidth)
        const baseGeneY = trackY
            + trackPadding
            + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)

        return getFeatureRowTargetY({
            baseGeneY,
            rowPitch: transcriptLayoutMetrics.rowPitch,
            midOffset: transcriptLayoutMetrics.midOffset,
            transcriptId: anchor.transcriptId,
            fallbackRowIndex: anchor.fallbackRowIndex,
            rowOffset: anchor.rowOffset,
            visibleTranscriptIds: displayTxs.map((tx) => tx?.id),
        })
    }, [layout, genomicToScreen, getDisplayTranscriptsForGene, transcriptLayoutMetrics])

    const getTrackTooltip = useCallback((trackId) => {
        if (trackId === 'forward') return 'Genes on the forward strand'
        if (trackId === 'reverse') return 'Genes on the reverse strand'
        if (trackId === 'sequence') return sequenceTrackTooltip
        if (isCustomTrackId(trackId)) return 'Custom BigWig track'
        return ''
    }, [sequenceTrackTooltip, isCustomTrackId])

    const isPrimaryPanel = useMemo(() => {
        const lowerLabel = String(label || '').toLowerCase()
        return alignmentRole === 'reference' || genome === 'reference' || lowerLabel.includes('primary')
    }, [alignmentRole, genome, label])

    const resolvedGenomeColor = useMemo(() => {
        return String(genomeColor || '').trim() || (isPrimaryPanel ? colors.exonProteinCoding : VCF_SETTINGS_DEFAULTS.genic_color)
    }, [genomeColor, isPrimaryPanel, colors.exonProteinCoding])

    const panelExonColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    const panelPillColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    const controlAccentColor = useMemo(() => {
        return resolvedGenomeColor
    }, [resolvedGenomeColor])

    // On: the genome's own colour, so the sidebar reads as part of this panel.
    // Off: a muted grey that still reads as a control rather than a disabled one.
    const sidebarToggleIconColor = useCallback((active) => (
        active ? panelPillColor : (isLight ? '#94a3b8' : '#6b7280')
    ), [panelPillColor, isLight])

    const buildPanelExportSnapshot = useCallback(async () => {
        const rootNode = rootRef.current
        const canvas = canvasRef.current
        if (!rootNode || !canvas) {
            throw new Error('Browser panel is not ready for export.')
        }

        const width = Math.max(
            1,
            Math.round(rootNode.getBoundingClientRect().width || rootNode.clientWidth || viewWidth || 1)
        )
        const toolbarNode = toolbarRef.current
        const focusNode = (selectedGene && !isSelectedHidden) || isLocationFocusVisible ? focusBarRef.current : null
        const toolbarHeight = toolbarNode
            ? Math.max(1, Math.round(toolbarNode.getBoundingClientRect().height || toolbarNode.clientHeight || 0))
            : 0
        const focusHeight = focusNode
            ? Math.max(1, Math.round(focusNode.getBoundingClientRect().height || focusNode.clientHeight || 0))
            : 0
        const canvasHeight = Math.max(
            1,
            Math.round(canvas.clientHeight || (canvas.height / (window.devicePixelRatio || 1)) || viewHeight || 1)
        )
        const textMeasureCanvas = document.createElement('canvas')
        const textMeasureCtx = textMeasureCanvas.getContext('2d')
        const textDescriptors = []
        const textMaskRects = []
        const overlayMarkupSections = []
        const visibleTrackOrder = trackOrder.filter((trackId) => {
            if (trackId === 'sequence') return showSequenceTrack
            if (isCustomTrackId(trackId)) return customTracksById.has(trackId)
            return true
        })
        const getExportTrackBgColor = (trackId) => {
            const index = visibleTrackOrder.indexOf(trackId)
            if (index % 2 === 0) {
                return isLight ? '#ffffff' : '#1a1b1e'
            }
            return isLight ? '#f8f9fa' : '#212226'
        }
        const getSidebarBgColor = (trackId) => {
            const isHidden = (trackId === 'forward' && effectiveHiddenStrands.forward)
                || (trackId === 'reverse' && effectiveHiddenStrands.reverse)
                || (trackId === 'sequence' && effectiveHiddenStrands.sequence)
                || (isCustomTrackId(trackId) && !(customTracksById.get(trackId)?.visible))
            if (isHidden) return isLight ? '#e9ecef' : '#141517'
            return getExportTrackBgColor(trackId)
        }
        const buildTextMaskRect = ({ text, x, y, font, textAnchor = 'middle', dominantBaseline = 'alphabetic', paddingX = 4, paddingY = 2 }) => {
            if (!textMeasureCtx || !text) return null
            textMeasureCtx.font = font
            const width = textMeasureCtx.measureText(text).width
            const fontSizeMatch = /(\d+(?:\.\d+)?)px/.exec(font)
            const fontSize = fontSizeMatch ? Number(fontSizeMatch[1]) : 11
            const safeHeight = Math.max(10, fontSize * 1.2)
            let left = x
            if (textAnchor === 'middle') left -= width / 2
            else if (textAnchor === 'end') left -= width
            let top = y - (fontSize * 0.82)
            if (dominantBaseline === 'middle') top = y - (safeHeight / 2)
            else if (dominantBaseline === 'hanging' || dominantBaseline === 'text-before-edge') top = y - fontSize * 0.1
            return {
                x: Math.floor(left - paddingX),
                y: Math.floor(top - paddingY),
                width: Math.ceil(width + paddingX * 2),
                height: Math.ceil(safeHeight + paddingY * 2),
            }
        }
        const pushExportText = ({
            text,
            x,
            y,
            font,
            fill,
            bgFill,
            textAnchor = 'middle',
            dominantBaseline = 'alphabetic',
            paddingX = 4,
            paddingY = 2,
        }) => {
            if (!text) return
            const maskRect = buildTextMaskRect({ text, x, y, font, textAnchor, dominantBaseline, paddingX, paddingY })
            if (maskRect && bgFill) {
                textMaskRects.push({ ...maskRect, fill: bgFill })
            }
            textDescriptors.push({
                text,
                x,
                y,
                font,
                fill,
                textAnchor,
                dominantBaseline,
            })
        }
        const pushOverlayMarkup = (markup) => {
            if (markup) overlayMarkupSections.push(markup)
        }
        const buildCustomTrackLabelY = (trackLayout, track, data) => {
            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode

            if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                const vcfLevel = getVcfBlockLevel(bpPerPx)
                const isDetailMode = data?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
                const top = trackLayout.y + (isDetailMode ? 18 : 8)
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const barH = Math.max(3, Math.floor(plotHeight * (isDetailMode ? 0.13 : 0.18)))
                const barY = top + Math.floor((plotHeight - barH) / 2)
                return isDetailMode
                    ? (trackLayout.y + 10)
                    : Math.max(trackLayout.y + 10, barY - 8)
            }

            if (renderMode !== 'zoned_heatmap') {
                return trackLayout.y + 9
            }

            const labelBand = 14
            const topPad = 4
            const bottomPad = 6
            const labelBelow = isPrimaryPanel
            if (labelBelow) {
                return trackLayout.y + trackLayout.height - bottomPad - (labelBand / 2)
            }
            return trackLayout.y + topPad + (labelBand / 2)
        }
        const sidebarToggleDescriptors = []
        const pushSidebarToggleDescriptor = (trackId, centerY, isHidden) => {
            if (!(Number.isFinite(centerY))) return
            const active = !isHidden
            sidebarToggleDescriptors.push({
                trackId,
                x: LHS_WIDTH - 13,
                y: centerY,
                iconColor: sidebarToggleIconColor(active),
                // The rasterised glyph is painted over with the sidebar's own
                // background so the export can re-emit it as a crisp path.
                maskFill: getSidebarBgColor(trackId),
            })
        }
        const pushSidebarLabelDescriptor = (trackId, centerY, text) => {
            if (!(Number.isFinite(centerY)) || !text) return
            pushExportText({
                text,
                x: (LHS_WIDTH - 13) - (SIDEBAR_TOGGLE_ICON_SIZE / 2) - SIDEBAR_TOGGLE_LABEL_GAP,
                y: centerY + 4,
                font: sansFont(11),
                fill: isLight ? '#64748b' : '#cbd5e1',
                bgFill: getSidebarBgColor(trackId),
                textAnchor: 'end',
                dominantBaseline: 'alphabetic',
                paddingX: 3,
                paddingY: 2,
            })
        }

        if (effectiveRulerHeight > 0) {
            const geometry = rulerGeometry({
                top: layout.RULER_Y,
                height: effectiveRulerHeight,
                position: effectiveRulerPosition,
            })
            const { ticks } = rulerTicks({
                start: viewStart,
                end: viewEnd,
                widthPx: viewWidth,
                fontSize: RULER_FONT_SIZE,
            })
            for (const pos of ticks) {
                const x = isAligned
                    ? (isFlipped
                        ? LHS_WIDTH + (viewEnd - pos) / bpPerPx
                        : LHS_WIDTH + (pos - viewStart) / bpPerPx)
                    : genomicToScreen(pos)
                if (x < 0 || x > viewWidth) continue
                let labelPos = pos
                if (isAligned && alignmentCoords && alignData) {
                    labelPos = overlayToGenomic(pos)
                }
                if (pos > 1 || isAligned) {
                    pushExportText({
                        text: formatRulerCoord(labelPos),
                        x: x + RULER_LABEL_GAP,
                        y: geometry.labelBaseline,
                        font: COORD_FONT,
                        fill: colors.rulerText,
                        bgFill: colors.rulerBg,
                        textAnchor: 'start',
                        dominantBaseline: 'alphabetic',
                        paddingX: 2,
                        paddingY: 2,
                    })
                }
            }
        }

        const exportGeneLabelCandidates = []
        let exportGeneLabelOrder = 0
        const collectGeneLabelDescriptors = (genesToRender, trackId, trackOrder, trackY) => {
            for (const gene of genesToRender) {
                const isSelected = selectedGene && selectedGene.id === gene.id
                const shouldDim = dimNonSelectedGenes && !!selectedGene && !isSelected
                const geneLabelColor = shouldDim ? (isLight ? '#868e96' : '#8a8d93') : colors.geneLabelText
                const txs = transcriptCache[gene.id]
                const candidate = buildGeneLabelCandidate({
                    gene,
                    trackId,
                    trackOrder,
                    trackY,
                    layout,
                    transcriptLayoutMetrics,
                    selectedGene,
                    dimNonSelectedGenes,
                    isLight,
                    colors,
                    geneLabelColor,
                    genomicToScreen,
                    viewWidth,
                    txs,
                    getEffectiveTranscriptLimit,
                    visibleTranscriptCount: getGeneRowCountForWidth(gene),
                    measureTextWidth: (text) => {
                        if (!textMeasureCtx) return 0
                        textMeasureCtx.font = LABEL_FONT
                        return textMeasureCtx.measureText(text).width
                    },
                    lhsWidth: LHS_WIDTH,
                    order: exportGeneLabelOrder++,
                    footerStyleEnabled: !isCompressedLayoutActive,
                })
                if (candidate) exportGeneLabelCandidates.push(candidate)
            }
        }

        if (!flattenTracks) {
            collectGeneLabelDescriptors(layout.forwardGenes, 'forward', 0, layout.FORWARD_Y)
            collectGeneLabelDescriptors(layout.reverseGenes, 'reverse', 1, layout.REVERSE_Y)
        }
        for (const label of placeNonOverlappingGeneLabels(exportGeneLabelCandidates)) {
            pushExportText({
                text: label.text,
                x: label.x,
                y: label.y,
                font: LABEL_FONT,
                fill: label.fill || colors.geneLabelText,
                bgFill: getExportTrackBgColor(label.trackId),
                textAnchor: label.textAlign === 'left' ? 'start' : 'middle',
                dominantBaseline: 'alphabetic',
                paddingX: 4,
                paddingY: 2,
            })
        }

        if (layout.forwardBgHeight > 0) {
            pushSidebarLabelDescriptor('forward', layout.FORWARD_Y + (layout.forwardBgHeight / 2), 'GF')
            pushSidebarToggleDescriptor(
                'forward',
                layout.FORWARD_Y + (layout.forwardBgHeight / 2),
                effectiveHiddenStrands.forward
            )
        }
        if (layout.reverseBgHeight > 0) {
            pushSidebarLabelDescriptor('reverse', layout.REVERSE_Y + (layout.reverseBgHeight / 2), 'GR')
            pushSidebarToggleDescriptor(
                'reverse',
                layout.REVERSE_Y + (layout.reverseBgHeight / 2),
                effectiveHiddenStrands.reverse
            )
        }
        if (showSequenceTrack && layout.SEQUENCE_Y >= 0) {
            pushSidebarLabelDescriptor('sequence', layout.SEQUENCE_Y + (layout.seqBgHeight / 2), sequenceTrackLabel)
            pushSidebarToggleDescriptor(
                'sequence',
                layout.SEQUENCE_Y + (layout.seqBgHeight / 2),
                effectiveHiddenStrands.sequence
            )
        }
        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts || {})) {
            const track = customTracksById.get(trackId)
            if (track) {
                pushExportText({
                    text: track.label || 'Custom track',
                    x: LHS_WIDTH + 8,
                    y: buildCustomTrackLabelY(trackLayout, track, customTrackData[trackId]),
                    font: sansFont(11),
                    fill: isLight ? '#1e3a8a' : '#93c5fd',
                    bgFill: getExportTrackBgColor(trackId),
                    textAnchor: 'start',
                    dominantBaseline: 'middle',
                    paddingX: 3,
                    paddingY: 2,
                })
            }
            pushSidebarLabelDescriptor(trackId, getCustomTrackToggleY(trackLayout), 'CT')
            pushSidebarToggleDescriptor(
                trackId,
                getCustomTrackToggleY(trackLayout),
                !(customTracksById.get(trackId)?.visible)
            )

            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const bigWigSettings = trackType === 'bigwig'
                ? normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings)
                : null
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, bigWigSettings?.data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const data = customTrackData[trackId]
            if (trackType === 'bigwig' && data?.has_data && Array.isArray(data.bins) && data.bins.length > 0 && data.bins.length <= 2048) {
                const values = data.bins
                const validValues = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
                if (validValues.length > 0) {
                    let top
                    let bottom
                    let plotHeight
                    if (renderMode !== 'zoned_heatmap') {
                        top = trackLayout.y + 18
                        bottom = trackLayout.y + trackLayout.height - 8
                        plotHeight = Math.max(8, bottom - top)
                    } else {
                        const labelBand = 14
                        const topPad = 4
                        const bottomPad = 6
                        const gap = 2
                        const labelBelow = isPrimaryPanel
                        if (labelBelow) {
                            top = trackLayout.y + topPad
                            bottom = trackLayout.y + trackLayout.height - (labelBand + bottomPad + gap)
                        } else {
                            top = trackLayout.y + labelBand + topPad
                            bottom = trackLayout.y + trackLayout.height - bottomPad
                        }
                        plotHeight = Math.max(8, bottom - top)
                    }
                    const left = LHS_WIDTH + 2
                    const right = viewWidth - 2
                    const plotWidth = Math.max(1, right - left)
                    const observedMin = Math.min(...validValues)
                    const observedMax = Math.max(...validValues)
                    const minVal = data.min ?? observedMin
                    const maxVal = data.max ?? observedMax
                    const safeMax = Math.max(maxVal, minVal + 1e-9)
                    const range = safeMax - minVal
                    const binWidth = plotWidth / values.length
                    const bigWigMarkup = []
                    textMaskRects.push({
                        x: left,
                        y: trackLayout.y,
                        width: viewWidth - left,
                        height: trackLayout.height,
                        fill: getExportTrackBgColor(trackId),
                    })

                    if (renderMode === 'zoned_heatmap') {
                        const colW = Math.max(1, Math.ceil(binWidth))
                        const zoneColors = bigWigSettings?.zoned_colors
                            || (isLight ? ZONED_ZONE_SOLID_COLORS.light : ZONED_ZONE_SOLID_COLORS.dark)
                        const isSecondaryZoned = !isPrimaryPanel
                        const zoneYForValue = (value) => {
                            const frac = getZonedValueFraction(value)
                            return isSecondaryZoned
                                ? (bottom - frac * plotHeight)
                                : (top + frac * plotHeight)
                        }
                        const baselineY = isSecondaryZoned ? (bottom + 0.5) : (top + 0.5)
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${baselineY}" x2="${right}" y2="${baselineY}" stroke="${escapeXml(isLight ? '#e8a534' : '#f0b44d')}" stroke-width="1" />`
                        )
                        const boundaryValues = [100, 1000, 10000, 100000]
                        for (const boundary of boundaryValues) {
                            const y = zoneYForValue(boundary)
                            bigWigMarkup.push(
                                `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${escapeXml(isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.32)')}" stroke-width="1" stroke-dasharray="4 3" />`
                            )
                        }
                        for (let i = 0; i < values.length; i += 1) {
                            const value = values[i]
                            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
                            const capped = clamp(value, 0, ZONED_TRACK_MAX_VALUE)
                            const x = left + i * binWidth
                            let zoneStart = 0
                            let yOffset = 0
                            for (let zoneIdx = 0; zoneIdx < ZONED_THRESHOLDS.length; zoneIdx += 1) {
                                const zoneEnd = ZONED_THRESHOLDS[zoneIdx]
                                if (capped <= zoneStart) break
                                const coveredEnd = Math.min(capped, zoneEnd)
                                if (coveredEnd <= zoneStart) {
                                    zoneStart = zoneEnd
                                    continue
                                }
                                const zoneSpan = Math.max(1, zoneEnd - zoneStart)
                                const coveredFraction = (coveredEnd - zoneStart) / zoneSpan
                                const segH = plotHeight * (ZONED_ZONE_HEIGHTS[zoneIdx] || 0) * coveredFraction
                                if (segH > 0) {
                                    const segY = isSecondaryZoned
                                        ? (bottom - yOffset - segH)
                                        : (top + yOffset)
                                    bigWigMarkup.push(
                                        `<rect x="${x}" y="${segY}" width="${colW}" height="${segH}" fill="${escapeXml(zoneColors[zoneIdx] || zoneColors[zoneColors.length - 1])}" />`
                                    )
                                    yOffset += segH
                                }
                                zoneStart = zoneEnd
                            }
                        }
                        for (const boundary of boundaryValues) {
                            const y = zoneYForValue(boundary)
                            bigWigMarkup.push(
                                `<text x="${viewWidth - 4}" y="${y}" fill="${escapeXml(isLight ? '#64748b' : '#94a3b8')}" text-anchor="end" dominant-baseline="middle" style="font:${escapeXml(sansFont(9))};">${escapeXml(`>${boundary.toLocaleString()}`)}</text>`
                            )
                        }
                    } else if (renderMode === 'signal_plot') {
                        const yMin = Math.min(0, observedMin)
                        const yMax = Math.max(0, observedMax)
                        const yRange = Math.max(1e-9, yMax - yMin)
                        const toY = (value) => bottom - ((value - yMin) / yRange) * plotHeight
                        const zeroY = clamp(toY(0), top, bottom)
                        const plotColor = normalizeBigWigHexColor(bigWigSettings?.plot_color, BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.plot_color)
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${zeroY}" x2="${right}" y2="${zeroY}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(148, 163, 184, 0.32)')}" stroke-width="1" />`
                        )
                        bigWigMarkup.push(
                            `<line x1="${left}" y1="${zeroY}" x2="${right}" y2="${zeroY}" stroke="${escapeXml(hexToRgba(plotColor, isLight ? 0.18 : 0.26))}" stroke-width="1" />`
                        )
                        const segments = []
                        const zeroBridges = []
                        let current = []
                        let gapStartX = null
                        let gapEndX = null
                        for (let i = 0; i < values.length; i += 1) {
                            const value = values[i]
                            const binLeft = left + i * binWidth
                            const binRight = left + (i + 1) * binWidth
                            if (typeof value !== 'number' || !Number.isFinite(value)) {
                                if (current.length > 0) segments.push(current)
                                current = []
                                if (gapStartX === null) gapStartX = binLeft
                                gapEndX = binRight
                                continue
                            }
                            if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                                zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                                gapStartX = null
                                gapEndX = null
                            }
                            current.push({
                                x: left + (i + 0.5) * binWidth,
                                y: clamp(toY(value), top, bottom),
                            })
                        }
                        if (current.length > 0) segments.push(current)
                        if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                            zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                        }
                        for (const segment of segments) {
                            if (segment.length === 0) continue
                            if (segment.length === 1) {
                                const p = segment[0]
                                bigWigMarkup.push(
                                    `<line x1="${p.x}" y1="${zeroY}" x2="${p.x}" y2="${p.y}" stroke="${escapeXml(hexToRgba(plotColor, 0.94))}" stroke-width="1.5" />`
                                )
                                continue
                            }
                            const areaPath = [`M ${segment[0].x} ${zeroY}`, `L ${segment[0].x} ${segment[0].y}`]
                            const strokePath = [`M ${segment[0].x} ${segment[0].y}`]
                            for (let i = 1; i < segment.length; i += 1) {
                                areaPath.push(`L ${segment[i].x} ${segment[i].y}`)
                                strokePath.push(`L ${segment[i].x} ${segment[i].y}`)
                            }
                            areaPath.push(`L ${segment[segment.length - 1].x} ${zeroY}`, 'Z')
                            bigWigMarkup.push(
                                `<path d="${escapeXml(areaPath.join(' '))}" fill="${escapeXml(hexToRgba(plotColor, 0.28))}" />`
                            )
                            bigWigMarkup.push(
                                `<path d="${escapeXml(strokePath.join(' '))}" fill="none" stroke="${escapeXml(hexToRgba(plotColor, 0.94))}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />`
                            )
                        }
                        for (const gap of zeroBridges) {
                            bigWigMarkup.push(
                                `<line x1="${gap.x1}" y1="${zeroY}" x2="${gap.x2}" y2="${zeroY}" stroke="${escapeXml(hexToRgba(plotColor, isLight ? 0.52 : 0.62))}" stroke-width="1" stroke-dasharray="4 3" />`
                            )
                        }
                        const axisX = viewWidth - 14
                        bigWigMarkup.push(
                            `<line x1="${axisX}" y1="${top}" x2="${axisX}" y2="${bottom}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)')}" stroke-width="1" />`
                        )
                        const ticks = [
                            { y: top, value: yMax },
                            { y: top + plotHeight / 2, value: (yMin + yMax) / 2 },
                            { y: bottom, value: yMin },
                        ]
                        for (const tick of ticks) {
                            bigWigMarkup.push(
                                `<line x1="${axisX - 4}" y1="${tick.y}" x2="${axisX}" y2="${tick.y}" stroke="${escapeXml(isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)')}" stroke-width="1" />`
                            )
                            bigWigMarkup.push(
                                `<text x="${viewWidth - 4}" y="${tick.y}" fill="${escapeXml(isLight ? '#64748b' : '#94a3b8')}" text-anchor="end" dominant-baseline="middle" style="font:${escapeXml(sansFont(9))};">${escapeXml(formatSignalValueForTrack(tick.value))}</text>`
                            )
                        }
                    }

                    if (bigWigMarkup.length > 0) {
                        pushOverlayMarkup(bigWigMarkup.join(''))
                    }
                }
            }

            if (trackType === 'bigbed' && data?.mode === 'bigbed_blocks' && Array.isArray(data.block_spans) && data.block_spans.length > 0) {
                const left = LHS_WIDTH + 2
                const right = viewWidth - 2
                const plotWidth = Math.max(1, right - left)
                const top = trackLayout.y + 18
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                const blockY = top + Math.round((plotHeight - blockH) / 2)
                const bigBedMarkup = []
                const gToX = (g) => left + (((g - (data.start ?? viewStart)) / Math.max(1, (data.end ?? viewEnd) - (data.start ?? viewStart))) * plotWidth)
                textMaskRects.push({
                    x: left,
                    y: trackLayout.y,
                    width: viewWidth - left,
                    height: trackLayout.height,
                    fill: getExportTrackBgColor(trackId),
                })
                for (const span of data.block_spans) {
                    const s = Number(span?.start)
                    const e = Number(span?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                    const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                    const drawW = x2 - x1
                    if (drawW <= 0) continue
                    const fill = bigBedBlockColor(span, isLight)
                    const drawWidth = Math.max(1, drawW)
                    bigBedMarkup.push(
                        `<rect x="${x1}" y="${blockY}" width="${drawWidth}" height="${blockH}" fill="${escapeXml(fill)}" />`
                    )
                    if (drawWidth > 2) {
                        bigBedMarkup.push(
                            `<rect x="${x1 + 0.5}" y="${blockY + 0.5}" width="${Math.max(0.5, drawWidth - 1)}" height="${Math.max(0.5, blockH - 1)}" fill="none" stroke="${escapeXml(isLight ? 'rgba(5,150,105,0.5)' : 'rgba(110,231,183,0.62)')}" stroke-width="0.7" />`
                        )
                    }
                }
                if (bigBedMarkup.length > 0) {
                    pushOverlayMarkup(bigBedMarkup.join(''))
                }
            }

            if (trackType === 'bigbed' && data?.mode === 'bigbed_detail' && Array.isArray(data.features) && data.features.length > 0) {
                const left = LHS_WIDTH + 2
                const right = viewWidth - 2
                const plotWidth = Math.max(1, right - left)
                const top = trackLayout.y + 18
                const bottom = trackLayout.y + trackLayout.height - 8
                const plotHeight = Math.max(8, bottom - top)
                const lanePitch = BIGBED_DETAIL_LANE_PITCH
                const exonH = BIGBED_DETAIL_EXON_HEIGHT
                const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                const maxVisibleLanes = getBigBedLaneCapacity(plotHeight)
                const clickedKey = clickedBigBedFeature?.trackId === trackId
                    ? bigBedFeatureKey(clickedBigBedFeature.feature)
                    : ''
                const hoveredKey = clickedKey
                    ? ''
                    : (hoveredBigBedFeature?.trackId === trackId ? hoveredBigBedFeature.key : '')
                const gToX = (g) => left + (((g - (data.start ?? viewStart)) / Math.max(1, (data.end ?? viewEnd) - (data.start ?? viewStart))) * plotWidth)
                const visibleFeatures = []
                let overflowCount = 0
                for (const feature of data.features) {
                    const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                    if (lane >= maxVisibleLanes) {
                        overflowCount += 1
                        continue
                    }
                    visibleFeatures.push(feature)
                }
                visibleFeatures.sort((a, b) =>
                    (Number(a?._lane ?? a?.lane ?? 0) - Number(b?._lane ?? b?.lane ?? 0))
                    || (Number(a?.start || 0) - Number(b?.start || 0))
                    || (Number(a?.end || 0) - Number(b?.end || 0))
                    || bigBedFeatureKey(a).localeCompare(bigBedFeatureKey(b))
                )
                const trackBgColor = getExportTrackBgColor(trackId)
                const bigBedMarkup = []
                textMaskRects.push({
                    x: left,
                    y: trackLayout.y,
                    width: viewWidth - left,
                    height: trackLayout.height,
                    fill: trackBgColor,
                })

                for (const feature of visibleFeatures) {
                    const s = Number(feature?.start)
                    const e = Number(feature?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                    const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                    const y = yMid - exonH / 2
                    if (y + exonH < top || y > bottom) continue

                    const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                    const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                    const drawW = x2 - x1
                    if (drawW <= 0) continue

                    const key = bigBedFeatureKey(feature)
                    const isFocused = !!clickedKey && key === clickedKey
                    const isHovered = !clickedKey && key === hoveredKey
                    const dimmed = !!clickedKey && !isFocused
                    const color = bigBedFeatureColor(feature, isLight)
                    const strokeColor = isFocused
                        ? (isLight ? 'rgba(0,0,0,0.92)' : 'rgba(255,255,255,0.96)')
                        : isHovered
                            ? (isLight ? 'rgba(0,0,0,0.74)' : 'rgba(255,255,255,0.84)')
                            : color.stroke
                    const codingFillColor = isFocused ? color.stroke : color.fill
                    const featureOpacity = dimmed ? 0.2 : (isFocused ? 1 : (isHovered ? 1 : 0.86))
                    const isTranscript = feature?._render_kind === 'transcript'
                        && feature?._structure_valid === true
                        && Array.isArray(feature?._exon_blocks)
                        && feature._exon_blocks.length > 0

                    if (isTranscript) {
                        const txBounds = getGenomicIntervalPixelBounds(s, e, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                        const txX1 = txBounds ? Math.max(left, txBounds.x1) : Math.max(left, gToX(Math.max(viewStart, s)))
                        const txX2 = txBounds ? Math.min(right, txBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, e)))
                        const txDrawW = txX2 - txX1
                        if (txDrawW > 0) {
                            bigBedMarkup.push(
                                `<line x1="${txX1}" y1="${yMid + 0.5}" x2="${txX2}" y2="${yMid + 0.5}" stroke="${escapeXml(strokeColor)}" stroke-width="${INTRON_HEIGHT}" opacity="${featureOpacity}" />`
                            )
                        }

                        const strand = String(feature?.strand || '.')
                        if ((strand === '+' || strand === '-') && txDrawW >= 30) {
                            const visuallyForward = txX1 <= txX2 ? (strand === '+') : (strand === '-')
                            const chevronColor = isFocused
                                ? strokeColor
                                : (isLight ? 'rgba(51,65,85,0.58)' : 'rgba(203,213,225,0.52)')
                            const spacing = Math.max(20, txDrawW / 15)
                            for (let cx = txX1 + 10; cx <= txX2 - 10; cx += spacing) {
                                const chevDir = visuallyForward ? 3.4 : -3.4
                                bigBedMarkup.push(
                                    `<path d="M ${cx - chevDir} ${yMid - 3.3} L ${cx} ${yMid} L ${cx - chevDir} ${yMid + 3.3}" fill="none" stroke="${escapeXml(chevronColor)}" stroke-width="1" opacity="${featureOpacity}" />`
                                )
                            }
                        }

                        const exonStrokeWidth = isFocused ? 1.8 : (isHovered ? 1.45 : 1.2)
                        const exons = Array.isArray(feature?._exon_blocks) ? feature._exon_blocks : []
                        const cdsBlocks = Array.isArray(feature?._cds_blocks) ? feature._cds_blocks : []
                        for (const exon of exons) {
                            const es = Number(exon?.start)
                            const ee = Number(exon?.end)
                            if (!Number.isFinite(es) || !Number.isFinite(ee) || ee < es) continue
                            if (ee <= viewStart || es >= viewEnd) continue

                            const overlaps = cdsBlocks
                                .map((cds) => {
                                    const cdsStart = Number(cds?.start)
                                    const cdsEnd = Number(cds?.end)
                                    if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd) || cdsEnd < cdsStart) return null
                                    const overlapStart = Math.max(es, cdsStart)
                                    const overlapEnd = Math.min(ee, cdsEnd)
                                    return overlapEnd >= overlapStart
                                        ? { start: overlapStart, end: overlapEnd }
                                        : null
                                })
                                .filter(Boolean)
                                .sort((a, b) => a.start - b.start)

                            const segments = []
                            let cursor = es
                            for (const coding of overlaps) {
                                if (coding.start > cursor) {
                                    segments.push({ start: cursor, end: coding.start - 1, coding: false })
                                }
                                segments.push({ start: coding.start, end: coding.end, coding: true })
                                cursor = Math.max(cursor, coding.end + 1)
                            }
                            if (cursor <= ee) {
                                segments.push({ start: cursor, end: ee, coding: false })
                            }
                            if (segments.length === 0) {
                                segments.push({ start: es, end: ee, coding: false })
                            }

                            for (const seg of segments) {
                                const segBounds = getGenomicIntervalPixelBounds(seg.start, seg.end, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                                const sx1 = segBounds ? Math.max(left, segBounds.x1) : Math.max(left, gToX(Math.max(viewStart, seg.start)))
                                const sx2 = segBounds ? Math.min(right, segBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, seg.end)))
                                const segW = sx2 - sx1
                                if (segW <= 0) continue

                                const drawH = exonH
                                const segY = yMid - drawH / 2
                                const strokeInset = exonStrokeWidth / 2
                                const drawX = sx1 + strokeInset
                                const drawY = segY + strokeInset
                                const boxW = Math.max(0.5, segW - exonStrokeWidth)
                                const boxH = Math.max(0.5, drawH - exonStrokeWidth)

                                bigBedMarkup.push(
                                    `<rect x="${sx1}" y="${segY}" width="${segW}" height="${drawH}" fill="${escapeXml(trackBgColor)}" opacity="${featureOpacity}" />`
                                )
                                if (seg.coding) {
                                    bigBedMarkup.push(
                                        `<rect x="${drawX}" y="${drawY}" width="${boxW}" height="${boxH}" fill="${escapeXml(codingFillColor)}" opacity="${featureOpacity}" />`
                                    )
                                }
                                bigBedMarkup.push(
                                    `<rect x="${drawX}" y="${drawY}" width="${boxW}" height="${boxH}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${exonStrokeWidth}" opacity="${featureOpacity}" />`
                                )
                            }
                        }
                    } else {
                        const drawWidth = Math.max(1, drawW)
                        bigBedMarkup.push(
                            `<rect x="${x1}" y="${y}" width="${drawWidth}" height="${exonH}" fill="${escapeXml(color.fill)}" opacity="${featureOpacity}" />`
                        )
                        if (drawWidth > 2) {
                            bigBedMarkup.push(
                                `<rect x="${x1 + 0.5}" y="${y + 0.5}" width="${Math.max(0.5, drawWidth - 1)}" height="${Math.max(0.5, exonH - 1)}" fill="none" stroke="${escapeXml(strokeColor)}" stroke-width="${isFocused ? 2 : (isHovered ? 1.5 : 0.9)}" opacity="${featureOpacity}" />`
                            )
                        }
                    }
                }

                if (overflowCount > 0) {
                    bigBedMarkup.push(
                        `<text x="${right - 3}" y="${bottom - 1}" fill="${escapeXml(isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)')}" text-anchor="end" dominant-baseline="text-after-edge" style="font:${escapeXml(sansFont(9))};">+${escapeXml(String(overflowCount))} overflow</text>`
                    )
                }

                if (bigBedMarkup.length > 0) {
                    pushOverlayMarkup(bigBedMarkup.join(''))
                }
            }
        }

        if (showSequenceTrack && layout.SEQUENCE_Y >= 0 && !effectiveHiddenStrands.sequence) {
            const seqY = layout.SEQUENCE_Y
            const seqTrackViewH = layout.seqBgHeight
            const seqBoxT = Math.round(seqY + 6)
            const seqBoxH = 24
            const seqPxPerBp = trackWidth / viewSpan
            const seqTrackBg = getExportTrackBgColor('sequence')
            const sequenceMarkup = []

            if (isAligned && alignData && viewSpan <= 1000 && seqPxPerBp >= 2) {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                const seqFont = seqPxPerBp >= 10 ? monoFont(12) : monoFont(9)
                const startIdx = Math.floor(viewStart)
                const endIdx = Math.ceil(viewEnd)
                const alnLen = alignData.sequence.length
                for (let i = startIdx; i < endIdx; i += 1) {
                    let base = null
                    if (i >= 0 && i < alnLen) {
                        base = alignData.sequence[i]
                    } else if (sequence && seqRange) {
                        const genomicBp = Math.round(overlayToGenomic(i))
                        const seqIdx = genomicBp - seqRange.start
                        if (seqIdx >= 0 && seqIdx < sequence.length) {
                            base = sequence[seqIdx]
                            if (alignData.strand === '-') {
                                base = REV_COMP[base] || base
                            }
                        }
                    }
                    if (!base) continue
                    const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                    const { bxL, bxR, bxW } = getBasePixelBounds(i, seqPxPerBp)
                    const alignedBp = Math.round(overlayToGenomic(i))
                    sequenceMarkup.push(
                        `<rect x="${bxL}" y="${seqBoxT}" width="${bxW}" height="${seqBoxH}" fill="${escapeXml(getBaseColor(displayBase, colors))}" />`
                    )
                    if (seqPxPerBp >= 6 && bxW >= 2) {
                        const sepX = bxR - 0.5
                        sequenceMarkup.push(
                            `<line x1="${sepX}" y1="${seqBoxT + 0.5}" x2="${sepX}" y2="${seqBoxT + seqBoxH - 0.5}" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)')}" stroke-width="1" />`
                        )
                    }
                    if (hoveredSeqBase?.bp === alignedBp && bxW >= 2) {
                        sequenceMarkup.push(
                            `<rect x="${bxL + 1}" y="${seqBoxT + 1}" width="${Math.max(0, bxW - 2)}" height="${seqBoxH - 2}" fill="none" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')}" stroke-width="2" />`
                        )
                    }
                    if (seqPxPerBp >= 10) {
                        sequenceMarkup.push(
                            `<text x="${bxL + bxW / 2}" y="${seqBoxT + seqBoxH / 2}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" style="font:${escapeXml(seqFont)};">${escapeXml(displayBase.toUpperCase())}</text>`
                        )
                    }
                }
            } else if (sequence && seqRange && viewSpan <= 1000 && seqPxPerBp >= 2) {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                const seqFont = seqPxPerBp >= 10 ? monoFont(12) : monoFont(9)
                for (let i = 0; i < sequence.length; i += 1) {
                    const bp = seqRange.start + i
                    if (bp < viewStart || bp >= viewEnd) continue
                    const base = sequence[i]
                    const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                    const { bxL, bxR, bxW } = getBasePixelBounds(bp, seqPxPerBp)
                    sequenceMarkup.push(
                        `<rect x="${bxL}" y="${seqBoxT}" width="${bxW}" height="${seqBoxH}" fill="${escapeXml(getBaseColor(displayBase, colors))}" />`
                    )
                    if (seqPxPerBp >= 6 && bxW >= 2) {
                        const sepX = bxR - 0.5
                        sequenceMarkup.push(
                            `<line x1="${sepX}" y1="${seqBoxT + 0.5}" x2="${sepX}" y2="${seqBoxT + seqBoxH - 0.5}" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)')}" stroke-width="1" />`
                        )
                    }
                    if (hoveredSeqBase?.bp === bp && bxW >= 2) {
                        sequenceMarkup.push(
                            `<rect x="${bxL + 1}" y="${seqBoxT + 1}" width="${Math.max(0, bxW - 2)}" height="${seqBoxH - 2}" fill="none" stroke="${escapeXml(isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)')}" stroke-width="2" />`
                        )
                    }
                    if (seqPxPerBp >= 10) {
                        sequenceMarkup.push(
                            `<text x="${bxL + bxW / 2}" y="${seqBoxT + seqBoxH / 2}" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" style="font:${escapeXml(seqFont)};">${escapeXml(displayBase.toUpperCase())}</text>`
                        )
                    }
                }
            } else {
                textMaskRects.push({
                    x: LHS_WIDTH,
                    y: seqY,
                    width: viewWidth - LHS_WIDTH,
                    height: seqTrackViewH,
                    fill: seqTrackBg,
                })
                sequenceMarkup.push(
                    `<text x="${LHS_WIDTH + (viewWidth - LHS_WIDTH) / 2}" y="${seqY + seqTrackViewH / 2 + 4}" fill="${escapeXml(isLight ? '#868e96' : '#5c5f66')}" text-anchor="middle" dominant-baseline="alphabetic" style="font:${escapeXml(sansFont(9))};">zoom in to see sequence</text>`
                )
            }

            pushOverlayMarkup(sequenceMarkup.join(''))
        }

        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts || {})) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue
            const trackType = track.type || 'bigwig'
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const data = customTrackData[trackId]
            if (!(trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode) && data?.mode === 'adp_detail')) continue

            const left = LHS_WIDTH + 2
            const right = viewWidth - 2
            const plotWidth = Math.max(1, right - left)
            const top = trackLayout.y + 18
            const bottom = trackLayout.y + trackLayout.height - 8
            const plotHeight = Math.max(8, bottom - top)
            const barH = Math.max(5, Math.floor(plotHeight * 0.13))
            const barY = top + Math.floor((plotHeight - barH) / 2)
            const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * plotWidth
            const variants = Array.isArray(data?.variants) ? data.variants : []
            const hb = hoveredVcfBlock
            const cvPos = clickedVcfVariant?.variant?.pos
            const cvType = clickedVcfVariant ? localVcfType(clickedVcfVariant.variant) : null
            const vcfSettings = normalizeVcfSettings(track?.vcfSettings || track?.vcf_settings)
            const vcfGenicColor = vcfSettings?.genic_color || VCF_SETTINGS_DEFAULTS.genic_color
            const vcfIntergenicColor = vcfSettings?.intergenic_color || VCF_SETTINGS_DEFAULTS.intergenic_color
            const VARIANT_FILL = {
                snv: isLight ? '#4a7cf5' : '#7ab4fc',
                ins: isLight ? '#16a34a' : '#4ade80',
                del: isLight ? '#d97706' : '#fbbf24',
                indel: isLight ? '#9333ea' : '#c084fc',
            }
            const VARIANT_STROKE = {
                snv: isLight ? 'rgba(30,60,160,0.75)' : 'rgba(120,170,255,0.65)',
                ins: isLight ? 'rgba(10,100,30,0.75)' : 'rgba(100,220,130,0.65)',
                del: isLight ? 'rgba(150,80,0,0.75)' : 'rgba(250,180,50,0.65)',
                indel: isLight ? 'rgba(100,20,160,0.75)' : 'rgba(190,100,250,0.65)',
            }
            const ANCHOR_FILL_ACTIVE = isLight ? '#3b82f6' : '#60a5fa'
            const ANCHOR_STROKE = isLight ? 'rgba(30,64,175,0.9)' : 'rgba(191,219,254,0.95)'
            const showIndelMarkers = bpPerPx <= 1
            const showIndelLabels = bpPerPx <= 0.5
            const viewGenicGenes = !isAligned
                ? genes.filter((g) => Number(g.end) >= viewStart && Number(g.start) <= viewEnd)
                : []
            const isPosiGenic = (pos) =>
                viewGenicGenes.some((g) => Number(g.start) <= pos && Number(g.end) >= pos)

            textMaskRects.push({
                x: left,
                y: trackLayout.y,
                width: plotWidth,
                height: trackLayout.height,
                fill: getExportTrackBgColor(trackId),
            })

            const vcfMarkup = []
            if (bpPerPx <= 1) {
                const occupiedPos = new Set(
                    variants
                        .filter((v) => localVcfType(v) === 'snv')
                        .map((v) => Number(v?.pos))
                        .filter(Number.isFinite)
                )
                for (let bp = Math.floor(viewStart); bp <= Math.ceil(viewEnd); bp += 1) {
                    if (occupiedPos.has(bp)) continue
                    const bxL = blockGToX(bp)
                    const bxR = blockGToX(bp + 1)
                    const drawL = Math.max(left, bxL)
                    const drawR = Math.min(right, bxR)
                    const drawW = drawR - drawL
                    if (drawW <= 0) continue
                    const regionColor = isPosiGenic(bp) ? vcfGenicColor : vcfIntergenicColor
                    vcfMarkup.push(
                        `<rect x="${drawL + 0.5}" y="${barY + 0.5}" width="${Math.max(0, drawW - 1)}" height="${barH - 1}" fill="none" stroke="${escapeXml(regionColor)}" stroke-width="1" />`
                    )
                }
            }

            const indelItems = []
            if (showIndelMarkers) {
                const seenIndel = new Set()
                for (const v of variants) {
                    const vtype = localVcfType(v)
                    if (vtype === 'snv') continue
                    const layoutInfo = getVcfDetailVariantLayout(v, vtype)
                    const vpos = layoutInfo.vpos
                    if (!Number.isFinite(vpos)) continue
                    const key = `${vtype}:${vpos}`
                    if (seenIndel.has(key)) continue
                    seenIndel.add(key)
                    const nBars = getVcfAltAlleleCount(v)
                    const xGenomic = layoutInfo.markerXGenomic
                    const x = blockGToX(Math.max(viewStart, xGenomic))
                    const primaryDir = vtype === 'ins' ? 'up' : 'down'
                    const altDir = primaryDir === 'up' ? 'down' : 'up'
                    let dir = primaryDir
                    let level = 0
                    if (showIndelLabels) {
                        const MAX_LEVEL = 3
                        let lP = 0
                        let lA = 0
                        for (const existing of indelItems) {
                            const leftNBars = existing.x <= x ? existing.nBars : nBars
                            const inProximity = Math.abs(existing.x - x) < Math.max(50, 7 + leftNBars * 14 + 5)
                            if (inProximity) {
                                if (existing.dir === primaryDir) lP = Math.max(lP, existing.level + 1)
                                if (existing.dir === altDir) lA = Math.max(lA, existing.level + 1)
                            }
                        }
                        lP = Math.min(lP, MAX_LEVEL)
                        lA = Math.min(lA, MAX_LEVEL)
                        if (lA < lP) {
                            dir = altDir
                            level = lA
                        } else {
                            dir = primaryDir
                            level = lP
                        }
                    }
                    indelItems.push({ v, vpos, x, dir, level, nBars })
                }
            }

            const drawSegmentMarkup = ({
                segStart,
                segEnd,
                fillColor,
                strokeColor,
                activeStroke = null,
                alpha = 0.9,
                strokeWidth = 1,
            }) => {
                if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return null
                const x1 = blockGToX(Math.max(viewStart, segStart))
                const x2 = blockGToX(Math.min(viewEnd, segEnd))
                const drawStart = Math.max(left, Math.min(x1, x2))
                const drawEnd = Math.min(right, Math.max(x1, x2))
                const drawW = drawEnd - drawStart
                if (drawW <= 0) return null
                vcfMarkup.push(
                    `<rect x="${drawStart}" y="${barY}" width="${Math.max(1, drawW)}" height="${barH}" style="fill:${fillColor};fill-opacity:${alpha};stroke:${escapeXml(activeStroke || strokeColor)};stroke-width:${strokeWidth};" />`
                )
                return { drawStart, drawW }
            }

            const drawVariantBlock = (variant, topPass) => {
                const vtype = localVcfType(variant)
                const layoutInfo = getVcfDetailVariantLayout(variant, vtype)
                const vpos = layoutInfo.vpos
                if (!Number.isFinite(vpos)) return
                const visibleStart = Math.min(layoutInfo.anchorStart, layoutInfo.refStart)
                const visibleEnd = Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
                if (visibleStart > viewEnd || visibleEnd < viewStart) return
                const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
                const isClicked = cvPos === vpos && cvType === vtype
                const active = isHovered || isClicked
                if (topPass !== active) return
                const activeStroke = isClicked
                    ? (isLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,1.0)')
                    : isHovered
                        ? (isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)')
                        : null
                const strokeWidth = isClicked ? 2.5 : isHovered ? 2 : 1

                if (vtype === 'ins' || vtype === 'del') {
                    if (vtype === 'del' && layoutInfo.hasDelSpan) {
                        drawSegmentMarkup({
                            segStart: layoutInfo.refStart,
                            segEnd: layoutInfo.refEnd,
                            fillColor: VARIANT_FILL.del,
                            strokeColor: VARIANT_STROKE.del,
                            activeStroke,
                            strokeWidth,
                        })
                    }
                    if (shouldRenderActiveAnchorBase(vtype, active)) {
                        const anchorSeg = drawSegmentMarkup({
                            segStart: layoutInfo.anchorStart,
                            segEnd: layoutInfo.anchorEnd,
                            fillColor: ANCHOR_FILL_ACTIVE,
                            strokeColor: ANCHOR_STROKE,
                            activeStroke,
                            alpha: 1,
                            strokeWidth,
                        })
                        if (anchorSeg && ANCHOR_ICON_BODY) {
                            const anchorCx = anchorSeg.drawStart + (anchorSeg.drawW / 2)
                            const margin = 0.5
                            const targetH = Math.max(4, barH - margin * 2)
                            const targetW = Math.max(4, Math.min(anchorSeg.drawW - margin * 2, targetH * 1.05))
                            const iH = Math.max(4, targetH * 0.9)
                            const iW = Math.max(4, targetW * 0.9)
                            const x = anchorCx - (iW / 2)
                            const y = (barY + barH / 2) - (iH / 2)
                            vcfMarkup.push(
                                `<g transform="translate(${x} ${y}) scale(${iW / 32} ${iH / 32})" fill="${escapeXml(isLight ? '#0f172a' : '#e2e8f0')}">${ANCHOR_ICON_BODY}</g>`
                            )
                        }
                    }
                    return
                }

                const seg = drawSegmentMarkup({
                    segStart: layoutInfo.refStart,
                    segEnd: layoutInfo.refEnd,
                    fillColor: vtype === 'snv'
                        ? (isPosiGenic(vpos) ? vcfGenicColor : vcfIntergenicColor)
                        : (VARIANT_FILL[vtype] || (isLight ? '#64748b' : '#94a3b8')),
                    strokeColor: vtype === 'snv'
                        ? (isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)')
                        : (VARIANT_STROKE[vtype] || (isLight ? 'rgba(60,60,60,0.6)' : 'rgba(200,200,200,0.5)')),
                    activeStroke,
                    strokeWidth,
                })
                if (!seg) return
                if (vtype === 'snv' && seg.drawW >= 14) {
                    vcfMarkup.push(
                        `<text x="${seg.drawStart + seg.drawW / 2}" y="${barY - 4}" fill="${escapeXml(active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#1e3a8a' : '#93c5fd'))}" text-anchor="middle" dominant-baseline="alphabetic" style="font:${escapeXml(sansFont(9))};">${escapeXml(variant.label || 'SNV')}</text>`
                    )
                }
            }

            for (const variant of variants) {
                if (localVcfType(variant) !== 'snv') drawVariantBlock(variant, false)
            }
            for (const variant of variants) {
                if (localVcfType(variant) === 'snv') drawVariantBlock(variant, false)
            }
            for (const variant of variants) {
                drawVariantBlock(variant, true)
            }

            if (showIndelMarkers) {
                for (const { v, vpos, x, dir, level, nBars } of indelItems) {
                    if (vpos > viewEnd || vpos < viewStart) continue
                    const vtype = localVcfType(v)
                    const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
                    const isClicked = cvPos === vpos && cvType === vtype
                    const active = isHovered || isClicked
                    const dotColor = VARIANT_FILL[vtype] || '#888'
                    const lineBaseLen = showIndelLabels ? 29 : 22
                    const lineLen = lineBaseLen + level * 18
                    const dotY = dir === 'up' ? (barY - lineLen) : (barY + barH + lineLen)
                    const dotR = active ? 5 : 4
                    vcfMarkup.push(
                        `<line x1="${x}" y1="${dir === 'up' ? barY : barY + barH}" x2="${x}" y2="${dotY}" stroke="${escapeXml(isLight ? 'rgba(80,80,80,0.55)' : 'rgba(200,200,200,0.5)')}" stroke-width="${active ? 1.5 : 1}" stroke-dasharray="3 3" />`
                    )
                    vcfMarkup.push(
                        `<circle cx="${x}" cy="${dotY}" r="${dotR}" style="fill:${dotColor};stroke:${escapeXml(active ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)') : (isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)'))};stroke-width:${active ? 1.5 : 1};" />`
                    )
                    if (showIndelLabels) {
                        const abH = 3
                        const abLen = 12
                        const abGap = 2
                        const abStartX = x + dotR + 3
                        const abY = dir === 'up'
                            ? Math.min(dotY + dotR + 3, barY - abH - 5)
                            : Math.max(barY + barH + 5, dotY - dotR - abH - 3)
                        for (let i = 0; i < nBars; i += 1) {
                            vcfMarkup.push(
                                `<rect x="${abStartX + i * (abLen + abGap)}" y="${abY}" width="${abLen}" height="${abH}" fill="${escapeXml(dotColor)}" fill-opacity="${active ? 0.85 : 0.55}" />`
                            )
                        }
                        const label = vtype === 'ins' ? 'ins' : vtype === 'del' ? 'del' : 'indel'
                        vcfMarkup.push(
                            `<text x="${x + dotR + 3}" y="${dotY + 3}" fill="${escapeXml(active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#334155' : '#cbd5e1'))}" text-anchor="start" dominant-baseline="alphabetic" style="font:${escapeXml(active ? sansFont(9, 'bold') : sansFont(9))};">${escapeXml(label)}</text>`
                        )
                    }
                }
            }

            pushOverlayMarkup(vcfMarkup.join(''))
        }

        // The note bubbles are DOM over the canvas, so the raster below has no
        // trace of them — an export would otherwise drop the one mark saying
        // this gene has been written about. Their coordinates are already
        // canvas-local, which is the space these sections are emitted in.
        const noteBubbles = geneNoteOverlayRef.current?.bubbles || []
        if (noteBubbles.length > 0) {
            const bubbleColor = escapeXml(panelPillColor)
            pushOverlayMarkup(noteBubbles.map((bubble) => noteBubbleGlyphSvgMarkup({
                x: bubble.x + (NOTE_BUBBLE_SIZE / 2),
                y: bubble.y + (NOTE_BUBBLE_SIZE / 2),
                size: NOTE_BUBBLE_SIZE,
                color: bubbleColor,
                fill: true,
                knockout: escapeXml(colors.bg),
            })).join(''))
        }

        let canvasImageHref = canvas.toDataURL('image/png')
        if (sidebarToggleDescriptors.length > 0 || textMaskRects.length > 0) {
            const exportCanvas = document.createElement('canvas')
            exportCanvas.width = canvas.width
            exportCanvas.height = canvas.height
            const exportCtx = exportCanvas.getContext('2d')
            if (exportCtx) {
                exportCtx.drawImage(canvas, 0, 0)
                const scaleX = exportCanvas.width / Math.max(1, canvas.clientWidth || width || 1)
                const scaleY = exportCanvas.height / Math.max(1, canvas.clientHeight || canvasHeight || 1)
                for (const maskRect of textMaskRects) {
                    exportCtx.fillStyle = maskRect.fill
                    exportCtx.fillRect(
                        maskRect.x * scaleX,
                        maskRect.y * scaleY,
                        maskRect.width * scaleX,
                        maskRect.height * scaleY
                    )
                }
                for (const descriptor of sidebarToggleDescriptors) {
                    const half = (SIDEBAR_TOGGLE_ICON_SIZE / 2) + 1
                    exportCtx.save()
                    exportCtx.translate(descriptor.x * scaleX, descriptor.y * scaleY)
                    exportCtx.scale(scaleX, scaleY)
                    exportCtx.fillStyle = descriptor.maskFill
                    exportCtx.fillRect(-half, -half, half * 2, half * 2)
                    exportCtx.restore()
                }
                canvasImageHref = exportCanvas.toDataURL('image/png')
            }
        }

        const sections = []
        let cursorY = 0
        const appendForeignObject = (node, height) => {
            if (!node || !(height > 0)) return
            const markup = buildForeignObjectMarkup(node, { width, height })
            if (!markup) return
            sections.push(
                `<foreignObject x="0" y="${cursorY}" width="${width}" height="${height}">${markup}</foreignObject>`
            )
            cursorY += height
        }

        if (effectiveToolbarPosition === 'top') appendForeignObject(toolbarNode, toolbarHeight)
        if (effectiveFocusBarPosition === 'top') appendForeignObject(focusNode, focusHeight)

        const canvasOffsetY = cursorY
        sections.push(
            `<image x="0" y="${cursorY}" width="${width}" height="${canvasHeight}" href="${escapeXml(canvasImageHref)}" preserveAspectRatio="none" />`
        )
        if (textDescriptors.length > 0) {
            sections.push(
                textDescriptors.map((descriptor) => (
                    `<text x="${descriptor.x}" y="${canvasOffsetY + descriptor.y}" fill="${escapeXml(descriptor.fill)}" text-anchor="${descriptor.textAnchor}" dominant-baseline="${descriptor.dominantBaseline}" style="font:${escapeXml(descriptor.font)};">${escapeXml(descriptor.text)}</text>`
                )).join('')
            )
        }
        if (overlayMarkupSections.length > 0) {
            sections.push(
                overlayMarkupSections.map((markup) => (
                    `<g data-export-overlay="detail-layer" transform="translate(0 ${canvasOffsetY})">${markup}</g>`
                )).join('')
            )
        }
        if (sidebarToggleDescriptors.length > 0) {
            sections.push(
                sidebarToggleDescriptors.map((descriptor) => (
                    `<g data-export-icon="sidebar-toggle">`
                    + powerGlyphSvgMarkup({
                        x: descriptor.x,
                        y: canvasOffsetY + descriptor.y,
                        size: SIDEBAR_TOGGLE_ICON_SIZE,
                        color: escapeXml(descriptor.iconColor),
                    })
                    + `</g>`
                )).join('')
            )
        }
        cursorY += canvasHeight

        if (effectiveFocusBarPosition === 'bottom') appendForeignObject(focusNode, focusHeight)
        if (effectiveToolbarPosition === 'bottom') appendForeignObject(toolbarNode, toolbarHeight)

        const svgMarkup = buildSvgDocument({
            width,
            height: cursorY,
            body: sections.join(''),
            backgroundColor: colors.bg,
        })

        return {
            width,
            height: cursorY,
            svgMarkup,
            backgroundColor: colors.bg,
        }
    }, [ANCHOR_ICON_BODY, REV_COMP, alignData, alignmentCoords, bpPerPx, clickedBigBedFeature, clickedVcfVariant, colors, colors.bg, colors.geneLabelText, colors.rulerBg, colors.rulerText, customTrackData, customTracksById, dimNonSelectedGenes, effectiveFocusBarPosition, effectiveHiddenStrands, effectiveRulerHeight, effectiveRulerPosition, effectiveToolbarPosition, expandedGenes, flattenTracks, genes, genomicToScreen, getBasePixelBounds, getGenomicIntervalPixelBounds, getCustomTrackToggleY, getEffectiveTranscriptLimit, getGeneRowCountForWidth, getVcfBlockLevel, hoveredBigBedFeature, hoveredSeqBase, hoveredVcfBlock, isAligned, isLight, isPrimaryPanel, isFlipped, isSelectedHidden, isLocationFocusVisible, isTranscriptCompressionActive, isCompressedLayoutActive, isCustomTrackId, layout, overlayToGenomic, panelPillColor, sidebarToggleIconColor, selectedGene, seqRange, sequence, sequenceTrackLabel, showSequenceTrack, shouldForceGeneBlockView, trackOrder, trackWidth, transcriptCache, transcriptLayoutMetrics, viewEnd, viewHeight, viewSpan, viewStart, viewWidth])

    const buildPanelExportSnapshotRef = useRef(buildPanelExportSnapshot)
    useEffect(() => {
        buildPanelExportSnapshotRef.current = buildPanelExportSnapshot
    }, [buildPanelExportSnapshot])

    const screenshotTargetDescriptor = useMemo(() => {
        if (!screenshotTargetId) return null
        return {
            id: screenshotTargetId,
            label: genomePillLabel || label || 'Genome browser panel',
            buildDefaultFilename: () => buildDefaultScreenshotName(),
            getVisibleRect: () => rootRef.current?.getBoundingClientRect() || null,
            getScrollElement: () => findNearestScrollable(containerRef.current) || containerRef.current || null,
            buildExportSnapshot: () => buildPanelExportSnapshotRef.current?.(),
        }
    }, [genomePillLabel, label, screenshotTargetId])

    useEffect(() => {
        if (typeof onScreenshotTargetChangeRef.current !== 'function') return undefined
        onScreenshotTargetChangeRef.current(screenshotTargetDescriptor)
        return () => {
            if (typeof onScreenshotTargetChangeRef.current === 'function') {
                onScreenshotTargetChangeRef.current(null)
            }
        }
    }, [screenshotTargetDescriptor])

    const getCustomTrackGeometry = useCallback((trackLayout, renderMode, trackType = '', data = null) => {
        if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
            const vcfLevel = getVcfBlockLevel(bpPerPx)
            const isDetailMode = data?.mode === 'adp_detail' || vcfLevel?.mode === 'detail'
            const top = trackLayout.y + (isDetailMode ? 18 : 8)
            const bottom = trackLayout.y + trackLayout.height - 8
            const plotHeight = Math.max(8, bottom - top)
            const barH = Math.max(3, Math.floor(plotHeight * (isDetailMode ? 0.13 : 0.18)))
            const barY = top + Math.floor((plotHeight - barH) / 2)
            return {
                top,
                bottom,
                plotHeight,
                labelY: isDetailMode
                    ? (trackLayout.y + 10)
                    : Math.max(trackLayout.y + 10, barY - 8),
                variantBarY: barY,
                variantBarH: barH,
                bumpAreaTop: top,
                bumpAreaBottom: bottom,
            }
        }

        if (renderMode !== 'zoned_heatmap') {
            const top = trackLayout.y + 18
            const bottom = trackLayout.y + trackLayout.height - 8
            return {
                top,
                bottom,
                plotHeight: Math.max(8, bottom - top),
                labelY: trackLayout.y + 9,
                // For ensembl VCF: allocate vertical subzones
                variantBarY: trackLayout.y + 18,
                variantBarH: 8,
                bumpAreaTop: trackLayout.y + 30,
                bumpAreaBottom: trackLayout.y + trackLayout.height - 8,
            }
        }

        const labelBand = 14
        const topPad = 4
        const bottomPad = 6
        const gap = 2
        const labelBelow = isPrimaryPanel
        if (labelBelow) {
            const top = trackLayout.y + topPad
            const bottom = trackLayout.y + trackLayout.height - (labelBand + bottomPad + gap)
            return {
                top,
                bottom,
                plotHeight: Math.max(8, bottom - top),
                labelY: trackLayout.y + trackLayout.height - bottomPad - (labelBand / 2),
            }
        }

        const top = trackLayout.y + labelBand + topPad
        const bottom = trackLayout.y + trackLayout.height - bottomPad
        return {
            top,
            bottom,
            plotHeight: Math.max(8, bottom - top),
            labelY: trackLayout.y + topPad + (labelBand / 2),
        }
    }, [isPrimaryPanel, getVcfBlockLevel, bpPerPx])

    const getCustomTrackHover = useCallback((mouseX, mouseY, clientX, clientY) => {
        const left = LHS_WIDTH + 2
        const right = viewWidth - 2
        for (const [trackId, trackLayout] of Object.entries(layout.customTrackLayouts)) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue
            const data = customTrackData[trackId]
            const trackType = track.type || 'bigwig'
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const { top, bottom, plotHeight } = getCustomTrackGeometry(trackLayout, renderMode, trackType, data)
            // For adp_detail tracks expand Y so indel markers that extend beyond the track bar are reachable
            const yExpand = (data?.mode === 'adp_detail' && bpPerPx <= 1) ? 80 : 0
            if (mouseX < left || mouseX > right || mouseY < top - yExpand || mouseY > bottom + yExpand) continue

            // ── Adaptive-like VCF (density/block) — hover highlight only, no tooltip ─────────────
            if (track.type === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                const plotHeight = bottom - top
                const curSpan = Math.max(1, viewEnd - viewStart)
                const genomicPos = viewStart + ((mouseX - left) / Math.max(1, right - left)) * curSpan
                const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, curSpan)) * (right - left)
                if (data?.mode === 'adp_detail') {
                    const barH = Math.max(5, Math.floor(plotHeight * 0.13))
                    const barY = top + Math.floor((plotHeight - barH) / 2)
                    const variants = Array.isArray(data?.variants) ? data.variants : []

                    // ── Check 1: bar hit (tight Y band) ──────────────────────────────
                    if (mouseY >= barY - 8 && mouseY <= barY + barH + 8) {
                        // Prefer narrowest match so SNVs win over large spanning deletions
                        let bestMatch = null
                        let bestSpan = Infinity
	                        for (const v of variants) {
	                            const lvtype = localVcfType(v)
	                            const layoutInfo = getVcfDetailVariantLayout(v, lvtype)
	                            const refStart = lvtype === 'del'
	                                ? layoutInfo.anchorStart
	                                : layoutInfo.refStart
	                            const refEnd = lvtype === 'del'
	                                ? Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
	                                : layoutInfo.refEnd
	                            if (genomicPos < refStart - 0.5 || genomicPos > refEnd + 0.5) continue
	                            // Pixel proximity — cursor must be near the rendered block
	                            const vx1 = blockGToX(refStart)
                            const vx2 = blockGToX(refEnd)
                            const pxMargin = Math.max(4, Math.min(10, 6 / Math.max(0.01, bpPerPx)))
                            if (mouseX < vx1 - pxMargin || mouseX > vx2 + pxMargin) continue
                            const span = refEnd - refStart
                            if (span < bestSpan) { bestSpan = span; bestMatch = v }
                        }
                        if (bestMatch) {
                            return { hoverBlock: { trackId, start: Number(bestMatch.pos), end: Number(bestMatch.end ?? bestMatch.pos), variant: bestMatch } }
                        }
                    }

                    // ── Check 2: indel dot / label hit ───────────────────────────────
                    if (bpPerPx <= 1) {
                        const lineBaseLen = bpPerPx <= 0.5 ? 29 : 22
                        const indelHits = []
                        const seenHit = new Set()
	                        for (const v of variants) {
	                            const vtype = localVcfType(v)
	                            if (vtype === 'snv') continue
	                            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                            const vpos = layoutInfo.vpos
	                            if (!Number.isFinite(vpos)) continue
	                            const key = `${vtype}:${vpos}`
	                            if (seenHit.has(key)) continue
	                            seenHit.add(key)
	                            const vend = Number(v?.end ?? v?.pos)
	                            const xGenomic = layoutInfo.markerXGenomic
	                            const x = blockGToX(Math.max(viewStart, xGenomic))
	                            const nBars = getVcfAltAlleleCount(v)
                            const primaryDir = vtype === 'ins' ? 'up' : 'down'
                            const altDir = primaryDir === 'up' ? 'down' : 'up'
                            let dir = primaryDir
                            let level = 0
                            if (bpPerPx <= 0.5) {
                                const MAX_LEVEL = 3
                                let lP = 0, lA = 0
                                for (const existing of indelHits) {
                                    const leftNBars = existing.x <= x ? existing.nBars : nBars
                                    const inProximity = Math.abs(existing.x - x) < Math.max(50, 7 + leftNBars * 14 + 5)
                                    if (inProximity) {
                                        if (existing.dir === primaryDir) lP = Math.max(lP, existing.level + 1)
                                        if (existing.dir === altDir)    lA = Math.max(lA, existing.level + 1)
                                    }
                                }
                                lP = Math.min(lP, MAX_LEVEL)
                                lA = Math.min(lA, MAX_LEVEL)
                                if (lA < lP) { dir = altDir; level = lA }
                                else          { dir = primaryDir; level = lP }
                            }
                            indelHits.push({ v, vpos, vend, x, dir, level, nBars })
                        }
                        for (const { v, vpos, vend, x, dir, level } of indelHits) {
                            const lineLen = lineBaseLen + level * 18
                            const dotY = dir === 'up' ? barY - lineLen : barY + barH + lineLen
                            const hitR = 10
                            if (mouseX >= x - hitR && mouseX <= x + hitR && mouseY >= dotY - hitR && mouseY <= dotY + hitR) {
                                return { hoverBlock: { trackId, start: vpos, end: vend, variant: v } }
                            }
                        }
                    }

                    return null
                }
                // Block mode (L0–L3) — gate on actual bar Y bounds
                const barH = Math.max(2, Math.floor(plotHeight * 0.12))
                const barY = top + Math.max(2, Math.floor((plotHeight - barH) * 0.2))
                if (mouseY < barY - 6 || mouseY > barY + barH + 6) return null
                const spans = Array.isArray(data?.block_spans) ? data.block_spans : []
                for (const span of spans) {
                    if (genomicPos >= span.start && genomicPos < span.end) {
                        return { hoverBlock: { trackId, start: span.start, end: span.end } }
                    }
                }
                return null
            }

            if (track.type === 'splice_junctions' && Array.isArray(data?.junctions)) {
                const curSpan = Math.max(1, viewEnd - viewStart)
                const genomicPos = viewStart + ((mouseX - left) / Math.max(1, right - left)) * curSpan
                const lodMode = getSpliceLodMode(trackId, bpPerPx, renderMode)
                if (lodMode === 'blocks') {
                    return null
                }

                const baselineY = bottom - 4
                const minTopY = top + 1
                const lanePitch = lodMode === 'detail' ? 10 : 8
                const capByHeight = Math.max(1, Math.floor((baselineY - minTopY) / lanePitch))
                const maxVisibleLanes = Math.max(1, Math.min(capByHeight, Number(data?.layout?.max_visible_lanes || capByHeight)))
                const spliceCandidates = []
                for (const j of data.junctions) {
                    const s = Number(j?.start)
                    const e = Number(j?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (genomicPos < s || genomicPos > e) continue
                    const lane = Math.max(0, Number(j?.lane || 0))
                    if (lane >= maxVisibleLanes) continue
                    const x1 = left + ((s - viewStart) / Math.max(1, curSpan)) * (right - left)
                    const x2 = left + ((e - viewStart) / Math.max(1, curSpan)) * (right - left)
                    const widthPx = Math.abs(x2 - x1)
                    if (widthPx < 1) continue
                    const key = spliceJunctionKey(j)
                    const mapKey = `${trackId}|${key}`
                    spliceCandidates.push({
                        ...j,
                        key,
                        x1,
                        x2,
                        widthPx,
                        manual_lift: Number(spliceArcLiftOffsets[mapKey] || 0),
                    })
                }
                const laidOut = annotateSpliceSimilarityLift(spliceCandidates, lodMode)
                let best = null
                let bestDist = Infinity
                for (const j of laidOut) {
                    const lane = Math.max(0, Number(j?.lane || 0))
                    const extraLift = Number(j?.manual_lift || 0) + Number(j?.similarity_lift || 0)
                    const peakY = computeSplicePeakY({
                        baselineY,
                        minTopY,
                        lane,
                        lanePitch,
                        widthPx: j.widthPx,
                        lodMode,
                        extraLift,
                    })
                    const controls = getSpliceBezierControls(j.x1, j.x2, peakY)
                    const t = clamp((mouseX - j.x1) / Math.max(1e-6, j.x2 - j.x1), 0, 1)
                    const yOnCurve = cubicPointAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                    const dist = Math.abs(mouseY - yOnCurve)
                    const threshold = 6 + Math.min(8, Math.log2(1 + (Number(j?.n_total ?? j?.reads ?? 0) || 0)))
                    if (dist <= threshold && dist < bestDist) {
                        bestDist = dist
                        best = {
                            ...j,
                            _hover_x: j.x1 + (j.x2 - j.x1) * 0.5,
                            _hover_y: yOnCurve,
                        }
                    }
                }
                if (best) {
                    return {
                        hoverSplice: {
                            trackId,
                            junction: best,
                            anchorCanvasX: best._hover_x,
                            anchorCanvasY: best._hover_y,
                        },
                    }
                }
                return null
            }

            if (track.type === 'bigbed' && data?.mode === 'bigbed_detail' && Array.isArray(data?.features)) {
                const curSpan = Math.max(1, viewEnd - viewStart)
                const lanePitch = BIGBED_DETAIL_LANE_PITCH
                const exonH = BIGBED_DETAIL_EXON_HEIGHT
                const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                const maxVisibleLanes = getBigBedLaneCapacity(plotHeight)
                let best = null
                let bestDist = Infinity
                let bestRank = Infinity
                for (const feature of data.features) {
                    const s = Number(feature?.start)
                    const e = Number(feature?.end)
                    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                    if (e <= viewStart || s >= viewEnd) continue
                    const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                    if (lane >= maxVisibleLanes) continue
                    const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                    const drawX1 = left + ((s - viewStart) / curSpan) * (right - left)
                    const drawX2 = left + ((e - viewStart) / curSpan) * (right - left)
                    const txLeft = Math.min(drawX1, drawX2)
                    const txRight = Math.max(drawX1, drawX2)
                    const key = bigBedFeatureKey(feature)

                    const isTranscript = feature?._render_kind === 'transcript'
                        && feature?._structure_valid === true
                        && Array.isArray(feature?._exon_blocks)
                        && feature._exon_blocks.length > 0

                    let candidate = null
                    if (isTranscript) {
                        if (mouseY >= (yMid - exonH / 2 - 3) && mouseY <= (yMid + exonH / 2 + 3)) {
                            for (const exon of feature._exon_blocks) {
                                const es = Number(exon?.start)
                                const ee = Number(exon?.end)
                                if (!Number.isFinite(es) || !Number.isFinite(ee) || ee <= es) continue
                                if (ee <= viewStart || es >= viewEnd) continue
                                const ex1 = left + ((es - viewStart) / curSpan) * (right - left)
                                const ex2 = left + ((ee - viewStart) / curSpan) * (right - left)
                                const exonLeft = Math.min(ex1, ex2)
                                const exonRight = Math.max(ex1, ex2)
                                if (mouseX < exonLeft - 2 || mouseX > exonRight + 2) continue
                                const centerX = (exonLeft + exonRight) / 2
                                const dist = Math.abs(mouseX - centerX)
                                candidate = {
                                    rank: 0,
                                    dist,
                                    anchorCanvasX: centerX,
                                    anchorCanvasY: yMid,
                                }
                                break
                            }
                        }
                        if (!candidate && mouseY >= yMid - 4 && mouseY <= yMid + 4 && mouseX >= txLeft - 2 && mouseX <= txRight + 2) {
                            candidate = {
                                rank: 1,
                                dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                                anchorCanvasX: (txLeft + txRight) / 2,
                                anchorCanvasY: yMid,
                            }
                        }
                    }

                    if (!candidate) {
                        if (mouseY < yMid - 6 || mouseY > yMid + 6) continue
                        if (mouseX < txLeft - 2 || mouseX > txRight + 2) continue
                        candidate = {
                            rank: 2,
                            dist: Math.abs(mouseX - ((txLeft + txRight) / 2)),
                            anchorCanvasX: (txLeft + txRight) / 2,
                            anchorCanvasY: yMid,
                        }
                    }

                    if (!candidate) continue
                    if (candidate.rank < bestRank || (candidate.rank === bestRank && candidate.dist < bestDist)) {
                        bestRank = candidate.rank
                        bestDist = candidate.dist
                        best = {
                            feature,
                            key,
                            anchorCanvasX: candidate.anchorCanvasX,
                            anchorCanvasY: candidate.anchorCanvasY,
                        }
                    }
                }
                if (best) {
                    return {
                        hoverBigBed: {
                            trackId,
                            key: best.key,
                            feature: best.feature,
                            anchorCanvasX: best.anchorCanvasX,
                            anchorCanvasY: best.anchorCanvasY,
                        },
                    }
                }
                return null
            }

            // ── Signal / density bins ────────────────────────────────────────
            const bins = data?.bins
            if (!Array.isArray(bins) || bins.length === 0) return null

            const binWidth = (right - left) / bins.length
            const idx = clamp(Math.floor((mouseX - left) / Math.max(1e-9, binWidth)), 0, bins.length - 1)
            const value = bins[idx]
            return {
                x: clientX,
                y: clientY,
                hoverKey: `${trackId}|${idx}`,
                text: `${track.label || 'Custom track'}: ${formatSignalValueExact(value)}`,
            }
        }
        return null
    }, [layout, customTracksById, customTrackData, viewWidth, viewStart, viewEnd, bpPerPx, formatSignalValueExact, getCustomTrackGeometry, getSpliceLodMode, spliceArcLiftOffsets])

    // Sync with external position (for locked dual browsers).
    // useLayoutEffect (not useEffect) so the position update is applied synchronously
    // before the browser paints — keeps secondary panels in step with the primary.
    useLayoutEffect(() => {
        if (!externalPosition) return
        const extChrom = String(externalPosition.chrom || '').trim()
        if (extChrom && extChrom !== selectedChrom) {
            const region = regions.find((r) => r.chrom === extChrom)
            if (region) {
                setSelectedChrom(extChrom)
                if (region?.end) setChromLength(region.end)
                setGenes([])
                tileCacheRef.current.clear()
                fetchingTilesRef.current.clear()
                // Re-run once selected chromosome state has been applied.
                return
            }
            if (regions.length > 0) {
                console.warn(`[GenomeBrowser:${genome}] Ignoring linked viewport chromosome ${extChrom}; it is not present in this genome.`)
            }
        }
        if (lockPan) {
            // Pan lock: sync both start and end (position + zoom)
            let [nextStart, nextEnd] = clampView(externalPosition.start, externalPosition.end)
            if (Math.abs(nextStart - viewStartRef.current) > 1e-6 || Math.abs(nextEnd - viewEndRef.current) > 1e-6) {
                setViewStart(nextStart)
                setViewEnd(nextEnd)
            }
        } else if (lockZoom) {
            if (Number.isFinite(externalPosition.anchorRatio)) {
                // Zoom event: the parent pre-computed our ratio-anchored position — apply directly.
                let [nextStart, nextEnd] = clampView(externalPosition.start, externalPosition.end)
                if (Math.abs(nextStart - viewStartRef.current) > 1e-6 || Math.abs(nextEnd - viewEndRef.current) > 1e-6) {
                    setViewStart(nextStart)
                    setViewEnd(nextEnd)
                }
            } else {
                // Pan event: keep our own center, just match the span.
                const extSpan = externalPosition.end - externalPosition.start
                const myCenter = (viewStartRef.current + viewEndRef.current) / 2
                let [nextStart, nextEnd] = clampView(myCenter - extSpan / 2, myCenter + extSpan / 2)
                if (Math.abs(nextStart - viewStartRef.current) > 1e-6 || Math.abs(nextEnd - viewEndRef.current) > 1e-6) {
                    setViewStart(nextStart)
                    setViewEnd(nextEnd)
                }
            }
        }

    }, [lockPan, lockZoom, externalPosition, clampView, selectedChrom, regions])

    // Notify parent of our actual current view position so it can use the real
    // value for ratio-anchored zoom (avoids stale panelPositions state jumps).
    useEffect(() => {
        if (onViewSyncRef.current) onViewSyncRef.current(selectedChrom, viewStart, viewEnd)
    }, [viewStart, viewEnd, selectedChrom])

    // Zoom centered on a screen position
    const zoomAt = useCallback((screenX, factor, targetTrack) => {
        if (onManualNavigate) onManualNavigate()
        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        let currentSpan = currentEnd - currentStart
        let newSpan = currentSpan * factor
        newSpan = Math.max(MIN_VIEW_SPAN, Math.min(MAX_VIEW_SPAN, newSpan))

        const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)
        const clampedX = Math.max(LHS_WIDTH, Math.min(viewWidth, screenX))
        const ratio = Math.max(0, Math.min(1, (clampedX - LHS_WIDTH) / trackWidth))
        const anchor = isFlipped
            ? currentEnd - ratio * currentSpan
            : currentStart + ratio * currentSpan
        const startRatio = isFlipped ? (1 - ratio) : ratio

        let newStart = anchor - newSpan * startRatio
        let newEnd = newStart + newSpan
        let [clampedStart, clampedEnd] = clampView(newStart, newEnd)

        // At base-level zoom, snap to integer positions so bases align between tracks
        if ((clampedEnd - clampedStart) <= 1000) {
            const snappedStart = Math.round(clampedStart)
            clampedEnd = snappedStart + (clampedEnd - clampedStart)
            clampedStart = snappedStart
                ;[clampedStart, clampedEnd] = clampView(clampedStart, clampedEnd)
        }

        // Pass ratio so linked panels apply the same screen-position anchor.
        scheduleInteractiveViewport(clampedStart, clampedEnd, targetTrack, ratio)
    }, [viewWidth, clampView, isFlipped, onManualNavigate, scheduleInteractiveViewport])

    // Mouse handlers
    const dragStartYRef = useRef(0)
    const dragScrollTopRef = useRef(0)
    const dragAxisRef = useRef(null) // null = undecided, 'x' = horizontal pan, 'y' = vertical scroll
    const scrollTargetRef = useRef(null) // the nearest scrollable ancestor at drag start
    const findNearestScrollable = (el) => {
        let current = el
        while (current && current !== document.body) {
            const overflowY = window.getComputedStyle(current).overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 1) {
                return current
            }
            current = current.parentElement
        }
        return null
    }
    const readAnchorScrollTop = (scrollElement) => (
        scrollElement && scrollElement !== document.documentElement && scrollElement !== document.body
            ? scrollElement.scrollTop
            : (window.scrollY || document.documentElement?.scrollTop || 0)
    )

    const expandedGeneFooters = useMemo(() => {
        if (compressTranscripts || isViewportTranscriptExpandMode) return []

        const footers = []
        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            const txs = transcriptCache[gene.id]
            if (!Array.isArray(txs) || txs.length < 2) continue

            const displayRows = getDisplayTranscriptRows(gene)
            const visibleRows = displayRows.filter((row) => !row.ghost)
            if (visibleRows.length < 2) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2) || Math.abs(rawGx2 - rawGx1) < 60) {
                continue
            }

            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue

            const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const footer = getGeneFooterGeometry({
                gene,
                txs,
                getEffectiveTranscriptLimit,
                visibleTranscriptCount: displayRows.length,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue

            footers.push({
                ...footer,
                // An expanded footer is one horizontal unit: label, then X.
                controlY: footer.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET,
                geneId: String(gene.id),
                label: String(gene.name || gene.id || '').trim(),
                trackBackground: isForward ? colors.forwardStrandBg : colors.reverseStrandBg,
            })
        }
        return footers
    }, [genes, compressTranscripts, isViewportTranscriptExpandMode, flattenTracks, isGeneHiddenFromTracks,
        transcriptCache, getDisplayTranscriptRows, genomicToScreen, effectiveHiddenStrands, layout,
        transcriptLayoutMetrics, getEffectiveTranscriptLimit, viewWidth, colors.forwardStrandBg,
        colors.reverseStrandBg])

    useLayoutEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || expandedGeneFooters.length === 0) {
            setExpandedFooterViewport((prev) => (prev === null ? prev : null))
            return undefined
        }

        const scrollElement = findNearestScrollable(canvas)
        let frameId = null

        const updateViewport = () => {
            frameId = null
            const canvasRect = canvas.getBoundingClientRect()
            const scrollRect = scrollElement?.getBoundingClientRect?.() || null
            const visibleTopClient = Math.max(
                0,
                canvasRect.top,
                Number.isFinite(scrollRect?.top) ? scrollRect.top : 0,
            )
            const visibleBottomClient = Math.min(
                window.innerHeight,
                canvasRect.bottom,
                Number.isFinite(scrollRect?.bottom) ? scrollRect.bottom : window.innerHeight,
            )
            const next = visibleBottomClient > visibleTopClient
                ? {
                    top: Math.max(0, visibleTopClient - canvasRect.top),
                    bottom: Math.max(0, visibleBottomClient - canvasRect.top),
                }
                : null

            setExpandedFooterViewport((prev) => {
                if (prev === null || next === null) return prev === next ? prev : next
                if (Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.bottom - next.bottom) < 0.5) return prev
                return next
            })
        }

        const scheduleViewportUpdate = () => {
            if (frameId !== null) return
            frameId = window.requestAnimationFrame(updateViewport)
        }

        updateViewport()
        scrollElement?.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
        window.addEventListener('scroll', scheduleViewportUpdate, { passive: true, capture: true })
        window.addEventListener('resize', scheduleViewportUpdate, { passive: true })

        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(scheduleViewportUpdate)
            : null
        resizeObserver?.observe(canvas)
        if (scrollElement) resizeObserver?.observe(scrollElement)

        return () => {
            if (frameId !== null) window.cancelAnimationFrame(frameId)
            scrollElement?.removeEventListener('scroll', scheduleViewportUpdate)
            window.removeEventListener('scroll', scheduleViewportUpdate, { capture: true })
            window.removeEventListener('resize', scheduleViewportUpdate)
            resizeObserver?.disconnect()
        }
    }, [expandedGeneFooters])

    const expandedFooterPlacementByGeneId = useMemo(() => {
        const placements = new Map()
        for (const footer of expandedGeneFooters) {
            placements.set(footer.geneId, {
                ...placeGeneFooterWithinViewport(footer, expandedFooterViewport),
                geneId: footer.geneId,
                label: footer.label,
                trackBackground: footer.trackBackground,
            })
        }
        return placements
    }, [expandedGeneFooters, expandedFooterViewport])
    const expandedFooterGeneIds = useMemo(
        () => new Set(expandedGeneFooters.map((footer) => footer.geneId)),
        [expandedGeneFooters],
    )

    const applyAdaptiveScrollAnchor = useCallback(() => {
        const anchor = adaptiveScrollAnchorRef.current
        const root = rootRef.current
        if (!anchor || !root) {
            adaptiveScrollAnchorRef.current = null
            return false
        }
        if (performance.now() > anchor.expiresAt) {
            adaptiveScrollAnchorRef.current = null
            return false
        }

        // If anything other than this anchor moved the page — the user grabbing the
        // scrollbar, a wheel over the margin — release it rather than fight them.
        const scrollTopNow = readAnchorScrollTop(anchor.scrollElement)
        if (anchor.lastScrollTop != null && Math.abs(scrollTopNow - anchor.lastScrollTop) > 0.5) {
            adaptiveScrollAnchorRef.current = null
            return false
        }

        const currentTop = root.getBoundingClientRect().top
        const deltaY = currentTop - anchor.rootTop
        if (Math.abs(deltaY) > 0.5) {
            if (anchor.scrollElement && anchor.scrollElement !== document.documentElement && anchor.scrollElement !== document.body) {
                anchor.scrollElement.scrollTop += deltaY
            } else {
                window.scrollBy(0, deltaY)
            }
            anchor.rootTop = root.getBoundingClientRect().top
        }
        anchor.lastScrollTop = readAnchorScrollTop(anchor.scrollElement)
        return true
    }, [])

    const scheduleAdaptiveScrollAnchor = useCallback(() => {
        if (adaptiveScrollAnchorFrameRef.current !== null) return
        const tick = () => {
            adaptiveScrollAnchorFrameRef.current = null
            if (applyAdaptiveScrollAnchor()) {
                adaptiveScrollAnchorFrameRef.current = requestAnimationFrame(tick)
            }
        }
        adaptiveScrollAnchorFrameRef.current = requestAnimationFrame(tick)
    }, [applyAdaptiveScrollAnchor])

    /**
     * Drop both imperative scroll anchors immediately.
     *
     * The adaptive panel anchor pins the panel's top for 700ms on a rAF loop,
     * and the transcript-row zoom anchor scrolls the page to keep the hovered
     * row under the cursor. Either one left running while the page scrolls
     * natively spends a frame or two fighting it, which reads as judder — and
     * in the scroll-first schemes that happens on every single wheel event.
     */
    const releaseScrollAnchors = useCallback(() => {
        adaptiveScrollAnchorRef.current = null
        verticalZoomTrackAnchorRef.current = null
        if (adaptiveScrollAnchorFrameRef.current !== null) {
            cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
            adaptiveScrollAnchorFrameRef.current = null
        }
    }, [])

    const captureAdaptiveScrollAnchor = useCallback(() => {
        if (!rootRef.current) return
        const scrollElement = findNearestScrollable(rootRef.current) || document.scrollingElement || document.documentElement
        adaptiveScrollAnchorRef.current = {
            rootTop: rootRef.current.getBoundingClientRect().top,
            scrollElement,
            lastScrollTop: readAnchorScrollTop(scrollElement),
            expiresAt: performance.now() + 700,
        }
        scheduleAdaptiveScrollAnchor()
    }, [scheduleAdaptiveScrollAnchor])

    useEffect(() => {
        return () => {
            if (adaptiveScrollAnchorFrameRef.current !== null) {
                cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
                adaptiveScrollAnchorFrameRef.current = null
            }
        }
    }, [])

    const canVerticallyScrollContainer = useCallback(() => {
        return scrollTargetRef.current !== null
    }, [])

    const handleMouseDown = (e) => {
        e.preventDefault() // Prevent browser text-selection on drag
        // preventDefault also suppresses the default focus, so take it
        // explicitly or keyboard navigation never reaches the clicked panel.
        // preventScroll matters: without it the page jumps and fights the
        // adaptive scroll anchor.
        containerRef.current?.focus({ preventScroll: true })
        setSidebarTooltip(null)
        dismissCustomTrackTooltip()
        hoveredSpliceRef.current = null
        setHoveredSpliceJunction(null)
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current)
            animationRef.current = null
        }

        const canvas = canvasRef.current
        if (canvas) {
            const rect = canvas.getBoundingClientRect()
            const clickX = e.clientX - rect.left
            const clickY = e.clientY - rect.top

            // One-shot rectangular selection mode for box-zoom.
            if (isBoxSelectMode) {
                if (clickX <= LHS_WIDTH) return
                suppressNextClickRef.current = true
                setIsSelectingRect(true)
                setSelectionRect({ x1: clickX, y1: clickY, x2: clickX, y2: clickY })
                return
            }

            // Intercept sidebar toggling or dragging
            if (clickX <= LHS_WIDTH) {
                // A step that limits the browser to zooming means it: the gutter switches
                // a track off and its handle reorders the stack, and neither is zooming.
                // The user who was told they could only zoom should not be able to blank
                // the track by clicking a little to the left of it.
                if (interactionModeRef.current !== 'all') return
                const trackId = getTrackAtY(clickY)

                // Circular hit test around the toggle glyph. The radius is
                // deliberately larger than the glyph so shrinking it did not make
                // the control harder to hit.
                const toggleCenterX = LHS_WIDTH - 13
                const hitRadiusSq = SIDEBAR_TOGGLE_HIT_RADIUS * SIDEBAR_TOGGLE_HIT_RADIUS
                const dxSq = (clickX - toggleCenterX) ** 2
                const hitsToggle = (centerY) => dxSq + (clickY - centerY) ** 2 <= hitRadiusSq

                let toggleTrackId = null
                if (layout.forwardBgHeight > 0 && hitsToggle(layout.FORWARD_Y + layout.forwardBgHeight / 2)) {
                    toggleTrackId = 'forward'
                } else if (layout.reverseBgHeight > 0 && hitsToggle(layout.REVERSE_Y + layout.reverseBgHeight / 2)) {
                    toggleTrackId = 'reverse'
                } else if (showSequenceTrack && layout.SEQUENCE_Y >= 0 && hitsToggle(layout.SEQUENCE_Y + layout.seqBgHeight / 2)) {
                    toggleTrackId = 'sequence'
                } else if (layout.customTrackLayouts) {
                    for (const [tid, tLayout] of Object.entries(layout.customTrackLayouts)) {
                        if (hitsToggle(getCustomTrackToggleY(tLayout))) { toggleTrackId = tid; break }
                    }
                }

                if (toggleTrackId === 'forward') {
                    setHiddenStrands(prev => ({ ...prev, forward: !prev.forward }))
                    return
                } else if (toggleTrackId === 'reverse') {
                    setHiddenStrands(prev => ({ ...prev, reverse: !prev.reverse }))
                    return
                } else if (toggleTrackId === 'sequence') {
                    setHiddenStrands(prev => ({ ...prev, sequence: !prev.sequence }))
                    return
                } else if (toggleTrackId && isCustomTrackId(toggleTrackId)) {
                    setCustomTracks((prev) =>
                        prev.map((track) =>
                            track.id === toggleTrackId
                                ? { ...track, visible: !track.visible }
                                : track
                        )
                    )
                    return
                }

                // If not a toggle, initiate drag-and-drop
                if (trackId) {
                    setDraggingTrack(trackId)
                }

                return // Handled LHS interaction
            }

            // Start splice-arc vertical drag mode (separate from viewport pan).
            const customHover = getCustomTrackHover(clickX, clickY, e.clientX, e.clientY)
            if (customHover?.hoverSplice?.junction) {
                const hit = customHover.hoverSplice
                const junctionKey = spliceJunctionKey(hit.junction)
                const mapKey = `${hit.trackId}|${junctionKey}`
                spliceArcDragRef.current = {
                    trackId: hit.trackId,
                    key: junctionKey,
                    startClientY: e.clientY,
                    initialLift: Number(spliceArcLiftOffsets[mapKey] || 0),
                }
            } else {
                spliceArcDragRef.current = null
            }
        }

        setIsDragging(true)
        isDraggingRef.current = true
        dragStartXRef.current = e.clientX
        // Anchor on the live viewport, not the last committed render: a pan that
        // starts mid-flight would otherwise measure its progress from a stale start.
        dragViewStartRef.current = viewStartRef.current
        dragStartYRef.current = e.clientY
        dragAxisRef.current = null
        const scrollTarget = findNearestScrollable(containerRef.current)
        scrollTargetRef.current = scrollTarget
        dragScrollTopRef.current = scrollTarget ? scrollTarget.scrollTop : 0
        lastPosRef.current = e.clientX
        lastTimeRef.current = performance.now()
        velocityRef.current = 0
    }

    const updateSelectionRectFromEvent = useCallback((e) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = Math.max(LHS_WIDTH, Math.min(viewWidth, e.clientX - rect.left))
        // Keep y unclamped so dragging off-canvas (e.g. onto secondary browser) continues naturally.
        const y = e.clientY - rect.top
        setSelectionRect(prev => prev ? { ...prev, x2: x, y2: y } : prev)
    }, [viewWidth])

    // Returns info about the sequence base under canvas coords (mouseX, mouseY), or null.
    const getSeqBaseAtMouse = useCallback((mouseX, mouseY) => {
        if (!showSequenceTrack || effectiveHiddenStrands.sequence) return null
        const { SEQUENCE_Y } = layout
        const seqBoxT = Math.round(SEQUENCE_Y + 6)
        const seqBoxH = 24
        if (mouseY < seqBoxT || mouseY > seqBoxT + seqBoxH) return null
        const trackW = viewWidth - LHS_WIDTH
        const pxPerBp = trackW / Math.max(1, viewEnd - viewStart)
        if (pxPerBp < 2) return null

        if (isAligned && alignData && viewSpan <= 1000) {
            const overlayPos = isFlipped
                ? viewEnd - (mouseX - LHS_WIDTH) / pxPerBp
                : viewStart + (mouseX - LHS_WIDTH) / pxPerBp
            const i = Math.floor(overlayPos)
            const alnLen = alignData.sequence.length
            let base = null
            if (i >= 0 && i < alnLen) {
                base = alignData.sequence[i]
            } else if (sequence && seqRange) {
                const genomicBp = Math.round(overlayToGenomic(i))
                const seqIdx = genomicBp - seqRange.start
                if (seqIdx >= 0 && seqIdx < sequence.length) {
                    base = sequence[seqIdx]
                    if (alignData.strand === '-') base = REV_COMP[base] || base
                }
            }
            if (!base || base === '-') return null
            const displayBase = isFlipped ? (REV_COMP[base] || base) : base
            const { bxL, bxR } = getBasePixelBounds(i, pxPerBp)
            const bp = Math.round(overlayToGenomic(i))
            return { bp, base: displayBase.toUpperCase(), bxL, bxR, seqBoxT, seqBoxH }
        } else if (sequence && seqRange && viewSpan <= 1000) {
            const overlayPos = isFlipped
                ? viewEnd - (mouseX - LHS_WIDTH) / pxPerBp
                : viewStart + (mouseX - LHS_WIDTH) / pxPerBp
            const bp = Math.floor(overlayPos)
            const seqIdx = bp - seqRange.start
            if (seqIdx < 0 || seqIdx >= sequence.length) return null
            const base = sequence[seqIdx]
            if (!base) return null
            const displayBase = isFlipped ? (REV_COMP[base] || base) : base
            const { bxL, bxR } = getBasePixelBounds(bp, pxPerBp)
            return { bp, base: displayBase.toUpperCase(), bxL, bxR, seqBoxT, seqBoxH }
        }
        return null
    }, [showSequenceTrack, effectiveHiddenStrands, layout, viewWidth, viewEnd, viewStart, viewSpan,
        isAligned, alignData, sequence, seqRange, isFlipped, overlayToGenomic, getBasePixelBounds])

    const handleMouseMove = useCallback((e) => {
        const canvas = canvasRef.current

        if (canvas && isSelectingRect) {
            dismissCustomTrackTooltip()
            updateSelectionRectFromEvent(e)
            return
        }

        if (canvas && !isDraggingRef.current) {
            const rect = canvas.getBoundingClientRect()
            const mouseX = e.clientX - rect.left
            const mouseY = e.clientY - rect.top

            // Sidebar hovering tooltip
            if (mouseX <= 40) {
                const trackId = getTrackAtY(mouseY)
                const tooltip = trackId ? getTrackTooltip(trackId) : ''
                if (tooltip) {
                    setSidebarTooltip({ text: tooltip, x: e.clientX, y: e.clientY })
                } else {
                    setSidebarTooltip(null)
                }
            } else {
                setSidebarTooltip(null)
            }

            // Hovering a transcript on the canvas highlights the same row in the
            // focus drawer, so the two lists point at each other both ways.
            if (focusViewGeneId) {
                const transcriptHit = getSelectedGeneTranscriptHit(mouseX, mouseY)
                const nextHoverId = String(transcriptHit?.transcript?.id || '')
                if (nextHoverId !== String(focusTranscriptView?.hoverId || '')) {
                    onFocusTranscriptViewChangeRef.current?.({ hoverId: nextHoverId || null })
                }
            }

            const customHover = getCustomTrackHover(mouseX, mouseY, e.clientX, e.clientY)
            // Strip internal hover fields before passing to tooltip state
            const { hoverBlock: nextBlock, hoverSplice: nextSplice, hoverBigBed: nextBigBed, ...tooltipOnly } = customHover || {}
            // Only show tooltip after cursor dwell on a plotted signal region.
            const tooltipPayload = customHover && tooltipOnly.text ? tooltipOnly : null
            if (draggingTrack) {
                dismissCustomTrackTooltip()
            } else {
                queueCustomTrackTooltip(tooltipPayload, mouseX, mouseY, e.clientX, e.clientY)
            }
            // Only call setState when the hovered block actually changes (avoids churn)
            const prev = hoveredVcfBlockRef.current
            const blockChanged = nextBlock?.trackId !== prev?.trackId || nextBlock?.start !== prev?.start
            if (blockChanged) {
                hoveredVcfBlockRef.current = nextBlock ?? null
                setHoveredVcfBlock(nextBlock ?? null)
            }
            const nextSpliceKey = nextSplice?.junction
                ? `${nextSplice.trackId}|${spliceJunctionKey(nextSplice.junction)}`
                : ''
            if (hoveredSpliceRef.current !== nextSpliceKey) {
                hoveredSpliceRef.current = nextSpliceKey
                setHoveredSpliceJunction(nextSplice?.junction ? {
                    trackId: nextSplice.trackId,
                    key: spliceJunctionKey(nextSplice.junction),
                    junction: nextSplice.junction,
                } : null)
            }
            const nextBigBedKey = nextBigBed?.key
                ? `${nextBigBed.trackId}|${nextBigBed.key}`
                : ''
            if (hoveredBigBedRef.current !== nextBigBedKey) {
                hoveredBigBedRef.current = nextBigBedKey
                setHoveredBigBedFeature(nextBigBed?.feature ? {
                    trackId: nextBigBed.trackId,
                    key: nextBigBed.key,
                    feature: nextBigBed.feature,
                    anchorCanvasX: nextBigBed.anchorCanvasX,
                    anchorCanvasY: nextBigBed.anchorCanvasY,
                } : null)
            }

            // Sequence track base hover
            const seqBase = getSeqBaseAtMouse(mouseX, mouseY)
            if (seqBase?.bp !== hoveredSeqBaseRef.current?.bp) {
                hoveredSeqBaseRef.current = seqBase
                setHoveredSeqBase(seqBase)
            }
            // Dismiss base popup when cursor leaves the clicked base
            if (clickedSeqBase && seqBase?.bp !== clickedSeqBase.bp) {
                setClickedSeqBase(null)
            }

            if (clickedGeneTranscript) {
                const transcriptHit = getSelectedGeneTranscriptHit(mouseX, mouseY)
                const isSameTranscript = Boolean(
                    transcriptHit?.transcript?.id
                    && transcriptHit.transcript.id === clickedGeneTranscript.transcriptId
                )
                if (isSameTranscript) {
                    clearTranscriptPopupDismissTimer()
                } else if (!transcriptPopupHoverRef.current) {
                    scheduleTranscriptPopupDismiss()
                }
            }
        }

        if (!isDraggingRef.current) return

        if (spliceArcDragRef.current) {
            const drag = spliceArcDragRef.current
            const mapKey = `${drag.trackId}|${drag.key}`
            const dy = drag.startClientY - e.clientY
            if (Math.abs(dy) > 2) {
                dragAxisRef.current = 'splice'
                suppressNextClickRef.current = true
            }
            const nextLift = clamp(Number(drag.initialLift || 0) + dy, -48, 210)
            setSpliceArcLiftOffsets((prev) => {
                const cur = Number(prev[mapKey] || 0)
                if (Math.abs(cur - nextLift) < 0.15) return prev
                return { ...prev, [mapKey]: nextLift }
            })
            velocityRef.current = 0
            return
        }

        dismissCustomTrackTooltip()
        if (hoveredSpliceRef.current) {
            hoveredSpliceRef.current = null
            setHoveredSpliceJunction(null)
        }
        if (hoveredBigBedRef.current) {
            hoveredBigBedRef.current = null
            setHoveredBigBedFeature(null)
        }
        const dx = dragStartXRef.current - e.clientX
        const dy = dragStartYRef.current - e.clientY

        // Lock to an axis once movement exceeds threshold
        if (!dragAxisRef.current) {
            const axis = resolveDragAxis({
                dx,
                dy,
                canScrollPage: canVerticallyScrollContainer(),
                currentAxis: null,
            })
            if (axis) {
                dragAxisRef.current = axis
                suppressNextClickRef.current = true
            }
        }

        if (dragAxisRef.current === 'x' || !dragAxisRef.current) {
            const bpDelta = viewStartRef.current - dragViewStartRef.current
            const currentSpan = viewEndRef.current - viewStartRef.current
            const currentPerPx = currentSpan / Math.max(1, viewWidth - LHS_WIDTH)
            const pxPanApplied = isFlipped ? -bpDelta / currentPerPx : bpDelta / currentPerPx
            captureAdaptiveScrollAnchor()
            panByPx(dx - pxPanApplied)
        }

        if (dragAxisRef.current === 'y' && scrollTargetRef.current) {
            // 1:1 grab-and-drag, matching the horizontal pan: the content follows
            // the cursor, so dragging down reveals what is above.
            scrollTargetRef.current.scrollTop = dragScrollTopRef.current + dy
        }

        // Track velocity (only for horizontal momentum). Smoothed over a couple of
        // samples and kept at true drag speed — amplifying it made the release
        // overshoot where the cursor actually stopped.
        const now = performance.now()
        const dt = now - lastTimeRef.current
        if (dt > 0 && dt < 100) {
            const samplePxPerFrame = ((lastPosRef.current - e.clientX) / dt) * 16
            velocityRef.current = (velocityRef.current * 0.4) + (samplePxPerFrame * 0.6)
        }
        lastPosRef.current = e.clientX
        lastTimeRef.current = now
    }, [viewWidth, panByPx, layout, isFlipped, isSelectingRect, updateSelectionRectFromEvent, getTrackAtY, getTrackTooltip, getCustomTrackHover, getSeqBaseAtMouse, clickedSeqBase, dismissCustomTrackTooltip, queueCustomTrackTooltip, draggingTrack, clickedGeneTranscript, getSelectedGeneTranscriptHit, focusViewGeneId, focusTranscriptView?.hoverId, clearTranscriptPopupDismissTimer, scheduleTranscriptPopupDismiss, canVerticallyScrollContainer, captureAdaptiveScrollAnchor])

    const handleMouseUp = useCallback(() => {
        if (isSelectingRect) {
            const rect = selectionRect
            setIsSelectingRect(false)
            setSelectionRect(null)
            setIsBoxSelectMode(false) // one-shot mode

            if (!rect) return

            const minX = Math.max(LHS_WIDTH, Math.min(rect.x1, rect.x2))
            const maxX = Math.max(LHS_WIDTH, Math.max(rect.x1, rect.x2))
            const minY = Math.min(rect.y1, rect.y2)
            const maxY = Math.max(rect.y1, rect.y2)

            const hitsAnyTrack = layout.orderedTracks.some((track) => (
                maxY >= track.y && minY <= (track.y + track.height)
            ))

            if (hitsAnyTrack && (maxX - minX) > 2) {
                const v1 = screenToViewCoord(minX)
                const v2 = screenToViewCoord(maxX)
                let nextStart = Math.min(v1, v2)
                let nextEnd = Math.max(v1, v2)
                if (nextEnd <= nextStart) nextEnd = nextStart + 1

                // What the user dragged out is now the location of focus. Zoomed to
                // slightly wider than the box so its boundary lines land inside the
                // view instead of on its edges, and framed clear of the drawer that
                // taking focus slides over this panel's right edge.
                const selectedSpan = nextEnd - nextStart
                const flank = (selectedSpan / BOX_SELECT_FILL_FRACTION - selectedSpan) / 2
                focusLocation({
                    chrom: selectedChrom,
                    start: Math.round(isAligned ? overlayToGenomic(nextStart) : nextStart),
                    end: Math.round(isAligned ? overlayToGenomic(nextEnd) : nextEnd),
                })
                const framedBox = frameFocusRange(nextStart - flank, nextEnd + flank, { gainingFocus: true })
                animateToView(framedBox.start, framedBox.end, 300)
            }
            return
        }

        if (!isDraggingRef.current) return
        isDraggingRef.current = false
        if (spliceArcDragRef.current) {
            spliceArcDragRef.current = null
            setIsDragging(false)
            dragAxisRef.current = null
            velocityRef.current = 0
            return
        }
        const wasVertical = dragAxisRef.current === 'y'
        setIsDragging(false)
        dragAxisRef.current = null
        if (!wasVertical) startMomentum()
    }, [startMomentum, isSelectingRect, selectionRect, layout, showSequenceTrack, screenToViewCoord, animateToView, focusLocation, frameFocusRange, selectedChrom, isAligned, overlayToGenomic])

    // While box-selecting, keep tracking even if cursor leaves this browser.
    useEffect(() => {
        if (!isSelectingRect) return
        const handleGlobalMove = (e) => updateSelectionRectFromEvent(e)
        const handleGlobalUp = () => handleMouseUp()
        window.addEventListener('mousemove', handleGlobalMove)
        window.addEventListener('mouseup', handleGlobalUp)
        return () => {
            window.removeEventListener('mousemove', handleGlobalMove)
            window.removeEventListener('mouseup', handleGlobalUp)
        }
    }, [isSelectingRect, updateSelectionRectFromEvent, handleMouseUp])

    useEffect(() => {
        if (!isDragging || isSelectingRect || draggingTrack) return
        const handleGlobalDragMove = (e) => handleMouseMove(e)
        const handleGlobalDragUp = () => handleMouseUp()
        window.addEventListener('mousemove', handleGlobalDragMove)
        window.addEventListener('mouseup', handleGlobalDragUp)
        return () => {
            window.removeEventListener('mousemove', handleGlobalDragMove)
            window.removeEventListener('mouseup', handleGlobalDragUp)
        }
    }, [isDragging, isSelectingRect, draggingTrack, handleMouseMove, handleMouseUp])

    const handleContainerMouseLeave = useCallback(() => {
        // Do not auto-release while box-selecting; release is handled by global mouseup.
        if (isSelectingRect) return
        // Read the ref, not the state: leaving the panel in the first frame of a
        // drag must not tear the drag down before the global listeners attach.
        if (isDraggingRef.current) return
        setSidebarTooltip(null)
        dismissCustomTrackTooltip()
        if (hoveredVcfBlockRef.current) {
            hoveredVcfBlockRef.current = null
            setHoveredVcfBlock(null)
        }
        if (hoveredSeqBaseRef.current) {
            hoveredSeqBaseRef.current = null
            setHoveredSeqBase(null)
        }
        if (hoveredSpliceRef.current) {
            hoveredSpliceRef.current = null
            setHoveredSpliceJunction(null)
        }
        if (hoveredBigBedRef.current) {
            hoveredBigBedRef.current = null
            setHoveredBigBedFeature(null)
        }
        scheduleTranscriptPopupDismiss(80)
        handleMouseUp()
    }, [isSelectingRect, handleMouseUp, dismissCustomTrackTooltip, scheduleTranscriptPopupDismiss])

    useEffect(() => {
        if (draggingTrack || isDragging || isSelectingRect) {
            dismissCustomTrackTooltip()
        }
    }, [draggingTrack, isDragging, isSelectingRect, dismissCustomTrackTooltip])

    useEffect(() => {
        if (!draggingTrack) return

        const handleGlobalMouseMove = (e) => {
            const canvas = canvasRef.current
            if (!canvas) return
            const rect = canvas.getBoundingClientRect()
            const mouseY = e.clientY - rect.top
            setHoveredTrack(getTrackAtY(mouseY))
        }

        const handleGlobalMouseUp = () => {
            if (hoveredTrack && hoveredTrack !== draggingTrack) {
                setTrackOrder(prev => {
                    const newOrder = [...prev]
                    const fromIdx = newOrder.indexOf(draggingTrack)
                    const toIdx = newOrder.indexOf(hoveredTrack)
                    if (fromIdx === -1 || toIdx === -1) return prev
                    newOrder.splice(fromIdx, 1)
                    newOrder.splice(toIdx, 0, draggingTrack)
                    return newOrder
                })
            }
            setDraggingTrack(null)
            setHoveredTrack(null)
        }

        window.addEventListener('mousemove', handleGlobalMouseMove)
        window.addEventListener('mouseup', handleGlobalMouseUp)

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove)
            window.removeEventListener('mouseup', handleGlobalMouseUp)
        }
    }, [draggingTrack, hoveredTrack, layout, getTrackAtY])

    // Wheel handler
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const handleWheel = (e) => {
            // A gesture that began on a control bar or in the page margins is a
            // page scroll. Scrolling slides this canvas under the cursor, so
            // without this the rest of the gesture would turn into a zoom.
            if (isWheelGestureFromChrome(e)) {
                markWheelHandled(e)
                return
            }
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current)
                animationRef.current = null
            }
            velocityRef.current = 0
            dismissCustomTrackTooltip()

            const rect = container.getBoundingClientRect()
            const cursorX = e.clientX - rect.left

            // Line/page deltas are normalised to pixels before any thresholding,
            // or Firefox and Linux mice (deltaMode 1) are ~30x weaker.
            const wheel = readWheelEvent(e, { pageHeight: rect.height || undefined })
            const gesture = beginWheelGesture(wheelGestureRef.current, wheel, e.timeStamp)

            const currentSpan = viewEndRef.current - viewStartRef.current
            const intent = resolveWheelAction(wheel, browsingControlsRef.current, {
                atMaxZoom: currentSpan >= MAX_VIEW_SPAN - 1e-6,
                canScrollPage: Boolean(findNearestScrollable(container)),
                gesture,
            })

            wheelGestureRef.current = { ...gesture, mode: intent.nextGestureMode }
            // Tell the view-level fallback listener this panel has seen the
            // event, even when the outcome is "do nothing". Must happen before
            // any early return.
            markWheelHandled(e)

            if (intent.preventDefault) e.preventDefault()
            if (intent.stopPropagation) e.stopPropagation()
            if (intent.releaseScrollAnchors) releaseScrollAnchors()

            // 'page_scroll' is handled by doing nothing at all: the event was
            // not prevented, so the browser scrolls the ancestor scroller with
            // its own inertia.
            if (intent.type === 'page_scroll' || intent.type === 'none') return

            if (intent.type === 'pan') {
                verticalZoomTrackAnchorRef.current = null
                if (intent.captureScrollAnchor) captureAdaptiveScrollAnchor()
                panByPx(intent.dxPx)
                return
            }

            if (intent.type !== 'zoom') return

            const mouseY = e.clientY - rect.top + container.scrollTop
            const targetTrack = getTrackAtY(mouseY)

            const now = performance.now()
            const existingGeneAnchor = verticalZoomTrackAnchorRef.current
            const hasActiveGeneAnchor = Boolean(existingGeneAnchor && now <= existingGeneAnchor.expiresAt)
            if (hasActiveGeneAnchor) {
                // Layout changes can move the pointer over another track during
                // a rapid wheel gesture. Keep following the feature row where
                // the gesture began until wheel input pauses.
                existingGeneAnchor.expiresAt = now + 450
            } else {
                const featureAnchor = getGeneFeatureVerticalAnchor(cursorX, mouseY, targetTrack)
                verticalZoomTrackAnchorRef.current = featureAnchor
                    ? {
                        ...featureAnchor,
                        viewportY: e.clientY - rect.top,
                        clientY: e.clientY,
                        expiresAt: now + 450,
                    }
                    : null
            }

            if (verticalZoomTrackAnchorRef.current) {
                adaptiveScrollAnchorRef.current = null
                if (adaptiveScrollAnchorFrameRef.current !== null) {
                    cancelAnimationFrame(adaptiveScrollAnchorFrameRef.current)
                    adaptiveScrollAnchorFrameRef.current = null
                }
            } else if (intent.captureScrollAnchor) {
                captureAdaptiveScrollAnchor()
            }

            const anchorX = intent.anchor === 'center' ? (LHS_WIDTH + viewWidthRef.current) / 2 : cursorX
            zoomAt(anchorX, intent.factor, targetTrack)
        }

        container.addEventListener('wheel', handleWheel, { passive: false })
        return () => container.removeEventListener('wheel', handleWheel)
    }, [zoomAt, panByPx, getTrackAtY, getGeneFeatureVerticalAnchor, dismissCustomTrackTooltip, captureAdaptiveScrollAnchor, releaseScrollAnchors])

    // ============ Click Handler (gene selection & pill expansion) ============

    // ============ Click Handler (gene selection & pill expansion) ============

    const handleCanvasClick = useCallback((e) => {
        if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false
            return
        }
        if (isBoxSelectMode || isSelectingRect) return
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const clickX = e.clientX - rect.left
        const clickY = e.clientY - rect.top

        // Intercept sidebar (handled in mousedown)
        if (clickX <= LHS_WIDTH) return

        const openSelectedTranscriptPopup = (hit) => {
            if (!hit?.transcript) return
            // With a transcript already pinned in the drawer, clicking another
            // row in the track moves the pin to it. Only then: with nothing
            // pinned, a click means what it always meant and just opens the
            // popup.
            const currentPin = String(focusTranscriptView?.pinnedId || '').trim()
            const clickedId = String(hit.transcript.id || '')
            if (currentPin && clickedId && currentPin !== clickedId) {
                onFocusTranscriptViewChangeRef.current?.({
                    pinnedId: clickedId,
                    hoverId: null,
                    ghostId: null,
                })
            }
            clearTranscriptPopupDismissTimer()
            transcriptPopupHoverRef.current = false
            setClickedGeneTranscript((prev) => {
                const nextGeneId = hit.gene?.id || ''
                const nextTranscriptId = String(hit.transcript.id || '')
                const isSameTranscript = String(prev?.geneId || '') === nextGeneId
                    && String(prev?.transcriptId || '') === nextTranscriptId
                if (isSameTranscript) return null
                return {
                    geneId: nextGeneId,
                    transcriptId: nextTranscriptId,
                    transcript: hit.transcript,
                    arrowTargetX: rect.left + hit.anchorCanvasX,
                    arrowTargetY: rect.top + hit.anchorCanvasY,
                }
            })
        }
        const selectedTranscriptHit = getSelectedGeneTranscriptHit(clickX, clickY)

        // Check if click is on a gene
        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            if (gene.strand === '+' && effectiveHiddenStrands.forward) continue
            if (gene.strand === '-' && effectiveHiddenStrands.reverse) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)

            if (clickX >= gx1 - 2 && clickX <= gx2 + 4) {
                const isForward = gene.strand === '+'
                const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y

                const geneWidth = gx2 - gx1
                const rowCount = getGeneRowCountForWidth(gene, geneWidth)

                const trackPadding = gene.strand === '+' ? layout.fwdPadding : layout.revPadding
                const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
                const totalGeneHeight = getGeneTotalHeight(rowCount)

                if (clickY >= baseGeneY && clickY <= baseGeneY + totalGeneHeight) {
                    const isSameGene = !!(selectedGene && selectedGene.id === gene.id)
                    if (isSameGene) {
                        if (selectedTranscriptHit?.gene?.id === gene.id) {
                            openSelectedTranscriptPopup(selectedTranscriptHit)
                            setClickedVcfVariant(null)
                            setClickedBigBedFeature(null)
                            setClickedSpliceJunction(null)
                            setClickedSeqBase(null)
                            return
                        }
                        dismissClickedGeneTranscript()
                        setSelectedGene(null)
                        return
                    }

                    dismissClickedGeneTranscript()
                    pendingVerticalCenterGeneIdRef.current = gene.id
                    setSelectedGene(gene)
                    trackAchievement('browser.geneFocus')

                    const selectedCoords = getSelectedGeneCoordsForView(gene, isAligned, alignData, genomicToOverlay)
                    if (selectedCoords) {
                        const framed = frameFocusRange(selectedCoords.start, selectedCoords.end, { gainingFocus: true })
                        animateToView(framed.start, framed.end, 700)
                    }
                    return
                }
            }
        }

        // Check if click is on a sequence track base
        const seqBaseHit = getSeqBaseAtMouse(clickX, clickY)
        if (seqBaseHit) {
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            const popupX = rect.left + (seqBaseHit.bxL + seqBaseHit.bxR) / 2
            const popupY = rect.top + seqBaseHit.seqBoxT + seqBaseHit.seqBoxH + 6
            setClickedSeqBase(prev =>
                prev?.bp === seqBaseHit.bp ? null : { ...seqBaseHit, popupX, popupY }
            )
            setClickedVcfVariant(null)
            setClickedSpliceJunction(null)
            dismissClickedGeneTranscript()
            return
        }

        const customHover = getCustomTrackHover(clickX, clickY, e.clientX, e.clientY)

        // Check if click is on an adaptive VCF variant (adp_detail mode)
        if (customHover?.hoverBlock?.variant) {
            // Toggle: clicking same variant again closes popup
            const v = customHover.hoverBlock.variant
            // Compute screen anchor for the popup arrow (left edge + vertical centre of feature)
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            const trackId = customHover.hoverBlock.trackId
            const trackLayout = layout.customTrackLayouts[trackId]
            const track = customTracksById.get(trackId)
            const trackType = track?.type || 'bigwig'
            const rawRenderMode = track?.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings).data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const { top: tTop, bottom: tBot } = getCustomTrackGeometry(trackLayout, renderMode, trackType, customTrackData?.[trackId] || null)
            const tPlotH = tBot - tTop
            const tBarH = Math.max(5, Math.floor(tPlotH * 0.13))
            const tBarY = tTop + Math.floor((tPlotH - tBarH) / 2)
            const cLeft = LHS_WIDTH + 2
            const cRight = viewWidth - 2
            const curSpan = Math.max(1, viewEnd - viewStart)
            const blockGToX = (g) => cLeft + ((g - viewStart) / curSpan) * (cRight - cLeft)
            const vtype = localVcfType(v)
            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
            let arrowTargetX, arrowTargetY
            if (vtype !== 'snv') {
                // Circle marker: X from dot centre, Y approximated from click
                const dotCanvasX = blockGToX(layoutInfo.markerXGenomic)
                arrowTargetX = rect.left + dotCanvasX - 5   // left edge of dot (r ≈ 5)
                arrowTargetY = e.clientY
            } else {
                // SNV block: left pixel edge and vertical centre
                arrowTargetX = rect.left + blockGToX(layoutInfo.vpos)
                arrowTargetY = rect.top + tBarY + tBarH / 2
            }
            setClickedVcfVariant((prev) =>
                prev?.variant?.pos === v.pos && prev?.variant?.type === v.type ? null
                    : { variant: v, chrom: selectedChrom, arrowTargetX, arrowTargetY }
            )
            setClickedBigBedFeature(null)
            setClickedSpliceJunction(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        if (customHover?.hoverBigBed?.feature) {
            const hit = customHover.hoverBigBed
            const canvas = canvasRef.current
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
            setClickedBigBedFeature((prev) => {
                if (prev?.trackId === hit.trackId && bigBedFeatureKey(prev.feature) === bigBedFeatureKey(hit.feature)) {
                    return null
                }
                return {
                    trackId: hit.trackId,
                    feature: hit.feature,
                    popupX: rect.left + hit.anchorCanvasX,
                    popupY: rect.top + hit.anchorCanvasY,
                }
            })
            setClickedVcfVariant(null)
            setClickedSpliceJunction(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        if (customHover?.hoverSplice?.junction) {
            const hit = customHover.hoverSplice
            setClickedSpliceJunction({ trackId: hit.trackId, junction: hit.junction, popupX: e.clientX, popupY: e.clientY })
            setClickedVcfVariant(null)
            setClickedBigBedFeature(null)
            setClickedSeqBase(null)
            dismissClickedGeneTranscript()
            return
        }

        // Click elsewhere — close any open popup
        if (clickedVcfVariant || clickedBigBedFeature || clickedSeqBase || clickedSpliceJunction || clickedGeneTranscript) {
            setClickedVcfVariant(null)
            setClickedBigBedFeature(null)
            setClickedSeqBase(null)
            setClickedSpliceJunction(null)
            dismissClickedGeneTranscript()
            return
        }

        // Any background click in the drawable browser region clears the focused gene.
        if (selectedGene) {
            dismissClickedGeneTranscript()
            setSelectedGene(null)
        }
    }, [
        genes,
        layout,
        genomicToScreen,
        isBoxSelectMode,
        isSelectingRect,
        getTrackAtY,
        selectedGene,
        isAligned,
        alignData,
        genomicToOverlay,
        animateToView,
        frameFocusRange,
        getCustomTrackHover,
        getCustomTrackGeometry,
        customTracksById,
        viewStart,
        viewEnd,
        viewWidth,
        selectedChrom,
        clickedVcfVariant,
        clickedBigBedFeature,
        clickedSpliceJunction,
        clickedSeqBase,
        clickedGeneTranscript,
        getSeqBaseAtMouse,
        getGeneRowCountForWidth,
        getGeneTotalHeight,
        transcriptLayoutMetrics,
        getSelectedGeneTranscriptHit,
        clearTranscriptPopupDismissTimer,
        dismissClickedGeneTranscript,
        isGeneHiddenFromTracks,
        effectiveHiddenStrands,
    ])

    // ============ Canvas Rendering ============

    // The height this panel needs for its own tracks, independent of any shared
    // band height handed down from the parent — so reporting it upward cannot feed
    // back into itself. Quantised so a pan that nudges a row by a pixel does not
    // renegotiate the shared height every frame.
    const naturalCanvasHeight = useMemo(() => {
        const { FORWARD_Y, REVERSE_Y, forwardBgHeight, reverseBgHeight, orderedTracks } = layout
        const lastTrackY = orderedTracks.length
            ? Math.max(...orderedTracks.map((track) => track.y + track.height))
            : Math.max(FORWARD_Y + forwardBgHeight, REVERSE_Y + reverseBgHeight)
        const alignTracksToBottom = effectiveTrackAlign === 'bottom' && !compactPanelHeight
        // Use +10 padding unless flush alignment is requested
        const bottomPadding = (alignTracksToBottom || compactPanelHeight) ? 0 : 10
        const totalHeight = lastTrackY
            + (effectiveRulerPosition === 'top' ? bottomPadding : effectiveRulerHeight + bottomPadding)
        return Math.max(1, Math.ceil(totalHeight / 8) * 8)
    }, [layout, effectiveTrackAlign, compactPanelHeight, effectiveRulerPosition, effectiveRulerHeight])

    useEffect(() => {
        onContentHeightChangeRef.current?.(naturalCanvasHeight)
    }, [naturalCanvasHeight])


    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        const dpr = window.devicePixelRatio || 1

        const { FORWARD_Y, REVERSE_Y, SEQUENCE_Y, RULER_Y, forwardBgHeight, reverseBgHeight, seqBgHeight, customTrackLayouts } = layout

        // Deliberately independent of the measured container height: the container
        // grows with the canvas, so feeding viewHeight back in would loop. The
        // shared band height keeps sibling genomes the same size when the panels
        // are not free to shrink to their own content.
        const canvasHeight = Math.max(naturalCanvasHeight, Number(minCanvasHeight) || 0)

        // Resize the backing store only when dimensions actually change. Assigning
        // canvas.width/height clears and reallocates the high-DPI buffer.
        const backingWidth = Math.max(1, Math.round(viewWidth * dpr))
        const backingHeight = Math.max(1, Math.round(canvasHeight * dpr))
        if (canvas.width !== backingWidth) canvas.width = backingWidth
        if (canvas.height !== backingHeight) canvas.height = backingHeight
        const cssWidth = `${viewWidth}px`
        const cssHeight = `${canvasHeight}px`
        if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth
        if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        // Clear
        ctx.fillStyle = colors.bg
        ctx.fillRect(0, 0, viewWidth, canvasHeight)

        let tickInterval = 10
        const span = viewEnd - viewStart
        if (effectiveRulerHeight > 0) {
            // ---- Coordinate Ruler ----
            // Styled after www.ensembl.org: no filled band and no minor ticks,
            // just a hairline rule closing off the band with a 1px tick at each
            // round coordinate and the coordinate set beside it in mono.
            const geometry = rulerGeometry({
                top: RULER_Y,
                height: effectiveRulerHeight,
                position: effectiveRulerPosition,
            })

            ctx.strokeStyle = colors.rulerLine
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(0, geometry.ruleY + 0.5)
            ctx.lineTo(viewWidth, geometry.ruleY + 0.5)
            ctx.stroke()

            const ticks = rulerTicks({
                start: viewStart,
                end: viewEnd,
                widthPx: viewWidth,
                fontSize: RULER_FONT_SIZE,
            })
            tickInterval = ticks.interval

            ctx.font = COORD_FONT
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            for (const pos of ticks.ticks) {
                const x = isAligned
                    ? (isFlipped
                        ? LHS_WIDTH + (viewEnd - pos) / bpPerPx
                        : LHS_WIDTH + (pos - viewStart) / bpPerPx)
                    : genomicToScreen(pos)
                if (x > viewWidth) continue

                // The leading tick sits just off the left edge so that its label
                // can bleed into view; only its line is skipped.
                if (x >= 0) {
                    ctx.strokeStyle = colors.tickMajor
                    ctx.beginPath()
                    ctx.moveTo(Math.round(x) + 0.5, geometry.tickStart)
                    ctx.lineTo(Math.round(x) + 0.5, geometry.tickEnd)
                    ctx.stroke()
                }

                let labelPos = pos
                if (isAligned && alignmentCoords && alignData) {
                    labelPos = overlayToGenomic(pos)
                }

                // Hide the label for the 1bp start of a sequence, unless aligned.
                if (pos > 1 || isAligned) {
                    ctx.fillStyle = colors.rulerText
                    ctx.fillText(formatRulerCoord(labelPos), x + RULER_LABEL_GAP, geometry.labelBaseline)
                }
            }
        }

        // ---- Track Backgrounds ----
        const getBgColor = (trackId) => {
            const visibleTrackOrder = trackOrder.filter((trackIdItem) => {
                if (trackIdItem === 'sequence') return showSequenceTrack
                if (isCustomTrackId(trackIdItem)) return customTracksById.has(trackIdItem)
                return true
            })
            const index = visibleTrackOrder.indexOf(trackId)
            if (index % 2 === 0) {
                return isLight ? '#ffffff' : '#1a1b1e'
            } else {
                return isLight ? '#f8f9fa' : '#212226'
            }
        }

        const drawTrackBg = (y, h, trackId, hidden) => {
            if (draggingTrack === trackId) {
                ctx.fillStyle = colors.selectedGene
            } else if (hoveredTrack === trackId && draggingTrack !== trackId) {
                ctx.fillStyle = isLight ? '#dbe4ff' : '#2A3141' // distinct hover grey/blue
            } else if (hidden) {
                ctx.fillStyle = isLight ? '#e9ecef' : '#141517'
            } else {
                ctx.fillStyle = getBgColor(trackId)
            }
            ctx.fillRect(0, y, viewWidth, h)
        }

        drawTrackBg(FORWARD_Y, forwardBgHeight, 'forward', effectiveHiddenStrands.forward)
        drawTrackBg(REVERSE_Y, reverseBgHeight, 'reverse', effectiveHiddenStrands.reverse)
        if (showSequenceTrack) {
            drawTrackBg(SEQUENCE_Y, seqBgHeight, 'sequence', effectiveHiddenStrands.sequence)
            ctx.save()
            ctx.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.24)'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(0, SEQUENCE_Y + seqBgHeight - 0.5)
            ctx.lineTo(viewWidth, SEQUENCE_Y + seqBgHeight - 0.5)
            ctx.stroke()
            ctx.restore()
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            const track = customTracksById.get(trackId)
            drawTrackBg(trackLayout.y, trackLayout.height, trackId, track ? !track.visible : true)
        }

        // Background Directional Arrows
        const bgPatternColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)'
        ctx.fillStyle = bgPatternColor
        ctx.font = monoFont(32, 'bold')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const chevronSpacing = 150
        const chevronStartY = FORWARD_Y + forwardBgHeight / 2
        const reverseChevronStartY = REVERSE_Y + reverseBgHeight / 2

        // Static chevrons (no panning offset) to prevent dizzying visual effect
        for (let bgX = LHS_WIDTH + chevronSpacing / 2; bgX <= viewWidth + chevronSpacing; bgX += chevronSpacing) {
            ctx.fillText('>', bgX, chevronStartY + 2)
            ctx.fillText('<', bgX, reverseChevronStartY + 2)
        }
        ctx.textBaseline = 'alphabetic' // Restore baseline

        const activeSpliceJunctions = []
        if (clickedSpliceJunction?.junction) {
            const clickedTrack = customTracksById.get(clickedSpliceJunction.trackId)
            activeSpliceJunctions.push({
                ...clickedSpliceJunction.junction,
                _source: 'click',
                _spliceSettings: normalizeSpliceTrackSettings(clickedTrack?.spliceSettings || clickedTrack?.splice_settings),
            })
        } else if (hoveredSpliceJunction?.junction) {
            const hoverTrack = customTracksById.get(hoveredSpliceJunction.trackId)
            activeSpliceJunctions.push({
                ...hoveredSpliceJunction.junction,
                _source: 'hover',
                _spliceSettings: normalizeSpliceTrackSettings(hoverTrack?.spliceSettings || hoverTrack?.splice_settings),
            })
        }
        const spliceBoundaryHighlights = new Map()
        if (activeSpliceJunctions.length > 0) {
            const registerBoundary = (coord, side, weight, source) => {
                if (!Number.isFinite(coord)) return
                const key = `${Math.round(coord)}|${side}`
                const prev = spliceBoundaryHighlights.get(key)
                if (prev) {
                    prev.weight = Math.max(prev.weight, weight)
                    if (source === 'click') prev.clicked = true
                    if (source === 'hover') prev.hovered = true
                    return
                }
                spliceBoundaryHighlights.set(key, {
                    weight,
                    clicked: source === 'click',
                    hovered: source === 'hover',
                })
            }
            for (const j of activeSpliceJunctions) {
                const jStart = Number(j?.start)
                const jEnd = Number(j?.end)
                if (!Number.isFinite(jStart) || !Number.isFinite(jEnd) || jEnd <= jStart) continue
                const support = Math.max(0, Number(j?.n_total ?? j?.reads ?? 0) || 0)
                const weight = spliceSupportBandWeight(support, j?._spliceSettings)
                registerBoundary(jStart - 1, 'right', weight, j._source)
                registerBoundary(jEnd + 1, 'left', weight, j._source)
            }
        }
        const getBoundaryHighlight = (coord, side) => {
            const key = `${Math.round(Number(coord) || 0)}|${side}`
            return spliceBoundaryHighlights.get(key) || null
        }

        // ---- Gene Rendering ----
        const geneLabelCandidates = []
        let geneLabelOrder = 0

        const renderGene = (gene, trackY, trackId, trackOrder) => {
            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const gx1 = Math.min(rawGx1, rawGx2)
            const gx2 = Math.max(rawGx1, rawGx2)
            const geneWidth = Math.max(1, gx2 - gx1)
            const isForward = gene.strand === '+'

            // Skip if off screen
            if (gx2 < -50 || gx1 > viewWidth + 50) return

            const isSelected = selectedGene && selectedGene.id === gene.id
            const shouldDim = dimNonSelectedGenes && !!selectedGene && !isSelected

            const exonColor = shouldDim ? (isLight ? '#9ca3af' : '#6b7280') : panelExonColor
            const intronColor = shouldDim ? (isLight ? '#adb5bd' : '#495057') : colors.intronLine
            const chevronColor = shouldDim ? (isLight ? '#adb5bd' : '#5c5f66') : colors.strandChevron
            const geneLabelColor = shouldDim ? (isLight ? '#868e96' : '#8a8d93') : colors.geneLabelText

            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)

            // transcript logic
            const txs = transcriptCache[gene.id]
            const displayRows = getDisplayTranscriptRows(gene)
            const displayTxs = displayRows.map((row) => row.transcript)
            const rowCount = Math.max(1, displayRows.length || 1)
            const chevronSpacing = isTranscriptCompressionActive
                ? Math.max(12, geneWidth / 22)
                : Math.max(20, geneWidth / 15)
            const chevronSize = isTranscriptCompressionActive ? 2.6 : 4
            const chevronEdgePadding = isTranscriptCompressionActive ? 7 : 10
            const compressedGeneBlockHeight = compressTranscripts
                ? Math.max(6, transcriptLayoutMetrics.exonHeight + 1)
                : EXON_HEIGHT
            const transcriptChevronPositions = (txs && txs.length > 0 && geneWidth > 30)
                ? buildAlignedIntronChevronLayout(displayTxs, chevronSpacing, chevronEdgePadding, genomicToScreen)
                : []

            // Highlighting follows the pointer, not the focus: only the row the
            // user is over lights up, whether they are hovering the canvas or
            // the matching entry in the focus drawer. A pinned row outranks the
            // pointer — it is the row the panel has been aligned to.
            const highlightTranscriptId = isSelected
                ? String(focusTranscriptView?.pinnedId || focusTranscriptView?.hoverId || '').trim()
                : ''

            if (displayRows.length > 0 && !shouldForceGeneBlockView) {
                // Render with transcript detail (exon/intron structure)
                let txIdx = 0
                for (const { transcript: tx, ghost: isGhostRow } of displayRows) {
                    const txY = baseGeneY + txIdx * transcriptLayoutMetrics.rowPitch
                    const midY = txY + transcriptLayoutMetrics.midOffset
                    // Ghost rows highlight too: the band is what makes a faint
                    // dashed preview read as "this row, right here".
                    const isHighlightedRow = Boolean(
                        highlightTranscriptId && tx.id === highlightTranscriptId
                    )

                    if (isHighlightedRow) {
                        ctx.fillStyle = colors.selectedGene
                        ctx.fillRect(
                            gx1 - 2,
                            txY,
                            geneWidth + 4,
                            transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
                        )
                    }

                    // A ghost previews where a hidden transcript would land: real
                    // geometry in the real row, drawn dashed and faded so it reads
                    // as "not shown yet".
                    ctx.save()
                    if (isGhostRow) {
                        ctx.globalAlpha = 0.9
                        ctx.setLineDash([5, 3])
                    }

                    // Intron line (spans full transcript). Inclusive coordinates again:
                    // the line has to reach the far edge of the last base so it meets the
                    // terminal exon box instead of stopping one base short of it.
                    const txPxPerBp = 1 / Math.max(1e-9, bpPerPx)
                    const txBounds = getGenomicIntervalPixelBounds(
                        tx.start,
                        tx.end,
                        txPxPerBp,
                        viewSpan <= 1000 && txPxPerBp >= 2
                    )
                    const rawTxX1 = txBounds ? txBounds.x1 : genomicToScreen(tx.start)
                    const rawTxX2 = txBounds ? txBounds.x2 : genomicToScreen(tx.end)
                    const txX1 = Math.min(rawTxX1, rawTxX2)
                    const txX2 = Math.max(rawTxX1, rawTxX2)

                    ctx.strokeStyle = intronColor
                    ctx.lineWidth = isTranscriptCompressionActive ? 1 : INTRON_HEIGHT
                    ctx.beginPath()
                    ctx.moveTo(Math.max(0, txX1), midY)
                    ctx.lineTo(Math.min(viewWidth, txX2), midY)
                    ctx.stroke()

                    // Beta-style dotted continuation trails show the full gene
                    // extent whenever this transcript stops short of either
                    // boundary. Geometry is visual rather than strand-based, so
                    // forward, reverse, and flipped panels all align identically.
                    const boundaryTrails = getTranscriptBoundaryTrails(gene, tx, genomicToScreen)
                    if (boundaryTrails.length > 0) {
                        ctx.save()
                        ctx.strokeStyle = exonColor
                        ctx.globalAlpha = shouldDim ? 0.4 : 0.65
                        ctx.lineWidth = 1
                        ctx.setLineDash([2, 3])
                        for (const trail of boundaryTrails) {
                            const x1 = clamp(trail.x1, 0, viewWidth)
                            const x2 = clamp(trail.x2, 0, viewWidth)
                            if (Math.abs(x2 - x1) <= 1) continue
                            ctx.beginPath()
                            ctx.moveTo(x1, midY)
                            ctx.lineTo(x2, midY)
                            ctx.stroke()
                        }
                        ctx.restore()
                    }

                    // Strand chevrons on intron line
                    if (geneWidth > 30) {
                        ctx.strokeStyle = chevronColor
                        ctx.lineWidth = isTranscriptCompressionActive ? 1 : 1.5
                        const chevronPositions = transcriptChevronPositions[txIdx] || []
                        for (const cx of chevronPositions) {
                            if (cx < 0 || cx > viewWidth) continue
                            const visuallyForward = rawGx1 <= rawGx2 ? (gene.strand === '+') : (gene.strand === '-')
                            const chevDir = visuallyForward ? chevronSize : -chevronSize
                            ctx.beginPath()
                            ctx.moveTo(cx - chevDir, midY - chevronSize)
                            ctx.lineTo(cx, midY)
                            ctx.lineTo(cx - chevDir, midY + chevronSize)
                            ctx.stroke()
                        }
                    }

                    // Detailed transcript style:
                    // - uniform-height exon boxes
                    // - coding segments: filled
                    // - non-coding segments: outline only
                    const detailedExonY = midY - transcriptLayoutMetrics.exonHeight / 2
                    const cdsList = Array.isArray(tx.cds_list) ? tx.cds_list : []
                    const exons = Array.isArray(tx.exons) ? tx.exons : []
                    const exonMaskColor = isHighlightedRow ? colors.selectedGene : getBgColor(isForward ? 'forward' : 'reverse')
                    const baseExonStrokeWidth = isTranscriptCompressionActive ? 1 : 1.5
                    // Ghost exons are hollow, so they need a heavier outline than
                    // filled ones to carry the same visual weight.
                    const exonStrokeWidth = isGhostRow ? baseExonStrokeWidth + 0.5 : baseExonStrokeWidth

                    for (const exon of exons) {
                        const exonStart = Number(exon.start)
                        const exonEnd = Number(exon.end)
                        const segments = getTranscriptExonSegments({ exonStart, exonEnd, cdsList })
                        if (segments.length === 0) continue

                        // Exon coordinates are inclusive, so a segment has to cover its
                        // last base too — getGenomicIntervalPixelBounds maps start..end
                        // to [x(start), x(end + 1)). At base-level zoom it also snaps to
                        // the same base grid as the sequence track.
                        const segPxPerBp = 1 / Math.max(1e-9, bpPerPx)
                        const snapSegToBaseGrid = viewSpan <= 1000 && segPxPerBp >= 2

                        for (const seg of segments) {
                            const segBounds = getGenomicIntervalPixelBounds(seg.start, seg.end, segPxPerBp, snapSegToBaseGrid)
                            if (!segBounds) continue
                            const sx1 = segBounds.x1
                            const sx2 = segBounds.x2
                            const segW = Math.max(1, sx2 - sx1)
                            const strokeInset = exonStrokeWidth / 2
                            const drawX = sx1 + strokeInset
                            const drawY = detailedExonY + strokeInset
                            const drawW = Math.max(0.5, segW - exonStrokeWidth)
                            const drawH = Math.max(0.5, transcriptLayoutMetrics.exonHeight - exonStrokeWidth)

                            // Hide intron line beneath exon boxes so it only shows in intronic sequence.
                            ctx.fillStyle = exonMaskColor
                            ctx.fillRect(sx1, detailedExonY, segW, transcriptLayoutMetrics.exonHeight)

                            // Ghost exons stay hollow even where they code, so a
                            // preview never reads as a drawn transcript.
                            if (seg.coding && !isGhostRow) {
                                ctx.fillStyle = exonColor
                                ctx.fillRect(drawX, drawY, drawW, drawH)
                            }

                            // Outline both coding and non-coding with identical stroke geometry.
                            ctx.strokeStyle = exonColor
                            ctx.lineWidth = exonStrokeWidth
                            ctx.strokeRect(drawX, drawY, drawW, drawH)
                        }

                        const leftBoundaryHighlight = isGhostRow ? null : getBoundaryHighlight(exonStart, 'left')
                        const rightBoundaryHighlight = isGhostRow ? null : getBoundaryHighlight(exonEnd, 'right')
                        if (leftBoundaryHighlight || rightBoundaryHighlight) {
                            const lineTop = detailedExonY - 1
                            const lineBottom = detailedExonY + transcriptLayoutMetrics.exonHeight + 1
                            // Splice boundaries sit on the outer edges of the first and last
                            // bases, so the 3' line belongs at x(exonEnd + 1), not x(exonEnd).
                            // The highlight specs are keyed by genomic coordinate while x1/x2
                            // are visual, so swap them when the panel is flipped.
                            const exonBounds = getGenomicIntervalPixelBounds(exonStart, exonEnd, segPxPerBp, snapSegToBaseGrid)
                            const startEdgeX = isFlipped ? exonBounds?.x2 : exonBounds?.x1
                            const endEdgeX = isFlipped ? exonBounds?.x1 : exonBounds?.x2
                            const drawBoundaryLine = (x, spec) => {
                                if (!spec || !Number.isFinite(x)) return
                                if (x < LHS_WIDTH - 2 || x > viewWidth + 2) return
                                const alpha = clamp(
                                    0.45 + spec.weight * 0.28 + (spec.clicked ? 0.12 : 0) + (spec.hovered ? 0.05 : 0),
                                    0.3,
                                    0.95
                                )
                                ctx.strokeStyle = `rgba(255,255,255,${alpha})`
                                ctx.lineWidth = 1.0 + spec.weight * 0.7 + (spec.clicked ? 0.35 : 0) + (spec.hovered ? 0.2 : 0)
                                ctx.beginPath()
                                ctx.moveTo(x, lineTop)
                                ctx.lineTo(x, lineBottom)
                                ctx.stroke()
                            }
                            drawBoundaryLine(startEdgeX, leftBoundaryHighlight)
                            drawBoundaryLine(endEdgeX, rightBoundaryHighlight)
                        }
                    }

                    ctx.restore()
                    txIdx++
                }
            } else if (geneWidth > 3) {
                // Simple block rendering (no transcript detail available or gene is small)
                const midY = baseGeneY + transcriptLayoutMetrics.midOffset
                const blockH = compressedGeneBlockHeight

                // Drawn as a block there is no row to single out, so any hovered or
                // pinned transcript lights the whole gene: it is all the browser can
                // truthfully say about where that transcript lives.
                if (highlightTranscriptId) {
                    ctx.fillStyle = colors.selectedGene
                    ctx.fillRect(
                        gx1 - 2,
                        baseGeneY,
                        geneWidth + 4,
                        transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
                    )
                }

                ctx.fillStyle = exonColor
                // Arrow shape for strand direction
                if (geneWidth > 15) {
                    const arrowSize = compressTranscripts
                        ? Math.min(4, geneWidth * 0.12)
                        : Math.min(6, geneWidth * 0.15)
                    const visuallyForward = rawGx1 <= rawGx2 ? (gene.strand === '+') : (gene.strand === '-')
                    ctx.beginPath()
                    if (visuallyForward) {
                        ctx.moveTo(gx1, midY - blockH / 2)
                        ctx.lineTo(gx2 - arrowSize, midY - blockH / 2)
                        ctx.lineTo(gx2, midY)
                        ctx.lineTo(gx2 - arrowSize, midY + blockH / 2)
                        ctx.lineTo(gx1, midY + blockH / 2)
                    } else {
                        ctx.moveTo(gx1 + arrowSize, midY - blockH / 2)
                        ctx.lineTo(gx2, midY - blockH / 2)
                        ctx.lineTo(gx2, midY + blockH / 2)
                        ctx.lineTo(gx1 + arrowSize, midY + blockH / 2)
                        ctx.lineTo(gx1, midY)
                    }
                    ctx.closePath()
                    ctx.fill()
                } else {
                    ctx.fillRect(gx1, midY - blockH / 2, geneWidth, blockH)
                }
            } else {
                // Very tiny: just a tick mark
                const midY = baseGeneY + transcriptLayoutMetrics.midOffset
                ctx.fillStyle = exonColor
                ctx.fillRect(gx1, midY - compressedGeneBlockHeight / 2, Math.max(1, geneWidth), compressedGeneBlockHeight)
            }

            const labelText = gene.name || gene.id
            // Expanded labels are HTML so the label and its X remain one
            // horizontal unit both while following the viewport and after
            // settling beneath the final transcript.
            const hasExpandedFooterOverlay = expandedFooterGeneIds.has(String(gene.id))
            if (labelText && !hasExpandedFooterOverlay) {
                ctx.font = LABEL_FONT
                const candidate = buildGeneLabelCandidate({
                    gene,
                    trackId,
                    trackOrder,
                    trackY,
                    layout,
                    transcriptLayoutMetrics,
                    selectedGene,
                    dimNonSelectedGenes,
                    isLight,
                    colors,
                    geneLabelColor,
                    genomicToScreen,
                    viewWidth,
                    txs,
                    getEffectiveTranscriptLimit,
                    visibleTranscriptCount: rowCount,
                    measureTextWidth: (text) => ctx.measureText(text).width,
                    lhsWidth: LHS_WIDTH,
                    order: geneLabelOrder++,
                    footerStyleEnabled: !isCompressedLayoutActive && !flattenTracks,
                })
                if (candidate) geneLabelCandidates.push(candidate)
            }
        }

        // Render forward strand genes
        for (const gene of layout.forwardGenes) {
            renderGene(gene, FORWARD_Y, 'forward', 0)
        }

        // Render reverse strand genes
        for (const gene of layout.reverseGenes) {
            renderGene(gene, REVERSE_Y, 'reverse', 1)
        }

        ctx.font = LABEL_FONT
        ctx.textBaseline = 'alphabetic'
        for (const label of placeNonOverlappingGeneLabels(geneLabelCandidates)) {
            // A label belongs to its track. Drawn into the ruler it is unreadable over the
            // ticks and takes the ticks with it, which is what a compact panel makes
            // possible: the ruler sits immediately after the last track, so a few pixels of
            // overflow land on it rather than in a margin.
            if (intersectsRuler(label.y - LABEL_ASCENT_PX, label.y + LABEL_DESCENT_PX, RULER_Y, effectiveRulerHeight)) continue
            ctx.fillStyle = label.fill || colors.geneLabelText
            ctx.textAlign = label.textAlign || 'center'
            ctx.fillText(label.text, label.x, label.y)
        }
        ctx.textAlign = 'center'

        // ---- Selected Gene Focus Lines ----
        const drawFocusLine = (x) => {
            ctx.strokeStyle = colors.focusLine
            ctx.lineWidth = 1.5
            ctx.beginPath()
            if (effectiveRulerPosition === 'top') {
                ctx.moveTo(x, RULER_Y + effectiveRulerHeight)
                ctx.lineTo(x, canvasHeight)
            } else {
                ctx.moveTo(x, 0)
                ctx.lineTo(x, RULER_Y)
            }
            ctx.stroke()
        }

        ctx.setLineDash([6, 3])
        if (isAligned && alignData) {
            // In alignment mode, focus lines indicate alignment boundaries, not selected-gene bounds.
            const overlayToScreenEdge = (overlayPos) => {
                if (isFlipped) {
                    return LHS_WIDTH + (viewEnd - overlayPos) / bpPerPx
                }
                return LHS_WIDTH + (overlayPos - viewStart) / bpPerPx
            }
            drawFocusLine(overlayToScreenEdge(0))
            drawFocusLine(overlayToScreenEdge(alignData.sequence.length))
        } else {
            const isSelectedGeneHidden = selectedGene && ((selectedGene.strand === '+' && effectiveHiddenStrands.forward) || (selectedGene.strand === '-' && effectiveHiddenStrands.reverse))
            const selectedCoords = getGeneCoordRange(selectedGene)
            if (selectedGene && selectedCoords && !isSelectedGeneHidden) {
                drawFocusLine(genomicToScreen(selectedCoords.start))
                drawFocusLine(genomicToScreen(selectedCoords.end))
            } else if (isLocationFocusVisible && focusLocationRange) {
                // The location of focus bounds itself, so it needs no strand or
                // biotype test — only its own edges.
                drawFocusLine(genomicToScreen(focusLocationRange.start))
                drawFocusLine(genomicToScreen(focusLocationRange.end))
            }
        }
        ctx.setLineDash([])

        // ---- LHS Standard Track Bar ----
        ctx.fillStyle = isLight ? '#f8f9fa' : '#1a1b1e' // Block out the underlying tracks
        if (effectiveRulerPosition === 'top') {
            ctx.fillRect(0, RULER_Y + effectiveRulerHeight, LHS_WIDTH, Math.max(0, canvasHeight - effectiveRulerHeight))
        } else {
            ctx.fillRect(0, 0, LHS_WIDTH, RULER_Y)
        }

        const drawSidebarHighlight = (y, h, trackId) => {
            // Base background
            const isHidden = (trackId === 'forward' && effectiveHiddenStrands.forward) ||
                (trackId === 'reverse' && effectiveHiddenStrands.reverse) ||
                (trackId === 'sequence' && effectiveHiddenStrands.sequence) ||
                (isCustomTrackId(trackId) && !(customTracksById.get(trackId)?.visible))

            if (isHidden) {
                ctx.fillStyle = isLight ? '#e9ecef' : '#141517'
                ctx.fillRect(0, y, LHS_WIDTH, h)
            } else {
                ctx.fillStyle = getBgColor(trackId)
                ctx.fillRect(0, y, LHS_WIDTH, h)
            }

            if (draggingTrack === trackId) {
                ctx.fillStyle = colors.selectedGene
                ctx.fillRect(0, y, LHS_WIDTH, h)
            } else if (hoveredTrack === trackId && draggingTrack !== trackId) {
                // High contrast highlight for hover drop targets
                ctx.fillStyle = isLight ? '#ced4da' : '#373a40'
                ctx.fillRect(0, y, LHS_WIDTH, h)
            }
        }

        drawSidebarHighlight(FORWARD_Y, forwardBgHeight, 'forward')
        drawSidebarHighlight(REVERSE_Y, reverseBgHeight, 'reverse')
        if (showSequenceTrack) {
            drawSidebarHighlight(SEQUENCE_Y, seqBgHeight, 'sequence')
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            drawSidebarHighlight(trackLayout.y, trackLayout.height, trackId)
        }
        ctx.strokeStyle = colors.gutterLine
        ctx.lineWidth = 1
        ctx.beginPath()
        if (effectiveRulerPosition === 'top') {
            ctx.moveTo(LHS_WIDTH, RULER_Y + effectiveRulerHeight)
            ctx.lineTo(LHS_WIDTH, canvasHeight)
        } else {
            ctx.moveTo(LHS_WIDTH, 0)
            ctx.lineTo(LHS_WIDTH, RULER_Y)
        }
        ctx.stroke()

        ctx.fillStyle = colors.trackLabel
        ctx.font = sansFont(11)
        ctx.textAlign = 'center'

        // Render circular power toggle with panel-specific active color.
        const drawToggle = (x, y, isHidden, label, trackId) => {
            const active = !isHidden
            const iconColor = sidebarToggleIconColor(active)
            const labelColor = isLight ? '#64748b' : '#cbd5e1'

            // Draw label to the left of toggle.
            ctx.fillStyle = (draggingTrack === trackId) ? '#ffffff' : labelColor
            ctx.textAlign = 'right'
            ctx.fillText(label, x - (SIDEBAR_TOGGLE_ICON_SIZE / 2) - SIDEBAR_TOGGLE_LABEL_GAP, y + 4)
            ctx.textAlign = 'center'

            // Stroked, not filled, and with no disc behind it: the glyph's own
            // colour carries the on/off state, and its line weight is set
            // independently of its size so the stem stays legible.
            if (drawPowerGlyph(ctx, x, y, { size: SIDEBAR_TOGGLE_ICON_SIZE, color: iconColor })) return

            // Fallback where Path2D is unavailable.
            const ringRadius = (SIDEBAR_TOGGLE_ICON_SIZE / 2) - 1.7
            ctx.strokeStyle = iconColor
            ctx.lineWidth = 1.8
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.arc(x, y + 1.2, ringRadius, -Math.PI * 0.34, Math.PI * 1.34)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(x, y - ringRadius - 1.4)
            ctx.lineTo(x, y - 0.2)
            ctx.stroke()
        }

        // Fwd toggle — only when track is in layout (height > 0)
        if (forwardBgHeight > 0) {
            const fwdLabelY = FORWARD_Y + forwardBgHeight / 2
            drawToggle(LHS_WIDTH - 13, fwdLabelY, effectiveHiddenStrands.forward, 'GF', 'forward')
        }

        // Rev toggle — only when track is in layout (height > 0)
        if (reverseBgHeight > 0) {
            const revLabelY = REVERSE_Y + reverseBgHeight / 2
            drawToggle(LHS_WIDTH - 13, revLabelY, effectiveHiddenStrands.reverse, 'GR', 'reverse')
        }

        // Seq toggle — only when track is in layout (SEQUENCE_Y >= 0)
        if (showSequenceTrack && SEQUENCE_Y >= 0) {
            const seqLabelY = SEQUENCE_Y + seqBgHeight / 2
            drawToggle(LHS_WIDTH - 13, seqLabelY, effectiveHiddenStrands.sequence, sequenceTrackLabel, 'sequence')
        }
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            const hidden = !(customTracksById.get(trackId)?.visible)
            const labelY = getCustomTrackToggleY(trackLayout)
            drawToggle(LHS_WIDTH - 13, labelY, hidden, 'CT', trackId)
        }

        // ---- Sequence Track ----
        if (showSequenceTrack && !effectiveHiddenStrands.sequence) {
            const seqY = SEQUENCE_Y
            const seqTrackViewH = seqBgHeight

            const pxPerBp = trackWidth / viewSpan
            if (isAligned && alignData && viewSpan <= 1000) {
                if (pxPerBp >= 2) {
                    ctx.font = pxPerBp >= 10 ? monoFont(12) : monoFont(9)
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'

                    const startIdx = Math.floor(viewStart)
                    const endIdx = Math.ceil(viewEnd)
                    const alnLen = alignData.sequence.length

                    for (let i = startIdx; i < endIdx; i++) {
                        let base = null
                        if (i >= 0 && i < alnLen) {
                            base = alignData.sequence[i]
                        } else if (sequence && seqRange) {
                            const genomicBp = Math.round(overlayToGenomic(i))
                            const seqIdx = genomicBp - seqRange.start
                            if (seqIdx >= 0 && seqIdx < sequence.length) {
                                base = sequence[seqIdx]
                                if (alignData.strand === '-') {
                                    base = REV_COMP[base] || base
                                }
                            }
                        }
                        if (!base) continue

                        const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                        const { bxL, bxR, bxW } = getBasePixelBounds(i, pxPerBp)
                        const seqBoxT = Math.round(seqY + 6)
                        const seqBoxH = 24
                        const alignedBp = Math.round(overlayToGenomic(i))
                        ctx.fillStyle = displayBase === '-' ? '#95a5a6' : getBaseColor(displayBase, colors)
                        ctx.fillRect(bxL, seqBoxT, bxW, seqBoxH)
                        if (pxPerBp >= 6 && bxW >= 2) {
                            // 0.5 snap keeps 1px separators crisp on canvas.
                            const sepX = bxR - 0.5
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)'
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(sepX, seqBoxT + 0.5)
                            ctx.lineTo(sepX, seqBoxT + seqBoxH - 0.5)
                            ctx.stroke()
                        }
                        // Hover outline
                        if (hoveredSeqBase?.bp === alignedBp && bxW >= 2) {
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'
                            ctx.lineWidth = 2
                            ctx.strokeRect(bxL + 1, seqBoxT + 1, Math.max(0, bxW - 2), seqBoxH - 2)
                        }
                        if (pxPerBp >= 10) {
                            ctx.fillStyle = '#ffffff'
                            ctx.fillText(displayBase.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
                        }
                    }
                    ctx.textBaseline = 'alphabetic'
                }
            } else if (sequence && seqRange && viewSpan <= 1000) {
                if (pxPerBp >= 2) {
                    ctx.font = pxPerBp >= 10 ? monoFont(12) : monoFont(9)
                    ctx.textAlign = 'center'
                    ctx.textBaseline = 'middle'
                    for (let i = 0; i < sequence.length; i++) {
                        const bp = seqRange.start + i
                        if (bp < viewStart || bp >= viewEnd) continue
                        const base = sequence[i]
                        const displayBase = isFlipped ? (REV_COMP[base] || base) : base
                        const { bxL, bxR, bxW } = getBasePixelBounds(bp, pxPerBp)
                        const seqBoxT = Math.round(seqY + 6)
                        const seqBoxH = 24
                        ctx.fillStyle = getBaseColor(displayBase, colors)
                        ctx.fillRect(bxL, seqBoxT, bxW, seqBoxH)
                        if (pxPerBp >= 6 && bxW >= 2) {
                            const sepX = bxR - 0.5
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.25)'
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(sepX, seqBoxT + 0.5)
                            ctx.lineTo(sepX, seqBoxT + seqBoxH - 0.5)
                            ctx.stroke()
                        }
                        // Hover outline
                        if (hoveredSeqBase?.bp === bp && bxW >= 2) {
                            ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'
                            ctx.lineWidth = 2
                            ctx.strokeRect(bxL + 1, seqBoxT + 1, Math.max(0, bxW - 2), seqBoxH - 2)
                        }
                        if (pxPerBp >= 10) {
                            ctx.fillStyle = '#ffffff'
                            ctx.fillText(displayBase.toUpperCase(), bxL + bxW / 2, seqBoxT + seqBoxH / 2)
                        }
                    }
                    ctx.textBaseline = 'alphabetic'
                }
            } else {
                // Not zoomed in enough — always show a hint so the track is never blank
                const trackW = viewWidth - LHS_WIDTH
                ctx.fillStyle = isLight ? '#868e96' : '#5c5f66'
                ctx.font = sansFont(9)
                ctx.textAlign = 'center'
                ctx.fillText('zoom in to see sequence', LHS_WIDTH + trackW / 2, seqY + seqTrackViewH / 2 + 4)
            }
        }

        // ---- Custom BigWig Tracks ----
        for (const [trackId, trackLayout] of Object.entries(customTrackLayouts)) {
            const track = customTracksById.get(trackId)
            if (!track || !track.visible) continue

            const left = LHS_WIDTH + 2
            const right = viewWidth - 2
            const width = Math.max(1, right - left)
            const trackType = track.type || 'bigwig'
            const bigWigSettings = trackType === 'bigwig'
                ? normalizeBigWigSettings(track?.bigwigSettings || track?.bigwig_settings)
                : null
            const rawRenderMode = track.renderMode || DEFAULT_CUSTOM_TRACK_RENDER_MODE
            const renderMode = trackType === 'bigwig'
                ? normalizeBigWigDisplayMode(rawRenderMode, bigWigSettings?.data_type)
                : trackType === 'vcf'
                    ? normalizeVcfDisplayMode(rawRenderMode)
                    : rawRenderMode
            const vcfSettings = trackType === 'vcf'
                ? normalizeVcfSettings(track?.vcfSettings || track?.vcf_settings)
                : null
            const vcfGenicColor = vcfSettings?.genic_color || VCF_SETTINGS_DEFAULTS.genic_color
            const vcfIntergenicColor = vcfSettings?.intergenic_color || VCF_SETTINGS_DEFAULTS.intergenic_color
            const data = customTrackData[trackId]
            const { top, bottom, plotHeight, labelY } = getCustomTrackGeometry(trackLayout, renderMode, trackType, data)
            const isLoading = !!customTrackLoading[trackId]
            const coverage = typeof data?.coverage === 'number' ? data.coverage : 0

            // Persistent label near the track edge (above for secondary, below for primary zoned mode).
            const labelX = LHS_WIDTH + 8
            const labelText = track.label || 'Custom track'
            ctx.save()
            ctx.font = sansFont(11)
            ctx.fillStyle = isLight ? '#1e3a8a' : '#93c5fd'
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillText(labelText, labelX, labelY)
            ctx.restore()

            const isDiscreteTrack = ['vcf', 'bed', 'bigbed', 'splice_junctions', 'long_reads'].includes(trackType)

            if (isDiscreteTrack) {
                if (!data || (data.error && !data.has_data)) {
                    if (data?.error && !data?.has_data) {
                        ctx.fillStyle = isLight ? '#b91c1c' : '#fca5a5'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText(data.error.substring(0, 80), left + width / 2, top + plotHeight / 2 + 3)
                    } else if (isLoading) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight / 2 + 3)
                    }
                    continue
                }

                const dataStart = data.start ?? viewStart
                const dataEnd = data.end ?? viewEnd
                const dataSpan = Math.max(1, dataEnd - dataStart)

                // Helper: genomic coord → canvas x (absolute, not relative to left)
                const gToX = (g) => left + ((g - dataStart) / dataSpan) * width

                if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode) && data?.mode === 'adp_detail') {
                    // L4 individual variant rendering
                    const variants = Array.isArray(data?.variants) ? data.variants : []
                    const barH = Math.max(5, Math.floor(plotHeight * 0.13))
                    const barY = top + Math.floor((plotHeight - barH) / 2)
                    const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width
                    const hb = hoveredVcfBlock
                    // Colorblind-safe: blue (SNV), green (ins), amber (del)
                    const VARIANT_FILL = {
                        snv:   isLight ? '#4a7cf5' : '#7ab4fc',
                        ins:   isLight ? '#16a34a' : '#4ade80',
                        del:   isLight ? '#d97706' : '#fbbf24',
                        indel: isLight ? '#9333ea' : '#c084fc',
                    }
	                    const VARIANT_STROKE = {
	                        snv:   isLight ? 'rgba(30,60,160,0.75)'  : 'rgba(120,170,255,0.65)',
	                        ins:   isLight ? 'rgba(10,100,30,0.75)'  : 'rgba(100,220,130,0.65)',
	                        del:   isLight ? 'rgba(150,80,0,0.75)'   : 'rgba(250,180,50,0.65)',
	                        indel: isLight ? 'rgba(100,20,160,0.75)' : 'rgba(190,100,250,0.65)',
	                    }
	                    const ANCHOR_FILL_ACTIVE = isLight ? '#3b82f6' : '#60a5fa'
	                    const ANCHOR_STROKE = isLight ? 'rgba(30,64,175,0.9)' : 'rgba(191,219,254,0.95)'
	                    const drawAnchorIcon = (cx, cy, boxH, boxW) => {
	                        const img = anchorIconImgRef.current
	                        if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
	                        // Fill the anchor block with icon detail while leaving a tiny border.
	                        const margin = 0.5
	                        const targetH = Math.max(4, boxH - margin * 2)
	                        const targetW = Math.max(4, Math.min(boxW - margin * 2, targetH * 1.05))
	                        const iH = Math.max(4, targetH * 0.9)
	                        const iW = Math.max(4, targetW * 0.9)
	                        const x = cx - (iW / 2)
	                        const y = cy - (iH / 2)
	                        ctx.save()
	                        ctx.imageSmoothingEnabled = true
	                        ctx.drawImage(img, x, y, iW, iH)
	                        ctx.restore()
	                    }
	                    // Indel dashed markers: show at ≤1 bp/px; labels only when sequence boxes visible (≤0.5 bp/px)
	                    const showIndelMarkers = bpPerPx <= 1
	                    const showIndelLabels = bpPerPx <= 0.5
                    const cvPos = clickedVcfVariant?.variant?.pos
                    const cvType = clickedVcfVariant ? localVcfType(clickedVcfVariant.variant) : null

                    // Position-based genic check: consistent with L0-L3 block_spans coloring.
                    // Prefilter to genes visible in this view to keep the inner check cheap.
                    const viewGenicGenes = !isAligned
                        ? genes.filter(g => Number(g.end) >= viewStart && Number(g.start) <= viewEnd)
                        : []
                    const isPosiGenic = (pos) =>
                        viewGenicGenes.some(g => Number(g.start) <= pos && Number(g.end) >= pos)

                    ctx.save()

                    // ── Reference bases: unfilled outlined boxes for positions with no SNV variant ──
                    if (bpPerPx <= 1) {
                        const occupiedPos = new Set(
                            variants
                                .filter(v => localVcfType(v) === 'snv')
                                .map(v => Number(v?.pos))
                                .filter(Number.isFinite)
                        )
                        for (let bp = Math.floor(viewStart); bp <= Math.ceil(viewEnd); bp++) {
                            if (occupiedPos.has(bp)) continue
                            const bxL = blockGToX(bp)
                            const bxR = blockGToX(bp + 1)
                            const drawL = Math.max(left, bxL)
                            const drawR = Math.min(right, bxR)
                            const drawW = drawR - drawL
                            if (drawW <= 0) continue
                            const regionColor = isPosiGenic(bp)
                                ? vcfGenicColor : vcfIntergenicColor
                            ctx.strokeStyle = regionColor
                            ctx.lineWidth = 1
                            ctx.strokeRect(drawL + 0.5, barY + 0.5, Math.max(0, drawW - 1), barH - 1)
                        }
                    }

                    // ── Pass 1: build indelItems, deduplicating multi-allelic split rows ──
                    const indelItems = []
                    if (showIndelMarkers) {
                        const seenIndel = new Set()
                        for (const v of variants) {
                            const vtype = localVcfType(v)
                            if (vtype === 'snv') continue
	                            const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                            const vpos = layoutInfo.vpos
	                            if (!Number.isFinite(vpos)) continue
	                            const key = `${vtype}:${vpos}`
	                            if (seenIndel.has(key)) continue  // already represented
	                            seenIndel.add(key)
	                            const vend = Number(v?.end ?? v?.pos)
                            const nBars = getVcfAltAlleleCount(v)
	                            // Marker placement is type-aware:
	                            // ins = right edge of anchor base, del = center of first deleted base.
	                            const xGenomic = layoutInfo.markerXGenomic
                            const x = blockGToX(Math.max(viewStart, xGenomic))
                            const primaryDir = vtype === 'ins' ? 'up' : 'down'
                            const altDir = primaryDir === 'up' ? 'down' : 'up'
                            let dir = primaryDir
                            let level = 0
                            if (showIndelLabels) {
                                // Bidirectional stagger: pick direction needing least displacement
                                // Proximity accounts for bar width (bars extend right from dot)
                                const MAX_LEVEL = 3
                                let lP = 0, lA = 0
                                for (const existing of indelItems) {
                                    // Right edge of existing's bars vs new dot, and vice versa
                                    const leftNBars = existing.x <= x ? existing.nBars : nBars
                                    const inProximity = Math.abs(existing.x - x) < Math.max(50, 7 + leftNBars * 14 + 5)
                                    if (inProximity) {
                                        if (existing.dir === primaryDir) lP = Math.max(lP, existing.level + 1)
                                        if (existing.dir === altDir)    lA = Math.max(lA, existing.level + 1)
                                    }
                                }
                                lP = Math.min(lP, MAX_LEVEL)
                                lA = Math.min(lA, MAX_LEVEL)
                                if (lA < lP) { dir = altDir; level = lA }
                                else          { dir = primaryDir; level = lP }
                            }
                            indelItems.push({ v, vpos, vend, x, dir, level, nBars })
                        }
                    }

	                    // ── Pass 2: draw variant blocks — non-active first, active on top ──
	                    const drawBlock = (v, topPass) => {
	                        const vtype = localVcfType(v)
	                        const layoutInfo = getVcfDetailVariantLayout(v, vtype)
	                        const vpos = layoutInfo.vpos
	                        if (!Number.isFinite(vpos)) return
	                        const visibleStart = Math.min(layoutInfo.anchorStart, layoutInfo.refStart)
	                        const visibleEnd = Math.max(layoutInfo.anchorEnd, layoutInfo.refEnd)
	                        if (visibleStart > viewEnd || visibleEnd < viewStart) return
	                        const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
	                        const isClicked = cvPos === vpos && cvType === vtype
	                        const active = isHovered || isClicked
	                        if (topPass !== active) return  // each block drawn in exactly one pass
	                        const activeStroke = isClicked
	                            ? (isLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,1.0)')
	                            : isHovered
	                                ? (isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)')
	                                : null
	                        const drawSegment = (segStart, segEnd, fillColor, strokeColor, alpha = 0.9) => {
	                            if (!Number.isFinite(segStart) || !Number.isFinite(segEnd) || segEnd <= segStart) return null
	                            const x1 = blockGToX(Math.max(viewStart, segStart))
	                            const x2 = blockGToX(Math.min(viewEnd, segEnd))
	                            const drawStart = Math.max(left, Math.min(x1, x2))
	                            const drawEnd = Math.min(right, Math.max(x1, x2))
	                            const drawW = drawEnd - drawStart
	                            if (drawW <= 0) return null
	                            ctx.fillStyle = fillColor
	                            ctx.globalAlpha = alpha
	                            ctx.fillRect(drawStart, barY, Math.max(1, drawW), barH)
	                            ctx.globalAlpha = 1
	                            ctx.strokeStyle = activeStroke || strokeColor
	                            ctx.lineWidth = isClicked ? 2.5 : isHovered ? 2 : 1
	                            ctx.strokeRect(drawStart + 0.5, barY + 0.5, Math.max(0.5, drawW - 1), barH - 1)
	                            return { drawStart, drawW }
	                        }

	                        if (vtype === 'ins' || vtype === 'del') {
	                            if (vtype === 'del' && layoutInfo.hasDelSpan) {
	                                drawSegment(
	                                    layoutInfo.refStart,
	                                    layoutInfo.refEnd,
	                                    VARIANT_FILL.del,
	                                    VARIANT_STROKE.del
	                                )
	                            }
                            // Anchor base is only visible for hovered/clicked INS/DEL.
                            if (shouldRenderActiveAnchorBase(vtype, active)) {
                                const anchorSeg = drawSegment(
                                    layoutInfo.anchorStart,
                                    layoutInfo.anchorEnd,
                                    ANCHOR_FILL_ACTIVE,
	                                    ANCHOR_STROKE,
	                                    1
	                                )
	                                if (anchorSeg) {
	                                    const anchorCx = anchorSeg.drawStart + (anchorSeg.drawW / 2)
	                                    drawAnchorIcon(anchorCx, barY + barH / 2, barH, anchorSeg.drawW)
	                                }
	                            }
	                            return
	                        }

	                        // SNV/indel blocks represent REF sequence span on genome.
	                        const seg = drawSegment(
	                            layoutInfo.refStart,
	                            layoutInfo.refEnd,
	                            vtype === 'snv'
	                                ? (isPosiGenic(vpos) ? vcfGenicColor : vcfIntergenicColor)
	                                : (VARIANT_FILL[vtype] || (isLight ? '#64748b' : '#94a3b8')),
	                            vtype === 'snv'
	                                ? (isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)')
	                                : (VARIANT_STROKE[vtype] || (isLight ? 'rgba(60,60,60,0.6)' : 'rgba(200,200,200,0.5)'))
	                        )
	                        if (!seg) return

	                        // SNV label above block — omit ins/del labels (dashed markers do that job)
	                        if (vtype === 'snv' && seg.drawW >= 14) {
	                            ctx.font = sansFont(9)
	                            ctx.textAlign = 'center'
	                            ctx.fillStyle = active ? (isLight ? '#1e3a8a' : '#bfdbfe') : (isLight ? '#1e3a8a' : '#93c5fd')
	                            ctx.fillText(v.label || 'SNV', seg.drawStart + seg.drawW / 2, barY - 4)
	                        }
	                    }
                    // Base pass: del/indel first, then SNVs so SNVs paint over by default
                    for (const v of variants) if (localVcfType(v) !== 'snv') drawBlock(v, false)
                    for (const v of variants) if (localVcfType(v) === 'snv') drawBlock(v, false)
                    for (const v of variants) drawBlock(v, true)   // top pass (hovered/clicked on top)

                    // ── Pass 3: draw indel dashed-line markers ────────────────────────
                    if (showIndelMarkers) {
                        for (const { v, vpos, x, dir, level, nBars } of indelItems) {
                            if (vpos > viewEnd || vpos < viewStart) continue
                            const vtype = localVcfType(v)
                            const isHovered = hb?.trackId === trackId && hb?.start === vpos && localVcfType(hb?.variant) === vtype
                            const isClicked = cvPos === vpos && cvType === vtype
                            const active = isHovered || isClicked
                            const dotColor = VARIANT_FILL[vtype] || '#888'
                            const lineBaseLen = showIndelLabels ? 29 : 22
                            const lineLen = lineBaseLen + level * 18

                            ctx.save()

                            // Dashed vertical line
                            ctx.setLineDash([3, 3])
                            ctx.strokeStyle = isLight ? 'rgba(80,80,80,0.55)' : 'rgba(200,200,200,0.5)'
                            ctx.lineWidth = active ? 1.5 : 1
                            ctx.beginPath()
                            if (dir === 'up') { ctx.moveTo(x, barY); ctx.lineTo(x, barY - lineLen) }
                            else { ctx.moveTo(x, barY + barH); ctx.lineTo(x, barY + barH + lineLen) }
                            ctx.stroke()
                            ctx.setLineDash([])

                            // Dot
                            const dotY = dir === 'up' ? barY - lineLen : barY + barH + lineLen
                            const dotR = active ? 5 : 4
                            ctx.fillStyle = dotColor
                            ctx.beginPath()
                            ctx.arc(x, dotY, dotR, 0, Math.PI * 2)
                            ctx.fill()
                            ctx.strokeStyle = active
                                ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)')
                                : (isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)')
                            ctx.lineWidth = active ? 1.5 : 1
                            ctx.stroke()

                            // Allele-count bars + label — only when fully zoomed in
                            if (showIndelLabels) {
                                const abH = 3        // bar height px
                                const abLen = 12     // bar length px
                                const abGap = 2      // horizontal gap between bars
                                const abStartX = x + dotR + 3
                                const abY = dir === 'up'
                                    ? Math.min(dotY + dotR + 3, barY - abH - 5)
                                    : Math.max(barY + barH + 5, dotY - dotR - abH - 3)
                                ctx.globalAlpha = active ? 0.85 : 0.55
                                ctx.fillStyle = dotColor
                                for (let i = 0; i < nBars; i++) {
                                    ctx.fillRect(abStartX + i * (abLen + abGap), abY, abLen, abH)
                                }
                                ctx.globalAlpha = 1

                                const label = vtype === 'ins' ? 'ins' : vtype === 'del' ? 'del' : 'indel'
                                ctx.fillStyle = active
                                    ? (isLight ? '#111827' : '#f9fafb')
                                    : (isLight ? '#374151' : '#d1d5db')
                                ctx.font = active ? sansFont(9, 'bold') : sansFont(9)
                                ctx.textAlign = 'left'
                                ctx.fillText(label, x + dotR + 3, dotY + 3)
                            }

                            ctx.restore()
                        }
                    }

                    if (isLoading && variants.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                if (trackType === 'vcf' && isVcfAdaptiveLikeMode(renderMode)) {
                    const spans = Array.isArray(data?.block_spans) ? data.block_spans : []
                    if (renderMode === 'adaptive') {
                        const barH = Math.max(3, Math.floor(plotHeight * 0.18))
                        const barY = top + Math.floor((plotHeight - barH) / 2)

                        // Always map block genomic coords to the CURRENT viewport (viewStart/viewEnd),
                        // not data.start/data.end — prevents blocks sticking during pan.
                        const blockGToX = (g) => left + ((g - viewStart) / Math.max(1, viewEnd - viewStart)) * width

                        // Show outlines when zoomed in enough that individual blocks are wide
                        const showOutlines = bpPerPx < 2

                        ctx.save()
                        ctx.strokeStyle = isLight ? 'rgba(120, 135, 155, 0.3)' : 'rgba(133, 151, 170, 0.26)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, barY + barH / 2)
                        ctx.lineTo(right, barY + barH / 2)
                        ctx.stroke()

                        const hb = hoveredVcfBlock
                        for (const rawSpan of spans) {
                            const s = Number(rawSpan?.start)
                            const e = Number(rawSpan?.end)
                            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                            if (e <= viewStart || s >= viewEnd) continue
                            const x1 = blockGToX(Math.max(viewStart, s))
                            const x2 = blockGToX(Math.min(viewEnd, e))
                            const drawStart = Math.max(left, Math.min(x1, x2))
                            const drawEnd = Math.min(right, Math.max(x1, x2))
                            const drawW = drawEnd - drawStart
                            if (drawW <= 0) continue
                            const cls = rawSpan?.class_name === 'genic' ? 'genic' : 'intergenic'
                            const isHovered = hb?.trackId === trackId && hb?.start === s && hb?.end === e
                            ctx.fillStyle = cls === 'genic' ? vcfGenicColor : vcfIntergenicColor
                            ctx.fillRect(drawStart, barY, Math.max(1, drawW), barH)
                            if (isHovered || (showOutlines && drawW > 2)) {
                                ctx.strokeStyle = isHovered
                                    ? (isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)')
                                    : (isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.2)')
                                ctx.lineWidth = isHovered ? 2 : 0.5
                                ctx.strokeRect(drawStart + 0.5, barY + 0.5, Math.max(0, drawW - 1), barH - 1)
                            }
                        }
                        ctx.restore()

                        if (isLoading && spans.length === 0) {
                            ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                            ctx.font = sansFont(10)
                            ctx.textAlign = 'center'
                            ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                        }
                        continue
                    }

                    // Density-Lollipop coarse mode: enrichment profile with genic/intergenic coloring.
                    const densityBins = Array.isArray(data?.density_bins) ? data.density_bins : []
                    const densityClasses = Array.isArray(data?.density_classes) ? data.density_classes : []
                    const binCount = Math.max(0, Math.min(densityBins.length, densityClasses.length))
                    const hasDensitySignal = densityBins.some((v) => Number(v) > 0)
                    const densityHotspots = normalizeVcfDensityForHotspots(densityBins)
                    const baseY = bottom - 2
                    const peakY = top + 8
                    const amp = Math.max(6, baseY - peakY)
                    const bw = width / Math.max(1, binCount || 1)

                    ctx.save()
                    ctx.strokeStyle = isLight ? 'rgba(120, 135, 155, 0.25)' : 'rgba(133, 151, 170, 0.2)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, baseY + 0.5)
                    ctx.lineTo(right, baseY + 0.5)
                    ctx.stroke()

                    const runs = []
                    let current = null
                    for (let i = 0; i < binCount; i++) {
                        const rawV = Number(densityHotspots[i])
                        const v = Number.isFinite(rawV) ? Math.max(0, Math.min(1, rawV)) : 0
                        const cls = densityClasses[i] === 'genic' ? 'genic' : 'intergenic'
                        const x = left + (i + 0.5) * bw
                        const y = baseY - Math.max(0, v * amp)
                        if (!current || current.cls !== cls) {
                            if (current && current.points.length > 0) runs.push(current)
                            current = { cls, points: [] }
                        }
                        current.points.push({ x, y })
                    }
                    if (current && current.points.length > 0) runs.push(current)

                    for (const run of runs) {
                        const pts = run.points
                        if (!Array.isArray(pts) || pts.length === 0) continue
                        const color = run.cls === 'genic' ? vcfGenicColor : vcfIntergenicColor
                        const xLeft = Math.max(left, pts[0].x - (bw / 2))
                        const xRight = Math.min(right, pts[pts.length - 1].x + (bw / 2))
                        if (xRight <= xLeft) continue

                        ctx.fillStyle = hexToRgba(color, isLight ? 0.8 : 0.72)
                        if (pts.length === 1) {
                            const barH = Math.max(0, baseY - pts[0].y)
                            if (barH <= 0) continue
                            ctx.fillRect(xLeft, pts[0].y, Math.max(1, xRight - xLeft), barH)
                            ctx.strokeStyle = hexToRgba(color, isLight ? 0.95 : 0.9)
                            ctx.lineWidth = 1
                            ctx.beginPath()
                            ctx.moveTo(xLeft, pts[0].y)
                            ctx.lineTo(xRight, pts[0].y)
                            ctx.stroke()
                            continue
                        }
                        ctx.beginPath()
                        ctx.moveTo(xLeft, baseY)
                        for (let i = 0; i < pts.length; i++) {
                            ctx.lineTo(pts[i].x, pts[i].y)
                        }
                        ctx.lineTo(xRight, baseY)
                        ctx.closePath()
                        ctx.fill()

                        ctx.strokeStyle = hexToRgba(color, isLight ? 0.95 : 0.9)
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(pts[0].x, pts[0].y)
                        for (let i = 1; i < pts.length; i++) {
                            ctx.lineTo(pts[i].x, pts[i].y)
                        }
                        ctx.stroke()
                    }
                    ctx.restore()

                    if (isLoading && !hasDensitySignal) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                // ── Density bins (coarse LOD for any discrete type) ────────────────
                if (Array.isArray(data.bins) && data.bins.length > 0) {
                    // Ensembl-style: continuous teal bar with opacity proportional to density
                    if (renderMode === 'ensembl' && trackType === 'vcf') {
                        const maxCount = data.max_count || Math.max(...data.bins.filter(Number.isFinite)) || 1
                        const bw = width / data.bins.length
                        const barY = top + 2
                        const barH = Math.min(10, plotHeight * 0.3)
                        ctx.save()
                        // Thin baseline
                        ctx.strokeStyle = isLight ? 'rgba(115, 184, 178, 0.3)' : 'rgba(115, 184, 178, 0.2)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, barY + barH / 2 + 0.5)
                        ctx.lineTo(right, barY + barH / 2 + 0.5)
                        ctx.stroke()

                        for (let i = 0; i < data.bins.length; i++) {
                            const v = data.bins[i]
                            if (!v || !Number.isFinite(v)) continue
                            const alpha = Math.min(0.85, 0.15 + (v / maxCount) * 0.7)
                            ctx.fillStyle = isLight
                                ? `rgba(91, 167, 161, ${alpha})`
                                : `rgba(115, 200, 193, ${alpha})`
                            const x = left + i * bw
                            const w = Math.max(1, bw)
                            ctx.fillRect(x, barY, w, barH)
                        }
                        ctx.restore()
                        continue
                    }
                    // Default density bars for non-Ensembl discrete tracks
                    const maxCount = data.max_count || Math.max(...data.bins.filter(Number.isFinite)) || 1
                    const bw = width / data.bins.length
                    const barColor = isLight ? 'rgba(245,158,11,0.7)' : 'rgba(251,191,36,0.55)'
                    ctx.save()
                    ctx.fillStyle = barColor
                    for (let i = 0; i < data.bins.length; i++) {
                        const v = data.bins[i]
                        if (!v || !Number.isFinite(v)) continue
                        const barH = (v / maxCount) * plotHeight
                        ctx.fillRect(left + i * bw, bottom - barH, Math.max(1, bw - 0.5), barH)
                    }
                    ctx.restore()
                    continue
                }

                // ── Fine VCF variants ─────────────────────────────────────────────
                if (trackType === 'vcf' && Array.isArray(data.variants)) {
                    if (renderMode === 'ensembl') {
                        // ─── Ensembl-style VCF rendering ──────────────────────────
                        const tealFill = isLight ? 'rgba(91, 167, 161, 0.7)' : 'rgba(115, 200, 193, 0.55)'
                        const tealStroke = isLight ? 'rgba(70, 140, 134, 0.5)' : 'rgba(90, 170, 163, 0.4)'
                        const insFill = isLight ? 'rgba(59, 130, 246, 0.65)' : 'rgba(96, 165, 250, 0.5)'
                        const delFill = isLight ? 'rgba(239, 68, 68, 0.6)' : 'rgba(248, 113, 113, 0.5)'

                        // Variant block sizing
                        const pxPerBp = width / Math.max(1, dataSpan)
                        const minBlockW = 4
                        const blockH = 8
                        const rowGap = 2
                        const showLabels = pxPerBp > 0.3
                        const labelRowH = showLabels ? 12 : 0
                        const rowH = blockH + rowGap + labelRowH

                        // Rows live entirely inside top→bottom; the ctx.clip below
                        // enforces this even if many rows overflow.
                        const bumpTop = top + 2
                        const bumpBot = bottom

                        // Hard-clip to this track so labels/blocks can never bleed into neighbours
                        ctx.save()
                        ctx.beginPath()
                        ctx.rect(left, top, width, plotHeight)
                        ctx.clip()

                        // Draw thin baseline
                        ctx.strokeStyle = isLight ? 'rgba(115, 184, 178, 0.3)' : 'rgba(115, 184, 178, 0.2)'
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(left, bumpTop + blockH / 2 + 0.5)
                        ctx.lineTo(right, bumpTop + blockH / 2 + 0.5)
                        ctx.stroke()

                        // Sort variants by position for bump allocation
                        const sorted = [...data.variants].sort((a, b) => a.pos - b.pos)
                        const blocks = sorted.map(v => {
                            const refLen = v.ref?.length || 1
                            const blockW = Math.max(minBlockW, refLen * pxPerBp)
                            // Insertions land at the RIGHT EDGE of v.pos (boundary to next base)
                            const x = v.type === 'ins' ? gToX(v.pos + 1) : gToX(v.pos)
                            return { v, x, w: blockW, right: x + blockW }
                        }).filter(b => b.right >= left - 2 && b.x <= right + 2)

                        // Greedy bump
                        const maxRows = Math.max(1, Math.floor((bumpBot - bumpTop) / rowH))
                        const rowEnds = new Array(maxRows).fill(-Infinity)
                        const blockRows = blocks.map(b => {
                            for (let r = 0; r < maxRows; r++) {
                                if (b.x > rowEnds[r] + 2) {
                                    rowEnds[r] = b.right
                                    return r
                                }
                            }
                            return 0
                        })

                        // Draw blocks (all clipped to track bounds by ctx.clip above)
                        for (let i = 0; i < blocks.length; i++) {
                            const { v, x, w } = blocks[i]
                            const row = blockRows[i]
                            const bx = Math.max(left, x)
                            const bw = Math.min(right, x + w) - bx
                            if (bw <= 0) continue

                            // Pick colour by type
                            if (v.type === 'ins') ctx.fillStyle = insFill
                            else if (v.type === 'del') ctx.fillStyle = delFill
                            else ctx.fillStyle = tealFill

                            const by = bumpTop + row * rowH
                            // Rounded rectangle
                            const radius = Math.min(2, bw / 2)
                            ctx.beginPath()
                            ctx.moveTo(bx + radius, by)
                            ctx.lineTo(bx + bw - radius, by)
                            ctx.arcTo(bx + bw, by, bx + bw, by + blockH, radius)
                            ctx.lineTo(bx + bw, by + blockH - radius)
                            ctx.arcTo(bx + bw, by + blockH, bx + bw - radius, by + blockH, radius)
                            ctx.lineTo(bx + radius, by + blockH)
                            ctx.arcTo(bx, by + blockH, bx, by + blockH - radius, radius)
                            ctx.lineTo(bx, by + radius)
                            ctx.arcTo(bx, by, bx + radius, by, radius)
                            ctx.fill()

                            // Subtle border
                            ctx.strokeStyle = tealStroke
                            ctx.lineWidth = 0.5
                            ctx.stroke()

                            // Label below block — skip if it would land outside track
                            const labelY = by + blockH + 1
                            if (showLabels && bw > 20 && labelY + labelRowH <= bottom) {
                                const typeLabel = v.type === 'snp' ? 'SNV'
                                    : v.type === 'snv' ? 'SNV'
                                        : v.type === 'ins' ? 'INS'
                                            : v.type === 'del' ? 'DEL'
                                                : v.type?.toUpperCase() || ''
                                ctx.fillStyle = isLight ? '#4b7c78' : '#9ec5c1'
                                ctx.font = sansFont(9)
                                ctx.textAlign = 'center'
                                ctx.textBaseline = 'top'
                                ctx.fillText(typeLabel, bx + bw / 2, labelY)
                            }
                        }
                        ctx.restore()  // removes clip
                        continue
                    }

                    // ── Default lollipop rendering (non-Ensembl VCF) ──────────────
                    const stickColor = isLight ? '#d97706' : '#fbbf24'
                    const headColor = isLight ? '#92400e' : '#fde68a'
                    ctx.save()
                    for (const v of data.variants) {
                        const x = gToX(v.pos)
                        if (x < left - 2 || x > right + 2) continue
                        ctx.strokeStyle = stickColor
                        ctx.lineWidth = 1
                        ctx.beginPath()
                        ctx.moveTo(x, bottom)
                        ctx.lineTo(x, top + 4)
                        ctx.stroke()
                        ctx.fillStyle = headColor
                        ctx.beginPath()
                        ctx.arc(x, top + 4, 3, 0, Math.PI * 2)
                        ctx.fill()
                    }
                    ctx.restore()
                    continue
                }

                if (trackType === 'bigbed' && data?.mode === 'bigbed_blocks' && Array.isArray(data.block_spans)) {
                    const spans = data.block_spans
                    const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                    const blockY = top + Math.round((plotHeight - blockH) / 2)

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    for (const span of spans) {
                        const s = Number(span?.start)
                        const e = Number(span?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        const fill = bigBedBlockColor(span, isLight)
                        ctx.fillStyle = fill
                        ctx.strokeStyle = isLight ? 'rgba(5,150,105,0.5)' : 'rgba(110,231,183,0.62)'
                        const drawWidth = Math.max(1, drawW)
                        ctx.fillRect(x1, blockY, drawWidth, blockH)
                        if (drawWidth > 2) {
                            ctx.lineWidth = 0.7
                            ctx.strokeRect(x1 + 0.5, blockY + 0.5, Math.max(0.5, drawWidth - 1), Math.max(0.5, blockH - 1))
                        }
                    }
                    ctx.restore()

                    if (isLoading && spans.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                if (trackType === 'bigbed' && data?.mode === 'bigbed_detail' && Array.isArray(data.features)) {
                    const lanePitch = BIGBED_DETAIL_LANE_PITCH
                    const exonH = BIGBED_DETAIL_EXON_HEIGHT
                    const laneBaseY = top + BIGBED_DETAIL_LANE_TOP_PAD
                    const maxVisibleLanes = getBigBedLaneCapacity(plotHeight)
                    const hoveredKey = hoveredBigBedFeature?.trackId === trackId ? hoveredBigBedFeature.key : ''
                    const clickedKey = clickedBigBedFeature?.trackId === trackId
                        ? bigBedFeatureKey(clickedBigBedFeature.feature)
                        : ''

                    const visibleFeatures = []
                    let overflowCount = 0
                    for (const feature of data.features) {
                        const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                        if (lane >= maxVisibleLanes) {
                            overflowCount += 1
                            continue
                        }
                        visibleFeatures.push(feature)
                    }
                    visibleFeatures.sort((a, b) =>
                        (Number(a?._lane ?? a?.lane ?? 0) - Number(b?._lane ?? b?.lane ?? 0))
                        || (Number(a?.start || 0) - Number(b?.start || 0))
                        || (Number(a?.end || 0) - Number(b?.end || 0))
                        || bigBedFeatureKey(a).localeCompare(bigBedFeatureKey(b))
                    )

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()
                    const trackBgColor = getBgColor(trackId)

                    for (const feature of visibleFeatures) {
                        const s = Number(feature?.start)
                        const e = Number(feature?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const lane = Math.max(0, Number(feature?._lane ?? feature?.lane ?? 0))
                        const yMid = laneBaseY + lane * lanePitch + (exonH / 2) + 0.5
                        const y = yMid - exonH / 2
                        if (y + exonH < top || y > bottom) continue

                        const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        const key = bigBedFeatureKey(feature)
                        const isFocused = !!clickedKey && key === clickedKey
                        const isHovered = !clickedKey && key === hoveredKey
                        const dimmed = !!clickedKey && !isFocused
                        const color = bigBedFeatureColor(feature, isLight)
                        const strokeColor = isFocused
                            ? (isLight ? 'rgba(0,0,0,0.92)' : 'rgba(255,255,255,0.96)')
                            : isHovered
                                ? (isLight ? 'rgba(0,0,0,0.74)' : 'rgba(255,255,255,0.84)')
                                : color.stroke
                        const codingFillColor = isFocused ? color.stroke : color.fill
                        const isTranscript = feature?._render_kind === 'transcript'
                            && feature?._structure_valid === true
                            && Array.isArray(feature?._exon_blocks)
                            && feature._exon_blocks.length > 0

                        ctx.save()
                        ctx.globalAlpha = dimmed ? 0.2 : (isFocused ? 1 : (isHovered ? 1 : 0.86))

                        if (isTranscript) {
                            const txBounds = getGenomicIntervalPixelBounds(s, e, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                            const txX1 = txBounds ? Math.max(left, txBounds.x1) : Math.max(left, gToX(Math.max(viewStart, s)))
                            const txX2 = txBounds ? Math.min(right, txBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, e)))
                            const txDrawW = txX2 - txX1
                            if (txDrawW > 0) {
                                ctx.strokeStyle = strokeColor
                                ctx.lineWidth = INTRON_HEIGHT
                                ctx.beginPath()
                                ctx.moveTo(txX1, yMid + 0.5)
                                ctx.lineTo(txX2, yMid + 0.5)
                                ctx.stroke()
                            }

                            const strand = String(feature?.strand || '.')
                            if ((strand === '+' || strand === '-') && txDrawW >= 30) {
                                const visuallyForward = txX1 <= txX2 ? (strand === '+') : (strand === '-')
                                const chevronColor = isFocused
                                    ? strokeColor
                                    : (isLight ? 'rgba(51,65,85,0.58)' : 'rgba(203,213,225,0.52)')
                                ctx.strokeStyle = chevronColor
                                ctx.lineWidth = 1
                                const spacing = Math.max(20, txDrawW / 15)
                                for (let cx = txX1 + 10; cx <= txX2 - 10; cx += spacing) {
                                    const chevDir = visuallyForward ? 3.4 : -3.4
                                    ctx.beginPath()
                                    ctx.moveTo(cx - chevDir, yMid - 3.3)
                                    ctx.lineTo(cx, yMid)
                                    ctx.lineTo(cx - chevDir, yMid + 3.3)
                                    ctx.stroke()
                                }
                            }

                            ctx.fillStyle = codingFillColor
                            ctx.strokeStyle = strokeColor
                            const exonStrokeWidth = isFocused ? 1.8 : (isHovered ? 1.45 : 1.2)
                            ctx.lineWidth = exonStrokeWidth
                            const exons = Array.isArray(feature?._exon_blocks) ? feature._exon_blocks : []
                            const cdsBlocks = Array.isArray(feature?._cds_blocks) ? feature._cds_blocks : []
                            for (const exon of exons) {
                                const es = Number(exon?.start)
                                const ee = Number(exon?.end)
                                if (!Number.isFinite(es) || !Number.isFinite(ee) || ee < es) continue
                                if (ee <= viewStart || es >= viewEnd) continue

                                const overlaps = cdsBlocks
                                    .map((cds) => {
                                        const cdsStart = Number(cds?.start)
                                        const cdsEnd = Number(cds?.end)
                                        if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd) || cdsEnd < cdsStart) return null
                                        const overlapStart = Math.max(es, cdsStart)
                                        const overlapEnd = Math.min(ee, cdsEnd)
                                        return overlapEnd >= overlapStart
                                            ? { start: overlapStart, end: overlapEnd }
                                            : null
                                    })
                                    .filter(Boolean)
                                    .sort((a, b) => a.start - b.start)

                                const segments = []
                                let cursor = es
                                for (const coding of overlaps) {
                                    if (coding.start > cursor) {
                                        segments.push({ start: cursor, end: coding.start - 1, coding: false })
                                    }
                                    segments.push({ start: coding.start, end: coding.end, coding: true })
                                    cursor = Math.max(cursor, coding.end + 1)
                                }
                                if (cursor <= ee) {
                                    segments.push({ start: cursor, end: ee, coding: false })
                                }
                                if (segments.length === 0) {
                                    segments.push({ start: es, end: ee, coding: false })
                                }

                                for (const seg of segments) {
                                    const segBounds = getGenomicIntervalPixelBounds(seg.start, seg.end, 1 / Math.max(1e-9, bpPerPx), viewSpan <= 1000 && (1 / Math.max(1e-9, bpPerPx)) >= 2)
                                    const sx1 = segBounds ? Math.max(left, segBounds.x1) : Math.max(left, gToX(Math.max(viewStart, seg.start)))
                                    const sx2 = segBounds ? Math.min(right, segBounds.x2) : Math.min(right, gToX(Math.min(viewEnd, seg.end)))
                                    const segW = sx2 - sx1
                                    if (segW <= 0) continue

                                    const drawH = exonH
                                    const segY = yMid - drawH / 2
                                    const strokeInset = exonStrokeWidth / 2
                                    const drawX = sx1 + strokeInset
                                    const drawY = segY + strokeInset
                                    const boxW = Math.max(0.5, segW - exonStrokeWidth)
                                    const boxH = Math.max(0.5, drawH - exonStrokeWidth)

                                    ctx.fillStyle = trackBgColor
                                    ctx.fillRect(sx1, segY, segW, drawH)
                                    if (seg.coding) {
                                        ctx.fillStyle = codingFillColor
                                        ctx.fillRect(drawX, drawY, boxW, boxH)
                                    }
                                    ctx.strokeStyle = strokeColor
                                    ctx.lineWidth = exonStrokeWidth
                                    ctx.strokeRect(drawX, drawY, boxW, boxH)
                                }
                            }
                        } else {
                            ctx.fillStyle = color.fill
                            ctx.strokeStyle = strokeColor
                            ctx.lineWidth = isFocused ? 2 : (isHovered ? 1.5 : 0.9)
                            const drawWidth = Math.max(1, drawW)
                            ctx.fillRect(x1, y, drawWidth, exonH)
                            if (drawWidth > 2) {
                                ctx.strokeRect(
                                    x1 + 0.5,
                                    y + 0.5,
                                    Math.max(0.5, drawWidth - 1),
                                    Math.max(0.5, exonH - 1)
                                )
                            }
                        }
                        ctx.restore()
                    }

                    if (overflowCount > 0) {
                        ctx.fillStyle = isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)'
                        ctx.font = sansFont(9)
                        ctx.textAlign = 'right'
                        ctx.textBaseline = 'bottom'
                        ctx.fillText(`+${overflowCount} overflow`, right - 3, bottom - 1)
                    }
                    ctx.restore()

                    if (isLoading && visibleFeatures.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight / 2 + 3)
                    }
                    continue
                }

                // ── BED intervals ─────────────────────────────────────────────────
                if (trackType === 'bed' && Array.isArray(data.features)) {
                    const barH = Math.min(10, plotHeight * 0.35)
                    const barY = top + (plotHeight - barH) / 2
                    const bedColor = isLight ? 'rgba(16,185,129,0.7)' : 'rgba(52,211,153,0.55)'
                    ctx.save()
                    ctx.fillStyle = bedColor
                    for (const f of data.features) {
                        const x1 = Math.max(left, gToX(f.start))
                        const x2 = Math.min(right, gToX(f.end))
                        if (x2 <= x1) continue
                        ctx.fillRect(x1, barY, x2 - x1, barH)
                    }
                    ctx.restore()
                    continue
                }

                if (trackType === 'splice_junctions' && data?.mode === 'splice_blocks' && Array.isArray(data.block_spans)) {
                    const spans = data.block_spans
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                    const blockH = Math.min(12, Math.max(8, Math.round(plotHeight * 0.34)))
                    const blockY = top + Math.round((plotHeight - blockH) / 2)
                    const radius = Math.max(1, Math.min(3, blockH / 3))

                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    ctx.strokeStyle = isLight ? 'rgba(139,92,246,0.22)' : 'rgba(196,181,253,0.24)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, blockY + blockH / 2 + 0.5)
                    ctx.lineTo(right, blockY + blockH / 2 + 0.5)
                    ctx.stroke()

                    for (const span of spans) {
                        const s = Number(span?.start)
                        const e = Number(span?.end)
                        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
                        if (e <= viewStart || s >= viewEnd) continue
                        const x1 = Math.max(left, gToX(Math.max(viewStart, s)))
                        const x2 = Math.min(right, gToX(Math.min(viewEnd, e)))
                        const drawW = x2 - x1
                        if (drawW <= 0) continue

                        const support = Math.max(0, Number(span?.max_support || 0))
                        const weight = spliceSupportBandWeight(support, spliceSettings)
                        const [r, g, b] = spliceSupportColor(weight, isLight)
                        const fillAlpha = 0.3 + weight * 0.6
                        const strokeAlpha = 0.35 + weight * 0.45
                        ctx.fillStyle = `rgba(${r},${g},${b},${fillAlpha})`
                        ctx.strokeStyle = `rgba(${r},${g},${b},${strokeAlpha})`
                        if (drawW <= 2) {
                            ctx.fillRect(x1, blockY, Math.max(1, drawW), blockH)
                            continue
                        }
                        ctx.beginPath()
                        ctx.moveTo(x1 + radius, blockY)
                        ctx.lineTo(x2 - radius, blockY)
                        ctx.arcTo(x2, blockY, x2, blockY + radius, radius)
                        ctx.lineTo(x2, blockY + blockH - radius)
                        ctx.arcTo(x2, blockY + blockH, x2 - radius, blockY + blockH, radius)
                        ctx.lineTo(x1 + radius, blockY + blockH)
                        ctx.arcTo(x1, blockY + blockH, x1, blockY + blockH - radius, radius)
                        ctx.lineTo(x1, blockY + radius)
                        ctx.arcTo(x1, blockY, x1 + radius, blockY, radius)
                        ctx.closePath()
                        ctx.fill()
                        ctx.lineWidth = 0.6
                        ctx.stroke()
                    }
                    ctx.restore()

                    if (isLoading && spans.length === 0) {
                        ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                        ctx.font = sansFont(10)
                        ctx.textAlign = 'center'
                        ctx.fillText('Loading…', left + width / 2, top + plotHeight * 0.56)
                    }
                    continue
                }

                // ── Splice junctions — arcs ───────────────────────────────────────
                if (trackType === 'splice_junctions' && Array.isArray(data.junctions)) {
                    ctx.save()
                    ctx.beginPath()
                    ctx.rect(left, top, width, plotHeight)
                    ctx.clip()

                    const baselineY = bottom - 4
                    const minTopY = top + 1
                    const spliceSettings = normalizeSpliceTrackSettings(track?.spliceSettings || track?.splice_settings)
                    const lodMode = getSpliceLodMode(trackId, bpPerPx, renderMode)
                    const lanePitch = lodMode === 'detail' ? 10 : 8
                    const maxLanesByHeight = Math.max(1, Math.floor((baselineY - minTopY) / lanePitch))
                    const maxVisibleLanes = Math.max(
                        1,
                        Math.min(maxLanesByHeight, Number(data?.layout?.max_visible_lanes || maxLanesByHeight))
                    )
                    const focusedKey = clickedSpliceJunction?.trackId === trackId
                        ? spliceJunctionKey(clickedSpliceJunction.junction)
                        : ''
                    const hoveredKey = focusedKey
                        ? ''
                        : (hoveredSpliceJunction?.trackId === trackId
                        ? hoveredSpliceJunction.key
                        : '')

                    const source = data.junctions
                        .map((raw) => {
                            const start = Number(raw?.start)
                            const end = Number(raw?.end)
                            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
                            if (end < viewStart || start > viewEnd) return null
                            const rawX1 = gToX(start)
                            const rawX2 = gToX(end)
                            const minX = Math.min(rawX1, rawX2)
                            const maxX = Math.max(rawX1, rawX2)
                            if (maxX < left - 2 || minX > right + 2) return null
                            const visibleLeft = Math.max(left, minX)
                            const visibleRight = Math.min(right, maxX)
                            const visibleWidth = visibleRight - visibleLeft
                            if (visibleWidth < 1.0) return null
                            const count = Number(raw?.n_total ?? raw?.reads ?? 0)
                            const key = raw?.key || spliceJunctionKey(raw)
                            const mapKey = `${trackId}|${key}`
                            return {
                                key,
                                start,
                                end,
                                strand: String(raw?.strand || '.'),
                                n_total: Number.isFinite(count) ? count : 0,
                                motif: String(raw?.motif || ''),
                                annotated: raw?.annotated === true,
                                canonical: raw?.canonical === true,
                                lane: Math.max(0, Number(raw?.lane || 0)),
                                x1: rawX1,
                                x2: rawX2,
                                widthPx: Math.abs(rawX2 - rawX1),
                                visibleWidthPx: visibleWidth,
                                manual_lift: Number(spliceArcLiftOffsets[mapKey] || 0),
                            }
                        })
                        .filter(Boolean)

                    if (source.length === 0) {
                        ctx.restore()
                        continue
                    }

                    if (lodMode === 'blocks') {
                        ctx.restore()
                        continue
                    }

                    const drawCap = Math.max(500, Math.min(spliceSettings.max_junctions, lodMode === 'detail' ? 9000 : 4500))
                    const drawSet = annotateSpliceSimilarityLift(source
                        .sort((a, b) =>
                            (a.lane - b.lane)
                            || (b.n_total - a.n_total)
                            || ((a.end - a.start) - (b.end - b.start))
                            || (a.start - b.start)
                            || (a.end - b.end)
                            || a.strand.localeCompare(b.strand)
                        )
                        .slice(0, drawCap), lodMode)

                    ctx.lineCap = 'butt'
                    ctx.lineJoin = 'round'

                    // Track baseline
                    ctx.strokeStyle = isLight ? 'rgba(139,92,246,0.25)' : 'rgba(196,181,253,0.28)'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(left, baselineY + 0.5)
                    ctx.lineTo(right, baselineY + 0.5)
                    ctx.stroke()

                    let overflow = drawSet.filter((j) => Number(j.lane || 0) >= maxVisibleLanes)
                    const visible = drawSet.filter((j) => Number(j.lane || 0) < maxVisibleLanes)
                    if (focusedKey) {
                        const focusedHidden = overflow.find((j) => j.key === focusedKey)
                        if (focusedHidden && !visible.some((j) => j.key === focusedKey)) {
                            visible.push(focusedHidden)
                            overflow = overflow.filter((j) => j.key !== focusedKey)
                        }
                    }

                    if (overflow.length > 0) {
                        const bins = Math.max(60, Math.min(220, Math.floor(width / 3)))
                        const overflowCounts = Array(bins).fill(0)
                        const overflowMaxSupport = Array(bins).fill(0)
                        for (const j of overflow) {
                            const mid = (j.start + j.end) / 2
                            const idx = clamp(Math.floor(((mid - viewStart) / Math.max(1, viewEnd - viewStart)) * bins), 0, bins - 1)
                            overflowCounts[idx] += Math.max(1, j.n_total || 0)
                            overflowMaxSupport[idx] = Math.max(overflowMaxSupport[idx], Math.max(0, Number(j.n_total || 0)))
                        }
                        const bandTop = Math.max(top + 1, baselineY + 1)
                        const bandBottom = Math.min(bottom - 1, bandTop + 8)
                        const bw = width / bins
                        for (let i = 0; i < bins; i++) {
                            const v = overflowCounts[i]
                            if (v <= 0) continue
                            const supportWeight = spliceSupportBandWeight(overflowMaxSupport[i], spliceSettings)
                            const [r, g, b] = spliceSupportColor(supportWeight, isLight)
                            const alpha = 0.12 + supportWeight * 0.25
                            ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
                            ctx.fillRect(left + i * bw, bandTop, Math.max(1, bw - 0.5), bandBottom - bandTop)
                        }
                    }

                    const nonFocused = []
                    const hovered = []
                    const focused = []
                    for (const j of visible) {
                        if (focusedKey && j.key === focusedKey) focused.push(j)
                        else if (hoveredKey && j.key === hoveredKey) hovered.push(j)
                        else nonFocused.push(j)
                    }
                    nonFocused.sort((a, b) =>
                        (a.lane - b.lane)
                        || (a.n_total - b.n_total)
                        || (a.start - b.start)
                        || (a.end - b.end)
                    )

                    const drawOrdered = [...nonFocused, ...hovered, ...focused]
                    for (const j of drawOrdered) {
                        const lane = Math.max(0, Number(j.lane || 0))
                        const extraLift = Number(j?.manual_lift || 0) + Number(j?.similarity_lift || 0)
                        const peakY = computeSplicePeakY({
                            baselineY,
                            minTopY,
                            lane,
                            lanePitch,
                            widthPx: j.widthPx,
                            lodMode,
                            extraLift,
                        })
                        const controls = getSpliceBezierControls(j.x1, j.x2, peakY)
                        const weight = spliceSupportBandWeight(j.n_total, spliceSettings)
                        const [r, g, b] = spliceSupportColor(weight, isLight)
                        const isFocused = !!focusedKey && j.key === focusedKey
                        const isHovered = !!hoveredKey && j.key === hoveredKey
                        const dimFactor = focusedKey && !isFocused ? 0.2 : 1
                        const strokeAlpha = Math.max(0.08, Math.min(0.98, (0.2 + weight * 0.72) * dimFactor + (isHovered ? 0.14 : 0)))
                        const lw = (1.2 + weight * (lodMode === 'detail' ? 3.0 : 2.2)) + (isFocused ? 1.3 : (isHovered ? 0.9 : 0))

                        ctx.strokeStyle = `rgba(${r},${g},${b},${strokeAlpha})`
                        ctx.lineWidth = lw
                        if (j.canonical !== true) ctx.setLineDash([4, 3])
                        else ctx.setLineDash([])
                        ctx.beginPath()
                        ctx.moveTo(j.x1, baselineY)
                        ctx.bezierCurveTo(controls.c1x, controls.c1y, controls.c2x, controls.c2y, j.x2, baselineY)
                        ctx.stroke()
                        ctx.setLineDash([])

                        if (spliceSettings.show_arrows && j.visibleWidthPx >= (lodMode === 'detail' ? 34 : 65)) {
                            const arrowCount = j.widthPx >= 140 ? 2 : 1
                            const dirSign = j.strand === '-' ? -1 : 1
                            const arrowTs = arrowCount === 2 ? [0.35, 0.65] : [0.5]
                            const arrowLen = Math.max(4, Math.min(7, lw + 2))
                            const arrowWing = Math.max(2.5, arrowLen * 0.55)
                            ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(0.98, strokeAlpha + 0.12)})`
                            ctx.lineWidth = Math.max(1, lw * 0.8)
                            for (const t of arrowTs) {
                                const px = cubicPointAt(j.x1, controls.c1x, controls.c2x, j.x2, t)
                                const py = cubicPointAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                                let tx = cubicDerivativeAt(j.x1, controls.c1x, controls.c2x, j.x2, t)
                                let ty = cubicDerivativeAt(baselineY, controls.c1y, controls.c2y, baselineY, t)
                                if (dirSign < 0) {
                                    tx *= -1
                                    ty *= -1
                                }
                                const norm = Math.hypot(tx, ty) || 1
                                const ux = tx / norm
                                const uy = ty / norm
                                const bx = px - ux * arrowLen
                                const by = py - uy * arrowLen
                                const nx = -uy
                                const ny = ux
                                ctx.beginPath()
                                ctx.moveTo(px, py)
                                ctx.lineTo(bx + nx * arrowWing, by + ny * arrowWing)
                                ctx.moveTo(px, py)
                                ctx.lineTo(bx - nx * arrowWing, by - ny * arrowWing)
                                ctx.stroke()
                            }
                        }
                    }
                    if (overflow.length > 0) {
                        const hiddenN = Number(data?.layout?.overflow_count || overflow.length)
                        ctx.fillStyle = isLight ? 'rgba(71,85,105,0.72)' : 'rgba(148,163,184,0.72)'
                        ctx.font = sansFont(9)
                        ctx.textAlign = 'right'
                        ctx.textBaseline = 'bottom'
                        ctx.fillText(`+${hiddenN} overflow`, right - 3, bottom - 1)
                    }
                    ctx.restore()
                    continue
                }

                // Unknown discrete format — skip
                continue
            }

            // ── Signal track (BigWig / BAM coverage) — always draw available data ─

            if (data?.error && !data?.has_data) {
                ctx.fillStyle = isLight ? '#b91c1c' : '#fca5a5'
                ctx.font = sansFont(10)
                ctx.textAlign = 'center'
                ctx.fillText(data.error, left + width / 2, top + plotHeight / 2 + 3)
                continue
            }

            if (!data || !data.has_data || !Array.isArray(data.bins) || data.bins.length === 0) {
                continue
            }

            const values = data.bins
            const validValues = values.filter((v) => typeof v === 'number')
            if (validValues.length === 0) {
                continue
            }

            const observedMin = Math.min(...validValues)
            const observedMax = Math.max(...validValues)
            const minVal = data.min ?? observedMin
            const maxVal = data.max ?? observedMax
            const safeMax = Math.max(maxVal, minVal + 1e-9)
            const range = safeMax - minVal
            const binWidth = width / values.length

            if (renderMode === 'zoned_heatmap') {
                const colW = Math.max(1, Math.ceil(binWidth))
                const zoneColors = (trackType === 'bigwig' && bigWigSettings)
                    ? bigWigSettings.zoned_colors
                    : (isLight ? ZONED_ZONE_SOLID_COLORS.light : ZONED_ZONE_SOLID_COLORS.dark)
                const isSecondaryZoned = !isPrimaryPanel
                const zoneYForValue = (value) => {
                    const frac = getZonedValueFraction(value)
                    return isSecondaryZoned
                        ? (bottom - frac * plotHeight)
                        : (top + frac * plotHeight)
                }

                // Top baseline and fixed zone guides: 0-100, 100-1k, 1k-10k, 10k-100k (capped).
                ctx.save()
                ctx.strokeStyle = isLight ? '#e8a534' : '#f0b44d'
                ctx.lineWidth = 1
                ctx.beginPath()
                const baselineY = isSecondaryZoned ? bottom + 0.5 : top + 0.5
                ctx.moveTo(left, baselineY)
                ctx.lineTo(right, baselineY)
                ctx.stroke()

                const boundaryValues = [100, 1000, 10000, 100000]
                ctx.setLineDash([4, 3])
                ctx.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.35)' : 'rgba(148, 163, 184, 0.32)'
                for (const boundary of boundaryValues) {
                    const y = zoneYForValue(boundary)
                    ctx.beginPath()
                    ctx.moveTo(left, y)
                    ctx.lineTo(right, y)
                    ctx.stroke()
                }
                ctx.restore()

                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
                    const capped = clamp(value, 0, ZONED_TRACK_MAX_VALUE)
                    const x = left + i * binWidth
                    let zoneStart = 0
                    let yOffset = 0

                    for (let zoneIdx = 0; zoneIdx < ZONED_THRESHOLDS.length; zoneIdx++) {
                        const zoneEnd = ZONED_THRESHOLDS[zoneIdx]
                        if (capped <= zoneStart) break
                        const coveredEnd = Math.min(capped, zoneEnd)
                        if (coveredEnd <= zoneStart) {
                            zoneStart = zoneEnd
                            continue
                        }
                        const zoneSpan = Math.max(1, zoneEnd - zoneStart)
                        const coveredFraction = (coveredEnd - zoneStart) / zoneSpan
                        const segH = plotHeight * (ZONED_ZONE_HEIGHTS[zoneIdx] || 0) * coveredFraction
                        if (segH > 0) {
                            ctx.fillStyle = zoneColors[zoneIdx] || zoneColors[zoneColors.length - 1]
                            const segY = isSecondaryZoned
                                ? (bottom - yOffset - segH)
                                : (top + yOffset)
                            ctx.fillRect(x, segY, colW, segH)
                            yOffset += segH
                        }
                        zoneStart = zoneEnd
                    }
                }

                // Fixed right-side zone labels.
                ctx.save()
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const boundary of boundaryValues) {
                    const y = zoneYForValue(boundary)
                    ctx.fillText(`>${boundary.toLocaleString()}`, viewWidth - 4, y)
                }
                ctx.restore()
            } else if (trackType === 'bigwig' && renderMode === 'signal_plot') {
                const yMin = Math.min(0, observedMin)
                const yMax = Math.max(0, observedMax)
                const yRange = Math.max(1e-9, yMax - yMin)
                const toY = (value) => bottom - ((value - yMin) / yRange) * plotHeight
                const zeroY = clamp(toY(0), top, bottom)
                const plotColor = normalizeBigWigHexColor(bigWigSettings?.plot_color, BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.plot_color)

                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.22)' : 'rgba(148, 163, 184, 0.32)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(left, zeroY)
                ctx.lineTo(right, zeroY)
                ctx.stroke()
                // Color-tinted zero baseline keeps sparse/no-data spans readable.
                ctx.strokeStyle = hexToRgba(plotColor, isLight ? 0.18 : 0.26)
                ctx.beginPath()
                ctx.moveTo(left, zeroY)
                ctx.lineTo(right, zeroY)
                ctx.stroke()

                const segments = []
                const zeroBridges = []
                let current = []
                let gapStartX = null
                let gapEndX = null
                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    const binLeft = left + i * binWidth
                    const binRight = left + (i + 1) * binWidth
                    if (typeof value !== 'number' || !Number.isFinite(value)) {
                        if (current.length > 0) segments.push(current)
                        current = []
                        if (gapStartX === null) gapStartX = binLeft
                        gapEndX = binRight
                        continue
                    }
                    if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                        zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                        gapStartX = null
                        gapEndX = null
                    }
                    const x = left + (i + 0.5) * binWidth
                    const y = clamp(toY(value), top, bottom)
                    current.push({ x, y })
                }
                if (current.length > 0) segments.push(current)
                if (gapStartX !== null && gapEndX !== null && gapEndX > gapStartX) {
                    zeroBridges.push({ x1: gapStartX, x2: gapEndX })
                }

                ctx.fillStyle = hexToRgba(plotColor, 0.28)
                ctx.strokeStyle = hexToRgba(plotColor, 0.94)
                ctx.lineWidth = 1.5

                for (const segment of segments) {
                    if (segment.length === 0) continue
                    if (segment.length === 1) {
                        const p = segment[0]
                        ctx.beginPath()
                        ctx.moveTo(p.x, zeroY)
                        ctx.lineTo(p.x, p.y)
                        ctx.stroke()
                        continue
                    }
                    ctx.beginPath()
                    ctx.moveTo(segment[0].x, zeroY)
                    ctx.lineTo(segment[0].x, segment[0].y)
                    for (let i = 1; i < segment.length; i++) {
                        ctx.lineTo(segment[i].x, segment[i].y)
                    }
                    ctx.lineTo(segment[segment.length - 1].x, zeroY)
                    ctx.closePath()
                    ctx.fill()

                    ctx.beginPath()
                    ctx.moveTo(segment[0].x, segment[0].y)
                    for (let i = 1; i < segment.length; i++) {
                        ctx.lineTo(segment[i].x, segment[i].y)
                    }
                    ctx.stroke()
                }

                if (zeroBridges.length > 0) {
                    ctx.save()
                    ctx.strokeStyle = hexToRgba(plotColor, isLight ? 0.52 : 0.62)
                    ctx.lineWidth = 1
                    ctx.setLineDash([4, 3])
                    for (const gap of zeroBridges) {
                        ctx.beginPath()
                        ctx.moveTo(gap.x1, zeroY)
                        ctx.lineTo(gap.x2, zeroY)
                        ctx.stroke()
                    }
                    ctx.restore()
                }

                const axisX = viewWidth - 14
                ctx.save()
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(axisX, top)
                ctx.lineTo(axisX, bottom)
                ctx.stroke()
                const ticks = [
                    { y: top, value: yMax },
                    { y: top + plotHeight / 2, value: (yMin + yMax) / 2 },
                    { y: bottom, value: yMin },
                ]
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const tick of ticks) {
                    ctx.beginPath()
                    ctx.moveTo(axisX - 4, tick.y)
                    ctx.lineTo(axisX, tick.y)
                    ctx.stroke()
                    ctx.fillText(formatSignalValue(tick.value), viewWidth - 4, tick.y)
                }
                ctx.restore()
            } else {
                // Baseline
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.2)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(left, bottom)
                ctx.lineTo(right, bottom)
                ctx.stroke()

                // Column renderer (one column per screen bin) for stable panning/zoom behavior.
                const fillColor = isLight ? 'rgba(0, 153, 255, 0.55)' : 'rgba(110, 168, 255, 0.62)'
                ctx.fillStyle = fillColor
                const colW = Math.max(1, Math.ceil(binWidth))
                for (let i = 0; i < values.length; i++) {
                    const value = values[i]
                    if (typeof value !== 'number') continue
                    const x = left + i * binWidth
                    const y = bottom - ((value - minVal) / range) * plotHeight
                    const h = Math.max(1, bottom - y)
                    ctx.fillRect(x, y, colW, h)
                }

                // Right-side y-axis reference markers.
                const axisX = viewWidth - 14
                ctx.save()
                ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.25)' : 'rgba(148, 163, 184, 0.35)'
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(axisX, top)
                ctx.lineTo(axisX, bottom)
                ctx.stroke()

                const ticks = [
                    { y: top, value: safeMax },
                    { y: top + plotHeight / 2, value: minVal + (range / 2) },
                    { y: bottom, value: minVal },
                ]
                ctx.font = sansFont(9)
                ctx.fillStyle = isLight ? '#64748b' : '#94a3b8'
                ctx.textAlign = 'right'
                ctx.textBaseline = 'middle'
                for (const tick of ticks) {
                    ctx.beginPath()
                    ctx.moveTo(axisX - 4, tick.y)
                    ctx.lineTo(axisX, tick.y)
                    ctx.stroke()
                    ctx.fillText(formatSignalValue(tick.value), viewWidth - 4, tick.y)
                }
                ctx.restore()
            }
        }

        // ---- Box Selection Overlay ----
        if (selectionRect) {
            const x = Math.min(selectionRect.x1, selectionRect.x2)
            const y = Math.min(selectionRect.y1, selectionRect.y2)
            const w = Math.abs(selectionRect.x2 - selectionRect.x1)
            const h = Math.abs(selectionRect.y2 - selectionRect.y1)
            if (w > 0 && h > 0) {
                ctx.save()
                ctx.strokeStyle = panelExonColor
                ctx.fillStyle = isLight ? 'rgba(0, 153, 255, 0.08)' : 'rgba(91, 141, 239, 0.14)'
                ctx.lineWidth = 1.5
                ctx.setLineDash([6, 4])
                ctx.fillRect(x, y, w, h)
                ctx.strokeRect(x, y, w, h)
                ctx.restore()
            }
        }

    }, [viewStart, viewEnd, viewWidth, genes, selectedGene, focusLocationRange, isLocationFocusVisible, expandedGenes, transcriptCache, sequence, seqRange, theme, colors, genomicToScreen, showSequenceTrack, sequenceTrackLabel, layout, effectiveHiddenStrands, draggingTrack, hoveredTrack, isAligned, alignData, bpPerPx, selectionRect, customTracksById, customTrackData, customTrackLoading, isCustomTrackId, formatSignalValue, getCustomTrackGeometry, getSpliceLodMode, isPrimaryPanel, panelExonColor, panelPillColor, sidebarToggleIconColor, hoveredVcfBlock, hoveredSpliceJunction, hoveredBigBedFeature, clickedVcfVariant, clickedSpliceJunction, clickedBigBedFeature, hoveredSeqBase, overlayToGenomic, getBasePixelBounds, getGenomicIntervalPixelBounds, spliceArcLiftOffsets, anchorIconReady, getDisplayTranscriptsForGene, getDisplayTranscriptRows, focusTranscriptView, getEffectiveTranscriptLimit, getGeneTotalHeight, transcriptLayoutMetrics, isTranscriptCompressionActive, isCompressedLayoutActive, flattenTracks, compactPanelHeight, effectiveTrackAlign, effectiveRulerPosition, effectiveRulerHeight, naturalCanvasHeight, minCanvasHeight, expandedFooterGeneIds])

    useLayoutEffect(() => {
        const anchor = verticalZoomTrackAnchorRef.current
        const container = containerRef.current
        if (!anchor || !container) return
        if (performance.now() > anchor.expiresAt) {
            verticalZoomTrackAnchorRef.current = null
            return
        }

        const contentY = getGeneFeatureVerticalTargetY(anchor)
        if (!Number.isFinite(contentY)) {
            verticalZoomTrackAnchorRef.current = null
            return
        }

        const deltaY = getAnchoredContentPageScrollDelta({
            containerTop: container.getBoundingClientRect().top,
            contentY,
            clientY: anchor.clientY,
        })
        if (Number.isFinite(deltaY) && Math.abs(deltaY) > 0.5) {
            const scrollElement = findNearestScrollable(rootRef.current)
                || document.scrollingElement
                || document.documentElement
            if (scrollElement && scrollElement !== document.documentElement && scrollElement !== document.body) {
                scrollElement.scrollTop += deltaY
            } else {
                window.scrollBy(0, deltaY)
            }
        }
    }, [getGeneFeatureVerticalTargetY, viewStart, viewEnd])

    // Expose view state upward for shared sequence strip
    useEffect(() => {
        if (onViewStateRef.current) {
            onViewStateRef.current({ sequence, seqRange, viewStart, viewEnd, viewWidth, genomicToScreen, colors })
        }
    }, [sequence, seqRange, viewStart, viewEnd, viewWidth, genomicToScreen, colors])

    // ============ Transcript footer controls (HTML overlay) ============

    const CONTROL_GAP_PX = 4

    const transcriptFooterOverlay = useMemo(() => {
        const controls = []
        // Flatten is a *height* control, not a "hide the gene's own controls" one: a gene
        // whose transcripts are showing still needs the way back, and a tutorial step
        // pointing at that control found nothing there. Compressed and window-wide-expanded
        // layouts do drop it — the first has no room, and in the second every gene is
        // expanded already, so a per-gene pill would be saying something untrue.
        if (compressTranscripts || isViewportTranscriptExpandMode) {
            return { controls }
        }
        const { FORWARD_Y, REVERSE_Y, RULER_Y } = layout

        for (const gene of genes) {
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue
            const isSelected = selectedGene && selectedGene.id === gene.id
            const isDimmed = dimNonSelectedGenes && !!selectedGene && !isSelected

            const txs = transcriptCache[gene.id]
            if (!txs || txs.length === 0) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            const geneWidth = Math.abs(rawGx2 - rawGx1)
            if (geneWidth < 60) continue

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const displayRows = getDisplayTranscriptRows(gene)
            const footer = getGeneFooterGeometry({
                gene,
                txs,
                getEffectiveTranscriptLimit,
                visibleTranscriptCount: displayRows.length,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue
            const displayFooter = expandedFooterPlacementByGeneId.get(String(gene.id)) || footer

            // Transcripts the user has hidden aren't waiting to be revealed by
            // this pill, so they don't count towards its "+N".
            const geneView = getGeneTranscriptView(gene.id)
            const transcriptIds = new Set(txs.map((tx) => String(tx?.id || '')))
            const hiddenIds = (geneView?.hidden || [])
                .map((id) => String(id))
                .filter((id) => transcriptIds.has(id))
            const expandableCount = hiddenIds.length
                ? resolveGeneTranscriptView({
                    transcripts: txs,
                    limit: txs.length,
                    hidden: hiddenIds,
                }).visibleCount
                : txs.length
            const controlState = getTranscriptFooterControlState(
                expandableCount,
                displayRows.filter((row) => !row.ghost).length,
            )
            // A gene with everything hidden has no expand/collapse control left,
            // but still needs the way back — so neither control alone is required.
            if (!controlState && hiddenIds.length === 0) continue

            const controlWidth = controlState
                ? Math.max(TRANSCRIPT_FOOTER_CONTROL_HEIGHT, (controlState.label.length * 6) + 8)
                : 0
            const restoreLabel = hiddenIds.length
                ? `Show ${hiddenIds.length} hidden`
                : ''
            const restoreWidth = restoreLabel ? (restoreLabel.length * 5.6) + 10 : 0
            const totalWidth = controlWidth + (restoreWidth ? restoreWidth + CONTROL_GAP_PX : 0)
            const isExpandedControl = controlState?.action === 'collapse'
            const expandedLabelWidth = isExpandedControl && displayFooter.label
                ? measureExpandedFooterLabelWidth(displayFooter.label)
                : 0
            const expandedGroupWidth = expandedLabelWidth
                ? expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP + totalWidth
                : 0
            const overlayWidth = Math.max(totalWidth, expandedGroupWidth)
            const groupX = clamp(
                displayFooter.x,
                LHS_WIDTH + 6,
                Math.max(LHS_WIDTH + 6, viewWidth - overlayWidth - 6),
            )
            // The same rule the canvas labels follow: a track's own controls stay in their
            // track. Reaching into the ruler makes both unreadable, and a compact panel
            // leaves no margin between the two for an overflow to land in.
            const rowTop = isExpandedControl
                ? displayFooter.labelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET
                : displayFooter.controlY
            if (intersectsRuler(rowTop, rowTop + TRANSCRIPT_FOOTER_CONTROL_HEIGHT, RULER_Y, effectiveRulerHeight)) {
                continue
            }

            controls.push({
                id: gene.id,
                x: groupX,
                controlX: isExpandedControl
                    ? groupX + expandedLabelWidth + EXPANDED_FOOTER_INLINE_GAP
                    : groupX,
                y: displayFooter.controlY,
                width: controlWidth,
                ...(controlState || {}),
                hasPrimary: Boolean(controlState),
                restoreLabel,
                restoreWidth,
                hiddenCount: hiddenIds.length,
                isDimmed,
                isFocused: gene.id === selectedGene?.id,
                totalTranscripts: txs.length,
                geneLabel: displayFooter.label || '',
                geneLabelY: displayFooter.labelY,
                isExpandedControl,
                trackBackground: displayFooter.trackBackground || '',
            })
        }
        return { controls }
    }, [genes, isGeneHiddenFromTracks, transcriptCache, getEffectiveTranscriptLimit, getDisplayTranscriptRows, getGeneTranscriptView, genomicToScreen, viewWidth, layout, effectiveHiddenStrands, selectedGene, dimNonSelectedGenes, compressTranscripts, isViewportTranscriptExpandMode, flattenTracks, transcriptLayoutMetrics, expandedFooterPlacementByGeneId, effectiveRulerHeight])

    /**
     * A speech bubble at the head of every gene the user has written about.
     *
     * DOM over the canvas, like the transcript footer pills above: that buys
     * hit-testing, hover, the tooltip and an accessible name for nothing, and
     * keeps this out of the draw effect entirely.
     */
    const geneNoteOverlay = useMemo(() => {
        const bubbles = []
        // Only once the track is drawing transcripts. Zoomed out, a gene is a
        // block or a tick and a mark on it would be pointing at nothing.
        if (!isTranscriptDetailZoomActive) return { bubbles }
        if (!geneNoteCounts) return { bubbles }
        const { FORWARD_Y, REVERSE_Y } = layout

        for (const gene of genes) {
            const count = Number(geneNoteCounts[String(gene.id)] || 0)
            if (!(count > 0)) continue
            if (isGeneHiddenFromTracks(gene)) continue
            const isForward = gene.strand === '+'
            if (isForward && effectiveHiddenStrands.forward) continue
            if (!isForward && effectiveHiddenStrands.reverse) continue

            const rawGx1 = genomicToScreen(gene.start)
            const rawGx2 = genomicToScreen(gene.end)
            if (!Number.isFinite(rawGx1) || !Number.isFinite(rawGx2)) continue
            if (Math.abs(rawGx2 - rawGx1) < NOTE_BUBBLE_MIN_GENE_WIDTH) continue
            // Flip-safe: a flipped view reverses genomicToScreen, so gene.start
            // is not reliably the left edge.
            const gx1 = Math.min(rawGx1, rawGx2)

            const trackY = isForward ? FORWARD_Y : REVERSE_Y
            const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
            const baseGeneY = trackY + trackPadding + ((gene._row || 0) * transcriptLayoutMetrics.rowPitch)
            const footer = getGeneFooterGeometry({
                gene,
                txs: transcriptCache[gene.id],
                getEffectiveTranscriptLimit,
                genomicToScreen,
                baseGeneY,
                transcriptLayoutMetrics,
                lhsWidth: LHS_WIDTH,
                viewWidth,
            })
            if (!footer) continue

            const top = footer.topY - NOTE_BUBBLE_SIZE - NOTE_BUBBLE_GAP
            // Compressed and flattened layouts leave 1-2px of track padding, so
            // there is simply nowhere to put the mark. Suppressed by the space
            // available rather than by naming the modes, which keeps it drawn
            // wherever it does fit.
            if (top < trackY + 1) continue

            bubbles.push({
                id: gene.id,
                gene,
                count,
                x: clamp(
                    gx1 - 1,
                    LHS_WIDTH + 2,
                    Math.max(LHS_WIDTH + 2, viewWidth - NOTE_BUBBLE_SIZE - 2),
                ),
                y: top,
                isDimmed: dimNonSelectedGenes && !!selectedGene && selectedGene.id !== gene.id,
            })
        }
        return { bubbles }
    }, [genes, geneNoteCounts, isTranscriptDetailZoomActive, genomicToScreen, viewWidth, layout,
        transcriptLayoutMetrics, transcriptCache, getEffectiveTranscriptLimit, effectiveHiddenStrands,
        isGeneHiddenFromTracks, selectedGene, dimNonSelectedGenes])

    // The SVG export builder is a callback and cannot read the memo directly.
    const geneNoteOverlayRef = useRef(geneNoteOverlay)
    geneNoteOverlayRef.current = geneNoteOverlay

    const transcriptPrefetchGenes = useMemo(() => {
        if (!isTranscriptDetailZoomActive || !selectedChrom) {
            return []
        }
        const viewGStart = genomicViewRange.start
        const viewGEnd = genomicViewRange.end
        const layoutBuffer = clamp((viewGEnd - viewGStart) * 0.5, GENE_LAYOUT_BUFFER_MIN, GENE_LAYOUT_BUFFER_MAX)
        const layoutStart = Math.max(0, viewGStart - layoutBuffer)
        const layoutEnd = viewGEnd + layoutBuffer
        const result = collectCachedGenesInRange(selectedChrom, layoutStart, layoutEnd, 1)
        const candidatesById = new Map()
        for (const gene of [...(Array.isArray(result?.genes) ? result.genes : []), ...genes]) {
            const geneId = String(gene?.id || '').trim()
            if (geneId && !candidatesById.has(geneId)) candidatesById.set(geneId, gene)
        }
        const candidates = Array.from(candidatesById.values())
        if (candidates.length <= MAX_TRANSCRIPT_PREFETCH_GENES) {
            return candidates
        }
        const viewCenter = (viewGStart + viewGEnd) / 2
        return candidates
            .slice()
            .sort((a, b) => {
                const aCenter = (Number(a?.start || 0) + Number(a?.end || 0)) / 2
                const bCenter = (Number(b?.start || 0) + Number(b?.end || 0)) / 2
                return Math.abs(aCenter - viewCenter) - Math.abs(bCenter - viewCenter)
            })
            .slice(0, MAX_TRANSCRIPT_PREFETCH_GENES)
    }, [isTranscriptDetailZoomActive, selectedChrom, genomicViewRange, collectCachedGenesInRange, genes])

    useEffect(() => {
        const nextProtectedIds = new Set()
        for (const gene of genes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        for (const gene of transcriptPrefetchGenes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        for (const gene of bufferedTranscriptExpandGenes || []) {
            const geneId = String(gene?.id || '').trim()
            if (geneId) nextProtectedIds.add(geneId)
        }
        if (selectedGene?.id) {
            nextProtectedIds.add(String(selectedGene.id))
        }
        for (const [geneId, limit] of Object.entries(expandedGenes || {})) {
            if (Number(limit) > 1) nextProtectedIds.add(String(geneId))
        }
        protectedTranscriptCacheIdsRef.current = nextProtectedIds
    }, [transcriptPrefetchGenes, bufferedTranscriptExpandGenes, expandedGenes, genes, selectedGene?.id])

    // Also fetch transcripts for visible genes at appropriate zoom
    useEffect(() => {
        if (viewSpan > TRANSCRIPT_DETAIL_VIEWSPAN_BP) return
        const genesToPrefetch = isViewportTranscriptExpandMode
            ? bufferedTranscriptExpandGenes
            : transcriptPrefetchGenes
        for (const gene of genesToPrefetch) {
            if (!transcriptCache[gene.id]) {
                fetchTranscripts(gene.id)
            }
        }
    }, [viewSpan, transcriptCache, fetchTranscripts, transcriptPrefetchGenes, isViewportTranscriptExpandMode, bufferedTranscriptExpandGenes])

    // ============ Search & Navigation ============

    const handleSearch = useCallback(async () => {
        const rawQuery = searchInput.trim()
        if (!rawQuery) return

        const resolveRegionChrom = (rawChrom) => {
            const token = String(rawChrom || '').trim()
            if (!token) return { region: null, ambiguous: false }
            const canonical = token.toLowerCase()
            const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
            const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`
            const tokenVariants = (value) => {
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
            const queryTokens = tokenVariants(token)
            const intersectsTokenSet = (left, right) => {
                for (const value of left) {
                    if (right.has(value)) return true
                }
                return false
            }

            // Exact first
            let region = regions.find((r) => r.chrom === token)
            if (region) return { region, ambiguous: false }

            // Case-insensitive, plus chr/no-chr aliases
            region = regions.find((r) => {
                const rc = String(r.chrom || '').toLowerCase()
                if (rc === canonical) return true
                if (rc === stripChr) return true
                if (rc === addChr) return true
                const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
                return rcStrip === stripChr
            })
            if (region) return { region, ambiguous: false }

            // Assembly-report synonyms returned by the backend.
            const synonymCandidates = regions.filter((r) => {
                const regionTokens = tokenVariants(r.chrom)
                if (intersectsTokenSet(queryTokens, regionTokens)) return true
                const synonyms = Array.isArray(r.synonyms) ? r.synonyms : []
                return synonyms.some((synonym) => intersectsTokenSet(queryTokens, tokenVariants(synonym)))
            })
            if (synonymCandidates.length === 1) {
                return { region: synonymCandidates[0], ambiguous: false }
            }
            if (synonymCandidates.length > 1) {
                return { region: null, ambiguous: true }
            }

            // Mitochondrial aliases
            if (['m', 'mt', 'chrm', 'chrmt'].includes(canonical)) {
                region = regions.find((r) => {
                    const rc = String(r.chrom || '').toLowerCase()
                    const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
                    return rc === 'mt' || rc === 'm' || rc === 'chrm' || rc === 'chrmt' || rcStrip === 'mt' || rcStrip === 'm'
                }) || null
                return { region, ambiguous: false }
            }

            return { region: null, ambiguous: false }
        }

        const resolveChromViaBackend = async (chrom, hintStart) => {
            const requested = String(chrom || '').trim()
            if (!requested) return requested
            const numericHint = Number(hintStart)
            const probeStart = Number.isFinite(numericHint)
                ? Math.max(0, Math.floor(numericHint) - 1)
                : 0
            const probeEnd = probeStart + 1
            try {
                const res = await fetch(
                    `${API_BASE}/api/browse/sequence?genome=${genome}&chrom=${encodeURIComponent(requested)}&start=${probeStart}&end=${probeEnd}`
                )
                if (!res.ok) return requested
                const data = await res.json()
                const resolved = String(data?.chrom || '').trim()
                return resolved || requested
            } catch {
                return requested
            }
        }

        const buildIdentifierWindow = (region, maxSpan = 1_000_000) => {
            if (!region?.chrom) return null
            const length = Math.floor(Number(region.end) || 0)
            if (length <= 0) return null
            if (length <= maxSpan) {
                return { chrom: region.chrom, start: 1, end: Math.max(2, length) }
            }
            const span = Math.min(maxSpan, length)
            const center = Math.max(1 + span / 2, Math.min(length - span / 2, length / 3))
            const start = Math.max(1, Math.round(center - span / 2))
            const end = Math.min(length, start + span)
            return { chrom: region.chrom, start, end: Math.max(start + 1, end) }
        }

        const jumpToRange = async (chrom, rawStart, rawEnd, geneForSelection = null) => {
            const { region: initialRegion, ambiguous } = resolveRegionChrom(chrom)
            let region = initialRegion
            let resolvedChrom = String(initialRegion?.chrom || chrom || '').trim()
            let start = Number(rawStart)
            let end = Number(rawEnd)
            if (!Number.isFinite(start) || !Number.isFinite(end)) return false
            if (end <= start) end = start + 1

            // Jumping to a gene also focuses it, which slides the drawer over
            // this panel's right edge — aim for the middle of what stays visible.
            if (geneForSelection) {
                const framedJump = frameRangeWithRightInset({
                    start,
                    end,
                    trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
                    rightInsetPx: focusDrawerInsetOnFocus,
                    flipped: isFlipped,
                })
                if (framedJump) {
                    start = framedJump.start
                    end = framedJump.end
                }
            }

            if (!region && resolvedChrom) {
                const backendResolvedChrom = await resolveChromViaBackend(resolvedChrom, start)
                if (backendResolvedChrom) {
                    resolvedChrom = backendResolvedChrom
                    region = regions.find((r) => String(r.chrom || '').trim() === resolvedChrom) || null
                }
            }
            if (!resolvedChrom) return false

            if (region) {
                // Region starts should always be 1-based chromosome coordinates.
                // Do not clamp to first-gene position from metadata payloads.
                //
                // Unless the genome declares a narrower window worth looking at, which the
                // tutorial's chromosome-1 slice does. Panning and zooming already respect
                // it through clampView; without it here too, a typed region or a pick from
                // the region list could still strand the user in the padding, which is the
                // one thing the declaration exists to prevent.
                const minBound = Math.max(1, Math.floor(Number(region.browsable_start) || 1))
                const maxBound = Math.max(
                    minBound + 1,
                    Math.floor(Number(region.browsable_end) || region.end || minBound + 1)
                )
                const span = Math.max(1, end - start)
                if (start < minBound) {
                    start = minBound
                    end = Math.min(maxBound, start + span)
                }
                if (end > maxBound) {
                    end = maxBound
                    start = Math.max(minBound, end - span)
                }
                setChromLength(maxBound)
            } else if (ambiguous) {
                // Ambiguous alias and no backend resolution: avoid arbitrary region switching.
                return false
            }

            if (resolvedChrom !== selectedChrom) {
                setSelectedChrom(resolvedChrom)
                setGenes([])
                tileCacheRef.current.clear()
                fetchingTilesRef.current.clear()
            }

            setViewStart(start)
            setViewEnd(end)
            if (onPositionChange) {
                onPositionChange(resolvedChrom, start, end)
            }
            pendingVerticalCenterGeneIdRef.current = geneForSelection?.id || null
            setSelectedGene(geneForSelection)
            setSearchInput('')
            if (onManualNavigate) onManualNavigate()
            // The chromosome as this panel knows it, so a caller that focuses what
            // it jumped to records the resolved name rather than what was typed.
            return resolvedChrom
        }

        // Coordinate format: chr:start-end
        const coordQuery = rawQuery.replace(/[–—]/g, '-')
        const coordMatch = coordQuery.match(/^([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)$/)
        if (coordMatch) {
            const chrom = coordMatch[1]
            const start = parseInt(coordMatch[2].replace(/[,\s]/g, ''), 10)
            const end = parseInt(coordMatch[3].replace(/[,\s]/g, ''), 10)
            // Framed like a focused gene rather than filling the view edge to edge:
            // padded so the boundary lines are visible, and shifted clear of the
            // drawer that focusing the location is about to slide over this panel.
            const requestedSpan = Math.max(1, end - start)
            const flank = Math.max(1, (requestedSpan / FOCUS_RANGE_FILL_FRACTION - requestedSpan) / 2)
            const framedRegion = frameFocusRange(start - flank, end + flank, { gainingFocus: true })
            const resolvedChrom = await jumpToRange(chrom, framedRegion.start, framedRegion.end, null)
            if (resolvedChrom) focusLocation({ chrom: resolvedChrom, start, end })
            // A tutorial step about the search box cannot wait for the box to hold what
            // was typed — jumpToRange empties it — so it waits for this instead. Emitted
            // whether the user typed it or the tutorial did, which is what lets someone
            // who types it themselves move straight on.
            emitTutorialSignal('browser.regionSearched', { chrom, start, end })
            return
        }

        // Region identifier format: chr / CM accession / assembly-report synonym
        const identifierQuery = coordQuery.trim()
        if (identifierQuery && !/[:\s-]/.test(identifierQuery)) {
            const { region, ambiguous } = resolveRegionChrom(identifierQuery)
            if (region) {
                const window = buildIdentifierWindow(region)
                if (window) {
                    await jumpToRange(window.chrom, window.start, window.end, null)
                    return
                }
            }
            if (ambiguous) return
        }

        try {
            const res = await fetch(
                `${API_BASE}/api/resolve_id?genome=${genome}&query=${encodeURIComponent(rawQuery)}`
            )
            if (res.ok) {
                const data = await res.json()
                const gene = data?.gene || null
                if (gene?.chrom) {
                    let focusStart = gene.start
                    let focusEnd = gene.end
                    if (data?.resolved_type === 'transcript' && data?.selected_transcript_id && Array.isArray(data?.transcripts)) {
                        const tx = data.transcripts.find((t) => t.id === data.selected_transcript_id)
                        if (tx && Number.isFinite(tx.start) && Number.isFinite(tx.end)) {
                            focusStart = tx.start
                            focusEnd = tx.end
                        }
                    }

                    const span = Math.max(1, focusEnd - focusStart)
                    const padding = Math.max(100, span * 0.5)
                    await jumpToRange(gene.chrom, focusStart - padding, focusEnd + padding, gene)
                    trackAchievement('browser.idSearch')
                    trackAchievement('browser.geneFocus')
                    return
                }
            }
        } catch (e) {
            console.error('Search resolve failed:', e)
        }

        // Fallback to currently cached genes if API resolve is unavailable.
        const query = rawQuery.toLowerCase()
        const match = genes.find((g) =>
            (g.name && g.name.toLowerCase().includes(query)) || g.id.toLowerCase().includes(query)
        )
        if (match) {
            const padding = Math.max(100, (match.end - match.start) * 0.5)
            await jumpToRange(match.chrom, match.start - padding, match.end + padding, match)
            trackAchievement('browser.idSearch')
            trackAchievement('browser.geneFocus')
        }
    }, [searchInput, regions, selectedChrom, genome, genes, onManualNavigate, onPositionChange, focusDrawerInsetOnFocus, isFlipped, emitTutorialSignal, focusLocation, frameFocusRange])

    const handleRegionChange = useCallback((chrom) => {
        setSelectedChrom(chrom)
        const region = regions.find(r => r.chrom === chrom)
        if (region) {
            setChromLength(region.end)
            setGenes([])
            // Clear tile cache on chrom switch
            tileCacheRef.current.clear()
            fetchingTilesRef.current.clear()
            // Set initial view — tile management effect will fetch genes
            const nextStart = region.start
            const nextEnd = Math.min(region.start + 500000, region.end)
            setViewStart(nextStart)
            setViewEnd(nextEnd)
            if (onPositionChange) {
                onPositionChange(chrom, nextStart, nextEnd)
            }
        }
        setSelectedGene(null)
        setExpandedGenes({})
        if (onManualNavigate) onManualNavigate()
    }, [regions, onManualNavigate, onPositionChange])

    const centerGeneVertically = useCallback((geneForCenter) => {
        if (!geneForCenter || !containerRef.current) return false

        const isForward = geneForCenter.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const rawGx1 = genomicToScreen(geneForCenter.start)
        const rawGx2 = genomicToScreen(geneForCenter.end)
        const geneWidth = Math.max(1, Math.abs(rawGx2 - rawGx1))
        const rowCount = getGeneRowCountForWidth(geneForCenter, geneWidth)

        const baseGeneY = trackY + trackPadding + ((geneForCenter._row || 0) * transcriptLayoutMetrics.rowPitch)
        const totalGeneHeight = getGeneTotalHeight(rowCount)
        const geneCenterY = baseGeneY + (totalGeneHeight / 2)

        const container = containerRef.current
        const scroller = findNearestScrollable(rootRef.current)
        const scrollerMetrics = getScrollerMetrics(scroller)
        const geneCenterClientY = container.getBoundingClientRect().top + geneCenterY
        const viewportCenterClientY = (scrollerMetrics.top + scrollerMetrics.bottom) / 2
        const targetScrollTop = clamp(
            scrollerMetrics.scrollTop + (geneCenterClientY - viewportCenterClientY),
            0,
            scrollerMetrics.maxScrollTop
        )
        scrollScrollerTo(scroller, scrollerMetrics, targetScrollTop)
        return true
    }, [layout, genomicToScreen, getGeneRowCountForWidth, getGeneTotalHeight, transcriptLayoutMetrics])

    useEffect(() => {
        const pendingGeneId = pendingVerticalCenterGeneIdRef.current
        if (!pendingGeneId) return

        const geneForCenter = genes.find((gene) => gene.id === pendingGeneId)
        if (!geneForCenter) return

        if (centerGeneVertically(geneForCenter)) {
            pendingVerticalCenterGeneIdRef.current = null
        }
    }, [genes, layout, centerGeneVertically])

    useEffect(() => {
        const pending = pendingTranscriptPillFocusRef.current
        if (!pending?.geneId) return

        const geneForFocus = genes.find((gene) => gene.id === pending.geneId)
        if (!geneForFocus) return

        if (pending.waitForTranscripts && !transcriptCache[pending.geneId]) {
            return
        }

        if (!pending.preserveHorizontalViewport) {
            const focusViewport = getGeneFocusViewport(geneForFocus, { limit: pending.limit })
            if (!focusViewport) {
                pendingTranscriptPillFocusRef.current = null
                return
            }

            const [targetStart, targetEnd] = clampView(focusViewport.start, focusViewport.end)
            if (!pending.animated) {
                pendingTranscriptPillFocusRef.current = {
                    ...pending,
                    animated: true,
                    waitForTranscripts: false,
                    targetStart,
                    targetEnd,
                }
                animateToView(targetStart, targetEnd, 700)
                return
            }

            const currentStart = viewStartRef.current
            const currentEnd = viewEndRef.current
            const isCloseToTarget = Math.abs(currentStart - targetStart) < 2 && Math.abs(currentEnd - targetEnd) < 2
            if (!isCloseToTarget) return
        } else if (!pending.animated) {
            // Expanding/collapsing transcript rows is a vertical layout operation.
            // Keep the user's genomic window untouched so the next wheel zoom does
            // not start from an unexpectedly re-centred or re-scaled viewport.
            pendingTranscriptPillFocusRef.current = {
                ...pending,
                animated: true,
                waitForTranscripts: false,
                targetStart: viewStartRef.current,
                targetEnd: viewEndRef.current,
            }
        }

        // The pinned-transcript path does its own vertical work: the drawer moves
        // the browser to meet the identifier it is level with. Parking the gene
        // at the top of the window as well would jump the view one way before
        // the alignment slid it back the other.
        if (pending.skipVerticalAlign) {
            pendingTranscriptPillFocusRef.current = null
            return
        }

        let attemptsRemaining = 6
        const tryVerticalAlign = () => {
            const didAlign = alignGeneToTop(geneForFocus, 18, {
                preferBottomVisible: pending.preferBottomVisible,
                bottomMarginPx: 16,
            })
            if (didAlign) {
                pendingTranscriptPillFocusRef.current = null
                return
            }
            attemptsRemaining -= 1
            if (attemptsRemaining <= 0) {
                pendingTranscriptPillFocusRef.current = null
                return
            }
            requestAnimationFrame(tryVerticalAlign)
        }
        requestAnimationFrame(tryVerticalAlign)
    }, [genes, transcriptCache, expandedGenes, getGeneFocusViewport, clampView, animateToView, alignGeneToTop, viewStart, viewEnd])

    // ---- Pinned transcript ---------------------------------------------------
    //
    // Clicking a transcript in the drawer pins it: the panel returns to the
    // framing the gene had when it took focus, and the view then slides the
    // drawer so the pinned row and its identifier meet. Hovering does none of
    // this — it must never move the viewport out from under the pointer.

    const pinnedTranscriptId = String(focusTranscriptView?.pinnedId || '').trim()

    // Reported in container-local pixels. Page scrolling moves the panel and the
    // drawer together, so a client-space reading taken here would be stale the
    // moment the user scrolled; the view adds the panel's live position instead.
    useEffect(() => {
        const report = onFocusRowGeometryChangeRef.current
        if (!report) return
        const geneForPin = pinnedTranscriptId && selectedGene
            ? genes.find((gene) => gene.id === selectedGene.id)
            : null
        if (!geneForPin) {
            report(null)
            return
        }

        const isForward = geneForPin.strand === '+'
        const trackY = isForward ? layout.FORWARD_Y : layout.REVERSE_Y
        const trackPadding = isForward ? layout.fwdPadding : layout.revPadding
        const baseGeneY = trackY + trackPadding + ((geneForPin._row || 0) * transcriptLayoutMetrics.rowPitch)

        const rows = getDisplayTranscriptRows(geneForPin)
        const rowIndex = rows.findIndex((row) => String(row.transcript?.id) === pinnedTranscriptId)

        report({
            transcriptId: pinnedTranscriptId,
            // A gene drawn as a block has no row of its own to meet, so the block
            // stands in for it until the panel is back at transcript zoom.
            offsetTop: baseGeneY + (rowIndex > 0 ? rowIndex * transcriptLayoutMetrics.rowPitch : 0),
            height: transcriptLayoutMetrics.rowPitch - transcriptLayoutMetrics.rowGap,
            resolved: rowIndex >= 0,
        })
    }, [pinnedTranscriptId, selectedGene, genes, layout, transcriptLayoutMetrics, getDisplayTranscriptRows])

    // Restore the focus framing on pin, but only when the view has actually
    // drifted from it. Re-framing unconditionally would re-run the whole focus
    // animation on every click, including the ones that change nothing.
    const lastPinFramingRef = useRef('')
    useEffect(() => {
        const geneId = focusViewGeneId
        if (!pinnedTranscriptId || !geneId) {
            lastPinFramingRef.current = ''
            return
        }
        const signature = `${geneId}::${pinnedTranscriptId}`
        if (lastPinFramingRef.current === signature) return
        lastPinFramingRef.current = signature

        const txs = transcriptCacheRef.current[geneId]
        const limit = getEffectiveTranscriptLimit(geneId, txs)
        const geneForPin = genes.find((gene) => gene.id === geneId)
        const focusViewport = geneForPin ? getGeneFocusViewport(geneForPin, { limit }) : null
        // Without a viewport to compare against there is no evidence the view has
        // drifted, and re-framing on a guess moves the browser for nothing.
        if (!focusViewport) return
        const tolerance = Math.max(1, Math.abs(focusViewport.end - focusViewport.start) * 0.01)
        const alreadyFramed = Math.abs(viewStartRef.current - focusViewport.start) <= tolerance
            && Math.abs(viewEndRef.current - focusViewport.end) <= tolerance
        if (alreadyFramed) return

        requestTranscriptPillFocus(geneId, {
            limit,
            waitForTranscripts: !txs,
            preferBottomVisible: false,
            skipVerticalAlign: true,
        })
    }, [pinnedTranscriptId, focusViewGeneId, genes, getEffectiveTranscriptLimit, getGeneFocusViewport, requestTranscriptPillFocus])

    const handleRecenterSelectedGene = useCallback(() => {
        if (!selectedGene) return
        const selectedCoords = getSelectedGeneCoordsForView(selectedGene, isAligned, alignData, genomicToOverlay)
        if (!selectedCoords) return

        const framed = frameFocusRange(selectedCoords.start, selectedCoords.end)
        animateToView(framed.start, framed.end, 1000)
        requestAnimationFrame(() => {
            centerGeneVertically(selectedGene)
        })
    }, [selectedGene, isAligned, alignData, genomicToOverlay, animateToView, centerGeneVertically, frameFocusRange])

    /* "Make what I am looking at the focus."
     *
     * The window itself becomes the location, then the view re-frames a little
     * wider than it — otherwise the focus boundary lines land exactly on the
     * edges of the view, where they cannot be seen, and the drawer that slides
     * out covers the region's right end. */
    const focusCurrentWindow = useCallback(() => {
        if (!selectedChrom) return
        const start = viewStartRef.current
        const end = viewEndRef.current
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return

        focusLocation({
            chrom: selectedChrom,
            start: Math.round(isAligned ? overlayToGenomic(start) : start),
            end: Math.round(isAligned ? overlayToGenomic(end) : end),
        })
        const span = end - start
        const flank = (span / BOX_SELECT_FILL_FRACTION - span) / 2
        const framed = frameFocusRange(start - flank, end + flank, { gainingFocus: true })
        animateToView(framed.start, framed.end, 300)
        if (onManualNavigate) onManualNavigate()
    }, [selectedChrom, isAligned, overlayToGenomic, focusLocation, frameFocusRange, animateToView, onManualNavigate])

    /* The location of focus re-frames horizontally only: there is no row to bring
     * into view, so unlike the gene target this leaves the vertical scroll alone. */
    const handleRecenterSelectedLocation = useCallback(() => {
        if (!focusLocationRange) return
        const coords = getFeatureCoordsForView(
            focusLocationRange.start,
            focusLocationRange.end,
            isAligned,
            alignData,
            genomicToOverlay
        )
        if (!coords) return

        const span = Math.max(1, coords.end - coords.start)
        const paddedSpan = span / FOCUS_RANGE_FILL_FRACTION
        const midpoint = (coords.start + coords.end) / 2
        const framed = frameFocusRange(midpoint - paddedSpan / 2, midpoint + paddedSpan / 2)
        animateToView(framed.start, framed.end, 1000)
    }, [focusLocationRange, isAligned, alignData, genomicToOverlay, frameFocusRange, animateToView])

    // Collapsing the drawer uncovers part of the track; opening it covers that
    // part again. Rescale the window by the change in visible width and recentre
    // whichever primary focus the panel holds, so a gene or location keeps the
    // same share of what can actually be seen. Secondary drawer layers are not
    // part of focusDrawerInset and therefore never move the genomic window.
    const lastFocusDrawerInsetRef = useRef(null)
    const lastLocationFocusCentreRef = useRef(null)
    useEffect(() => {
        const previous = lastFocusDrawerInsetRef.current
        lastFocusDrawerInsetRef.current = focusDrawerInset
        const locationCoords = focusLocationRange
            ? getFeatureCoordsForView(focusLocationRange.start, focusLocationRange.end, isAligned, alignData, genomicToOverlay)
            : null
        if (selectedGene) lastLocationFocusCentreRef.current = null
        else if (locationCoords) lastLocationFocusCentreRef.current = (locationCoords.start + locationCoords.end) / 2
        if (previous === null || previous === focusDrawerInset) return

        // A newly focused range was already framed in the action that created
        // it. Non-zero changes are the primary drawer opening/collapsing. A
        // disappearing location drawer is also balanced once around its last
        // centre, so dismissing it gives the recovered track width back.
        if (!previous) return
        const closingLocation = !focusDrawerInset && !selectedGene && !focusLocationRange
            && Number.isFinite(lastLocationFocusCentreRef.current)
        if (!focusDrawerInset && !closingLocation) return

        const selectedCoords = selectedGene
            ? getSelectedGeneCoordsForView(selectedGene, isAligned, alignData, genomicToOverlay)
            : locationCoords
                ? locationCoords
                : closingLocation
                    ? {start:lastLocationFocusCentreRef.current,end:lastLocationFocusCentreRef.current}
                    : null
        if (!selectedCoords) return

        const next = rebalanceRangeForInsetChange({
            start: viewStartRef.current,
            end: viewEndRef.current,
            trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
            fromInsetPx: previous,
            toInsetPx: focusDrawerInset,
            focusCentre: (selectedCoords.start + selectedCoords.end) / 2,
            flipped: isFlipped,
        })
        if (!next) return

        const [targetStart, targetEnd] = clampView(next.start, next.end)
        animateToView(targetStart, targetEnd, 320)
        if (closingLocation) lastLocationFocusCentreRef.current = null
    }, [focusDrawerInset, selectedGene, focusLocationRange, isAligned, alignData, genomicToOverlay, isFlipped, clampView, animateToView])

    // ============ Keyboard navigation ============
    //
    // Bound to the panel element rather than the window, so keys can only act on
    // the panel that actually has focus. A window-level binding (as in
    // AlignmentPanel) fires while the view is off-screen or a modal is open.
    //
    // The key map is deliberately the same in every control scheme: schemes
    // change pointer behaviour only. Making the keyboard scheme-dependent would
    // leave Default users with no keyboard access at all.
    const handleKeyDown = useCallback((e) => {
        if (e.defaultPrevented) return
        // The panel contains a search box and a track-label dialog whose keydowns
        // bubble up to this container.
        if (isTextEntryTarget(e.target)) return

        const intent = resolveKeyAction(readKeyEvent(e))
        if (intent.type === 'none') return
        if (intent.preventDefault) e.preventDefault()

        const currentStart = viewStartRef.current
        const currentEnd = viewEndRef.current
        const span = Math.max(1, currentEnd - currentStart)
        const trackWidth = Math.max(1, viewWidth - LHS_WIDTH)

        if (intent.type === 'pan') {
            // At base-level zoom a "fine" step should be exactly one base,
            // otherwise a percentage of the span.
            const stepPx = (intent.fineStep && span <= 1000)
                ? Math.sign(intent.dxFraction) * (trackWidth / span)
                : intent.dxFraction * trackWidth
            captureAdaptiveScrollAnchor()
            panByPx(stepPx)
            return
        }

        if (intent.type === 'zoom') {
            zoomAt(LHS_WIDTH + trackWidth / 2, intent.factor, null)
            return
        }

        if (intent.type === 'jump') {
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            const [nextStart, nextEnd] = intent.edge === 'start'
                ? clampView(1, 1 + span)
                : clampView(maxEnd - span, maxEnd)
            animateToView(nextStart, nextEnd, 400)
            return
        }

        if (intent.type === 'reset') {
            if (intent.scope === 'gene') {
                // "Reset to what is focused": whichever kind of focus the panel holds.
                if (selectedGene) handleRecenterSelectedGene()
                else handleRecenterSelectedLocation()
                return
            }
            if (onManualNavigate) onManualNavigate()
            const maxEnd = Math.max(2, chromLength || currentEnd)
            animateToView(1, maxEnd, 500)
            return
        }

        if (intent.type === 'dismiss') {
            if (selectedGene) {
                setSelectedGene(null)
                return
            }
            if (selectedLocation) {
                setSelectedLocation(null)
                return
            }
            containerRef.current?.blur()
        }
    }, [
        viewWidth, chromLength, selectedGene, selectedLocation, panByPx, zoomAt, animateToView, clampView,
        onManualNavigate, captureAdaptiveScrollAnchor, handleRecenterSelectedGene, handleRecenterSelectedLocation,
    ])

    // Published upward so GenomeBrowserView can route a wheel gesture that landed
    // between panels (page padding, or the divider) to the nearest one. Follows
    // the same descriptor-registration pattern as screenshotTargetDescriptor,
    // which avoids forwardRef/useImperativeHandle entirely.
    const browsingTargetDescriptor = useMemo(() => ({
        containsNode: (node) => Boolean(node && rootRef.current?.contains(node)),
        getRootRect: () => rootRef.current?.getBoundingClientRect() || null,
        applyWheelIntent: (intent, point) => {
            const container = containerRef.current
            if (!container || intent?.type !== 'zoom') return
            const rect = container.getBoundingClientRect()
            const trackWidth = Math.max(1, rect.width - LHS_WIDTH)
            // Anchoring on a cursor that is outside the panel horizontally would
            // silently zoom about the far edge of the tracks, so centre instead.
            const insideHorizontally = Number.isFinite(point?.clientX)
                && point.clientX >= rect.left && point.clientX <= rect.right
            const anchorX = (intent.anchor === 'cursor' && insideHorizontally)
                ? point.clientX - rect.left
                : LHS_WIDTH + trackWidth / 2
            const targetTrack = Number.isFinite(point?.clientY)
                ? getTrackAtY(point.clientY - rect.top + container.scrollTop)
                : null
            captureAdaptiveScrollAnchor()
            zoomAt(anchorX, intent.factor, targetTrack)
        },
    }), [zoomAt, getTrackAtY, captureAdaptiveScrollAnchor])

    useEffect(() => {
        const notify = onBrowsingTargetChangeRef.current
        if (typeof notify !== 'function') return undefined
        notify(browsingTargetDescriptor)
        return () => {
            if (typeof onBrowsingTargetChangeRef.current === 'function') {
                onBrowsingTargetChangeRef.current(null)
            }
        }
    }, [browsingTargetDescriptor])

    // ============ Region sorting ============
    // Sort: numeric chroms first (chr1, 1, chr2...), then named sex/special (X, Y, MT) by length desc then alpha,
    // then accession-style scaffolds by length desc.
    const sortedRegions = useMemo(() => {
        const withFeatures = regions.filter(r => r.gene_count > 0)
        const featureless = regions.filter(r => r.gene_count === 0)

        const chromNum = (name) => {
            const m = name.match(/^(?:chr)?0*(\d+)$/i)
            return m ? parseInt(m[1], 10) : null
        }
        const isSpecial = (name) => /^(?:chr)?(X|Y|MT|M|W|Z)$/i.test(name)
        const isAccession = (name) => /^[A-Z]{1,4}[_0-9]{3,}/i.test(name) && chromNum(name) === null && !isSpecial(name)
        // Use display_name (e.g. "1") when available for sort categorization so that
        // accession-named regions (NC_000001.11) sort with their numeric peers.
        const sortName = (r) => r.display_name || r.chrom

        const sortGroup = (arr) => {
            const numeric = arr.filter(r => chromNum(sortName(r)) !== null).sort((a, b) => chromNum(sortName(a)) - chromNum(sortName(b)))
            const special = arr.filter(r => isSpecial(sortName(r))).sort((a, b) => b.length - a.length || sortName(a).localeCompare(sortName(b)))
            const accessions = arr.filter(r => isAccession(sortName(r))).sort((a, b) => b.length - a.length)
            const other = arr.filter(r => !chromNum(sortName(r)) && !isSpecial(sortName(r)) && !isAccession(sortName(r))).sort((a, b) => b.length - a.length || sortName(a).localeCompare(sortName(b)))
            return [...numeric, ...special, ...other, ...accessions]
        }

        return { withFeatures: sortGroup(withFeatures), featureless: sortGroup(featureless) }
    }, [regions])

    // Map chrom identifiers (e.g. NC_000001.11) to human-readable display names (e.g. "1").
    const chromDisplayMap = useMemo(() => {
        const map = {}
        for (const r of regions) {
            if (r.display_name) map[r.chrom] = r.display_name
        }
        return map
    }, [regions])
    const chromLabel = (c) => chromDisplayMap[c] || c

    // Reset showFeatureless each time regions are loaded
    useEffect(() => { setShowFeatureless(false) }, [regions])

    // ============ Viewport control, published for the tutorial ============
    // The browser has no zoom button and no slider — panning is a drag or the arrow keys,
    // zooming is the wheel or +/- — so a tutorial demonstrating either has nothing to
    // click on the user's behalf. Rather than adding controls that exist only for the
    // tutorial to press, the panel publishes the moves it can make and the tutorial calls
    // them. Everything goes through animateToView, so a move the tutorial makes travels at
    // the same speed and stops at the same edges as one the user makes.
    const tutorialSequenceVisibleRef = useRef(false)
    tutorialSequenceVisibleRef.current = Boolean(
        showSequenceTrack
        && !effectiveHiddenStrands.sequence
        && sequence
        && seqRange
        && viewSpan <= 1000
    )

    useEffect(() => {
        const panelKey = String(screenshotTargetId || genome || '')
        if (!panelKey) return undefined
        const span = () => Math.max(1, viewEndRef.current - viewStartRef.current)
        const duration = (ms) => (Number(ms) > 0 ? Number(ms) : TUTORIAL_MOVE_MS)
        const bare = (name) => String(name || '').trim().toLowerCase().replace(/^chr/, '')

        return registerBrowserViewport(panelKey, {
            recipeId: tutorialRecipeId,
            frameFocusedRange: (start, end) => frameFocusRange(start, end, { gainingFocus: true }),
            setTracks: (tracks) => setHiddenStrands((prev) => ({ ...prev, ...Object.fromEntries(Object.entries(tracks).map(([key, visible]) => [key, !visible])) })),
            setInteraction: (mode) => { interactionModeRef.current = mode },
            resetScroll: () => {
                // The panel lives inside the view's scroller, not its own, so this walks
                // up to whatever is actually scrolling.
                let node = rootRef.current
                while (node && node !== document.body) {
                    if (node.scrollHeight > node.clientHeight + 1) { node.scrollTop = 0; return }
                    node = node.parentElement
                }
            },
            describe: () => ({
                chrom: selectedChrom,
                start: viewStartRef.current,
                end: viewEndRef.current,
                sequenceVisible: tutorialSequenceVisibleRef.current,
                bounds: browsableRange,
                tracks: Object.fromEntries(Object.entries(hiddenStrands).map(([key, hidden]) => [key, !hidden])),
                focus: selectedGene?.name || selectedGene?.id || '',
                // The location of focus, so an arrival can tell "already right" from
                // "needs setting" rather than re-focusing on every visit to a step.
                locationFocus: isLocationFocusVisible && focusLocationRange
                    ? { ...focusLocationRange }
                    : null,
                ready: Boolean(selectedChrom && regions.length),
            }),
            // The location of focus, set the way the gene of focus is: through the panel's
            // own handler rather than behind it, so the drawer, the focus bar, the boundary
            // lines and the gene that gives way to it all stay in step.
            //
            // Deliberately not "press the Focus this window button": that control focuses
            // whatever the window happens to be showing, so a step wanting a particular
            // region would have to travel there first and then be moved back — a journey
            // and a correction, which is exactly what docs/TUTORIALS.md says a tutorial
            // must not do. This leaves the view alone; the step's own `browserView`
            // arrival puts it where the card describes, in one move.
            setLocationFocus: (range) => {
                if (!range) {
                    if (!selectedLocation) return false
                    focusLocation(null)
                    return true
                }
                const wanted = getFocusLocationRange(range)
                if (!wanted) return false
                if (!isSameChromToken(wanted.chrom, selectedChrom)) return false
                const current = focusLocationRange
                if (current
                    && isSameChromToken(current.chrom, wanted.chrom)
                    && Math.round(current.start) === Math.round(wanted.start)
                    && Math.round(current.end) === Math.round(wanted.end)) return false
                focusLocation(wanted)
                return true
            },
            panByWindows: (fraction, ms) => {
                const shift = span() * (Number(fraction) || 0)
                if (!shift) return false
                animateToView(viewStartRef.current + shift, viewEndRef.current + shift, duration(ms))
                return true
            },
            zoomBy: (factor, ms) => {
                const value = Number(factor)
                if (!(value > 0)) return false
                const centre = viewStartRef.current + (span() / 2)
                const next = Math.max(2, span() * value)
                animateToView(centre - (next / 2), centre + (next / 2), duration(ms))
                return true
            },
            goToLocus: (text, ms) => {
                const parsed = String(text || '').match(/^\s*([^:\s]+)\s*:\s*([\d,\s]+)\s*-\s*([\d,\s]+)\s*$/)
                if (!parsed) return false
                const start = parseInt(parsed[2].replace(/[,\s]/g, ''), 10)
                const end = parseInt(parsed[3].replace(/[,\s]/g, ''), 10)
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
                // A locus on some other region is not a move, it is a navigation — leave
                // that to the search box, which knows how to switch region.
                const showing = chromDisplayMap[selectedChrom] || selectedChrom
                if (bare(parsed[1]) !== bare(showing) && bare(parsed[1]) !== bare(selectedChrom)) return false
                // Through the same framing every other "put this on screen" path uses, so
                // a locus a tutorial asks for lands in the part of the track the reader can
                // actually see. Without it a step that names a region around the focused
                // gene centres that gene behind the drawer — the drawer overlays the canvas
                // rather than narrowing it, so the window itself never shrank. A no-op
                // whenever no drawer is open, since the inset is then zero.
                const framed = frameFocusRange(start, end)
                animateToView(framed.start, framed.end, duration(ms))
                return true
            },
        })
    }, [animateToView, browsableRange, chromDisplayMap, frameFocusRange, genome, screenshotTargetId, selectedChrom, tutorialRecipeId, hiddenStrands, selectedGene, regions.length, focusLocation, focusLocationRange, isLocationFocusVisible, selectedLocation])

    // ============ Render ============

    // The foot of the last track drawn, which is where the gutter marker stops. Zero until
    // the tracks have been laid out, which is the signal not to render it yet.
    const gutterMarkerHeight = (() => {
        const foot = showSequenceTrack && layout.SEQUENCE_Y >= 0
            ? layout.SEQUENCE_Y + layout.seqBgHeight
            : layout.REVERSE_Y + layout.reverseBgHeight
        return foot > LHS_WIDTH ? Math.round(foot + 4) : 0
    })()

    const toolbarColumnWidths = {
        genome: 180,
        region: 220,
        search: 220,
        iconGroup: 226,
        coordinates: 230,
    }

    const toolbar = (
        <div
            ref={toolbarRef}
            data-browser-controls="true"
            // The assembly drawer lines its header band up with this row, so the
            // drawer reads as sliding out of the genome pill that opened it.
            data-browser-toolbar="true"
            data-focus-panel-key={screenshotTargetId || genome}
            // Control freak counts this genome's toolbar as well as the general control
            // bar; see achievements/browserControls.js.
            onClickCapture={(event) => {
                const key = browserControlKey(event.target)
                if (key) trackAchievement('browser.control', key)
            }}
            onKeyDownCapture={(event) => {
                if (event.key === 'Enter' && event.target?.dataset?.tourId === 'browser-location-search') {
                    trackAchievement('browser.control', 'browser-location-search-go')
                }
            }}
            className="flex items-center gap-0 px-3 py-2 border-b flex-none"
            style={{
                backgroundColor: colors.infoBg,
                borderColor: isLight ? '#dee2e6' : '#373a40',
            }}
        >
            {genomePillLabel && (
                <button
                    type="button"
                    data-browser-control="browser-genome-pill"
                    onClick={() => {
                        if (!onGenomePillClick) return
                        if (!genomePillExpanded) trackAchievement('browser.pillInfo')
                        onGenomePillClick()
                    }}
                    disabled={!onGenomePillClick}
                    className="inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium mr-2 shrink-0"
                    style={{
                        backgroundColor: panelPillColor,
                        color: '#ffffff',
                        borderColor: 'transparent',
                        opacity: onGenomePillClick ? 1 : 0.9,
                        cursor: onGenomePillClick ? 'pointer' : 'default',
                        width: `${toolbarColumnWidths.genome}px`,
                    }}
                    title={onGenomePillClick ? `${genomePillLabel} (click for assembly information)` : genomePillLabel}
                    aria-expanded={genomePillExpanded}
                >
                    <span className="truncate">{genomePillLabel}</span>
                    {/* Marks the pill as something to read, not just a label.
                        Only where there is something behind it to open. */}
                    {onGenomePillClick && (
                        <span className="ml-auto flex-none pl-1.5 opacity-90">
                            <InfoGlyph size={13} strokeWidth={2.2} />
                        </span>
                    )}
                </button>
            )}

            {/* Region selector */}
            <select
                data-tour-id="browser-region-select"
                value={selectedChrom}
                onChange={(e) => {
                    const v = e.target.value
                    if (v === '__show_featureless__') {
                        setShowFeatureless(true)
                        return
                    }
                    handleRegionChange(v)
                }}
                className="text-xs px-2 py-1 rounded border"
                style={{
                    backgroundColor: colors.bg,
                    color: colors.infoText,
                    borderColor: isLight ? '#ced4da' : '#495057',
                    width: `${toolbarColumnWidths.region}px`,
                    flex: `0 0 ${toolbarColumnWidths.region}px`,
                }}
            >
                {sortedRegions.withFeatures.map(r => (
                    <option key={r.chrom} value={r.chrom}>
                        {r.display_name || r.chrom} ({r.gene_count} genes, {formatBp(r.length)})
                    </option>
                ))}
                {sortedRegions.featureless.length > 0 && !showFeatureless && (
                    <option value="__show_featureless__" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                        + {sortedRegions.featureless.length} featureless region{sortedRegions.featureless.length !== 1 ? 's' : ''}
                    </option>
                )}
                {showFeatureless && sortedRegions.featureless.map(r => (
                    <option key={r.chrom} value={r.chrom}>
                        {r.display_name || r.chrom} (no genes, {formatBp(r.length)})
                    </option>
                ))}
            </select>

            {/* Search. The wrapper is anchored as well as the input: the box and its go
                button are one control to a reader, so a tutorial spotlighting the pair
                leaves the button inside the lit, clickable area rather than dimmed
                alongside the field it belongs to. */}
            <div
                data-tour-id="browser-location-search-field"
                className="flex items-center gap-0.5 ml-2 mr-0.5 shrink-0"
                style={{ width: `${toolbarColumnWidths.search}px` }}
            >
                <input
                    data-tour-id="browser-location-search"
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Gene name or chr:start-end"
                    className="text-xs px-2 py-1 rounded border flex-1 min-w-0"
                    style={{
                        backgroundColor: colors.bg,
                        color: colors.infoText,
                        borderColor: isLight ? '#ced4da' : '#495057',
                    }}
                />
                <button
                    data-tour-id="browser-location-search-go"
                    onClick={handleSearch}
                    className="p-1 rounded transition-opacity hover:opacity-80 flex items-center justify-center"
                    style={{ backgroundColor: controlAccentColor, color: '#ffffff', width: '28px', height: '28px' }}
                    title="Go to location"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                </button>
            </div>

            {/* View Controls Group */}
            <div
                className="flex items-center gap-1.5 ml-0 pl-0.5 border-l border-gray-300 dark:border-gray-700 shrink-0"
                style={{ width: `${toolbarColumnWidths.iconGroup}px` }}
            >

                {/* Focus this window — the location counterpart of clicking a gene */}
                <button
                    data-tour-id="browser-focus-window"
                    data-tutorial-engaged={isLocationFocusVisible ? 'true' : 'false'}
                    onClick={() => {
                        trackAchievement('browser.locationFocus')
                        focusCurrentWindow()
                    }}
                    disabled={!selectedChrom}
                    className="p-1.5 rounded transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: isLocationFocusVisible ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none',
                    }}
                    title={selectedGene
                        ? 'Focus the current window instead of the gene of focus'
                        : 'Make the current window the location of focus'}
                >
                    <svg width="19" height="19" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                        <path d={RESET_ICON_PATH_D} fill="currentColor" />
                    </svg>
                </button>

                {/* Expand / Collapse All — single toggle */}
                {(() => {
                    const isWindowExpanded = isViewportTranscriptExpandMode
                    const transcriptControlsDisabled = isTranscriptCompressionActive

                    return (
                        <button
                            data-tour-id="browser-expand-transcripts"
                            data-tutorial-engaged={isWindowExpanded ? 'true' : 'false'}
                            onClick={() => {
                                if (transcriptControlsDisabled) return
                                if (isWindowExpanded) {
                                    setIsViewportTranscriptExpandMode(false)
                                    setExpandedGenes({})
                                } else {
                                    setIsViewportTranscriptExpandMode(true)
                                }
                            }}
                            className="p-1.5 rounded transition-opacity hover:opacity-80 disabled:opacity-50 flex items-center justify-center"
                            disabled={transcriptControlsDisabled || (!isWindowExpanded && genes.length === 0)}
                            style={{
                                backgroundColor: transcriptControlsDisabled
                                    ? (isLight ? '#e5e7eb' : '#374151')
                                    : controlAccentColor,
                                color: transcriptControlsDisabled
                                    ? (isLight ? '#9ca3af' : '#6b7280')
                                    : '#ffffff',
                                width: '32px', height: '28px'
                            }}
                            title={transcriptControlsDisabled
                                ? 'Disable Compress to change transcript expansion'
                                : (isWindowExpanded
                                    ? 'Return to canonical transcripts'
                                    : 'Expand transcripts in the current window and surrounding buffer')}
                        >
                            {/* Make SVG use the full 24x24 canvas to expand the diagram's visual size */}
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                {isWindowExpanded ? (
                                    <>
                                        {/* Top transcript */}
                                        <line x1="2" y1="5" x2="22" y2="5" strokeWidth="1" />
                                        <rect x="2" y="3" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="10" y="3" width="6" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="3" width="3" height="4" fill="currentColor" stroke="none" />
                                        {/* Up arrow */}
                                        <path d="M12 21V10" strokeWidth="3" />
                                        <path d="M8 14l4-4 4 4" strokeWidth="3" fill="none" />
                                    </>
                                ) : (
                                    <>
                                        {/* Transcript 1 (top): 3 exons */}
                                        <line x1="2" y1="4" x2="22" y2="4" strokeWidth="1" />
                                        <rect x="2" y="2" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="10" y="2" width="6" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="2" width="3" height="4" fill="currentColor" stroke="none" />

                                        {/* Transcript 2 (middle): 2 exons skipping middle */}
                                        <line x1="2" y1="12" x2="22" y2="12" strokeWidth="1" />
                                        <rect x="2" y="10" width="5" height="4" fill="currentColor" stroke="none" />
                                        <rect x="19" y="10" width="3" height="4" fill="currentColor" stroke="none" />

                                        {/* Transcript 3 (bottom): 1 long exon (aligned left but not full width) */}
                                        {/* Fits the first two exons horizontally to show alternative transcript splicing */}
                                        <rect x="2" y="18" width="14" height="4" fill="currentColor" stroke="none" />
                                    </>
                                )}
                            </svg>
                        </button>
                    )
                })()}

                {/* Flip Track Orientation */}
                <button
                    data-browser-control="browser-flip"
                    onClick={() => setIsFlipped(!isFlipped)}
                    className={`p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80`}
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px'
                    }}
                    title={isFlipped ? "Restore 5' to 3' view" : "Flip to 3' to 5' view"}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 9a9 9 0 0 0-14.8-4.2L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M3 15a9 9 0 0 0 14.8 4.2l3.2-3.2" />
                        <path d="M21 21v-5h-5" />
                        {/* Strikethrough when flipped */}
                        {isFlipped && (
                            <line x1="2" y1="2" x2="22" y2="22" stroke="white" strokeWidth="3" />
                        )}
                    </svg>
                </button>

                {/* Flip Vertical Track Layout (Primary/Secondary preset style) */}
                <button
                    data-browser-control="browser-strand-layout"
                    onClick={() => setIsVerticalLayoutFlipped((prev) => !prev)}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: 'none',
                    }}
                    title={`Switch to ${isVerticalLayoutFlipped
                        ? (isPrimaryPanel ? 'primary' : 'secondary')
                        : (isPrimaryPanel ? 'secondary' : 'primary')
                        } layout style`}
                >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 20V5" />
                        <path d="M4.5 8.5L8 5l3.5 3.5" />
                        <path d="M16 4v15" />
                        <path d="M12.5 15.5L16 19l3.5-3.5" />
                    </svg>
                </button>

                {/* Box-Select Zoom */}
                <button
                    data-browser-control="browser-box-zoom"
                    onClick={() => {
                        setIsBoxSelectMode(prev => !prev)
                        setIsSelectingRect(false)
                        setSelectionRect(null)
                    }}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px',
                        boxShadow: isBoxSelectMode ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset` : 'none'
                    }}
                    title={isBoxSelectMode ? 'Selection mode active: drag to zoom' : 'Activate selection zoom mode'}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
                        <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
                    </svg>
                </button>

                {/* Add Custom Track — opens Track Picker (shows registered tracks) */}
                <button
                    data-tour-id="browser-add-track"
                    onClick={() => {
                        refreshAvailableTracks?.()
                        setSelectedTrackPickerIds([])
                        setIsTrackPickerOpen(true)
                    }}
                    className="p-1.5 rounded transition-opacity flex items-center justify-center hover:opacity-80"
                    style={{
                        backgroundColor: controlAccentColor,
                        color: '#ffffff',
                        width: '32px', height: '28px'
                    }}
                    title="Add Custom Track"
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h6" strokeWidth="2.1" />
                        <path d="M3 12h10" strokeWidth="2.1" />
                        <path d="M3 18h14" strokeWidth="2.1" />
                        <path d="M16 4v6" strokeWidth="2.1" />
                        <path d="M13 7h6" strokeWidth="2.1" />
                    </svg>
                </button>
            </div>


            {/* Coordinates display */}
            <button
                data-tour-id="browser-coordinates"
                type="button"
                onClick={() => setIsRulerCollapsed((prev) => !prev)}
                className="text-xs ml-auto tabular-nums rounded px-1.5 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/10 text-right truncate shrink-0"
                style={{
                    color: colors.rulerText,
                    width: `${toolbarColumnWidths.coordinates}px`,
                }}
                title={isRulerCollapsed ? 'Show coordinate ruler' : 'Hide coordinate ruler'}
                aria-pressed={isRulerCollapsed}
            >
                {chromLabel(selectedChrom)}:{formatCoord(Math.floor(viewStart))}-{formatCoord(Math.ceil(viewEnd))} ({formatBp(Math.ceil(viewEnd - viewStart))})
            </button>
        </div>
    )

    /* Shared by every focus bar, so a new kind of focus is a row of content rather
     * than another copy of the bar. Only one focus is ever live in a panel, so
     * they can all share `focusBarRef` and the layout compensation that measures it. */
    const renderFocusBar = (kind, children) => (
        <div
            ref={focusBarRef}
            // The focus drawer aligns its header to this bar and scrolls it into
            // view when the user switches between panels' focus genes.
            data-focus-bar="true"
            data-focus-kind={kind}
            // Written out rather than derived from `data-focus-kind`, so the bar the
            // location tutorial points at is a single attribute a target contract can
            // name — a compound selector is invisible to the binding test.
            data-location-focus-bar={kind === 'location' ? 'true' : undefined}
            data-browser-controls="true"
            data-focus-panel-key={screenshotTargetId || genome}
            className="flex items-center gap-4 px-3 py-1.5 flex-none text-xs"
            style={{
                backgroundColor: colors.selectedGene,
                borderTop: effectiveFocusBarPosition === 'bottom' ? `1px solid ${isLight ? '#b1c2ff' : '#1e293b'}` : 'none',
                borderBottom: effectiveFocusBarPosition === 'top' ? `1px solid ${isLight ? '#b1c2ff' : '#1e293b'}` : 'none',
                color: isLight ? '#1e293b' : '#ffffff',
            }}
        >
            {children}
        </div>
    )

    // The anchor is spelled out per kind rather than passed in, so every tour id the
    // focus bar can render is written literally in the component that renders it.
    const renderFocusTargetButton = (kind, onClick, title, disabled = false) => (
        <button
            data-tour-id={kind === 'location' ? 'browser-recenter-location' : 'browser-recenter'}
            onClick={() => {
                trackAchievement('browser.recenter')
                onClick()
            }}
            disabled={disabled}
            className="shrink-0 p-1.5 rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
            title={title}
        >
            <svg width="27" height="27" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path d={RESET_ICON_PATH_D} fill={controlAccentColor} />
            </svg>
        </button>
    )

    const selectedLocationInfoBar = isLocationFocusVisible && focusLocationRange && renderFocusBar('location', (
        <>
            {renderFocusTargetButton(
                'location',
                handleRecenterSelectedLocation,
                'Re-center view on location of focus'
            )}
            <span className="font-semibold">
                {formatRegionCoord(
                    chromLabel(focusLocationRange.chrom),
                    focusLocationRange.start,
                    focusLocationRange.end
                )}
            </span>
            <span className="opacity-70">Location</span>
            <span className="opacity-70">{formatBp(focusLocationRange.end - focusLocationRange.start)}</span>
            <button
                onClick={() => setSelectedLocation(null)}
                className="ml-auto opacity-50 hover:opacity-100"
                style={{ color: colors.infoText }}
                title="Clear the location of focus"
            >
                ✕
            </button>
        </>
    ))

    const selectedGeneInfoBar = selectedGene && !isSelectedHidden && renderFocusBar('gene', (
        <>
            {renderFocusTargetButton(
                'gene',
                handleRecenterSelectedGene,
                'Re-center view on selected gene',
                !hasGeneCoords(selectedGene)
            )}
            <span className="font-semibold">{selectedGene.name || selectedGene.id}</span>
            <span className="opacity-70">{selectedGene.id}</span>
            <span className="opacity-70">{selectedGene.biotype || 'protein_coding'}</span>
            <span className="opacity-70">{formatGeneStrand(selectedGene.strand)}</span>
            {hasGeneCoords(selectedGene) && (
                <span className="opacity-70">
                    {formatRegionCoord(selectedGene.chrom, selectedGene.start, selectedGene.end)}
                </span>
            )}
            <button
                onClick={() => setSelectedGene(null)}
                className="ml-auto opacity-50 hover:opacity-100"
                style={{ color: colors.infoText }}
            >
                ✕
            </button>
        </>
    ))

    const canConfirmCustomTrack = customTrackLabelInput.trim().length > 0

    const closeTrackPicker = useCallback(() => {
        setIsTrackPickerOpen(false)
        setSelectedTrackPickerIds([])
    }, [])

    const buildCustomTrackFromRegistered = useCallback((registeredTrack) => {
        const id = `ct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        const trackType = registeredTrack.type || 'bigwig'
        const nextTrack = {
            id,
            path: registeredTrack.path,
            label: registeredTrack.label,
            visible: true,
            renderMode: trackType === 'vcf'
                ? normalizeVcfDisplayMode(registeredTrack.display_mode || 'density_lollipop')
                : (registeredTrack.display_mode || DEFAULT_CUSTOM_TRACK_RENDER_MODE),
            type: trackType,
            registryTrackId: registeredTrack.id,
            spliceSettings: normalizeSpliceTrackSettings(registeredTrack.splice_settings),
            vcfSettings: normalizeVcfSettings(registeredTrack.vcf_settings),
        }
        if (trackType === 'bigwig') {
            const bigWigSettings = normalizeBigWigSettings(registeredTrack.bigwig_settings)
            nextTrack.bigwigSettings = bigWigSettings
            nextTrack.renderMode = normalizeBigWigDisplayMode(registeredTrack.display_mode, bigWigSettings.data_type)
        } else if (trackType === 'splice_junctions') {
            nextTrack.renderMode = 'arcs'
        } else if (trackType === 'vcf') {
            nextTrack.renderMode = normalizeVcfDisplayMode(registeredTrack.display_mode)
        }
        return nextTrack
    }, [])

    const seededTrackPickerRequestRef = useRef(null)

    /* A tutorial's `browserTracks` arrival, reconciled against this panel.
     *
     * Set, never toggled, because an arrival runs on every entry to a step — walking back
     * into a step that shows three tracks must show the same three, not add them again.
     *
     * Registry ids are minted when a track is registered, so a portable document cannot
     * name one. The arrival names the demo tracks by key and they are matched here by the
     * end of their path, which is stable and is what the tutorial actually laid down. */
    useEffect(() => {
        if (!tutorialTracksRequest) return
        const wanted = Array.isArray(tutorialTracksRequest.added) ? tutorialTracksRequest.added : []
        const registered = Array.isArray(availableTracks) ? availableTracks : []
        const matching = (key) => registered.find((track) =>
            String(track?.path || '').endsWith(TRACK_FILENAMES[key] || '\u0000')
        )
        // Which of them are switched on. Absent means all, so a step that is not about
        // visibility need not say — and the section that *is* about it can put two tracks
        // off and leave the third on, on every entry, however the step was reached.
        const shown = Array.isArray(tutorialTracksRequest.visible)
            ? tutorialTracksRequest.visible
            : wanted
        const shouldShow = (key) => shown.includes(key)

        setCustomTracks((prev) => {
            const keep = wanted.map((key) => {
                const registeredTrack = matching(key)
                if (!registeredTrack) return null
                const existing = prev.find((ct) =>
                    String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                    || String(ct.path || '') === String(registeredTrack.path || '')
                )
                const base = existing || buildCustomTrackFromRegistered(registeredTrack)
                return base.visible === shouldShow(key) ? base : { ...base, visible: shouldShow(key) }
            }).filter(Boolean)
            const same = keep.length === prev.length
                && keep.every((track, index) => track === prev[index])
            return same ? prev : keep
        })

    }, [tutorialTracksRequest, availableTracks, buildCustomTrackFromRegistered])

    // A registry refresh can change availableTracks while the reader is using the picker.
    // Apply the tutorial's open/closed state only when the request itself changes.
    useEffect(() => {
        if (!tutorialTracksRequest) return
        seededTrackPickerRequestRef.current = null
        setSelectedTrackPickerIds([])
        setIsTrackPickerOpen(String(tutorialTracksRequest.picker || 'closed') === 'open')
        onTutorialHideInactive?.(Boolean(tutorialTracksRequest.hideInactive))
    }, [tutorialTracksRequest, onTutorialHideInactive])

    // The registry may arrive after the request. Seed its chosen rows once all are
    // available, without reselecting rows after a later refresh or user click.
    useEffect(() => {
        if (!tutorialTracksRequest || seededTrackPickerRequestRef.current === tutorialTracksRequest) return
        const chosen = Array.isArray(tutorialTracksRequest.chosen) ? tutorialTracksRequest.chosen : []
        const matching = (key) => (Array.isArray(availableTracks) ? availableTracks : []).find((track) =>
            String(track?.path || '').endsWith(TRACK_FILENAMES[key] || '\u0000')
        )
        const selected = chosen.map(matching)
        if (selected.some((track) => !track)) return
        seededTrackPickerRequestRef.current = tutorialTracksRequest
        setSelectedTrackPickerIds(selected.map((track) => String(track.id || '')))
    }, [tutorialTracksRequest, availableTracks])

    const addSelectedRegisteredTracksToBrowser = useCallback(() => {
        if (!Array.isArray(selectedTrackPickerIds) || selectedTrackPickerIds.length === 0) return
        const selectedIdSet = new Set(selectedTrackPickerIds.map((id) => String(id)))
        const tracksToAdd = (Array.isArray(availableTracks) ? availableTracks : []).filter((track) =>
            selectedIdSet.has(String(track?.id || ''))
        )
        if (tracksToAdd.length === 0) {
            closeTrackPicker()
            return
        }
        setCustomTracks((prev) => {
            const next = [...prev]
            for (const registeredTrack of tracksToAdd) {
                const duplicate = next.some((ct) =>
                    String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                    || (
                        String(ct.path || '') === String(registeredTrack.path || '')
                        && String(ct.type || 'bigwig') === String(registeredTrack.type || 'bigwig')
                    )
                )
                if (duplicate) continue
                next.push(buildCustomTrackFromRegistered(registeredTrack))
            }
            return next
        })
        closeTrackPicker()
    }, [selectedTrackPickerIds, availableTracks, closeTrackPicker, buildCustomTrackFromRegistered])

    useEffect(() => {
        if (!isTrackPickerOpen) return
        const valid = new Set((Array.isArray(availableTracks) ? availableTracks : []).map((track) => String(track?.id || '')))
        setSelectedTrackPickerIds((prev) => {
            if (!Array.isArray(prev) || prev.length === 0) return prev
            const next = prev.filter((id) => valid.has(String(id)))
            if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev
            return next
        })
    }, [availableTracks, isTrackPickerOpen])

    // The panel is as loaded as it is going to get once the regions are in. What
    // it would otherwise still be waiting on is the first gene tile, and while
    // the index is being built there is no gene tile coming — leaving this up
    // would put a full-panel spinner over the very browser the build was made
    // non-blocking so the user could use.
    const showInitialLoadingOverlay = loadingRegions
        || (Boolean(selectedChrom) && !hasInitialViewportData && !geneTilesBlocked)

    // Screen-reader description of the active controls, generated from the same
    // source as the settings cheat sheet so the two cannot drift apart.
    const keyboardHintId = `${useId()}-browsing-controls`
    const keyboardHintText = useMemo(() => (
        describeBrowsingControls(browsingControls)
            .map((row) => `${row.gesture}: ${row.action}.`)
            .join(' ')
    ), [browsingControls])

    return (
        <div
            ref={rootRef}
            className="relative flex flex-col"
            style={{ flex: '1 0 auto', minHeight: 0 }}
        >

            {isCustomTrackLabelModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div
                        className={`w-full max-w-md rounded-xl shadow-2xl border ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                    >
                        <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Custom BigWig Label</h3>
                            <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Choose a label for the new track.</p>
                        </div>
                        <div className="p-4">
                            <input
                                type="text"
                                value={customTrackLabelInput}
                                onChange={(e) => setCustomTrackLabelInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && canConfirmCustomTrack) handleConfirmAddCustomTrack()
                                    if (e.key === 'Escape') {
                                        setIsCustomTrackLabelModalOpen(false)
                                        setPendingCustomTrackPath('')
                                        setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                                    }
                                }}
                                className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                                    ? 'bg-white border-gray-300 focus:ring-blue-500/40 focus:border-blue-500'
                                    : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'
                                    }`}
                                placeholder=""
                                autoFocus
                            />
                            <div className="mt-3">
                                <label className={`block text-xs mb-1 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                    Rendering mode
                                </label>
                                <select
                                    value={customTrackRenderModeInput}
                                    onChange={(e) => setCustomTrackRenderModeInput(e.target.value)}
                                    className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                                        ? 'bg-white border-gray-300 focus:ring-blue-500/40 focus:border-blue-500'
                                        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'
                                        }`}
                                >
                                    <option value="zoned_heatmap">Zoned Heat Map</option>
                                    <option value="signal_plot">Signal Plot</option>
                                </select>
                            </div>
                        </div>
                        <div className={`px-4 py-3 border-t flex justify-end gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/30'}`}>
                            <button
                                onClick={() => {
                                    setIsCustomTrackLabelModalOpen(false)
                                    setPendingCustomTrackPath('')
                                    setCustomTrackRenderModeInput(DEFAULT_CUSTOM_TRACK_RENDER_MODE)
                                }}
                                className={`px-3 py-1.5 rounded-md text-sm ${isLight ? 'text-gray-700 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'}`}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmAddCustomTrack}
                                disabled={!canConfirmCustomTrack}
                                className="px-3 py-1.5 rounded-md text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Add Track
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Track Picker Modal ─────────────────────────────────────────────────── */}
            {isTrackPickerOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
                    onClick={closeTrackPicker}
                >
                    <div
                        data-tour-id="browser-track-picker"
                        className={`w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col max-h-[80vh] ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className={`px-5 py-3.5 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <div>
                                <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Add Registered Track</h3>
                                <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {availableTracks.length === 0
                                        ? 'No tracks registered. Go to Track Manager to register tracks.'
                                        : `${availableTracks.length} track${availableTracks.length !== 1 ? 's' : ''} available`
                                    }
                                </p>
                            </div>
                            <button
                                onClick={closeTrackPicker}
                                className={`p-1.5 rounded-lg ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                            >✕</button>
                        </div>
                        {/* Track list */}
                        <div data-tour-id="browser-track-picker-list" className="flex-1 overflow-y-auto p-3 space-y-1.5">
                            {availableTracks.length === 0 ? (
                                <div className={`text-center py-10 text-sm ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                    <p>Open <strong>Track Manager</strong> → click <strong>Add Track</strong> → register your data files.</p>
                                </div>
                            ) : availableTracks.map((registeredTrack) => {
                                const addedTrack = customTracks.find((ct) =>
                                    String(ct.registryTrackId || '') === String(registeredTrack.id || '')
                                    || (
                                        String(ct.path || '') === String(registeredTrack.path || '')
                                        && String(ct.type || 'bigwig') === String(registeredTrack.type || 'bigwig')
                                    )
                                )
                                const alreadyAdded = Boolean(addedTrack)
                                const isAddedVisible = Boolean(addedTrack?.visible)
                                const pickerTrackId = String(registeredTrack.id || '')
                                const selectedForAdd = !alreadyAdded && selectedTrackPickerIds.includes(pickerTrackId)
                                const typeColor = {
                                    bigwig: '#3b82f6', vcf: '#f59e0b', bed: '#10b981', bigbed: '#059669',
                                    splice_junctions: '#8b5cf6', bam: '#ef4444', long_reads: '#ec4899',
                                }[registeredTrack.type] || '#64748b'
                                return (
                                    <div
                                        key={registeredTrack.id}
                                        data-tour-id={`browser-track-picker-row-${registeredTrack.id}`}
                                        data-tutorial-picker-track={registeredTrack.label || ''}
                                        // Ticked, or already on the panel. A tutorial step that asks the reader to
                                        // choose several rows reads this to leave alone the ones they have already
                                        // done — without it, pressing Next after ticking two of three unticked
                                        // those two on its way past.
                                        data-tutorial-engaged={(selectedForAdd || alreadyAdded) ? 'true' : 'false'}
                                        aria-pressed={selectedForAdd || alreadyAdded}
                                        onClick={() => {
                                            if (alreadyAdded) return
                                            setSelectedTrackPickerIds((prev) =>
                                                prev.includes(pickerTrackId)
                                                    ? prev.filter((id) => id !== pickerTrackId)
                                                    : [...prev, pickerTrackId]
                                            )
                                        }}
                                        onKeyDown={(e) => {
                                            if (alreadyAdded) return
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault()
                                                setSelectedTrackPickerIds((prev) =>
                                                    prev.includes(pickerTrackId)
                                                        ? prev.filter((id) => id !== pickerTrackId)
                                                        : [...prev, pickerTrackId]
                                                )
                                            }
                                        }}
                                        role="button"
                                        tabIndex={alreadyAdded ? -1 : 0}
                                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${alreadyAdded
                                            ? isLight ? 'border-gray-200 bg-gray-50/80' : 'border-gray-700 bg-gray-800/50'
                                            : selectedForAdd
                                                ? isLight ? 'border-blue-300 bg-blue-50' : 'border-blue-600 bg-blue-900/20'
                                                : isLight ? 'border-gray-200 hover:border-blue-300 hover:bg-blue-50' : 'border-gray-700 hover:border-blue-600 hover:bg-blue-900/20'
                                            }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span
                                                className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                                                style={{ backgroundColor: typeColor + '22', color: typeColor, border: `1px solid ${typeColor}44` }}
                                            >
                                                {registeredTrack.type}
                                            </span>
                                            <span className={`text-sm font-medium flex-1 min-w-0 truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                                {registeredTrack.label}
                                            </span>
                                            {registeredTrack.genome_key && (
                                                <span className={`text-[10px] shrink-0 px-1.5 py-0.5 rounded font-mono ${isLight ? 'bg-gray-100 text-gray-500' : 'bg-gray-700 text-gray-400'}`}>
                                                    {registeredTrack.genome_key.split('::').slice(-1)[0] || registeredTrack.genome_key}
                                                </span>
                                            )}
                                            {alreadyAdded && (
                                                <div className="ml-1 inline-flex items-center gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            const targetId = addedTrack?.id
                                                            if (!targetId) return
                                                            setCustomTracks((prev) =>
                                                                prev.map((track) =>
                                                                    track.id === targetId
                                                                        ? { ...track, visible: !track.visible }
                                                                        : track
                                                                )
                                                            )
                                                        }}
                                                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors ${isLight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                                                        style={{ color: sidebarToggleIconColor(isAddedVisible) }}
                                                        title={isAddedVisible ? 'Turn track off' : 'Turn track on'}
                                                    >
                                                        <PowerGlyph size={15} />
                                                        <span className="text-[10px] font-semibold">{isAddedVisible ? 'On' : 'Off'}</span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            const targetId = addedTrack?.id
                                                            if (!targetId) return
                                                            setCustomTracks((prev) => prev.filter((track) => track.id !== targetId))
                                                        }}
                                                        className={`inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[10px] font-semibold ${isLight ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-red-900/35 text-red-300 hover:bg-red-900/55'}`}
                                                        title="Remove from browser"
                                                    >
                                                        Remove
                                                    </button>
                                                </div>
                                            )}
                                            {!alreadyAdded && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setSelectedTrackPickerIds((prev) =>
                                                            prev.includes(pickerTrackId)
                                                                ? prev.filter((id) => id !== pickerTrackId)
                                                                : [...prev, pickerTrackId]
                                                        )
                                                    }}
                                                    className={`ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 shrink-0 transition-colors ${isLight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                                                    style={{ color: sidebarToggleIconColor(selectedForAdd) }}
                                                    title={selectedForAdd ? 'Selected for add' : 'Select for add'}
                                                    aria-pressed={selectedForAdd}
                                                >
                                                    <PowerGlyph size={15} />
                                                </button>
                                            )}
                                        </div>
                                        <p className={`text-[11px] font-mono mt-0.5 truncate ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                            {registeredTrack.path}
                                        </p>
                                    </div>
                                )
                            })}
                        </div>
                        {/* Footer action */}
                        <div className={`px-5 py-3 border-t flex justify-end items-center gap-2 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-800 bg-gray-900/50'}`}>
                            <button
                                data-tour-id="browser-track-picker-add"
                                onClick={addSelectedRegisteredTracksToBrowser}
                                disabled={selectedTrackPickerIds.length === 0}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${selectedTrackPickerIds.length === 0
                                    ? isLight ? 'bg-blue-200 text-blue-700/70 cursor-not-allowed' : 'bg-blue-900/40 text-blue-200/50 cursor-not-allowed'
                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                    }`}
                            >
                                Add{selectedTrackPickerIds.length > 0 ? ` (${selectedTrackPickerIds.length})` : ''}
                            </button>
                            <button
                                data-tour-id="browser-track-picker-close"
                                onClick={closeTrackPicker}
                                className={`px-3 py-1.5 rounded-lg text-xs ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                            >Close</button>
                        </div>
                    </div>
                </div>
            )}


            {effectiveToolbarPosition === 'top' && toolbar}

            {/* Selected Gene Info Bar (Top) */}
            {effectiveFocusBarPosition === 'top' && (selectedGeneInfoBar || selectedLocationInfoBar)}

            {/* Canvas container. It has no overflow of its own — note that
                `overflow-x-hidden` alone would silently promote overflow-y back to
                `auto` and re-create the inner scrollbar. */}
            <div
                ref={containerRef}
                // Marks the surface that owns its own axis-locked drag, so the
                // view-level drag-to-scroll fallback stands down here.
                data-browser-canvas-surface="true"
                data-focus-panel-key={screenshotTargetId || genome}
                className="flex-grow relative overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
                style={{
                    cursor: (isBoxSelectMode || isSelectingRect) ? 'crosshair' : (isDragging ? 'grabbing' : 'grab'),
                    backgroundColor: colors.bg
                }}
                // Focusable so keyboard navigation is scoped to the panel the
                // user is actually on, and reachable by Tab.
                tabIndex={0}
                role="group"
                aria-label={`${genomePillLabel || label || 'Genome'} browser${selectedChrom ? `, ${selectedChrom}` : ''}`}
                aria-describedby={keyboardHintId}
                onKeyDown={handleKeyDown}
                onMouseDown={handleMouseDown}
                onMouseMove={isDragging ? undefined : handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleContainerMouseLeave}
            >
                <p id={keyboardHintId} className="sr-only">{keyboardHintText}</p>

                <canvas
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    style={{ display: 'block' }}
                />

                {/* Markers over the track gutter, so a tutorial can point at GF, GR and
                    SL. They exist only to be spotlit: the gutter is painted on the canvas
                    and hit-tested by geometry (see drawToggle), so there is no element to
                    anchor on otherwise, and adding real buttons would mean two code paths
                    for the same toggle. `pointer-events-none` keeps every click going to
                    the canvas exactly as before — the tutorial's steps about these are
                    look-only, and turning tracks on and off is taught through the Tracks
                    button in the bar above, which is real DOM. */}
                {/* Only once the tracks have been laid out. Rendered before that it is a
                    sliver at the top of the panel, and anything measuring it — a tutorial
                    card placing itself beside it — lands in the wrong place and then jumps
                    when the real height arrives. */}
                {gutterMarkerHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gutter"
                        className="absolute pointer-events-none"
                        // Down to the foot of the last track rather than the foot of the
                        // canvas: the canvas keeps whatever empty space the panel has, and
                        // a spotlight that took in all of it framed mostly nothing.
                        style={{ left: 0, top: 0, width: LHS_WIDTH, height: gutterMarkerHeight }}
                    />
                )}
                {/* Written out one by one rather than mapped over a list, because the
                    tutorial's anchor test scans this source for literal `data-tour-id`
                    attributes — an id that arrives in a variable is invisible to it, and
                    a renamed anchor would then fail in front of a user instead of in the
                    suite. */}
                {layout.forwardBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gf"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.FORWARD_Y, layout.forwardBgHeight)}
                    />
                )}
                {layout.reverseBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gr"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.REVERSE_Y, layout.reverseBgHeight)}
                    />
                )}
                {/* The reverse track's band, full width. Nothing points *at* it; it is
                    what a step's card is placed against when the step spotlights the whole
                    track and the card would otherwise land on the genes being described. */}
                {layout.reverseBgHeight > 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-gr-band"
                        className="absolute pointer-events-none"
                        style={{
                            left: LHS_WIDTH,
                            top: layout.REVERSE_Y,
                            width: Math.max(1, viewWidth - LHS_WIDTH),
                            height: layout.reverseBgHeight,
                        }}
                    />
                )}
                {showSequenceTrack && layout.SEQUENCE_Y >= 0 && (
                    <div
                        aria-hidden="true"
                        data-tour-id="browser-track-sl"
                        className="absolute pointer-events-none"
                        style={gutterMarkerStyle(layout.SEQUENCE_Y, layout.seqBgHeight)}
                    />
                )}

                {/* The gene index note. Positioned against the panel rather than
                    against the genome, so it stays put through a pan or a zoom
                    instead of sliding away with the coordinates it would
                    otherwise be pinned to. The canvas underneath stays live. */}
                {geneIndexOverlayGeometry && (
                    <GeneIndexProgressOverlay
                        status={geneIndexStatus}
                        isLight={isLight}
                        left={LHS_WIDTH}
                        width={Math.max(1, viewWidth - LHS_WIDTH)}
                        top={geneIndexOverlayGeometry.top}
                        height={geneIndexOverlayGeometry.height}
                        onRetry={retryGeneIndex}
                    />
                )}

                {/* Invisible buttons over the canvas-drawn gutter switches, so a tutorial can
                    point at one and a reader can press it. The click goes to the same setter
                    the canvas hit-test uses, so there is still one code path for the control.

                    Gated on a tutorial running rather than on `tutorialRecipeId`: that id is
                    only set for a genome installed from an embedded dataset recipe, and a
                    tutorial running on one of the *bundled* genomes — which is how the Track
                    Manager tutorial reaches the chromosome-1 slice — had no id, so none of
                    these existed and the gutter was unanchored. */}
                {tutorialAnchorsActive && [
                    ['forward', layout.FORWARD_Y + layout.forwardBgHeight / 2, layout.forwardBgHeight > 0],
                    ['reverse', layout.REVERSE_Y + layout.reverseBgHeight / 2, layout.reverseBgHeight > 0],
                    ['sequence', layout.SEQUENCE_Y + layout.seqBgHeight / 2, showSequenceTrack && layout.SEQUENCE_Y >= 0],
                ].filter(([, , visible]) => visible).map(([strand, y]) => (
                    <button key={strand} data-tour-id={{ forward: 'browser-toggle-forward', reverse: 'browser-toggle-reverse', sequence: 'browser-toggle-sequence' }[strand]}
                        aria-label={`Toggle ${strand} track`} aria-pressed={!hiddenStrands[strand]}
                        data-tutorial-engaged={!hiddenStrands[strand] ? 'true' : 'false'}
                        onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => { event.stopPropagation(); setHiddenStrands((prev) => ({ ...prev, [strand]: !prev[strand] })) }}
                        className="absolute rounded-full"
                        style={{ left: LHS_WIDTH - 25, top: y - 12, width: 24, height: 24, background: 'transparent' }} />
                ))}
                {/* The same again for each custom track. Addressed by the track's label rather
                    than by its registry id, which is minted when the track is registered and
                    cannot be written into a portable document. */}
                {tutorialAnchorsActive && Object.entries(layout.customTrackLayouts || {}).map(([trackId, trackLayout]) => {
                    const track = customTracksById.get(trackId)
                    if (!track) return null
                    const y = getCustomTrackToggleY(trackLayout)
                    if (!Number.isFinite(y)) return null
                    return (
                        <button key={trackId}
                            data-tour-id={`browser-toggle-track-${trackId}`}
                            data-tutorial-track-switch={track.label || ''}
                            aria-label={`Toggle ${track.label || 'custom'} track`} aria-pressed={track.visible !== false}
                            data-tutorial-engaged={track.visible !== false ? 'true' : 'false'}
                            onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation()
                                setCustomTracks((prev) => prev.map((entry) => (
                                    entry.id === trackId ? { ...entry, visible: !entry.visible } : entry
                                )))
                            }}
                            className="absolute rounded-full"
                            style={{ left: LHS_WIDTH - 25, top: y - 12, width: 24, height: 24, background: 'transparent' }} />
                    )
                })}
                {sidebarTooltip && (
                    <div
                        className="pointer-events-none fixed z-30 px-2 py-1 text-[11px] rounded shadow-md"
                        style={{
                            left: sidebarTooltip.x + 12,
                            top: sidebarTooltip.y + 12,
                            backgroundColor: isLight ? 'rgba(15, 23, 42, 0.92)' : 'rgba(248, 250, 252, 0.92)',
                            color: isLight ? '#ffffff' : '#0f172a',
                            border: `1px solid ${isLight ? 'rgba(148, 163, 184, 0.35)' : 'rgba(15, 23, 42, 0.2)'}`,
                        }}
                    >
                        {sidebarTooltip.text}
                    </div>
                )}

                {customTrackHoverTooltip && (
                    <div
                        className="pointer-events-none fixed z-30 px-2.5 py-1.5 text-[11px] rounded-md shadow-lg"
                        style={{
                            left: customTrackHoverTooltip.x + 12,
                            top: customTrackHoverTooltip.y + 12,
                            backgroundColor: colors.infoBg,
                            color: colors.infoText,
                            border: `1px solid ${isLight ? '#d0d7e2' : '#334155'}`,
                            backdropFilter: 'blur(2px)',
                        }}
                    >
                        {customTrackHoverTooltip.text}
                    </div>
                )}

                {clickedGeneTranscript?.transcript && (
                    <TranscriptInfoPopup
                        popup={clickedGeneTranscript}
                        selectedChrom={selectedChrom}
                        onMouseEnter={() => {
                            transcriptPopupHoverRef.current = true
                            clearTranscriptPopupDismissTimer()
                        }}
                        onMouseLeave={() => {
                            transcriptPopupHoverRef.current = false
                            scheduleTranscriptPopupDismiss(70)
                        }}
                    />
                )}

                {/* Variant info popup (click on adp_detail variant) */}
                {clickedVcfVariant && (() => {
                    const { variant: v, chrom, arrowTargetX, arrowTargetY } = clickedVcfVariant
                    const popupW = 260
                    const arrowSize = 8
                    const gap = 4
                    // Box sits to the left of the feature; flip right only when near left edge
                    const spaceLeft = arrowTargetX - arrowSize - gap
                    const goLeft = spaceLeft >= popupW
                    const popupLeft = goLeft
                        ? arrowTargetX - popupW - arrowSize - gap
                        : arrowTargetX + arrowSize + gap
                    const typeLabel = v.type === 'snv' ? 'SNV' : v.type === 'ins' ? 'insertion' : v.type === 'del' ? 'deletion' : (v.label || 'variant')
                    const pos1 = Number(v.pos).toLocaleString()
                    const displayId = v.id && v.id !== '.' ? v.id : null
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupLeft,
                                top: arrowTargetY,
                                transform: 'translateY(-50%)',
                                width: popupW,
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '10px 14px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                overflowWrap: 'break-word',
                                wordBreak: 'break-all',
                            }}
                        >
                            {/* Arrow pointing right toward the feature (on right side when goLeft, left side when flipped) */}
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
                            <div>Variant <span style={{ fontWeight: 700 }}>{displayId || `${chrom}:${pos1}`}</span></div>
                            <div><span style={{ fontWeight: 700 }}>{typeLabel.toUpperCase()}</span>&nbsp;&nbsp;{chrom}:{pos1}</div>
                            <div>Alleles <span style={{ fontWeight: 700 }}>{v.ref} {v.alt}</span></div>
                        </div>
                    )
                })()}

                {/* Splice junction info popup (click on arc) */}
                {clickedSpliceJunction && (() => {
                    const { junction: j, popupX, popupY } = clickedSpliceJunction
                    const popupW = 300
                    const arrowSize = 8
                    const gap = 4
                    const popupTop = Math.max(8, popupY - arrowSize - gap)
                    const support = Number(j?.n_total ?? j?.reads ?? 0)
                    const canonicalLabel = j?.canonical === true ? 'Canonical' : 'Non-canonical'
                    const annotationLabel = j?.annotated === true ? 'Annotated' : 'Novel'
                    const strandRaw = String(j?.strand || '.')
                    const strandLabel = strandRaw === '+'
                        ? 'Forward'
                        : strandRaw === '-'
                            ? 'Reverse'
                            : 'Unknown'
                    const motifLabel = formatSpliceMotifForDisplay(j?.motif, strandRaw)
                    const span = Math.max(0, (Number(j?.end) || 0) - (Number(j?.start) || 0))
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupX,
                                top: popupTop,
                                transform: 'translate(-50%, -100%)',
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
                                bottom: -arrowSize,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                width: 0,
                                height: 0,
                                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                                borderLeft: `${arrowSize}px solid transparent`,
                                borderRight: `${arrowSize}px solid transparent`,
                            }} />
                            <div>Junction <span style={{ fontWeight: 700 }}>{chromLabel(selectedChrom)}:{formatCoord(j?.start)}-{formatCoord(j?.end)}</span></div>
                            <div>Support <span style={{ fontWeight: 700 }}>{support.toLocaleString()}</span></div>
                            <div>Class <span style={{ fontWeight: 700 }}>{canonicalLabel}</span></div>
                            <div>Status <span style={{ fontWeight: 700 }}>{annotationLabel}</span></div>
                            <div>Motif <span style={{ fontWeight: 700 }}>{motifLabel}</span></div>
                            <div>Strand <span style={{ fontWeight: 700 }}>{strandLabel}</span></div>
                            <div>Intron span <span style={{ fontWeight: 700 }}>{span.toLocaleString()} bp</span></div>
                        </div>
                    )
                })()}

                {/* BigBed feature info popup (click on detail feature) */}
                {clickedBigBedFeature && (() => {
                    const { feature: f, popupX, popupY } = clickedBigBedFeature
                    const popupW = 320
                    const arrowSize = 8
                    const gap = 4
                    const popupTop = Math.max(8, popupY - arrowSize - gap)
                    const start = Number(f?.start)
                    const end = Number(f?.end)
                    const strandRaw = String(f?.strand || '.')
                    const strandLabel = strandRaw === '+'
                        ? 'Forward'
                        : strandRaw === '-'
                            ? 'Reverse'
                            : 'Unknown'
                    const scoreNum = Number(f?.score)
                    const scoreLabel = Number.isFinite(scoreNum)
                        ? scoreNum.toLocaleString(undefined, { maximumFractionDigits: 2 })
                        : (String(f?.score || '').trim() || '—')
                    const extraFields = Array.isArray(f?.extra_fields)
                        ? f.extra_fields.map((v) => String(v || '').trim()).filter(Boolean)
                        : []
                    const featureName = String(f?.name || '').trim()
                    const spanLabel = Number.isFinite(start) && Number.isFinite(end) && end > start
                        ? `${formatCoord(start)}-${formatCoord(end)}`
                        : '—'
                    const exonBlocks = Array.isArray(f?._exon_blocks)
                        ? f._exon_blocks
                        : (Array.isArray(f?.exon_blocks) ? f.exon_blocks : [])
                    const cdsBlocks = Array.isArray(f?._cds_blocks)
                        ? f._cds_blocks
                        : (Array.isArray(f?.cds_blocks) ? f.cds_blocks : [])
                    const isTranscriptModel = (
                        (String(f?._render_kind || f?.render_kind || '').toLowerCase() === 'transcript')
                        && ((f?._structure_valid === true) || (f?.structure_valid === true) || exonBlocks.length > 0)
                    )
                    const cdsSpanStart = cdsBlocks.length > 0
                        ? Math.min(...cdsBlocks.map((block) => Number(block?.start)).filter((v) => Number.isFinite(v)))
                        : null
                    const cdsSpanEnd = cdsBlocks.length > 0
                        ? Math.max(...cdsBlocks.map((block) => Number(block?.end)).filter((v) => Number.isFinite(v)))
                        : null
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
                            style={{
                                left: popupX,
                                top: popupTop,
                                transform: 'translate(-50%, -100%)',
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
                                bottom: -arrowSize,
                                left: '50%',
                                transform: 'translateX(-50%)',
                                width: 0,
                                height: 0,
                                borderTop: `${arrowSize}px solid rgba(17,24,39,0.97)`,
                                borderLeft: `${arrowSize}px solid transparent`,
                                borderRight: `${arrowSize}px solid transparent`,
                            }} />
                            <div>Feature <span style={{ fontWeight: 700 }}>{featureName || `${chromLabel(selectedChrom)}:${spanLabel}`}</span></div>
                            <div>Region <span style={{ fontWeight: 700 }}>{chromLabel(selectedChrom)}:{spanLabel}</span></div>
                            <div>Score <span style={{ fontWeight: 700 }}>{scoreLabel}</span></div>
                            <div>Strand <span style={{ fontWeight: 700 }}>{strandLabel}</span></div>
                            <div>Model <span style={{ fontWeight: 700 }}>{isTranscriptModel ? 'Transcript-like' : 'Interval'}</span></div>
                            {isTranscriptModel && (
                                <>
                                    <div>Exons <span style={{ fontWeight: 700 }}>{exonBlocks.length}</span></div>
                                    <div>CDS <span style={{ fontWeight: 700 }}>
                                        {(Number.isFinite(cdsSpanStart) && Number.isFinite(cdsSpanEnd))
                                            ? `${formatCoord(cdsSpanStart)}-${formatCoord(cdsSpanEnd)} (${cdsBlocks.length} block${cdsBlocks.length === 1 ? '' : 's'})`
                                            : 'None'}
                                    </span></div>
                                </>
                            )}
                            {extraFields.length > 0 && (
                                <div>Extra <span style={{ fontWeight: 700 }}>{extraFields.join(' | ')}</span></div>
                            )}
                        </div>
                    )
                })()}

                {/* Sequence base info popup (click on sequence track base) */}
                {clickedSeqBase && (() => {
                    const { bp, base, popupX, popupY } = clickedSeqBase
                    const pos1 = bp.toLocaleString()
                    const baseColor = getBaseColor(base, colors)
                    const popupW = 'max-content'
                    return (
                        <div
                            className="fixed z-40 rounded-lg shadow-xl text-[12px]"
                            style={{
                                left: popupX,
                                top: popupY,
                                transform: 'translateX(-50%)',
                                backgroundColor: 'rgba(17, 24, 39, 0.97)',
                                color: '#f1f5f9',
                                padding: '5px 10px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                pointerEvents: 'none',
                                whiteSpace: 'nowrap',
                                width: popupW,
                            }}
                        >
                            {chromLabel(selectedChrom)}:{pos1}&nbsp;&nbsp;<span style={{ fontWeight: 700, color: baseColor }}>{base.toUpperCase()}</span>
                        </div>
                    )
                })()}

                {/* Beta-style transcript expansion controls */}
                {transcriptFooterOverlay.controls.map(control => {
                    const controlBaseColor = control.isDimmed
                        ? (isLight ? '#94a3b8' : '#64748b')
                        : panelPillColor
                    const controlTextColor = control.isDimmed
                        ? (isLight ? '#1f2937' : '#e5e7eb')
                        : colors.pillText
                    return (
                        <Fragment key={control.id}>
                        {control.isExpandedControl && control.geneLabel && (
                            <span
                                aria-hidden="true"
                                className="absolute font-sans whitespace-nowrap pointer-events-none"
                                style={{
                                    left: control.x,
                                    top: control.geneLabelY - EXPANDED_FOOTER_LABEL_TOP_OFFSET,
                                    minHeight: 11,
                                    padding: '0 2px',
                                    borderRadius: 2,
                                    backgroundColor: control.trackBackground || colors.bg,
                                    color: colors.geneLabelText,
                                    fontSize: '11px',
                                    lineHeight: '11px',
                                    zIndex: 12,
                                }}
                            >
                                {control.geneLabel}
                            </span>
                        )}
                        {control.hasPrimary && (
                        <button
                            // DOM over the canvas, so a tutorial can point at it without
                            // the marker-div trick the track gutter needs. `engaged` is
                            // what lets an arrival set the gene's transcripts rather than
                            // toggle them: the pill shows a collapse action exactly when
                            // the gene is already expanded.
                            data-tour-id={`browser-gene-transcripts-${control.id}`}
                            data-tutorial-engaged={control.action === 'collapse' ? 'true' : 'false'}
                            onClick={(e) => {
                                e.stopPropagation()
                                const expand = control.action !== 'collapse'
                                // The focused gene's expand state belongs to the
                                // drawer, so this pill drives that instead of the
                                // panel-local map — one state, two controls.
                                if (control.isFocused) {
                                    onFocusTranscriptViewChangeRef.current?.({ expanded: expand })
                                } else {
                                    setExpandedGenes(prev => ({
                                        ...prev,
                                        [control.id]: expand ? control.totalTranscripts : 1,
                                    }))
                                }
                                if (expand) {
                                    requestTranscriptPillFocus(control.id, {
                                        limit: control.totalTranscripts,
                                        waitForTranscripts: !transcriptCache[control.id],
                                        // Park the first transcript at the top of the
                                        // window: with a long set, chasing the bottom
                                        // scrolls the gene's start out of sight.
                                        preferBottomVisible: false,
                                        // Match focused-gene navigation: centre the gene and
                                        // size the genomic window around its displayed bounds.
                                        preserveHorizontalViewport: false,
                                    })
                                    fetchTranscripts(control.id)
                                } else {
                                    requestTranscriptPillFocus(control.id, {
                                        limit: 1,
                                        preserveHorizontalViewport: true,
                                    })
                                }
                            }}
                            title={control.title}
                            aria-label={control.title}
                            className="absolute p-0 m-0 border-0 font-semibold transition-opacity hover:opacity-85"
                            style={{
                                left: control.controlX,
                                top: control.y,
                                width: control.width,
                                minWidth: control.width,
                                height: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                minHeight: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                borderRadius: 1,
                                backgroundColor: controlBaseColor,
                                color: controlTextColor,
                                fontSize: '10px',
                                lineHeight: '1',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                zIndex: 10,
                                opacity: control.isDimmed ? 0.8 : 1,
                            }}
                        >
                            {control.label}
                        </button>
                        )}

                        {/* Hidden transcripts survive collapsing and unfocusing, so
                            the way back has to live on the gene itself. */}
                        {control.hiddenCount > 0 && (
                            <button
                                // The way back, and the only thing on screen saying a
                                // transcript is missing at all — so a tutorial has to be
                                // able to point at it.
                                data-tour-id={`browser-gene-hidden-transcripts-${control.id}`}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onGeneTranscriptViewChangeRef.current?.(control.id, { hidden: [], ghostId: null })
                                }}
                                title={`Show ${control.hiddenCount} hidden transcript${control.hiddenCount === 1 ? '' : 's'}`}
                                aria-label={`Show ${control.hiddenCount} hidden transcript${control.hiddenCount === 1 ? '' : 's'}`}
                                className="absolute p-0 m-0 border-0 font-semibold transition-opacity hover:opacity-85"
                                style={{
                                    left: control.controlX + (control.hasPrimary ? control.width + CONTROL_GAP_PX : 0),
                                    top: control.y,
                                    width: control.restoreWidth,
                                    minWidth: control.restoreWidth,
                                    height: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                    minHeight: TRANSCRIPT_FOOTER_CONTROL_HEIGHT,
                                    borderRadius: 1,
                                    backgroundColor: 'transparent',
                                    border: `1px solid ${controlBaseColor}`,
                                    color: controlBaseColor,
                                    fontSize: '10px',
                                    lineHeight: '1',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: 'pointer',
                                    zIndex: 10,
                                    opacity: control.isDimmed ? 0.8 : 1,
                                }}
                            >
                                {control.restoreLabel}
                            </button>
                        )}
                        </Fragment>
                    )
                })}

                {/* One bubble per gene the user has written about. Above the
                    footer pills in the stack, because it sits at the head of the
                    gene where nothing else competes for the space. */}
                {geneNoteOverlay.bubbles.map((bubble) => (
                    <button
                        key={`note-${bubble.id}`}
                        data-tour-id={`browser-gene-note-${bubble.id}`}
                        type="button"
                        onClick={(e) => {
                            // Without this the canvas click handler runs too and
                            // toggles the very gene this is trying to open.
                            e.stopPropagation()
                            setSelectedGene(bubble.gene)
                            onOpenGeneNotesRef.current?.(String(bubble.gene.id))
                        }}
                        title={`${bubble.count} note${bubble.count === 1 ? '' : 's'} — open notes`}
                        aria-label={`Open ${bubble.count} note${bubble.count === 1 ? '' : 's'} on ${bubble.gene.name || bubble.gene.id}`}
                        className="absolute p-0 m-0 border-0 bg-transparent transition-opacity hover:opacity-85"
                        style={{
                            left: bubble.x,
                            top: bubble.y,
                            width: NOTE_BUBBLE_SIZE,
                            height: NOTE_BUBBLE_SIZE,
                            color: bubble.isDimmed ? (isLight ? '#94a3b8' : '#64748b') : panelPillColor,
                            cursor: 'pointer',
                            zIndex: 11,
                            opacity: bubble.isDimmed ? 0.8 : 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        {/* Filled, and its rules knocked out in the track's own
                            background, so the mark reads as writing on a bubble
                            rather than a solid blob at this size. */}
                        <NoteGlyph size={NOTE_BUBBLE_SIZE} filled knockout={colors.bg} />
                    </button>
                ))}

                {/* Loading indicator */}
                {loadingGenes && (
                    <div
                        className="absolute top-2 right-2 text-xs px-2 py-1 rounded"
                        style={{
                            backgroundColor: panelPillColor + '40',
                            color: panelPillColor,
                        }}
                    >
                        Loading...
                    </div>
                )}
            </div>

            {/* Selected Gene Info Bar (Bottom) */}
            {effectiveFocusBarPosition === 'bottom' && (selectedGeneInfoBar || selectedLocationInfoBar)}

            {/* Toolbar bottom */}
            {effectiveToolbarPosition === 'bottom' && (
                <div style={{ borderTop: `1px solid ${isLight ? '#dee2e6' : '#373a40'}` }}>
                    {toolbar}
                </div>
            )}

            {showInitialLoadingOverlay && (
                <div
                    className="absolute inset-0 z-40 flex items-center justify-center"
                    style={{
                        backgroundColor: isLight ? 'rgba(248, 250, 252, 0.82)' : 'rgba(15, 23, 42, 0.78)',
                        backdropFilter: 'blur(2px)',
                    }}
                >
                    <div
                        className={`rounded-xl border px-5 py-4 shadow-lg ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-900/95 border-gray-700 text-gray-100'}`}
                        style={{ minWidth: 280 }}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className={`h-7 w-7 animate-spin rounded-full border-4 border-t-transparent ${isLight ? 'border-sky-500' : 'border-sky-400'}`}
                                aria-hidden="true"
                            />
                            <div>
                                <div className="text-sm font-semibold">Loading Genome Browser</div>
                                <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Preparing regions, controls, and annotation tracks...
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

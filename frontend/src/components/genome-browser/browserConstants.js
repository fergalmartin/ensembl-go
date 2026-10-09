// Layout constants, level-of-detail tables, colours and small style helpers of the
// Genome Browser canvas. Pure values: importable from Node tests.
import { NUCLEOTIDE_COLORS } from '../../utils/nucleotideStyle.js'
import { monoFont, sansFont } from '../../utils/typography.js'
import { RULER_FONT_SIZE } from '../genomeBrowserRuler.js'

export const EMPTY_LIST = Object.freeze([])

export const TRACK_HEIGHT = 40

// How often the panel asks how the gene index behind it is getting on.
// Fast enough that the meter reads as live, slow enough that a build
// running for minutes is not polled thousands of times.
export const GENE_INDEX_POLL_INTERVAL_MS = 1200

export const TRACK_GAP = 8

export const EXON_HEIGHT = 12

export const INTRON_HEIGHT = 2

export const LABEL_FONT = sansFont(11)

export const COORD_FONT = monoFont(RULER_FONT_SIZE)

export const PILL_FONT = sansFont(10)

export const LHS_WIDTH = 48

// How long a move the tutorial makes takes. Long enough to read as travelling rather
// than jumping, and in the same range as the browser's own Home/End (400ms) and
// whole-chromosome reset (500ms). The tutorial scales it by the chosen autoplay speed.
export const TUTORIAL_MOVE_MS = 700

/** A box over one track's switch in the gutter, for a tutorial to spotlight.
 *
 *  The gutter is painted on the canvas and hit-tested by geometry, so there is no element
 *  to anchor on; these markers are `pointer-events-none` and exist only to be measured. */
export function gutterMarkerStyle(trackY, trackHeight) {
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
export const EXPANDED_FOOTER_LABEL_TOP_OFFSET = 6

export const EXPANDED_FOOTER_INLINE_GAP = 6

// Sidebar power toggles are drawn as a bare glyph, like the chevron and close
// controls on the focus drawer: the genome's own colour when the track is on,
// muted grey when it is off. A filled disc read as far louder than the thing it
// was toggling. The hit radius stays generous so the smaller glyph is no harder
// to click than the disc was.
export const SIDEBAR_TOGGLE_ICON_SIZE = 16

export const SIDEBAR_TOGGLE_HIT_RADIUS = 12

export const SIDEBAR_TOGGLE_LABEL_GAP = 6

export const CUSTOM_TRACK_HEIGHT_STANDARD = 54

export const pickerRowClass = (willShow, isLight) => `w-full text-left px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${willShow
    ? isLight ? 'border-blue-300 bg-blue-50' : 'border-blue-600/80 bg-blue-900/25'
    : isLight ? 'border-gray-200 hover:border-blue-200 hover:bg-gray-50' : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/40'}`

// The track picker's selection holds registry track ids and, for groups, 'group:<id>'.
export const TRACK_PICKER_GROUP_PREFIX = 'group:'

// A joined track group's row opens with a band naming the group.
export const JOINED_GROUP_HEADER_HEIGHT = 16

export const joinedGroupHeaderText = (rowLayout) => {
    const count = rowLayout?.memberIds?.length || 0
    return `${rowLayout?.label || 'Track group'} · ${count} track${count === 1 ? '' : 's'}`
}

export const CUSTOM_TRACK_HEIGHT_ZONED = 81

export const CUSTOM_TRACK_HEIGHT_ENSEMBL_VCF = 100

export const CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF = 108

export const CUSTOM_TRACK_HEIGHT_ADAPTIVE_VCF_COMPACT = 64

export const COMPRESSED_TRANSCRIPT_ROW_PITCH = 8

export const COMPRESSED_TRANSCRIPT_ROW_GAP = 1

export const COMPRESSED_TRANSCRIPT_EXON_HEIGHT = 6

export const COMPRESSED_TRANSCRIPT_TRACK_PADDING = 12

export const COMPRESSED_TRANSCRIPT_MID_OFFSET = 4

export const COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT = 24

export const FLATTENED_TRANSCRIPT_ROW_PITCH = 18

export const FLATTENED_TRANSCRIPT_ROW_GAP = 2

export const FLATTENED_TRANSCRIPT_TRACK_PADDING = 2

export const FLATTENED_TRANSCRIPT_MID_OFFSET = 8

export const FLATTENED_TRANSCRIPT_MIN_TRACK_HEIGHT = 36

export const FLATTENED_COMPRESSED_TRANSCRIPT_TRACK_PADDING = 1

export const FLATTENED_COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT = 36

// 5-level LOD pyramid for custom tracks
// binsPerTile × bpPerBin = tile size in bp
// Buffer = 2× viewport each side = 5× viewport total covered
export const TRACK_LOD_LEVELS = [
    { id: 'L0', minBpPerPx: 1000, bpPerBin: 10000, binsPerTile: 500 }, // 5Mb tiles — whole-chrom overview
    { id: 'L1', minBpPerPx: 100, bpPerBin: 1000, binsPerTile: 512 }, // 512kb tiles — regional
    { id: 'L2', minBpPerPx: 10, bpPerBin: 100, binsPerTile: 512 }, // 51.2kb tiles — gene level
    { id: 'L3', minBpPerPx: 2, bpPerBin: 10, binsPerTile: 512 }, // 5.12kb tiles — exon level
    { id: 'L4', minBpPerPx: 0, bpPerBin: 1, binsPerTile: 1024 }, // 1kb tiles — base level
]

// Keep backward-compat alias for any legacy path still referencing BIGWIG_LOD_LEVELS
export const BIGWIG_LOD_LEVELS = TRACK_LOD_LEVELS

export const VCF_LOD_LEVELS = [
    { id: 'L0', minBpPerPx: 1200, bpPerBin: 25000, binsPerTile: 400, mode: 'summary' },
    { id: 'L1', minBpPerPx: 240, bpPerBin: 2500, binsPerTile: 512, mode: 'summary' },
    { id: 'L2', minBpPerPx: 48, bpPerBin: 500, binsPerTile: 512, mode: 'summary' },
    { id: 'L3', minBpPerPx: 8, bpPerBin: 60, binsPerTile: 512, mode: 'summary' },
    { id: 'L4', minBpPerPx: 0, bpPerBin: 3, binsPerTile: 1024, mode: 'detail' },
]

export const VCF_SETTINGS_DEFAULTS = {
    genic_color: '#00b692',
    intergenic_color: '#96d0c9',
}

export const SPLICE_FINE_BP_PER_PX = 140

export const SPLICE_TILE_SPAN_FINE = 120_000

export const SPLICE_TILE_SPAN_COARSE = 500_000

export const SPLICE_TRANSCRIPT_BP_PER_PX = 40

export const TRANSCRIPT_DETAIL_VIEWSPAN_BP = 500_000

// A gene carrying notes gets a speech bubble at its head. Smaller than the
// transcript-count pill because it says one thing rather than reading as a
// control, and it has to sit in the 16px of track padding above row zero.
export const NOTE_BUBBLE_SIZE = 14

// Much looser than the footer pill's 60px: a bubble is a fixed mark, not a
// label that has to fit inside the gene. Below this the gene is a tick and the
// bubble would be describing something the reader cannot see.
export const NOTE_BUBBLE_MIN_GENE_WIDTH = 24

export const NOTE_BUBBLE_GAP = 2

export const SPLICE_BLOCK_TRACK_HEIGHT = 56

export const SPLICE_BLOCK_MERGE_GAP_PX = 2

export const SPLICE_BLOCK_LEVELS = [
    { id: 'L0', minBpPerPx: 1600, tileSpanBp: 2_000_000, blockBp: 40_000 },
    { id: 'L1', minBpPerPx: 800, tileSpanBp: 1_000_000, blockBp: 20_000 },
    { id: 'L2', minBpPerPx: 320, tileSpanBp: 500_000, blockBp: 10_000 },
    { id: 'L3', minBpPerPx: SPLICE_FINE_BP_PER_PX, tileSpanBp: 250_000, blockBp: 5_000 },
]

export const BIGBED_DETAIL_ENTER_BP_PER_PX = 18

export const BIGBED_DETAIL_EXIT_BP_PER_PX = 26

export const BIGBED_FEATURE_TILE_SPAN = 120_000

export const BIGBED_BLOCK_MERGE_GAP_PX = 2

export const BIGBED_DETAIL_EXON_HEIGHT = EXON_HEIGHT

export const BIGBED_DETAIL_LANE_PITCH = EXON_HEIGHT + 4

// Gene models name each transcript under it, as the gene track does.
export const BIGBED_DETAIL_LABEL_ROW = 11

export const BIGBED_DETAIL_LABEL_FONT_PX = 9

export const bigBedLanePitch = (labelled) => BIGBED_DETAIL_LANE_PITCH + (labelled ? BIGBED_DETAIL_LABEL_ROW : 0)

// A GFF/GTF read as gene models rather than one interval per line.
export const isGeneModelTrack = (track) => track?.type === 'gff' && track?.renderMode === 'transcripts'

export const BIGBED_DETAIL_LANE_TOP_PAD = 4

export const BIGBED_DETAIL_LANE_BOTTOM_PAD = 4

export const BIGBED_DETAIL_TRACK_BASE_HEIGHT = 34

export const BIGBED_DETAIL_TRACK_MAX_HEIGHT = 240

export const BIGBED_DETAIL_MAX_FEATURES_PER_TILE = 3000

export const BIGBED_DETAIL_DENSE_FEATURE_THRESHOLD = 2500

// Blocks are ~2px at each level's finest zoom, so separate features stay separate on
// screen; at 25-130px they used to merge a run of peaks into one slab. The ids changed
// with the sizes so tiles cached at the old sizes are not reused.
export const BIGBED_BLOCK_LEVELS = [
    // A whole chromosome at B0 alone is ~70 tiles; this keeps it to a handful.
    { id: 'B00', minBpPerPx: 12_000, tileSpanBp: 32_000_000, blockBp: 24_000 },
    { id: 'B0', minBpPerPx: 1500, tileSpanBp: 4_000_000, blockBp: 3_000 },
    { id: 'B1', minBpPerPx: 320, tileSpanBp: 800_000, blockBp: 640 },
    { id: 'B2', minBpPerPx: 60, tileSpanBp: 200_000, blockBp: 120 },
    // The backend's smallest block is 50bp.
    { id: 'B3', minBpPerPx: BIGBED_DETAIL_ENTER_BP_PER_PX, tileSpanBp: 80_000, blockBp: 50 },
]

// Density view for BED/BigBed: feature counts per bin, drawn as a histogram at every
// zoom. Each level's bins are ~3px at its finest zoom and a tile holds ~320 of them, so
// a screenful is one to five tiles whatever the zoom.
export const BED_DENSITY_LEVELS = [
    { id: 'D0', minBpPerPx: 60_000, tileSpanBp: 64_000_000, blockBp: 200_000 },
    { id: 'D1', minBpPerPx: 12_000, tileSpanBp: 16_000_000, blockBp: 40_000 },
    { id: 'D2', minBpPerPx: 2_500, tileSpanBp: 3_200_000, blockBp: 8_000 },
    { id: 'D3', minBpPerPx: 500, tileSpanBp: 640_000, blockBp: 1_600 },
    { id: 'D4', minBpPerPx: 100, tileSpanBp: 128_000, blockBp: 320 },
    { id: 'D5', minBpPerPx: 0, tileSpanBp: 32_000, blockBp: 64 },
]

export const BED_DEFAULT_COLOR = '#10b981'

export const GFF_DEFAULT_COLOR = '#0891b2'

// Interval tracks share one pipeline: BigBed through pyBigWig, plain BED and GFF/GTF
// through the backend's in-memory index, all served as BigBed-shaped tiles.
export const INTERVAL_TRACK_TYPES = new Set(['bigbed', 'bed', 'gff'])

export const isIntervalTrackType = (type) => INTERVAL_TRACK_TYPES.has(type)

export const SPLICE_HEIGHT_BASE = 52

export const SPLICE_HEIGHT_STEP = 12

export const SPLICE_HEIGHT_MIN = 56

export const SPLICE_HEIGHT_MAX = 180

export const GENE_LAYOUT_BUFFER_MIN = 100_000

export const GENE_LAYOUT_BUFFER_MAX = 500_000

export const GENE_LAYOUT_BUCKET_MIN_STEP = 50_000

export const GENE_SUBTRACK_ENABLE_BP = 1_450_000

export const GENE_SUBTRACK_DISABLE_BP = 1_650_000

export const GENE_CHROM_CACHE_ENTER_SPAN = 2_000_000

export const GENE_LAYOUT_COVERAGE_SHRINK_THRESHOLD = 0.85

export const MAX_GENE_TILE_CACHE_TILES = 640

export const MAX_TRANSCRIPT_CACHE_GENES = 180

export const MAX_TRANSCRIPT_PREFETCH_GENES = 96

export const MAX_BOTTOM_ALIGN_EXTRA_TOP_GAP = 12

export const SPLICE_HEAT_STOPS_LIGHT = [
    [51, 102, 204],   // transcript blue (cold)
    [139, 92, 246],   // purple (mid)
    [239, 68, 68],    // red (hot)
]

export const SPLICE_HEAT_STOPS_DARK = [
    [91, 141, 239],   // transcript blue (cold)
    [167, 139, 250],  // purple (mid)
    [248, 113, 113],  // red (hot)
]

export const DEFAULT_SPLICE_TRACK_SETTINGS = {
    min_support: 1,
    canonical_mode: 'all',
    annotated_mode: 'all',
    show_arrows: true,
    max_junctions: 5000,
    weak_max_support: 2,
    low_max_support: 4,
    medium_max_support: 9,
}

export const BIGWIG_DATA_TYPE_DEFAULTS = {
    rna_seq: {
        display_mode: 'zoned_heatmap',
        plot_color: '#3b82f6',
        zoned_colors: ['#f7cd61', '#f4a940', '#ea7a2d', '#cc2f1f'],
        zone_scale: 'fixed',
    },
    atac_seq: {
        display_mode: 'signal_plot',
        plot_color: '#b52aa1',
        zoned_colors: ['#86efac', '#4ade80', '#22c55e', '#15803d'],
        zone_scale: 'file',
    },
    chip_seq: {
        display_mode: 'signal_plot',
        plot_color: '#8b5cf6',
        zoned_colors: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#6d28d9'],
        zone_scale: 'file',
    },
    custom: {
        display_mode: 'signal_plot',
        plot_color: '#14b8a6',
        zoned_colors: ['#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8'],
        zone_scale: 'file',
    },
}

export const VCF_EFFECT_COLORS = {
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

export const DEFAULT_CUSTOM_TRACK_RENDER_MODE = 'zoned_heatmap'

export const CUSTOM_TRACK_TOOLTIP_DWELL_MS = 1000

export const CUSTOM_TRACK_TOOLTIP_MOVE_TOL_PX = 4

export const ZONED_ZONE_SOLID_COLORS = {
    light: ['#f7cd61', '#f4a940', '#ea7a2d', '#cc2f1f'],
    dark: ['#f5c04c', '#ef9a30', '#e36823', '#d03a2a'],
}

// Ensembl-inspired color palette
export const COLORS = {
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

export const MIRRORED_TEXT_ALIGN = { left: 'right', right: 'left', start: 'end', end: 'start' }

// The built-in tracks a flipped panel shows reverse complemented, and so marks "RC"
// on the line under their label, in the label's own size. Custom tracks are marked
// too: their values are unchanged, but they are drawn mirrored like everything else,
// and an unmarked track in a flipped panel reads as though it were the right way round.
export const REVERSE_COMPLEMENTED_TRACK_IDS = new Set(['forward', 'reverse', 'sequence'])

export const SIDEBAR_RC_LINE_GAP = 13

// The label moves up by this, and RC sits the rest of the gap below the centre, so
// the pair is centred on the toggle — a short track (SL) then has room above and below.
// Rounded down: the labels' ink sits half a pixel above their centre line already.
export const SIDEBAR_RC_HALF_GAP = Math.floor(SIDEBAR_RC_LINE_GAP / 2)

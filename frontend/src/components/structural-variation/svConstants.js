// Tuning and layout constants of the structural-variation view. Pure values.

// ── Layout constants ──────────────────────────────────────────────────────────
// Keep the same band + gene-track geometry as before so the genome bands
// look identical to the rest of the app.
export const PLOT_PAD_X    = 2

export const MIN_VIEW_SPAN = 50

export const MAX_VIEW_SPAN = 50_000_000

export const BUFFER_PAD_MIN    = 120_000

export const BUFFER_PAD_RATIO  = 1.5

export const BUFFER_MARGIN_RATIO = 0.16

export const WHEEL_COMMIT_DEBOUNCE_MS = 180

/**
 * Feel parameters for every pan/zoom surface in this view — the alignment
 * panel, the workspace, the gene bands, and the <ens-sv-alignments> web
 * component, which used to have its own (4x faster) zoom rate.
 */
export const SV_BROWSING_TUNING = Object.freeze({
  zoomSensitivity: 0.0012,
  pinchSensitivity: 0.0016,
  panAmplification: 1.6,
  zoomAtExtentHandoff: false,
})

export const SV_EXTERNAL_VIEWPORT_EVENT_GUARD_MS = 400

export const ALIGNMENT_PANEL_HEIGHT = 168

export const ALIGNMENT_PANEL_COMPACT_HEIGHT = 132

export const SV_DATA_TRACK_FETCH_DEBOUNCE_MS = 50

export const SV_BIGBED_FEATURE_TILE_SPAN = 120_000

export const SV_BIGBED_DETAIL_PREFETCH_RATIO = 1.25

export const SV_BIGBED_DETAIL_PREFETCH_MIN_TILES = 4

export const SV_BIGBED_DETAIL_FETCH_BATCH_SIZE = 24

export const SV_BIGBED_DETAIL_FETCH_PER_TRACK = 12

export const SV_BIGBED_DETAIL_MAX_FEATURES_PER_TILE = 3000

export const SV_RIBBON_INTERVAL_MAX_VIEW_SPAN = 1_500_000

export const SV_RIBBON_INTERVAL_MAX_FEATURES = 4000

export const SV_RIBBON_INTERVAL_MAX_MARKS = 900

export const SV_RIBBON_MAX_CACHE_TILES = 800

export const SV_RIBBON_MAX_CACHE_FEATURES = 120_000

export const SV_SIGNAL_TRACK_HEIGHT = 38

export const SV_SIGNAL_TRACK_GAP = 2

export const SV_SIGNAL_CONTROL_WIDTH = 50

export const SV_SIGNAL_TOGGLE_RADIUS = 11

export const SV_SIGNAL_TARGET_FETCH_BATCH_SIZE = 10

export const SV_SIGNAL_FALLBACK_FETCH_BATCH_SIZE = 6

export const SV_SIGNAL_OVERVIEW_FETCH_BATCH_SIZE = 4

export const SV_AUX_TRACK_RENDER_HALO_WINDOWS = 2

export const SV_AUX_TRACK_RENDER_HALO_MAX_BP = 1_000_000

export const SV_SIGNAL_RENDER_MAX_BINS = 8000

export const SV_AUX_TRACK_CACHE_VERSION = 'sv-aux-20260630-1'

export const SV_TRANSIENT_RETRY_LIMIT = 6

export const SV_TRANSIENT_RETRY_BASE_MS = 250

export const SV_SIGNAL_LOD_LEVELS = [
  { id: 'L0', minBpPerPx: 1000, bpPerBin: 10000, binsPerTile: 500 },
  { id: 'L1', minBpPerPx: 100, bpPerBin: 1000, binsPerTile: 512 },
  { id: 'L2', minBpPerPx: 10, bpPerBin: 100, binsPerTile: 512 },
  { id: 'L3', minBpPerPx: 2, bpPerBin: 10, binsPerTile: 512 },
  { id: 'L4', minBpPerPx: 0, bpPerBin: 1, binsPerTile: 1024 },
]

export const DEFAULT_SV_LOADING_MODE = 'eager'

export const SV_LOADING_MODE_STORAGE_KEY = 'svLoadingMode'

export const SV_TRIO_DEFAULT_REF_WINDOW = {
  chrom: '11',
  start: 49_490_090,
  end: 49_945_992,
}

export const SV_GENOME_GROUP_LABELS = {
  selected: 'Selected genomes',
  add: 'Available locally',
  missing: 'No local data',
}

export const SV_FILE_BROWSER_EXTENSIONS = {
  chain_path: ['.bigChain.bb', '.bb'],
  reference_bigwig_path: ['.bw', '.bigwig'],
  target_bigwig_path: ['.bw', '.bigwig'],
  reference_bigbed_path: ['.bb', '.bigbed'],
  target_bigbed_path: ['.bb', '.bigbed'],
  config_path: ['.json', '.cfg'],
}

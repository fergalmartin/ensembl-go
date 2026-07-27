import initWasm, { WasmRenderer } from '../../rust/sv_renderer/pkg/ensembl_sv_renderer.js'
import {
  BoundedLruCache,
  SV_RUST_CACHE_LIMIT_BYTES,
  SV_RUST_PROTOCOL_VERSION,
  estimateJsonBytes,
  isCurrentSvEpoch,
} from '../utils/svRustRendererProtocol'
import {
  alignmentRequestWindow,
  alignedInitialTargetCandidate,
  shouldIncludeTranscriptExons,
  shouldLoadCanonicalTranscripts,
  transcriptRequestWindow,
} from '../utils/svRustSceneStrategy'

const PROTOCOL_VERSION = SV_RUST_PROTOCOL_VERSION
const CACHE_LIMIT_BYTES = SV_RUST_CACHE_LIMIT_BYTES
const PREFETCH_RATIO = 1.25
const MIN_VIEW_SPAN = 50
const MAX_VIEW_SPAN = 1_000_000_000

let renderer = null
let config = null
let epoch = 0
let disposed = false
let activeControllers = new Set()
let scene = null
let renderWidth = 1200
let renderDpr = 1
let snapshotTimer = null
let commitTimer = null
let retryTimer = null
let retryAttempt = 0
let sceneBytes = 0
const responseCache = new BoundedLruCache(CACHE_LIMIT_BYTES)
const pendingRequests = new Map()

function post(type, payload = {}) {
  if (disposed) return
  self.postMessage({ protocolVersion: PROTOCOL_VERSION, type, ...payload })
}

function parseJson(value, fallback = null) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return fallback
  }
}

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeWindow(window, slot, fallback = {}) {
  if (!window?.chrom) return null
  const chromLength = Math.max(0, finite(window.chrom_length ?? fallback.chrom_length))
  const maxSpan = chromLength > 1
    ? Math.max(MIN_VIEW_SPAN, Math.min(MAX_VIEW_SPAN, chromLength - 1))
    : MAX_VIEW_SPAN
  let start = Math.max(1, finite(window.start, 1))
  let span = clamp(Math.max(1, finite(window.end, start + 1) - start), MIN_VIEW_SPAN, maxSpan)
  let end = start + span
  if (chromLength > 1 && end > chromLength) {
    end = chromLength
    start = Math.max(1, end - span)
  }
  span = Math.max(1, end - start)
  return {
    slot,
    chrom: String(window.chrom),
    start: Math.round(start),
    end: Math.round(start + span),
    chrom_length: chromLength,
    label: String(window.label || fallback.label || slot),
    color: String(window.color || fallback.color || '#49b8ff'),
  }
}

function buildInitialReferenceWindow() {
  const restored = config?.initialWindows?.find?.((item) => item?.slot === 'reference')
  if (restored?.chrom) return normalizeWindow(restored, 'reference', restored)
  const region = config?.anchorRegion || {}
  const chrom = String(region.chrom || region.label || region.id || '').trim()
  const length = Math.max(0, finite(region.indexed_length || region.length || region.chrom_length))
  const explicitStart = finite(region.start, NaN)
  const explicitEnd = finite(region.end, NaN)
  if (Number.isFinite(explicitStart) && Number.isFinite(explicitEnd) && explicitEnd > explicitStart) {
    return normalizeWindow({ chrom, start: explicitStart, end: explicitEnd, chrom_length: length }, 'reference', {
      label: config.labels.reference,
      color: config.colors.reference,
    })
  }
  const span = length > 0 ? Math.min(1_000_000, length) : 1_000_000
  const center = length > span ? Math.max(span / 2 + 1, Math.min(length - span / 2, length / 3)) : span / 2 + 1
  return normalizeWindow({
    chrom,
    start: Math.max(1, Math.round(center - span / 2)),
    end: Math.max(2, Math.round(center + span / 2)),
    chrom_length: length,
  }, 'reference', { label: config.labels.reference, color: config.colors.reference })
}

function authHeaders(extra = {}) {
  const headers = new Headers(extra)
  if (config?.apiToken) headers.set(config.tokenHeader || 'X-Ensembl-Local-Token', config.apiToken)
  return headers
}

function apiUrl(path, params = null) {
  const base = String(config?.apiBase || 'http://127.0.0.1:8000').replace(/\/$/, '')
  const url = new URL(path, `${base}/`)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function fetchJson(path, {
  params = null,
  method = 'GET',
  body = null,
  cache = true,
  priority = 'auto',
} = {}) {
  const url = apiUrl(path, params)
  const cacheKey = body ? `${method}|${url}|${JSON.stringify(body)}` : `${method}|${url}`
  if (cache) {
    const cached = responseCache.get(cacheKey)
    if (cached !== null) return Promise.resolve(cached)
    const pending = pendingRequests.get(cacheKey)
    if (pending) return pending
  }
  let request
  request = (async () => {
    const controller = new AbortController()
    activeControllers.add(controller)
    try {
      const response = await fetch(url, {
        method,
        headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        priority,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.detail || `${path} failed (${response.status})`)
      if (cache) responseCache.set(cacheKey, payload)
      return payload
    } finally {
      activeControllers.delete(controller)
    }
  })().finally(() => {
    if (pendingRequests.get(cacheKey) === request) pendingRequests.delete(cacheKey)
  })
  if (cache) pendingRequests.set(cacheKey, request)
  return request
}

function expandedWindow(window, ratio = PREFETCH_RATIO) {
  const span = Math.max(1, window.end - window.start)
  const pad = Math.max(120_000, span * ratio)
  const tileSpan = 2 ** Math.ceil(Math.log2(Math.max(120_000, span)))
  const rawStart = Math.max(1, Math.floor(window.start - pad))
  const rawEnd = Math.ceil(window.end + pad)
  return {
    ...window,
    start: Math.max(1, Math.floor(rawStart / tileSpan) * tileSpan),
    end: Math.ceil(rawEnd / tileSpan) * tileSpan,
  }
}

function visibleHaloWindow(window, ratio = 0.15) {
  const span = Math.max(1, window.end - window.start)
  const pad = Math.max(20_000, span * ratio)
  return {
    ...window,
    start: Math.max(1, Math.floor(window.start - pad)),
    end: Math.ceil(window.end + pad),
  }
}

function viewportParam(window) {
  return `${window.chrom}:${Math.round(window.start)}-${Math.round(window.end)}`
}

function deriveTargetWindow(data, referenceWindow, slot) {
  const restored = config?.initialWindows?.find?.((item) => item?.slot === slot)
  if (restored?.chrom) {
    return normalizeWindow(restored, slot, {
      label: config.labels[slot],
      color: config.colors[slot],
    })
  }
  const blocks = Array.isArray(data?.segments) && data.segments.length ? data.segments : (data?.blocks || [])
  let min = Infinity
  let max = -Infinity
  for (const block of blocks) {
    const refStart = finite(block.ref_start)
    const refEnd = finite(block.ref_end)
    if (refEnd < referenceWindow.start || refStart > referenceWindow.end) continue
    min = Math.min(min, finite(block.tgt_start), finite(block.tgt_end))
    max = Math.max(max, finite(block.tgt_start), finite(block.tgt_end))
  }
  const span = Math.max(1, referenceWindow.end - referenceWindow.start)
  const center = Number.isFinite(min) && Number.isFinite(max) && max > min
    ? (min + max) / 2
    : (finite(data?.tgt_start) + finite(data?.tgt_end)) / 2
  return normalizeWindow({
    chrom: data?.tgt_chrom || referenceWindow.chrom,
    start: center - span / 2,
    end: center + span / 2,
    chrom_length: finite(data?.tgt_chrom_length),
  }, slot, { label: config.labels[slot], color: config.colors[slot] })
}

function normalizeAlignment(raw, panel) {
  const refStart = finite(raw?.reference?.start ?? raw?.ref_start)
  const refLength = finite(raw?.reference?.length, finite(raw?.ref_end) - refStart)
  const tgtStart = finite(raw?.alt?.start ?? raw?.tgt_start)
  const tgtLength = finite(raw?.alt?.length, finite(raw?.tgt_end) - tgtStart)
  return {
    panel,
    id: String(raw?.id || raw?.chain_id || `${panel}:${refStart}:${tgtStart}`),
    ref_start: refStart,
    ref_end: finite(raw?.ref_end, refStart + Math.max(1, refLength)),
    tgt_start: tgtStart,
    tgt_end: finite(raw?.tgt_end, tgtStart + Math.max(1, tgtLength)),
    strand: String(raw?.alt?.strand || raw?.strand || '+'),
    kind: String(raw?.type || raw?.kind || ''),
  }
}

function deriveGapVariants(alignments, panel) {
  const sorted = [...alignments].sort((left, right) => left.ref_start - right.ref_start)
  const variants = []
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const previous = sorted[index]
    const current = sorted[index + 1]
    const previousReverse = previous.strand === '-' || previous.strand === 'reverse'
    const currentReverse = current.strand === '-' || current.strand === 'reverse'
    if (previousReverse !== currentReverse) continue
    const refGap = Math.max(0, current.ref_start - previous.ref_end)
    const altGapStart = previousReverse ? current.tgt_end : previous.tgt_end
    const altGapEnd = previousReverse ? previous.tgt_start : current.tgt_start
    const altGap = Math.max(0, altGapEnd - altGapStart)
    let kind = ''
    if (refGap === 1 && altGap === 1) kind = 'snv'
    else if (altGap - refGap >= 1) kind = 'insertion'
    else if (altGap - refGap <= -1) kind = 'deletion'
    if (!kind) continue
    variants.push({
      panel,
      name: `derived-${kind}-${Math.round(previous.ref_end)}-${index}`,
      kind,
      chrom: '',
      start: previous.ref_end,
      end: Math.max(previous.ref_end + 1, current.ref_start),
      target_start: Math.min(altGapStart, altGapEnd),
      target_end: Math.max(altGapStart, altGapEnd),
      ref_length: refGap,
      alt_length: altGap,
      metadata: { derived: true },
    })
  }
  return variants
}

function normalizeVariant(raw, panel, referenceChrom) {
  const kind = String(raw?.type || raw?.kind || 'variant')
  const start = finite(raw?.location?.start ?? raw?.start)
  const end = finite(raw?.location?.end ?? raw?.end, start) + (raw?.location ? 1 : 0)
  return {
    panel,
    name: String(raw?.name || `${kind}-${start}`),
    kind,
    chrom: String(raw?.location?.region_name || referenceChrom || ''),
    start,
    end: Math.max(start + 1, end),
    target_start: finite(raw?._renderSpanStart ?? raw?.target_start),
    target_end: finite(raw?._renderSpanEnd ?? raw?.target_end),
    ref_length: finite(raw?.ref_length),
    alt_length: finite(raw?.alt_length),
    metadata: raw,
  }
}

function normalizeTranscripts(entries, slot, includeExons = true) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const gene = entry?.gene || entry || {}
    const transcript = entry?.transcript || {}
    return {
      slot,
      id: String(transcript.id || gene.id || ''),
      label: String(gene.name || gene.id || transcript.id || ''),
      start: finite(transcript.start, finite(gene.start)),
      end: finite(transcript.end, finite(gene.end)),
      strand: String(transcript.strand || gene.strand || '+'),
      biotype: String(transcript.biotype || gene.biotype || ''),
      exons: includeExons
        ? (transcript.exons || []).map((exon) => ({ start: finite(exon.start), end: finite(exon.end) }))
        : [],
    }
  }).filter((entry) => entry.end > entry.start)
}

async function fetchTranscripts(slot, genome, window) {
  if (!shouldLoadCanonicalTranscripts(window)) return []
  const expanded = transcriptRequestWindow(window)
  const payload = await fetchJson('/api/browse/canonical_transcripts', {
    params: { genome, chrom: window.chrom, start: expanded.start, end: expanded.end, limit: 20000 },
  }).catch(() => [])
  return normalizeTranscripts(payload, slot, shouldIncludeTranscriptExons(window))
}

async function fetchCompleteAlignments({
  panel,
  targetAssembly,
  alignmentId,
  referenceWindow,
  targetWindow,
}) {
  const referenceRequest = alignmentRequestWindow(referenceWindow)
  const targetRequest = alignmentRequestWindow(targetWindow)
  const common = {
    reference_genome_id: config.refAssembly,
    alt_genome_id: targetAssembly,
    reference_viewport: viewportParam(referenceRequest),
    alt_viewport: viewportParam(targetRequest),
    alignment_id: alignmentId,
    output_dir: config.outputDir,
  }
  // A ribbon can cross the canvas even when neither endpoint overlaps the
  // opposite viewport. Querying both indexes is therefore required for complete
  // polygon coverage, exactly as in the regular structural-variation view.
  const [byReference, byTarget] = await Promise.all([
    fetchJson('/api/sv/alignments', {
      priority: 'high', params: { ...common, query_side: 'reference' },
    }).catch(() => []),
    fetchJson('/api/sv/alignments', {
      priority: 'high', params: { ...common, query_side: 'alt' },
    }).catch(() => []),
  ])
  return dedupe(
    [...(Array.isArray(byReference) ? byReference : []), ...(Array.isArray(byTarget) ? byTarget : [])]
      .map((item) => normalizeAlignment(item, panel)),
    (item) => item.id,
  ).sort((left, right) => left.ref_start - right.ref_start || left.tgt_start - right.tgt_start)
}

async function fetchSequence(slot, genome, window) {
  if (window.end - window.start > 2_000) return null
  const payload = await fetchJson('/api/browse/sequence', {
    params: { genome, chrom: window.chrom, start: Math.max(0, Math.floor(window.start)), end: Math.ceil(window.end) },
  }).catch(() => null)
  if (!payload?.sequence) return null
  return { slot, start: finite(payload.start), sequence: String(payload.sequence) }
}

function tracksForSide(viewData, side, type) {
  const tracks = viewData?.tracks?.[side] || []
  return tracks.filter((track) => String(track?.type || '').toLowerCase() === type && track?.path)
}

async function fetchSignalTracks(viewData, side, slot, genome, window) {
  if (!config.flags.showBigWig) return []
  const span = Math.max(1, window.end - window.start)
  const start = Math.max(0, Math.floor(window.start - span))
  const end = Math.ceil(window.end + span)
  const bins = Math.max(200, Math.min(1600, Math.round(renderWidth)))
  return Promise.all(tracksForSide(viewData, side, 'bigwig').map(async (track) => {
    const payload = await fetchJson('/api/browse/bigwig_batch', {
      method: 'POST',
      body: { genome, path: track.path, chrom: window.chrom, tiles: [{ start, end, bins }] },
    }).catch(() => null)
    const tile = payload?.tiles?.[0]
    const values = Array.isArray(tile?.bins) ? tile.bins : []
    const binSpan = Math.max(1, end - start) / Math.max(1, values.length)
    return {
      slot,
      id: String(track.id || track.path),
      label: String(track.label || 'BigWig'),
      bins: values.map((value, index) => ({
        start: start + index * binSpan,
        end: start + (index + 1) * binSpan,
        value: Number.isFinite(Number(value)) ? Number(value) : null,
      })),
    }
  }))
}

async function fetchIntervalTracks(viewData, side, slot, genome, window) {
  if (!config.flags.showBigBed) return []
  const span = Math.max(1, window.end - window.start)
  const start = Math.max(0, Math.floor(window.start - span))
  const end = Math.ceil(window.end + span)
  const detailed = span <= 500_000
  return Promise.all(tracksForSide(viewData, side, 'bigbed').map(async (track) => {
    const body = detailed
      ? { genome, path: track.path, chrom: window.chrom, max_features_per_tile: 3000, tiles: [{ start, end, level_id: 'detail', max_features: 3000 }] }
      : { genome, path: track.path, chrom: window.chrom, tiles: [{ start, end, level_id: 'L0', block_bp: Math.max(5_000, Math.round(span / 500)) }] }
    const payload = await fetchJson(detailed ? '/api/browse/bigbed/feature_tiles' : '/api/browse/bigbed/block_tiles', {
      method: 'POST', body,
    }).catch(() => null)
    const tile = payload?.tiles?.[0]
    const rawFeatures = detailed ? (tile?.features || []) : (tile?.block_spans || [])
    return {
      slot,
      id: String(track.id || track.path),
      label: String(track.label || 'BigBed'),
      features: rawFeatures.map((feature, index) => ({
        id: String(feature.id || feature.name || `${track.id || 'bb'}:${feature.start}:${index}`),
        start: finite(feature.start),
        end: Math.max(finite(feature.start) + 1, finite(feature.end)),
        label: String(feature.name || feature.label || ''),
        metadata: feature,
      })),
    }
  }))
}

async function fetchPair({
  slot,
  panel,
  targetAssembly,
  targetGenome,
  alignmentId,
  referenceWindow,
  targetWindow,
  normalizeTargetSpan = false,
}) {
  const viewFetchStartedAt = performance.now()
  const requestWindow = visibleHaloWindow(referenceWindow)
  const viewData = await fetchJson('/api/sv/view', {
    priority: 'high',
    params: {
      ref_assembly: config.refAssembly,
      tgt_assembly: targetAssembly,
      ref_chrom: referenceWindow.chrom,
      ref_start: requestWindow.start,
      ref_end: requestWindow.end,
      tgt_chrom: targetWindow?.chrom,
      tgt_start: targetWindow?.start,
      tgt_end: targetWindow?.end,
      ref_browse_genome: config.browse.reference,
      tgt_browse_genome: targetGenome,
      // These blocks are only a first-paint fallback; complete ribbons come
      // from `/api/sv/alignments`. Keep the metadata response inexpensive.
      max_blocks: 600,
      alignment_id: alignmentId,
      output_dir: config.outputDir,
    },
  })
  const viewFetchMs = performance.now() - viewFetchStartedAt
  if (!viewData?.supported) throw new Error(viewData?.detail || 'SV dataset is unavailable')
  const resolvedReference = normalizeWindow({
    ...referenceWindow,
    chrom: viewData.ref_chrom || referenceWindow.chrom,
    chrom_length: finite(viewData.ref_chrom_length, referenceWindow.chrom_length),
  }, 'reference', { label: config.labels.reference, color: config.colors.reference })
  let resolvedTarget = targetWindow
    ? normalizeWindow({ ...targetWindow, chrom_length: finite(viewData.tgt_chrom_length, targetWindow.chrom_length) }, slot, {
      label: config.labels[slot], color: config.colors[slot],
    })
    : deriveTargetWindow(viewData, resolvedReference, slot)
  if (normalizeTargetSpan && targetWindow) {
    resolvedTarget = normalizeWindow(
      alignedInitialTargetCandidate(viewData, resolvedReference, resolvedTarget),
      slot,
      { label: config.labels[slot], color: config.colors[slot] },
    )
  }
  const alignmentParams = {
    reference_genome_id: config.refAssembly,
    alt_genome_id: targetAssembly,
    reference_viewport: viewportParam(expandedWindow(resolvedReference, 0.5)),
    alt_viewport: viewportParam(expandedWindow(resolvedTarget, 0.5)),
    query_side: 'reference',
    alignment_id: alignmentId,
    output_dir: config.outputDir,
  }
  // `/api/sv/view` blocks are intentionally sampled. Segments are contiguous
  // overview geometry and make a safe first paint while complete blocks load.
  const alignments = ((viewData.segments?.length ? viewData.segments : viewData.blocks) || [])
    .map((item) => normalizeAlignment(item, panel))
  const variants = deriveGapVariants(alignments, panel)
  const transcripts = [
    ...normalizeTranscripts(viewData.ref_genes, 'reference'),
    ...normalizeTranscripts(viewData.tgt_genes, slot),
  ]
  const loadAlignments = () => fetchCompleteAlignments({
    panel,
    targetAssembly,
    alignmentId,
    referenceWindow: resolvedReference,
    targetWindow: resolvedTarget,
  })
  const loadDetail = async () => {
    const [rawVariants, refTranscripts, targetTranscripts, refSequence, targetSequence,
      referenceSignals, targetSignals, referenceIntervals, targetIntervals] = await Promise.all([
      fetchJson('/api/sv/variants', { params: alignmentParams }).catch(() => []),
      fetchTranscripts('reference', config.browse.reference, resolvedReference),
      fetchTranscripts(slot, targetGenome, resolvedTarget),
      fetchSequence('reference', config.browse.reference, resolvedReference),
      fetchSequence(slot, targetGenome, resolvedTarget),
      fetchSignalTracks(viewData, 'reference', 'reference', config.browse.reference, resolvedReference),
      fetchSignalTracks(viewData, 'target', slot, targetGenome, resolvedTarget),
      fetchIntervalTracks(viewData, 'reference', 'reference', config.browse.reference, resolvedReference),
      fetchIntervalTracks(viewData, 'target', slot, targetGenome, resolvedTarget),
    ])
    const detailedVariants = (Array.isArray(rawVariants) ? rawVariants : [])
      .map((item) => normalizeVariant(item, panel, resolvedReference.chrom))
    return {
      variants: detailedVariants,
      transcripts: [
        ...(refTranscripts.length ? refTranscripts : normalizeTranscripts(viewData.ref_genes, 'reference')),
        ...(targetTranscripts.length ? targetTranscripts : normalizeTranscripts(viewData.tgt_genes, slot)),
      ],
      sequences: [refSequence, targetSequence].filter(Boolean),
      signalTracks: [...referenceSignals, ...targetSignals],
      intervalTracks: [...referenceIntervals, ...targetIntervals],
    }
  }
  return {
    viewData,
    referenceWindow: resolvedReference,
    targetWindow: resolvedTarget,
    alignments,
    variants,
    transcripts,
    sequences: [],
    signalTracks: [],
    intervalTracks: [],
    loadDetail,
    loadAlignments,
    viewFetchMs,
  }
}

function dedupe(items, keyFor) {
  const seen = new Set()
  return items.filter((item) => {
    const key = keyFor(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function publishScene(nextScene, datasetLabel, phase, diagnostics = {}) {
  const nextSceneBytes = estimateJsonBytes(nextScene)
  if (nextSceneBytes > CACHE_LIMIT_BYTES) {
    throw new Error('The requested structural-variation window exceeds the 256 MiB renderer budget')
  }
  renderer.set_scene(JSON.stringify(nextScene))
  scene = nextScene
  sceneBytes = nextSceneBytes
  responseCache.setLimit(CACHE_LIMIT_BYTES - sceneBytes)
  const metrics = parseJson(renderer.render(), {})
  const layout = parseJson(renderer.layout_json(), {})
  post('scene', {
    phase,
    windows: scene.windows,
    height: renderer.required_height(),
    layout,
    datasetLabel,
    metrics: {
      ...metrics,
      ...diagnostics,
      cache_bytes: responseCache.bytes + sceneBytes,
      scene_bytes: sceneBytes,
    },
  })
  scheduleSnapshot()
}

async function loadScene(windowsOverride = null, reason = 'load') {
  const loadStartedAt = performance.now()
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (reason !== 'retry') retryAttempt = 0
  abortAll()
  const loadEpoch = ++epoch
  post('loading', { loading: true, reason, phase: 'base' })
  const retainedScene = scene
  const currentWindows = windowsOverride || scene?.windows || config.initialWindows || []
  const referenceWindow = normalizeWindow(
    currentWindows.find?.((item) => item?.slot === 'reference') || buildInitialReferenceWindow(),
    'reference', { label: config.labels.reference, color: config.colors.reference },
  )
  if (!referenceWindow?.chrom) throw new Error('The selected SV region has no chromosome identifier')
  const topWindow = currentWindows.find?.((item) => item?.slot === 'top') || null
  const bottomWindow = currentWindows.find?.((item) => item?.slot === 'bottom') || null
  try {
    const upperPromise = fetchPair({
      slot: 'top', panel: 'upper', targetAssembly: config.topAssembly, targetGenome: config.browse.top,
      alignmentId: config.topAlignmentId, referenceWindow, targetWindow: topWindow,
      normalizeTargetSpan: reason === 'initial' || (reason === 'retry' && !scene),
    })
    const lowerPromise = config.bottomAssembly && config.bottomAlignmentId
      ? fetchPair({
        slot: 'bottom', panel: 'lower', targetAssembly: config.bottomAssembly, targetGenome: config.browse.bottom,
        alignmentId: config.bottomAlignmentId, referenceWindow, targetWindow: bottomWindow,
        normalizeTargetSpan: reason === 'initial' || (reason === 'retry' && !scene),
      })
      : Promise.resolve(null)
    const [upper, lower] = await Promise.all([upperPromise, lowerPromise])
    if (disposed || !isCurrentSvEpoch(loadEpoch, epoch)) return
    const reference = lower?.referenceWindow || upper.referenceWindow
    const nextScene = {
      version: 1,
      theme: config.theme,
      compact: config.flags.compact,
      show_bigwig: config.flags.showBigWig,
      show_bigbed: config.flags.showBigBed,
      hide_inactive: config.flags.hideInactive,
      hidden_tracks: config.flags.hiddenTracks || [],
      windows: [upper.targetWindow, reference, lower?.targetWindow].filter(Boolean),
      alignments: [...upper.alignments, ...(lower?.alignments || [])],
      variants: [...upper.variants, ...(lower?.variants || [])],
      transcripts: dedupe([...upper.transcripts, ...(lower?.transcripts || [])], (item) => `${item.slot}|${item.id}|${item.start}`),
      sequences: dedupe([...upper.sequences, ...(lower?.sequences || [])], (item) => `${item.slot}|${item.start}`),
      signal_tracks: dedupe([...upper.signalTracks, ...(lower?.signalTracks || [])], (item) => `${item.slot}|${item.id}`),
      interval_tracks: dedupe([...upper.intervalTracks, ...(lower?.intervalTracks || [])], (item) => `${item.slot}|${item.id}`),
    }
    retryAttempt = 0
    const datasetLabel = upper.viewData?.dataset_label || 'Structural variation'
    const baseLoadMs = performance.now() - loadStartedAt
    if (!retainedScene) {
      publishScene(nextScene, datasetLabel, 'base', {
        base_load_ms: baseLoadMs,
        view_fetch_ms: Math.max(upper.viewFetchMs, lower?.viewFetchMs || 0),
      })
    }
    post('loading', { loading: true, reason, phase: 'alignments' })

    // Publish complete upper/lower ribbon sets as one transaction. A trio must
    // never expose one fully loaded panel alongside one sampled panel.
    const upperAlignmentPromise = upper.loadAlignments()
    const lowerAlignmentPromise = lower?.loadAlignments() || Promise.resolve([])
    const upperDetailPromise = upper.loadDetail()
    const lowerDetailPromise = lower?.loadDetail() || Promise.resolve(null)
    const [upperAlignments, lowerAlignments] = await Promise.all([
      upperAlignmentPromise,
      lowerAlignmentPromise,
    ])
    if (disposed || !isCurrentSvEpoch(loadEpoch, epoch)) return
    const alignmentScene = {
      ...(retainedScene || nextScene),
      theme: config.theme,
      compact: config.flags.compact,
      show_bigwig: config.flags.showBigWig,
      show_bigbed: config.flags.showBigBed,
      hide_inactive: config.flags.hideInactive,
      hidden_tracks: config.flags.hiddenTracks || [],
      windows: parseJson(renderer.windows_json(), nextScene.windows),
      alignments: [...upperAlignments, ...lowerAlignments],
      variants: [
        ...deriveGapVariants(upperAlignments, 'upper'),
        ...deriveGapVariants(lowerAlignments, 'lower'),
      ],
    }
    publishScene(alignmentScene, datasetLabel, 'alignments', {
      base_load_ms: baseLoadMs,
      view_fetch_ms: Math.max(upper.viewFetchMs, lower?.viewFetchMs || 0),
      alignment_load_ms: performance.now() - loadStartedAt,
      alignment_count: alignmentScene.alignments.length,
    })
    post('loading', { loading: true, reason, phase: 'detail' })

    const [upperDetail, lowerDetail] = await Promise.all([
      upperDetailPromise,
      lowerDetailPromise,
    ])
    if (disposed || !isCurrentSvEpoch(loadEpoch, epoch)) return
    const detailedScene = {
      ...alignmentScene,
      windows: parseJson(renderer.windows_json(), alignmentScene.windows),
      variants: [
        ...(upperDetail.variants.length ? upperDetail.variants : deriveGapVariants(upperAlignments, 'upper')),
        ...((lowerDetail?.variants || []).length
          ? lowerDetail.variants
          : deriveGapVariants(lowerAlignments, 'lower')),
      ],
      transcripts: dedupe(
        [...upperDetail.transcripts, ...(lowerDetail?.transcripts || [])],
        (item) => `${item.slot}|${item.id}|${item.start}`,
      ),
      sequences: dedupe(
        [...upperDetail.sequences, ...(lowerDetail?.sequences || [])],
        (item) => `${item.slot}|${item.start}`,
      ),
      signal_tracks: dedupe(
        [...upperDetail.signalTracks, ...(lowerDetail?.signalTracks || [])],
        (item) => `${item.slot}|${item.id}`,
      ),
      interval_tracks: dedupe(
        [...upperDetail.intervalTracks, ...(lowerDetail?.intervalTracks || [])],
        (item) => `${item.slot}|${item.id}`,
      ),
    }
    publishScene(detailedScene, datasetLabel, 'detail', {
      base_load_ms: baseLoadMs,
      view_fetch_ms: Math.max(upper.viewFetchMs, lower?.viewFetchMs || 0),
      detail_load_ms: performance.now() - loadStartedAt,
    })
    retryAttempt = 0
  } catch (error) {
    if (disposed || !isCurrentSvEpoch(loadEpoch, epoch) || error?.name === 'AbortError') return
    const message = error?.message || 'Failed to load the Rust SV scene'
    const retryable = !/exceeds the 256 MiB|no chromosome identifier|dataset is unavailable/i.test(message)
    const retryInMs = retryable && retryAttempt < 3 ? [500, 1200, 2500][retryAttempt] : 0
    post('error', { message, retryInMs })
    if (retryInMs) {
      retryAttempt += 1
      const retryWindows = windowsOverride || scene?.windows || currentWindows
      retryTimer = setTimeout(() => {
        retryTimer = null
        loadScene(retryWindows, 'retry')
      }, retryInMs)
    }
  } finally {
    if (!disposed && isCurrentSvEpoch(loadEpoch, epoch)) post('loading', { loading: false, reason })
  }
}

function renderAndPost(type = 'preview') {
  if (!renderer) return
  try {
    const metrics = parseJson(renderer.render(), {})
    const windows = parseJson(renderer.windows_json(), [])
    post(type, { windows, height: renderer.required_height(), metrics: { ...metrics, cache_bytes: responseCache.bytes + sceneBytes, scene_bytes: sceneBytes } })
  } catch (error) {
    post('fatal', { message: error?.message || String(error) })
  }
}

function scheduleCommit(windows, reason = 'wheel') {
  if (commitTimer) clearTimeout(commitTimer)
  commitTimer = setTimeout(() => {
    commitTimer = null
    post('commit', { windows, reason })
    loadScene(windows, reason)
  }, 180)
}

function scheduleSnapshot() {
  if (snapshotTimer) clearTimeout(snapshotTimer)
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null
    createSnapshot().catch(() => {})
  }, 180)
}

async function createSnapshot(requestId = '') {
  if (!renderer) return
  const width = renderer.physical_width()
  const height = renderer.physical_height()
  const pixels = renderer.snapshot_rgba()
  const exportCanvas = new OffscreenCanvas(width, height)
  const context = exportCanvas.getContext('2d')
  context.putImageData(new ImageData(pixels, width, height), 0, 0)
  const blob = await exportCanvas.convertToBlob({ type: 'image/png' })
  post('snapshot', { requestId, blob, width, height })
}

function abortAll() {
  for (const controller of activeControllers) controller.abort()
  activeControllers.clear()
  pendingRequests.clear()
}

self.onmessage = async (event) => {
  const message = event.data || {}
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    post('fatal', { message: `Unsupported SV worker protocol ${message.protocolVersion}` })
    return
  }
  try {
    switch (message.type) {
      case 'init': {
        disposed = false
        config = message.config
        renderWidth = Math.max(1, finite(message.width, 1200))
        renderDpr = clamp(finite(message.dpr, 1), 1, 4)
        await initWasm()
        renderer = new WasmRenderer(message.geometryCanvas, message.overlayCanvas)
        renderer.resize(renderWidth, 1, renderDpr)
        post('ready', { capabilities: { wasm: true, offscreenCanvas: true, webgl2: true } })
        await loadScene(null, 'initial')
        break
      }
      case 'resize': {
        renderWidth = Math.max(1, finite(message.width, renderWidth))
        renderDpr = clamp(finite(message.dpr, renderDpr), 1, 4)
        renderer?.resize(renderWidth, renderer.required_height(), renderDpr)
        renderAndPost('resized')
        scheduleSnapshot()
        break
      }
      case 'pointerDown':
        renderer?.pointer_down(message.x, message.y, Boolean(message.boxSelect))
        break
      case 'pointerMove':
        if (renderer?.pointer_move(message.x, message.y)) renderAndPost('preview')
        else {
          const hit = parseJson(renderer?.hit_test(message.x, message.y), null)
          post('hover', { hit })
        }
        break
      case 'pointerUp': {
        const result = parseJson(renderer?.pointer_up(message.x, message.y), null)
        renderAndPost('preview')
        if (result?.kind === 'viewport') {
          post('commit', { windows: result.windows, reason: message.boxSelect ? 'box-select' : 'pan' })
          loadScene(result.windows, message.boxSelect ? 'box-select' : 'pan')
        } else if (result) {
          post('hit', { hit: result, clientX: message.clientX, clientY: message.clientY })
        } else {
          post('hit', { hit: null })
        }
        scheduleSnapshot()
        break
      }
      case 'pointerCancel':
        renderer?.cancel_pointer()
        renderAndPost('preview')
        break
      case 'wheel': {
        const result = parseJson(renderer?.wheel(message.x, message.y, message.deltaX, message.deltaY, Boolean(message.ctrlKey)), null)
        renderAndPost('preview')
        if (result?.windows) scheduleCommit(result.windows, 'wheel')
        break
      }
      case 'zoom': {
        const windows = parseJson(renderer?.zoom_all(message.factor), [])
        renderAndPost('preview')
        post('commit', { windows, reason: 'toolbar-zoom' })
        loadScene(windows, 'toolbar-zoom')
        break
      }
      case 'center': {
        const windows = parseJson(renderer?.center_targets(), [])
        renderAndPost('preview')
        post('commit', { windows, reason: 'center' })
        loadScene(windows, 'center')
        break
      }
      case 'settings':
        {
          const needsTrackFetch = Boolean(
            message.flags
            && (
              message.flags.showBigWig !== config.flags.showBigWig
              || message.flags.showBigBed !== config.flags.showBigBed
            )
          )
        config = { ...config, theme: message.theme || config.theme, flags: { ...config.flags, ...(message.flags || {}) } }
        if (scene) {
          scene.theme = config.theme
          scene.compact = config.flags.compact
          scene.show_bigwig = config.flags.showBigWig
          scene.show_bigbed = config.flags.showBigBed
          scene.hide_inactive = config.flags.hideInactive
          scene.hidden_tracks = config.flags.hiddenTracks || []
        }
          if (needsTrackFetch) {
            loadScene(scene?.windows, 'settings')
          } else if (scene && renderer) {
            renderer.set_scene(JSON.stringify(scene))
            renderAndPost('scene')
            scheduleSnapshot()
          }
        }
        break
      case 'snapshot':
        await createSnapshot(message.requestId || '')
        break
      case 'dispose':
        disposed = true
        epoch += 1
        abortAll()
        responseCache.clear()
        sceneBytes = 0
        if (commitTimer) clearTimeout(commitTimer)
        if (snapshotTimer) clearTimeout(snapshotTimer)
        if (retryTimer) clearTimeout(retryTimer)
        renderer?.dispose()
        renderer = null
        self.close()
        break
      default:
        post('error', { message: `Unknown SV worker message: ${message.type}` })
    }
  } catch (error) {
    post(message.type === 'init' ? 'fatal' : 'error', { message: error?.message || String(error) })
  }
}

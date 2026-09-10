import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, API_TOKEN_HEADER, getApiToken } from '../../backendRuntime'
import { resolveGenomeColor } from '../../genomeColorSchemes'
import { SvPerformanceRecorder } from '../../utils/svPerformanceBenchmark'
import { SV_RUST_PROTOCOL_VERSION } from '../../utils/svRustRendererProtocol'

const PROTOCOL_VERSION = SV_RUST_PROTOCOL_VERSION
const DEFAULT_HEIGHT = 340

function runtimeAssembly(species) {
  return species?.assembly_name || species?.assembly || species?.gca || species?.accession || species?.key || ''
}

function speciesKey(species) {
  return species?.genome_key || species?.key || species?.id || species?.gca || species?.accession || species?.assembly || ''
}

function regionKey(region) {
  return String(region?.id || region?.chrom || region?.label || '')
}

function formatCoord(value) {
  return Math.round(Number(value) || 0).toLocaleString()
}

function formatBp(span) {
  const value = Math.max(0, Number(span) || 0)
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)} Mb`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)} kb`
  return `${Math.round(value)} bp`
}

function windowForSlot(windows, slot) {
  return (windows || []).find((window) => window?.slot === slot) || null
}

function buildInitialWindows({ savedViewportRef, refSpecies, tgtSpecies, thirdSpecies, browserRefGene, browserRefViewport }) {
  const refAssembly = runtimeAssembly(refSpecies)
  const topAssembly = runtimeAssembly(tgtSpecies)
  const bottomAssembly = runtimeAssembly(thirdSpecies)
  const saved = savedViewportRef?.current
  const restored = saved?.refWindow && saved.refAssembly === refAssembly && saved.topAssembly === topAssembly
    ? [
      { ...saved.topWindow, slot: 'top' },
      { ...saved.refWindow, slot: 'reference' },
      ...(saved.bottomWindow && saved.bottomAssembly === bottomAssembly ? [{ ...saved.bottomWindow, slot: 'bottom' }] : []),
    ].filter((window) => window?.chrom)
    : []

  let externalReference = null
  if (browserRefGene?.chrom) {
    const geneSpan = Math.max(1, Number(browserRefGene.end || 0) - Number(browserRefGene.start || 0))
    const span = Math.max(120_000, Math.min(5_000_000, Math.round(geneSpan * 8)))
    const center = (Number(browserRefGene.start || 0) + Number(browserRefGene.end || 0)) / 2
    externalReference = { slot: 'reference', chrom: browserRefGene.chrom, start: Math.max(1, center - span / 2), end: center + span / 2 }
  } else if (browserRefViewport?.chrom && Number(browserRefViewport.end) > Number(browserRefViewport.start)) {
    externalReference = {
      slot: 'reference',
      chrom: browserRefViewport.chrom,
      start: Math.max(1, Number(browserRefViewport.start)),
      end: Number(browserRefViewport.end),
    }
  }
  if (!externalReference) return restored
  return [
    ...restored.filter((window) => window.slot !== 'reference'),
    externalReference,
  ]
}

function capabilityFailure() {
  if (typeof Worker === 'undefined') return 'Web Workers are unavailable.'
  if (typeof OffscreenCanvas === 'undefined') return 'OffscreenCanvas is unavailable.'
  if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
    return 'Canvas transfer to a worker is unavailable.'
  }
  try {
    const canvas = new OffscreenCanvas(2, 2)
    if (!canvas.getContext('webgl2')) return 'WebGL2 is unavailable.'
  } catch {
    return 'WebGL2 initialization failed.'
  }
  return ''
}

function MetadataPopup({ hit, onClose }) {
  if (!hit) return null
  const payload = hit.payload || {}
  const isVariant = hit.kind === 'variant'
  const variant = isVariant ? payload : null
  const interval = !isVariant ? payload.feature : null
  const rows = isVariant
    ? [
      ['Variant type', variant?.kind || 'variant'],
      ['Location', `${variant?.chrom || ''}:${formatCoord(variant?.start)}-${formatCoord(variant?.end)}`],
      ['Reference length', variant?.ref_length || '—'],
      ['Alternate length', variant?.alt_length || '—'],
    ]
    : [
      ['Track', payload.track || 'BigBed'],
      ['Feature', interval?.label || interval?.id || 'Interval'],
      ['Location', `${formatCoord(interval?.start)}-${formatCoord(interval?.end)}`],
      ...Object.entries(interval?.metadata || {}).slice(0, 8).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]),
    ]
  return (
    <div
      className="fixed z-50 w-[320px] rounded-lg border border-white/10 bg-gray-900/95 p-3 text-xs text-slate-100 shadow-2xl"
      style={{ left: hit.popupX, top: hit.popupY, transform: 'translate(-50%, calc(-100% - 12px))' }}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" className="absolute right-2 top-1 text-base text-slate-400 hover:text-white" onClick={onClose} aria-label="Close metadata">×</button>
      <div className="mb-2 pr-5 text-sm font-semibold">{isVariant ? 'Structural variant' : 'Interval feature'}</div>
      <div className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[105px_1fr] gap-2">
            <span className="text-slate-400">{label}</span>
            <span className="break-words font-medium">{String(value ?? '')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function RustStructuralVariationView({
  theme = 'dark',
  config: appConfig,
  refSpecies,
  tgtSpecies,
  thirdSpecies,
  thirdGenomeId = '',
  refPillLabel = '',
  tgtPillLabel = '',
  thirdPillLabel = '',
  selectedTopAlignmentId = '',
  selectedBottomAlignmentId = '',
  selectedAnchorRegion = null,
  outputDir = '',
  browserRefGene = null,
  browserRefViewport = null,
  savedViewportRef = null,
  rendererSessionId = 0,
  onFatal = null,
}) {
  const isLight = theme === 'light'
  const canvasHostRef = useRef(null)
  const viewportRef = useRef(null)
  const workerRef = useRef(null)
  const pointerIdRef = useRef(null)
  const settingsReadyRef = useRef(false)
  const snapshotUrlRef = useRef('')
  const savedViewportTargetRef = useRef(savedViewportRef)
  const performanceRecorder = useMemo(() => new SvPerformanceRecorder(), [])
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingPhase, setLoadingPhase] = useState('base')
  const [error, setError] = useState('')
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [windows, setWindows] = useState([])
  const [datasetLabel, setDatasetLabel] = useState('Structural variation')
  const [metrics, setMetrics] = useState(null)
  const [boxSelect, setBoxSelect] = useState(false)
  const [compact, setCompact] = useState(false)
  const [showBigWig, setShowBigWig] = useState(false)
  const [showBigBed, setShowBigBed] = useState(false)
  const [hideInactive, setHideInactive] = useState(Boolean(appConfig?.sv_hide_inactive_tracks))
  const [hiddenTracks, setHiddenTracks] = useState([])
  const [hit, setHit] = useState(null)
  const [snapshotUrl, setSnapshotUrl] = useState('')

  const refAssembly = runtimeAssembly(refSpecies)
  const topAssembly = runtimeAssembly(tgtSpecies)
  const bottomAssembly = runtimeAssembly(thirdSpecies)
  const colors = useMemo(() => ({
    reference: resolveGenomeColor(appConfig, refSpecies),
    top: resolveGenomeColor(appConfig, tgtSpecies),
    bottom: resolveGenomeColor(appConfig, thirdSpecies),
  }), [appConfig, refSpecies, tgtSpecies, thirdSpecies])
  const labels = useMemo(() => ({
    reference: refPillLabel || 'Primary genome',
    top: tgtPillLabel || 'Secondary genome',
    bottom: thirdPillLabel || 'Third genome',
  }), [refPillLabel, tgtPillLabel, thirdPillLabel])
  const initialWindows = useMemo(() => buildInitialWindows({
    savedViewportRef, refSpecies, tgtSpecies, thirdSpecies, browserRefGene, browserRefViewport,
  }), [savedViewportRef, refSpecies, tgtSpecies, thirdSpecies, browserRefGene, browserRefViewport])

  useEffect(() => {
    performanceRecorder.start()
    return () => performanceRecorder.stop()
  }, [performanceRecorder])

  useEffect(() => {
    savedViewportTargetRef.current = savedViewportRef
  }, [savedViewportRef])

  const updateSavedViewport = useCallback((nextWindows) => {
    const target = savedViewportTargetRef.current
    if (!target) return
    target.current = {
      refWindow: windowForSlot(nextWindows, 'reference'),
      topWindow: windowForSlot(nextWindows, 'top'),
      bottomWindow: windowForSlot(nextWindows, 'bottom'),
      refAssembly,
      topAssembly,
      bottomAssembly,
      seededRegionKey: `${selectedTopAlignmentId}|${regionKey(selectedAnchorRegion)}|${selectedAnchorRegion?.start || ''}-${selectedAnchorRegion?.end || ''}`,
    }
  }, [refAssembly, topAssembly, bottomAssembly, selectedTopAlignmentId, selectedAnchorRegion])

  useEffect(() => {
    const failure = capabilityFailure()
    if (failure) {
      onFatal?.(failure)
      return undefined
    }
    const canvasHost = canvasHostRef.current
    const viewport = viewportRef.current
    if (!canvasHost || !viewport) return undefined

    const geometryCanvas = document.createElement('canvas')
    geometryCanvas.className = 'absolute inset-0 block h-full w-full'
    geometryCanvas.setAttribute('aria-label', 'Rust structural variation geometry')
    const overlayCanvas = document.createElement('canvas')
    overlayCanvas.className = 'pointer-events-none absolute inset-0 block h-full w-full'
    overlayCanvas.setAttribute('aria-hidden', 'true')
    canvasHost.append(geometryCanvas, overlayCanvas)

    let worker
    try {
      const geometryOffscreen = geometryCanvas.transferControlToOffscreen()
      const overlayOffscreen = overlayCanvas.transferControlToOffscreen()
      worker = new Worker(new URL('../../workers/svRustRenderer.worker.js', import.meta.url), { type: 'module', name: 'ensembl-sv-rust-renderer' })
      workerRef.current = worker
      const width = Math.max(760, Math.round(viewport.getBoundingClientRect().width || 760))
      const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1))
      worker.onmessage = (event) => {
        const message = event.data || {}
        if (message.protocolVersion !== PROTOCOL_VERSION) return
        if (message.type === 'ready') {
          settingsReadyRef.current = true
          setReady(true)
          setError('')
        } else if (message.type === 'loading') {
          setLoading(Boolean(message.loading))
          if (message.phase) setLoadingPhase(message.phase)
        } else if (message.type === 'scene' || message.type === 'preview' || message.type === 'resized') {
          if (Array.isArray(message.windows)) setWindows(message.windows)
          if (Number.isFinite(message.height)) setHeight(Math.max(1, message.height))
          if (message.datasetLabel) setDatasetLabel(message.datasetLabel)
          if (message.metrics) {
            const observed = performanceRecorder.recordFrame(message.metrics)
            setMetrics((current) => ({ ...current, ...message.metrics, ...observed }))
          }
          if (message.type === 'scene') setError('')
          if (message.type === 'scene' && Array.isArray(message.windows)) updateSavedViewport(message.windows)
        } else if (message.type === 'commit') {
          if (Array.isArray(message.windows)) {
            setWindows(message.windows)
            updateSavedViewport(message.windows)
          }
          setHit(null)
          setBoxSelect(false)
        } else if (message.type === 'hit') {
          if (message.hit?.kind === 'track-toggle' && message.hit?.payload?.track_id) {
            const trackId = String(message.hit.payload.track_id)
            setHiddenTracks((current) => (
              current.includes(trackId)
                ? current.filter((candidate) => candidate !== trackId)
                : [...current, trackId]
            ))
            setHit(null)
          } else {
            setHit(message.hit ? { ...message.hit, popupX: message.clientX, popupY: message.clientY } : null)
          }
        } else if (message.type === 'hover') {
          viewport.style.cursor = message.hit ? 'pointer' : (boxSelect ? 'crosshair' : 'grab')
        } else if (message.type === 'snapshot' && message.blob) {
          if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
          const nextUrl = URL.createObjectURL(message.blob)
          snapshotUrlRef.current = nextUrl
          setSnapshotUrl(nextUrl)
        } else if (message.type === 'error') {
          setError(message.message || 'The Rust renderer reported an error.')
        } else if (message.type === 'fatal') {
          onFatal?.(message.message || 'The Rust renderer stopped unexpectedly.')
        }
      }
      worker.onerror = (event) => onFatal?.(event.message || 'The Rust renderer worker crashed.')
      worker.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'init',
        geometryCanvas: geometryOffscreen,
        overlayCanvas: overlayOffscreen,
        width,
        dpr,
        config: {
          apiBase: API_BASE,
          apiToken: getApiToken(),
          tokenHeader: API_TOKEN_HEADER,
          outputDir: outputDir || appConfig?.output_dir || '',
          refAssembly,
          topAssembly,
          bottomAssembly,
          topAlignmentId: selectedTopAlignmentId,
          bottomAlignmentId: selectedBottomAlignmentId,
          anchorRegion: selectedAnchorRegion,
          initialWindows,
          browse: {
            reference: 'reference',
            top: 'target',
            bottom: thirdGenomeId || speciesKey(thirdSpecies) || 'target',
          },
          labels,
          colors,
          theme,
          flags: {
            compact: false,
            showBigWig: false,
            showBigBed: false,
            hideInactive: Boolean(appConfig?.sv_hide_inactive_tracks),
            hiddenTracks: [],
          },
        },
      }, [geometryOffscreen, overlayOffscreen])
    } catch (cause) {
      onFatal?.(cause?.message || 'Failed to start the Rust renderer.')
      return undefined
    }

    const observer = new ResizeObserver(() => {
      const width = Math.max(760, Math.round(viewport.getBoundingClientRect().width || 760))
      worker.postMessage({ protocolVersion: PROTOCOL_VERSION, type: 'resize', width, dpr: Math.max(1, Math.min(4, window.devicePixelRatio || 1)) })
    })
    observer.observe(viewport)

    return () => {
      observer.disconnect()
      settingsReadyRef.current = false
      worker.postMessage({ protocolVersion: PROTOCOL_VERSION, type: 'dispose' })
      worker.terminate()
      workerRef.current = null
      geometryCanvas.remove()
      overlayCanvas.remove()
      if (snapshotUrlRef.current) URL.revokeObjectURL(snapshotUrlRef.current)
      snapshotUrlRef.current = ''
    }
  // Canvas transfer requires a full component remount; the parent key changes for every session/alignment/region.
  }, [rendererSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!settingsReadyRef.current || !workerRef.current) return
    workerRef.current.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'settings',
      theme,
      flags: { compact, showBigWig, showBigBed, hideInactive, hiddenTracks },
    })
  }, [ready, theme, compact, showBigWig, showBigBed, hideInactive, hiddenTracks])

  const postPointer = useCallback((type, event) => {
    const viewport = viewportRef.current
    const worker = workerRef.current
    if (!viewport || !worker) return
    const rect = viewport.getBoundingClientRect()
    worker.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type,
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
      clientX: event.clientX,
      clientY: event.clientY,
      boxSelect,
    })
  }, [boxSelect])

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0 || pointerIdRef.current !== null) return
    pointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    setHit(null)
    performanceRecorder.markInput()
    postPointer('pointerDown', event)
  }, [performanceRecorder, postPointer])

  const handlePointerMove = useCallback((event) => {
    if (pointerIdRef.current !== null) performanceRecorder.markInput()
    postPointer('pointerMove', event)
  }, [performanceRecorder, postPointer])

  const finishPointer = useCallback((event, cancelled = false) => {
    if (pointerIdRef.current !== event.pointerId) return
    pointerIdRef.current = null
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* ignored */ }
    performanceRecorder.markInput()
    postPointer(cancelled ? 'pointerCancel' : 'pointerUp', event)
  }, [performanceRecorder, postPointer])

  const handleWheel = useCallback((event) => {
    const viewport = viewportRef.current
    const worker = workerRef.current
    if (!viewport || !worker || boxSelect) return
    event.preventDefault()
    event.stopPropagation()
    performanceRecorder.markInput()
    const rect = viewport.getBoundingClientRect()
    worker.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'wheel',
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      ctrlKey: event.ctrlKey || event.metaKey,
    })
  }, [boxSelect, performanceRecorder])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const sendAction = useCallback((type, payload = {}) => {
    performanceRecorder.markInput()
    workerRef.current?.postMessage({ protocolVersion: PROTOCOL_VERSION, type, ...payload })
  }, [performanceRecorder])

  const referenceWindow = windowForSlot(windows, 'reference')
  const headerLocation = referenceWindow
    ? `${referenceWindow.chrom}:${formatCoord(referenceWindow.start)}-${formatCoord(referenceWindow.end)} (${formatBp(referenceWindow.end - referenceWindow.start)})`
    : 'Loading Rust viewport…'
  const buttonClass = isLight
    ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'
    : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  const activeClass = isLight ? 'border-sky-500 bg-sky-500 text-white' : 'border-sky-600 bg-sky-600 text-white'
  const cacheMb = Number(metrics?.cache_bytes || 0) / (1024 * 1024)
  const hasScene = ready && windows.length > 0

  return (
    <div className={`overflow-hidden rounded-xl border ${isLight ? 'border-gray-200 bg-white text-gray-900' : 'border-gray-700 bg-[#1E2938] text-gray-100'}`}>
      <div className={`flex items-center gap-2 border-b px-3 py-2 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <div className="w-[330px] max-w-[38vw] shrink-0 truncate text-xs opacity-75">{headerLocation}</div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <button type="button" disabled={!hasScene} className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${buttonClass}`} onClick={() => sendAction('zoom', { factor: 1.12 })} title="Zoom out">−</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${buttonClass}`} onClick={() => sendAction('zoom', { factor: 0.89 })} title="Zoom in">+</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${buttonClass}`} onClick={() => sendAction('center')} title="Center aligned target windows">Center</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${boxSelect ? activeClass : buttonClass}`} onClick={() => setBoxSelect((value) => !value)} aria-pressed={boxSelect}>Select</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${compact ? activeClass : buttonClass}`} onClick={() => setCompact((value) => !value)}>{compact ? 'Expand' : 'Compress'}</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${hideInactive ? activeClass : buttonClass}`} onClick={() => setHideInactive((value) => !value)} aria-pressed={hideInactive}>Hide inactive</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${showBigWig ? activeClass : buttonClass}`} onClick={() => setShowBigWig((value) => !value)} aria-pressed={showBigWig}>BigWig</button>
          <button type="button" disabled={!hasScene} className={`rounded border px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${showBigBed ? activeClass : buttonClass}`} onClick={() => setShowBigBed((value) => !value)} aria-pressed={showBigBed}>BigBed</button>
        </div>
      </div>

      <div
        data-screenshot-raster-proxy="img[data-sv-rust-snapshot='true']"
        ref={viewportRef}
        className="relative w-full touch-none select-none overflow-hidden"
        style={{ height, cursor: boxSelect ? 'crosshair' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event, false)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
        onMouseLeave={() => { if (pointerIdRef.current === null) setHit(null) }}
      >
        <div ref={canvasHostRef} className="absolute inset-0" />
        {snapshotUrl && (
          <img
            data-sv-rust-snapshot="true"
            src={snapshotUrl}
            alt="Structural variation viewport"
            className="pointer-events-none absolute left-0 top-0 h-full w-full opacity-0"
          />
        )}
        {loading && windows.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/20">
            <div className={`flex items-center gap-3 rounded-lg px-4 py-2 text-sm font-semibold ${isLight ? 'bg-white/90 text-gray-700' : 'bg-slate-900/85 text-gray-200'}`}>
              <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-sky-500 border-t-transparent" />
              Loading Rust SV window…
            </div>
          </div>
        )}
        {loading && windows.length > 0 && (
          <div className={`pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-md px-2.5 py-1 text-[11px] font-medium shadow ${isLight ? 'bg-white/90 text-gray-600' : 'bg-slate-900/85 text-gray-300'}`}>
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
            {loadingPhase === 'alignments'
              ? 'Completing alignment coverage…'
              : loadingPhase === 'detail'
                ? 'Adding visible detail…'
                : 'Updating window…'}
          </div>
        )}
        {!ready && !error && <div className="absolute inset-0 flex items-center justify-center text-sm opacity-70">Starting Rust/WASM renderer…</div>}
        {error && (
          <div className="pointer-events-none absolute left-1/2 top-3 max-w-[80%] -translate-x-1/2 rounded-md bg-red-950/90 px-3 py-1.5 text-center text-xs text-red-200 shadow-lg">
            {error}
          </div>
        )}
      </div>

      <MetadataPopup hit={hit} onClose={() => setHit(null)} />

      <div className={`flex items-center gap-3 border-t px-3 py-1.5 text-[11px] ${isLight ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-gray-700 bg-[#152033] text-gray-300'}`}>
        <span>{loading && windows.length === 0 ? 'Loading structural variation…' : datasetLabel}</span>
        <span className="ml-auto font-mono opacity-80">
          Rust · {Number(metrics?.delivered_fps || 0)} fps · {Number(metrics?.input_latency_p95_ms || 0).toFixed(1)} ms input P95 · {Number(metrics?.render_ms || 0).toFixed(1)} ms render · {Number(metrics?.primitive_count || 0).toLocaleString()} primitives · {cacheMb.toFixed(1)} MiB cache
          {Number(metrics?.base_load_ms) > 0 && ` · ${Math.round(Number(metrics.base_load_ms))} ms base`}
          {Number(metrics?.view_fetch_ms) > 0 && ` · ${Math.round(Number(metrics.view_fetch_ms))} ms SV API`}
        </span>
      </div>
    </div>
  )
}

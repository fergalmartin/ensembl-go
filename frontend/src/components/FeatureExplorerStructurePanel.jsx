import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'
import { genomeKeysMatch } from '../utils/genomeIdentity'
import {
  createStructureViewerBridge,
  structureModelUrl,
  structureViewerUrl,
} from './structureViewerBridge'
import {
  CONSEQUENCE_LABELS,
  EXON_ALTERNATING_COLORS,
  PLAIN_COLOR,
  UNMAPPED_COLOR,
  VARIANT_IMPACT_COLORS,
  VARIANT_IMPACT_LABELS,
  buildPaintSegments,
  buildVariantOverlays,
  exonAtResidue,
  formatRange,
  mutedColor,
  rgbCss,
  summariseExons,
  summariseVariantImpacts,
} from './structureExonMapping'

const COLOR_MODES = [
  { key: 'exons', label: 'Exons', title: 'Colour the model by which coding exon contributes each residue' },
  { key: 'plddt', label: 'Confidence', title: "Colour by AlphaFold's pLDDT per-residue confidence" },
  { key: 'none', label: 'Plain', title: 'No overlay' },
]

const SOURCE_LABELS = {
  manual: 'entered',
  custom_tsv: 'mapping file',
  xref: 'genome xref',
  uniprot_api: 'UniProt',
}

// Matches the lock in the transcript panel, so the two mean the same thing.
const LOCKED_ICON_PATH = 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z'

function Chevron({ collapsed }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      {collapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
    </svg>
  )
}

/**
 * One collapsible block in the panel's side column.
 *
 * The column is meant to grow — exons and variants today, domains and
 * conservation later — so each block owns its own disclosure state and the
 * column simply stacks them.
 */
function StructureSection({ title, badge, open, onToggle, isLight, actions, children }) {
  const headerClass = isLight ? 'text-gray-800 hover:bg-gray-100' : 'text-gray-100 hover:bg-gray-700/60'
  const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  return (
    <div className={`rounded-md border ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-[11px] font-semibold transition-colors ${headerClass}`}
        >
          <Chevron collapsed={!open} />
          <span className="truncate">{title}</span>
          {badge != null && <span className={`shrink-0 tabular-nums font-normal ${mutedClass}`}>{badge}</span>}
        </button>
        {open && actions}
      </div>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  )
}

export default function FeatureExplorerStructurePanel({
  theme = 'dark',
  resolvedGene = null,
  sequenceGenome = 'reference',
  displayOrderIds = [],
  activeTranscriptIds = new Set(),
  transcriptById = new Map(),
  containerRef = null,
  onRegisterScreenshot = null,
}) {
  const isLight = theme === 'light'
  const mode = isLight ? 'light' : 'dark'
  const [collapsed, setCollapsed] = useState(true)
  const [transcriptId, setTranscriptId] = useState('')
  const [colorMode, setColorMode] = useState('exons')
  const [resolution, setResolution] = useState(null)
  const [residueMap, setResidueMap] = useState(null)
  const [loadState, setLoadState] = useState('idle') // idle | resolving | loading | ready | error
  const [errorMessage, setErrorMessage] = useState('')
  const [accessionDraft, setAccessionDraft] = useState('')
  const [hoveredExon, setHoveredExon] = useState(null)
  const [lockedExons, setLockedExons] = useState(() => new Set())
  const [clickedResidue, setClickedResidue] = useState(null)
  const [mappingStatus, setMappingStatus] = useState(null)
  const [viewerReady, setViewerReady] = useState(false)
  const [spinning, setSpinning] = useState(false)
  const [openSections, setOpenSections] = useState({ exons: true, variants: false })

  const [probe, setProbe] = useState(null)
  const [probing, setProbing] = useState(false)

  const [vcfTracks, setVcfTracks] = useState([])
  const [selectedTrackIds, setSelectedTrackIds] = useState(() => new Set())
  const [variantData, setVariantData] = useState(null)
  const [variantsLoading, setVariantsLoading] = useState(false)
  // A population VCF can put a variant on most of the coding sequence, which
  // paints the whole fold one colour. Hiding a class is how the reader gets back
  // to the handful that matter.
  const [hiddenImpacts, setHiddenImpacts] = useState(() => new Set())

  const frameRef = useRef(null)
  const bridgeRef = useRef(null)
  const requestTokenRef = useRef(0)
  const variantTokenRef = useRef(0)
  // What the last started request was for. StrictMode double-invokes effects in
  // development, and two concurrent load commands would race inside Mol*; the
  // request token alone keeps React state honest but does not stop the second
  // command from being sent.
  const inFlightKeyRef = useRef('')
  const probeKeyRef = useRef('')

  // Only coding transcripts have anything to show here.
  const codingIds = useMemo(() => (
    displayOrderIds.filter((id) => {
      const tx = transcriptById.get(id)
      return tx && Array.isArray(tx.cds_list) && tx.cds_list.length > 0
    })
  ), [displayOrderIds, transcriptById])

  const canonicalId = useMemo(() => (
    codingIds.find((id) => transcriptById.get(id)?.is_canonical) || ''
  ), [codingIds, transcriptById])

  // ── Which transcripts are worth offering ──────────────────────────────────

  const probeByTranscript = useMemo(() => (
    new Map((probe?.entries || []).map((entry) => [entry.transcript_id, entry]))
  ), [probe])

  /**
   * The dropdown's contents.
   *
   * Before the probe answers, and whenever it could not answer, this falls back
   * to the canonical transcript alone rather than offering options that lead to
   * a dead end. A transcript the probe could not check is kept: not being able
   * to rule it out is not the same as knowing it has nothing.
   */
  const offeredIds = useMemo(() => {
    const fallback = canonicalId ? [canonicalId] : codingIds.slice(0, 1)
    if (!probe) return fallback
    if (probe.mode === 'canonical_only') return fallback
    const usable = codingIds.filter((id) => {
      const status = probeByTranscript.get(id)?.status
      return status === 'ok' || status === 'unknown'
    })
    return usable.length > 0 ? usable : fallback
  }, [probe, probeByTranscript, codingIds, canonicalId])

  // Whatever is on screen stays selectable even if the probe would not have
  // offered it — a manually entered accession is a legitimate reason to be
  // looking at a transcript this panel could not resolve on its own.
  const dropdownIds = useMemo(() => (
    transcriptId && !offeredIds.includes(transcriptId)
      ? [transcriptId, ...offeredIds]
      : offeredIds
  ), [offeredIds, transcriptId])

  useEffect(() => {
    if (transcriptId && codingIds.includes(transcriptId)) return
    const active = codingIds.find((id) => activeTranscriptIds.has(id))
    setTranscriptId(active || canonicalId || codingIds[0] || '')
  }, [codingIds, activeTranscriptIds, canonicalId, transcriptId])

  // Once the probe lands, move off a transcript it has ruled out.
  useEffect(() => {
    if (!probe || !transcriptId || accessionDraft) return
    const status = probeByTranscript.get(transcriptId)?.status
    if (!status || status === 'ok' || status === 'unknown') return
    const next = offeredIds.includes(canonicalId) ? canonicalId : offeredIds[0]
    if (next && next !== transcriptId) setTranscriptId(next)
  }, [probe, probeByTranscript, transcriptId, offeredIds, canonicalId, accessionDraft])

  useEffect(() => {
    setResolution(null)
    setResidueMap(null)
    setErrorMessage('')
    setClickedResidue(null)
    setLoadState('idle')
    setAccessionDraft('')
    setLockedExons(new Set())
    setProbe(null)
    setVariantData(null)
    probeKeyRef.current = ''
  }, [resolvedGene?.id])

  // ── Viewer bridge ─────────────────────────────────────────────────────────

  const handleViewerEvent = useCallback((type, payload) => {
    if (type === 'ready') {
      setViewerReady(true)
      return
    }
    if (type === 'loadError') {
      setLoadState('error')
      setErrorMessage(payload?.message || 'The structure could not be displayed.')
      return
    }
    if (type === 'residueClick') {
      setClickedResidue(Number(payload?.residue) || null)
    }
  }, [])

  useEffect(() => {
    const bridge = createStructureViewerBridge({ onEvent: handleViewerEvent })
    bridgeRef.current = bridge
    return () => {
      bridge.dispose()
      bridgeRef.current = null
      setViewerReady(false)
    }
  }, [handleViewerEvent])

  // The iframe unmounts with the panel, so reopening it gives a viewer that has
  // forgotten everything the last one was doing.
  useEffect(() => {
    if (collapsed) {
      setSpinning(false)
      return
    }
    bridgeRef.current?.attach(frameRef.current)
  }, [collapsed])

  useEffect(() => {
    if (!viewerReady) return
    bridgeRef.current?.setTheme(isLight ? 'light' : 'dark').catch(() => {})
  }, [isLight, viewerReady])

  // ── Resolve, load, map ────────────────────────────────────────────────────

  const runResolve = useCallback(async (overrideAccession = '') => {
    if (!transcriptId || collapsed) return

    const key = `${sequenceGenome}|${transcriptId}|${overrideAccession}`
    if (key === inFlightKeyRef.current) return
    inFlightKeyRef.current = key
    const token = (requestTokenRef.current += 1)

    setLoadState('resolving')
    setErrorMessage('')
    setResidueMap(null)
    setClickedResidue(null)
    setLockedExons(new Set())

    try {
      const response = await fetch(`${API_BASE}/api/structure/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genome: sequenceGenome || 'reference',
          transcript_id: transcriptId,
          accession_override: overrideAccession,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (token !== requestTokenRef.current) return
      if (!response.ok) throw new Error(data?.detail || 'Structure lookup failed.')

      setResolution(data)
      if (data.status !== 'ok' || !data.model?.model_url) {
        setLoadState('error')
        setErrorMessage(data.message || 'No structure is available for this transcript.')
        return
      }

      setLoadState('loading')
      await bridgeRef.current?.load({
        modelUrl: structureModelUrl(data.model.model_url),
        theme: isLight ? 'light' : 'dark',
        alphafoldView: true,
      })
      if (token !== requestTokenRef.current) return
      setLoadState('ready')

      const mapResponse = await fetch(`${API_BASE}/api/structure/residue_map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genome: sequenceGenome || 'reference',
          transcript_id: transcriptId,
          accession: data.uniprot_accession,
        }),
      })
      const mapData = await mapResponse.json().catch(() => ({}))
      if (token !== requestTokenRef.current) return
      if (mapResponse.ok) setResidueMap(mapData)
    } catch (error) {
      if (token !== requestTokenRef.current) return
      setLoadState('error')
      setErrorMessage(error?.message || 'Structure lookup failed.')
    } finally {
      if (token === requestTokenRef.current) inFlightKeyRef.current = ''
    }
  }, [transcriptId, sequenceGenome, collapsed, isLight])

  useEffect(() => {
    if (collapsed || !viewerReady || !transcriptId) return
    runResolve('')
    // runResolve is recreated whenever its inputs change, which is exactly when
    // a reload is wanted; adding it as a dependency would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, viewerReady, transcriptId, sequenceGenome])

  // Probe every coding transcript once per gene, alongside the load above rather
  // than in front of it: the first structure should appear without waiting on a
  // dozen accession lookups.
  useEffect(() => {
    if (collapsed || codingIds.length === 0) return
    const key = `${sequenceGenome}|${codingIds.join(',')}`
    if (key === probeKeyRef.current) return
    probeKeyRef.current = key

    let cancelled = false
    setProbing(true)
    fetch(`${API_BASE}/api/structure/transcripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genome: sequenceGenome || 'reference', transcript_ids: codingIds }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (!cancelled && data) setProbe(data) })
      .catch(() => { if (!cancelled) setProbe({ mode: 'canonical_only', entries: [], message: '' }) })
      .finally(() => { if (!cancelled) setProbing(false) })

    return () => { cancelled = true }
  }, [collapsed, sequenceGenome, codingIds])

  const exonSummary = useMemo(() => summariseExons(residueMap?.segments), [residueMap])
  const model = resolution?.model || null

  // ── Variant tracks ────────────────────────────────────────────────────────

  // Only VCFs registered against the assembly in view. A track carrying no
  // assembly cannot be checked against this genome, so it is left out rather
  // than plotted on a guess.
  useEffect(() => {
    if (collapsed) return undefined
    let cancelled = false
    fetch(`${API_BASE}/api/tracks`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const eligible = (data.tracks || []).filter((track) => (
          track?.type === 'vcf'
          && String(track?.genome_key || '').trim()
          && genomeKeysMatch(track.genome_key, sequenceGenome)
        ))
        setVcfTracks(eligible)
        setSelectedTrackIds((prev) => {
          const allowed = new Set(eligible.map((track) => track.id))
          const next = new Set([...prev].filter((id) => allowed.has(id)))
          return next.size === prev.size ? prev : next
        })
      })
      .catch(() => { if (!cancelled) setVcfTracks([]) })
    return () => { cancelled = true }
  }, [collapsed, sequenceGenome])

  const selectedTrackList = useMemo(() => (
    vcfTracks.filter((track) => selectedTrackIds.has(track.id)).map((track) => track.id)
  ), [vcfTracks, selectedTrackIds])

  useEffect(() => {
    const accession = resolution?.uniprot_accession || ''
    if (collapsed || loadState !== 'ready' || !accession || selectedTrackList.length === 0) {
      setVariantData(null)
      return
    }
    const token = (variantTokenRef.current += 1)
    setVariantsLoading(true)
    fetch(`${API_BASE}/api/structure/variants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        genome: sequenceGenome || 'reference',
        transcript_id: transcriptId,
        accession,
        track_ids: selectedTrackList,
      }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (token === variantTokenRef.current) setVariantData(data) })
      .catch(() => { if (token === variantTokenRef.current) setVariantData(null) })
      .finally(() => { if (token === variantTokenRef.current) setVariantsLoading(false) })
  }, [collapsed, loadState, resolution?.uniprot_accession, sequenceGenome, transcriptId, selectedTrackList])

  const allVariants = useMemo(() => (
    (variantData?.tracks || []).flatMap((track) => track.variants || [])
  ), [variantData])

  const impactSummary = useMemo(() => summariseVariantImpacts(allVariants), [allVariants])

  const shownVariants = useMemo(() => (
    hiddenImpacts.size === 0
      ? allVariants
      : allVariants.filter((variant) => !hiddenImpacts.has(variant.impact))
  ), [allVariants, hiddenImpacts])

  const variantsShown = shownVariants.length > 0

  // ── Painting ──────────────────────────────────────────────────────────────

  const plainSegments = useMemo(() => {
    if (!model) return []
    return [{
      start: model.sequence_start,
      end: model.sequence_end,
      color: PLAIN_COLOR[mode],
    }]
  }, [model, mode])

  const paintSegments = useMemo(() => {
    if (colorMode !== 'exons') return null
    return buildPaintSegments(residueMap?.segments, exonSummary, mode, {
      lockedExons,
      dim: variantsShown,
    })
  }, [colorMode, residueMap, exonSummary, mode, lockedExons, variantsShown])

  const overlays = useMemo(() => {
    if (!variantsShown) return []
    const bounds = model ? { start: model.sequence_start, end: model.sequence_end } : null
    return buildVariantOverlays(shownVariants, mode, bounds)
  }, [variantsShown, shownVariants, mode, model])

  // Repaint whenever the overlay, the mapping, the locks or the theme change.
  useEffect(() => {
    if (loadState !== 'ready' || !viewerReady) return
    const bridge = bridgeRef.current
    if (!bridge) return

    if (colorMode === 'exons' && paintSegments?.length) {
      bridge.colorSegments({
        segments: paintSegments,
        overlays,
        nonSelectedColor: UNMAPPED_COLOR[mode],
      }).catch(() => {})
      return
    }
    if (colorMode === 'none' && plainSegments.length) {
      // A single flat colour across the whole chain. Clearing would restore the
      // AlphaFold preset instead, which is what Confidence already shows.
      bridge.colorSegments({
        segments: plainSegments,
        overlays,
        nonSelectedColor: PLAIN_COLOR[mode],
      }).catch(() => {})
      return
    }
    if (overlays.length) {
      // Confidence colouring with variants on top. Only the variant residues are
      // listed and no non-selected colour is given, so every other residue keeps
      // the pLDDT preset underneath.
      bridge.colorSegments({ segments: [], overlays, nonSelectedColor: null }).catch(() => {})
      return
    }
    // Clearing restores the AlphaFold preset, which is the pLDDT colouring.
    bridge.clearColors().catch(() => {})
  }, [loadState, viewerReady, colorMode, paintSegments, plainSegments, overlays, mode])

  // ── Screenshot ────────────────────────────────────────────────────────────
  // The Feature Explorer captures panels by serialising the DOM into an SVG
  // foreignObject, which renders a WebGL canvas as an empty rectangle. The
  // viewer hands back a raster instead, which is spliced in over the iframe.
  const buildExportSnapshot = useCallback(async (node) => {
    const shot = await bridgeRef.current?.screenshot()
    return { canvasDataUri: shot?.dataUri || '', node }
  }, [])

  useEffect(() => {
    if (typeof onRegisterScreenshot !== 'function') return undefined
    onRegisterScreenshot(buildExportSnapshot)
    return () => onRegisterScreenshot(null)
  }, [onRegisterScreenshot, buildExportSnapshot])

  // ── Mapping file ──────────────────────────────────────────────────────────

  const refreshMappingStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/structure/mapping`)
      if (!response.ok) return
      setMappingStatus(await response.json())
    } catch {
      /* the panel works without it */
    }
  }, [])

  useEffect(() => {
    if (!collapsed) refreshMappingStatus()
  }, [collapsed, refreshMappingStatus])

  // ── Interaction ───────────────────────────────────────────────────────────

  const handleExonHover = useCallback((exon) => {
    setHoveredExon(exon ? exon.exonIndex : null)
    const bridge = bridgeRef.current
    if (!bridge || loadState !== 'ready') return
    if (!exon) bridge.clearHighlight().catch(() => {})
    else bridge.highlight({ start: exon.modelStart, end: exon.modelEnd }).catch(() => {})
  }, [loadState])

  const toggleExonLock = useCallback((exon) => {
    setLockedExons((prev) => {
      const next = new Set(prev)
      if (next.has(exon.exonIndex)) next.delete(exon.exonIndex)
      else next.add(exon.exonIndex)
      return next
    })
  }, [])

  const focusRanges = useCallback((exons) => {
    if (loadState !== 'ready' || exons.length === 0) return
    bridgeRef.current?.focus({
      ranges: exons.map((exon) => ({ start: exon.modelStart, end: exon.modelEnd })),
    }).catch(() => {})
  }, [loadState])

  const toggleTrack = useCallback((trackId) => {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  const toggleImpact = useCallback((impact) => {
    setHiddenImpacts((prev) => {
      const next = new Set(prev)
      if (next.has(impact)) next.delete(impact)
      else next.add(impact)
      return next
    })
  }, [])

  const toggleAllTracks = useCallback(() => {
    setSelectedTrackIds((prev) => (
      prev.size === vcfTracks.length ? new Set() : new Set(vcfTracks.map((track) => track.id))
    ))
  }, [vcfTracks])

  const toggleSection = useCallback((key) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // ── Styling shorthands ────────────────────────────────────────────────────
  const panelBorderClass = isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'
  const headerBorderClass = isLight ? 'border-gray-200' : 'border-gray-700'
  const titleClass = isLight ? 'text-gray-800' : 'text-gray-100'
  const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const bodyTextClass = isLight ? 'text-gray-700' : 'text-gray-200'
  const btnActive = isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80'
  const btnInactive = isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
  const inputClass = isLight
    ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
    : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
  const collapseToggleClass = isLight
    ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
  const miniButtonClass = `px-1.5 py-0.5 rounded text-[10px] font-semibold border ${btnInactive}`

  if (!resolvedGene) return null

  const palette = EXON_ALTERNATING_COLORS[mode]
  const variantPalette = VARIANT_IMPACT_COLORS[mode]
  const clickedExon = exonAtResidue(exonSummary, clickedResidue)
  const clickedVariants = clickedResidue == null
    ? []
    : allVariants.filter((variant) => variant.model_residue === clickedResidue)
  const lockedList = exonSummary.filter((exon) => lockedExons.has(exon.exonIndex))
  const truncated = (variantData?.tracks || []).some((track) => track.truncated)

  return (
    <div ref={containerRef} className={`rounded-xl border overflow-hidden ${panelBorderClass}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setCollapsed((prev) => !prev)
          }
        }}
        className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${headerBorderClass}`}
      >
        <div className={`text-sm font-semibold ${titleClass}`}>Structure</div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setCollapsed((prev) => !prev)
          }}
          className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${collapseToggleClass}`}
          title={collapsed ? 'Expand structure panel' : 'Collapse structure panel'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div className="p-3 space-y-3">
          {/* ── Toolbar ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={transcriptId}
              onChange={(event) => setTranscriptId(event.target.value)}
              className={`px-2 py-1 rounded text-[11px] border font-mono ${inputClass}`}
              title="Transcripts with an AlphaFold model"
            >
              {dropdownIds.length === 0 && <option value="">No coding transcripts</option>}
              {dropdownIds.map((id) => {
                const entry = probeByTranscript.get(id)
                const parts = [id]
                if (transcriptById.get(id)?.is_canonical) parts.push('canonical')
                if (entry?.accession) parts.push(entry.accession)
                return <option key={id} value={id}>{parts.join(' · ')}</option>
              })}
            </select>

            <div className="flex items-center gap-1">
              {COLOR_MODES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setColorMode(item.key)}
                  disabled={item.key === 'exons' && !residueMap?.segments?.length}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${colorMode === item.key ? btnActive : btnInactive} disabled:opacity-40 disabled:cursor-not-allowed`}
                  title={item.title}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => bridgeRef.current?.reset().catch(() => {})}
              disabled={loadState !== 'ready'}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${btnInactive} disabled:opacity-40 disabled:cursor-not-allowed`}
              title="Reset the camera"
            >
              Reset view
            </button>

            <button
              type="button"
              onClick={() => {
                const next = !spinning
                setSpinning(next)
                bridgeRef.current?.spin(next).catch(() => setSpinning(!next))
              }}
              disabled={loadState !== 'ready'}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${spinning ? btnActive : btnInactive} disabled:opacity-40 disabled:cursor-not-allowed`}
              title={spinning ? 'Stop rotating the model' : 'Rotate the model continuously'}
            >
              Spin
            </button>

            {probing && <span className={`text-[11px] ${mutedClass}`}>Checking transcripts…</span>}
          </div>

          {/* ── Provenance ──────────────────────────────────────────────── */}
          {model && (
            <div className={`text-[11px] ${mutedClass} flex flex-wrap items-center gap-x-3 gap-y-1`}>
              <span className={`font-mono ${bodyTextClass}`}>{resolution.uniprot_accession}</span>
              <span>via {SOURCE_LABELS[resolution.source] || resolution.source}</span>
              <span>model v{model.version}</span>
              <span>{model.sequence_length} aa modelled · {resolution.protein_length} aa translated</span>
              {resolution.protein_id && <span className="font-mono">{resolution.protein_id}</span>}
            </div>
          )}

          {probe?.message && (
            <div className={`text-[11px] ${mutedClass}`}>{probe.message}</div>
          )}

          {/* Isoform mismatch is stated, never smoothed over: an exon overlay on a
              model of a different sequence is only as good as the alignment. */}
          {residueMap && !residueMap.identical && residueMap.warnings?.length > 0 && (
            <div className={`text-[11px] rounded border px-2.5 py-2 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-500/10 border-amber-500/40 text-amber-200'}`}>
              {residueMap.warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          )}

          {variantData?.warnings?.length > 0 && (
            <div className={`text-[11px] rounded border px-2.5 py-2 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-500/10 border-amber-500/40 text-amber-200'}`}>
              {variantData.warnings.map((warning) => <div key={warning}>{warning}</div>)}
            </div>
          )}

          {(loadState === 'error' || errorMessage) && (
            <div className={`text-[11px] rounded border px-2.5 py-2 ${isLight ? 'bg-red-50 border-red-200 text-red-800' : 'bg-red-500/10 border-red-500/40 text-red-200'}`}>
              {errorMessage}
            </div>
          )}

          {/* ── Viewer and side column ──────────────────────────────────── */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 260px' }}>
            <div className={`relative rounded-lg border overflow-hidden ${headerBorderClass}`} style={{ height: 420 }}>
              {/* allow-same-origin keeps the frame on the backend's origin rather
                  than an opaque one. It needs that for two reasons: its own CSP
                  restricts it to connect-src 'self', which matches nothing from an
                  opaque origin, and postMessage from an opaque origin arrives as
                  "null", which the bridge cannot distinguish from any other
                  sandboxed frame. It is safe here precisely because that origin is
                  not the app's: the pairing is only dangerous when the framed page
                  is same-origin with its embedder and could clear its own sandbox.
                  Everything else stays denied — no popups, no top-level navigation,
                  no forms, no downloads. */}
              <iframe
                ref={frameRef}
                title="Protein structure viewer"
                src={structureViewerUrl()}
                sandbox="allow-scripts allow-same-origin"
                className="w-full h-full block border-0"
                onLoad={() => bridgeRef.current?.attach(frameRef.current)}
              />
              {(loadState === 'resolving' || loadState === 'loading') && (
                <div className={`absolute inset-0 flex items-center justify-center text-[12px] ${mutedClass} ${isLight ? 'bg-white/70' : 'bg-gray-900/70'}`}>
                  {loadState === 'resolving' ? 'Finding a structure…' : 'Loading structure…'}
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-2 max-h-[420px] overflow-y-auto pr-0.5">
              <StructureSection
                title="Coding exons"
                badge={exonSummary.length || null}
                open={openSections.exons}
                onToggle={() => toggleSection('exons')}
                isLight={isLight}
                actions={lockedExons.size > 0 ? (
                  <div className="flex items-center gap-1 pr-1.5">
                    <button
                      type="button"
                      className={miniButtonClass}
                      onClick={() => focusRanges(lockedList)}
                      title="Frame the locked exons"
                    >
                      Focus
                    </button>
                    <button
                      type="button"
                      className={miniButtonClass}
                      onClick={() => setLockedExons(new Set())}
                      title="Unlock every exon"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
              >
                {exonSummary.length === 0 ? (
                  <div className={`text-[11px] ${mutedClass}`}>
                    {loadState === 'ready' ? 'No exon mapping available.' : '—'}
                  </div>
                ) : (
                  // The list scrolls inside the section rather than pushing the
                  // sections below it off the column: a transcript with thirty
                  // coding exons would otherwise hide the Variants header
                  // entirely, and nothing would suggest it was there.
                  <div className="space-y-0.5 max-h-[210px] overflow-y-auto pr-1">
                    {exonSummary.map((exon, position) => {
                      const locked = lockedExons.has(exon.exonIndex)
                      const base = palette[position % palette.length]
                      // The swatch mutes exactly as the model does, so the list
                      // and the structure never disagree about what is emphasised.
                      const dimmed = (lockedExons.size > 0 && !locked) || (variantsShown && !locked)
                      return (
                        <div
                          key={exon.exonIndex}
                          onMouseEnter={() => handleExonHover(exon)}
                          onMouseLeave={() => handleExonHover(null)}
                          className={`flex items-center gap-1.5 rounded transition-colors ${
                            hoveredExon === exon.exonIndex ? (isLight ? 'bg-gray-100' : 'bg-gray-700/70') : ''
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleExonLock(exon)}
                            className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 text-left text-[11px]"
                            title={`${locked ? 'Unlock' : 'Lock'} exon ${position + 1} · residues ${formatRange(exon.modelStart, exon.modelEnd)}${exon.genomicStart ? ` · ${exon.genomicStart.toLocaleString()}–${(exon.genomicEnd || exon.genomicStart).toLocaleString()}` : ''}`}
                          >
                            <span
                              className="w-2.5 h-2.5 rounded-sm shrink-0"
                              style={{ backgroundColor: rgbCss(dimmed ? mutedColor(base, mode) : base) }}
                              aria-hidden="true"
                            />
                            <span className={`shrink-0 tabular-nums ${bodyTextClass}`}>{position + 1}</span>
                            <span className={`truncate tabular-nums ${mutedClass}`}>
                              aa {formatRange(exon.aaStart, exon.aaEnd)}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => focusRanges([exon])}
                            className={`shrink-0 px-1 py-1 ${mutedClass} hover:${isLight ? 'text-gray-800' : 'text-gray-100'}`}
                            title={`Frame exon ${position + 1}`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                              <circle cx="12" cy="12" r="7" />
                              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                            </svg>
                          </button>
                          <span className="shrink-0 w-4 flex items-center justify-center">
                            {locked && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                style={{ color: isLight ? '#0099ff' : '#60a5fa' }}
                                aria-label={`Exon ${position + 1} locked`}
                                role="img"
                              >
                                <path d={LOCKED_ICON_PATH} />
                              </svg>
                            )}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </StructureSection>

              {vcfTracks.length > 0 && (
                <StructureSection
                  title="Variants"
                  badge={
                    hiddenImpacts.size > 0 && allVariants.length
                      ? `${shownVariants.length}/${allVariants.length}`
                      : (allVariants.length || null)
                  }
                  open={openSections.variants}
                  onToggle={() => toggleSection('variants')}
                  isLight={isLight}
                >
                  <div className="space-y-1.5">
                    <label className={`flex items-center gap-1.5 text-[11px] ${bodyTextClass}`}>
                      <input
                        type="checkbox"
                        checked={selectedTrackIds.size === vcfTracks.length && vcfTracks.length > 0}
                        onChange={toggleAllTracks}
                      />
                      <span>All variants</span>
                    </label>
                    {vcfTracks.map((track) => {
                      const result = (variantData?.tracks || []).find((item) => item.track_id === track.id)
                      return (
                        <label key={track.id} className={`flex items-center gap-1.5 text-[11px] ${bodyTextClass}`}>
                          <input
                            type="checkbox"
                            checked={selectedTrackIds.has(track.id)}
                            onChange={() => toggleTrack(track.id)}
                          />
                          <span className="truncate" title={track.label || track.id}>{track.label || track.id}</span>
                          {result && (
                            <span className={`shrink-0 tabular-nums ${mutedClass}`}>
                              {result.status === 'ok' ? result.variants.length : '!'}
                            </span>
                          )}
                        </label>
                      )
                    })}

                    {variantsLoading && <div className={`text-[11px] ${mutedClass}`}>Reading variants…</div>}

                    {(variantData?.tracks || [])
                      .filter((track) => track.status !== 'ok')
                      .map((track) => (
                        <div key={track.track_id} className={`text-[11px] ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                          {track.label || track.track_id}: {track.message}
                        </div>
                      ))}

                    {impactSummary.length > 0 && (
                      <div className={`pt-1.5 border-t ${headerBorderClass} space-y-0.5`}>
                        {impactSummary.map((entry) => {
                          const hidden = hiddenImpacts.has(entry.impact)
                          return (
                            <button
                              key={entry.impact}
                              type="button"
                              onClick={() => toggleImpact(entry.impact)}
                              className={`w-full flex items-center gap-2 px-0.5 py-0.5 rounded text-left text-[11px] ${bodyTextClass} ${hidden ? 'opacity-40' : ''} ${isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-700/60'}`}
                              title={`${hidden ? 'Show' : 'Hide'} ${VARIANT_IMPACT_LABELS[entry.impact].toLowerCase()} variants`}
                            >
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{
                                  backgroundColor: hidden ? 'transparent' : rgbCss(variantPalette[entry.impact]),
                                  border: `1.5px solid ${rgbCss(variantPalette[entry.impact])}`,
                                }}
                                aria-hidden="true"
                              />
                              <span className="truncate">{VARIANT_IMPACT_LABELS[entry.impact]}</span>
                              <span className={`ml-auto tabular-nums ${mutedClass}`}>{entry.count}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {truncated && (
                      <div className={`text-[11px] ${mutedClass}`}>
                        Showing the first variants only — the coding region holds more than the viewer plots.
                      </div>
                    )}

                    {variantsShown && (
                      <div className={`text-[10px] ${mutedClass}`}>
                        Marks span one residue either side so a single variant stays visible;
                        consequences are computed from the codon, not read from a CSQ or ANN field.
                      </div>
                    )}
                  </div>
                </StructureSection>
              )}

              {clickedResidue != null && (
                <div className={`rounded-md border px-2 py-1.5 text-[11px] ${headerBorderClass} ${mutedClass}`}>
                  <div className={bodyTextClass}>Residue {clickedResidue}</div>
                  {clickedExon
                    ? <div>Exon {exonSummary.indexOf(clickedExon) + 1}</div>
                    : <div>Outside the mapped region</div>}
                  {clickedVariants.map((variant) => (
                    <div key={`${variant.track_id}-${variant.pos}-${variant.alt}`} className="truncate">
                      {variant.chrom}:{variant.pos.toLocaleString()} {variant.ref}&gt;{variant.alt}
                      {' · '}{CONSEQUENCE_LABELS[variant.consequence] || variant.consequence}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Manual accession and mapping file ───────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={accessionDraft}
              onChange={(event) => setAccessionDraft(event.target.value)}
              placeholder="UniProt accession"
              className={`px-2 py-1 rounded text-[11px] border font-mono w-40 ${inputClass}`}
              title="Load a specific AlphaFold model instead of the one found automatically"
            />
            <button
              type="button"
              onClick={() => runResolve(accessionDraft.trim())}
              disabled={!accessionDraft.trim()}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${btnInactive} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Use accession
            </button>
            {accessionDraft && (
              <button
                type="button"
                onClick={() => { setAccessionDraft(''); runResolve('') }}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${btnInactive}`}
              >
                Clear
              </button>
            )}
            <span className={`text-[11px] ${mutedClass}`}>
              {mappingStatus?.configured
                ? `Mapping file: ${mappingStatus.entry_count.toLocaleString()} entries`
                : 'No mapping file imported'}
            </span>
          </div>

          <div className={`text-[10px] ${mutedClass}`}>
            Structure predictions from{' '}
            {model?.afdb_url
              ? <a href={model.afdb_url} target="_blank" rel="noreferrer" className="underline">AlphaFold DB</a>
              : 'AlphaFold DB'}
            {' '}(CC BY 4.0), rendered with Mol* / PDBe Mol*.
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { trackAchievement } from '../achievements/tracker.js'
import { API_BASE } from '../backendRuntime'
import GenomeAnalysisOverview from './GenomeAnalysisOverview'
import { useResumableState } from '../hooks/useResumableState.js'
import {
  STRUCTURAL_PENDING_STATUSES,
  STRUCTURAL_SELECTABLE_STATUSES,
  SUMMARY_CORE_SECTIONS,
  buildErrorRecord,
  buildPlaceholderRecord,
  genomeKeyFromInput,
  genomeLabel,
  normalizeGenomeInput,
  structuralDisplayStatus,
} from './stats/statsModel.js'
import {
  ZoomOutButton,
} from './stats/ZoomOutButton.jsx'
import {
  AnnotationChart,
} from './stats/AnnotationChart.jsx'
import {
  AnnotationSankey,
} from './stats/AnnotationSankey.jsx'
import {
  AnnotationDetails,
} from './stats/AnnotationDetails.jsx'
import {
  StructuralHeatmap,
} from './stats/StructuralHeatmap.jsx'
import {
  StructuralClusterPlot,
} from './stats/StructuralClusterPlot.jsx'
import {
  HomologyScatter,
} from './stats/HomologyScatter.jsx'

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

  const [mode, setMode] = useResumableState('stats.mode', 'overview', { isValid: (value) => typeof value === 'string' })
  const [annotationBasis, setAnnotationBasis] = useResumableState('stats.annotationBasis', 'genes', { isValid: (value) => typeof value === 'string' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [records, setRecords] = useState([])
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 })
  // A summary read from saved stats is back in a few milliseconds; the note only
  // appears once it has taken long enough to be worth explaining.
  const [loadingIsSlow, setLoadingIsSlow] = useState(false)
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

  // Keyed on what the genomes are rather than on the config object, which is
  // replaced several times as the app starts up and settles. Each replacement used
  // to fetch the summary again, and a genome whose stats are being calculated for
  // the first time would be calculated once per fetch.
  const genomesSignature = JSON.stringify(
    (config?.active_species || []).map((item) => normalizeGenomeInput(item))
  )
  const genomes = useMemo(() => JSON.parse(genomesSignature), [genomesSignature])

  const genomeOrder = useMemo(() => genomes.map((g) => genomeKeyFromInput(g)), [genomes])
  const placeholdersByKey = useMemo(() => {
    const m = new Map()
    for (const genome of genomes) {
      const placeholder = buildPlaceholderRecord(genome)
      m.set(placeholder.genome_key, placeholder)
    }
    return m
  }, [genomes])

  // One request per genome rather than one for them all, so each genome's sections
  // fill in as soon as its own stats are back, and the count of genomes ready is a
  // real count. A genome reads its saved stats, or calculates them from its files
  // the first time (or after they change), which is what can take a while.
  const fetchSummary = useCallback(async (silent = false) => {
    const requestSeq = requestSeqRef.current + 1
    requestSeqRef.current = requestSeq

    if (!genomes.length) {
      setRecords([])
      setError('')
      setLoading(false)
      setLoadProgress({ done: 0, total: 0 })
      return
    }

    setError('')
    if (!silent) {
      setLoading(true)
      setLoadProgress({ done: 0, total: genomes.length })
      setRecords(genomes.map((g) => buildPlaceholderRecord(g)))
    }

    let done = 0
    let anyReady = false
    let firstError = ''
    await Promise.all(genomes.map(async (genome) => {
      const key = genomeKeyFromInput(genome)
      let record
      try {
        const res = await fetch(`${API_BASE}/api/stats/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genomes: [genome],
            sections: summarySections,
            structural_profile: 'canonical_coding',
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to load stats summary.')
        const returned = (Array.isArray(data?.records) ? data.records : []).filter((r) => r && r.genome_key)
        record = returned.find((r) => r.genome_key === key) || returned[0] || buildErrorRecord(genome, 'Missing stats record.')
        anyReady = anyReady || returned.length > 0
      } catch (e) {
        firstError = firstError || e?.message || 'Failed to load stats summary.'
        record = buildErrorRecord(genome, e?.message || 'Failed to load stats for genome.')
      }
      if (requestSeqRef.current !== requestSeq) return
      done += 1
      setRecords((prev) => {
        const byKey = new Map(prev.map((r) => [r.genome_key, r]))
        byKey.set(key, record)
        return genomeOrder.map((k) => byKey.get(k) || placeholdersByKey.get(k)).filter(Boolean)
      })
      if (!silent) setLoadProgress({ done, total: genomes.length })
    }))

    if (requestSeqRef.current !== requestSeq) return
    if (anyReady) trackAchievement('stats.summary')
    if (firstError) setError(firstError)
    setLoading(false)
  }, [genomes, genomeOrder, placeholdersByKey, summarySections])

  useEffect(() => {
    if (!loading) {
      setLoadingIsSlow(false)
      return undefined
    }
    const timer = window.setTimeout(() => setLoadingIsSlow(true), 400)
    return () => window.clearTimeout(timer)
  }, [loading])

  useEffect(() => {
    fetchSummary(false)
  }, [fetchSummary])

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
  // How far the running genome has got, from the backend's own count of transcripts
  // worked through. Null until the run has actually started on it.
  const runningResult = structuralRunningGenomeKey ? (taskState?.results || {})[structuralRunningGenomeKey] : null
  const runningProgress = Number.isFinite(Number(runningResult?.progress)) && runningResult?.progress != null
    ? Math.max(0, Math.min(1, Number(runningResult.progress)))
    : null
  const runningRecord = structuralRunningGenomeKey
    ? records.find((r) => r.genome_key === structuralRunningGenomeKey)
    : null
  const generatingLabel = runningProgress == null ? 'Generating' : `Generating ${Math.round(runningProgress * 100)}%`
  const summaryPendingLabels = records
    .filter((r) => Object.values(r?.statuses || {}).includes('loading'))
    .map((r) => genomeLabel(r))

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

        {/* Only on the tabs that read the summary: the overview reads the stored
            analysis reports, so a note about the summary there explains nothing. */}
        {loading && loadingIsSlow && mode !== 'overview' && summaryPendingLabels.length > 0 && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${isLight ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-blue-900/20 text-blue-300 border-blue-700/40'}`}>
            <div>
              <span className="font-semibold">Working on {summaryPendingLabels.join(', ')}</span>
              <span className="ml-2 opacity-80">{loadProgress.done} of {loadProgress.total} genomes ready</span>
            </div>
            <div className="mt-0.5 opacity-80">
              Reading their saved annotation and homology stats, or calculating them from the genome&apos;s files
              if this is the first time it has been opened here. Their sections fill in as each one finishes.
            </div>
          </div>
        )}

        {(isGenerating || structuralQueue.length > 0) && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${isLight ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-blue-900/20 text-blue-300 border-blue-700/40'}`}>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-semibold flex-none">Structural stats:</span>
              <span className="truncate">
                {structuralRunningGenomeKey
                  ? `${runningRecord ? genomeLabel(runningRecord) : 'Genome'} — ${runningResult?.message || 'Starting…'}`
                  : 'Starting the next genome in the queue…'}
              </span>
              {runningProgress != null && (
                <span className="flex-none tabular-nums font-semibold">{Math.round(runningProgress * 100)}%</span>
              )}
              {structuralQueue.length > 0 && (
                <span className="flex-none ml-auto opacity-80">{structuralQueue.length} more queued</span>
              )}
            </div>
            {structuralRunningGenomeKey && (
              <div className={`mt-1.5 h-1 rounded-full overflow-hidden ${isLight ? 'bg-blue-100' : 'bg-blue-950/60'}`}>
                {runningProgress == null ? (
                  // Before the first count arrives: say it is working, without
                  // pretending to know how far it has got.
                  <div className={`h-full w-1/4 rounded-full animate-pulse ${isLight ? 'bg-[#0099ff]' : 'bg-blue-500'}`} />
                ) : (
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${isLight ? 'bg-[#0099ff]' : 'bg-blue-500'}`}
                    style={{ width: `${Math.max(2, runningProgress * 100)}%` }}
                  />
                )}
              </div>
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
                generatingLabel={generatingLabel}
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
                            if (runtime === 'running') return generatingLabel
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

import { useState, useEffect, useCallback } from 'react'
import { API_BASE } from '../backendRuntime'
import { genomeKeyCandidates, getGenomeKey } from '../utils/genomeIdentity'

function speciesItemKey(species) {
  return getGenomeKey(species)
}

function formatDate(isoStr) {
  if (!isoStr) return ''
  try {
    return new Date(isoStr).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return isoStr
  }
}

function classifyGenome(genomeKey, activeGenomes, inactiveGenomes, localAssemblies) {
  if (activeGenomes.some((s) => genomeKeyCandidates(s).includes(genomeKey))) return 'active'
  if (inactiveGenomes.some((s) => genomeKeyCandidates(s).includes(genomeKey))) return 'inactive'
  if (localAssemblies.some((s) => genomeKeyCandidates(s).includes(genomeKey))) return 'local'
  return 'unavailable'
}

const PILL_SORT_ORDER = { active: 0, inactive: 1, local: 2, unavailable: 3 }

function GenomePill({ genomeKey, label, assembly, kind, isLight }) {
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs whitespace-nowrap select-none'
  const styles = {
    active: isLight
      ? 'bg-green-100 text-green-800 border border-green-200'
      : 'bg-green-900/40 text-green-300 border border-green-700',
    inactive: isLight
      ? 'bg-amber-100 text-amber-800 border border-amber-200'
      : 'bg-amber-900/40 text-amber-300 border border-amber-700',
    local: isLight
      ? 'bg-gray-100 text-gray-700 border border-gray-300'
      : 'bg-gray-700 text-gray-300 border border-gray-600',
    unavailable: isLight
      ? 'bg-gray-100 text-gray-400 border border-gray-200 line-through opacity-60'
      : 'bg-gray-800 text-gray-600 border border-gray-700 line-through opacity-50',
  }
  const title = kind === 'unavailable'
    ? `${genomeKey} — not available locally`
    : genomeKey

  return (
    <span className={`${base} ${styles[kind] || styles.unavailable}`} title={title}>
      {label}
      {assembly && <span className="opacity-60">{assembly}</span>}
    </span>
  )
}

function AlignmentListItem({ aln, isSelected, activeGenomes, inactiveGenomes, localAssemblies, isLight, onClick }) {
  const textClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const selectedBorder = isLight ? 'border-blue-400 bg-blue-50' : 'border-blue-500 bg-blue-900/20'
  const normalBorder = isLight ? 'border-gray-200 hover:border-gray-300 hover:bg-gray-50' : 'border-gray-700 hover:border-gray-600 hover:bg-gray-700/30'

  const sortedGenomes = [...(aln.genomes || [])].sort((a, b) => {
    const ka = PILL_SORT_ORDER[classifyGenome(a.genome_key, activeGenomes, inactiveGenomes, localAssemblies)] ?? 3
    const kb = PILL_SORT_ORDER[classifyGenome(b.genome_key, activeGenomes, inactiveGenomes, localAssemblies)] ?? 3
    return ka - kb
  })

  const stats = aln.stats || {}
  const avgId = stats.average_identity != null ? `${Number(stats.average_identity).toFixed(1)}%` : '—'
  const alnLen = stats.alignment_length != null ? stats.alignment_length.toLocaleString() : '—'
  const geneList = [...new Set((aln.genomes || []).map((g) => g.gene_symbol || g.gene_id).filter(Boolean))].slice(0, 3).join(', ')

  return (
    <div
      className={`cursor-pointer rounded-lg border p-3 transition-colors ${isSelected ? selectedBorder : normalBorder}`}
      onClick={onClick}
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <span className={`text-sm font-medium truncate max-w-[200px] ${textClass}`} title={aln.name}>
          {aln.name || aln.file_stem}
        </span>
        <span className={`text-xs ${subTextClass} ml-2 flex-shrink-0`}>{formatDate(aln.created)}</span>
      </div>

      {/* Genome pills */}
      <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto mb-2">
        {sortedGenomes.map((g) => {
          const kind = classifyGenome(g.genome_key, activeGenomes, inactiveGenomes, localAssemblies)
          return (
            <GenomePill
              key={g.genome_key}
              genomeKey={g.genome_key}
              label={g.common_name || g.scientific_name || g.genome_key}
              assembly={g.assembly_name || g.assembly || ''}
              kind={kind}
              isLight={isLight}
            />
          )
        })}
      </div>

      {/* Stats row */}
      <div className={`flex items-center gap-3 text-xs ${subTextClass}`}>
        <span>{(aln.genomes || []).length} genomes</span>
        <span>len {alnLen}</span>
        <span>id {avgId}</span>
        {geneList && <span className="truncate max-w-[120px]" title={geneList}>{geneList}</span>}
      </div>
    </div>
  )
}

export default function LoadAlignmentModal({
  open,
  theme = 'dark',
  apiBase = API_BASE,
  outputDir = '',
  activeGenomes = [],
  inactiveGenomes = [],
  onLoad,
  onClose,
}) {
  const isLight = theme === 'light'
  const [alignments, setAlignments] = useState([])
  const [localAssemblies, setLocalAssemblies] = useState([])
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState(null)
  const [loadMode, setLoadMode] = useState('active')
  const [loading, setLoading] = useState(false)
  const [loadResult, setLoadResult] = useState(null) // { ok, error, excludedCount }

  // Fetch alignment list and local assemblies on open
  useEffect(() => {
    if (!open) return
    setSelected(null)
    setLoadResult(null)
    setLoadMode('active')
    setShowAll(false)

    const fetchData = async () => {
      setFetching(true)
      setFetchError(null)
      try {
        const [alnRes, localRes] = await Promise.all([
          fetch(`${apiBase}/api/alignments/list?output_dir=${encodeURIComponent(outputDir)}`),
          outputDir
            ? fetch(`${apiBase}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`)
            : Promise.resolve(null),
        ])
        const alnData = await alnRes.json()
        setAlignments(Array.isArray(alnData?.alignments) ? alnData.alignments : [])
        if (localRes && localRes.ok) {
          const localData = await localRes.json()
          setLocalAssemblies(Array.isArray(localData) ? localData : [])
        }
      } catch (e) {
        setFetchError(e?.message || 'Failed to load alignments')
      } finally {
        setFetching(false)
      }
    }
    fetchData()
  }, [open, apiBase, outputDir])

  const activeKeys = new Set(activeGenomes.map(speciesItemKey))

  // Filter: show only alignments that have ≥1 active genome, unless showAll
  const visibleAlignments = showAll
    ? alignments
    : alignments.filter((aln) =>
        (aln.genome_keys || []).some((k) => activeKeys.has(k))
      )

  // Compute load-mode info for selected alignment
  const selectedGenomes = selected?.genomes || []
  const unavailableCount = selectedGenomes.filter(
    (g) => classifyGenome(g.genome_key, activeGenomes, inactiveGenomes, localAssemblies) === 'unavailable'
  ).length

  const handleLoad = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    setLoadResult(null)
    try {
      const res = await onLoad({
        name: selected.file_stem || selected.name,
        loadMode,
        alignmentGenomes: selected.genomes || [],
        localAssemblies,
      })
      if (res?.ok) {
        onClose?.()
        return
      }
      setLoadResult({ ok: false, error: res?.error || 'Load failed.' })
    } catch (e) {
      setLoadResult({ ok: false, error: e?.message || 'Load failed.' })
    } finally {
      setLoading(false)
    }
  }, [selected, loadMode, localAssemblies, onLoad, onClose])

  if (!open) return null

  const overlayBg = isLight ? 'bg-black/40' : 'bg-black/60'
  const panelBg = isLight ? 'bg-white border border-gray-200 shadow-xl' : 'bg-gray-800 border border-gray-700 shadow-xl'
  const textClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const dividerClass = isLight ? 'border-gray-200' : 'border-gray-700'
  const radioBase = 'flex items-start gap-2 cursor-pointer'

  const loadModeOptions = [
    {
      value: 'active',
      label: 'Load active genomes only',
      description: 'Include only genomes matching the current active set',
    },
    {
      value: 'active_inactive',
      label: 'Load active + inactive',
      description: 'Also activate any inactive genomes found in this file',
    },
    {
      value: 'all',
      label: 'Load all available',
      description: 'Also add local genomes that are not yet selected',
    },
  ]

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${overlayBg}`}
      onClick={(e) => { if (e.target === e.currentTarget && !loading) onClose?.() }}
    >
      <div className={`${panelBg} rounded-lg w-full max-w-2xl mx-4 flex flex-col`} style={{ maxHeight: '85vh' }}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${dividerClass} flex-shrink-0`}>
          <h2 className={`text-base font-semibold ${textClass}`}>Load alignment</h2>
          <div className="flex items-center gap-3">
            {/* Pill legend */}
            <div className="flex items-center gap-2 text-[10px]">
              <span className={`px-1.5 py-0.5 rounded-full ${isLight ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-green-900/40 text-green-300 border border-green-700'}`}>active</span>
              <span className={`px-1.5 py-0.5 rounded-full ${isLight ? 'bg-amber-100 text-amber-700 border border-amber-200' : 'bg-amber-900/40 text-amber-300 border border-amber-700'}`}>inactive</span>
              <span className={`px-1.5 py-0.5 rounded-full ${isLight ? 'bg-gray-100 text-gray-600 border border-gray-300' : 'bg-gray-700 text-gray-300 border border-gray-600'}`}>local</span>
            </div>
            <button
              onClick={() => !loading && onClose?.()}
              className={`${subTextClass} hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none`}
            >
              ×
            </button>
          </div>
        </div>

        {/* Filter toggle */}
        <div className={`px-5 py-2.5 border-b ${dividerClass} flex-shrink-0 flex items-center justify-between`}>
          <span className={`text-xs ${subTextClass}`}>
            {fetching ? 'Loading…' : `${visibleAlignments.length} alignment${visibleAlignments.length !== 1 ? 's' : ''}`}
          </span>
          <button
            onClick={() => setShowAll((v) => !v)}
            className={`text-xs underline ${isLight ? 'text-blue-600 hover:text-blue-800' : 'text-blue-400 hover:text-blue-300'}`}
          >
            {showAll ? 'Show matching only' : 'Show all'}
          </button>
        </div>

        {/* Alignment list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2 min-h-0">
          {fetchError && (
            <div className={`rounded px-3 py-2 text-xs ${isLight ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
              {fetchError}
            </div>
          )}
          {!fetching && !fetchError && visibleAlignments.length === 0 && (
            <div className={`text-center py-8 text-sm ${subTextClass}`}>
              {alignments.length === 0
                ? 'No saved alignments found.'
                : 'No alignments match the current active genomes. Toggle "Show all" to see all saved alignments.'}
            </div>
          )}
          {visibleAlignments.map((aln) => (
            <AlignmentListItem
              key={aln.file_stem || aln.name}
              aln={aln}
              isSelected={selected?.file_stem === aln.file_stem}
              activeGenomes={activeGenomes}
              inactiveGenomes={inactiveGenomes}
              localAssemblies={localAssemblies}
              isLight={isLight}
              onClick={() => {
                setSelected(aln)
                setLoadResult(null)
              }}
            />
          ))}
        </div>

        {/* Load options (shown when an alignment is selected) */}
        {selected && (
          <div className={`px-5 py-4 border-t ${dividerClass} flex-shrink-0`}>
            <div className={`text-xs font-medium ${subTextClass} mb-2`}>Load options</div>
            <div className="space-y-2 mb-3">
              {loadModeOptions.map((opt) => (
                <label key={opt.value} className={radioBase}>
                  <input
                    type="radio"
                    name="loadMode"
                    value={opt.value}
                    checked={loadMode === opt.value}
                    onChange={() => setLoadMode(opt.value)}
                    disabled={loading}
                    className="mt-0.5 flex-shrink-0"
                  />
                  <div>
                    <div className={`text-xs font-medium ${textClass}`}>{opt.label}</div>
                    <div className={`text-xs ${subTextClass}`}>{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Unavailable genomes info */}
            {unavailableCount > 0 && (
              <div className={`text-xs ${subTextClass} mb-3`}>
                {unavailableCount} genome{unavailableCount !== 1 ? 's' : ''} in this file {unavailableCount !== 1 ? 'have' : 'has'} no local data and will be excluded.
              </div>
            )}

            {/* Load result message (errors only) */}
            {loadResult && !loadResult.ok && (
              <div className={`rounded px-3 py-2 text-xs mb-3 ${
                isLight ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-red-900/30 border border-red-700 text-red-300'
              }`}>
                {loadResult.error}
              </div>
            )}

            {/* Footer buttons */}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => !loading && onClose?.()}
                className={`px-4 py-1.5 rounded text-sm transition-colors
                  ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
              >
                Cancel
              </button>
              <button
                onClick={handleLoad}
                disabled={loading || !selected}
                className="px-4 py-1.5 rounded text-sm font-medium bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed text-white transition-colors"
              >
                {loading ? 'Loading…' : 'Load'}
              </button>
            </div>
          </div>
        )}

        {/* Empty footer when nothing selected */}
        {!selected && (
          <div className={`px-5 py-3 border-t ${dividerClass} flex-shrink-0 flex justify-end`}>
            <button
              onClick={onClose}
              className={`px-4 py-1.5 rounded text-sm transition-colors
                ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

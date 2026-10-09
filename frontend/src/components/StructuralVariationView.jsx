import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { API_BASE } from '../backendRuntime'
import { getOutgoingSvAlignments, getSvAlignmentsForPair } from '../utils/svCatalog'

// Register the Beta web component (ens-sv-alignments + ens-sv-alignments-image)
import '../lib/ensembl-sv/alignments/variant-alignments.js'
import { svSpeciesSelectionKey } from './structural-variation/svFormat.js'
import {
  alignmentSupportsAnchorRegion,
  buildSvAnchorRegionOptions,
  getSvRegionKey,
  parseRegionInput,
  svRegionsMatch,
} from './structural-variation/svWindows.js'
import {
  StructuralVariationThreeGenomeView,
} from './structural-variation/StructuralVariationThreeGenomeView.jsx'
import {
  StructuralVariationChooser,
} from './structural-variation/StructuralVariationChooser.jsx'

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

  // Genome and region selection determine the alignment, using the first
  // applicable catalog record when more than one covers the same comparison.
  const selectedSecondAlignment = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, tgtSpecies)
        .find((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId)) || null
      : null),
    [catalog, refSpecies, tgtSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
  )
  const selectedThirdAlignment = useMemo(
    () => (hasExplicitAnchorRegion
      ? getSvAlignmentsForPair(catalog, refSpecies, thirdSpecies)
        .find((alignment) => alignmentSupportsAnchorRegion(alignment, effectiveSelectedAnchorRegionId)) || null
      : null),
    [catalog, refSpecies, thirdSpecies, effectiveSelectedAnchorRegionId, hasExplicitAnchorRegion],
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

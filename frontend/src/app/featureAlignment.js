// The Feature Alignment view's actions: resolving inputs, running pairwise and
// multiple alignments, deriving the pairwise overlay, per-row settings, the rows
// shown, and saving and loading alignment workspaces.
import { API_BASE } from '../backendRuntime.js'
import { isTutorialSandboxActive } from '../tutorials/sandbox.js'
import {
    buildAlignmentGenomicToColumnMap,
    buildProjectedTranscriptFeatures,
    getCoveredAlignmentColumnRange,
    getTranscriptBoundaryStatus,
    getTranscriptSpan,
} from './alignmentProjection.js'
import { dedupeSpeciesList, speciesItemKey } from './genomeLists.js'

export async function runMultipleAlignment(ctx) {
    const {
        alignmentGlobalFlanks,
        alignmentInputs,
        alignmentResultSourceRef,
        alignmentRunSettings,
        buildResolvedAlignmentSignature,
        setAlignmentOverlay,
        setAlignmentViewError,
        setAlignmentViewLoading,
        setLastSuccessfulMultiAlignmentSignature,
        setLoadedAlignmentBaselineByGenome,
        setMultiAlignmentResult,
    } = ctx
    // Use the rows from the render that supplied this click handler. In
    // particular, this guarantees that the transcript shown in the controlled
    // select is the transcript sent to the backend.
    const rows = alignmentInputs || []
    if (!rows.length) return
    const runSignature = buildResolvedAlignmentSignature(rows, alignmentGlobalFlanks)
    const nextLoadedBaseline = {}

    const payloadRows = rows.map((row) => {
      const useGlobal = row.settings?.useGlobalFlanks !== false
      const flank5 = useGlobal ? alignmentGlobalFlanks.flank5 : row.settings?.flank5
      const flank3 = useGlobal ? alignmentGlobalFlanks.flank3 : row.settings?.flank3
      const bestQuery = String(
        row.query
        || row.resolved?.query
        || row.resolved?.gene?.id
        || row.resolved?.gene?.name
        || ''
      ).trim()
      const transcriptQueryFallback = String(
        row.resolved?.resolvedType === 'transcript'
          ? (bestQuery || row.resolved?.query || '')
          : ''
      ).trim()
      const chosenTranscriptId = String(
        row.settings?.selectedTranscriptId
        || row.resolved?.selectedTranscriptId
        || row.resolved?.transcripts?.find((tx) => tx?.is_canonical)?.id
        || row.resolved?.transcripts?.[0]?.id
        || transcriptQueryFallback
        || ''
      ).trim()
      if (String(row.genome_key || '').trim()) {
        nextLoadedBaseline[String(row.genome_key || '').trim()] = {
          genomeKey: String(row.genome_key || '').trim(),
          query: bestQuery,
          geneId: String(row.resolved?.gene?.id || '').trim(),
          geneName: String(row.resolved?.gene?.name || '').trim(),
          selectedTranscriptId: chosenTranscriptId,
        }
      }
      return {
        genome: row.genome_param || row.genome_key,
        genome_key: row.genome_key,
        tag: row.tag,
        query: bestQuery,
        include: Boolean(chosenTranscriptId || bestQuery),
        transcript_id: chosenTranscriptId,
        selected_transcript_id: chosenTranscriptId,
        use_gene_boundaries: row.settings?.useGeneBoundaries !== false,
        flank_5_bp: Math.max(0, parseInt(flank5 || 0, 10) || 0),
        flank_3_bp: Math.max(0, parseInt(flank3 || 0, 10) || 0),
        overlay_annotation: Boolean(row.settings?.overlayAnnotation),
      }
    })

    setAlignmentViewLoading(true)
    setAlignmentViewError(null)
    try {
      const res = await fetch(`${API_BASE}/api/align/multi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: payloadRows,
          run_scope: 'resolved_subset',
          run_settings: {
            ...alignmentRunSettings,
            profile: 'balanced',
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.detail || 'Failed to run feature alignment')
      }
      const alignedRows = Array.isArray(data?.rows) ? data.rows : []
      const includedCount = Number.isFinite(Number(data?.included_count))
        ? Number(data.included_count)
        : alignedRows.length
      if (includedCount < 2 || alignedRows.length < 2) {
        const warningMessage = Array.isArray(data?.warnings) && data.warnings.length > 0
          ? String(data.warnings[0] || '').trim()
          : ''
        throw new Error(warningMessage || 'Need at least two resolved genomes with selected transcripts to run alignment.')
      }
      setLoadedAlignmentBaselineByGenome(nextLoadedBaseline)
      setMultiAlignmentResult(data)
      setLastSuccessfulMultiAlignmentSignature(runSignature)
      alignmentResultSourceRef.current = { kind: 'run', signature: runSignature }
      // Bridge from Feature Alignment to the browser alignment overlay is disabled for now.
      setAlignmentOverlay(null)
    } catch (e) {
      setAlignmentViewError(e?.message || 'Failed to run feature alignment')
    } finally {
      setAlignmentViewLoading(false)
    }
  }

export async function resolveAlignmentInputs(ctx, genomeKey, queryOverride = null, options = {}) {
    const {
        alignmentInputsRef,
        alignmentResolveControllersRef,
        alignmentResolveRequestTokenRef,
        setAlignmentInputs,
    } = ctx
    const row = (alignmentInputsRef.current || []).find((item) => item.genome_key === genomeKey)
    if (!row) return null
    const query = String(queryOverride != null ? queryOverride : row.query || '').trim()
    if (!query) return null

    const requestToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    alignmentResolveRequestTokenRef.current[genomeKey] = requestToken
    try {
      alignmentResolveControllersRef.current[genomeKey]?.abort()
    } catch { }
    const controller = new AbortController()
    alignmentResolveControllersRef.current[genomeKey] = controller
    setAlignmentInputs((prev) => prev.map((item) => (
      item.genome_key === genomeKey
        ? { ...item, status: 'resolving', error: '' }
        : item
    )))

    try {
      const res = await fetch(
        `${API_BASE}/api/resolve_id?genome=${encodeURIComponent(genomeKey)}&query=${encodeURIComponent(query)}`,
        { signal: controller.signal }
      )
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err?.detail || 'Not found')
      }
      const data = await res.json()
      const resolvedTranscripts = Array.isArray(data.transcripts) ? data.transcripts : []
      const fallbackSelectedTranscriptId = String(
        data.selected_transcript_id
        || resolvedTranscripts.find((tx) => tx?.is_canonical)?.id
        || resolvedTranscripts[0]?.id
        || ''
      ).trim()
      const resolved = {
        query: data.query,
        resolvedType: data.resolved_type,
        gene: data.gene,
        transcripts: resolvedTranscripts,
        selectedTranscriptId: fallbackSelectedTranscriptId,
      }
      if (alignmentResolveRequestTokenRef.current[genomeKey] !== requestToken) return null
      const preferredSelectedTranscriptId = String(options?.selectedTranscriptId || '').trim()
      setAlignmentInputs((prev) => prev.map((item) => {
        if (item.genome_key !== genomeKey) return item
        const currentSelectedTranscriptId = String(item.settings?.selectedTranscriptId || '').trim()
        const hasCurrentSelectedTranscript = currentSelectedTranscriptId
          ? resolved.transcripts?.some((tx) => String(tx?.id || '').trim() === currentSelectedTranscriptId)
          : false
        const hasPreferredSelectedTranscript = preferredSelectedTranscriptId
          ? resolved.transcripts?.some((tx) => String(tx?.id || '').trim() === preferredSelectedTranscriptId)
          : false
        const nextSelected = String(
          (options?.preferSelectedTranscriptId && hasPreferredSelectedTranscript ? preferredSelectedTranscriptId : '')
          || (hasCurrentSelectedTranscript ? currentSelectedTranscriptId : '')
          || (hasPreferredSelectedTranscript ? preferredSelectedTranscriptId : '')
          || resolved.selectedTranscriptId
          || resolved.transcripts?.find((tx) => tx?.is_canonical)?.id
          || resolved.transcripts?.[0]?.id
          || ''
        ).trim()
        return {
          ...item,
          query,
          status: 'resolved',
          error: '',
          include: true,
          resolved,
          settings: {
            ...(item.settings || {}),
            selectedTranscriptId: nextSelected,
          },
          lastAutoQuery: options?.auto ? String(query).toLowerCase() : item.lastAutoQuery,
        }
      }))
      return resolved
    } catch (e) {
      if (alignmentResolveRequestTokenRef.current[genomeKey] !== requestToken) return null
      const message = e?.message || 'Resolve failed'
      setAlignmentInputs((prev) => prev.map((item) => (
        item.genome_key === genomeKey
          ? { ...item, status: 'error', error: message, include: true, resolved: null }
          : item
      )))
      return null
    } finally {
      if (alignmentResolveControllersRef.current[genomeKey] === controller) {
        delete alignmentResolveControllersRef.current[genomeKey]
      }
    }
  }

export function changeAlignmentRowSetting(ctx, genomeKey, patch) {
    const {
        setAlignmentInputs,
    } = ctx
    setAlignmentInputs((prev) => prev.map((row) => {
      if (row.genome_key !== genomeKey) return row
      const current = { ...(row.settings || {}) }
      const incoming = { ...(patch || {}) }
      const resolvedMax = Number.isFinite(Number(incoming.flankMax))
        ? Math.max(100, Number(incoming.flankMax))
        : (Number.isFinite(Number(current.flankMax)) ? Math.max(100, Number(current.flankMax)) : 1000)

      let flank5 = Number.isFinite(Number(incoming.flank5))
        ? Math.max(0, Number(incoming.flank5))
        : (Number.isFinite(Number(current.flank5)) ? Math.max(0, Number(current.flank5)) : 100)
      let flank3 = Number.isFinite(Number(incoming.flank3))
        ? Math.max(0, Number(incoming.flank3))
        : (Number.isFinite(Number(current.flank3)) ? Math.max(0, Number(current.flank3)) : 100)

      const lockFromPatch = Object.prototype.hasOwnProperty.call(incoming, 'flanksLocked')
        ? Boolean(incoming.flanksLocked)
        : Boolean(current.flanksLocked ?? true)

      if (lockFromPatch) {
        const hasF5 = Object.prototype.hasOwnProperty.call(incoming, 'flank5')
        const hasF3 = Object.prototype.hasOwnProperty.call(incoming, 'flank3')
        if (hasF5 && !hasF3) {
          flank3 = flank5
        } else if (hasF3 && !hasF5) {
          flank5 = flank3
        } else if (!hasF5 && !hasF3 && Object.prototype.hasOwnProperty.call(incoming, 'flanksLocked')) {
          flank3 = flank5
        } else if (hasF5 && hasF3) {
          flank3 = flank5
        }
      }

      flank5 = Math.min(resolvedMax, flank5)
      flank3 = Math.min(resolvedMax, flank3)

      const nextSettings = {
        ...current,
        ...incoming,
        flankMax: resolvedMax,
        flanksLocked: lockFromPatch,
        flank5,
        flank3,
      }
      const nextSelectedTranscriptId = String(nextSettings.selectedTranscriptId || '').trim()
      const nextResolved = row.resolved
        ? {
          ...row.resolved,
          selectedTranscriptId: nextSelectedTranscriptId || row.resolved.selectedTranscriptId || '',
        }
        : row.resolved
      return { ...row, settings: nextSettings, resolved: nextResolved }
    }))
  }

export function buildPairwiseOverlay(ctx, multiResult) {
    const rows = multiResult?.rows || []
    if (rows.length < 2) return null
    const first = rows[0]
    const second = rows[1]
    const seq1 = String(first.aligned_sequence || '')
    const seq2 = String(second.aligned_sequence || '')
    if (!seq1 || !seq2 || seq1.length !== seq2.length) return null

    let matches = 0
    let denom = 0
    let gaps = 0
    for (let i = 0; i < seq1.length; i += 1) {
      const a = seq1[i]
      const b = seq2[i]
      if (a === '-' || b === '-') {
        gaps += 1
      } else {
        denom += 1
        if (a === b) matches += 1
      }
    }
    const identity = denom > 0 ? (matches / denom) * 100 : 0
    return {
      transcript_id: first.transcript_id || '',
      target_transcript_id: second.transcript_id || '',
      reference: {
        name: first.tag || 'reference',
        sequence: seq1,
        features: first.features || [],
        chrom: first.chrom || '',
        genomic_start: Number(first.genomic_start || 0),
        genomic_end: Number(first.genomic_end || 0),
        strand: first.strand || '+',
      },
      target: {
        name: second.tag || 'target',
        sequence: seq2,
        features: second.features || [],
        chrom: second.chrom || '',
        genomic_start: Number(second.genomic_start || 0),
        genomic_end: Number(second.genomic_end || 0),
        strand: second.strand || '+',
      },
      alignment_length: seq1.length,
      identity,
      gaps,
      timestamp: multiResult?.timestamp || new Date().toISOString(),
    }
  }

export async function resolveAlignmentInput(ctx, side, query) {
    const {
        configRef,
        setRefError,
        setRefLoading,
        setRefResolved,
        setTgtError,
        setTgtLoading,
        setTgtResolved,
    } = ctx
    const setSideLoading = side === 'ref' ? setRefLoading : setTgtLoading
    const setSideError = side === 'ref' ? setRefError : setTgtError
    const setSideResolved = side === 'ref' ? setRefResolved : setTgtResolved
    const genome = side === 'ref' ? 'reference' : 'target'

    // Focusing a gene pushes its name into this input, which then looks for the same gene
    // on the comparison side. During a tutorial that side is still the user's own
    // reference genome, and the gene is one of the demo genome's invented ones — so the
    // lookup can only fail, noisily, for something nobody asked for.
    if (isTutorialSandboxActive()) {
      setSideResolved(null)
      setSideError(null)
      return null
    }

    // With no annotation configured for this side there is nothing to resolve against,
    // so the request can only come back 404 — and the "Not found" it produces says the
    // gene is missing when really the side is simply unset.
    const configured = side === 'ref'
      ? configRef.current?.ref_gff
      : configRef.current?.target_gff
    if (!String(configured || '').trim()) {
      setSideResolved(null)
      setSideError(null)
      return null
    }

    setSideLoading(true)
    setSideError(null)

    try {
      const res = await fetch(
        `${API_BASE}/api/resolve_id?genome=${genome}&query=${encodeURIComponent(query.trim())}`
      )
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Not found')
      }
      const data = await res.json()
      const resolved = {
        query: data.query,
        resolvedType: data.resolved_type,
        gene: data.gene,
        transcripts: data.transcripts,
        selectedTranscriptId: data.selected_transcript_id,
      }
      setSideResolved(resolved)
      return resolved
    } catch (e) {
      setSideError(e.message)
      setSideResolved(null)
      return null
    } finally {
      setSideLoading(false)
    }
  }

export function computeAlignmentDisplayRows(ctx) {
    const {
        alignmentInputByGenomeKey,
        loadedAlignmentBaselineByGenome,
        multiAlignmentResult,
    } = ctx
    try {
      const loadedRows = Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows : []
      return loadedRows.map((rawRow) => {
        const genomeKey = String(rawRow?.genome_key || rawRow?.genome || '').trim()
        const inputRow = alignmentInputByGenomeKey.get(genomeKey) || null
        const baseline = loadedAlignmentBaselineByGenome?.[genomeKey] || null
        const resolved = inputRow?.status === 'resolved' ? inputRow.resolved : null
        const resolvedTranscripts = Array.isArray(resolved?.transcripts) ? resolved.transcripts : []
        const selectedTranscriptId = String(
          inputRow?.settings?.selectedTranscriptId
          || resolved?.selectedTranscriptId
          || baseline?.selectedTranscriptId
          || rawRow?.transcript_id
          || ''
        ).trim()
        const selectedTranscript = resolvedTranscripts.find((tx) => String(tx?.id || '').trim() === selectedTranscriptId) || null
        const selectedTranscriptCoordLabel = selectedTranscript
          ? `${String(selectedTranscript.chrom || rawRow?.chrom || '').trim()}:${Math.min(Number(selectedTranscript.start), Number(selectedTranscript.end))}-${Math.max(Number(selectedTranscript.start), Number(selectedTranscript.end))} (${String(selectedTranscript.strand || rawRow?.strand || '+')})`
          : ''
        const geneLabel = String(
          resolved?.gene?.name
          || resolved?.gene?.id
          || baseline?.geneName
          || baseline?.geneId
          || rawRow?.query
          || rawRow?.transcript_id
          || genomeKey
        ).trim()

        const baseRow = {
          ...rawRow,
          transcript_id: selectedTranscriptId || String(rawRow?.transcript_id || '').trim(),
          gene_label: geneLabel,
          loaded_gene_id: String(baseline?.geneId || '').trim(),
          selected_transcript_coord_label: selectedTranscriptCoordLabel,
          boundary_status: 'unknown',
          boundary_message: '',
          coverage_status: 'full',
          not_aligned_bp_left: 0,
          not_aligned_bp_right: 0,
          covered_column_start: null,
          covered_column_end: null,
          no_coverage: false,
          display_features: Array.isArray(rawRow?.features) ? rawRow.features : [],
        }

        try {
          if (!resolved || !selectedTranscript) {
            return baseRow
          }

          const baselineTranscriptId = String(
            baseline?.selectedTranscriptId
            || rawRow?.transcript_id
            || ''
          ).trim()
          const isSwitchedTranscript = Boolean(
            baseline
            && selectedTranscriptId
            && baselineTranscriptId
            && selectedTranscriptId !== baselineTranscriptId
          )
          const transcriptSpan = getTranscriptSpan(selectedTranscript)
          const coveredStart = Math.min(Number(rawRow?.genomic_start), Number(rawRow?.genomic_end))
          const coveredEnd = Math.max(Number(rawRow?.genomic_start), Number(rawRow?.genomic_end))
          let coverageStatus = 'full'
          let boundaryStatus = 'unknown'
          let boundaryMessage = ''
          let notAlignedBpLeft = 0
          let notAlignedBpRight = 0
          let coveredColumnStart = null
          let coveredColumnEnd = null
          let noCoverage = false
          let displayFeatures = Array.isArray(rawRow?.features) ? rawRow.features : []

          if (baseline && transcriptSpan && Number.isFinite(coveredStart) && Number.isFinite(coveredEnd)) {
            const overlapWindow = {
              start: Math.max(transcriptSpan.start, coveredStart),
              end: Math.min(transcriptSpan.end, coveredEnd),
            }
            boundaryStatus = getTranscriptBoundaryStatus(transcriptSpan, coveredStart, coveredEnd)
            if (isSwitchedTranscript) {
              if (boundaryStatus === 'within') boundaryMessage = 'Transcript matches on or within boundaries'
              else if (boundaryStatus === 'partial') boundaryMessage = 'Transcript partially overlaps boundaries'
              else if (boundaryStatus === 'outside') boundaryMessage = 'Transcript outside boundaries'
            }
            if (String(transcriptSpan.strand || rawRow?.strand || '+') === '-') {
              notAlignedBpLeft = Math.max(0, Math.round(transcriptSpan.end - coveredEnd))
              notAlignedBpRight = Math.max(0, Math.round(coveredStart - transcriptSpan.start))
            } else {
              notAlignedBpLeft = Math.max(0, Math.round(coveredStart - transcriptSpan.start))
              notAlignedBpRight = Math.max(0, Math.round(transcriptSpan.end - coveredEnd))
            }
            if (notAlignedBpLeft > 0 && notAlignedBpRight > 0) coverageStatus = 'truncated_both'
            else if (notAlignedBpLeft > 0) coverageStatus = 'truncated_left'
            else if (notAlignedBpRight > 0) coverageStatus = 'truncated_right'
            if (boundaryStatus === 'within') {
              coverageStatus = 'full'
              notAlignedBpLeft = 0
              notAlignedBpRight = 0
            } else if (boundaryStatus === 'outside') {
              coverageStatus = 'outside'
              noCoverage = true
            }
            if (isSwitchedTranscript) {
              const genomicToAlign = buildAlignmentGenomicToColumnMap(
                rawRow?.aligned_sequence,
                rawRow?.genomic_start,
                rawRow?.genomic_end,
                rawRow?.strand
              )
              const projectedFeatures = buildProjectedTranscriptFeatures(selectedTranscript, genomicToAlign)
              if (projectedFeatures.length > 0) {
                displayFeatures = projectedFeatures
              }
              if (boundaryStatus === 'partial') {
                const coveredRange = overlapWindow.start <= overlapWindow.end
                  ? getCoveredAlignmentColumnRange(genomicToAlign, overlapWindow)
                  : null
                if (coveredRange) {
                  coveredColumnStart = coveredRange.start
                  coveredColumnEnd = coveredRange.end
                }
              }
            }
          }

          return {
            ...baseRow,
            boundary_status: boundaryStatus,
            boundary_message: boundaryMessage,
            coverage_status: coverageStatus,
            not_aligned_bp_left: notAlignedBpLeft,
            not_aligned_bp_right: notAlignedBpRight,
            covered_column_start: coveredColumnStart,
            covered_column_end: coveredColumnEnd,
            no_coverage: noCoverage,
            display_features: displayFeatures,
          }
        } catch (error) {
          console.error('Failed to derive alignment display row:', genomeKey, error)
          return {
            ...baseRow,
            boundary_status: 'unknown',
            boundary_message: '',
            no_coverage: false,
          }
        }
      })
    } catch (error) {
      console.error('Failed to derive alignment display rows:', error)
      return (Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows : []).map((rawRow) => ({
        ...rawRow,
        gene_label: String(rawRow?.query || rawRow?.transcript_id || rawRow?.genome_key || rawRow?.genome || '').trim(),
        loaded_gene_id: '',
        coverage_status: 'full',
        not_aligned_bp_left: 0,
        not_aligned_bp_right: 0,
        covered_column_start: null,
        covered_column_end: null,
        no_coverage: false,
        display_features: Array.isArray(rawRow?.features) ? rawRow.features : [],
      }))
    }
  }

export async function loadAlignmentWorkspace(ctx, { name, loadMode, alignmentGenomes, localAssemblies }) {
    const {
        alignmentInputsRef,
        alignmentResultSourceRef,
        buildAlignmentInputRow,
        config,
        configRef,
        handleGenomeFocusGeneSelect,
        inactiveSelectedSpeciesRef,
        refGenomeKey,
        resolveAlignmentInput,
        setAlignmentInputs,
        setAlignmentViewError,
        setConfig,
        setInactiveSelectedSpecies,
        setLoadedAlignmentBaselineByGenome,
        setMultiAlignmentResult,
        setRefError,
        setRefInput,
        setRefResolved,
        setTgtError,
        setTgtInput,
        setTgtResolved,
        tgtGenomeKey,
    } = ctx
    const outputDir = config?.output_dir || ''
    if (!outputDir) return { ok: false, error: 'Output directory not configured' }

    const currentConfig = configRef.current || config
    const currentActive = dedupeSpeciesList(currentConfig?.active_species || [])
    const currentActiveKeys = new Set(currentActive.map((s) => speciesItemKey(s)))
    const currentInactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const currentInactiveKeys = new Set(currentInactive.map((s) => speciesItemKey(s)))

    // Determine which genome_keys to include and which species to activate
    const fileKeys = (alignmentGenomes || []).map((g) => g.genome_key).filter(Boolean)
    let includeKeys = []
    let newActive = [...currentActive]
    let newInactive = [...currentInactive]

    for (const gKey of fileKeys) {
      if (currentActiveKeys.has(gKey)) {
        includeKeys.push(gKey)
      } else if (currentInactiveKeys.has(gKey)) {
        if (loadMode === 'active_inactive' || loadMode === 'all') {
          // Move from inactive → active
          const species = currentInactive.find((s) => speciesItemKey(s) === gKey)
          if (species) {
            newActive = [...newActive, species]
            newInactive = newInactive.filter((s) => speciesItemKey(s) !== gKey)
            includeKeys.push(gKey)
          }
        }
      } else {
        // Check local assemblies (available but not selected)
        const localMatch = (localAssemblies || []).find((a) => speciesItemKey(a) === gKey)
        if (localMatch && loadMode === 'all') {
          newActive = [...newActive, localMatch]
          includeKeys.push(gKey)
        }
      }
    }

    if (includeKeys.length === 0) {
      return { ok: false, error: 'No matching genomes found for current selection' }
    }

    // Apply genome activation if needed
    const activationChanged = newActive.length !== currentActive.length
    if (activationChanged) {
      const updatedConfig = { ...currentConfig, active_species: dedupeSpeciesList(newActive) }
      setConfig(updatedConfig)
      configRef.current = updatedConfig
      setInactiveSelectedSpecies(dedupeSpeciesList(newInactive))
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedConfig),
        })
      } catch (e) {
        console.error('Failed to save config after genome activation:', e)
      }
    }

    // Load alignment data from backend
    try {
      const res = await fetch(`${API_BASE}/api/alignments/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, output_dir: outputDir, genome_keys: includeKeys }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data?.detail || 'Load failed' }
      const loadedRows = Array.isArray(data?.rows) ? data.rows : []
      const loadedRowByGenomeKey = new Map(
        loadedRows
          .map((row) => [String(row?.genome_key || row?.genome || '').trim(), row])
          .filter(([key]) => key)
      )
      const nextAlignmentSpecies = dedupeSpeciesList(newActive).filter((species) => Boolean(species?.files?.gff3))
      const previousRowsByGenomeKey = new Map((alignmentInputsRef.current || []).map((row) => [row.genome_key, row]))
      const nextAlignmentRows = nextAlignmentSpecies.map((species, idx) => {
        const row = buildAlignmentInputRow(species, idx, previousRowsByGenomeKey.get(speciesItemKey(species)) || null)
        const loadedRow = loadedRowByGenomeKey.get(String(row.genome_key || '').trim())
        if (!loadedRow) {
          return {
            ...row,
            query: '',
            status: 'idle',
            error: '',
            resolved: null,
            lastAutoQuery: '',
            settings: {
              ...(row.settings || {}),
              selectedTranscriptId: '',
            },
          }
        }
        return {
          ...row,
          query: String(loadedRow?.query || '').trim(),
          status: 'idle',
          error: '',
          resolved: null,
          lastAutoQuery: '',
          settings: {
            ...(row.settings || {}),
            overlayAnnotation: loadedRow?.overlay_annotation !== false,
            useGeneBoundaries: loadedRow?.use_gene_boundaries !== false,
            selectedTranscriptId: String(loadedRow?.transcript_id || '').trim(),
          },
        }
      })
      const immediateLoadedBaseline = {}
      for (const genome of alignmentGenomes || []) {
        const genomeKey = String(genome?.genome_key || '').trim()
        if (!genomeKey) continue
        immediateLoadedBaseline[genomeKey] = {
          genomeKey,
          query: String(genome?.gene_symbol || genome?.gene_id || genome?.transcript_id || '').trim(),
          geneId: String(genome?.gene_id || '').trim(),
          geneName: String(genome?.gene_symbol || '').trim(),
          selectedTranscriptId: String(genome?.transcript_id || '').trim(),
        }
      }
      alignmentInputsRef.current = nextAlignmentRows
      setAlignmentInputs(nextAlignmentRows)
      setLoadedAlignmentBaselineByGenome(immediateLoadedBaseline)
      setMultiAlignmentResult(data)
      alignmentResultSourceRef.current = { kind: 'loaded', name, genomeKeys: includeKeys }
      setAlignmentViewError(null)

      const loadedRefQuery = refGenomeKey ? String(loadedRowByGenomeKey.get(refGenomeKey)?.query || '').trim() : ''
      const loadedTgtQuery = tgtGenomeKey ? String(loadedRowByGenomeKey.get(tgtGenomeKey)?.query || '').trim() : ''
      setRefInput(loadedRefQuery)
      setTgtInput(loadedTgtQuery)
      setRefResolved(null)
      setTgtResolved(null)
      setRefError(null)
      setTgtError(null)

      const activeAlignmentGenomeKeys = new Set(nextAlignmentRows.map((row) => String(row?.genome_key || '').trim()).filter(Boolean))
      for (const genomeKey of activeAlignmentGenomeKeys) {
        if (!loadedRowByGenomeKey.has(genomeKey)) {
          handleGenomeFocusGeneSelect(genomeKey, null)
        }
      }

      const resolvedLoadedRows = await Promise.all(loadedRows.map(async (row) => {
        const genomeKey = String(row?.genome_key || row?.genome || '').trim()
        const query = String(row?.query || '').trim()
        const selectedTranscriptId = String(row?.transcript_id || '').trim()
        if (!genomeKey || !query) return null
        const resolved = await resolveAlignmentInput(genomeKey, query, {
          auto: true,
          selectedTranscriptId,
          preferSelectedTranscriptId: true,
        })
        if (resolved?.gene) {
          handleGenomeFocusGeneSelect(genomeKey, resolved.gene)
        }
        return {
          genomeKey,
          query,
          selectedTranscriptId,
          resolved,
        }
      }))

      const nextLoadedBaseline = {}
      for (const item of resolvedLoadedRows) {
        if (!item?.genomeKey) continue
        nextLoadedBaseline[item.genomeKey] = {
          genomeKey: item.genomeKey,
          query: item.query || '',
          geneId: String(item?.resolved?.gene?.id || '').trim(),
          geneName: String(item?.resolved?.gene?.name || '').trim(),
          selectedTranscriptId: item.selectedTranscriptId || '',
        }
      }
      setLoadedAlignmentBaselineByGenome(nextLoadedBaseline)

      return { ok: true, excludedCount: data.excluded_count || 0 }
    } catch (e) {
      return { ok: false, error: e?.message || 'Load failed' }
    }
  }

export async function saveAlignmentWorkspace(ctx, { name }) {
    const {
        activeSpeciesByKey,
        config,
        loadedAlignmentBaselineByGenome,
        multiAlignmentResult,
    } = ctx
    if (!multiAlignmentResult) return { ok: false, error: 'No alignment result' }
    const outputDir = config?.output_dir || ''
    if (!outputDir) return { ok: false, error: 'Output directory not configured' }

    // Build aligned_sequences map and genomes list from the result rows
    const alignedSequences = {}
    const genomes = []
    for (const row of (multiAlignmentResult.rows || [])) {
      const key = row.genome_key || row.genome || ''
      if (!key) continue
      alignedSequences[key] = row.aligned_sequence || ''
      const species = activeSpeciesByKey.get(key) || {}
      const loadedBaseline = loadedAlignmentBaselineByGenome?.[key] || null
        genomes.push({
          genome_key: key,
          species_key: species.species_key || '',
          assembly: species.assembly || '',
        assembly_name: species.assembly_name || '',
        scientific_name: species.scientific_name || '',
        common_name: species.common_name || '',
        gene_symbol: loadedBaseline?.geneName || row.query || '',
        gene_id: loadedBaseline?.geneId || row.query || '',
        transcript_id: row.transcript_id || '',
        tag: row.tag || '',
        chrom: row.chrom || '',
        genomic_start: row.genomic_start || 0,
        genomic_end: row.genomic_end || 0,
        strand: row.strand || '+',
          raw_length: row.raw_length || 0,
          flank_5_bp: row.flank_5_bp || 0,
          flank_3_bp: row.flank_3_bp || 0,
          use_gene_boundaries: row.use_gene_boundaries !== false,
          identity_to_consensus: row.identity_to_consensus || 0,
          gap_fraction: row.gap_fraction || 0,
          features: row.features || [],
        })
    }
    const stats = {
      alignment_length: multiAlignmentResult.alignment_length || 0,
      average_identity: multiAlignmentResult.average_identity || 0,
      requested_count: multiAlignmentResult.requested_count || 0,
      included_count: multiAlignmentResult.included_count || 0,
      profile: multiAlignmentResult.profile || 'balanced',
      strategy: multiAlignmentResult.strategy || '',
    }
    try {
      const res = await fetch(`${API_BASE}/api/alignments/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          output_dir: outputDir,
          genomes,
          aligned_sequences: alignedSequences,
          stats,
          consensus: multiAlignmentResult.consensus || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data?.detail || 'Save failed' }
      return { ok: true, name: data.name }
    } catch (e) {
      return { ok: false, error: e?.message || 'Save failed' }
    }
  }

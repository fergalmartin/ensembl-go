// The Neighbourhood view's actions from the app shell: loading pair links,
// selecting a link, and seeding a pair from a homology hit.
import { geneFocusSignature, mergeGeneFocus, updateGeneFocusMapEntry } from './geneFocus.js'
import { API_BASE } from '../backendRuntime.js'
import { datasetReleaseDownloadMetadata } from '../utils/downloadMetadata.js'
import { getAssemblyAccession, normalizeGenomeProvider } from '../utils/genomeIdentity.js'
import { speciesItemKey } from './genomeLists.js'
import { buildNeighbourhoodPairKey } from './viewSpecies.js'
import { trackAchievement } from '../achievements/tracker.js'
import { NEIGHBOURHOOD_FLANK_WINDOW_SIZE, mergeNeighbourhoodTrack } from './viewSpecies.js'

export function selectNeighbourhoodLink(ctx, payload = {}) {
    const {
        browserRefGene,
        browserTgtGene,
        handleGenomeFocusGeneSelect,
        refGenomeKey,
        setBrowserFocusByGenome,
        setBrowserRefGene,
        setBrowserTgtGene,
        setNeighbourhoodQueryByGenome,
        setRefInput,
        setTgtInput,
        tgtGenomeKey,
    } = ctx
    const payloadGenesByGenome = payload?.genesByGenome && typeof payload.genesByGenome === 'object'
      ? payload.genesByGenome
      : null
    if (payloadGenesByGenome && Object.keys(payloadGenesByGenome).length > 0) {
      const focusUpdatesByGenome = {}
      const queryLabelByGenome = {}
      for (const [genomeKeyRaw, geneRaw] of Object.entries(payloadGenesByGenome)) {
        const genomeKey = String(genomeKeyRaw || '').trim()
        const gene = geneRaw || null
        const geneId = String(gene?.id || '').trim()
        if (!genomeKey || !geneId) continue
        focusUpdatesByGenome[genomeKey] = gene
        const label = String(gene?.name || gene?.id || '').trim()
        if (label) queryLabelByGenome[genomeKey] = label
      }

      const refGeneUpdate = refGenomeKey ? focusUpdatesByGenome[refGenomeKey] : null
      const tgtGeneUpdate = tgtGenomeKey ? focusUpdatesByGenome[tgtGenomeKey] : null
      if (refGeneUpdate) {
        setBrowserRefGene((prev) => {
          const next = mergeGeneFocus(prev, refGeneUpdate)
          return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
        })
        if (refGeneUpdate?.name || refGeneUpdate?.id) {
          setRefInput(refGeneUpdate.name || refGeneUpdate.id)
        }
      }
      if (tgtGeneUpdate) {
        setBrowserTgtGene((prev) => {
          const next = mergeGeneFocus(prev, tgtGeneUpdate)
          return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
        })
        if (tgtGeneUpdate?.name || tgtGeneUpdate?.id) {
          setTgtInput(tgtGeneUpdate.name || tgtGeneUpdate.id)
        }
      }

      setBrowserFocusByGenome((prev) => {
        let next = prev
        for (const [genomeKey, gene] of Object.entries(focusUpdatesByGenome)) {
          const fallbackGene = genomeKey === refGenomeKey
            ? browserRefGene
            : (genomeKey === tgtGenomeKey ? browserTgtGene : null)
          next = updateGeneFocusMapEntry(next, genomeKey, gene, fallbackGene)
        }
        return next
      })

      setNeighbourhoodQueryByGenome((prev) => {
        const next = { ...(prev || {}) }
        let changed = false
        for (const [genomeKey, label] of Object.entries(queryLabelByGenome)) {
          if (next[genomeKey] !== label) {
            next[genomeKey] = label
            changed = true
          }
        }
        return changed ? next : prev
      })
      return
    }

    const refGenome = String(payload?.refGenomeKey || '').trim()
    const tgtGenome = String(payload?.targetGenomeKey || '').trim()
    const referenceGene = payload?.referenceGene || null
    const targetGene = payload?.targetGene || null
    if (!refGenome || !tgtGenome || !referenceGene?.id || !targetGene?.id) return
    setNeighbourhoodQueryByGenome((prev) => ({
      ...prev,
      [refGenome]: referenceGene?.name || referenceGene?.id || prev?.[refGenome] || '',
      [tgtGenome]: targetGene?.name || targetGene?.id || prev?.[tgtGenome] || '',
    }))
    handleGenomeFocusGeneSelect(refGenome, referenceGene)
    handleGenomeFocusGeneSelect(tgtGenome, targetGene)
  }

export async function seedNeighbourhoodFromHomologyHit(ctx) {
    const {
        config,
        neighbourhoodDisabledByGenome,
        neighbourhoodGenomes,
        neighbourhoodHomologyAvailabilityByGenome,
        neighbourhoodHomologyAvailabilityByGenomeRef,
        neighbourhoodUseHomology,
        setNeighbourhoodHomologyAvailabilityByGenome,
        setNeighbourhoodHomologyDownloadTaskByGenome,
        setNeighbourhoodHomologyError,
        setNeighbourhoodHomologyPairLoading,
        setNeighbourhoodUseHomology,
    } = ctx
    if (neighbourhoodUseHomology) {
      setNeighbourhoodUseHomology(false)
      setNeighbourhoodHomologyPairLoading({})
      return
    }

    const eligibleGenomes = neighbourhoodGenomes.filter((species) => {
      const availability = neighbourhoodHomologyAvailabilityByGenome?.[speciesItemKey(species)]
      return availability === 'local' || availability === 'downloadable'
    })
    if (!eligibleGenomes.length) return

    // Mark every adjacent, enabled genome pair as "loading" immediately so the view can
    // blank out old links and show a spinner right away, covering both the download
    // wait (below) and the subsequent /api/neighbourhood fetch once homology mode flips on.
    const enabledKeysForLoading = neighbourhoodGenomes
      .map((species) => speciesItemKey(species))
      .filter((key) => key && !neighbourhoodDisabledByGenome?.[key])
    const seedLoadingPairKeys = []
    for (let i = 0; i < enabledKeysForLoading.length - 1; i += 1) {
      const pk = buildNeighbourhoodPairKey(enabledKeysForLoading[i], enabledKeysForLoading[i + 1])
      if (pk) seedLoadingPairKeys.push(pk)
    }
    if (seedLoadingPairKeys.length) {
      setNeighbourhoodHomologyPairLoading((prev) => {
        const next = { ...prev }
        for (const pk of seedLoadingPairKeys) next[pk] = true
        return next
      })
    }

    const downloadableGenomes = eligibleGenomes.filter((species) => (
      neighbourhoodHomologyAvailabilityByGenome?.[speciesItemKey(species)] === 'downloadable'
    ))

    if (downloadableGenomes.length) {
      if (!config?.output_dir) {
        setNeighbourhoodHomologyError('Set an Output Directory in Configuration before downloading homology data.')
        setNeighbourhoodHomologyPairLoading({})
        return
      }
      setNeighbourhoodHomologyError('')

      await Promise.all(downloadableGenomes.map(async (species) => {
        const key = speciesItemKey(species)
        const provider = normalizeGenomeProvider(species)
        const speciesKey = String(species?.species_key || '').trim()
        const assembly = getAssemblyAccession(species)
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'downloading' }))
        try {
          const filesRes = await fetch(`${API_BASE}/api/remote/files/${encodeURIComponent(speciesKey)}/${encodeURIComponent(assembly)}?provider=${encodeURIComponent(provider)}&file_types=homology`)
          if (!filesRes.ok) throw new Error('Could not fetch homology file info')
          const files = await filesRes.json()
          const file = Array.isArray(files) ? files.find((f) => f?.type === 'homology') : null
          if (!file) throw new Error('No homology file found')

          const res = await fetch(`${API_BASE}/api/remote/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: file.url,
              filename: file.filename,
              provider,
              species_key: speciesKey,
              assembly,
              file_type: 'homology',
              output_dir: config.output_dir,
              scientific_name: species.scientific_name || '',
              common_name: species.common_name || '',
              display_name: species.display_name || '',
              display_name_reason: species.display_name_reason || '',
              assembly_name: species.assembly_name || '',
              source_database: species.source_database || '',
              equivalent_accessions: species.equivalent_accessions || [],
              ...datasetReleaseDownloadMetadata(file, species),
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data?.detail || 'Failed to start homology download')

          if (data?.status === 'already_exists' || data?.status === 'completed') {
            setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'local' }))
          } else if (data?.task_id) {
            setNeighbourhoodHomologyDownloadTaskByGenome((prev) => ({ ...prev, [key]: data.task_id }))
          } else {
            setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'download_failed' }))
          }
        } catch {
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'download_failed' }))
        }
      }))

      // Wait for the /api/remote/tasks poller (above) to resolve every triggered
      // download to 'local' or 'download_failed' before switching modes on, so the
      // very first homology-mode fetch already has the files it needs.
      const downloadKeys = downloadableGenomes.map((species) => speciesItemKey(species))
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const availability = neighbourhoodHomologyAvailabilityByGenomeRef.current || {}
        const stillWaiting = downloadKeys.some((key) => availability[key] === 'downloading')
        if (!stillWaiting) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }

    const finalAvailability = neighbourhoodHomologyAvailabilityByGenomeRef.current || {}
    const unavailableKeys = neighbourhoodGenomes
      .map((species) => speciesItemKey(species))
      .filter((key) => {
        const state = finalAvailability[key]
        return state === 'unavailable' || state === 'download_failed' || state === 'downloading'
      })
    setNeighbourhoodHomologyError(
      unavailableKeys.length
        ? `${unavailableKeys.length} of ${neighbourhoodGenomes.length} genomes lack homology data — those links will use approximate matching instead.`
        : ''
    )
    setNeighbourhoodUseHomology(true)
  }

export async function loadPairLinks(ctx, {
    refGenomeKey: pairRefGenomeKey,
    targetGenomeKey: pairTargetGenomeKey,
    refGeneId,
    targetGeneId,
    useHomology = false,
  }) {
    const {
        neighbourhoodPairAbortRef,
        neighbourhoodPairRequestSeqRef,
        setNeighbourhoodHomologyLinksByPair,
        setNeighbourhoodHomologyPairLoading,
        setNeighbourhoodLinksByPair,
        setNeighbourhoodPairRequestByKey,
        setNeighbourhoodTracksByGenome,
    } = ctx
    const refKey = String(pairRefGenomeKey || '').trim()
    const tgtKey = String(pairTargetGenomeKey || '').trim()
    const srcGeneId = String(refGeneId || '').trim()
    const dstGeneId = String(targetGeneId || '').trim()
    const pairKey = buildNeighbourhoodPairKey(refKey, tgtKey)
    if (!pairKey || !srcGeneId || !dstGeneId) return null

    const prevController = neighbourhoodPairAbortRef.current[pairKey]
    if (prevController) {
      try { prevController.abort() } catch { }
    }
    const controller = new AbortController()
    neighbourhoodPairAbortRef.current[pairKey] = controller
    const reqSeq = (Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) + 1
    neighbourhoodPairRequestSeqRef.current[pairKey] = reqSeq

    if (useHomology) {
      setNeighbourhoodHomologyPairLoading((prev) => (prev?.[pairKey] ? prev : { ...prev, [pairKey]: true }))
    }

    try {
      const url = `${API_BASE}/api/neighbourhood?ref_genome=${encodeURIComponent(refKey)}&target_genome=${encodeURIComponent(tgtKey)}&ref_gene_id=${encodeURIComponent(srcGeneId)}&target_gene_id=${encodeURIComponent(dstGeneId)}&window_size=${NEIGHBOURHOOD_FLANK_WINDOW_SIZE}${useHomology ? '&use_homology=true' : ''}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Failed to load neighbourhood links')
      }
      const json = await res.json()
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return null
      const homologies = Array.isArray(json?.homologies)
        ? json.homologies.filter((pair) => Array.isArray(pair) && pair.length >= 2)
        : []
      const homologyLinks = Array.isArray(json?.homology_links) ? json.homology_links : []
      const refGenes = Array.isArray(json?.reference_genes) ? json.reference_genes : []
      const targetGenes = Array.isArray(json?.target_genes) ? json.target_genes : []
      const resolvedRefGeneId = String(json?.request_ref_gene_id || srcGeneId).trim()
      const resolvedTargetGeneId = String(json?.request_target_gene_id || dstGeneId).trim()
      setNeighbourhoodLinksByPair((prev) => ({ ...prev, [pairKey]: homologies }))
      setNeighbourhoodHomologyLinksByPair((prev) => ({ ...prev, [pairKey]: homologyLinks }))
      if (refGenes.length || targetGenes.length) trackAchievement('neighbourhood.loaded')
      if (refGenes.length || targetGenes.length) {
        setNeighbourhoodTracksByGenome((prev) => {
          const next = { ...(prev || {}) }
          if (refGenes.length) {
            next[refKey] = mergeNeighbourhoodTrack(
              prev?.[refKey],
              refGenes,
              String(json?.center_ref_id || resolvedRefGeneId).trim(),
              resolvedRefGeneId,
              NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
            )
          }
          if (targetGenes.length) {
            next[tgtKey] = mergeNeighbourhoodTrack(
              prev?.[tgtKey],
              targetGenes,
              String(json?.center_target_id || resolvedTargetGeneId).trim(),
              resolvedTargetGeneId,
              NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
            )
          }
          return next
        })
      }
      setNeighbourhoodPairRequestByKey((prev) => ({
        ...prev,
        [pairKey]: {
          refGeneId: resolvedRefGeneId,
          targetGeneId: resolvedTargetGeneId,
          windowSize: NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
          useHomology,
        },
      }))
      return json
    } catch (e) {
      if (e?.name === 'AbortError') return null
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return null
      console.error(`Neighbourhood pair fetch error (${pairKey}):`, e)
      return null
    } finally {
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return
      if (neighbourhoodPairAbortRef.current[pairKey] === controller) {
        delete neighbourhoodPairAbortRef.current[pairKey]
      }
      if (useHomology) {
        setNeighbourhoodHomologyPairLoading((prev) => {
          if (!prev?.[pairKey]) return prev
          const next = { ...prev }
          delete next[pairKey]
          return next
        })
      }
    }
  }

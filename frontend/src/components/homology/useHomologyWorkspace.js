import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { API_BASE } from '../../backendRuntime'
import { getGenomeKey } from '../../utils/genomeIdentity.js'
import { allowedTargets, effectiveQuery, hasHomologySource, initialWorkspace, PAGE_SIZE, SearchQueue, workspaceReducer } from './model.js'

async function search(body, signal) {
    const response = await fetch(`${API_BASE}/api/homology/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not search homologies.')
    return data
}

// Owned by App, including the queue, so unmounting the view does not erase results.
export default function useHomologyWorkspace({ genomes, localGenomes, outputDir, enabled }) {
    const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspace)
    const [queue] = useState(() => new SearchQueue(3))
    const [diskGenomes, setDiskGenomes] = useState({ outputDir: '', genomes: [] })
    const availableGenomes = useMemo(() => {
        const records = diskGenomes.outputDir === outputDir ? diskGenomes.genomes : []
        return [...new Map([...records, ...localGenomes, ...genomes].map(genome => [getGenomeKey(genome), genome])).values()]
    }, [diskGenomes, outputDir, localGenomes, genomes])
    const sourceSignature = JSON.stringify(genomes.map(genome => [getGenomeKey(genome), genome.files?.homology || '']))
    useEffect(() => {
        dispatch({ type: 'sync', genomes })
        const active = new Set(genomes.map(getGenomeKey))
        for (const key of queue.tasks.keys()) {
            const genomeKey = key.replace(/^(search|detail):/, '')
            if (!active.has(genomeKey)) queue.cancel(key)
        }
        // Changing a path invalidates requests before they can populate the new source.
        for (const genome of genomes) {
            const key = getGenomeKey(genome)
            if (state.panels[key] && state.panels[key].configuredSourcePath !== (genome.files?.homology || '')) {
                queue.cancel(`search:${key}`)
                queue.cancel(`detail:${key}`)
            }
        }
    // Only changes to membership or source paths need to reconcile cached panels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourceSignature, queue])

    useEffect(() => {
        if (!enabled) return
        const controller = new AbortController()
        const refresh = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/homology/sources`, { signal: controller.signal })
                if (!response.ok) return
                const data = await response.json()
                if (!controller.signal.aborted) dispatch({ type: 'sync', genomes, sources: data.sources })
            } catch { /* A transient availability check must not destroy successful searches. */ }
        }
        refresh()
        const timer = setInterval(refresh, 30000)
        return () => { controller.abort(); clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, sourceSignature, outputDir])

    useEffect(() => {
        if (!enabled || !outputDir) return
        const controller = new AbortController()
        const load = async () => {
            try {
                const response = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`, { signal: controller.signal })
                if (!response.ok) return
                const records = await response.json()
                if (!controller.signal.aborted) setDiskGenomes({ outputDir, genomes: (Array.isArray(records) ? records : []).flatMap(genome => genome.dataset_instances?.length ? genome.dataset_instances : [genome]) })
            } catch { /* Registered genomes remain available during a failed disk scan. */ }
        }
        load()
        return () => controller.abort()
    }, [enabled, outputDir, sourceSignature])

    useEffect(() => {
        // React's development StrictMode remounts effects on the same state objects.
        queue.closed = false
        return () => queue.dispose()
    }, [queue])

    const run = useCallback(key => {
        const query = effectiveQuery(state, key)
        queue.cancel(`detail:${key}`)
        const requestId = queue.replace(`search:${key}`, async task => {
            if (task.controller.signal.aborted) return
            dispatch({ type: 'running', key, requestId: task.id })
            try {
                const data = await search({ genome_key: key, gene_query: query, limit: PAGE_SIZE }, task.controller.signal)
                if (!task.controller.signal.aborted) dispatch({ type: 'success', key, requestId: task.id, data })
            } catch (error) {
                if (!task.controller.signal.aborted) dispatch({ type: 'failure', key, requestId: task.id, error: error.message })
            }
        })
        dispatch({ type: 'start', key, requestId, query })
        queue.pump()
    }, [state, queue])

    const runAll = useCallback(() => {
        for (const genome of genomes) {
            const key = getGenomeKey(genome)
            if (hasHomologySource(state.panels[key]) && effectiveQuery(state, key)) run(key)
        }
    }, [genomes, state, run])

    const activePanel = state.panels[state.activeTab]
    const targetAssemblies = useMemo(() => allowedTargets(state.filters, genomes, availableGenomes), [state.filters, genomes, availableGenomes])
    const detailBody = activePanel?.status === 'ready' ? {
        genome_key: state.activeTab, gene_query: activePanel.submittedQuery,
        min_identity: state.filters.minIdentity === '' ? null : Number(state.filters.minIdentity),
        min_coverage: state.filters.minCoverage === '' ? null : Number(state.filters.minCoverage),
        types: state.filters.types, target_assemblies: targetAssemblies,
        offset: activePanel.offset, limit: PAGE_SIZE,
        focus_query_gene_id: activePanel.navigation?.geneId || '', focus_target_key: activePanel.navigation?.targetKey || '',
        sort_key: state.filters.sortKey, direction: state.filters.direction,
        include_evidence: false,
    } : null
    const detailSignature = detailBody ? JSON.stringify([activePanel.sourceToken, detailBody, activePanel.navigation?.id]) : ''
    useEffect(() => {
        if (!enabled || !detailSignature) return
        const [, body] = JSON.parse(detailSignature)
        const key = body.genome_key
        const requestId = queue.replace(`detail:${key}`, async task => {
            try {
                const data = await search(body, task.controller.signal)
                if (!task.controller.signal.aborted) dispatch({ type: 'detailSuccess', key, requestId: task.id, data })
            } catch (error) {
                if (!task.controller.signal.aborted) dispatch({ type: 'detailFailure', key, requestId: task.id, error: error.message })
            }
        })
        dispatch({ type: 'detailStart', key, requestId })
        queue.pump()
        return () => queue.cancel(`detail:${key}`)
    }, [enabled, detailSignature, queue])

    const openEvidence = useCallback((key, geneId, targetKey) => {
        dispatch({ type: 'focus', key, geneId, targetKey })
        dispatch({ type: 'tab', key })
    }, [])
    return { state, dispatch, run, runAll, openEvidence, availableGenomes }
}

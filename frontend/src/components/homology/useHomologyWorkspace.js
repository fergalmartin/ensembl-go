import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime'
import { consumeRestoredSessionState, peekRestoredSessionState, registerSessionState } from '../../sessionResume.js'
import { getGenomeKey } from '../../utils/genomeIdentity.js'
import { allowedTargets, effectiveQuery, hasHomologySource, homologyResultTab, initialWorkspace, PAGE_SIZE, SearchQueue, workspaceReducer } from './model.js'

async function search(body, signal) {
    const response = await fetch(`${API_BASE}/api/homology/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not search homologies.')
    return data
}

// Owned by App, including the queue, so unmounting the view does not erase results.
export default function useHomologyWorkspace({ genomes, localGenomes, outputDir, enabled }) {
    // The searches the reader had before the page reloaded (see sessionResume.js): the
    // query, filters and tab come back at once, and the searches themselves are run again
    // the first time the view is open, rather than on load for a view nobody is looking at.
    const resumeRef = useRef(undefined)
    if (resumeRef.current === undefined) {
        const saved = peekRestoredSessionState('homology.workspace')
        resumeRef.current = saved && typeof saved === 'object' ? saved : null
    }
    const [state, dispatch] = useReducer(workspaceReducer, undefined, () => {
        const base = initialWorkspace()
        const saved = resumeRef.current
        if (!saved) return base
        return {
            ...base,
            sharedQuery: typeof saved.sharedQuery === 'string' ? saved.sharedQuery : '',
            activeTab: typeof saved.activeTab === 'string' && saved.activeTab ? saved.activeTab : base.activeTab,
            filters: { ...base.filters, ...(saved.filters && typeof saved.filters === 'object' ? saved.filters : {}) },
            visibleColumns: Array.isArray(saved.visibleColumns) ? saved.visibleColumns : null,
            summaryPage: Number(saved.summaryPage) || 0,
        }
    })
    const pendingResumeRef = useRef(undefined)
    if (pendingResumeRef.current === undefined) {
        const panels = resumeRef.current?.panels
        pendingResumeRef.current = panels && typeof panels === 'object' && Object.keys(panels).length
            ? Object.fromEntries(Object.entries(panels).map(([key, entry]) => [key, { ...entry, phase: 'waiting' }]))
            : null
    }
    // Read only when a snapshot is taken. Results are not kept — they are searched again.
    const stateRef = useRef(state)
    stateRef.current = state
    useEffect(() => {
        consumeRestoredSessionState('homology.workspace')
        return registerSessionState('homology.workspace', () => {
            const current = stateRef.current
            const panels = {}
            for (const [key, panel] of Object.entries(current.panels)) {
                const searched = ['queued', 'loading', 'ready'].includes(panel.status) ? panel.submittedQuery : ''
                const pending = pendingResumeRef.current?.[key]
                if (pending) panels[key] = { override: pending.override ?? null, query: pending.query || '', offset: pending.offset || 0, navigation: pending.navigation || null }
                else if (searched || panel.override !== null) panels[key] = { override: panel.override, query: searched, offset: panel.offset || 0, navigation: panel.navigation || null }
            }
            return {
                sharedQuery: current.sharedQuery,
                activeTab: current.activeTab,
                filters: current.filters,
                visibleColumns: current.visibleColumns,
                summaryPage: current.summaryPage,
                panels,
            }
        })
    }, [])
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

    const run = useCallback((key, submitted = null) => {
        const query = submitted ?? effectiveQuery(state, key)
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

    // Searching again for what the reader had found before the reload, then going back to
    // the page or the gene they were on once the results are in.
    const runRef = useRef(run)
    runRef.current = run
    useEffect(() => {
        const pending = pendingResumeRef.current
        if (!enabled || !pending) return
        for (const [key, entry] of Object.entries(pending)) {
            const panel = state.panels[key]
            if (!panel) continue
            if (entry.phase === 'waiting') {
                if (entry.override !== null && entry.override !== undefined && panel.override !== entry.override) {
                    dispatch({ type: 'override', key, value: entry.override })
                }
                if (!entry.query) { delete pending[key]; continue }
                if (!hasHomologySource(panel)) continue
                entry.phase = 'searching'
                runRef.current(key, entry.query)
            } else if (entry.phase === 'searching' && panel.status === 'ready') {
                if (entry.navigation?.geneId) dispatch({ type: 'focus', key, geneId: entry.navigation.geneId, targetKey: entry.navigation.targetKey })
                else if (entry.offset) dispatch({ type: 'page', key, offset: entry.offset })
                delete pending[key]
            } else if (entry.phase === 'searching' && ['error', 'stale', 'missing'].includes(panel.status)) {
                delete pending[key]
            }
        }
        if (!Object.keys(pending).length) pendingResumeRef.current = null
    }, [enabled, state.panels])

    const runAll = useCallback(() => {
        for (const genome of genomes) {
            const key = getGenomeKey(genome)
            if (hasHomologySource(state.panels[key]) && effectiveQuery(state, key)) run(key)
        }
    }, [genomes, state, run])

    const activeTab = homologyResultTab(genomes, state)
    const activePanel = state.panels[activeTab]
    const targetAssemblies = useMemo(() => allowedTargets(state.filters, genomes, availableGenomes), [state.filters, genomes, availableGenomes])
    const detailBody = activePanel?.status === 'ready' ? {
        genome_key: activeTab, gene_query: activePanel.submittedQuery,
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

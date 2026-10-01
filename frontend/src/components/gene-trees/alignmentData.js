/**
 * The alignment behind the Structure (and Sequence) data columns: which of the leaves on
 * show are linked to local genes, whether a stored alignment already covers their
 * transcripts, and, when none does, a run the user starts and can follow and cancel.
 *
 * MAFFT never runs on its own: an uncovered set of rows says so (`needsRun`, with the
 * backend's size estimate) and waits for `run()`. A run carries on while the user looks
 * elsewhere; coming back to the same rows picks its progress up again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './data.js'
import { alignmentGenes, geneKey } from './alignmentGenes.js'

export { ALIGNMENT_DEFAULTS, FLANK_CHOICES_BP, INTRON_EDGE_CHOICES, alignmentGenes } from './alignmentGenes.js'

// For the visit: plans by request, projected rows by alignment and rows, runs by request.
const PLANS = new Map()
const ROWS = new Map()
const RUNS = new Map() // request key → job id

/**
 * `useTreeAlignment(nodes, links, settings, enabled, name)` →
 * `{status, plan, data, job, error, run, cancel}`. `status` is 'off', 'planning',
 * 'needs-run', 'running', 'loading', 'ready', 'too-few' or 'error'; `data` is
 * `{id, length, rows: Map(leaf id → row), consensus}` once an alignment is on hand.
 */
export function useTreeAlignment(nodes, links, settings, enabled, name = 'gene tree') {
  const genes = useMemo(() => (enabled ? alignmentGenes(nodes, links) : new Map()), [nodes, links, enabled])
  const request = useMemo(() => {
    const unique = new Map()
    for (const gene of genes.values()) unique.set(geneKey(gene), gene)
    return {
      genes: [...unique.values()].sort((a, b) => geneKey(a).localeCompare(geneKey(b))),
      settings: { region: settings.region, flank: settings.flank, intron_edge: settings.intron_edge, transcript: settings.transcript },
    }
  }, [genes, settings.region, settings.flank, settings.intron_edge, settings.transcript])
  const key = useMemo(() => JSON.stringify(request), [request])
  const [state, setState] = useState({ key: '', status: 'off' })
  const [job, setJob] = useState(null)
  const [version, setVersion] = useState(0)
  const nameRef = useRef(name)
  nameRef.current = name

  // Plan, then fetch what a covering alignment has for these rows.
  useEffect(() => {
    if (!enabled) { setState({ key, status: 'off' }); return undefined }
    if (request.genes.length < 2) { setState({ key, status: 'too-few' }); return undefined }
    const controller = new AbortController()
    let cancelled = false
    ;(async () => {
      try {
        let plan = PLANS.get(key)
        if (!plan) {
          setState(prev => ({ key, status: 'planning', plan: prev.key === key ? prev.plan : null }))
          plan = await api('/alignments/plan', request, controller.signal)
          PLANS.set(key, plan)
        }
        if (cancelled) return
        if (!plan.covered) {
          setState({ key, status: RUNS.has(key) ? 'running' : 'needs-run', plan })
          return
        }
        const rowKeys = plan.rows.map(r => r.row_key)
        const rowsKey = `${plan.covered}|${rowKeys.join(',')}`
        let projected = ROWS.get(rowsKey)
        if (!projected) {
          setState({ key, status: 'loading', plan })
          projected = await api(`/alignments/${encodeURIComponent(plan.covered)}/rows`, { rows: rowKeys }, controller.signal)
          ROWS.set(rowsKey, projected)
        }
        if (!cancelled) setState({ key, status: 'ready', plan, projected })
      } catch (err) {
        if (err.name === 'AbortError' || cancelled) return
        // A stored alignment removed meanwhile: plan again.
        if (err.status === 404) PLANS.delete(key)
        setState({ key, status: 'error', error: err.message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [key, request, enabled, version])

  // Follow a run for these rows, started here or before the user looked away.
  useEffect(() => {
    const jobId = RUNS.get(key)
    if (!enabled || !jobId) { setJob(null); return undefined }
    let stop = false
    let timer = 0
    const poll = async () => {
      try {
        const next = await api(`/alignments/jobs/${jobId}`)
        if (stop) return
        setJob(next)
        if (['queued', 'running'].includes(next.status)) { timer = setTimeout(poll, 400); return }
        RUNS.delete(key)
        PLANS.delete(key)
        if (next.status === 'failed') setState(prev => ({ ...prev, key, status: 'error', error: next.error || 'The alignment failed' }))
        else if (next.status === 'ready') setState(prev => ({ ...prev, key, status: 'loading' }))
        setVersion(v => v + 1)
      } catch (err) {
        if (stop) return
        RUNS.delete(key)
        setState(prev => ({ ...prev, key, status: 'error', error: err.status === 404 ? 'The alignment run was lost (the backend restarted)' : err.message }))
      }
    }
    poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [key, enabled, version])

  const run = useCallback(async () => {
    if (RUNS.has(key)) return
    try {
      const started = await api('/alignments/run', { ...request, name: nameRef.current })
      RUNS.set(key, started.job)
      setState(prev => ({ ...prev, key, status: 'running' }))
      setVersion(v => v + 1)
    } catch (err) {
      setState(prev => ({ ...prev, key, status: 'error', error: err.message }))
    }
  }, [key, request])

  const cancel = useCallback(() => {
    const jobId = RUNS.get(key)
    if (jobId) api(`/alignments/jobs/${jobId}/cancel`, {}).catch(() => {})
  }, [key])

  const retry = useCallback(() => { PLANS.delete(key); setVersion(v => v + 1) }, [key])

  // Rows by leaf: a leaf's gene → its row key (the plan) → its aligned row.
  const data = useMemo(() => {
    if (state.key !== key || state.status !== 'ready' || !state.projected) return null
    const byRowKey = new Map(state.projected.rows.map(r => [r.row_key, r]))
    const byGene = new Map(state.plan.rows.map(r => [r.gene, r.row_key]))
    const rows = new Map()
    for (const [leafId, gene] of genes) {
      const row = byRowKey.get(byGene.get(geneKey(gene)))
      if (row) rows.set(leafId, row)
    }
    return { id: state.projected.id, length: state.projected.alignment_length, rows, transcripts: byRowKey.size, consensus: state.projected.consensus,
      strategy: state.projected.strategy, params: state.projected.params }
  }, [state, key, genes])

  // Which leaves are still coming, and which cannot be drawn and why.
  const { pending, failed } = useMemo(() => {
    const failedByGene = new Map((state.key === key && state.plan?.failed || []).map(f => [f.gene, f.reason]))
    // Placeholders only while something is on its way, not while a run waits to be asked for.
    const coming = state.key !== key || ['planning', 'loading', 'running'].includes(state.status) || RUNS.has(key)
    const waiting = new Set()
    const failedLeaves = new Map()
    for (const [leafId, gene] of genes) {
      const reason = failedByGene.get(geneKey(gene))
      if (reason) failedLeaves.set(leafId, reason)
      else if (coming && !data?.rows.has(leafId)) waiting.add(leafId)
    }
    return { pending: waiting, failed: failedLeaves }
  }, [state, key, genes, data])

  const current = state.key === key ? state : { status: enabled ? 'planning' : 'off' }
  return { status: current.status, plan: current.plan || null, error: current.error || '', data, job: RUNS.has(key) ? job : null,
    pending, failed, genes: genes.size, run, cancel, retry }
}

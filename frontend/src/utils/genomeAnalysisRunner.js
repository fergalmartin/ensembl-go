// Runs a genome or annotation analysis and follows it to completion.
//
// The work happens on the backend as a task: one POST to start it, then polls
// until it reports success or failure. This lives outside any component because
// more than one view offers the analysis — the genome selector runs it per file,
// the stats overview runs it per genome and gene set — and they must produce
// identical reports, stored under identical keys, or the two views would
// disagree about whether a genome had been analysed.

import { API_BASE } from '../backendRuntime'

const POLL_INTERVAL_MS = 300

export const ANALYSIS_KIND_GENOME = 'genome'
export const ANALYSIS_KIND_ANNOTATION = 'annotation'

export function analysisStartEndpoint(kind, apiBase = API_BASE) {
  return kind === ANALYSIS_KIND_GENOME
    ? `${apiBase}/api/custom/validate-genome`
    : `${apiBase}/api/custom/validate-annotation`
}

export function analysisBodyFor(kind, files) {
  if (kind === ANALYSIS_KIND_GENOME) {
    const path = String(files?.fasta || '').trim()
    return path ? { fasta_path: path } : null
  }
  const path = String(files?.gff3 || '').trim()
  if (!path) return null
  return {
    annotation_path: path,
    fasta_path: String(files?.fasta || '').trim() || null,
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start an analysis and poll it to completion.
 *
 * `onUpdate` is called with each poll payload so a caller can show progress.
 * Resolves with the final payload; rejects only when the analysis could not be
 * started or followed, which callers render as a failed report rather than
 * letting it escape.
 */
export async function runGenomeAnalysis({
  kind,
  body,
  onUpdate = null,
  apiBase = API_BASE,
  pollIntervalMs = POLL_INTERVAL_MS,
  isCancelled = null,
}) {
  const res = await fetch(analysisStartEndpoint(kind, apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const started = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(started?.detail || 'Failed to start analysis')
  if (!started?.task_id) throw new Error('Analysis did not return a task id')

  for (;;) {
    await delay(pollIntervalMs)
    if (isCancelled?.()) return null
    const poll = await fetch(`${apiBase}/api/custom/validation/${started.task_id}`)
    const payload = await poll.json().catch(() => ({}))
    if (!poll.ok) throw new Error(payload?.detail || 'Analysis lookup failed')
    onUpdate?.(payload)
    if (payload.status === 'success' || payload.status === 'failed') return payload
  }
}

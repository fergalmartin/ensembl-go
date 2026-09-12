/** Fixed-position progress never participates in the sequence canvas layout. */
export default function MotifProgress({ operation }) {
  const job = operation.progress
  if (!job) return null
  if (!operation.visible) return <div className="al-motif-working" role="status">Preparing motif colours… <button onClick={operation.cancel}>Cancel</button></div>
  const total = job.total || 0, done = job.completed || 0
  const percent = total ? Math.min(100, Math.floor(done / total * 100)) : null
  const phase = { queued: 'Waiting to prepare motifs…', searching: 'Searching sequence…', cached: 'Reading cached searches…', preparing: 'Preparing colours for each zoom level…', publishing: 'Opening prepared results…' }[job.phase] || 'Preparing motif colours…'
  const failed = job.status === 'failed'
  return <div className="al-modal-shade al-motif-progress">
    <div className="al-modal al-import" role="dialog" aria-modal="true" aria-label="Preparing motif colours">
      <h3>{failed ? 'Motif preparation stopped' : 'Preparing motif colours'}</h3>
      <p role={failed ? 'alert' : 'status'}>{failed ? job.error : phase}</p>
      {!failed && <div className={`al-progress ${percent == null ? 'unknown' : ''}`} role="progressbar" aria-label="Sequence regions prepared"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><i style={percent == null ? undefined : { width: `${percent}%` }} /></div>}
      <small>{done.toLocaleString()} of {total.toLocaleString()} sequence regions prepared{percent != null ? ` · ${percent}%` : ''}.</small>
      {!!job.motif_total && <small>Current region: motif {job.motif_index || 0} of {job.motif_total}{job.motif ? ` · ${job.motif}` : ''}</small>}
      <small>{(job.searched || 0).toLocaleString()} new searches · {(job.cached || 0).toLocaleString()} cached searches reused.</small>
      {!!job.prepared_cached && <small>{job.prepared_cached.toLocaleString()} regions already had prepared colours.</small>}
      <small>Searches are cached to speed up future motif rendering. Cancel keeps fully processed sequence regions; the current view stays unchanged.</small>
      <button onClick={failed ? operation.dismiss : operation.cancel}>{failed ? 'Close' : 'Cancel'}</button>
    </div>
  </div>
}

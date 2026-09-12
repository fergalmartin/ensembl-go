/** What a long import is doing, while it is doing it.
 *
 * Indexing a large alignment takes minutes. Left to a line of text beside a
 * still-open file chooser, it read as nothing having happened, and the obvious
 * response - choose the file again - is the one thing that does not help.
 */
const sizes = bytes => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export default function ImportProgress({ job, name, opening, cancelling, onCancel }) {
  const read = job?.bytes, total = job?.total_bytes
  // Only where the reader knows the size of what it is reading. Pasted content
  // and MAFFT results have no file behind them, and a bar that invented a
  // denominator would be worse than none.
  const fraction = total ? Math.max(0, Math.min(1, read / total)) : null
  const counted = job?.blocks ? `${job.blocks.toLocaleString()} blocks` : job?.rows ? `${job.rows.toLocaleString()} sequences` : ''
  const phase = opening ? 'Opening the indexed alignment…'
    : job?.status === 'queued' ? 'Waiting to start…'
    : cancelling ? 'Stopping…' : 'Reading and indexing…'
  return <div className="al-modal-shade">
    <div className="al-modal al-import" role="dialog" aria-modal="true" aria-label="Opening alignment">
      <h3>{name || 'Opening alignment'}</h3>
      <p aria-live="polite">{phase}</p>
      <div className={`al-progress ${fraction == null ? 'unknown' : ''}`}
        role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={fraction == null ? undefined : Math.round(fraction * 100)}>
        <i style={fraction == null ? undefined : { width: `${Math.max(2, fraction * 100)}%` }} />
      </div>
      <small className="al-progress-note">
        {fraction == null ? counted || 'Working…'
          : `${Math.round(fraction * 100)}% · ${sizes(read)} of ${sizes(total)}${counted ? ` · ${counted}` : ''}`}
      </small>
      <small>The source file is not changed. You can cancel and reopen it in another format.</small>
      <button disabled={!job || cancelling} onClick={onCancel}>{cancelling ? 'Cancelling…' : 'Cancel import'}</button>
    </div>
  </div>
}

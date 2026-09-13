/** Persistent applied values; menu drafts must never be passed here. */
export default function ControlLabel({ label, value, active = false }) {
  return <span className="al-control-label"><span className="al-control-name">{label}{active && <span className="al-control-active">✓ Active</span>}</span><strong className="al-control-value">{value}</strong></span>
}

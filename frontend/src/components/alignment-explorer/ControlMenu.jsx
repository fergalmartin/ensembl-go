import { createPortal } from 'react-dom'

/** The outer frame keeps its connector visible while long menu contents scroll. */
export default function ControlMenu({ id, root, anchor, title, current, children, className = '' }) {
  if (!anchor || !root) return null
  return createPortal(<div className="al-anchored-menu" style={anchor}>
    <div id={id} className={`al-tool-menu ${className}`} role="dialog" aria-label={`${title} options`}>
      <div className="al-menu-heading"><strong>{title}</strong><span>Applied: {current}</span></div>
      {children}
    </div>
  </div>, root)
}

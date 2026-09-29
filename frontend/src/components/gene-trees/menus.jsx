import { createPortal } from 'react-dom'
import { useMenuDismiss } from '../alignment-explorer/menuAnchor.js'

/** One menu hanging off a control, positioned and dismissed like the Alignment Explorer's. */
export default function AnchoredMenu({ anchorRef, position, onClose, title, children, isLight = false }) {
  useMenuDismiss(Boolean(position), onClose, anchorRef, 'gt-menu')
  if (!position) return null
  const { above, ...style } = position
  return createPortal(
    <div className={`gt-menu gt-anchored${above ? ' above' : ''}${isLight ? ' light' : ''}`} style={style} role="dialog" aria-label={title}>
      <div className="gt-menu-heading">{title}</div>
      {children}
    </div>, document.body)
}

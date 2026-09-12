import { createPortal } from 'react-dom'

/** A word above a button, for a click that changes something out of sight.
 *
 * Cycling the colour scheme from the bar has no other feedback: the button no
 * longer carries the mode, and the sheet recolouring is exactly what the reader
 * is not yet looking at. It clears itself when its own animation ends rather
 * than on a timer, so there is no timer to cancel when the next one arrives.
 */
export default function ToolToast({ toast, root, onDone }) {
  if (!toast || !root) return null
  return createPortal(<div key={toast.key} className="al-toast" role="status"
    style={{ top: toast.at.top, left: toast.at.left }} onAnimationEnd={onDone}>{toast.label}</div>, root)
}

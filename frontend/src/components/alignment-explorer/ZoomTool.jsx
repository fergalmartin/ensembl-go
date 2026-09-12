import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, toastPosition, useMenuDismiss } from './menuAnchor'
import ToolToast from './ToolToast'

/** Which of the two things a zoom gesture does, behind one button.
 *
 * It was a labelled select in the bar, the last one left once selecting and
 * colouring moved behind arrows. Two alternatives with a sentence each read
 * better in a menu than in an option list with one tooltip covering both.
 */
const ZOOM_MODES = [
  { id: 'alignment', label: 'Alignment',
    hint: 'Zooms the columns and leaves rows their height, which is what reading an alignment wants.' },
  { id: 'panel', label: 'Panel',
    hint: 'Zooms the whole sheet: blocks, names and labels shrink together, the view centres, and whitespace opens around the edges.' },
]

export default function ZoomTool({ panel, plane = 1, root, onMode }) {
  const [anchor, setAnchor] = useState(null)
  const [toast, setToast] = useState(null)
  const button = useRef(null)
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const current = ZOOM_MODES[panel ? 1 : 0]
  const shrunk = panel && plane < 1 ? `${Math.round(plane * 100)}%` : null
  // The button no longer carries the mode, so switching it has to say so
  // somewhere: above the button, where the press was.
  const switchTo = () => {
    onMode(!panel)
    setToast({ label: ZOOM_MODES[panel ? 0 : 1].label, at: toastPosition(button.current), key: Date.now() })
  }
  return <>
    <div className={`al-split ${panel ? 'selected' : ''}`} ref={button}>
      <button className="al-split-main al-zoom-button" aria-pressed={!!panel}
        title={`Zoom: ${current.label}. ${current.hint} Click to switch.`}
        onClick={switchTo}>Zoom{shrunk && <b>{shrunk}</b>}</button>
      <button className="al-split-arrow" aria-label="Zoom options" aria-expanded={!!anchor}
        onClick={() => setAnchor(open => open ? null : menuPosition(button.current))}>▾</button>
    </div>
    {anchor && root && createPortal(<div className="al-tool-menu" role="dialog" aria-label="Zoom options" style={anchor}>
      <div className="al-menu-options">
        {ZOOM_MODES.map(option => <button key={option.id} type="button"
          className={`al-menu-option ${option.id === current.id ? 'selected' : ''}`}
          aria-pressed={option.id === current.id}
          onClick={() => { onMode(option.id === 'panel'); close() }}>
          <strong>{option.label}</strong><small>{option.hint}</small></button>)}
      </div>
      <div className="al-menu-foot">
        <small>Dragging, picking and reordering work in both.{shrunk ? ` Panel is at ${shrunk}.` : ''}</small>
      </div>
    </div>, root)}
    <ToolToast toast={toast} root={root} onDone={() => setToast(null)} />
  </>
}

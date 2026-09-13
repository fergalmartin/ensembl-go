import { useCallback, useId, useRef, useState } from 'react'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import ControlMenu from './ControlMenu'

const ZOOM_MODES = [
  { id: 'alignment', label: 'Alignment',
    hint: 'Zooms the columns and keeps rows at their normal height.' },
  { id: 'panel', label: 'Panel',
    hint: 'Zooms the whole sheet: blocks, names and labels scale together.' },
]

export default function ZoomTool({ panel, plane = 1, root, onMode }) {
  const [anchor, setAnchor] = useState(null)
  const button = useRef(null), menuId = useId()
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const current = ZOOM_MODES[panel ? 1 : 0]
  const value = panel ? `Panel · ${Math.round(plane * 100)}%` : current.label
  const open = () => { if (anchor) close(); else setAnchor(menuPosition(button.current, 320)) }
  // One choice, taken as soon as it is made: a menu of two alternatives had
  // nothing for Apply to add over the click that picked one.
  const choose = id => { onMode(id === 'panel'); close() }
  return <>
    <button ref={button} className={`al-control al-control-zoom ${anchor ? 'menu-open' : ''}`}
      aria-label={`Zoom: ${value}. Zoom options`} aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
      title="Choose how zooming changes the alignment" onClick={open}>
      <ControlLabel label="Zoom" value={value}/><ControlChevron/>
    </button>
    <ControlMenu id={menuId} root={root} anchor={anchor} title="Zoom" current={value}>
      <div className="al-menu-options">
        {ZOOM_MODES.map(option => <button key={option.id} type="button"
          className={`al-menu-option ${option.id === current.id ? 'selected' : ''}`}
          aria-pressed={option.id === current.id} onClick={() => choose(option.id)}>
          <strong>{option.label}</strong><small>{option.hint}</small></button>)}
      </div>
      <div className="al-menu-actions"><small>Picking one applies it.</small><button onClick={close}>Close</button></div>
    </ControlMenu>
  </>
}

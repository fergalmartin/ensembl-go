import { useCallback, useId, useRef, useState } from 'react'
import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import ControlMenu from './ControlMenu'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import { SELECT_KINDS, isSelectMode, selectKind } from './selectKinds'

/** Pointer activation is separate from editing the remembered selection shape. */
export default function SelectTool({ mode, kind, picked = 0, rows = 0, root, onMode, onKind, onClear }) {
  const [anchor, setAnchor] = useState(null)
  const button = useRef(null), menuId = useId()
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const active = isSelectMode(mode)
  const current = selectKind(active ? mode : kind)
  // Picking a shape takes effect where the pick was made. Apply only ever
  // repeated the click that chose, and left the menu looking unanswered until
  // it was pressed.
  const choose = option => { onKind(option.mode); if (active) onMode(option.mode); close() }
  return <>
    <div className={`al-split al-control-select ${active ? 'selected' : ''} ${anchor ? 'menu-open' : ''}`} ref={button}>
      <button className="al-split-main" aria-pressed={active} title={`${current.label}: ${current.hint}`}
        onClick={() => onMode(current.mode)}><ControlLabel label="Select" value={current.label} active={active}/></button>
      <button className="al-split-arrow" aria-label="Selection options" aria-expanded={!!anchor} aria-haspopup="dialog" aria-controls={anchor ? menuId : undefined}
        title="Choose how a selection is drawn"
        onClick={() => { if(anchor)close();else setAnchor(menuPosition(button.current, 340)) }}><ControlChevron/></button>
    </div>
    <ControlMenu id={menuId} root={root} anchor={anchor} title="Selection" current={`${current.label} · ${active ? 'active' : 'Pan active'}`}>
      <div className="al-menu-options">
        {SELECT_KINDS.map(option => <button key={option.mode} type="button"
          className={`al-menu-option ${option.mode === current.mode ? 'selected' : ''}`}
          aria-pressed={option.mode === current.mode} onClick={() => choose(option)}>
          <strong>{option.label}</strong><small>{option.hint}</small></button>)}
      </div>
      <div className="al-menu-foot">
        <small>{picked
          ? `${rows} ${rows === 1 ? 'sequence' : 'sequences'} · ${picked} ${picked === 1 ? 'pick' : 'picks'}`
          : 'Nothing picked yet'}</small>
        <button type="button" disabled={!picked} onClick={() => { onClear(); close() }}>Clear selection</button>
      </div>
      <div className="al-menu-actions"><small>{active ? 'Picking a shape applies it.' : 'Picking a shape saves it. Click Select to use it.'}</small><button onClick={close}>Close</button></div>
    </ControlMenu>
  </>
}

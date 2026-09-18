import { useCallback, useId, useRef, useState } from 'react'
import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import ControlMenu from './ControlMenu'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import { CURSOR_MODES, isSelectMode, cursorMode, selectKind } from './selectKinds'

/** What the pointer does: one control, three choices.
 *
 * The face says which of them is in hand and switches between moving and
 * selecting, since those are the two the reader alternates between and a
 * completed selection already puts the mode back to Move view. Which shape a
 * selection is drawn in is remembered, so the face comes back to the one last
 * used rather than to a default nobody chose. The third choice, and everything
 * about what is already picked, is behind the arrow.
 */
export default function CursorTool({ mode, shape, picked = 0, rows = 0, root, onMode, onShape, onClear }) {
  const [anchor, setAnchor] = useState(null)
  const button = useRef(null), menuId = useId()
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const selecting = isSelectMode(mode)
  const current = cursorMode(mode)
  const remembered = selectKind(shape)
  // The face is the way back: pressing it while selecting returns to moving the
  // sheet, and pressing it while moving arms the shape last used. Like Hide, the
  // press lands on the word that says what is on rather than a menu away from it.
  const other = selecting ? cursorMode('pan') : remembered
  // Picking a mode takes effect where the pick was made. Apply only ever
  // repeated the click that chose, and left the menu looking unanswered until
  // it was pressed.
  const choose = option => { if (isSelectMode(option.mode)) onShape(option.mode); onMode(option.mode); close() }
  return <>
    <div className={`al-split al-control-cursor ${selecting ? 'selected' : ''} ${anchor ? 'menu-open' : ''}`} ref={button}>
      <button className="al-split-main" aria-pressed={selecting} title={`${current.hint} Click for ${other.label}.`}
        onClick={() => onMode(other.mode)}><ControlLabel label="Cursor" value={current.label}/></button>
      <button className="al-split-arrow" aria-label="Cursor options" aria-expanded={!!anchor} aria-haspopup="dialog" aria-controls={anchor ? menuId : undefined}
        title="Choose what the pointer does"
        onClick={() => { if(anchor)close();else setAnchor(menuPosition(button.current, 340)) }}><ControlChevron/></button>
    </div>
    <ControlMenu id={menuId} root={root} anchor={anchor} title="Cursor" current={current.label}>
      <div className="al-menu-options">
        {CURSOR_MODES.map(option => <button key={option.mode} type="button"
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
      <div className="al-menu-actions"><small>A completed selection returns the cursor to Move view; the shape is remembered.</small><button onClick={close}>Close</button></div>
    </ControlMenu>
  </>
}

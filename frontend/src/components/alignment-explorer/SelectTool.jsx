import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import { SELECT_KINDS, isSelectMode, selectKind } from './selectKinds'

/** One button for selecting, with the two ways of doing it behind its arrow.
 *
 * Split, not plain: the main half turns the tool on with whichever kind was
 * last used, because a completed selection puts the mode back to Pan and asking
 * which kind again on every drag would be the old two buttons in one.
 *
 * The button says `Select` and nothing else. A label that changed to `Columns`
 * made the bar's width jump and read as a different control appearing; which
 * kind is armed belongs in the menu, the tooltip and the shape of the drag.
 */
export default function SelectTool({ mode, kind, picked = 0, rows = 0, root, onMode, onKind, onClear }) {
  const [anchor, setAnchor] = useState(null), [draft, setDraft] = useState(null)
  const button = useRef(null)
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const active = isSelectMode(mode)
  const current = selectKind(active ? mode : kind)
  const chosenMode = draft?.mode || current.mode
  return <>
    <div className={`al-split ${active ? 'selected' : ''}`} ref={button}>
      <button className="al-split-main" aria-pressed={active} title={`${current.label}: ${current.hint}`}
        onClick={() => onMode(active ? 'pan' : current.mode)}>Select</button>
      <button className="al-split-arrow" aria-label="Selection options" aria-expanded={!!anchor}
        title="Choose how a selection is drawn"
        onClick={() => { if(anchor)close();else{setDraft({mode:current.mode,clear:false});setAnchor(menuPosition(button.current))} }}>▾</button>
    </div>
    {anchor && root && createPortal(<div className="al-tool-menu" role="dialog" aria-label="Selection options" style={anchor}>
      <div className="al-menu-options">
        {SELECT_KINDS.map(option => <button key={option.mode} type="button"
          className={`al-menu-option ${option.mode === chosenMode ? 'selected' : ''}`}
          aria-pressed={option.mode === chosenMode} onClick={() => setDraft(value=>({...value,mode:option.mode}))}>
          <strong>{option.label}</strong><small>{option.hint}</small></button>)}
      </div>
      <div className="al-menu-foot">
        <small>{picked
          ? `${rows} ${rows === 1 ? 'sequence' : 'sequences'} · ${picked} ${picked === 1 ? 'pick' : 'picks'}`
          : 'Nothing picked yet'}</small>
        <button type="button" disabled={!picked} onClick={() => setDraft(value=>({...value,clear:true}))}>{draft?.clear ? 'Selection will be cleared' : 'Clear selection'}</button>
      </div>
      <div className="al-menu-actions"><button onClick={close}>Cancel</button><button className="primary" onClick={()=>{if(draft?.clear)onClear();onKind(chosenMode);onMode(chosenMode);close()}}>Apply</button></div>
    </div>, root)}
  </>
}

import { useRef, useState } from 'react'
import AnchoredMenu from './menus.jsx'
import { menuPlacement } from './menuPlacement.js'

/**
 * What is picked, and what can be done with it: copy into a layer (or a new one), widen
 * a marquee to whole clades, and — inside a layer — remove it or re-root on it.
 */
export default function SelectionBar({ genes, pieces, layers, activeId, inLayer, wholeClades, onWholeClades,
  onCopy, onRemove, onClear, singleNode, onReroot, onSplit, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const targets = layers.filter(l => l.id !== 'original' && l.id !== activeId)
  return (
    <div className="gt-selection-bar" role="toolbar" aria-label="Selection">
      <span className="gt-selection-count"><i />{genes.toLocaleString()} gene{genes === 1 ? '' : 's'}{pieces > 1 ? ` in ${pieces} pieces` : ''} picked</span>
      <span ref={anchor}>
        <button type="button" className="primary" onClick={() => setMenu(menu ? null : menuPlacement(anchor.current, 280))}>Copy to layer ▾</button>
      </span>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Copy the picked subtrees into…">
        {targets.map(l => (
          <button key={l.id} type="button" className="gt-menu-option gt-layer-option" onClick={() => { onCopy(l.id); setMenu(null) }}>
            <span className="gt-tool-option-head"><i style={{ background: l.color }} /><strong>{l.name}</strong></span>
            <span>{l.summary}</span>
          </button>
        ))}
        <button type="button" className="gt-menu-option" onClick={() => { onCopy('new'); setMenu(null) }}><strong>＋ A new layer</strong></button>
      </AnchoredMenu>
      <label className="gt-check" title="A box that touches a node brings everything beneath it"><input type="checkbox" checked={wholeClades} onChange={e => onWholeClades(e.target.checked)} />Whole clades</label>
      {inLayer ? <button type="button" onClick={onRemove} title="Remove the picked nodes and everything beneath them (Delete)">Remove</button> : null}
      {inLayer && singleNode ? <button type="button" onClick={onSplit} title="Cut this clade off as a subtree of its own">Split here</button> : null}
      {inLayer && singleNode ? <button type="button" onClick={onReroot} title="Root the subtree on the branch above this node">Re-root here</button> : null}
      <button type="button" onClick={onClear} title="Clear (Esc)">Clear</button>
    </div>
  )
}

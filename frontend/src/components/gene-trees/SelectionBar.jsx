import { useRef, useState } from 'react'
import AnchoredMenu from './menus.jsx'
import { menuPlacement } from './menuPlacement.js'

/**
 * What is picked, and what can be done with it: copy into a layer (or a new one) and,
 * inside a layer, duplicate it there. The Original is never edited — anything that would
 * change a tree is offered only in a layer (`inLayer`); the Original's picks can only be
 * copied out.
 */
export default function SelectionBar({ genes, pieces, layers, activeId, inLayer, onCopy, onDuplicate, onClear, isLight }) {
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
      {inLayer ? <button type="button" onClick={onDuplicate} title="Copy the picked subtrees into this layer, beside the originals">Duplicate</button> : null}
      <button type="button" className="gt-selection-close" onClick={onClear} title="Clear the selection (Esc)" aria-label="Clear the selection">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  )
}

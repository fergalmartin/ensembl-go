import { useRef, useState } from 'react'
import { menuPosition } from '../alignment-explorer/menuAnchor.js'
import AnchoredMenu from './menus.jsx'
import { TOOLS } from './tools.js'

/**
 * The canvas tools, one split button like the Alignment Explorer's CursorTool: the face
 * switches between Explore and whichever tool was used last, the arrow lists them all.
 */
export function ToolIcon({ id, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (id === 'select') return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="3 3" /><path d="M13 13l6 6" /></svg>
  if (id === 'clade') return <svg {...common}><path d="M3 12h4M7 12c3 0 3-6 6-6h7M7 12c3 0 3 6 6 6h7" /><circle cx="7" cy="12" r="2" fill="currentColor" /></svg>
  if (id === 'split') return <svg {...common}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></svg>
  if (id === 'connect') return <svg {...common}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
  return <svg {...common}><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" /></svg>
}

export function ToolButton({ tool, lastTool, onTool, inLayer, pickSummary, onClear, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const available = TOOLS.filter(t => inLayer || !t.layerOnly)
  // A layer tool (from the bar over a layer) is not one of these: the face shows Explore,
  // unlit, and pressing it goes back to exploring.
  const own = TOOLS.find(t => t.id === tool)
  const current = own || TOOLS[0]
  const other = tool === 'explore' ? (available.find(t => t.id === lastTool && t.id !== 'explore') || available[1]) : TOOLS[0]
  return (
    <span ref={anchor} className="gt-split">
      <button type="button" className={`gt-split-main${own && tool !== 'explore' ? ' selected' : ''}`} onClick={() => onTool(other.id)}
        title={`${current.label} (${current.key}) · click for ${other.label}`}>
        <ToolIcon id={current.id} />
        <span>{current.label}</span>
      </button>
      <button type="button" className={`gt-split-arrow${menu ? ' menu-open' : ''}`} aria-label="All tools" aria-expanded={Boolean(menu)}
        onClick={() => setMenu(menu ? null : menuPosition(anchor.current, 340, 'gt'))}>▾</button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Tools">
        {available.map(t => (
          <button key={t.id} type="button" className={`gt-menu-option gt-tool-option${t.id === tool ? ' selected' : ''}`}
            onClick={() => { onTool(t.id); setMenu(null) }}>
            <span className="gt-tool-option-head"><ToolIcon id={t.id} /><strong>{t.label}</strong><kbd>{t.key}</kbd></span>
            <span>{t.hint}</span>
          </button>
        ))}
        <div className="gt-menu-foot">
          <span>{pickSummary || 'Nothing picked'}</span>
          <button type="button" disabled={!pickSummary} onClick={() => { onClear(); setMenu(null) }}>Clear selection</button>
        </div>
        <p className="gt-muted">⇧-drag draws a selection box with any tool. Drag anything picked to copy the selection into a layer; click a pick to deselect it (⌥-click: with everything beneath it).</p>
      </AnchoredMenu>
    </span>
  )
}

/** The layer showing, and the list of them all to pick from (Cycle, beside it, rotates through them). */
export function LayerSwitcher({ layers, activeId, onSwitch, onNew, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const current = layers.find(l => l.id === activeId) || layers[0]
  return (
    <span ref={anchor} className="gt-layer-switcher">
      <button type="button" className="gt-layer-current" onClick={() => setMenu(menu ? null : menuPosition(anchor.current, 300, 'gt'))}
        aria-expanded={Boolean(menu)} title="Choose a layer">
        <i style={{ background: current?.color }} />
        <span>{current?.name}</span>
      </button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Layers">
        {layers.map(l => (
          <button key={l.id} type="button" className={`gt-menu-option gt-layer-option${l.id === activeId ? ' selected' : ''}`}
            onClick={() => { onSwitch(l.id); setMenu(null) }}>
            <span className="gt-tool-option-head"><i style={{ background: l.color }} /><strong>{l.name}</strong></span>
            <span>{l.summary}</span>
          </button>
        ))}
        <button type="button" className="gt-menu-option" onClick={() => { onNew(); setMenu(null) }}><strong>＋ New layer</strong></button>
      </AnchoredMenu>
    </span>
  )
}

export function UndoRedo({ canUndo, canRedo, onUndo, onRedo }) {
  const icon = redo => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  )
  return (
    <span className="gt-undo">
      <button type="button" disabled={!canUndo} onClick={onUndo} title="Undo (⌘Z)" aria-label="Undo">{icon(false)}</button>
      <button type="button" disabled={!canRedo} onClick={onRedo} title="Redo (⇧⌘Z)" aria-label="Redo">{icon(true)}</button>
    </span>
  )
}

/**
 * Data views: extra data from the user's local genomes, drawn in a column beside the
 * leaves. `views` are `{id, label, hint, disabled, note}`; `value` is the one showing, or 'off'.
 */
export function DataViewMenu({ value, views, onChange, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const current = views.find(v => v.id === value)
  const choose = id => { setMenu(null); onChange(id) }
  return (
    <span ref={anchor} className="gt-clade-menu gt-data-menu">
      <button type="button" className={`${menu ? 'menu-open' : ''}${current ? ' on' : ''}`} aria-expanded={Boolean(menu)}
        title={current ? `Data view: ${current.label}` : 'Show data from your local genomes beside the tree'}
        onClick={() => setMenu(menu ? null : menuPosition(anchor.current, 300, 'gt'))}>
        <span>{current ? current.label : 'Data'}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Data views">
        <button type="button" className={`gt-menu-option${value === 'off' ? ' selected' : ''}`} onClick={() => choose('off')}>
          <strong>Off</strong>
          <span>The tree alone</span>
        </button>
        {views.map(view => (
          <button key={view.id} type="button" className={`gt-menu-option${view.id === value ? ' selected' : ''}`} disabled={view.disabled}
            title={view.disabled ? view.note : undefined} onClick={() => choose(view.id)}>
            <strong>{view.label}</strong>
            <span>{view.disabled ? view.note : view.hint}</span>
          </button>
        ))}
      </AnchoredMenu>
    </span>
  )
}

/**
 * What can be done with the selected clade, in the control bar rather than a right-click
 * menu: the app has no right-click. `items` are `{label, onClick, disabled}`; the heading
 * names what they act on, or says how to choose it.
 */
export function CladeMenu({ target, items, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const any = items.some(item => !item.disabled)
  return (
    <span ref={anchor} className="gt-clade-menu">
      <button type="button" className={menu ? 'menu-open' : ''} disabled={!any} aria-expanded={Boolean(menu)}
        title={any ? 'Actions for the selected clade' : 'Select a clade to see what can be done with it'}
        onClick={() => setMenu(menu ? null : menuPosition(anchor.current, 260, 'gt'))}>
        <span>Clade</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title={target || 'No clade selected'}>
        {items.map(item => (
          <button key={item.label} type="button" className="gt-menu-option" disabled={item.disabled}
            onClick={() => { setMenu(null); item.onClick() }}>
            <strong>{item.label}</strong>
          </button>
        ))}
      </AnchoredMenu>
    </span>
  )
}

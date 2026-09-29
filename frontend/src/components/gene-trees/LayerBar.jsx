import { useState } from 'react'
import { LAYER_TOOLS } from './tools.js'

/** The layer tools' marks, in the stroke style of the control bar's tool icons. */
function LayerToolIcon({ id, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (id === 'move') return <svg {...common}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></svg>
  if (id === 'merge') return <svg {...common}><path d="M4 5c5 0 5 7 10 7h6M4 19c5 0 5-7 10-7" /><path d="M17 9l3 3-3 3" /></svg>
  // A graft as the canvas draws one: a branch, and a small clade joined to it by a dashed stem.
  if (id === 'graft') return <svg {...common}><path d="M2 18h20" /><path d="M8 18L15 9" strokeDasharray="2.4 2.4" /><path d="M15 9l6-4.5M15 9l6 4" /><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" /></svg>
  if (id === 'cut') return <svg {...common}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></svg>
  if (id === 'remove') return <svg {...common}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
  return null
}

/** Undo's curved arrow, as the control bar draws it; mirrored for redo. */
function UndoGlyph({ redo = false }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  )
}

/**
 * The bar over a subtree layer: its tools, as the sequence view's transcript bar floats its
 * readings over the sequence (same panel, accent edge, radius and shadow). One tool at a
 * time; pressing the lit one again goes back to exploring. Undo and redo sit at its end,
 * where the edits it makes are.
 */
export default function LayerBar({ layer, tool, onTool, radial, arranged, onRestack, canUndo, canRedo, onUndo, onRedo,
  renameTarget, onRename, isLight }) {
  // Rename: press it with part of one subtree selected, type, and confirm (or cancel). The
  // draft belongs to the subtree it was started on; selecting another starts afresh.
  const [naming, setNaming] = useState(null)
  const editing = naming && renameTarget && naming.id === renameTarget.id ? naming : null
  const finish = save => {
    if (save && editing) onRename(editing.id, editing.draft.trim())
    setNaming(null)
  }
  return (
    <div className="gt-layerbar-track">
      <div className={`gt-layerbar${isLight ? ' light' : ''}`} role="toolbar" aria-label="Subtree layer tools"
        onPointerDown={event => event.stopPropagation()}>
        <div className="gt-layerbar-row">
          <span className="gt-layerbar-name" title={layer.name}><i style={{ background: layer.color }} />{layer.name}</span>
          <span className="gt-layerbar-split" aria-hidden="true" />
          {LAYER_TOOLS.map(t => {
            const on = t.id === tool
            const disabled = t.id === 'move' && radial
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} disabled={disabled}
                className={`gt-layer-tool${on ? ' on' : ''}${t.id === 'remove' ? ' danger' : ''}`}
                title={disabled ? t.radialNote : t.hint}
                onClick={() => onTool(on ? 'explore' : t.id)}>
                <LayerToolIcon id={t.id} />
                <span>{t.label}</span>
              </button>
            )
          })}
          <span className="gt-layerbar-split" aria-hidden="true" />
          {editing ? (
            <span className="gt-layerbar-rename">
              <input autoFocus value={editing.draft} placeholder={renameTarget.auto} aria-label="Subtree name"
                onChange={e => setNaming({ ...editing, draft: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false) }} />
              <button type="button" className="gt-layerbar-act" onClick={() => finish(true)} title="Save the name" aria-label="Save the name">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </button>
              <button type="button" className="gt-layerbar-act" onClick={() => finish(false)} title="Cancel" aria-label="Cancel">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </span>
          ) : (
            <button type="button" className="gt-layer-tool" disabled={!renameTarget}
              title={renameTarget ? `Rename ${renameTarget.label}` : 'Select part of a subtree to rename it'}
              onClick={() => setNaming({ id: renameTarget.id, draft: renameTarget.name || '' })}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
              <span>Rename</span>
            </button>
          )}
          <span className="gt-layerbar-split" aria-hidden="true" />
          <button type="button" className="gt-layerbar-act" disabled={!arranged} onClick={onRestack}
            title="Restack the subtrees" aria-label="Restack the subtrees">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="4" width="16" height="4" rx="1" /><rect x="4" y="10" width="16" height="4" rx="1" /><rect x="4" y="16" width="16" height="4" rx="1" />
            </svg>
          </button>
          <span className="gt-layerbar-split" aria-hidden="true" />
          <button type="button" className="gt-layerbar-act" disabled={!canUndo} onClick={onUndo} title="Undo" aria-label="Undo"><UndoGlyph /></button>
          <button type="button" className="gt-layerbar-act" disabled={!canRedo} onClick={onRedo} title="Redo" aria-label="Redo"><UndoGlyph redo /></button>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { CloseGlyph, CopyGlyph, DownloadGlyph } from '../focusDrawerChrome'

/** The rename pencil, stroked like the drawer's other marks. */
function PencilGlyph({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" />
    </svg>
  )
}

const LAYER_MIME = 'application/x-gene-tree-layer'
const FRAGMENT_MIME = 'application/x-gene-tree-fragment'

/**
 * The drawer's Layers section, after the Alignment Explorer's sidebar: the Original,
 * then each subtree layer with its colour, name and size, then "＋ New layer".
 *
 * Every row is a drop target twice over. A selection dragged off the canvas finds rows
 * by `data-selection-drop` (the canvas drag uses pointer events, so the view resolves the
 * target itself and passes `dropTarget` back to highlight it). Rows can also be dragged
 * onto each other with ordinary HTML drag-and-drop: a layer onto a layer merges them, a
 * subtree onto a layer moves it there.
 */
export default function LayerPanel({
  layers, activeId, dropTarget, dragging, fragments = [],
  onSwitch, onNew, onRename, onDelete, onDuplicate, onExport, onMergeLayers, onMoveFragment,
  onFragmentRename, onFragmentDelete, onFragmentExport, onFragmentFocus,
}) {
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [htmlOver, setHtmlOver] = useState(null)
  // A subtree being renamed in place: its id and the draft. An empty name goes back to the
  // automatic one (the clade's name, or its genes and species).
  const [naming, setNaming] = useState(null)
  const finishNaming = () => {
    if (naming) onFragmentRename(naming.id, naming.draft.trim())
    setNaming(null)
  }

  const startEdit = (id, name) => { setEditing(id); setDraft(name) }
  const finishEdit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim())
    setEditing(null)
  }

  const dropProps = id => ({
    onDragOver: event => {
      const types = event.dataTransfer.types
      if (types.includes(LAYER_MIME) || types.includes(FRAGMENT_MIME)) {
        event.preventDefault()
        setHtmlOver(id)
      }
    },
    onDragLeave: () => setHtmlOver(over => (over === id ? null : over)),
    onDrop: event => {
      event.preventDefault()
      setHtmlOver(null)
      const layer = event.dataTransfer.getData(LAYER_MIME)
      const fragment = event.dataTransfer.getData(FRAGMENT_MIME)
      if (layer && layer !== id) onMergeLayers(layer, id)
      else if (fragment) onMoveFragment(fragment, id)
    },
  })

  return (
    <div className={`gt-layer-targets${dragging ? ' is-dragging' : ''}`}>
      {layers.map(layer => {
        const original = layer.id === 'original'
        const active = layer.id === activeId
        const disabled = dragging && active && !original
        const classes = ['gt-layer-row', active ? 'selected' : '', dropTarget === layer.id || htmlOver === layer.id ? 'selection-drop-hover' : '',
          disabled ? 'selection-drop-disabled' : '', original ? 'gt-original' : ''].filter(Boolean).join(' ')
        return (
          <div key={layer.id} className={classes} data-selection-drop={original ? undefined : layer.id}
            draggable={!original && editing !== layer.id}
            onDragStart={event => { event.dataTransfer.setData(LAYER_MIME, layer.id); event.dataTransfer.effectAllowed = 'move' }}
            {...(original ? {} : dropProps(layer.id))}>
            <button type="button" className="gt-layer-main" onClick={() => onSwitch(layer.id)}
              title={original ? 'The tree as loaded: never changed' : 'Show this layer · drag onto another layer to merge'}>
              <i style={{ background: layer.color }} />
              {editing === layer.id ? (
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={finishEdit}
                  onKeyDown={e => { if (e.key === 'Enter') finishEdit(); if (e.key === 'Escape') setEditing(null) }} onClick={e => e.stopPropagation()} />
              ) : (
                <span className="gt-layer-text"><strong>{layer.name}</strong><small>{layer.summary}</small></span>
              )}
            </button>
            {!original ? (
              <span className="gt-layer-tools">
                <button type="button" title="Rename" aria-label="Rename" onClick={() => startEdit(layer.id, layer.name)}><PencilGlyph /></button>
                <button type="button" title="Duplicate" aria-label="Duplicate" onClick={() => onDuplicate(layer.id)}><CopyGlyph size={16} /></button>
                <button type="button" title="Export as NHX" aria-label="Export as NHX" onClick={() => onExport(layer.id)}><DownloadGlyph size={14} /></button>
                <button type="button" title="Delete layer" aria-label="Delete layer" onClick={() => onDelete(layer.id)}><CloseGlyph size={16} /></button>
              </span>
            ) : null}
          </div>
        )
      })}
      <button type="button" className={`gt-new-layer${dropTarget === 'new' ? ' selection-drop-hover' : ''}`} data-selection-drop="new" onClick={onNew}>
        <strong>＋ New layer</strong>
        {dragging ? <small>Drop here to start a layer with the selection</small> : null}
      </button>

      {fragments.length ? (
        <div className="gt-fragments">
          <div className="gt-fragments-head"><span>Subtrees in this layer</span></div>
          {fragments.map(f => (
            <div key={f.id} className="gt-fragment-row" draggable={naming?.id !== f.id}
              onDragStart={event => { event.dataTransfer.setData(FRAGMENT_MIME, f.id); event.dataTransfer.effectAllowed = 'move' }}>
              {naming?.id === f.id ? (
                <input className="gt-fragment-name-input" autoFocus value={naming.draft} placeholder={f.auto}
                  aria-label="Subtree name" onChange={e => setNaming({ id: f.id, draft: e.target.value })} onBlur={finishNaming}
                  onKeyDown={e => { if (e.key === 'Enter') finishNaming(); if (e.key === 'Escape') setNaming(null) }} />
              ) : (
                <button type="button" className="gt-fragment-main" onClick={() => onFragmentFocus(f.id)} title="Show this subtree">
                  <strong>{f.label}</strong>
                  <small>{f.detail}</small>
                </button>
              )}
              {f.grafts ? <em className="gt-graft-badge" title="Joined by hand: branch lengths at the join are approximate">grafted</em> : null}
              <span className="gt-layer-tools">
                <button type="button" title="Rename subtree" aria-label="Rename subtree" onClick={() => setNaming({ id: f.id, draft: f.name || '' })}><PencilGlyph /></button>
                <button type="button" title="Export as NHX" aria-label="Export as NHX" onClick={() => onFragmentExport(f.id)}><DownloadGlyph size={14} /></button>
                <button type="button" title="Remove subtree" aria-label="Remove subtree" onClick={() => onFragmentDelete(f.id)}><CloseGlyph size={16} /></button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

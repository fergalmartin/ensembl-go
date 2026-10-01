import { LAYER_TOOLS } from './tools.js'

/** The layer tools' marks, in the stroke style of the control bar's tool icons. */
function LayerToolIcon({ id, size = 16 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (id === 'move') return <svg {...common}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></svg>
  if (id === 'merge') return <svg {...common}><path d="M4 5c5 0 5 7 10 7h6M4 19c5 0 5-7 10-7" /><path d="M17 9l3 3-3 3" /></svg>
  // Wide, mirrored forks keep all four tips legible at toolbar size.
  // The inward twig on the right marks the graft.
  if (id === 'graft') return (
    <svg {...common} width={size * 4 / 3} viewBox="0 0 32 24" strokeWidth={2.8}>
      <path d="M2 4l4.5 8L16 21l9.5-9L30 4M6.5 12L11 4" />
      <path d="M25.5 12L21 4" stroke="var(--gt-warn)" />
    </svg>
  )
  if (id === 'cut') return <svg {...common}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></svg>
  if (id === 'remove') return <svg {...common}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
  if (id === 'compare') return <svg {...common}><path d="M3 4v16M3 8h5M3 16h5M21 4v16M21 8h-5M21 16h-5" /><path d="M9 8c3 0 3 8 6 8M9 16c3 0 3-8 6-8" strokeDasharray="2 2" /></svg>
  if (id === 'rename') return <svg {...common}><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
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
/**
 * The second row while two subtrees are compared: which two (swap them), what joins their
 * genes, facing each other or as the user had them, untangling, whether disagreement shows,
 * the counts, and an end to it.
 */
function CompareRow({ compare }) {
  return (
    <div className="gt-layerbar-row gt-compare-row">
      <span className="gt-compare-pair" title={`${compare.a} on the left, ${compare.b} on the right`}>
        <span className="gt-compare-name"><b>1</b>{compare.a}</span>
        <button type="button" className="gt-layerbar-act" onClick={compare.onSwap} title="Swap sides" aria-label="Swap sides">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h15l-4-4M20 16H5l4 4" /></svg>
        </button>
        <span className="gt-compare-name"><b>2</b>{compare.b}</span>
      </span>
      <span className="gt-layerbar-split" aria-hidden="true" />
      <span className="gt-compare-group" role="radiogroup" aria-label="Join genes by">
        <span className="gt-compare-label">Join by</span>
        {compare.matchChoices.map(choice => (
          <button key={choice.id} type="button" role="radio" aria-checked={compare.by === choice.id} title={choice.hint}
            className={`gt-compare-choice${compare.by === choice.id ? ' on' : ''}`} onClick={() => compare.onBy(choice.id)}>{choice.label}</button>
        ))}
      </span>
      <span className="gt-layerbar-split" aria-hidden="true" />
      <span className="gt-compare-group" role="radiogroup" aria-label="Arrangement">
        <button type="button" role="radio" aria-checked={compare.facing} className={`gt-compare-choice${compare.facing ? ' on' : ''}`}
          title="Set the two subtrees facing each other, the second mirrored" onClick={() => compare.onFacing(true)}>Facing</button>
        <button type="button" role="radio" aria-checked={!compare.facing} className={`gt-compare-choice${!compare.facing ? ' on' : ''}`}
          title="Put every subtree back where you had it, keeping the lines" onClick={() => compare.onFacing(false)}>As placed</button>
      </span>
      <button type="button" className="gt-compare-choice" onClick={compare.onUntangle} title="Flip branches so the lines cross as little as they can">Untangle</button>
      <label className="gt-compare-check" title="Dash the branches into clades the other tree does not have, and colour lines by the clades both share">
        <input type="checkbox" checked={compare.disagreement} onChange={event => compare.onDisagreement(event.target.checked)} />
        Disagreement
      </label>
      <span className="gt-layerbar-split" aria-hidden="true" />
      <span className="gt-compare-stats">
        {compare.stats.map(stat => <span key={stat.text} className={stat.warn ? 'warn' : ''} title={stat.title}>{stat.text}</span>)}
      </span>
      <button type="button" className="gt-layerbar-act" onClick={compare.onEnd} title="End the comparison" aria-label="End the comparison">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  )
}

export default function LayerBar({ layer, tool, onTool, radial, arranged, onRestack, canUndo, canRedo, onUndo, onRedo,
  subtrees = 0, comparing = false, onCompare, compare = null, isLight }) {
  return (
    <div className="gt-layerbar-track">
      <div className={`gt-layerbar${isLight ? ' light' : ''}`} role="toolbar" aria-label="Subtree layer tools"
        onPointerDown={event => event.stopPropagation()}>
        <div className="gt-layerbar-row">
          <span className="gt-layerbar-name" title={layer.name}><i style={{ background: layer.color }} />{layer.name}</span>
          <span className="gt-layerbar-split" aria-hidden="true" />
          {LAYER_TOOLS.map(t => {
            const isCompare = t.id === 'compare'
            const on = t.id === tool || (isCompare && comparing)
            const disabled = ((t.id === 'move' || isCompare) && radial) || (isCompare && subtrees < 2 && !comparing)
            const title = (t.id === 'move' || isCompare) && radial ? t.radialNote
              : isCompare && subtrees < 2 && !comparing ? 'Compare needs two subtrees in this layer'
                : isCompare && comparing ? 'End the comparison'
                  : isCompare && tool === 'compare' ? 'Click the first subtree, then the second (Esc cancels)' : t.hint
            return (
              <button key={t.id} type="button" role="radio" aria-checked={on} disabled={disabled}
                className={`gt-layer-tool${on ? ' on' : ''}${t.id === 'remove' ? ' danger' : ''}`}
                title={title}
                onClick={() => (isCompare ? onCompare() : onTool(on ? 'explore' : t.id))}>
                <LayerToolIcon id={t.id} />
                <span>{t.label}</span>
              </button>
            )
          })}
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
        {compare ? <CompareRow compare={compare} /> : null}
      </div>
    </div>
  )
}

const input = 'rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-gray-100'

export default function TutorialBrowserDemoEditor({ value, datasets, onChange }) {
  const moves = value?.moves || []
  const update = (next) => onChange(next.length ? { ...value, type: 'browserView', moves: next, durationMs: value?.durationMs || 1100, pauseMs: value?.pauseMs || 900, revealPanel: true } : null)
  return <details className="rounded-md border border-gray-700 p-2.5" open={Boolean(value)}>
    <summary className="cursor-pointer text-xs font-semibold text-gray-200">Autoplay browser demonstration</summary>
    <p className="mt-2 text-xs text-gray-400">These moves run only during autoplay. Manual Next leaves the reader's view alone. Pan is a fraction of the window; zoom below 1 zooms in.</p>
    <div className="mt-2 space-y-2">
      {moves.map((move, index) => <div key={index} className="flex flex-wrap gap-2">
        <select aria-label={`Demo genome ${index + 1}`} className={input} value={move.panelKey || ''} onChange={(e) => update(moves.map((m, i) => i === index ? { ...m, panelKey: e.target.value } : m))}>
          <option value="">First active genome</option>
          {datasets.map((d) => <option key={d.recipeId} value={d.recipeId}>{d.label || d.recipeId}</option>)}
        </select>
        <select aria-label={`Demo movement ${index + 1}`} className={input} value={move.zoom === undefined ? 'pan' : 'zoom'} onChange={(e) => update(moves.map((m, i) => i === index ? { panelKey: m.panelKey, [e.target.value]: e.target.value === 'pan' ? 0.2 : 0.6 } : m))}>
          <option value="pan">Pan</option><option value="zoom">Zoom</option>
        </select>
        <input aria-label={`Demo amount ${index + 1}`} className={`${input} w-20`} type="number" step="0.1" value={move.zoom ?? move.pan} onChange={(e) => update(moves.map((m, i) => i === index ? { ...m, [m.zoom === undefined ? 'pan' : 'zoom']: Number(e.target.value) } : m))} />
        <button type="button" className={input} onClick={() => update(moves.filter((_, i) => i !== index))}>Remove</button>
      </div>)}
      <button type="button" className={input} onClick={() => update([...moves, { panelKey: datasets[0]?.recipeId || '', pan: 0.2 }])}>Add move</button>
    </div>
  </details>
}

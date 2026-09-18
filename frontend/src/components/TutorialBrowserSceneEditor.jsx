import { describeTutorialBrowserScene } from '../utils/tutorialBrowserScene.js'

const input = 'w-full rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-gray-100'
const copy = (value) => JSON.parse(JSON.stringify(value))

/** The same portable scene vocabulary is used for arrivals, Next and result checks. */
export default function TutorialBrowserSceneEditor({ title, value, datasets, onChange, checkOnly = false }) {
  const scene = value || {}
  const update = (patch) => onChange({ ...scene, ...patch })
  const panelUpdate = (id, patch) => update({ panels: { ...scene.panels, [id]: { ...scene.panels?.[id], ...patch } } })
  const capture = () => {
    const current = describeTutorialBrowserScene()
    if (!current) return
    const panels = Object.fromEntries(Object.entries(current.panels).filter(([, p]) => p).map(([id, p]) => [id, {
      ...(checkOnly ? {} : { locus: `${p.chrom}:${Math.round(p.start)}-${Math.round(p.end)}` }),
      focus: p.focus || '', tracks: p.tracks,
    }]))
    // A closed wheel has no genome and no action to record, and writing the empty strings
    // it reports would put a dataset name of "" into the document.
    const cycle = current.cycle?.open ? current.cycle : { open: false }
    onChange({ ...current, panels, cycle, ...(!checkOnly ? { reset: true, preserveView: true } : {}) })
  }
  return <details className="rounded-md border border-gray-700 p-2.5" open={Boolean(value)}>
    <summary className="cursor-pointer text-xs font-semibold text-gray-200">{title}</summary>
    <div className="mt-2 space-y-2 text-xs text-gray-200">
      <div className="flex gap-2">
        <button type="button" className={input} onClick={capture}>Use current browser state</button>
        {value && <button type="button" className={input} onClick={() => onChange(null)}>Remove</button>}
      </div>
      <p className="text-gray-400">Choose active genomes, then set their starting location, gene focus and tracks. Blank focus clears the gene. Unspecified fields stay as they are.</p>
      {!checkOnly && <div className="flex flex-wrap gap-3">
        <label><input type="checkbox" checked={Boolean(scene.reset)} onChange={(e) => update({ reset: e.target.checked })} /> Clear previous focus and links first</label>
        <label><input type="checkbox" checked={Boolean(scene.preserveView)} onChange={(e) => update({ preserveView: e.target.checked })} /> Keep the view if the scene already matches</label>
      </div>}
      <div className="grid grid-cols-3 gap-2">
        <label>Inactive tracks<select className={input} value={scene.hideInactive === undefined ? '' : String(scene.hideInactive)} onChange={(e) => update({ hideInactive: e.target.value === '' ? undefined : e.target.value === 'true' })}>
          <option value="">Keep</option><option value="true">Hidden</option><option value="false">Shown</option>
        </select></label>
        <label>Link<select className={input} value={scene.link ?? ''} onChange={(e) => update({ link: e.target.value || undefined })}>
          <option value="">Keep</option><option value="none">None</option><option value="region">Region</option><option value="gene">Gene</option>
        </select></label>
        {['pan', 'zoom'].map((key) => <label key={key}>{key === 'pan' ? 'Pan' : 'Zoom'}<select className={input} value={scene[key] === undefined ? '' : String(scene[key])} onChange={(e) => update({ [key]: e.target.value === '' ? undefined : e.target.value === 'true' })}>
          <option value="">Keep</option><option value="true">Linked</option><option value="false">Independent</option>
        </select></label>)}
      </div>
      {/* The wheel cannot be arrived at by describing it: until something opens it there
          is no rail for a spotlight and no faces for a card to talk about. Held open by a
          tutorial it commits only from its own Focus/Jump buttons, so a step can sit
          beside it without the reader's next click confirming something. */}
      <div className="grid grid-cols-3 gap-2">
        <label>Cycle wheel<select className={input} value={scene.cycle?.open === undefined ? '' : String(scene.cycle.open)} onChange={(e) => update({ cycle: e.target.value === '' ? undefined : { ...scene.cycle, open: e.target.value === 'true' } })}>
          <option value="">Keep</option><option value="true">Open</option><option value="false">Closed</option>
        </select></label>
        {scene.cycle?.open && <>
          <label>Showing<select className={input} value={scene.cycle?.genome ?? ''} onChange={(e) => update({ cycle: { ...scene.cycle, genome: e.target.value || undefined } })}>
            <option value="">Keep</option>{datasets.map((dataset) => <option key={dataset.recipeId} value={dataset.recipeId}>{dataset.label || dataset.recipeId}</option>)}
          </select></label>
          <label>Chosen action<select className={input} value={scene.cycle?.action ?? ''} onChange={(e) => update({ cycle: { ...scene.cycle, action: e.target.value || undefined } })}>
            <option value="">Keep</option><option value="none">Neither</option><option value="focus">Focus</option><option value="add">Add or Jump</option>
          </select></label>
        </>}
      </div>
      {datasets.map((dataset) => {
        const id = dataset.recipeId
        const panel = scene.panels?.[id] || {}
        return <div key={id} className="space-y-1 rounded border border-gray-700 p-2">
          <label className="flex gap-2"><input type="checkbox" checked={scene.active?.includes(id) || false} onChange={(e) => {
            const active = new Set(scene.active || [])
            if (e.target.checked) active.add(id); else active.delete(id)
            const panels = copy(scene.panels || {})
            if (!e.target.checked) delete panels[id]
            update({ active: datasets.map((d) => d.recipeId).filter((key) => active.has(key)), panels })
          }} />{dataset.label || id}</label>
          {scene.active?.includes(id) && <>
            <label>Location<input className={input} placeholder="chromosome:start-end (optional)" value={panel.locus || ''} onChange={(e) => panelUpdate(id, { locus: e.target.value || undefined })} /></label>
            <label className="flex gap-2"><input type="checkbox" checked={panel.focus !== undefined} onChange={(e) => panelUpdate(id, { focus: e.target.checked ? '' : undefined })} /> Set gene focus</label>
            {panel.focus !== undefined && <input className={input} placeholder="Gene symbol / ID; blank clears focus" value={panel.focus} onChange={(e) => panelUpdate(id, { focus: e.target.value })} />}
            <div className="grid grid-cols-3 gap-2">{[['forward', 'GF'], ['reverse', 'GR'], ['sequence', 'SL']].map(([strand, label]) => <label key={strand}>{label}<select className={input} value={panel.tracks?.[strand] === undefined ? '' : String(panel.tracks[strand])} onChange={(e) => panelUpdate(id, { tracks: { ...panel.tracks, [strand]: e.target.value === '' ? undefined : e.target.value === 'true' } })}>
              <option value="">Keep</option><option value="true">On</option><option value="false">Off</option>
            </select></label>)}</div>
          </>}
        </div>
      })}
    </div>
  </details>
}

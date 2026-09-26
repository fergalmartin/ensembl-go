// Bringing the track registry to the set a tutorial step declares.
//
// This lives outside `TrackManagerView` for exactly the reason `customGenomeImport.js`
// lives outside the Genome Selector: two callers need it and only one of them is a view.
// The Track Manager is where a person registers a track; the tutorial runtime is the other
// caller, and it has to be able to do it from a step in a *different app* — views unmount
// when they are not active, so a genome-browser step that expects three tracks to exist
// cannot reach anything inside the Track Manager to make it so.
//
// That was not a theoretical gap. Walking backward or jumping into any browser step of the
// Track Manager tutorial found an empty registry, so the panel had no custom tracks to draw
// and the card describing them was describing nothing.
//
// Nothing here touches React state. Give it the workspace's files and the set of tracks a
// step wants registered, get back what the registry now holds.

import { API_BASE } from '../backendRuntime'

/** How each demo track is registered: the label the cards quote, and how it is drawn.
 *
 *  The two BigWigs differ only in `dataType`, which is the lesson — the same file type
 *  draws a zoned heatmap or a signal plot depending on what you say the data is. */
export const TUTORIAL_TRACK_PRESETS = Object.freeze({
  expression: { label: 'Brain expression', type: 'bigwig', dataType: 'rna_seq', displayMode: 'zoned_heatmap' },
  atac: { label: 'ATAC-seq peaks', type: 'bigwig', dataType: 'atac_seq', displayMode: 'signal_plot' },
  variants: { label: 'Variants', type: 'vcf', displayMode: 'density_lollipop' },
})

async function listRegistry() {
  try {
    const response = await fetch(`${API_BASE}/api/tracks`)
    if (!response.ok) return { tracks: [], groups: [] }
    const data = await response.json()
    return {
      tracks: Array.isArray(data?.tracks) ? data.tracks : [],
      groups: Array.isArray(data?.groups) ? data.groups : [],
    }
  } catch {
    return { tracks: [], groups: [] }
  }
}

async function listTracks() {
  return (await listRegistry()).tracks
}

async function send(method, path, body) {
  try {
    await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch { /* reported by the arrival's own wait, which finds the registry short */ }
}

/** Set the track groups to exactly the ones a step declares, by name.
 *
 *  Same rules as the tracks: set, never added to, and only the tutorial's own touched — a
 *  group is the tutorial's when every track in it is one of the demo files. Each declared
 *  group is made, or brought to the declared layout and tracks, so re-entering a step that
 *  describes a group finds exactly one of it, laid out as the step says. */
async function reconcileTutorialGroups({ files, wanted, genomeKey }) {
  const { tracks, groups } = await listRegistry()
  const idFor = (key) => tracks.find((track) => files[key] && String(track.path || '') === files[key])?.id
  const ourIds = new Set(Object.keys(files).map(idFor).filter(Boolean))
  const isOurs = (group) => (group.members || []).every((m) => ourIds.has(String(m.track_id)))
  const membersFor = (keys) => keys.map(idFor).filter(Boolean).map((id) => ({ track_id: id, settings: null }))

  for (const group of groups) {
    if (!isOurs(group) || wanted.some((w) => w.name === group.label)) continue
    await send('DELETE', `/api/track-groups/${encodeURIComponent(group.id)}`)
  }
  for (const want of wanted) {
    const members = membersFor(want.members)
    const existing = groups.find((group) => group.label === want.name && isOurs(group))
    if (!existing) {
      await send('POST', '/api/track-groups', { label: want.name, genome_key: genomeKey, layout: want.layout, members })
      continue
    }
    const sameMembers = JSON.stringify((existing.members || []).map((m) => String(m.track_id)))
      === JSON.stringify(members.map((m) => m.track_id))
    const sameSettings = (existing.members || []).every((m) => !m.settings)
    if (existing.layout !== want.layout || !sameMembers || !sameSettings) {
      await send('PUT', `/api/track-groups/${encodeURIComponent(existing.id)}`, { layout: want.layout, members })
    }
  }
}

/** Set the registry to exactly the tracks a step declares.
 *
 *  Set, never added to: an arrival runs on every entry to a step, so walking back into the
 *  step that registers the first track has to find exactly one registered, not a second
 *  copy of it. Only the tutorial's own files are ever removed — the guard in
 *  `main._tracks_config` means the registry in play is the workspace's own, but this is
 *  written so that it would still only touch its own files if that ever changed.
 *
 *  @param files    workspace paths by track key, from the demo-tracks installer
 *  @param wanted   the track keys the step wants registered
 *  @param genomeKey which genome to register them against; without it they never draw
 */
export async function reconcileTutorialTracks({ files = {}, wanted = [], groups = [], genomeKey = '' } = {}) {
  const existing = await listTracks()
  const pathFor = (key) => String(files[key] || '')
  const isOurs = (track) => Object.values(files).some((path) => path && String(track?.path || '') === path)
  const isWanted = (track) => wanted.some((key) => pathFor(key) && String(track?.path || '') === pathFor(key))

  for (const track of existing) {
    if (!isOurs(track) || isWanted(track)) continue
    try {
      await fetch(`${API_BASE}/api/tracks/${track.id}`, { method: 'DELETE' })
    } catch { /* the registry is the workspace's own and is swept with it */ }
  }

  for (const key of wanted) {
    const path = pathFor(key)
    const preset = TUTORIAL_TRACK_PRESETS[key]
    if (!path || !preset) continue
    if (existing.some((track) => String(track.path || '') === path)) continue
    try {
      await fetch(`${API_BASE}/api/tracks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          label: preset.label,
          type: preset.type,
          display_mode: preset.displayMode,
          genome_key: genomeKey || '',
          ...(preset.dataType ? { bigwig_settings: { data_type: preset.dataType } } : {}),
        }),
      })
    } catch { /* reported by the arrival's own wait, which finds the track missing */ }
  }

  await reconcileTutorialGroups({ files, wanted: Array.isArray(groups) ? groups : [], genomeKey })
  return listTracks()
}

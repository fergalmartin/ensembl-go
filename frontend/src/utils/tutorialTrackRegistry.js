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

async function listTracks() {
  try {
    const response = await fetch(`${API_BASE}/api/tracks`)
    if (!response.ok) return []
    const data = await response.json()
    return Array.isArray(data?.tracks) ? data.tracks : []
  } catch {
    return []
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
export async function reconcileTutorialTracks({ files = {}, wanted = [], genomeKey = '' } = {}) {
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

  return listTracks()
}

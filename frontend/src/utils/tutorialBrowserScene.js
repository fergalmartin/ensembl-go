import { browserViewportControls, describeBrowserViewport, parseLocus, sameBrowserViewport } from './browserTutorialControls.js'

let host = null
let generation = 0
let appliedActive = null
export function registerTutorialBrowserHost(controls) {
  host = controls
  return () => { if (host === controls) { host = null; appliedActive = null; generation += 1 } }
}
export function cancelTutorialBrowserScene() { generation += 1; host?.cancel?.() }
export function describeTutorialBrowserScene() {
  const state = host?.describe?.()
  if (!state) return null
  return { ...state, panels: Object.fromEntries((state.active || []).map((id) => [id, describeBrowserViewport(id)])) }
}
export function tutorialSettings(document, genomes) {
  const settings = document?.settings || {}
  return {
    ...(settings.showInactivePills ? { tutorial_selected_genomes: genomes.filter(Boolean) } : {}),
    // A tutorial's palette is positional — genome 1, genome 2 — because that is
    // what its prose refers to; the genomes carry the index (see
    // resolveDatasetGenomes) and read their colour out of this.
    ...(Array.isArray(settings.genomeColors) ? { tutorial_color_palette: settings.genomeColors.slice() } : {}),
  }
}
export function browserSceneMatches(wanted, actual = describeTutorialBrowserScene()) {
  if (!wanted || !actual) return false
  if (wanted.active && (wanted.active.length !== actual.active?.length || wanted.active.some((id, i) => id !== actual.active[i]))) return false
  for (const key of ['pan', 'zoom', 'link', 'hideInactive']) if (wanted[key] !== undefined && wanted[key] !== actual[key]) return false
  for (const [id, panel] of Object.entries(wanted.panels || {})) {
    const current = actual.panels?.[id]
    if (!current?.ready) return false
    if (panel.focus !== undefined && String(panel.focus).toLowerCase() !== String(current.focus || '').toLowerCase()) return false
    if (panel.locus && !wanted.preserveView && !sameBrowserViewport(parseLocus(panel.locus), current)) return false
    for (const [strand, visible] of Object.entries(panel.tracks || {})) if (current.tracks?.[strand] !== visible) return false
  }
  return true
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function applyTutorialBrowserScene(scene) {
  const token = ++generation
  const current = () => token === generation
  const deadline = Date.now() + 15000
  while (current() && (!host || (scene.active || Object.keys(scene.panels || {})).some((id) => !browserViewportControls(id)?.describe?.()?.ready))) {
    if (Date.now() > deadline) throw new Error('The requested genome panels did not become ready.')
    await delay(60)
  }
  if (!current()) return false
  const activeSignature = JSON.stringify(scene.active || host.describe().active)
  if (scene.preserveView && appliedActive === activeSignature && browserSceneMatches(scene)) return true
  await host.apply(scene, current)
  if (!current()) return false
  for (const [id, panel] of Object.entries(scene.panels || {})) {
    const controls = browserViewportControls(id)
    if (panel.tracks) controls?.setTracks?.(panel.tracks)
    if (panel.locus && !controls?.goToLocus?.(panel.locus, 1)) throw new Error(`Could not show ${panel.locus}.`)
  }
  await delay(80)
  if (!current()) return false
  await host.link(scene, current)
  if (current()) appliedActive = activeSignature
  return current()
}

export function browserSceneProblems(scene, datasets = []) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return ['Browser scene must be an object.']
  const problems = []
  if (scene.active !== undefined && !Array.isArray(scene.active)) return ['Browser active genomes must be a list.']
  if (scene.panels !== undefined && (!scene.panels || typeof scene.panels !== 'object' || Array.isArray(scene.panels))) return ['Browser panels must be a map of dataset IDs to panel state.']
  const known = new Set((Array.isArray(datasets) ? datasets : []).map((d) => d.recipeId))
  for (const id of [...(scene.active || []), ...Object.keys(scene.panels || {})]) if (!known.has(id)) problems.push(`Browser scene names an unattached dataset: ${id}.`)
  if (scene.link !== undefined && !['none', 'region', 'gene'].includes(scene.link)) problems.push('Browser link must be none, region or gene.')
  for (const key of ['pan', 'zoom', 'reset', 'preserveView', 'hideInactive']) if (scene[key] !== undefined && typeof scene[key] !== 'boolean') problems.push(`Browser ${key} must be true or false.`)
  for (const panel of Object.values(scene.panels || {})) {
    if (!panel || typeof panel !== 'object' || Array.isArray(panel)) { problems.push('Each browser panel needs a state object.'); continue }
    if (panel.locus && !parseLocus(panel.locus)) problems.push('Panel locus must be chromosome:start-end.')
    if (panel.focus !== undefined && typeof panel.focus !== 'string') problems.push('Panel focus must be a gene name or an empty string.')
    for (const [strand, value] of Object.entries(panel.tracks || {})) if (!['forward', 'reverse', 'sequence'].includes(strand) || typeof value !== 'boolean') problems.push('Track visibility must name forward, reverse or sequence with a boolean value.')
  }
  return [...new Set(problems)]
}

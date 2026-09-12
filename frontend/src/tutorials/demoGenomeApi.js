// Installing the genomes the tutorials run on. Split from demoGenome.js so the tutorial
// definitions stay free of the backend client — same split as genomeAnalysis.js and its
// runner.
//
// Every call takes an optional bundled-genome id. Omitting it means the demo genome,
// which is what the first tutorial wants and what these functions did when it was the
// only one.

import { API_BASE } from '../backendRuntime'
import { DEMO_SPECIES_KEY } from './demoGenome.js'
export { installTutorialDataset, installDemoSourceFiles } from './drafts.js'

export async function fetchDemoGenomeStatus(outputDir, genomeId = '') {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  if (genomeId) params.set('genome_id', String(genomeId))
  const response = await fetch(`${API_BASE}/api/demo/genome?${params.toString()}`)
  if (!response.ok) throw new Error('Could not load the demo genome')
  return response.json()
}

/** Stands in for a download: copies the bundled genome into place and indexes it. */
export async function installDemoGenome(outputDir, genomeId = '') {
  const response = await fetch(`${API_BASE}/api/demo/genome/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), genome_id: String(genomeId || '') }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.detail || 'Could not install the demo genome')
  return payload
}

/** Create the scratch directory a tutorial runs in, inside the user's own output dir. */
export async function createTutorialWorkspace(outputDir) {
  const response = await fetch(`${API_BASE}/api/tutorial/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || '') }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.detail || 'Could not prepare the tutorial workspace')
  return payload.workspace
}

/** Remove it again. Safe to call when there is nothing there. */
export async function resetTutorialWorkspace(outputDir) {
  const dir = String(outputDir || '').trim()
  if (!dir) return false
  try {
    const params = new URLSearchParams({ output_dir: dir })
    const response = await fetch(`${API_BASE}/api/tutorial/workspace?${params.toString()}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

/** A bundled genome as the app's own genome listing describes it, which is the shape the
 *  rest of the app expects an active genome to have. */
export async function fetchDemoGenomeRecord(outputDir, speciesKey = DEMO_SPECIES_KEY) {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  const response = await fetch(`${API_BASE}/api/remote/local-assemblies?${params.toString()}`)
  if (!response.ok) throw new Error('Could not list the tutorial genomes')
  const assemblies = await response.json()
  return (Array.isArray(assemblies) ? assemblies : [])
    .find((entry) => String(entry?.species_key || '') === String(speciesKey)) || null
}

/** Every genome in a tutorial workspace, as the app's own listing describes them.
 *
 *  The record a dataset installs as is not the record the Genome Selector lists. The
 *  catalogue derives its own identity for a genome by scanning the workspace — which
 *  dataset release its annotation belongs to, and therefore its selection key — and that
 *  is what a row's checkbox is matched against. Selecting the installed record instead
 *  puts a pill in the top bar whose own row, in the list below, still reads as
 *  unselected: two views of one genome disagreeing about whether it is chosen. Whatever
 *  the tutorial selects on the user's behalf therefore comes from here, exactly as
 *  `fetchDemoGenomeRecord` already does for the bundled demo genome. */
export async function fetchTutorialGenomeRecords(outputDir) {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  const response = await fetch(`${API_BASE}/api/remote/local-assemblies?${params.toString()}`)
  if (!response.ok) throw new Error('Could not list the tutorial genomes')
  const assemblies = await response.json()
  return Array.isArray(assemblies) ? assemblies : []
}

/** Tell the backend which genome the tutorial has activated.
 *
 *  The tutorial's active genome exists only in the frontend's config override, which is
 *  what keeps the user's real configuration untouched — but the genome browser resolves
 *  genomes server-side, out of the saved configuration, so without this it cannot find
 *  the demo genome at all and every browse request comes back 400 with blank tracks
 *  behind it. The backend holds it in memory only, and only for a genome this app
 *  bundles, whose files are inside the tutorial workspace. */
export async function registerTutorialGenome(record) {
  if (!record) return false
  try {
    const response = await fetch(`${API_BASE}/api/tutorial/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genome: record }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Forget it again on the way out. */
export async function clearTutorialGenome() {
  try {
    const response = await fetch(`${API_BASE}/api/tutorial/session`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

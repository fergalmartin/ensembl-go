import { API_BASE } from '../backendRuntime.js'

export const TUTORIAL_DRAFTS_CHANGED_EVENT = 'ensembl:tutorial-drafts-changed'

export function notifyTutorialDraftsChanged(outputDir) {
  window.dispatchEvent(new CustomEvent(TUTORIAL_DRAFTS_CHANGED_EVENT, {
    detail: { outputDir: String(outputDir || '') },
  }))
}

async function payload(response, fallback) {
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result?.detail || fallback)
  return result
}

export async function listTutorialDrafts(outputDir) {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  const response = await fetch(`${API_BASE}/api/tutorial/drafts?${params.toString()}`)
  return payload(response, 'Could not load tutorial drafts')
}

export async function saveTutorialDraft(outputDir, tutorial) {
  const response = await fetch(`${API_BASE}/api/tutorial/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), tutorial }),
  })
  return payload(response, 'Could not save the tutorial draft')
}

export async function deleteTutorialDraft(outputDir, tutorialId) {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  const response = await fetch(`${API_BASE}/api/tutorial/drafts/${encodeURIComponent(tutorialId)}?${params.toString()}`, {
    method: 'DELETE',
  })
  return payload(response, 'Could not delete the tutorial draft')
}

export async function listTutorialCheckpoints(outputDir, tutorialId) {
  const params = new URLSearchParams({ output_dir: String(outputDir || '') })
  const response = await fetch(`${API_BASE}/api/tutorial/drafts/${encodeURIComponent(tutorialId)}/checkpoints?${params.toString()}`)
  return payload(response, 'Could not load tutorial checkpoints')
}

export async function saveTutorialCheckpoint({ outputDir, tutorialId, name, tutorial }) {
  const response = await fetch(`${API_BASE}/api/tutorial/drafts/checkpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), tutorial_id: tutorialId, name, tutorial }),
  })
  return payload(response, 'Could not save the tutorial checkpoint')
}

export async function exportTutorialPackage({ outputDir, tutorialId, path }) {
  const response = await fetch(`${API_BASE}/api/tutorial/packages/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), tutorial_id: tutorialId, path }),
  })
  return payload(response, 'Could not export the tutorial package')
}

export async function scanTutorialPackage(path) {
  const params = new URLSearchParams({ path: String(path || '') })
  const response = await fetch(`${API_BASE}/api/tutorial/packages/scan?${params.toString()}`)
  return payload(response, 'Could not inspect the tutorial package')
}

export async function importTutorialPackage({ outputDir, path }) {
  const response = await fetch(`${API_BASE}/api/tutorial/packages/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), path }),
  })
  return payload(response, 'Could not import the tutorial package')
}

export async function promoteTutorialDraft(outputDir, tutorialId) {
  const response = await fetch(`${API_BASE}/api/tutorial/drafts/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output_dir: String(outputDir || ''), tutorial_id: tutorialId }),
  })
  return payload(response, 'Could not promote the tutorial draft')
}

export async function generateTutorialDataset(request) {
  const response = await fetch(`${API_BASE}/api/tutorial/datasets/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return payload(response, 'Could not generate the tutorial dataset')
}

export async function generateTutorialFixture(request) {
  const response = await fetch(`${API_BASE}/api/tutorial/datasets/fixture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return payload(response, 'Could not generate the example tutorial dataset')
}

export async function installTutorialDataset(request) {
  const response = await fetch(`${API_BASE}/api/tutorial/datasets/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return payload(response, 'Could not install the tutorial dataset')
}

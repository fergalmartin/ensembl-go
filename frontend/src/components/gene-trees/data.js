import { API_BASE } from '../../backendRuntime'

/** `/api/gene-trees` requests, shaped like the Alignment Explorer's `api()`. */
export async function api(path, body, signal, method) {
  const response = await fetch(`${API_BASE}/api/gene-trees${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    let detail
    try { detail = (await response.json()).detail } catch { detail = response.statusText }
    const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail))
    error.status = response.status
    throw error
  }
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text()
}

export const query = params => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, value)
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Poll an import job until it settles. */
export async function waitForJob(jobId, onProgress, signal) {
  for (;;) {
    const job = await api(`/jobs/${jobId}`, undefined, signal)
    onProgress?.(job)
    if (!['queued', 'running'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 350))
  }
}

export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const storageKey = (collectionId, treeId) => `gene-trees:view:${collectionId}:${treeId}`

export function loadViewState(collectionId, treeId) {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(collectionId, treeId)) || 'null')
    if (!raw) return null
    return { collapsed: new Set(raw.collapsed || []), flipped: new Set(raw.flipped || []), root: raw.root ?? 0, focus: raw.focus ?? -1 }
  } catch { return null }
}

export function saveViewState(collectionId, treeId, view, focus) {
  try {
    localStorage.setItem(storageKey(collectionId, treeId), JSON.stringify({
      collapsed: [...view.collapsed], flipped: [...view.flipped], root: view.root ?? 0, focus,
    }))
  } catch { /* private window or full storage: the view just starts fresh next time */ }
}

export function loadPreference(key, fallback) {
  try {
    const raw = localStorage.getItem(`gene-trees:${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch { return fallback }
}

export function savePreference(key, value) {
  try { localStorage.setItem(`gene-trees:${key}`, JSON.stringify(value)) } catch { /* ignore */ }
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`
  return `${value} B`
}

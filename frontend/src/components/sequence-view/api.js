// Talking to /api/sequence-view.
//
// Goes through apiFetch rather than bare fetch, so the local API token is
// attached and a tutorial's sandbox can intercept. Several older sequence call
// sites in this app use bare fetch and get away with it only because the token
// is usually empty; this is not one more of them.

import { API_BASE, apiFetch } from '../../backendRuntime'

function queryString(params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params || {})) {
        if (value === null || value === undefined || value === '') continue
        // A list becomes the same key repeated, which is what FastAPI reads back
        // as a list -- `seg` is the one that uses it, to ask for a record's kept
        // stretches rather than its whole range.
        if (Array.isArray(value)) {
            for (const item of value) search.append(key, String(item))
            continue
        }
        search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    }
    return search.toString()
}

/**
 * The stretches of a record that are actually drawn, as `start-end` pairs.
 *
 * Empty for a record shown in full, which is what tells the backend to write the
 * whole range: a reader copying what they can see should get what they can see,
 * and when nothing is collapsed those are the same thing.
 */
export function drawnSegments(layout) {
    if (!layout?.collapsed) return []
    return (layout.items || [])
        .filter((item) => item.kind === 'seq')
        .map((item) => `${item.s}-${item.e}`)
}

/**
 * One read, with an error the tile scheduler can decide about.
 *
 * `retryable` is what tells the scheduler to back off and try again rather than
 * give up. 425 is the important one: it means the genome's annotation index is
 * still being built, which ends by itself, so a class request that meets it
 * should wait rather than report the region as having no genes.
 */
export async function sequenceApi(path, params = {}, signal = undefined) {
    const query = queryString(params)
    const url = `${API_BASE}/api/sequence-view${path}${query ? `?${query}` : ''}`
    const response = await apiFetch(url, { signal })
    if (!response.ok) {
        let detail = ''
        try {
            detail = (await response.json())?.detail || ''
        } catch {
            detail = response.statusText
        }
        const error = new Error(detail || `Request failed (${response.status})`)
        error.status = response.status
        error.retryable = response.status === 425 || response.status === 429 || response.status >= 500
        throw error
    }
    return response.json()
}

/**
 * One call that carries a body rather than a query string.
 *
 * Find is the only one. A regular expression is not a word -- it is full of the
 * characters a URL reserves -- and several of them at five hundred characters
 * apiece is past what a proxy will forward, so what is being looked for goes in
 * the body where its length and its punctuation are nobody else's business.
 */
export async function sequenceApiPost(path, body = {}, signal = undefined) {
    const response = await apiFetch(`${API_BASE}/api/sequence-view${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    })
    if (!response.ok) {
        let detail = ''
        try {
            detail = (await response.json())?.detail || ''
        } catch {
            detail = response.statusText
        }
        const error = new Error(detail || `Request failed (${response.status})`)
        error.status = response.status
        error.retryable = response.status === 425 || response.status === 429 || response.status >= 500
        throw error
    }
    return response.json()
}

/** The address of a region's FASTA, for handing to a download. */
export function sequenceFastaUrl(params = {}) {
    return `${API_BASE}/api/sequence-view/fasta?${queryString(params)}`
}

/**
 * The focused region as plain FASTA. Text, not JSON.
 *
 * The backend's own reason is carried through rather than replaced. It is the
 * only party that knows why a read was refused -- most usefully that the region
 * is past what the clipboard should be given -- and telling the reader "could
 * not read the sequence" instead would leave them with no idea what to do.
 */
export async function sequenceFasta(params = {}, signal = undefined) {
    const response = await apiFetch(sequenceFastaUrl(params), { signal })
    if (!response.ok) {
        let detail = ''
        try {
            detail = (await response.json())?.detail || ''
        } catch {
            detail = ''
        }
        const error = new Error(detail || `Could not read the sequence (${response.status})`)
        error.status = response.status
        // 413 is the region being too large for the clipboard, which the reader
        // can act on: download it instead.
        error.tooLarge = response.status === 413
        throw error
    }
    return response.text()
}

export { queryString }

// Homology rows carry identifiers, not annotation coordinates. Resolve against
// the chosen dataset before handing a navigation request to its browser panel.
import { INDEX_BUILDING_STATUS } from './browserReadiness.js'

function waitForIndex(signal) {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer)
            reject(new DOMException('Cancelled', 'AbortError'))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort)
            resolve()
        }, 1000)
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
    })
}

export async function resolveBrowserGene({ apiBase, genomeKey, gene, signal, fetchImpl = fetch }) {
    const id = String(gene?.id || '').trim()
    if (!id) throw new Error('No gene ID was supplied.')
    const params = new URLSearchParams({ genome: genomeKey, query: id })
    let response
    do {
        response = await fetchImpl(`${apiBase}/api/resolve_id?${params}`, { signal })
        // Regions can be served from FASTA before the annotation index exists.
        // Keep this request alive until lookup is available or the reader leaves.
        if (response.status === INDEX_BUILDING_STATUS) await waitForIndex(signal)
    } while (response.status === INDEX_BUILDING_STATUS)
    if (!response.ok) throw new Error(`Could not open ${id} in this genome (${response.status}).`)
    const resolved = (await response.json())?.gene
    // resolve_id also supports name searches; an absent stable ID must not
    // silently navigate to a different gene with a partially matching name.
    if (String(resolved?.id || '').toLowerCase() !== id.toLowerCase()
        || !String(resolved?.chrom || '').trim()
        || resolved?.start == null || resolved?.end == null
        || !Number.isFinite(Number(resolved.start)) || !Number.isFinite(Number(resolved.end))) {
        throw new Error(`Gene ${id} was not found in this genome's annotation.`)
    }
    return { ...resolved, start: Number(resolved.start), end: Number(resolved.end) }
}

import { useEffect, useRef, useState } from 'react'

import { API_BASE, apiFetch } from '../../backendRuntime'

const EMPTY = Object.freeze(new Map())

/**
 * How long each of a genome's chromosomes is.
 *
 * The view draws a ruler against a chromosome and lets a reader type a range
 * on it, and until now it did both without knowing where the chromosome ends:
 * `1:1-999,999,999` was accepted, printed in the header and counted along the
 * gutters, and only the backend -- which clips every read -- knew better.
 *
 * `/api/browse/regions` is the genome browser's own list, which is where its
 * chromosome menu comes from, so this is a fact the app already had and this
 * view was not asking for. Asked once per genome and held: a chromosome does
 * not change length, and a reader switching back and forth should not pay for
 * it twice.
 *
 * **The guard is on having an answer, not on having asked.** An effect that
 * recorded the attempt and then had its request cancelled -- which is what
 * happens on every mount under StrictMode -- would never ask again, and the
 * ranges would never be held inside anything. The same trap the seeding effect
 * in SequenceView carries a note about, walked straight into: the first attempt
 * was aborted by the cleanup, the second saw the attempt recorded and returned,
 * and the rejection that would have undone the record arrived after it.
 *
 * A genome whose list cannot be read is remembered as such rather than asked
 * again for ever, and reports nothing. The only thing that depends on this is
 * holding a typed range inside the chromosome, and not doing that is a great
 * deal better than not opening.
 */
export default function useChromExtents(genomeKey) {
    const [byGenome, setByGenome] = useState(() => new Map())
    const refused = useRef(new Set())

    useEffect(() => {
        if (!genomeKey || byGenome.has(genomeKey) || refused.current.has(genomeKey)) return undefined
        const controller = new AbortController()
        apiFetch(
            `${API_BASE}/api/browse/regions?genome=${encodeURIComponent(genomeKey)}`,
            { signal: controller.signal },
        )
            .then((response) => (response.ok ? response.json() : null))
            .then((regions) => {
                if (!Array.isArray(regions)) {
                    refused.current.add(genomeKey)
                    return
                }
                const extents = new Map()
                for (const region of regions) {
                    const chrom = String(region?.chrom || '').trim()
                    const start = Number(region?.start)
                    const end = Number(region?.end)
                    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end)) continue
                    extents.set(chrom, { start, end })
                    // A reader types whichever name they have. The browser's own
                    // list carries the synonyms, so `chr1` and `NC_000001.11`
                    // answer for `1` without a second lookup.
                    for (const synonym of region?.synonyms || []) {
                        const alias = String(synonym || '').trim()
                        if (alias && !extents.has(alias)) extents.set(alias, { start, end })
                    }
                }
                setByGenome((previous) => new Map(previous).set(genomeKey, extents))
            })
            .catch((error) => {
                // A cancelled attempt leaves nothing behind, so the next run
                // retries. Only a refusal settles it.
                if (error.name !== 'AbortError') refused.current.add(genomeKey)
            })
        return () => controller.abort()
    }, [genomeKey, byGenome])

    return byGenome.get(genomeKey) || EMPTY
}

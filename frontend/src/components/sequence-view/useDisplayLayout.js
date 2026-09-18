// The layout the rows are drawn from: what is shown, in what order.
//
// With nothing collapsed this needs nothing from the backend -- every base of
// the region is drawn, so the layout is arithmetic. Collapsed, it needs to know
// where the genes and their exons are, and it needs to know for the *whole*
// region before a single row can be placed, because the gaps are what decide
// how many rows there are.
//
// That is why this asks `/spans` rather than reusing the class runs. A location
// focus tiles its classes around the window and so never holds the region's
// whole shape; and the layout has to arrive whether or not the annotation queue
// is busy, since nothing can be drawn at all until it does.
//
// What is asked for is the annotation -- where the genes are, where their exons
// are -- and nothing about the reader's choices. Which kinds to collapse, how
// much of each stretch's ends to keep and how short a stretch has to be to be
// left alone are all applied here, so moving any of those controls re-lays-out
// the view immediately instead of waiting on a round trip.

import { useEffect, useMemo, useRef, useState } from 'react'

import { sequenceApi } from './api'
import {
    COLLAPSE_KINDS,
    DEFAULT_COLLAPSE,
    buildDisplayLayout,
    collapseKeeps,
} from '../../utils/sequenceViewDisplay'
import { LEVEL_CUSTOM, LEVEL_LOCATION } from '../../utils/sequenceViewFocus'

const EMPTY = {
    signature: '', genic: [], exonic: null, offers: [], limited: '', geneCount: 0,
    annotation: 'ready', error: null,
}

/** Whether anything at all is being collapsed. */
export function anyCollapse(settings) {
    return COLLAPSE_KINDS.some((kind) => Boolean(settings?.[kind]?.on))
}

function requestFor({ genomeKey, chrom, region, level, geneId, transcriptId }) {
    if (!genomeKey || !chrom || !region?.start || !region?.end) return null
    const params = {
        genome: genomeKey,
        chrom,
        start: region.start,
        end: region.end,
        // A drag-selected region has no annotation of its own; what can be
        // collapsed inside it is whatever the location around it says.
        level: level === LEVEL_CUSTOM ? LEVEL_LOCATION : level,
    }
    if (params.level === 'gene') {
        if (!geneId) return null
        params.gene_id = geneId
    }
    if (params.level === 'transcript' || params.level === 'feature') {
        if (!transcriptId) return null
        params.transcript_id = transcriptId
    }
    return params
}

export default function useDisplayLayout({
    genomeKey = '',
    chrom = '',
    region = null,
    level = LEVEL_LOCATION,
    geneId = '',
    transcriptId = '',
    reverse = false,
    collapse = DEFAULT_COLLAPSE,
} = {}) {
    const [loaded, setLoaded] = useState(EMPTY)
    // Written only when an answer arrives, and read only inside the effect.
    const arrived = useRef('')

    const wanted = anyCollapse(collapse)
    const params = useMemo(
        () => (wanted ? requestFor({ genomeKey, chrom, region, level, geneId, transcriptId }) : null),
        [wanted, genomeKey, chrom, region, level, geneId, transcriptId],
    )
    const signature = params ? JSON.stringify(params) : ''

    useEffect(() => {
        if (!signature) return undefined
        const controller = new AbortController()
        sequenceApi('/spans', JSON.parse(signature), controller.signal)
            .then((data) => {
                arrived.current = signature
                // An answer with no `offers` is one written by an older version
                // of this endpoint and read out of the cache that outlives a
                // restart. It carries none of the spans this works from, so it
                // is an error to retry rather than a region that can collapse
                // nothing -- which is how it used to read, complete with a gene
                // count that had nothing to do with it.
                if (!Array.isArray(data.offers)) {
                    setLoaded({
                        ...EMPTY,
                        signature,
                        error: 'This region was described by an older version of the app. Try again.',
                    })
                    return
                }
                setLoaded({
                    signature,
                    genic: data.genic || [],
                    // Null rather than empty where the region was too dense to
                    // read every isoform: nothing is exonic and nobody asked are
                    // opposite answers, and treating the second as the first
                    // would make every base of every gene look like an intron.
                    exonic: data.exonic ?? null,
                    offers: data.offers,
                    // Why a kind is missing from `offers`, in the answer's own
                    // words. Never inferred from its absence: an answer this
                    // client cannot read is refused above, rather than being
                    // reported to the reader as a fact about their region.
                    limited: data.limited || '',
                    geneCount: data.gene_count || 0,
                    annotation: data.annotation || 'ready',
                    error: null,
                })
            })
            .catch((error) => {
                if (error.name === 'AbortError') return
                arrived.current = signature
                setLoaded({ ...EMPTY, signature, error: error.message || String(error) })
            })
        return () => controller.abort()
    }, [signature])

    const ready = Boolean(signature) && loaded.signature === signature

    // What the reader asked for, less whatever this region cannot answer. A
    // location with too many genes to read isoform by isoform knows where the
    // genes are and not where their exons are, so intergenic sequence still
    // collapses there and introns do not -- and the bar says so rather than
    // quietly doing something other than what was asked.
    const settled = useMemo(() => {
        if (!ready) return null
        const out = {}
        const offered = Array.isArray(loaded.offers) ? loaded.offers : []
        for (const kind of COLLAPSE_KINDS) {
            const choice = collapse?.[kind] || DEFAULT_COLLAPSE[kind]
            out[kind] = { ...choice, on: Boolean(choice.on) && offered.includes(kind) }
        }
        return out
    }, [ready, collapse, loaded.offers])

    // Collapsing before the answer is here would lay the view out over an empty
    // keep set -- one marker covering the region, and every row thrown away the
    // moment the real answer landed. Everything shown until then, which is the
    // same sequence in the same place.
    const plan = useMemo(() => (settled && anyCollapse(settled)
        ? collapseKeeps({
            region,
            genic: loaded.genic,
            exonic: loaded.exonic || [],
            settings: settled,
        })
        : null), [settled, region, loaded.genic, loaded.exonic])

    const collapsed = Boolean(plan && plan.collapses.length > 0)

    const layout = useMemo(() => buildDisplayLayout({
        region,
        // Already flanked, kind by kind: each carries its own, so there is no
        // one number left for the layout to widen them by.
        keep: collapsed ? plan.keep : [],
        flank: 0,
        collapse: collapsed,
        reverse,
    }), [region, collapsed, plan, reverse])

    return {
        layout,
        collapsed,
        // What the reader is actually getting rid of, which at a location busy
        // enough to price introns out is less than they asked for.
        collapses: collapsed ? plan.collapses : [],
        // What this region could collapse if asked. Both kinds until something
        // says otherwise: nothing is asked for until a switch is on, and a
        // region reporting no kinds because nobody has asked reads in the menu
        // as a region that cannot collapse anything.
        offers: ready && !loaded.error ? loaded.offers : COLLAPSE_KINDS,
        // The answer's own reason for offering less, or ''.
        limited: ready ? loaded.limited : '',
        geneCount: loaded.geneCount,
        annotation: loaded.annotation,
        pending: Boolean(signature) && !ready,
        error: ready ? loaded.error : null,
    }
}

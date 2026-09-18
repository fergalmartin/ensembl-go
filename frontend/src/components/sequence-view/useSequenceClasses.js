// What the bases on screen are, according to the annotation.
//
// Three of the four focus levels ask once and are done: a transcript, an exon or
// intron, and a gene all cover a bounded stretch, so their whole description
// arrives in a single reply keyed on which thing is in focus. Only a location
// focus is unbounded -- it can be a whole chromosome -- so that one alone is
// tiled, and the tiles are aligned to their own absolute grid for the same
// reason the sequence chunks are.
//
// This runs on its own queue, separate from sequence. While a genome's
// annotation index is building, every request here meets a 425 and backs off,
// and sequence keeps arriving on the other queue meanwhile.

import { useEffect, useMemo, useRef, useState } from 'react'

import { sequenceApi } from './api'
import { sequenceTiles } from './sequenceTileService'
import { ANNOTATION_TILE_BP } from '../../utils/sequenceViewClasses'

// Bigger than a sequence chunk by a wide margin. Runs are compact, the gene
// table is indexed on (chrom, start) so the overlap query is one index scan, and
// there is no index on transcripts by position -- so region-scoped annotation
// work has to start from genes, and is worth doing as seldom as possible.
export { ANNOTATION_TILE_BP }

const INDEX_BUILDING = 425

// One frozen empty list rather than a fresh one per render. This is a memo
// dependency downstream -- the rows that carry a protein lane are worked out
// from it, and those decide the document's geometry -- so a new array every
// render rebuilds the document every render, which reports a new viewport,
// which renders again. The same reason `EMPTY_OVERLAPS` exists in the view.
const EMPTY_FRAME = Object.freeze([])

function tileIndexForCoord(coord) {
    return Math.floor((coord - 1) / ANNOTATION_TILE_BP)
}

function tileRange(index) {
    const start = index * ANNOTATION_TILE_BP + 1
    return { index, start, end: start + ANNOTATION_TILE_BP - 1 }
}

/**
 * The request that describes a focus, or null when there is nothing to ask.
 *
 * A location focus produces one request per tile it touches; everything else
 * produces exactly one, keyed on the thing in focus rather than on the window,
 * so that changing the flank refetches but scrolling does not.
 */
function planClassRequests(focus, visibleStart, visibleEnd, intervals, hide) {
    if (!focus?.level || !focus?.chrom) return []
    const { level, chrom, genomeKey } = focus

    if (level !== 'location') {
        const params = {
            genome: genomeKey,
            chrom,
            level,
            // Both ends, because a reader asking for a promoter is asking for
            // the 5' end whichever strand the thing is on. The backend turns
            // the pair into coordinates; it is the party that knows the strand.
            flank5: focus.flank5 || 0,
            flank3: focus.flank3 || 0,
            // Part of the question, not a filter on the answer: a hidden isoform
            // casts no vote, so the runs themselves are different. It is in the
            // key for the same reason, which is what makes showing something
            // again cost nothing.
            //
            // Only where there is more than one voter. A transcript in focus is
            // the only thing describing its own bases, and hiding it elsewhere
            // does not mean a reader who has opened it wants to see nothing --
            // sending it anyway would only mint a second cache key for the same
            // answer.
            ...(hide && level === 'gene' ? { hide } : {}),
        }
        if (level === 'gene') {
            if (!focus.geneId) return []
            params.gene_id = focus.geneId
        } else {
            if (!focus.transcriptId) return []
            params.transcript_id = focus.transcriptId
            if (level === 'feature') {
                params.start = focus.featureStart
                params.end = focus.featureEnd
            }
        }
        return [{ key: `cls:${JSON.stringify(params)}`, priority: 0, params }]
    }

    // Collapsed, the rows on screen describe stretches that can be far apart, so
    // the tiles are taken from those rather than from the span between them --
    // which for a collapsed chromosome would be nearly all of it.
    const stretches = Array.isArray(intervals) && intervals.length
        ? intervals
        : [{ s: Math.min(visibleStart, visibleEnd), e: Math.max(visibleStart, visibleEnd) }]

    const wanted = new Map()
    for (const stretch of stretches) {
        const low = Math.max(focus.start, Math.min(stretch.s, stretch.e))
        const high = Math.min(focus.end, Math.max(stretch.s, stretch.e))
        if (high < low) continue
        for (let index = tileIndexForCoord(low); index <= tileIndexForCoord(high); index += 1) {
            if (!wanted.has(index)) wanted.set(index, wanted.size === 0 ? 0 : 1)
        }
    }

    const out = []
    for (const [index, priority] of [...wanted.entries()].sort((a, b) => a[0] - b[0])) {
        const range = tileRange(index)
        const start = Math.max(focus.start, range.start)
        const end = Math.min(focus.end, range.end)
        if (end < start) continue
        const params = { genome: genomeKey, chrom, level, start, end, ...(hide ? { hide } : {}) }
        out.push({ key: `cls:${JSON.stringify(params)}`, priority, params })
    }
    return out
}

export default function useSequenceClasses({
    focus = null, visibleStart = 0, visibleEnd = 0, intervals = null, hide = '', enabled = true,
} = {}) {
    // The tick's value, not its setter, is what the memo below depends on. A
    // setter is stable for the life of the component, so depending on it would
    // mean the answers were gathered once and never again -- the requests would
    // land and nothing would repaint with them.
    const [tick, repaint] = useState(0)
    const owner = useRef(Symbol('sequence-view-classes'))

    const serviceKey = `${focus?.genomeKey || ''}:${focus?.chrom || ''}`
    const service = useMemo(() => sequenceTiles(serviceKey), [serviceKey])
    const cache = service.classes

    useEffect(() => {
        let frame = null
        const changed = () => {
            if (frame == null) {
                frame = requestAnimationFrame(() => {
                    frame = null
                    repaint((n) => n + 1)
                })
            }
        }
        const off = cache.subscribe(changed)
        const consumer = owner.current
        return () => {
            off()
            if (frame != null) cancelAnimationFrame(frame)
            cache.release(consumer)
        }
    }, [cache])

    const intervalSignature = useMemo(
        () => (Array.isArray(intervals) ? intervals.map((p) => `${p.s}-${p.e}`).join(',') : ''),
        [intervals],
    )
    const plan = useMemo(
        () => (enabled ? planClassRequests(focus, visibleStart, visibleEnd, intervals, hide) : []),
        // intervalSignature stands in for intervals: a fresh array of the same
        // stretches must not re-plan.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [enabled, focus, visibleStart, visibleEnd, intervalSignature, hide],
    )
    const planSignature = useMemo(() => plan.map((item) => item.key).join('|'), [plan])

    useEffect(() => {
        const tasks = plan.map(({ key, priority, params }) => ({
            key,
            priority,
            label: 'Annotation',
            run: (signal) => sequenceApi('/classes', params, signal),
        }))
        cache.setWanted(tasks, owner.current)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cache, planSignature])

    const answers = useMemo(
        () => plan.map(({ key }) => cache.get(key)).filter(Boolean),
        // The cache changes contents without changing identity, so the tick is
        // what brings new answers through.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [cache, planSignature, tick],
    )

    const runs = useMemo(() => {
        if (answers.length === 0) return []
        if (answers.length === 1) return answers[0].runs || []
        const merged = answers.flatMap((answer) => answer.runs || [])
        merged.sort((a, b) => a.s - b.s)
        return merged
    }, [answers])

    // Where genes lie on one another. Cheap enough that the backend answers even
    // for a tile too dense to colour in detail, so it survives the fallback.
    const overlaps = useMemo(() => {
        const merged = answers.flatMap((answer) => answer.overlaps || [])
        merged.sort((a, b) => a.s - b.s)
        return merged
    }, [answers])

    const first = answers[0] || null

    // Which vocabulary the runs are written in. A tile at a time, so a dense
    // stretch can fall back while its neighbour does not; the view says "plain"
    // when any tile did, since that is the part a reader would otherwise
    // misread.
    const plain = answers.find((answer) => answer.detail === 'plain') || null

    let pending = false
    let failure = null
    let indexBuilding = false
    for (const { key, priority } of plan) {
        if (priority > 1) continue
        if (cache.failed.has(key)) {
            const error = cache.failed.get(key)
            if (error?.status === INDEX_BUILDING) indexBuilding = true
            else failure = failure || error
            continue
        }
        if (!cache.get(key)) pending = true
    }
    // A request still in flight that has already met a 425 once counts as
    // building too, so the banner does not flicker between retries.
    for (const { key } of plan) {
        const error = cache.failed.get(key)
        if (error?.status === INDEX_BUILDING) indexBuilding = true
    }

    return {
        runs,
        // The window the backend settled on, clipped to the contig. The view
        // lays its rows out over this rather than its own estimate, so a focus
        // near the end of a chromosome does not draw rows that are not there.
        // Only meaningful for the levels that ask in one go; a tiled location
        // focus already knows its own extent.
        windowStart: first && first.level !== 'location' ? first.start : null,
        windowEnd: first && first.level !== 'location' ? first.end : null,
        cdsFrame: first?.cdsFrame || EMPTY_FRAME,
        overlaps,
        detail: plain ? 'plain' : (first?.detail || ''),
        // The count that made it fall back, for the line that explains it.
        geneCount: plain ? Number(plain.gene_count) || 0 : 0,
        strand: first?.strand || '+',
        features: useMemo(() => answers.flatMap((answer) => answer.features || []), [answers]),
        annotation: first?.annotation || (indexBuilding ? 'building' : 'ready'),
        truncated: Boolean(first?.truncated),
        note: first?.note || '',
        pending,
        indexBuilding,
        error: failure ? failure.message || String(failure) : null,
        retry: () => cache.retryFailed(),
    }
}

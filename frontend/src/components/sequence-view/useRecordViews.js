// Everything a picked record needs in order to be drawn: what its bases are,
// and how they are laid out.
//
// A record is bounded by definition -- a gene, a transcript, one exon -- so each
// asks once and is done, with no tiling. They go on the same annotation queue as
// everything else, which is what keeps a collection of forty records from
// occupying the single worker that sequence reads through.
//
// The layouts are built here rather than in the view because collapsing is a
// control the reader moves: changing what is hidden, how much of its edges is
// kept or how short a stretch has to be to be left alone re-lays-out every
// record at once, without asking the backend anything.

import { useEffect, useMemo, useRef, useState } from 'react'

import { sequenceApi } from './api'
import { sequenceTiles } from './sequenceTileService'
import {
    DEFAULT_COLLAPSE,
    buildDisplayLayout,
    collapseKeeps,
} from '../../utils/sequenceViewDisplay'
import { anyCollapse } from './useDisplayLayout'

const INDEX_BUILDING = 425

/** What to ask about a record, and under what key to remember the answer. */
function requestsFor(record, genomeKey, collapse, hide) {
    if (!record?.chrom || !record.start || !record.end) return []
    const base = {
        genome: genomeKey,
        chrom: record.chrom,
        start: record.start,
        end: record.end,
        level: record.level,
    }
    if (record.level === 'gene') base.gene_id = record.geneId
    if (record.level === 'transcript' || record.level === 'feature') {
        base.transcript_id = record.transcriptId
    }
    // A gene or transcript describes itself; a feature is a window onto its
    // transcript, so it carries both the transcript and the window.
    const classes = record.level === 'feature'
        ? { ...base }
        : { genome: base.genome, chrom: base.chrom, level: base.level, flank: 0,
            ...(base.gene_id ? { gene_id: base.gene_id } : {}),
            ...(base.transcript_id ? { transcript_id: base.transcript_id } : {}),
            // A record of a gene is drawn by its isoforms, so silencing one
            // changes it exactly as it changes the plain view. A record of a
            // transcript or of one exon has only itself to go on.
            ...(hide && record.level === 'gene' ? { hide } : {}) }

    const out = [{ kind: 'classes', path: '/classes', params: classes }]
    if (collapse) out.push({ kind: 'spans', path: '/spans', params: base })
    return out
}

const taskKey = (kind, params) => `rec:${kind}:${JSON.stringify(params)}`

/** The reader's choices, less whatever this record's region cannot answer. */
function settledFor(collapse, offers) {
    const out = {}
    for (const [kind, choice] of Object.entries(collapse || DEFAULT_COLLAPSE)) {
        out[kind] = { ...choice, on: Boolean(choice?.on) && offers.includes(kind) }
    }
    return out
}

export default function useRecordViews({
    genomeKey = '',
    chrom = '',
    records = null,
    collapse = DEFAULT_COLLAPSE,
    flip = false,
    hide = '',
    enabled = true,
} = {}) {
    // The tick's value, not its setter, is what the memo below depends on -- a
    // setter is stable for the life of the component, so depending on it would
    // gather the answers once and never again.
    const [tick, repaint] = useState(0)
    const owner = useRef(Symbol('sequence-view-records'))

    const serviceKey = `${genomeKey}:${chrom}`
    const service = useMemo(() => sequenceTiles(serviceKey), [serviceKey])
    const cache = service.classes

    useEffect(() => {
        let frame = null
        const changed = () => {
            if (frame == null) {
                frame = requestAnimationFrame(() => { frame = null; repaint((n) => n + 1) })
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

    const list = useMemo(() => (Array.isArray(records) ? records : []), [records])

    // Whether the spans are worth asking for at all. Only this, and not the
    // settings themselves, is part of what is fetched: changing a flank or a
    // floor changes the layout and not the annotation.
    const wanted = anyCollapse(collapse)

    const plan = useMemo(() => {
        if (!enabled) return []
        const out = []
        list.forEach((record, index) => {
            for (const request of requestsFor(record, genomeKey, wanted, hide)) {
                out.push({
                    key: taskKey(request.kind, request.params),
                    // In the order they were picked: the first record is the one
                    // the reader is looking at while the rest arrive.
                    priority: index,
                    recordKey: record.key,
                    kind: request.kind,
                    path: request.path,
                    params: request.params,
                })
            }
        })
        return out
    }, [enabled, list, genomeKey, wanted, hide])

    const planSignature = useMemo(() => plan.map((item) => item.key).join('|'), [plan])

    useEffect(() => {
        cache.setWanted(plan.map(({ key, priority, path, params }) => ({
            key,
            priority,
            label: 'Record',
            run: (signal) => sequenceApi(path, params, signal),
        })), owner.current)
        // planSignature stands in for plan: the same questions at the same
        // priorities must not re-queue because a new array was built.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cache, planSignature])

    const views = useMemo(() => {
        const byRecord = new Map()
        for (const record of list) {
            const asked = requestsFor(record, genomeKey, wanted, hide)
            const classes = asked.find((item) => item.kind === 'classes')
            const spans = asked.find((item) => item.kind === 'spans')
            const answer = classes ? cache.get(taskKey('classes', classes.params)) : null
            const shape = spans ? cache.get(taskKey('spans', spans.params)) : null

            // Reverse reading for a record on the minus strand, the same rule a
            // single transcript in focus follows -- and then the reader's own
            // switch on top of it, which reverses whatever that came to.
            const strand = answer?.strand || record.strand || '+'
            const natural = strand === '-' && record.level !== 'location'
            const reverse = natural !== Boolean(flip)
            // Collapsed only once its spans are here. Laying out over an empty
            // keep set would draw one marker over the whole record and throw
            // every row away the moment the real answer landed.
            const plan = shape
                ? collapseKeeps({
                    region: { start: record.start, end: record.end },
                    genic: shape.genic || [],
                    exonic: shape.exonic || [],
                    settings: settledFor(collapse, shape.offers || []),
                })
                : null
            const collapsed = Boolean(plan && plan.collapses.length)

            byRecord.set(record.key, {
                record,
                runs: answer?.runs || [],
                cdsFrame: answer?.cdsFrame || [],
                strand,
                collapsed,
                collapses: collapsed ? plan.collapses : [],
                hidden: 0,
                layout: buildDisplayLayout({
                    region: { start: record.start, end: record.end },
                    keep: collapsed ? plan.keep : [],
                    flank: 0,
                    collapse: collapsed,
                    reverse,
                }),
                pending: Boolean(classes) && !answer,
            })
        }
        return byRecord
        // The cache changes contents without changing identity, so the tick is
        // what brings new answers through.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list, genomeKey, collapse, wanted, flip, hide, cache, planSignature, tick])

    let pending = false
    let failure = null
    let indexBuilding = false
    for (const { key } of plan) {
        const error = cache.failed.get(key)
        if (error) {
            if (error.status === INDEX_BUILDING) indexBuilding = true
            else failure = failure || error
            continue
        }
        if (!cache.get(key)) pending = true
    }

    return {
        views,
        pending,
        indexBuilding,
        error: failure ? failure.message || String(failure) : null,
        retry: () => cache.retryFailed(),
    }
}

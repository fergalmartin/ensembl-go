// Keeping the rows on screen supplied with sequence while the reader scrolls.
//
// The region a focus covers can be a whole chromosome, so sequence is never
// fetched whole. It arrives in fixed 12 kb chunks on a grid anchored at
// coordinate 1 -- absolute rather than relative to the focus, so that moving
// from a gene to one of its transcripts and back reuses everything already
// fetched instead of starting again.

import { useEffect, useMemo, useRef, useState } from 'react'

import { sequenceApi } from './api'
import { sequenceTiles } from './sequenceTileService'
import {
    chunkIndexForCoord,
    chunkKey,
    planChunksForIntervals,
    planSequenceChunks,
} from '../../utils/sequenceViewChunks'

// How long after a scroll a reader still counts as moving. Past this, the next
// chunk in the direction of travel is not worth the one worker's time: asking
// for it after every idle repaint would keep sequence loading that nobody has
// asked to see. Matches the alignment explorer's lookahead gate.
const MOVING_MS = 600
const MOVING_MS_MIN = 200

export default function useSequenceBuffer({
    genomeKey = '',
    chrom = '',
    region = null,
    visibleStart = 0,
    visibleEnd = 0,
    intervals = null,
    anchorCoord = null,
    softmask = false,
    enabled = true,
    onError = null,
} = {}) {
    const [, repaint] = useState(0)
    const owner = useRef(Symbol('sequence-view'))
    const motion = useRef(null)
    const report = useRef(onError)
    report.current = onError

    const serviceKey = `${genomeKey}:${chrom}`
    const service = useMemo(() => sequenceTiles(serviceKey), [serviceKey])
    const cache = service.sequence

    useEffect(() => {
        service.users += 1
        let frame = null
        const changed = () => {
            // Coalesced to a frame: a chunk landing should repaint once, not
            // once per subscriber callback.
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
            service.users -= 1
        }
    }, [service, cache])

    // Which way the reader is going, and whether they are still going. Held in a
    // ref because it describes the gesture rather than the render.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const previous = motion.current
    const moved = previous && anchorCoord !== null ? anchorCoord - previous.coord : 0
    const recently = previous && now - previous.time < Math.min(MOVING_MS, Math.max(MOVING_MS_MIN, cache.latency))
    const direction = recently ? (Math.sign(moved) || previous.direction || 0) : 0
    if (anchorCoord !== null && (!previous || previous.coord !== anchorCoord)) {
        motion.current = { coord: anchorCoord, time: now, direction: Math.sign(moved) || 0 }
    }

    // Collapsed, the rows on screen cover stretches that can be a long way
    // apart, so the chunks are planned from the stretches themselves. Reading
    // from the first visible coordinate to the last would fetch the whole of
    // every intron the reader has just hidden.
    const scattered = Array.isArray(intervals) && intervals.length > 1
    const intervalSignature = useMemo(
        () => (scattered ? intervals.map((piece) => `${piece.s}-${piece.e}`).join(',') : ''),
        [scattered, intervals],
    )

    const plan = useMemo(() => {
        if (!enabled || !region || !chrom) return []
        if (scattered) {
            return planChunksForIntervals({ intervals, anchorCoord })
        }
        return planSequenceChunks({
            region,
            visibleStart,
            visibleEnd,
            anchorCoord,
            direction,
            lookahead: true,
        })
        // intervalSignature stands in for intervals: a fresh array of the same
        // stretches must not re-plan.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, region, chrom, visibleStart, visibleEnd, anchorCoord, direction,
        scattered, intervalSignature])

    const planSignature = useMemo(
        () => plan.map((chunk) => `${chunk.index}:${chunk.priority}`).join(','),
        [plan],
    )

    useEffect(() => {
        if (!enabled || !chrom) {
            cache.setWanted([], owner.current)
            return
        }
        const tasks = plan.map(({ index, priority, start, end }) => ({
            key: chunkKey(genomeKey, chrom, index),
            priority,
            label: `${chrom}:${start}`,
            bytes: (value) => (value?.sequence?.length || 0) * 2,
            run: async (signal) => {
                const tile = await sequenceApi(
                    '/sequence',
                    { genome: genomeKey, chrom, start, end, softmask },
                    signal,
                )
                return { ...tile, index }
            },
        }))
        cache.setWanted(tasks, owner.current)
        // planSignature stands in for plan: the same chunks at the same
        // priorities must not re-queue just because a new array was built.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cache, enabled, genomeKey, chrom, planSignature, softmask])

    // A reader rather than a snapshot. The closure looks the chunk up when it is
    // called, so it does not have to be rebuilt when one lands -- the repaint is
    // enough. Anything here that captured the cache's *contents* instead would
    // have to depend on the tick, or it would be gathered once and never again.
    const readChunk = useMemo(() => {
        const prefix = `${genomeKey}:${chrom}`
        return (index) => cache.get(`seq:${prefix}:${index}`)
    }, [cache, genomeKey, chrom])

    const readSequence = useMemo(() => (index) => readChunk(index)?.sequence || null, [readChunk])

    /** The soft-masked stretches overlapping a row, from whichever chunks it spans. */
    const maskedForRow = useMemo(() => (row) => {
        if (!softmask || !row) return []
        const first = chunkIndexForCoord(row.start)
        const last = chunkIndexForCoord(row.end)
        const out = []
        for (let index = first; index <= last; index += 1) {
            const tile = readChunk(index)
            if (!tile?.masked?.length) continue
            for (const span of tile.masked) {
                if (span.e < row.start || span.s > row.end) continue
                out.push(span)
            }
        }
        return out
    }, [readChunk, softmask])

    let pending = false
    let failure = null
    for (const { index, priority } of plan) {
        if (priority > 1) continue
        const key = chunkKey(genomeKey, chrom, index)
        if (cache.failed.has(key)) {
            failure = failure || cache.failed.get(key)
            continue
        }
        if (!cache.get(key)) pending = true
    }

    useEffect(() => {
        if (failure && report.current) report.current(failure.message || String(failure))
    }, [failure])

    return {
        readChunk,
        readSequence,
        maskedForRow,
        pending,
        error: failure ? failure.message || String(failure) : null,
        retry: () => cache.retryFailed(),
    }
}

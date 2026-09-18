// The list of things the reader can drill into from where they are.
//
// One request per level, made when that level opens: the genes on a location,
// the transcripts of a gene, the exons and introns of a transcript. Kept apart
// from the class and sequence queues because it is a small, one-off read that
// should not wait behind either of them.
//
// A location list is asked again as the reader scrolls, and that is what makes
// this more than a fetch. The rule is that the panel never goes blank and never
// half-draws: the list already on screen stays exactly as it is until a reply
// arrives that actually says something different, and then it is replaced in
// one go. Emptying it while a reply is in flight is what made the panel flicker
// -- and, worse, what swallowed clicks, since a button removed between the
// press and the release never sees a click at all.

import { useEffect, useRef, useState } from 'react'

import { sequenceApi } from './api'
import {
    LEVEL_GENE,
    LEVEL_LOCATION,
    LEVEL_TRANSCRIPT,
} from '../../utils/sequenceViewFocus'

// How long the scrolling has to settle before the window is asked about again.
// Only ever applied to a list of the same thing: moving to another level is the
// reader asking for something they cannot see yet, so that goes at once.
const SETTLE_MS = 150

// How many lists to remember, so that stepping down into a gene and back up
// again finds the location's genes still there. One per level plus room for a
// few siblings, which is as far back as the focus chain can go.
const REMEMBERED = 8

/**
 * What to ask, and what the answer would be a list *of*.
 *
 * The identity is deliberately coarser than the request: a location's genes are
 * identified by the region, not by the window scrolled to within it, so moving
 * the window is a refresh of a list the reader is already looking at rather
 * than a different list. A gene's transcripts are identified by the gene, so
 * one gene's transcripts can never be shown under another's.
 */
function requestFor(focus, window) {
    if (!focus) return null
    switch (focus.level) {
        case LEVEL_LOCATION: {
            if (!focus.location) return null
            // The window is quantised before it becomes a request, so scrolling
            // a row at a time does not re-ask for a list that would come back
            // the same. A screenful is about two kilobases; this asks again
            // roughly once per screenful moved.
            const step = 2_000
            const quantise = (value, round) => round(Number(value) / step) * step
            const from = Number(window?.start)
            const to = Number(window?.end)
            const known = Number.isFinite(from) && Number.isFinite(to) && to > from
            const identity = `genes:${focus.genomeKey}:${focus.chrom}:${focus.location.start}-${focus.location.end}`
            return {
                identity,
                path: '/focus/genes',
                params: {
                    genome: focus.genomeKey,
                    chrom: focus.chrom,
                    start: focus.location.start,
                    end: focus.location.end,
                    // Before the first paint there is no window yet. Ask about
                    // the start of the region rather than about the whole of
                    // it, which for a chromosome would be every gene on it.
                    window_start: known
                        ? Math.max(focus.location.start, quantise(from, Math.floor))
                        : focus.location.start,
                    window_end: known
                        ? Math.min(focus.location.end, quantise(to, Math.ceil))
                        : Math.min(focus.location.end, focus.location.start + step),
                },
            }
        }
        case LEVEL_GENE:
            if (!focus.gene?.id) return null
            return {
                identity: `transcripts:${focus.genomeKey}:${focus.gene.id}`,
                path: '/focus/transcripts',
                params: { genome: focus.genomeKey, gene_id: focus.gene.id },
            }
        case LEVEL_TRANSCRIPT:
            if (!focus.transcript?.id) return null
            return {
                identity: `features:${focus.genomeKey}:${focus.transcript.id}`,
                path: '/focus/features',
                params: { genome: focus.genomeKey, transcript_id: focus.transcript.id },
            }
        default:
            // A feature and an ad-hoc selection have nothing below them.
            return null
    }
}

/**
 * Whether two lists would draw the same rows.
 *
 * Compared by what a row shows rather than by object identity, because the
 * reply is freshly parsed JSON every time and so never identical to the last
 * one. Scrolling within a gene-rich stretch mostly produces the same ten genes,
 * and answering "nothing to do" here is what keeps the panel still.
 */
function sameRows(before, after) {
    if (before === after) return true
    if (!Array.isArray(before) || !Array.isArray(after)) return false
    if (before.length !== after.length) return false
    for (let index = 0; index < before.length; index += 1) {
        const a = before[index]
        const b = after[index]
        if (a === b) continue
        if (a?.id !== b?.id) return false
        if (a?.s !== b?.s || a?.e !== b?.e) return false
        if (a?.kind !== b?.kind || a?.index !== b?.index) return false
    }
    return true
}

/** The last few answers, oldest dropped, so ascending finds its list intact. */
function remember(memory, identity, entry) {
    const next = { ...memory }
    // Deleted before being re-added, because a key put back into an object it is
    // already in keeps its original place -- and the list being refreshed most
    // often would then be the first one dropped.
    delete next[identity]
    next[identity] = entry
    const keys = Object.keys(next)
    for (const key of keys.slice(0, Math.max(0, keys.length - REMEMBERED))) delete next[key]
    return next
}

const EMPTY = {
    signature: '', identity: '', items: [], total: null, inWindow: null, error: null, memory: {},
}

export default function useFocusChildren(focus, window) {
    // Keyed by the request it answers, so "is this list the one we are showing"
    // is derived rather than tracked -- which keeps the effect from having to
    // set state on its way in and re-render for it.
    const [loaded, setLoaded] = useState(EMPTY)
    // What has actually arrived, written only when something does. Read inside
    // the effect to tell a refresh of the list on screen from a list the reader
    // cannot see yet -- which is not a question the effect can be allowed to
    // re-run on.
    const arrived = useRef('')

    const request = requestFor(focus, window)
    const signature = request ? JSON.stringify([request.identity, request.path, request.params]) : ''

    useEffect(() => {
        if (!signature) return undefined
        const [identity, path, params] = JSON.parse(signature)
        const controller = new AbortController()
        const settle = arrived.current === identity ? SETTLE_MS : 0

        const timer = setTimeout(() => {
            sequenceApi(path, params, controller.signal)
                .then((data) => {
                    arrived.current = identity
                    const items = data.genes || data.transcripts || data.features || []
                    // How many there are in the whole region, which is a
                    // different question from what is worth listing here.
                    const total = typeof data.total === 'number' ? data.total : null
                    const inWindow = typeof data.in_window === 'number' ? data.in_window : null
                    setLoaded((previous) => {
                        const kept = previous.identity === identity && !previous.error
                            && sameRows(previous.items, items)
                            // The rows themselves are kept when the answer has
                            // not changed, so nothing below re-renders and the
                            // panel does not move at all.
                            ? previous.items
                            : items
                        return {
                            signature,
                            identity,
                            items: kept,
                            total,
                            inWindow,
                            error: null,
                            memory: remember(previous.memory, identity, { items: kept, total, inWindow }),
                        }
                    })
                })
                .catch((error) => {
                    if (error.name === 'AbortError') return
                    arrived.current = identity
                    // Whatever is on screen is still the best answer there is,
                    // so it stays; the failure is reported beside it rather
                    // than in place of it.
                    setLoaded((previous) => ({
                        ...previous,
                        signature,
                        identity,
                        items: previous.identity === identity ? previous.items : [],
                        error: error.message || String(error),
                    }))
                })
        }, settle)

        return () => { clearTimeout(timer); controller.abort() }
    }, [signature])

    const ready = Boolean(signature) && loaded.signature === signature
    // Something to show while the reply is on its way: either the same list for
    // a window that has moved, or the answer this level gave last time the
    // reader was here. Both are very nearly the list about to arrive, and both
    // are a better thing to draw than nothing.
    const current = request && loaded.identity === request.identity
        ? loaded
        : (request ? loaded.memory?.[request.identity] : null) || null

    return {
        items: current ? current.items : [],
        total: current ? current.total : null,
        inWindow: current ? current.inWindow : null,
        // Only true when there is genuinely nothing to show yet. A refresh of a
        // list already on screen is not something the reader needs telling
        // about, and saying so would itself be the flicker.
        loading: Boolean(signature) && !current,
        error: ready ? loaded.error : null,
    }
}

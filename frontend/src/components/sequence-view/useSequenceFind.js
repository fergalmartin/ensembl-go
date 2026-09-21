import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
    activePatterns,
    nearestMatch,
    patternErrors,
    patternSearchKey,
    stepMatch,
} from '../../utils/findPatterns'
import { sequenceApiPost } from './api'

const NO_MATCHES = Object.freeze([])

/**
 * Where what the reader is looking for turns up in the region they are reading.
 *
 * The region, not the screen. The view holds a few screens of sequence at a
 * time, and a count of matches that changed as the reader scrolled would be
 * worse than no count at all -- "3 of 148" has to mean the same thing at the
 * top of a gene and the bottom of it. So the scan is the backend's, over the
 * whole extent in focus, and what comes back is the same answer wherever the
 * reader happens to be.
 *
 * Asked again only when the answer would differ: the patterns' text and kind,
 * the region, the genome, and which way round the sequence is being read --
 * that last because the search is done on what is displayed, so a reader
 * looking at the reverse complement is looking for what they can see. Colour,
 * order and the enable switches are applied here without asking anything.
 *
 * **`patterns` is what the reader submitted, not what they are typing.** This
 * used to debounce a search behind every keystroke, which is the right shape
 * for a find box over a page and the wrong one for a scan of a chromosome:
 * typing `ATGGC` started five of them and threw four away. The box has a
 * button now, and nothing happens until it is pressed.
 */
export default function useSequenceFind({
    genome = '',
    chrom = '',
    region = null,
    reverse = false,
    patterns = [],
    enabled = false,
    // Where the reader is looking, so a search can start from there rather
    // than from wherever the region happens to begin.
    near = null,
} = {}) {
    const [answer, setAnswer] = useState(null)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState('')

    const errors = useMemo(() => patternErrors(patterns), [patterns])
    const searchable = useMemo(
        () => activePatterns(patterns).filter((item) => !errors[item.id]),
        [patterns, errors],
    )
    // What a search is, as against what a picture of one is. Recolouring or
    // reordering must not throw away matches that are still correct.
    const key = useMemo(() => patternSearchKey(searchable), [searchable])
    const start = region?.start ?? 0
    const end = region?.end ?? 0
    const on = Boolean(enabled && genome && chrom && end >= start && start > 0 && key !== '[]')

    // The request in flight, so a reader typing quickly is not answered by an
    // older scan that happened to finish later.
    const runRef = useRef(0)

    useEffect(() => {
        if (!on) {
            setAnswer(null)
            setPending(false)
            setError('')
            return undefined
        }
        const run = runRef.current + 1
        runRef.current = run
        const controller = new AbortController()
        setPending(true)
        ;(async () => {
            try {
                const result = await sequenceApiPost('/find', {
                    genome,
                    chrom,
                    start,
                    end,
                    strand: reverse ? '-' : '+',
                    patterns: JSON.parse(key),
                }, controller.signal)
                if (runRef.current !== run) return
                setAnswer(result)
                setError('')
            } catch (failure) {
                if (controller.signal.aborted || runRef.current !== run) return
                setAnswer(null)
                setError(String(failure?.message || 'Could not search this region'))
            } finally {
                if (runRef.current === run) setPending(false)
            }
        })()
        return () => controller.abort()
    }, [on, genome, chrom, start, end, reverse, key])

    const matches = answer?.matches || NO_MATCHES
    const total = answer?.total ?? 0

    // Which match the reader is standing on. Kept here rather than by the
    // caller because it has to be forgotten when the matches change underneath
    // it: match three of the old search is not match three of the new one.
    const [at, setAt] = useState(-1)
    useEffect(() => { setAt(-1) }, [key, start, end, genome, chrom, reverse])

    /**
     * A new answer starts at the match nearest where the reader is looking.
     *
     * Not at the first one in the region. On a chromosome the first is a very
     * long way from wherever they are reading, so a search jumped them
     * somewhere else entirely and stepping walked back towards them one match
     * at a time.
     *
     * `near` is read from a ref, so scrolling does not re-run this: where the
     * reader was looking matters at the moment the answer lands and not
     * afterwards. And only where they have not already chosen a match, which
     * is what leaves a reader stepping through undisturbed.
     */
    const nearRef = useRef(near)
    nearRef.current = near
    useEffect(() => {
        if (!answer?.matches?.length) return
        setAt((previous) => (previous >= 0 ? previous : nearestMatch(matches, nearRef.current)))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [answer])

    const step = useCallback((delta) => {
        setAt((previous) => stepMatch(previous, matches.length, delta))
    }, [matches.length])

    const goTo = useCallback((index) => {
        setAt(index >= 0 && index < matches.length ? index : -1)
    }, [matches.length])

    /**
     * Which match covers a coordinate, or -1 where none does.
     *
     * What a click on the sequence is answered with: the reader pressed a base,
     * and if that base is part of something they were looking for then that is
     * the match they mean.
     *
     * Binary search, because a chromosome's worth of matches is a long list to
     * walk -- and it takes the reading direction, because the list is in
     * reading order and that runs backwards along the chromosome when the
     * sequence is turned round. Where two matches cover one base the search
     * keeps going left, so the answer is the first of them in reading order --
     * which the tie-break above made the one that is drawn on top.
     */
    const indexAt = useCallback((coord) => {
        const at = Number(coord)
        if (!Number.isFinite(at)) return -1
        const order = reverse ? -1 : 1
        let low = 0
        let high = matches.length - 1
        let found = -1
        while (low <= high) {
            const mid = (low + high) >>> 1
            const [from, to] = matches[mid]
            if (at >= from && at <= to) {
                found = mid
                high = mid - 1
            } else if ((at - from) * order < 0) high = mid - 1
            else low = mid + 1
        }
        return found
    }, [matches, reverse])

    return useMemo(() => ({
        matches,
        total,
        truncated: Boolean(answer?.truncated),
        counts: answer?.counts || null,
        pending,
        error,
        errors,
        // Which one the reader is on, and the one itself. Named `match` and
        // not `current`, because a field called `current` on a hook's result
        // reads as a ref to every linter that looks at it -- and this one is
        // a value that must be depended on.
        at,
        match: at >= 0 && at < matches.length ? matches[at] : null,
        // Whether the list of positions is the whole of what was counted. The
        // count is exact either way.
        listed: matches.length,
        step,
        goTo,
        indexAt,
        // Whether anything was asked at all, which is not the same as having
        // found nothing: an empty box is not a search that failed.
        searching: on,
    }), [matches, total, answer, pending, error, errors, at, step, goTo, indexAt, on])
}

import { useCallback, useEffect, useState } from 'react'

import { KIND_CDS, KIND_PROTEIN, isSpliced } from '../../utils/transcriptSequenceView'
import { sequenceApi } from './api'

/**
 * A transcript's own readings, fetched once each and remembered.
 *
 * Two callers need the same answers and must not ask twice: the bar over the
 * sequence, which prints how long each reading is and greys the two coding ones
 * where there is no CDS, and the surface below it, which draws whichever is
 * chosen. So the store is here, one level above both, rather than inside the
 * surface where the bar could not see it.
 *
 * Only the reading being drawn is fetched. The other two are a request each that
 * a reader who never switches would never need, and the bar says nothing about a
 * length it has not been told rather than a nought, which would be a claim that
 * the transcript has none.
 */
export default function useTranscriptReadings({ genomeKey, transcriptId, kind }) {
    // The store carries what it is about, and is replaced rather than patched
    // when that changes -- the house pattern for state derived from a prop, and
    // the only way the fetch below can be sure it is not looking in a store
    // belonging to the transcript the reader has just left.
    const identity = `${genomeKey}|${transcriptId}`
    const [held, setHeld] = useState({ identity, answers: {}, error: '' })
    if (held.identity !== identity) setHeld({ identity, answers: {}, error: '' })
    const answers = held.identity === identity ? held.answers : {}
    const error = held.identity === identity ? held.error : ''

    const remember = useCallback((key, value) => setHeld((was) => (
        // A reply for a transcript the reader has already left is dropped rather
        // than stored under the one they are on now.
        was.identity === identity
            ? { ...was, answers: { ...was.answers, [key]: value } }
            : was
    )), [identity])

    const wanted = isSpliced(kind) ? kind : ''
    const answer = wanted ? (answers[wanted] || null) : null

    // `have` rather than the answers themselves, so a reply landing flips one
    // boolean and the effect returns, instead of rebuilding into a second fetch.
    const have = Boolean(answer)
    useEffect(() => {
        if (!wanted || !transcriptId || have) return undefined
        let live = true
        const controller = new AbortController()
        sequenceApi('/transcript-sequence', {
            genome: genomeKey, transcript_id: transcriptId, kind: wanted,
        }, controller.signal)
            .then((result) => { if (live) remember(wanted, result) })
            .catch((failure) => {
                if (!live || failure?.name === 'AbortError') return
                setHeld((was) => (was.identity === identity
                    ? { ...was, error: failure?.message || 'Could not read this sequence' }
                    : was))
            })
        return () => { live = false; controller.abort() }
    }, [genomeKey, transcriptId, wanted, have, identity, remember])

    return {
        answers,
        answer,
        error,
        loading: Boolean(wanted) && Boolean(transcriptId) && !answer && !error,
        // Said by an answer rather than guessed from the biotype. Either coding
        // reading reporting no CDS settles it for both, because it is one fact
        // about the transcript and not two about the readings.
        coding: ![answers[KIND_CDS], answers[KIND_PROTEIN]]
            .some((one) => one?.status === 'no_cds'),
    }
}

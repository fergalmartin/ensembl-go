import { useCallback, useEffect, useMemo, useState } from 'react'

import {
    KIND_CDS,
    KIND_PROTEIN,
    KIND_TRANSCRIPT,
    isSpliced,
} from '../../utils/transcriptSequenceView'
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
 * **All of them are fetched, not only the one being drawn.** It used to be one,
 * on the grounds that a reader who never switches would never need the others
 * -- but the bar prints how long each reading is, and one that only knew the
 * reading already on screen told the reader nothing until they had clicked it.
 * Finding out how long a protein is by opening it is not an answer to the
 * question the bar exists to answer.
 *
 * They are fetched one after another rather than at once, and the one on screen
 * goes first, because that is the one somebody is waiting for. Each is small --
 * a spliced transcript is kilobases, not megabases -- and the backend caches
 * them, so a reader switching back and forth pays for none of it twice.
 *
 * `coding` says whether there is a coding sequence to ask about at all. It comes
 * from the annotation the view has already fetched for its own drawing, so a
 * non-coding transcript never asks for a CDS or a protein -- and the bar knows
 * to grey them before the reader presses one, rather than after.
 */
export default function useTranscriptReadings({ genomeKey, transcriptId, kind, coding = true }) {
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

    const shown = isSpliced(kind) ? kind : ''
    const answer = shown ? (answers[shown] || null) : null

    /**
     * Every reading this transcript has, the one on screen first.
     *
     * A transcript always has its own spliced sequence; the two coding ones
     * exist only where there is a coding sequence, and asking for them on a
     * lncRNA is a request whose answer is known before it is sent.
     */
    const wanted = useMemo(() => {
        if (!transcriptId) return []
        const all = coding ? [KIND_TRANSCRIPT, KIND_CDS, KIND_PROTEIN] : [KIND_TRANSCRIPT]
        return shown && all.includes(shown)
            ? [shown, ...all.filter((one) => one !== shown)]
            : all
    }, [transcriptId, coding, shown])

    /**
     * The next one still missing, fetched one at a time.
     *
     * The guard is on *having the answer* rather than on having asked for it.
     * An effect that recorded the attempt and then had its request cancelled --
     * which is what happens on every mount under StrictMode -- would never ask
     * again, and the bar would sit on a blank length for good. So a cancelled
     * attempt leaves nothing behind and the next run retries; a reply settles
     * one reading and re-runs this for the one after it.
     */
    const next = wanted.find((one) => !answers[one]) || ''
    useEffect(() => {
        if (!next || !transcriptId) return undefined
        let live = true
        const controller = new AbortController()
        sequenceApi('/transcript-sequence', {
            genome: genomeKey, transcript_id: transcriptId, kind: next,
        }, controller.signal)
            .then((result) => { if (live) remember(next, result) })
            .catch((failure) => {
                if (!live || failure?.name === 'AbortError') return
                setHeld((was) => (was.identity === identity
                    ? { ...was, error: failure?.message || 'Could not read this sequence' }
                    : was))
            })
        return () => { live = false; controller.abort() }
    }, [genomeKey, transcriptId, next, identity, remember])

    return {
        answers,
        answer,
        error,
        loading: Boolean(shown) && Boolean(transcriptId) && !answer && !error,
        // The caller's answer, with either coding reading's own refusal as a
        // backstop: `no_cds` from one settles it for both, because it is one
        // fact about the transcript and not two about the readings.
        coding: coding && ![answers[KIND_CDS], answers[KIND_PROTEIN]]
            .some((one) => one?.status === 'no_cds'),
    }
}

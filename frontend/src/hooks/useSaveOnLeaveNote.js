import { useEffect, useRef } from 'react'

import { isTempNoteId } from '../utils/geneNotes'

/**
 * Save the note a reader has just left.
 *
 * Leaving a note — going back to the list, closing the panel, navigating away —
 * is them saying they are done with it, so the autosave debounce does not get to
 * hold their last sentence.
 *
 * The one subtlety, and the reason this is shared rather than written out at
 * each call site: a note's id changes once, from the temporary id it is created
 * under to the one the server assigns. That transition looks exactly like the
 * reader moving from note A to note B, and treating it as one runs the
 * leave-behaviour over a note that is still open and still being typed into —
 * which, for a note nobody has written in yet, means discarding it the instant
 * it is created. Both effects below have to know the difference.
 */
export default function useSaveOnLeaveNote(openNoteId, onSave) {
    const openNoteIdRef = useRef(openNoteId)
    const onSaveRef = useRef(onSave)

    useEffect(() => {
        onSaveRef.current = onSave
    }, [onSave])

    useEffect(() => {
        const previous = openNoteIdRef.current
        openNoteIdRef.current = openNoteId
        if (!previous || previous === openNoteId) return
        // A temp id becoming the server's id is this note being saved, not the
        // reader leaving it.
        if (isTempNoteId(previous)) return
        onSaveRef.current?.(previous)
    }, [openNoteId])

    useEffect(() => () => {
        const id = openNoteIdRef.current
        if (id && !isTempNoteId(id)) onSaveRef.current?.(id)
    }, [])
}

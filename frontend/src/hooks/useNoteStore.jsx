import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import {
    NOTE_SAVE_STATES,
    geneNoteCountsForGenome,
    geneNoteTargetKey,
    makeTempNoteId,
    mergeLoadedNotes,
    nextSaveState,
    noteEditableFieldsMatch,
    noteIsBlank,
    noteTargetKey,
    normalizeNote,
    normalizeNoteList,
    notesByTargetKey as groupByTargetKey,
    pendingUnloadWrites,
} from '../utils/geneNotes'
import { normalizeNoteTags, sameTagList } from '../utils/noteTags'

/**
 * Every note the user has written, and the machinery for writing them.
 *
 * The only React context in this app, and it earns it. Three of the refs below —
 * the unsaved set, the in-flight map, and the compare-and-swap token cache — are
 * only correct if there is exactly one of each in the process. Two copies would
 * mean one view advancing a note's token while the other holds the old one, and
 * the other's next write conflicting with a write this app made itself. That is
 * a correctness argument, not an efficiency one, so the store is a provider
 * rather than a hook each consumer calls for itself.
 *
 * Both the genome browser's focus drawer and the Notes view read from here. The
 * whole store is loaded in one request: notes are human prose, so there are
 * hundreds of them at most, and holding them all turns every per-gene and
 * per-genome question into a synchronous selector.
 *
 * Everything this makes a decision about lives as a pure function in
 * `utils/geneNotes.js`, where the test harness can reach it.
 */

/** Quiet enough that a sentence lands as one write, short enough to feel saved. */
const NOTE_AUTOSAVE_DEBOUNCE_MS = 600

/**
 * Longest a note may go unwritten while someone keeps typing.
 *
 * The debounce alone never fires during continuous writing, which is exactly
 * when there is most to lose.
 */
const NOTE_AUTOSAVE_MAX_WAIT_MS = 5000

/** How long "Saved" stands before the indicator goes quiet again. */
const NOTE_SAVED_SETTLE_MS = 2000

const EMPTY_NOTES = Object.freeze([])
const EMPTY_COUNTS = Object.freeze({})

const NoteStoreContext = createContext(null)

export function NoteStoreProvider({ children }) {
    const [notesById, setNotesById] = useState({})
    const [status, setStatus] = useState('idle')
    const [error, setError] = useState('')
    const [saveStateById, setSaveStateById] = useState({})
    const [reloadEpoch, setReloadEpoch] = useState(0)

    // Read by writes that need the freshest list without waiting for a render.
    const notesByIdRef = useRef({})
    notesByIdRef.current = notesById

    // A load already on its way cannot know about work started since. Bumped
    // before any optimistic change so a response in flight is discarded.
    const loadGenerationRef = useRef(0)

    // noteId -> { timer, firstEditAt }
    const noteSaveTimersRef = useRef(new Map())
    const settleTimersRef = useRef(new Map())
    const tmpNoteCounterRef = useRef(0)

    // Notes with edits that have not reached the server. Leaving a note the
    // reader only read must not write to it — a save that changes nothing still
    // moves `updated_at`, and the next real save then conflicts with it.
    const dirtyNotesRef = useRef(new Set())
    // One write per note at a time. Two overlapping PUTs would both carry the
    // same compare-and-swap token, and the second would lose to the first.
    const noteWritesInFlightRef = useRef(new Map())
    // Freshest `updated_at` we have been told about, by note. The token has to be
    // the newest one known *now*, which is not always what the last render holds.
    const noteVersionsRef = useRef(new Map())
    // Notes with a DELETE in flight, so a load landing behind it cannot bring
    // them back.
    const deletingNotesRef = useRef(new Set())
    // A user can delete a new blank note before its POST returns. Remember that
    // intent so the arriving server copy is deleted instead of becoming an
    // orphaned empty note after its optimistic draft has left the UI.
    const pendingCreateDeletesRef = useRef(new Set())
    // Archive changes are optimistic too. A load landing during the request
    // keeps the local state instead of briefly moving the note back.
    const archivingNotesRef = useRef(new Set())

    const invalidateLoad = useCallback(() => {
        loadGenerationRef.current += 1
    }, [])

    // --- Save state ---------------------------------------------------------

    const clearSettleTimer = useCallback((noteId) => {
        const timer = settleTimersRef.current.get(noteId)
        if (timer) clearTimeout(timer)
        settleTimersRef.current.delete(noteId)
    }, [])

    const setSaveState = useCallback((noteId, event) => {
        if (!noteId) return
        setSaveStateById((prev) => {
            const next = nextSaveState(prev[noteId], event)
            if (next === prev[noteId]) return prev
            return { ...prev, [noteId]: next }
        })
        clearSettleTimer(noteId)
        if (event !== 'ok') return
        // "Saved" is a reassurance, not a state worth living in. Left standing it
        // also accumulates one stale entry per note the reader ever touched.
        settleTimersRef.current.set(noteId, setTimeout(() => {
            settleTimersRef.current.delete(noteId)
            setSaveStateById((prev) => {
                const next = nextSaveState(prev[noteId], 'settle')
                if (next === prev[noteId]) return prev
                return { ...prev, [noteId]: next }
            })
        }, NOTE_SAVED_SETTLE_MS))
    }, [clearSettleTimer])

    const forgetNote = useCallback((noteId) => {
        clearSettleTimer(noteId)
        setSaveStateById((prev) => {
            if (!(noteId in prev)) return prev
            const next = { ...prev }
            delete next[noteId]
            return next
        })
    }, [clearSettleTimer])

    // --- Loading ------------------------------------------------------------

    useEffect(() => {
        const generation = loadGenerationRef.current + 1
        loadGenerationRef.current = generation
        const controller = new AbortController()

        setStatus((prev) => (prev === 'ready' ? prev : 'loading'))
        fetch(`${API_BASE}/api/notes`, { signal: controller.signal })
            .then(async (res) => {
                if (!res.ok) throw new Error(`Notes request failed (${res.status})`)
                return res.json()
            })
            .then((payload) => {
                if (loadGenerationRef.current !== generation) return
                const loaded = normalizeNoteList(payload?.notes)
                const loadedById = new Map(loaded.map((note) => [note.id, note]))
                // A previous write can report a conflict even though a later
                // reload shows both copies are now identical (for example, a
                // reversible status toggle in another app window). Such a note
                // is no longer dirty and must not remain permanently blocked.
                for (const noteId of [...dirtyNotesRef.current]) {
                    const local = notesByIdRef.current[noteId]
                    const remote = loadedById.get(noteId)
                    if (!noteEditableFieldsMatch(local, remote)) continue
                    dirtyNotesRef.current.delete(noteId)
                    const pending = noteSaveTimersRef.current.get(noteId)
                    if (pending?.timer) clearTimeout(pending.timer)
                    noteSaveTimersRef.current.delete(noteId)
                }
                // Never assigned wholesale: somewhere else in the app there may be
                // a note being typed into, one whose POST has not come back, or
                // one being deleted. See mergeLoadedNotes.
                const merged = mergeLoadedNotes(loaded, notesByIdRef.current, {
                    dirtyIds: new Set([...dirtyNotesRef.current, ...archivingNotesRef.current]),
                    deletingIds: deletingNotesRef.current,
                })
                for (const note of merged) {
                    // Only for notes nobody is editing: a dirty note's token must
                    // keep pointing at the version its edit was made against.
                    if (!dirtyNotesRef.current.has(note.id)) {
                        noteVersionsRef.current.set(note.id, note.updatedAt)
                    }
                }
                setSaveStateById((previous) => {
                    let changed = false
                    const next = { ...previous }
                    for (const note of merged) {
                        if (dirtyNotesRef.current.has(note.id) || !(note.id in next)) continue
                        delete next[note.id]
                        changed = true
                    }
                    return changed ? next : previous
                })
                setNotesById(Object.fromEntries(merged.map((note) => [note.id, note])))
                setError('')
                setStatus('ready')
            })
            .catch((cause) => {
                if (controller.signal.aborted) return
                if (loadGenerationRef.current !== generation) return
                setError(cause?.message || "Couldn't load notes.")
                setStatus('error')
            })

        return () => controller.abort()
    }, [reloadEpoch])

    // --- Writing ------------------------------------------------------------

    const patchNote = useCallback((noteId, patch) => {
        setNotesById((prev) => {
            const note = prev[noteId]
            if (!note) return prev
            return { ...prev, [noteId]: { ...note, ...patch } }
        })
    }, [])

    const clearNoteTimer = useCallback((noteId) => {
        const pending = noteSaveTimersRef.current.get(noteId)
        if (pending?.timer) clearTimeout(pending.timer)
        noteSaveTimersRef.current.delete(noteId)
    }, [])

    /**
     * Write a note now, if it has anything to write.
     *
     * Two rules keep this from fighting itself. A note with no unsaved edits is
     * not written at all — a no-op save still moves `updated_at` on the server,
     * and the next real save would then be refused as a conflict against a write
     * this code made itself. And only one write per note is ever in flight, so
     * two saves cannot both send the same compare-and-swap token.
     */
    const flushNote = useCallback((noteId, { force = false } = {}) => {
        clearNoteTimer(noteId)
        if (!dirtyNotesRef.current.has(noteId)) return undefined
        // Let the write already going out carry these edits, then re-check: a
        // keystroke that landed mid-flight leaves the note dirty again.
        const inFlight = noteWritesInFlightRef.current.get(noteId)
        if (inFlight) return inFlight

        const note = notesByIdRef.current[noteId]
        // A note still waiting for its POST has nothing to PUT to yet; the
        // create's own response carries whatever was typed in the meantime.
        if (!note || note.pending) return undefined

        const write = (async () => {
            setSaveState(noteId, 'flush')
            try {
                const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: note.title,
                        body: note.body,
                        tags: note.tags,
                        status: note.status,
                        priority: note.priority,
                        completed: note.completed,
                        todo_order: note.todoOrder,
                        // Omitted on a forced write: that is the reader having been
                        // shown the conflict and chosen to overwrite, so there is
                        // nothing left to compare against. Otherwise from the ref,
                        // not from `note` — a previous write may have returned a
                        // newer stamp than the render this note came from.
                        ...(force ? {} : { updated_at: noteVersionsRef.current.get(noteId) || note.updatedAt }),
                    }),
                })
                if (res.status === 409) {
                    setSaveState(noteId, 'conflict')
                    return
                }
                if (!res.ok) throw new Error(`Save failed (${res.status})`)
                const saved = normalizeNote(await res.json())
                if (saved) {
                    noteVersionsRef.current.set(noteId, saved.updatedAt)
                    patchNote(noteId, {
                        updatedAt: saved.updatedAt,
                        status: saved.status,
                        priority: saved.priority,
                        completed: saved.completed,
                        completedAt: saved.completedAt,
                        todoOrder: saved.todoOrder,
                        tags: saved.tags,
                        tagsUpdatedAt: saved.tagsUpdatedAt,
                    })
                }
                // Only clear the flag if nothing was typed while this was out.
                const latest = notesByIdRef.current[noteId]
                if (!latest || (
                    note.title === latest.title
                    && note.body === latest.body
                    && sameTagList(note.tags, latest.tags)
                    && note.status === latest.status
                    && note.priority === latest.priority
                    && note.completed === latest.completed
                    && note.todoOrder === latest.todoOrder
                )) {
                    dirtyNotesRef.current.delete(noteId)
                }
                setSaveState(noteId, 'ok')
            } catch {
                // The text stays in state either way. Losing what someone wrote to
                // report that it failed to save would be the worse outcome.
                setSaveState(noteId, 'fail')
            } finally {
                noteWritesInFlightRef.current.delete(noteId)
            }
        })()

        noteWritesInFlightRef.current.set(noteId, write)
        return write
    }, [clearNoteTimer, patchNote, setSaveState])

    const flushNoteRef = useRef(flushNote)
    useEffect(() => {
        flushNoteRef.current = flushNote
    }, [flushNote])

    const updateNoteFields = useCallback((noteId, patch) => {
        patchNote(noteId, patch)
        setSaveState(noteId, 'edit')

        // The only place a note becomes worth writing. Everything else that
        // saves is just choosing when.
        dirtyNotesRef.current.add(noteId)
        const pending = noteSaveTimersRef.current.get(noteId)
        if (pending?.timer) clearTimeout(pending.timer)
        const firstEditAt = pending?.firstEditAt || Date.now()

        // Continuous typing never lets a debounce fire, which is exactly when
        // there is most to lose — so the wait is capped.
        const elapsed = Date.now() - firstEditAt
        const delay = elapsed >= NOTE_AUTOSAVE_MAX_WAIT_MS
            ? 0
            : Math.min(NOTE_AUTOSAVE_DEBOUNCE_MS, NOTE_AUTOSAVE_MAX_WAIT_MS - elapsed)

        const timer = setTimeout(() => {
            noteSaveTimersRef.current.delete(noteId)
            flushNoteRef.current(noteId)
        }, delay)
        noteSaveTimersRef.current.set(noteId, { timer, firstEditAt })
    }, [patchNote, setSaveState])

    const deleteNote = useCallback(async (noteId) => {
        clearNoteTimer(noteId)
        const removed = notesByIdRef.current[noteId]
        if (!removed) return false
        // A note whose POST is still out has a server copy on the way that this
        // cannot delete yet. Remove the draft immediately and let createNote
        // delete the assigned server id as soon as it arrives.
        if (removed.pending) {
            invalidateLoad()
            dirtyNotesRef.current.delete(noteId)
            pendingCreateDeletesRef.current.add(noteId)
            setNotesById((prev) => {
                if (!(noteId in prev)) return prev
                const next = { ...prev }
                delete next[noteId]
                return next
            })
            forgetNote(noteId)
            return true
        }

        invalidateLoad()
        dirtyNotesRef.current.delete(noteId)
        noteVersionsRef.current.delete(noteId)
        deletingNotesRef.current.add(noteId)

        setNotesById((prev) => {
            if (!(noteId in prev)) return prev
            const next = { ...prev }
            delete next[noteId]
            return next
        })

        try {
            const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
            if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`)
            forgetNote(noteId)
            return true
        } catch {
            setNotesById((prev) => ({ ...prev, [noteId]: removed }))
            setSaveState(noteId, 'fail')
            return false
        } finally {
            deletingNotesRef.current.delete(noteId)
        }
    }, [clearNoteTimer, forgetNote, invalidateLoad, setSaveState])

    const deleteNotes = useCallback(async (noteIds) => {
        const ids = [...new Set((Array.isArray(noteIds) ? noteIds : [])
            .map((noteId) => String(noteId || '').trim())
            .filter(Boolean))]
        const removed = Object.fromEntries(ids
            .map((noteId) => [noteId, notesByIdRef.current[noteId]])
            .filter(([, note]) => note && !note.pending))
        const deletableIds = Object.keys(removed)
        if (deletableIds.length === 0) return false
        const dirtyBeforeDelete = new Set(deletableIds.filter((noteId) => dirtyNotesRef.current.has(noteId)))
        const versionsBeforeDelete = new Map(deletableIds.map((noteId) => [noteId, noteVersionsRef.current.get(noteId)]))

        invalidateLoad()
        for (const noteId of deletableIds) {
            clearNoteTimer(noteId)
            clearSettleTimer(noteId)
            dirtyNotesRef.current.delete(noteId)
            noteVersionsRef.current.delete(noteId)
            deletingNotesRef.current.add(noteId)
        }
        setNotesById((prev) => {
            const next = { ...prev }
            for (const noteId of deletableIds) delete next[noteId]
            return next
        })

        try {
            const res = await fetch(`${API_BASE}/api/notes/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note_ids: deletableIds }),
            })
            if (!res.ok) throw new Error(`Bulk delete failed (${res.status})`)
            for (const noteId of deletableIds) forgetNote(noteId)
            return true
        } catch {
            setNotesById((prev) => ({ ...removed, ...prev }))
            for (const noteId of deletableIds) {
                if (dirtyBeforeDelete.has(noteId)) dirtyNotesRef.current.add(noteId)
                const version = versionsBeforeDelete.get(noteId)
                if (version) noteVersionsRef.current.set(noteId, version)
                setSaveState(noteId, 'fail')
            }
            return false
        } finally {
            for (const noteId of deletableIds) deletingNotesRef.current.delete(noteId)
        }
    }, [clearNoteTimer, clearSettleTimer, forgetNote, invalidateLoad, setSaveState])

    const setNoteArchived = useCallback(async (noteId, archived) => {
        const original = notesByIdRef.current[noteId]
        if (!original || original.pending) return false

        // Archive only after the latest prose has landed. Otherwise its stamp
        // could advance underneath a dirty edit and manufacture a conflict.
        const pendingWrite = flushNote(noteId)
        if (pendingWrite) await pendingWrite
        if (dirtyNotesRef.current.has(noteId)) return false
        const beforeArchive = notesByIdRef.current[noteId] || original

        invalidateLoad()
        archivingNotesRef.current.add(noteId)
        const optimisticArchivedAt = archived ? new Date().toISOString() : ''
        patchNote(noteId, { archived: Boolean(archived), archivedAt: optimisticArchivedAt })
        try {
            const res = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(noteId)}/archive`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: Boolean(archived) }),
            })
            if (!res.ok) throw new Error(`Archive failed (${res.status})`)
            const saved = normalizeNote(await res.json())
            if (!saved) throw new Error('Archive returned nothing usable')
            noteVersionsRef.current.set(noteId, saved.updatedAt)
            patchNote(noteId, {
                archived: saved.archived,
                archivedAt: saved.archivedAt,
                updatedAt: saved.updatedAt,
            })
            return true
        } catch {
            patchNote(noteId, {
                archived: beforeArchive.archived,
                archivedAt: beforeArchive.archivedAt,
                updatedAt: noteVersionsRef.current.get(noteId) || beforeArchive.updatedAt,
            })
            setSaveState(noteId, 'fail')
            return false
        } finally {
            archivingNotesRef.current.delete(noteId)
        }
    }, [flushNote, invalidateLoad, patchNote, setSaveState])

    /**
     * Start a note and return immediately.
     *
     * Deliberately not `async`: the caller opens its editor on the id this hands
     * back, on the same tick, so a new note is somewhere to type rather than a
     * wait. `done` resolves to the server's id, or '' if the create failed — it
     * never rejects, so an unawaited call cannot raise.
     */
    const createNote = useCallback((target, {
        onIdAssigned = null,
        title = '',
        body = '',
        tags = [],
        status = 'backlog',
        priority = 'medium',
        completed = false,
        todoOrder = 0,
    } = {}) => {
        tmpNoteCounterRef.current += 1
        const tempId = makeTempNoteId(tmpNoteCounterRef.current)
        const now = new Date().toISOString()
        const normalizedTags = normalizeNoteTags(tags)
        const draft = {
            id: tempId,
            title,
            body,
            tags: normalizedTags,
            tagsUpdatedAt: normalizedTags.length > 0 ? now : '',
            createdAt: now,
            updatedAt: now,
            archived: false,
            archivedAt: '',
            status,
            priority,
            completed,
            completedAt: completed ? now : '',
            todoOrder,
            target,
            pending: true,
        }

        // Before the optimistic insert, not after: a load still in flight would
        // otherwise settle on top of the draft and drop it.
        invalidateLoad()
        setNotesById((prev) => ({ ...prev, [tempId]: draft }))

        const done = (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/notes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        target,
                        title,
                        body,
                        tags: normalizedTags,
                        status,
                        priority,
                        completed,
                        todo_order: todoOrder,
                    }),
                })
                if (!res.ok) throw new Error(`Create failed (${res.status})`)
                const created = normalizeNote(await res.json())
                if (!created) throw new Error('Create returned nothing usable')

                if (pendingCreateDeletesRef.current.delete(tempId)) {
                    const deleteRes = await fetch(`${API_BASE}/api/notes/${encodeURIComponent(created.id)}`, { method: 'DELETE' })
                    if (!deleteRes.ok && deleteRes.status !== 404) {
                        // Keep a failed deletion visible and retryable rather than
                        // hiding a server record the user still owns.
                        setNotesById((prev) => ({ ...prev, [created.id]: { ...created, pending: false } }))
                        noteVersionsRef.current.set(created.id, created.updatedAt)
                        setSaveState(created.id, 'fail')
                        onIdAssigned?.(tempId, created.id)
                        return created.id
                    }
                    dirtyNotesRef.current.delete(tempId)
                    clearNoteTimer(tempId)
                    forgetNote(tempId)
                    onIdAssigned?.(tempId, '')
                    return ''
                }

                setNotesById((prev) => {
                    const local = prev[tempId]
                    if (!local) return prev
                    const next = { ...prev }
                    delete next[tempId]
                    // Whatever was typed while the POST was out stays on the note —
                    // only the id and the server's stamps come from the response.
                    next[created.id] = {
                        ...local,
                        id: created.id,
                        createdAt: created.createdAt,
                        updatedAt: created.updatedAt,
                        tagsUpdatedAt: created.tagsUpdatedAt,
                        target: created.target,
                        pending: false,
                    }
                    return next
                })
                noteVersionsRef.current.set(created.id, created.updatedAt)

                // Anything typed during the round trip was marked dirty against
                // the temp id, which no longer exists. Carry it over and write it.
                if (dirtyNotesRef.current.delete(tempId)) {
                    dirtyNotesRef.current.add(created.id)
                    clearNoteTimer(tempId)
                    flushNoteRef.current(created.id)
                }
                forgetNote(tempId)
                onIdAssigned?.(tempId, created.id)
                return created.id
            } catch {
                pendingCreateDeletesRef.current.delete(tempId)
                dirtyNotesRef.current.delete(tempId)
                clearNoteTimer(tempId)
                setNotesById((prev) => {
                    if (!(tempId in prev)) return prev
                    const next = { ...prev }
                    delete next[tempId]
                    return next
                })
                onIdAssigned?.(tempId, '')
                return ''
            }
        })()

        return { tempId, done }
    }, [clearNoteTimer, forgetNote, invalidateLoad, setSaveState])

    /** Drop a note nobody ever typed into, rather than filing an empty record. */
    const discardIfBlank = useCallback((noteId) => {
        const note = notesByIdRef.current[noteId]
        if (!note || !noteIsBlank(note)) return false
        deleteNote(noteId)
        return true
    }, [deleteNote])

    /**
     * Save on the way out of a note.
     *
     * Distinct from `flushNote`, which writes and nothing else: this is what a
     * reader leaving a note means, so a note they never typed into is discarded
     * rather than filed empty.
     */
    const saveNote = useCallback((noteId, { force = false } = {}) => {
        if (!noteId) return
        if (discardIfBlank(noteId)) return
        flushNote(noteId, { force })
    }, [discardIfBlank, flushNote])

    /**
     * Re-read the store.
     *
     * With a note id this is the conflict panel's "Load theirs": that edit is
     * being given up deliberately, so its unsaved flag and its stale token go
     * with it — and because they go *before* the fetch, the merge naturally takes
     * the server's copy for that one note while protecting every other edit in
     * flight.
     */
    const reload = useCallback(({ noteId = '' } = {}) => {
        if (noteId) {
            clearNoteTimer(noteId)
            dirtyNotesRef.current.delete(noteId)
            noteVersionsRef.current.delete(noteId)
            forgetNote(noteId)
        }
        setReloadEpoch((value) => value + 1)
    }, [clearNoteTimer, forgetNote])

    // --- Leaving the page ---------------------------------------------------

    // The app can be closed inside the debounce. `keepalive` because the request
    // has to outlive the page, and `fetch` rather than `sendBeacon` because this
    // is a PUT that needs the API token header the runtime shim attaches.
    useEffect(() => {
        const flushPendingNotes = () => {
            for (const note of pendingUnloadWrites(dirtyNotesRef.current, notesByIdRef.current)) {
                try {
                    fetch(`${API_BASE}/api/notes/${encodeURIComponent(note.id)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: note.title,
                            body: note.body,
                            tags: note.tags,
                            status: note.status,
                            priority: note.priority,
                            completed: note.completed,
                            todo_order: note.todoOrder,
                        }),
                        keepalive: true,
                    }).catch(() => {})
                } catch {
                    // Nothing left to fall back on at this point.
                }
            }
        }
        window.addEventListener('pagehide', flushPendingNotes)
        window.addEventListener('beforeunload', flushPendingNotes)
        return () => {
            window.removeEventListener('pagehide', flushPendingNotes)
            window.removeEventListener('beforeunload', flushPendingNotes)
        }
    }, [])

    useEffect(() => {
        const saveTimers = noteSaveTimersRef.current
        const settleTimers = settleTimersRef.current
        return () => {
            for (const pending of saveTimers.values()) {
                if (pending?.timer) clearTimeout(pending.timer)
            }
            saveTimers.clear()
            for (const timer of settleTimers.values()) clearTimeout(timer)
            settleTimers.clear()
        }
    }, [])

    // --- Selectors ----------------------------------------------------------

    const allNotes = useMemo(() => Object.values(notesById), [notesById])
    const notes = useMemo(() => allNotes.filter((note) => !note.archived), [allNotes])
    const archivedNotes = useMemo(() => allNotes.filter((note) => note.archived), [allNotes])
    const byTargetKey = useMemo(() => groupByTargetKey(notes), [notes])

    /**
     * Which notes exist and where, ignoring what they say.
     *
     * The canvas memoizes its whole bubble overlay on the count map, so a map
     * rebuilt on every keystroke would re-lay-out every bubble as the reader
     * types. Keying the memo on this signature means the map only changes when a
     * note is created, deleted or re-targeted — which is exactly when a bubble
     * can change.
     */
    const targetSignature = useMemo(() => {
        const keys = []
        for (const note of notes) {
            const key = noteTargetKey(note?.target?.kind, note?.target?.genome_key, note?.target?.id)
            if (key) keys.push(key)
        }
        return keys.sort().join('|')
    }, [notes])

    const notesForSignature = useRef(notes)
    notesForSignature.current = notes
    const countsByGenome = useMemo(() => {
        const cache = new Map()
        const snapshot = notesForSignature.current
        return (genomeKey) => {
            const key = String(genomeKey || '')
            if (!key) return EMPTY_COUNTS
            if (!cache.has(key)) cache.set(key, geneNoteCountsForGenome(snapshot, key))
            return cache.get(key)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetSignature])

    const notesForGene = useCallback(
        (genomeKey, geneId) => byTargetKey[geneNoteTargetKey(genomeKey, geneId)] || EMPTY_NOTES,
        [byTargetKey]
    )

    const saveStateFor = useCallback(
        (noteId) => saveStateById[noteId] || NOTE_SAVE_STATES.IDLE,
        [saveStateById]
    )

    const value = useMemo(() => ({
        notes,
        archivedNotes,
        notesById,
        notesByTargetKey: byTargetKey,
        status,
        error,
        notesForGene,
        geneNoteCountsForGenome: countsByGenome,
        saveStateFor,
        createNote,
        updateNoteFields,
        flushNote,
        saveNote,
        deleteNote,
        deleteNotes,
        setNoteArchived,
        discardIfBlank,
        reload,
    }), [notes, archivedNotes, notesById, byTargetKey, status, error, notesForGene, countsByGenome, saveStateFor,
        createNote, updateNoteFields, flushNote, saveNote, deleteNote, deleteNotes, setNoteArchived, discardIfBlank, reload])

    return <NoteStoreContext.Provider value={value}>{children}</NoteStoreContext.Provider>
}

export default function useNoteStore() {
    const store = useContext(NoteStoreContext)
    // Loud on purpose. A second provider, or a consumer mounted outside the one
    // there is, would give that consumer its own copy of the unsaved set and the
    // token cache — and the two would then conflict over the same note.
    if (!store) throw new Error('useNoteStore must be used inside a NoteStoreProvider')
    return store
}

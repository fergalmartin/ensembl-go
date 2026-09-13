import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import NoteGlyph from './NoteGlyph'
import { FOCUS_DETAIL_WIDTH } from './FocusTranscriptDetail'
import useSaveOnLeaveNote from '../hooks/useSaveOnLeaveNote'
import {
    DEFAULT_NOTE_SORT_MODE,
    NOTE_SAVE_STATES,
    NOTE_SORT_MODES,
    noteDisplayTitle,
    noteIsBlank,
    notePreview,
    noteTimestampLabel,
    saveIndicatorLabel,
    sortNotes,
} from '../utils/geneNotes'

// The same width as the transcript detail, and taken from it rather than
// restated: the drawer has one wide slot with two possible occupants, and
// declaring 540 twice is how that stops being true.
export const FOCUS_NOTES_WIDTH = FOCUS_DETAIL_WIDTH

/** How long "Confirm delete" stands before the button goes back to asking. */
const DELETE_CONFIRM_MS = 4000

function CloseGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    )
}

function BackGlyph({ size = 15 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 6 9 12 15 18" />
        </svg>
    )
}

function TrashGlyph({ size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
        </svg>
    )
}

function PlusGlyph({ size = 14 }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

/**
 * The gene's notes, opened beside the transcript list.
 *
 * An inbox on a narrow pane, so it is a list that pushes to a reader rather
 * than two columns side by side — 540px will not carry both and still leave
 * room to write in.
 */
export default function FocusNotesPanel({
    theme = 'dark',
    gene = null,
    // What these notes are about, when it is not a gene. The panel is the same
    // inbox either way — only what it calls its subject changes — so the
    // location drawer reuses it rather than growing a second copy.
    subjectLabel = '',
    subjectNoun = 'gene',
    subjectKey = '',
    notes = [],
    status = 'ready',
    error = '',
    notesEnabled = true,
    openNoteId = '',
    onOpenNoteChange = null,
    sortMode = DEFAULT_NOTE_SORT_MODE,
    onSortChange = null,
    saveState = NOTE_SAVE_STATES.IDLE,
    onCreate = null,
    onFieldChange = null,
    onSave = null,
    onDelete = null,
    onRetryLoad = null,
    onClose = null,
}) {
    const isLight = theme === 'light'
    const [confirmingDeleteId, setConfirmingDeleteId] = useState('')
    const confirmTimerRef = useRef(null)
    const bodyRef = useRef(null)

    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const dividerColor = isLight ? '#e5e7eb' : '#374151'
    const accentColor = isLight ? '#0099ff' : '#4c9aff'
    const rowHoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const dangerColor = isLight ? '#dc2626' : '#f87171'
    const cardBg = isLight ? '#f8fafc' : '#161d29'

    const geneLabel = subjectLabel || gene?.name || gene?.id || ''
    const ordered = useMemo(() => sortNotes(notes, sortMode), [notes, sortMode])
    const openNote = useMemo(
        // A delete can land between the state update and this render; falling
        // back to the list beats binding an editor to nothing.
        () => notes.find((note) => note.id === openNoteId) || null,
        [notes, openNoteId]
    )

    const clearConfirmTimer = useCallback(() => {
        if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current)
            confirmTimerRef.current = null
        }
    }, [])

    useEffect(() => clearConfirmTimer, [clearConfirmTimer])

    // Two-step rather than window.confirm: Electron renders that as a native
    // modal that takes focus off the app, which for a delete inside a side panel
    // is a much bigger interruption than the action warrants.
    const armDelete = useCallback((noteId) => {
        clearConfirmTimer()
        setConfirmingDeleteId(noteId)
        confirmTimerRef.current = setTimeout(() => {
            confirmTimerRef.current = null
            setConfirmingDeleteId('')
        }, DELETE_CONFIRM_MS)
    }, [clearConfirmTimer])

    const handleDelete = useCallback((noteId) => {
        const note = notes.find((candidate) => candidate.id === noteId)
        if (noteIsBlank(note)) {
            clearConfirmTimer()
            setConfirmingDeleteId('')
            onDelete?.(noteId)
            return
        }
        if (confirmingDeleteId !== noteId) {
            armDelete(noteId)
            return
        }
        clearConfirmTimer()
        setConfirmingDeleteId('')
        onDelete?.(noteId)
    }, [notes, confirmingDeleteId, armDelete, clearConfirmTimer, onDelete])

    // Shared with the Notes view rather than written out here, so neither can
    // lose the temp-id guard the hook exists for.
    useSaveOnLeaveNote(openNoteId, onSave)

    // Opening a note puts the cursor at the end of it. The reason to open one is
    // almost always to add to it, and a panel that makes you click once more
    // before you can type is charging for the privilege.
    //
    // Keyed on the id alone: re-running this per keystroke would drag the caret
    // back to the end every time the reader edited anything but the last line.
    const openNoteKey = openNote?.id || ''
    useEffect(() => {
        const node = bodyRef.current
        if (!openNoteKey || !node) return
        node.focus()
        const end = node.value.length
        try {
            node.setSelectionRange(end, end)
        } catch {
            // Some browsers refuse this on a hidden field; the focus still lands.
        }
    }, [openNoteKey])

    const handleKeyDown = useCallback((event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            onSave?.(openNoteId)
            return
        }
        if (event.key === 'Escape') {
            // Stopped here so Escape means "leave this note", not whatever it
            // means to the browser behind the drawer.
            event.stopPropagation()
            onOpenNoteChange?.('')
        }
    }, [openNoteId, onSave, onOpenNoteChange])

    const headerButton = `flex-none flex items-center justify-center rounded transition-colors ${rowHoverClass}`

    const handleClose = useCallback(() => {
        onOpenNoteChange?.('')
        onClose?.()
    }, [onOpenNoteChange, onClose])

    const closeButton = (
        <button
            type="button"
            onClick={handleClose}
            className={`${headerButton} p-1`}
            style={{ color: accentColor }}
            title="Close notes"
            aria-label="Close notes"
        >
            <CloseGlyph />
        </button>
    )

    const newNoteButton = notesEnabled ? (
        <button
            type="button"
            onClick={() => onCreate?.()}
            className="flex-none inline-flex items-center gap-1 h-6 px-2 text-[11px] font-semibold rounded-full transition-opacity hover:opacity-85"
            style={{ backgroundColor: accentColor, color: '#ffffff' }}
            title="Add a note"
        >
            <PlusGlyph size={12} />
            New note
        </button>
    ) : null

    // ── Editor ──────────────────────────────────────────────────────────────

    if (openNote) {
        const indicator = saveIndicatorLabel(saveState)
        const canSave = saveState === NOTE_SAVE_STATES.DIRTY
            || saveState === NOTE_SAVE_STATES.ERROR
            || saveState === NOTE_SAVE_STATES.CONFLICT
        const indicatorColor = (saveState === NOTE_SAVE_STATES.ERROR || saveState === NOTE_SAVE_STATES.CONFLICT)
            ? dangerColor
            : undefined
        const confirming = confirmingDeleteId === openNote.id

        return (
            <div
                className="flex flex-col h-full min-h-0 overflow-hidden border-l"
                style={{ width: FOCUS_NOTES_WIDTH, borderColor: dividerColor }}
                data-focus-notes-panel={subjectKey || gene?.id || ''}
            >
                <div className="flex-none flex items-center gap-2 px-2 py-1.5 border-b" style={{ borderColor: dividerColor }}>
                    <button
                        type="button"
                        onClick={() => onOpenNoteChange?.('')}
                        className={`${headerButton} gap-1 pl-0.5 pr-1.5 py-1 text-[11px]`}
                        style={{ color: accentColor }}
                        title="Back to all notes"
                    >
                        <BackGlyph />
                        All notes
                    </button>
                    <span className={`min-w-0 truncate text-[11px] ${subTextClass}`}>
                        {noteTimestampLabel(openNote.updatedAt) || noteTimestampLabel(openNote.createdAt)}
                    </span>
                    <span
                        className="ml-auto flex-none text-[10px]"
                        style={{ color: indicatorColor }}
                        aria-live="polite"
                    >
                        {indicator}
                    </span>
                    <button
                        type="button"
                        data-tour-id="focus-note-save"
                        // In conflict this button is "Keep mine", so it has to
                        // overwrite rather than offer the same stamp the server
                        // already refused.
                        onClick={() => onSave?.(openNote.id, { force: saveState === NOTE_SAVE_STATES.CONFLICT })}
                        disabled={!canSave}
                        className={`flex-none h-6 px-2 text-[11px] font-semibold rounded transition-opacity ${canSave ? 'hover:opacity-85' : 'opacity-40 cursor-default'}`}
                        style={{ backgroundColor: canSave ? accentColor : 'transparent', color: canSave ? '#ffffff' : undefined }}
                        title={saveState === NOTE_SAVE_STATES.CONFLICT
                            ? 'Overwrite the other copy with what is here'
                            : 'Save now'}
                    >
                        {saveState === NOTE_SAVE_STATES.CONFLICT ? 'Keep mine' : 'Save'}
                    </button>
                    <button
                        type="button"
                        onClick={() => handleDelete(openNote.id)}
                        className={`${headerButton} px-1.5 py-1 text-[11px]`}
                        style={{ color: dangerColor }}
                        title={confirming ? 'Delete this note for good' : 'Delete this note'}
                    >
                        {confirming ? 'Confirm delete' : <TrashGlyph />}
                    </button>
                    {closeButton}
                </div>

                {saveState === NOTE_SAVE_STATES.CONFLICT && (
                    <div className={`flex-none flex items-center gap-2 px-3 py-1.5 text-[11px] ${textClass}`} style={{ backgroundColor: cardBg }}>
                        <span className="min-w-0">This note changed somewhere else since you opened it.</span>
                        <button
                            type="button"
                            // Named so the reload knows this edit is being given
                            // up on purpose, rather than being a retry that
                            // should keep it.
                            onClick={() => onRetryLoad?.(openNote.id)}
                            className="ml-auto flex-none underline underline-offset-2 hover:opacity-85"
                            style={{ color: accentColor }}
                        >
                            Load theirs
                        </button>
                    </div>
                )}

                <input
                    data-tour-id="focus-note-title"
                    type="text"
                    value={openNote.title}
                    onChange={(event) => onFieldChange?.(openNote.id, { title: event.target.value })}
                    onKeyDown={handleKeyDown}
                    placeholder="Title (optional)"
                    maxLength={200}
                    className={`flex-none w-full px-3 pt-2.5 pb-1 text-[12px] font-semibold bg-transparent outline-none ${textClass}`}
                />

                {/* Reading and editing are the same thing here. A textarea that
                    looks like prose is already the reader, and making someone
                    click "Edit" before they can add a line to their own note is
                    a tax on the one action this panel exists for. */}
                <textarea
                    data-tour-id="focus-note-body"
                    ref={bodyRef}
                    value={openNote.body}
                    onChange={(event) => onFieldChange?.(openNote.id, { body: event.target.value })}
                    onKeyDown={handleKeyDown}
                    placeholder={`Write anything about this ${subjectNoun}…`}
                    spellCheck
                    className={`flex-1 min-h-0 w-full resize-none bg-transparent outline-none themed-scrollbar px-3 pb-3 text-[12px] leading-[1.55] ${textClass}`}
                />
            </div>
        )
    }

    // ── List ────────────────────────────────────────────────────────────────

    return (
        <div
            className="flex flex-col h-full min-h-0 overflow-hidden border-l"
            style={{ width: FOCUS_NOTES_WIDTH, borderColor: dividerColor }}
            data-focus-notes-panel={subjectKey || gene?.id || ''}
        >
            <div className="flex-none flex items-center gap-2 px-2 py-1.5 border-b" style={{ borderColor: dividerColor }}>
                <span className={`flex-none inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase ${subTextClass}`}>
                    <NoteGlyph size={13} filled={notes.length > 0} knockout={isLight ? '#ffffff' : '#1E2938'} />
                    Notes
                </span>
                <span className={`min-w-0 truncate text-[11px] ${textClass}`}>{geneLabel}</span>
                {notes.length > 0 && (
                    <span className={`flex-none text-[10px] ${subTextClass}`}>
                        {notes.length}
                    </span>
                )}
                <div className="flex-1" />
                {notes.length > 1 && (
                    <select
                        value={sortMode}
                        onChange={(event) => onSortChange?.(event.target.value)}
                        className={`flex-none h-6 text-[11px] rounded border bg-transparent px-1 ${subTextClass}`}
                        style={{ borderColor: dividerColor }}
                        title="Order these notes"
                        aria-label="Sort notes"
                    >
                        {NOTE_SORT_MODES.map((mode) => (
                            <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                    </select>
                )}
                {newNoteButton}
                {closeButton}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto themed-scrollbar px-2 py-2 flex flex-col gap-1.5">
                {status === 'loading' && notes.length === 0 && (
                    <div className={`px-1 py-2 text-[11px] ${subTextClass}`}>Loading notes…</div>
                )}

                {status === 'error' && (
                    <div className={`px-1 py-2 text-[11px] ${subTextClass}`}>
                        <span style={{ color: dangerColor }}>{error || "Couldn't load notes."}</span>
                        <button
                            type="button"
                            onClick={() => onRetryLoad?.()}
                            className="ml-2 underline underline-offset-2 hover:opacity-85"
                            style={{ color: accentColor }}
                        >
                            Retry
                        </button>
                    </div>
                )}

                {status === 'ready' && notes.length === 0 && (
                    <div className={`px-1 py-3 flex flex-col items-start gap-2 text-[11px] ${subTextClass}`}>
                        <span>
                            No notes for {geneLabel || `this ${subjectNoun}`} yet.
                            {/* Said once, here, because the alternative is a tester
                                deciding notes are broken when the same gene in
                                another assembly comes up empty. */}
                            <br />Notes are kept per assembly, so this {subjectNoun} in another genome has its own.
                        </span>
                        {newNoteButton}
                    </div>
                )}

                {ordered.map((note) => {
                    const confirming = confirmingDeleteId === note.id
                    const preview = notePreview(note)
                    return (
                        <div
                            key={note.id}
                            className={`group relative rounded border transition-colors ${rowHoverClass}`}
                            style={{ borderColor: dividerColor, backgroundColor: cardBg }}
                        >
                            <button
                                type="button"
                                onClick={() => onOpenNoteChange?.(note.id)}
                                className="w-full text-left px-2.5 py-2 pr-8"
                                title="Open this note"
                            >
                                <span className={`block text-[12px] font-semibold truncate ${textClass}`}>
                                    {noteDisplayTitle(note)}
                                </span>
                                {preview && (
                                    <span
                                        className={`block mt-0.5 text-[11px] leading-[1.45] ${subTextClass}`}
                                        // No line-clamp utility is configured in
                                        // this project, so the two-line clamp is
                                        // spelled out rather than assumed.
                                        style={{
                                            display: '-webkit-box',
                                            WebkitLineClamp: 2,
                                            WebkitBoxOrient: 'vertical',
                                            overflow: 'hidden',
                                        }}
                                    >
                                        {preview}
                                    </span>
                                )}
                                <span className={`block mt-1 text-[10px] ${subTextClass}`}>
                                    {noteTimestampLabel(note.updatedAt) || noteTimestampLabel(note.createdAt)}
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); handleDelete(note.id) }}
                                className={`absolute top-1.5 right-1.5 flex-none rounded transition-opacity ${confirming ? 'opacity-100 px-1.5 py-0.5 text-[10px] font-semibold' : 'p-1 opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                                style={{ color: dangerColor }}
                                title={confirming ? 'Delete this note for good' : 'Delete this note'}
                            >
                                {confirming ? 'Confirm' : <TrashGlyph />}
                            </button>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

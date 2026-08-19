export const MAX_RECENT_NOTE_ACTIVITY = 10

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const compactLine = (value) => text(value).replace(/\s+/g, ' ')

export function normalizeRecentNoteViews(value) {
    if (!Array.isArray(value)) return []
    const seen = new Set()
    const out = []
    for (const entry of value) {
        const noteId = text(typeof entry === 'string' ? entry : entry?.noteId)
        if (!noteId || seen.has(noteId)) continue
        seen.add(noteId)
        out.push({
            noteId,
            viewedAt: text(typeof entry === 'string' ? '' : entry?.viewedAt),
        })
    }
    return out.slice(0, MAX_RECENT_NOTE_ACTIVITY)
}

export function touchRecentNoteView(current, noteId, viewedAt = new Date().toISOString()) {
    const id = text(noteId)
    if (!id) return normalizeRecentNoteViews(current)
    return [
        { noteId: id, viewedAt: text(viewedAt) },
        ...normalizeRecentNoteViews(current).filter((entry) => entry.noteId !== id),
    ].slice(0, MAX_RECENT_NOTE_ACTIVITY)
}

/** Merge persisted view events with note edit timestamps, newest activity first. */
export function buildRecentNoteActivity(notes, recentViews, limit = MAX_RECENT_NOTE_ACTIVITY) {
    const viewedAtById = new Map(normalizeRecentNoteViews(recentViews)
        .map((entry) => [entry.noteId, entry.viewedAt]))
    return (Array.isArray(notes) ? notes : [])
        .filter((note) => note?.id && !note?.pending)
        .map((note) => ({
            note,
            activityAt: [viewedAtById.get(note.id), note.updatedAt, note.createdAt]
                .filter(Boolean)
                .sort()
                .at(-1) || '',
        }))
        .sort((left, right) => right.activityAt.localeCompare(left.activityAt)
            || String(left.note.id).localeCompare(String(right.note.id)))
        .slice(0, Math.max(0, Number(limit) || 0))
}

/** The most recently opened surviving note or task. */
export function buildLastViewedActivity(notes, recentViews) {
    const notesById = new Map((Array.isArray(notes) ? notes : [])
        .filter((note) => note?.id && !note?.pending)
        .map((note) => [note.id, note]))
    for (const view of normalizeRecentNoteViews(recentViews)
        .slice()
        .sort((left, right) => right.viewedAt.localeCompare(left.viewedAt))) {
        const note = notesById.get(view.noteId)
        if (note) return [{ note, activityAt: view.viewedAt }]
    }
    return []
}

/** The note or task whose stored content/workflow metadata changed last. */
export function buildLastEditedActivity(notes) {
    const latest = (Array.isArray(notes) ? notes : [])
        .filter((note) => note?.id && !note?.pending)
        .map((note) => ({ note, activityAt: note.updatedAt || note.createdAt || '' }))
        .sort((left, right) => right.activityAt.localeCompare(left.activityAt)
            || String(left.note.id).localeCompare(String(right.note.id)))[0]
    return latest ? [latest] : []
}

/** One compact second line for a Recent activity row. */
export function recentNotePreview(note) {
    const body = compactLine(note?.body)
    if (note?.target?.kind === 'todo') return body
    const title = compactLine(note?.title)
    if (title && body && title !== body) return `${title} — ${body}`
    return title || body || 'Untitled note'
}

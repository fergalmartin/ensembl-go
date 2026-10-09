// The Notes view's model: panel modes, todo labels and status colours, and the
// recently viewed notes kept in local storage.
import { normalizeRecentNoteViews } from '../../utils/recentNoteActivity.js'

export const IDLE_PANEL_MODES = [
    { id: 'recent', label: 'Recent activity', description: 'Last ten viewed or edited items' },
    { id: 'viewed', label: 'Last viewed', description: 'Most recently opened note or task' },
    { id: 'edited', label: 'Last edited', description: 'Most recently changed note or task' },
    { id: 'tags', label: 'Tags', description: 'Browse and filter reusable tags' },
]

export const todoLabel = (items, value) => items.find((item) => item.id === value)?.label || value

export const statusDotColor = (status) => ({
    backlog: '#94a3b8',
    next: '#38bdf8',
    in_progress: '#3b82f6',
    waiting: '#14b8a6',
    blocked: '#64748b',
    completed: '#22c55e',
    abandoned: '#a1a1aa',
}[status] || '#94a3b8')

export const priorityDotColor = (priority) => ({
    low: '#eab308',
    medium: '#f97316',
    high: '#ef4444',
}[priority] || '#eab308')

/** How long "Confirm" stands before a delete button goes back to asking. */
export const DELETE_CONFIRM_MS = 4000

export const RECENT_NOTE_VIEWS_STORAGE_KEY = 'ensembl-go-notes-recent-views-v1'

export function loadRecentNoteViews() {
    if (typeof window === 'undefined') return []
    try {
        return normalizeRecentNoteViews(JSON.parse(window.localStorage.getItem(RECENT_NOTE_VIEWS_STORAGE_KEY) || '[]'))
    } catch {
        return []
    }
}

export const TODO_STATUSES = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'next', label: 'Next' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'waiting', label: 'Waiting' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'completed', label: 'Completed' },
    { id: 'abandoned', label: 'Abandoned' },
]

export const TODO_PRIORITIES = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
]

export const TODO_SORT_MODES = [
    { id: 'manual', label: 'Manual order' },
    { id: 'priority', label: 'Priority' },
    { id: 'status', label: 'Status' },
    { id: 'updated', label: 'Recently edited' },
]

const text = (value) => (typeof value === 'string' ? value : (value == null ? '' : String(value)))
const statusRank = new Map(TODO_STATUSES.map((item, index) => [item.id, index]))
const priorityRank = new Map(TODO_PRIORITIES.map((item, index) => [item.id, index]))

/** Stable task ordering for each of the Todo box's sort modes. */
export function sortTodos(notes, mode = 'manual') {
    const list = Array.isArray(notes) ? notes.slice() : []
    const byId = (a, b) => text(a?.id).localeCompare(text(b?.id))
    const byTitle = (a, b) => text(a?.title).localeCompare(text(b?.title), undefined, { sensitivity: 'base' }) || byId(a, b)
    const byManual = (a, b) => (Number(a?.todoOrder) - Number(b?.todoOrder)) || byTitle(a, b)
    const comparators = {
        manual: byManual,
        priority: (a, b) => (
            (priorityRank.get(text(b?.priority)) ?? 1) - (priorityRank.get(text(a?.priority)) ?? 1)
        ) || byManual(a, b),
        status: (a, b) => (
            (statusRank.get(text(a?.status)) ?? 0) - (statusRank.get(text(b?.status)) ?? 0)
        ) || byManual(a, b),
        updated: (a, b) => text(b?.updatedAt).localeCompare(text(a?.updatedAt)) || byId(a, b),
    }
    return list.sort(comparators[mode] || comparators.manual)
}

/** Move one task before another and assign comfortably spaced persisted ranks. */
export function reorderTodos(notes, draggedId, targetId) {
    const list = sortTodos(notes, 'manual')
    const from = list.findIndex((note) => note?.id === draggedId)
    const to = list.findIndex((note) => note?.id === targetId)
    if (from < 0 || to < 0 || from === to) return list.map((note) => ({ note, todoOrder: Number(note?.todoOrder) || 0 }))
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    return list.map((note, index) => ({ note, todoOrder: (index + 1) * 1024 }))
}

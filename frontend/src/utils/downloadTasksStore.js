// One poll of /api/remote/tasks shared by everything that shows download state:
// the app-level refresh, the Downloads view, both Active downloads panels and the
// top-bar Active tasks button. Polls only while something is subscribed.

import { useSyncExternalStore } from 'react'
import { API_BASE } from '../backendRuntime'

const POLL_INTERVAL_MS = 2000
const EMPTY_TASKS = Object.freeze([])

let tasks = EMPTY_TASKS
let tasksSignature = '[]'
let timer = null
let inFlight = null
// Bumped by a local change (a cancel) so a poll that set off before it cannot
// paint the old statuses back.
let generation = 0
const listeners = new Set()

function emit() {
    for (const listener of listeners) listener()
}

async function fetchTasks() {
    if (inFlight) return inFlight
    const startedAt = generation
    inFlight = (async () => {
        try {
            const res = await fetch(`${API_BASE}/api/remote/tasks`)
            if (!res.ok) return
            const next = await res.json()
            if (!Array.isArray(next) || startedAt !== generation) return
            // Most polls return the same list. Keep the old array then, so components
            // reading through the hook see an unchanged snapshot and skip rendering,
            // but still notify: direct subscribers re-check state of their own on
            // every poll (App's pending-genome and homology bookkeeping does).
            const signature = JSON.stringify(next)
            if (signature !== tasksSignature) {
                tasksSignature = signature
                tasks = next
            }
            emit()
        } catch {
            // Keep the last list; whoever shows download errors does so from the tasks.
        } finally {
            inFlight = null
        }
    })()
    return inFlight
}

function startPolling() {
    if (timer) return
    void fetchTasks()
    timer = setInterval(fetchTasks, POLL_INTERVAL_MS)
}

function stopPolling() {
    if (!timer) return
    clearInterval(timer)
    timer = null
}

export function subscribeDownloadTasks(listener) {
    listeners.add(listener)
    startPolling()
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopPolling()
    }
}

export function getDownloadTasksSnapshot() {
    return tasks
}

/** Fetch now rather than waiting for the next tick, e.g. straight after a change. */
export function refreshDownloadTasks() {
    return fetchTasks()
}

/**
 * Cancel downloads by task id, or every queued and running one with `all`.
 * Resolves to the ids the backend cancelled.
 */
export async function cancelDownloadTasks({ taskIds = [], all = false } = {}) {
    const res = await fetch(`${API_BASE}/api/remote/tasks/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids: taskIds, all }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.detail || 'Failed to cancel downloads')
    const cancelled = new Set(Array.isArray(data?.task_ids) ? data.task_ids : [])
    if (cancelled.size > 0) {
        // Show the cancel at once; the refresh below confirms it.
        tasks = tasks.map((task) => (
            cancelled.has(task.id)
                ? { ...task, status: 'canceled', progress: 0, error: null, cancel_requested: true }
                : task
        ))
        tasksSignature = ''
        generation += 1
        emit()
    }
    if (inFlight) await inFlight
    void fetchTasks()
    return Array.from(cancelled)
}

export function useDownloadTasks() {
    return useSyncExternalStore(subscribeDownloadTasks, getDownloadTasksSnapshot, getDownloadTasksSnapshot)
}

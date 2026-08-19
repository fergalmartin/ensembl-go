import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildRecentNoteActivity,
    buildLastEditedActivity,
    buildLastViewedActivity,
    normalizeRecentNoteViews,
    recentNotePreview,
    touchRecentNoteView,
} from '../src/utils/recentNoteActivity.js'

const note = (id, updatedAt, rest = {}) => ({
    id,
    title: '',
    body: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    target: { kind: 'gene' },
    ...rest,
})

test('a view event moves an item to the front without duplicating it', () => {
    const current = [
        { noteId: 'a', viewedAt: '2026-01-02T00:00:00Z' },
        { noteId: 'b', viewedAt: '2026-01-01T00:00:00Z' },
    ]
    assert.deepEqual(touchRecentNoteView(current, 'b', '2026-01-03T00:00:00Z'), [
        { noteId: 'b', viewedAt: '2026-01-03T00:00:00Z' },
        { noteId: 'a', viewedAt: '2026-01-02T00:00:00Z' },
    ])
})

test('recent activity uses the newer of the edit and view timestamps', () => {
    const notes = [
        note('edited', '2026-01-04T00:00:00Z'),
        note('viewed', '2026-01-02T00:00:00Z'),
    ]
    const activity = buildRecentNoteActivity(notes, [
        { noteId: 'viewed', viewedAt: '2026-01-05T00:00:00Z' },
    ])
    assert.deepEqual(activity.map((entry) => entry.note.id), ['viewed', 'edited'])
})

test('recent activity ignores pending notes and respects its limit', () => {
    const notes = Array.from({ length: 12 }, (_, index) => note(String(index), `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`))
    notes.push(note('pending', '2027-01-01T00:00:00Z', { pending: true }))
    assert.equal(buildRecentNoteActivity(notes, [], 10).length, 10)
    assert.equal(buildRecentNoteActivity(notes, [], 10).some((entry) => entry.note.id === 'pending'), false)
})

test('last viewed and last edited each return one independently filtered item', () => {
    const notes = [
        note('edited', '2026-01-06T00:00:00Z'),
        note('viewed', '2026-01-02T00:00:00Z'),
    ]
    const views = [{ noteId: 'viewed', viewedAt: '2026-01-05T00:00:00Z' }]
    assert.deepEqual(buildLastViewedActivity(notes, views).map((entry) => entry.note.id), ['viewed'])
    assert.deepEqual(buildLastEditedActivity(notes).map((entry) => entry.note.id), ['edited'])
    assert.deepEqual(buildLastViewedActivity(notes, [{ noteId: 'missing', viewedAt: '2027-01-01T00:00:00Z' }]), [])
})

test('recent previews use descriptions for tasks and compact note prose', () => {
    assert.equal(recentNotePreview(note('task', '', { body: '  one\n two  ', target: { kind: 'todo' } })), 'one two')
    assert.equal(recentNotePreview(note('note', '', { title: 'Heading', body: 'Some details' })), 'Heading — Some details')
    assert.equal(recentNotePreview(note('blank', '')), 'Untitled note')
    assert.deepEqual(normalizeRecentNoteViews(null), [])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { reorderTodos, sortTodos } from '../src/utils/todoNotes.js'

const task = (id, patch = {}) => ({
    id,
    title: id,
    todoOrder: 0,
    status: 'backlog',
    priority: 'medium',
    updatedAt: '',
    ...patch,
})

test('todo sorting supports manual, priority, status and recent order', () => {
    const tasks = [
        task('b', { todoOrder: 1024, priority: 'low', status: 'blocked', updatedAt: '2026-01-01' }),
        task('a', { todoOrder: 2048, priority: 'high', status: 'next', updatedAt: '2026-03-01' }),
        task('c', { todoOrder: 3072, priority: 'medium', status: 'in_progress', updatedAt: '2026-02-01' }),
    ]
    assert.deepEqual(sortTodos(tasks, 'manual').map((item) => item.id), ['b', 'a', 'c'])
    assert.deepEqual(sortTodos(tasks, 'priority').map((item) => item.id), ['a', 'c', 'b'])
    assert.deepEqual(sortTodos(tasks, 'status').map((item) => item.id), ['a', 'c', 'b'])
    assert.deepEqual(sortTodos(tasks, 'updated').map((item) => item.id), ['a', 'c', 'b'])
})

test('drag reordering returns spaced persistent ranks without mutating input', () => {
    const tasks = [task('a', { todoOrder: 1024 }), task('b', { todoOrder: 2048 }), task('c', { todoOrder: 3072 })]
    const reordered = reorderTodos(tasks, 'c', 'a')
    assert.deepEqual(reordered.map(({ note }) => note.id), ['c', 'a', 'b'])
    assert.deepEqual(reordered.map(({ todoOrder }) => todoOrder), [1024, 2048, 3072])
    assert.deepEqual(tasks.map((item) => item.id), ['a', 'b', 'c'])
})

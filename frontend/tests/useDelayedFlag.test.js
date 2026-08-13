import assert from 'node:assert/strict'
import test from 'node:test'

import {
    DEFAULT_LOADING_DELAY_MS,
    DEFAULT_MIN_VISIBLE_MS,
    resolveDelayedFlag,
} from '../src/hooks/useDelayedFlag.js'

const at = (over) => resolveDelayedFlag({
    active: false,
    visible: false,
    activeSince: 0,
    visibleSince: 0,
    now: 0,
    ...over,
})

test('a fast load never shows an indicator', () => {
    // The reported problem: panning and zooming refetch constantly, most loads
    // land in tens of milliseconds, and a spinner for each one is noise.
    for (const elapsed of [0, 1, 50, 200, DEFAULT_LOADING_DELAY_MS - 1]) {
        const step = at({ active: true, activeSince: 0, now: elapsed })
        assert.equal(step.visible, false, `showed after only ${elapsed}ms`)
        assert.equal(step.wakeAt, DEFAULT_LOADING_DELAY_MS, 'must schedule its own re-check')
    }
    // Finishing before the threshold leaves nothing to show.
    assert.equal(at({ active: false, visible: false, now: 100 }).visible, false)
})

test('a slow load does show an indicator', () => {
    const step = at({ active: true, activeSince: 0, now: DEFAULT_LOADING_DELAY_MS })
    assert.equal(step.visible, true)
    assert.equal(step.wakeAt, null, 'nothing further to wait for')
})

test('an indicator that appeared stays long enough to be read', () => {
    // Otherwise a load finishing just past the threshold produces a one-frame
    // flash, which reads as a glitch.
    const early = at({ active: false, visible: true, visibleSince: 1000, now: 1000 + DEFAULT_MIN_VISIBLE_MS - 1 })
    assert.equal(early.visible, true)
    assert.equal(early.wakeAt, 1000 + DEFAULT_MIN_VISIBLE_MS)

    const due = at({ active: false, visible: true, visibleSince: 1000, now: 1000 + DEFAULT_MIN_VISIBLE_MS })
    assert.equal(due.visible, false)
    assert.equal(due.wakeAt, null)
})

test('steady states ask for no further work', () => {
    assert.deepEqual(at({ active: false, visible: false }), { visible: false, wakeAt: null })
    assert.deepEqual(
        at({ active: true, visible: true, visibleSince: 0, now: 5_000 }),
        { visible: true, wakeAt: null },
    )
})

test('a load that restarts while the indicator is up keeps it up', () => {
    const step = at({ active: true, visible: true, activeSince: 900, visibleSince: 500, now: 1000 })
    assert.equal(step.visible, true)
    assert.equal(step.wakeAt, null)
})

test('the thresholds are configurable per call site', () => {
    assert.equal(at({ active: true, activeSince: 0, now: 60, delayMs: 50 }).visible, true)
    assert.equal(at({ active: true, activeSince: 0, now: 60, delayMs: 5_000 }).visible, false)
    assert.equal(
        at({ active: false, visible: true, visibleSince: 0, now: 10, minVisibleMs: 0 }).visible,
        false,
    )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { lockWheelAxis, newWheelAxis, WHEEL_AXIS_IDLE_MS } from '../src/components/gene-trees/wheelAxis.js'

// A stream of wheel events 16 ms apart, as a trackpad sends them.
const run = (lock, deltas, t0 = 0) => deltas.map(([dx, dy], i) => lockWheelAxis(lock, { dx, dy, ts: t0 + i * 16 }))
const moved = out => out.reduce((sum, w) => ({ dx: sum.dx + Math.abs(w.dx), dy: sum.dy + Math.abs(w.dy) }), { dx: 0, dy: 0 })

test('a swipe that wanders off its line keeps to it', () => {
  const lock = newWheelAxis()
  const sideways = moved(run(lock, Array.from({ length: 20 }, (_, i) => [6, i % 3 === 0 ? 3 : 1])))
  assert.equal(sideways.dy, 0, 'a sideways pan leaked into a zoom')
  assert.ok(sideways.dx > 100)
  const up = moved(run(newWheelAxis(), Array.from({ length: 20 }, (_, i) => [i % 2 ? 2 : 0, 5])))
  assert.equal(up.dx, 0, 'a zoom leaked into a pan')
})

test('a diagonal swipe is one or the other, not both', () => {
  const out = moved(run(newWheelAxis(), Array.from({ length: 20 }, () => [5, 4])))
  assert.ok(out.dx > 0 && out.dy === 0)
})

test('a pan straight after a zoom’s coasting events is a pan, with nothing of it lost to the zoom', () => {
  // A zoom flung up and down, its coasting tail decaying with no gap, then a sideways swipe
  // started before the tail had gone quiet. The old lock waited for a pause that never came.
  const lock = newWheelAxis()
  const zoom = [...Array.from({ length: 10 }, () => [0, 12]), ...Array.from({ length: 40 }, (_, i) => [0, Math.max(1, 10 - i / 4)])]
  run(lock, zoom)
  const pan = run(lock, Array.from({ length: 30 }, (_, i) => [8, i % 4 === 0 ? 1 : 0]), zoom.length * 16)
  const after = moved(pan.slice(3))
  assert.equal(lock.axis, 'x')
  assert.equal(after.dy, 0, 'the pan was read as a zoom')
  assert.ok(after.dx >= 8 * 26, 'the pan was held back for more than its first few events')
  assert.equal(moved(pan).dy, 0, 'the events held back while the lock turned leaked into the zoom')
})

test('and a zoom straight after a pan’s coasting events is a zoom', () => {
  const lock = newWheelAxis()
  run(lock, Array.from({ length: 30 }, (_, i) => [Math.max(1, 12 - i / 3), 0]))
  const zoom = run(lock, Array.from({ length: 20 }, () => [0, 6]), 30 * 16)
  assert.equal(lock.axis, 'y')
  assert.equal(moved(zoom).dx, 0)
  assert.ok(moved(zoom).dy >= 6 * 17)
})

test('a pause ends a gesture', () => {
  const lock = newWheelAxis()
  run(lock, [[0, 8], [0, 8]])
  const next = lockWheelAxis(lock, { dx: 8, dy: 0, ts: 16 + WHEEL_AXIS_IDLE_MS + 1 })
  assert.equal(next.dx, 8)
  assert.equal(lock.axis, 'x')
})

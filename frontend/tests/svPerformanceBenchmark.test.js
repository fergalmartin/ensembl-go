import test from 'node:test'
import assert from 'node:assert/strict'

import { SvPerformanceRecorder, percentile } from '../src/utils/svPerformanceBenchmark.js'

test('percentile uses the nearest-rank definition', () => {
  assert.equal(percentile([], 0.95), 0)
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
  assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100)
})

test('performance recorder captures delivered frames and input-to-frame latency', () => {
  let now = 1000
  const recorder = new SvPerformanceRecorder({ clock: () => now })
  recorder.markInput()
  now = 1016
  let summary = recorder.recordFrame({ render_ms: 3.5, primitive_count: 4200 })
  assert.equal(summary.input_latency_p95_ms, 16)
  assert.equal(summary.delivered_frame_count, 1)
  assert.equal(summary.visible_primitive_count, 4200)

  for (let index = 0; index < 59; index += 1) {
    now += 16
    summary = recorder.recordFrame({ render_ms: 4, primitive_count: 4200 })
  }
  assert.equal(summary.delivered_fps, 60)
  assert.equal(summary.render_p95_ms, 4)
})

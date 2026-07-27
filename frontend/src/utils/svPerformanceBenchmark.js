const SAMPLE_LIMIT = 900

function sample(values, value) {
  if (!Number.isFinite(value)) return
  values.push(value)
  if (values.length > SAMPLE_LIMIT) values.splice(0, values.length - SAMPLE_LIMIT)
}

export function percentile(values, fraction = 0.95) {
  if (!values.length) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))
  return ordered[index]
}

export class SvPerformanceRecorder {
  constructor({ clock = () => performance.now() } = {}) {
    this.clock = clock
    this.frameTimes = []
    this.latencies = []
    this.renderTimes = []
    this.longTasks = []
    this.pendingInputAt = null
    this.memoryHighWater = 0
    this.lastWorkerMetrics = {}
    this.observer = null
  }

  start() {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sample(this.longTasks, entry.duration)
      })
      this.observer.observe({ type: 'longtask', buffered: true })
    } catch {
      this.observer = null
    }
  }

  stop() {
    this.observer?.disconnect()
    this.observer = null
  }

  markInput(at = this.clock()) {
    if (this.pendingInputAt === null) this.pendingInputAt = at
  }

  recordFrame(workerMetrics = {}, at = this.clock()) {
    sample(this.frameTimes, at)
    sample(this.renderTimes, Number(workerMetrics.render_ms))
    if (this.pendingInputAt !== null) {
      sample(this.latencies, Math.max(0, at - this.pendingInputAt))
      this.pendingInputAt = null
    }
    const heap = Number(globalThis.performance?.memory?.usedJSHeapSize || 0)
    this.memoryHighWater = Math.max(this.memoryHighWater, heap)
    this.lastWorkerMetrics = workerMetrics
    return this.summary(at)
  }

  summary(at = this.clock()) {
    const recentFrames = this.frameTimes.filter((time) => time >= at - 1000)
    return {
      delivered_fps: recentFrames.length,
      input_latency_p95_ms: percentile(this.latencies),
      render_p95_ms: percentile(this.renderTimes),
      main_thread_long_task_count: this.longTasks.filter((duration) => duration >= 50).length,
      main_thread_long_task_max_ms: this.longTasks.length ? Math.max(...this.longTasks) : 0,
      memory_high_water_bytes: this.memoryHighWater,
      delivered_frame_count: this.frameTimes.length,
      visible_primitive_count: Number(this.lastWorkerMetrics.primitive_count || 0),
    }
  }
}

function animationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

/**
 * Runs the same input sequence against either renderer. Pass the viewport DOM
 * element selected beneath the JavaScript/Rust switch and retain the returned
 * JSON as a baseline artifact.
 */
export async function runScriptedSvBenchmark(viewport, { cycles = 12 } = {}) {
  if (!viewport?.dispatchEvent || typeof requestAnimationFrame === 'undefined') {
    throw new Error('The SV benchmark must run in a browser with a mounted viewport')
  }
  const recorder = new SvPerformanceRecorder()
  recorder.start()
  const rect = viewport.getBoundingClientRect()
  const x = rect.left + rect.width * 0.52
  const y = rect.top + rect.height * 0.5
  for (let index = 0; index < cycles; index += 1) {
    recorder.markInput()
    viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      deltaY: index % 2 ? 72 : -72,
      ctrlKey: true,
    }))
    await animationFrame()
    recorder.recordFrame()

    if (typeof PointerEvent !== 'undefined') {
      const pointerId = 7000 + index
      recorder.markInput()
      viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId }))
      viewport.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 24, clientY: y, pointerId }))
      viewport.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 24, clientY: y, button: 0, pointerId }))
      await animationFrame()
      recorder.recordFrame()
    }
  }
  await animationFrame()
  recorder.recordFrame()
  recorder.stop()
  return recorder.summary()
}

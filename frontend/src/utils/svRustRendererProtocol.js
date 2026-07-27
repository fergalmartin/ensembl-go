export const SV_RUST_PROTOCOL_VERSION = 1
export const SV_RUST_CACHE_LIMIT_BYTES = 256 * 1024 * 1024

export const SV_RUST_REQUEST_TYPES = Object.freeze([
  'init',
  'resize',
  'pointerDown',
  'pointerMove',
  'pointerUp',
  'pointerCancel',
  'wheel',
  'zoom',
  'center',
  'settings',
  'snapshot',
  'dispose',
])

export const SV_RUST_RESPONSE_TYPES = Object.freeze([
  'ready',
  'error',
  'fatal',
  'loading',
  'scene',
  'preview',
  'resized',
  'commit',
  'hit',
  'hover',
  'snapshot',
])

export function isCurrentSvEpoch(candidate, current) {
  return Number(candidate) === Number(current)
}

export function estimateJsonBytes(value) {
  try {
    return Math.max(64, new TextEncoder().encode(JSON.stringify(value)).byteLength)
  } catch {
    return 64
  }
}

export class BoundedLruCache {
  constructor(limitBytes = SV_RUST_CACHE_LIMIT_BYTES) {
    this.limitBytes = Math.max(0, Number(limitBytes) || 0)
    this.bytes = 0
    this.values = new Map()
  }

  get(key) {
    const entry = this.values.get(key)
    if (!entry) return null
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key, value) {
    const encodedBytes = estimateJsonBytes(value)
    const previous = this.values.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.values.delete(key)
    }
    if (encodedBytes > this.limitBytes) return false
    this.values.set(key, { value, bytes: encodedBytes })
    this.bytes += encodedBytes
    this.evictToLimit()
    return this.values.has(key)
  }

  setLimit(limitBytes) {
    this.limitBytes = Math.max(0, Number(limitBytes) || 0)
    this.evictToLimit()
  }

  evictToLimit() {
    while (this.bytes > this.limitBytes && this.values.size) {
      const oldestKey = this.values.keys().next().value
      const oldest = this.values.get(oldestKey)
      this.values.delete(oldestKey)
      this.bytes -= oldest?.bytes || 0
    }
  }

  clear() {
    this.values.clear()
    this.bytes = 0
  }
}

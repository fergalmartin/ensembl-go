import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BoundedLruCache,
  SV_RUST_CACHE_LIMIT_BYTES,
  SV_RUST_PROTOCOL_VERSION,
  SV_RUST_REQUEST_TYPES,
  SV_RUST_RESPONSE_TYPES,
  isCurrentSvEpoch,
} from '../src/utils/svRustRendererProtocol.js'

test('the Rust renderer protocol is versioned and covers lifecycle, input, diagnostics, and snapshots', () => {
  assert.equal(SV_RUST_PROTOCOL_VERSION, 1)
  for (const type of ['init', 'resize', 'wheel', 'settings', 'snapshot', 'dispose']) {
    assert.ok(SV_RUST_REQUEST_TYPES.includes(type), `missing request ${type}`)
  }
  for (const type of ['ready', 'fatal', 'loading', 'preview', 'commit', 'hit', 'snapshot']) {
    assert.ok(SV_RUST_RESPONSE_TYPES.includes(type), `missing response ${type}`)
  }
})

test('stale epochs are rejected deterministically', () => {
  assert.equal(isCurrentSvEpoch(8, 8), true)
  assert.equal(isCurrentSvEpoch('8', 8), true)
  assert.equal(isCurrentSvEpoch(7, 8), false)
})

test('bounded LRU eviction is strict and updates recency', () => {
  const cache = new BoundedLruCache(128)
  cache.set('a', 'a'.repeat(40))
  cache.set('b', 'b'.repeat(40))
  assert.equal(cache.get('a'), 'a'.repeat(40))
  cache.set('c', 'c'.repeat(40))
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a'), 'a'.repeat(40))
  assert.ok(cache.bytes <= cache.limitBytes)

  cache.setLimit(0)
  assert.equal(cache.bytes, 0)
  assert.equal(cache.values.size, 0)
  assert.equal(SV_RUST_CACHE_LIMIT_BYTES, 256 * 1024 * 1024)
})

test('an entry larger than the budget is never retained', () => {
  const cache = new BoundedLruCache(64)
  assert.equal(cache.set('oversize', 'x'.repeat(200)), false)
  assert.equal(cache.bytes, 0)
})

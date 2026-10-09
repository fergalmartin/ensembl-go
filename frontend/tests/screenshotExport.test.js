import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDefaultScreenshotName,
  buildScreenshotTimestamp,
  ensureScreenshotFilename,
  normalizeScreenshotFormat,
} from '../src/utils/screenshotExport.js'

test('buildScreenshotTimestamp uses YYYYMMDD_HHMMSS format', () => {
  const date = new Date('2026-03-18T14:05:06Z')
  assert.equal(buildScreenshotTimestamp(date), '20260318_140506')
})

test('buildDefaultScreenshotName prefixes timestamped filename', () => {
  const date = new Date('2026-03-18T14:05:06Z')
  assert.equal(buildDefaultScreenshotName('ens_screenshot', date), 'ens_screenshot_20260318_140506')
})

test('normalizeScreenshotFormat handles jpg alias', () => {
  assert.equal(normalizeScreenshotFormat('jpg'), 'jpeg')
  assert.equal(normalizeScreenshotFormat('PNG'), 'png')
  assert.equal(normalizeScreenshotFormat('weird'), 'svg')
})

test('ensureScreenshotFilename appends or replaces extensions', () => {
  assert.equal(ensureScreenshotFilename('capture', 'svg'), 'capture.svg')
  assert.equal(ensureScreenshotFilename('capture.jpeg', 'png'), 'capture.png')
  assert.equal(ensureScreenshotFilename('capture.jpg', 'jpeg'), 'capture.jpg')
})

test('the page policy allows no WebAssembly eval and screenshots keep their raster proxy', async () => {
  const { readFile } = await import('node:fs/promises')
  const csp = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const screenshot = await readFile(new URL('../src/utils/screenshotExport.js', import.meta.url), 'utf8')
  assert.doesNotMatch(csp, /wasm-unsafe-eval/)
  assert.match(screenshot, /data-screenshot-raster-proxy/)
})

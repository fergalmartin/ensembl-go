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

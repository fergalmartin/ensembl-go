import test from 'node:test'
import assert from 'node:assert/strict'

import {
  browserIsFeatureFramed,
  browserIsShowingSequence,
  clearBrowserViewports,
  registerBrowserViewport,
} from '../src/utils/browserTutorialControls.js'

test('feature framing distinguishes a recentered gene from a whole-region view', () => {
  let viewport = { chrom: '1', start: 118_440_000, end: 120_120_000 }
  const release = registerBrowserViewport('panel', { describe: () => viewport })
  try {
    const reg4 = '1:119,794,017-119,811,580'
    assert.equal(browserIsFeatureFramed(reg4, 'panel'), false)

    viewport = { chrom: 'chr1', start: 119_788_000, end: 119_817_000 }
    assert.equal(browserIsFeatureFramed(reg4, 'panel'), true)

    viewport = { chrom: '1', start: 119_800_000, end: 119_817_000 }
    assert.equal(browserIsFeatureFramed(reg4, 'panel'), false, 'partly clipped is not framed')
  } finally {
    release()
    clearBrowserViewports()
  }
})

test('sequence completion follows the browser\'s rendered sequence state', () => {
  let sequenceVisible = false
  const release = registerBrowserViewport('panel', {
    describe: () => ({ chrom: '1', start: 100, end: 150, sequenceVisible }),
  })
  try {
    assert.equal(browserIsShowingSequence('panel'), false)
    sequenceVisible = true
    assert.equal(browserIsShowingSequence('panel'), true)
  } finally {
    release()
    clearBrowserViewports()
  }
})

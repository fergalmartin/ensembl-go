import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createSvRequestError,
  isRetryableSvRequestError,
  shouldStartSvRequest,
} from '../src/utils/svRequestRetry.js'
import { DataService } from '../src/lib/ensembl-sv/alignments-data/data-service.js'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('an SV buffer request cannot restart while the same key is already loading or waiting to retry', () => {
  const fetchKey = 'alignment_id=third&ref_chrom=11'

  assert.equal(shouldStartSvRequest({ fetchKey }), true)
  assert.equal(shouldStartSvRequest({ fetchKey, lastFetchKey: fetchKey }), false)
  assert.equal(shouldStartSvRequest({ fetchKey, inFlightFetchKey: fetchKey }), false)
  assert.equal(shouldStartSvRequest({ fetchKey, retryScheduled: true }), false)
})

test('SV retries are limited to transient responses and explicitly retryable catalogue races', () => {
  assert.equal(isRetryableSvRequestError(new TypeError('Failed to fetch')), true)
  assert.equal(isRetryableSvRequestError(createSvRequestError('busy', { status: 503 })), true)
  assert.equal(isRetryableSvRequestError(createSvRequestError('rate limited', { status: 429 })), true)
  assert.equal(isRetryableSvRequestError(createSvRequestError('catalogue refreshing', { retryable: true })), true)
  assert.equal(isRetryableSvRequestError(createSvRequestError('bad request', { status: 400 })), false)
})

test('the three-genome view tracks in-flight requests independently and reserves select-arrow space', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')

  assert.match(view, /const upperInFlightFetchKeyRef = useRef\(''\)/)
  assert.match(view, /const lowerInFlightFetchKeyRef = useRef\(''\)/)
  assert.match(view, /slot === 'top' \? upperInFlightFetchKeyRef : lowerInFlightFetchKeyRef/)
  assert.match(view, /retryScheduled: Boolean\(retryState\.timer\)/)
  assert.match(view, /third genome alignment could not be loaded/)
  assert.match(view, /controlBaseClass = '[^']*overflow-hidden[^']*text-ellipsis[^']*pr-8/)
})

test('a failed alignment data request is surfaced and can be retried', async () => {
  let attempts = 0
  const service = new DataService({
    loader: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary failure')
      return [{ id: 'alignment-1', start: 10, end: 20 }]
    },
    getFeatureId: (feature) => feature.id,
    getFeatureStart: (feature) => feature.start,
    getFeatureEnd: (feature) => feature.end,
  })

  await assert.rejects(service.get({ start: 1, end: 100 }), /temporary failure/)
  assert.deepEqual(await service.get({ start: 1, end: 100 }), [
    { id: 'alignment-1', start: 10, end: 20 },
  ])
})

test('adding a third genome preserves the loading upper view and waits for a complete lower window', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')
  const renderer = await source('src/lib/ensembl-sv/alignments/variant-alignments.js')

  assert.match(view, /key=\{`javascript\|\$\{pairAlignmentId\}\|\$\{getSvRegionKey\(selectedAnchorRegion\)\}`\}/)
  assert.doesNotMatch(view, /key=\{`javascript\|\$\{pairAlignmentId\}\|\$\{thirdAlignmentId\}/)
  assert.match(view, /selectedBottomAlignmentId,[\s\S]*?baseTopWindow\?\.chrom,[\s\S]*?baseBottomWindow\?\.chrom/)
  assert.match(view, /selectedBottomAlignmentId[\s\S]*?baseBottomWindow\?\.chrom[\s\S]*?\)/)
  assert.match(renderer, /disconnectedCallback\(\)[\s\S]*?loadAbortController\?\.abort\(\)/)
  assert.match(renderer, /const generation = \+\+this\.loadGeneration/)
  assert.match(renderer, /this\.loadData\(\{ retry: true \}\)/)
})

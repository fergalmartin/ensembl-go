import test from 'node:test'
import assert from 'node:assert/strict'

import { datasetReleaseDownloadMetadata } from '../src/utils/downloadMetadata.js'

test('download metadata preserves dated release provenance from remote files', () => {
  assert.deepEqual(datasetReleaseDownloadMetadata({
    dataset_release_key: 'ensembl/2024_10',
    dataset_release_source: 'ensembl',
    dataset_release_date: '2024_10',
    dataset_release_label: 'ensembl 2024_10',
  }), {
    dataset_release_key: 'ensembl/2024_10',
    dataset_release_source: 'ensembl',
    dataset_release_date: '2024_10',
    dataset_release_label: 'ensembl 2024_10',
  })
})

test('download metadata only uses active release as a fallback', () => {
  assert.deepEqual(datasetReleaseDownloadMetadata({}, {
    active_dataset_release_key: 'ensembl/2025_08',
    dataset_release_source: 'ensembl',
    dataset_release_date: '2025_08',
    dataset_release_label: 'ensembl 2025_08',
  }), {
    dataset_release_key: 'ensembl/2025_08',
    dataset_release_source: 'ensembl',
    dataset_release_date: '2025_08',
    dataset_release_label: 'ensembl 2025_08',
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGeneIntervalIndex,
  queryGeneIntervalIndex,
  sameGeneRange,
} from '../src/utils/geneIntervalIndex.js'

test('gene interval index returns exact overlaps from unsorted input', () => {
  const genes = [
    { id: 'late', start: 900, end: 950 },
    { id: 'long', start: 10, end: 800 },
    { id: 'middle', start: 400, end: 450 },
    { id: 'outside', start: 1000, end: 1100 },
  ]
  const index = buildGeneIntervalIndex(genes)

  assert.deepEqual(
    queryGeneIntervalIndex(index, 430, 920).map((gene) => gene.id),
    ['long', 'middle', 'late'],
  )
})

test('gene interval index preserves inclusive browser boundary semantics', () => {
  const genes = [
    { id: 'left', start: 10, end: 20 },
    { id: 'right', start: 30, end: 40 },
  ]

  assert.deepEqual(queryGeneIntervalIndex(genes, 20, 30).map((gene) => gene.id), ['left', 'right'])
  assert.deepEqual(queryGeneIntervalIndex(genes, 21, 29), [])
})

test('sameGeneRange preserves state identity for equivalent query results', () => {
  const left = [{ id: 'gene-1', start: 10, end: 20 }]
  const right = [{ id: 'gene-1', start: 10, end: 20 }]
  const changed = [{ id: 'gene-1', start: 10, end: 21 }]
  const metadataChanged = [{ id: 'gene-1', start: 10, end: 20, biotype: 'lncRNA' }]

  assert.equal(sameGeneRange(left, right), true)
  assert.equal(sameGeneRange(left, changed), false)
  assert.equal(sameGeneRange(left, metadataChanged), false)
})

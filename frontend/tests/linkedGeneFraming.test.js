import test from 'node:test'
import assert from 'node:assert/strict'
import { linkedGeneFraming } from '../src/utils/linkedGeneFraming.js'

const entries = [
  { gene: { start: 923923, end: 944575, strand: '+' }, bounds: { start: 880000, end: 1075000 } },
  { gene: { start: 172113654, end: 172131927, strand: '-' }, bounds: { start: 172030000, end: 172180000 } },
]
test('gene linking fits mixed strands inside small slices without losing five-prime alignment', () => {
  const { ratio, span } = linkedGeneFraming(entries, '+')
  assert.equal(ratio, 0.5)
  for (const { gene, bounds } of entries) {
    const anchor = gene.strand === '-' ? gene.end : gene.start
    const start = anchor - ratio * span, end = start + span
    assert.ok(start >= bounds.start && end <= bounds.end)
    assert.ok(start <= gene.start && end >= gene.end)
    assert.ok(Math.abs((anchor - start) / span - ratio) < 1e-9)
  }
})
test('full genomes retain the established strand-dependent placement', () => {
  const unbounded = entries.map(({ gene }) => ({ gene }))
  assert.equal(linkedGeneFraming(unbounded, '+').ratio, 0.25)
  assert.equal(linkedGeneFraming(unbounded, '-').ratio, 0.75)
})

test('drawer-aware linked windows fit the slice and keep complete genes in the uncovered track', () => {
  const visibleFraction = 1044 / 1344
  const framed = entries.map((entry) => ({ ...entry, frameRange: (start, end) => ({ start, end: start + (end - start) / visibleFraction }) }))
  const { ratio, span } = linkedGeneFraming(framed, '+')
  for (const { gene, bounds, frameRange } of framed) {
    const anchor = gene.strand === '-' ? gene.end : gene.start
    const start = anchor - ratio * span
    const actual = frameRange(start, start + span)
    assert.ok(actual.start >= bounds.start && actual.end <= bounds.end)
    const uncoveredEnd = actual.start + (actual.end - actual.start) * visibleFraction
    assert.ok(gene.start >= actual.start && gene.end <= uncoveredEnd)
  }
})

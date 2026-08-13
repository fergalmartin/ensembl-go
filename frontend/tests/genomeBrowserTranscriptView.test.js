import assert from 'node:assert/strict'
import test from 'node:test'

import {
  orderTranscripts,
  reorderTranscriptIds,
  resolveGeneTranscriptView,
} from '../src/components/genomeBrowserTranscriptView.js'

const tx = (id, isCanonical = false) => ({ id, is_canonical: isCanonical })

// BRCA2-shaped: one canonical plus a handful of alternates, canonical listed
// second to prove ordering is not just "whatever the backend returned".
const TRANSCRIPTS = [
  tx('ENST-970'),
  tx('ENST-969', true),
  tx('ENST-971'),
  tx('ENST-972'),
]

const ids = (rows) => rows.map((row) => row.transcript.id)

test('canonical transcripts sort ahead of the rest by default', () => {
  assert.deepEqual(
    orderTranscripts(TRANSCRIPTS).map((t) => t.id),
    ['ENST-969', 'ENST-970', 'ENST-971', 'ENST-972']
  )
})

test('an explicit order wins, and unlisted transcripts follow in default order', () => {
  assert.deepEqual(
    orderTranscripts(TRANSCRIPTS, ['ENST-972']).map((t) => t.id),
    ['ENST-972', 'ENST-969', 'ENST-970', 'ENST-971']
  )
})

// A saved ordering can outlive the transcripts it names (chromosome switch,
// assembly change). It must degrade to the default rather than drop rows.
test('ids in the order that no longer exist are ignored', () => {
  assert.deepEqual(
    orderTranscripts(TRANSCRIPTS, ['ENST-gone', 'ENST-971', '', null]).map((t) => t.id),
    ['ENST-971', 'ENST-969', 'ENST-970', 'ENST-972']
  )
})

test('collapsing to one row still yields the canonical transcript', () => {
  const view = resolveGeneTranscriptView({ transcripts: TRANSCRIPTS, limit: 1 })
  assert.deepEqual(ids(view.rows), ['ENST-969'])
  assert.equal(view.visibleCount, 1)
  assert.equal(view.totalCount, 4)
})

test('a gene with no canonical flag falls back to the first transcript', () => {
  const view = resolveGeneTranscriptView({
    transcripts: [tx('ENST-a'), tx('ENST-b')],
    limit: 1,
  })
  assert.deepEqual(ids(view.rows), ['ENST-a'])
})

// Hiding has to happen before the limit slice, otherwise hiding the canonical
// while collapsed would leave the gene with no rows at all.
test('hidden transcripts are filtered out before the row limit applies', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 1,
    hidden: ['ENST-969'],
  })
  assert.deepEqual(ids(view.rows), ['ENST-970'])
  assert.equal(view.hiddenCount, 1)
})

// A gene with everything hidden still has to be findable on screen, so the
// first transcript stays as an outline rather than the gene collapsing away.
test('hiding every transcript leaves the first one as an outline', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 4,
    hidden: ['ENST-969', 'ENST-970', 'ENST-971', 'ENST-972'],
  })
  assert.deepEqual(ids(view.rows), ['ENST-969'])
  assert.deepEqual(view.rows.map((row) => row.ghost), [true])
  assert.equal(view.visibleCount, 0)
  assert.equal(view.hiddenCount, 4)
})

// Collapsed, the browser draws one row. Hiding it must not quietly promote the
// next transcript into its place — the drawer turns that click into hide-all.
test('collapsed with the first transcript hidden falls back to an outline, not a substitute', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 1,
    hidden: ['ENST-969', 'ENST-970', 'ENST-971', 'ENST-972'],
  })
  assert.deepEqual(ids(view.rows), ['ENST-969'])
  assert.equal(view.rows[0].ghost, true)
})

test('a ghost is spliced into the slot it would occupy if unhidden', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 4,
    hidden: ['ENST-971'],
    ghostId: 'ENST-971',
  })
  assert.deepEqual(ids(view.rows), ['ENST-969', 'ENST-970', 'ENST-971', 'ENST-972'])
  assert.deepEqual(view.rows.map((row) => row.ghost), [false, false, true, false])
})

// The ghost costs one extra row rather than evicting a real one, so hovering a
// hidden transcript never makes a visible transcript disappear.
test('a ghost adds a row instead of displacing a visible transcript', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 1,
    hidden: ['ENST-970'],
    ghostId: 'ENST-970',
  })
  assert.deepEqual(ids(view.rows), ['ENST-969', 'ENST-970'])
  assert.deepEqual(view.rows.map((row) => row.ghost), [false, true])
  assert.equal(view.visibleCount, 1)
})

test('ghosting an already visible transcript changes nothing', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 4,
    ghostId: 'ENST-970',
  })
  assert.deepEqual(ids(view.rows), ['ENST-969', 'ENST-970', 'ENST-971', 'ENST-972'])
  assert.ok(view.rows.every((row) => row.ghost === false))
})

test('ghosting an unknown id changes nothing', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 2,
    ghostId: 'ENST-nope',
  })
  assert.deepEqual(ids(view.rows), ['ENST-969', 'ENST-970'])
})

test('the visible transcript list excludes ghost rows', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 4,
    hidden: ['ENST-972'],
    ghostId: 'ENST-972',
  })
  assert.deepEqual(view.transcripts.map((t) => t.id), ['ENST-969', 'ENST-970', 'ENST-971'])
})

test('an empty gene resolves to an empty view', () => {
  const view = resolveGeneTranscriptView({ transcripts: [], limit: 3 })
  assert.deepEqual(view, {
    rows: [],
    transcripts: [],
    visibleCount: 0,
    totalCount: 0,
    hiddenCount: 0,
  })
})

test('hidden accepts a Set as well as an array', () => {
  const view = resolveGeneTranscriptView({
    transcripts: TRANSCRIPTS,
    limit: 4,
    hidden: new Set(['ENST-970']),
  })
  assert.deepEqual(ids(view.rows), ['ENST-969', 'ENST-971', 'ENST-972'])
})

test('reordering moves a transcript to the requested final index', () => {
  const base = ['a', 'b', 'c', 'd']
  assert.deepEqual(reorderTranscriptIds(base, 'd', 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(reorderTranscriptIds(base, 'a', 3), ['b', 'c', 'd', 'a'])
  assert.deepEqual(reorderTranscriptIds(base, 'b', 2), ['a', 'c', 'b', 'd'])
})

test('reordering clamps out-of-range targets and ignores unknown ids', () => {
  const base = ['a', 'b', 'c']
  assert.deepEqual(reorderTranscriptIds(base, 'a', 99), ['b', 'c', 'a'])
  assert.deepEqual(reorderTranscriptIds(base, 'a', -5), ['a', 'b', 'c'])
  assert.deepEqual(reorderTranscriptIds(base, 'zzz', 0), ['a', 'b', 'c'])
})

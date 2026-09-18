import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_PICKS,
  clearPicks,
  featureRecord,
  geneRecord,
  isPicked,
  pickScope,
  picksFor,
  togglePick,
  transcriptRecord,
} from '../src/utils/sequenceViewPicks.js'

const focusAt = (level, extra = {}) => ({
  genomeKey: 'g', chrom: '17', level,
  location: { start: 1, end: 1000 },
  ...extra,
})

test('picks belong to the parent, not to the level', () => {
  const location = pickScope(focusAt('location'))
  assert.ok(location)
  // Two different genes are two different scopes, so ticking transcripts off one
  // says nothing about the other.
  const a = pickScope(focusAt('gene', { gene: { id: 'ENSG1' } }))
  const b = pickScope(focusAt('gene', { gene: { id: 'ENSG2' } }))
  assert.notEqual(a, b)
  assert.notEqual(a, location)
  assert.equal(a, pickScope(focusAt('gene', { gene: { id: 'ENSG1' } })), 'stable')
})

test('a level with nothing chosen yet has no scope to tick in', () => {
  assert.equal(pickScope(focusAt('gene')), '')
  assert.equal(pickScope(focusAt('transcript')), '')
  assert.equal(pickScope(focusAt('feature', { transcript: { id: 'T' } })), '')
  assert.equal(pickScope(null), '')
  assert.equal(pickScope({ level: 'location' }), '', 'no genome')
})

test('a location scope follows the region, so moving house clears the list', () => {
  const here = pickScope(focusAt('location'))
  const there = pickScope({ ...focusAt('location'), location: { start: 5000, end: 6000 } })
  assert.notEqual(here, there)
})

const GENE = { id: 'ENSG00000012048', name: 'BRCA1', s: 43044295, e: 43170245, strand: '-' }

test('a gene becomes a record named by its symbol', () => {
  const record = geneRecord(GENE, '17')
  assert.equal(record.key, 'gene:ENSG00000012048')
  assert.equal(record.label, 'BRCA1')
  assert.equal(record.detail, 'ENSG00000012048', 'the identifier still shown')
  assert.equal(record.level, 'gene')
  assert.deepEqual([record.start, record.end], [43044295, 43170245])
  assert.equal(record.geneId, 'ENSG00000012048')
})

test('a gene with no symbol is named by its identifier, and not twice', () => {
  assert.equal(geneRecord({ ...GENE, name: '' }, '17').detail, '')
  // The backend names an unnamed gene by its identifier rather than leaving the
  // field empty, so the heading has to notice that too.
  const named = geneRecord({ ...GENE, name: GENE.id }, '17')
  assert.equal(named.label, 'ENSG00000012048')
  assert.equal(named.detail, '')
})

test('a transcript becomes a record named by its identifier', () => {
  const record = transcriptRecord(
    { id: 'ENST00000357654', s: 43044295, e: 43125483, strand: '-', biotype: 'protein_coding' },
    '17', 'ENSG00000012048',
  )
  assert.equal(record.key, 'tx:ENST00000357654')
  assert.equal(record.level, 'transcript')
  assert.equal(record.transcriptId, 'ENST00000357654')
  assert.equal(record.geneId, 'ENSG00000012048')
})

test('an exon or intron carries the transcript it is read against', () => {
  // Its classes are the transcript's, windowed -- which is what `feature` means.
  const exon = featureRecord({ kind: 'exon', index: 3, s: 100, e: 200 }, '17', 'ENST1')
  assert.equal(exon.key, 'exon:ENST1:3')
  assert.equal(exon.label, 'exon 3')
  assert.equal(exon.level, 'feature')
  assert.equal(exon.transcriptId, 'ENST1')

  const intron = featureRecord({ kind: 'intron', index: 3, s: 201, e: 900 }, '17', 'ENST1')
  assert.notEqual(intron.key, exon.key, 'exon 3 and intron 3 are different records')
})

test('the same feature number of two transcripts are two records', () => {
  const a = featureRecord({ kind: 'exon', index: 1, s: 1, e: 10 }, '17', 'ENST1')
  const b = featureRecord({ kind: 'exon', index: 1, s: 50, e: 60 }, '17', 'ENST2')
  assert.notEqual(a.key, b.key)
})

test('nothing usable makes no record', () => {
  assert.equal(geneRecord(null, '17'), null)
  assert.equal(geneRecord({ id: 'X' }, '17'), null, 'no coordinates')
  assert.equal(transcriptRecord({ s: 1, e: 2 }, '17'), null, 'no identifier')
  assert.equal(featureRecord({ index: 1, s: 1, e: 2 }, '17', 'T'), null, 'no kind')
})

test('ticking adds, ticking again removes', () => {
  const record = geneRecord(GENE, '17')
  const once = togglePick(EMPTY_PICKS, 'scope-a', record)
  assert.equal(once.items.length, 1)
  assert.ok(isPicked(once, 'scope-a', record.key))
  const off = togglePick(once, 'scope-a', record)
  assert.equal(off.items.length, 0)
  assert.equal(isPicked(off, 'scope-a', record.key), false)
})

test('records stay in the order they were ticked', () => {
  // The reader built the list, so it is theirs to have in the order they made
  // it rather than sorted back into coordinate order behind their back.
  const late = geneRecord({ ...GENE, id: 'A', name: 'A', s: 900, e: 999 }, '17')
  const early = geneRecord({ ...GENE, id: 'B', name: 'B', s: 1, e: 99 }, '17')
  const picks = togglePick(togglePick(EMPTY_PICKS, 's', late), 's', early)
  assert.deepEqual(picks.items.map((item) => item.label), ['A', 'B'])
})

test('picks made under one parent do not show under another', () => {
  const picks = togglePick(EMPTY_PICKS, 'gene:A', geneRecord(GENE, '17'))
  assert.equal(picksFor(picks, 'gene:A').length, 1)
  assert.equal(picksFor(picks, 'gene:B').length, 0)
  assert.equal(isPicked(picks, 'gene:B', 'gene:ENSG00000012048'), false)
})

test('ticking under a new parent starts that parent’s own list', () => {
  const first = togglePick(EMPTY_PICKS, 'gene:A', geneRecord(GENE, '17'))
  const second = togglePick(first, 'gene:B', geneRecord({ ...GENE, id: 'X', name: 'X' }, '17'))
  assert.equal(second.scope, 'gene:B')
  assert.equal(second.items.length, 1)
  assert.equal(second.items[0].label, 'X')
})

test('with nowhere to tick, nothing is ticked', () => {
  assert.equal(togglePick(EMPTY_PICKS, '', geneRecord(GENE, '17')), EMPTY_PICKS)
  assert.equal(togglePick(EMPTY_PICKS, 'scope', null), EMPTY_PICKS)
  assert.deepEqual(clearPicks(), EMPTY_PICKS)
})

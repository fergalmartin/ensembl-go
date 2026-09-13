import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEATURE_PAGE_SIZE,
  SEQUENCE_BLOCK_BP,
  SEQUENCE_CHUNK_BP,
  locationFasta,
  locationFastaHeader,
  locationSpan,
  orderFeaturesFiveToThree,
  paginate,
  reverseComplement,
  selectLocationFeatures,
  sequenceBlock,
  sequenceChunks,
  wrapSequence,
} from '../src/utils/locationFocus.js'

import {
  buildLocationNoteTarget,
  locationNoteLabel,
  locationNoteTargetId,
  locationNoteTargetKey,
  parseLocationNoteTargetId,
} from '../src/utils/geneNotes.js'

const gene = (id, start, end, strand, biotype = 'protein_coding') => ({
  id, start, end, strand, biotype, chrom: '1',
})

test('a location span is ordered, whole-based and never empty', () => {
  assert.deepEqual(locationSpan({ start: 100, end: 200 }), { start: 100, end: 200, length: 100 })
  assert.deepEqual(locationSpan({ start: 200, end: 100 }), { start: 100, end: 200, length: 100 })
  assert.deepEqual(locationSpan({ start: 50, end: 50 }), { start: 50, end: 51, length: 1 })
  assert.equal(locationSpan({ start: 'x', end: 1 }), null)
  assert.equal(locationSpan(null), null)
})

test('a region is read one block at a time, cut from its start', () => {
  const location = { chrom: '1', start: 0, end: 2_500_000 }
  const first = sequenceBlock(location, 0)
  assert.deepEqual(
    { index: first.index, count: first.count, start: first.start, end: first.end },
    { index: 0, count: 3, start: 0, end: SEQUENCE_BLOCK_BP }
  )
  const last = sequenceBlock(location, 2)
  assert.deepEqual({ start: last.start, end: last.end }, { start: 2_000_000, end: 2_500_000 })
  // Paging past either end holds at the block that exists, so the controls can
  // step without bounds-checking themselves.
  assert.equal(sequenceBlock(location, 99).index, 2)
  assert.equal(sequenceBlock(location, -5).index, 0)
  // A region inside one block says so, so the panel can drop its pager.
  assert.equal(sequenceBlock({ start: 10, end: 20 }, 0).isWhole, true)
})

test('a range is split into requests the sequence endpoint accepts', () => {
  const chunks = sequenceChunks(0, 250_000)
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks[0], { start: 0, end: SEQUENCE_CHUNK_BP })
  assert.deepEqual(chunks[2], { start: 200_000, end: 250_000 })
  assert.ok(chunks.every((chunk) => (chunk.end - chunk.start) <= SEQUENCE_CHUNK_BP))
  assert.deepEqual(sequenceChunks(10, 10), [], 'an empty range needs no requests')
  assert.deepEqual(sequenceChunks(200, 100), [{ start: 100, end: 200 }], 'reversed ranges still fetch')
})

test('reverse complement covers ambiguity codes and keeps case', () => {
  assert.equal(reverseComplement('ACGT'), 'ACGT')
  assert.equal(reverseComplement('AAGG'), 'CCTT')
  assert.equal(reverseComplement('acgtn'), 'nacgt')
  assert.equal(reverseComplement('ACRYX'), 'NRYGT', 'an unknown base complements to N')
  assert.equal(reverseComplement(''), '')
})

test('sequences wrap to fixed-width lines and carry a 1-based header', () => {
  assert.equal(wrapSequence('AAAAA', 2), 'AA\nAA\nA')
  // Fetched half-open, shown the way the user types it into the search box.
  assert.equal(
    locationFastaHeader({ chrom: '1', start: 999_999, end: 1_000_010, reverse: true }),
    '>1:1000000-1000010 strand:-'
  )
  assert.equal(
    locationFasta({ chrom: '1', start: 0, end: 4, sequence: 'ACGT' }),
    '>1:1-4 strand:+\nACGT'
  )
})

test('features list 5 prime to 3 prime along the strand being read', () => {
  const features = [
    gene('c', 300, 400, '-'),
    gene('a', 100, 200, '+'),
    gene('b', 150, 250, '-'),
  ]
  assert.deepEqual(orderFeaturesFiveToThree(features, 'both').map((f) => f.id), ['a', 'b', 'c'])
  assert.deepEqual(orderFeaturesFiveToThree(features, 'forward').map((f) => f.id), ['a'])
  // On the reverse strand the most 5' feature is the rightmost one.
  assert.deepEqual(orderFeaturesFiveToThree(features, 'reverse').map((f) => f.id), ['c', 'b'])
})

test('pagination reports what the pager has to show', () => {
  const items = Array.from({ length: 23 }, (_, i) => i)
  const first = paginate(items, 0, FEATURE_PAGE_SIZE)
  assert.deepEqual(
    { page: first.page, pageCount: first.pageCount, from: first.from, to: first.to },
    { page: 0, pageCount: 3, from: 1, to: 10 }
  )
  const last = paginate(items, 9, FEATURE_PAGE_SIZE)
  assert.deepEqual({ page: last.page, from: last.from, to: last.to }, { page: 2, from: 21, to: 23 })
  const empty = paginate([], 0)
  assert.deepEqual({ total: empty.total, from: empty.from, to: empty.to, pageCount: empty.pageCount },
    { total: 0, from: 0, to: 0, pageCount: 1 })
})

test('the drawer list drops classes the reader filtered out before paging', () => {
  const features = [
    gene('a', 100, 200, '+', 'protein_coding'),
    gene('b', 300, 400, '+', 'lncRNA'),
    gene('c', 500, 600, '-', 'protein_coding'),
  ]
  const selection = selectLocationFeatures(features, {
    strandOption: 'both',
    isHiddenByClass: (feature) => feature.biotype === 'lncRNA',
    pageSize: 2,
  })
  assert.deepEqual(selection.ordered.map((f) => f.id), ['a', 'c'])
  assert.equal(selection.total, 2, 'the count is what is listed, not what was fetched')
  assert.deepEqual(selection.items.map((f) => f.id), ['a', 'c'])
})

test('a location note is keyed by its plain coordinates and titled by its label', () => {
  assert.equal(locationNoteTargetId({ chrom: '1', start: 1_000_000, end: 1_200_000 }), '1:1000000-1200000')
  // However the region arrives, the same stretch is the same note.
  assert.equal(locationNoteTargetId({ chrom: '1', start: 1_200_000, end: 1_000_000 }), '1:1000000-1200000')
  assert.equal(locationNoteTargetId({ start: 1, end: 2 }), '')
  assert.deepEqual(parseLocationNoteTargetId('1:1000000-1200000'), { chrom: '1', start: 1_000_000, end: 1_200_000 })
  assert.deepEqual(parseLocationNoteTargetId('NW_0001.1:5-9'), { chrom: 'NW_0001.1', start: 5, end: 9 })
  assert.equal(parseLocationNoteTargetId('not-a-region'), null)
  assert.equal(
    locationNoteLabel({ chrom: '1', start: 1_000_000, end: 1_200_000 }),
    'Location: 1:1,000,000-1,200,000'
  )
  const target = buildLocationNoteTarget({
    genomeKey: 'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12',
    selectionKey: 'panel-1',
    location: { chrom: '1', start: 1_000_000, end: 1_200_000 },
  })
  assert.equal(target.kind, 'location')
  assert.equal(target.genome_key, 'ensembl::Homo_sapiens::GCA_000001405.29', 'the release is not part of the key')
  assert.equal(target.id, '1:1000000-1200000')
  assert.equal(
    locationNoteTargetKey('ensembl::Homo_sapiens::GCA_000001405.29', { chrom: '1', start: 1_000_000, end: 1_200_000 }),
    ['location', 'ensembl::Homo_sapiens::GCA_000001405.29', '1:1000000-1200000'].join('\u0000')
  )
})

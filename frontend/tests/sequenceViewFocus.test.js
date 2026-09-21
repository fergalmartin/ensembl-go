import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FLANKS,
  FOCUS_CHAIN,
  LEVEL_GENE,
  LEVEL_LOCATION,
  LEVEL_TRANSCRIPT,
  emptyFocus,
  focusFromStart,
  focusReducer,
  focusWindow,
  levelIsSet,
  neighbours,
  overlapsLocation,
  spanOf,
} from '../src/utils/sequenceViewFocus.js'

const gene = { id: 'G1', name: 'BRCA1', start: 101, end: 200, strand: '-' }
const otherGene = { id: 'G2', name: 'NBR2', start: 300, end: 400, strand: '+' }
const transcript = { id: 'T1', start: 110, end: 190, strand: '-' }
const exon = { kind: 'exon', index: 2, start: 150, end: 170 }

const run = (state, ...actions) => actions.reduce(focusReducer, state)
const seeded = () => run(
  { ...emptyFocus('g', '17'), location: { start: 1, end: 1000 } },
  { type: 'enterGene', gene },
  { type: 'enterTranscript', transcript },
  { type: 'enterFeature', feature: exon },
)

test('the chain is location, gene, transcript, feature', () => {
  assert.deepEqual(FOCUS_CHAIN, ['location', 'gene', 'transcript', 'feature'])
})

test('descending sets the child and moves the pointer', () => {
  const state = seeded()
  assert.equal(state.level, 'feature')
  assert.equal(state.gene.id, 'G1')
  assert.equal(state.transcript.id, 'T1')
})

test('ascending moves the pointer but keeps the children, so going back is free', () => {
  // The thing that makes this not a nested menu: the transcript is still chosen
  // after stepping up to the gene, so stepping back down lands where it was.
  const state = run(seeded(), { type: 'ascend' }, { type: 'ascend' })
  assert.equal(state.level, 'gene')
  assert.equal(state.transcript.id, 'T1', 'the transcript is remembered')
  assert.equal(state.feature.index, 2, 'and so is the exon')

  const back = focusReducer(state, { type: 'goTo', level: 'transcript' })
  assert.equal(back.level, 'transcript')
  assert.equal(back.transcript.id, 'T1')
})

test('choosing a different gene clears what was chosen underneath it', () => {
  const state = focusReducer(seeded(), { type: 'enterGene', gene: otherGene })
  assert.equal(state.gene.id, 'G2')
  assert.equal(state.transcript, null)
  assert.equal(state.feature, null)
})

test('choosing the same gene again keeps the transcript below it', () => {
  const state = focusReducer(seeded(), { type: 'enterGene', gene })
  assert.equal(state.level, 'gene')
  assert.equal(state.transcript.id, 'T1')
})

test('a new transcript clears the exon but leaves the gene alone', () => {
  const state = focusReducer(seeded(), { type: 'enterTranscript', transcript: { id: 'T2', start: 1, end: 9 } })
  assert.equal(state.feature, null)
  assert.equal(state.gene.id, 'G1')
})

test('the reader cannot ascend past the location or descend past a feature', () => {
  const atTop = run({ ...emptyFocus('g', '17'), location: { start: 1, end: 10 } })
  assert.equal(neighbours(atTop).parent, null)
  assert.equal(focusReducer(atTop, { type: 'ascend' }), atTop, 'unchanged')
  assert.equal(neighbours(seeded()).child, null)
})

test('a level with nothing chosen cannot be moved to', () => {
  const state = { ...emptyFocus('g', '17'), location: { start: 1, end: 10 } }
  assert.equal(levelIsSet(state, 'gene'), false)
  assert.equal(focusReducer(state, { type: 'goTo', level: 'gene' }).level, 'location')
})

test('a selection sits beside the chain and returns the reader where they were', () => {
  const state = run(seeded(), { type: 'ascend' }) // at transcript
  assert.equal(state.level, 'transcript')

  const selected = run(state,
    { type: 'setCustom', custom: { start: 180, end: 120 } },
    { type: 'focusCustom' })
  assert.equal(selected.level, 'custom')
  assert.deepEqual(selected.custom, { start: 120, end: 180 }, 'ordered whichever way it was dragged')
  // The chain is untouched underneath it.
  assert.equal(selected.transcript.id, 'T1')

  const dismissed = focusReducer(selected, { type: 'clearCustom' })
  assert.equal(dismissed.level, 'transcript', 'back where the reader was')
  assert.equal(dismissed.custom, null)
})

test('moving in the chain drops a selection, whose coordinates would be off screen', () => {
  const selected = run(seeded(),
    { type: 'setCustom', custom: { start: 120, end: 180 } },
    { type: 'focusCustom' })
  assert.equal(focusReducer(selected, { type: 'enterGene', gene: otherGene }).custom, null)
  assert.equal(focusReducer(selected, { type: 'ascend' }).custom, null)
})

test('selecting twice without dismissing does not lose the level to return to', () => {
  const state = run(seeded(), { type: 'ascend' })
  const twice = run(state,
    { type: 'setCustom', custom: { start: 1, end: 2 } },
    { type: 'focusCustom' },
    { type: 'setCustom', custom: { start: 5, end: 9 } })
  assert.equal(focusReducer(twice, { type: 'clearCustom' }).level, 'transcript')
})

test('each level brings its own flank, and a window is clipped at the start of a contig', () => {
  assert.deepEqual(DEFAULT_FLANKS.gene, { five: 60, three: 60 })
  assert.deepEqual(DEFAULT_FLANKS.transcript, { five: 60, three: 60 })
  assert.deepEqual(DEFAULT_FLANKS.feature, { five: 10, three: 10 })
  assert.deepEqual(DEFAULT_FLANKS.location, { five: 0, three: 0 })

  const atTranscript = run(seeded(), { type: 'ascend' })
  assert.deepEqual(focusWindow(atTranscript), { start: 50, end: 250 })
  assert.deepEqual(focusWindow(seeded()), { start: 140, end: 180 }, 'the exon plus ten')
  // Never before the first base of the chromosome.
  const early = { ...emptyFocus('g', '17'), level: 'transcript', transcript: { start: 5, end: 50 } }
  assert.equal(focusWindow(early).start, 1)
})

test('a flank the reader has changed is used instead of the default', () => {
  const atTranscript = run(seeded(), { type: 'ascend' })
  assert.deepEqual(focusWindow(atTranscript, { transcript: { five: 0, three: 0 } }),
    { start: 110, end: 190 })
  // One number is the older shape of this setting, and meant both ends.
  assert.deepEqual(focusWindow(atTranscript, { transcript: 5 }), { start: 105, end: 195 })
})

test('5\u2032 and 3\u2032 are the feature\u2019s ends, not the screen\u2019s', () => {
  // The whole point of the pair: a promoter is the 5' box on both strands, so
  // on the minus strand the 5' flank has to come off the high coordinate.
  const forward = { ...emptyFocus('g', '17'), level: 'transcript',
    transcript: { start: 100, end: 200, strand: '+' } }
  const reverse = { ...forward, transcript: { start: 100, end: 200, strand: '-' } }
  const flanks = { transcript: { five: 30, three: 5 } }
  assert.deepEqual(focusWindow(forward, flanks), { start: 70, end: 205 })
  assert.deepEqual(focusWindow(reverse, flanks), { start: 95, end: 230 })
})

test('a focus with nothing chosen has no window rather than a wrong one', () => {
  assert.equal(focusWindow(emptyFocus('g', '17')), null)
  assert.equal(focusWindow(null), null)
})

test('a coordinate jump can cross chromosomes, and crossing clears the chain', () => {
  // Landing on the right coordinates of the wrong chromosome would be worse
  // than not moving, and a gene from the old chromosome is meaningless here.
  const state = focusReducer(seeded(), { type: 'enterLocation', chrom: '11', location: { start: 5, end: 90 } })
  assert.equal(state.chrom, '11')
  assert.deepEqual(state.location, { start: 5, end: 90 })
  assert.equal(state.gene, null)
  assert.equal(state.transcript, null)
  assert.equal(state.feature, null)
})

test('a jump keeps whatever it lands on top of', () => {
  // Nudging the ends of a location must not cost the reader the gene they were
  // reading: the chain is their way back to it.
  const state = focusReducer(seeded(), { type: 'enterLocation', chrom: '17', location: { start: 120, end: 400 } })
  assert.equal(state.gene.id, 'G1')
  assert.equal(state.transcript.id, 'T1')
  assert.equal(state.feature.start, 150)
})

test('a jump somewhere else on the chromosome arrives as a fresh location', () => {
  // The gene is at 101-200 and the new window is nowhere near it. Leaving it in
  // the drawer would offer a way back to somewhere the reader has just left.
  const state = focusReducer(seeded(), { type: 'enterLocation', chrom: '17', location: { start: 5, end: 90 } })
  assert.deepEqual(state.location, { start: 5, end: 90 })
  assert.equal(state.gene, null)
  assert.equal(state.transcript, null)
  assert.equal(state.feature, null)
  assert.equal(state.level, 'location')
})

test('overlapping at all is enough to survive a jump', () => {
  // A gene wider than the window is still the gene the reader is standing in.
  const inside = focusReducer(seeded(), { type: 'enterLocation', location: { start: 155, end: 160 } })
  assert.equal(inside.gene.id, 'G1')
  // Touching by one base counts; the base before it does not.
  const edge = focusReducer(seeded(), { type: 'enterLocation', location: { start: 1, end: 101 } })
  assert.equal(edge.gene.id, 'G1')
  const short = focusReducer(seeded(), { type: 'enterLocation', location: { start: 1, end: 100 } })
  assert.equal(short.gene, null)
})

test('a jump with no chromosome named stays on the one being read', () => {
  const state = focusReducer(seeded(), { type: 'enterLocation', location: { start: 150, end: 900 } })
  assert.equal(state.chrom, '17')
  assert.equal(state.gene.id, 'G1', 'and so keeps what it still covers')
})

test('a selection read as a location leaves the highlight behind', () => {
  // What the panel over a selection does: the reader has chosen where to be, so
  // it is a jump like any other and the selection has done its job.
  const selected = focusReducer(seeded(), { type: 'setCustom', custom: { start: 160, end: 120 } })
  assert.deepEqual(selected.custom, { start: 120, end: 160 })
  const jumped = focusReducer(selected, { type: 'enterLocation', location: { start: 120, end: 160 } })
  assert.equal(jumped.custom, null)
  assert.equal(jumped.level, 'location')
  assert.deepEqual(jumped.location, { start: 120, end: 160 })
})

test('a span is read however its ends are spelt', () => {
  // Features arrive as s/e from the annotation lists and as start/end once the
  // reducer has them, and both have to be placeable against a location.
  assert.deepEqual(spanOf({ start: 10, end: 20 }), { start: 10, end: 20 })
  assert.deepEqual(spanOf({ s: 10, e: 20 }), { start: 10, end: 20 })
  assert.deepEqual(spanOf({ start: 20, end: 10 }), { start: 10, end: 20 }, 'either way round')
  assert.equal(spanOf(null), null)
  assert.equal(spanOf({ start: 10 }), null)
  assert.equal(overlapsLocation({ s: 150, e: 170 }, { start: 100, end: 200 }), true)
  assert.equal(overlapsLocation({ s: 150, e: 170 }, null), false)
  assert.equal(overlapsLocation(null, { start: 1, end: 2 }), false)
})

test('switching genomes lands where that genome was being read', () => {
  // A gene picked out elsewhere is the most particular answer, so it wins.
  const withGene = focusFromStart('g2', {
    gene: { id: 'G9', name: 'BRCA2', chrom: '13', start: 32315474, end: 32400266, strand: '+' },
    location: { chrom: '13', start: 32300000, end: 32500000 },
  })
  assert.equal(withGene.chrom, '13')
  assert.equal(withGene.focus.level, 'gene')
  assert.equal(withGene.focus.gene.id, 'G9')
  assert.deepEqual(withGene.focus.location, { start: 32300000, end: 32500000 },
    'and the region on record stands above it')
})

test('a region from another chromosome is not the gene’s region', () => {
  const crossed = focusFromStart('g2', {
    gene: { id: 'G9', chrom: '13', start: 100, end: 200 },
    location: { chrom: '7', start: 1, end: 5000 },
  })
  assert.equal(crossed.chrom, '13')
  assert.deepEqual(crossed.focus.location, { start: 100, end: 200 }, 'the gene’s own span stands in')
})

test('a region alone is enough to open on', () => {
  const region = focusFromStart('g3', { location: { chrom: '2', start: 90, end: 10 } })
  assert.equal(region.chrom, '2')
  assert.equal(region.focus.level, 'location')
  assert.deepEqual(region.focus.location, { start: 10, end: 90 }, 'either way round')
  assert.equal(region.focus.gene, undefined)
})

test('a genome nobody has been reading has nothing to say', () => {
  assert.equal(focusFromStart('g4', null), null)
  assert.equal(focusFromStart('g4', {}), null)
  // Half a gene is not a place: without coordinates there is nowhere to go.
  assert.equal(focusFromStart('g4', { gene: { id: 'G1' } }), null)
  assert.equal(focusFromStart('g4', { location: { start: 1, end: 2 } }), null, 'nor a region with no chromosome')
})

// ---- switching genome -----------------------------------------------------

test('a reset to another genome carries nothing at all from the old one', () => {
  // The bug this guards: the view set the genome key and, where it had nowhere
  // to send the reader, returned -- leaving the previous genome's chromosome,
  // region, gene, transcript and selection on the screen under the new
  // genome's name. A reset with no focus has to be genuinely empty.
  const busy = {
    genomeKey: 'rat', chrom: '7', level: LEVEL_TRANSCRIPT,
    location: { start: 100, end: 900 },
    gene: { id: 'G1', name: 'ABC', start: 200, end: 800, strand: '+' },
    transcript: { id: 'T1', start: 200, end: 800, strand: '+' },
    feature: { kind: 'exon', index: 2, s: 300, e: 400 },
    custom: { start: 310, end: 320 },
    previousLevel: LEVEL_GENE,
  }
  const after = focusReducer(busy, { type: 'reset', genomeKey: 'human', chrom: '' })
  assert.equal(after.genomeKey, 'human')
  assert.equal(after.chrom, '')
  for (const key of ['location', 'gene', 'transcript', 'feature', 'custom']) {
    assert.equal(after[key], null, `${key} survived a genome switch`)
  }
  assert.equal(after.level, LEVEL_LOCATION, 'and the level is back at the top')
})

test('a reset to a remembered place restores exactly that place', () => {
  // The other half: switching back to a genome the reader has read before
  // returns them to where they were, rather than to wherever the app last
  // opened it somewhere else.
  const remembered = {
    level: LEVEL_GENE,
    location: { start: 5_000_000, end: 5_010_000 },
    gene: { id: 'G9', name: 'XYZ', start: 5_001_000, end: 5_009_000, strand: '-' },
  }
  const after = focusReducer(
    emptyFocus('human', '1'),
    { type: 'reset', genomeKey: 'rat', chrom: '2', focus: remembered },
  )
  assert.equal(after.genomeKey, 'rat')
  assert.equal(after.chrom, '2')
  assert.equal(after.level, LEVEL_GENE)
  assert.deepEqual(after.location, remembered.location)
  assert.equal(after.gene.id, 'G9')
})

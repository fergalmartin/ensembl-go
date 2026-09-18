import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FLANKS,
  FOCUS_CHAIN,
  emptyFocus,
  focusReducer,
  focusWindow,
  levelIsSet,
  neighbours,
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

test('a jump within the same chromosome keeps the gene and transcript', () => {
  const state = focusReducer(seeded(), { type: 'enterLocation', chrom: '17', location: { start: 5, end: 90 } })
  assert.equal(state.gene.id, 'G1')
  assert.equal(state.transcript.id, 'T1')
})

test('a jump with no chromosome named stays on the one being read', () => {
  const state = focusReducer(seeded(), { type: 'enterLocation', location: { start: 5, end: 90 } })
  assert.equal(state.chrom, '17')
  assert.equal(state.gene.id, 'G1', 'and so does not clear the chain')
})

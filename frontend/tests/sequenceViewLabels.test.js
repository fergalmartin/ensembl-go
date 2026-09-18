import assert from 'node:assert/strict'
import test from 'node:test'

import { biotypeText, metaText, strandMark, strandText } from '../src/utils/sequenceViewLabels.js'

test('a biotype is the annotation’s own word, in lower case', () => {
  assert.equal(biotypeText('protein_coding'), 'protein coding')
  assert.equal(biotypeText('processed_pseudogene'), 'processed pseudogene')
  assert.equal(biotypeText('transcribed_unitary_pseudogene'), 'transcribed unitary pseudogene')
})

test('an acronym keeps its shape', () => {
  // Lower-casing these would be wrong rather than merely unusual: lncrna is not
  // a word, and tec is not TEC.
  for (const name of ['lncRNA', 'snoRNA', 'miRNA', 'scaRNA', 'TEC', 'Mt_tRNA']) {
    assert.equal(biotypeText(name), name.replace(/_/g, ' '), name)
  }
})

test('a capitalised label comes back in the same words as the raw biotype', () => {
  // The thing that started this: "Protein-coding" in the list beside "protein
  // coding" in the box, for one gene.
  assert.equal(biotypeText('Protein_coding'), 'protein coding')
  assert.equal(biotypeText('protein_coding'), biotypeText('Protein_coding'))
})

test('nothing in, nothing out', () => {
  assert.equal(biotypeText(''), '')
  assert.equal(biotypeText(null), '')
  assert.equal(strandText(''), '')
  assert.equal(strandText('?'), '')
})

test('a strand is written in words, never as a bare sign', () => {
  assert.equal(strandText('+'), '+ strand')
  assert.equal(strandText('-'), '- strand')
})

test('facts are separated by space, and empty ones do not leave gaps', () => {
  assert.equal(metaText('protein coding', '+ strand', '56 kb'), 'protein coding + strand 56 kb')
  assert.equal(metaText('lncRNA', '', null, '1.2 kb'), 'lncRNA 1.2 kb')
  assert.equal(metaText([]), '')
})

test('a strand is a bare sign where it sits beside a name', () => {
  assert.equal(strandMark('+'), '+')
  assert.equal(strandMark('-'), '-')
  assert.equal(strandMark(' - '), '-')
  // Nothing at all rather than a stray character, for the things that have no
  // strand of their own: a location, a dragged selection, an unread feature.
  assert.equal(strandMark(''), '')
  assert.equal(strandMark(null), '')
  assert.equal(strandMark(undefined), '')
  assert.equal(strandMark('?'), '')
  // The worded form is still what the base box and a record's heading use.
  assert.equal(strandText('-'), '- strand')
})

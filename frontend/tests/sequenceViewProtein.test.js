import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_AMINO,
  buildRowAminoAcids,
  coordAtOffset,
  offsetAtCoord,
  proteinRowRuns,
  spliceIndex,
  translateCodon,
} from '../src/utils/sequenceViewProtein.js'
import { PLACEHOLDER_BASE } from '../src/utils/sequenceViewChunks.js'
import { buildDisplayLayout, displayRow } from '../src/utils/sequenceViewDisplay.js'

/** A reader over a made-up chromosome, 1-based like everything else here. */
const reader = (sequence, start = 1) => (coord) => sequence[coord - start] || null

test('the genetic code is the standard one, stops and all', () => {
  assert.equal(translateCodon('ATG'), 'M')
  assert.equal(translateCodon('atg'), 'M', 'case is not information here')
  assert.equal(translateCodon('TGG'), 'W')
  assert.equal(translateCodon('TAA'), '*')
  assert.equal(translateCodon('TAG'), '*')
  assert.equal(translateCodon('TGA'), '*')
  // A codon with an N in it is still a codon: blanking it would read as the end
  // of the coding sequence rather than as one unreadable base.
  assert.equal(translateCodon('ANG'), 'X')
  assert.equal(translateCodon('AT'), 'X')
})

test('an offset and a coordinate are the same place, read both ways', () => {
  // Two CDS segments with an intron between them: spliced offsets run straight
  // through, genomic coordinates do not.
  const frame = [{ s: 101, e: 106, o: 0 }, { s: 201, e: 206, o: 6 }]
  const index = spliceIndex(frame)
  assert.equal(offsetAtCoord(index, 101), 0)
  assert.equal(offsetAtCoord(index, 106), 5)
  assert.equal(offsetAtCoord(index, 201), 6, 'the intron costs no offset')
  assert.equal(offsetAtCoord(index, 150), null, 'inside the intron is not CDS')
  assert.equal(coordAtOffset(index, 5), 106)
  assert.equal(coordAtOffset(index, 6), 201)
  assert.equal(coordAtOffset(index, 12), null, 'past the end of the CDS')
})

test('the same index is reused rather than rebuilt for every row', () => {
  const frame = [{ s: 1, e: 3, o: 0 }]
  assert.equal(spliceIndex(frame), spliceIndex(frame))
  assert.equal(spliceIndex([]), null)
})

test('a letter sits on its codon’s middle base, and nowhere else', () => {
  //            101 ATG GCC
  const bases = 'ATGGCC'
  const frame = [{ s: 101, e: 106, o: 0 }]
  const amino = buildRowAminoAcids({
    row: { start: 101, end: 106 }, cdsFrame: frame, strand: '+', readBase: reader(bases, 101),
  })
  // Centred: the first and third base of each codon carry nothing, which is
  // what puts the letter over the three cells rather than at one end of them.
  assert.equal(amino, [NO_AMINO, 'M', NO_AMINO, NO_AMINO, 'A', NO_AMINO].join(''))
})

test('a codon split across an exon junction is read spliced, not through the intron', () => {
  // GC | C: the third base of the second codon is the first base of exon two.
  // Reading genomically from the middle base would pick up an intronic base and
  // translate a different amino acid.
  const chromosome = 'ATGGCXXXXXXXXXXC'
  const frame = [{ s: 101, e: 105, o: 0 }, { s: 116, e: 116, o: 5 }]
  const read = reader(chromosome, 101)
  const amino = buildRowAminoAcids({
    row: { start: 101, end: 116 }, cdsFrame: frame, strand: '+', readBase: read,
  })
  assert.equal(amino[0], NO_AMINO)
  assert.equal(amino[1], 'M')
  assert.equal(amino[3], NO_AMINO, 'the fourth base opens the second codon')
  // GCC is alanine. Read through the intron it would have been GCX -> unknown.
  assert.equal(amino[4], 'A')
})

test('a minus-strand transcript is read from its far end and complemented', () => {
  // The coding sequence reads ATG TAA 5' to 3', which on this strand is the
  // reverse complement of the forward bases TTA CAT.
  const forward = 'TTACAT'
  const frame = [{ s: 101, e: 106, o: 0 }]
  const amino = buildRowAminoAcids({
    row: { start: 101, end: 106 }, cdsFrame: frame, strand: '-', readBase: reader(forward, 101),
  })
  // Offsets fall as the coordinate rises, so the codon at offsets 0-2 is the
  // high end of the window: 106, 105, 104.
  assert.equal(amino[105 - 101], 'M')
  assert.equal(amino[102 - 101], '*')
})

test('a base whose chunk has not arrived leaves the codon blank rather than unknown', () => {
  // A loading state, not an annotation: an X there would say something about the
  // sequence that is not true.
  const frame = [{ s: 101, e: 103, o: 0 }]
  const amino = buildRowAminoAcids({
    row: { start: 101, end: 103 },
    cdsFrame: frame,
    strand: '+',
    readBase: (coord) => (coord === 103 ? PLACEHOLDER_BASE : 'A'),
  })
  assert.equal(amino, NO_AMINO.repeat(3))
})

test('sequence with no reading frame gets a blank lane of the right length', () => {
  const amino = buildRowAminoAcids({ row: { start: 1, end: 60 }, cdsFrame: [] })
  assert.equal(amino.length, 60)
  assert.equal(amino.trim(), '')
})


// ---- which rows are tall --------------------------------------------------
//
// The runs decide a row's height, and the letters decide what is drawn in it.
// They are worked out from different things -- the annotation and the bases --
// so the property that matters is that the first never leaves out a row the
// second would draw in. A letter with no lane under it is a letter over the
// neighbouring row.

const covered = (runs, row) => runs.some((run) => row >= run.from && row <= run.to)

/** Every row of a layout, and whether translation puts a letter in it. */
function lettersByRow(layout, cdsFrame, strand, readBase) {
  const out = []
  for (let i = 0; i < layout.totalRows; i += 1) {
    const row = displayRow(layout, i)
    let has = false
    for (const piece of row.pieces) {
      const amino = buildRowAminoAcids({
        row: { start: piece.s, end: piece.e }, cdsFrame, strand, readBase,
      })
      if (amino.trim() !== '') has = true
    }
    out.push(has)
  }
  return out
}

test('a row is tall wherever translation would put a letter in it', () => {
  // Two coding exons a long way apart, so most rows are intronic and carry
  // nothing at all -- which is the case this exists for.
  const region = { start: 1001, end: 1001 + 60 * 20 - 1 }
  const cdsFrame = [{ s: 1031, e: 1090, o: 0 }, { s: 1501, e: 1560, o: 60 }]
  const layout = buildDisplayLayout({ region })
  const runs = proteinRowRuns({ layout, cdsFrame, strand: '+' })
  const letters = lettersByRow(layout, cdsFrame, '+', () => 'A')

  assert.ok(letters.some(Boolean), 'the fixture has letters somewhere')
  assert.ok(letters.some((has) => !has), 'and rows without any')
  letters.forEach((has, row) => {
    if (has) assert.ok(covered(runs, row), `row ${row} draws a letter with no lane`)
  })
})

test('the tall rows are the ones with letters, and not the whole document', () => {
  const region = { start: 1001, end: 1001 + 60 * 20 - 1 }
  const cdsFrame = [{ s: 1031, e: 1090, o: 0 }]
  const layout = buildDisplayLayout({ region })
  const runs = proteinRowRuns({ layout, cdsFrame, strand: '+' })
  const tall = []
  for (let row = 0; row < layout.totalRows; row += 1) if (covered(runs, row)) tall.push(row)
  // The CDS spans rows 0 and 1 of a region beginning at 1001: 1031 is column 30.
  assert.deepEqual(tall, [0, 1])
})

test('a minus-strand frame marks the same rows, read from the other end', () => {
  const region = { start: 1001, end: 1001 + 60 * 8 - 1 }
  const cdsFrame = [{ s: 1031, e: 1090, o: 0 }]
  const layout = buildDisplayLayout({ region, reverse: true })
  const runs = proteinRowRuns({ layout, cdsFrame, strand: '-' })
  const letters = lettersByRow(layout, cdsFrame, '-', () => 'A')
  letters.forEach((has, row) => {
    if (has) assert.ok(covered(runs, row), `row ${row} draws a letter with no lane`)
  })
  assert.ok(runs.length > 0)
})

test('no frame is no tall rows at all', () => {
  const layout = buildDisplayLayout({ region: { start: 1, end: 600 } })
  assert.deepEqual(proteinRowRuns({ layout, cdsFrame: [] }), [])
  assert.deepEqual(proteinRowRuns({ layout: null, cdsFrame: [{ s: 1, e: 3, o: 0 }] }), [])
})

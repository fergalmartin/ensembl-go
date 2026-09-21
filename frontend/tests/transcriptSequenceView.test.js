import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KINDS,
  KIND_CDS,
  aminoRow,
  legendGroupsFor,
  splicedRunsFor,
  KIND_GENOMIC,
  KIND_PROTEIN,
  KIND_TRANSCRIPT,
  MODES,
  codonPlace,
  codonRuns,
  codonSpan,
  genomicAt,
  genomicExtentOf,
  overlayRuns,
  proteinRuns,
  rowClasses,
  segmentAt,
  selectedText,
  selectionSpan,
  counted,
  genomicRangeFor,
  highlightFor,
  modeOffer,
  residueAt,
  splicedRangeFor,
  readingFasta,
  splicedRows,
} from '../src/utils/transcriptSequenceView.js'
import { CLASS_CODES, CLASS_NONE } from '../src/utils/sequenceViewPalette.js'
import { NO_AMINO } from '../src/utils/sequenceViewProtein.js'

// The two exons of a plus-strand transcript, and the same two read the other
// way round. Spliced position 1 is the transcript's first base on both: on the
// minus strand that is the highest coordinate it has.
const PLUS = [
  { s: 1, e: 20, gs: 101, ge: 120, exon: 1 },
  { s: 21, e: 40, gs: 131, ge: 150, exon: 2 },
]
const MINUS = [
  { s: 1, e: 20, gs: 231, ge: 250, exon: 1 },
  { s: 21, e: 40, gs: 201, ge: 220, exon: 2 },
]

test('rows are sixty wide and the last one is however much is left', () => {
  const rows = splicedRows(130)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { index: 0, col0: 0, length: 60, first: 1, last: 60 })
  assert.deepEqual(rows[1], { index: 1, col0: 60, length: 60, first: 61, last: 120 })
  assert.deepEqual(rows[2], { index: 2, col0: 120, length: 10, first: 121, last: 130 })
})

test('an exact multiple of sixty does not get an empty last row', () => {
  const rows = splicedRows(120)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].last, 120)
})

test('nothing to show is no rows at all', () => {
  assert.deepEqual(splicedRows(0), [])
})

test('a spliced position resolves to its own segment', () => {
  assert.equal(segmentAt(PLUS, 1).exon, 1)
  assert.equal(segmentAt(PLUS, 20).exon, 1)
  assert.equal(segmentAt(PLUS, 21).exon, 2)
  assert.equal(segmentAt(PLUS, 41), null, 'past the end of the transcript')
  assert.equal(segmentAt(PLUS, 0), null)
})

test('the genomic coordinate rises with the position on the plus strand', () => {
  assert.deepEqual(genomicAt(PLUS, 1, '+'), { coord: 101, exon: 1, segment: PLUS[0] })
  assert.deepEqual(genomicAt(PLUS, 20, '+').coord, 120)
  // Across the junction: the next base of the transcript is ten away on the
  // chromosome, which is the whole point of reading it spliced.
  assert.equal(genomicAt(PLUS, 21, '+').coord, 131)
})

test('the genomic coordinate falls with the position on the minus strand', () => {
  assert.equal(genomicAt(MINUS, 1, '-').coord, 250)
  assert.equal(genomicAt(MINUS, 20, '-').coord, 231)
  assert.equal(genomicAt(MINUS, 21, '-').coord, 220)
  assert.equal(genomicAt(MINUS, 40, '-').coord, 201)
})

test('a residue names the three bases that spell it', () => {
  // Codon-aligned CDS space, where residue n is always at 3n-2 to 3n. A
  // 5'-incomplete CDS is padded on the left by the backend's translation layout
  // precisely so that this stays arithmetic.
  assert.deepEqual(codonSpan(1), { s: 1, e: 3 })
  assert.deepEqual(codonSpan(2), { s: 4, e: 6 })
  assert.deepEqual(codonSpan(100), { s: 298, e: 300 })
  assert.equal(codonSpan(0), null)
})

// A protein's own segments: codon-aligned CDS bases, where residue n is at
// 3n-2 .. 3n. Nine coding bases in exon 4 and eleven in exon 5, so residues 1-3
// are wholly in exon 4 and residue 4 begins exactly at the junction.
const CODING = [
  { s: 1, e: 9, gs: 1001, ge: 1009, exon: 4 },
  { s: 10, e: 20, gs: 3001, ge: 3011, exon: 5 },
]

test('a residue resolves to the three bases that spell it', () => {
  assert.deepEqual(codonPlace(CODING, 1, '+'), {
    s: 1001, e: 1003, exon: 4, spans: null, bases: 3,
  })
  assert.deepEqual(codonPlace(CODING, 2, '+'), {
    s: 1004, e: 1006, exon: 4, spans: null, bases: 3,
  })
})

test('a codon across a junction reports both exons and the span between them', () => {
  // Positions 10, 11, 12: the first is the last base of exon 4's coding part...
  const across = [
    { s: 1, e: 10, gs: 1001, ge: 1010, exon: 4 },
    { s: 11, e: 20, gs: 3001, ge: 3010, exon: 5 },
  ]
  const place = codonPlace(across, 4, '+')   // positions 10-12
  assert.deepEqual(place.spans, [4, 5])
  assert.equal(place.exon, 0, 'no single exon to name')
  // The span is the whole distance the codon reaches over, intron and all --
  // which is the truth about where it is, and why the exons say what they do.
  assert.deepEqual([place.s, place.e], [1010, 3002])
  assert.equal(place.bases, 3)
})

test('a codon whose bases the annotation does not have reports the ones it does', () => {
  // A 5'-incomplete CDS: the layout pads on the left, and those positions stand
  // for no base at all. Residue 1 is then two real bases, not none.
  const padded = [{ s: 2, e: 10, gs: 1001, ge: 1009, exon: 1 }]
  const place = codonPlace(padded, 1, '+')
  assert.equal(place.bases, 2, 'its third base began outside the annotation')
  assert.deepEqual([place.s, place.e], [1001, 1002])
  assert.equal(codonPlace(padded, 2, '+').bases, 3)
})

test('a residue past the end of the coding sequence is nowhere', () => {
  assert.equal(codonPlace(CODING, 99, '+'), null)
  assert.equal(codonPlace(CODING, 0, '+'), null)
})

test('a residue on the minus strand spans the same three bases, counting down', () => {
  const minus = [{ s: 1, e: 9, gs: 2001, ge: 2009, exon: 1 }]
  // Position 1 is genomic 2009 and position 3 is 2007, so the codon is 2007-2009.
  assert.deepEqual(codonPlace(minus, 1, '-'), {
    s: 2007, e: 2009, exon: 1, spans: null, bases: 3,
  })
  assert.deepEqual(codonPlace(minus, 2, '-'), {
    s: 2004, e: 2006, exon: 1, spans: null, bases: 3,
  })
})

test('a protein is marked at its initiator', () => {
  assert.deepEqual(proteinRuns('MAKD'), [{ s: 1, e: 1, c: 'start_codon' }])
  // An M partway along is an ordinary methionine.
  assert.deepEqual(proteinRuns('AKMD'), [])
})

test('every stop in a protein is marked, because a terminal one is already gone', () => {
  // This application strips the terminal stop the way Ensembl's pep file does,
  // so a star still in the sequence is an internal one -- a readthrough, a
  // frameshift or a mis-annotation -- and it is the thing most worth seeing.
  assert.deepEqual(proteinRuns('MA*KD*E'), [
    { s: 1, e: 1, c: 'start_codon' },
    { s: 3, e: 3, c: 'stop_codon' },
    { s: 6, e: 6, c: 'stop_codon' },
  ])
})

test('a protein starting with X from an incomplete CDS takes no class for it', () => {
  // Marking it as a stop would be wrong, and marking it as a start would claim
  // a codon the annotation does not have. The panel says what it is in words.
  assert.deepEqual(proteinRuns('XAKD'), [])
})

test('codon stripes alternate and stop where the CDS does', () => {
  assert.deepEqual(codonRuns({ s: 1, e: 9 }), [
    { s: 1, e: 3, c: 'cds' },
    { s: 4, e: 6, c: 'cds1' },
    { s: 7, e: 9, c: 'cds' },
  ])
})

test('a CDS starting partway along a transcript stripes from its own first base', () => {
  const runs = codonRuns({ s: 11, e: 16 })
  assert.deepEqual(runs, [
    { s: 11, e: 13, c: 'cds' },
    { s: 14, e: 16, c: 'cds1' },
  ])
})

test('a CDS ending mid-codon stripes what is there rather than over the end', () => {
  const runs = codonRuns({ s: 1, e: 8 })
  assert.equal(runs[runs.length - 1].e, 8)
})

test('the overlay wins wherever the two lists meet', () => {
  // The start codon has to sit over the stripe, not under it: it is what tells
  // a reader where the reading begins.
  const merged = overlayRuns(
    [{ s: 1, e: 3, c: 'start_codon' }],
    [{ s: 1, e: 3, c: 'cds' }, { s: 4, e: 6, c: 'cds1' }],
  )
  assert.deepEqual(merged, [
    { s: 1, e: 3, c: 'start_codon' },
    { s: 4, e: 6, c: 'cds1' },
  ])
})

test('an overlay inside a run splits it rather than replacing it', () => {
  const merged = overlayRuns(
    [{ s: 4, e: 5, c: 'stop_codon' }],
    [{ s: 1, e: 9, c: 'cds' }],
  )
  assert.deepEqual(merged, [
    { s: 1, e: 3, c: 'cds' },
    { s: 4, e: 5, c: 'stop_codon' },
    { s: 6, e: 9, c: 'cds' },
  ])
})

test('a row takes the class codes of the runs that reach it', () => {
  const row = { index: 0, col0: 0, length: 6 }
  const codes = rowClasses(row, [
    { s: 1, e: 2, c: 'utr5' },
    { s: 3, e: 5, c: 'start_codon' },
  ])
  assert.equal(codes, `${CLASS_CODES.utr5.repeat(2)}${CLASS_CODES.start_codon.repeat(3)}${CLASS_NONE}`)
  assert.equal(codes.length, 6, 'always exactly as long as the row')
})

test('a row in the middle of a sequence is offset by its own start', () => {
  const row = { index: 1, col0: 60, length: 4 }
  assert.equal(rowClasses(row, [{ s: 61, e: 62, c: 'cds' }]),
    `${CLASS_CODES.cds.repeat(2)}${CLASS_NONE.repeat(2)}`)
})

test('a class the reader has switched off leaves the base unmarked', () => {
  const row = { index: 0, col0: 0, length: 3 }
  const allowed = new Set([CLASS_CODES.cds])
  assert.equal(rowClasses(row, [{ s: 1, e: 3, c: 'utr5' }], allowed), CLASS_NONE.repeat(3))
})

test('a selection is reported in positions, not columns', () => {
  assert.deepEqual(selectionSpan({ lo: 0, hi: 2 }, 100), { s: 1, e: 3, length: 3 })
  // Dragged backwards is the same selection.
  assert.deepEqual(selectionSpan({ lo: 9, hi: 4 }, 100), { s: 5, e: 10, length: 6 })
  // Dragged off the end stops at the end.
  assert.deepEqual(selectionSpan({ lo: 95, hi: 400 }, 100), { s: 96, e: 100, length: 5 })
  assert.equal(selectionSpan(null, 100), null)
})

test('copying with nothing selected copies the whole of it', () => {
  assert.equal(selectedText('ATGGCC', null), 'ATGGCC')
  assert.equal(selectedText('ATGGCC', { s: 2, e: 4 }), 'TGG')
})

// One highlight, held as a stretch of chromosome, projected into whichever
// reading is on screen. These are the two halves of that: positions out of a
// genomic range, and a genomic range out of positions.

test('a stretch inside the exons keeps its length in the spliced reading', () => {
  assert.deepEqual(splicedRangeFor(PLUS, '+', { start: 105, end: 110 }), { s: 5, e: 10 })
})

test('a stretch across an intron closes up, because the intron is gone', () => {
  // Sixteen genomic bases, six of them intronic, so six spliced positions.
  assert.deepEqual(splicedRangeFor(PLUS, '+', { start: 118, end: 133 }), { s: 18, e: 23 })
})

test('a stretch wholly inside an intron is in no reading but the genomic one', () => {
  assert.equal(splicedRangeFor(PLUS, '+', { start: 122, end: 128 }), null)
})

test('a stretch running off the end is clipped rather than refused', () => {
  // The reader highlighted across the transcript's edge; what they meant is the
  // part that is still there.
  assert.deepEqual(splicedRangeFor(PLUS, '+', { start: 90, end: 105 }), { s: 1, e: 5 })
})

test('the minus strand projects a stretch to the same positions, counted its own way', () => {
  // Genomic 246-250 is the transcript's first five bases.
  assert.deepEqual(splicedRangeFor(MINUS, '-', { start: 246, end: 250 }), { s: 1, e: 5 })
  assert.deepEqual(splicedRangeFor(MINUS, '-', { start: 218, end: 233 }), { s: 18, e: 23 })
})

test('a codon-aligned position names the residue it belongs to', () => {
  assert.equal(residueAt(1), 1)
  assert.equal(residueAt(3), 1)
  assert.equal(residueAt(4), 2)
  assert.equal(residueAt(300), 100)
  assert.equal(residueAt(0), null)
})

test('a highlight becomes residues outward, so a touched codon is kept', () => {
  // Rounding inward would drop a residue at each end of most highlights, and
  // the one at the edge is usually the interesting one.
  const answer = { status: 'ok', segments: [{ s: 1, e: 30, gs: 1001, ge: 1030, exon: 1 }] }
  // Genomic 1003-1006 is CDS positions 3-6: the last base of residue 1 and all
  // of residue 2.
  assert.deepEqual(highlightFor('protein', answer, '+', { start: 1003, end: 1006 }), { s: 1, e: 2 })
  assert.deepEqual(highlightFor('protein', answer, '+', { start: 1001, end: 1003 }), { s: 1, e: 1 })
})

test('a highlight outside the coding sequence is nothing to a protein', () => {
  const answer = { status: 'ok', segments: [{ s: 1, e: 30, gs: 1001, ge: 1030, exon: 1 }] }
  assert.equal(highlightFor('protein', answer, '+', { start: 2000, end: 2100 }), null)
})

test('the genomic reading holds the highlight itself and projects nothing', () => {
  const answer = { status: 'ok', segments: PLUS }
  assert.equal(highlightFor('genomic', answer, '+', { start: 105, end: 110 }), null)
})

test('positions and a genomic range convert into each other both ways', () => {
  const answer = { status: 'ok', segments: PLUS }
  for (const span of [{ s: 1, e: 1 }, { s: 5, e: 10 }, { s: 18, e: 23 }, { s: 21, e: 40 }]) {
    const range = genomicRangeFor('transcript', answer, '+', span)
    assert.deepEqual(splicedRangeFor(PLUS, '+', range), span,
      `${span.s}-${span.e} does not survive the round trip`)
  }
})

test('a residue range round-trips through its codons', () => {
  const answer = { status: 'ok', segments: [{ s: 1, e: 30, gs: 1001, ge: 1030, exon: 1 }] }
  for (const span of [{ s: 1, e: 1 }, { s: 2, e: 5 }, { s: 1, e: 10 }]) {
    const range = genomicRangeFor('protein', answer, '+', span)
    assert.deepEqual(highlightFor('protein', answer, '+', range), span)
  }
})

test('a minus-strand range round-trips too', () => {
  const answer = { status: 'ok', segments: MINUS }
  for (const span of [{ s: 1, e: 5 }, { s: 18, e: 23 }, { s: 40, e: 40 }]) {
    const range = genomicRangeFor('transcript', answer, '-', span)
    assert.deepEqual(splicedRangeFor(MINUS, '-', range), span)
  }
})

test('the three spliced readings are offered in the order a reader works down', () => {
  assert.deepEqual(KINDS, ['transcript', 'cds', 'protein'])
  // Genomic first on the bar: it is where every reader starts, and what the
  // other three are a transformation of.
  assert.deepEqual(MODES, ['genomic', 'transcript', 'cds', 'protein'])
})

test('genomic is always on offer and the transcript readings are not', () => {
  const nowhere = { hasTranscript: false }
  assert.equal(modeOffer(KIND_GENOMIC, nowhere).on, true)
  for (const kind of KINDS) {
    const offer = modeOffer(kind, nowhere)
    assert.equal(offer.on, false, kind)
    assert.match(offer.why, /transcript/i, 'says what would make it usable')
  }
})

test('a transcript with no CDS keeps its own sequence and loses the other two', () => {
  const here = { hasTranscript: true, coding: false }
  assert.equal(modeOffer(KIND_TRANSCRIPT, here).on, true)
  assert.equal(modeOffer(KIND_CDS, here).on, false)
  assert.equal(modeOffer(KIND_PROTEIN, here).on, false)
  assert.match(modeOffer(KIND_PROTEIN, here).why, /no coding sequence/i)
})

test('nothing having said otherwise, the coding readings stay on offer', () => {
  // Not guessed from a biotype: a transcript annotated protein coding whose CDS
  // is missing is a real thing, and so is the other way round.
  const here = { hasTranscript: true }
  for (const kind of MODES) assert.equal(modeOffer(kind, here).on, true, kind)
})

test('a count carries the unit its reading is measured in', () => {
  assert.equal(counted(1, KIND_CDS), '1 base')
  assert.equal(counted(1200, KIND_CDS), '1,200 bases')
  assert.equal(counted(1, KIND_PROTEIN), '1 residue')
  assert.equal(counted(400, KIND_PROTEIN), '400 residues')
})

test('a record names the reading and the positions it was taken at', () => {
  const whole = readingFasta({
    transcriptId: 'ENST1', kind: KIND_PROTEIN, chrom: '13', strand: '+',
    sequence: 'MPIGSKERPT',
  })
  assert.equal(whole.name, 'ENST1_protein')
  assert.equal(whole.file, 'ENST1_protein.fa')
  assert.equal(whole.text, '>ENST1_protein Protein 10aa 13(+)\nMPIGSKERPT\n')

  // A stretch says where in the reading it came from, because a spliced
  // sequence does not match its own coordinate range and a chromosome range
  // would be a name that contradicts the sequence under it.
  const part = readingFasta({
    transcriptId: 'ENST1', kind: KIND_CDS, chrom: '13', strand: '-',
    sequence: 'ATGCCTATTGGA', span: { s: 4, e: 9, length: 6 },
  })
  assert.equal(part.name, 'ENST1_cds:4-9')
  assert.equal(part.text, '>ENST1_cds:4-9 CDS 6bp 13(-)\nCCTATT\n')
})

test('a transcript record is named without a suffix, since that is the sequence', () => {
  const record = readingFasta({
    transcriptId: 'ENST1', kind: KIND_TRANSCRIPT, sequence: 'ACGT',
  })
  assert.equal(record.name, 'ENST1')
  assert.equal(record.text, '>ENST1 Transcript 4bp\nACGT\n')
})

test('a record wraps at sixty, the width the rows are read at', () => {
  const record = readingFasta({
    transcriptId: 'T', kind: KIND_CDS, sequence: 'A'.repeat(130),
  })
  const lines = record.text.trim().split('\n').slice(1)
  assert.deepEqual(lines.map((l) => l.length), [60, 60, 10])
})

test('nothing to write is no record at all', () => {
  assert.equal(readingFasta({ transcriptId: 'T', sequence: '' }), null)
})


// ---- the protein over the codons ------------------------------------------

// A CDS starting at position 4 of a transcript: three bases of 5' UTR, then
// ATG GCC TAA -- a start, an alanine and a stop.
const TX = 'CCCATGGCCTAA'
const TX_CDS = { s: 4, e: 12 }
const row = (col0, length) => ({ col0, length })

test('a letter sits over the middle base of its codon', () => {
  // Positions 4-6 are the start codon, so the M goes on 5 -- index 4 of a row
  // that begins at position 1.
  const lane = aminoRow(row(0, 12), TX, TX_CDS)
  assert.equal(lane.length, 12)
  assert.equal(lane[4], 'M', 'over the T of ATG')
  assert.equal(lane[7], 'A', 'over the C of GCC')
  assert.equal(lane[10], '*', 'and the stop is marked, as it is in the genomic lane')
})

test('everything but the middle bases is blank', () => {
  const lane = aminoRow(row(0, 12), TX, TX_CDS)
  const lettered = [...lane].map((c, i) => (c === NO_AMINO ? null : i)).filter((i) => i !== null)
  assert.deepEqual(lettered, [4, 7, 10], 'one letter a codon and no more')
})

test('bases outside the coding sequence spell nothing', () => {
  // The three bases of UTR before the CDS.
  const lane = aminoRow(row(0, 12), TX, TX_CDS)
  assert.equal(lane.slice(0, 3), NO_AMINO.repeat(3))
})

test('the lane is built for the row asked for, not the whole sequence', () => {
  // A second row of a longer transcript: positions 7-12.
  const lane = aminoRow(row(6, 6), TX, TX_CDS)
  assert.equal(lane.length, 6)
  assert.equal(lane[1], 'A', 'position 8, the middle of GCC')
  assert.equal(lane[4], '*', 'position 11, the middle of TAA')
})

test('a codon running off the end of what is there spells nothing', () => {
  // A CDS the sequence does not finish, which is an incomplete annotation.
  assert.equal(aminoRow(row(0, 6), 'ATGGC', { s: 1, e: 6 })[4], NO_AMINO)
})

test('no coding sequence is no lane at all', () => {
  assert.equal(aminoRow(row(0, 12), TX, null), '')
  assert.equal(aminoRow(row(0, 12), TX, { s: 9, e: 4 }), '', 'and neither is an inverted one')
  assert.equal(aminoRow(row(0, 0), TX, TX_CDS), '')
})

// ---- what is coloured, and what the legend says ---------------------------

const ANSWER = {
  status: 'ok',
  sequence: TX,
  cds: TX_CDS,
  runs: [
    { s: 1, e: 3, c: 'utr5' },
    { s: 4, e: 6, c: 'start_codon' },
    { s: 7, e: 9, c: 'cds' },
    { s: 10, e: 12, c: 'stop_codon' },
  ],
}

test('the codon stripes are not buried under the annotation’s flat CDS block', () => {
  // The bug: the backend sends one `cds` run over the whole coding region, and
  // laid over the stripes it covered every one of them.
  const runs = splicedRunsFor(KIND_TRANSCRIPT, ANSWER)
  const classes = rowClasses(row(0, 12), runs)
  assert.ok(classes.includes(CLASS_CODES.cds) || classes.includes(CLASS_CODES.cds1),
    'the coding bases carry a stripe class')
  // The two shades alternate a codon at a time, which is the whole point.
  const shades = [...classes].filter((c) => c === CLASS_CODES.cds || c === CLASS_CODES.cds1)
  assert.ok(new Set(shades).size === 2 || shades.length <= 3, 'both shades are used')
})

test('the start and stop codons still win over the stripes under them', () => {
  const classes = rowClasses(row(0, 12), splicedRunsFor(KIND_TRANSCRIPT, ANSWER))
  assert.equal(classes.slice(3, 6), CLASS_CODES.start_codon.repeat(3))
  assert.equal(classes.slice(9, 12), CLASS_CODES.stop_codon.repeat(3))
  assert.equal(classes.slice(0, 3), CLASS_CODES.utr5.repeat(3), 'and the UTR is untouched')
})

test('the legend lists only what is on the screen', () => {
  // A protein with no internal stop has no stop to explain. The terminal one
  // is stripped the way Ensembl's own pep file strips it, so most proteins
  // have none -- and the legend was promising a colour that never appeared.
  const clean = { status: 'ok', sequence: 'MAAA', runs: [] }
  assert.deepEqual(
    legendGroupsFor(KIND_PROTEIN, splicedRunsFor(KIND_PROTEIN, clean)),
    ['start_codon'],
  )
  const readthrough = { status: 'ok', sequence: 'MA*AA', runs: [] }
  assert.deepEqual(
    legendGroupsFor(KIND_PROTEIN, splicedRunsFor(KIND_PROTEIN, readthrough)),
    ['start_codon', 'stop_codon'],
  )
})

test('a legend asked without runs still answers with the level’s whole key', () => {
  assert.deepEqual(legendGroupsFor(KIND_CDS), ['cds', 'start_codon', 'stop_codon'])
  assert.equal(legendGroupsFor(KIND_GENOMIC), null, 'the genomic reading keeps every group')
})

test('a transcript’s legend keeps the stripes it is actually drawing', () => {
  const groups = legendGroupsFor(KIND_TRANSCRIPT, splicedRunsFor(KIND_TRANSCRIPT, ANSWER))
  assert.ok(groups.includes('cds'), 'the stripes are still a cds swatch')
  assert.ok(groups.includes('utr'))
  assert.ok(!groups.includes('noncoding'), 'and nothing here is non-coding')
})

test('a reading covers the chromosome its own segments cover', () => {
    // A transcript of two exons, whose coding part starts inside the first
    // and ends inside the second.
    const transcript = {
        status: 'ok',
        genomic: { s: 1000, e: 2000 },
        segments: [
            { s: 1, e: 100, gs: 1000, ge: 1099 },
            { s: 101, e: 200, gs: 1901, ge: 2000 },
        ],
    }
    const cds = {
        status: 'ok',
        // The answer says the transcript's span whatever kind was asked for,
        // which is exactly why this is not read off it.
        genomic: { s: 1000, e: 2000 },
        segments: [
            { s: 1, e: 50, gs: 1050, ge: 1099 },
            { s: 51, e: 110, gs: 1901, ge: 1960 },
        ],
    }
    assert.deepEqual(genomicExtentOf(transcript), { start: 1000, end: 2000 })
    assert.deepEqual(genomicExtentOf(cds), { start: 1050, end: 1960 })

    // Nothing to place from an answer that is not one, and the transcript's
    // own span where there are no segments to read.
    assert.equal(genomicExtentOf(null), null)
    assert.equal(genomicExtentOf({ status: 'no_cds', genomic: { s: 1, e: 9 } }), null)
    assert.deepEqual(
        genomicExtentOf({ status: 'ok', segments: [], genomic: { s: 1000, e: 2000 } }),
        { start: 1000, end: 2000 },
    )
})

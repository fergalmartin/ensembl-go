import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRowClasses,
  cdsStripeAt,
  classAtCoord,
  findRunIndex,
  geneEdgeMaskForRow,
  orientRowForDisplay,
} from '../src/utils/sequenceViewClasses.js'
import {
  CLASS_CODES,
  CLASS_NONE,
  LEVEL_GROUPS,
  classStyle,
  classesForLevel,
  defaultHighlights,
} from '../src/utils/sequenceViewPalette.js'
import { PLACEHOLDER_BASE } from '../src/utils/sequenceViewChunks.js'

// A small two-exon transcript on the forward strand. The CDS is split by an
// intron, which is the case codon framing has to survive.
const runs = [
  { s: 101, e: 110, c: 'utr5' },
  { s: 111, e: 120, c: 'cds' },
  { s: 121, e: 130, c: 'intron' },
  { s: 131, e: 140, c: 'cds' },
  { s: 141, e: 150, c: 'utr3' },
]
// Spliced-CDS offsets: the second segment carries on from where the first left off.
const cdsFrame = [{ s: 111, e: 120, o: 0 }, { s: 131, e: 140, o: 10 }]

const allOn = (level) => new Set(classesForLevel(level).keys())

test('a run is found by binary search, and a gap reports nothing', () => {
  assert.equal(findRunIndex(runs, 101), 0)
  assert.equal(findRunIndex(runs, 140), 3)
  assert.equal(findRunIndex(runs, 100), -1)
  assert.equal(findRunIndex(runs, 151), -1)
  assert.equal(findRunIndex([], 5), -1)
  assert.equal(classAtCoord(runs, 125), 'intron')
  assert.equal(classAtCoord(runs, 99), null)
})

test('codons keep their frame across an intron', () => {
  // The codon at spliced offsets 9, 10, 11 spans the splice junction: its bases
  // are genomic 120, 131 and 132, and all three must take the same shade.
  assert.equal(cdsStripeAt(cdsFrame, 120, '+'), 1)
  assert.equal(cdsStripeAt(cdsFrame, 131, '+'), 1)
  assert.equal(cdsStripeAt(cdsFrame, 132, '+'), 1)
  assert.equal(cdsStripeAt(cdsFrame, 133, '+'), 0, 'the next codon flips')

  // The first codon of the CDS.
  assert.equal(cdsStripeAt(cdsFrame, 111, '+'), 0)
  assert.equal(cdsStripeAt(cdsFrame, 113, '+'), 0)
  assert.equal(cdsStripeAt(cdsFrame, 114, '+'), 1)

  assert.equal(cdsStripeAt(cdsFrame, 125, '+'), null, 'not in coding sequence')
  assert.equal(cdsStripeAt([], 111, '+'), null)
})

test('on the reverse strand the frame is counted from the other end', () => {
  // Ascending by coordinate, like every other run list — the spliced offsets
  // carry the biological direction, so the list itself never has to.
  const reverseFrame = [{ s: 111, e: 120, o: 10 }, { s: 131, e: 140, o: 0 }]
  // Reading 5' to 3' on the minus strand starts at 140.
  assert.equal(cdsStripeAt(reverseFrame, 140, '-'), 0)
  assert.equal(cdsStripeAt(reverseFrame, 138, '-'), 0)
  assert.equal(cdsStripeAt(reverseFrame, 137, '-'), 1)
  // Again the codon that crosses the junction holds together: offsets 9, 10, 11
  // are genomic 131, 120 and 119.
  assert.equal(cdsStripeAt(reverseFrame, 131, '-'), 1)
  assert.equal(cdsStripeAt(reverseFrame, 120, '-'), 1)
  assert.equal(cdsStripeAt(reverseFrame, 119, '-'), 1)
  assert.equal(cdsStripeAt(reverseFrame, 118, '-'), 0)
})

test('a row is classed one code per base, alternating the CDS shades', () => {
  const row = { start: 101, end: 160 }
  const classes = buildRowClasses({ row, runs, cdsFrame, strand: '+', allowed: allOn('transcript') })
  assert.equal(classes.length, 60)
  assert.equal(classes.slice(0, 10), CLASS_CODES.utr5.repeat(10))
  assert.equal(classes.slice(10, 20), 'cccCCCcccC')
  assert.equal(classes.slice(20, 30), CLASS_CODES.intron.repeat(10))
  assert.equal(classes.slice(30, 40), 'CCcccCCCcc')
  assert.equal(classes.slice(40, 50), CLASS_CODES.utr3.repeat(10))
  assert.equal(classes.slice(50), CLASS_NONE.repeat(10), 'past the last run')
})

test('a class switched off falls back to no class, leaving the rest alone', () => {
  const row = { start: 101, end: 160 }
  const withoutIntrons = new Set(allOn('transcript'))
  withoutIntrons.delete(CLASS_CODES.intron)
  const classes = buildRowClasses({ row, runs, cdsFrame, strand: '+', allowed: withoutIntrons })
  assert.equal(classes.slice(20, 30), CLASS_NONE.repeat(10))
  assert.equal(classes.slice(10, 20), 'cccCCCcccC', 'the CDS is untouched')
  assert.equal(classes.length, 60, 'and the row is the same size, so nothing moves')
})

test('coding sequence with no verified frame is flat rather than wrongly striped', () => {
  const row = { start: 111, end: 120 }
  const classes = buildRowClasses({ row, runs, cdsFrame: [], strand: '+', allowed: allOn('transcript') })
  assert.equal(classes, CLASS_CODES.cds.repeat(10))
})

test('soft-masking sits under everything else, and is off unless asked for', () => {
  const row = { start: 101, end: 130 }
  const masked = [{ s: 105, e: 125 }]
  const on = new Set(allOn('transcript'))

  const shown = buildRowClasses({ row, runs, cdsFrame, strand: '+', allowed: on, masked })
  // Where a feature already claimed the base, the feature wins.
  assert.equal(shown[4], CLASS_CODES.utr5)
  assert.equal(shown[14], CLASS_CODES.cds1)

  // With no run over it, the mask shows through.
  const bare = buildRowClasses({ row: { start: 200, end: 209 }, runs, allowed: on, masked: [{ s: 200, e: 204 }] })
  assert.equal(bare, CLASS_CODES.softmask.repeat(5) + CLASS_NONE.repeat(5))

  const off = new Set(on)
  off.delete(CLASS_CODES.softmask)
  const hidden = buildRowClasses({ row: { start: 200, end: 209 }, runs, allowed: off, masked: [{ s: 200, e: 204 }] })
  assert.equal(hidden, CLASS_NONE.repeat(10))
  assert.equal(defaultHighlights('transcript').softmask, false, 'off by default')
})

test('a row is flipped for reverse reading, sequence and classes together', () => {
  const oriented = orientRowForDisplay(
    { sequence: 'ATGCAA', classes: 'cCiu.5', mask: '110000', edges: '500000' },
    true,
  )
  assert.equal(oriented.sequence, 'TTGCAT')
  assert.equal(oriented.classes, '5.uiCc')
  assert.equal(oriented.mask, '000011')
  // A gene's start is still its start, but it is now on the right of the screen,
  // so the mark changes side as well as position. The overlap bit travels with
  // it unchanged: how many genes cover a base does not depend on which way it
  // is read. (5 = start + overlap, so 6 = end + overlap.)
  assert.equal(oriented.edges, '000006')
  // Forward is the identity, not a copy with the same content.
  const forward = orientRowForDisplay({ sequence: 'ATGC', classes: 'cccc', mask: '0000' })
  assert.equal(forward.sequence, 'ATGC')
  assert.equal(forward.classes, 'cccc')
})

test('a base that has not loaded has no complement', () => {
  const oriented = orientRowForDisplay(
    { sequence: `AC${PLACEHOLDER_BASE}G`, classes: '....', mask: '0000' },
    true,
  )
  assert.equal(oriented.sequence, `C${PLACEHOLDER_BASE}GT`)
  assert.equal(oriented.sequence.length, 4, 'a placeholder still occupies its cell')
})


test('every level offers toggles, and every class it emits has a colour', () => {
  for (const level of ['location', 'gene', 'transcript', 'feature', 'custom']) {
    const groups = LEVEL_GROUPS[level]
    assert.ok(Array.isArray(groups) && groups.length > 0, `${level} has toggles`)
    for (const group of groups) {
      assert.ok(group.swatch, `${level}/${group.key} has a swatch`)
      for (const code of group.classes) {
        assert.ok(classStyle(code)?.bg, `${level}/${group.key} class ${code} has a colour`)
      }
    }
    assert.deepEqual(
      Object.keys(defaultHighlights(level)).sort(),
      groups.map((group) => group.key).sort(),
    )
  }
})

test('an exon or intron focus is described exactly as its transcript is', () => {
  // Same classes, same toggles — only the window differs, so there is one code
  // path rather than two that could drift apart.
  assert.equal(LEVEL_GROUPS.feature, LEVEL_GROUPS.transcript)
  assert.equal(LEVEL_GROUPS.custom, LEVEL_GROUPS.transcript)
})

test('the gene level names the five states a base can be in across isoforms', () => {
  assert.deepEqual(
    LEVEL_GROUPS.gene.map((group) => group.key),
    ['coding', 'utr', 'noncoding', 'intron', 'mixed'],
  )
  const mixed = LEVEL_GROUPS.gene.find((group) => group.key === 'mixed')
  assert.match(mixed.hint, /disagree/, 'mixed explains itself')
  // Mixed must not be mistakeable for a weaker version of another class.
  const others = LEVEL_GROUPS.gene.filter((g) => g.key !== 'mixed').map((g) => g.swatch)
  assert.ok(!others.includes(mixed.swatch))
})

// The marks channel is a hex digit per cell: 1 a gene's first base, 2 its last,
// 4 a base more than one gene covers. Bits rather than characters because a base
// can be more than one of those at once.
test('a highlighted gene is marked where it begins and where it ends', () => {
  //            coords 100 .. 109, so the gene's edges fall at offsets 2 and 7
  const row = { start: 100, end: 109 }
  assert.equal(geneEdgeMaskForRow(row, [{ id: 'G1', s: 102, e: 107 }]), '0010000200')
})

test('several highlighted genes are all marked', () => {
  const row = { start: 100, end: 109 }
  const genes = [{ id: 'A', s: 100, e: 103 }, { id: 'B', s: 105, e: 109 }]
  assert.equal(geneEdgeMaskForRow(row, genes), '1002010002')
})

test('a gene reaching past the row is marked only where its edge falls inside', () => {
  const row = { start: 100, end: 109 }
  assert.equal(geneEdgeMaskForRow(row, [{ id: 'G', s: 1, e: 105 }]), '0000020000')
  assert.equal(geneEdgeMaskForRow(row, [{ id: 'G', s: 105, e: 9999 }]), '0000010000')
  assert.equal(geneEdgeMaskForRow(row, [{ id: 'G', s: 1, e: 9999 }]), '0000000000', 'neither edge in view')
})

test('overlapping genes are marked under every base they share', () => {
  const row = { start: 100, end: 109 }
  const marks = geneEdgeMaskForRow(row, [], [{ s: 103, e: 106, n: 2 }])
  assert.equal(marks, '0004444000')
})

test('an edge and an overlap can fall on the same base', () => {
  // A gene beginning inside another one: both are true of that base, and one
  // must not displace the other.
  const row = { start: 100, end: 109 }
  const marks = geneEdgeMaskForRow(row, [{ id: 'B', s: 104, e: 108 }], [{ s: 104, e: 108, n: 2 }])
  assert.equal(marks[4], '5', 'gene start + overlap')
  assert.equal(marks[8], '6', 'gene end + overlap')
  assert.equal(marks[5], '4', 'overlap alone')
})

test('the feature under the pointer is marked across the whole row', () => {
  const row = { start: 100, end: 109 }
  assert.equal(
    geneEdgeMaskForRow(row, [], null, null, { s: 103, e: 106 }),
    '000gggg000',
    'g is 16 in base 32',
  )
  // Reaching in from outside, only the part inside is marked.
  assert.equal(geneEdgeMaskForRow(row, [], null, null, { s: 1, e: 102 }), 'ggg0000000')
  assert.equal(geneEdgeMaskForRow(row, [], null, null, { s: 200, e: 300 }), '0000000000')
})

test('a marked base can be five things at once', () => {
  // Five marks in one character is what the move to base 32 bought; the row is
  // still four equal-length strings, which is what the memoised row compares.
  const row = { start: 100, end: 109 }
  const marks = geneEdgeMaskForRow(
    row,
    [{ id: 'G', s: 104, e: 108 }],
    [{ s: 104, e: 108, n: 2 }],
    104,
    { s: 104, e: 108 },
  )
  assert.equal(parseInt(marks[4], 32), 1 + 4 + 8 + 16, 'start + overlap + asked about + pointed at')
})

test('an overlap outside the row does not mark it', () => {
  const row = { start: 100, end: 109 }
  assert.equal(geneEdgeMaskForRow(row, [], [{ s: 1, e: 50, n: 2 }]), '0000000000')
  // One reaching in from outside marks only the part inside.
  assert.equal(geneEdgeMaskForRow(row, [], [{ s: 1, e: 102, n: 3 }]), '4440000000')
})

test('nothing highlighted is a row of no marks, never an empty string', () => {
  assert.equal(geneEdgeMaskForRow({ start: 1, end: 5 }, []), '00000')
  assert.equal(geneEdgeMaskForRow({ start: 1, end: 5 }, null), '00000')
  assert.equal(geneEdgeMaskForRow(null, []), '')
})

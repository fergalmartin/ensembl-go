import test from 'node:test'
import assert from 'node:assert/strict'

import {
    COORDINATE_WINDOW,
    clampNote,
    clampToChromosome,
    parseSearchQuery,
    withinOpenRegion,
} from '../src/utils/sequenceViewSearch.js'

// Chromosome 1 of GRCh38, which is the case this was written for.
const CHR1 = { start: 1, end: 248_956_422 }

test('a range names both of its ends, on a chromosome or on the one already open', () => {
    assert.deepEqual(parseSearchQuery('1:1000-2000', '7'), {
        kind: 'range', query: '1:1000-2000', chrom: '1', start: 1000, end: 2000,
    })
    assert.deepEqual(parseSearchQuery('1000-2000', '7'), {
        kind: 'range', query: '1000-2000', chrom: '7', start: 1000, end: 2000,
    })
})

test('the separators the gutters print are the ones a reader pastes back', () => {
    const parsed = parseSearchQuery('1:119,648,351-119,744,287')
    assert.equal(parsed.kind, 'range')
    assert.equal(parsed.start, 119_648_351)
    assert.equal(parsed.end, 119_744_287)
    // And the spaces a reader leaves around the punctuation.
    assert.deepEqual(
        parseSearchQuery('X : 10 - 20').start,
        10,
    )
    assert.equal(parseSearchQuery('X : 10 - 20').chrom, 'X')
})

test('a range typed the other way round is still that range', () => {
    const parsed = parseSearchQuery('1:200000-100000')
    assert.equal(parsed.start, 100_000)
    assert.equal(parsed.end, 200_000)
})

test('a range never begins before the first base of the chromosome', () => {
    assert.equal(parseSearchQuery('1:0-500').start, 1)
})

test('a bare coordinate is a destination, framed by a screenful either side', () => {
    const parsed = parseSearchQuery('119711874', '1')
    assert.equal(parsed.kind, 'coordinate')
    assert.equal(parsed.chrom, '1')
    assert.equal(parsed.at, 119_711_874)
    assert.equal(parsed.start, 119_711_874 - COORDINATE_WINDOW)
    assert.equal(parsed.end, 119_711_874 + COORDINATE_WINDOW)
    // Near the start of a chromosome the window is clipped rather than negative.
    assert.equal(parseSearchQuery('10').start, 1)
})

test('anything else is a name for the annotation to answer', () => {
    assert.deepEqual(parseSearchQuery('PHGDH'), { kind: 'name', query: 'PHGDH' })
    assert.deepEqual(parseSearchQuery('ENSG00000092621'), { kind: 'name', query: 'ENSG00000092621' })
    // A chromosome with no coordinates is not a region either.
    assert.equal(parseSearchQuery('chr1').kind, 'name')
})

test('an empty box asks for nothing', () => {
    assert.equal(parseSearchQuery(''), null)
    assert.equal(parseSearchQuery('   '), null)
    assert.equal(parseSearchQuery(null), null)
    assert.equal(parseSearchQuery(undefined), null)
})

const open = { chrom: '1', location: { start: 1, end: 245_000_000 } }

test('a range inside the region already open still reframes to it', () => {
    // The bug: opening a chromosome and then asking for five megabases of it did
    // nothing at all, because the new range was inside the old one and was taken
    // for a jump to a base already on screen. Every narrower range after that
    // was inside the first, so there was no way back out.
    for (const query of ['1:1-5000000', '1:1000000-1200000', '1:119648351-119744287']) {
        const parsed = parseSearchQuery(query, '1')
        assert.equal(parsed.kind, 'range')
        assert.equal(withinOpenRegion(parsed, open.chrom, open.location), false, query)
    }
})

test('a coordinate inside the region already open is a jump, not a reframe', () => {
    const parsed = parseSearchQuery('5000000', '1')
    assert.equal(withinOpenRegion(parsed, open.chrom, open.location), true)
})

test('a coordinate outside it has nothing to stay within', () => {
    const narrow = { chrom: '1', location: { start: 1_000_000, end: 1_200_000 } }
    assert.equal(
        withinOpenRegion(parseSearchQuery('5000000', '1'), narrow.chrom, narrow.location),
        false,
    )
    // Its screenful straddling the edge counts as outside, so the frame moves
    // rather than the page scrolling to a row that is not drawn.
    assert.equal(
        withinOpenRegion(parseSearchQuery('1000100', '1'), narrow.chrom, narrow.location),
        false,
    )
    assert.equal(
        withinOpenRegion(parseSearchQuery('1100000', '1'), narrow.chrom, narrow.location),
        true,
    )
})

test('a coordinate on another chromosome is never inside this one', () => {
    assert.equal(withinOpenRegion(parseSearchQuery('7:5000000'), open.chrom, open.location), false)
})

test('nothing is inside a region that is not open yet', () => {
    assert.equal(withinOpenRegion(parseSearchQuery('500', '1'), '1', null), false)
    assert.equal(withinOpenRegion(null, '1', open.location), false)
    assert.equal(withinOpenRegion(parseSearchQuery('PHGDH'), '1', open.location), false)
})


// ---- holding a typed range inside the chromosome --------------------------

test('a range past the end of the chromosome is brought back to it', () => {
    const typed = parseSearchQuery('1:1-999,999,999', '1')
    const held = clampToChromosome(typed, CHR1)
    assert.equal(held.start, 1)
    assert.equal(held.end, CHR1.end)
    assert.ok(held.clamped)
})

test('a range that fits is left exactly as it was typed', () => {
    const typed = parseSearchQuery('1:1,000-2,000', '1')
    const held = clampToChromosome(typed, CHR1)
    assert.equal(held.start, 1000)
    assert.equal(held.end, 2000)
    assert.ok(!held.clamped, 'and is not reported as having been moved')
})

test('a range touching the last base is not a range that was moved', () => {
    const typed = parseSearchQuery(`1:1-${CHR1.end}`, '1')
    assert.ok(!clampToChromosome(typed, CHR1).clamped)
})

test('a range entirely past the end collapses onto the last base', () => {
    // Not nothing, and not an error: the reader named somewhere that is not
    // there, and the nearest place that is there is the end.
    const typed = parseSearchQuery('1:900,000,000-999,000,000', '1')
    const held = clampToChromosome(typed, CHR1)
    assert.equal(held.start, CHR1.end)
    assert.equal(held.end, CHR1.end)
    assert.ok(held.clamped)
})

test('a range starting before the first base is brought forward to it', () => {
    const held = clampToChromosome(
        { kind: 'range', query: '', chrom: '1', start: -50, end: 400 }, CHR1,
    )
    assert.equal(held.start, 1)
    assert.equal(held.end, 400)
    assert.ok(held.clamped)
})

test('a bare coordinate is held inside, and so is the window around it', () => {
    const typed = parseSearchQuery('999,999,999', '1')
    const held = clampToChromosome(typed, CHR1)
    assert.equal(held.at, CHR1.end, 'the destination itself')
    assert.equal(held.end, CHR1.end, 'and the screenful framed around it')
    assert.ok(held.start <= held.end)
})

test('a coordinate near the start does not frame a window before base one', () => {
    const typed = parseSearchQuery('10', '1')
    const held = clampToChromosome(typed, CHR1)
    assert.equal(held.at, 10)
    assert.equal(held.start, 1, `not ${10 - COORDINATE_WINDOW}`)
})

test('a chromosome nobody has measured yet clamps nothing', () => {
    // Refusing to move until a lookup has arrived is worse than moving to a
    // region the backend will clip a moment later anyway.
    const typed = parseSearchQuery('1:1-999,999,999', '1')
    const held = clampToChromosome(typed, null)
    assert.equal(held.end, 999_999_999)
    assert.ok(!held.clamped)
})

test('a name is not a range and passes through untouched', () => {
    const typed = parseSearchQuery('PHGDH', '1')
    assert.equal(clampToChromosome(typed, CHR1), typed)
    assert.equal(clampToChromosome(null, CHR1), null)
})

test('the note says how long the chromosome is and what is being shown', () => {
    const held = clampToChromosome(parseSearchQuery('1:1-999,999,999', '1'), CHR1)
    const note = clampNote(held, CHR1, '1')
    assert.ok(note.includes('248,956,422'), 'how long it actually is')
    assert.ok(note.includes('1\u2013248,956,422') || note.includes('248,956,422'), 'and where the reader is')
    // Nothing to say where nothing was moved.
    assert.equal(clampNote(clampToChromosome(parseSearchQuery('1:10-20', '1'), CHR1), CHR1, '1'), '')
})

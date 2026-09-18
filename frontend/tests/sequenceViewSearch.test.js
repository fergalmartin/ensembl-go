import test from 'node:test'
import assert from 'node:assert/strict'

import {
    COORDINATE_WINDOW,
    parseSearchQuery,
    withinOpenRegion,
} from '../src/utils/sequenceViewSearch.js'

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

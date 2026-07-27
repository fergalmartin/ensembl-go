import test from 'node:test'
import assert from 'node:assert/strict'

import {
    VCF_BLOCK_LEVELS,
    buildVcfOverviewWarmupKey,
    buildVcfOverviewWarmupTiles,
    getVcfBlockLevel,
    getVcfViewportIntent,
} from '../src/utils/vcfTileStrategy.js'

test('VCF L0 overview stays coarse enough to warm a chromosome quickly', () => {
    const l0 = VCF_BLOCK_LEVELS[0]

    assert.equal(l0.id, 'L0')
    assert.equal(l0.tileSpanBp, 25_000_000)
    assert.equal(l0.blockBp, 25_000)
    assert.equal(l0.windowBp, 250_000)
})

test('VCF overview warmup covers the whole chromosome independently of viewport', () => {
    const l0 = VCF_BLOCK_LEVELS[0]
    const tiles = buildVcfOverviewWarmupTiles({ chromLength: 248_956_422 })

    assert.equal(tiles.length, 10)
    assert.equal(tiles[0].start, 0)
    assert.equal(tiles[0].end, l0.tileSpanBp)
    assert.equal(tiles.at(-1).start, 225_000_000)
    assert.equal(tiles.at(-1).end, 250_000_000)
    assert.deepEqual(
        tiles.map((tile) => tile.level_id).every((levelId) => levelId === 'L0'),
        true,
    )
})

test('VCF overview warmup key changes when the source or pyramid changes', () => {
    const base = buildVcfOverviewWarmupKey({
        trackId: 'track-a',
        path: '/tmp/chr1.vcf.gz',
        chrom: 'chr1',
        chromLength: 248_956_422,
    })
    const changedPath = buildVcfOverviewWarmupKey({
        trackId: 'track-a',
        path: '/tmp/other.vcf.gz',
        chrom: 'chr1',
        chromLength: 248_956_422,
    })

    assert.notEqual(base, '')
    assert.notEqual(base, changedPath)
})

test('VCF viewport intent detects zooming before background expansion', () => {
    const previous = { center: 1_000_000, span: 100_000, changedAt: 1000, intent: 'settled' }
    const next = getVcfViewportIntent({
        previous,
        center: 1_000_000,
        span: 40_000,
        nowMs: 1300,
    })

    assert.equal(next.intent, 'zooming')
})

test('VCF viewport intent detects panning when span is stable', () => {
    const previous = { center: 1_000_000, span: 100_000, changedAt: 1000, intent: 'settled' }
    const next = getVcfViewportIntent({
        previous,
        center: 1_050_000,
        span: 100_000,
        nowMs: 1600,
    })

    assert.equal(next.intent, 'panning')
})

test('VCF block level selects detail level for close zoom', () => {
    assert.equal(getVcfBlockLevel(2000).id, 'L0')
    assert.equal(getVcfBlockLevel(50).id, 'L2')
    assert.equal(getVcfBlockLevel(1).id, 'L4')
})

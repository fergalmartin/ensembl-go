import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildBrowserGeneSeedKey,
    buildBrowserViewportSeedKey,
    resolveAnchorRegionSeed,
    shouldApplyAnchorRegion,
    shouldSeedFromBrowser,
    shouldSeedFromBrowserViewport,
} from '../src/components/svViewportSeeding.js'

// ---------------------------------------------------------------------------
// Seed keys
// ---------------------------------------------------------------------------

test('a browser viewport seed key is stable for an unchanged viewport', () => {
    const viewport = { chrom: '11', start: 49_490_090.4, end: 49_945_992.6 }
    assert.equal(buildBrowserViewportSeedKey(viewport), buildBrowserViewportSeedKey({ ...viewport }))
})

test('a browser viewport seed key changes when the browser moves', () => {
    const a = buildBrowserViewportSeedKey({ chrom: '11', start: 100, end: 200 })
    const b = buildBrowserViewportSeedKey({ chrom: '1', start: 100, end: 200 })
    const c = buildBrowserViewportSeedKey({ chrom: '11', start: 150, end: 250 })
    assert.notEqual(a, b)
    assert.notEqual(a, c)
})

test('an unusable viewport produces no key, so it can never seed', () => {
    for (const bad of [null, {}, { chrom: '' }, { chrom: '1', start: 5, end: 5 }, { chrom: '1', start: 9, end: 2 }]) {
        assert.equal(buildBrowserViewportSeedKey(bad), '')
        assert.equal(shouldSeedFromBrowser({ seededKey: '', candidateKey: buildBrowserViewportSeedKey(bad) }), false)
    }
})

test('gene and viewport seeds cannot collide', () => {
    const gene = buildBrowserGeneSeedKey({ id: 'g', chrom: '11', start: 1, end: 2 })
    const viewport = buildBrowserViewportSeedKey({ chrom: '11', start: 1, end: 2 })
    assert.notEqual(gene, viewport)
})

// ---------------------------------------------------------------------------
// Browser seeding across a remount — the actual bug
// ---------------------------------------------------------------------------

test('a remount does not re-seed from an unchanged browser position', () => {
    const key = buildBrowserViewportSeedKey({ chrom: '1', start: 1, end: 500_000 })
    assert.equal(shouldSeedFromBrowser({ seededKey: key, candidateKey: key }), false)
})

test('a restored viewport beats the browser viewport, even when the browser moved', () => {
    // The reported failure, exactly: view chromosome 11 in SV, switch to the
    // genome browser (which republishes its own viewport, chromosome 1 by
    // default, under a different key), switch back. A key guard alone lets that
    // through, which is how the view ended up on chromosome 1 while the region
    // selector still said 11 and the third genome failed to align.
    const before = buildBrowserViewportSeedKey({ chrom: '1', start: 1, end: 500_000 })
    const after = buildBrowserViewportSeedKey({ chrom: '1', start: 250_000, end: 900_000 })
    assert.equal(shouldSeedFromBrowser({ seededKey: before, candidateKey: after }), true)
    assert.equal(
        shouldSeedFromBrowserViewport({ seededKey: before, candidateKey: after, hasRestoredViewport: true }),
        false,
    )
})

test('a first entry still opens where the genome browser is', () => {
    const key = buildBrowserViewportSeedKey({ chrom: '7', start: 1, end: 500_000 })
    assert.equal(
        shouldSeedFromBrowserViewport({ seededKey: '', candidateKey: key, hasRestoredViewport: false }),
        true,
    )
})

test('focusing a gene still moves the view, restored viewport or not', () => {
    // A focused gene is a deliberate act, unlike the browser's ambient viewport,
    // so it keeps the plain key guard.
    const before = buildBrowserGeneSeedKey({ id: 'a', chrom: '11', start: 1, end: 2 })
    const after = buildBrowserGeneSeedKey({ id: 'b', chrom: '3', start: 9, end: 10 })
    assert.equal(shouldSeedFromBrowser({ seededKey: before, candidateKey: after }), true)
    assert.equal(shouldSeedFromBrowser({ seededKey: after, candidateKey: after }), false)
})

test('the first ever mount does seed from the browser', () => {
    const key = buildBrowserViewportSeedKey({ chrom: '7', start: 1, end: 500_000 })
    assert.equal(shouldSeedFromBrowser({ seededKey: '', candidateKey: key }), true)
})

test('moving the genome browser still re-seeds the view', () => {
    const before = buildBrowserViewportSeedKey({ chrom: '1', start: 1, end: 500_000 })
    const after = buildBrowserViewportSeedKey({ chrom: '7', start: 1, end: 500_000 })
    assert.equal(shouldSeedFromBrowser({ seededKey: before, candidateKey: after }), true)
})

// ---------------------------------------------------------------------------
// Anchor region precedence
// ---------------------------------------------------------------------------

const anchor = (over = {}) => ({
    regionKey: 'aln|11|1-2',
    seededRegionKey: 'aln|11|1-2',
    regionChrom: '11',
    windowChrom: '11',
    seededBrowserKey: 'viewport|11|1|2',
    regionSeedBrowserKey: 'viewport|11|1|2',
    ...over,
})

test('a newly selected region is applied', () => {
    assert.equal(shouldApplyAnchorRegion(anchor({ seededRegionKey: 'aln|7|1-2' })), true)
})

test('an already applied region is not re-applied', () => {
    assert.equal(shouldApplyAnchorRegion(anchor()), false)
})

test('a view that drifted off the selected chromosome snaps back', () => {
    // Otherwise inescapable: the region counts as applied, so re-picking it in
    // the selector does nothing and the error keeps naming chromosome 1.
    assert.equal(shouldApplyAnchorRegion(anchor({ windowChrom: '1' })), true)
})

test('drift is ignored when the genome browser moved the view on purpose', () => {
    assert.equal(shouldApplyAnchorRegion(anchor({
        windowChrom: '1',
        seededBrowserKey: 'viewport|1|1|500000',
        regionSeedBrowserKey: 'viewport|11|1|2',
    })), false)
})

test('no region selected means nothing to apply', () => {
    assert.equal(shouldApplyAnchorRegion(anchor({ regionKey: '' })), false)
})

test('an unknown window chromosome is not treated as drift', () => {
    // Before the first window exists there is nothing to compare against, and
    // guessing would re-apply the region on every render.
    assert.equal(shouldApplyAnchorRegion(anchor({ windowChrom: '' })), false)
    assert.equal(shouldApplyAnchorRegion(anchor({ windowChrom: null })), false)
})

test('drift recovery is capped at one attempt per region', () => {
    // The region name the user picked and the name the applied window carries
    // are resolved separately. If they can never compare equal, an uncapped
    // recovery would re-apply the region on every render forever.
    const drifting = anchor({ windowChrom: 'NC_000011.10' })
    assert.equal(resolveAnchorRegionSeed(drifting), 'drift')
    assert.equal(resolveAnchorRegionSeed({ ...drifting, driftRecoveredKey: drifting.regionKey }), '')
})

test('a cap on one region does not block recovery for another', () => {
    const other = anchor({ regionKey: 'aln|7|1-2', seededRegionKey: 'aln|7|1-2', regionChrom: '7', windowChrom: '1' })
    assert.equal(resolveAnchorRegionSeed({ ...other, driftRecoveredKey: 'aln|11|1-2' }), 'drift')
})

test('resolveAnchorRegionSeed reports why it fired', () => {
    assert.equal(resolveAnchorRegionSeed(anchor({ seededRegionKey: 'aln|7|1-2' })), 'changed')
    assert.equal(resolveAnchorRegionSeed(anchor({ windowChrom: '1' })), 'drift')
    assert.equal(resolveAnchorRegionSeed(anchor()), '')
})

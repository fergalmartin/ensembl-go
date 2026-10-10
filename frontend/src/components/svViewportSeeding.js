/**
 * Choose the initial Structural Variation region from browser state.
 *
 * An explicit SV selection survives remounts. A newly focused browser gene may
 * seed a region, but ambient viewport reports must not overwrite a selection
 * when the user switches views.
 */

const token = (value) => String(value ?? '').trim()

export function buildBrowserGeneSeedKey(gene) {
    const chrom = token(gene?.chrom)
    if (!chrom) return ''
    return `gene|${token(gene?.id)}|${chrom}|${gene?.start ?? ''}|${gene?.end ?? ''}`
}

export function buildBrowserViewportSeedKey(viewport) {
    const chrom = token(viewport?.chrom)
    const start = Number(viewport?.start)
    const end = Number(viewport?.end)
    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return ''
    return `viewport|${chrom}|${Math.round(start)}|${Math.round(end)}`
}

/**
 * Seed from the genome browser's FOCUSED GENE.
 *
 * Focusing a gene is a deliberate act, and the key is stable while the focus is
 * unchanged, so a remount-surviving key guard is enough here: re-entering the
 * view with the same gene focused does nothing.
 */
export function shouldSeedFromBrowser({ seededKey, candidateKey }) {
    if (!candidateKey) return false
    return token(seededKey) !== candidateKey
}

/**
 * Seed from the genome browser's VIEWPORT.
 *
 * A key guard is not sufficient for this one. The browser's viewport is ambient
 * state, not an intention — merely visiting the genome browser republishes it,
 * and any pan or zoom there changes the key. So going SV → browser → SV would
 * re-seed from wherever the browser happened to be (chromosome 1 by default),
 * discarding the region the user had been looking at and leaving the region
 * selector contradicting the view.
 *
 * The rule is therefore: a restored viewport always wins. This seed only applies
 * on a first entry, where carrying the browser's position across is genuinely
 * useful and there is nothing to lose.
 */
export function shouldSeedFromBrowserViewport({ seededKey, candidateKey, hasRestoredViewport }) {
    if (hasRestoredViewport) return false
    return shouldSeedFromBrowser({ seededKey, candidateKey })
}

/**
 * Apply the anchor region when it changed, or when the view has drifted onto a
 * different chromosome from the one the selector is showing.
 *
 * The drift case matters because it is otherwise inescapable: the region counts
 * as already applied, so re-picking it does nothing, and the view keeps
 * reporting an error about a chromosome the user never chose.
 *
 * Drift is ignored when the genome browser seeded the view after the region was
 * applied — navigating the browser elsewhere and then opening this view is meant
 * to follow the browser, not snap back.
 *
 * Chromosome names must be normalised by the caller ('chr1' vs '1').
 */
export function resolveAnchorRegionSeed({
    regionKey,
    seededRegionKey,
    regionChrom,
    windowChrom,
    seededBrowserKey,
    regionSeedBrowserKey,
    driftRecoveredKey,
}) {
    if (!token(regionKey)) return ''
    if (token(seededRegionKey) !== token(regionKey)) return 'changed'

    const region = token(regionChrom)
    const window = token(windowChrom)
    const drifted = Boolean(region) && Boolean(window) && region !== window
    if (!drifted) return ''
    if (token(seededBrowserKey) !== token(regionSeedBrowserKey)) return ''

    // At most one recovery per region. `regionChrom` is the name the user
    // picked, while the applied window carries whatever `getResolvedChromName`
    // resolved it to; if those two never compare equal, an unlimited recovery
    // would re-apply the region on every render forever.
    if (token(driftRecoveredKey) === token(regionKey)) return ''
    return 'drift'
}

/** Convenience wrapper for callers that only need the yes/no. */
export function shouldApplyAnchorRegion(input) {
    return resolveAnchorRegionSeed(input) !== ''
}

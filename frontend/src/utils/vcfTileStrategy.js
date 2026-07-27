// Adaptive VCF loading strategy. Keep these helpers pure so regressions in
// overview/detail prioritization can be covered by fast Node unit tests.

export const VCF_BLOCK_LEVELS = [
    { id: 'L0', minBpPerPx: 1000, tileSpanBp: 25_000_000, blockBp: 25_000, windowBp: 250_000 },
    { id: 'L1', minBpPerPx: 100, tileSpanBp: 500_000, blockBp: 500, windowBp: 5_000 },
    { id: 'L2', minBpPerPx: 10, tileSpanBp: 50_000, blockBp: 100, windowBp: 1_000 },
    { id: 'L3', minBpPerPx: 5, tileSpanBp: 10_000, blockBp: 100, windowBp: 500 },
    { id: 'L4', minBpPerPx: 0, tileSpanBp: 5_000, mode: 'detail' },
]

export function getVcfBlockLevel(bpPerPx, levels = VCF_BLOCK_LEVELS) {
    for (const level of levels) {
        if (Number(bpPerPx) >= Number(level.minBpPerPx)) return level
    }
    return levels[levels.length - 1]
}

export function getVcfViewportIntent({ previous = {}, center, span, nowMs }) {
    const currentCenter = Number(center || 0)
    const currentSpan = Math.max(1, Number(span || 1))
    const previousSpan = Number(previous.span || 0)
    const previousCenter = Number(previous.center || currentCenter)
    const timestamp = Number(nowMs || 0)
    const spanRatio = previousSpan > 0 ? (currentSpan / previousSpan) : 1
    const centerShift = previousSpan > 0
        ? (Math.abs(currentCenter - previousCenter) / Math.max(1, Math.min(currentSpan, previousSpan)))
        : 0

    let intent = 'settled'
    if (spanRatio < 0.85 || spanRatio > 1.18) {
        intent = 'zooming'
    } else if (centerShift > 0.12) {
        intent = 'panning'
    } else if (timestamp - Number(previous.changedAt || 0) < 450) {
        intent = previous.intent || 'settled'
    }

    return {
        center: currentCenter,
        span: currentSpan,
        changedAt: intent === previous.intent ? Number(previous.changedAt || timestamp) : timestamp,
        intent,
    }
}

export function buildVcfOverviewWarmupKey({ trackId, path, chrom, chromLength, level = VCF_BLOCK_LEVELS[0] }) {
    const chromEnd = Math.max(0, Math.floor(Number(chromLength || 0)))
    if (!trackId || !path || !chrom || chromEnd <= 0 || !level) return ''
    return `${trackId}|${path}|${chrom}|${chromEnd}|${level.tileSpanBp}|${level.blockBp}|${level.windowBp}`
}

export function buildVcfOverviewWarmupTiles({ chromLength, level = VCF_BLOCK_LEVELS[0] }) {
    const chromEnd = Math.max(0, Math.floor(Number(chromLength || 0)))
    const tileSpan = Math.max(1, Math.floor(Number(level?.tileSpanBp || 1)))
    if (chromEnd <= 0) return []
    const tiles = []
    for (let tileStart = 0; tileStart < chromEnd; tileStart += tileSpan) {
        tiles.push({
            tileStart,
            tileEnd: tileStart + tileSpan,
            start: tileStart,
            end: tileStart + tileSpan,
            level_id: level.id,
            block_bp: level.blockBp,
            window_bp: level.windowBp,
        })
    }
    return tiles
}

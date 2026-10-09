// Shaping track data for the Genome Browser: tile keys, BED/bigBed feature
// normalisation into the browser's coordinate frame, VCF density smoothing, and
// classifying fetch errors as transient. Pure functions.
import { bedThickRegion } from '../../utils/bedThickRegion.js'
import { queryGeneIntervalIndex } from '../../utils/geneIntervalIndex.js'

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

export function quantileFromSorted(sortedValues, q) {
    const arr = Array.isArray(sortedValues) ? sortedValues : []
    if (arr.length === 0) return 0
    const qNorm = clamp(Number(q), 0, 1)
    const idx = (arr.length - 1) * qNorm
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    if (lo === hi) return Number(arr[lo]) || 0
    const loVal = Number(arr[lo]) || 0
    const hiVal = Number(arr[hi]) || 0
    const t = idx - lo
    return loVal + (hiVal - loVal) * t
}

export function normalizeVcfDensityForHotspots(densityBins) {
    const values = Array.isArray(densityBins) ? densityBins : []
    if (values.length === 0) return []
    const finite = values
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    if (finite.length === 0) {
        return values.map(() => 0)
    }
    const sorted = [...finite].sort((a, b) => a - b)
    const median = Math.max(1e-6, quantileFromSorted(sorted, 0.5))
    const p95 = quantileFromSorted(sorted, 0.95)
    // Legacy occupancy payloads are typically in [0,1]; newer payloads are
    // enrichment-like where baseline is around 1 and hotspots are >1.
    const isLegacyOccupancy = p95 <= 1.05

    return values.map((v) => {
        const raw = Number(v)
        if (!Number.isFinite(raw) || raw <= 0) return 0
        const ratio = isLegacyOccupancy
            ? (raw / median)
            : raw
        const positive = Math.max(0, Math.log2(Math.max(1e-6, ratio)))
        const hotspot = Math.pow(clamp(positive / 3.0, 0, 1), 0.72)
        const baseline = ratio < 1
            ? (clamp(ratio, 0, 1) * 0.06)
            : 0.06
        return baseline + ((1 - baseline) * hotspot)
    })
}

export function smoothVcfDensityBins(values, populated, radius = 1) {
    const src = Array.isArray(values) ? values : []
    const n = src.length
    if (n === 0 || radius <= 0) return src.slice()
    const pop = populated instanceof Uint8Array ? populated : null
    const out = src.slice()
    for (let i = 0; i < n; i++) {
        if (pop && !pop[i]) continue
        let sum = 0
        let wsum = 0
        const lo = Math.max(0, i - radius)
        const hi = Math.min(n - 1, i + radius)
        for (let j = lo; j <= hi; j++) {
            if (pop && !pop[j]) continue
            const v = Number(src[j])
            if (!Number.isFinite(v)) continue
            const w = radius + 1 - Math.abs(j - i)
            sum += v * w
            wsum += w
        }
        if (wsum > 0) out[i] = sum / wsum
    }
    return out
}

export function smoothVcfDensityClasses(classes, populated, radius = 1) {
    const src = Array.isArray(classes) ? classes : []
    const n = src.length
    if (n === 0 || radius <= 0) return src.slice()
    const pop = populated instanceof Uint8Array ? populated : null
    const out = src.slice()
    for (let i = 0; i < n; i++) {
        if (pop && !pop[i]) continue
        let g = 0
        let inter = 0
        const lo = Math.max(0, i - radius)
        const hi = Math.min(n - 1, i + radius)
        for (let j = lo; j <= hi; j++) {
            if (pop && !pop[j]) continue
            const w = radius + 1 - Math.abs(j - i)
            if (src[j] === 'genic') g += w
            else inter += w
        }
        out[i] = g >= inter ? 'genic' : 'intergenic'
    }
    return out
}

export function getFetchErrorMessage(error) {
    if (!error) return 'Request failed'
    if (typeof error === 'string') return error
    const message = String(error?.message || error?.detail || error)
    return message || 'Request failed'
}

export function isTransientFetchErrorMessage(message) {
    const token = String(message || '').trim().toLowerCase()
    if (!token) return false
    return (
        token.includes('failed to fetch')
        || token.includes('fetch failed')
        || token.includes('networkerror')
        || token.includes('network error')
        || token.includes('load failed')
        || token.includes('connection was lost')
        || token.includes('aborterror')
        || token.includes('aborted')
        || token.includes('signal is aborted')
    )
}

export function isTransientFetchError(error) {
    return isTransientFetchErrorMessage(getFetchErrorMessage(error))
}

export function parseItemRgb(value) {
    const token = String(value || '').trim()
    if (!token) return null
    const parts = token.split(',')
    if (parts.length !== 3) return null
    const rgb = parts.map((part) => Number.parseInt(part.trim(), 10))
    if (rgb.some((v) => !Number.isFinite(v))) return null
    return [
        clamp(rgb[0], 0, 255),
        clamp(rgb[1], 0, 255),
        clamp(rgb[2], 0, 255),
    ]
}

export function bigBedFeatureKey(feature) {
    const start = Number(feature?.start) || 0
    const end = Number(feature?.end) || 0
    const name = String(feature?.name || '')
    const strand = String(feature?.strand || '.')
    const score = String(feature?.score ?? '')
    const color = String(feature?.itemRgb || feature?.color || '')
    const blockCount = String(feature?.block_count ?? '')
    const blockSizes = String(feature?.block_sizes || '')
    const blockStarts = String(feature?.block_starts || '')
    const renderKind = String(feature?.render_kind || feature?._render_kind || '')
    return `${start}|${end}|${name}|${strand}|${score}|${color}|${blockCount}|${blockSizes}|${blockStarts}|${renderKind}`
}

export function normalizeBigBedBlockSegments(rawBlocks, fallbackStart, fallbackEnd) {
    if (!Array.isArray(rawBlocks)) return []
    const out = []
    for (const block of rawBlocks) {
        const s = Number(block?.start)
        const e = Number(block?.end)
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
        const start = Math.max(Number(fallbackStart) || 0, s)
        const end = Math.min(Number(fallbackEnd) || Number.MAX_SAFE_INTEGER, e)
        if (end <= start) continue
        out.push({ start, end })
    }
    out.sort((a, b) => (a.start - b.start) || (a.end - b.end))
    return out
}

export function parseBigBedBlockCsvInts(value) {
    const token = String(value || '').trim().replace(/,+$/, '')
    if (!token) return []
    const out = []
    for (const part of token.split(',')) {
        const v = Number.parseInt(String(part).trim(), 10)
        if (!Number.isFinite(v)) return []
        out.push(v)
    }
    return out
}

export function deriveBigBedExonBlocksFromBedColumns(rowStart, rowEnd, blockCountRaw, blockSizesRaw, blockStartsRaw) {
    const start = Number(rowStart)
    const end = Number(rowEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    const blockCount = Number.parseInt(String(blockCountRaw ?? ''), 10)
    const blockSizes = parseBigBedBlockCsvInts(blockSizesRaw)
    const blockStarts = parseBigBedBlockCsvInts(blockStartsRaw)
    const expected = Number.isFinite(blockCount) && blockCount > 0 ? blockCount : blockSizes.length
    if (expected <= 0 || blockSizes.length !== expected || blockStarts.length !== expected) return []
    const out = []
    for (let i = 0; i < expected; i += 1) {
        const size = Number(blockSizes[i])
        const relStart = Number(blockStarts[i])
        if (!Number.isFinite(size) || !Number.isFinite(relStart) || size <= 0) return []
        const exonStart = start + relStart
        const exonEnd = exonStart + size
        const clippedStart = Math.max(start, exonStart)
        const clippedEnd = Math.min(end, exonEnd)
        if (clippedEnd > clippedStart) out.push({ start: clippedStart, end: clippedEnd })
    }
    out.sort((a, b) => (a.start - b.start) || (a.end - b.end))
    return out
}

// BED and BigBed positions are 0-based and half-open: [start, end) is bases start+1..end.
// This browser numbers bases from 1 and draws base N over [N, N+1) — genes and the
// sequence track both do — so those bases belong at [start+1, end+1). Drawing the raw
// numbers put every BED feature one base to the left: its first base under the label
// of the base before, its last base one short. Tiles are moved into the browser's frame
// once, as they are cached; anything showing a position as a number shows start..end-1.
export const BED_TO_BROWSER_OFFSET = 1

export function shiftBedInterval(interval) {
    if (!interval || typeof interval !== 'object') return interval
    const s = Number(interval.start)
    const e = Number(interval.end)
    return {
        ...interval,
        start: Number.isFinite(s) ? s + BED_TO_BROWSER_OFFSET : interval.start,
        end: Number.isFinite(e) ? e + BED_TO_BROWSER_OFFSET : interval.end,
    }
}

export function shiftBedFeatureToBrowserFrame(feature) {
    if (!feature || typeof feature !== 'object') return feature
    const shifted = shiftBedInterval(feature)
    for (const key of ['thick_start', 'thick_end']) {
        const v = feature[key]
        if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
            shifted[key] = Number(v) + BED_TO_BROWSER_OFFSET
        }
    }
    // Block starts are relative to the feature start, so they move with it; the
    // absolute blocks the backend derived do not, and are shifted here.
    if (Array.isArray(feature.exon_blocks)) shifted.exon_blocks = feature.exon_blocks.map(shiftBedInterval)
    if (Array.isArray(feature.cds_blocks)) shifted.cds_blocks = feature.cds_blocks.map(shiftBedInterval)
    return shifted
}

export function normalizeBigBedFeatureForRender(feature) {
    if (!feature || typeof feature !== 'object') return null
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null

    const explicitExons = normalizeBigBedBlockSegments(feature?.exon_blocks, start, end)
    const fallbackExons = explicitExons.length > 0
        ? explicitExons
        : deriveBigBedExonBlocksFromBedColumns(start, end, feature?.block_count, feature?.block_sizes, feature?.block_starts)
    const structureValidRaw = feature?.structure_valid === true
    const structureValid = (structureValidRaw && explicitExons.length > 0) || fallbackExons.length > 0
    const requestedRenderKind = String(feature?.render_kind || '').trim().toLowerCase()
    const renderKind = (structureValid && requestedRenderKind === 'transcript') || (structureValid && !requestedRenderKind)
        ? 'transcript'
        : 'interval'

    let cdsBlocks = normalizeBigBedBlockSegments(feature?.cds_blocks, start, end)
    if (cdsBlocks.length === 0 && structureValid) {
        const thickStart = Number(feature?.thick_start)
        const thickEnd = Number(feature?.thick_end)
        if (Number.isFinite(thickStart) && Number.isFinite(thickEnd) && thickEnd > thickStart) {
            cdsBlocks = fallbackExons
                .map((exon) => ({
                    start: Math.max(exon.start, thickStart),
                    end: Math.min(exon.end, thickEnd),
                }))
                .filter((block) => block.end > block.start)
        }
    }

    // BED9 without blocks: a thick core drawn full height and the rest thin, as UCSC
    // and IGV do (see utils/bedThickRegion). A single box hid the difference.
    const thick = structureValid ? null : bedThickRegion(feature, start, end)

    return {
        ...feature,
        start,
        end,
        _structure_valid: structureValid,
        _render_kind: renderKind,
        _exon_blocks: structureValid ? fallbackExons : [],
        _cds_blocks: structureValid ? cdsBlocks : [],
        _thick: thick,
    }
}

export const REV_COMP = {
    'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C', 'N': 'N',
    'a': 't', 't': 'a', 'c': 'g', 'g': 'c', 'n': 'n',
    '-': '-'
}

// ============ Tile Cache Constants (module-level to avoid stale closures) ============
export const TILE_SIZE = 1_000_000

export const getTileKey = (chrom, tileStart) => `${chrom}:${tileStart}`

export const getChromGeneCacheKey = (genome, chrom) => `${genome || ''}:${String(chrom || '').trim().toLowerCase()}`

export const snapToTile = (pos) => Math.floor(pos / TILE_SIZE) * TILE_SIZE

export function collectGenesFromList(genes, start, end) {
    return queryGeneIntervalIndex(genes, start, end)
}

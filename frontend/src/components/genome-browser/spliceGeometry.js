// Splice-junction arcs: support colours and bands, motif display, and the bezier
// geometry that lifts overlapping arcs apart. Pure functions.
import { DEFAULT_SPLICE_TRACK_SETTINGS, SPLICE_HEAT_STOPS_DARK, SPLICE_HEAT_STOPS_LIGHT } from './browserConstants.js'
import { clamp } from './trackData.js'

export function spliceJunctionKey(junction) {
    const s = Number(junction?.start)
    const e = Number(junction?.end)
    const strand = String(junction?.strand || '.')
    return `${s}|${e}|${strand}`
}

export function mixRgb(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ]
}

export function spliceSupportColor(weight, isLight) {
    const stops = isLight ? SPLICE_HEAT_STOPS_LIGHT : SPLICE_HEAT_STOPS_DARK
    const w = clamp(Number.isFinite(weight) ? weight : 0, 0, 1)
    if (w <= 0) return stops[0]
    if (w >= 1) return stops[stops.length - 1]
    const scaled = w * (stops.length - 1)
    const idx = Math.floor(scaled)
    const frac = scaled - idx
    return mixRgb(stops[idx], stops[Math.min(stops.length - 1, idx + 1)], frac)
}

export function spliceSupportBandForValue(support, spliceSettings) {
    const count = Math.max(0, Number(support) || 0)
    const settings = spliceSettings || DEFAULT_SPLICE_TRACK_SETTINGS
    if (count <= settings.weak_max_support) return 'weak'
    if (count <= settings.low_max_support) return 'low'
    if (count <= settings.medium_max_support) return 'medium'
    return 'high'
}

export function spliceSupportBandWeight(support, spliceSettings) {
    const band = spliceSupportBandForValue(support, spliceSettings)
    if (band === 'weak') return 0.14
    if (band === 'low') return 0.4
    if (band === 'medium') return 0.68
    return 0.94
}

export function reverseComplementDinucleotide(token) {
    const seq = String(token || '').toUpperCase()
    const map = { A: 'T', C: 'G', G: 'C', T: 'A' }
    return seq
        .split('')
        .reverse()
        .map((base) => map[base] || 'N')
        .join('')
}

export function formatSpliceMotifForDisplay(motif, strand) {
    const text = String(motif || '').trim()
    const m = text.match(/^([ACGT]{2})\s*(?:\/|-)\s*([ACGT]{2})$/i)
    if (!m) return text || 'unknown'
    const donor = m[1].toUpperCase()
    const acceptor = m[2].toUpperCase()
    if (String(strand || '.').trim() === '-') {
        // Reverse strand: present motif in transcript-forward orientation.
        return `${reverseComplementDinucleotide(acceptor)}/${reverseComplementDinucleotide(donor)}`
    }
    return `${donor}/${acceptor}`
}

export function getSpliceArcLift(widthPx, lodMode) {
    const w = Math.max(1, Number(widthPx) || 1)
    const maxLift = lodMode === 'detail' ? 84 : 63
    const sqrtTerm = Math.sqrt(w) * (lodMode === 'detail' ? 1.55 : 1.25)
    const longIntronBoost = Math.log2(1 + w) * (lodMode === 'detail' ? 1.35 : 1.05)
    return Math.min(maxLift, 5 + sqrtTerm + longIntronBoost)
}

export function getSpliceBezierControls(x1, x2, peakY) {
    const dx = x2 - x1
    const dir = dx >= 0 ? 1 : -1
    const span = Math.abs(dx)
    const shoulder = Math.max(6, Math.min(44, span * 0.22))
    return {
        c1x: x1 + dir * shoulder,
        c1y: peakY,
        c2x: x2 - dir * shoulder,
        c2y: peakY,
    }
}

export function annotateSpliceSimilarityLift(arcs, lodMode) {
    const list = Array.isArray(arcs) ? arcs : []
    if (list.length <= 1) return list
    const bucketPx = lodMode === 'detail' ? 2 : 3
    const liftStep = lodMode === 'detail' ? 3 : 2
    const groups = new Map()
    for (const arc of list) {
        const minX = Math.min(Number(arc?.x1) || 0, Number(arc?.x2) || 0)
        const maxX = Math.max(Number(arc?.x1) || 0, Number(arc?.x2) || 0)
        const b1 = Math.round(minX / bucketPx)
        const b2 = Math.round(maxX / bucketPx)
        const key = `${b1}|${b2}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(arc)
    }
    const out = []
    for (const group of groups.values()) {
        group.sort((a, b) =>
            (Number(a?.lane || 0) - Number(b?.lane || 0))
            || ((Number(b?.n_total || 0)) - (Number(a?.n_total || 0)))
            || ((Number(a?.end || 0) - Number(a?.start || 0)) - (Number(b?.end || 0) - Number(b?.start || 0)))
            || ((Number(a?.start || 0)) - (Number(b?.start || 0)))
            || ((Number(a?.end || 0)) - (Number(b?.end || 0)))
        )
        group.forEach((arc, idx) => {
            out.push({ ...arc, similarity_lift: idx * liftStep })
        })
    }
    return out
}

export function computeSplicePeakY({
    baselineY,
    minTopY,
    lane,
    lanePitch,
    widthPx,
    lodMode,
    extraLift = 0,
}) {
    const laneN = Math.max(0, Number(lane || 0))
    const laneLift = (laneN + 1) * lanePitch
    const laneTopSeparation = Math.min(14, laneN * (lodMode === 'detail' ? 1.8 : 1.4))
    const topLimit = minTopY + laneTopSeparation
    const maxTotalLift = Math.max(2, baselineY - topLimit)

    const baseSpanLift = getSpliceArcLift(widthPx, lodMode)
    // Use most available arc headroom while keeping a small top margin.
    const boostedSpanLift = Math.min(maxTotalLift * 0.96, baseSpanLift * 1.3)

    const w = Math.max(1, Number(widthPx) || 1)
    const dragScale = 1 + Math.min(0.65, Math.log2(1 + w) / 14)
    const dragInput = clamp(Number(extraLift) || 0, -120, 240)
    const effectiveDragLift = dragInput * dragScale

    const desiredLift = laneLift + boostedSpanLift + effectiveDragLift
    const totalLift = clamp(desiredLift, 2, maxTotalLift)
    return baselineY - totalLift
}

export function cubicPointAt(p0, p1, p2, p3, t) {
    const omt = 1 - t
    return (omt * omt * omt * p0)
        + (3 * omt * omt * t * p1)
        + (3 * omt * t * t * p2)
        + (t * t * t * p3)
}

export function cubicDerivativeAt(p0, p1, p2, p3, t) {
    const omt = 1 - t
    return 3 * (
        (p1 - p0) * omt * omt
        + 2 * (p2 - p1) * omt * t
        + (p3 - p2) * t * t
    )
}

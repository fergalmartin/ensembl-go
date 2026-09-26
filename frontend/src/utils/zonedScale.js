// The zoned heatmap's zones: four value ranges stacked up the track, each coloured and
// each given a fixed share of the height, so a value's height says which range it is in
// and how far through it.
//
// The fixed zones (100 / 1k / 10k / 100k) were made for RNA-seq read coverage. A signal
// in other units — ATAC fold enrichment tops out below 10 — sat in the bottom few percent
// of the first zone and drew nothing. "Scaled to this file" takes the zone edges from the
// file's own peak heights instead (its 50th/90th/99th/99.9th percentile peak, computed by
// the backend), so the same four zones span that file's range. "Custom" uses four edges
// the user typed; the last ones saved are remembered as a starting point for the next track.

export const FIXED_ZONE_THRESHOLDS = [100, 1000, 10000, 100000]
export const ZONE_HEIGHTS = [0.4, 0.2, 0.2, 0.2]

const isValidThresholds = (list) => Array.isArray(list)
    && list.length === 4
    && list.every((v, i) => Number.isFinite(v) && v > 0 && (i === 0 || v > list[i - 1]))

/**
 * The zone edges to draw with: the user's ('custom'), those shared by files registered
 * together ('files'), or the file's own ('file') when chosen and sound; else the fixed ones.
 * Shared zones that are missing fall back to the file's own peaks.
 */
export function zoneThresholdsFor(zoneScale, fileThresholds, customZones = null, sharedZones = null) {
    if (zoneScale === 'custom' && isValidThresholds(customZones)) return customZones
    if (zoneScale === 'files' && isValidThresholds(sharedZones)) return sharedZones
    if ((zoneScale === 'file' || zoneScale === 'files') && isValidThresholds(fileThresholds)) return fileThresholds
    return FIXED_ZONE_THRESHOLDS
}

/**
 * Four typed zone edges checked: { ok, zones, message }. `zones` are the parsed numbers
 * (NaN where a box does not hold one); `message` says what is wrong, for the form.
 */
export function checkCustomZones(values) {
    const list = Array.isArray(values) ? values : []
    const zones = [0, 1, 2, 3].map((i) => {
        const raw = list[i]
        if (typeof raw === 'number') return raw
        const text = String(raw ?? '').replace(/,/g, '').trim()
        return text === '' ? NaN : Number(text)
    })
    const missing = zones.findIndex((v) => !Number.isFinite(v))
    if (missing >= 0) return { ok: false, zones, message: `Enter a number for zone ${missing + 1}.` }
    const nonPositive = zones.findIndex((v) => v <= 0)
    if (nonPositive >= 0) return { ok: false, zones, message: `Zone ${nonPositive + 1} must be above 0.` }
    const notIncreasing = zones.findIndex((v, i) => i > 0 && v <= zones[i - 1])
    if (notIncreasing >= 0) {
        return { ok: false, zones, message: `Zone ${notIncreasing + 1} must be higher than zone ${notIncreasing}.` }
    }
    return { ok: true, zones, message: '' }
}

// The last custom zones saved on any track, offered first when another track chooses
// custom. One preset, per user and machine: a convenience, so storage failures (a private
// window, blocked site data) are quiet and simply mean nothing is remembered.
const REMEMBERED_ZONES_KEY = 'ensemblGo.bigwigCustomZones'

export function loadRememberedCustomZones(storage = globalThis.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(REMEMBERED_ZONES_KEY) || 'null')
        return isValidThresholds(parsed) ? parsed : null
    } catch {
        return null
    }
}

export function rememberCustomZones(zones, storage = globalThis.localStorage) {
    if (!isValidThresholds(zones)) return false
    try {
        storage?.setItem(REMEMBERED_ZONES_KEY, JSON.stringify(zones))
        return true
    } catch {
        return false
    }
}

/** Where a newly custom track starts: its own sound zones, the remembered ones, or the fixed ones. */
export function initialCustomZones(existing, storage = globalThis.localStorage) {
    if (isValidThresholds(existing)) return existing
    return loadRememberedCustomZones(storage) || FIXED_ZONE_THRESHOLDS.slice()
}

/** How far up the track (0-1) a value reaches. Values past the last edge are capped. */
export function zonedValueFraction(value, thresholds = FIXED_ZONE_THRESHOLDS, heights = ZONE_HEIGHTS) {
    const top = thresholds[thresholds.length - 1]
    const v = Math.min(top, Math.max(0, Number.isFinite(value) ? value : 0))
    let acc = 0
    let zoneStart = 0
    for (let i = 0; i < thresholds.length; i++) {
        const zoneEnd = thresholds[i]
        const zoneHeight = heights[i] || 0
        if (v <= zoneEnd || i === thresholds.length - 1) {
            const span = Math.max(Number.EPSILON, zoneEnd - zoneStart)
            return Math.min(1, acc + Math.min(1, Math.max(0, (v - zoneStart) / span)) * zoneHeight)
        }
        acc += zoneHeight
        zoneStart = zoneEnd
    }
    return 1
}

/** The stacked pieces a value fills: [{ zone, height }] with height a fraction of the track. */
export function zonedSegments(value, thresholds = FIXED_ZONE_THRESHOLDS, heights = ZONE_HEIGHTS) {
    const top = thresholds[thresholds.length - 1]
    const capped = Math.min(top, Math.max(0, Number.isFinite(value) ? value : 0))
    const out = []
    let zoneStart = 0
    for (let zone = 0; zone < thresholds.length; zone++) {
        const zoneEnd = thresholds[zone]
        if (capped <= zoneStart) break
        const covered = Math.min(capped, zoneEnd) - zoneStart
        const span = Math.max(Number.EPSILON, zoneEnd - zoneStart)
        if (covered > 0) out.push({ zone, height: (heights[zone] || 0) * Math.min(1, covered / span) })
        zoneStart = zoneEnd
    }
    return out
}

/** A zone edge as its label: whole numbers grouped, small values to two significant figures. */
export function formatZoneLabel(value) {
    const v = Number(value)
    if (!Number.isFinite(v)) return ''
    if (v >= 100) return `>${Math.round(v).toLocaleString('en-US')}`
    return `>${Number(v.toPrecision(2)).toString()}`
}

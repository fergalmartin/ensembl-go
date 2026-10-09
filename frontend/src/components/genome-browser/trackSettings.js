// Per-track-type display settings (BED/bigBed, bigWig, VCF, splice junctions):
// normalising what the track registry stores, and the colours and lane heights they
// imply. Pure functions.
import { BED_DEFAULT_COLOR, BIGBED_DETAIL_EXON_HEIGHT, BIGBED_DETAIL_LANE_BOTTOM_PAD, BIGBED_DETAIL_LANE_PITCH, BIGBED_DETAIL_LANE_TOP_PAD, BIGBED_DETAIL_TRACK_BASE_HEIGHT, BIGBED_DETAIL_TRACK_MAX_HEIGHT, BIGWIG_DATA_TYPE_DEFAULTS, CUSTOM_TRACK_HEIGHT_STANDARD, DEFAULT_SPLICE_TRACK_SETTINGS, GFF_DEFAULT_COLOR, VCF_SETTINGS_DEFAULTS } from './browserConstants.js'
import { clamp, parseItemRgb } from './trackData.js'

// A BED/BigBed track's chosen colour, or '' for automatic.
export function normalizeBedSettings(raw) {
    const color = String(raw?.color || '').trim().toLowerCase()
    return { color: /^#[0-9a-f]{6}$/.test(color) ? color : '' }
}

// Automatic colouring: the file's own itemRgb where it has one, then the type's default.
// A colour chosen for the track overrides both.
export function bedTrackColors(track) {
    const chosen = normalizeBedSettings(track?.bedSettings || track?.bed_settings).color
    return {
        chosen,
        fallback: track?.type === 'bed' ? BED_DEFAULT_COLOR : track?.type === 'gff' ? GFF_DEFAULT_COLOR : '',
    }
}

export function bigBedFeatureColor(feature, isLight, colors = null) {
    const chosen = colors?.chosen || ''
    if (chosen) {
        return {
            fill: hexToRgba(chosen, isLight ? 0.58 : 0.72),
            stroke: hexToRgba(chosen, isLight ? 0.92 : 0.98),
        }
    }
    const rgb = parseItemRgb(feature?.itemRgb || feature?.color)
    if (rgb) {
        const [r, g, b] = rgb
        return {
            fill: `rgba(${r},${g},${b},${isLight ? 0.58 : 0.72})`,
            stroke: `rgba(${r},${g},${b},${isLight ? 0.92 : 0.98})`,
        }
    }
    const fallbackColor = colors?.fallback || VCF_SETTINGS_DEFAULTS.genic_color
    const fallback = {
        fill: hexToRgba(fallbackColor, isLight ? 0.34 : 0.46),
        stroke: hexToRgba(fallbackColor, isLight ? 0.94 : 0.98),
    }
    return fallback
}

export function bigBedBlockColor(span, isLight, colors = null) {
    // Summary blocks intentionally use a stable generic color so large low-LOD spans
    // do not flicker as different underlying features stream in/out during pan/zoom.
    const base = colors?.chosen || colors?.fallback || ''
    if (base) return hexToRgba(base, isLight ? 0.5 : 0.58)
    return isLight ? 'rgba(5,150,105,0.44)' : 'rgba(52,211,153,0.50)'
}

export function bigBedBlockStroke(isLight, colors = null) {
    const base = colors?.chosen || colors?.fallback || ''
    if (base) return hexToRgba(base, isLight ? 0.6 : 0.72)
    return isLight ? 'rgba(5,150,105,0.5)' : 'rgba(110,231,183,0.62)'
}

export function getBigBedLaneCapacity(plotHeight, lanePitch = BIGBED_DETAIL_LANE_PITCH) {
    const available = Math.max(
        BIGBED_DETAIL_EXON_HEIGHT,
        Number(plotHeight || 0) - BIGBED_DETAIL_LANE_TOP_PAD - BIGBED_DETAIL_LANE_BOTTOM_PAD,
    )
    return Math.max(1, Math.floor((available - BIGBED_DETAIL_EXON_HEIGHT) / lanePitch) + 1)
}

export function getBigBedTrackHeightForLanes(laneCount, lanePitch = BIGBED_DETAIL_LANE_PITCH) {
    const lanes = Math.max(1, Number.isFinite(Number(laneCount)) ? Math.round(Number(laneCount)) : 1)
    return clamp(
        Math.max(
            CUSTOM_TRACK_HEIGHT_STANDARD,
            Math.round(BIGBED_DETAIL_TRACK_BASE_HEIGHT + lanes * lanePitch),
        ),
        CUSTOM_TRACK_HEIGHT_STANDARD,
        BIGBED_DETAIL_TRACK_MAX_HEIGHT,
    )
}

export function normalizeBigWigDataType(value, fallback = 'rna_seq') {
    const token = String(value || '').trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(BIGWIG_DATA_TYPE_DEFAULTS, token) ? token : fallback
}

export function normalizeBigWigDisplayMode(mode, dataType = 'rna_seq') {
    const token = String(mode || '').trim().toLowerCase()
    if (token === 'line_plot' || token === 'bar_chart') return 'signal_plot'
    if (token === 'signal_plot' || token === 'zoned_heatmap') return token
    const normalizedType = normalizeBigWigDataType(dataType)
    return BIGWIG_DATA_TYPE_DEFAULTS[normalizedType].display_mode
}

export function normalizeVcfDisplayMode(mode) {
    let token = String(mode || '').trim().toLowerCase()
    if (token === 'block_lollipop' || token === 'block-lollipop') token = 'adaptive'
    if (token === 'ensembl' || token === 'lollipop' || token === 'density') token = 'density_lollipop'
    return token === 'adaptive' || token === 'density_lollipop' ? token : 'density_lollipop'
}

export function isVcfAdaptiveLikeMode(mode) {
    const normalized = normalizeVcfDisplayMode(mode)
    return normalized === 'adaptive' || normalized === 'density_lollipop'
}

export function normalizeVcfHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

export function normalizeVcfSettings(raw = null, previous = null) {
    const prev = previous && typeof previous === 'object' ? previous : {}
    const base = {
        genic_color: normalizeVcfHexColor(prev.genic_color, VCF_SETTINGS_DEFAULTS.genic_color),
        intergenic_color: normalizeVcfHexColor(prev.intergenic_color, VCF_SETTINGS_DEFAULTS.intergenic_color),
    }
    const source = raw && typeof raw === 'object' ? raw : {}
    return {
        genic_color: normalizeVcfHexColor(source.genic_color, base.genic_color),
        intergenic_color: normalizeVcfHexColor(source.intergenic_color, base.intergenic_color),
    }
}

export function normalizeBigWigHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

export function normalizeBigWigZonedColors(rawColors, fallbackColors) {
    const fallback = Array.isArray(fallbackColors) && fallbackColors.length >= 4
        ? fallbackColors.slice(0, 4)
        : BIGWIG_DATA_TYPE_DEFAULTS.rna_seq.zoned_colors.slice(0, 4)
    const source = Array.isArray(rawColors) ? rawColors : []
    return [0, 1, 2, 3].map((idx) => normalizeBigWigHexColor(source[idx], fallback[idx]))
}

export function normalizeBigWigSettings(raw = null, previous = null) {
    const prevType = normalizeBigWigDataType(previous?.data_type, 'rna_seq')
    const prevDefaults = BIGWIG_DATA_TYPE_DEFAULTS[prevType]
    const prev = {
        data_type: prevType,
        plot_color: normalizeBigWigHexColor(previous?.plot_color, prevDefaults.plot_color),
        zoned_colors: normalizeBigWigZonedColors(previous?.zoned_colors, prevDefaults.zoned_colors),
        use_default_plot_color: previous?.use_default_plot_color !== false,
        use_default_zoned_colors: previous?.use_default_zoned_colors !== false,
    }

    const source = raw && typeof raw === 'object' ? raw : {}
    const data_type = normalizeBigWigDataType(source.data_type, prev.data_type)
    const defaults = BIGWIG_DATA_TYPE_DEFAULTS[data_type]
    const use_default_plot_color = source.use_default_plot_color !== undefined
        ? source.use_default_plot_color !== false
        : prev.use_default_plot_color
    const use_default_zoned_colors = source.use_default_zoned_colors !== undefined
        ? source.use_default_zoned_colors !== false
        : prev.use_default_zoned_colors

    return {
        data_type,
        plot_color: use_default_plot_color
            ? defaults.plot_color
            : normalizeBigWigHexColor(source.plot_color, prev.plot_color),
        zoned_colors: use_default_zoned_colors
            ? defaults.zoned_colors.slice(0, 4)
            : normalizeBigWigZonedColors(source.zoned_colors, prev.zoned_colors),
        use_default_plot_color,
        use_default_zoned_colors,
        // 'fixed' zones for read coverage, 'file': edges from the file's own peaks, or
        // 'custom': the four edges in custom_zones.
        zone_scale: ['fixed', 'file', 'files', 'custom'].includes(source.zone_scale)
            ? source.zone_scale
            : (['fixed', 'file', 'files', 'custom'].includes(previous?.zone_scale) ? previous.zone_scale : defaults.zone_scale),
        custom_zones: Array.isArray(source.custom_zones)
            ? source.custom_zones.map(Number)
            : (Array.isArray(previous?.custom_zones) ? previous.custom_zones.map(Number) : null),
        // 'files': edges from the peaks of every file registered together, so they compare.
        shared_zones: Array.isArray(source.shared_zones)
            ? source.shared_zones.map(Number)
            : (Array.isArray(previous?.shared_zones) ? previous.shared_zones.map(Number) : null),
    }
}

export function hexToRgba(hex, alpha = 1) {
    const token = String(hex || '').trim()
    const match = token.match(/^#([0-9a-fA-F]{6})$/)
    if (!match) {
        return `rgba(59,130,246,${clamp(alpha, 0, 1)})`
    }
    const value = match[1]
    const r = Number.parseInt(value.slice(0, 2), 16)
    const g = Number.parseInt(value.slice(2, 4), 16)
    const b = Number.parseInt(value.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`
}

export function normalizeSpliceTrackSettings(raw = null) {
    const merged = { ...DEFAULT_SPLICE_TRACK_SETTINGS, ...(raw || {}) }
    const minSupport = Number.parseInt(merged.min_support, 10)
    const maxJunctions = Number.parseInt(merged.max_junctions, 10)
    const weakMax = Number.parseInt(merged.weak_max_support, 10)
    const lowMax = Number.parseInt(merged.low_max_support, 10)
    const mediumMax = Number.parseInt(merged.medium_max_support, 10)
    const canonicalMode = ['all', 'canonical', 'non_canonical'].includes(String(merged.canonical_mode))
        ? String(merged.canonical_mode)
        : 'all'
    const annotatedMode = ['all', 'annotated', 'novel'].includes(String(merged.annotated_mode))
        ? String(merged.annotated_mode)
        : 'all'
    const min_support = Number.isFinite(minSupport) ? Math.max(1, minSupport) : 1
    const weak_max_support = Number.isFinite(weakMax) ? Math.max(min_support, weakMax) : Math.max(min_support, DEFAULT_SPLICE_TRACK_SETTINGS.weak_max_support)
    const low_max_support = Number.isFinite(lowMax) ? Math.max(weak_max_support + 1, lowMax) : Math.max(weak_max_support + 1, DEFAULT_SPLICE_TRACK_SETTINGS.low_max_support)
    const medium_max_support = Number.isFinite(mediumMax) ? Math.max(low_max_support + 1, mediumMax) : Math.max(low_max_support + 1, DEFAULT_SPLICE_TRACK_SETTINGS.medium_max_support)
    return {
        min_support,
        canonical_mode: canonicalMode,
        annotated_mode: annotatedMode,
        show_arrows: merged.show_arrows !== false,
        max_junctions: Number.isFinite(maxJunctions) ? Math.max(100, maxJunctions) : 5000,
        weak_max_support,
        low_max_support,
        medium_max_support,
    }
}

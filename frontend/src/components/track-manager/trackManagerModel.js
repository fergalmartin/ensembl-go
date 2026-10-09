// The Track Manager's model: track types and display modes, per-type settings
// defaults and normalisation (bigWig zones, VCF, BED, splice), converting between a
// registered track and its settings form, the track-hub discovery cache, and group
// layouts.
import { genomeKeysMatch, trackAssemblyKey } from '../../utils/genomeIdentity.js'
import { checkCustomZones, formatZoneLabel } from '../../utils/zonedScale.js'
import { normalizeVcfDisplayMode } from '../genome-browser/trackSettings.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const TRACK_TYPES = [
    { id: 'bigwig', label: 'BigWig', ext: '.bw / .bigwig', desc: 'Continuous signal (coverage, ChIP-seq, ATAC-seq)' },
    { id: 'vcf', label: 'VCF', ext: '.vcf.gz (+ .tbi)', desc: 'Tabix-indexed variants (SNPs, indels, SVs)' },
    { id: 'bed', label: 'BED', ext: '.bed / .bed.gz', desc: 'Genomic intervals (peaks, repeats, regions)' },
    { id: 'gff', label: 'GFF / GTF', ext: '.gff / .gff3 / .gtf (.gz)', desc: 'Features or gene models, for display only (regulatory build, repeats, transcripts)' },
    { id: 'bigbed', label: 'BigBED', ext: '.bb / .bigBed', desc: 'Indexed intervals for large BED files' },
    { id: 'splice_junctions', label: 'Splice Junctions', ext: '.SJ.out.tab', desc: 'STAR splice-junction file (arc / sashimi plot)' },
    { id: 'bam', label: 'BAM (short reads)', ext: '.bam (+ .bai)', desc: 'Short-read alignments (coverage + reads)' },
    { id: 'long_reads', label: 'Long Reads (minimap2)', ext: '.bam (+ .bai)', desc: 'minimap2 / IsoSeq / ONT — collapsed transcript models' },
]

export const DISPLAY_MODES = {
    bigwig: [{ id: 'zoned_heatmap', label: 'Zoned Heatmap' }, { id: 'signal_plot', label: 'Signal Plot' }],
    vcf: [
        { id: 'density_lollipop', label: 'Density-Lollipop' },
        { id: 'adaptive', label: 'Block Lollipop' },
    ],
    bed: [{ id: 'intervals', label: 'Intervals' }, { id: 'density', label: 'Density' }],
    gff: [{ id: 'intervals', label: 'Intervals' }, { id: 'transcripts', label: 'Gene models' }, { id: 'density', label: 'Density' }],
    bigbed: [{ id: 'intervals', label: 'Intervals' }, { id: 'density', label: 'Density' }],
    splice_junctions: [{ id: 'arcs', label: 'Arcs (Sashimi)' }],
    bam: [{ id: 'coverage', label: 'Coverage' }, { id: 'reads_coverage', label: 'Reads + Coverage' }],
    long_reads: [{ id: 'collapsed_transcripts', label: 'Collapsed Transcripts' }],
}

export const BIGWIG_DATA_TYPES = [
    { id: 'rna_seq', label: 'RNA-seq' },
    { id: 'atac_seq', label: 'ATAC-seq' },
    { id: 'chip_seq', label: 'Chip-seq' },
    { id: 'custom', label: 'Custom' },
]

export const BIGWIG_DEFAULTS = {
    rna_seq: {
        display_mode: 'zoned_heatmap',
        plot_color: '#3b82f6',
        zoned_colors: ['#f7cd61', '#f4a940', '#ea7a2d', '#cc2f1f'],
        zone_scale: 'fixed',
    },
    atac_seq: {
        display_mode: 'signal_plot',
        plot_color: '#b52aa1',
        zoned_colors: ['#86efac', '#4ade80', '#22c55e', '#15803d'],
        zone_scale: 'file',
    },
    chip_seq: {
        display_mode: 'signal_plot',
        plot_color: '#8b5cf6',
        zoned_colors: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#6d28d9'],
        zone_scale: 'file',
    },
    custom: {
        display_mode: 'signal_plot',
        plot_color: '#14b8a6',
        zoned_colors: ['#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8'],
        zone_scale: 'file',
    },
}

// How a zoned heatmap places its four zones.
export const ZONE_SCALES = [
    { id: 'fixed', label: 'Fixed: 100 / 1k / 10k / 100k', hint: 'For read coverage (RNA-seq).' },
    { id: 'file', label: "Scaled to this file's peaks", hint: "Zone edges at this file's typical, strong, very strong and top peak heights; for signal in other units (ATAC, ChIP)." },
    { id: 'custom', label: 'Custom', hint: 'Set where each zone ends yourself. The last zones you saved are offered first on the next track.' },
]

// The zone scales to offer. Files registered together that share settings are scaled
// across all of them, so their tracks compare directly — worded as such. A track saved
// that way keeps the choice, with the edges it was given.
export function zoneScaleOptions(sharedFileCount = 1, settings = null) {
    return ZONE_SCALES.flatMap((opt) => {
        if (opt.id === 'file' && sharedFileCount > 1) {
            return [{
                id: 'file',
                label: `Scaled to the peaks of all ${sharedFileCount} files`,
                hint: `Zone edges at the typical, strong, very strong and top peak heights across all ${sharedFileCount} files, measured together, so the tracks share one scale and can be compared directly.`,
            }]
        }
        if (opt.id === 'custom' && settings?.zone_scale === 'files') {
            const zones = Array.isArray(settings.shared_zones) ? settings.shared_zones : []
            return [{
                id: 'files',
                label: 'Shared with the files registered alongside it',
                hint: `Edges from the peaks of the files registered together${zones.length === 4 ? ` (${zones.map((v) => formatZoneLabel(v).slice(1)).join(' / ')})` : ''}, so those tracks compare directly.`,
            }, opt]
        }
        return [opt]
    })
}

// A custom-zoned heatmap whose zones do not yet make sense: the message to show, or ''.
export function customZoneProblem(settings, displayMode) {
    if (displayMode !== 'zoned_heatmap' || settings?.zone_scale !== 'custom') return ''
    const check = checkCustomZones(settings?.custom_zones)
    return check.ok ? '' : `Custom zones: ${check.message}`
}

export const VCF_SETTINGS_DEFAULTS = {
    genic_color: '#00b692',
    intergenic_color: '#96d0c9',
}

export const TYPE_COLORS = {
    bigwig: '#3b82f6',
    vcf: '#f59e0b',
    bed: '#10b981',
    gff: '#0891b2',
    bigbed: '#059669',
    splice_junctions: '#8b5cf6',
    bam: '#ef4444',
    long_reads: '#ec4899',
}

export const DEFAULT_SPLICE_SETTINGS = {
    min_support: 1,
    canonical_mode: 'all',
    annotated_mode: 'all',
    show_arrows: true,
    max_junctions: 5000,
    weak_max_support: 2,
    low_max_support: 4,
    medium_max_support: 9,
}

export const SPLICE_CANONICAL_OPTIONS = [
    { id: 'all', label: 'All motifs' },
    { id: 'canonical', label: 'Canonical only' },
    { id: 'non_canonical', label: 'Non-canonical only' },
]

export const SPLICE_ANNOTATED_OPTIONS = [
    { id: 'all', label: 'All junctions' },
    { id: 'annotated', label: 'Annotated only' },
    { id: 'novel', label: 'Novel only' },
]

export const HUB_TRACK_ROW_HEIGHT = 86

export const HUB_TRACK_OVERSCAN = 6

export const HUB_TRACK_VIRTUALIZE_THRESHOLD = 120

export const HUB_TRACK_VIRTUALIZED_MAX_HEIGHT = 344

export const HUB_DISCOVERY_CACHE_PREFIX = 'trackhub_discovery_cache_v3::'

export const HUB_DISCOVERY_GENOME_CACHE_PREFIX = 'trackhub_discovery_cache_genome_v2::'

export function buildHubDiscoveryCacheKey(genomes = []) {
    const normalized = [...(Array.isArray(genomes) ? genomes : [])]
        .map((g) => String(g?.genome_key || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    if (normalized.length === 0) return ''
    return `${HUB_DISCOVERY_CACHE_PREFIX}${JSON.stringify(normalized)}`
}

export function normalizeHubDiscoveryPayload(byGenome) {
    const source = byGenome && typeof byGenome === 'object' ? byGenome : {}
    const out = {}
    const genomeKeys = Object.keys(source).sort((a, b) => a.localeCompare(b))
    for (const genomeKey of genomeKeys) {
        const item = source[genomeKey] && typeof source[genomeKey] === 'object' ? source[genomeKey] : {}
        const tracks = Array.isArray(item.tracks) ? item.tracks : []
        const normalizedTracks = tracks
            .map((row) => ({
                hub_id: String(row?.hub_id || ''),
                hub_name: String(row?.hub_name || ''),
                track_id: String(row?.track_id || ''),
                track_name: String(row?.track_name || ''),
                assembly: String(row?.assembly || ''),
                format: String(row?.format || ''),
                type: String(row?.type || ''),
                data_url: String(row?.data_url || ''),
                description: String(row?.description || ''),
                import_key: String(row?.import_key || ''),
            }))
            .sort((a, b) =>
                String(a.hub_name || '').localeCompare(String(b.hub_name || ''))
                || String(a.track_name || '').localeCompare(String(b.track_name || ''))
                || String(a.data_url || '').localeCompare(String(b.data_url || ''))
            )
        out[genomeKey] = {
            genome_key: genomeKey,
            error: String(item?.error || ''),
            tracks: normalizedTracks,
        }
    }
    return out
}

export function buildHubDiscoverySignature(byGenome) {
    return JSON.stringify(normalizeHubDiscoveryPayload(byGenome))
}

export function readHubDiscoveryCache(cacheKey, genomes = []) {
    if (!cacheKey || typeof window === 'undefined' || !window.localStorage) return null
    try {
        const raw = window.localStorage.getItem(cacheKey)
        if (raw) {
            const parsed = JSON.parse(raw)
            const savedAt = Number(parsed?.saved_at || 0)
            const byGenome = parsed?.by_genome && typeof parsed.by_genome === 'object' ? parsed.by_genome : null
            if (Number.isFinite(savedAt) && byGenome) {
                const signature = String(parsed?.signature || buildHubDiscoverySignature(byGenome))
                return { saved_at: savedAt, by_genome: byGenome, signature }
            }
        }
    } catch {
        // fallback to per-genome cache below
    }

    const genomeKeys = [...(Array.isArray(genomes) ? genomes : [])]
        .map((g) => String(g?.genome_key || '').trim())
        .filter(Boolean)
    if (genomeKeys.length === 0) return null

    const byGenome = {}
    let newestSavedAt = 0
    for (const genomeKey of genomeKeys) {
        const perGenomeKey = `${HUB_DISCOVERY_GENOME_CACHE_PREFIX}${genomeKey}`
        try {
            const raw = window.localStorage.getItem(perGenomeKey)
            if (!raw) continue
            const parsed = JSON.parse(raw)
            const savedAt = Number(parsed?.saved_at || 0)
            const payload = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : null
            if (!payload) continue
            byGenome[genomeKey] = payload
            if (Number.isFinite(savedAt)) newestSavedAt = Math.max(newestSavedAt, savedAt)
        } catch {
            // ignore per-genome parse issues
        }
    }
    if (Object.keys(byGenome).length === 0) return null
    const signature = buildHubDiscoverySignature(byGenome)
    return { saved_at: newestSavedAt || Date.now(), by_genome: byGenome, signature }
}

export function writeHubDiscoveryCache(cacheKey, byGenome, signature = '') {
    if (!cacheKey || typeof window === 'undefined' || !window.localStorage) return
    if (!byGenome || typeof byGenome !== 'object') return
    const savedAt = Date.now()
    const effectiveSignature = String(signature || buildHubDiscoverySignature(byGenome))
    try {
        window.localStorage.setItem(cacheKey, JSON.stringify({
            saved_at: savedAt,
            by_genome: byGenome,
            signature: effectiveSignature,
        }))
    } catch {
        // ignore cache write failures
    }
    for (const [genomeKey, payload] of Object.entries(byGenome)) {
        if (!genomeKey || !payload) continue
        try {
            window.localStorage.setItem(`${HUB_DISCOVERY_GENOME_CACHE_PREFIX}${genomeKey}`, JSON.stringify({
                saved_at: savedAt,
                payload,
            }))
        } catch {
            // ignore per-genome cache write failures
        }
    }
}

export function normalizeBigWigDataType(value, fallback = 'rna_seq') {
    return BIGWIG_DATA_TYPES.some((opt) => opt.id === value) ? value : fallback
}

export function normalizeHubDataUrl(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    try {
        const parsed = new URL(raw)
        if (parsed.protocol === 'http:') {
            parsed.protocol = 'https:'
            return parsed.toString()
        }
        return parsed.toString()
    } catch {
        return raw
    }
}

export function normalizeHubTrackType(row) {
    const rawFormat = String(row?.format || '').trim().toLowerCase()
    if (rawFormat.includes('bigwig')) return 'bigwig'
    if (rawFormat.includes('bigbed')) return 'bigbed'

    const rawUrl = String(row?.data_url || '').trim().toLowerCase().split('?', 1)[0]
    if (rawUrl.endsWith('.bw') || rawUrl.endsWith('.bigwig')) return 'bigwig'
    if (rawUrl.endsWith('.bb') || rawUrl.endsWith('.bigbed')) return 'bigbed'

    const rawType = String(row?.type || '').trim().toLowerCase()
    if (rawType === 'bigwig' || rawType === 'bigbed') return rawType
    return ''
}

export function hubTrackTypeLabel(trackType, row) {
    if (trackType === 'bigwig') return 'bigWig'
    if (trackType === 'bigbed') return 'bigBed'
    const fallback = String(row?.format || row?.type || '').trim()
    return fallback || 'Unknown'
}

export function titleCaseGenomeToken(value = '') {
    return String(value || '')
        .replace(/_/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
}

export function fallbackGenomeLabel(genomeKey = '') {
    const token = String(genomeKey || '').trim()
    if (!token) return 'No genome set'
    const parts = token.split('::')
    const species = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : '')
    const assembly = parts.length >= 3 ? parts.slice(2).join('::') : (parts.length === 2 ? parts[1] : token)
    const speciesLabel = titleCaseGenomeToken(species)
    return speciesLabel && assembly ? `${speciesLabel} - ${assembly}` : (speciesLabel || assembly || token)
}

export function buildGenomeDisplayLabel({ name = '', assemblyName = '', accession = '', fallback = '' } = {}) {
    const parts = []
    const speciesLabel = String(name || '').trim()
    const assemblyLabel = String(assemblyName || '').trim()
    const accessionLabel = String(accession || '').trim()
    if (speciesLabel) parts.push(speciesLabel)
    if (assemblyLabel) parts.push(assemblyLabel)
    if (accessionLabel && accessionLabel.toLowerCase() !== assemblyLabel.toLowerCase()) {
        parts.push(accessionLabel)
    }
    return parts.length ? parts.join(' - ') : String(fallback || '').trim()
}

export function findGenomeOption(genomeOptions = [], genomeKey = '') {
    return genomeOptions.find((option) => genomeKeysMatch(option.key, genomeKey))
}

export function normalizeBigWigDisplayMode(mode, dataType = 'rna_seq') {
    const token = String(mode || '').trim().toLowerCase()
    const normalizedType = normalizeBigWigDataType(dataType)
    if (token === 'line_plot' || token === 'bar_chart') return 'signal_plot'
    if (token === 'signal_plot' || token === 'zoned_heatmap') return token
    return BIGWIG_DEFAULTS[normalizedType].display_mode
}

export function normalizeHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

export function normalizeVcfSettings(raw = null, previous = null) {
    const prev = previous && typeof previous === 'object' ? previous : {}
    const base = {
        genic_color: normalizeHexColor(prev.genic_color, VCF_SETTINGS_DEFAULTS.genic_color),
        intergenic_color: normalizeHexColor(prev.intergenic_color, VCF_SETTINGS_DEFAULTS.intergenic_color),
    }
    const source = raw && typeof raw === 'object' ? raw : {}
    return {
        genic_color: normalizeHexColor(source.genic_color, base.genic_color),
        intergenic_color: normalizeHexColor(source.intergenic_color, base.intergenic_color),
    }
}

// '' means automatic: the file's own itemRgb colours, else the type's default.
export function normalizeBedSettings(raw = null) {
    const source = raw && typeof raw === 'object' ? raw : {}
    return { color: normalizeHexColor(source.color, '') }
}

export function normalizeZonedColors(rawColors, fallbackColors) {
    const fallback = Array.isArray(fallbackColors) && fallbackColors.length >= 4
        ? fallbackColors.slice(0, 4)
        : BIGWIG_DEFAULTS.rna_seq.zoned_colors.slice(0, 4)
    const source = Array.isArray(rawColors) ? rawColors : []
    return [0, 1, 2, 3].map((idx) => normalizeHexColor(source[idx], fallback[idx]))
}

export function normalizeBigWigSettings(raw = null, previous = null) {
    const prevType = normalizeBigWigDataType(previous?.data_type, 'rna_seq')
    const prevDefaults = BIGWIG_DEFAULTS[prevType]
    const prev = {
        data_type: prevType,
        plot_color: normalizeHexColor(previous?.plot_color, prevDefaults.plot_color),
        zoned_colors: normalizeZonedColors(previous?.zoned_colors, prevDefaults.zoned_colors),
        use_default_plot_color: previous?.use_default_plot_color !== false,
        use_default_zoned_colors: previous?.use_default_zoned_colors !== false,
    }

    const source = raw && typeof raw === 'object' ? raw : {}
    const data_type = normalizeBigWigDataType(source.data_type, prev.data_type)
    const defaults = BIGWIG_DEFAULTS[data_type]
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
            : normalizeHexColor(source.plot_color, prev.plot_color),
        zoned_colors: use_default_zoned_colors
            ? defaults.zoned_colors.slice(0, 4)
            : normalizeZonedColors(source.zoned_colors, prev.zoned_colors),
        use_default_plot_color,
        use_default_zoned_colors,
        zone_scale: ['fixed', 'file', 'files', 'custom'].includes(source.zone_scale)
            ? source.zone_scale
            : (['fixed', 'file', 'files', 'custom'].includes(previous?.zone_scale) ? previous.zone_scale : defaults.zone_scale),
        shared_zones: Array.isArray(source.shared_zones)
            ? source.shared_zones.map(Number)
            : (Array.isArray(previous?.shared_zones) ? previous.shared_zones.map(Number) : null),
        // As typed — NaN where a box holds no number — so the form can say what is wrong.
        custom_zones: Array.isArray(source.custom_zones)
            ? source.custom_zones.map(Number)
            : (Array.isArray(previous?.custom_zones) ? previous.custom_zones.map(Number) : null),
    }
}

export function applyBigWigDataTypeChange(nextType, currentDisplayMode, currentSettings) {
    const prev = normalizeBigWigSettings(currentSettings)
    const dataType = normalizeBigWigDataType(nextType, prev.data_type)
    const nextDefaults = BIGWIG_DEFAULTS[dataType]
    const prevDefaults = BIGWIG_DEFAULTS[prev.data_type]
    const normalizedMode = normalizeBigWigDisplayMode(currentDisplayMode, prev.data_type)
    const nextMode = normalizedMode === prevDefaults.display_mode
        ? nextDefaults.display_mode
        : normalizedMode
    // A new data type brings its own units, so its own zone scale too.
    const nextSettings = normalizeBigWigSettings({ data_type: dataType, zone_scale: nextDefaults.zone_scale }, prev)
    return { display_mode: nextMode, settings: nextSettings }
}

export function normalizeSpliceSettings(raw = {}) {
    const merged = { ...DEFAULT_SPLICE_SETTINGS, ...(raw || {}) }
    const canonical_mode = SPLICE_CANONICAL_OPTIONS.some(o => o.id === merged.canonical_mode) ? merged.canonical_mode : 'all'
    const annotated_mode = SPLICE_ANNOTATED_OPTIONS.some(o => o.id === merged.annotated_mode) ? merged.annotated_mode : 'all'
    const minSupport = Number.parseInt(merged.min_support, 10)
    const maxJunctions = Number.parseInt(merged.max_junctions, 10)
    const weakMax = Number.parseInt(merged.weak_max_support, 10)
    const lowMax = Number.parseInt(merged.low_max_support, 10)
    const mediumMax = Number.parseInt(merged.medium_max_support, 10)
    return {
        min_support: Number.isFinite(minSupport) ? Math.max(1, minSupport) : 1,
        canonical_mode,
        annotated_mode,
        show_arrows: merged.show_arrows !== false,
        max_junctions: Number.isFinite(maxJunctions) ? Math.max(100, maxJunctions) : 5000,
        weak_max_support: Number.isFinite(weakMax) ? Math.max(0, weakMax) : DEFAULT_SPLICE_SETTINGS.weak_max_support,
        low_max_support: Number.isFinite(lowMax) ? Math.max(0, lowMax) : DEFAULT_SPLICE_SETTINGS.low_max_support,
        medium_max_support: Number.isFinite(mediumMax) ? Math.max(0, mediumMax) : DEFAULT_SPLICE_SETTINGS.medium_max_support,
    }
}

export function coerceSpliceSettingsForSave(raw = {}) {
    const merged = { ...DEFAULT_SPLICE_SETTINGS, ...(raw || {}) }
    const minSupportRaw = Number.parseInt(merged.min_support, 10)
    const weakRaw = Number.parseInt(merged.weak_max_support, 10)
    const lowRaw = Number.parseInt(merged.low_max_support, 10)
    const mediumRaw = Number.parseInt(merged.medium_max_support, 10)
    const minSupport = Number.isFinite(minSupportRaw) ? Math.max(1, minSupportRaw) : DEFAULT_SPLICE_SETTINGS.min_support
    const weak = Number.isFinite(weakRaw) ? weakRaw : DEFAULT_SPLICE_SETTINGS.weak_max_support
    const low = Number.isFinite(lowRaw) ? lowRaw : DEFAULT_SPLICE_SETTINGS.low_max_support
    const medium = Number.isFinite(mediumRaw) ? mediumRaw : DEFAULT_SPLICE_SETTINGS.medium_max_support
    const validSupportTiers = (
        weak >= minSupport
        && low > weak
        && medium > low
    )
    if (validSupportTiers) {
        return { settings: normalizeSpliceSettings(raw), warning: '' }
    }
    return {
        settings: normalizeSpliceSettings(DEFAULT_SPLICE_SETTINGS),
        warning: 'Invalid splice support tiers detected; reverted to defaults and saved.',
    }
}

export function basenameFromPath(p = '') {
    return p.replace(/\\/g, '/').split('/').pop() || p
}

export function stemFromPath(p = '') {
    const base = basenameFromPath(p)
    // Strip common extensions
    return base
        .replace(/\.(vcf\.gz|bed\.gz|gff3\.gz|gff\.gz|gtf\.gz|bigwig|bigbed|sj\.out\.tab|bam|bw|bb|vcf|bed|gff3|gff|gtf)$/i, '')
        .replace(/[_\-.]/g, ' ')
        .trim()
}

export function detectTypeFromPath(path = '') {
    const lower = path.toLowerCase()
    if (lower.endsWith('.bw') || lower.endsWith('.bigwig')) return 'bigwig'
    if (lower.endsWith('.bb') || lower.endsWith('.bigbed')) return 'bigbed'
    if (lower.endsWith('.vcf.gz') || lower.endsWith('.vcf')) return 'vcf'
    if (lower.endsWith('.bed.gz') || lower.endsWith('.bed')) return 'bed'
    if (/\.(gff3?|gtf)(\.gz)?$/.test(lower)) return 'gff'
    if (lower.endsWith('.sj.out.tab')) return 'splice_junctions'
    if (lower.endsWith('.bam')) {
        // Heuristic: long-read if name contains these keywords
        const isLongRead = ['minimap', 'ont', 'pacbio', 'isoseq', 'nanopore', 'flair', 'longread', 'long_read'].some(k => lower.includes(k))
        return isLongRead ? 'long_reads' : 'bam'
    }
    return null
}

// ── GenomeComboBox ────────────────────────────────────────────────────────────

// The name to show for a chosen genome key: the installed genome it belongs to, matched
// by assembly so a key with or without a dataset suffix finds it, or the key itself.
export function genomeDisplayText(value, genomeOptions) {
    if (!value) return ''
    const assembly = trackAssemblyKey(value)
    const match = genomeOptions.find((g) => g.key === value)
        || genomeOptions.find((g) => trackAssemblyKey(g.key) === assembly)
    return match ? match.label : value
}

// A type's options before anything is chosen: what picking a file of that type has
// always started from. A GFF/GTF starts on Automatic (''): the backend reads it as gene
// models when it has transcript structure, otherwise as intervals.
export function defaultTypeSettings(type) {
    const modes = DISPLAY_MODES[type] || []
    const firstMode = modes.length ? modes[0].id : ''
    return {
        displayMode: type === 'bigwig' || type === 'gff'
            ? ''
            : type === 'vcf' ? normalizeVcfDisplayMode(firstMode) : firstMode,
        bigWigDataType: '',
        bigWigSettings: normalizeBigWigSettings(null),
        vcfSettings: normalizeVcfSettings(null),
        bedSettings: normalizeBedSettings(null),
        spliceSettings: DEFAULT_SPLICE_SETTINGS,
    }
}

export const typeLabelOf = (type) => TRACK_TYPES.find((t) => t.id === type)?.label || 'Unrecognised'

// A registered track's settings in the shape the dialog edits.
export function settingsFromTrack(track) {
    const type = track?.type || ''
    const base = defaultTypeSettings(type)
    if (type === 'bigwig') {
        const bigWigSettings = normalizeBigWigSettings(track.bigwig_settings)
        return {
            ...base,
            bigWigSettings,
            bigWigDataType: bigWigSettings.data_type,
            displayMode: normalizeBigWigDisplayMode(track.display_mode, bigWigSettings.data_type),
        }
    }
    if (type === 'vcf') return { ...base, displayMode: normalizeVcfDisplayMode(track.display_mode), vcfSettings: normalizeVcfSettings(track.vcf_settings) }
    if (['bed', 'bigbed', 'gff'].includes(type)) {
        return { ...base, displayMode: track.display_mode || base.displayMode, bedSettings: normalizeBedSettings(track.bed_settings) }
    }
    if (type === 'splice_junctions') return { ...base, displayMode: 'arcs', spliceSettings: normalizeSpliceSettings(track.splice_settings) }
    return { ...base, displayMode: track?.display_mode || base.displayMode }
}

// The API's fields for one type's settings in the dialog's shape: what a track is
// registered or saved with, and what a track group keeps as its own for a member.
export function settingsToTrackFields(type, settings) {
    let splicePayload
    let spliceWarning = ''
    if (type === 'splice_junctions') {
        const coerced = coerceSpliceSettingsForSave(settings.spliceSettings)
        splicePayload = coerced.settings
        spliceWarning = coerced.warning || ''
    }
    return {
        spliceWarning,
        fields: {
            display_mode: type === 'bigwig'
                ? normalizeBigWigDisplayMode(settings.displayMode, settings.bigWigDataType || settings.bigWigSettings?.data_type)
                : type === 'vcf' ? normalizeVcfDisplayMode(settings.displayMode) : settings.displayMode,
            splice_settings: type === 'splice_junctions' ? splicePayload : undefined,
            bigwig_settings: type === 'bigwig'
                ? normalizeBigWigSettings({ ...settings.bigWigSettings, data_type: settings.bigWigDataType }, settings.bigWigSettings)
                : undefined,
            vcf_settings: type === 'vcf' ? normalizeVcfSettings(settings.vcfSettings) : undefined,
            bed_settings: ['bed', 'bigbed', 'gff'].includes(type) ? normalizeBedSettings(settings.bedSettings) : undefined,
        },
    }
}

// Both built by the same functions, so equal settings serialise identically.
export const sameTypeSettings = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Whether TypeSettingsEditor has anything to show for a type.
export const typeHasSettings = (type) => type === 'bigwig'
    || (DISPLAY_MODES[type] || []).length > 1
    || ['splice_junctions', 'vcf', 'bed', 'bigbed', 'gff'].includes(type)

// ── Track Card ────────────────────────────────────────────────────────────────

// ── Track groups ──────────────────────────────────────────────────────────────
//
// A named, ordered set of one genome's tracks, switched on together in the Genome
// Browser. A member uses its track's own settings unless the group is given settings of
// its own for it; those belong to the group alone and leave the track as it is.

export const GROUP_LAYOUTS = [
    {
        id: 'separate',
        label: 'Separate tracks',
        hint: 'Each track gets its own row, labelled CG. The group switches them on and off together.',
    },
    {
        id: 'joined',
        label: 'One joined track',
        hint: 'All the tracks share one CG row, stacked in the order below.',
    },
]

// The Add Track dialog's "Add to track group" choice for a group made on the spot.
export const NEW_TRACK_GROUP = '__new__'

export const groupLayoutLabel = (layout) => GROUP_LAYOUTS.find((l) => l.id === layout)?.label || GROUP_LAYOUTS[0].label

// The settings a member shows with: the group's own, or its track's.
export const memberSettings = (member, track) => member.custom || settingsFromTrack(track)

// The API's fields for a member's own settings, without the ones its type does not use.
export function memberSettingsFields(type, settings) {
    const { fields } = settingsToTrackFields(type, settings)
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

/**
 * TrackManagerView — register, browse, and manage custom data tracks.
 * Tracks are persisted to disk via the backend's /api/tracks endpoints.
 */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import GenomeColorPicker, { ColorSwatch } from './GenomeColorPicker'
import { genomeColorPalette } from '../genomeColorSchemes'
import { checkCustomZones, formatZoneLabel, initialCustomZones, rememberCustomZones } from '../utils/zonedScale'
import { DEFAULT_BATCH_NAMING, applySettingsChange, batchLabel, groupFilesByType, suggestStartIndex } from '../utils/trackBatch'
import FileBrowserModal from './FileBrowserModal'
import { TUTORIAL_TRACK_PRESETS } from '../utils/tutorialTrackRegistry'

import { API_BASE } from '../backendRuntime'
import { genomeKeysMatch, getGenomeKey, normalizeGenomeProvider, trackAssemblyKey } from '../utils/genomeIdentity'

// ── Constants ────────────────────────────────────────────────────────────────

const TRACK_TYPES = [
    { id: 'bigwig', label: 'BigWig', ext: '.bw / .bigwig', desc: 'Continuous signal (coverage, ChIP-seq, ATAC-seq)' },
    { id: 'vcf', label: 'VCF', ext: '.vcf.gz (+ .tbi)', desc: 'Tabix-indexed variants (SNPs, indels, SVs)' },
    { id: 'bed', label: 'BED', ext: '.bed / .bed.gz', desc: 'Genomic intervals (peaks, repeats, regions)' },
    { id: 'gff', label: 'GFF / GTF', ext: '.gff / .gff3 / .gtf (.gz)', desc: 'Features or gene models, for display only (regulatory build, repeats, transcripts)' },
    { id: 'bigbed', label: 'BigBED', ext: '.bb / .bigBed', desc: 'Indexed intervals for large BED files' },
    { id: 'splice_junctions', label: 'Splice Junctions', ext: '.SJ.out.tab', desc: 'STAR splice-junction file (arc / sashimi plot)' },
    { id: 'bam', label: 'BAM (short reads)', ext: '.bam (+ .bai)', desc: 'Short-read alignments (coverage + reads)' },
    { id: 'long_reads', label: 'Long Reads (minimap2)', ext: '.bam (+ .bai)', desc: 'minimap2 / IsoSeq / ONT — collapsed transcript models' },
]

const DISPLAY_MODES = {
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

const BIGWIG_DATA_TYPES = [
    { id: 'rna_seq', label: 'RNA-seq' },
    { id: 'atac_seq', label: 'ATAC-seq' },
    { id: 'chip_seq', label: 'Chip-seq' },
    { id: 'custom', label: 'Custom' },
]

const BIGWIG_DEFAULTS = {
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
const ZONE_SCALES = [
    { id: 'fixed', label: 'Fixed: 100 / 1k / 10k / 100k', hint: 'For read coverage (RNA-seq).' },
    { id: 'file', label: "Scaled to this file's peaks", hint: "Zone edges at this file's typical, strong, very strong and top peak heights; for signal in other units (ATAC, ChIP)." },
    { id: 'custom', label: 'Custom', hint: 'Set where each zone ends yourself. The last zones you saved are offered first on the next track.' },
]

// The zone scales to offer. Files registered together that share settings are scaled
// across all of them, so their tracks compare directly — worded as such. A track saved
// that way keeps the choice, with the edges it was given.
function zoneScaleOptions(sharedFileCount = 1, settings = null) {
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
function customZoneProblem(settings, displayMode) {
    if (displayMode !== 'zoned_heatmap' || settings?.zone_scale !== 'custom') return ''
    const check = checkCustomZones(settings?.custom_zones)
    return check.ok ? '' : `Custom zones: ${check.message}`
}

const VCF_SETTINGS_DEFAULTS = {
    genic_color: '#00b692',
    intergenic_color: '#96d0c9',
}

const TYPE_COLORS = {
    bigwig: '#3b82f6',
    vcf: '#f59e0b',
    bed: '#10b981',
    gff: '#0891b2',
    bigbed: '#059669',
    splice_junctions: '#8b5cf6',
    bam: '#ef4444',
    long_reads: '#ec4899',
}

const DEFAULT_SPLICE_SETTINGS = {
    min_support: 1,
    canonical_mode: 'all',
    annotated_mode: 'all',
    show_arrows: true,
    max_junctions: 5000,
    weak_max_support: 2,
    low_max_support: 4,
    medium_max_support: 9,
}

const SPLICE_CANONICAL_OPTIONS = [
    { id: 'all', label: 'All motifs' },
    { id: 'canonical', label: 'Canonical only' },
    { id: 'non_canonical', label: 'Non-canonical only' },
]

const SPLICE_ANNOTATED_OPTIONS = [
    { id: 'all', label: 'All junctions' },
    { id: 'annotated', label: 'Annotated only' },
    { id: 'novel', label: 'Novel only' },
]

const HUB_TRACK_ROW_HEIGHT = 86
const HUB_TRACK_OVERSCAN = 6
const HUB_TRACK_VIRTUALIZE_THRESHOLD = 120
const HUB_TRACK_VIRTUALIZED_MAX_HEIGHT = 344
const HUB_DISCOVERY_CACHE_PREFIX = 'trackhub_discovery_cache_v3::'
const HUB_DISCOVERY_GENOME_CACHE_PREFIX = 'trackhub_discovery_cache_genome_v2::'

const IconUpDown = ({ open, size = 12 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
    >
        <polyline points="6 9 12 15 18 9" />
    </svg>
)

function buildHubDiscoveryCacheKey(genomes = []) {
    const normalized = [...(Array.isArray(genomes) ? genomes : [])]
        .map((g) => String(g?.genome_key || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    if (normalized.length === 0) return ''
    return `${HUB_DISCOVERY_CACHE_PREFIX}${JSON.stringify(normalized)}`
}

function normalizeHubDiscoveryPayload(byGenome) {
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

function buildHubDiscoverySignature(byGenome) {
    return JSON.stringify(normalizeHubDiscoveryPayload(byGenome))
}

function readHubDiscoveryCache(cacheKey, genomes = []) {
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

function writeHubDiscoveryCache(cacheKey, byGenome, signature = '') {
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

function normalizeBigWigDataType(value, fallback = 'rna_seq') {
    return BIGWIG_DATA_TYPES.some((opt) => opt.id === value) ? value : fallback
}

function normalizeHubDataUrl(value) {
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

function normalizeHubTrackType(row) {
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

function hubTrackTypeLabel(trackType, row) {
    if (trackType === 'bigwig') return 'bigWig'
    if (trackType === 'bigbed') return 'bigBed'
    const fallback = String(row?.format || row?.type || '').trim()
    return fallback || 'Unknown'
}

function titleCaseGenomeToken(value = '') {
    return String(value || '')
        .replace(/_/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
}

function fallbackGenomeLabel(genomeKey = '') {
    const token = String(genomeKey || '').trim()
    if (!token) return 'No genome set'
    const parts = token.split('::')
    const species = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : '')
    const assembly = parts.length >= 3 ? parts.slice(2).join('::') : (parts.length === 2 ? parts[1] : token)
    const speciesLabel = titleCaseGenomeToken(species)
    return speciesLabel && assembly ? `${speciesLabel} - ${assembly}` : (speciesLabel || assembly || token)
}

function buildGenomeDisplayLabel({ name = '', assemblyName = '', accession = '', fallback = '' } = {}) {
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

function findGenomeOption(genomeOptions = [], genomeKey = '') {
    return genomeOptions.find((option) => genomeKeysMatch(option.key, genomeKey))
}

function normalizeBigWigDisplayMode(mode, dataType = 'rna_seq') {
    const token = String(mode || '').trim().toLowerCase()
    const normalizedType = normalizeBigWigDataType(dataType)
    if (token === 'line_plot' || token === 'bar_chart') return 'signal_plot'
    if (token === 'signal_plot' || token === 'zoned_heatmap') return token
    return BIGWIG_DEFAULTS[normalizedType].display_mode
}

function normalizeVcfDisplayMode(mode) {
    let token = String(mode || '').trim().toLowerCase()
    if (token === 'block_lollipop' || token === 'block-lollipop') token = 'adaptive'
    if (token === 'ensembl' || token === 'lollipop' || token === 'density') token = 'density_lollipop'
    return token === 'adaptive' || token === 'density_lollipop' ? token : 'density_lollipop'
}

function normalizeHexColor(value, fallback) {
    const token = String(value || '').trim()
    return /^#[0-9a-fA-F]{6}$/.test(token) ? token.toLowerCase() : String(fallback || '').toLowerCase()
}

function normalizeVcfSettings(raw = null, previous = null) {
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
function normalizeBedSettings(raw = null) {
    const source = raw && typeof raw === 'object' ? raw : {}
    return { color: normalizeHexColor(source.color, '') }
}

function normalizeZonedColors(rawColors, fallbackColors) {
    const fallback = Array.isArray(fallbackColors) && fallbackColors.length >= 4
        ? fallbackColors.slice(0, 4)
        : BIGWIG_DEFAULTS.rna_seq.zoned_colors.slice(0, 4)
    const source = Array.isArray(rawColors) ? rawColors : []
    return [0, 1, 2, 3].map((idx) => normalizeHexColor(source[idx], fallback[idx]))
}

function normalizeBigWigSettings(raw = null, previous = null) {
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

/** Four boxes for where each zone ends, checked as they are typed. */
function CustomZonesEditor({ zones, onChange, isLight, inputCls }) {
    const fromZones = (list) => [0, 1, 2, 3].map((i) => {
        const v = Array.isArray(list) ? list[i] : undefined
        return Number.isFinite(v) ? String(v) : ''
    })
    const [drafts, setDrafts] = useState(() => fromZones(zones))
    // Follow zones set from outside (switching to custom, a reset) without fighting the
    // boxes while they are typed in: only when they no longer describe what is shown.
    useEffect(() => {
        const shown = checkCustomZones(drafts).zones
        const incoming = Array.isArray(zones) ? zones : []
        const same = shown.every((v, i) => Object.is(v, Number(incoming[i])) || (Number.isNaN(v) && Number.isNaN(Number(incoming[i]))))
        if (!same) setDrafts(fromZones(zones))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [zones])
    const check = checkCustomZones(drafts)
    const update = (index, text) => {
        const next = drafts.slice()
        next[index] = text
        setDrafts(next)
        onChange(checkCustomZones(next).zones)
    }
    return (
        <div className="mb-3">
            <div className="grid grid-cols-2 gap-2">
                {drafts.map((text, index) => (
                    <label key={index} className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                        <span className="w-24 shrink-0">Zone {index + 1} up to</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            value={text}
                            onChange={(e) => update(index, e.target.value)}
                            aria-invalid={!check.ok && !Number.isFinite(check.zones[index]) ? 'true' : undefined}
                            className={inputCls}
                        />
                    </label>
                ))}
            </div>
            <p className={`mt-1 text-xs ${check.ok
                ? (isLight ? 'text-gray-500' : 'text-gray-400')
                : (isLight ? 'text-red-600' : 'text-red-400')}`}
            >
                {check.ok
                    ? `Values above ${formatZoneLabel(check.zones[3]).slice(1)} fill the top zone.`
                    : check.message}
            </p>
        </div>
    )
}

function applyBigWigDataTypeChange(nextType, currentDisplayMode, currentSettings) {
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

function normalizeSpliceSettings(raw = {}) {
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

function coerceSpliceSettingsForSave(raw = {}) {
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

function SpliceSettingsEditor({ value, onChange, isLight }) {
    const settings = normalizeSpliceSettings(value)
    const weakLt = Number(settings.weak_max_support) + 1
    const lowLt = Number(settings.low_max_support) + 1
    const mediumLt = Number(settings.medium_max_support) + 1
    const [minSupportInput, setMinSupportInput] = useState(String(settings.min_support))
    const [weakLtInput, setWeakLtInput] = useState(String(weakLt))
    const [lowLtInput, setLowLtInput] = useState(String(lowLt))
    const [mediumLtInput, setMediumLtInput] = useState(String(mediumLt))

    useEffect(() => { setMinSupportInput(String(settings.min_support)) }, [settings.min_support])
    useEffect(() => { setWeakLtInput(String(weakLt)) }, [weakLt])
    useEffect(() => { setLowLtInput(String(lowLt)) }, [lowLt])
    useEffect(() => { setMediumLtInput(String(mediumLt)) }, [mediumLt])

    const cleanNumericInput = (raw) => String(raw || '').replace(/[^\d]/g, '')
    const commitMinSupport = () => {
        const parsed = Number.parseInt(minSupportInput, 10)
        onChange({ ...settings, min_support: Number.isFinite(parsed) && parsed > 0 ? parsed : 1 })
    }
    const commitWeakLt = () => {
        const parsed = Number.parseInt(weakLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, weak_max_support: Math.max(0, lt - 1) })
    }
    const commitLowLt = () => {
        const parsed = Number.parseInt(lowLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, low_max_support: Math.max(0, lt - 1) })
    }
    const commitMediumLt = () => {
        const parsed = Number.parseInt(mediumLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, medium_max_support: Math.max(0, lt - 1) })
    }
    const inputCls = `w-full px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const labelCls = `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`
    return (
        <div className={`rounded-lg border p-3 space-y-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div className="grid grid-cols-1 gap-2">
                <div>
                    <label className={labelCls}>Min support</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={minSupportInput}
                        onChange={(e) => setMinSupportInput(cleanNumericInput(e.target.value))}
                        onBlur={commitMinSupport}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitMinSupport()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
                <div>
                    <label className={labelCls}>Weak (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={weakLtInput}
                        onChange={(e) => setWeakLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitWeakLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitWeakLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
                <div>
                    <label className={labelCls}>Low (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={lowLtInput}
                        onChange={(e) => setLowLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitLowLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitLowLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
                <div>
                    <label className={labelCls}>Medium (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={mediumLtInput}
                        onChange={(e) => setMediumLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitMediumLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitMediumLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
            </div>
            <p className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Rule: weak cutoff ≥ min support, low {'>'} weak, medium {'>'} low. High is support ≥ medium cutoff.
            </p>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className={labelCls}>Canonical filter</label>
                    <select
                        value={settings.canonical_mode}
                        onChange={(e) => onChange({ ...settings, canonical_mode: e.target.value })}
                        className={inputCls}
                    >
                        {SPLICE_CANONICAL_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelCls}>Annotation filter</label>
                    <select
                        value={settings.annotated_mode}
                        onChange={(e) => onChange({ ...settings, annotated_mode: e.target.value })}
                        className={inputCls}
                    >
                        {SPLICE_ANNOTATED_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                    </select>
                </div>
            </div>
            <label className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                <input
                    type="checkbox"
                    checked={!!settings.show_arrows}
                    onChange={(e) => onChange({ ...settings, show_arrows: e.target.checked })}
                />
                Show direction arrows
            </label>
        </div>
    )
}

function VcfSettingsEditor({ settings, onChange, isLight, trackLabel = '' }) {
    const normalized = normalizeVcfSettings(settings)
    return (
        <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div className="grid grid-cols-2 gap-3">
                <TrackColorField
                    label="Genic colour"
                    color={normalized.genic_color}
                    defaultColor={VCF_SETTINGS_DEFAULTS.genic_color}
                    onChange={(genic_color) => onChange({ ...normalized, genic_color })}
                    isLight={isLight}
                    previewKind="variants"
                    pickerTitle="Genic variant colour"
                    pickerSubtitle={trackLabel}
                />
                <TrackColorField
                    label="Intergenic colour"
                    color={normalized.intergenic_color}
                    defaultColor={VCF_SETTINGS_DEFAULTS.intergenic_color}
                    onChange={(intergenic_color) => onChange({ ...normalized, intergenic_color })}
                    isLight={isLight}
                    previewKind="variants"
                    pickerTitle="Intergenic variant colour"
                    pickerSubtitle={trackLabel}
                />
            </div>
        </div>
    )
}

// The app's palette (built-in plus the user's own colours), provided once by the view so
// every track colour field offers the same choices as the Genome Selector.
const TrackColorPaletteContext = createContext(null)

/** A small picture of a track drawn in one colour, for the picker's preview. */
function TrackColorPreview({ color, kind = 'intervals', isLight }) {
    const bg = isLight ? '#ffffff' : '#1E2938'
    const axis = isLight ? '#d8dee7' : '#3a4557'
    let body
    if (kind === 'signal') {
        const ys = [30, 26, 12, 20, 34, 8, 16, 28, 22, 6, 18, 30, 24, 14, 32, 26, 10, 22, 30, 20]
        const step = 320 / (ys.length - 1)
        const line = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y + 10}`).join(' ')
        body = <path d={`${line} L320,50 L0,50 Z`} fill={color} opacity="0.85" />
    } else if (kind === 'variants') {
        body = [18, 46, 60, 104, 150, 158, 212, 250, 284].map((x, i) => (
            <g key={x}>
                <line x1={x} x2={x} y1={46} y2={18 + (i % 3) * 7} stroke={color} strokeWidth="1.5" />
                <circle cx={x} cy={16 + (i % 3) * 7} r="3" fill={color} />
            </g>
        ))
    } else {
        body = [[10, 26], [52, 12], [80, 40], [150, 18], [180, 8], [214, 52], [290, 20]].map(([x, w]) => (
            <rect key={x} x={x} y={22} width={w} height={12} rx="1.5" fill={color} opacity="0.9" />
        ))
    }
    return (
        <div className={`rounded-xl border overflow-hidden ${isLight ? 'border-gray-200' : 'border-gray-700'}`} style={{ background: bg }}>
            <svg viewBox="0 0 320 56" className="block w-full" role="img" aria-label={`Track preview in ${color}`}>
                <line x1="0" x2="320" y1="50.5" y2="50.5" stroke={axis} strokeWidth="1" />
                {body}
            </svg>
        </div>
    )
}

/** A track colour: the app's rounded swatch, which opens the shared colour picker.
 *
 *  `automatic` is for a colour whose default is "whatever the file says" (BED itemRgb):
 *  then an empty value means automatic, and choosing the default colour returns to it. */
function TrackColorField({
    label,
    color,
    defaultColor,
    onChange,
    isLight,
    previewKind = 'intervals',
    pickerTitle = 'Track colour',
    pickerSubtitle = '',
    automatic = false,
    compact = false,
}) {
    const palette = useContext(TrackColorPaletteContext)
    const [open, setOpen] = useState(false)
    const isAutomatic = automatic && !color
    const shown = color || defaultColor
    // Too narrow for the marker in the compact grid; the zones have "Reset to defaults".
    const isDefault = !automatic && !compact && shown === defaultColor
    return (
        <div className={compact ? 'flex items-center gap-2' : ''}>
            {label ? (
                <span className={compact
                    ? `text-xs w-12 shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-300'}`
                    : `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}
                >
                    {label}
                </span>
            ) : null}
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`inline-flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${isLight ? 'hover:bg-blue-50' : 'hover:bg-blue-900/20'}`}
                title={`${pickerTitle}: ${isAutomatic ? 'automatic' : shown}`}
                aria-label={`Choose ${pickerTitle.toLowerCase()}`}
            >
                <ColorSwatch color={shown} />
                <span className={`text-xs font-mono ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                    {isAutomatic ? 'Automatic' : shown}
                    {isDefault ? <span className={isLight ? 'text-gray-400' : 'text-gray-500'}> · default</span> : null}
                </span>
            </button>
            {open && typeof document !== 'undefined' ? createPortal(
                <GenomeColorPicker
                    isOpen
                    theme={isLight ? 'light' : 'dark'}
                    title={pickerTitle}
                    subtitle={pickerSubtitle}
                    palette={palette || genomeColorPalette(null)}
                    currentColor={shown}
                    defaultColor={defaultColor}
                    defaultLabel={automatic ? 'Automatic' : 'Use default'}
                    paletteHint={automatic
                        ? 'Automatic uses the colours written in the file where it has them, and this default where it does not.'
                        : 'Choose from the palette, or mix a custom colour.'}
                    renderPreview={(c) => <TrackColorPreview color={c} kind={previewKind} isLight={isLight} />}
                    onApply={(next) => onChange(automatic && next === defaultColor ? '' : next)}
                    onClose={() => setOpen(false)}
                />,
                document.body,
            ) : null}
        </div>
    )
}

function BedSettingsEditor({ settings, trackType, onChange, isLight, trackLabel = '' }) {
    const normalized = normalizeBedSettings(settings)
    return (
        <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
        <TrackColorField
            color={normalized.color}
            defaultColor={TYPE_COLORS[trackType] || TYPE_COLORS.bed}
            onChange={(color) => onChange({ color })}
            isLight={isLight}
            previewKind="intervals"
            pickerTitle="Track colour"
            pickerSubtitle={trackLabel}
            automatic
        />
        </div>
    )
}

function BigWigSettingsEditor({
    settings,
    displayMode,
    // More than one: the settings are shared by that many files registered together, and
    // "scaled to the file" means scaled across all of them.
    sharedFileCount = 1,
    onSettingsChange,
    onDisplayModeChange,
    onDataTypeChange,
    onDataTypeSelect,
    selectedDataType = '',
    requireDataTypeSelection = false,
    isLight,
    // Anchored by the caller: the wizard and an editing track card both render this, and
    // an anchor resolves to the first match, so only one of them may carry the ids.
    dataTypeTourId,
    displayModeTourId,
}) {
    const normalized = normalizeBigWigSettings(settings)
    const hasDataTypeSelection = !requireDataTypeSelection || !!selectedDataType
    const effectiveDataType = hasDataTypeSelection
        ? normalizeBigWigDataType(selectedDataType || normalized.data_type, normalized.data_type)
        : ''
    const effectiveSettings = hasDataTypeSelection
        ? normalizeBigWigSettings({ data_type: effectiveDataType }, normalized)
        : normalized
    const inputCls = `w-full px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const labelCls = `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`

    const handleDataType = (nextType) => {
        const token = String(nextType || '').trim()
        if (!token) return
        onDataTypeSelect?.(token)
        const changed = applyBigWigDataTypeChange(nextType, displayMode, normalized)
        if (onDataTypeChange) {
            onDataTypeChange(changed.settings, changed.display_mode)
            return
        }
        onSettingsChange(changed.settings)
        onDisplayModeChange(changed.display_mode)
    }

    const resetPlotColor = () => {
        const defaults = BIGWIG_DEFAULTS[effectiveSettings.data_type]
        onSettingsChange({
            ...effectiveSettings,
            plot_color: defaults.plot_color,
            use_default_plot_color: true,
        })
    }

    const resetZonedColors = () => {
        const defaults = BIGWIG_DEFAULTS[effectiveSettings.data_type]
        onSettingsChange({
            ...effectiveSettings,
            zoned_colors: defaults.zoned_colors.slice(0, 4),
            use_default_zoned_colors: true,
        })
    }

    return (
        <div className={`rounded-lg border p-3 space-y-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div>
                <label className={labelCls}>Data type</label>
                <select
                    data-tour-id={dataTypeTourId}
                    value={requireDataTypeSelection ? selectedDataType : effectiveSettings.data_type}
                    onChange={(e) => handleDataType(e.target.value)}
                    className={inputCls}
                >
                    {requireDataTypeSelection && <option value="">Select data type…</option>}
                    {BIGWIG_DATA_TYPES.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                </select>
            </div>
            {hasDataTypeSelection ? (
                <>
                    <div>
                        <label className={labelCls}>Display mode</label>
                        <select
                            data-tour-id={displayModeTourId}
                            value={displayMode}
                            onChange={(e) => onDisplayModeChange(normalizeBigWigDisplayMode(e.target.value, effectiveSettings.data_type))}
                            className={inputCls}
                        >
                            {(DISPLAY_MODES.bigwig || []).map((m) => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                        </select>
                    </div>
                    {displayMode === 'signal_plot' ? (
                        <div>
                            <TrackColorField
                                label="Plot colour"
                                color={effectiveSettings.plot_color}
                                defaultColor={BIGWIG_DEFAULTS[effectiveSettings.data_type].plot_color}
                                onChange={(plot_color) => {
                                    if (plot_color === BIGWIG_DEFAULTS[effectiveSettings.data_type].plot_color) {
                                        resetPlotColor()
                                        return
                                    }
                                    onSettingsChange({ ...effectiveSettings, plot_color, use_default_plot_color: false })
                                }}
                                isLight={isLight}
                                previewKind="signal"
                                pickerTitle="Plot colour"
                            />
                        </div>
                    ) : (
                        <div>
                            <label className={labelCls}>Zone scale</label>
                            <select
                                value={effectiveSettings.zone_scale}
                                onChange={(e) => {
                                    const zoneScale = e.target.value
                                    // Custom starts from this track's own zones, else the last ones
                                    // saved on any track, else the fixed ones.
                                    onSettingsChange(zoneScale === 'custom'
                                        ? { ...effectiveSettings, zone_scale: zoneScale, custom_zones: initialCustomZones(effectiveSettings.custom_zones) }
                                        : { ...effectiveSettings, zone_scale: zoneScale })
                                }}
                                className={inputCls}
                            >
                                {zoneScaleOptions(sharedFileCount, effectiveSettings).map((opt) => (
                                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                                ))}
                            </select>
                            <p className={`mt-1 mb-3 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {zoneScaleOptions(sharedFileCount, effectiveSettings).find((opt) => opt.id === effectiveSettings.zone_scale)?.hint}
                            </p>
                            {effectiveSettings.zone_scale === 'custom' && (
                                <CustomZonesEditor
                                    zones={effectiveSettings.custom_zones}
                                    onChange={(customZones) => onSettingsChange({ ...effectiveSettings, custom_zones: customZones })}
                                    isLight={isLight}
                                    inputCls={inputCls}
                                />
                            )}
                            <label className={labelCls}>Zone colours</label>
                            <div className="grid grid-cols-2 gap-2">
                                {effectiveSettings.zoned_colors.map((color, idx) => (
                                    <TrackColorField
                                        key={idx}
                                        compact
                                        label={`Zone ${idx + 1}`}
                                        color={color}
                                        defaultColor={BIGWIG_DEFAULTS[effectiveSettings.data_type].zoned_colors[idx]}
                                        onChange={(nextColor) => {
                                            const next = effectiveSettings.zoned_colors.slice(0, 4)
                                            next[idx] = nextColor
                                            onSettingsChange({
                                                ...effectiveSettings,
                                                zoned_colors: next,
                                                use_default_zoned_colors: false,
                                            })
                                        }}
                                        isLight={isLight}
                                        previewKind="signal"
                                        pickerTitle={`Zone ${idx + 1} colour`}
                                    />
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={resetZonedColors}
                                className={`mt-2 px-2.5 py-1.5 rounded-md text-xs font-medium ${isLight ? 'text-blue-700 bg-blue-50 hover:bg-blue-100' : 'text-blue-300 bg-blue-900/30 hover:bg-blue-900/50'}`}
                            >
                                Reset to defaults
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    Select a data type to load display mode and color defaults.
                </p>
            )}
        </div>
    )
}

function basenameFromPath(p = '') {
    return p.replace(/\\/g, '/').split('/').pop() || p
}

function stemFromPath(p = '') {
    const base = basenameFromPath(p)
    // Strip common extensions
    return base
        .replace(/\.(vcf\.gz|bed\.gz|gff3\.gz|gff\.gz|gtf\.gz|bigwig|bigbed|sj\.out\.tab|bam|bw|bb|vcf|bed|gff3|gff|gtf)$/i, '')
        .replace(/[_\-.]/g, ' ')
        .trim()
}

function detectTypeFromPath(path = '') {
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

// ── Sub-components ────────────────────────────────────────────────────────────

function TypeBadge({ type, small = false }) {
    const color = TYPE_COLORS[type] || '#64748b'
    const label = TRACK_TYPES.find(t => t.id === type)?.label || type
    return (
        <span
            className={`inline-flex items-center rounded font-semibold ${small ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5'}`}
            style={{ backgroundColor: color + '22', color, border: `1px solid ${color}55` }}
        >
            {label}
        </span>
    )
}

function EmptyState({ isLight }) {
    return (
        <div className={`flex flex-col items-center justify-center h-64 rounded-xl border-2 border-dashed ${isLight ? 'border-gray-200 text-gray-400' : 'border-gray-700 text-gray-500'}`}>
            <svg className="w-12 h-12 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-6M12 17v-2M15 17v-4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
            </svg>
            <p className="text-sm font-medium">No tracks registered yet</p>
            <p className="text-xs mt-1 opacity-70">Click "Add Track" to register your first custom track</p>
        </div>
    )
}

// ── Genome note helper ────────────────────────────────────────────────────────

function GenomeNote({ genomeKey, genomeOptions, isLight }) {
    if (!genomeKey) return null
    const isKnown = genomeOptions.some(g => genomeKeysMatch(g.key, genomeKey))
    if (isKnown) return null
    return (
        <p className={`text-xs mt-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
            No local data for this genome — it will be saved, but won't display until a matching genome is added in the Genome Selector.
        </p>
    )
}

// ── GenomeComboBox ────────────────────────────────────────────────────────────

// The name to show for a chosen genome key: the installed genome it belongs to, matched
// by assembly so a key with or without a dataset suffix finds it, or the key itself.
function genomeDisplayText(value, genomeOptions) {
    if (!value) return ''
    const assembly = trackAssemblyKey(value)
    const match = genomeOptions.find((g) => g.key === value)
        || genomeOptions.find((g) => trackAssemblyKey(g.key) === assembly)
    return match ? match.label : value
}

function GenomeComboBox({ value, onChange, genomeOptions, isLight }) {
    const [open, setOpen] = useState(false)
    const [inputValue, setInputValue] = useState(() => genomeDisplayText(value, genomeOptions))
    const boxRef = useRef(null)
    const listRef = useRef(null)

    // Picking a genome shows its name; this used to put the raw key back in the box.
    useEffect(() => {
        setInputValue(genomeDisplayText(value, genomeOptions))
    }, [value, genomeOptions])


    useEffect(() => {
        const handleClick = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    const filtered = useMemo(() => {
        if (!inputValue) return genomeOptions
        const q = inputValue.toLowerCase()
        return genomeOptions.filter(g =>
            g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q)
        )
    }, [inputValue, genomeOptions])

    // The genome field sits at the foot of the Add Track dialog, so its list opened below
    // the visible part of the dialog's scrolling body and had to be scrolled to by hand.
    // Bring it into view as it opens — 'nearest', so nothing moves when it already fits.
    const hasList = open && filtered.length > 0
    useEffect(() => {
        if (!hasList) return undefined
        const frame = requestAnimationFrame(() => {
            listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        })
        return () => cancelAnimationFrame(frame)
    }, [hasList])

    return (
        <div ref={boxRef} className="relative">
            <input
                type="text"
                value={inputValue}
                placeholder="Search genomes or type an assembly accession…"
                onFocus={() => setOpen(true)}
                onChange={(e) => {
                    setInputValue(e.target.value)
                    onChange(e.target.value)
                    setOpen(true)
                }}
                className={`w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                    ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
                    : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`}
            />
            {open && filtered.length > 0 && (
                <div ref={listRef} className={`absolute z-50 mt-1 w-full rounded-lg shadow-lg border overflow-hidden max-h-52 overflow-y-auto ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                    {filtered.map(g => (
                        <button
                            key={g.key}
                            type="button"
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-500/10 ${isLight ? 'text-gray-800' : 'text-gray-200'}`}
                            onMouseDown={(e) => {
                                e.preventDefault()
                                setInputValue(g.label)
                                onChange(g.key)
                                setOpen(false)
                            }}
                        >
                            <span className="font-medium">{g.label}</span>
                            <span className={`ml-2 text-xs opacity-60`}>{g.key}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

// A type's options before anything is chosen: what picking a file of that type has
// always started from. A GFF/GTF starts on Automatic (''): the backend reads it as gene
// models when it has transcript structure, otherwise as intervals.
function defaultTypeSettings(type) {
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

const typeLabelOf = (type) => TRACK_TYPES.find((t) => t.id === type)?.label || 'Unrecognised'

// A registered track's settings in the shape the dialog edits.
function settingsFromTrack(track) {
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

// Both built by the same functions, so equal settings serialise identically.
const sameTypeSettings = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Whether TypeSettingsEditor has anything to show for a type.
const typeHasSettings = (type) => type === 'bigwig'
    || (DISPLAY_MODES[type] || []).length > 1
    || ['splice_junctions', 'vcf', 'bed', 'bigbed', 'gff'].includes(type)

/**
 * One track type's options: BigWig plot settings, display mode, splice filters, colours.
 * The same editor serves a single file, a whole type group, and one file of a group given
 * settings of its own, so the three never drift apart. It carries the tutorial's anchors:
 * only one is ever on screen at a time.
 */
function TypeSettingsEditor({ type, value, onChange, isLight, labelCls, inputCls, trackLabel = '', sharedFileCount = 1, allowAutomatic = true }) {
    const patch = (next) => onChange({ ...value, ...next })
    if (!type) return null
    return (
        <div className="space-y-4">
            {type === 'bigwig' && (
                <div data-tour-id="track-wizard-bigwig">
                    <label className={labelCls}>BigWig plot settings</label>
                    <BigWigSettingsEditor
                        dataTypeTourId="track-wizard-datatype"
                        displayModeTourId="track-wizard-display"
                        settings={value.bigWigSettings}
                        displayMode={value.displayMode}
                        onSettingsChange={(next) => patch({ bigWigSettings: normalizeBigWigSettings(next, value.bigWigSettings) })}
                        onDisplayModeChange={(mode) => patch({ displayMode: mode })}
                        onDataTypeChange={(nextSettings, nextDisplayMode) => {
                            const normalized = normalizeBigWigSettings(nextSettings, value.bigWigSettings)
                            patch({
                                bigWigSettings: normalized,
                                bigWigDataType: normalizeBigWigDataType(normalized.data_type, ''),
                                displayMode: normalizeBigWigDisplayMode(nextDisplayMode, normalized.data_type),
                            })
                        }}
                        onDataTypeSelect={(dataType) => patch({ bigWigDataType: dataType })}
                        selectedDataType={value.bigWigDataType}
                        requireDataTypeSelection
                        sharedFileCount={sharedFileCount}
                        isLight={isLight}
                    />
                </div>
            )}
            {type !== 'bigwig' && (DISPLAY_MODES[type] || []).length > 1 && (
                <div>
                    <label className={labelCls}>Display mode</label>
                    <select
                        data-tour-id="track-wizard-display-mode"
                        value={value.displayMode}
                        onChange={(e) => patch({ displayMode: e.target.value })}
                        className={inputCls}
                    >
                        {type === 'gff' && allowAutomatic && (
                            <option value="">Automatic (gene models if the file has transcripts)</option>
                        )}
                        {(DISPLAY_MODES[type] || []).map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                </div>
            )}
            {type === 'splice_junctions' && (
                <div>
                    <label className={labelCls}>Splice filters</label>
                    <SpliceSettingsEditor
                        value={value.spliceSettings}
                        onChange={(next) => patch({ spliceSettings: next })}
                        isLight={isLight}
                    />
                </div>
            )}
            {type === 'vcf' && (
                <div data-tour-id="track-wizard-vcf">
                    <label className={labelCls}>VCF colours</label>
                    <VcfSettingsEditor
                        trackLabel={trackLabel}
                        settings={value.vcfSettings}
                        onChange={(next) => patch({ vcfSettings: normalizeVcfSettings(next, value.vcfSettings) })}
                        isLight={isLight}
                    />
                </div>
            )}
            {['bed', 'bigbed', 'gff'].includes(type) && (
                <div>
                    <label className={labelCls}>Colour</label>
                    <BedSettingsEditor
                        trackLabel={trackLabel}
                        settings={value.bedSettings}
                        trackType={type}
                        onChange={(next) => patch({ bedSettings: normalizeBedSettings(next) })}
                        isLight={isLight}
                    />
                </div>
            )}
        </div>
    )
}

// ── Registration Wizard ───────────────────────────────────────────────────────
//
// One file or many. Picking a single file gives the familiar form, laid out in two
// columns; ticking several in the file browser (of any mix of types) gives a list of the
// files grouped by type beside an editor for whatever is selected: a whole type group —
// its naming pattern and the settings its files share — or one file, which can take its
// own label and settings. Every file joins the one genome chosen at the top, and all of
// them are registered together.

function RegistrationWizard({
    isLight,
    genomeOptions,
    onClose,
    onRegistered,
    initialBrowsePath,
    seed = null,
    existingLabels = [],
    // 'edit': the same dialog over tracks already registered (one or many), saving
    // changes to them rather than registering files.
    mode = 'register',
    editTracks = null,
    onUpdated = null,
}) {
    const isEdit = mode === 'edit'
    const [step, setStep] = useState(isEdit ? 2 : 1)
    // { id, path, detectedType, type, label, labelEdited, custom } — `custom` is the file's
    // own settings, or null to share its type group's.
    const [files, setFiles] = useState([])
    // type -> { settings, naming }
    const [groups, setGroups] = useState({})
    const [genomeKey, setGenomeKey] = useState('')
    // Editing tracks from different genomes: the field starts empty, and stays out of the
    // save unless a genome is chosen, so each keeps its own.
    const [genomeMixed, setGenomeMixed] = useState(false)
    const [genomeTouched, setGenomeTouched] = useState(false)
    // Registering with no genome: the tracks that would be left without one, to confirm.
    const [noGenomePrompt, setNoGenomePrompt] = useState(false)
    const genomeFieldRef = useRef(null)
    const [selection, setSelection] = useState(null) // { kind: 'group', key: type } | { kind: 'file', key: id }
    const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
    const [registering, setRegistering] = useState(false)
    const [progress, setProgress] = useState(null)
    const [error, setError] = useState('')
    const [failures, setFailures] = useState({})
    const nextIdRef = useRef(1)
    // The folder the file browser last showed, and where it opens next: Back, or adding
    // more files, returns there rather than to the start of the tree. A ref, not state —
    // the browser reports every folder it passes through, and re-rendering on each would
    // re-point it and drop the files ticked so far.
    const lastDirectoryRef = useRef('')
    const [browserStart, setBrowserStart] = useState('')
    // The list as it stands, for adding to it from the file browser's callback.
    const filesRef = useRef(files)
    filesRef.current = files

    const withGroup = (prev, type, patch = null) => {
        if (!type) return prev
        const current = prev[type] || { settings: defaultTypeSettings(type), naming: { ...DEFAULT_BATCH_NAMING } }
        return { ...prev, [type]: patch ? { ...current, ...patch } : current }
    }

    const makeFile = (path, extra = {}) => {
        const detectedType = detectTypeFromPath(path)
        return {
            id: `f${nextIdRef.current++}`,
            path,
            detectedType,
            type: detectedType || '',
            label: '',
            labelEdited: false,
            custom: null,
            ...extra,
        }
    }

    /* A tutorial's picture of this form. Set rather than merged, so walking back into a
     * step that shows a file chosen and no data type yet shows exactly that, even if the
     * reader had gone on to choose one. `seededAt` is a timestamp rather than a flag, so
     * re-entering the same step is a fresh request — "empty" has to be re-established on
     * the way back even though nothing about the step changed. A tutorial is always about
     * one file, so it seeds a list of one. */
    useEffect(() => {
        if (!seed) return
        const nextFiles = seed.filePath ? [makeFile(seed.filePath, { label: seed.label || '', labelEdited: true })] : []
        let nextGroups = {}
        const type = nextFiles[0]?.type
        if (type) {
            const settings = defaultTypeSettings(type)
            if (type === 'bigwig') {
                settings.bigWigDataType = seed.dataType || ''
                settings.bigWigSettings = normalizeBigWigSettings(seed.dataType ? { data_type: seed.dataType } : null)
            }
            if (seed.displayMode) settings.displayMode = seed.displayMode
            nextGroups = { [type]: { settings, naming: { ...DEFAULT_BATCH_NAMING } } }
        }
        setFiles(nextFiles)
        setGroups(nextGroups)
        setSelection(type ? { kind: 'group', key: type } : null)
        setStep(seed.step === 2 ? 2 : 1)
        setGenomeKey(seed.genomeKey || '')
        lastDirectoryRef.current = ''
        setBrowserStart('')
        setFileBrowserOpen(Boolean(seed.browserOpen))
        setError('')
        setFailures({})
        setProgress(null)
    }, [seed?.seededAt])  // eslint-disable-line react-hooks/exhaustive-deps

    // Editing: the tracks as they are. Each type group starts from its first track's
    // settings, and any track that differs keeps its own, so opening the dialog changes
    // nothing by itself. Names are kept unless the user asks to rename from a pattern.
    useEffect(() => {
        if (!isEdit || !Array.isArray(editTracks)) return
        const nextGroups = {}
        const nextFiles = editTracks.map((track) => {
            const type = track.type || ''
            const settings = settingsFromTrack(track)
            if (type && !nextGroups[type]) nextGroups[type] = { settings, naming: { ...DEFAULT_BATCH_NAMING, renaming: false } }
            return {
                id: `t:${track.id}`,
                trackId: track.id,
                path: track.path,
                detectedType: type,
                type,
                label: track.label || '',
                originalLabel: track.label || '',
                labelEdited: true,
                custom: type && sameTypeSettings(settings, nextGroups[type].settings) ? null : settings,
            }
        })
        // Compared by assembly, as the Track Manager groups them: the same genome can be
        // registered with and without a dataset suffix, and that is not a mix of genomes.
        // Left untouched, each track keeps its exact key (genome_key is not sent).
        const genomeKeys = editTracks.map((t) => String(t.genome_key || ''))
        const assemblies = new Set(genomeKeys.map((key) => (key ? trackAssemblyKey(key) : '')))
        setGenomeKey(assemblies.size === 1 ? genomeKeys[0] : '')
        setGenomeMixed(assemblies.size > 1)
        setGenomeTouched(false)
        setFiles(nextFiles)
        setGroups(nextGroups)
        const firstType = nextFiles[0]?.type
        setSelection(firstType ? { kind: 'group', key: firstType } : null)
        setStep(2)
    }, [isEdit, editTracks])

    const addPaths = (paths) => {
        const known = new Set(filesRef.current.map((f) => f.path))
        const fresh = []
        for (const path of paths) {
            if (!path || known.has(path)) continue
            known.add(path)
            fresh.push(makeFile(path))
        }
        if (!fresh.length) {
            setStep(filesRef.current.length ? 2 : 1)
            return
        }
        setFiles((prev) => [...prev, ...fresh.filter((f) => !prev.some((p) => p.path === f.path))])
        setGroups((prev) => fresh.reduce((acc, f) => withGroup(acc, f.type), prev))
        setSelection((prev) => prev || (fresh[0]?.type ? { kind: 'group', key: fresh[0].type } : fresh[0] ? { kind: 'file', key: fresh[0].id } : null))
        setError('')
        setStep(2)
    }

    const updateFile = (id, patch) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
    const removeFile = (id) => {
        setFiles((prev) => prev.filter((f) => f.id !== id))
        setFailures((prev) => { const next = { ...prev }; delete next[id]; return next })
        setSelection((prev) => (prev?.kind === 'file' && prev.key === id ? null : prev))
    }
    const setFileType = (id, type) => {
        updateFile(id, { type, custom: null })
        setGroups((prev) => withGroup(prev, type))
    }

    const grouped = useMemo(() => groupFilesByType(files, TRACK_TYPES.map((t) => t.id)), [files])
    const isSingle = files.length === 1
    const onlyFile = isSingle ? files[0] : null

    const namingFor = (type) => {
        const naming = { ...DEFAULT_BATCH_NAMING, ...(groups[type]?.naming || {}) }
        return naming.startIndexEdited ? naming : { ...naming, startIndex: suggestStartIndex(existingLabels, naming.prefix) }
    }
    const labelFor = (file) => {
        if (file.labelEdited) return file.label
        const group = grouped.find((g) => g.type === file.type)
        const index = group ? group.files.findIndex((f) => f.id === file.id) : 0
        return batchLabel(namingFor(file.type), stemFromPath(file.path), Math.max(0, index))
    }
    const settingsFor = (file) => file.custom || groups[file.type]?.settings || defaultTypeSettings(file.type)

    // What stops registration, as sentences, once each.
    const problems = useMemo(() => {
        const out = []
        const add = (text) => { if (!out.includes(text)) out.push(text) }
        for (const file of files) {
            const name = basenameFromPath(file.path)
            if (!file.type) { add(`${name}: choose a track type.`); continue }
            if (!String(labelFor(file) || '').trim()) add(`${name}: give it a label.`)
            const settings = settingsFor(file)
            if (file.type === 'bigwig') {
                if (!settings.bigWigDataType) {
                    add(file.custom ? `${name}: choose a BigWig data type.` : isSingle ? 'Choose a BigWig data type.' : 'BigWig files: choose a data type.')
                }
                const zones = customZoneProblem(
                    settings.bigWigSettings,
                    normalizeBigWigDisplayMode(settings.displayMode, settings.bigWigDataType || settings.bigWigSettings?.data_type),
                )
                if (zones) add(file.custom || isSingle ? zones : `BigWig files: ${zones}`)
            }
        }
        return out
        // labelFor/settingsFor read these; listing them keeps the sentences current.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files, groups, grouped, existingLabels, isSingle])

    const buildRequest = (file, sharedZones = null) => {
        const settings = settingsFor(file)
        const type = file.type
        let splicePayload
        let spliceWarning = ''
        if (type === 'splice_junctions') {
            const coerced = coerceSpliceSettingsForSave(settings.spliceSettings)
            splicePayload = coerced.settings
            spliceWarning = coerced.warning || ''
        }
        return {
            spliceWarning,
            body: {
                path: file.path,
                label: labelFor(file),
                type,
                display_mode: type === 'bigwig'
                    ? normalizeBigWigDisplayMode(settings.displayMode, settings.bigWigDataType || settings.bigWigSettings?.data_type)
                    : type === 'vcf' ? normalizeVcfDisplayMode(settings.displayMode) : settings.displayMode,
                // Editing leaves each track's genome alone unless one was chosen here.
                genome_key: isEdit && !genomeTouched ? undefined : (genomeKey || ''),
                splice_settings: type === 'splice_junctions' ? splicePayload : undefined,
                bigwig_settings: type === 'bigwig'
                    ? {
                        ...normalizeBigWigSettings({ ...settings.bigWigSettings, data_type: settings.bigWigDataType }, settings.bigWigSettings),
                        // Scaled across the files registered together: their shared edges.
                        ...(sharedZones ? { zone_scale: 'files', shared_zones: sharedZones } : {}),
                    }
                    : undefined,
                vcf_settings: type === 'vcf' ? normalizeVcfSettings(settings.vcfSettings) : undefined,
                bed_settings: ['bed', 'bigbed', 'gff'].includes(type) ? normalizeBedSettings(settings.bedSettings) : undefined,
            },
        }
    }

    const handleRegister = async ({ withoutGenome = false } = {}) => {
        if (problems.length || !files.length) return
        // Easy to forget, and a track with no genome is never drawn until it gets one: say
        // so, and let the user go back or go ahead.
        if (!isEdit && !genomeKey && !withoutGenome) {
            setNoGenomePrompt(true)
            return
        }
        const order = grouped.flatMap((g) => g.files)
        // Labels fixed now, so a file that fails keeps the name it was about to get even
        // though the files registered around it leave the list.
        const labels = new Map(order.map((f) => [f.id, labelFor(f)]))
        setError('')
        setFailures({})
        setRegistering(true)

        // BigWigs sharing "scaled to the peaks" on a zoned heatmap are scaled across all of
        // them: their peaks are measured together, once, and every one stores the same
        // edges, so the tracks can be compared directly.
        let sharedZones = null
        const sharingIds = new Set()
        const bigWigSettings = groups.bigwig?.settings
        const sharing = (grouped.find((g) => g.type === 'bigwig')?.files || []).filter((f) => !f.custom)
        const sharedMode = bigWigSettings
            ? normalizeBigWigDisplayMode(bigWigSettings.displayMode, bigWigSettings.bigWigDataType || bigWigSettings.bigWigSettings?.data_type)
            : ''
        if (sharing.length > 1 && sharedMode === 'zoned_heatmap' && bigWigSettings?.bigWigSettings?.zone_scale === 'file') {
            setProgress({ measuring: sharing.length })
            try {
                const res = await fetch(`${API_BASE}/api/browse/bigwig/zone_scale`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: sharing.map((f) => f.path) }),
                })
                const data = await res.json().catch(() => ({}))
                const thresholds = Array.isArray(data?.thresholds) ? data.thresholds.map(Number) : []
                if (!res.ok || thresholds.length !== 4) throw new Error(data?.detail || 'no peaks were found')
                sharedZones = thresholds
                for (const f of sharing) sharingIds.add(f.id)
            } catch (e) {
                setRegistering(false)
                setProgress(null)
                setError(`Could not measure the peaks across the ${sharing.length} BigWig files: ${e.message}. Nothing was ${isEdit ? 'saved' : 'registered'}.`)
                return
            }
        }

        setProgress({ done: 0, total: order.length })
        const failed = {}
        const succeeded = new Set()
        for (const [index, file] of order.entries()) {
            try {
                const { body } = buildRequest(file, sharingIds.has(file.id) ? sharedZones : null)
                const res = await fetch(isEdit ? `${API_BASE}/api/tracks/${encodeURIComponent(file.trackId)}` : `${API_BASE}/api/tracks`, {
                    method: isEdit ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
                if (isEdit) onUpdated?.(data)
                else onRegistered(data)
                succeeded.add(file.id)
                const zones = body.bigwig_settings
                if (zones?.zone_scale === 'custom') rememberCustomZones(checkCustomZones(zones.custom_zones).zones)
            } catch (e) {
                failed[file.id] = e.message || (isEdit ? 'Saving failed' : 'Registration failed')
            }
            setProgress({ done: index + 1, total: order.length })
        }
        setRegistering(false)
        if (!Object.keys(failed).length) {
            onClose()
            return
        }
        setFiles((prev) => prev
            .filter((f) => !succeeded.has(f.id))
            .map((f) => ({ ...f, label: labels.get(f.id) ?? f.label, labelEdited: true })))
        setFailures(failed)
        setSelection(null)
        setProgress(null)
        setError(succeeded.size
            ? `${succeeded.size} of ${order.length} ${isEdit ? 'saved' : 'registered'}. The rest are still here, each with what went wrong.`
            : Object.values(failed)[0])
    }

    const inputCls = `w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`
    const labelCls = `block text-xs font-medium mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`
    const mutedCls = isLight ? 'text-gray-500' : 'text-gray-400'
    const panelCls = `rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-gray-50/60' : 'border-gray-700 bg-gray-800/30'}`

    const openBrowser = () => {
        setBrowserStart(lastDirectoryRef.current)
        setFileBrowserOpen(true)
    }

    const genomeBlock = (
        <div data-tour-id="track-wizard-genome" ref={genomeFieldRef}>
            <label className={labelCls}>
                Genome association <span className={`font-normal ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    ({isSingle ? 'needed to show the track' : `for every ${isEdit ? 'track' : 'file'}`})
                </span>
            </label>
            <GenomeComboBox
                value={genomeKey}
                onChange={(value) => { setGenomeKey(value); setGenomeTouched(true) }}
                genomeOptions={genomeOptions}
                isLight={isLight}
            />
            {isEdit && genomeMixed && !genomeTouched && (
                <p className={`text-xs mt-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                    These tracks belong to different genomes. Leave this empty to keep each one&apos;s, or choose a genome to move them all.
                </p>
            )}
            <GenomeNote genomeKey={genomeKey} genomeOptions={genomeOptions} isLight={isLight} />
            {!genomeKey && !(isEdit && genomeMixed && !genomeTouched) && (
                <p className={`text-xs mt-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    Tracks are shown in the Genome Browser only when the matching genome is active.
                </p>
            )}
        </div>
    )

    // The single-file form's is the tutorial's anchor; a file within a group has none.
    const typeSelect = (file) => (
        <select
            data-tour-id={isSingle ? 'track-wizard-type' : undefined}
            value={file.type || ''}
            onChange={(e) => setFileType(file.id, e.target.value)}
            // A registered track's type is fixed; re-register the file to read it another way.
            disabled={isEdit}
            title={isEdit ? 'A registered track keeps its type' : undefined}
            className={`${inputCls} disabled:opacity-60`}
        >
            {!file.type && <option value="">Select type…</option>}
            {TRACK_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label} — {t.ext}</option>
            ))}
        </select>
    )

    // ── One file: the familiar form, in two columns ──────────────────────────
    const singleForm = onlyFile && (
        <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
                <div>
                    <span className={labelCls}>{isEdit ? 'File' : 'Selected file'}</span>
                    <div data-tour-id="track-wizard-file" className={`px-3 py-2 rounded-lg text-xs font-mono break-all ${isLight ? 'bg-gray-50 text-gray-600 border border-gray-200' : 'bg-gray-800 text-gray-300 border border-gray-700'}`}>
                        {onlyFile.path}
                    </div>
                    {failures[onlyFile.id] && (
                        <p className={`text-xs mt-1.5 ${isLight ? 'text-red-600' : 'text-red-400'}`}>Not registered: {failures[onlyFile.id]}</p>
                    )}
                </div>
                <div>
                    <span className={labelCls}>Track type</span>
                    {isEdit ? null : onlyFile.detectedType ? (
                        <p className={`text-xs mb-2 ${isLight ? 'text-green-600' : 'text-green-400'}`}>
                            ✓ Auto-detected as <strong>{typeLabelOf(onlyFile.detectedType)}</strong>
                        </p>
                    ) : (
                        <p className={`text-xs mb-2 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                            ⚠ Could not auto-detect type — please select below
                        </p>
                    )}
                    {typeSelect(onlyFile)}
                </div>
                <div>
                    <label className={labelCls}>Label</label>
                    <input
                        data-tour-id="track-wizard-label"
                        type="text"
                        value={labelFor(onlyFile)}
                        onChange={(e) => updateFile(onlyFile.id, { label: e.target.value, labelEdited: true })}
                        className={inputCls}
                        placeholder="Track label…"
                    />
                </div>
                {genomeBlock}
            </div>
            <div>
                {onlyFile.type && (
                    <TypeSettingsEditor
                        type={onlyFile.type}
                        value={settingsFor(onlyFile)}
                        allowAutomatic={!isEdit}
                        onChange={(next) => {
                            // A lone track edits its settings directly, whether or not they
                            // matched the group they would otherwise share.
                            if (onlyFile.custom) updateFile(onlyFile.id, { custom: next })
                            else setGroups((prev) => withGroup(prev, onlyFile.type, { settings: next }))
                        }}
                        isLight={isLight}
                        labelCls={labelCls}
                        inputCls={inputCls}
                        trackLabel={labelFor(onlyFile)}
                    />
                )}
                {onlyFile.type && !typeHasSettings(onlyFile.type) && (
                    <p className={`text-sm ${mutedCls}`}>{typeLabelOf(onlyFile.type)} tracks have no further settings.</p>
                )}
            </div>
        </div>
    )

    // ── Several files: groups on the left, the selected group or file on the right ──
    const selectedGroup = selection?.kind === 'group' ? grouped.find((g) => g.type === selection.key) : null
    const selectedFile = selection?.kind === 'file' ? files.find((f) => f.id === selection.key) : null

    const groupEditor = selectedGroup && (() => {
        const type = selectedGroup.type
        const naming = namingFor(type)
        const setNaming = (patch) => setGroups((prev) => withGroup(prev, type, { naming: { ...namingFor(type), ...patch } }))
        const ownSettings = selectedGroup.files.filter((f) => f.custom).length
        const handNamed = selectedGroup.files.filter((f) => f.labelEdited).length
        return (
            <div className="space-y-5">
                <div>
                    <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {type ? `All ${typeLabelOf(type)} files` : 'Files that need a type'} · {selectedGroup.files.length}
                    </h3>
                    <p className={`text-xs mt-0.5 ${mutedCls}`}>
                        {type ? 'Names and settings here apply to every file in this group. Select a file on the left to change just that one.' : 'Select each file on the left to choose its type.'}
                    </p>
                </div>
                {type && (
                    <div className={panelCls} data-tour-id="track-wizard-naming">
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${mutedCls}`}>Names</div>
                        {isEdit && (
                            <label className={`flex items-center gap-2 text-sm mb-3 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="checkbox"
                                    checked={Boolean(naming.renaming)}
                                    onChange={(e) => {
                                        const renaming = e.target.checked
                                        setNaming({ renaming })
                                        // On: the pattern names them. Off: back to the names they had.
                                        const ids = new Set(selectedGroup.files.map((f) => f.id))
                                        setFiles((prev) => prev.map((f) => (ids.has(f.id)
                                            ? (renaming ? { ...f, labelEdited: false } : { ...f, label: f.originalLabel ?? f.label, labelEdited: true })
                                            : f)))
                                    }}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                Rename these {selectedGroup.files.length} tracks from a pattern
                            </label>
                        )}
                        <fieldset disabled={isEdit && !naming.renaming} className="disabled:opacity-50">
                        <div className="grid gap-3 sm:grid-cols-3 items-end">
                            <div>
                                <label className={labelCls}>Prefix</label>
                                <input
                                    type="text"
                                    value={naming.prefix}
                                    placeholder="e.g. lung"
                                    onChange={(e) => setNaming({ prefix: e.target.value })}
                                    className={inputCls}
                                />
                            </div>
                            <label className={`flex items-center gap-2 text-sm pb-2 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="checkbox"
                                    checked={naming.useFileName}
                                    onChange={(e) => setNaming({ useFileName: e.target.checked })}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                Include the file name
                            </label>
                            <div className="flex items-end gap-2">
                                <label className={`flex items-center gap-2 text-sm pb-2 whitespace-nowrap ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                    <input
                                        type="checkbox"
                                        checked={naming.numbered}
                                        onChange={(e) => setNaming({ numbered: e.target.checked })}
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    Number from
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    value={naming.startIndex}
                                    disabled={!naming.numbered}
                                    onChange={(e) => setNaming({ startIndex: Math.max(0, Math.trunc(Number(e.target.value) || 0)), startIndexEdited: true })}
                                    className={`${inputCls} w-24 disabled:opacity-40`}
                                    aria-label="First number"
                                />
                            </div>
                        </div>
                        {naming.numbered && !naming.startIndexEdited && naming.startIndex > 1 && !isEdit && (
                            <p className={`text-xs mt-2 ${mutedCls}`}>
                                Carries on from the {naming.prefix.trim()} tracks already registered.
                            </p>
                        )}
                        <div className={`mt-3 text-xs ${mutedCls}`}>
                            <span className="font-medium">Preview: </span>
                            {selectedGroup.files.slice(0, 5).map((f) => labelFor(f)).join(', ')}
                            {selectedGroup.files.length > 5 ? `, … (${selectedGroup.files.length} in all)` : ''}
                        </div>
                        {handNamed > 0 && !isEdit && (
                            <p className={`text-xs mt-1 ${mutedCls}`}>
                                {handNamed === 1 ? 'One file has' : `${handNamed} files have`} a name typed by hand, which is kept.
                            </p>
                        )}
                        </fieldset>
                    </div>
                )}
                {type && (
                    <div className={panelCls}>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${mutedCls}`}>
                            Settings for {ownSettings && !isEdit ? `${selectedGroup.files.length - ownSettings} of ${selectedGroup.files.length}` : `all ${selectedGroup.files.length}`}
                        </div>
                        {isEdit && ownSettings > 0 && (
                            <p className={`text-xs mb-3 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                These tracks differ in some settings; this shows the first one&apos;s. A change here is made on every track, and whatever you leave alone stays as each track has it.
                            </p>
                        )}
                        <TypeSettingsEditor
                            type={type}
                            value={groups[type]?.settings || defaultTypeSettings(type)}
                            onChange={(next) => {
                                const before = groups[type]?.settings || defaultTypeSettings(type)
                                setGroups((prev) => withGroup(prev, type, { settings: next }))
                                // Editing: the change reaches tracks with their own settings too,
                                // field by field, and a track left matching the group rejoins it.
                                if (isEdit) {
                                    setFiles((prev) => prev.map((f) => {
                                        if (f.type !== type || !f.custom) return f
                                        const changed = applySettingsChange(before, next, f.custom)
                                        return { ...f, custom: sameTypeSettings(changed, next) ? null : changed }
                                    }))
                                }
                            }}
                            isLight={isLight}
                            labelCls={labelCls}
                            inputCls={inputCls}
                            sharedFileCount={selectedGroup.files.length - ownSettings}
                            allowAutomatic={!isEdit}
                        />
                        {ownSettings > 0 && (
                            <div className={`flex flex-wrap items-center gap-2 text-xs mt-3 ${mutedCls}`}>
                                <span>
                                    {isEdit
                                        ? `${ownSettings === 1 ? 'One track differs' : `${ownSettings} tracks differ`} from the first in other settings.`
                                        : `${ownSettings === 1 ? 'One file keeps its' : `${ownSettings} files keep their`} custom settings and ${ownSettings === 1 ? 'is' : 'are'} not changed here.`}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const ids = new Set(selectedGroup.files.map((f) => f.id))
                                        setFiles((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, custom: null } : f)))
                                    }}
                                    className="text-blue-500 hover:underline"
                                >
                                    {isEdit ? 'Make them all match this' : `Use these settings for all ${selectedGroup.files.length}`}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    })()

    const fileEditor = selectedFile && (() => {
        const file = selectedFile
        return (
            <div className="space-y-5">
                <div>
                    <h3 className={`text-sm font-semibold break-all ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{labelFor(file) || basenameFromPath(file.path)}</h3>
                    <p className={`text-xs mt-0.5 font-mono break-all ${mutedCls}`}>{file.path}</p>
                    {failures[file.id] && (
                        <p className={`text-xs mt-2 ${isLight ? 'text-red-600' : 'text-red-400'}`}>Not registered: {failures[file.id]}</p>
                    )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <label className={labelCls}>Track type</label>
                        {typeSelect(file)}
                    </div>
                    <div>
                        <label className={labelCls}>Label</label>
                        <input
                            type="text"
                            value={labelFor(file)}
                            onChange={(e) => updateFile(file.id, { label: e.target.value, labelEdited: true })}
                            className={inputCls}
                        />
                        {file.labelEdited && file.type && (
                            <button type="button" onClick={() => updateFile(file.id, { labelEdited: false, label: '' })} className="text-xs text-blue-500 hover:underline mt-1">
                                Use the group&apos;s naming
                            </button>
                        )}
                    </div>
                </div>
                {file.type && (
                    <div className={panelCls}>
                        <label className={`flex items-center gap-2 text-sm mb-3 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <input
                                type="checkbox"
                                checked={!file.custom}
                                onChange={(e) => updateFile(file.id, {
                                    custom: e.target.checked ? null : { ...(groups[file.type]?.settings || defaultTypeSettings(file.type)) },
                                })}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            Use the settings shared by all {typeLabelOf(file.type)} files
                        </label>
                        {file.custom ? (
                            <TypeSettingsEditor
                                type={file.type}
                                value={file.custom}
                                allowAutomatic={!isEdit}
                                onChange={(next) => updateFile(file.id, { custom: next })}
                                isLight={isLight}
                                labelCls={labelCls}
                                inputCls={inputCls}
                                trackLabel={labelFor(file)}
                            />
                        ) : (
                            <p className={`text-xs ${mutedCls}`}>Untick to give this file custom settings.</p>
                        )}
                    </div>
                )}
            </div>
        )
    })()

    const sidebar = (
        <div className={`flex flex-col min-h-0 border-r ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {grouped.map((group) => {
                    const groupSelected = selection?.kind === 'group' && selection.key === group.type
                    return (
                        <div key={group.type || 'untyped'}>
                            <button
                                type="button"
                                onClick={() => setSelection({ kind: 'group', key: group.type })}
                                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs font-semibold ${groupSelected
                                    ? (isLight ? 'bg-blue-50 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                                    : (isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-800')}`}
                            >
                                <span className="flex items-center gap-2">
                                    <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: TYPE_COLORS[group.type] || '#94a3b8' }} />
                                    {group.type ? typeLabelOf(group.type) : 'Needs a type'}
                                </span>
                                <span className={mutedCls}>{group.files.length}</span>
                            </button>
                            <div className="mt-1 space-y-0.5">
                                {group.files.map((file) => {
                                    const fileSelected = selection?.kind === 'file' && selection.key === file.id
                                    return (
                                        <div
                                            key={file.id}
                                            className={`group/file flex items-start gap-1 rounded-lg ${fileSelected ? (isLight ? 'bg-blue-50' : 'bg-blue-900/30') : (isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-800')}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() => setSelection({ kind: 'file', key: file.id })}
                                                className="flex-1 min-w-0 text-left pl-6 pr-1 py-1.5"
                                            >
                                                <div className={`text-xs truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>{labelFor(file) || '—'}</div>
                                                <div className={`text-[11px] truncate font-mono ${mutedCls}`}>{basenameFromPath(file.path)}</div>
                                                {(file.custom || failures[file.id]) && (
                                                    <div className="flex gap-1 mt-0.5">
                                                        {file.custom && <span className={`text-[10px] px-1 rounded ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>custom settings</span>}
                                                        {failures[file.id] && <span className="text-[10px] px-1 rounded bg-red-500/15 text-red-500">failed</span>}
                                                    </div>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => removeFile(file.id)}
                                                title={isEdit ? 'Leave out of this edit' : 'Remove from this list'}
                                                aria-label={`Remove ${basenameFromPath(file.path)}`}
                                                className={`shrink-0 p-1.5 text-xs opacity-0 group-hover/file:opacity-100 focus:opacity-100 ${mutedCls}`}
                                            >✕</button>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    )
                })}
            </div>
            {!isEdit && (
                <div className={`p-3 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button type="button" onClick={openBrowser} className="w-full py-2 rounded-lg text-xs font-medium border border-dashed border-blue-400/60 text-blue-500 hover:bg-blue-500/5">
                        + Add more files
                    </button>
                </div>
            )}
        </div>
    )

    const summary = grouped
        .map((g) => `${g.files.length} ${g.type ? typeLabelOf(g.type) : 'unrecognised'}`)
        .join(', ')

    const dialogWidth = step === 1 ? 'max-w-xl' : isSingle ? 'max-w-4xl' : 'max-w-6xl'

    return (
        <>
            <FileBrowserModal
                isOpen={fileBrowserOpen}
                onClose={() => { setFileBrowserOpen(false) }}
                onSelect={(path) => addPaths([path])}
                onSelectMany={addPaths}
                onDirectoryChange={(path) => { lastDirectoryRef.current = path }}
                multiple
                initialPath={browserStart || seed?.browserDirectory || initialBrowsePath || '.'}
                mode="file"
                theme={isLight ? 'light' : 'dark'}
                extensions={['.bw', '.bigwig', '.bb', '.bigbed', '.vcf', '.vcf.gz', '.bed', '.bed.gz', '.gff', '.gff3', '.gtf', '.gff.gz', '.gff3.gz', '.gtf.gz', '.bam', '.SJ.out.tab']}
            />

            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
                <div
                    data-tour-id="track-wizard"
                    // Bounded, with the body scrolling. Several files get a fixed height, so the
                    // file list and the editor each scroll on their own.
                    className={`w-full ${dialogWidth} rounded-2xl shadow-2xl border flex flex-col ${step === 2 && !isSingle ? 'h-[min(88vh,820px)]' : 'max-h-[88vh]'} ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className={`px-6 py-4 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <div>
                            <h2 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                {isEdit
                                    ? (isSingle ? 'Edit Track' : `Edit ${files.length} tracks`)
                                    : (step === 2 && !isSingle ? `Register ${files.length} tracks` : 'Register Track')}
                            </h2>
                            <p className={`text-xs mt-0.5 ${mutedCls}`}>
                                {isEdit
                                    ? (isSingle ? basenameFromPath(onlyFile?.path || '') : summary)
                                    : step === 1 ? 'Step 1 of 2' : isSingle ? 'Step 2 of 2' : `Step 2 of 2 · ${summary}`}
                            </p>
                        </div>
                        <button onClick={onClose} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${mutedCls}`}>✕</button>
                    </div>

                    {step === 1 && (
                        <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto min-h-0 text-center">
                            <p className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                                Select the file you want to add as a track — or tick several, of any types, to add them together.
                            </p>
                            <button
                                data-tour-id="track-wizard-browse"
                                onClick={openBrowser}
                                className="w-full py-8 rounded-xl border-2 border-dashed border-blue-400/50 hover:border-blue-500 hover:bg-blue-500/5 transition-colors text-blue-500 dark:text-blue-400 text-sm font-medium"
                            >
                                <svg className="w-8 h-8 mx-auto mb-2 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                </svg>
                                Browse for files…
                            </button>
                            <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Supported: .bw, .bigwig, .bb, .vcf.gz, .bed, .bed.gz, .gff, .gff3, .gtf (.gz), .bam, .SJ.out.tab
                            </p>
                        </div>
                    )}

                    {step === 2 && isSingle && (
                        <div className="px-6 py-5 flex-1 overflow-y-auto min-h-0">{singleForm}</div>
                    )}

                    {step === 2 && !isSingle && (
                        <>
                            <div className={`px-6 py-4 border-b flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>{genomeBlock}</div>
                            <div className="flex-1 min-h-0 grid grid-cols-[18rem_1fr]">
                                {sidebar}
                                <div className="min-h-0 overflow-y-auto px-6 py-5">
                                    {groupEditor || fileEditor || (
                                        <p className={`text-sm ${mutedCls}`}>Select a group or a file on the left to see its names and settings.</p>
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Status: what stops registering, how far it has got, what went wrong. */}
                    {step === 2 && (error || problems.length > 0 || progress) && (
                        <div className={`px-6 py-2.5 border-t text-xs flex-none space-y-1 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                            {progress && (
                                <div className={mutedCls}>
                                    {progress.measuring
                                        ? `Measuring the peaks across ${progress.measuring} BigWig files…`
                                        : `${isEdit ? 'Saving' : 'Registering'} ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`}
                                </div>
                            )}
                            {error && (
                                <div className={isLight ? 'text-red-700' : 'text-red-300'}>{error}</div>
                            )}
                            {!progress && problems.length > 0 && (
                                <div className={isLight ? 'text-amber-700' : 'text-amber-300'}>
                                    {problems[0]}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Footer */}
                    {step === 2 && (
                        <div className={`px-6 py-4 border-t flex items-center justify-between gap-3 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-900/50'}`}>
                            <div className="flex items-center gap-2">
                                {!isEdit && (
                                <>
                                <button
                                    data-tour-id="track-wizard-back"
                                    // Start again from the file browser, in the folder the files came
                                    // from — not from the top of the tree.
                                    onClick={() => { setStep(1); setFiles([]); setSelection(null); setFailures({}); setError(''); openBrowser() }}
                                    className={`px-4 py-2 rounded-lg text-sm ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                                >
                                    ← Back
                                </button>
                                {isSingle && (
                                    <button
                                        type="button"
                                        onClick={openBrowser}
                                        className={`px-3 py-2 rounded-lg text-sm ${isLight ? 'text-blue-600 hover:bg-blue-50' : 'text-blue-400 hover:bg-blue-900/20'}`}
                                    >
                                        + Add more files
                                    </button>
                                )}
                                </>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                            {/* Editing has nowhere to go back to, so Cancel sits by Save. */}
                            {isEdit && (
                                <button
                                    type="button"
                                    onClick={onClose}
                                    disabled={registering}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-40 ${isLight ? 'border-gray-300 text-gray-700 hover:bg-gray-100' : 'border-gray-600 text-gray-300 hover:bg-gray-800'}`}
                                >
                                    Cancel
                                </button>
                            )}
                            <button
                                data-tour-id="track-wizard-register"
                                onClick={() => handleRegister()}
                                disabled={!files.length || registering || problems.length > 0}
                                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {registering
                                    ? (isEdit ? 'Saving…' : 'Registering…')
                                    : isEdit
                                        ? (isSingle ? 'Save changes' : `Save ${files.length} tracks`)
                                        : (isSingle ? 'Register Track' : `Register ${files.length} tracks`)}
                            </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {noGenomePrompt && (() => {
                const names = grouped.flatMap((g) => g.files).map((f) => labelFor(f) || basenameFromPath(f.path))
                const shown = names.slice(0, 8)
                return (
                    <div data-wheel-isolated="true" className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
                        <div
                            data-tour-id="track-wizard-no-genome"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="track-wizard-no-genome-title"
                            className={`w-full max-w-md rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                        >
                            <div className="px-5 py-4 space-y-3">
                                <h3 id="track-wizard-no-genome-title" className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                    ⚠ No genome associated
                                </h3>
                                <p className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                    {names.length === 1 ? 'This track has' : `These ${names.length} tracks have`} no genome, so {names.length === 1 ? 'it' : 'they'} will not appear in the Genome Browser until one is set. You can set it later by editing {names.length === 1 ? 'the track' : 'them'}.
                                </p>
                                <ul className={`text-xs rounded-lg border px-3 py-2 space-y-0.5 max-h-40 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-gray-700 bg-gray-900/40 text-gray-300'}`}>
                                    {shown.map((name, i) => <li key={`${name}-${i}`} className="truncate">{name}</li>)}
                                    {names.length > shown.length && <li className={mutedCls}>and {names.length - shown.length} more</li>}
                                </ul>
                            </div>
                            <div className={`px-5 py-3 border-t flex justify-end gap-2 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                                <button
                                    type="button"
                                    data-tour-id="track-wizard-no-genome-back"
                                    onClick={() => {
                                        setNoGenomePrompt(false)
                                        // Straight to the field that needs filling.
                                        genomeFieldRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                                        genomeFieldRef.current?.querySelector('input')?.focus()
                                    }}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium ${isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-700'}`}
                                >
                                    Go back and choose a genome
                                </button>
                                <button
                                    type="button"
                                    data-tour-id="track-wizard-no-genome-continue"
                                    onClick={() => { setNoGenomePrompt(false); handleRegister({ withoutGenome: true }) }}
                                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700"
                                >
                                    Register without a genome
                                </button>
                            </div>
                        </div>
                    </div>
                )
            })()}
        </>
    )
}

// ── Track Card ────────────────────────────────────────────────────────────────

function TrackCard({ track, isLight, genomeOptions, onDelete, onEdit, selected = false, onToggleSelected }) {
    // A card shows a track; editing it — alone or with others — happens in the same
    // dialog that registers tracks, so adding and changing them work the same way.
    const spliceSummary = useMemo(
        () => (track.type === 'splice_junctions' ? normalizeSpliceSettings(track.splice_settings) : null),
        [track.type, track.splice_settings]
    )
    const bigWigSummary = useMemo(() => {
        if (track.type !== 'bigwig') return null
        return normalizeBigWigSettings(track.bigwig_settings)
    }, [track.type, track.bigwig_settings])
    const vcfSummary = useMemo(() => {
        if (track.type !== 'vcf') return null
        return normalizeVcfSettings(track.vcf_settings)
    }, [track.type, track.vcf_settings])
    const bedSummary = useMemo(() => {
        if (!['bed', 'bigbed', 'gff'].includes(track.type)) return null
        return normalizeBedSettings(track.bed_settings)
    }, [track.type, track.bed_settings])

    const genomeName = useMemo(() => {
        const opt = findGenomeOption(genomeOptions, track.genome_key)
        return opt?.label || track.genome_label || fallbackGenomeLabel(track.genome_key) || 'Any genome'
    }, [track.genome_key, track.genome_label, genomeOptions])

    const handleDelete = async () => {
        if (!window.confirm(`Remove track "${track.label}"?\n(The file itself will not be deleted.)`)) return
        try {
            await fetch(`${API_BASE}/api/tracks/${track.id}`, { method: 'DELETE' })
            onDelete(track.id)
        } catch {
            // ignore
        }
    }

    const displayModeSummaryId = track.type === 'bigwig'
        ? normalizeBigWigDisplayMode(track.display_mode, bigWigSummary?.data_type)
        : track.type === 'vcf'
            ? normalizeVcfDisplayMode(track.display_mode)
        : track.display_mode

    return (
        // Anchored by label rather than by registry id: the id is minted at registration
        // and a tutorial cannot know it, but the label is exactly what the tutorial typed.
        <div
            data-tour-id={`track-manager-track-${track.id}`}
            data-tutorial-track-label={track.label || ''}
            className={`h-full rounded-xl border p-4 transition-colors ${selected
                ? (isLight ? 'bg-blue-50/60 border-blue-300' : 'bg-blue-900/20 border-blue-600/70')
                : (isLight ? 'bg-white border-gray-200 hover:border-blue-200' : 'bg-gray-800 border-gray-700 hover:border-blue-700/50')}`}
        >
                <div className="flex items-start gap-3">
                    <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`Select ${track.label}`}
                        onClick={() => onToggleSelected(track.id)}
                        className="-m-2 p-2 shrink-0 rounded-lg"
                    >
                        <input
                            type="checkbox"
                            readOnly
                            tabIndex={-1}
                            checked={selected}
                            className="pointer-events-none rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                    </button>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <TypeBadge type={track.type} small />
                            <span className={`text-sm font-semibold truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{track.label}</span>
                        </div>
                        <p className={`text-xs mt-1 font-mono truncate ${isLight ? 'text-gray-400' : 'text-gray-500'}`} title={track.path}>
                            {basenameFromPath(track.path)}
                        </p>
                        <div className="flex flex-col gap-0.5 mt-1.5">
                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Display mode: {DISPLAY_MODES[track.type]?.find(m => m.id === displayModeSummaryId)?.label || displayModeSummaryId?.replace(/_/g, ' ')}
                            </span>
                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Genome: {genomeName}
                            </span>
                            {bigWigSummary && (
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Data type: {BIGWIG_DATA_TYPES.find((opt) => opt.id === bigWigSummary.data_type)?.label || bigWigSummary.data_type}
                                    {displayModeSummaryId === 'zoned_heatmap'
                                        ? ` · Zones: ${bigWigSummary.zone_scale === 'files'
                                            ? 'shared across files'
                                            : bigWigSummary.zone_scale === 'file'
                                            ? 'scaled to file'
                                            : bigWigSummary.zone_scale === 'custom' && checkCustomZones(bigWigSummary.custom_zones).ok
                                                ? `custom (${bigWigSummary.custom_zones.map((v) => formatZoneLabel(v).slice(1)).join(' / ')})`
                                                : 'fixed'}`
                                        : ''}
                                </span>
                            )}
                            {vcfSummary && (
                                <span className={`text-xs inline-flex items-center gap-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    <span>Colours: genic</span>
                                    <ColorSwatch color={vcfSummary.genic_color} size={12} />
                                    <span>{vcfSummary.genic_color}, intergenic</span>
                                    <ColorSwatch color={vcfSummary.intergenic_color} size={12} />
                                    <span>{vcfSummary.intergenic_color}</span>
                                </span>
                            )}
                            {bedSummary && (
                                <span className={`text-xs inline-flex items-center gap-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    <span>Colour:</span>
                                    {bedSummary.color ? (
                                        <>
                                            <ColorSwatch color={bedSummary.color} size={12} />
                                            <span>{bedSummary.color}</span>
                                        </>
                                    ) : <span>automatic</span>}
                                </span>
                            )}
                            {spliceSummary && (
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Splice: min {spliceSummary.min_support}; weak &lt; {spliceSummary.weak_max_support + 1}, low &lt; {spliceSummary.low_max_support + 1}, medium &lt; {spliceSummary.medium_max_support + 1}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button
                            onClick={() => onEdit(track)}
                            className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                            title="Edit"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                        </button>
                        <button
                            onClick={handleDelete}
                            className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-red-400 hover:bg-red-50' : 'text-red-500 hover:bg-red-900/30'}`}
                            title="Remove registration"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    </div>
                </div>
        </div>
    )
}

function HubTrackRows({ rows, renderRow, isLight }) {
    const [scrollTop, setScrollTop] = useState(0)
    if (!Array.isArray(rows) || rows.length === 0) return null

    if (rows.length <= HUB_TRACK_VIRTUALIZE_THRESHOLD) {
        return (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {rows.map((row, idx) => renderRow(row, idx))}
            </div>
        )
    }

    const viewportHeight = HUB_TRACK_VIRTUALIZED_MAX_HEIGHT
    const totalHeight = rows.length * HUB_TRACK_ROW_HEIGHT
    const visibleCount = Math.ceil(viewportHeight / HUB_TRACK_ROW_HEIGHT) + HUB_TRACK_OVERSCAN * 2
    const startIndex = Math.max(0, Math.floor(scrollTop / HUB_TRACK_ROW_HEIGHT) - HUB_TRACK_OVERSCAN)
    const endIndex = Math.min(rows.length, startIndex + visibleCount)
    const topPad = startIndex * HUB_TRACK_ROW_HEIGHT
    const bottomPad = Math.max(0, totalHeight - (endIndex * HUB_TRACK_ROW_HEIGHT))
    const windowRows = rows.slice(startIndex, endIndex)

    return (
        <div
            className={`overflow-y-auto ${isLight ? 'bg-white' : 'bg-transparent'}`}
            style={{ maxHeight: viewportHeight }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
            <div style={{ height: topPad }} />
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {windowRows.map((row, idx) => renderRow(row, startIndex + idx))}
            </div>
            <div style={{ height: bottomPad }} />
        </div>
    )
}

// ── Main View ─────────────────────────────────────────────────────────────────

export default function TrackManagerView({
    theme = 'dark',
    config,
    inactiveSpecies = [],
    // A tutorial's `trackRegistry` arrival, reconciled below, and the way back: the
    // arrival waits on what this reports rather than assuming registration is instant.
    tutorialTrackRequest = null,
    onTutorialTracksRegistered = null,
}) {
    const isLight = theme === 'light'
    const [tracks, setTracks] = useState([])
    const [loading, setLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)
    // Tracks ticked for editing together, and the tracks the edit dialog is open on.
    const [selectedTrackIds, setSelectedTrackIds] = useState(() => new Set())
    const [editingTracks, setEditingTracks] = useState(null)
    const toggleTrackSelected = useCallback((id) => {
        setSelectedTrackIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])
    // What the wizard should open showing, when a tutorial puts it in a particular state.
    const [wizardSeed, setWizardSeed] = useState(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [filterType, setFilterType] = useState('')
    const [filterGenome, setFilterGenome] = useState('')
    const [hubTracksByGenome, setHubTracksByGenome] = useState({})
    const [hubLoading, setHubLoading] = useState(false)
    const [hubError, setHubError] = useState('')
    const [hubSelectedRows, setHubSelectedRows] = useState({})
    const [hubSearchByGenome, setHubSearchByGenome] = useState({})
    const [hubFilterByGenome, setHubFilterByGenome] = useState({})
    const [hubExpandedByGroup, setHubExpandedByGroup] = useState({})
    const [hubImportTasks, setHubImportTasks] = useState([])
    const [hubImporting, setHubImporting] = useState(false)
    const seenCompletedHubTaskIdsRef = useRef(new Set())
    const hubDiscoverySignatureRef = useRef('')

    // Build genome options from all species in the top bar (active + inactive in browser view)
    const genomeOptions = useMemo(() => {
        const all = [...(config?.active_species || []), ...(inactiveSpecies || [])]
        const seen = new Set()
        return all
            .filter(s => {
                const key = getGenomeKey(s)
                if (seen.has(key)) return false
                seen.add(key)
                return true
            })
            .map(s => {
                const key = getGenomeKey(s)
                const name = s.display_name || s.common_name || s.scientific_name || titleCaseGenomeToken(s.species_key) || key
                const assembly = s.assembly_name || s.assembly || ''
                const accession = s.assembly || s.gca || ''
                return {
                    key,
                    label: buildGenomeDisplayLabel({
                        name,
                        assemblyName: assembly,
                        accession,
                        fallback: key,
                    }),
                }
            })
    }, [config?.active_species, inactiveSpecies])

    const selectedGenomesForHub = useMemo(() => {
        const all = [...(config?.active_species || []), ...(inactiveSpecies || [])]
        const seen = new Set()
        const rows = []
        for (const species of all) {
            const speciesKey = String(species?.species_key || '').trim()
            const assembly = String(species?.assembly || '').trim()
            const genomeKey = getGenomeKey(species)
            if (!speciesKey || !assembly || seen.has(genomeKey)) continue
            seen.add(genomeKey)
            rows.push({
                genome_key: genomeKey,
                species_key: speciesKey,
                scientific_name: String(species?.scientific_name || '').trim(),
                common_name: String(species?.common_name || '').trim(),
                assembly,
                assembly_name: String(species?.assembly_name || species?.assembly || '').trim(),
                provider: normalizeGenomeProvider(species),
            })
        }
        return rows
    }, [config?.active_species, inactiveSpecies])
    const hubDiscoveryCacheKey = useMemo(
        () => buildHubDiscoveryCacheKey(selectedGenomesForHub),
        [selectedGenomesForHub]
    )

    const loadTracks = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/tracks`)
            if (res.ok) {
                const data = await res.json()
                setTracks(data.tracks || [])
            }
        } catch (e) {
            console.warn('Failed to load tracks:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { loadTracks() }, [loadTracks])

    /* Report what is registered, so a tutorial's arrival can wait for the work rather than
     * assume it. Registering validates the file and may build a tabix index, which is real
     * work; a card describing a track in the list was otherwise ringing a card that did
     * not exist yet. */
    useEffect(() => {
        onTutorialTracksRegistered?.(tracks.map((track) => String(track?.label || '')))
    }, [tracks, onTutorialTracksRegistered])

    /* A tutorial's `trackRegistry` arrival, reconciled against this view.
     *
     * Set, never toggled: an arrival runs on every entry to a step, so walking back into
     * the step that registers the first track has to find exactly one track registered,
     * not a second copy of it.
     *
     * Registering is done here rather than in the runtime because this is where the work
     * lives, and because the registry the tutorial writes to is chosen by the backend
     * (`main._tracks_config`) rather than by the caller — so there is no second path that
     * could write somewhere else. */
    useEffect(() => {
        const request = tutorialTrackRequest
        if (!request) return
        let cancelled = false

        const run = async () => {
            // The registry itself is the runtime's job, not this view's. It has to be,
            // because a genome-browser step declares registered tracks with no Track
            // Manager mounted — and when both reconciled, each read the same empty registry
            // and posted the same three tracks, so the list showed six.
            //
            // So this only catches up with what the runtime has done.
            await loadTracks()
            if (cancelled) return

            // Then the wizard itself, which is what most of the steps are about.
            setShowWizard(request.wizard !== 'closed')
            setWizardSeed(request.wizard === 'closed' ? null : {
                step: request.wizard === 'details' ? 2 : 1,
                filePath: request.file || '',
                label: request.fields?.label || '',
                dataType: request.dataType || '',
                displayMode: request.displayMode || '',
                genomeKey: request.genome === 'slice' ? (request.genomeKey || '') : '',
                browserOpen: request.browser?.state === 'open',
                browserDirectory: request.browser?.directory || '',
                seededAt: request.requestedAt,
            })
        }

        run()
        return () => { cancelled = true }
    }, [tutorialTrackRequest, loadTracks])

    const loadHubTracks = useCallback(async (options = {}) => {
        const refresh = options?.refresh === true
        const silent = options?.silent === true
        if (!selectedGenomesForHub.length) {
            setHubTracksByGenome({})
            hubDiscoverySignatureRef.current = ''
            setHubError('')
            setHubLoading(false)
            return
        }
        if (!silent) {
            setHubLoading(true)
            setHubError('')
        }
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/discover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    genomes: selectedGenomesForHub,
                    refresh: refresh === true,
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
            const byGenome = {}
            for (const item of (data?.genomes || [])) {
                byGenome[item.genome_key] = item
            }
            const nextSignature = buildHubDiscoverySignature(byGenome)
            const prevSignature = String(hubDiscoverySignatureRef.current || '')
            const changed = !prevSignature || prevSignature !== nextSignature
            if (changed) {
                setHubTracksByGenome(byGenome)
                hubDiscoverySignatureRef.current = nextSignature
            }
            setHubError('')
            writeHubDiscoveryCache(hubDiscoveryCacheKey, byGenome, nextSignature)
        } catch (e) {
            if (!silent) setHubError(e.message || 'Failed to load Track Hub Registry tracks.')
        } finally {
            if (!silent) setHubLoading(false)
        }
    }, [selectedGenomesForHub, hubDiscoveryCacheKey])

    const loadHubImportTasks = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/import_tasks`)
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
            const nextTasks = Array.isArray(data?.tasks) ? data.tasks : []
            setHubImportTasks(nextTasks)
            const completedNow = nextTasks.filter((t) => t?.status === 'completed')
            let shouldReloadTracks = false
            for (const task of completedNow) {
                if (!seenCompletedHubTaskIdsRef.current.has(task.id)) {
                    seenCompletedHubTaskIdsRef.current.add(task.id)
                    shouldReloadTracks = true
                }
            }
            if (shouldReloadTracks) loadTracks()
        } catch {
            // keep silent in polling loop
        }
    }, [loadTracks])

    useEffect(() => {
        if (!selectedGenomesForHub.length) {
            setHubTracksByGenome({})
            hubDiscoverySignatureRef.current = ''
            setHubError('')
            setHubLoading(false)
            return
        }

        const cached = readHubDiscoveryCache(hubDiscoveryCacheKey, selectedGenomesForHub)
        const hasCached = !!(cached?.by_genome && Object.keys(cached.by_genome).length > 0)
        if (hasCached) {
            setHubTracksByGenome(cached.by_genome)
            hubDiscoverySignatureRef.current = String(cached.signature || buildHubDiscoverySignature(cached.by_genome))
            setHubError('')
            setHubLoading(false)
            // Always reconcile in the background so each session can start from cache
            // and then silently pick up any new registry entries.
            loadHubTracks({ refresh: false, silent: true })
            return
        }

        hubDiscoverySignatureRef.current = ''
        loadHubTracks({ refresh: false, silent: false })
    }, [selectedGenomesForHub, hubDiscoveryCacheKey, loadHubTracks])

    useEffect(() => {
        loadHubImportTasks()
        const timer = window.setInterval(() => {
            loadHubImportTasks()
        }, 2000)
        return () => window.clearInterval(timer)
    }, [loadHubImportTasks])

    const handleRegistered = (newTrack) => {
        setTracks(prev => [...prev, newTrack])
    }

    const handleUpdate = (updated) => {
        setTracks(prev => prev.map(t => t.id === updated.id ? updated : t))
    }

    const handleDelete = (id) => {
        setTracks(prev => prev.filter(t => t.id !== id))
        setSelectedTrackIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }

    const importedTrackKeys = useMemo(() => {
        const keys = new Set()
        for (const track of tracks) {
            if (String(track?.source || '').toLowerCase() !== 'trackhub') continue
            const genomeKey = String(track?.genome_key || '')
            const dataUrl = String(track?.source_meta?.data_url || '')
            const normalizedDataUrl = normalizeHubDataUrl(dataUrl)
            const importKey = String(track?.source_meta?.import_key || '')
            if (genomeKey && importKey) keys.add(`${genomeKey}|${importKey}`)
            if (genomeKey && dataUrl) keys.add(`${genomeKey}|${dataUrl}`)
            if (genomeKey && normalizedDataUrl) keys.add(`${genomeKey}|${normalizedDataUrl}`)
        }
        return keys
    }, [tracks])

    const importTaskByRowKey = useMemo(() => {
        const map = new Map()
        const sorted = [...hubImportTasks].sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')))
        for (const task of sorted) {
            const rowKey = `${task?.genome_key || ''}|${task?.import_key || ''}`
            if (!task?.genome_key || !task?.import_key || map.has(rowKey)) continue
            map.set(rowKey, task)
        }
        return map
    }, [hubImportTasks])

    const getHubRowState = useCallback((genomeKey, row) => {
        const rowKey = `${genomeKey}|${row?.import_key || ''}`
        const task = importTaskByRowKey.get(rowKey)
        const normalizedRowDataUrl = normalizeHubDataUrl(row?.data_url || '')
        const imported = importedTrackKeys.has(`${genomeKey}|${row?.import_key || ''}`)
            || importedTrackKeys.has(`${genomeKey}|${row?.data_url || ''}`)
            || importedTrackKeys.has(`${genomeKey}|${normalizedRowDataUrl}`)
        const status = imported
            ? 'Registered'
            : (task?.status === 'downloading'
                ? `Downloading ${Math.round((task?.progress || 0) * 100)}%`
                : task?.status === 'registering'
                    ? 'Registering'
                    : task?.status === 'failed'
                        ? 'Failed'
                        : task?.status === 'queued'
                            ? 'Queued'
                            : '')
        const canSelect = !imported && !['queued', 'downloading', 'registering'].includes(String(task?.status || ''))
        return { rowKey, task, imported, status, canSelect }
    }, [importTaskByRowKey, importedTrackKeys])

    const hubViewByGenome = useMemo(() => {
        const byGenome = {}
        for (const genome of selectedGenomesForHub) {
            const genomeKey = genome.genome_key
            const payload = hubTracksByGenome[genomeKey] || { tracks: [], error: '' }
            const allRows = Array.isArray(payload?.tracks) ? payload.tracks : []
            const hubFilter = String(hubFilterByGenome[genomeKey] || '').trim()
            const searchToken = String(hubSearchByGenome[genomeKey] || '').trim().toLowerCase()

            const hubNameSet = new Set()
            for (const row of allRows) {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                hubNameSet.add(hubName)
            }
            const hubOptions = Array.from(hubNameSet).sort((a, b) => a.localeCompare(b))

            const filteredRows = allRows.filter((row) => {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                if (hubFilter && hubName !== hubFilter) return false
                if (!searchToken) return true
                const haystack = [
                    hubName,
                    String(row?.track_name || ''),
                    String(row?.track_id || ''),
                    String(row?.description || ''),
                    String(row?.data_url || ''),
                ].join(' ').toLowerCase()
                return haystack.includes(searchToken)
            })

            const groupsMap = new Map()
            for (const row of filteredRows) {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                const hubId = String(row?.hub_id || '').trim()
                const hubKey = `${genomeKey}|${hubName.toLowerCase()}|${hubId || '__'}`.toLowerCase()
                if (!groupsMap.has(hubKey)) {
                    groupsMap.set(hubKey, {
                        hub_key: hubKey,
                        hub_name: hubName,
                        hub_id: hubId,
                        tracks: [],
                        total_tracks: 0,
                        bigwig_count: 0,
                        bigbed_count: 0,
                    })
                }
                const group = groupsMap.get(hubKey)
                group.tracks.push(row)
                group.total_tracks += 1
                const trackType = normalizeHubTrackType(row)
                if (trackType === 'bigwig') group.bigwig_count += 1
                if (trackType === 'bigbed') group.bigbed_count += 1
            }

            const groups = Array.from(groupsMap.values())
            groups.sort((a, b) => {
                const nameCmp = String(a.hub_name || '').localeCompare(String(b.hub_name || ''))
                if (nameCmp !== 0) return nameCmp
                return String(a.hub_id || '').localeCompare(String(b.hub_id || ''))
            })
            for (const group of groups) {
                group.tracks.sort((a, b) => {
                    const typeOrder = { bigwig: 0, bigbed: 1, '': 9 }
                    const aType = normalizeHubTrackType(a)
                    const bType = normalizeHubTrackType(b)
                    const typeCmp = (typeOrder[aType] ?? 9) - (typeOrder[bType] ?? 9)
                    if (typeCmp !== 0) return typeCmp
                    const nameCmp = String(a?.track_name || '').localeCompare(String(b?.track_name || ''))
                    if (nameCmp !== 0) return nameCmp
                    return String(a?.data_url || '').localeCompare(String(b?.data_url || ''))
                })
            }

            byGenome[genomeKey] = {
                error: String(payload?.error || ''),
                allRows,
                filteredRows,
                hubOptions,
                groups,
            }
        }
        return byGenome
    }, [selectedGenomesForHub, hubTracksByGenome, hubFilterByGenome, hubSearchByGenome])

    const toggleHubSelection = useCallback((genomeKey, importKey, selected) => {
        const rowKey = `${genomeKey}|${importKey}`
        setHubSelectedRows((prev) => {
            const next = { ...prev }
            if (selected) next[rowKey] = true
            else delete next[rowKey]
            return next
        })
    }, [])

    const toggleHubGroupExpanded = useCallback((groupKey) => {
        setHubExpandedByGroup((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
    }, [])

    const updateHubSearch = useCallback((genomeKey, value) => {
        setHubSearchByGenome((prev) => ({ ...prev, [genomeKey]: value }))
    }, [])

    const updateHubFilter = useCallback((genomeKey, value) => {
        setHubFilterByGenome((prev) => ({ ...prev, [genomeKey]: value }))
    }, [])

    const handleSelectAllHubForGenome = useCallback((genomeKey, tracksForGenome, selected) => {
        setHubSelectedRows((prev) => {
            const next = { ...prev }
            for (const track of (tracksForGenome || [])) {
                const rowKey = `${genomeKey}|${track.import_key}`
                if (selected) next[rowKey] = true
                else delete next[rowKey]
            }
            return next
        })
    }, [])

    const handleImportSelectedHubTracks = useCallback(async () => {
        if (!config?.output_dir) return
        const selectedKeys = new Set(Object.keys(hubSelectedRows))
        if (selectedKeys.size === 0) return

        const genomeInfoByKey = new Map(selectedGenomesForHub.map((g) => [g.genome_key, g]))
        const items = []
        const importedRowKeys = []
        for (const [genomeKey, payload] of Object.entries(hubTracksByGenome || {})) {
            const genomeInfo = genomeInfoByKey.get(genomeKey)
            if (!genomeInfo) continue
            for (const track of (payload?.tracks || [])) {
                const rowKey = `${genomeKey}|${track.import_key}`
                if (!selectedKeys.has(rowKey)) continue
                const normalizedDataUrl = normalizeHubDataUrl(track.data_url)
                if (
                    importedTrackKeys.has(`${genomeKey}|${track.import_key}`)
                    || importedTrackKeys.has(`${genomeKey}|${track.data_url}`)
                    || importedTrackKeys.has(`${genomeKey}|${normalizedDataUrl}`)
                ) continue
                items.push({
                    genome_key: genomeKey,
                    species_key: genomeInfo.species_key,
                    assembly: genomeInfo.assembly,
                    label: track.track_name,
                    source_meta: {
                        hub_id: track.hub_id,
                        hub_name: track.hub_name,
                        track_id: track.track_id,
                        track_name: track.track_name,
                        assembly: track.assembly,
                        format: track.format,
                        data_url: normalizedDataUrl || track.data_url,
                        description: track.description,
                        import_key: track.import_key,
                    },
                })
                importedRowKeys.push(rowKey)
            }
        }
        if (items.length === 0) return

        setHubImporting(true)
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    items,
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)

            setHubSelectedRows((prev) => {
                const next = { ...prev }
                for (const rowKey of importedRowKeys) {
                    delete next[rowKey]
                }
                return next
            })
            loadHubImportTasks()
        } catch (e) {
            setHubError(e.message || 'Failed to import Track Hub tracks.')
        } finally {
            setHubImporting(false)
        }
    }, [config?.output_dir, hubSelectedRows, selectedGenomesForHub, hubTracksByGenome, importedTrackKeys, loadHubImportTasks])

    // Derived: tracks grouped by genome
    const filteredTracks = useMemo(() => {
        return tracks.filter(t => {
            if (filterType && t.type !== filterType) return false
            if (filterGenome && !genomeKeysMatch(t.genome_key, filterGenome)) return false
            if (searchQuery) {
                const q = searchQuery.toLowerCase()
                return t.label?.toLowerCase().includes(q) || t.path?.toLowerCase().includes(q) || t.type?.includes(q)
            }
            return true
        })
    }, [tracks, filterType, filterGenome, searchQuery])

    // One section per assembly: tracks registered against different annotation releases
    // of the same assembly (the genome picker offers both) belong together.
    const tracksByGenome = useMemo(() => {
        const map = new Map()
        for (const t of filteredTracks) {
            const key = trackAssemblyKey(t.genome_key)
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(t)
        }
        return map
    }, [filteredTracks])

    const allGenomes = useMemo(() => {
        const keys = new Set(tracks.map(t => trackAssemblyKey(t.genome_key)))
        return Array.from(keys).sort()
    }, [tracks])

    const browsePath = useMemo(() => {
        const outputDir = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        if (outputDir) return `${outputDir}/local_data`
        return '.'
    }, [config])

    // Colour styles
    const bg = isLight ? 'bg-[#f8f9fa]' : 'bg-[#111827]'
    const contentBg = isLight ? 'bg-white' : 'bg-[#1a2232]'
    const borderColor = isLight ? 'border-gray-200' : 'border-gray-700'
    const textPrimary = isLight ? 'text-gray-900' : 'text-gray-100'
    const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputCls = `px-3 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const selectedHubCount = Object.keys(hubSelectedRows).length
    const genomeLabelByKey = useMemo(() => {
        const map = new Map()
        for (const g of selectedGenomesForHub) {
            const key = g.genome_key
            const option = findGenomeOption(genomeOptions, key)
            map.set(key, option?.label || fallbackGenomeLabel(key))
        }
        return map
    }, [selectedGenomesForHub, genomeOptions])

    const colorPalette = useMemo(() => genomeColorPalette(config), [config])

    return (
        <TrackColorPaletteContext.Provider value={colorPalette}>
        <div data-screenshot-capture="view" data-tour-id="track-manager-view" className={`h-full overflow-y-auto ${bg}`} style={{ minHeight: 0 }}>
            {/* ── Header ── */}
            <div data-tour-id="track-manager-header" className={`px-6 py-4 border-b ${borderColor} ${contentBg}`}>
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className={`text-xl font-bold ${textPrimary}`}>Track Manager</h1>
                        <p className={`text-sm mt-0.5 ${textSecondary}`}>Register custom data tracks to display in the Genome Browser</p>
                    </div>
                    <button
                        data-tour-id="track-manager-add"
                        onClick={() => setShowWizard(true)}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                        Add Track
                    </button>
                </div>

                {/* ── Controls row: search + filters ── */}
                {tracks.length > 0 && (
                    <div data-tour-id="track-manager-filters" className="flex items-center gap-3 mt-4 flex-wrap">
                        <input
                            data-tour-id="track-manager-search"
                            type="text"
                            placeholder="Search tracks…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className={`${inputCls} w-52`}
                        />
                        <select value={filterType} onChange={e => setFilterType(e.target.value)} className={inputCls}>
                            <option value="">All types</option>
                            {TRACK_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        {allGenomes.length > 1 && (
                            <select value={filterGenome} onChange={e => setFilterGenome(e.target.value)} className={inputCls}>
                                <option value="">All genomes</option>
                                {allGenomes.map(g => {
                                    const track = tracks.find((item) => genomeKeysMatch(item.genome_key, g) && item.genome_label)
                                    const label = findGenomeOption(genomeOptions, g)?.label || track?.genome_label || fallbackGenomeLabel(g)
                                    return <option key={g} value={g}>{label}</option>
                                })}
                            </select>
                        )}
                        <span className={`text-xs ml-auto ${textSecondary}`}>{filteredTracks.length} track{filteredTracks.length !== 1 ? 's' : ''}</span>
                    </div>
                )}
            </div>

            {/* ── Track list ── */}
            <div data-tour-id="track-manager-list" className="px-6 py-5 space-y-6">
                {/* Edit several tracks at once: the same dialog as registering them. */}
                {selectedTrackIds.size > 0 && (
                    <div
                        data-tour-id="track-manager-selection"
                        className={`sticky top-0 z-10 flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-sm ${isLight ? 'bg-blue-50 border-blue-200' : 'bg-blue-950/60 border-blue-800 backdrop-blur'}`}
                    >
                        <span className={`text-sm font-medium ${isLight ? 'text-blue-900' : 'text-blue-100'}`}>
                            {selectedTrackIds.size} track{selectedTrackIds.size === 1 ? '' : 's'} selected
                        </span>
                        <button
                            type="button"
                            data-tour-id="track-manager-edit-selected"
                            onClick={() => setEditingTracks(tracks.filter((t) => selectedTrackIds.has(t.id)))}
                            className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700"
                        >
                            Edit {selectedTrackIds.size === 1 ? 'track' : `${selectedTrackIds.size} tracks`}
                        </button>
                        <button
                            type="button"
                            onClick={() => setSelectedTrackIds(new Set())}
                            className={`ml-auto text-xs ${isLight ? 'text-blue-700 hover:underline' : 'text-blue-300 hover:underline'}`}
                        >
                            Clear selection
                        </button>
                    </div>
                )}
                {loading ? (
                    <div className="flex items-center justify-center h-40">
                        <div className={`w-6 h-6 border-2 border-t-transparent rounded-full animate-spin ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
                    </div>
                ) : tracks.length === 0 ? (
                    <EmptyState isLight={isLight} />
                ) : filteredTracks.length === 0 ? (
                    <div className={`text-center py-12 ${textSecondary} text-sm`}>No tracks match your filters</div>
                ) : (
                    Array.from(tracksByGenome.entries()).map(([genomeKey, genomeTracks]) => {
                        const installed = findGenomeOption(genomeOptions, genomeKey)
                        const genomeLabel = installed?.label
                            || genomeTracks.find((track) => track.genome_label)?.genome_label
                            || fallbackGenomeLabel(genomeKey)
                        const groupIds = genomeTracks.map((t) => t.id)
                        const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedTrackIds.has(id))
                        const someSelected = !allSelected && groupIds.some((id) => selectedTrackIds.has(id))
                        return (
                            <div key={genomeKey}>
                                <div className="flex items-center gap-2 mb-3">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={(el) => { if (el) el.indeterminate = someSelected }}
                                        onChange={(e) => setSelectedTrackIds((prev) => {
                                            const next = new Set(prev)
                                            for (const id of groupIds) {
                                                if (e.target.checked) next.add(id)
                                                else next.delete(id)
                                            }
                                            return next
                                        })}
                                        aria-label={`Select all ${genomeLabel} tracks`}
                                        title="Select all tracks for this genome"
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <h2 className={`text-xs font-semibold ${textSecondary}`}>{genomeLabel}</h2>
                                    {/* The link is kept when a genome is removed, so its tracks come
                                        back with it; say why they are not in the browser meanwhile. */}
                                    {genomeKey && !installed && (
                                        <span className={`text-[11px] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                            genome data not found in Genome Selector
                                        </span>
                                    )}
                                </div>
                                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-stretch auto-rows-fr">
                                    {genomeTracks.map(track => (
                                        <TrackCard
                                            key={track.id}
                                            track={track}
                                            isLight={isLight}
                                            genomeOptions={genomeOptions}
                                            onDelete={handleDelete}
                                            onEdit={(t) => setEditingTracks([t])}
                                            selected={selectedTrackIds.has(track.id)}
                                            onToggleSelected={toggleTrackSelected}
                                        />
                                    ))}
                                </div>
                            </div>
                        )
                    })
                )}

                {/* ── Track Hub Registry discovery/import ── */}
                <div data-tour-id="track-manager-hub" className={`rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/30'}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <h3 className={`text-sm font-semibold ${textPrimary}`}>Track Hub Registry</h3>
                            <p className={`text-xs mt-0.5 ${textSecondary}`}>
                                Discover BigWig and BigBed tracks by selected genome and import as local tracks.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => loadHubTracks({ refresh: true, silent: false })}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${isLight ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50' : 'bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700'}`}
                            >
                                Refresh
                            </button>
                            <button
                                type="button"
                                onClick={handleImportSelectedHubTracks}
                                disabled={!config?.output_dir || selectedHubCount === 0 || hubImporting}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${(!config?.output_dir || selectedHubCount === 0 || hubImporting)
                                    ? (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-800 text-gray-500')
                                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                                    }`}
                                title={!config?.output_dir ? 'Set output directory in Configuration first' : ''}
                            >
                                {hubImporting ? 'Importing…' : `Import selected${selectedHubCount > 0 ? ` (${selectedHubCount})` : ''}`}
                            </button>
                        </div>
                    </div>

                    {hubError && (
                        <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${isLight ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-red-900/20 text-red-300 border border-red-800/40'}`}>
                            {hubError}
                        </div>
                    )}

                    <div className="mt-3 space-y-4">
                        {selectedGenomesForHub.length === 0 ? (
                            <div className={`text-xs ${textSecondary}`}>No selected genomes available.</div>
                        ) : hubLoading ? (
                            <div className="flex items-center gap-2 text-xs">
                                <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
                                <span className={textSecondary}>Loading Track Hub Registry tracks…</span>
                            </div>
                        ) : (
                            selectedGenomesForHub.map((genome) => {
                                const genomeKey = genome.genome_key
                                const payload = hubViewByGenome[genomeKey] || { error: '', allRows: [], filteredRows: [], hubOptions: [], groups: [] }
                                const rows = payload.filteredRows || []
                                const groups = payload.groups || []
                                const selectable = rows.filter((row) => getHubRowState(genomeKey, row).canSelect)
                                const allSelected = selectable.length > 0 && selectable.every((row) => hubSelectedRows[`${genomeKey}|${row.import_key}`])
                                return (
                                    <div key={genomeKey} className={`rounded-lg border ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                                        <div className={`px-3 py-2 flex items-center justify-between ${isLight ? 'bg-gray-50' : 'bg-gray-800/40'}`}>
                                            <div>
                                                <div className={`text-xs font-semibold ${textPrimary}`}>{genomeLabelByKey.get(genomeKey) || genomeKey}</div>
                                                <div className={`text-[11px] ${textSecondary}`}>{rows.length} matching track{rows.length !== 1 ? 's' : ''} across {groups.length} hub{groups.length !== 1 ? 's' : ''}</div>
                                            </div>
                                        </div>
                                        <div className={`px-3 py-2 border-t flex items-center gap-2 flex-wrap ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/20'}`}>
                                            <input
                                                type="text"
                                                value={hubSearchByGenome[genomeKey] || ''}
                                                onChange={(e) => updateHubSearch(genomeKey, e.target.value)}
                                                placeholder="Search hub, URL, description, track..."
                                                className={`${inputCls} !text-xs !py-1.5 w-72 max-w-full`}
                                            />
                                            <select
                                                value={hubFilterByGenome[genomeKey] || ''}
                                                onChange={(e) => updateHubFilter(genomeKey, e.target.value)}
                                                className={`${inputCls} !text-xs !py-1.5`}
                                            >
                                                <option value="">All hubs</option>
                                                {(payload.hubOptions || []).map((hubName) => (
                                                    <option key={hubName} value={hubName}>{hubName}</option>
                                                ))}
                                            </select>
                                            <label className={`text-[11px] ml-auto flex items-center gap-1.5 ${textSecondary}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={allSelected}
                                                    disabled={selectable.length === 0}
                                                    onChange={(e) => handleSelectAllHubForGenome(genomeKey, selectable, e.target.checked)}
                                                />
                                                Select all shown
                                            </label>
                                        </div>
                                        {payload.error && (
                                            <div className={`px-3 py-2 text-[11px] ${isLight ? 'text-amber-700 bg-amber-50 border-t border-amber-200' : 'text-amber-300 bg-amber-900/10 border-t border-amber-800/30'}`}>
                                                {payload.error}
                                            </div>
                                        )}
                                        {rows.length === 0 ? (
                                            <div className={`px-3 py-2 text-[11px] ${textSecondary}`}>
                                                {payload.allRows?.length ? 'No tracks match the current search/filter.' : 'No Track Hub records found for this genome.'}
                                            </div>
                                        ) : (
                                            <div className={`divide-y ${isLight ? 'divide-gray-200' : 'divide-gray-700'}`}>
                                                {groups.map((group) => {
                                                    const expanded = !!hubExpandedByGroup[group.hub_key]
                                                    const groupSelectedCount = group.tracks.filter((row) => hubSelectedRows[`${genomeKey}|${row.import_key}`]).length
                                                    return (
                                                        <div key={group.hub_key}>
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleHubGroupExpanded(group.hub_key)}
                                                                className={`w-full px-3 py-2 text-left flex items-center justify-between gap-3 ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-800/30'}`}
                                                            >
                                                                <div className="min-w-0 flex-1">
                                                                    <div className={`text-xs font-semibold truncate ${textPrimary}`}>{group.hub_name}</div>
                                                                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-800 text-gray-300'}`}>
                                                                            {group.total_tracks} total
                                                                        </span>
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-400/40 text-blue-500 bg-blue-500/10">
                                                                            bigWig {group.bigwig_count}
                                                                        </span>
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-400/40 text-emerald-500 bg-emerald-500/10">
                                                                            bigBed {group.bigbed_count}
                                                                        </span>
                                                                        {groupSelectedCount > 0 && (
                                                                            <span className={`text-[10px] ${textSecondary}`}>{groupSelectedCount} selected</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <span className={`opacity-50 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                                                    <IconUpDown open={expanded} size={14} />
                                                                </span>
                                                            </button>
                                                            {expanded && (
                                                                <HubTrackRows
                                                                    rows={group.tracks}
                                                                    isLight={isLight}
                                                                    renderRow={(row, rowIndex) => {
                                                                        const { rowKey, task, status, canSelect } = getHubRowState(genomeKey, row)
                                                                        const rowTrackType = normalizeHubTrackType(row)
                                                                        const rowTypeLabel = hubTrackTypeLabel(rowTrackType, row)
                                                                        const isLast = rowIndex === group.tracks.length - 1
                                                                        const rowTypeBadgeClass = rowTrackType === 'bigbed'
                                                                            ? 'border-emerald-400/40 text-emerald-500 bg-emerald-500/10'
                                                                            : rowTrackType === 'bigwig'
                                                                                ? 'border-blue-400/40 text-blue-500 bg-blue-500/10'
                                                                                : (isLight ? 'border-gray-300 text-gray-600 bg-gray-100' : 'border-gray-600 text-gray-300 bg-gray-700/40')
                                                                        return (
                                                                            <div key={rowKey} className="relative px-3 py-2 flex items-stretch gap-2" style={{ minHeight: HUB_TRACK_ROW_HEIGHT }}>
                                                                                <div className="relative w-8 shrink-0 mr-0.5 flex items-center">
                                                                                    <div
                                                                                        className={`absolute left-4 top-0 ${isLast ? 'bottom-1/2' : 'bottom-0'} border-l-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                                                                    />
                                                                                    <div
                                                                                        className={`absolute left-4 w-4 border-b-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                                                                    />
                                                                                </div>
                                                                                <div className="min-w-0 flex-1 overflow-hidden">
                                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${rowTypeBadgeClass}`}>
                                                                                            {rowTypeLabel}
                                                                                        </span>
                                                                                        <span className={`text-xs font-medium ${textPrimary}`}>{row.track_name || row.track_id}</span>
                                                                                        {status && (
                                                                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${status === 'Failed'
                                                                                                ? (isLight ? 'bg-red-100 text-red-700' : 'bg-red-900/30 text-red-300')
                                                                                                : status === 'Registered'
                                                                                                    ? (isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-300')
                                                                                                    : (isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                                                                                                }`}>
                                                                                                {status}
                                                                                            </span>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className={`text-[11px] mt-0.5 font-mono truncate ${textSecondary}`}>{row.data_url}</div>
                                                                                    {row.description && (
                                                                                        <div className={`text-[11px] mt-0.5 truncate ${textSecondary}`}>{row.description}</div>
                                                                                    )}
                                                                                    {task?.status === 'failed' && task?.error && (
                                                                                        <div className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-red-700' : 'text-red-300'}`}>{task.error}</div>
                                                                                    )}
                                                                                </div>
                                                                                <input
                                                                                    type="checkbox"
                                                                                    className="mt-0.5 ml-2 shrink-0"
                                                                                    checked={!!hubSelectedRows[rowKey]}
                                                                                    disabled={!canSelect}
                                                                                    onChange={(e) => toggleHubSelection(genomeKey, row.import_key, e.target.checked)}
                                                                                />
                                                                            </div>
                                                                        )
                                                                    }}
                                                                />
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* ── Supported types info ── */}
                {tracks.length === 0 && (
                    <div className={`mt-6 rounded-xl border p-5 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
                        <h3 className={`text-sm font-semibold mb-3 ${textPrimary}`}>Supported Track Types</h3>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {TRACK_TYPES.map(t => (
                                <div key={t.id} className={`flex items-start gap-2.5 p-2.5 rounded-lg ${isLight ? 'bg-white border border-gray-100' : 'bg-gray-800 border border-gray-700/50'}`}>
                                    <TypeBadge type={t.id} small />
                                    <div className="min-w-0">
                                        <p className={`text-xs font-medium ${textPrimary}`}>{t.label}</p>
                                        <p className={`text-[11px] mt-0.5 ${textSecondary}`}>{t.desc}</p>
                                        <p className={`text-[10px] font-mono mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>{t.ext}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Registration Wizard ── */}
            {editingTracks && editingTracks.length > 0 && (
                <RegistrationWizard
                    mode="edit"
                    editTracks={editingTracks}
                    isLight={isLight}
                    genomeOptions={genomeOptions}
                    onClose={() => setEditingTracks(null)}
                    onUpdated={handleUpdate}
                    onRegistered={() => {}}
                    initialBrowsePath={browsePath}
                    existingLabels={tracks.filter((t) => !editingTracks.some((e) => e.id === t.id)).map((t) => t.label)}
                />
            )}
            {showWizard && (
                <RegistrationWizard
                    isLight={isLight}
                    genomeOptions={genomeOptions}
                    onClose={() => { setShowWizard(false); setWizardSeed(null) }}
                    onRegistered={handleRegistered}
                    initialBrowsePath={browsePath}
                    seed={wizardSeed}
                    existingLabels={tracks.map((t) => t.label)}
                />
            )}
        </div>
        </TrackColorPaletteContext.Provider>
    )
}

/**
 * TrackManagerView — register, browse, and manage custom data tracks.
 * Tracks are persisted to disk via the backend's /api/tracks endpoints.
 */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import GenomeColorPicker, { ColorSwatch } from './GenomeColorPicker'
import { genomeColorPalette } from '../genomeColorSchemes'
import FileBrowserModal from './FileBrowserModal'
import { TUTORIAL_TRACK_PRESETS } from '../utils/tutorialTrackRegistry'

import { API_BASE } from '../backendRuntime'
import { genomeKeysMatch, getGenomeKey, normalizeGenomeProvider } from '../utils/genomeIdentity'

// ── Constants ────────────────────────────────────────────────────────────────

const TRACK_TYPES = [
    { id: 'bigwig', label: 'BigWig', ext: '.bw / .bigwig', desc: 'Continuous signal (coverage, ChIP-seq, ATAC-seq)' },
    { id: 'vcf', label: 'VCF', ext: '.vcf.gz (+ .tbi)', desc: 'Tabix-indexed variants (SNPs, indels, SVs)' },
    { id: 'bed', label: 'BED', ext: '.bed / .bed.gz', desc: 'Genomic intervals (peaks, repeats, regions)' },
    { id: 'gff', label: 'GFF / GTF', ext: '.gff / .gff3 / .gtf (.gz)', desc: 'Features as generic intervals (regulatory build, repeats); not gene models' },
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
    gff: [{ id: 'intervals', label: 'Intervals' }, { id: 'density', label: 'Density' }],
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
    },
    atac_seq: {
        display_mode: 'signal_plot',
        plot_color: '#b52aa1',
        zoned_colors: ['#86efac', '#4ade80', '#22c55e', '#15803d'],
    },
    chip_seq: {
        display_mode: 'signal_plot',
        plot_color: '#8b5cf6',
        zoned_colors: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#6d28d9'],
    },
    custom: {
        display_mode: 'signal_plot',
        plot_color: '#14b8a6',
        zoned_colors: ['#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8'],
    },
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
    }
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
    const nextSettings = normalizeBigWigSettings({ data_type: dataType }, prev)
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

function GenomeComboBox({ value, onChange, genomeOptions, isLight }) {
    const [open, setOpen] = useState(false)
    const [inputValue, setInputValue] = useState(value || '')
    const boxRef = useRef(null)

    useEffect(() => {
        setInputValue(value || '')
    }, [value])

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
                <div className={`absolute z-50 mt-1 w-full rounded-lg shadow-lg border overflow-hidden max-h-52 overflow-y-auto ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
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

// ── Registration Wizard ───────────────────────────────────────────────────────

function RegistrationWizard({ isLight, genomeOptions, onClose, onRegistered, initialBrowsePath, seed = null }) {
    const [step, setStep] = useState(1)
    const [filePath, setFilePath] = useState('')
    const [detectedType, setDetectedType] = useState(null)
    const [selectedType, setSelectedType] = useState(null)
    const [label, setLabel] = useState('')
    const [displayMode, setDisplayMode] = useState('')
    const [genomeKey, setGenomeKey] = useState('')
    const [spliceSettings, setSpliceSettings] = useState(DEFAULT_SPLICE_SETTINGS)
    const [bigWigSettings, setBigWigSettings] = useState(normalizeBigWigSettings(null))
    const [bigWigDataType, setBigWigDataType] = useState('')
    const [vcfSettings, setVcfSettings] = useState(normalizeVcfSettings(null))
    const [bedSettings, setBedSettings] = useState(normalizeBedSettings(null))
    const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
    const [registering, setRegistering] = useState(false)
    const [error, setError] = useState('')
    const [warning, setWarning] = useState('')

    const effectiveType = selectedType || detectedType

    const filePickedRef = useRef(false)

    /* A tutorial's picture of this form. Set rather than merged, so walking back into a
     * step that shows a file chosen and no data type yet shows exactly that, even if the
     * reader had gone on to choose one. `seededAt` is a timestamp rather than a flag, so
     * re-entering the same step is a fresh request — "empty" has to be re-established on
     * the way back even though nothing about the step changed. */
    useEffect(() => {
        if (!seed) return
        const detected = seed.filePath ? detectTypeFromPath(seed.filePath) : null
        setStep(seed.step === 2 ? 2 : 1)
        setFilePath(seed.filePath || '')
        setDetectedType(detected)
        setSelectedType(null)
        setLabel(seed.label || '')
        setBigWigDataType(seed.dataType || '')
        setBigWigSettings(normalizeBigWigSettings(seed.dataType ? { data_type: seed.dataType } : null))
        setDisplayMode(seed.displayMode || '')
        setVcfSettings(normalizeVcfSettings(null))
        setBedSettings(normalizeBedSettings(null))
        setSpliceSettings(DEFAULT_SPLICE_SETTINGS)
        setGenomeKey(seed.genomeKey || '')
        setFileBrowserOpen(Boolean(seed.browserOpen))
        setError('')
        setWarning('')
        setIndexNote('')
    }, [seed?.seededAt])  // eslint-disable-line react-hooks/exhaustive-deps

    const [indexNote, setIndexNote] = useState('')

    const handleFilePicked = (path) => {
        filePickedRef.current = true   // set synchronously before onClose fires
        setFilePath(path)
        const detected = detectTypeFromPath(path)
        setDetectedType(detected)
        setSelectedType(null)
        setLabel(stemFromPath(path))
        if (detected === 'bigwig') {
            setBigWigSettings(normalizeBigWigSettings(null))
            setBigWigDataType('')
            setDisplayMode('')
            setVcfSettings(normalizeVcfSettings(null))
        } else {
            setBigWigDataType('')
            const modes = detected ? (DISPLAY_MODES[detected] || []) : []
            setDisplayMode(detected === 'vcf' ? normalizeVcfDisplayMode(modes.length ? modes[0].id : '') : (modes.length ? modes[0].id : ''))
            setVcfSettings(normalizeVcfSettings(null))
        }
        setBedSettings(normalizeBedSettings(null))
        setSpliceSettings(DEFAULT_SPLICE_SETTINGS)
        setStep(2)
    }

    const handleTypeChange = (newType) => {
        setSelectedType(newType)
        if (newType === 'bigwig') {
            setBigWigSettings(normalizeBigWigSettings(null))
            setBigWigDataType('')
            setDisplayMode('')
            setVcfSettings(normalizeVcfSettings(null))
        } else {
            setBigWigDataType('')
            const modes = DISPLAY_MODES[newType] || []
            setDisplayMode(newType === 'vcf' ? normalizeVcfDisplayMode(modes.length ? modes[0].id : '') : (modes.length ? modes[0].id : ''))
            setVcfSettings(normalizeVcfSettings(null))
        }
        if (newType === 'splice_junctions') setSpliceSettings(DEFAULT_SPLICE_SETTINGS)
        setBedSettings(normalizeBedSettings(null))
    }

    const handleBigWigSettingsChange = (nextSettings) => {
        setBigWigSettings(normalizeBigWigSettings(nextSettings, bigWigSettings))
    }

    const handleBigWigDataTypeChange = (nextSettings, nextDisplayMode) => {
        const normalized = normalizeBigWigSettings(nextSettings, bigWigSettings)
        setBigWigSettings(normalized)
        setBigWigDataType(normalizeBigWigDataType(normalized.data_type, ''))
        setDisplayMode(normalizeBigWigDisplayMode(nextDisplayMode, normalized.data_type))
    }

    const isBigWigConfigured = effectiveType !== 'bigwig' || !!bigWigDataType

    const handleRegister = async () => {
        if (effectiveType === 'bigwig' && !bigWigDataType) {
            setError('Select a BigWig data type before registering.')
            return
        }
        setError('')
        setWarning('')
        setIndexNote('')
        setRegistering(true)
        try {
            let spliceSettingsPayload
            if (effectiveType === 'splice_junctions') {
                const { settings, warning: warningText } = coerceSpliceSettingsForSave(spliceSettings)
                spliceSettingsPayload = settings
                if (warningText) {
                    setWarning(warningText)
                    setSpliceSettings(settings)
                }
            }
            const res = await fetch(`${API_BASE}/api/tracks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: filePath,
                    label,
                    type: effectiveType,
                    display_mode: effectiveType === 'bigwig'
                        ? normalizeBigWigDisplayMode(displayMode, bigWigDataType || bigWigSettings?.data_type)
                        : effectiveType === 'vcf'
                            ? normalizeVcfDisplayMode(displayMode)
                        : displayMode,
                    genome_key: genomeKey || '',
                    splice_settings: effectiveType === 'splice_junctions' ? spliceSettingsPayload : undefined,
                    bigwig_settings: effectiveType === 'bigwig'
                        ? normalizeBigWigSettings({ ...bigWigSettings, data_type: bigWigDataType }, bigWigSettings)
                        : undefined,
                    vcf_settings: effectiveType === 'vcf'
                        ? normalizeVcfSettings(vcfSettings)
                        : undefined,
                    bed_settings: ['bed', 'bigbed', 'gff'].includes(effectiveType)
                        ? normalizeBedSettings(bedSettings)
                        : undefined,
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
            if (data.index_note) setIndexNote(data.index_note)
            onRegistered(data)
            onClose()
        } catch (e) {
            setError(e.message)
        } finally {
            setRegistering(false)
        }
    }

    const inputCls = `w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`

    const labelCls = `block text-xs font-medium mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`

    return (
        <>
            <FileBrowserModal
                isOpen={fileBrowserOpen}
                onClose={() => { setFileBrowserOpen(false) }}
                onSelect={handleFilePicked}
                initialPath={seed?.browserDirectory || initialBrowsePath || '.'}
                mode="file"
                theme={isLight ? 'light' : 'dark'}
                extensions={['.bw', '.bigwig', '.bb', '.bigbed', '.vcf', '.vcf.gz', '.bed', '.bed.gz', '.gff', '.gff3', '.gtf', '.gff.gz', '.gff3.gz', '.gtf.gz', '.bam', '.SJ.out.tab']}
            />

            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
                <div
                    data-tour-id="track-wizard"
                    // Bounded, with the middle scrolling, the way the browser's track picker
                    // already is. Unbounded, a BigWig's settings made the dialog taller than a
                    // 900px laptop window and Register was simply off the bottom of the screen
                    // with no way to reach it — the modal is `fixed`, so nothing scrolls it.
                    className={`w-full max-w-lg rounded-2xl shadow-2xl border flex flex-col max-h-[88vh] ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className={`px-6 py-4 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <div>
                            <h2 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Register Track</h2>
                            <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Step {step} of 2</p>
                        </div>
                        <button onClick={onClose} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>✕</button>
                    </div>

                    <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto min-h-0">
                        {step === 1 && (
                            <div className="text-center space-y-4">
                                <p className={`text-sm ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Select the data file you want to add as a track.</p>
                                <button
                                    data-tour-id="track-wizard-browse"
                                    onClick={() => {
                                        filePickedRef.current = false
                                        setFileBrowserOpen(true)
                                    }}
                                    className="w-full py-8 rounded-xl border-2 border-dashed border-blue-400/50 hover:border-blue-500 hover:bg-blue-500/5 transition-colors text-blue-500 dark:text-blue-400 text-sm font-medium"
                                >
                                    <svg className="w-8 h-8 mx-auto mb-2 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                                    </svg>
                                    Browse for file…
                                </button>
                                <p className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                    Supported: .bw, .bigwig, .bb, .vcf.gz, .bed, .bed.gz, .gff, .gff3, .gtf (.gz), .bam, .SJ.out.tab
                                </p>
                            </div>
                        )}

                        {step === 2 && (
                            <>
                                {/* File path display */}
                                <div>
                                    <span className={labelCls}>Selected file</span>
                                    <div data-tour-id="track-wizard-file" className={`px-3 py-2 rounded-lg text-xs font-mono break-all ${isLight ? 'bg-gray-50 text-gray-600 border border-gray-200' : 'bg-gray-800 text-gray-300 border border-gray-700'}`}>
                                        {filePath}
                                    </div>
                                </div>

                                {/* Type selection */}
                                <div>
                                    <span className={labelCls}>Track type</span>
                                    {detectedType && (
                                        <p className={`text-xs mb-2 ${isLight ? 'text-green-600' : 'text-green-400'}`}>
                                            ✓ Auto-detected as <strong>{TRACK_TYPES.find(t => t.id === detectedType)?.label}</strong>
                                        </p>
                                    )}
                                    {!detectedType && (
                                        <p className={`text-xs mb-2 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                            ⚠ Could not auto-detect type — please select below
                                        </p>
                                    )}
                                    <select
                                        data-tour-id="track-wizard-type"
                                        value={effectiveType || ''}
                                        onChange={e => handleTypeChange(e.target.value)}
                                        className={inputCls}
                                    >
                                        {!effectiveType && <option value="">Select type…</option>}
                                        {TRACK_TYPES.map(t => (
                                            <option key={t.id} value={t.id}>{t.label} — {t.ext}</option>
                                        ))}
                                    </select>
                                </div>

                                {/* Label */}
                                <div>
                                    <label className={labelCls}>Label</label>
                                    <input
                                        data-tour-id="track-wizard-label"
                                        type="text"
                                        value={label}
                                        onChange={e => setLabel(e.target.value)}
                                        className={inputCls}
                                        placeholder="Track label…"
                                    />
                                </div>

                                {effectiveType === 'bigwig' && (
                                    <div data-tour-id="track-wizard-bigwig">
                                        <label className={labelCls}>BigWig plot settings</label>
                                        <BigWigSettingsEditor
                                            dataTypeTourId="track-wizard-datatype"
                                            displayModeTourId="track-wizard-display"
                                            settings={bigWigSettings}
                                            displayMode={displayMode}
                                            onSettingsChange={handleBigWigSettingsChange}
                                            onDisplayModeChange={setDisplayMode}
                                            onDataTypeChange={handleBigWigDataTypeChange}
                                            onDataTypeSelect={setBigWigDataType}
                                            selectedDataType={bigWigDataType}
                                            requireDataTypeSelection
                                            isLight={isLight}
                                        />
                                    </div>
                                )}
                                {effectiveType && effectiveType !== 'bigwig' && (DISPLAY_MODES[effectiveType] || []).length > 1 && (
                                    <div>
                                        <label className={labelCls}>Display mode</label>
                                        <select
                                            data-tour-id="track-wizard-display-mode"
                                            value={displayMode}
                                            onChange={e => setDisplayMode(e.target.value)}
                                            className={inputCls}
                                        >
                                            {(DISPLAY_MODES[effectiveType] || []).map(m => (
                                                <option key={m.id} value={m.id}>{m.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                {effectiveType === 'splice_junctions' && (
                                    <div>
                                        <label className={labelCls}>Splice filters</label>
                                        <SpliceSettingsEditor
                                            value={spliceSettings}
                                            onChange={setSpliceSettings}
                                            isLight={isLight}
                                        />
                                    </div>
                                )}
                                {effectiveType === 'vcf' && (
                                    <div data-tour-id="track-wizard-vcf">
                                        <label className={labelCls}>VCF colours</label>
                                        <VcfSettingsEditor
                                            trackLabel={label}
                                            settings={vcfSettings}
                                            onChange={(next) => setVcfSettings(normalizeVcfSettings(next, vcfSettings))}
                                            isLight={isLight}
                                        />
                                    </div>
                                )}

                                {['bed', 'bigbed', 'gff'].includes(effectiveType) && (
                                    <div>
                                        <label className={labelCls}>Colour</label>
                                        <BedSettingsEditor
                                            trackLabel={label}
                                            settings={bedSettings}
                                            trackType={effectiveType}
                                            onChange={(next) => setBedSettings(normalizeBedSettings(next))}
                                            isLight={isLight}
                                        />
                                    </div>
                                )}

                                {/* Genome */}
                                <div data-tour-id="track-wizard-genome">
                                    <label className={labelCls}>Genome association <span className={`font-normal ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>(optional)</span></label>
                                    <GenomeComboBox
                                        value={genomeKey}
                                        onChange={setGenomeKey}
                                        genomeOptions={genomeOptions}
                                        isLight={isLight}
                                    />
                                    <GenomeNote genomeKey={genomeKey} genomeOptions={genomeOptions} isLight={isLight} />
                                    {!genomeKey && (
                                        <p className={`text-xs mt-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                            Tracks are shown in the Genome Browser only when the matching genome is active.
                                        </p>
                                    )}
                                </div>

                                {/* Error */}
                                {error && (
                                    <div className={`px-3 py-2 rounded-lg text-xs ${isLight ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-red-900/30 text-red-300 border border-red-800'}`}>
                                        {error}
                                    </div>
                                )}
                                {warning && (
                                    <div className={`px-3 py-2 rounded-lg text-xs ${isLight ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-amber-900/30 text-amber-300 border border-amber-800'}`}>
                                        ⚠ {warning}
                                    </div>
                                )}
                                {/* Auto-index success note */}
                                {indexNote && (
                                    <div className={`px-3 py-2 rounded-lg text-xs ${isLight ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-green-900/30 text-green-300 border border-green-800'}`}>
                                        ✓ {indexNote}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    {step === 2 && (
                        <div className={`px-6 py-4 border-t flex justify-between gap-3 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-900/50'}`}>
                            <button
                                data-tour-id="track-wizard-back"
                                onClick={() => { setStep(1); setFilePath('') }}
                                className={`px-4 py-2 rounded-lg text-sm ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                            >
                                ← Back
                            </button>
                            <button
                                data-tour-id="track-wizard-register"
                                onClick={handleRegister}
                                disabled={!effectiveType || !label.trim() || registering || !isBigWigConfigured}
                                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {registering ? 'Registering…' : 'Register Track'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}

// ── Track Card ────────────────────────────────────────────────────────────────

function TrackCard({ track, isLight, genomeOptions, onUpdate, onDelete }) {
    const [editing, setEditing] = useState(false)
    const [editLabel, setEditLabel] = useState(track.label)
    const [editDisplayMode, setEditDisplayMode] = useState(
        track.type === 'bigwig'
            ? normalizeBigWigDisplayMode(track.display_mode, track.bigwig_settings?.data_type)
            : track.type === 'vcf'
                ? normalizeVcfDisplayMode(track.display_mode)
            : track.display_mode
    )
    const [editGenomeKey, setEditGenomeKey] = useState(track.genome_key || '')
    const [editSpliceSettings, setEditSpliceSettings] = useState(normalizeSpliceSettings(track.splice_settings))
    const [editBigWigSettings, setEditBigWigSettings] = useState(normalizeBigWigSettings(track.bigwig_settings))
    const [editVcfSettings, setEditVcfSettings] = useState(normalizeVcfSettings(track.vcf_settings))
    const [editBedSettings, setEditBedSettings] = useState(normalizeBedSettings(track.bed_settings))
    const isBedLike = ['bed', 'bigbed', 'gff'].includes(track.type)
    const [saving, setSaving] = useState(false)
    const [saveWarning, setSaveWarning] = useState('')
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

    const handleSave = async () => {
        setSaving(true)
        try {
            let spliceSettingsPayload
            let bigWigSettingsPayload
            let vcfSettingsPayload
            if (track.type === 'splice_junctions') {
                const { settings, warning } = coerceSpliceSettingsForSave(editSpliceSettings)
                spliceSettingsPayload = settings
                setEditSpliceSettings(settings)
                setSaveWarning(warning || '')
            } else if (track.type === 'bigwig') {
                bigWigSettingsPayload = normalizeBigWigSettings(editBigWigSettings)
                setEditBigWigSettings(bigWigSettingsPayload)
                setSaveWarning('')
            } else if (track.type === 'vcf') {
                vcfSettingsPayload = normalizeVcfSettings(editVcfSettings, track.vcf_settings)
                setEditVcfSettings(vcfSettingsPayload)
                setSaveWarning('')
            } else {
                setSaveWarning('')
            }
            const res = await fetch(`${API_BASE}/api/tracks/${track.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: editLabel,
                    display_mode: track.type === 'bigwig'
                        ? normalizeBigWigDisplayMode(editDisplayMode, normalizeBigWigSettings(editBigWigSettings).data_type)
                        : track.type === 'vcf'
                            ? normalizeVcfDisplayMode(editDisplayMode)
                        : editDisplayMode,
                    genome_key: editGenomeKey,
                    splice_settings: track.type === 'splice_junctions' ? spliceSettingsPayload : undefined,
                    bigwig_settings: track.type === 'bigwig' ? bigWigSettingsPayload : undefined,
                    vcf_settings: track.type === 'vcf' ? vcfSettingsPayload : undefined,
                    bed_settings: isBedLike ? normalizeBedSettings(editBedSettings) : undefined,
                }),
            })
            if (!res.ok) throw new Error()
            const updated = await res.json()
            onUpdate(updated)
            setEditing(false)
        } catch {
            // ignore
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!window.confirm(`Remove track "${track.label}"?\n(The file itself will not be deleted.)`)) return
        try {
            await fetch(`${API_BASE}/api/tracks/${track.id}`, { method: 'DELETE' })
            onDelete(track.id)
        } catch {
            // ignore
        }
    }

    const inputCls = `w-full px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const handleEditBigWigSettingsChange = (nextSettings) => {
        setEditBigWigSettings(normalizeBigWigSettings(nextSettings, editBigWigSettings))
    }
    const handleEditBigWigDataTypeChange = (nextSettings, nextDisplayMode) => {
        setEditBigWigSettings(normalizeBigWigSettings(nextSettings, editBigWigSettings))
        setEditDisplayMode(normalizeBigWigDisplayMode(nextDisplayMode, nextSettings?.data_type))
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
            className={`h-full rounded-xl border p-4 transition-colors ${isLight ? 'bg-white border-gray-200 hover:border-blue-200' : 'bg-gray-800 border-gray-700 hover:border-blue-700/50'}`}
        >
            {!editing ? (
                <div className="flex items-start gap-3">
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
                            {saveWarning && (
                                <span className={`text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                                    ⚠ {saveWarning}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button
                            onClick={() => {
                                setEditing(true)
                                setEditLabel(track.label)
                                setEditDisplayMode(
                                    track.type === 'bigwig'
                                        ? normalizeBigWigDisplayMode(track.display_mode, track.bigwig_settings?.data_type)
                                        : track.type === 'vcf'
                                            ? normalizeVcfDisplayMode(track.display_mode)
                                        : track.display_mode
                                )
                                setEditGenomeKey(track.genome_key || '')
                                setEditSpliceSettings(normalizeSpliceSettings(track.splice_settings))
                                setEditBigWigSettings(normalizeBigWigSettings(track.bigwig_settings))
                                setEditVcfSettings(normalizeVcfSettings(track.vcf_settings))
                                setEditBedSettings(normalizeBedSettings(track.bed_settings))
                                setSaveWarning('')
                            }}
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
            ) : (
                <div className="space-y-3">
                    <div>
                        <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Label</label>
                        <input type="text" value={editLabel} onChange={e => setEditLabel(e.target.value)} className={inputCls} />
                    </div>
                    {track.type === 'bigwig' && (
                        <div>
                            <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>BigWig plot settings</label>
                            <BigWigSettingsEditor
                                settings={editBigWigSettings}
                                displayMode={editDisplayMode}
                                onSettingsChange={handleEditBigWigSettingsChange}
                                onDisplayModeChange={setEditDisplayMode}
                                onDataTypeChange={handleEditBigWigDataTypeChange}
                                isLight={isLight}
                            />
                        </div>
                    )}
                    {track.type === 'vcf' && (
                        <div>
                            <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>VCF colours</label>
                            <VcfSettingsEditor
                                trackLabel={editLabel}
                                settings={editVcfSettings}
                                onChange={(next) => setEditVcfSettings(normalizeVcfSettings(next, editVcfSettings))}
                                isLight={isLight}
                            />
                        </div>
                    )}
                    {isBedLike && (
                        <div>
                            <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Colour</label>
                            <BedSettingsEditor
                                trackLabel={editLabel}
                                settings={editBedSettings}
                                trackType={track.type}
                                onChange={(next) => setEditBedSettings(normalizeBedSettings(next))}
                                isLight={isLight}
                            />
                        </div>
                    )}
                    {track.type !== 'bigwig' && (DISPLAY_MODES[track.type] || []).length > 1 && (
                        <div>
                            <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Display mode</label>
                            <select value={editDisplayMode} onChange={e => setEditDisplayMode(e.target.value)} className={inputCls}>
                                {(DISPLAY_MODES[track.type] || []).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                            </select>
                        </div>
                    )}
                    <div>
                        <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Genome</label>
                        <GenomeComboBox value={editGenomeKey} onChange={setEditGenomeKey} genomeOptions={genomeOptions} isLight={isLight} />
                        <GenomeNote genomeKey={editGenomeKey} genomeOptions={genomeOptions} isLight={isLight} />
                    </div>
                    {track.type === 'splice_junctions' && (
                        <div>
                            <label className={`block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>Splice filters</label>
                            <SpliceSettingsEditor
                                value={editSpliceSettings}
                                onChange={setEditSpliceSettings}
                                isLight={isLight}
                            />
                        </div>
                    )}
                    {saveWarning && (
                        <div className={`px-3 py-2 rounded-lg text-xs ${isLight ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-amber-900/30 text-amber-300 border border-amber-800'}`}>
                            ⚠ {saveWarning}
                        </div>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                        <button onClick={() => setEditing(false)} className={`px-3 py-1.5 rounded-lg text-xs ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}>Cancel</button>
                        <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50">
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            )}
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

    const tracksByGenome = useMemo(() => {
        const map = new Map()
        for (const t of filteredTracks) {
            const key = t.genome_key || ''
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(t)
        }
        return map
    }, [filteredTracks])

    const allGenomes = useMemo(() => {
        const keys = new Set(tracks.map(t => t.genome_key || ''))
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
                        const genomeLabel = findGenomeOption(genomeOptions, genomeKey)?.label
                            || genomeTracks.find((track) => track.genome_label)?.genome_label
                            || fallbackGenomeLabel(genomeKey)
                        return (
                            <div key={genomeKey}>
                                <h2 className={`text-xs font-semibold mb-3 ${textSecondary}`}>{genomeLabel}</h2>
                                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-stretch auto-rows-fr">
                                    {genomeTracks.map(track => (
                                        <TrackCard
                                            key={track.id}
                                            track={track}
                                            isLight={isLight}
                                            genomeOptions={genomeOptions}
                                            onUpdate={handleUpdate}
                                            onDelete={handleDelete}
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
            {showWizard && (
                <RegistrationWizard
                    isLight={isLight}
                    genomeOptions={genomeOptions}
                    onClose={() => { setShowWizard(false); setWizardSeed(null) }}
                    onRegistered={handleRegistered}
                    initialBrowsePath={browsePath}
                    seed={wizardSeed}
                />
            )}
        </div>
        </TrackColorPaletteContext.Provider>
    )
}

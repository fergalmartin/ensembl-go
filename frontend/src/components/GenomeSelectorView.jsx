import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react'
import { IconTrash } from './ConfigurationView'
import FileBrowserModal from './FileBrowserModal'
import AppButtonIcon from './AppButtonIcon'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'
import ValidationReportPanel from './ValidationReportPanel'
import { runGenomeAnalysis } from '../utils/genomeAnalysisRunner'
import ProgressGlyph from './ProgressGlyph'
import { API_BASE } from '../backendRuntime'
import {
    buildDefaultScreenshotName,
    buildDomNodeScreenshotSnapshot,
    measureScreenshotNode,
} from '../utils/screenshotExport'
import {
    getAssemblyAccession,
    formatDatasetReleaseShortLabel,
    getGenomeKey,
    genomeKeyCandidates,
    genomeKeysMatch,
    normalizeGenomeProvider,
    normalizeGenomeRecord,
    normalizeGenomeSourceDatabase,
} from '../utils/genomeIdentity'
import { datasetReleaseDownloadMetadata } from '../utils/downloadMetadata'
import {
    getCurrentGenomeAnalysis,
    genomeAnalysisKind,
    isAnalysableGenomeFileType,
    withGenomeAnalysis,
    withoutGenomeAnalysis,
} from '../utils/genomeAnalysis'
import {
    batchProgress,
    findDuplicateManualGenome,
    manualGenomeLabel,
    manualProgressText,
    mergeManualGenomePlaylistMemberships,
} from '../utils/manualGenomeConfig'
import {
    GENOME_FILE_EDITOR_TYPES,
    MANUAL_GENOME_FILE_EDITOR_TYPES,
    canonicalBundleFiles,
    localFileTypeLabel,
    orderBundleFileTypes,
} from '../utils/genomeFileTypes'
import {
    bundleMissingFileReport,
    bundlePreviewModel,
    buildGenomeBundle,
    registrationBadgeLabel,
    registrationBadgeTooltip,
} from '../utils/genomeBundle'
import GenomeBundlePreviewModal from './GenomeBundlePreviewModal'
import { deregisterGenomesFromConfig } from '../utils/genomeDeregistration'
import {
    REMOVAL_FILL_ALL,
    REMOVAL_FILL_SELECTED,
    computeSelectAllChecked,
    flaggedItems,
    formatBytes,
    nextRemovalFlags,
    partitionRemovalTargets,
    registeredRemovalFiles,
    selectableItems,
    toggleRemovalFlag,
} from '../utils/genomeRemovalSelection'

const FASTA_EXTENSIONS = ['.fa', '.fna', '.fasta', '.fa.gz', '.fna.gz', '.fasta.gz', '.fa.bgz', '.fna.bgz', '.fasta.bgz']
// GFF3 loads directly; GFF and GTF are accepted too but must be converted into
// canonical GFF3 on import, which the backend enforces.
const GFF3_EXTENSIONS = [
    '.gff3', '.gff3.gz', '.gff3.bgz',
    '.gff', '.gff.gz', '.gff.bgz',
    '.gtf', '.gtf.gz', '.gtf.bgz',
]
const CONVERSION_REQUIRED_EXTENSIONS = ['.gtf', '.gtf.gz', '.gtf.bgz', '.gff2', '.gff2.gz']
const HOMOLOGY_EXTENSIONS = ['.tsv', '.tsv.gz']
const LOCAL_PAGE_SIZE = 10
// Selecting this many genomes at once is worth a confirmation: it changes what
// the whole app is working with.
const BULK_SELECT_CONFIRM_THRESHOLD = 50
// Genomes per remove-data call, so a long run reports progress as it goes.
const REMOVAL_CHUNK_SIZE = 8
const PLAYLIST_ALL_ID = '__all__'
const SELECTOR_PENDING_GENOMES_STORAGE_KEY = 'ensembl_selector_pending_genomes'
const SELECTOR_REFRESH_EVENT = 'ensembl:selector-refresh'
const todayIsoDate = () => new Date().toISOString().slice(0, 10)
const defaultCustomAnnotationLabel = () => `custom ${todayIsoDate()}`

const readPendingSelectorGenomeIds = () => {
    if (typeof window === 'undefined' || !window.sessionStorage) return new Set()
    try {
        const raw = window.sessionStorage.getItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY)
        const parsed = JSON.parse(raw || '[]')
        return new Set(Array.isArray(parsed) ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean) : [])
    } catch {
        return new Set()
    }
}

const writePendingSelectorGenomeIds = (ids) => {
    if (typeof window === 'undefined' || !window.sessionStorage) return
    try {
        window.sessionStorage.setItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY, JSON.stringify(Array.from(ids)))
    } catch {
        // Ignore storage failures; the task poller still refreshes completed downloads.
    }
}

const IconChevron = ({ open, size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }} aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
    </svg>
)

const AddGenomeGlyph = ({ size = 16, style = undefined, opacity = 1 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        aria-hidden="true"
        style={style}
        opacity={opacity}
    >
        <path d="M12 5v14M5 12h14" />
    </svg>
)

const IconClipboard = ({ size = 14 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <rect x="7" y="4" width="13" height="16" rx="2" />
        <path d="M16 4V3a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h2" />
    </svg>
)

// ---------------------------------------------------------------------------
// Expanded per-genome file editor panel
// ---------------------------------------------------------------------------
const FILE_EDIT_EXTENSIONS = {
    fasta: FASTA_EXTENSIONS,
    gff3: GFF3_EXTENSIONS,
    index: ['.db'],
    homology: ['.tsv', '.tsv.gz'],
    cdna: ['.fa', '.fasta', '.fa.gz', '.fasta.gz', '.fa.bgz', '.fasta.bgz'],
    protein: ['.fa', '.fasta', '.fa.gz', '.fasta.gz', '.fa.bgz', '.fasta.bgz'],
    xref: ['.tsv', '.tsv.gz'],
    metadata: ['.json', '.txt'],
    gff3_index: ['.csi', '.tbi'],
    gtf_index: ['.csi', '.tbi'],
    cdna_index: ['.fai', '.gzi'],
    protein_index: ['.fai', '.gzi'],
}

function GenomeFileEditor({
    item,
    effectiveFiles,
    isLight,
    theme,
    confirmDeleteFile,
    setConfirmDeleteFile,
    onDeleteFile,
    onBrowse,
    onSavePath,
    analysisByType = {},
    onAnalyse,
}) {
    const genomeKey = itemKey(item)
    // A hand-added genome only ever has the three base types, but one registered
    // from a bundle can carry the full download set — show whatever it actually
    // has rather than silently hiding files it came with.
    const fileTypes = React.useMemo(() => {
        if (!item.is_manual) return GENOME_FILE_EDITOR_TYPES
        const extras = Object.keys(effectiveFiles || {}).filter((type) => (
            !MANUAL_GENOME_FILE_EDITOR_TYPES.includes(type) && effectiveFiles[type]
        ))
        return [...MANUAL_GENOME_FILE_EDITOR_TYPES, ...orderBundleFileTypes(extras)]
    }, [item.is_manual, effectiveFiles])

    const [editPaths, setEditPaths] = React.useState(() => ({ ...effectiveFiles }))
    const [openAnalysisTypes, setOpenAnalysisTypes] = React.useState({})
    const [pendingAnalysisTypes, setPendingAnalysisTypes] = React.useState({})
    React.useEffect(() => { setEditPaths({ ...effectiveFiles }) }, [effectiveFiles])

    const inputBg = isLight
        ? 'bg-white border-gray-200 text-gray-800 placeholder-gray-300 focus:border-[#0099ff] focus:ring-[#0099ff]/30'
        : 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-blue-500/30'
    const browseBtn = isLight
        ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-300'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
    const deleteBtn = isLight
        ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
        : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'
    const rowHover = isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/30'
    const rowText = isLight ? 'text-gray-700' : 'text-gray-300'
    const pathText = isLight ? 'text-gray-500' : 'text-gray-400'
    const gridTemplateColumns = '132px 150px minmax(180px,1fr) 190px'

    const handleBlur = (type, value) => {
        const prev = effectiveFiles[type] || ''
        if (value !== prev) onSavePath(type, value)
    }

    return (
        <div className={`rounded-lg border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/60 border-gray-700'}`}>
            <div className={`grid items-center gap-2 px-3 py-2 border-b text-[10px] font-bold uppercase tracking-widest ${isLight ? 'bg-gray-50 border-gray-200 text-gray-500' : 'bg-gray-750 border-gray-700 text-gray-400'}`} style={{ gridTemplateColumns }}>
                <span>Type</span>
                <span>File</span>
                <span>Path</span>
                <span className="text-right">Actions</span>
            </div>
            <div className={`divide-y ${isLight ? 'divide-gray-100' : 'divide-gray-700/60'}`}>
                {fileTypes.map((type) => {
                    const path = effectiveFiles[type] || ''
                    const editPath = editPaths[type] ?? path
                    const isConfirmingDelete = confirmDeleteFile?.fileType === type && confirmDeleteFile?.path === path && itemKey(confirmDeleteFile?.item) === genomeKey
                    const typeLabel = localFileTypeLabel(type, item.is_manual)
                    const filename = basenameFromPath(editPath || path)
                    const analysis = analysisByType[type] || null
                    const locallyBusy = Boolean(pendingAnalysisTypes[type])
                    const analysisBusy = locallyBusy || analysis?.status === 'queued' || analysis?.status === 'running'
                    const hasAnalysis = analysis?.status === 'success' && analysis?.report
                    const analysisOpen = Boolean(openAnalysisTypes[type])
                    const canAnalyse = isAnalysableGenomeFileType(type) && Boolean(path)
                    const analysisProgress = Math.max(0, Math.min(100, Number(analysis?.progress || 0)))
                    const displayedAnalysis = analysis || (locallyBusy
                        ? {
                            status: 'queued',
                            progress: 0,
                            message: 'Starting analysis',
                            report: null,
                            error: null,
                        }
                        : null)

                    const handleAnalyseClick = async () => {
                        if (hasAnalysis && !analysisOpen) {
                            setOpenAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                            return
                        }
                        setOpenAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                        if (analysisBusy) return
                        setPendingAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                        try {
                            await onAnalyse?.(type)
                        } finally {
                            setPendingAnalysisTypes((prev) => ({ ...prev, [type]: false }))
                        }
                    }

                    return (
                        <React.Fragment key={type}>
                            <div
                                className={`grid items-center gap-2 px-3 py-1.5 text-xs ${rowHover}`}
                                style={{ gridTemplateColumns }}
                            >
                                <span className={`min-w-0 truncate font-semibold ${rowText}`} title={typeLabel}>
                                    {typeLabel}
                                </span>
                                <span className={`min-w-0 truncate font-mono ${pathText}`} title={filename || `No ${typeLabel} file`}>
                                    {filename || '-'}
                                </span>
                                <div className="min-w-0">
                                    <input
                                        type="text"
                                        value={editPath}
                                        placeholder={`No ${typeLabel} file`}
                                        onChange={(e) => setEditPaths((prev) => ({ ...prev, [type]: e.target.value }))}
                                        onFocus={(e) => { e.target.scrollLeft = 0 }}
                                        onBlur={(e) => {
                                            handleBlur(type, e.target.value)
                                            requestAnimationFrame(() => {
                                                if (e.target) e.target.scrollLeft = e.target.scrollWidth
                                            })
                                        }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                                        ref={(el) => { if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth }}
                                        className={`w-full min-w-0 px-2 py-1 rounded border text-xs font-mono transition-colors focus:outline-none focus:ring-1 ${inputBg}`}
                                    />
                                </div>
                                <div className="flex items-center gap-1 justify-end">
                                    {isAnalysableGenomeFileType(type) && (
                                        <button
                                            type="button"
                                            onClick={handleAnalyseClick}
                                            disabled={!canAnalyse || analysisBusy}
                                            aria-busy={analysisBusy}
                                            className={`h-7 px-2 rounded text-[10px] font-semibold transition-colors border inline-flex items-center gap-1.5 ${analysisBusy
                                                ? (isLight
                                                    ? 'bg-blue-100 text-blue-800 border-blue-300 cursor-wait'
                                                    : 'bg-blue-900/50 text-blue-200 border-blue-600 cursor-wait')
                                                : canAnalyse
                                                ? (isLight
                                                    ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                                                    : 'bg-blue-900/30 text-blue-300 border-blue-700/40 hover:bg-blue-900/50')
                                                : (isLight
                                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-default'
                                                    : 'bg-gray-800 text-gray-500 border-gray-700 cursor-default')
                                                }`}
                                            title={hasAnalysis
                                                ? (analysisOpen ? `Reanalyse the ${typeLabel} file` : 'Show the saved analysis')
                                                : `Analyse the ${typeLabel} file`}
                                        >
                                            {analysisBusy ? (
                                                <span
                                                    className="w-3 h-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"
                                                    aria-hidden="true"
                                                />
                                            ) : null}
                                            <span aria-live="polite">
                                                {analysisBusy
                                                ? (analysisProgress > 0 ? `Analysing ${Math.round(analysisProgress)}%` : 'Analysing…')
                                                : (hasAnalysis ? (analysisOpen ? 'Reanalyse' : 'View analysis') : (analysis?.status === 'failed' ? 'Retry analysis' : 'Analyse'))}
                                            </span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => onBrowse(type)}
                                        className={`w-7 h-7 rounded text-xs transition-colors inline-flex items-center justify-center ${browseBtn}`}
                                        title={`Browse for ${typeLabel} file`}
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                        </svg>
                                    </button>
                                    {isConfirmingDelete ? (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => onDeleteFile(confirmDeleteFile)}
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isLight ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-red-900/40 text-red-400 hover:bg-red-900/60'}`}
                                            >
                                                Delete
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setConfirmDeleteFile(null)}
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                Cancel
                                            </button>
                                        </>
                                    ) : (
                                            <button
                                                type="button"
                                                onClick={() => path && setConfirmDeleteFile({ path, fileType: type, item })}
                                                disabled={!path}
                                                className={`p-1 rounded transition-colors ${path ? deleteBtn : 'opacity-20 cursor-default'}`}
                                                title={path ? `Delete ${typeLabel} file` : `No ${typeLabel} file to delete`}
                                            >
                                                <IconTrash size={13} />
                                            </button>
                                    )}
                                </div>
                            </div>
                            {analysisOpen && displayedAnalysis ? (
                                <div className={`px-3 py-3 ${isLight ? 'bg-blue-50/30' : 'bg-blue-950/10'}`}>
                                    <ValidationReportPanel
                                        kind={genomeAnalysisKind(type)}
                                        theme={theme}
                                        status={displayedAnalysis.status}
                                        progress={displayedAnalysis.progress}
                                        stage={displayedAnalysis.stage}
                                        message={displayedAnalysis.message}
                                        counters={displayedAnalysis.counters}
                                        report={displayedAnalysis.report}
                                        error={displayedAnalysis.error}
                                        analysedAt={displayedAnalysis.analysed_at}
                                        onClose={() => setOpenAnalysisTypes((prev) => ({ ...prev, [type]: false }))}
                                    />
                                </div>
                            ) : null}
                        </React.Fragment>
                    )
                })}
            </div>
        </div>
    )
}

const basenameFromPath = (value = '') => {
    const normalized = String(value || '').replace(/\\/g, '/')
    const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
    if (!trimmed) return ''
    const parts = trimmed.split('/')
    return parts[parts.length - 1] || ''
}

const dirnameFromPath = (value = '') => {
    const normalized = String(value || '').replace(/\\/g, '/')
    const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
    const idx = trimmed.lastIndexOf('/')
    if (idx < 0) return '.'
    if (idx === 0) return '/'
    return trimmed.slice(0, idx)
}

const DEFAULT_BUNDLE_FILENAME = 'ensembl-go-genomes.json'

const joinPath = (base, child) => {
    if (!base) return child
    if (!child) return base
    if (base === '/') return `/${child}`
    return `${base.replace(/\/+$/, '')}/${child}`
}

// Strips any annotation extension, so a GTF does not derive an index named
// `<name>.gtf.gz.gff3.index.db`.
const stripGffSuffix = (filename = '') =>
    filename.replace(/\.(?:ensembl\.)?(?:gff3|gff|gtf|gff2)(\.(?:gz|bgz))?$/i, '')

const deriveIndexPathFromGff = (gffPath = '', fallbackDir = '') => {
    if (!gffPath) return ''
    const file = basenameFromPath(gffPath)
    const prefix = stripGffSuffix(file) || 'genome'
    const dir = dirnameFromPath(gffPath) || fallbackDir || '.'
    return joinPath(dir, `${prefix}.gff3.index.db`)
}

const manualIndexFilename = (genomeLabel = '', assemblyLabel = '', annotationPath = '') => {
    const labelStem = [genomeLabel, assemblyLabel]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('_')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
    const annotationStem = stripGffSuffix(basenameFromPath(annotationPath)) || 'genome'
    return `${labelStem || annotationStem}.gff3.index.db`
}

const titleCaseWords = (value = '') =>
    value
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')

const toSpeciesKey = (value = '') =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')

const formatSpeciesNameFromKey = (speciesKey = '') => titleCaseWords(String(speciesKey || '').replace(/_/g, ' '))
const itemKey = (item) => {
    return getGenomeKey(item)
}
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)

const buildPlaylistId = () => `playlist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const snapshotGenomeForPlaylist = (item) => {
    const normalized = normalizeGenomeRecord(item)
    const key = itemKey(normalized)
    if (!key) return null
    return {
        key,
        assembly_key: String(normalized?.assembly_key || '').trim(),
        selection_key: String(normalized?.selection_key || key).trim(),
        species_key: String(normalized?.species_key || '').trim(),
        assembly: String(normalized?.assembly || '').trim(),
        scientific_name: String(normalized?.scientific_name || '').trim() || formatSpeciesNameFromKey(normalized?.species_key || ''),
        common_name: String(normalized?.common_name || '').trim(),
        display_name: String(normalized?.display_name || '').trim(),
        display_name_reason: String(normalized?.display_name_reason || '').trim(),
        assembly_name: String(normalized?.assembly_name || normalized?.assembly || '').trim(),
        provider: normalizeGenomeProvider(normalized),
        source_database: normalizeGenomeSourceDatabase(normalized),
        gca: String(normalized?.gca || '').trim(),
        dataset_release_key: String(normalized?.dataset_release_key || '').trim(),
        dataset_release_source: String(normalized?.dataset_release_source || '').trim(),
        dataset_release_date: String(normalized?.dataset_release_date || '').trim(),
        dataset_release_label: String(normalized?.dataset_release_label || '').trim(),
        dataset_release_short_label: String(normalized?.dataset_release_short_label || '').trim(),
        is_manual: Boolean(normalized?.is_manual),
        active_by_default: Boolean(item?.active_by_default),
    }
}

const normalizePlaylistGenome = (item) => {
    if (!item || typeof item !== 'object') return null
    const normalized = normalizeGenomeRecord(item)
    const assembly = String(normalized?.assembly || '').trim()
    const key = String(itemKey(normalized) || item?.key || '').trim()
    if (!key) return null
    return {
        key,
        assembly_key: String(normalized?.assembly_key || '').trim(),
        selection_key: String(normalized?.selection_key || key).trim(),
        species_key: String(normalized?.species_key || '').trim(),
        assembly,
        scientific_name: String(normalized?.scientific_name || '').trim() || formatSpeciesNameFromKey(normalized?.species_key || ''),
        common_name: String(normalized?.common_name || '').trim(),
        display_name: String(normalized?.display_name || '').trim(),
        display_name_reason: String(normalized?.display_name_reason || '').trim(),
        assembly_name: String(normalized?.assembly_name || assembly).trim(),
        provider: normalizeGenomeProvider(normalized),
        source_database: normalizeGenomeSourceDatabase(normalized),
        gca: String(normalized?.gca || '').trim(),
        dataset_release_key: String(normalized?.dataset_release_key || '').trim(),
        dataset_release_source: String(normalized?.dataset_release_source || '').trim(),
        dataset_release_date: String(normalized?.dataset_release_date || '').trim(),
        dataset_release_label: String(normalized?.dataset_release_label || '').trim(),
        dataset_release_short_label: String(normalized?.dataset_release_short_label || '').trim(),
        is_manual: Boolean(normalized?.is_manual),
        active_by_default: Boolean(item?.active_by_default),
    }
}

const normalizeGenomePlaylists = (playlists) => {
    const normalized = []
    const seenIds = new Set()
    for (const [index, rawPlaylist] of (Array.isArray(playlists) ? playlists : []).entries()) {
        if (!rawPlaylist || typeof rawPlaylist !== 'object') continue
        const baseId = String(rawPlaylist?.id || '').trim() || `playlist_${index + 1}`
        let nextId = baseId
        let suffix = 1
        while (seenIds.has(nextId)) {
            nextId = `${baseId}_${suffix}`
            suffix += 1
        }
        seenIds.add(nextId)

        const rawGenomes = Array.isArray(rawPlaylist?.genomes) ? rawPlaylist.genomes : []
        const hasExplicitActiveDefaults = rawGenomes.some((rawGenome) => hasOwn(rawGenome, 'active_by_default'))
        const genomes = []
        for (const rawGenome of rawGenomes) {
            const genome = normalizePlaylistGenome(rawGenome)
            if (!genome?.key || genomes.some((existing) => genomeKeysMatch(existing, genome))) continue
            genomes.push(genome)
        }
        if (!hasExplicitActiveDefaults && genomes.length > 0) {
            genomes[0] = { ...genomes[0], active_by_default: true }
        }

        normalized.push({
            id: nextId,
            name: String(rawPlaylist?.name || '').trim() || `Playlist ${normalized.length + 1}`,
            description: String(rawPlaylist?.description || '').trim(),
            genomes,
            system: Boolean(rawPlaylist?.system),
            hidden: Boolean(rawPlaylist?.hidden),
        })
    }
    return normalized
}

const matchesGenomeSearch = (item, searchQuery) => {
    const q = String(searchQuery || '').trim().toLowerCase()
    if (!q) return true
    return [
        item?.scientific_name,
        item?.common_name,
        item?.display_name,
        item?.assembly,
        item?.assembly_name,
        item?.species_key,
        item?.gca,
        item?.provider,
        item?.source_database,
        item?.key,
    ].some((value) => String(value || '').toLowerCase().includes(q))
}

const formatPlaylistGenomeLabel = (item) => {
    const species = String(item?.display_name || item?.scientific_name || '').trim() || formatSpeciesNameFromKey(item?.species_key || '')
    const assembly = String(item?.assembly_name || item?.assembly || '').trim()
    return assembly ? `${species} (${assembly})` : species
}

const canDownloadPlaylistGenome = (item) => {
    if (!item || item.is_manual) return false
    return Boolean(item.species_key && getAssemblyAccession(item) && normalizeGenomeProvider(item))
}

/**
 * Confirming a removal.
 *
 * Two intentions get their own button, because they are not the same thing:
 * forgetting a genome, and deleting its data. The preview comes from the backend
 * so the list of files is what will actually be deleted, and the files the user
 * supplied are named in full — they are the ones people worry about.
 */
function GenomeRemovalDialog({ isOpen, theme, targets, preview, onClose, onRemove }) {
    const isLight = theme === 'light'
    const [expanded, setExpanded] = useState(false)
    const [affectedFilesExpanded, setAffectedFilesExpanded] = useState(false)
    const [copiedPath, setCopiedPath] = useState('')
    const [includeManual, setIncludeManual] = useState(true)

    useEffect(() => {
        if (isOpen) {
            setExpanded(false)
            setAffectedFilesExpanded(false)
            setCopiedPath('')
            setIncludeManual(true)
        }
    }, [isOpen])

    const { manual, downloaded, missing } = useMemo(
        () => partitionRemovalTargets(targets || []),
        [targets],
    )
    const knownAffectedFiles = useMemo(
        () => registeredRemovalFiles(targets || []),
        [targets],
    )

    if (!isOpen || !(targets || []).length) return null

    const plans = preview?.status === 'ready' ? (preview.plans || []) : []
    const totals = preview?.totals || {}
    const protectedFiles = plans.flatMap((plan) => plan.protected || [])
    const leftInPlace = plans.flatMap((plan) => plan.left_in_place || [])
    const previewAffectedFiles = plans.flatMap((plan) => plan.deletable || [])
    const affectedFiles = preview?.status === 'ready' ? previewAffectedFiles : knownAffectedFiles
    const deletableCount = Number(totals.files || 0)
    const canDeleteData = downloaded.length > 0 || manual.length > 0
    const deleteScopeCount = includeManual ? downloaded.length + manual.length : downloaded.length
    const deregisterLabel = targets.length === 1 ? 'Deregister genome' : 'Deregister genomes'

    const heading = (targets || []).length === 1
        ? `Remove ${targets[0].scientific_name || targets[0].species_key}?`
        : `Remove ${targets.length} genomes?`

    const copyAffectedPath = async (path) => {
        const value = String(path || '')
        if (!value || !navigator?.clipboard?.writeText) return
        try {
            await navigator.clipboard.writeText(value)
            setCopiedPath(value)
            window.setTimeout(() => setCopiedPath((current) => current === value ? '' : current), 1600)
        } catch {
            // The full path remains available in the tooltip if clipboard access
            // is unavailable in the current runtime.
        }
    }

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl max-h-[85vh] flex flex-col ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{heading}</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`w-7 h-7 rounded flex items-center justify-center ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        &#10005;
                    </button>
                </div>

                <div className="px-5 py-4 overflow-y-auto text-sm space-y-4">
                    <ul className={`space-y-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                        {(targets || []).slice(0, expanded ? targets.length : 6).map((item) => (
                            <li key={itemKey(item)} className="flex items-center gap-2">
                                <span className="font-medium">{item.scientific_name || item.species_key}</span>
                                <span className="opacity-60 text-xs font-mono">{getAssemblyAccession(item) || item.assembly}</span>
                                {item.is_manual ? (
                                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/40 text-indigo-300'}`}>
                                        added manually
                                    </span>
                                ) : null}
                            </li>
                        ))}
                        {!expanded && targets.length > 6 ? (
                            <li>
                                <button type="button" onClick={() => setExpanded(true)} className="text-xs underline opacity-70 hover:opacity-100">
                                    show {targets.length - 6} more
                                </button>
                            </li>
                        ) : null}
                    </ul>

                    <div className={`rounded-lg border px-3 py-2.5 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/40'}`}>
                        {preview?.status === 'loading' ? (
                            <span className="text-xs opacity-70">Checking what is on disk…</span>
                        ) : preview?.status === 'error' ? (
                            <span className={`text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>
                                Could not check what is on disk: {preview.error}
                            </span>
                        ) : (
                            <div className="text-xs space-y-1">
                                <div>
                                    <span className="font-semibold">{deletableCount}</span> file{deletableCount === 1 ? '' : 's'} would be deleted
                                    {totals.bytes ? <> — frees up to <span className="font-semibold">{formatBytes(totals.bytes)}</span></> : null}
                                </div>
                                {downloaded.length > 0 ? (
                                    <div className="opacity-80">{downloaded.length} downloaded genome{downloaded.length === 1 ? '' : 's'} in your data folder</div>
                                ) : null}
                                {missing.length > 0 ? (
                                    <div className="opacity-80">{missing.length} playlist entr{missing.length === 1 ? 'y has' : 'ies have'} no local files — they can only be forgotten</div>
                                ) : null}
                                {downloaded.length > 0 ? (
                                    <div className="opacity-80">
                                        Deregistering removes the genome from this list while leaving its
                                        downloaded files untouched.
                                    </div>
                                ) : null}
                                {leftInPlace.length > 0 ? (
                                    <div className="opacity-80">
                                        Attached track hub files stay on disk ({leftInPlace.map((entry) => formatBytes(entry.bytes)).join(', ')}).
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>

                    <div className={`rounded-lg border overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/30'}`}>
                        <button
                            type="button"
                            onClick={() => setAffectedFilesExpanded((current) => !current)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-xs font-semibold transition-colors ${isLight
                                ? 'text-gray-800 hover:bg-gray-50'
                                : 'text-gray-200 hover:bg-gray-800'
                                }`}
                            aria-expanded={affectedFilesExpanded}
                        >
                            <span>
                                Affected files
                                {` (${affectedFiles.length})`}
                            </span>
                            <IconChevron open={affectedFilesExpanded} size={13} />
                        </button>
                        {affectedFilesExpanded ? (
                            <div className={`border-t px-3 py-2.5 ${isLight ? 'border-gray-200 bg-gray-50/60' : 'border-gray-700 bg-gray-900/50'}`}>
                                {affectedFiles.length === 0 ? (
                                    <div className="text-xs opacity-70">
                                        {preview?.status === 'loading'
                                            ? 'Checking for generated files…'
                                            : 'No files would be deleted.'}
                                    </div>
                                ) : (
                                    <>
                                        {preview?.status === 'loading' ? (
                                            <div className="mb-2 text-[11px] opacity-70">
                                                Showing registered paths now; checking for generated sidecars…
                                            </div>
                                        ) : preview?.status === 'error' ? (
                                            <div className={`mb-2 text-[11px] ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                                                Showing registered paths; the additional disk check was unavailable.
                                            </div>
                                        ) : null}
                                        <ul className="space-y-1.5">
                                            {affectedFiles.map((entry, index) => {
                                                const path = String(entry?.path || '')
                                                return (
                                                    <li key={`${path}-${index}`} className="flex min-w-0 items-center gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => copyAffectedPath(path)}
                                                            className={`flex-none rounded p-1 transition-colors ${isLight
                                                                ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-800'
                                                                : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100'
                                                                }`}
                                                            title={copiedPath === path ? 'Copied' : 'Copy full path'}
                                                            aria-label={copiedPath === path ? 'Path copied' : `Copy ${path}`}
                                                        >
                                                            <IconClipboard size={13} />
                                                        </button>
                                                        <span
                                                            className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}
                                                            style={{ direction: 'rtl', textAlign: 'left' }}
                                                            title={path}
                                                        >
                                                            {path}
                                                        </span>
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                    </>
                                )}
                            </div>
                        ) : null}
                    </div>

                    {manual.length > 0 ? (
                        <div className={`rounded-lg border px-3 py-2.5 text-xs ${isLight ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-amber-700/60 bg-amber-900/20 text-amber-100'}`}>
                            <div className="font-semibold">
                                {manual.length} genome{manual.length === 1 ? ' was' : 's were'} added manually.
                            </div>
                            <p className="mt-1">
                                Only files Ensembl Go generated for them are deleted — the index, sequence
                                and annotation indexes, and any annotation it converted. The files you
                                supplied are left exactly where they are:
                            </p>
                            <ul className="mt-1.5 space-y-0.5 font-mono break-all">
                                {protectedFiles.slice(0, 8).map((entry) => (
                                    <li key={entry.path}>{entry.path}</li>
                                ))}
                                {protectedFiles.length > 8 ? <li className="font-sans opacity-70">…and {protectedFiles.length - 8} more</li> : null}
                            </ul>
                        </div>
                    ) : null}

                    {manual.length > 0 && downloaded.length > 0 ? (
                        <label className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <input
                                type="checkbox"
                                checked={includeManual}
                                onChange={(event) => setIncludeManual(event.target.checked)}
                                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                            />
                            Include the manually added genomes
                        </label>
                    ) : null}
                </div>

                <div className={`px-5 py-4 border-t flex flex-wrap items-center gap-2 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        type="button"
                        onClick={() => onRemove({ deleteData: false, includeManual: true })}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${isLight
                            ? 'bg-white border-gray-300 text-gray-800 hover:bg-gray-100'
                            : 'bg-transparent border-gray-600 text-gray-200 hover:bg-gray-700'
                            }`}
                        title="Forget these genomes. Nothing on disk is touched."
                    >
                        {deregisterLabel}
                    </button>
                    <button
                        type="button"
                        disabled={!canDeleteData || deleteScopeCount === 0}
                        onClick={() => onRemove({ deleteData: true, includeManual })}
                        className={`px-3 py-2 rounded-lg text-xs font-bold text-white transition-colors ${!canDeleteData || deleteScopeCount === 0
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-red-600 hover:bg-red-500'
                            }`}
                        title="Delete the files Ensembl Go downloaded or generated, then forget the genomes."
                    >
                        {manual.length > 0 && downloaded.length > 0 && !includeManual
                            ? `Delete data · downloads only (${downloaded.length})`
                            : `Delete data (${deleteScopeCount})`}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`ml-auto px-3 py-2 rounded-lg text-xs font-medium ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700'}`}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}

function PlaylistMembershipModal({ isOpen, theme, genome, playlists, onClose, onSave }) {
    const isLight = theme === 'light'
    const genomeKey = itemKey(genome)
    const [selectedIds, setSelectedIds] = useState(new Set())
    const [newPlaylistName, setNewPlaylistName] = useState('')
    const [newPlaylistDescription, setNewPlaylistDescription] = useState('')
    const editablePlaylists = useMemo(
        () => (Array.isArray(playlists) ? playlists : []).filter((playlist) => !playlist.system),
        [playlists]
    )

    useEffect(() => {
        if (!isOpen || !genomeKey) return
        const nextSelected = new Set(
            editablePlaylists
                .filter((playlist) => playlist.genomes.some((member) => genomeKeysMatch(member, genomeKey)))
                .map((playlist) => playlist.id)
        )
        setSelectedIds(nextSelected)
        setNewPlaylistName('')
        setNewPlaylistDescription('')
    }, [isOpen, genomeKey, editablePlaylists])

    if (!isOpen || !genome) return null

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`w-full max-w-xl rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div>
                        <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Add to playlists</h3>
                        <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{formatPlaylistGenomeLabel(genome)}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`p-2 rounded-lg transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <div>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Existing playlists</div>
                        <div className={`rounded-xl border max-h-52 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                            {editablePlaylists.length === 0 ? (
                                <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No playlists yet.</div>
                            ) : editablePlaylists.map((playlist) => {
                                const checked = selectedIds.has(playlist.id)
                                return (
                                    <label
                                        key={playlist.id}
                                        className={`flex items-start gap-3 px-4 py-3 border-b last:border-b-0 cursor-pointer ${isLight ? 'border-gray-200 hover:bg-white' : 'border-gray-700 hover:bg-gray-800/70'}`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => {
                                                setSelectedIds((prev) => {
                                                    const next = new Set(prev)
                                                    if (next.has(playlist.id)) next.delete(playlist.id)
                                                    else next.add(playlist.id)
                                                    return next
                                                })
                                            }}
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <div className="min-w-0">
                                            <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>{playlist.name}</div>
                                            <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {playlist.genomes.length} genome{playlist.genomes.length === 1 ? '' : 's'}
                                                {playlist.description ? ` • ${playlist.description}` : ''}
                                            </div>
                                        </div>
                                    </label>
                                )
                            })}
                        </div>
                    </div>

                    <div className={`rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Create new playlist</div>
                        <div className="space-y-3">
                            <input
                                type="text"
                                value={newPlaylistName}
                                onChange={(event) => setNewPlaylistName(event.target.value)}
                                placeholder="Playlist name"
                                className={`w-full px-3 py-2 rounded-lg text-sm border ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                    : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                    }`}
                            />
                            <textarea
                                value={newPlaylistDescription}
                                onChange={(event) => setNewPlaylistDescription(event.target.value)}
                                placeholder="Description (optional)"
                                rows={3}
                                className={`w-full px-3 py-2 rounded-lg text-sm border resize-none ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                    : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                    }`}
                            />
                        </div>
                    </div>
                </div>

                <div className={`px-5 py-4 border-t flex items-center justify-end gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold border ${isLight
                            ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                            : 'bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700'
                            }`}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const didSave = onSave({
                                genome,
                                selectedPlaylistIds: Array.from(selectedIds),
                                newPlaylistName,
                                newPlaylistDescription,
                            })
                            if (didSave !== false) onClose()
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold ${isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}

function PlaylistEditorModal({ isOpen, theme, playlist, availableAssembliesByKey, onClose, onSave }) {
    const isLight = theme === 'light'
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [genomes, setGenomes] = useState([])

    useEffect(() => {
        if (!isOpen || !playlist) return
        setName(playlist.name || '')
        setDescription(playlist.description || '')
        setGenomes(Array.isArray(playlist.genomes) ? playlist.genomes : [])
    }, [isOpen, playlist])

    if (!isOpen || !playlist) return null

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div>
                        <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Edit playlist</h3>
                        <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{genomes.length} genome{genomes.length === 1 ? '' : 's'}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`p-2 rounded-lg transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <div className="grid grid-cols-1 gap-3">
                        <input
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Playlist name"
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${isLight
                                ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                }`}
                        />
                        <textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="Description (optional)"
                            rows={3}
                            className={`w-full px-3 py-2 rounded-lg text-sm border resize-none ${isLight
                                ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                }`}
                        />
                    </div>

                    <div>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Playlist genomes</div>
                        <div className={`rounded-xl border max-h-64 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                            {genomes.length === 0 ? (
                                <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>This playlist is empty.</div>
                            ) : genomes.map((genome) => {
                                const isMissing = !availableAssembliesByKey.has(genome.key)
                                const isActiveByDefault = Boolean(genome.active_by_default)
                                return (
                                    <div
                                        key={genome.key}
                                        className={`px-4 py-3 border-b last:border-b-0 flex items-center justify-between gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                                    >
                                        <div className="min-w-0">
                                            <div className={`text-sm font-semibold truncate ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>{formatPlaylistGenomeLabel(genome)}</div>
                                            <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {genome.key}
                                                {isMissing ? ' • Missing locally' : ''}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            <button
                                                type="button"
                                                aria-pressed={isActiveByDefault}
                                                title="Active by default when this playlist is selected"
                                                onClick={() => setGenomes((prev) => prev.map((member) => (
                                                    genomeKeysMatch(member, genome)
                                                        ? { ...member, active_by_default: !Boolean(member.active_by_default) }
                                                        : member
                                                )))}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isActiveByDefault
                                                    ? (isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500')
                                                    : (isLight ? 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50' : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700')
                                                    }`}
                                            >
                                                Active
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGenomes((prev) => prev.filter((member) => !genomeKeysMatch(member, genome)))}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${isLight
                                                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                                                    : 'bg-red-900/30 text-red-300 hover:bg-red-900/50'
                                                    }`}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>

                <div className={`px-5 py-4 border-t flex items-center justify-end gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold border ${isLight
                            ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                            : 'bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700'
                            }`}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const didSave = onSave({
                                ...playlist,
                                name,
                                description,
                                genomes,
                            })
                            if (didSave !== false) onClose()
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold ${isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}

function ManualPathRow({ label, value, onBrowse, placeholder, isLight, onValidate, validating, hint }) {
    return (
        <div>
            <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                {label}
            </label>
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={value || ''}
                    readOnly
                    placeholder={placeholder}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${isLight
                        ? 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                        : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                        }`}
                />
                {onValidate ? (
                    <button
                        type="button"
                        onClick={onValidate}
                        disabled={!value || validating}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                            : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 border border-blue-700/40 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                            }`}
                    >
                        {validating ? 'Analysing…' : 'Analyse'}
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={onBrowse}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
                        : 'bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-500'
                        }`}
                >
                    Browse
                </button>
            </div>
            {hint ? (
                <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{hint}</p>
            ) : null}
        </div>
    )
}

function CustomAnnotationModal({
    isOpen,
    theme,
    item,
    label,
    path,
    importing,
    validation,
    idMode,
    idPrefix,
    onLabelChange,
    onPathChange,
    onBrowse,
    onCancel,
    onImport,
    onValidate,
    onCloseValidation,
    onIdModeChange,
    onIdPrefixChange,
}) {
    if (!isOpen || !item) return null
    const isLight = theme === 'light'
    const panelClass = isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-800 border-gray-700 text-gray-100'
    const inputClass = isLight
        ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400 focus:border-[#0099ff] focus:ring-[#0099ff]/30'
        : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-blue-500/30'
    const secondaryBtn = isLight
        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
        : 'bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-500'

    const trimmedPath = String(path || '').trim()
    const lowerPath = trimmedPath.toLowerCase()
    // GTF cannot be indexed directly, so conversion is not optional for it.
    const requiresConversion = CONVERSION_REQUIRED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))
    const report = validation?.status === 'success' ? validation.report : null
    const generationRecommended = Boolean(report?.identifiers?.generation_recommended)
    const validating = validation?.status === 'queued' || validation?.status === 'running'
    const prefixValid = idMode !== 'generate' || /^[A-Za-z][A-Za-z0-9]{2,9}$/.test(String(idPrefix || '').trim())

    const canImport = Boolean(trimmedPath)
        && Boolean(String(label || '').trim())
        && prefixValid
        && !importing

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl ${panelClass}`}>
                <div className={`px-5 py-4 border-b flex items-start justify-between gap-4 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div className="min-w-0">
                        <h3 className="text-lg font-bold">Add custom annotation</h3>
                        <div className={`text-xs mt-1 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {item.scientific_name || item.species_key} - {item.assembly_name || item.assembly}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        className={`p-1 rounded transition-colors ${isLight ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-100' : 'text-gray-500 hover:text-gray-200 hover:bg-gray-700'}`}
                        aria-label="Close custom annotation dialog"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="p-5 space-y-4">
                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Dataset label
                        </label>
                        <input
                            type="text"
                            value={label || ''}
                            onChange={(event) => onLabelChange(event.target.value)}
                            placeholder={defaultCustomAnnotationLabel()}
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${inputClass}`}
                        />
                    </div>
                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Annotation file
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={path || ''}
                                onChange={(event) => onPathChange(event.target.value)}
                                placeholder="/path/to/annotation.gff3.gz"
                                className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${inputClass}`}
                            />
                            <button
                                type="button"
                                onClick={onBrowse}
                                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${secondaryBtn}`}
                            >
                                Browse
                            </button>
                            <button
                                type="button"
                                onClick={onValidate}
                                disabled={!trimmedPath || validating}
                                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                                    ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                                    : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 border border-blue-700/40 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                                    }`}
                            >
                                {validating ? 'Analysing…' : 'Analyse'}
                            </button>
                        </div>
                        <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            GFF3, GFF or GTF. Output from StringTie, Scallop, BRAKER, AUGUSTUS,
                            Tiberius, Helixer, egapx and similar tools is converted into Ensembl-style
                            GFF3 on import.
                        </p>
                    </div>

                    {requiresConversion ? (
                        <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                            ? 'bg-blue-50 text-blue-800 border border-blue-200'
                            : 'bg-blue-900/20 text-blue-300 border border-blue-800/40'
                            }`}>
                            GTF cannot be indexed directly, so this file will be converted into
                            canonical GFF3. The original is kept alongside it.
                        </div>
                    ) : null}

                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Identifiers
                        </label>
                        <div className="space-y-1.5">
                            <label className={`flex items-start gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="radio"
                                    name="custom-annotation-id-mode"
                                    checked={idMode !== 'generate'}
                                    onChange={() => onIdModeChange('keep')}
                                    className="mt-0.5"
                                />
                                <span>
                                    Use the identifiers in the file
                                    {generationRecommended ? (
                                        <span className={isLight ? ' text-amber-700' : ' text-amber-400'}>
                                            {' '}— not possible for this file
                                        </span>
                                    ) : null}
                                </span>
                            </label>
                            <label className={`flex items-start gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="radio"
                                    name="custom-annotation-id-mode"
                                    checked={idMode === 'generate'}
                                    onChange={() => onIdModeChange('generate')}
                                    className="mt-0.5"
                                />
                                <span>Generate Ensembl-style identifiers</span>
                            </label>
                            {idMode === 'generate' ? (
                                <div className="pl-6 space-y-1">
                                    <input
                                        type="text"
                                        value={idPrefix || ''}
                                        onChange={(event) => onIdPrefixChange(event.target.value.toUpperCase())}
                                        placeholder="ENSXYZ"
                                        className={`w-40 px-3 py-1.5 rounded-lg text-xs border font-mono ${inputClass}`}
                                    />
                                    <p className={`text-xs ${prefixValid
                                        ? (isLight ? 'text-gray-500' : 'text-gray-400')
                                        : (isLight ? 'text-red-600' : 'text-red-400')
                                        }`}>
                                        {prefixValid
                                            ? `Produces ${(idPrefix || 'ENSXYZ')}G00000000001, ${(idPrefix || 'ENSXYZ')}T00000000001, …`
                                            : '3-10 characters, starting with a letter (letters and digits only).'}
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {validation ? (
                        <div className="max-h-96 overflow-y-auto">
                            <ValidationReportPanel
                                kind="annotation"
                                theme={theme}
                                status={validation.status}
                                progress={validation.progress}
                                stage={validation.stage}
                                message={validation.message}
                                counters={validation.counters}
                                report={validation.report}
                                error={validation.error}
                                analysedAt={validation.analysed_at}
                                onClose={onCloseValidation}
                            />
                        </div>
                    ) : null}
                </div>
                <div className={`px-5 py-4 border-t flex justify-end gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/30'}`}>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={importing}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${secondaryBtn}`}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onImport}
                        disabled={!canImport}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${isLight
                            ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                            : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                            }`}
                    >
                        {importing ? 'Importing...' : 'Import'}
                    </button>
                </div>
            </div>
        </div>
    )
}

// The locally installed genomes as of the last time this view was open. It is
// unmounted on every view switch, so without this the list is rebuilt from
// scratch each visit and the page sits empty until the scan answers — which is
// exactly when the user is least able to wait, because whatever made the
// backend slow is the thing they came here to check on.
let lastScannedAssemblies = null
let lastScannedOutputDir = ''

export default function GenomeSelectorView({
    config,
    onConfigChange,
    onToggleSpecies,
    onApplyPlaylist = null,
    selectedSpeciesList = null,
    theme,
    screenshotMode = false,
    onScreenshotModeChange = null,
    onScreenshotAvailabilityChange = null,
    screenshotToggleButtonRef = null,
}) {
    const isLight = theme === 'light'
    const screenshotRootRef = useRef(null)
    const [screenshotRootNode, setScreenshotRootNode] = useState(null)
    const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)
    const setScreenshotRoot = useCallback((node) => {
        screenshotRootRef.current = node
        setScreenshotRootNode(node)
    }, [])

    const [assemblies, setAssemblies] = useState(() => lastScannedAssemblies || [])
    const [loading, setLoading] = useState(false)
    const assembliesLoadedRef = useRef(!!lastScannedAssemblies)
    const assembliesOutputDirRef = useRef(lastScannedOutputDir)
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(1)
    const [expandedRows, setExpandedRows] = useState(new Set())
    const [fileBrowserEditTarget, setFileBrowserEditTarget] = useState(null) // { genomeKey, fileType, item }
    const [confirmDeleteFile, setConfirmDeleteFile] = useState(null) // { path, fileType, item }
    const [statusMessage, setStatusMessage] = useState(null)
    const [indexingSet, setIndexingSet] = useState(new Set())
    const [indexTaskStatusByKey, setIndexTaskStatusByKey] = useState({})
    const [pendingSelectionKeys, setPendingSelectionKeys] = useState(new Set())
    const indexBuildPromiseRef = useRef(new Map())
    const selectionDelayTimersRef = useRef(new Map())
    const tableScrollRef = useRef(null)
    const pendingScrollTopRef = useRef(null)
    // Removal mode keeps its own flags: the Active ticks say what the app is
    // working with, and mixing the two would make a mis-click destructive.
    const [removalMode, setRemovalMode] = useState(false)
    const [removalKeys, setRemovalKeys] = useState(() => new Set())
    const [removalFillMode, setRemovalFillMode] = useState(null)
    const [removalDialog, setRemovalDialog] = useState(null)   // { targets, origin }
    const [removalPreview, setRemovalPreview] = useState({ status: 'idle' })
    const [removalRun, setRemovalRun] = useState(null)
    const [playlistMembershipTarget, setPlaylistMembershipTarget] = useState(null)
    const [editingPlaylistId, setEditingPlaylistId] = useState('')
    const [playlistsCollapsed, setPlaylistsCollapsed] = useState(true)
    const [selectorPlaylistId, setSelectorPlaylistId] = useState(PLAYLIST_ALL_ID)
    const [downloadingMissingKeys, setDownloadingMissingKeys] = useState(new Set())

    // Expanded by default: the add form and the JSON controls are the panel's
    // whole point, and hiding them behind a chevron made them hard to find.
    const [manualOpen, setManualOpen] = useState(true)
    const [manualBrowseDirectory, setManualBrowseDirectory] = useState('')
    const [manualSpeciesLabel, setManualSpeciesLabel] = useState('')
    const [manualAssemblyLabel, setManualAssemblyLabel] = useState('')
    const [manualGca, setManualGca] = useState('')
    const [manualFasta, setManualFasta] = useState('')
    const [manualGff3, setManualGff3] = useState('')
    const [manualHomology, setManualHomology] = useState('')
    const [manualIndexPath, setManualIndexPath] = useState('')
    const [selectLoadedManualGenomes, setSelectLoadedManualGenomes] = useState(true)
    // Reviewing before importing is opt-in — the common case is "just load it".
    const [reviewBeforeImport, setReviewBeforeImport] = useState(false)
    const [bundlePreview, setBundlePreview] = useState(null)
    const [bundleExportPath, setBundleExportPath] = useState('')
    const [bundleExportConflict, setBundleExportConflict] = useState(null)
    // Once the user edits or browses, stop replacing the path with the default.
    const bundleExportPathTouchedRef = useRef(false)
    const [manualOperation, setManualOperation] = useState({
        status: 'idle',
        kind: '',
        progress: 0,
        stage: '',
        message: '',
        counters: {},
        summary: null,
    })
    const manualSuccessTimerRef = useRef(null)
    const [customAnnotationTarget, setCustomAnnotationTarget] = useState(null)
    const [customAnnotationLabel, setCustomAnnotationLabel] = useState(defaultCustomAnnotationLabel())
    const [customAnnotationPath, setCustomAnnotationPath] = useState('')
    const [importingCustomAnnotation, setImportingCustomAnnotation] = useState(false)
    const [customAnnotationIdMode, setCustomAnnotationIdMode] = useState('keep')
    const [customAnnotationIdPrefix, setCustomAnnotationIdPrefix] = useState('')

    // Validation reports are keyed by slot ('genome' | 'annotation') so the
    // manual panel and the custom-annotation dialog can each show their own.
    const [validation, setValidation] = useState({})

    const [modalOpen, setModalOpen] = useState(false)
    const [modalMode, setModalMode] = useState('file')
    const [modalTarget, setModalTarget] = useState('')

    const showStatus = (msg, isError = false) => {
        setStatusMessage({ text: msg, isError })
        setTimeout(() => setStatusMessage(null), 3500)
    }

    const runValidation = useCallback(async (slot, kind, body) => {
        const targetContext = {
            path: String(body?.fasta_path || body?.annotation_path || '').trim(),
            fasta_path: kind === 'annotation' ? String(body?.fasta_path || '').trim() : '',
        }
        setValidation((prev) => ({
            ...prev,
            [slot]: {
                kind,
                status: 'queued',
                progress: 0,
                stage: 'queued',
                message: 'Queued for analysis',
                counters: {},
                report: null,
                error: null,
                ...targetContext,
            },
        }))
        try {
            // Shared with the stats overview, so both views produce the same
            // report and store it under the same key. Progress is reported on
            // every poll; large assemblies take a while.
            return await runGenomeAnalysis({
                kind,
                body,
                onUpdate: (payload) => {
                    setValidation((prev) => ({
                        ...prev,
                        [slot]: {
                            kind,
                            status: payload.status,
                            progress: payload.progress,
                            stage: payload.stage,
                            message: payload.message,
                            counters: payload.counters || {},
                            report: payload.report,
                            error: payload.error,
                            analysed_at: payload.completed_at || '',
                            ...targetContext,
                        },
                    }))
                },
            })
        } catch (error) {
            setValidation((prev) => ({
                ...prev,
                [slot]: {
                    kind,
                    status: 'failed',
                    progress: 0,
                    report: null,
                    error: error?.message || 'Analysis failed',
                    ...targetContext,
                },
            }))
            return null
        }
    }, [])

    // Converts an annotation into canonical GFF3 when the indexer cannot read it
    // as-is, and returns the path that should actually be indexed.
    const prepareAnnotation = useCallback(async (annotationPath, fastaPath, onProgress = null) => {
        const res = await fetch(`${API_BASE}/api/custom/prepare-annotation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                annotation_path: annotationPath,
                fasta_path: fastaPath || null,
            }),
        })
        const started = await res.json()
        if (!res.ok) throw new Error(started?.detail || 'Failed to prepare the annotation')

        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 300))
            const poll = await fetch(`${API_BASE}/api/custom/conversion/${started.task_id}`)
            const payload = await poll.json()
            if (!poll.ok) throw new Error(payload?.detail || 'Preparation lookup failed')
            onProgress?.({
                status: payload.status,
                progress: Number(payload.progress || 0),
                stage: payload.stage || '',
                message: payload.message || '',
                counters: payload.counters || {},
            })
            if (payload.status === 'failed') {
                throw new Error(payload.error || 'Failed to prepare the annotation')
            }
            if (payload.status === 'success') return payload.report || {}
        }
    }, [])

    const resetManualForm = useCallback(() => {
        setManualSpeciesLabel('')
        setManualAssemblyLabel('')
        setManualGca('')
        setManualFasta('')
        setManualGff3('')
        setManualHomology('')
        setManualIndexPath('')
        setManualBrowseDirectory('')
        setValidation((prev) => {
            const next = { ...prev }
            delete next.genome
            delete next.annotation
            return next
        })
    }, [])

    useEffect(() => () => {
        if (manualSuccessTimerRef.current) {
            window.clearTimeout(manualSuccessTimerRef.current)
        }
    }, [])

    const closeValidation = useCallback((slot) => {
        setValidation((prev) => {
            const next = { ...prev }
            delete next[slot]
            return next
        })
    }, [])

    // When an audit finds identifiers that cannot be carried over, preselect
    // generation so the user is not left to discover the block at import time.
    const customAnnotationValidation = validation.customAnnotation
    useEffect(() => {
        if (customAnnotationValidation?.status !== 'success') return
        if (customAnnotationValidation.report?.identifiers?.generation_recommended) {
            setCustomAnnotationIdMode('generate')
        }
    }, [customAnnotationValidation])

    const fetchAssemblies = useCallback(async () => {
        const outputDir = String(config.output_dir || '').trim()
        if (assembliesOutputDirRef.current !== outputDir) {
            assembliesOutputDirRef.current = outputDir
            assembliesLoadedRef.current = false
            lastScannedAssemblies = null
            setAssemblies([])
        }
        if (!outputDir) {
            lastScannedAssemblies = null
            setAssemblies([])
            setLoading(false)
            assembliesLoadedRef.current = true
            return
        }
        const showInitialLoading = !assembliesLoadedRef.current
        if (showInitialLoading) setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`)
	            if (res.ok) {
                const data = await res.json()
                const pendingIds = readPendingSelectorGenomeIds()
                const assemblies = (Array.isArray(data) ? data : []).map((item) => {
                    const normalized = normalizeGenomeRecord(item)
                    const datasetInstances = (Array.isArray(item?.dataset_instances) ? item.dataset_instances : [])
                        .map((instance) => normalizeGenomeRecord(instance))
                    return { ...normalized, dataset_instances: datasetInstances }
                })
                const visible = assemblies.filter((item) => !pendingIds.has(itemKey(item)) && !pendingIds.has(item.assembly_key))
                lastScannedAssemblies = visible
                lastScannedOutputDir = outputDir
                setAssemblies(visible)
	            }
	            else {
	                console.warn('Failed to refresh local assemblies:', res.statusText)
	            }
	        } catch (error) {
	            console.warn('Failed to refresh local assemblies:', error)
	        } finally {
                assembliesLoadedRef.current = true
                if (showInitialLoading) setLoading(false)
	        }
    }, [config.output_dir])

    const generateIndex = useCallback(async (item, gff3Path, onComplete) => {
        const key = itemKey(item)
        setIndexingSet((prev) => new Set([...prev, key]))
        setIndexTaskStatusByKey((prev) => ({ ...prev, [key]: 'queued' }))
        showStatus(`Queued index for ${item.scientific_name || item.assembly}...`)
        try {
            const indexPathHint = item?.files?.index || ''
            const outputDirHint = indexPathHint
                ? dirnameFromPath(indexPathHint)
                : (item?.is_manual ? (dirnameFromPath(gff3Path) || manualBrowseDirectory || config.working_dir || config.output_dir) : config.output_dir)

            const res = await fetch(`${API_BASE}/api/index/generate-for-genome`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gff_path: gff3Path,
                    output_dir: outputDirHint,
                    index_path: indexPathHint || undefined,
                }),
            })
            if (!res.ok) {
                const err = await res.json()
                showStatus(`Index generation failed: ${err.detail || 'Unknown error'}`, true)
                return null
            }
            const { task_id, status } = await res.json()
            if (status) {
                setIndexTaskStatusByKey((prev) => ({ ...prev, [key]: status }))
            }
            if (!task_id) {
                showStatus('Index generation failed: no task id returned.', true)
                return null
            }

            // Poll until the background build finishes
            const indexPath = await new Promise((resolve) => {
                let consecutivePollFailures = 0
                const maxPollFailures = 5
                const poll = async () => {
                    try {
                        const statusRes = await fetch(`${API_BASE}/api/index/task-status/${task_id}`)
                        if (statusRes.ok) {
                            consecutivePollFailures = 0
                            const statusData = await statusRes.json()
                            if (statusData.status === 'queued' || statusData.status === 'running') {
                                setIndexTaskStatusByKey((prev) => ({ ...prev, [key]: statusData.status }))
                            }
                            if (statusData.status === 'success') {
                                resolve(statusData.index_path)
                                return
                            }
                            if (statusData.status === 'failed') {
                                showStatus(`Index generation failed: ${statusData.error || 'Unknown error'}`, true)
                                resolve(null)
                                return
                            }
                        } else {
                            consecutivePollFailures += 1
                        }
                    } catch (error) {
                        consecutivePollFailures += 1
                        console.warn('Index generation status poll failed:', error)
                    }
                    if (consecutivePollFailures >= maxPollFailures) {
                        showStatus('Index generation status is unavailable. You can retry indexing later.', true)
                        resolve(null)
                        return
                    }
                    setTimeout(poll, 3000)
                }
                poll()
            })

            if (indexPath) {
                showStatus('Index generated successfully!')
                if (onComplete) onComplete(indexPath)
                // Refresh in the background. The task badge is cleared by the
                // surrounding finally block immediately, rather than waiting
                // for a full filesystem rescan to finish.
                fetchAssemblies()
            }
            return indexPath
        } catch (e) {
            showStatus(`Index generation error: ${e.message}`, true)
            return null
	        } finally {
	            setIndexingSet((prev) => {
	                const s = new Set(prev)
	                s.delete(key)
	                return s
	            })
	            setIndexTaskStatusByKey((prev) => {
	                const next = { ...prev }
	                delete next[key]
	                return next
	            })
	        }
    }, [config.output_dir, config.working_dir, fetchAssemblies, manualBrowseDirectory])

    useEffect(() => {
        fetchAssemblies()
    }, [fetchAssemblies])

    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handleRefresh = () => {
            fetchAssemblies()
        }
        window.addEventListener(SELECTOR_REFRESH_EVENT, handleRefresh)
        return () => window.removeEventListener(SELECTOR_REFRESH_EVENT, handleRefresh)
    }, [fetchAssemblies])

    useEffect(() => {
        return () => {
            for (const timer of selectionDelayTimersRef.current.values()) {
                window.clearTimeout(timer)
            }
            selectionDelayTimersRef.current.clear()
        }
    }, [])

    const fileExistsAtPath = useCallback(async (path) => {
        if (!path) return false
        try {
            const dir = dirnameFromPath(path)
            const name = basenameFromPath(path)
            const res = await fetch(`${API_BASE}/api/files/list?path=${encodeURIComponent(dir)}`)
            if (!res.ok) return false
            const data = await res.json()
            return (data.items || []).some((item) => !item.is_dir && item.name === name)
        } catch {
            return false
        }
    }, [])

    const persistBuiltIndex = useCallback((item, indexPath) => {
        if (!item?.files?.gff3 || !indexPath) return
        const key = itemKey(item)
        onConfigChange((prev) => {
            let changed = false
            const applyIndex = (items) => (items || []).map((s) => {
                if (itemKey(s) !== key) return s
                if ((s.files?.index || '') === indexPath) return s
                changed = true
                return { ...s, files: { ...s.files, index: indexPath } }
            })

            const updated = {
                ...prev,
                active_species: applyIndex(prev.active_species),
                manual_species: applyIndex(prev.manual_species),
            }

            if (updated.ref_gff === item.files.gff3 && updated.ref_index !== indexPath) {
                updated.ref_index = indexPath
                changed = true
            }
            if (updated.target_gff === item.files.gff3 && updated.target_index !== indexPath) {
                updated.target_index = indexPath
                changed = true
            }

            return changed ? updated : prev
        })
    }, [onConfigChange])

    const ensureIndexForGenome = useCallback((item) => {
        if (!item?.files?.gff3) return Promise.resolve(null)
        const key = itemKey(item)

        const existingPromise = indexBuildPromiseRef.current.get(key)
        if (existingPromise) return existingPromise

        const promise = (async () => {
            const currentIndex = item?.files?.index || ''
            if (currentIndex) {
                const exists = await fileExistsAtPath(currentIndex)
                if (exists) {
                    if ((config?.ref_gff === item.files.gff3 && config?.ref_index !== currentIndex) ||
                        (config?.target_gff === item.files.gff3 && config?.target_index !== currentIndex)) {
                        persistBuiltIndex(item, currentIndex)
                    }
                    return currentIndex
                }
            }

            const suggestedIndex = currentIndex || deriveIndexPathFromGff(item.files.gff3, dirnameFromPath(item.files.gff3))
            const buildItem = { ...item, files: { ...item.files, index: suggestedIndex } }
            const built = await generateIndex(buildItem, item.files.gff3, (indexPath) => persistBuiltIndex(item, indexPath))
            if (built) {
                persistBuiltIndex(item, built)
            }
            return built
        })()

        indexBuildPromiseRef.current.set(key, promise)
        promise.finally(() => {
            indexBuildPromiseRef.current.delete(key)
        })
        return promise
    }, [config?.ref_gff, config?.ref_index, config?.target_gff, config?.target_index, fileExistsAtPath, generateIndex, persistBuiltIndex])

    const rebuildIndexForGenome = useCallback((item) => {
        if (!item?.files?.gff3) return Promise.resolve(null)
        const key = itemKey(item)

        const existingPromise = indexBuildPromiseRef.current.get(key)
        if (existingPromise) return existingPromise

        const promise = (async () => {
            const currentIndex = item?.files?.index || ''
            const suggestedIndex = currentIndex || deriveIndexPathFromGff(item.files.gff3, dirnameFromPath(item.files.gff3))
            const buildItem = { ...item, files: { ...item.files, index: suggestedIndex } }
            const built = await generateIndex(buildItem, item.files.gff3, (indexPath) => persistBuiltIndex(item, indexPath))
            if (built) {
                persistBuiltIndex(item, built)
            }
            return built
        })()

        indexBuildPromiseRef.current.set(key, promise)
        promise.finally(() => {
            indexBuildPromiseRef.current.delete(key)
        })
        return promise
    }, [generateIndex, persistBuiltIndex])

    const buildIndexesForGenomeDatasets = useCallback(async (items, { force = false } = {}) => {
        const targets = (Array.isArray(items) ? items : [])
            .filter((entry) => entry?.files?.gff3)
        if (targets.length === 0) return []
        return Promise.all(targets.map((entry) => (
            force ? rebuildIndexForGenome(entry) : ensureIndexForGenome(entry)
        )))
    }, [ensureIndexForGenome, rebuildIndexForGenome])

    // Merge filesystem-discovered files with any user overrides stored in config
    const getEffectiveFiles = useCallback((item) => {
        const overrides = config.genome_file_overrides?.[itemKey(item)] || {}
        return { ...(item.files || {}), ...overrides }
    }, [config.genome_file_overrides])

    const analysisSlotForFile = useCallback((item, fileType) => (
        `genome-file:${itemKey(item)}:${fileType}`
    ), [])

    const getFileAnalysisByType = useCallback((item, files) => {
        const key = itemKey(item)
        const result = {}
        for (const fileType of ['fasta', 'gff3']) {
            const live = validation[analysisSlotForFile(item, fileType)]
            const liveMatches = live
                && String(live.path || '').trim() === String(files?.[fileType] || '').trim()
                && (
                    fileType !== 'gff3'
                    || String(live.fasta_path || '').trim() === String(files?.fasta || '').trim()
                )
            if (liveMatches) {
                result[fileType] = live
                continue
            }
            const cached = getCurrentGenomeAnalysis(
                config.genome_analysis_reports,
                key,
                fileType,
                files,
            )
            if (cached) {
                result[fileType] = {
                    ...cached,
                    status: 'success',
                    progress: 100,
                    error: null,
                }
            }
        }
        return result
    }, [analysisSlotForFile, config.genome_analysis_reports, validation])

    const analyseGenomeFile = useCallback(async (item, fileType, files) => {
        const kind = genomeAnalysisKind(fileType)
        const path = String(files?.[fileType] || '').trim()
        if (!kind || !path) return
        const body = kind === 'genome'
            ? { fasta_path: path }
            : {
                annotation_path: path,
                fasta_path: String(files?.fasta || '').trim() || null,
            }
        const result = await runValidation(analysisSlotForFile(item, fileType), kind, body)
        if (result?.status !== 'success' || !result.report) return
        onConfigChange((prev) => ({
            ...prev,
            genome_analysis_reports: withGenomeAnalysis(
                prev.genome_analysis_reports,
                itemKey(item),
                fileType,
                files,
                result.report,
                result.completed_at || new Date().toISOString(),
            ),
        }))
    }, [analysisSlotForFile, onConfigChange, runValidation])

    // Persist a file path override into config (or clear it when path is empty)
    const saveFileOverride = useCallback((item, fileType, newPath) => {
        const key = itemKey(item)
        const trimmed = (newPath || '').trim()
        onConfigChange((prev) => {
            const prevOverrides = prev.genome_file_overrides || {}
            const prevEntry = prevOverrides[key] || {}
            const nextEntry = { ...prevEntry, [fileType]: trimmed || undefined }
            if (!trimmed) delete nextEntry[fileType]
            const nextOverrides = { ...prevOverrides, [key]: nextEntry }
            if (Object.keys(nextEntry).length === 0) delete nextOverrides[key]
            let nextAnalyses = prev.genome_analysis_reports || {}
            if (fileType === 'fasta') {
                nextAnalyses = withoutGenomeAnalysis(nextAnalyses, key, 'fasta')
                nextAnalyses = withoutGenomeAnalysis(nextAnalyses, key, 'gff3')
            } else if (fileType === 'gff3') {
                nextAnalyses = withoutGenomeAnalysis(nextAnalyses, key, 'gff3')
            }
            return {
                ...prev,
                genome_file_overrides: nextOverrides,
                genome_analysis_reports: nextAnalyses,
            }
        })
        if (fileType === 'fasta') {
            closeValidation(analysisSlotForFile(item, 'fasta'))
            closeValidation(analysisSlotForFile(item, 'gff3'))
        } else if (fileType === 'gff3') {
            closeValidation(analysisSlotForFile(item, 'gff3'))
        }
        // gff3 change: clear stale index override then trigger a fresh rebuild
        if (fileType === 'gff3') {
            onConfigChange((prev) => {
                const prevOverrides = prev.genome_file_overrides || {}
                const prevEntry = prevOverrides[key] || {}
                const nextEntry = { ...prevEntry, index: undefined }
                if (trimmed) nextEntry.gff3 = trimmed
                else delete nextEntry.gff3
                delete nextEntry.index
                const nextOverrides = { ...prevOverrides, [key]: nextEntry }
                if (Object.keys(nextEntry).length === 0) delete nextOverrides[key]
                return { ...prev, genome_file_overrides: nextOverrides }
            })
            if (trimmed) {
                const updatedItem = { ...item, files: { ...(item.files || {}), gff3: trimmed, index: '' } }
                ensureIndexForGenome(updatedItem)
            }
        }
        // index change: mirror into ref_index / target_index as persistBuiltIndex does
        if (fileType === 'index' && trimmed) {
            const currentFiles = { ...(item.files || {}), ...((config.genome_file_overrides?.[key]) || {}) }
            persistBuiltIndex({ ...item, files: currentFiles }, trimmed)
        }
    }, [analysisSlotForFile, closeValidation, config.genome_file_overrides, onConfigChange, persistBuiltIndex, ensureIndexForGenome])

    // Delete a single file on disk then clear any config override for that type
    const handleDeleteSingleFile = useCallback(async ({ path, fileType, item }) => {
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-file`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: path,
                    output_dir: config.output_dir || '',
                    species_key: item?.species_key || '',
                    assembly: getAssemblyAccession(item),
                    provider: normalizeGenomeProvider(item),
                }),
            })
            if (res.ok) {
                saveFileOverride(item, fileType, '')
                showStatus(`Deleted ${fileType.toUpperCase()} file`)
                fetchAssemblies()
            } else {
                showStatus('Failed to delete file', true)
            }
        } catch (e) {
            showStatus(`Error: ${e.message}`, true)
        }
        setConfirmDeleteFile(null)
    }, [config.output_dir, saveFileOverride, fetchAssemblies])

    const manualAssemblies = useMemo(
        () => (config.manual_species || []).map((item) => normalizeGenomeRecord({ ...item, is_manual: true })),
        [config.manual_species]
    )

    const allAssemblies = useMemo(() => {
        const byKey = new Map()
        const deregisteredKeys = Array.isArray(config.deregistered_genome_keys)
            ? config.deregistered_genome_keys
            : []
        const isDeregistered = (item) => deregisteredKeys.some((key) => genomeKeysMatch(item, key))
        for (const item of assemblies || []) {
            if (!isDeregistered(item)) byKey.set(itemKey(item), normalizeGenomeRecord(item))
        }
        for (const item of manualAssemblies) {
            if (isDeregistered(item)) continue
            const key = itemKey(item)
            if (!byKey.has(key)) byKey.set(key, item)
        }
        return Array.from(byKey.values())
    }, [assemblies, config.deregistered_genome_keys, manualAssemblies])
	    const allAssembliesByKey = useMemo(
	        () => {
	            const map = new Map()
	            for (const item of allAssemblies) {
	                for (const key of genomeKeyCandidates(item)) {
	                    if (!map.has(key)) map.set(key, item)
	                }
                    for (const rawInstance of Array.isArray(item?.dataset_instances) ? item.dataset_instances : []) {
                        const instance = normalizeGenomeRecord(rawInstance)
                        for (const key of genomeKeyCandidates(instance)) {
                            if (!map.has(key)) map.set(key, instance)
                        }
                    }
	            }
	            return map
	        },
        [allAssemblies]
    )
    const genomePlaylists = useMemo(
        () => normalizeGenomePlaylists(config?.genome_playlists || []),
        [config?.genome_playlists]
    )
    const selectedPlaylistIdRaw = String(selectorPlaylistId || PLAYLIST_ALL_ID).trim() || PLAYLIST_ALL_ID
    const selectedPlaylistId = selectedPlaylistIdRaw === PLAYLIST_ALL_ID || genomePlaylists.some((playlist) => playlist.id === selectedPlaylistIdRaw)
        ? selectedPlaylistIdRaw
        : PLAYLIST_ALL_ID
    const selectedPlaylist = useMemo(
        () => genomePlaylists.find((playlist) => playlist.id === selectedPlaylistId) || null,
        [genomePlaylists, selectedPlaylistId]
    )

    const persistPlaylistState = useCallback(async (nextConfig) => {
        if (!nextConfig) return
        try {
            await fetch(`${API_BASE}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...nextConfig,
                    clear_genome_playlists: (nextConfig.genome_playlists || []).length === 0,
                }),
            })
        } catch (error) {
            console.error('Failed to persist genome playlists:', error)
        }
    }, [])
    const resolveLocalPlaylistGenome = useCallback((genome) => {
        for (const key of genomeKeyCandidates(genome)) {
            const liveItem = allAssembliesByKey.get(key)
            if (liveItem) return liveItem
        }
        return null
    }, [allAssembliesByKey])
    const playlistRows = useMemo(() => {
        return genomePlaylists.map((playlist) => {
            const missingGenomes = playlist.genomes.filter((genome) => !resolveLocalPlaylistGenome(genome))
            const downloadableMissingCount = missingGenomes.filter(canDownloadPlaylistGenome).length
            return {
                ...playlist,
                genomeCount: playlist.genomes.length,
                missingCount: missingGenomes.length,
                downloadableMissingCount,
            }
        })
    }, [genomePlaylists, resolveLocalPlaylistGenome])
    const visibleAssembliesBase = useMemo(() => {
        if (selectedPlaylistId === PLAYLIST_ALL_ID) return allAssemblies
        if (!selectedPlaylist) return []
        return selectedPlaylist.genomes.map((genome) => {
            const liveItem = resolveLocalPlaylistGenome(genome)
            if (liveItem) {
                return { ...liveItem, is_missing: false }
            }
            return {
                ...genome,
                assembly: genome.assembly || genome.assembly_name || genome.gca || '',
                assembly_name: genome.assembly_name || genome.assembly || '',
                scientific_name: genome.scientific_name || formatSpeciesNameFromKey(genome.species_key || ''),
                common_name: genome.common_name || '',
                display_name: genome.display_name || '',
                display_name_reason: genome.display_name_reason || '',
                gca: genome.gca || '',
                key: genome.key,
                provider: normalizeGenomeProvider(genome),
                source_database: genome.source_database || normalizeGenomeSourceDatabase(genome),
                is_missing: true,
                files: {},
                types: [],
            }
        })
    }, [selectedPlaylistId, selectedPlaylist, allAssemblies, resolveLocalPlaylistGenome])
    const selectedPlaylistMissingGenomes = useMemo(() => {
        if (selectedPlaylistId === PLAYLIST_ALL_ID || !selectedPlaylist) return []
        return visibleAssembliesBase.filter((item) => item?.is_missing)
    }, [selectedPlaylistId, selectedPlaylist, visibleAssembliesBase])
    const selectedPlaylistDownloadableMissingGenomes = useMemo(
        () => selectedPlaylistMissingGenomes.filter(canDownloadPlaylistGenome),
        [selectedPlaylistMissingGenomes]
    )

    useEffect(() => {
        if (downloadingMissingKeys.size === 0) return
        setDownloadingMissingKeys((prev) => {
            const next = new Set()
            for (const key of prev) {
                if (!allAssembliesByKey.has(key)) next.add(key)
            }
            return next.size === prev.size ? prev : next
        })
    }, [allAssembliesByKey, downloadingMissingKeys.size])
    const filtered = useMemo(() => {
        if (!search.trim()) return visibleAssembliesBase
        const q = search.toLowerCase().trim()
        return visibleAssembliesBase.filter((item) => matchesGenomeSearch(item, q))
    }, [visibleAssembliesBase, search])

    const activeSpeciesList = useMemo(() => {
        if (Array.isArray(selectedSpeciesList)) return selectedSpeciesList
        return (config.active_species || [])
    }, [selectedSpeciesList, config.active_species])
    const selectedGenomeKeys = useMemo(() => {
        return new Set(activeSpeciesList.map((item) => itemKey(item)))
    }, [activeSpeciesList])
    const selectedOrder = useMemo(() => {
        const order = new Map()
        activeSpeciesList.forEach((item, idx) => {
            order.set(itemKey(item), idx)
        })
        return order
    }, [activeSpeciesList])

    const filteredSorted = useMemo(() => {
        if (!filtered.length) return filtered
        if (selectedPlaylistId !== PLAYLIST_ALL_ID) return filtered
        return [...filtered].sort((a, b) => {
            const aSelected = selectedGenomeKeys.has(itemKey(a))
            const bSelected = selectedGenomeKeys.has(itemKey(b))
            if (aSelected !== bSelected) return aSelected ? -1 : 1
            if (aSelected && bSelected) {
                const aOrder = selectedOrder.get(itemKey(a)) ?? Number.MAX_SAFE_INTEGER
                const bOrder = selectedOrder.get(itemKey(b)) ?? Number.MAX_SAFE_INTEGER
                return aOrder - bOrder
            }
            return 0
        })
    }, [filtered, selectedGenomeKeys, selectedOrder, selectedPlaylistId])

    const totalPages = Math.ceil(filteredSorted.length / LOCAL_PAGE_SIZE)
    const pageItems = filteredSorted.slice((page - 1) * LOCAL_PAGE_SIZE, page * LOCAL_PAGE_SIZE)
    useLayoutEffect(() => {
        if (pendingScrollTopRef.current === null) return
        if (tableScrollRef.current) {
            tableScrollRef.current.scrollTop = pendingScrollTopRef.current
        }
        pendingScrollTopRef.current = null
    }, [filteredSorted, page])
    useEffect(() => {
        setPage(1)
    }, [search, selectedPlaylistId])
    // Removing genomes can shorten the list under the current page.
    useEffect(() => {
        setPage((current) => Math.min(current, Math.max(1, totalPages)))
    }, [totalPages])

    useEffect(() => {
        if (selectedPlaylistIdRaw === selectedPlaylistId) return
        setSelectorPlaylistId(selectedPlaylistId)
    }, [selectedPlaylistIdRaw, selectedPlaylistId])

    const updatePlaylistConfig = useCallback((updater) => {
        if (!onConfigChange) return false
        onConfigChange((prev) => {
            const base = prev || config
            const currentPlaylists = normalizeGenomePlaylists(base?.genome_playlists || [])
            const result = updater({
                baseConfig: base,
                playlists: currentPlaylists,
                selectedPlaylistId: String(base?.selected_genome_playlist_id || PLAYLIST_ALL_ID).trim() || PLAYLIST_ALL_ID,
            })
            if (!result) return base
            const nextConfig = {
                ...base,
                genome_playlists: result.genome_playlists ?? currentPlaylists,
                selected_genome_playlist_id: result.selected_genome_playlist_id ?? (String(base?.selected_genome_playlist_id || PLAYLIST_ALL_ID).trim() || PLAYLIST_ALL_ID),
            }
            persistPlaylistState(nextConfig)
            return nextConfig
        })
        return true
    }, [onConfigChange, config, persistPlaylistState])

    const cancelPendingSelections = useCallback(() => {
        for (const timer of selectionDelayTimersRef.current.values()) {
            window.clearTimeout(timer)
        }
        selectionDelayTimersRef.current.clear()
        setPendingSelectionKeys(new Set())
    }, [])

    const resolvePlaylistActivation = useCallback((playlist) => {
        const playlistGenomes = Array.isArray(playlist?.genomes) ? playlist.genomes : []
        const hasExplicitActiveDefaults = playlistGenomes.some((genome) => hasOwn(genome, 'active_by_default'))
        const availablePairs = []
        for (const genome of playlistGenomes) {
            const liveItem = resolveLocalPlaylistGenome(genome)
            if (!liveItem?.files?.gff3 || availablePairs.some((entry) => genomeKeysMatch(entry.liveItem, liveItem))) continue
            availablePairs.push({ genome, liveItem })
        }
        const availableSpecies = availablePairs.map((entry) => entry.liveItem)
        const activeSpecies = availablePairs
            .filter((entry) => Boolean(entry.genome?.active_by_default))
            .map((entry) => entry.liveItem)
        return {
            activeSpecies: activeSpecies.length > 0 || hasExplicitActiveDefaults ? activeSpecies : availableSpecies.slice(0, 1),
            availableSpecies,
        }
    }, [resolveLocalPlaylistGenome])

    const handleSelectPlaylist = async (playlistId) => {
        const nextId = String(playlistId || PLAYLIST_ALL_ID).trim() || PLAYLIST_ALL_ID
        if (!onConfigChange) return
        cancelPendingSelections()
        setSelectorPlaylistId(nextId)

        if (nextId === PLAYLIST_ALL_ID) {
            if (String(config?.selected_genome_playlist_id || PLAYLIST_ALL_ID).trim() !== nextId) {
                onConfigChange({ ...config, selected_genome_playlist_id: nextId })
            }
            return
        }

        const playlist = genomePlaylists.find((entry) => entry.id === nextId)
        if (!playlist) {
            setSelectorPlaylistId(PLAYLIST_ALL_ID)
            onConfigChange({ ...config, selected_genome_playlist_id: PLAYLIST_ALL_ID })
            return
        }

        const { activeSpecies: nextActive, availableSpecies } = resolvePlaylistActivation(playlist)
        const missingCount = Math.max(0, playlist.genomes.length - availableSpecies.length)

        if (onApplyPlaylist) {
            const result = await onApplyPlaylist({
                playlistId: nextId,
                playlist,
                activeSpecies: nextActive,
                selectedSpecies: availableSpecies,
            })
            if (result?.ok === false) {
                showStatus(result?.message || `Unable to activate playlist "${playlist.name}".`, true)
                return
            }
        } else {
            const first = nextActive[0] || null
            const second = nextActive[1] || null
            onConfigChange({
                ...config,
                selected_genome_playlist_id: nextId,
                active_species: nextActive,
                ref_fasta: first?.files?.fasta || '',
                ref_gff: first?.files?.gff3 || '',
                ref_index: first?.files?.index || '',
                homologies_file: first?.files?.homology || '',
                target_fasta: second?.files?.fasta || '',
                target_gff: second?.files?.gff3 || '',
                target_index: second?.files?.index || '',
            })
        }

        const activeLabel = nextActive.length === 0
            ? 'no active genomes'
            : nextActive.length === 1
                ? '1 active genome'
                : `${nextActive.length} active genomes`
        const inactiveAvailableCount = Math.max(0, availableSpecies.length - nextActive.length)
        const inactiveLabel = inactiveAvailableCount > 0
            ? `; ${inactiveAvailableCount} other available genome${inactiveAvailableCount === 1 ? '' : 's'} left inactive`
            : ''
        const missingLabel = missingCount > 0
            ? `; ${missingCount} unavailable`
            : ''
        showStatus(`Activated playlist "${playlist.name}" with ${activeLabel}${inactiveLabel}${missingLabel}.`)
    }

    const handleSaveGenomePlaylistMembership = ({ genome, selectedPlaylistIds, newPlaylistName, newPlaylistDescription }) => {
        const snapshot = snapshotGenomeForPlaylist(genome)
        if (!snapshot) {
            showStatus('Unable to add this genome to a playlist.', true)
            return false
        }

        const trimmedNewName = String(newPlaylistName || '').trim()
        const trimmedNewDescription = String(newPlaylistDescription || '').trim()
        return updatePlaylistConfig(({ playlists, selectedPlaylistId: currentSelectedPlaylistId }) => {
            const selectedIds = new Set((selectedPlaylistIds || []).map((id) => String(id || '').trim()).filter(Boolean))
            const nextPlaylists = playlists.map((playlist) => ({ ...playlist, genomes: [...playlist.genomes] }))

            if (trimmedNewName) {
                const duplicate = nextPlaylists.some((playlist) => playlist.name.toLowerCase() === trimmedNewName.toLowerCase())
                if (duplicate) {
                    showStatus(`A playlist named "${trimmedNewName}" already exists.`, true)
                    return null
                }
                const newPlaylistId = buildPlaylistId()
                nextPlaylists.push({
                    id: newPlaylistId,
                    name: trimmedNewName,
                    description: trimmedNewDescription,
                    genomes: [{ ...snapshot, active_by_default: true }],
                })
                selectedIds.add(newPlaylistId)
            }

            for (let index = 0; index < nextPlaylists.length; index += 1) {
                const playlist = nextPlaylists[index]
                const hasGenome = playlist.genomes.some((member) => genomeKeysMatch(member, snapshot.key))
                const shouldInclude = selectedIds.has(playlist.id)
                if (shouldInclude && !hasGenome) {
                    nextPlaylists[index] = {
                        ...playlist,
                        genomes: [
                            ...playlist.genomes,
                            { ...snapshot, active_by_default: playlist.genomes.length === 0 },
                        ],
                    }
                } else if (!shouldInclude && hasGenome) {
                    nextPlaylists[index] = {
                        ...playlist,
                        genomes: playlist.genomes.filter((member) => !genomeKeysMatch(member, snapshot.key)),
                    }
                }
            }

            showStatus(`Updated playlist memberships for ${genome?.scientific_name || genome?.assembly_name || genome?.assembly}.`)
            return {
                genome_playlists: nextPlaylists,
                selected_genome_playlist_id: currentSelectedPlaylistId,
            }
        })
    }

    const handleSavePlaylistEdit = (editedPlaylist) => {
        if (editedPlaylist?.system) {
            showStatus('Previous session is updated automatically and cannot be edited.', true)
            return false
        }
        const nextName = String(editedPlaylist?.name || '').trim()
        if (!nextName) {
            showStatus('Playlist name is required.', true)
            return false
        }

        return updatePlaylistConfig(({ playlists, selectedPlaylistId: currentSelectedPlaylistId }) => {
            const duplicate = playlists.some((playlist) => (
                playlist.id !== editedPlaylist.id &&
                playlist.name.toLowerCase() === nextName.toLowerCase()
            ))
            if (duplicate) {
                showStatus(`A playlist named "${nextName}" already exists.`, true)
                return null
            }

            const normalizedGenomes = []
            for (const rawGenome of Array.isArray(editedPlaylist?.genomes) ? editedPlaylist.genomes : []) {
                const genome = normalizePlaylistGenome(rawGenome)
                if (!genome?.key || normalizedGenomes.some((existing) => genomeKeysMatch(existing, genome))) continue
                normalizedGenomes.push(genome)
            }

            const nextPlaylists = playlists.map((playlist) => (
                playlist.id === editedPlaylist.id
                    ? {
                        ...playlist,
                        name: nextName,
                        description: String(editedPlaylist?.description || '').trim(),
                        genomes: normalizedGenomes,
                    }
                    : playlist
            ))

            showStatus(`Updated playlist "${nextName}".`)
            return {
                genome_playlists: nextPlaylists,
                selected_genome_playlist_id: currentSelectedPlaylistId,
            }
        })
    }

    const handleDeletePlaylist = (playlist) => {
        if (!playlist?.id) return
        if (playlist.system) {
            showStatus('Previous session is updated automatically and cannot be deleted.', true)
            return
        }
        const confirmed = window.confirm(`Delete playlist "${playlist.name}"?`)
        if (!confirmed) return

        updatePlaylistConfig(({ playlists, selectedPlaylistId: currentSelectedPlaylistId }) => {
            const nextPlaylists = playlists.filter((entry) => entry.id !== playlist.id)
            const nextSelectedPlaylistId = currentSelectedPlaylistId === playlist.id ? PLAYLIST_ALL_ID : currentSelectedPlaylistId
            showStatus(`Deleted playlist "${playlist.name}".`)
            return {
                genome_playlists: nextPlaylists,
                selected_genome_playlist_id: nextSelectedPlaylistId,
            }
        })
    }

    const editingPlaylist = useMemo(
        () => genomePlaylists.find((playlist) => playlist.id === editingPlaylistId) || null,
        [genomePlaylists, editingPlaylistId]
    )

    // Removing genomes: deregistering forgets them, deleting also removes the
    // files we downloaded or generated. Both go through the same dialog, whether
    // one row's trash or a whole flagged set, so the choice is always explicit.

    const openRemovalDialog = useCallback((targets, origin = 'row') => {
        const list = (Array.isArray(targets) ? targets : []).filter(Boolean)
        if (list.length === 0) return
        setRemovalRun(null)
        setRemovalPreview({ status: 'loading' })
        setRemovalDialog({ targets: list, origin })
    }, [])

    const closeRemovalDialog = useCallback(() => {
        setRemovalDialog(null)
        setRemovalPreview({ status: 'idle' })
    }, [])

    const removalDescriptors = useCallback((targets) => (
        (targets || []).map((item) => ({
            genome_key: itemKey(item),
            species_key: String(item?.species_key || ''),
            assembly: getAssemblyAccession(item) || String(item?.assembly || ''),
            provider: normalizeGenomeProvider(item),
            is_manual: Boolean(item?.is_manual),
        }))
    ), [])

    /** Forget genomes without touching a single file.
     *
     * The update is a function rather than an object built from the `config`
     * prop. That prop is a render-time snapshot with the app's internal
     * playlists filtered out of it, so writing it back both lost those
     * playlists and let any config change made since that render — a selection
     * toggle raised by the same click, for one — overwrite the deregistration
     * that had just been recorded, putting the genome straight back in the list.
     */
    const deregisterGenomes = useCallback((targets) => {
        onConfigChange((current) => {
            const result = deregisterGenomesFromConfig(current, targets)
            return result.changed ? result.config : null
        })
    }, [onConfigChange])

    // Ask the backend what it would delete. The dialog shows that list rather
    // than a guess, and the answer is thrown away when the dialog closes.
    //
    // There is deliberately no deadline. A genome with a lot of data on disk can
    // take a while to total up, and cutting the count short only replaced a
    // number the user was waiting for with an error. Nothing is blocked on it
    // either: both buttons work while it runs, and choosing one — or closing the
    // dialog — clears `removalDialog`, which aborts the request through this
    // effect's cleanup.
    useEffect(() => {
        const targets = removalDialog?.targets
        if (!targets || targets.length === 0) {
            setRemovalPreview({ status: 'idle' })
            return undefined
        }
        const controller = new AbortController()
        let disposed = false
        setRemovalPreview({ status: 'loading' })
        ;(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/genomes/removal-preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        output_dir: config.output_dir,
                        genomes: removalDescriptors(targets),
                    }),
                    signal: controller.signal,
                })
                const data = await res.json().catch(() => ({}))
                if (disposed) return
                if (!res.ok) {
                    setRemovalPreview({ status: 'error', error: data?.detail || `Request failed (${res.status})` })
                    return
                }
                setRemovalPreview({ status: 'ready', ...data })
            } catch (error) {
                if (disposed || error?.name === 'AbortError') return
                setRemovalPreview({ status: 'error', error: error?.message || 'Request failed' })
            }
        })()
        return () => {
            disposed = true
            controller.abort()
        }
    }, [removalDialog, config.output_dir, removalDescriptors])

    const runRemoval = useCallback(async (targets, { deleteData, includeManual }) => {
        const list = (Array.isArray(targets) ? targets : []).filter(Boolean)
        if (list.length === 0) return
        const { manual } = partitionRemovalTargets(list)
        const manualKeys = new Set(manual.map((item) => itemKey(item)))
        const scope = includeManual ? list : list.filter((item) => !manualKeys.has(itemKey(item)))
        if (scope.length === 0) return

        setRemovalDialog(null)
        setRemovalPreview({ status: 'idle' })

        if (!deleteData) {
            deregisterGenomes(scope)
            setAssemblies((current) => current.filter(
                (item) => !scope.some((target) => genomeKeysMatch(item, target))
            ))
            setRemovalRun(null)
            showStatus(`Deregistered ${scope.length} genome${scope.length === 1 ? '' : 's'}`)
            setRemovalKeys(new Set())
            setRemovalFillMode(null)
            setRemovalMode(false)
            // No refresh: nothing on disk changed, and re-reading the directory
            // would put the row back for as long as the config write is in
            // flight — the very flicker that made deregistering look inert.
            return
        }

        const descriptors = removalDescriptors(scope)
        const results = []
        setRemovalRun({ status: 'running', total: descriptors.length, completed: 0, results, failures: [] })

        for (let index = 0; index < descriptors.length; index += REMOVAL_CHUNK_SIZE) {
            const chunk = descriptors.slice(index, index + REMOVAL_CHUNK_SIZE)
            try {
                const res = await fetch(`${API_BASE}/api/genomes/remove-data`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ output_dir: config.output_dir, genomes: chunk }),
                })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) {
                    // One chunk failing must not abandon the rest of the selection.
                    results.push(...chunk.map((genome) => ({
                        genome_key: genome.genome_key,
                        status: 'failed',
                        failed: [{ path: '', error: data?.detail || `Request failed (${res.status})` }],
                        deleted: [],
                        freed_bytes: 0,
                    })))
                } else {
                    results.push(...(Array.isArray(data?.results) ? data.results : []))
                }
            } catch (error) {
                results.push(...chunk.map((genome) => ({
                    genome_key: genome.genome_key,
                    status: 'failed',
                    failed: [{ path: '', error: error?.message || 'Request failed' }],
                    deleted: [],
                    freed_bytes: 0,
                })))
            }
            setRemovalRun({
                status: 'running',
                total: descriptors.length,
                completed: Math.min(index + REMOVAL_CHUNK_SIZE, descriptors.length),
                results: [...results],
                failures: results.filter((row) => (row.failed || []).length > 0),
            })
        }

        // Deregister everything the user confirmed, including genomes whose files
        // only partly went: leaving one half-deleted but registered would point
        // the browser at files that are no longer there.
        deregisterGenomes(scope)

        const freed = results.reduce((total, row) => total + (Number(row.freed_bytes) || 0), 0)
        const failures = results.filter((row) => (row.failed || []).length > 0)
        setRemovalRun({
            status: failures.length > 0 ? 'error' : 'success',
            total: descriptors.length,
            completed: descriptors.length,
            results,
            failures,
            freed,
        })
        showStatus(
            failures.length > 0
                ? `Removed ${descriptors.length - failures.length} of ${descriptors.length} genomes; ${failures.length} had files that could not be deleted`
                : `Deleted data for ${descriptors.length} genome${descriptors.length === 1 ? '' : 's'} (${formatBytes(freed)})`,
            failures.length > 0,
        )
        setRemovalKeys(new Set())
        setRemovalFillMode(null)
        setRemovalMode(false)
        fetchAssemblies()
        window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
    }, [config.output_dir, deregisterGenomes, fetchAssemblies, removalDescriptors, showStatus])

    const buildRemoteFilesUrl = useCallback((item, requestedTypes = []) => {
        const params = new URLSearchParams({
            provider: normalizeGenomeProvider(item),
        })
        const normalizedTypes = (Array.isArray(requestedTypes) ? requestedTypes : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        if (normalizedTypes.length > 0) {
            params.set('file_types', normalizedTypes.join(','))
        }
        return `${API_BASE}/api/remote/files/${encodeURIComponent(item.species_key)}/${encodeURIComponent(getAssemblyAccession(item))}?${params.toString()}`
    }, [])

    const handleDownloadMissingGenomes = useCallback(async (items) => {
        if (!config.output_dir) {
            showStatus('Set an Output Directory in Configuration first.', true)
            return
        }

        const targets = (Array.isArray(items) ? items : [items])
            .filter((item) => item?.is_missing && canDownloadPlaylistGenome(item))
        if (targets.length === 0) {
            showStatus('No downloadable missing genomes in this playlist.', true)
            return
        }

        const targetKeys = new Set(targets.map((item) => itemKey(item)).filter(Boolean))
        const startedKeys = new Set()
        let alreadyLocal = 0
        let failedGenomes = 0

        setDownloadingMissingKeys((prev) => new Set([...prev, ...targetKeys]))

        for (const item of targets) {
            const key = itemKey(item)
            try {
                const filesRes = await fetch(buildRemoteFilesUrl(item, ['fasta', 'gff3', 'metadata']))
                if (!filesRes.ok) throw new Error('Could not fetch remote file list')
                const files = await filesRes.json()
                const queuedFiles = (Array.isArray(files) ? files : []).filter((file) => ['fasta', 'gff3', 'metadata'].includes(file.type))
                if (queuedFiles.length === 0) throw new Error('No downloadable files found for this genome')

                let startedForGenome = false
                for (const file of queuedFiles) {
                    const res = await fetch(`${API_BASE}/api/remote/download`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: file.url,
                            filename: file.filename,
                            provider: normalizeGenomeProvider(item),
                            species_key: item.species_key,
                            assembly: getAssemblyAccession(item),
                            file_type: file.type,
                            output_dir: config.output_dir,
                            scientific_name: item.scientific_name,
                            common_name: item.common_name,
                            display_name: item.display_name || '',
                            display_name_reason: item.display_name_reason || '',
                            assembly_name: item.assembly_name,
                            source_database: item.source_database,
                            equivalent_accessions: item.equivalent_accessions || [],
                            ...datasetReleaseDownloadMetadata(file, item),
                        }),
                    })
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(data?.detail || `Failed to queue ${file.type}`)
                    if (data?.status === 'started' || data?.status === 'pending' || data?.status === 'downloading') {
                        startedForGenome = true
                    } else if (data?.status === 'already_exists' || data?.status === 'completed') {
                        alreadyLocal += 1
                    }
                }

                if (startedForGenome) startedKeys.add(key)
            } catch (error) {
                failedGenomes += 1
                console.error('Failed to download missing playlist genome:', item, error)
            }
        }

        if (startedKeys.size > 0) {
            const pendingIds = readPendingSelectorGenomeIds()
            for (const key of startedKeys) pendingIds.add(key)
            writePendingSelectorGenomeIds(pendingIds)
        }

        setDownloadingMissingKeys((prev) => {
            const next = new Set(prev)
            for (const key of targetKeys) {
                if (!startedKeys.has(key)) next.delete(key)
            }
            return next
        })

        if (alreadyLocal > 0 || startedKeys.size > 0) {
            window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            fetchAssemblies()
        }

        const genomeLabel = `${targets.length} missing genome${targets.length === 1 ? '' : 's'}`
        if (startedKeys.size > 0) {
            showStatus(`Queued downloads for ${startedKeys.size} of ${genomeLabel}.`)
        } else if (alreadyLocal > 0) {
            showStatus('Those playlist genomes are already present locally. Refreshing…')
        } else {
            showStatus(`Could not queue downloads for ${genomeLabel}.`, true)
        }
        if (failedGenomes > 0 && startedKeys.size > 0) {
            window.setTimeout(() => showStatus(`${failedGenomes} missing genome${failedGenomes === 1 ? '' : 's'} could not be queued.`, true), 3800)
        }
    }, [buildRemoteFilesUrl, config.output_dir, fetchAssemblies])

    const openCustomAnnotationModal = useCallback((item) => {
        if (!item || item?.is_missing) return
        setCustomAnnotationTarget(item)
        setCustomAnnotationLabel(defaultCustomAnnotationLabel())
        setCustomAnnotationPath('')
    }, [])

    const closeCustomAnnotationModal = useCallback(() => {
        if (importingCustomAnnotation) return
        setCustomAnnotationTarget(null)
        setCustomAnnotationLabel(defaultCustomAnnotationLabel())
        setCustomAnnotationPath('')
        setCustomAnnotationIdMode('keep')
        setCustomAnnotationIdPrefix('')
        closeValidation('customAnnotation')
    }, [importingCustomAnnotation, closeValidation])

    const importCustomAnnotation = useCallback(async () => {
        const target = customAnnotationTarget
        const gff3Path = String(customAnnotationPath || '').trim()
        const label = String(customAnnotationLabel || '').trim() || defaultCustomAnnotationLabel()
        if (!target || !gff3Path) {
            showStatus('Choose an annotation file to import.', true)
            return
        }
        if (!config.output_dir) {
            showStatus('Set an Output Directory in Configuration first.', true)
            return
        }

        // Convert whenever the format needs it, whenever the identifiers have to
        // be regenerated, or whenever validation found something to repair.
        const lowerPath = gff3Path.toLowerCase()
        const requiresConversion = CONVERSION_REQUIRED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))
        const report = validation.customAnnotation?.status === 'success'
            ? validation.customAnnotation.report
            : null
        const inferenceNeeded = Object.keys(report?.conversion_preview?.inference || {}).length > 0
        const generate = customAnnotationIdMode === 'generate'
        const convert = requiresConversion || generate || inferenceNeeded

        setImportingCustomAnnotation(true)
        try {
            const res = await fetch(`${API_BASE}/api/remote/custom-annotation`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    provider: normalizeGenomeProvider(target),
                    species_key: target.species_key,
                    assembly: getAssemblyAccession(target),
                    gff3_path: gff3Path,
                    label,
                    convert,
                    id_mode: customAnnotationIdMode,
                    id_prefix: customAnnotationIdPrefix,
                    fasta_path: getEffectiveFiles(target)?.fasta || '',
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(data?.detail || 'Failed to import custom annotation')
            }
            await fetchAssemblies()
            setCustomAnnotationTarget(null)
            setCustomAnnotationLabel(defaultCustomAnnotationLabel())
            setCustomAnnotationPath('')
            setCustomAnnotationIdMode('keep')
            setCustomAnnotationIdPrefix('')
            closeValidation('customAnnotation')

            const conversion = data?.conversion
            if (conversion?.converted) {
                showStatus(
                    `Imported and converted: ${conversion.gene_count} genes, `
                    + `${conversion.transcript_count} transcripts from ${String(conversion.dialect || '').toUpperCase()}`,
                )
            } else {
                showStatus(`Imported annotation dataset: ${data?.dataset_release_label || label}`)
            }
        } catch (error) {
            showStatus(error?.message || 'Failed to import custom annotation', true)
        } finally {
            setImportingCustomAnnotation(false)
        }
    }, [
        config.output_dir,
        customAnnotationLabel,
        customAnnotationPath,
        customAnnotationTarget,
        customAnnotationIdMode,
        customAnnotationIdPrefix,
        validation,
        fetchAssemblies,
        closeValidation,
        getEffectiveFiles,
    ])

    const makeDatasetDefault = useCallback(async (item, instance, expandedRowKey = '') => {
        const releaseKey = String(instance?.dataset_release_key || '').trim()
        if (!item || !releaseKey || !config.output_dir) return
        try {
            if (expandedRowKey) {
                setExpandedRows((prev) => new Set([...prev, expandedRowKey]))
            }
            const res = await fetch(`${API_BASE}/api/remote/dataset-default`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    provider: normalizeGenomeProvider(item),
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    dataset_release_key: releaseKey,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(data?.detail || 'Failed to update default dataset')
            }
            await fetchAssemblies()
            if (expandedRowKey) {
                setExpandedRows((prev) => new Set([...prev, expandedRowKey]))
            }
            showStatus(`Default annotation dataset set to ${instance.dataset_release_short_label || instance.dataset_release_label || releaseKey}.`)
        } catch (error) {
            showStatus(error?.message || 'Failed to update default dataset', true)
        }
    }, [config.output_dir, fetchAssemblies])

    const applySpeciesToggleNow = async (item, source = 'selector') => {
        if (item?.is_missing) return
        if (tableScrollRef.current) {
            pendingScrollTopRef.current = tableScrollRef.current.scrollTop
        }
        if (onToggleSpecies) {
            const result = await onToggleSpecies(item, source)
            if (result?.ok === false) {
                showStatus('Unable to update genome selection.', true)
            }
            return
        }

        const currentActive = config.active_species || []
        const key = itemKey(item)
        const isSelected = currentActive.some((s) => itemKey(s) === key)

        if (isSelected) {
            const updated = currentActive.filter((s) => itemKey(s) !== key)
            const updates = { active_species: updated }
            if (item.files?.gff3) {
                if (config.ref_gff === item.files.gff3) {
                    updates.ref_fasta = ''
                    updates.ref_gff = ''
                    updates.ref_index = ''
                    updates.homologies_file = ''
                }
                if (config.target_gff === item.files.gff3) {
                    updates.target_fasta = ''
                    updates.target_gff = ''
                    updates.target_index = ''
                }
            }
            onConfigChange({ ...config, ...updates })
        } else {
            const hadActive = currentActive.length > 0
            const nextActive = [...currentActive.filter((s) => itemKey(s) !== key), item]
            const updates = { active_species: nextActive }

            // Only make a newly added genome primary if no primary genome exists yet.
            if (!hadActive && item.files?.gff3) {
                updates.ref_fasta = item.files.fasta || ''
                updates.ref_gff = item.files.gff3
                updates.ref_index = item.files.index || ''
                updates.homologies_file = item.files.homology || ''
                updates.target_fasta = ''
                updates.target_gff = ''
                updates.target_index = ''
            }

            onConfigChange({ ...config, ...updates })

        }
    }

    const toggleSpecies = async (item, options = {}) => {
        if (item?.is_missing) return
        const key = itemKey(item)
        const isSelected = selectedGenomeKeys.has(key)
        const hasPending = pendingSelectionKeys.has(key)

        if (isSelected) {
            await applySpeciesToggleNow(item, options.removeSelected ? 'selector_remove' : 'selector')
            return
        }

        if (hasPending) {
            const timer = selectionDelayTimersRef.current.get(key)
            if (timer) window.clearTimeout(timer)
            selectionDelayTimersRef.current.delete(key)
            setPendingSelectionKeys((prev) => {
                const next = new Set(prev)
                next.delete(key)
                return next
            })
            return
        }

        setPendingSelectionKeys((prev) => new Set([...prev, key]))
        const timer = window.setTimeout(async () => {
            selectionDelayTimersRef.current.delete(key)
            setPendingSelectionKeys((prev) => {
                const next = new Set(prev)
                next.delete(key)
                return next
            })
            await applySpeciesToggleNow(item)
        }, 1000)
        selectionDelayTimersRef.current.set(key, timer)
    }

    /**
     * Select or deselect a whole list of genomes in one config write.
     *
     * Looping toggleSpecies would post the config once per genome, each from a
     * stale snapshot, and would queue an index build for every one of them.
     */
    const applyBulkSelection = useCallback((items, { select }) => {
        const candidates = selectableItems(items)
        if (candidates.length === 0) return
        cancelPendingSelections()

        const currentActive = activeSpeciesList || []
        const keys = new Set(candidates.map((item) => itemKey(item)))
        if (select) {
            const kept = currentActive.filter((entry) => !keys.has(itemKey(entry)))
            const addedKeys = candidates
                .filter((item) => !currentActive.some((entry) => itemKey(entry) === itemKey(item)))
                .map((item) => itemKey(item))
            onConfigChange({
                ...config,
                active_species: [...kept, ...candidates],
                // App keeps the first and moves the rest to selected-but-inactive,
                // which is what selecting many genomes at once should mean.
                __manual_batch_added_keys: addedKeys,
            })
            return
        }

        const remaining = currentActive.filter((entry) => !keys.has(itemKey(entry)))
        onConfigChange({
            ...config,
            active_species: remaining,
            __removed_genome_keys: [...keys],
        })
    }, [activeSpeciesList, cancelPendingSelections, config, onConfigChange])

    const selectAllChecked = useMemo(
        () => computeSelectAllChecked(filteredSorted, selectedGenomeKeys),
        [filteredSorted, selectedGenomeKeys],
    )
    const selectableFilteredCount = useMemo(
        () => selectableItems(filteredSorted).length,
        [filteredSorted],
    )
    // What the shortcuts would actually flag: the filter is what is on screen.
    const selectedFilteredCount = useMemo(
        () => selectableItems(filteredSorted).filter((item) => selectedGenomeKeys.has(itemKey(item))).length,
        [filteredSorted, selectedGenomeKeys],
    )

    const handleRemovalFillToggle = useCallback((action) => {
        if (removalFillMode === action) {
            setRemovalKeys(new Set())
            setRemovalFillMode(null)
            return
        }
        setRemovalKeys(nextRemovalFlags(new Set(), action, {
            filteredItems: filteredSorted,
            selectedKeys: selectedGenomeKeys,
        }))
        setRemovalFillMode(action)
    }, [filteredSorted, removalFillMode, selectedGenomeKeys])

    const toggleRemovalMode = useCallback(() => {
        setRemovalMode((current) => {
            if (current) setRemovalKeys(new Set())
            return !current
        })
        setRemovalFillMode(null)
    }, [])

    const handleSelectAllToggle = useCallback(() => {
        const candidates = selectableItems(filteredSorted)
        if (candidates.length === 0) return
        if (selectAllChecked) {
            applyBulkSelection(candidates, { select: false })
            return
        }
        if (candidates.length > BULK_SELECT_CONFIRM_THRESHOLD) {
            const proceed = window.confirm(
                `Select all ${candidates.length} genomes matching the current filter?`
            )
            if (!proceed) return
        }
        applyBulkSelection(candidates, { select: true })
    }, [applyBulkSelection, filteredSorted, selectAllChecked])

    const openManualBrowser = (target, mode = 'file') => {
        setModalTarget(target)
        setModalMode(mode)
        setModalOpen(true)
    }

    const modalInitialPath = useMemo(() => {
        const manualBrowseStart = manualBrowseDirectory || config.working_dir || '.'
        if (modalTarget === 'manual_config_load') {
            return config.working_dir || '.'
        }
        if (modalTarget === 'bundle_export_path') {
            return bundleExportPath ? dirnameFromPath(bundleExportPath) : (config.working_dir || '.')
        }
        if (modalTarget === 'manual_fasta') {
            return manualFasta ? dirnameFromPath(manualFasta) : manualBrowseStart
        }
        if (modalTarget === 'manual_gff3') {
            return manualGff3 ? dirnameFromPath(manualGff3) : manualBrowseStart
        }
        if (modalTarget === 'manual_homology') {
            return manualHomology ? dirnameFromPath(manualHomology) : manualBrowseStart
        }
        if (modalTarget === 'manual_index') {
            return manualIndexPath
                ? dirnameFromPath(manualIndexPath)
                : (dirnameFromPath(manualGff3) || manualBrowseStart)
        }
        if (modalTarget === 'custom_annotation_gff3') {
            const targetFiles = customAnnotationTarget ? getEffectiveFiles(customAnnotationTarget) : {}
            const currentPath = customAnnotationPath || targetFiles?.gff3 || targetFiles?.fasta
            return currentPath ? dirnameFromPath(currentPath) : (config.working_dir || '.')
        }
        if (modalTarget?.startsWith('genome_edit:') && fileBrowserEditTarget) {
            const { fileType, item } = fileBrowserEditTarget
            const effectiveFiles = getEffectiveFiles(item)
            const currentPath = effectiveFiles?.[fileType]
            return currentPath ? dirnameFromPath(currentPath) : (config.output_dir || '.')
        }
        return config.working_dir || '.'
    }, [modalTarget, manualBrowseDirectory, manualFasta, manualGff3, manualHomology, manualIndexPath, bundleExportPath, customAnnotationPath, customAnnotationTarget, config.output_dir, config.working_dir, fileBrowserEditTarget, getEffectiveFiles])

    const modalExtensions = useMemo(() => {
        if (modalTarget === 'manual_config_load' || modalTarget === 'bundle_export_path') return ['.json']
        if (modalTarget === 'manual_fasta') return FASTA_EXTENSIONS
        if (modalTarget === 'manual_gff3') return GFF3_EXTENSIONS
        if (modalTarget === 'manual_homology') return HOMOLOGY_EXTENSIONS
        if (modalTarget === 'custom_annotation_gff3') return GFF3_EXTENSIONS
        if (modalTarget?.startsWith('genome_edit:')) {
            const fileType = modalTarget.split(':')[2]
            if (fileType === 'fasta') return FASTA_EXTENSIONS
            if (fileType === 'gff3') return GFF3_EXTENSIONS
            if (fileType === 'homology') return HOMOLOGY_EXTENSIONS
        }
        return []
    }, [modalTarget])

    const handleModalSelect = (path, selection = {}) => {
        if (modalTarget === 'manual_config_load') {
            void loadGenomeBundle(path)
        } else if (modalTarget === 'bundle_export_path') {
            // Browsing only fills the box; the Export button does the writing.
            bundleExportPathTouchedRef.current = true
            setBundleExportConflict(null)
            setBundleExportPath(path)
        } else if (modalTarget === 'manual_fasta') {
            setManualFasta(path)
            setManualBrowseDirectory(dirnameFromPath(path))
            closeValidation('genome')
            closeValidation('annotation')
        } else if (modalTarget === 'manual_gff3') {
            const nextDir = dirnameFromPath(path)
            setManualGff3(path)
            setManualBrowseDirectory(nextDir)
            setManualIndexPath(joinPath(
                nextDir,
                manualIndexFilename(manualSpeciesLabel, manualAssemblyLabel, path),
            ))
            closeValidation('annotation')
        } else if (modalTarget === 'manual_homology') {
            setManualHomology(path)
            setManualBrowseDirectory(dirnameFromPath(path))
        } else if (modalTarget === 'manual_index') {
            const isDirectory = selection.kind === 'directory'
            const suggestedFilename = manualIndexFilename(
                manualSpeciesLabel,
                manualAssemblyLabel,
                manualGff3,
            )
            setManualIndexPath(isDirectory ? joinPath(path, suggestedFilename) : path)
            setManualBrowseDirectory(isDirectory ? path : dirnameFromPath(path))
        } else if (modalTarget === 'custom_annotation_gff3') {
            setCustomAnnotationPath(path)
        } else if (modalTarget?.startsWith('genome_edit:') && fileBrowserEditTarget) {
            const { fileType, item } = fileBrowserEditTarget
            saveFileOverride(item, fileType, path)
            setFileBrowserEditTarget(null)
        }
        setModalOpen(false)
    }

    // Build a selector record from a bundle entry (or the manual add form).
    //
    // The declared provider is preserved rather than forced to 'manual', so a
    // genome exported from a downloaded set and re-registered from local files
    // reads as what it actually is. It also makes the genome key collide
    // correctly with the same genome downloaded later — allAssemblies already
    // prefers the download-managed record on a key clash.
    // `prepared` is the /api/custom/prepare-annotation result, when there was one.
    // Recording what it converted, and from what, is the only way a later removal
    // can tell our converted GFF3 from the file the user pointed us at — the
    // record keeps only the converted path in files.gff3.
    const buildManualGenomeRecord = (entry, annotationPath = '', prepared = null) => {
        const speciesLabel = String(entry?.species || '').trim()
        const assemblyLabel = String(entry?.assembly || '').trim()
        const assemblyName = String(entry?.assembly_name || '').trim() || assemblyLabel
        const accession = String(entry?.accession || '').trim()
        const provider = String(entry?.provider || '').trim() || 'manual'
        const isHandAdded = provider.toLowerCase() === 'manual'
        const files = canonicalBundleFiles(entry?.files)
        const preparedAnnotation = annotationPath || files.gff3 || ''
        const artifacts = prepared?.converted
            ? {
                converted_annotation: String(prepared.annotation_path || preparedAnnotation || ''),
                source_annotation: String(prepared.source_path || files.gff3 || ''),
                id_map: String(prepared.id_map_path || ''),
                generated_at: new Date().toISOString(),
            }
            : (entry?.artifacts && typeof entry.artifacts === 'object' ? entry.artifacts : null)

        const resolvedFiles = { ...files }
        if (preparedAnnotation) {
            resolvedFiles.gff3 = preparedAnnotation
            if (!resolvedFiles.index) resolvedFiles.index = deriveIndexPathFromGff(preparedAnnotation)
        } else {
            delete resolvedFiles.gff3
            delete resolvedFiles.index
        }
        const release = entry?.dataset_release || {}

        return normalizeGenomeRecord({
            species_key: String(entry?.species_key || '').trim() || toSpeciesKey(speciesLabel) || 'manual_species',
            // Accession first, as before: it is what the genome key is built
            // from, so changing the precedence would rekey existing genomes.
            assembly: accession || assemblyLabel,
            assembly_name: assemblyName,
            scientific_name: speciesLabel,
            common_name: String(entry?.common_name || '').trim(),
            display_name: String(entry?.display_name || '').trim(),
            display_name_reason: String(entry?.display_name_reason || '').trim(),
            provider,
            source_database: String(entry?.source_database || '').trim() || (isHandAdded ? 'Manual' : provider),
            gca: accession,
            equivalent_accessions: Array.isArray(entry?.equivalent_accessions) ? entry.equivalent_accessions : [],
            dataset_release_key: String(release.key || '').trim(),
            dataset_release_source: String(release.source || '').trim(),
            dataset_release_date: String(release.date || '').trim(),
            dataset_release_label: String(release.label || '').trim(),
            dataset_release_short_label: String(release.short_label || '').trim(),
            // Registered from local files rather than managed by the downloader.
            is_manual: true,
            types: Object.keys(resolvedFiles).filter((type) => resolvedFiles[type]),
            has_annotation: Boolean(preparedAnnotation),
            files: resolvedFiles,
            missing_files: Array.isArray(entry?.missing_files) ? entry.missing_files : [],
            ...(artifacts ? { artifacts } : {}),
        })
    }

    const mergeManualGenomeRecords = (
        records,
        {
            retainFormAnalyses = false,
            sourceAnnotation = '',
            selectRecords = true,
            playlistAssignments = [],
        } = {},
    ) => {
        if (!records.length && !playlistAssignments.length) return
        const nextManual = [...(config.manual_species || [])]
        const nextActive = [...(config.active_species || [])]
        for (const record of records) {
            const key = itemKey(record)
            const manualIndex = nextManual.findIndex((entry) => itemKey(entry) === key)
            if (manualIndex >= 0) nextManual[manualIndex] = record
            else nextManual.push(record)
            if (selectRecords) {
                const activeIndex = nextActive.findIndex((entry) => itemKey(entry) === key)
                if (activeIndex >= 0) nextActive[activeIndex] = record
                else nextActive.push(record)
            }
        }

        const updates = {
            manual_species: nextManual,
            active_species: nextActive,
            // Explicitly registering this genome again reverses a previous
            // deregistration. Otherwise filesystem discovery would remain
            // hidden even though the user has just added the genome back.
            deregistered_genome_keys: (config.deregistered_genome_keys || []).filter(
                (hiddenKey) => !records.some((record) => genomeKeysMatch(record, hiddenKey))
            ),
        }
        if (playlistAssignments.length) {
            updates.genome_playlists = mergeManualGenomePlaylistMemberships(
                normalizeGenomePlaylists(config.genome_playlists || []),
                playlistAssignments,
                {
                    createPlaylistId: buildPlaylistId,
                    snapshotGenome: snapshotGenomeForPlaylist,
                    genomesMatch: genomeKeysMatch,
                },
            )
        }
        if (retainFormAnalyses && records.length === 1) {
            const record = records[0]
            const key = itemKey(record)
            let nextAnalyses = config.genome_analysis_reports || {}
            if (validation.genome?.status === 'success' && validation.genome.report) {
                nextAnalyses = withGenomeAnalysis(
                    nextAnalyses,
                    key,
                    'fasta',
                    record.files,
                    validation.genome.report,
                    validation.genome.analysed_at || new Date().toISOString(),
                )
            }
            if (
                record.files.gff3 === sourceAnnotation
                && validation.annotation?.status === 'success'
                && validation.annotation.report
            ) {
                nextAnalyses = withGenomeAnalysis(
                    nextAnalyses,
                    key,
                    'gff3',
                    record.files,
                    validation.annotation.report,
                    validation.annotation.analysed_at || new Date().toISOString(),
                )
            }
            updates.genome_analysis_reports = nextAnalyses
        }

        const first = records[0]
        if (
            selectRecords
            && (config.active_species || []).length === 0
            && !config.ref_gff
            && first?.files?.fasta
        ) {
            updates.ref_fasta = first.files.fasta || ''
            updates.ref_gff = first.files.gff3 || ''
            updates.ref_index = first.files.index || ''
            updates.homologies_file = first.files.homology || ''
        }
        onConfigChange({
            ...config,
            ...updates,
            ...(selectRecords && records.length > 1
                ? { __manual_batch_added_keys: records.map((record) => itemKey(record)) }
                : {}),
        })
    }

    // Read a bundle and either import it straight away or hand it to the review
    // modal. Reviewing is opt-in, so the default path is one click from the file
    // browser to a finished import.
    const loadGenomeBundle = async (path) => {
        setManualOperation({
            status: 'processing',
            kind: 'batch',
            progress: 0,
            stage: 'reading_config',
            message: 'Reading genome configuration',
            counters: {},
            summary: null,
        })
        try {
            const response = await fetch(`${API_BASE}/api/custom/genome-config/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error(payload?.detail || 'Could not read genome configuration')
            if (!payload?.ok) {
                const reason = payload?.diagnostics?.find((item) => item.severity === 'error')?.message
                throw new Error(reason || 'The genome configuration is not valid')
            }

            if (reviewBeforeImport) {
                setBundlePreview({ payload, model: bundlePreviewModel(payload) })
                setManualOperation({
                    status: 'idle',
                    kind: '',
                    progress: 0,
                    stage: '',
                    message: '',
                    counters: {},
                    summary: null,
                })
                return
            }
            await importGenomeBundle(payload)
        } catch (error) {
            const message = error?.message || 'Could not import genome configuration'
            setManualOperation({
                status: 'error',
                kind: 'batch',
                progress: 0,
                stage: 'error',
                message,
                counters: {},
                summary: null,
            })
            showStatus(message, true)
        }
    }

    const importGenomeBundle = async (payload, indexes = null) => {
        const wanted = indexes ? new Set(indexes) : null
        setManualOperation({
            status: 'processing',
            kind: 'batch',
            progress: 0,
            stage: 'registering',
            message: 'Registering genomes',
            counters: {},
            summary: null,
        })
        try {
            const entries = (Array.isArray(payload.entries) ? payload.entries : [])
                .filter((entry) => !wanted || wanted.has(entry?.index))
            const total = entries.length
            const accepted = [
                ...(assemblies || []),
                ...(config.manual_species || []),
                ...(config.active_species || []),
            ]
            const records = []
            const playlistAssignments = []
            const summary = { added: [], skipped: [], failed: [] }

            for (let position = 0; position < entries.length; position += 1) {
                const entry = entries[position]
                const genome = entry?.genome || {}
                const label = manualGenomeLabel(genome)
                const prefix = `Genome ${position + 1} of ${total}:`
                if (!entry?.valid) {
                    const reason = entry?.diagnostics?.find((item) => item.severity === 'error')?.message || 'Invalid entry'
                    summary.failed.push({ label, reason })
                    setManualOperation((prev) => ({
                        ...prev,
                        progress: batchProgress(position + 1, 0, total),
                        message: `${prefix} skipped invalid entry`,
                    }))
                    continue
                }

                const duplicate = findDuplicateManualGenome(genome, accepted)
                if (duplicate) {
                    if (genome.playlists?.length) {
                        playlistAssignments.push({
                            genome: duplicate,
                            playlists: genome.playlists,
                        })
                    }
                    summary.skipped.push({
                        label,
                        reason: `Duplicate of ${manualGenomeLabel(duplicate)}`,
                    })
                    setManualOperation((prev) => ({
                        ...prev,
                        progress: batchProgress(position + 1, 0, total),
                        message: `${prefix} duplicate skipped`,
                    }))
                    continue
                }
                // Reserve the identity before preparation so later entries in
                // the same file are classified as duplicates.
                accepted.push(genome)

                try {
                    let annotationPath = genome.files?.gff3 || ''
                    let preparedResult = null
                    if (annotationPath) {
                        const prepared = await prepareAnnotation(
                            annotationPath,
                            genome.files?.fasta,
                            (progress) => {
                                setManualOperation((prev) => ({
                                    ...prev,
                                    status: 'processing',
                                    kind: 'batch',
                                    progress: batchProgress(position, progress.progress, total),
                                    stage: progress.stage,
                                    message: `${prefix} ${progress.message || 'Preparing annotation'}`,
                                    counters: progress.counters,
                                }))
                            },
                        )
                        annotationPath = prepared.annotation_path || annotationPath
                        preparedResult = prepared
                    } else {
                        setManualOperation((prev) => ({
                            ...prev,
                            progress: batchProgress(position, 95, total),
                            stage: 'registering',
                            message: `${prefix} Registering sequence-only genome`,
                            counters: {},
                        }))
                    }
                    const record = buildManualGenomeRecord(genome, annotationPath, preparedResult)
                    records.push(record)
                    if (genome.playlists?.length) {
                        playlistAssignments.push({
                            genome: record,
                            playlists: genome.playlists,
                        })
                    }
                    accepted.push(record)
                    summary.added.push({ label: manualGenomeLabel(record) })
                } catch (error) {
                    summary.failed.push({
                        label,
                        reason: error?.message || 'Annotation preparation failed',
                    })
                }
                setManualOperation((prev) => ({
                    ...prev,
                    progress: batchProgress(position + 1, 0, total),
                    stage: 'batch',
                    message: `${prefix} complete`,
                    counters: {},
                }))
            }

            mergeManualGenomeRecords(records, {
                selectRecords: selectLoadedManualGenomes,
                playlistAssignments,
            })
            summary.missingFiles = bundleMissingFileReport(payload, { indexes })
            const message = `Added ${summary.added.length}; skipped ${summary.skipped.length}; failed ${summary.failed.length}.`
            setManualOperation({
                status: 'idle',
                kind: 'batch',
                progress: 100,
                stage: 'complete',
                message,
                counters: {},
                summary,
            })
            showStatus(message, summary.added.length === 0 && summary.failed.length > 0)
        } catch (error) {
            const message = error?.message || 'Could not import genome configuration'
            setManualOperation({
                status: 'error',
                kind: 'batch',
                progress: 0,
                stage: 'error',
                message,
                counters: {},
                summary: null,
            })
            showStatus(message, true)
        }
    }

    // Playlists a bundle may legitimately describe — the two session-tracking
    // playlists are app bookkeeping and never belong in an export.
    const exportablePlaylists = useMemo(() => (config.genome_playlists || []).filter((playlist) => {
        const id = String(playlist?.id || '').trim()
        const name = String(playlist?.name || '').trim().toLowerCase()
        return (
            !playlist?.hidden
            && !playlist?.system
            && id !== '__previous_session__'
            && id !== '__next_previous_session__'
            && name !== 'previous session'
            && name !== 'next previous session'
        )
    }), [config.genome_playlists])

    // The export set is whatever is currently selected. Applying a playlist
    // populates the selection, so "export this playlist" needs no separate
    // control — choose the playlist, then export.
    //
    // This reads activeSpeciesList, not config.active_species: the table's
    // checkboxes are driven by the former, which prefers the selectedSpeciesList
    // prop. Reading the config directly let the two diverge, so the button could
    // sit disabled while rows showed as ticked.
    const exportSelectionEntries = useMemo(() => (
        (activeSpeciesList || []).map((genome) => {
            // Downloaded genomes carry their real file map on the live scan
            // record, not on the selection snapshot.
            const live = resolveLocalPlaylistGenome(genome) || genome
            const playlists = exportablePlaylists
                .filter((playlist) => (
                    (playlist.genomes || []).some((member) => genomeKeysMatch(member, genome))
                ))
                .map((playlist) => playlist.name)
            return { genome: live, files: getEffectiveFiles(live), playlists }
        })
    ), [activeSpeciesList, exportablePlaylists, resolveLocalPlaylistGenome, getEffectiveFiles])

    const exportSelectionCount = exportSelectionEntries.length

    // Offer a usable destination up front rather than an empty box.
    useEffect(() => {
        if (bundleExportPathTouchedRef.current) return
        const directory = config.working_dir || config.output_dir
        if (!directory) return
        setBundleExportPath(joinPath(directory, DEFAULT_BUNDLE_FILENAME))
    }, [config.working_dir, config.output_dir])

    // mode: 'create' refuses to touch an existing file (the backend answers 409),
    // so the user gets a choice rather than a silent overwrite.
    const exportGenomeBundle = async (mode = 'create') => {
        const destination = String(bundleExportPath || '').trim()
        if (!destination) return
        // Be forgiving about a hand-typed path; the backend requires .json.
        const path = /\.[^/\\.]+$/.test(destination) ? destination : `${destination}.json`

        const { genomes, playlists, skipped } = buildGenomeBundle(
            exportSelectionEntries,
            { playlists: exportablePlaylists },
        )
        if (!genomes.length) {
            showStatus('None of the selected genomes have files that can be exported.', true)
            return
        }
        setBundleExportConflict(null)
        setManualOperation({
            status: 'processing',
            kind: 'export',
            progress: 20,
            stage: 'exporting',
            message: mode === 'merge' ? 'Amending genome configuration' : 'Writing genome configuration',
            counters: {},
            summary: null,
        })
        try {
            const response = await fetch(`${API_BASE}/api/custom/genome-config/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, genomes, playlists, mode }),
            })
            const payload = await response.json().catch(() => null)
            if (response.status === 409) {
                setBundleExportConflict({ path, detail: payload?.detail || 'That file already exists.' })
                setManualOperation({
                    status: 'idle', kind: '', progress: 0,
                    stage: '', message: '', counters: {}, summary: null,
                })
                return
            }
            if (!response.ok) throw new Error(payload?.detail || 'Could not save genome configuration')
            const skippedNote = skipped.length
                ? ` Skipped ${skipped.length}: ${skipped.map((item) => `${item.label} (${item.reason})`).join('; ')}.`
                : ''
            const message = payload.mode === 'merge'
                ? `Amended ${payload.path}: ${payload.added} added, ${payload.updated} updated, ${payload.count} in the file.${skippedNote}`
                : `Exported ${payload.count} genome${payload.count === 1 ? '' : 's'} to ${payload.path}.${skippedNote}`
            setManualOperation({
                status: 'idle',
                kind: 'export',
                progress: 100,
                stage: 'complete',
                message,
                counters: {},
                summary: { exported: payload.count, path: payload.path },
            })
            showStatus(message)
        } catch (error) {
            const message = error?.message || 'Could not export genome configuration'
            setManualOperation({
                status: 'error',
                kind: 'export',
                progress: 0,
                stage: 'error',
                message,
                counters: {},
                summary: null,
            })
            showStatus(message, true)
        }
    }

    const addManualGenome = async () => {
        const speciesLabel = (manualSpeciesLabel || '').trim()
        const assemblyLabel = (manualAssemblyLabel || '').trim()
        const accession = (manualGca || '').trim()
        if (!speciesLabel || !assemblyLabel) {
            showStatus('Species and assembly labels are required.', true)
            return
        }
        if (!manualFasta) {
            showStatus('A genome requires a FASTA file.', true)
            return
        }

        setManualOperation({
            status: 'processing',
            kind: 'single',
            progress: manualGff3 ? 0 : 92,
            stage: manualGff3 ? 'queued' : 'registering',
            message: manualGff3 ? 'Queueing annotation preparation' : 'Registering sequence-only genome',
            counters: {},
            summary: null,
        })
        try {
            let annotationPath = manualGff3
            let preparedResult = null
            if (manualGff3) {
                const prepared = await prepareAnnotation(manualGff3, manualFasta, (progress) => {
                    setManualOperation((prev) => ({
                        ...prev,
                        status: 'processing',
                        kind: 'single',
                        progress: progress.progress,
                        stage: progress.stage,
                        message: progress.message || 'Preparing annotation',
                        counters: progress.counters,
                    }))
                })
                annotationPath = prepared.annotation_path || manualGff3
                preparedResult = prepared
            }

            setManualOperation((prev) => ({
                ...prev,
                progress: Math.max(prev.progress, 99),
                stage: 'registering',
                message: 'Registering genome',
            }))
            const record = buildManualGenomeRecord({
                species: speciesLabel,
                assembly: assemblyLabel,
                accession,
                files: {
                    fasta: manualFasta,
                    gff3: manualGff3,
                    homology: manualHomology,
                    index: manualIndexPath,
                },
            }, annotationPath, preparedResult)
            mergeManualGenomeRecords(
                [record],
                { retainFormAnalyses: true, sourceAnnotation: manualGff3 },
            )

            const annotationNote = record.files?.gff3
                ? ''
                : ' (sequence only — no annotation, so the gene track will be empty)'
            showStatus(`Manual genome added: ${manualGenomeLabel(record)}${annotationNote}`)
            setManualOperation({
                status: 'success',
                kind: 'single',
                progress: 100,
                stage: 'complete',
                message: 'Added',
                counters: {},
                summary: null,
            })
            manualSuccessTimerRef.current = window.setTimeout(() => {
                resetManualForm()
                setManualOpen(false)
                setManualOperation({
                    status: 'idle',
                    kind: '',
                    progress: 0,
                    stage: '',
                    message: '',
                    counters: {},
                    summary: null,
                })
                manualSuccessTimerRef.current = null
            }, 2000)
        } catch (error) {
            const message = error?.message || 'Failed to prepare the annotation'
            setManualOperation({
                status: 'error',
                kind: 'single',
                progress: 0,
                stage: 'error',
                message,
                counters: {},
                summary: null,
            })
            showStatus(message, true)
        }
    }

    const isPlaylistView = selectedPlaylistId !== PLAYLIST_ALL_ID
    const emptyStateTitle = isPlaylistView && selectedPlaylist?.genomes.length === 0
        ? 'Playlist is empty'
        : 'No genomes found'
    const emptyStateMessage = search.trim()
        ? (isPlaylistView ? 'No results match your search query in this playlist.' : 'No results match your search query.')
        : (isPlaylistView
            ? 'This playlist has no genomes yet.'
            : (!allAssemblies.length
                ? 'Download genomes to the output directory or add genomes manually from local files.'
                : 'No results match your search query.'))
    const selectedPlaylistLabel = selectedPlaylistId === PLAYLIST_ALL_ID
        ? 'All genomes'
        : (selectedPlaylist?.name || 'All genomes')

    // The alignment is split out rather than overridden per column: appending
    // `text-center` to a class string that already carries `text-left` leaves
    // which one wins up to the order the two utilities happen to be emitted in,
    // which is how the header controls drifted out of line with their columns.
    const thBaseClass = `px-4 py-3 text-xs font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500 bg-gray-50' : 'text-gray-400 bg-gray-800'}`
    const thClass = `${thBaseClass} text-left`
    const thCenteredClass = `${thBaseClass} text-center`
    const manualProcessing = manualOperation.status === 'processing'
    const manualLocked = manualProcessing || manualOperation.status === 'success'
    const manualStatusText = manualProgressText(manualOperation)
    const canCaptureRasterScreenshot = typeof window !== 'undefined' &&
        typeof window.electronAPI?.captureHtmlSnapshot === 'function'
    const screenshotTarget = useMemo(() => {
        const node = screenshotRootNode
        if (!node) return null
        const allowedFormats = canCaptureRasterScreenshot ? ['svg', 'png', 'jpeg'] : ['svg']
        return {
            id: 'genome-selector-view',
            label: 'Genome Selector view',
            allowedFormats,
            defaultFormat: canCaptureRasterScreenshot ? 'png' : 'svg',
            getVisibleRect: () => node.getBoundingClientRect(),
            getScrollElement: () => node,
            buildDefaultFilename: () => buildDefaultScreenshotName('ens_genome_selector_page'),
            buildExportSnapshot: async () => {
                const { width, height } = measureScreenshotNode(node)
                return buildDomNodeScreenshotSnapshot(node, {
                    width,
                    height,
                    backgroundColor: isLight ? '#f3f4f6' : '#111827',
                })
            },
        }
    }, [canCaptureRasterScreenshot, isLight, screenshotRootNode])

    const defaultScreenshotDir = useMemo(() => {
        const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        return base ? `${base}/screenshots` : ''
    }, [config?.output_dir])

    useEffect(() => {
        onScreenshotAvailabilityChange?.('genome_selector', Boolean(screenshotTarget))
        return () => onScreenshotAvailabilityChange?.('genome_selector', false)
    }, [onScreenshotAvailabilityChange, screenshotTarget])

    useEffect(() => {
        if (screenshotTarget || !screenshotMode) return
        onScreenshotModeChange?.(false)
        setSelectedScreenshotTarget(null)
    }, [onScreenshotModeChange, screenshotMode, screenshotTarget])

    const handleScreenshotSave = useCallback(async ({ filename, directory, format, scale, quality, target }) => {
        if (!target?.buildExportSnapshot) {
            return { ok: false, error: 'Screenshot target is no longer available.' }
        }

        try {
            const snapshot = await target.buildExportSnapshot()
            if (!snapshot?.svgMarkup) {
                return { ok: false, error: 'Failed to build screenshot export.' }
            }

            let payload
            if (format === 'svg') {
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: 'image/svg+xml',
                    encoding: 'utf8',
                    data: snapshot.svgMarkup,
                }
            } else {
                const electronBridge = typeof window !== 'undefined' ? window.electronAPI : null
                if (!snapshot.htmlMarkup || typeof electronBridge?.captureHtmlSnapshot !== 'function') {
                    return { ok: false, error: 'PNG/JPEG export for this view requires the Electron screenshot renderer. Export as SVG instead.' }
                }
                const raster = await electronBridge.captureHtmlSnapshot({
                    htmlMarkup: snapshot.bodyMarkup || snapshot.htmlMarkup,
                    width: snapshot.width,
                    height: snapshot.height,
                    format,
                    scale,
                    quality,
                    backgroundColor: snapshot.backgroundColor || (isLight ? '#f3f4f6' : '#111827'),
                })
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: raster.mimeType,
                    encoding: 'base64',
                    data: raster.base64,
                }
            }

            const response = await fetch(`${API_BASE}/api/exports/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || !data?.ok) {
                return { ok: false, error: data?.detail || 'Failed to save screenshot.' }
            }
            return { ok: true, path: data.path, filename: data.filename }
        } catch (error) {
            return { ok: false, error: error?.message || 'Failed to export screenshot.' }
        }
    }, [isLight])

    return (
        <>
        <div ref={setScreenshotRoot} className="relative h-full overflow-y-auto pr-1 flex flex-col max-w-5xl mx-auto pb-6">
            <FileBrowserModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                onSelect={handleModalSelect}
                initialPath={modalInitialPath}
                mode={modalMode}
                theme={theme}
                extensions={modalExtensions}
                defaultFileName={modalTarget === 'bundle_export_path' ? 'ensembl-go-genomes.json' : ''}
                footerContent={modalTarget === 'manual_config_load' ? (
                    <div className="space-y-2">
                        <label
                            className={`flex items-start gap-2 cursor-pointer ${isLight ? 'text-gray-700' : 'text-gray-200'}`}
                            title="This will add all the loaded genomes to the selected genomes set in Genome Selector and the genome boxes near the top of the app."
                        >
                            <input
                                type="checkbox"
                                checked={selectLoadedManualGenomes}
                                onChange={(event) => setSelectLoadedManualGenomes(event.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-400 accent-[#0099ff]"
                            />
                            <span>
                                <span className="block text-sm font-medium">Automatically add to selected genomes list</span>
                                <span className={`block mt-0.5 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Adds them to the selected genomes set and the genome boxes at the top of the app.
                                </span>
                            </span>
                        </label>
                        <label
                            className={`flex items-start gap-2 cursor-pointer ${isLight ? 'text-gray-700' : 'text-gray-200'}`}
                            title="Show what the file contains and choose which genomes to import."
                        >
                            <input
                                type="checkbox"
                                checked={reviewBeforeImport}
                                onChange={(event) => setReviewBeforeImport(event.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded border-gray-400 accent-[#0099ff]"
                            />
                            <span>
                                <span className="block text-sm font-medium">Review genomes before importing</span>
                                <span className={`block mt-0.5 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Show which genomes and files the file lists, and pick the ones to import.
                                </span>
                            </span>
                        </label>
                    </div>
                ) : null}
            />
            <GenomeBundlePreviewModal
                isOpen={Boolean(bundlePreview)}
                theme={theme}
                model={bundlePreview?.model}
                busy={manualProcessing}
                selectLoaded={selectLoadedManualGenomes}
                onSelectLoadedChange={setSelectLoadedManualGenomes}
                onClose={() => setBundlePreview(null)}
                onImport={(indexes) => {
                    const payload = bundlePreview?.payload
                    setBundlePreview(null)
                    if (payload) void importGenomeBundle(payload, indexes)
                }}
            />
            <CustomAnnotationModal
                isOpen={!!customAnnotationTarget}
                theme={theme}
                item={customAnnotationTarget}
                label={customAnnotationLabel}
                path={customAnnotationPath}
                importing={importingCustomAnnotation}
                validation={validation.customAnnotation}
                idMode={customAnnotationIdMode}
                idPrefix={customAnnotationIdPrefix}
                onLabelChange={setCustomAnnotationLabel}
                onPathChange={setCustomAnnotationPath}
                onBrowse={() => {
                    setModalTarget('custom_annotation_gff3')
                    setModalMode('file')
                    setModalOpen(true)
                }}
                onCancel={closeCustomAnnotationModal}
                onImport={importCustomAnnotation}
                onValidate={() => runValidation('customAnnotation', 'annotation', {
                    annotation_path: String(customAnnotationPath || '').trim(),
                    fasta_path: getEffectiveFiles(customAnnotationTarget)?.fasta || null,
                })}
                onCloseValidation={() => closeValidation('customAnnotation')}
                onIdModeChange={setCustomAnnotationIdMode}
                onIdPrefixChange={setCustomAnnotationIdPrefix}
            />
            <GenomeRemovalDialog
                isOpen={!!removalDialog}
                theme={theme}
                targets={removalDialog?.targets || []}
                preview={removalPreview}
                onClose={closeRemovalDialog}
                onRemove={(options) => runRemoval(removalDialog?.targets || [], options)}
            />
            <PlaylistMembershipModal
                isOpen={!!playlistMembershipTarget}
                theme={theme}
                genome={playlistMembershipTarget}
                playlists={genomePlaylists}
                onClose={() => setPlaylistMembershipTarget(null)}
                onSave={handleSaveGenomePlaylistMembership}
            />
            <PlaylistEditorModal
                isOpen={!!editingPlaylist}
                theme={theme}
                playlist={editingPlaylist}
                availableAssembliesByKey={allAssembliesByKey}
                onClose={() => setEditingPlaylistId('')}
                onSave={handleSavePlaylistEdit}
            />

            {statusMessage && (
                <div className={`fixed top-24 right-4 sm:right-6 z-50 rounded-lg px-6 py-4 shadow-lg border backdrop-blur-sm max-w-[calc(100vw-32px)] sm:max-w-md break-words ${statusMessage.isError
                    ? 'bg-red-500/90 text-white border-red-400'
                    : 'bg-emerald-500/90 text-white border-emerald-400'
                    }`}>
                    {/* The icon must not shrink and the text must be allowed to,
                        or a long path overflows the box instead of wrapping. */}
                    <div className="flex items-start gap-3">
                        {statusMessage.isError
                            ? <svg className="shrink-0 mt-0.5" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                            : <svg className="shrink-0 mt-0.5" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeLinecap="round" strokeLinejoin="round" /><polyline points="22 4 12 14.01 9 11.01" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        }
                        <span className="min-w-0 font-medium break-words">{statusMessage.text}</span>
                    </div>
                </div>
            )}

            <div className={`flex-none mb-6 p-6 rounded-xl border ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}>
                <h2 className={`text-xl font-bold mb-2 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Genome Selector</h2>
                <p className={`text-sm mb-4 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    Selected genomes are available across the app. Create genome playlists or manually add genomes.
                </p>
                {!config.output_dir && (
                    <div className={`mb-4 px-3 py-2 rounded-lg text-xs ${isLight ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-amber-900/20 text-amber-300 border border-amber-800/40'}`}>
                        No output directory is currently set. Downloaded assemblies may be hidden, but manual genome import is still available below.
                    </div>
                )}

                <div className={`border rounded-xl overflow-hidden ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                    <button
                        type="button"
                        onClick={() => setPlaylistsCollapsed((prev) => !prev)}
                        className={`w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors ${isLight ? 'hover:bg-white' : 'hover:bg-gray-800/70'}`}
                    >
                        <div className="min-w-0">
                            <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>Genome Playlists</div>
                            <div className={`text-xs mt-1 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Selected: {selectedPlaylistLabel}
                            </div>
                        </div>
                        <div className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
                            ? 'bg-white border-gray-300 text-gray-700'
                            : 'bg-gray-800 border-gray-600 text-gray-200'
                            }`}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                {playlistsCollapsed
                                    ? <polyline points="6 9 12 15 18 9" />
                                    : <polyline points="18 15 12 9 6 15" />}
                            </svg>
                        </div>
                    </button>

                    {!playlistsCollapsed && (
                        <div className={`px-4 pb-4 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <p className={`text-xs mt-3 mb-3 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Choosing a playlist selects its available genomes and activates the first one.
                            </p>
                            {selectedPlaylistId !== PLAYLIST_ALL_ID && selectedPlaylistMissingGenomes.length > 0 && (
                                <div className={`mb-3 px-3 py-2 rounded-lg border flex items-center justify-between gap-3 ${isLight
                                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                                    : 'bg-amber-900/20 border-amber-800/40 text-amber-200'
                                }`}>
                                    <div className="min-w-0">
                                        <div className="text-xs font-semibold">
                                            {selectedPlaylistMissingGenomes.length} playlist genome{selectedPlaylistMissingGenomes.length === 1 ? '' : 's'} missing locally
                                        </div>
                                        <div className={`text-[11px] mt-0.5 ${isLight ? 'text-amber-700' : 'text-amber-300/80'}`}>
                                            {selectedPlaylistDownloadableMissingGenomes.length > 0
                                                ? `${selectedPlaylistDownloadableMissingGenomes.length} can be downloaded from the remote catalogue.`
                                                : 'No missing genomes in this playlist have enough remote metadata to download automatically.'}
                                        </div>
                                    </div>
                                    {selectedPlaylistDownloadableMissingGenomes.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation()
                                                handleDownloadMissingGenomes(selectedPlaylistDownloadableMissingGenomes)
                                            }}
                                            className={`shrink-0 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${isLight
                                                ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-300'
                                                : 'bg-amber-700/50 text-amber-100 hover:bg-amber-700 border border-amber-600'
                                            }`}
                                        >
                                            Download missing
                                        </button>
                                    )}
                                </div>
                            )}
                            <div className="max-h-56 overflow-y-auto rounded-lg overflow-hidden">
                            <button
                                type="button"
                                onClick={() => handleSelectPlaylist(PLAYLIST_ALL_ID)}
                                className={`w-full px-4 py-3 text-left border-b transition-colors ${selectedPlaylistId === PLAYLIST_ALL_ID
                                    ? (isLight ? 'bg-blue-50 text-blue-900 border-blue-100' : 'bg-blue-900/25 text-blue-100 border-blue-800/50')
                                    : (isLight ? 'bg-transparent text-gray-800 border-gray-200 hover:bg-white' : 'bg-transparent text-gray-100 border-gray-700 hover:bg-gray-800/70')
                                    }`}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold">All genomes</div>
                                        <div className={`text-xs mt-1 ${selectedPlaylistId === PLAYLIST_ALL_ID
                                            ? (isLight ? 'text-blue-700/80' : 'text-blue-200/80')
                                            : (isLight ? 'text-gray-500' : 'text-gray-400')
                                            }`}>
                                            {allAssemblies.length} genome{allAssemblies.length === 1 ? '' : 's'}
                                        </div>
                                    </div>
                                </div>
                            </button>

                            {playlistRows.length === 0 ? (
                                <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    No playlists yet. Use the add-to-playlist button on a genome row to create one.
                                </div>
                            ) : playlistRows.map((playlist) => {
                                const isSelectedPlaylist = selectedPlaylistId === playlist.id
                                return (
                                    <div
                                        key={playlist.id}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleSelectPlaylist(playlist.id)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault()
                                                handleSelectPlaylist(playlist.id)
                                            }
                                        }}
                                        className={`w-full px-4 py-3 text-left border-b last:border-b-0 transition-colors ${isSelectedPlaylist
                                            ? (isLight ? 'bg-blue-50 text-blue-900 border-blue-100' : 'bg-blue-900/25 text-blue-100 border-blue-800/50')
                                            : (isLight ? 'bg-transparent text-gray-800 border-gray-200 hover:bg-white' : 'bg-transparent text-gray-100 border-gray-700 hover:bg-gray-800/70')
                                            }`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-sm font-semibold truncate">{playlist.name}</div>
                                                <div className={`text-xs mt-1 ${isSelectedPlaylist
                                                    ? (isLight ? 'text-blue-700/80' : 'text-blue-200/80')
                                                    : (isLight ? 'text-gray-500' : 'text-gray-400')
                                                    }`}>
                                                    {playlist.genomeCount} genome{playlist.genomeCount === 1 ? '' : 's'}
                                                    {playlist.missingCount > 0 ? ` • ${playlist.missingCount} missing locally` : ''}
                                                    {playlist.downloadableMissingCount > 0 ? ` • ${playlist.downloadableMissingCount} downloadable` : ''}
                                                </div>
                                                {playlist.description && (
                                                    <div className={`text-xs mt-1 truncate ${isSelectedPlaylist
                                                        ? (isLight ? 'text-blue-800/80' : 'text-blue-100/85')
                                                        : (isLight ? 'text-gray-600' : 'text-gray-300')
                                                        }`}>
                                                        {playlist.description}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                {!playlist.system && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation()
                                                                setEditingPlaylistId(playlist.id)
                                                            }}
                                                            className={`p-2 rounded-lg transition-colors ${isLight
                                                                ? 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                                                                : 'text-gray-500 hover:text-blue-300 hover:bg-blue-900/20'
                                                                }`}
                                                            title="Edit playlist"
                                                        >
                                                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                <path d="M12 20h9" />
                                                                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                                                            </svg>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation()
                                                                handleDeletePlaylist(playlist)
                                                            }}
                                                            className={`p-2 rounded-lg transition-colors ${isLight
                                                                ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
                                                                : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'
                                                                }`}
                                                            title="Delete playlist"
                                                        >
                                                            <IconTrash size={15} />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                            </div>
                        </div>
                    )}
                </div>

                <div className="mt-4">
                    <div className={`flex items-center gap-2 flex-1 px-4 py-2.5 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-300' : 'bg-gray-900 border-gray-600'}`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-40 shrink-0">
                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                            type="text"
                            placeholder="Search species, GCA, assembly…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className={`flex-1 bg-transparent outline-none text-sm ${isLight ? 'text-gray-900 placeholder-gray-400' : 'text-gray-100 placeholder-gray-500'}`}
                        />
                        {search && <button onClick={() => setSearch('')} className="opacity-40 hover:opacity-70 text-xs">&#10005;</button>}
                    </div>
                </div>
            </div>

            <div className={`order-3 flex-none mt-6 rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`flex flex-wrap items-center gap-2 px-3 sm:px-6 py-3 ${isLight ? 'bg-white' : 'bg-gray-800'}`}>
                    <button
                        type="button"
                        onClick={() => setManualOpen((prev) => !prev)}
                        disabled={manualLocked}
                        className={`min-w-0 flex-1 flex items-center justify-between py-1 text-left transition-colors disabled:cursor-not-allowed ${manualLocked ? 'opacity-60' : ''}`}
                    >
                        <div className={`flex items-center gap-2 text-base font-bold ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 2v12M2 8h12" />
                            </svg>
                            Manually add genomes
                        </div>
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`ml-2 transition-transform ${manualOpen ? 'rotate-180' : ''} ${isLight ? 'text-gray-400' : 'text-gray-500'}`}
                        >
                            <path d="M4 6l4 4 4-4" />
                        </svg>
                    </button>
                    <div className={`h-6 w-px ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`} />
                    <button
                        type="button"
                        disabled={manualLocked}
                        title="Load a json file containing details for data relating to one or more genomes. Good for bulk loading data"
                        onClick={() => {
                            setManualOpen(true)
                            setModalTarget('manual_config_load')
                            setModalMode('file')
                            setModalOpen(true)
                        }}
                        className={`shrink-0 px-2.5 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isLight
                            ? 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100'
                            : 'bg-gray-700 border-gray-600 text-gray-200 hover:bg-gray-600'
                            }`}
                    >
                        Load JSON
                    </button>
                </div>

                {/* The import report belongs next to the button that produced it,
                    not at the far bottom of the section. */}
                {manualOperation.kind === 'batch' && (manualProcessing || manualOperation.summary || manualOperation.status === 'error') ? (
                    <div className={`mx-3 sm:mx-6 mb-3 rounded-lg border p-3 text-xs ${manualOperation.status === 'error'
                        ? (isLight ? 'border-red-200 bg-red-50 text-red-800' : 'border-red-800/60 bg-red-900/20 text-red-200')
                        : (isLight ? 'border-blue-200 bg-blue-50 text-blue-900' : 'border-blue-800/60 bg-blue-900/20 text-blue-100')
                        }`}>
                        <div className="flex items-start gap-3">
                            {manualProcessing ? (
                                <ProgressGlyph
                                    size={14}
                                    progress={Math.max(0, Math.min(1, manualOperation.progress / 100))}
                                    renderGlyph={(props) => <AddGenomeGlyph {...props} />}
                                />
                            ) : null}
                            <div className="min-w-0 flex-1" role="status" aria-live="polite">
                                <div className="font-semibold break-words">{manualStatusText}</div>
                                {manualProcessing ? (
                                    <div className="mt-1 opacity-75">{Math.round(manualOperation.progress)}% overall</div>
                                ) : null}
                            </div>
                            {!manualProcessing && manualOperation.summary ? (
                                <button
                                    type="button"
                                    onClick={() => setManualOperation({
                                        status: 'idle', kind: '', progress: 0,
                                        stage: '', message: '', counters: {}, summary: null,
                                    })}
                                    className="shrink-0 p-0.5 rounded opacity-60 hover:opacity-100"
                                    aria-label="Dismiss import report"
                                >
                                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                                        <path d="M15 5L5 15M5 5l10 10" strokeLinecap="round" />
                                    </svg>
                                </button>
                            ) : null}
                        </div>
                        {manualOperation.summary ? (
                            <div className="mt-3 grid grid-cols-3 gap-2">
                                <div><span className="font-semibold">{manualOperation.summary.added?.length || 0}</span> added</div>
                                <div><span className="font-semibold">{manualOperation.summary.skipped?.length || 0}</span> skipped</div>
                                <div><span className="font-semibold">{manualOperation.summary.failed?.length || 0}</span> failed</div>
                                {[...(manualOperation.summary.skipped || []), ...(manualOperation.summary.failed || [])].length ? (
                                    <div className="col-span-3 mt-1 max-h-28 overflow-y-auto space-y-1">
                                        {[...(manualOperation.summary.skipped || []), ...(manualOperation.summary.failed || [])].map((item, index) => (
                                            <div key={`${item.label}-${index}`} className="opacity-80 break-words">
                                                {item.label}: {item.reason}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                                {/* A direct import skips the review matrix, so this is the
                                    only place the user learns which paths did not resolve. */}
                                {manualOperation.summary.missingFiles?.length ? (
                                    <div className={`col-span-3 mt-2 pt-2 border-t ${isLight ? 'border-blue-200' : 'border-blue-800/60'}`}>
                                        <div className="font-semibold">
                                            {manualOperation.summary.missingFiles.length} file
                                            {manualOperation.summary.missingFiles.length === 1 ? '' : 's'} not found
                                        </div>
                                        <div className="mt-1 max-h-28 overflow-y-auto space-y-1">
                                            {manualOperation.summary.missingFiles.map((item, index) => (
                                                <div key={`${item.label}-${item.fileType}-${index}`} className="opacity-80 break-all">
                                                    {item.label} — {localFileTypeLabel(item.fileType, true)}: {item.path}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {manualOpen && (
                    <div className={`px-6 pb-6 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <fieldset
                            disabled={manualLocked}
                            className={`pt-5 space-y-4 transition-opacity ${manualLocked ? 'opacity-55' : ''}`}
                        >
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                        Genome label *
                                    </label>
                                    <input
                                        type="text"
                                        value={manualSpeciesLabel}
                                        onChange={(e) => setManualSpeciesLabel(e.target.value)}
                                        placeholder="e.g. Human reference"
                                        className={`w-full px-3 py-2 rounded-lg text-xs border ${isLight
                                            ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
                                            : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                            }`}
                                    />
                                </div>
                                <div>
                                    <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                        Assembly label *
                                    </label>
                                    <input
                                        type="text"
                                        value={manualAssemblyLabel}
                                        onChange={(e) => setManualAssemblyLabel(e.target.value)}
                                        placeholder="e.g. GRCh38.p14"
                                        className={`w-full px-3 py-2 rounded-lg text-xs border ${isLight
                                            ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
                                            : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                            }`}
                                    />
                                </div>
                                <div>
                                    <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                        Assembly accession (optional)
                                    </label>
                                    <input
                                        type="text"
                                        value={manualGca}
                                        onChange={(e) => setManualGca(e.target.value)}
                                        placeholder="e.g. GCA_000001405.29 or GCF_000001405.40"
                                        className={`w-full px-3 py-2 rounded-lg text-xs border ${isLight
                                            ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
                                            : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                            }`}
                                    />
                                </div>
                            </div>

                            <ManualPathRow
                                label="FASTA file *"
                                value={manualFasta}
                                onBrowse={() => openManualBrowser('manual_fasta', 'file')}
                                placeholder="/path/to/genome.fa.gz"
                                isLight={isLight}
                                validating={validation.genome?.status === 'queued' || validation.genome?.status === 'running'}
                                onValidate={() => runValidation('genome', 'genome', { fasta_path: manualFasta })}
                            />

                            {validation.genome ? (
                                <ValidationReportPanel
                                    kind="genome"
                                    theme={theme}
                                    status={validation.genome.status}
                                    progress={validation.genome.progress}
                                    stage={validation.genome.stage}
                                    message={validation.genome.message}
                                    counters={validation.genome.counters}
                                    report={validation.genome.report}
                                    error={validation.genome.error}
                                    analysedAt={validation.genome.analysed_at}
                                    onClose={() => closeValidation('genome')}
                                />
                            ) : null}

                            <ManualPathRow
                                label="Annotation file (optional)"
                                value={manualGff3}
                                onBrowse={() => openManualBrowser('manual_gff3', 'file')}
                                placeholder="/path/to/genes.gff3.gz"
                                isLight={isLight}
                                hint="GFF3, GFF or GTF. Without one the genome still opens; only the gene track is empty."
                                validating={validation.annotation?.status === 'queued' || validation.annotation?.status === 'running'}
                                onValidate={() => runValidation('annotation', 'annotation', {
                                    annotation_path: manualGff3,
                                    fasta_path: manualFasta || null,
                                })}
                            />

                            {validation.annotation ? (
                                <ValidationReportPanel
                                    kind="annotation"
                                    theme={theme}
                                    status={validation.annotation.status}
                                    progress={validation.annotation.progress}
                                    stage={validation.annotation.stage}
                                    message={validation.annotation.message}
                                    counters={validation.annotation.counters}
                                    report={validation.annotation.report}
                                    error={validation.annotation.error}
                                    analysedAt={validation.annotation.analysed_at}
                                    onClose={() => closeValidation('annotation')}
                                />
                            ) : null}

                            <ManualPathRow
                                label="Homology TSV file (optional)"
                                value={manualHomology}
                                onBrowse={() => openManualBrowser('manual_homology', 'file')}
                                placeholder="/path/to/homology.tsv.gz"
                                isLight={isLight}
                            />

                            <div>
                                <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Suggested index path
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={manualIndexPath || ''}
                                        readOnly
                                        disabled={!manualGff3}
                                        placeholder="Will be set when an annotation is selected"
                                        className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono disabled:cursor-not-allowed ${!manualGff3
                                            ? (isLight
                                                ? 'bg-gray-100 border-gray-200 text-gray-400 placeholder-gray-400'
                                                : 'bg-gray-800 border-gray-700 text-gray-500 placeholder-gray-500')
                                            : (isLight
                                                ? 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                                                : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500')
                                            }`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => openManualBrowser('manual_index', 'file-or-directory')}
                                        disabled={!manualGff3}
                                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors disabled:cursor-not-allowed ${isLight
                                            ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                                            : 'bg-gray-700 text-gray-200 border-gray-500 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                                            }`}
                                    >
                                        Browse
                                    </button>
                                </div>
                                <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Choose a directory to keep the suggested filename, or select a specific index file.
                                </p>
                            </div>

                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3">
                                <div
                                    className={`min-h-5 flex-1 text-xs text-right ${manualOperation.status === 'error'
                                        ? (isLight ? 'text-red-600' : 'text-red-300')
                                        : (isLight ? 'text-gray-600' : 'text-gray-300')
                                        }`}
                                    role="status"
                                    aria-live="polite"
                                >
                                    {manualOperation.kind === 'single' ? manualStatusText : ''}
                                </div>
                                <button
                                    type="button"
                                    onClick={addManualGenome}
                                    disabled={
                                        !manualSpeciesLabel.trim()
                                        || !manualAssemblyLabel.trim()
                                        || !manualFasta
                                        || manualLocked
                                    }
                                    className={`min-w-[132px] inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${isLight
                                        ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                                        : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                                        }`}
                                >
                                    {manualOperation.kind === 'single' && manualLocked ? (
                                        <ProgressGlyph
                                            size={14}
                                            progress={Math.max(0, Math.min(1, manualOperation.progress / 100))}
                                            renderGlyph={(props) => <AddGenomeGlyph {...props} />}
                                        />
                                    ) : null}
                                    {manualOperation.kind === 'single' && manualOperation.status === 'success'
                                        ? 'Added'
                                        : manualOperation.kind === 'single' && manualProcessing
                                            ? 'Adding…'
                                            : 'Add genome'}
                                </button>
                            </div>
                        </fieldset>
                    </div>
                )}

                {/* Export lives outside the collapse gate: it acts on the current
                    selection, not on the add form, so folding the form away must
                    not hide it. */}
                <div className={`px-6 py-5 border-t ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                    <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Export genome configuration
                    </label>
                    <p className={`mb-2 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Exports the details for all currently selected genomes
                        {exportSelectionCount > 0 ? ` (${exportSelectionCount})` : ''}.
                    </p>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={bundleExportPath}
                            onChange={(event) => {
                                bundleExportPathTouchedRef.current = true
                                setBundleExportConflict(null)
                                setBundleExportPath(event.target.value)
                            }}
                            placeholder="/path/to/genomes.json"
                            className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${isLight
                                ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400'
                                : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                                }`}
                        />
                        <button
                            type="button"
                            onClick={() => openManualBrowser('bundle_export_path', 'save')}
                            className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${isLight
                                ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                                : 'bg-gray-700 text-gray-200 border-gray-500 hover:bg-gray-600'
                                }`}
                        >
                            Browse
                        </button>
                        <button
                            type="button"
                            onClick={() => exportGenomeBundle('create')}
                            disabled={!bundleExportPath.trim() || exportSelectionCount === 0 || manualProcessing}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                                ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                                : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                                }`}
                        >
                            Export
                        </button>
                    </div>

                    {bundleExportConflict ? (
                        <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${isLight
                            ? 'border-amber-300 bg-amber-50 text-amber-900'
                            : 'border-amber-700/60 bg-amber-900/20 text-amber-100'
                            }`}>
                            <div className="font-semibold break-words">{bundleExportConflict.detail}</div>
                            <p className="mt-1 opacity-80 break-all">{bundleExportConflict.path}</p>
                            <p className="mt-1 opacity-80">
                                Amending adds the selected genomes to the existing file, refreshing any
                                that are already in it rather than duplicating them.
                            </p>
                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => exportGenomeBundle('merge')}
                                    className={`px-3 py-1.5 rounded text-xs font-semibold text-white transition-colors ${isLight ? 'bg-[#0099ff] hover:bg-[#0088ee]' : 'bg-blue-600 hover:bg-blue-500'}`}
                                >
                                    Amend file
                                </button>
                                <button
                                    type="button"
                                    onClick={() => exportGenomeBundle('overwrite')}
                                    className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${isLight
                                        ? 'bg-white border-amber-400 text-amber-800 hover:bg-amber-100'
                                        : 'bg-transparent border-amber-600 text-amber-100 hover:bg-amber-900/40'
                                        }`}
                                >
                                    Replace file
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBundleExportConflict(null)}
                                    className="px-2 py-1.5 rounded text-xs font-medium opacity-70 hover:opacity-100"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {manualOperation.kind === 'export' && manualOperation.message ? (
                        <div
                            className={`mt-3 rounded-lg border px-3 py-2 text-xs ${manualOperation.status === 'error'
                                ? (isLight ? 'border-red-200 bg-red-50 text-red-800' : 'border-red-800/60 bg-red-900/20 text-red-200')
                                : (isLight ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-gray-700 bg-gray-900/40 text-gray-300')
                                }`}
                            role="status"
                            aria-live="polite"
                        >
                            <span className="break-words">{manualStatusText}</span>
                        </div>
                    ) : null}
                </div>
            </div>

            {removalMode ? (
                <div className={`order-2 mb-3 rounded-xl border px-4 py-3 ${isLight
                    ? 'border-red-300 bg-red-50'
                    : 'border-red-900/60 bg-red-900/20'
                    }`}>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className={`text-sm font-bold ${isLight ? 'text-red-800' : 'text-red-200'}`}>
                            Flag genomes to remove
                        </div>
                        <div className={`text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>
                            {removalKeys.size === 0
                                ? 'Click rows, or use a shortcut below.'
                                : `${removalKeys.size} flagged`}
                        </div>
                        <div className="flex items-center gap-1.5 ml-auto">
                            {[
                                { action: REMOVAL_FILL_ALL, label: `All ${selectableFilteredCount}` },
                                { action: REMOVAL_FILL_SELECTED, label: `Selected ${selectedFilteredCount}` },
                            ].map(({ action, label }) => (
                                <button
                                    key={action}
                                    type="button"
                                    disabled={action === REMOVAL_FILL_SELECTED && selectedFilteredCount === 0}
                                    onClick={() => handleRemovalFillToggle(action)}
                                    aria-pressed={removalFillMode === action}
                                    className={`px-2.5 py-1.5 rounded text-xs font-semibold border transition-colors ${action === REMOVAL_FILL_SELECTED && selectedFilteredCount === 0
                                        ? (isLight ? 'bg-white border-red-200 text-red-300 cursor-not-allowed' : 'bg-transparent border-red-900/50 text-red-800 cursor-not-allowed')
                                        : removalFillMode === action
                                            ? 'bg-red-600 border-red-600 text-white hover:bg-red-500'
                                            : (isLight
                                                ? 'bg-white border-red-300 text-red-800 hover:bg-red-100'
                                                : 'bg-transparent border-red-800 text-red-200 hover:bg-red-900/40')
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                            <button
                                type="button"
                                disabled={removalKeys.size === 0}
                                onClick={() => openRemovalDialog(flaggedItems(allAssemblies, removalKeys), 'bulk')}
                                className={`px-3 py-1.5 rounded text-xs font-bold transition-colors ${removalKeys.size === 0
                                    ? (isLight ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-700 text-gray-500 cursor-not-allowed')
                                    : 'bg-red-600 text-white hover:bg-red-500'
                                    }`}
                            >
                                Summary
                            </button>
                            <button
                                type="button"
                                disabled={removalKeys.size === 0}
                                onClick={() => runRemoval(
                                    flaggedItems(allAssemblies, removalKeys),
                                    { deleteData: true, includeManual: true },
                                )}
                                className={`px-3 py-1.5 rounded text-xs font-bold transition-colors ${removalKeys.size === 0
                                    ? (isLight ? 'bg-gray-200 text-gray-400 cursor-not-allowed' : 'bg-gray-700 text-gray-500 cursor-not-allowed')
                                    : 'bg-red-600 text-white hover:bg-red-500'
                                    }`}
                                title="Delete affected files and deregister the flagged genomes without opening the summary"
                            >
                                Delete
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setRemovalMode(false)
                                    setRemovalKeys(new Set())
                                    setRemovalFillMode(null)
                                }}
                                className={`px-2.5 py-1.5 rounded text-xs font-medium ${isLight ? 'text-red-800 hover:bg-red-100' : 'text-red-200 hover:bg-red-900/40'}`}
                            >
                                Exit
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {removalRun ? (
                <div className={`order-2 mb-3 rounded-xl border px-4 py-3 text-xs ${removalRun.status === 'error'
                    ? (isLight ? 'border-red-200 bg-red-50 text-red-800' : 'border-red-800/60 bg-red-900/20 text-red-200')
                    : (isLight ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-gray-700 bg-gray-900/40 text-gray-300')
                    }`} role="status" aria-live="polite">
                    <div className="flex items-center gap-2">
                        <span className="font-semibold">
                            {removalRun.status === 'running'
                                ? `Deleting data… ${removalRun.completed}/${removalRun.total}`
                                : removalRun.status === 'error'
                                    ? `${removalRun.failures.length} of ${removalRun.total} genomes had files that could not be deleted`
                                    : `Deleted data for ${removalRun.total} genome${removalRun.total === 1 ? '' : 's'}${removalRun.freed ? ` — ${formatBytes(removalRun.freed)} freed` : ''}`}
                        </span>
                        {removalRun.status !== 'running' ? (
                            <button
                                type="button"
                                onClick={() => setRemovalRun(null)}
                                className="ml-auto px-2 py-1 rounded font-medium opacity-70 hover:opacity-100"
                            >
                                Dismiss
                            </button>
                        ) : null}
                    </div>
                    {removalRun.status === 'error' ? (
                        <ul className="mt-2 space-y-1">
                            {removalRun.failures.slice(0, 6).map((row) => (
                                <li key={row.genome_key} className="break-all">
                                    <span className="font-mono">{row.genome_key}</span>
                                    {' — '}
                                    {(row.failed || []).map((failure) => failure.error).filter(Boolean).join('; ')}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}

            <div className={`order-2 flex-none h-[560px] min-h-[560px] rounded-xl border overflow-hidden flex flex-col ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'}`}>
                {loading ? (
                    <div className={`flex-1 flex flex-col items-center justify-center gap-3 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                        <div className={`animate-spin w-8 h-8 border-4 border-t-transparent rounded-full ${isLight ? 'border-blue-500' : 'border-blue-400'}`}></div>
                        <div className="text-sm font-medium">Loading genomes…</div>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className={`flex-1 flex items-center justify-center p-8 text-center ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        <div>
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mx-auto mb-4 opacity-50">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="9" y1="3" x2="9" y2="21"></line>
                            </svg>
                            <h2 className={`text-lg font-bold mb-1 mt-4 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{emptyStateTitle}</h2>
                            <p className="text-sm opacity-80 mt-2">{emptyStateMessage}</p>
                        </div>
                    </div>
                ) : (
                    <>
                        <div ref={tableScrollRef} className="overflow-x-auto overflow-y-auto flex-1 min-h-0">
                            <table className="w-full text-sm">
                                <thead className={`sticky top-0 z-10 ${isLight ? 'bg-gray-50' : 'bg-gray-800'}`}>
                                    <tr className={`border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                                        {/* No column label: the select-all box sits directly above the
                                            per-genome boxes, which says what it does more plainly than
                                            a word that pushed it off centre. */}
                                        <th className={`${thCenteredClass} w-16`}>
                                            <input
                                                type="checkbox"
                                                checked={selectAllChecked}
                                                onChange={handleSelectAllToggle}
                                                disabled={selectableFilteredCount === 0}
                                                aria-label={selectAllChecked
                                                    ? 'Deselect all genomes'
                                                    : 'Select all genomes matching the filter'}
                                                title={selectAllChecked
                                                    ? `Deselect all ${selectableFilteredCount} genomes`
                                                    : `Select all ${selectableFilteredCount} genomes matching the filter`}
                                                className={`w-4 h-4 align-middle rounded border-gray-300 text-blue-600 focus:ring-blue-500 ${selectableFilteredCount === 0 ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                                            />
                                        </th>
                                        <th className={thClass}>Species</th>
                                        <th className={thClass}>Source</th>
                                        <th className={thClass}>Accession</th>
                                        <th className={thClass}>Assembly</th>
                                        <th className={thClass}>Files</th>
                                        <th className={thClass}>Index</th>
                                        <th className={`${thCenteredClass} w-32 min-w-[8rem]`}>
                                            {/* Same 72px two-slot box as every row's action cell, so the
                                                bulk-removal bin sits in the same column as the row bins. */}
                                            <div className="mx-auto inline-flex w-[72px] items-center justify-center gap-1 align-middle">
                                                <span aria-hidden="true" className="h-8 w-8 flex-none" />
                                                <button
                                                    type="button"
                                                    onClick={toggleRemovalMode}
                                                    title={removalMode
                                                        ? 'Leave removal mode'
                                                        : 'Flag several genomes to remove'}
                                                    className={`w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors ${removalMode
                                                        ? (isLight ? 'bg-red-100 text-red-700' : 'bg-red-900/50 text-red-300')
                                                        : (isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20')
                                                        }`}
                                                >
                                                    <IconTrash size={16} />
                                                </button>
                                            </div>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
	                                    {pageItems.map((item) => {
	                                        const key = itemKey(item)
	                                        const rowKey = String(item?.assembly_key || key || '').trim()
	                                        const isMissing = Boolean(item?.is_missing)
	                                        const isSelected = selectedGenomeKeys.has(key)
			                                        const isPendingSelection = pendingSelectionKeys.has(key)
			                                        const isFlaggedForRemoval = removalKeys.has(key)
			                                        const effectiveFiles = getEffectiveFiles(item)
                                                    const fileAnalysisByType = getFileAnalysisByType(item, effectiveFiles)
			                                        const filesExpanded = expandedRows.has(rowKey)
	                                        const datasetInstances = (
	                                            Array.isArray(item?.dataset_instances) && item.dataset_instances.length > 0
	                                                ? item.dataset_instances
	                                                : [item]
	                                        )
	                                            .map((instance) => {
	                                                const normalized = normalizeGenomeRecord(instance)
	                                                return { ...normalized, files: getEffectiveFiles(normalized) }
	                                            })
	                                            .filter((instance) => instance?.files?.gff3)
	                                        const indexableDatasetInstances = datasetInstances.filter((instance) => instance?.files?.gff3)
	                                        const allDatasetIndexesBuilt = indexableDatasetInstances.length > 0 && indexableDatasetInstances.every((instance) => Boolean(instance?.files?.index))
	                                        const anyDatasetIndexing = indexableDatasetInstances.some((instance) => indexingSet.has(itemKey(instance)))
	                                        const parentIndexStatus = (
	                                            indexableDatasetInstances.find((instance) => indexingSet.has(itemKey(instance)) && indexTaskStatusByKey[itemKey(instance)] === 'queued')
	                                                ? 'queued'
	                                                : 'running'
	                                        )
	                                        const canImportCustomAnnotation = !item.is_manual && Boolean(config.output_dir)

	                                        return (
	                                            <React.Fragment key={rowKey}>
                                            <tr
                                                onClick={() => {
                                                    if (isMissing) return
                                                    // In removal mode a click curates the removal set
                                                    // rather than changing what the app is working with.
                                                    if (removalMode) {
                                                        setRemovalFillMode(null)
                                                        setRemovalKeys((prev) => toggleRemovalFlag(prev, item))
                                                    }
                                                    else toggleSpecies(item)
                                                }}
                                                className={`border-b transition-colors group ${isMissing
                                                    ? (isLight ? 'bg-gray-50/80 border-gray-100' : 'bg-gray-900/20 border-gray-700/50')
                                                    : isFlaggedForRemoval
                                                        ? (isLight ? 'bg-red-50 hover:bg-red-100 border-red-100 cursor-pointer' : 'bg-red-900/20 hover:bg-red-900/30 border-red-900/40 cursor-pointer')
                                                        : (isLight
                                                            ? (isSelected ? 'bg-blue-50/50 hover:bg-blue-50 border-gray-100 cursor-pointer' : 'border-gray-100 hover:bg-gray-50 cursor-pointer')
                                                            : (isSelected ? 'bg-blue-900/10 hover:bg-blue-900/20 border-gray-700/50 cursor-pointer' : 'border-gray-700/50 hover:bg-gray-700/30 cursor-pointer'))
                                                    }`}
                                            >
                                                <td className="px-4 py-3 text-center align-middle" onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        checked={!isMissing && (isSelected || isPendingSelection)}
                                                        disabled={isMissing}
                                                        readOnly
                                                        onMouseDown={(e) => e.preventDefault()}
	                                                        onClick={(e) => {
	                                                            e.stopPropagation()
	                                                            if (isMissing) return
	                                                            toggleSpecies(item, { removeSelected: true })
	                                                        }}
                                                        className={`w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 ${isMissing ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                                                    />
                                                </td>
                                                <td className={`px-4 py-3 align-middle ${isMissing
                                                    ? (isLight ? 'text-gray-500' : 'text-gray-400')
                                                    : (isLight ? 'text-gray-900' : 'text-gray-100')
                                                    }`}>
                                                    <div className="font-medium leading-tight flex items-center gap-2">
                                                        <span>{item.scientific_name}</span>
                                                        {item.is_manual && (
                                                            <span
                                                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/40 text-indigo-300'}`}
                                                                title={registrationBadgeTooltip(item)}
                                                            >
                                                                {registrationBadgeLabel(item)}
                                                            </span>
                                                        )}
                                                        {item.is_manual && item.missing_files?.length ? (
                                                            <span
                                                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-900/30 text-amber-300'}`}
                                                                title={item.missing_files
                                                                    .map((entry) => `${entry.field}: ${entry.path}`)
                                                                    .join('\n')}
                                                            >
                                                                {item.missing_files.length} missing
                                                            </span>
                                                        ) : null}
                                                        {item.retired_remote && !isMissing && (
                                                            <span
                                                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isLight ? 'bg-amber-100 text-amber-700' : 'bg-amber-900/30 text-amber-300'}`}
                                                                title="This genome remains available locally but is no longer present in the current Ensembl Beta FTP catalogue."
                                                            >
                                                                Retired upstream
                                                            </span>
                                                        )}
                                                        {isMissing && (
                                                            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>
                                                                Missing
                                                            </span>
                                                        )}
                                                    </div>
                                                    {item.common_name && (
                                                        <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{item.common_name}</div>
                                                    )}
                                                </td>
                                                <td className={`px-4 py-3 text-xs align-middle ${isMissing
                                                    ? (isLight ? 'text-gray-400' : 'text-gray-500')
                                                    : (isLight ? 'text-gray-700' : 'text-gray-300')
                                                    }`}>
                                                    {item.source_database || normalizeGenomeSourceDatabase(item)}
                                                </td>
                                                <td className={`px-4 py-3 font-mono text-xs align-middle ${isMissing
                                                    ? (isLight ? 'text-gray-400' : 'text-gray-500')
                                                    : (isLight ? 'text-gray-600' : 'text-gray-400')
                                                    }`}>{getAssemblyAccession(item) || '-'}</td>
                                                <td className={`px-4 py-3 text-xs align-middle ${isMissing
                                                    ? (isLight ? 'text-gray-400' : 'text-gray-500')
                                                    : (isLight ? 'text-gray-700' : 'text-gray-300')
                                                    }`}>{item.assembly_name}</td>
                                                <td className="px-4 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                                                    {isMissing ? (
                                                        <div className={`text-xs italic ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>Missing locally</div>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                                                            onClick={(e) => {
                                                                e.stopPropagation()
	                                                                setExpandedRows((prev) => {
	                                                                    const next = new Set(prev)
	                                                                    next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey)
	                                                                    return next
	                                                                })
                                                            }}
	                                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${filesExpanded
	                                                                ? (isLight ? 'text-blue-700 bg-blue-50 border border-blue-100' : 'text-blue-300 bg-blue-900/20 border border-blue-900/40')
	                                                                : (isLight ? 'text-gray-700 bg-white border border-gray-200 hover:border-blue-300 hover:text-blue-700' : 'text-gray-300 bg-gray-800 border border-gray-700 hover:border-blue-700 hover:text-blue-300')
	                                                            }`}
	                                                            title={filesExpanded ? 'Collapse files' : 'Expand files'}
	                                                            aria-label={filesExpanded ? 'Collapse files' : 'Expand files'}
	                                                        >
	                                                            <IconChevron open={filesExpanded} size={13} />
	                                                        </button>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                                                    {isMissing ? (
                                                        <span className={`text-xs italic ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>Unavailable</span>
	                                                    ) : (() => {
		                                                        const canBuildAnyIndex = indexableDatasetInstances.length > 0
		                                                        if (anyDatasetIndexing) {
		                                                            if (parentIndexStatus === 'queued') {
		                                                                return (
		                                                                    <div className="flex items-center gap-1.5 text-[10px] text-blue-600">
		                                                                        <div className="w-3 h-3 rounded-full border-2 border-blue-300" />
	                                                                        Queued…
	                                                                    </div>
	                                                                )
	                                                            }
	                                                            return (
	                                                                <div className="flex items-center gap-1.5 text-[10px] text-blue-600">
	                                                                    <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                                                    Building…
                                                                </div>
                                                            )
                                                        }
	                                                        return (
	                                                            <button
	                                                                type="button"
	                                                                onClick={() => buildIndexesForGenomeDatasets(indexableDatasetInstances, { force: allDatasetIndexesBuilt })}
	                                                                disabled={!canBuildAnyIndex}
	                                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${canBuildAnyIndex
	                                                                    ? (allDatasetIndexesBuilt
	                                                                        ? (isLight ? 'text-blue-700 bg-blue-50 border-blue-100 hover:bg-blue-100' : 'text-blue-300 bg-blue-900/20 border-blue-900/40 hover:bg-blue-900/30')
	                                                                        : (isLight ? 'text-blue-700 bg-white border-blue-100 hover:bg-blue-50' : 'text-blue-300 bg-gray-800 border-blue-900/40 hover:bg-blue-900/20'))
	                                                                    : 'bg-gray-100 text-gray-400 opacity-50 cursor-default'
	                                                                    }`}
	                                                                title={canBuildAnyIndex ? (allDatasetIndexesBuilt ? 'Rebuild indexes for all annotation datasets' : 'Build missing annotation dataset indexes') : 'No GFF3 file available'}
	                                                            >
	                                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
	                                                                {allDatasetIndexesBuilt ? 'Rebuild' : 'Build'}
	                                                            </button>
	                                                        )
                                                    })()}
                                                </td>
                                                <td className="px-2 py-3 align-middle text-center w-32 min-w-[8rem]" onClick={(e) => e.stopPropagation()}>
                                                    {isMissing ? (
                                                        canDownloadPlaylistGenome(item) ? (
                                                            <button
                                                                type="button"
                                                                disabled={downloadingMissingKeys.has(key)}
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault()
                                                                    event.stopPropagation()
                                                                }}
                                                                onClick={() => handleDownloadMissingGenomes([item])}
                                                                className={`px-3 py-1.5 rounded text-[11px] font-bold uppercase tracking-wide transition-colors ${downloadingMissingKeys.has(key)
                                                                    ? (isLight ? 'bg-gray-100 text-gray-400 cursor-wait' : 'bg-gray-800 text-gray-500 cursor-wait')
                                                                    : (isLight ? 'bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-300' : 'bg-amber-800/40 text-amber-200 hover:bg-amber-800/60 border border-amber-700')
                                                                }`}
                                                                title="Download FASTA and GFF3 for this missing playlist genome"
                                                            >
                                                                {downloadingMissingKeys.has(key) ? 'Queued' : 'Download'}
                                                            </button>
                                                        ) : (
                                                            <span
                                                                className={`text-xs italic ${isLight ? 'text-gray-400' : 'text-gray-500'}`}
                                                                title="This playlist genome does not have enough remote metadata to download automatically."
                                                            >
                                                                Not downloadable
                                                            </span>
                                                        )
                                                    ) : removalMode ? (
                                                        <label
                                                            className="mx-auto inline-flex w-[72px] items-center justify-center gap-1 cursor-pointer"
                                                            onMouseDown={(event) => event.preventDefault()}
                                                            title={isFlaggedForRemoval ? 'Flagged for deletion' : 'Keep this genome'}
                                                        >
                                                            <span className="inline-flex h-8 w-8 flex-none items-center justify-center">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isFlaggedForRemoval}
                                                                    onChange={() => {
                                                                        setRemovalFillMode(null)
                                                                        setRemovalKeys((prev) => toggleRemovalFlag(prev, item))
                                                                    }}
                                                                    className="w-5 h-5 rounded border-red-400 text-red-600 focus:ring-red-500 cursor-pointer"
                                                                />
                                                            </span>
                                                            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${isFlaggedForRemoval
                                                                ? (isLight ? 'text-red-700' : 'text-red-300')
                                                                : (isLight ? 'text-gray-400' : 'text-gray-500')
                                                                }`}>
                                                                <IconTrash size={16} />
                                                            </span>
                                                        </label>
                                                    ) : (
	                                                        <div className="mx-auto inline-flex w-[72px] items-center justify-center gap-1">
	                                                            <button
	                                                                type="button"
	                                                                onMouseDown={(event) => {
	                                                                    event.preventDefault()
                                                                    event.stopPropagation()
                                                                }}
                                                                onClick={() => setPlaylistMembershipTarget(item)}
                                                                className={`w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors ${isLight
                                                                    ? 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
                                                                    : 'text-gray-500 hover:text-blue-300 hover:bg-blue-900/20'
                                                                    }`}
	                                                                title="Add to playlists"
	                                                            >
	                                                                <AppButtonIcon buttonId="genome_playlist" isLight={isLight} compact size={15} />
	                                                            </button>
                                                            <button
                                                                type="button"
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault()
                                                                    event.stopPropagation()
                                                                }}
                                                                onClick={() => openRemovalDialog([item], 'row')}
                                                                className={`w-8 h-8 inline-flex items-center justify-center rounded-lg transition-colors ${isLight
                                                                    ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
                                                                    : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'
                                                                    }`}
                                                                title={item.is_manual ? 'Remove this genome' : 'Remove this genome or delete its data'}
                                                            >
                                                                <IconTrash size={16} />
                                                            </button>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
	                                            {filesExpanded && !isMissing && (
	                                                <tr key={`${rowKey}-files`}>
                                                    <td colSpan={8} className={`px-6 py-3 border-b ${isLight ? 'bg-gray-50/80 border-gray-100' : 'bg-gray-900/30 border-gray-700/50'}`} onClick={(e) => e.stopPropagation()}>
                                                        <div className="space-y-4">
                                                            {!item.is_manual && (
                                                            <div className={`rounded-lg border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/60 border-gray-700'}`}>
                                                                <div className={`px-3 py-2 border-b flex items-center justify-between gap-3 ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                                                    <div className="min-w-0">
                                                                        <div className={`text-xs font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                                            Datasets
                                                                        </div>
                                                                        <div className={`text-[11px] mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                                            {datasetInstances.length} available
                                                                        </div>
                                                                    </div>
                                                                    {canImportCustomAnnotation && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => openCustomAnnotationModal(item)}
                                                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${isLight
                                                                                ? 'text-blue-700 bg-white border-blue-100 hover:bg-blue-50'
                                                                                : 'text-blue-300 bg-gray-800 border-blue-900/40 hover:bg-blue-900/20'
                                                                                }`}
                                                                        >
                                                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                                                <path d="M12 5v14M5 12h14" />
                                                                            </svg>
                                                                            Add custom annotation
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                {datasetInstances.length === 0 ? (
                                                                    <div className={`px-3 py-3 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                                        No annotation datasets found.
                                                                    </div>
                                                                ) : (
                                                                    <div className={`divide-y ${isLight ? 'divide-gray-100' : 'divide-gray-700/60'}`}>
	                                                                        {datasetInstances.map((instance) => {
	                                                                            const instanceKey = itemKey(instance)
	                                                                            const instanceFiles = instance.files || getEffectiveFiles(instance)
	                                                                            const instanceSelected = selectedGenomeKeys.has(instanceKey)
	                                                                            const instancePending = pendingSelectionKeys.has(instanceKey)
	                                                                            const instanceIsIndexing = indexingSet.has(instanceKey)
                                                                            const instanceIndexStatus = indexTaskStatusByKey[instanceKey] || 'running'
                                                                            const hasIndex = !!instanceFiles?.index
                                                                            const releaseBadge = instance.dataset_release_short_label || formatDatasetReleaseShortLabel(instance) || 'default'
                                                                            const releaseLabel = instance.dataset_release_label || instance.dataset_release_key || releaseBadge
                                                                            const releaseSource = instance.dataset_release_source === 'custom'
                                                                                ? 'Custom'
                                                                                : (instance.dataset_release_source || normalizeGenomeSourceDatabase(instance))

	                                                                            return (
	                                                                                <div
	                                                                                    key={instanceKey}
	                                                                                    className={`grid items-center gap-3 px-3 py-2 text-xs ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/30'}`}
	                                                                                    style={{ gridTemplateColumns: 'minmax(220px, 1.45fr) minmax(150px, 0.8fr) 118px 104px' }}
	                                                                                >
                                                                                    <label className="min-w-0 flex items-center gap-2 cursor-pointer">
                                                                                        <input
                                                                                            type="checkbox"
                                                                                            checked={instanceSelected || instancePending}
                                                                                            readOnly
                                                                                            onMouseDown={(event) => event.preventDefault()}
                                                                                            onClick={(event) => {
                                                                                                event.stopPropagation()
                                                                                                toggleSpecies({ ...instance, files: instanceFiles }, { removeSelected: true })
                                                                                            }}
                                                                                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                                                        />
                                                                                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold ${isLight ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-blue-900/30 text-blue-200 border border-blue-800/60'}`}>
                                                                                            {releaseBadge}
                                                                                        </span>
                                                                                        <span className={`truncate font-semibold ${isLight ? 'text-gray-800' : 'text-gray-200'}`} title={releaseLabel}>
                                                                                            {releaseLabel}
                                                                                        </span>
                                                                                    </label>
	                                                                                    <div className="min-w-0 flex items-center gap-2">
	                                                                                        <span className={`truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={instance.dataset_release_key || releaseSource}>
	                                                                                            {releaseSource}
	                                                                                        </span>
	                                                                                    </div>
	                                                                                    <div className="flex items-center justify-end">
	                                                                                        {instance.is_default_dataset ? (
	                                                                                            <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-semibold uppercase ${isLight ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-emerald-900/25 text-emerald-300 border border-emerald-900/50'}`}>
	                                                                                                DEFAULT
	                                                                                            </span>
	                                                                                        ) : (
	                                                                                            <button
	                                                                                                type="button"
	                                                                                                onClick={(event) => {
	                                                                                                    event.stopPropagation()
	                                                                                                    makeDatasetDefault(item, instance, rowKey)
	                                                                                                }}
	                                                                                                className={`inline-flex items-center px-2 py-1 rounded text-[10px] font-semibold uppercase border transition-colors ${isLight
	                                                                                                    ? 'text-gray-400 bg-gray-50 border-gray-200 hover:text-gray-700 hover:bg-white hover:border-gray-400'
	                                                                                                    : 'text-gray-500 bg-gray-800 border-gray-700 hover:text-gray-100 hover:bg-gray-800 hover:border-white'
	                                                                                                }`}
	                                                                                                title="Make this annotation dataset the default"
	                                                                                            >
	                                                                                                DEFAULT
	                                                                                            </button>
	                                                                                        )}
	                                                                                    </div>
	                                                                                    <div className="flex items-center justify-end">
	                                                                                        {instanceIsIndexing ? (
                                                                                            <div className="flex items-center gap-1.5 text-[10px] text-blue-600">
                                                                                                <div className={instanceIndexStatus === 'queued'
                                                                                                    ? 'w-3 h-3 rounded-full border-2 border-blue-300'
                                                                                                    : 'w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin'}
                                                                                                />
                                                                                                {instanceIndexStatus === 'queued' ? 'Queued...' : 'Building...'}
                                                                                            </div>
                                                                                        ) : (
	                                                                                            <button
	                                                                                                type="button"
	                                                                                                onClick={() => hasIndex ? rebuildIndexForGenome({ ...instance, files: instanceFiles }) : ensureIndexForGenome({ ...instance, files: instanceFiles })}
	                                                                                                disabled={!instanceFiles?.gff3}
                                                                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${instanceFiles?.gff3
                                                                                                    ? (hasIndex
                                                                                                        ? (isLight ? 'text-blue-700 bg-blue-50 border-blue-100 hover:bg-blue-100' : 'text-blue-300 bg-blue-900/20 border-blue-900/40 hover:bg-blue-900/30')
                                                                                                        : (isLight ? 'text-blue-700 bg-white border-blue-100 hover:bg-blue-50' : 'text-blue-300 bg-gray-800 border-blue-900/40 hover:bg-blue-900/20'))
                                                                                                    : 'bg-gray-100 text-gray-400 opacity-50 cursor-default'
                                                                                                    }`}
                                                                                                title={instanceFiles?.gff3 ? (hasIndex ? `Rebuild index: ${instanceFiles.index}` : 'Generate index for this dataset') : 'No GFF3 file available'}
                                                                                            >
                                                                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                                                                                {hasIndex ? 'Rebuild' : 'Build'}
                                                                                            </button>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                            )
                                                                        })}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            )}
                                                            <div className="space-y-2">
                                                                <div className={`text-xs font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                                    {item.is_manual ? 'Genome files' : 'Default dataset file paths'}
                                                                </div>
                                                                <GenomeFileEditor
                                                                    item={item}
                                                                    effectiveFiles={effectiveFiles}
                                                                    isLight={isLight}
                                                                    theme={theme}
                                                                    confirmDeleteFile={confirmDeleteFile}
                                                                    setConfirmDeleteFile={setConfirmDeleteFile}
                                                                    onDeleteFile={handleDeleteSingleFile}
                                                                    analysisByType={fileAnalysisByType}
                                                                    onAnalyse={(fileType) => analyseGenomeFile(item, fileType, effectiveFiles)}
                                                                    onBrowse={(fileType) => {
                                                                        setModalTarget(`genome_edit:${key}:${fileType}`)
                                                                        setModalMode('file')
                                                                        setFileBrowserEditTarget({ genomeKey: key, fileType, item })
                                                                        setModalOpen(true)
                                                                    }}
                                                                    onSavePath={(fileType, newPath) => saveFileOverride(item, fileType, newPath)}
                                                                />
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                            </React.Fragment>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {totalPages > 1 && (
                            <div className={`px-6 py-3 border-t flex items-center justify-between flex-none ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                                <button
                                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                                    disabled={page === 1}
                                    className={`px-4 py-1.5 text-sm font-medium rounded-lg border transition-colors ${page === 1
                                        ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                        : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                >
                                    &larr; Previous
                                </button>
                                <span className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Page <strong className={isLight ? 'text-gray-900' : 'text-gray-100'}>{page}</strong> of <strong className={isLight ? 'text-gray-900' : 'text-gray-100'}>{totalPages}</strong>
                                    <span className="ml-3 opacity-60">
                                        ({((page - 1) * LOCAL_PAGE_SIZE) + 1}&ndash;{Math.min(page * LOCAL_PAGE_SIZE, filteredSorted.length)} of {filteredSorted.length})
                                    </span>
                                </span>
                                <button
                                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                    disabled={page === totalPages}
                                    className={`px-4 py-1.5 text-sm font-medium rounded-lg border transition-colors ${page === totalPages
                                        ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                        : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                >
                                    Next &rarr;
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
            <ScreenshotSelectionOverlay
                active={screenshotMode && Boolean(screenshotTarget)}
                theme={theme}
                containerRef={screenshotRootRef}
                scrollContainerRef={screenshotRootRef}
                exemptRefs={[screenshotToggleButtonRef]}
                targets={screenshotTarget ? [screenshotTarget] : []}
                instructions="Click on the highlighted area to export"
                highlightSingleTarget={true}
                selectSingleTargetOnClick={true}
                onSelect={(target) => {
                    setSelectedScreenshotTarget(target)
                    onScreenshotModeChange?.(false)
                }}
                onCancel={() => {
                    onScreenshotModeChange?.(false)
                    setSelectedScreenshotTarget(null)
                }}
            />
        </div>
        <ScreenshotExportModal
            open={Boolean(selectedScreenshotTarget)}
            theme={theme}
            target={selectedScreenshotTarget}
            outputDir={defaultScreenshotDir}
            onSave={handleScreenshotSave}
            onClose={() => setSelectedScreenshotTarget(null)}
        />
        </>
    )
}
